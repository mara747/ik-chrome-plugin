"use strict";

// George (Česká spořitelna) scraper: /my/securities snapshot → fund positions
// (web ADR 0010 in the club repo). Fixture mirrors the live-calibrated shape
// (2026-09) with fake values: integer money + precision, FUND vs SHARE titles
// on one account, derived average from investedValue.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(require.resolve("../content/brokers/george.js"), "utf8");

const M = (value, precision) => ({ value, precision, currency: "CZK" });

function fundTitle(over = {}) {
  return {
    isin: "CZ0008412345",
    title: "Testovací fond",
    fullTitle: "Testovací otevřený podílový fond",
    securityType: "FUND",
    currency: "CZK",
    numberOfShares: 1000,
    marketValue: M(1250000, 2),        // 12 500.00
    investedValue: M(1000000, 2),      // 10 000.00 → avg 10.00
    positions: [{ lastPrice: M(125000, 4) }], // 12.5000
    ...over,
  };
}

function accountBody(titles, balanceValue = 1250000) {
  return {
    securitiesAccounts: [{
      accountno: "1234567890",
      "cz-agreementType": "MUIN1",
      balance: M(balanceValue, 2),
      investedAmount: M(1000000, 2),
      subSecAccounts: [{ id: "00", titles }],
    }],
  };
}

function createHarness({ token = "tok-123", status = 200, body = null } = {}) {
  let registered = null;
  const sandbox = {
    IK: { registerScraper(def) { registered = def; } },
    IKDiagnostics: { failure: (args) => ({ __diag: true, ...args }) },
    sessionStorage: {
      getItem: (k) => (k === "gt" ? token : null),
    },
    fetch: async () => ({
      ok: status === 200,
      status,
      redirected: false,
      json: async () => body,
    }),
    Math, Number, Array, Object, JSON, Date, Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return { scraper: registered };
}

test("registers an API-only scraper reachable from any George route", () => {
  const { scraper } = createHarness();
  assert.equal(scraper.broker, "george");
  assert.equal(scraper.isPortfolioPage(), true);
});

test("maps a fund title: ISIN identity, derived average, NAV snapshot", async () => {
  const { scraper } = createHarness({ body: accountBody([fundTitle()]) });
  const res = await scraper.scrape();
  assert.equal(res.ok, true);
  assert.equal(res.payload.broker, "george");
  assert.equal(res.payload.currency, "CZK");
  assert.equal(res.payload.totalValue, 12500);
  assert.equal(res.payload.cashValue, 0); // explicit zero, never null here
  assert.equal(res.payload.positions.length, 1);
  const p = res.payload.positions[0];
  assert.equal(p.kind, "fund");
  assert.equal(p.ticker, "CZ0008412345");
  assert.equal(p.name, "Testovací fond");
  assert.equal(p.shares, 1000);
  assert.equal(p.avgCost, 10);       // 10 000.00 / 1000
  assert.equal(p.price, 12.5);       // lastPrice precision 4
  assert.equal(p.currency, "CZK");
  assert.equal(res.payload.warnings.length, 0);
});

test("skips non-FUND titles loudly and keeps them out of cash", async () => {
  const share = {
    isin: "US0000000001", title: "Nějaká akcie", securityType: "SHARE",
    currency: "USD", numberOfShares: 5,
    marketValue: M(250000, 2), // 2 500.00 CZK-converted in the snapshot
    positions: [],
  };
  const { scraper } = createHarness({
    body: accountBody([fundTitle(), share], 1500000), // balance 15 000.00
  });
  const res = await scraper.scrape();
  assert.equal(res.ok, true);
  assert.equal(res.payload.positions.length, 1); // only the fund
  assert.equal(res.payload.positions[0].kind, "fund");
  // cash = 15 000 − (12 500 + 2 500) = 0 — the skipped SHARE must not leak in
  assert.equal(res.payload.cashValue, 0);
  assert.match(res.payload.warnings.join(" "), /burzovní tituly/);
});

test("missing investedValue → avgCost null with a manual-fill warning", async () => {
  const { scraper } = createHarness({
    body: accountBody([fundTitle({ investedValue: null })]),
  });
  const res = await scraper.scrape();
  assert.equal(res.ok, true);
  assert.equal(res.payload.positions[0].avgCost, null);
  assert.match(res.payload.warnings.join(" "), /nákupní cena/);
});

test("sold-out fund (zero shares) is skipped", async () => {
  const { scraper } = createHarness({
    body: accountBody([fundTitle({ numberOfShares: 0, marketValue: M(0, 2) })], 0),
  });
  const res = await scraper.scrape();
  assert.equal(res.ok, true);
  assert.equal(res.payload.positions.length, 0);
  assert.match(res.payload.warnings.join(" "), /žádné podílové fondy/);
});

test("price falls back to marketValue / shares when lastPrice is missing", async () => {
  const { scraper } = createHarness({
    body: accountBody([fundTitle({ positions: [] })]),
  });
  const res = await scraper.scrape();
  assert.equal(res.payload.positions[0].price, 12.5); // 12 500 / 1000
});

test("mixed account currencies degrade to positions-only", async () => {
  const body = accountBody([fundTitle()]);
  body.securitiesAccounts.push({
    accountno: "0987654321",
    balance: { value: 10000, precision: 2, currency: "EUR" },
    subSecAccounts: [],
  });
  const { scraper } = createHarness({ body });
  const res = await scraper.scrape();
  assert.equal(res.ok, true);
  assert.equal(res.payload.totalValue, null);
  assert.equal(res.payload.cashValue, null);
  assert.match(res.payload.warnings.join(" "), /více měnách/);
});

test("missing token → login_required, no request needed", async () => {
  const { scraper } = createHarness({ token: null });
  const res = await scraper.scrape();
  assert.equal(res.ok, false);
  assert.equal(res.needsCalibration, false);
  assert.equal(res.diagnostic.errorCode, "login_required");
  assert.equal(res.diagnostic.brokerDetail.had_token, false);
});

test("401 → expired login, 412 → key rotation needs calibration", async () => {
  const expired = await createHarness({ status: 401 }).scraper.scrape();
  assert.equal(expired.ok, false);
  assert.equal(expired.diagnostic.errorCode, "login_required");
  assert.equal(expired.needsCalibration, false);

  const rotated = await createHarness({ status: 412 }).scraper.scrape();
  assert.equal(rotated.ok, false);
  assert.equal(rotated.needsCalibration, true);
  assert.equal(rotated.diagnostic.errorCode, "broker_request_failed");
});

test("diagnostic detail carries only counts, never ISINs or values", async () => {
  const { scraper } = createHarness({ body: { securitiesAccounts: [] } });
  const res = await scraper.scrape();
  assert.equal(res.ok, false);
  assert.equal(res.diagnostic.errorCode, "portfolio_view_missing");
  const flat = JSON.stringify(res.diagnostic.brokerDetail);
  assert.doesNotMatch(flat, /CZ00084/);
  assert.doesNotMatch(flat, /1234567890/);
  assert.deepEqual(Object.keys(res.diagnostic.brokerDetail).sort(), [
    "accounts_count", "had_token", "request_ok", "request_redirected",
    "request_status", "titles_by_type", "titles_count",
  ]);
});
