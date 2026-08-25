"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const NORMALIZE_SOURCE = fs.readFileSync(
  require.resolve("../lib/normalize.js"),
  "utf8",
);

function loadNormalize() {
  const listeners = [];
  const sandbox = {
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) { listeners.push(listener); },
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(NORMALIZE_SOURCE, sandbox);
  return {
    IK: vm.runInContext("IK", sandbox),
    listeners,
  };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("resolves exact broker ticker and native-currency overrides", () => {
  const { IK } = loadNormalize();

  assert.equal(IK.resolveBrokerTicker("xtb", "DOC1", "USD"), "DOC");
  assert.equal(IK.resolveBrokerTicker("t212", "WEBN1.DE", "EUR"), "WEBN.DE");
  assert.equal(IK.resolveBrokerTicker("portu", "SX5EEX.DE", "EUR"), "EUEA.AS");
});

test("normalizes lookup keys but requires all three dimensions", () => {
  const { IK } = loadNormalize();

  assert.equal(IK.resolveBrokerTicker(" XTB ", " doc1 ", " usd "), "DOC");
  assert.equal(IK.resolveBrokerTicker("xtb", "DOC1", "EUR"), "DOC1");
  assert.equal(IK.resolveBrokerTicker("portu", "DOC1", "USD"), "DOC1");
  assert.equal(IK.resolveBrokerTicker("portu", "SX5EEX", "EUR"), "SX5EEX");
  assert.equal(IK.resolveBrokerTicker("xtb", "UNKNOWN", "USD"), "UNKNOWN");
  assert.equal(IK.resolveBrokerTicker(null, "DOC1", "USD"), "DOC1");
});

test("applies an override without mutating broker-owned data", () => {
  const { IK } = loadNormalize();
  const position = {
    ticker: "DOC1",
    shares: 8,
    avgCost: 16.5638,
    currency: "USD",
    note: "DOC1.US (Healthpeak Properties)",
  };
  const payload = {
    broker: "xtb",
    brokerLabel: "XTB",
    totalValue: 100,
    cashValue: 2,
    currency: "CZK",
    positions: [position],
    warnings: ["synthetic warning"],
    scrapedAt: "2026-08-25T12:00:00.000Z",
  };
  const before = plain(payload);

  const result = IK.applyBrokerTickerOverrides(payload);

  assert.notStrictEqual(result, payload);
  assert.notStrictEqual(result.positions, payload.positions);
  assert.notStrictEqual(result.positions[0], position);
  assert.equal(result.positions[0].ticker, "DOC");
  assert.equal(result.positions[0].note, "DOC1.US (Healthpeak Properties)");
  assert.deepEqual(plain(result.positions[0]), {
    ...before.positions[0],
    ticker: "DOC",
  });
  assert.deepEqual(plain(payload), before);
  assert.equal(result.totalValue, 100);
  assert.equal(result.cashValue, 2);
  assert.equal(result.currency, "CZK");
  assert.deepEqual(plain(result.warnings), ["synthetic warning"]);
});

test("preserves unmatched position objects while returning a new payload", () => {
  const { IK } = loadNormalize();
  const position = {
    ticker: "ACME",
    shares: 1,
    avgCost: 10,
    currency: "USD",
    note: null,
  };
  const payload = { broker: "xtb", positions: [position] };

  const result = IK.applyBrokerTickerOverrides(payload);

  assert.notStrictEqual(result, payload);
  assert.notStrictEqual(result.positions, payload.positions);
  assert.strictEqual(result.positions[0], position);
  assert.equal(result.positions[0].ticker, "ACME");
});

test("applies the Portu override and preserves the instrument name", () => {
  const { IK } = loadNormalize();
  const payload = {
    broker: "portu",
    positions: [{
      ticker: "SX5EEX.DE",
      shares: 2,
      avgCost: 50,
      currency: "EUR",
      note: "iShares Core EURO STOXX 50 UCITS ETF EUR (Dist)",
    }],
  };

  const result = IK.applyBrokerTickerOverrides(payload);

  assert.equal(result.positions[0].ticker, "EUEA.AS");
  assert.equal(
    result.positions[0].note,
    "iShares Core EURO STOXX 50 UCITS ETF EUR (Dist)",
  );
});

test("reverts only a colliding override and appends the Czech audit note", () => {
  const { IK } = loadNormalize();
  const payload = {
    broker: "xtb",
    positions: [
      {
        ticker: "DOC1",
        currency: "USD",
        shares: 8,
        avgCost: 16,
        note: "Healthpeak",
      },
      {
        ticker: "DOC",
        currency: "USD",
        shares: 3,
        avgCost: 20,
        note: "Existing DOC",
      },
    ],
  };

  const result = IK.applyBrokerTickerOverrides(payload);

  assert.deepEqual(
    result.positions.map((position) => position.ticker),
    ["DOC1", "DOC"],
  );
  assert.equal(
    result.positions[0].note,
    "Healthpeak; převod na DOC přeskočen – kolize s existující pozicí DOC",
  );
  assert.equal(result.positions[1].note, "Existing DOC");
  assert.equal(result.positions[0].shares, 8);
  assert.equal(result.positions[0].avgCost, 16);
});

test("does not duplicate a collision audit note when normalization repeats", () => {
  const { IK } = loadNormalize();
  const payload = {
    broker: "xtb",
    positions: [
      { ticker: "DOC1", currency: "USD", note: "Healthpeak" },
      { ticker: "DOC", currency: "USD", note: "Existing DOC" },
    ],
  };

  const once = IK.applyBrokerTickerOverrides(payload);
  const twice = IK.applyBrokerTickerOverrides(once);

  assert.equal(twice.positions[0].note, once.positions[0].note);
});

test("reverts two aliases to one output but keeps an independent override", () => {
  const { IK } = loadNormalize();
  const overrides = {
    synthetic: {
      ALIAS1: { EUR: "FINAL.AS" },
      ALIAS2: { EUR: "FINAL.AS" },
      OLD: { USD: "NEW" },
    },
  };
  const payload = {
    broker: "synthetic",
    positions: [
      { ticker: "ALIAS1", currency: "EUR", note: null },
      { ticker: "ALIAS2", currency: "EUR", note: "Second" },
      { ticker: "OLD", currency: "USD", note: "Independent" },
    ],
  };

  const result = IK.applyBrokerTickerOverrides(payload, overrides);

  assert.deepEqual(
    result.positions.map((position) => position.ticker),
    ["ALIAS1", "ALIAS2", "NEW"],
  );
  assert.equal(
    result.positions[0].note,
    "převod na FINAL.AS přeskočen – kolize s existující pozicí FINAL.AS",
  );
  assert.equal(
    result.positions[1].note,
    "Second; převod na FINAL.AS přeskočen – kolize s existující pozicí FINAL.AS",
  );
  assert.equal(result.positions[2].note, "Independent");
});

test("does not reinterpret pre-existing duplicates when no override applies", () => {
  const { IK } = loadNormalize();
  const first = { ticker: "ACME", currency: "USD", note: "First" };
  const second = { ticker: "ACME", currency: "USD", note: "Second" };

  const result = IK.applyBrokerTickerOverrides({
    broker: "xtb",
    positions: [first, second],
  });

  assert.strictEqual(result.positions[0], first);
  assert.strictEqual(result.positions[1], second);
});

function scrapeThroughListener(listener) {
  return new Promise((resolve, reject) => {
    try {
      const asyncReply = listener({ type: "IK_SCRAPE" }, {}, resolve);
      assert.equal(asyncReply, true);
    } catch (error) {
      reject(error);
    }
  });
}

test("registerScraper transforms a successful result before sendResponse", async () => {
  const { IK, listeners } = loadNormalize();
  const sourcePayload = {
    broker: "portu",
    positions: [{
      ticker: "SX5EEX.DE",
      currency: "EUR",
      shares: 1,
      avgCost: 55,
      note: "iShares Core EURO STOXX 50 UCITS ETF EUR (Dist)",
    }],
  };
  IK.registerScraper({
    broker: "portu",
    brokerLabel: "Portu",
    portfolioUrl: "https://www.portu.cz/souhrn",
    isPortfolioPage: () => true,
    scrape: async () => ({ ok: true, payload: sourcePayload }),
  });

  const response = await scrapeThroughListener(listeners[0]);

  assert.equal(response.ok, true);
  assert.equal(response.payload.positions[0].ticker, "EUEA.AS");
  assert.equal(sourcePayload.positions[0].ticker, "SX5EEX.DE");
});

test("registerScraper preserves a broker error without applying overrides", async () => {
  const { IK, listeners } = loadNormalize();
  const failure = {
    ok: false,
    needsCalibration: true,
    error: "Syntetická chyba brokera.",
  };
  IK.registerScraper({
    broker: "xtb",
    brokerLabel: "XTB",
    portfolioUrl: "https://xstation5.xtb.com/",
    isPortfolioPage: () => true,
    scrape: async () => failure,
  });

  const response = await scrapeThroughListener(listeners[0]);

  assert.strictEqual(response, failure);
});
