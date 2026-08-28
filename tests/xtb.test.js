"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE_PATH = path.join(__dirname, "..", "content", "brokers", "xtb.js");
const NORMALIZE_SOURCE_PATH = path.join(__dirname, "..", "lib", "normalize.js");
const ORIGIN = "https://xstation5.xtb.com";

function loadSharedNormalize() {
  const sandbox = {
    chrome: { runtime: { onMessage: { addListener() {} } } },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(NORMALIZE_SOURCE_PATH, "utf8"), sandbox);
  return vm.runInContext("IK", sandbox);
}

function validNormalizedResult() {
  return {
    ok: true,
    payload: {
      broker: "xtb",
      brokerLabel: "XTB",
      totalValue: 1000,
      cashValue: 25,
      currency: "USD",
      positions: [{ ticker: "ACME", shares: 2, avgCost: 10, currency: "USD", note: null }],
      warnings: [],
      scrapedAt: "2026-08-25T00:00:00.000Z",
    },
  };
}

function responseFor(request, result = validNormalizedResult()) {
  return {
    channel: "ik-xtb-stream-bridge",
    type: "response",
    requestId: request.requestId,
    nonce: request.nonce,
    result,
  };
}

function loadIsolatedAdapter(resolveBrokerTicker = (_broker, ticker) => ticker) {
  const listeners = new Map();
  const scheduled = new Map();
  let nextTimerId = 1;
  let nextToken = 1;
  let registered = null;

  const window = {
    posted: [],
    addEventListener(type, listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) || []).filter((candidate) => candidate !== listener));
    },
    postMessage(message, targetOrigin) {
      this.posted.push({ message, targetOrigin });
    },
    emitMessage(event) {
      for (const listener of [...(listeners.get("message") || [])]) listener(event);
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
  };
  const sandbox = {
    IK: {
      registerScraper(definition) { registered = definition; },
      resolveBrokerTicker,
    },
    window,
    location: { origin: ORIGIN, hostname: "xstation5.xtb.com" },
    crypto: { randomUUID() { return `token-${nextToken++}`; } },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      scheduled.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { scheduled.delete(id); },
    Date,
    Math,
    Promise,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE_PATH, "utf8"), sandbox);
  return {
    get registered() { return registered; },
    scheduled,
    window,
  };
}

test("registers XTB and accepts only the matching one-time MAIN response", async () => {
  const runtime = loadIsolatedAdapter();
  const { registered, window } = runtime;
  assert.equal(registered.broker, "xtb");
  assert.equal(registered.brokerLabel, "XTB");
  assert.equal(registered.isPortfolioPage(), true);

  const pending = registered.scrape();
  const request = window.posted.at(-1).message;
  assert.equal(window.posted.at(-1).targetOrigin, ORIGIN);
  assert.equal(request.channel, "ik-xtb-stream-bridge");
  assert.equal(request.type, "request");

  const invalidEvents = [
    { source: {}, origin: ORIGIN, data: responseFor(request) },
    { source: window, origin: "https://evil.example", data: responseFor(request) },
    { source: window, origin: ORIGIN, data: { ...responseFor(request), channel: "wrong" } },
    { source: window, origin: ORIGIN, data: { ...responseFor(request), requestId: "wrong" } },
    { source: window, origin: ORIGIN, data: { ...responseFor(request), nonce: "wrong" } },
  ];
  for (const event of invalidEvents) window.emitMessage(event);
  assert.equal(window.listenerCount("message"), 1);

  const result = validNormalizedResult();
  window.emitMessage({ source: window, origin: ORIGIN, data: responseFor(request, result) });
  assert.deepEqual(await pending, result);
  assert.equal(window.listenerCount("message"), 0);
  assert.equal(runtime.scheduled.size, 0);
});

test("rejects a malformed MAIN result through the bounded bridge timeout", async () => {
  const runtime = loadIsolatedAdapter();
  const pending = runtime.registered.scrape();
  const request = runtime.window.posted.at(-1).message;
  runtime.window.emitMessage({
    source: runtime.window,
    origin: ORIGIN,
    data: responseFor(request, { payload: {} }),
  });
  assert.equal(runtime.window.listenerCount("message"), 1);

  const timer = [...runtime.scheduled.values()][0];
  assert.equal(timer.delay, 8000);
  timer.callback();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.needsCalibration, true);
  assert.match(result.error, /streamem XTB/i);
  assert.equal(runtime.window.listenerCount("message"), 0);
});

test("uses independent request and nonce values for concurrent scrapes", () => {
  const runtime = loadIsolatedAdapter();
  runtime.registered.scrape();
  runtime.registered.scrape();
  const [first, second] = runtime.window.posted.map((entry) => entry.message);
  assert.notEqual(first.requestId, first.nonce);
  assert.notEqual(first.requestId, second.requestId);
  assert.notEqual(first.nonce, second.nonce);
});

test("accepts a MAIN-world instrument only when the strict shared override exists", async () => {
  const sharedNormalize = loadSharedNormalize();
  const runtime = loadIsolatedAdapter(sharedNormalize.resolveBrokerTicker);
  const pending = runtime.registered.scrape();
  const request = runtime.window.posted.at(-1).message;
  const result = validNormalizedResult();
  result.payload.positions = [{
    ticker: "ISLN.UK",
    shares: 2,
    avgCost: 35,
    currency: "USD",
    note: "ISLN.UK (Physical Silver)",
    requiresTickerOverride: true,
  }];

  runtime.window.emitMessage({ source: runtime.window, origin: ORIGIN, data: responseFor(request, result) });
  const accepted = await pending;

  assert.equal(accepted.ok, true);
  assert.equal(accepted.payload.positions[0].ticker, "ISLN.UK");
  assert.equal(accepted.payload.positions[0].currency, "USD");
  assert.equal("requiresTickerOverride" in accepted.payload.positions[0], false);
  const normalized = sharedNormalize.applyBrokerTickerOverrides(accepted.payload);
  assert.equal(normalized.positions[0].ticker, "ISLN.L");
  assert.equal(normalized.positions[0].currency, "USD");
  assert.equal(normalized.positions[0].note, "ISLN.UK (Physical Silver)");
});

test("rejects an exact XTB currency enrichment when the shared ticker override is missing", async () => {
  const runtime = loadIsolatedAdapter();
  const pending = runtime.registered.scrape();
  const request = runtime.window.posted.at(-1).message;
  const result = validNormalizedResult();
  result.payload.positions = [{
    ticker: "ISLN.UK",
    shares: 2,
    avgCost: 35,
    currency: "USD",
    note: "ISLN.UK (Physical Silver)",
    requiresTickerOverride: true,
  }];

  runtime.window.emitMessage({ source: runtime.window, origin: ORIGIN, data: responseFor(request, result) });
  const rejected = await pending;

  assert.equal(rejected.ok, false);
  assert.equal(rejected.needsCalibration, true);
  assert.match(rejected.error, /XTB-INSTRUMENT-OVERRIDE-MISSING/);
  assert.match(rejected.error, /ISLN\.UK/);
  assert.match(rejected.error, /USD/);
});

test("registers the exact production XTB execution-world entries", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  const xtbEntries = manifest.content_scripts.filter((entry) =>
    entry.matches?.includes("https://xstation5.xtb.com/*"));

  assert.deepEqual(xtbEntries, [
    {
      matches: ["https://xstation5.xtb.com/*"],
      js: ["content/brokers/xtb-stream.js"],
      world: "MAIN",
      run_at: "document_start",
    },
    {
      matches: ["https://xstation5.xtb.com/*"],
      js: ["lib/normalize.js", "content/brokers/xtb.js"],
      run_at: "document_idle",
    },
  ]);
  assert.equal(manifest.host_permissions, undefined);
});
