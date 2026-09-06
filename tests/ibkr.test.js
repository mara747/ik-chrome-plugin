"use strict";

// IBKR Client Portal scraper — option import (root ADR 0016 in the club
// monorepo): bought OPT rows become OCC-symbol positions with per-share
// premium and an explicit multiplier; written options and rows that cannot
// compose an exact OCC symbol are skipped loudly (fail-closed). Fixtures
// mirror the live-calibrated shapes (.ie portal proxy, 2026-09, SPY
// Mar19'27 770 P): the position row carries NO option fields (everything
// comes from /trsrv/secdef — expiry/putOrCall/strike-as-string/multiplier/
// undSym) and avgPrice/avgCost are both PER SHARE (27.900333); per-contract
// avgCost exists only on gateways that omit avgPrice.

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

// Live .ie portal-proxy position row: no option fields, per-share averages.
const OPT_ROW = {
  acctId: "U111",
  conid: 826254591,
  assetClass: "OPT",
  secType: "OPT",
  position: 1,
  avgCost: 27.900333,
  avgPrice: 27.900333,
  mktPrice: 28.99959945,
  mktValue: 2899.959945,
  currency: "USD",
  contractDesc: "SPY Mar19'27 770 PUT @AMEX",
  description: "SPY Mar19'27 770 PUT @AMEX",
};

// Live /trsrv/secdef entry for the same conid (strike is a STRING there).
const OPT_SECDEF = {
  conid: 826254591,
  currency: "USD",
  listingExchange: "AMEX",
  assetClass: "OPT",
  expiry: "20270319",
  lastTradingDay: "20270319",
  putOrCall: "P",
  strike: "770",
  multiplier: 100,
  undSym: "SPY",
  ticker: "SPY",
  fullName: "SPY Mar19'27 770 Put",
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

test("imports the live-shaped option: OCC via secdef, per-share premium kept", async () => {
  const { scraper } = createHarness({
    routes: {
      [`${BASE}/portfolio/U111/positions/all`]: [STK_ROW, OPT_ROW],
      [`${BASE}/trsrv/secdef`]: [OPT_SECDEF],
    },
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
  assert.equal(opt.shares, 1);                  // contracts, not shares
  assert.equal(opt.avgCost, 27.900333);         // avgPrice is already per share
  assert.equal(opt.multiplier, 100);
  assert.equal(opt.price, 2899.959945 / 100);   // mktValue / (qty × multiplier)
  assert.equal(opt.name, "SPY Mar19'27 770 PUT"); // "@AMEX" annotation cut
  assert.equal(opt.currency, "USD");
  assert.equal(res.payload.warnings.length, 0);
});

test("falls back to per-contract avgCost ÷ multiplier when avgPrice is absent", async () => {
  const gatewayRow = {
    conid: 826254591,
    assetClass: "OPT",
    position: 1,
    avgCost: 2784.49, // CP-gateway style: includes the multiplier
    currency: "USD",
    contractDesc: "SPY Mar19'27 770 PUT",
  };
  const { scraper } = createHarness({
    routes: {
      [`${BASE}/portfolio/U111/positions/all`]: [gatewayRow],
      [`${BASE}/trsrv/secdef`]: [OPT_SECDEF],
    },
  });
  const res = await scraper.scrape();
  assert.equal(res.payload.positions[0].avgCost, 2784.49 / 100);
  assert.equal(res.payload.positions[0].price, null); // no mktValue either
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

test("accepts the maturityDate/right secdef field variant", async () => {
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
        maturityDate: "20270319", // older gateway naming — fallback path
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
  assert.equal(opt.avgCost, 5.12);          // no avgPrice → 512 / 100
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

test("pads a fractional strike to eight digits (inline row fields, no secdef)", async () => {
  const small = {
    ...OPT_ROW,
    conid: 780,
    contractDesc: "XYZ 18DEC26 7.5 C",
    undSym: "XYZ",
    expiry: "20261218",
    putOrCall: "C",
    strike: 7.5,
    multiplier: 100,
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
    routes: {
      [`${BASE}/portfolio/U111/positions/all`]: [noMkt],
      [`${BASE}/trsrv/secdef`]: [OPT_SECDEF],
    },
  });
  const res = await scraper.scrape();
  assert.equal(res.payload.positions[0].price, null);
  assert.equal(res.payload.positions[0].avgCost, 27.900333);
});
