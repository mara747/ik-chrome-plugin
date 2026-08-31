"use strict";

// Diagnostic delivery lifecycle in content/club.js (review 2026-08-31):
// the initial 800 ms burst, the switch to the sparse 30 s cadence after two
// minutes (the club web is a SPA — a full page reload may never come), the
// 24 h expiry and the ACK/REJECTED cleanup. Runs the real script in a vm
// sandbox with a hand-rolled clock so no test ever sleeps.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "content", "club.js"), "utf8");
const KEY = "ik_pending_diagnostic";
const RESULT_KEY = "ik_diagnostic_result";
const HOUR = 60 * 60 * 1000;

// chrome.storage.local is shared between tabs, and every tab's interval must
// tick on the same clock — the "world" holds that shared state so a test can
// run two harnesses (= two club tabs) against one storage.
function createWorld() {
  return {
    storage: new Map(),
    storageListeners: [],
    intervals: new Map(),
    nextId: 1,
    clock: 1_000_000,
  };
}

function createHarness(world = createWorld()) {
  const { storage, storageListeners, intervals } = world;
  const messageListeners = [];
  const posted = [];

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const sandbox = {
    console,
    chrome: {
      storage: {
        local: {
          get: (key) => Promise.resolve(
            storage.has(key) ? { [key]: storage.get(key) } : {}),
          set: (items) => {
            const changes = {};
            for (const [k, v] of Object.entries(items)) {
              changes[k] = { newValue: v };
              storage.set(k, v);
            }
            storageListeners.forEach((l) => l(changes, "local"));
            return Promise.resolve();
          },
          remove: (key) => {
            // Real Chrome fires onChanged on removal too (no newValue) —
            // the multi-tab stop path depends on exactly that event.
            if (!storage.has(key)) return Promise.resolve();
            const oldValue = storage.get(key);
            storage.delete(key);
            storageListeners.forEach((l) => l({ [key]: { oldValue } }, "local"));
            return Promise.resolve();
          },
        },
        onChanged: { addListener: (l) => storageListeners.push(l) },
      },
      runtime: { onMessage: { addListener() {} } },
    },
    setInterval: (fn, ms) => {
      const id = world.nextId;
      world.nextId += 1;
      intervals.set(id, { fn, ms, next: world.clock + ms });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    Date: { now: () => world.clock },
  };
  sandbox.window = {
    location: { origin: "https://club.test", pathname: "/" },
    postMessage: (data) => posted.push(data),
    addEventListener: (type, l) => {
      if (type === "message") messageListeners.push(l);
    },
    removeEventListener: (type, l) => {
      const i = messageListeners.indexOf(l);
      if (i >= 0) messageListeners.splice(i, 1);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  return {
    storage,
    posted,
    flush,
    now: () => world.clock,
    load: async () => {
      vm.runInContext(SOURCE, sandbox);
      await flush();
    },
    // Advance the SHARED fake clock, firing due interval ticks (of every tab
    // in the world) in time order.
    advance: async (ms) => {
      const target = world.clock + ms;
      for (;;) {
        let earliest = null;
        for (const [id, it] of intervals) {
          if (it.next <= target && (!earliest || it.next < earliest.it.next)) {
            earliest = { id, it };
          }
        }
        if (!earliest) break;
        world.clock = earliest.it.next;
        earliest.it.next += earliest.it.ms;
        earliest.it.fn();
        await flush();
      }
      world.clock = target;
      await flush();
    },
    deliver: async (data) => {
      [...messageListeners].forEach((l) => l({ source: sandbox.window, data }));
      await flush();
    },
    diagnosticPosts: () =>
      posted.filter((p) => p.type === "IK_PLUGIN_DIAGNOSTIC"),
  };
}

function entry(h, ageMs = 0) {
  return { report: { report_id: "r-1" }, savedAt: h.now() - ageMs };
}

test("fresh report posts immediately and retries every 800 ms", async () => {
  const h = createHarness();
  h.storage.set(KEY, entry(h));
  await h.load();
  assert.equal(h.diagnosticPosts().length, 1);
  await h.advance(4_000);
  assert.equal(h.diagnosticPosts().length, 6); // 1 + 4000/800
});

test("after two minutes the cadence drops to sparse 30 s, not zero", async () => {
  const h = createHarness();
  h.storage.set(KEY, entry(h));
  await h.load();
  await h.advance(2 * 60 * 1000 + 800); // burst window + the switching tick
  const afterBurst = h.diagnosticPosts().length;
  await h.advance(60_000);
  const sparse = h.diagnosticPosts().length - afterBurst;
  assert.equal(sparse, 2); // 30 s cadence — delivery must NOT stop entirely
});

test("expired report is dropped on load without a single post", async () => {
  const h = createHarness();
  h.storage.set(KEY, entry(h, 25 * HOUR));
  await h.load();
  assert.equal(h.diagnosticPosts().length, 0);
  assert.equal(h.storage.has(KEY), false);
});

test("report expiring mid-flight stops posting and cleans storage", async () => {
  const h = createHarness();
  h.storage.set(KEY, entry(h, 24 * HOUR - 1_000));
  await h.load();
  await h.advance(5_000);
  const upTo = h.diagnosticPosts().length;
  await h.advance(60_000);
  assert.equal(h.diagnosticPosts().length, upTo);
  assert.equal(h.storage.has(KEY), false);
});

test("ACK stores the reference code and stops delivery", async () => {
  const h = createHarness();
  h.storage.set(KEY, entry(h));
  await h.load();
  await h.deliver({
    type: "IK_PLUGIN_DIAGNOSTIC_ACK", reportId: "r-1", referenceCode: "FIO-ABC",
  });
  assert.equal(h.storage.has(KEY), false);
  const result = h.storage.get(RESULT_KEY);
  assert.equal(result.referenceCode, "FIO-ABC");
  assert.equal(result.rejected, false);
  const before = h.diagnosticPosts().length;
  await h.advance(10_000);
  assert.equal(h.diagnosticPosts().length, before);
});

test("REJECTED keeps the reason for the popup wording", async () => {
  const h = createHarness();
  h.storage.set(KEY, entry(h));
  await h.load();
  await h.deliver({
    type: "IK_PLUGIN_DIAGNOSTIC_REJECTED", reportId: "r-1", reason: "rate_limited",
  });
  const result = h.storage.get(RESULT_KEY);
  assert.equal(result.rejected, true);
  assert.equal(result.rejectReason, "rate_limited");
  assert.equal(h.storage.has(KEY), false);
});

test("second club tab stops retrying once another tab's ACK clears storage", async () => {
  const world = createWorld();
  const tabA = createHarness(world);
  const tabB = createHarness(world);
  world.storage.set(KEY, entry(tabA));
  await tabA.load();
  await tabB.load();
  assert.equal(tabA.diagnosticPosts().length, 1);
  assert.equal(tabB.diagnosticPosts().length, 1);
  // Only tab A's page inserts and acks; tab B must notice the storage removal.
  await tabA.deliver({
    type: "IK_PLUGIN_DIAGNOSTIC_ACK", reportId: "r-1", referenceCode: "FIO-ABC",
  });
  assert.equal(world.storage.has(KEY), false);
  const postsA = tabA.diagnosticPosts().length;
  const postsB = tabB.diagnosticPosts().length;
  await tabA.advance(5 * 60 * 1000); // shared clock — ticks tab B's timer too
  assert.equal(tabA.diagnosticPosts().length, postsA);
  assert.equal(tabB.diagnosticPosts().length, postsB);
});

test("ACK for a different report is ignored", async () => {
  const h = createHarness();
  h.storage.set(KEY, entry(h));
  await h.load();
  await h.deliver({
    type: "IK_PLUGIN_DIAGNOSTIC_ACK", reportId: "cizí", referenceCode: "X",
  });
  assert.equal(h.storage.has(KEY), true);
  assert.equal(h.storage.has(RESULT_KEY), false);
});
