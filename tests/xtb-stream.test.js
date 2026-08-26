"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const stream = require("../content/brokers/xtb-stream.js");

const ACCOUNT_SECRET = "account-secret-alpha";
const ENDPOINT_SECRET = "endpoint-secret-beta";
const POSITION_SECRET = -900000000001;
const QUOTE_SECRET = 700000000001;

function element(propertyName, record, state = 1) {
  return { state, value: { [propertyName]: record }, stamp: 123456789 };
}

function responseFrame(reqId, elements, completed = true) {
  return {
    reqId: `${reqId}_synthetic-suffix`,
    status: 0,
    response: [{ element: { elements } }],
    completed,
  };
}

function accountFrame(account = ACCOUNT_SECRET, endpoint = ENDPOINT_SECRET, currency = "USD") {
  return responseFrame("settingsGetAccountData", [element("xmt4account", {
    accountID: { wtaccountid: { accountNo: account, endpointID: endpoint } },
    currency,
    unrelatedSecret: "discard-account-secret",
  })]);
}

function catalogFrame(records = [
  {
      quoteId: QUOTE_SECRET,
      name: "ACME.US",
      displayName: "Acme Incorporated",
      unrelatedSecret: "discard-catalog-secret",
  },
  {
      quoteId: QUOTE_SECRET + 1,
      name: "BETA.DE",
      displayName: "Beta GmbH",
  },
]) {
  return responseFrame("getAllSymbolsLight", records.map((record) => element("xcfdsymbol", record)));
}

function tradeRecord(overrides = {}) {
  return {
    account: ACCOUNT_SECRET,
    login: ACCOUNT_SECRET,
    symbol: "ACME.US",
    idQuote: QUOTE_SECRET,
    recordType: 0,
    tradeType: 0,
    side: 0,
    volume: 1,
    openPrice: 10,
    positionId: POSITION_SECRET,
    order: -123,
    comment: "discard-trade-secret",
    ...overrides,
  };
}

function tradeFrame(records = [
  tradeRecord(),
  tradeRecord({ positionId: POSITION_SECRET - 1, volume: 2, openPrice: 20 }),
]) {
  return responseFrame("getAndSubscribeTradeRecord", records.map((record) => element("xcfdtrade", record)));
}

function profitFrame(records = [
  { idPosition: POSITION_SECRET, accountId: 111, marketValue: 100, unrelatedSecret: "discard-profit-secret" },
  { idPosition: POSITION_SECRET - 1, accountId: 111, marketValue: 200 },
]) {
  return responseFrame("getAndSubscribeTradeProfit", records.map((record) => element("xtradeprofit", record)));
}

function balanceRecord(overrides = {}) {
  return {
    aid: { accountNo: ACCOUNT_SECRET, endpointID: ENDPOINT_SECRET },
    balance: 25,
    equity: 25,
    freeMargin: 25,
    stockFreeMargin: 25,
    stockLock: 0,
    cashStockValue: 975,
    totalEquity: 1000,
    stockValue: 975,
    unrelatedSecret: "discard-balance-secret",
    ...overrides,
  };
}

function balanceFrame(account = ACCOUNT_SECRET, endpoint = ENDPOINT_SECRET, overrides = {}) {
  return responseFrame("getAndSubscribeTotalBalance", [element("xtotalbalance", balanceRecord({
    aid: { accountNo: account, endpointID: endpoint },
    ...overrides,
  }))]);
}

test("reduces only completed known XTB response families", () => {
  const reducer = stream.createStreamReducer();
  reducer.inspectTransport("incoming", { segment: "socket", result: [{ 5: accountFrame() }] });
  reducer.inspectTransport("incoming", { segment: "socket", result: [{ 6: catalogFrame() }] });
  reducer.inspectTransport("incoming", tradeFrame());
  reducer.inspectTransport("incoming", profitFrame());
  reducer.inspectTransport("incoming", balanceFrame());

  const snapshot = reducer.snapshot();
  assert.equal(snapshot.account.currency, "USD");
  assert.equal(snapshot.catalogByQuoteId.size, 2);
  assert.equal(snapshot.tradeEntries.length, 2);
  assert.equal(snapshot.profits.length, 2);
  assert.equal(snapshot.completed.account, true);
  assert.equal(snapshot.completed.catalog, true);
  assert.equal(snapshot.completed.trades, true);
  assert.equal(snapshot.completed.profits, true);
  assert.equal(snapshot.completed.balance, true);
});

test("ignores unknown request families and incomplete snapshots", () => {
  const reducer = stream.createStreamReducer();
  reducer.inspectTransport("incoming", { reqId: "privateCommand_secret", response: [] });
  reducer.inspectTransport("incoming", { ...tradeFrame(), completed: false });
  assert.equal(reducer.snapshot().tradeEntries.length, 0);
  assert.equal(reducer.snapshot().completed.trades, false);
});

test("ignores request identifiers that only contain a known family name", () => {
  const reducer = stream.createStreamReducer();
  reducer.inspectTransport("incoming", {
    ...accountFrame(),
    reqId: "forgetAccountData_synthetic-suffix",
  });

  assert.equal(reducer.snapshot().account, null);
  assert.equal(reducer.snapshot().completed.account, false);
});

test("ignores settings account-data envelopes without an xmt4account record", () => {
  const reducer = stream.createStreamReducer();
  reducer.inspectTransport("incoming", accountFrame());
  reducer.inspectTransport("incoming", {
    reqId: "settingsGetAccountData_synthetic",
    status: 0,
    response: [{ xaccountdata: { value: "settings-secret" } }],
    completed: true,
  });
  assert.equal(reducer.snapshot().account.currency, "USD");
});

test("discards account-scoped records when the complete account identity changes", () => {
  const reducer = stream.createStreamReducer();
  reducer.inspectTransport("incoming", accountFrame("first-account", "endpoint-a", "EUR"));
  reducer.inspectTransport("incoming", tradeFrame());
  reducer.inspectTransport("incoming", profitFrame());
  reducer.inspectTransport("incoming", balanceFrame());
  reducer.inspectTransport("incoming", accountFrame("second-account", "endpoint-b", "USD"));

  const snapshot = reducer.snapshot();
  assert.equal(snapshot.generation, 1);
  assert.equal(snapshot.account.currency, "USD");
  assert.deepEqual(snapshot.tradeEntries, []);
  assert.deepEqual(snapshot.profits, []);
  assert.equal(snapshot.balance, null);
  assert.equal(snapshot.completed.trades, false);
});

test("starts a new generation when the same account key changes currency", () => {
  const reducer = stream.createStreamReducer();
  feedCoherentStream(reducer);
  reducer.inspectTransport("incoming", accountFrame(ACCOUNT_SECRET, ENDPOINT_SECRET, "EUR"));

  const snapshot = reducer.snapshot();
  const result = stream.buildPayloadFromStreamSnapshot(snapshot);

  assert.equal(snapshot.generation, 1);
  assert.equal(snapshot.account.currency, "EUR");
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "incomplete");
});

test("requires fresh account-scoped data after a malformed account baseline", () => {
  const reducer = stream.createStreamReducer();
  feedCoherentStream(reducer);
  reducer.inspectTransport("incoming", responseFrame("settingsGetAccountData", [
    element("xmt4account", {
      accountID: { wtaccountid: { accountNo: ACCOUNT_SECRET, endpointID: ENDPOINT_SECRET } },
      currency: "USD",
    }),
    element("xmt4account", {
      accountID: { wtaccountid: { accountNo: "other-account", endpointID: "other-endpoint" } },
      currency: "EUR",
    }),
  ]));
  reducer.inspectTransport("incoming", accountFrame());

  const snapshot = reducer.snapshot();
  const result = stream.buildPayloadFromStreamSnapshot(snapshot);

  assert.equal(snapshot.generation, 1);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "incomplete");
});

test("ignores account-scoped snapshots observed before the active-account baseline", () => {
  const reducer = stream.createStreamReducer();
  reducer.inspectTransport("incoming", catalogFrame());
  reducer.inspectTransport("incoming", tradeFrame());
  reducer.inspectTransport("incoming", profitFrame());
  reducer.inspectTransport("incoming", balanceFrame());
  reducer.inspectTransport("incoming", accountFrame());

  const result = stream.buildPayloadFromStreamSnapshot(reducer.snapshot());

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "incomplete");
});

test("rejects account-scoped snapshots tagged with another account generation", () => {
  const snapshot = coherentSnapshot();
  snapshot.accountScopedGenerations = {
    trades: snapshot.generation,
    profits: snapshot.generation - 1,
    balance: snapshot.generation,
  };

  const result = stream.buildPayloadFromStreamSnapshot(snapshot);

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "incomplete");
});

test("copies only whitelisted fields from page-owned protocol records", () => {
  const reducer = stream.createStreamReducer();
  reducer.inspectTransport("incoming", accountFrame());
  reducer.inspectTransport("incoming", catalogFrame());
  reducer.inspectTransport("incoming", tradeFrame());
  reducer.inspectTransport("incoming", profitFrame());
  reducer.inspectTransport("incoming", balanceFrame());

  const serialized = JSON.stringify({
    ...reducer.snapshot(),
    catalogByQuoteId: [...reducer.snapshot().catalogByQuoteId],
  });
  assert.doesNotMatch(serialized, /discard-(?:account|catalog|trade|profit|balance)-secret/);
  assert.doesNotMatch(serialized, /comment|marketValue|stockValue/);
});

function coherentSnapshot(overrides = {}) {
  const reducer = stream.createStreamReducer();
  reducer.inspectTransport("incoming", overrides.accountFrame || accountFrame());
  reducer.inspectTransport("incoming", overrides.catalogFrame || catalogFrame());
  reducer.inspectTransport("incoming", tradeFrame(overrides.trades));
  reducer.inspectTransport("incoming", profitFrame(overrides.profits));
  reducer.inspectTransport("incoming", overrides.balanceFrame || balanceFrame());
  return reducer.snapshot();
}

test("excludes the live-calibrated pending-order lifecycle tuple from positions", () => {
  const trades = [
    tradeRecord({ positionId: POSITION_SECRET, volume: 1, openPrice: 10 }),
    tradeRecord({ positionId: POSITION_SECRET - 1, volume: 2, openPrice: 20 }),
    tradeRecord({
      positionId: POSITION_SECRET - 2,
      symbol: "CLOSED.US",
      idQuote: QUOTE_SECRET + 2,
      recordType: 1,
      tradeType: 1,
      side: 0,
    }),
  ];
  const profits = [{ idPosition: POSITION_SECRET }, { idPosition: POSITION_SECRET - 1 }];

  const result = stream.buildPayloadFromStreamSnapshot(
    coherentSnapshot({ trades, profits }),
    "2026-08-25T00:00:00.000Z",
  );

  assert.equal(result.ok, true);
  assert.equal(result.payload.positions.length, 1);
  assert.equal(result.payload.positions[0].ticker, "ACME");
});

test("fails closed when eligible trade and profit position-id sets differ", () => {
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    profits: [{ idPosition: -999 }],
  }));

  assert.equal(result.ok, false);
  assert.equal(result.needsCalibration, true);
  assert.match(result.error, /pozic/i);
});

test("groups executions by canonical symbol and computes native weighted average", () => {
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot(), "2026-08-25T00:00:00.000Z");

  assert.equal(result.ok, true);
  assert.deepEqual(result.payload.positions, [{
    ticker: "ACME",
    shares: 3,
    avgCost: 50 / 3,
    currency: "USD",
    note: "ACME.US (Acme Incorporated)",
  }]);
  assert.equal(result.payload.scrapedAt, "2026-08-25T00:00:00.000Z");
});

test("accepts a traded catalog pair when many symbols share the same quote id", () => {
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    catalogFrame: catalogFrame([
      { quoteId: QUOTE_SECRET, name: "ACME.US" },
      { quoteId: QUOTE_SECRET, name: "OTHER.US" },
    ]),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.payload.positions[0].ticker, "ACME");
});

test("carries the raw XTB symbol and matched catalog display name into the position note", () => {
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    catalogFrame: catalogFrame([
      { quoteId: QUOTE_SECRET, name: "ACME.US", displayName: "Acme Incorporated" },
      { quoteId: QUOTE_SECRET, name: "OTHER.US", displayName: "Other Company" },
    ]),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.payload.positions[0].note, "ACME.US (Acme Incorporated)");
});

test("uses only the raw XTB symbol when the matched catalog name is blank", () => {
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    catalogFrame: catalogFrame([
      { quoteId: QUOTE_SECRET, name: "ACME.US", displayName: "  " },
    ]),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.payload.positions[0].note, "ACME.US");
});

test("uses totalEquity and reports consensus free funds", () => {
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot());

  assert.equal(result.ok, true);
  assert.equal(result.payload.currency, "USD");
  assert.equal(result.payload.totalValue, 1000);
  assert.equal(result.payload.cashValue, 25);
  assert.deepEqual(result.payload.warnings, []);
});

test("adds XTB stockLock to free funds for a corroborated pending buy order", () => {
  const trades = [
    tradeRecord(),
    tradeRecord({ positionId: POSITION_SECRET - 1, volume: 2, openPrice: 20 }),
    tradeRecord({
      positionId: POSITION_SECRET - 2,
      recordType: 1,
      tradeType: 1,
      side: 0,
      volume: 2,
      openPrice: 10,
    }),
  ];
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    trades,
    balanceFrame: balanceFrame(ACCOUNT_SECRET, ENDPOINT_SECRET, {
      balance: 5,
      equity: 5,
      freeMargin: 5,
      stockFreeMargin: 5,
      stockLock: 20,
      cashStockValue: 75,
      totalEquity: 100,
    }),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.payload.cashValue, 25);
  assert.deepEqual(result.payload.warnings, []);
});

test("ignores a pending sell order when confirming cash", () => {
  const trades = [
    tradeRecord(),
    tradeRecord({ positionId: POSITION_SECRET - 1, volume: 2, openPrice: 20 }),
    tradeRecord({
      positionId: POSITION_SECRET - 2,
      recordType: 1,
      tradeType: 1,
      side: 1,
      volume: 3,
      openPrice: 20,
    }),
  ];
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    trades,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.payload.cashValue, 25);
  assert.deepEqual(result.payload.warnings, []);
});

test("adds BUY stockLock while ignoring simultaneous pending SELL orders", () => {
  const trades = [
    tradeRecord(),
    tradeRecord({ positionId: POSITION_SECRET - 1, volume: 2, openPrice: 20 }),
    tradeRecord({
      positionId: POSITION_SECRET - 2,
      recordType: 1,
      tradeType: 1,
      side: 0,
      volume: 2,
      openPrice: 10,
    }),
    tradeRecord({
      positionId: POSITION_SECRET - 3,
      recordType: 1,
      tradeType: 1,
      side: 1,
      volume: 0.5,
      openPrice: 60,
    }),
  ];
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    trades,
    balanceFrame: balanceFrame(ACCOUNT_SECRET, ENDPOINT_SECRET, {
      balance: 5,
      equity: 5,
      freeMargin: 5,
      stockFreeMargin: 5,
      stockLock: 20,
      cashStockValue: 75,
      totalEquity: 100,
    }),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.payload.cashValue, 25);
  assert.deepEqual(result.payload.warnings, []);
});

test("omits locked cash when no recognized pending buy order corroborates it", () => {
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    balanceFrame: balanceFrame(ACCOUNT_SECRET, ENDPOINT_SECRET, {
      stockLock: 20,
      cashStockValue: 955,
    }),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.payload.cashValue, null);
  assert.equal(result.payload.warnings.length, 1);
});

test("fails closed for malformed or uncorroborated locked-cash boundaries", () => {
  const sellOnlyTrades = [
    tradeRecord(),
    tradeRecord({ positionId: POSITION_SECRET - 1, volume: 2, openPrice: 20 }),
    tradeRecord({
      positionId: POSITION_SECRET - 2,
      recordType: 1,
      tradeType: 1,
      side: 1,
      volume: 3,
      openPrice: 20,
    }),
  ];
  const nearMissTrades = [
    tradeRecord(),
    tradeRecord({ positionId: POSITION_SECRET - 1, volume: 2, openPrice: 20 }),
    tradeRecord({
      positionId: POSITION_SECRET - 2,
      recordType: 1,
      tradeType: 0,
      side: 0,
      volume: 2,
      openPrice: 10,
    }),
  ];
  const cases = [
    { name: "missing stockLock", balance: { stockLock: undefined } },
    { name: "negative stockLock", balance: { stockLock: -1 } },
    { name: "non-finite stockLock", balance: { stockLock: Number.POSITIVE_INFINITY } },
    { name: "missing cashStockValue", balance: { cashStockValue: undefined } },
    { name: "negative cashStockValue", balance: { cashStockValue: -1 } },
    { name: "non-finite cashStockValue", balance: { cashStockValue: Number.NaN } },
    {
      name: "positive lock with only a pending SELL",
      trades: sellOnlyTrades,
      balance: { stockLock: 20, cashStockValue: 955 },
    },
    {
      name: "positive lock with a near-miss pending lifecycle tuple",
      trades: nearMissTrades,
      balance: { stockLock: 20, cashStockValue: 955 },
    },
  ];

  for (const testCase of cases) {
    const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
      trades: testCase.trades,
      balanceFrame: balanceFrame(ACCOUNT_SECRET, ENDPOINT_SECRET, testCase.balance),
    }));
    assert.equal(result.ok, true, testCase.name);
    assert.equal(result.payload.cashValue, null, testCase.name);
    assert.deepEqual(result.payload.warnings, [
      "XTB nevrátilo jednoznačnou hodnotu volných prostředků; web klubu ji dopočítá z celkové hodnoty a pozic.",
    ], testCase.name);
  }
});

test("omits locked cash when the total-equity identity does not corroborate it", () => {
  const trades = [
    tradeRecord(),
    tradeRecord({ positionId: POSITION_SECRET - 1, volume: 2, openPrice: 20 }),
    tradeRecord({
      positionId: POSITION_SECRET - 2,
      recordType: 1,
      tradeType: 1,
      side: 0,
      volume: 2,
      openPrice: 10,
    }),
  ];
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    trades,
    balanceFrame: balanceFrame(ACCOUNT_SECRET, ENDPOINT_SECRET, {
      balance: 5,
      equity: 5,
      freeMargin: 5,
      stockFreeMargin: 5,
      stockLock: 20,
      cashStockValue: 74,
      totalEquity: 100,
    }),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.payload.cashValue, null);
  assert.equal(result.payload.warnings.length, 1);
});

test("omits ambiguous cash with the exact Czech warning", () => {
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    balanceFrame: balanceFrame(ACCOUNT_SECRET, ENDPOINT_SECRET, { equity: 26 }),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.payload.cashValue, null);
  assert.deepEqual(result.payload.warnings, [
    "XTB nevrátilo jednoznačnou hodnotu volných prostředků; web klubu ji dopočítá z celkové hodnoty a pozic.",
  ]);
});

test("rejects mixed-account trades and balance records", () => {
  const tradeMismatch = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    trades: [tradeRecord({ account: "other-account", login: "other-account" })],
    profits: [{ idPosition: POSITION_SECRET }],
  }));
  const balanceMismatch = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    balanceFrame: balanceFrame("other-account", ENDPOINT_SECRET),
  }));

  assert.equal(tradeMismatch.ok, false);
  assert.match(tradeMismatch.error, /účtu/i);
  assert.equal(balanceMismatch.ok, false);
  assert.match(balanceMismatch.error, /účtu/i);
});

test("rejects an account currency outside the live-calibrated XTB set", () => {
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    accountFrame: accountFrame(ACCOUNT_SECRET, ENDPOINT_SECRET, "ZZZ"),
  }));

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "account");
});

test("rejects missing catalog quotes, invalid numbers, and unknown venues", () => {
  const missingQuote = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    catalogFrame: catalogFrame([{ quoteId: QUOTE_SECRET + 9, name: "OTHER.US" }]),
  }));
  const invalidVolume = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    trades: [tradeRecord({ volume: 0 })],
    profits: [{ idPosition: POSITION_SECRET }],
  }));
  const invalidPrice = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    trades: [tradeRecord({ openPrice: -1 })],
    profits: [{ idPosition: POSITION_SECRET }],
  }));
  const unknownVenue = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    catalogFrame: catalogFrame([{ quoteId: QUOTE_SECRET, name: "ACME.XX" }]),
    trades: [tradeRecord({ symbol: "ACME.XX" })],
    profits: [{ idPosition: POSITION_SECRET }],
  }));

  assert.equal(missingQuote.ok, false);
  assert.equal(invalidVolume.ok, false);
  assert.equal(invalidPrice.ok, false);
  assert.equal(unknownVenue.ok, false);
  assert.match(unknownVenue.error, /burzy/i);
});

test("reports the XTB symbol when its quote is missing from the catalog", () => {
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    catalogFrame: catalogFrame([{ quoteId: QUOTE_SECRET + 9, name: "OTHER.US" }]),
  }));

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "instrument");
  assert.match(result.error, /XTB-INSTRUMENT-CATALOG-MISSING/);
  assert.match(result.error, /instrument „ACME\.US“/);
});

test("reports both XTB symbols when a position disagrees with its catalog quote", () => {
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    catalogFrame: catalogFrame([{ quoteId: QUOTE_SECRET, name: "OTHER.US" }]),
  }));

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "instrument");
  assert.match(result.error, /XTB-INSTRUMENT-CATALOG-MISMATCH/);
  assert.match(result.error, /symbol pozice „ACME\.US“/);
  assert.match(result.error, /katalogu XTB „OTHER\.US“/);
});

test("reports a safely printable invalid XTB symbol", () => {
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    catalogFrame: catalogFrame([{ quoteId: QUOTE_SECRET, name: "ODD/US\nCONTROL" }]),
    trades: [tradeRecord({ symbol: "ODD/US\nCONTROL" })],
    profits: [{ idPosition: POSITION_SECRET }],
  }));

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "instrument");
  assert.match(result.error, /XTB-INSTRUMENT-INVALID-SYMBOL/);
  assert.match(result.error, /neplatný symbol „ODD\/US CONTROL“/);
  assert.doesNotMatch(result.error.split("Diagnostika:")[1], /[\r\n]/);
});

test("reports the exact unsupported XTB venue", () => {
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    catalogFrame: catalogFrame([{ quoteId: QUOTE_SECRET, name: "ACME.XX" }]),
    trades: [tradeRecord({ symbol: "ACME.XX" })],
    profits: [{ idPosition: POSITION_SECRET }],
  }));

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "instrument");
  assert.match(result.error, /XTB-INSTRUMENT-UNKNOWN-VENUE/);
  assert.match(result.error, /instrument „ACME\.XX“/);
  assert.match(result.error, /burzu „\.XX“/);
});

test("rejects a suffixless symbol without a calibrated XTB venue", () => {
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    catalogFrame: catalogFrame([{ quoteId: QUOTE_SECRET, name: "ACME" }]),
    trades: [tradeRecord({ symbol: "ACME" })],
    profits: [{ idPosition: POSITION_SECRET }],
  }));

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "instrument");
  assert.match(result.error, /XTB-INSTRUMENT-MISSING-VENUE/);
  assert.match(result.error, /instrument „ACME“/);
});

test("maps calibrated XTB venues without using account currency", () => {
  assert.deepEqual(stream.toYahooTicker("ACME.US"), {
    ticker: "ACME",
    currency: "USD",
    knownVenue: true,
  });
  assert.deepEqual(stream.toYahooTicker("ACME.DE"), {
    ticker: "ACME.DE",
    currency: "EUR",
    knownVenue: true,
  });
  assert.deepEqual(stream.toYahooTicker("0700.HK"), {
    ticker: "700.HK",
    currency: "HKD",
    knownVenue: true,
  });
  assert.deepEqual(stream.toYahooTicker("ASML.NL"), {
    ticker: "ASML.AS",
    currency: "EUR",
    knownVenue: true,
  });
  assert.deepEqual(stream.toYahooTicker("CS.FR"), {
    ticker: "CS.PA",
    currency: "EUR",
    knownVenue: true,
  });
});

test("enriches only the exact calibrated XTB London instrument with native currency", () => {
  assert.deepEqual(stream.toYahooTicker("ISLN.UK"), {
    ticker: "ISLN.UK",
    currency: "USD",
    knownVenue: true,
    requiresTickerOverride: true,
  });
  assert.deepEqual(stream.toYahooTicker("UNKNOWN.UK"), {
    ticker: "UNKNOWN.UK",
    currency: null,
    knownVenue: false,
  });
});

test("passes the exact XTB London instrument to strict shared ticker normalization", () => {
  const result = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    accountFrame: accountFrame(ACCOUNT_SECRET, ENDPOINT_SECRET, "EUR"),
    catalogFrame: catalogFrame([{
      quoteId: QUOTE_SECRET,
      name: "ISLN.UK",
      displayName: "Physical Silver",
    }]),
    trades: [tradeRecord({ symbol: "ISLN.UK", volume: 2, openPrice: 35 })],
    profits: [{ idPosition: POSITION_SECRET, accountId: 111 }],
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.payload.positions, [{
    ticker: "ISLN.UK",
    shares: 2,
    avgCost: 35,
    currency: "USD",
    note: "ISLN.UK (Physical Silver)",
    requiresTickerOverride: true,
  }]);
});

test("rejects incomplete, empty, and missing-total snapshots", () => {
  const incompleteReducer = stream.createStreamReducer();
  incompleteReducer.inspectTransport("incoming", accountFrame());
  const incomplete = stream.buildPayloadFromStreamSnapshot(incompleteReducer.snapshot());
  const empty = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({ trades: [], profits: [] }));
  const missingTotal = stream.buildPayloadFromStreamSnapshot(coherentSnapshot({
    balanceFrame: balanceFrame(ACCOUNT_SECRET, ENDPOINT_SECRET, { totalEquity: Number.NaN }),
  }));

  assert.equal(incomplete.errorCode, "incomplete");
  assert.equal(empty.ok, false);
  assert.equal(missingTotal.ok, false);
  assert.match(missingTotal.error, /hodnotu/i);
});

function feedCoherentStream(reducer) {
  reducer.inspectTransport("incoming", accountFrame());
  reducer.inspectTransport("incoming", catalogFrame());
  reducer.inspectTransport("incoming", tradeFrame());
  reducer.inspectTransport("incoming", profitFrame());
  reducer.inspectTransport("incoming", balanceFrame());
}

test("observes a page-created Worker without changing its constructor or messages", () => {
  let createdWorkerCount = 0;
  let createdWebSocketCount = 0;
  const consoleWrites = [];
  const domWrites = [];

  class FakeWorker {
    constructor(...args) {
      createdWorkerCount += 1;
      this.constructorArgs = args;
      this.listeners = new Map();
      this.sent = [];
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    postMessage(data, transfer) {
      this.sent.push([data, transfer]);
      return "native-result";
    }

    emitMessage(data) {
      for (const listener of this.listeners.get("message") || []) listener({ data });
    }
  }

  class FakeWebSocket {
    constructor() { createdWebSocketCount += 1; }
  }

  const root = {
    Worker: FakeWorker,
    WebSocket: FakeWebSocket,
    console: { log(value) { consoleWrites.push(value); }, info(value) { consoleWrites.push(value); } },
    document: { append(value) { domWrites.push(value); } },
  };
  const reducer = stream.createStreamReducer();
  assert.equal(stream.installWorkerObserver(root, reducer), true);

  const originalConstructorArgs = ["worker-secret.js", { name: "socket-worker" }];
  const worker = new root.Worker(...originalConstructorArgs);
  const outgoing = { command: "page-owned-command" };
  const transfer = [{ transferable: true }];
  assert.deepEqual(worker.constructorArgs, originalConstructorArgs);
  assert.equal(worker.postMessage(outgoing, transfer), "native-result");
  assert.deepEqual(worker.sent, [[outgoing, transfer]]);

  for (const frame of [accountFrame(), catalogFrame(), tradeFrame(), profitFrame(), balanceFrame()]) {
    worker.emitMessage({ segment: "socket", result: [{ 7: frame }] });
  }
  assert.equal(reducer.snapshot().completed.balance, true);
  assert.equal(createdWorkerCount, 1);
  assert.equal(createdWebSocketCount, 0);
  assert.deepEqual(consoleWrites, []);
  assert.deepEqual(domWrites, []);
});

test("returns a ready public result and strips internal error codes", async () => {
  const reducer = stream.createStreamReducer();
  feedCoherentStream(reducer);

  const result = await stream.waitForReadyResult(reducer, globalThis, 10);
  assert.equal(result.ok, true);
  assert.equal(result.payload.positions.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "errorCode"), false);
});

test("times out an incomplete stream with a public Czech calibration error", async () => {
  const reducer = stream.createStreamReducer();
  const result = await stream.waitForReadyResult(reducer, globalThis, 5);

  assert.equal(result.ok, false);
  assert.equal(result.needsCalibration, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "errorCode"), false);
  assert.match(result.error, /úplný stav/i);
});

test("invalidates a pending request when the account generation changes", async () => {
  const reducer = stream.createStreamReducer();
  reducer.inspectTransport("incoming", accountFrame());
  const pending = stream.waitForReadyResult(reducer, globalThis, 100);
  reducer.resetAccountState();
  const result = await pending;

  assert.equal(result.ok, false);
  assert.match(result.error, /účtu/i);
});

function bridgeRoot() {
  const listeners = new Map();
  return {
    Worker: class FakeWorker {
      addEventListener() {}
    },
    location: { origin: "https://xstation5.xtb.com" },
    posted: [],
    addEventListener(type, listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    postMessage(message, targetOrigin) {
      this.posted.push({ message, targetOrigin });
    },
    emitMessage(event) {
      for (const listener of listeners.get("message") || []) listener(event);
    },
    setTimeout,
    clearTimeout,
    Date,
  };
}

test("MAIN bridge ignores spoofed requests and answers one valid same-window request", async () => {
  const root = bridgeRoot();
  const reducer = stream.createStreamReducer();
  feedCoherentStream(reducer);
  assert.equal(stream.installMainWorld(root, { reducer, timeoutMs: 20 }), true);

  const request = {
    channel: "ik-xtb-stream-bridge",
    type: "request",
    requestId: "request-public",
    nonce: "nonce-public",
  };
  root.emitMessage({ source: {}, origin: root.location.origin, data: request });
  root.emitMessage({ source: root, origin: "https://evil.example", data: request });
  root.emitMessage({ source: root, origin: root.location.origin, data: { ...request, channel: "wrong" } });
  root.emitMessage({ source: root, origin: root.location.origin, data: { ...request, nonce: 123 } });
  assert.equal(root.posted.length, 0);

  root.emitMessage({ source: root, origin: root.location.origin, data: request });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(root.posted.length, 1);
  assert.equal(root.posted[0].targetOrigin, root.location.origin);
  assert.equal(root.posted[0].message.requestId, request.requestId);
  assert.equal(root.posted[0].message.nonce, request.nonce);
  assert.equal(root.posted[0].message.result.ok, true);
  const serialized = JSON.stringify(root.posted[0]);
  assert.doesNotMatch(serialized, new RegExp(ACCOUNT_SECRET));
  assert.doesNotMatch(serialized, new RegExp(ENDPOINT_SECRET));
  assert.doesNotMatch(serialized, new RegExp(String(POSITION_SECRET)));
});

module.exports = {
  ACCOUNT_SECRET,
  ENDPOINT_SECRET,
  POSITION_SECRET,
  QUOTE_SECRET,
  accountFrame,
  balanceFrame,
  balanceRecord,
  catalogFrame,
  element,
  profitFrame,
  responseFrame,
  tradeFrame,
  tradeRecord,
};
