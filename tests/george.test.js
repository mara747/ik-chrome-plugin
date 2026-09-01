"use strict";

// George (Česká spořitelna) scraper: /my/securities snapshot → fund positions
// + share positions (web ADR 0010 and its 2026-09-01 addendum in the club
// repo). Fixture mirrors the live-calibrated shape (2026-09) with fake values:
// integer money + precision, FUND / SHARE / unknown titles on one account,
// derived average from investedValue.
//
// The calibration report attached to a SUCCESSFUL import (root ADR 0015
// addendum) is covered too: identity of the affected titles is allowed, sizes
// (shares, amounts, values) never are.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(require.resolve("../content/brokers/george.js"), "utf8");

const M = (value, precision) => ({ value, precision, currency: "CZK" });
const MC = (value, precision, currency) => ({ value, precision, currency });

// Values built inside the vm sandbox live in another realm — deepEqual would
// trip over the prototypes, so structural assertions compare plain JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

// SHARE on the same securities account, quoted in the ACCOUNT currency —
// the only case where the average may be derived from investedValue.
function shareTitle(over = {}) {
  return {
    isin: "cz0008019106",                // lowercase on purpose → uppercased
    title: "Komerční banka",
    fullTitle: "Komerční banka, a.s.",
    securityType: "SHARE",
    securitySubType: "STOCK",
    assetClass: "EQUITY",
    currency: "CZK",
    numberOfShares: 40,
    marketValue: M(3200000, 2),          // 32 000.00
    investedValue: M(2800000, 2),        // 28 000.00 → avg 700.00
    performance: M(400000, 2),
    positions: [{
      lastPrice: M(8000000, 4),
      stockExchange: "Burza cenných papírů Praha",
      stockExchangeCode: "XPRA",
      marketValue: M(3200000, 2),
      numberOfShares: 40,
    }],
    ...over,
  };
}

// Foreign-currency SHARE: George keeps investedValue in the ACCOUNT currency,
// so no average may be derived — the native amount lives in some other money
// field and that is exactly what calibration asks about.
function usdShareTitle(over = {}) {
  return {
    ...shareTitle(),
    isin: "US11135F1012",
    title: "Broadcom",
    fullTitle: "Broadcom Inc.",
    currency: "USD",
    numberOfShares: 3,
    marketValue: M(1500000, 2),          // CZK, account currency
    investedValue: M(1200000, 2),        // CZK too → unusable as an average
    marketValueInOriginalCurrency: MC(6400000, 2, "USD"),
    positions: [{
      lastPrice: MC(21333, 2, "USD"),
      stockExchange: "NASDAQ",
      stockExchangeCode: "XNAS",
    }],
    ...over,
  };
}

// A type we have no live sample of — must be skipped loudly, never guessed.
function bondTitle(over = {}) {
  return {
    isin: "CZ0003704165",
    title: "Dluhopis ČEZ 2030",
    securityType: "BOND",
    securitySubType: "CORPORATE",
    currency: "CZK",
    numberOfShares: 10,
    marketValue: M(1000000, 2),          // 10 000.00
    positions: [{ stockExchangeCode: "XPRA" }],
    ...over,
  };
}

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

test("skips unknown title types loudly and keeps them out of cash", async () => {
  const { scraper } = createHarness({
    body: accountBody([fundTitle(), bondTitle()], 2250000), // balance 22 500.00
  });
  const res = await scraper.scrape();
  assert.equal(res.ok, true);
  assert.equal(res.payload.positions.length, 1); // only the fund
  assert.equal(res.payload.positions[0].kind, "fund");
  // cash = 22 500 − (12 500 + 10 000) = 0 — the skipped bond must not leak in
  assert.equal(res.payload.cashValue, 0);
  const warned = res.payload.warnings.join(" ");
  assert.match(warned, /Dluhopis ČEZ 2030/);
  assert.match(warned, /diagnostiku/);

  // Identity of the skipped title travels in the calibration report.
  assert.equal(res.calibration.errorCode, "partial_import");
  assert.equal(res.calibration.phase, "scrape");
  assert.deepEqual(plain(res.calibration.brokerDetail.skipped_titles), [{
    isin: "CZ0003704165",
    title: "Dluhopis ČEZ 2030",
    security_type: "BOND",
    security_sub_type: "CORPORATE",
    exchange: "XPRA",
    currency: "CZK",
  }]);
  assert.deepEqual(plain(res.calibration.brokerDetail.money_fields), []);
  assert.equal(res.calibration.brokerDetail.titles_by_type.BOND, 1);
});

test("SHARE in the account currency imports as a plain ticker row", async () => {
  const { scraper } = createHarness({
    body: accountBody([shareTitle()], 3200000),
  });
  const res = await scraper.scrape();
  assert.equal(res.ok, true);
  assert.equal(res.payload.positions.length, 1);
  const p = res.payload.positions[0];
  assert.equal(p.ticker, "CZ0008019106");   // ISIN, uppercased
  assert.equal(p.shares, 40);
  assert.equal(p.avgCost, 700);             // 28 000 / 40
  assert.equal(p.currency, "CZK");
  assert.equal(p.note, "Komerční banka · XPRA");
  // A share is an ORDINARY position: no fund kind, no price snapshot, no name.
  assert.equal("kind" in p, false);
  assert.equal("price" in p, false);
  assert.equal("name" in p, false);
  assert.deepEqual(plain(Object.keys(p).sort()),
    ["avgCost", "currency", "note", "shares", "ticker"]);
  assert.deepEqual(plain(res.payload.warnings), []);
  assert.equal("calibration" in res, false); // nothing to calibrate
});

test("foreign-currency SHARE: no average, warning, money fields for calibration", async () => {
  const { scraper } = createHarness({
    body: accountBody([usdShareTitle()], 1500000),
  });
  const res = await scraper.scrape();
  assert.equal(res.ok, true);
  const p = res.payload.positions[0];
  assert.equal(p.ticker, "US11135F1012");
  assert.equal(p.shares, 3);
  assert.equal(p.avgCost, null);            // CZK invested vs USD title
  assert.equal(p.currency, "USD");
  assert.equal(p.note, "Broadcom · XNAS");
  assert.match(res.payload.warnings.join(" "), /Broadcom/);
  assert.match(res.payload.warnings.join(" "), /cizí měně/);

  assert.equal(res.calibration.errorCode, "partial_import");
  assert.deepEqual(plain(res.calibration.brokerDetail.skipped_titles), []);
  assert.deepEqual(plain(res.calibration.brokerDetail.money_fields), [{
    isin: "US11135F1012",
    fields: {
      marketValue: "CZK",
      investedValue: "CZK",
      performance: "CZK",
      marketValueInOriginalCurrency: "USD",
      "positions[0].lastPrice": "USD",
    },
  }]);
});

test("clean fund-only account attaches no calibration at all", async () => {
  const { scraper } = createHarness({ body: accountBody([fundTitle()]) });
  const res = await scraper.scrape();
  assert.equal(res.ok, true);
  assert.equal("calibration" in res, false);
  assert.equal(res.calibration, undefined);
});

test("calibration lists are capped at 20 items", async () => {
  const titles = [];
  for (let i = 0; i < 25; i += 1) {
    titles.push(bondTitle({
      isin: `CZ000370${String(4000 + i)}`,
      title: `Dluhopis ${i}`,
      marketValue: M(0, 2),
    }));
  }
  const { scraper } = createHarness({ body: accountBody(titles, 0) });
  const res = await scraper.scrape();
  assert.equal(res.ok, true);
  assert.equal(res.calibration.brokerDetail.skipped_titles.length, 20);
  assert.equal(res.calibration.brokerDetail.titles_count, 25); // count is honest
});

test("calibration detail stays under the server's 8192 B limit", async () => {
  const longTitle = "Dluhopisový certifikát s velmi dlouhým názvem, "
    + "který se do hlášení nesmí vejít celý ";
  const titles = [];
  for (let i = 0; i < 25; i += 1) {
    titles.push(bondTitle({
      isin: `CZ000370${String(4000 + i)}`,
      title: `${longTitle}${i}`,
      securitySubType: `${longTitle}sub`,
      marketValue: M(0, 2),
    }));
    // …plus foreign shares, whose money-field names blow the detail up fastest.
    const fields = {};
    for (let f = 0; f < 8; f += 1) {
      fields[`investedValueInOriginalCurrencyVariant${f}`] = MC(1, 2, "USD");
    }
    titles.push(usdShareTitle({
      isin: `US000000000${i}`,
      title: `${longTitle}${i}`,
      marketValue: M(0, 2),
      ...fields,
    }));
  }
  const { scraper } = createHarness({ body: accountBody(titles, 0) });
  const res = await scraper.scrape();
  const bytes = Buffer.byteLength(
    JSON.stringify(res.calibration.brokerDetail), "utf8");
  assert.ok(bytes <= 8192, `broker_detail is ${bytes} B`);
  // Trimming drops calibration ITEMS only — the counts stay honest.
  assert.ok(res.calibration.brokerDetail.skipped_titles.length > 0);
  assert.ok(res.calibration.brokerDetail.money_fields.length > 0);
  assert.ok(res.calibration.brokerDetail.skipped_titles.length
    + res.calibration.brokerDetail.money_fields.length < 40);
  assert.equal(res.calibration.brokerDetail.titles_count, 50);
});

test("calibration detail carries identity only — never shares or amounts", async () => {
  const leaky = usdShareTitle({
    numberOfShares: 7777,
    marketValue: M(424242, 2),
    investedValue: M(313131, 2),
    marketValueInOriginalCurrency: MC(191919, 2, "USD"),
    performance: M(858585, 2),
    positions: [{ lastPrice: MC(636363, 4, "USD"), stockExchangeCode: "XNAS" }],
  });
  const bond = bondTitle({ numberOfShares: 5151, marketValue: M(747474, 2) });
  const { scraper } = createHarness({
    body: accountBody([leaky, bond], 6666666),
  });
  const res = await scraper.scrape();
  const flat = JSON.stringify(res.calibration.brokerDetail);
  for (const leak of ["7777", "424242", "313131", "191919", "858585",
    "636363", "5151", "747474", "6666666", "4242.42", "3131.31"]) {
    assert.ok(!flat.includes(leak), `calibration leaked ${leak}`);
  }
  assert.doesNotMatch(flat, /1234567890/); // account number
  assert.deepEqual(plain(Object.keys(res.calibration.brokerDetail).sort()), [
    "accounts_count", "had_token", "money_fields", "request_ok",
    "request_redirected", "request_status", "skipped_titles",
    "titles_by_type", "titles_count",
  ]);
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
  assert.match(res.payload.warnings.join(" "), /žádné fondy ani akcie/);
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
