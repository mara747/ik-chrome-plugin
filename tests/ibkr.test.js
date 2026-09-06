"use strict";

// IBKR Client Portal scraper — option import (root ADR 0016 in the club
// monorepo): bought OPT rows become OCC-symbol positions with per-share
// premium and an explicit multiplier; written options and rows that cannot
// compose an exact OCC symbol are skipped loudly (fail-closed). Fixtures
// mirror the live-calibrated shapes (2026-09) with the SPY Mar19'27 770 P
// case: avgCost is per CONTRACT (2784.49 against a 27.90 per-share quote).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(require.resolve("../content/brokers/ibkr.js"), "utf8");

const BASE = "/portal.proxy/v1/portal";

const STK_ROW = {
  conid: 1,
  assetClass: "STK",
  position: 10,
  avgPrice: 100,
  currency: "USD",
  ticker: "AAPL",
  listingExchange: "NASDAQ",
};

// Long put with every OCC field inline — no secdef call needed.
const OPT_ROW = {
  conid: 777,
  assetClass: "OPT",
  position: 1,
  avgCost: 2784.49,
  mktValue: 2790,
  currency: "USD",
  contractDesc: "SPY 19MAR27 770 P",
  undSym: "SPY",
  expiry: "20270319",
  putOrCall: "P",
  strike: 770,
  multiplier: 100,
};

function createHarness({ routes = {} } = {}) {
  let registered = null;
  const table = {
    [`${BASE}/portfolio/accounts`]: [{ id: "U111" }],
    [`${BASE}/portfolio/U111/positions/all`]: [],
    [`${BASE}/portfolio/U111/summary`]: {
      netliquidation: { amount: 100000, currency: "USD" },
      totalcashvalue: { amount: 5000 },
    },
    ...routes,
  };
  const sandbox = {
    IK: {
      registerScraper(def) { registered = def; },
      yahooSymbol: (s) =>
        String(s || "").trim().toUpperCase().replace(/^\$/, "").replace("/", "-"),
      parseNumber: () => null,
      pickText: () => null,
      detectCurrency: () => null,
    },
    document: {},
    // secdef requests carry a ?conids=… query — match on the bare path.
    fetch: async (path) => {
      const hit = table[String(path)] ?? table[String(path).split("?")[0]];
      if (hit === undefined) return { ok: false, status: 404, json: async () => null };
      return { ok: true, status: 200, json: async () => hit };
    },
    AbortController: class {
      constructor() { this.signal = {}; }
      abort() {}
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    Math, Number, Array, Object, JSON, Date, Promise, Set, String,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return { scraper: registered };
}

test("registers the ibkr scraper", () => {
  const { scraper } = createHarness();
  assert.equal(scraper.broker, "ibkr");
});

test("imports a bought option as an OCC position with per-share premium", async () => {
  const { scraper } = createHarness({
    routes: { [`${BASE}/portfolio/U111/positions/all`]: [STK_ROW, OPT_ROW] },
  });
  const res = await scraper.scrape();
  assert.equal(res.ok, true);
  assert.equal(res.payload.positions.length, 2);
  const stock = res.payload.positions[0];
  assert.equal(stock.ticker, "AAPL");
  assert.equal("kind" in stock, false);
  const opt = res.payload.positions[1];
  assert.equal(opt.ticker, "SPY270319P00770000");
  assert.equal(opt.kind, "option");
  assert.equal(opt.shares, 1);                 // contracts, not shares
  assert.equal(opt.avgCost, 2784.49 / 100);    // per-contract → per-share
  assert.equal(opt.multiplier, 100);
  assert.equal(opt.price, 27.9);               // mktValue / (qty × multiplier)
  assert.equal(opt.name, "SPY 19MAR27 770 P");
  assert.equal(opt.currency, "USD");
  assert.equal(res.payload.warnings.length, 0);
});

test("skips a written (negative) option with a warning", async () => {
  const short = { ...OPT_ROW, position: -2 };
  const { scraper } = createHarness({
    routes: { [`${BASE}/portfolio/U111/positions/all`]: [STK_ROW, short] },
  });
  const res = await scraper.scrape();
  assert.equal(res.ok, true);
  assert.equal(res.payload.positions.length, 1);
  assert.equal(res.payload.positions[0].ticker, "AAPL");
  assert.match(res.payload.warnings.join(" "), /OPT psaná ×1/);
});

test("backfills missing OCC fields from secdef", async () => {
  const bare = {
    conid: 778,
    assetClass: "OPT",
    position: 2,
    avgCost: 512,
    mktValue: 1100,
    currency: "USD",
    contractDesc: "SPY 19MAR27 770 P",
  };
  const { scraper } = createHarness({
    routes: {
      [`${BASE}/portfolio/U111/positions/all`]: [bare],
      [`${BASE}/trsrv/secdef`]: [{
        conid: 778,
        undSym: "SPY",
        maturityDate: "20270319",
        right: "P",
        strike: 770,
        multiplier: 100,
        currency: "USD",
      }],
    },
  });
  const res = await scraper.scrape();
  assert.equal(res.ok, true);
  assert.equal(res.payload.positions.length, 1);
  const opt = res.payload.positions[0];
  assert.equal(opt.ticker, "SPY270319P00770000");
  assert.equal(opt.shares, 2);
  assert.equal(opt.avgCost, 5.12);          // 512 / 100
  assert.equal(opt.price, 5.5);             // 1100 / (2 × 100)
});

test("fails closed when the OCC symbol cannot be composed", async () => {
  const bare = {
    conid: 779,
    assetClass: "OPT",
    position: 1,
    avgCost: 300,
    currency: "USD",
    contractDesc: "??? option",
  };
  const { scraper } = createHarness({
    routes: {
      [`${BASE}/portfolio/U111/positions/all`]: [STK_ROW, bare],
      [`${BASE}/trsrv/secdef`]: [],
    },
  });
  const res = await scraper.scrape();
  assert.equal(res.ok, true);
  assert.equal(res.payload.positions.length, 1); // only the stock
  assert.match(res.payload.warnings.join(" "), /OPT bez polí pro OCC symbol ×1/);
});

test("pads a fractional strike to eight digits", async () => {
  const small = {
    ...OPT_ROW,
    conid: 780,
    contractDesc: "XYZ 18DEC26 7.5 C",
    undSym: "XYZ",
    expiry: "20261218",
    putOrCall: "C",
    strike: 7.5,
  };
  const { scraper } = createHarness({
    routes: { [`${BASE}/portfolio/U111/positions/all`]: [small] },
  });
  const res = await scraper.scrape();
  assert.equal(res.payload.positions[0].ticker, "XYZ261218C00007500");
});

test("keeps price null when mktValue is missing", async () => {
  const noMkt = { ...OPT_ROW, mktValue: undefined };
  const { scraper } = createHarness({
    routes: { [`${BASE}/portfolio/U111/positions/all`]: [noMkt] },
  });
  const res = await scraper.scrape();
  assert.equal(res.payload.positions[0].price, null);
  assert.equal(res.payload.positions[0].avgCost, 2784.49 / 100);
});
