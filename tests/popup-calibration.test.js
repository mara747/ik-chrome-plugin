"use strict";

// Popup: the calibration diagnostic offered after a SUCCESSFUL import (root
// ADR 0015 addendum 2026-09-01). It must reuse the failure dialog exactly —
// same report envelope, same two-step confirmation, same storage handoff —
// while leaving the primary "Odeslat do webu klubu" action untouched.
//
// popup.js is a plain script, so it runs in a vm sandbox against a minimal DOM
// stub (only the element API the popup actually uses) and stubbed chrome.*.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const POPUP = fs.readFileSync(path.join(__dirname, "..", "popup", "popup.js"), "utf8");
const DIAGNOSTICS = fs.readFileSync(
  path.join(__dirname, "..", "lib", "diagnostics.js"), "utf8");

const CLUB_TAB = { id: 9, windowId: 1, url: "https://investicni-klub.lovable.app/portfolio" };
const BROKER_TAB = { id: 4, windowId: 1, url: "https://george.csas.cz/" };

function createElement() {
  const el = {
    hidden: false,
    textContent: "",
    value: "",
    dataset: {},
    onclick: null,
    listeners: {},
    children: [],
    selectedOptions: [],
    addEventListener(type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    replaceChildren(...nodes) { el.children = nodes; },
    appendChild(node) { el.children.push(node); },
  };
  return el;
}

function createHarness({ scrapeResult, clubStatus }) {
  const elements = new Map();
  const stored = new Map();
  const tabUpdates = [];
  const tabsCreated = [];
  let closed = false;

  const el = (id) => {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id);
  };

  const sandbox = {
    console,
    navigator: { userAgent: "Mozilla/5.0 Chrome/140.0.0.0" },
    crypto: { randomUUID: () => "12345678-1234-4234-8234-123456789abc" },
    setTimeout,
    document: {
      getElementById: el,
      querySelectorAll: () => [],
      createElement: () => createElement(),
    },
    window: { close() { closed = true; } },
    chrome: {
      runtime: { getManifest: () => ({ version: "0.6.0" }) },
      storage: {
        local: {
          get: async (key) => (stored.has(key) ? { [key]: stored.get(key) } : {}),
          set: async (items) => {
            for (const [k, v] of Object.entries(items)) stored.set(k, v);
          },
          remove: async (key) => { stored.delete(key); },
        },
      },
      tabs: {
        query: async (q) => (q.active ? [BROKER_TAB] : [CLUB_TAB]),
        sendMessage: async (_id, msg) => {
          if (msg.type === "IK_DETECT") {
            return {
              supported: true,
              broker: "george",
              brokerLabel: "George (Česká spořitelna)",
              portfolioUrl: "https://george.csas.cz/",
              onPortfolioPage: true,
            };
          }
          if (msg.type === "IK_SCRAPE") return scrapeResult;
          if (msg.type === "IK_CLUB_STATUS") return clubStatus;
          return null;
        },
        update: async (id, props) => { tabUpdates.push({ id, ...props }); },
        create: async (props) => { tabsCreated.push(props); },
      },
      windows: { update: async () => {} },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(DIAGNOSTICS, sandbox);
  vm.runInContext(POPUP, sandbox);

  const flush = async () => {
    for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r));
  };
  const click = async (id) => {
    const target = el(id);
    if (target.onclick) await target.onclick();
    for (const fn of target.listeners.click || []) await fn();
    await flush();
  };

  return { el, stored, click, flush, tabUpdates, tabsCreated, closed: () => closed };
}

const CALIBRATION = {
  phase: "scrape",
  errorCode: "partial_import",
  commonDetail: { browser: "Chrome 140", path: "", query: {} },
  brokerDetail: {
    had_token: true,
    request_ok: true,
    request_status: 200,
    request_redirected: false,
    accounts_count: 1,
    titles_count: 2,
    titles_by_type: { FUND: 1, BOND: 1 },
    skipped_titles: [{
      isin: "CZ0003704165", title: "Dluhopis ČEZ 2030", security_type: "BOND",
      security_sub_type: "CORPORATE", exchange: "XPRA", currency: "CZK",
    }],
    money_fields: [],
  },
};

const PAYLOAD = {
  broker: "george",
  brokerLabel: "George (Česká spořitelna)",
  totalValue: 22500,
  cashValue: 0,
  currency: "CZK",
  positions: [{ ticker: "CZ0008412345", shares: 1000, avgCost: 10, currency: "CZK", note: null }],
  warnings: ["Tituly Dluhopis ČEZ 2030 zatím neumíme naimportovat."],
  scrapedAt: "2026-09-01T10:00:00.000Z",
};

const CLUB_STATUS = {
  ok: true,
  portfolioId: "p1",
  portfolioName: "Hlavní",
  portfolios: [{ id: "p1", name: "Hlavní" }],
};

async function scrapeWith(calibration) {
  const h = createHarness({
    scrapeResult: { ok: true, payload: PAYLOAD, ...(calibration ? { calibration } : {}) },
    clubStatus: CLUB_STATUS,
  });
  await h.flush();
  await h.click("btn-scrape");
  return h;
}

test("a successful import without calibration offers nothing extra", async () => {
  const h = await scrapeWith(null);
  assert.equal(h.el("result").hidden, false);
  assert.equal(h.el("result-calibration").hidden, true);
  assert.equal(h.el("btn-send").disabled, false); // primary action ready
});

test("calibration offers the diagnostic next to the result, not instead of it", async () => {
  const h = await scrapeWith(CALIBRATION);
  assert.equal(h.el("result-calibration").hidden, false);

  await h.click("btn-result-diagnostic");
  // Same dialog as after a failure — and the result panel STAYS open so the
  // import handoff is never blocked by the diagnostic.
  assert.equal(h.el("diagnostic").hidden, false);
  assert.equal(h.el("result").hidden, false);
  assert.equal(h.el("btn-send").disabled, false);

  const report = JSON.parse(h.el("diagnostic").dataset.report);
  assert.equal(report.error_code, "partial_import");
  assert.equal(report.phase, "scrape");
  assert.equal(report.broker, "george");
  assert.equal(report.plugin_version, "0.6.0");
  assert.equal(report.diagnostic_schema_version, 1);
  assert.deepEqual(report.broker_detail.skipped_titles[0].title, "Dluhopis ČEZ 2030");
  // The member sees the exact content before confirming.
  assert.ok(h.el("diagnostic-preview").textContent.includes("partial_import"));
  assert.ok(h.el("diagnostic-preview").textContent.includes("CZ0003704165"));
  // …and the wording admits that title identity is part of it.
  assert.match(h.el("diagnostic-scope").textContent, /identita titulů/);
  assert.match(h.el("diagnostic-safe").textContent, /Neposílají se kusy, částky/);
});

test("second confirmation stores the pending report and keeps the popup open", async () => {
  const h = await scrapeWith(CALIBRATION);
  await h.click("btn-result-diagnostic");
  h.el("diagnostic-note").value = "  fond sedí, dluhopis chybí  ";
  await h.click("btn-diagnostic-send");

  const pending = h.stored.get("ik_pending_diagnostic");
  assert.ok(pending, "report must wait in storage for the club web");
  assert.equal(pending.report.error_code, "partial_import");
  assert.equal(pending.report.member_note, "fond sedí, dluhopis chybí");
  // Delivery is unchanged (content/club.js reads storage), so the popup must
  // not steal focus or close — the member can still send the import.
  assert.equal(h.closed(), false);
  assert.equal(h.el("result").hidden, false);
  assert.equal(h.el("diagnostic").hidden, true);
  assert.equal(h.el("btn-result-diagnostic").hidden, true);
  assert.match(h.el("result-calibration-text").textContent, /připravená/);
  assert.deepEqual(h.tabUpdates, []);
  assert.deepEqual(h.tabsCreated, []);
});

test("the import handoff still works after sending the diagnostic", async () => {
  const h = await scrapeWith(CALIBRATION);
  await h.click("btn-result-diagnostic");
  await h.click("btn-diagnostic-send");

  h.el("target-select").value = "p1";
  h.el("target-select").selectedOptions = [{ textContent: "Hlavní" }];
  await h.click("btn-send");

  const pendingImport = h.stored.get("ik_pending_import");
  assert.equal(pendingImport.targetPortfolioId, "p1");
  assert.equal(pendingImport.payload.broker, "george");
  // Both handoffs now wait in storage; club.js delivers each exactly once.
  assert.ok(h.stored.get("ik_pending_diagnostic"));
  assert.equal(h.closed(), true);
});

test("the failure flow is untouched: hides the error box, steers and closes", async () => {
  const h = createHarness({
    scrapeResult: {
      ok: false,
      error: "Nepodařilo se načíst data z George.",
      diagnostic: {
        phase: "scrape", errorCode: "broker_request_failed",
        commonDetail: {}, brokerDetail: { had_token: true, request_status: 500 },
      },
    },
    clubStatus: CLUB_STATUS,
  });
  await h.flush();
  await h.click("btn-scrape");
  assert.equal(h.el("error-box").hidden, false);
  assert.equal(h.el("btn-diagnostic").hidden, false);

  await h.click("btn-diagnostic");
  assert.equal(h.el("error-box").hidden, true);
  assert.equal(h.el("diagnostic").hidden, false);
  assert.match(h.el("diagnostic-scope").textContent, /fáze chyby/);

  await h.click("btn-diagnostic-send");
  assert.equal(h.stored.get("ik_pending_diagnostic").report.error_code,
    "broker_request_failed");
  assert.match(h.tabUpdates[0].url, /\/rozsireni$/);
  assert.equal(h.closed(), true);
});

test("back returns to the result without revealing the error box", async () => {
  const h = await scrapeWith(CALIBRATION);
  await h.click("btn-result-diagnostic");
  await h.click("btn-diagnostic-back");
  assert.equal(h.el("diagnostic").hidden, true);
  assert.equal(h.el("error-box").hidden, true);
  assert.equal(h.el("result").hidden, false);
});
