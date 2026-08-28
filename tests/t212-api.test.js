"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {
  buildPayload,
  ENDPOINTS,
  API_ROOT,
  fetchT212Data,
} = require("../content/brokers/t212-api.js");

const account = { id: 7, tradingType: "EQUITY", type: "LIVE", currencyCode: "CZK" };
const summary = {
  open: [{ code: "ACME_NL_EQ", quantity: 4.5, averagePrice: 58.84 }],
  cash: { free: 120, total: 1000 },
  accountsByType: {
    EQUITY: {
      open: [{ code: "ACME_NL_EQ", quantity: 4.5, averagePrice: 58.84 }],
      cash: { free: 120, total: 1000 },
    },
  },
};
const currentSummary = {
  activeAccountCurrency: "CZK",
  accountsByType: {
    EQUITY: {
      cash: {
        ppl: 0,
        result: 0,
        total: 1000,
        margin: null,
        free: null,
        indicator: null,
        blockedForStocks: 0,
        pieCash: 0,
        stockInvestment: 880,
        investPot: 100,
        spendingPot: 20,
        netDeposit: 900,
      },
      open: [{ code: "ACME_NL_EQ", quantity: 4.5, averagePrice: 58.84 }],
      orders: [],
      valueOrders: [],
    },
  },
};
const instruments = [{
  ticker: "ACME_NL_EQ",
  currency: "EUR",
  shortName: "Acme N.V.",
  isin: "NL0000000001",
}];

test("builds a normalized payload from original instrument values", () => {
  const result = buildPayload({ account, summary, instruments, now: "2026-08-04T12:00:00.000Z" });

  assert.deepEqual(result, {
    ok: true,
    payload: {
      broker: "t212",
      brokerLabel: "Trading 212",
      totalValue: 1000,
      cashValue: 120,
      currency: "CZK",
      positions: [{
        ticker: "ACME.AS",
        shares: 4.5,
        avgCost: 58.84,
        currency: "EUR",
        note: "ISIN: NL0000000001; název: Acme N.V.",
      }],
      warnings: [],
      scrapedAt: "2026-08-04T12:00:00.000Z",
    },
  });
});

test("rejects a position with no original average price", () => {
  const result = buildPayload({
    account,
    summary: { ...summary, open: [{ ...summary.open[0], averagePrice: null }] },
    instruments,
  });

  assert.equal(result.ok, false);
  assert.equal(result.needsCalibration, true);
  assert.match(result.error, /průměrnou nákupní cenu/i);
});

test("identifies the T212 instrument when its original average price is missing", () => {
  const result = buildPayload({
    account,
    summary: {
      ...summary,
      open: [{ ...summary.open[0], code: "ZETA_US_EQ", averagePrice: null }],
    },
    instruments,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /T212-POSITION-MISSING-AVERAGE-PRICE/);
  assert.match(result.error, /ZETA_US_EQ/);
});

test("identifies the T212 instrument when its metadata is missing", () => {
  const result = buildPayload({
    account,
    summary: { ...summary, open: [{ ...summary.open[0], code: "ZETA_US_EQ" }] },
    instruments: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /T212-INSTRUMENT-METADATA-MISSING/);
  assert.match(result.error, /ZETA_US_EQ/);
});

test("does not expose an unrecognized T212 position code in diagnostics", () => {
  const unsafeCode = "session token 123456789";
  const result = buildPayload({
    account,
    summary: {
      ...summary,
      open: [{ ...summary.open[0], code: unsafeCode, averagePrice: null }],
    },
    instruments,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /T212-POSITION-MISSING-AVERAGE-PRICE/);
  assert.match(result.error, /neznámý/);
  assert.equal(result.error.includes(unsafeCode), false);
});

test("does not expose an overlong T212 position code in diagnostics", () => {
  const unsafeCode = `${"A".repeat(75)}_US_EQ`;
  const result = buildPayload({
    account,
    summary: {
      ...summary,
      open: [{ ...summary.open[0], code: unsafeCode, averagePrice: null }],
    },
    instruments,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /T212-POSITION-MISSING-AVERAGE-PRICE/);
  assert.match(result.error, /neznámý/);
  assert.equal(result.error.includes(unsafeCode), false);
});

test("does not expose an invalid instrument currency in diagnostics", () => {
  const unsafeCurrency = "session token 123456789";
  const result = buildPayload({
    account,
    summary,
    instruments: [{ ...instruments[0], currency: unsafeCurrency }],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /T212-INSTRUMENT-INVALID-CURRENCY/);
  assert.match(result.error, /neznám/);
  assert.equal(result.error.includes(unsafeCurrency), false);
});

test("separates total account value from invest and spending cash", () => {
  const result = buildPayload({
    account,
    summary: {
      ...summary,
      cash: { total: 1000, free: 75, investPot: 100, spendingPot: 20, pieCash: 0 },
    },
    instruments,
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.totalValue, 1000);
  assert.equal(result.payload.cashValue, 120);
});

test("includes uninvested Pie Cash in broker-reported cash", () => {
  const result = buildPayload({
    account,
    summary: {
      ...summary,
      cash: { total: 1000, free: 75, investPot: 100, spendingPot: 20, pieCash: 30 },
    },
    instruments,
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.cashValue, 150);
});

test("adds the verified pending BUY reservation to cash", () => {
  const result = buildPayload({
    account,
    summary: {
      ...summary,
      cash: {
        total: 1000,
        investPot: 100,
        spendingPot: 20,
        pieCash: 30,
        blockedForStocks: 40,
      },
      orders: [{ type: "LIMIT", status: "NEW", quantity: 0.25, filledQuantity: 0 }],
      valueOrders: [],
    },
    instruments,
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.cashValue, 190);
});

test("accepts decimal text fields for a verified pending BUY", () => {
  const result = buildPayload({
    account,
    summary: {
      ...summary,
      cash: {
        total: 1000,
        investPot: 100,
        spendingPot: 20,
        pieCash: 30,
        blockedForStocks: 40,
      },
      orders: [{ type: "LIMIT", status: "NEW", quantity: "0.25", filledQuantity: "0" }],
      valueOrders: [],
    },
    instruments,
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.cashValue, 190);
});

test("does not count a verified pending SELL as position cash", () => {
  const result = buildPayload({
    account,
    summary: {
      ...summary,
      cash: {
        total: 1000,
        investPot: 100,
        spendingPot: 20,
        pieCash: 30,
        blockedForStocks: 40,
      },
      orders: [
        { type: "LIMIT", status: "NEW", quantity: 0.25, filledQuantity: 0 },
        { type: "LIMIT", status: "NEW", quantity: -1, filledQuantity: 0 },
      ],
      valueOrders: [],
    },
    instruments,
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.cashValue, 190);
  assert.equal(result.payload.positions[0].shares, 4.5);
});

test("omits cash when a pending order is partially filled or not NEW", () => {
  for (const order of [
    { type: "LIMIT", status: "NEW", quantity: 0.25, filledQuantity: 0.1 },
    { type: "LIMIT", status: "CANCELLED", quantity: 0.25, filledQuantity: 0 },
  ]) {
    const result = buildPayload({
      account,
      summary: {
        ...summary,
        cash: {
          total: 1000,
          investPot: 100,
          spendingPot: 20,
          pieCash: 30,
          blockedForStocks: 40,
        },
        orders: [order],
        valueOrders: [],
      },
      instruments,
    });

    assert.equal(result.ok, true);
    assert.equal(result.payload.cashValue, null);
    assert.ok(result.payload.warnings.includes(
      "Trading 212 vrátilo nejednoznačný stav čekajících pokynů; hotovost nebyla načtena.",
    ));
  }
});

test("omits cash when a zero reservation accompanies an unsafe ordinary order", () => {
  const result = buildPayload({
    account,
    summary: {
      ...summary,
      cash: {
        total: 1000,
        investPot: 100,
        spendingPot: 20,
        pieCash: 30,
        blockedForStocks: 0,
      },
      orders: [{ type: "LIMIT", status: "CANCELLED", quantity: 0.25, filledQuantity: 0 }],
      valueOrders: [],
    },
    instruments,
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.cashValue, null);
  assert.ok(result.payload.warnings.includes(
    "Trading 212 vrátilo nejednoznačný stav čekajících pokynů; hotovost nebyla načtena.",
  ));
});

test("omits cash when a zero reservation accompanies Pie value orders", () => {
  const result = buildPayload({
    account,
    summary: {
      ...summary,
      cash: {
        total: 1000,
        investPot: 100,
        spendingPot: 20,
        pieCash: 30,
        blockedForStocks: 0,
      },
      orders: [],
      valueOrders: [{ type: "LIMIT", status: "NEW", quantity: 0.25, filledQuantity: 0 }],
    },
    instruments,
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.cashValue, null);
  assert.ok(result.payload.warnings.includes(
    "Trading 212 vrátilo nejednoznačný stav čekajících pokynů; hotovost nebyla načtena.",
  ));
});

test("omits cash when a pending BUY has a nonnumeric filled quantity", () => {
  for (const filledQuantity of [null, "", false]) {
    const result = buildPayload({
      account,
      summary: {
        ...summary,
        cash: {
          total: 1000,
          investPot: 100,
          spendingPot: 20,
          pieCash: 30,
          blockedForStocks: 40,
        },
        orders: [{ type: "LIMIT", status: "NEW", quantity: 0.25, filledQuantity }],
        valueOrders: [],
      },
      instruments,
    });

    assert.equal(result.ok, true);
    assert.equal(result.payload.cashValue, null);
    assert.ok(result.payload.warnings.includes(
      "Trading 212 vrátilo nejednoznačný stav čekajících pokynů; hotovost nebyla načtena.",
    ));
  }
});

test("omits cash when pending-order numeric fields are non-scalar or non-decimal", () => {
  for (const order of [
    { type: "LIMIT", status: "NEW", quantity: [0.25], filledQuantity: 0 },
    { type: "LIMIT", status: "NEW", quantity: 0.25, filledQuantity: [] },
    { type: "LIMIT", status: "NEW", quantity: "0x1", filledQuantity: "0x0" },
  ]) {
    const result = buildPayload({
      account,
      summary: {
        ...summary,
        cash: {
          total: 1000,
          investPot: 100,
          spendingPot: 20,
          pieCash: 30,
          blockedForStocks: 40,
        },
        orders: [order],
        valueOrders: [],
      },
      instruments,
    });

    assert.equal(result.ok, true);
    assert.equal(result.payload.cashValue, null);
    assert.ok(result.payload.warnings.includes(
      "Trading 212 vrátilo nejednoznačný stav čekajících pokynů; hotovost nebyla načtena.",
    ));
  }
});

test("omits cash when T212 returns unverified Pie value orders", () => {
  const result = buildPayload({
    account,
    summary: {
      ...summary,
      cash: {
        total: 1000,
        investPot: 100,
        spendingPot: 20,
        pieCash: 30,
        blockedForStocks: 40,
      },
      orders: [{ type: "LIMIT", status: "NEW", quantity: 0.25, filledQuantity: 0 }],
      valueOrders: [{ type: "LIMIT", status: "NEW", quantity: 0.25, filledQuantity: 0 }],
    },
    instruments,
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.cashValue, null);
  assert.ok(result.payload.warnings.includes(
    "Trading 212 vrátilo nejednoznačný stav čekajících pokynů; hotovost nebyla načtena.",
  ));
});

test("does not report partial cash when the Pie Cash component is missing", () => {
  const result = buildPayload({
    account,
    summary: {
      ...summary,
      cash: { total: 1000, free: 75, investPot: 100, spendingPot: 20 },
    },
    instruments,
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.cashValue, null);
  assert.match(result.payload.warnings[0], /hotovost/i);
});

test("continues with a warning when Trading 212 omits the cash breakdown", () => {
  const result = buildPayload({
    account,
    summary: {
      ...summary,
      cash: { total: 1000 },
      accountsByType: { EQUITY: { ...summary.accountsByType.EQUITY, cash: { total: 1000 } } },
    },
    instruments,
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.cashValue, null);
  assert.deepEqual(result.payload.warnings, [
    "Trading 212 nevrátilo hotovost; web klubu ji dopočítá z celkové hodnoty a pozic.",
  ]);
});

test("rejects a ticker from an unknown exchange venue", () => {
  const result = buildPayload({
    account,
    summary: { ...summary, open: [{ ...summary.open[0], code: "ACME_XX_EQ" }] },
    instruments: [{ ...instruments[0], ticker: "ACME_XX_EQ" }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.needsCalibration, true);
  assert.match(result.error, /neznámé burzy/i);
});

test("identifies the T212 instrument and venue when the exchange is unsupported", () => {
  const result = buildPayload({
    account,
    summary: { ...summary, open: [{ ...summary.open[0], code: "ZETA_XX_EQ" }] },
    instruments: [{ ...instruments[0], ticker: "ZETA_XX_EQ" }],
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /T212-INSTRUMENT-UNKNOWN-VENUE/);
  assert.match(result.error, /ZETA_XX_EQ/);
  assert.match(result.error, /XX/);
});

test("maps verified T212 exchange shorthand codes to Yahoo suffixes", () => {
  const cases = [
    { code: "ACMEa_EQ", yahooTicker: "ACME.AS" },
    { code: "ACMEd_EQ", yahooTicker: "ACME.DE" },
    { code: "ACMEl_EQ", yahooTicker: "ACME.L" },
    { code: "ACMEp_EQ", yahooTicker: "ACME.PA" },
  ];

  const actual = cases.map(({ code }) => buildPayload({
    account,
    summary: { ...summary, open: [{ ...summary.open[0], code }] },
    instruments: [{ ...instruments[0], ticker: code }],
  })).map((result) => result.ok ? result.payload.positions[0].ticker : result.error);

  assert.deepEqual(actual, cases.map(({ yahooTicker }) => yahooTicker));
});

test("matches uppercase position codes to canonical instrument tickers", () => {
  const result = buildPayload({
    account,
    summary: { ...summary, open: [{ ...summary.open[0], code: "ACMEL_EQ" }] },
    instruments: [{ ...instruments[0], ticker: "ACMEl_EQ" }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.positions[0].ticker, "ACME.L");
  assert.equal(result.payload.positions[0].currency, "EUR");
});

test("preserves GBX prices and maps London instruments to Yahoo .L", () => {
  const result = buildPayload({
    account,
    summary: { ...summary, open: [{ ...summary.open[0], code: "ACME_GB_EQ", averagePrice: 1234.5 }] },
    instruments: [{ ...instruments[0], ticker: "ACME_GB_EQ", currency: "GBX" }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.payload.positions[0].ticker, "ACME.L");
  assert.equal(result.payload.positions[0].currency, "GBX");
  assert.equal(result.payload.positions[0].avgCost, 1234.5);
});

test("reports missing instrument metadata separately from a missing currency", () => {
  const result = buildPayload({ account, summary, instruments: [] });

  assert.equal(result.ok, false);
  assert.equal(result.needsCalibration, true);
  assert.match(result.error, /metadata instrumentu/i);
  assert.doesNotMatch(result.error, /měnu instrumentu/i);
});

test("exports the session API paths used by the importer", () => {
  assert.deepEqual(ENDPOINTS, {
    accounts: "/rest/v1/accounts",
    summary: "/rest/v1/equity/multi-accounts/summary",
    instruments: "/instrumentarium/v2/instruments/find",
    instrumentCatalog: "/instrumentarium/v2/instruments/0",
  });
});

test("uses the logged-in session for accounts, positions and metadata", async () => {
  const requests = [];
  const replies = [
    [account],
    summary,
    instruments,
  ];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => replies.shift() };
  };

  const data = await fetchT212Data(fetchImpl);

  assert.deepEqual(data, { account, summary, instruments, warnings: [] });
  assert.deepEqual(requests.map((request) => request.url), [
    `${API_ROOT}/rest/v1/accounts`,
    `${API_ROOT}/rest/v1/equity/multi-accounts/summary?targetCurrency=CZK`,
    `${API_ROOT}/instrumentarium/v2/instruments/find`,
  ]);
  assert.equal(requests.every((request) => request.init.credentials === "include"), true);
  assert.equal(requests[1].init.body, "[]");
  assert.equal(requests[2].init.body, '["ACME_NL_EQ"]');
});

test("recovers metadata omitted by /find from the T212 instrument catalog", async () => {
  const requests = [];
  const catalogInstrument = {
    ticker: "ACME_NL_EQ",
    type: "STOCK",
    currency: "EUR",
    shortName: "Acme N.V.",
    fullName: "Acme N.V.",
    exchangeId: 1,
    isin: "NL0000000001",
  };
  const replies = [
    [account],
    summary,
    [],
    { timestamp: 123, instruments: [catalogInstrument] },
  ];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => replies.shift() };
  };

  const data = await fetchT212Data(fetchImpl, {
    deviceId: "transient-device",
    appVersion: "8.41.0",
  });
  const result = buildPayload({ ...data, now: "2026-08-04T12:00:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(result.payload.positions[0].currency, "EUR");
  assert.equal(result.payload.positions[0].ticker, "ACME.AS");
  assert.deepEqual(data.instruments, [catalogInstrument]);
  assert.equal(
    requests[3].url,
    `${API_ROOT}/instrumentarium/v2/instruments/0`,
  );
  assert.equal(requests[3].init.method, undefined);
  assert.equal(requests[3].init.body, undefined);
});

test("selects the live Equity account from the current accounts wrapper", async () => {
  const replies = [
    { liveAccounts: [account], demoAccounts: [] },
    summary,
    instruments,
  ];
  const fetchImpl = async () => ({ ok: true, json: async () => replies.shift() });

  const data = await fetchT212Data(fetchImpl, {
    deviceId: "transient-device",
    appVersion: "8.41.0",
  });

  assert.deepEqual(data, { account, summary, instruments, warnings: [] });
});

test("warns before import when Trading 212 returns multiple live Equity accounts", async () => {
  const replies = [
    { liveAccounts: [account, { ...account, id: 8 }], demoAccounts: [] },
    summary,
    instruments,
  ];
  const fetchImpl = async () => ({ ok: true, json: async () => replies.shift() });

  const data = await fetchT212Data(fetchImpl, {
    deviceId: "transient-device",
    appVersion: "8.41.0",
  });
  const result = buildPayload(data);

  assert.equal(result.ok, true);
  assert.deepEqual(result.payload.warnings, [
    "Trading 212 vrátilo více živých investičních účtů; načten byl první v pořadí. Před odesláním ověř hodnotu a pozice.",
  ]);
});

test("imports the active account slice from the current multi-account summary", async () => {
  const replies = [
    { liveAccounts: [account], demoAccounts: [] },
    currentSummary,
    instruments,
  ];
  const fetchImpl = async () => ({ ok: true, json: async () => replies.shift() });

  const data = await fetchT212Data(fetchImpl, {
    deviceId: "transient-device",
    appVersion: "8.41.0",
  });
  const result = buildPayload({ ...data, now: "2026-08-04T12:00:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(result.payload.totalValue, 1000);
  assert.equal(result.payload.cashValue, 120);
  assert.deepEqual(result.payload.positions.map(({ ticker, shares, avgCost, currency }) => ({
    ticker, shares, avgCost, currency,
  })), [{ ticker: "ACME.AS", shares: 4.5, avgCost: 58.84, currency: "EUR" }]);
});

test("reads total value only from the selected account type", async () => {
  const summaryWithOtherAccountData = {
    ...currentSummary,
    total: 9000,
    accountsByType: {
      ...currentSummary.accountsByType,
      CFD: {
        cash: { total: 8000 },
        open: [],
      },
    },
  };
  const replies = [
    { liveAccounts: [account], demoAccounts: [] },
    summaryWithOtherAccountData,
    instruments,
  ];
  const fetchImpl = async () => ({ ok: true, json: async () => replies.shift() });

  const data = await fetchT212Data(fetchImpl, {
    deviceId: "transient-device",
    appVersion: "8.41.0",
  });
  const result = buildPayload({ ...data });

  assert.equal(result.ok, true);
  assert.equal(result.payload.totalValue, 1000);
});

test("adds transient Trading 212 client headers without persisting them", async () => {
  const requests = [];
  const replies = [[account], summary, instruments];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => replies.shift() };
  };

  await fetchT212Data(fetchImpl, { deviceId: "transient-device", appVersion: "8.41.0" });

  assert.deepEqual(requests.map((request) => request.init.headers["X-Trader-Target-Type"]), [
    "EQUITY", "EQUITY", "EQUITY",
  ]);
  assert.equal(requests[0].init.headers["X-Trader-Device-Model"], "Chrome");
  assert.equal(
    requests[0].init.headers["X-Trader-Client"],
    "application=WC4,version=8.41.0,dUUID=transient-device",
  );
  assert.equal(
    requests[1].init.headers["X-Trader-Client"],
    "application=WC4,version=8.41.0,dUUID=transient-device,accountId=7",
  );
});

test("reports only the failed API stage and HTTP status", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ ignored: true }) });

  await assert.rejects(
    () => fetchT212Data(fetchImpl, { deviceId: "transient-device", appVersion: "8.41.0" }),
    (error) => error.t212Stage === "accounts" && error.t212Status === 403,
  );
});

test("labels malformed responses with the endpoint that returned them", async () => {
  const scenarios = [
    { expectedStage: "accounts", replies: [{ liveAccounts: [account] }] },
    { expectedStage: "summary", replies: [[account], { open: null }] },
    { expectedStage: "instruments", replies: [[account], summary, { instruments: [] }] },
  ];
  const actualStages = [];

  for (const scenario of scenarios) {
    const replies = [...scenario.replies];
    const fetchImpl = async () => ({ ok: true, json: async () => replies.shift() });
    try {
      await fetchT212Data(fetchImpl, { deviceId: "transient-device", appVersion: "8.41.0" });
      actualStages.push("no error");
    } catch (error) {
      actualStages.push(error.t212Stage);
    }
  }

  assert.deepEqual(actualStages, scenarios.map((scenario) => scenario.expectedStage));
});

test("labels a missing page fetch as an importer-runtime failure", async () => {
  await assert.rejects(
    () => fetchT212Data(null, { deviceId: "transient-device", appVersion: "8.41.0" }),
    (error) => error.t212Stage === "runtime",
  );
});

test("keeps both T212 execution-world resources with the broker adapters", () => {
  const manifest = require("../manifest.json");
  const mainWorld = manifest.content_scripts.find((entry) => entry.world === "MAIN");
  const isolatedWorld = manifest.content_scripts.find((entry) => (
    entry.matches?.includes("https://app.trading212.com/*") && entry.world !== "MAIN"
  ));

  assert.ok(mainWorld);
  assert.deepEqual(mainWorld.js, ["content/brokers/t212-api.js"]);
  assert.equal(mainWorld.run_at, "document_idle");
  assert.ok(isolatedWorld);
  assert.deepEqual(isolatedWorld.js, ["lib/normalize.js", "content/brokers/t212.js"]);
  assert.equal(mainWorld.js.some((file) => file.startsWith("lib/") || file === "content/t212-page-api.js"), false);
  assert.equal(manifest.host_permissions, undefined);
});

test("uses the page-global fetch when a free fetch binding is unavailable", async () => {
  const source = fs.readFileSync(require.resolve("../content/brokers/t212-api.js"), "utf8");
  const replies = [[account], summary, instruments];
  const requests = [];
  const pageFetch = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, json: async () => replies.shift() };
  };
  let messageListener;
  let postedMessage;
  const sandbox = {
    fetch: pageFetch,
    crypto: { randomUUID: () => "synthetic-device" },
    location: { origin: "https://app.trading212.com" },
  };
  sandbox.window = {
    addEventListener(type, listener) {
      if (type === "message") messageListener = listener;
    },
    postMessage(message) {
      postedMessage = message;
    },
  };
  sandbox.lexicalScope = new Proxy({}, {
    has(_target, property) {
      return property === "fetch";
    },
    get(_target, property) {
      if (property === Symbol.unscopables) return undefined;
      if (property === "fetch") throw new ReferenceError("free fetch binding is unavailable");
      return undefined;
    },
  });

  vm.createContext(sandbox);
  vm.runInContext(
    `(function (scope) { with (scope) { return function () {\n${source}\n}; } })(lexicalScope)();`,
    sandbox,
  );
  await messageListener({
    source: sandbox.window,
    origin: sandbox.location.origin,
    data: {
      channel: "ik-t212-session-bridge",
      type: "request",
      requestId: "request",
      nonce: "nonce",
    },
  });

  assert.equal(requests.length, 3);
  assert.equal(postedMessage.result.ok, true);
});

test("registers only the isolated scraper when extension APIs are available", () => {
  const source = fs.readFileSync(require.resolve("../content/brokers/t212.js"), "utf8");
  let registered;
  let pageListeners = 0;
  const sandbox = {
    chrome: { runtime: { id: "synthetic-extension" } },
    IK: { registerScraper(definition) { registered = definition; } },
    window: { addEventListener() { pageListeners += 1; } },
    location: { origin: "https://app.trading212.com" },
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  assert.equal(registered.broker, "t212");
  assert.equal(pageListeners, 0);
});

test("registers the isolated scraper when normalize exposes only IK", () => {
  const source = fs.readFileSync(require.resolve("../content/brokers/t212.js"), "utf8");
  let registered;
  let pageListeners = 0;
  const sandbox = {
    IK: { registerScraper(definition) { registered = definition; } },
    window: { addEventListener() { pageListeners += 1; } },
    location: { origin: "https://app.trading212.com" },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  assert.equal(registered.broker, "t212");
  assert.equal(pageListeners, 0);
});

test("exports the T212 API functions from the MAIN-world broker adapter in Node", () => {
  assert.equal(typeof buildPayload, "function");
  assert.equal(typeof fetchT212Data, "function");
});
