// XTB XStation 5 — passive MAIN-world Worker-stream import.
//
// STREAM-ONLY, calibrated live (2026-08): XStation creates a dedicated Worker
// that owns its existing WebSocket connection and emits account, instrument,
// position, profit, and balance records. This file must run at document_start
// in Chrome's MAIN world so it can observe page-created Workers from the same
// JavaScript world. It transparently wraps the Worker constructor and listens
// only to messages produced by Workers that XStation itself creates.
//
// The paired xtb.js must remain a separate ISOLATED-world content script. That
// file registers XTB through the extension's shared IK helper and requests one
// normalized result through a nonce-bound, same-window bridge. One file cannot
// perform both roles because page-owned Worker objects and the isolated IK
// registration live in different Chrome execution worlds.
//
// This adapter never creates a Worker, WebSocket, HTTP request, subscription,
// or XTB command; never switches or enumerates accounts; and never uses DOM,
// logo, tooltip, or page-text fallbacks. Raw protocol state and account-bound
// identifiers stay in memory. Only whitelisted fields needed to prove one
// coherent active-account snapshot are reduced, and only the final normalized
// Investicni klub result crosses the bridge. Nothing is logged or persisted.
"use strict";

var IKXtbStreamMain = (() => {
  const FAMILIES = Object.freeze([
    "getAccountData",
    "getAllSymbolsLight",
    "getAndSubscribeTradeRecord",
    "getAndSubscribeTradeProfit",
    "getAndSubscribeTotalBalance",
  ]);
  const MAX_ENVELOPE_DEPTH = 6;
  const MAX_ENVELOPE_NODES = 128;
  const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]*(?:\.[A-Z]{1,3})?$/;
  const ACCOUNT_CURRENCIES = Object.freeze(["CZK", "EUR", "USD"]);
  const CASH_WARNING = "XTB nevrátilo jednoznačnou hodnotu volných prostředků; web klubu ji dopočítá z celkové hodnoty a pozic.";
  const BRIDGE_CHANNEL = "ik-xtb-stream-bridge";
  const MAIN_READY_TIMEOUT_MS = 6000;
  const INSTALL_MARKER = "__ikXtbStreamMainInstalled";
  const ERRORS = Object.freeze({
    incomplete: "XTB ještě neposkytlo úplný stav právě vybraného účtu. Obnov stránku (F5), počkej na načtení XStation a zkus import znovu.",
    account: "Data XTB nepatří jednoznačně právě vybranému účtu. Obnov stránku (F5) a zkus import znovu.",
    positions: "XTB neposkytlo bezpečně ověřitelnou množinu otevřených pozic. Obnov stránku (F5) a zkus import znovu.",
    instrument: "XTB vrátilo instrument v neznámém formátu nebo z neznámé burzy. Import jsem pro jistotu nezapsal; nahlas prosím tento případ k doplnění.",
    summary: "XTB neposkytlo bezpečně ověřitelnou celkovou hodnotu účtu. Obnov stránku (F5) a zkus import znovu.",
  });
  const VENUES = Object.freeze({
    ".DE": ["EUR", ".DE"], ".F": ["EUR", ".F"], ".SG": ["EUR", ".SG"],
    ".MU": ["EUR", ".MU"], ".BE": ["EUR", ".BE"], ".PA": ["EUR", ".PA"],
    ".FR": ["EUR", ".PA"], ".AS": ["EUR", ".AS"], ".NL": ["EUR", ".AS"],
    ".NV": ["EUR", ".AS"], ".BR": ["EUR", ".BR"],
    ".MI": ["EUR", ".MI"], ".MC": ["EUR", ".MC"], ".LS": ["EUR", ".LS"],
    ".VI": ["EUR", ".VI"], ".IR": ["EUR", ".IR"], ".HE": ["EUR", ".HE"],
    ".SW": ["CHF", ".SW"], ".HK": ["HKD", ".HK"], ".T": ["JPY", ".T"],
    ".AX": ["AUD", ".AX"], ".TO": ["CAD", ".TO"], ".V": ["CAD", ".V"],
    ".ST": ["SEK", ".ST"], ".CO": ["DKK", ".CO"], ".OL": ["NOK", ".OL"],
    ".SI": ["SGD", ".SI"], ".TA": ["ILS", ".TA"], ".MX": ["MXN", ".MX"],
    ".SA": ["BRL", ".SA"], ".WA": ["PLN", ".WA"],
  });

  function opaqueToken(value) {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const token = String(value);
    return token ? token : null;
  }

  function requestFamily(reqId) {
    const base = String(reqId || "").split("_", 1)[0];
    if (base === "settingsGetAccountData") return "getAccountData";
    return FAMILIES.includes(base) ? base : null;
  }

  function collectNamedObjects(root, propertyName) {
    const found = [];
    const visited = new Set();
    const visit = (node) => {
      if (!node || typeof node !== "object" || visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      const candidate = node[propertyName];
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) found.push(candidate);
      for (const value of Object.values(node)) visit(value);
    };
    visit(root);
    return found;
  }

  function collectElementRecords(root, propertyName) {
    const found = [];
    const visited = new Set();
    const visit = (node) => {
      if (!node || typeof node !== "object" || visited.has(node)) return;
      visited.add(node);
      if (Array.isArray(node)) {
        for (const item of node) visit(item);
        return;
      }
      const record = node?.value?.[propertyName];
      if (record && typeof record === "object" && !Array.isArray(record)) {
        found.push({
          elementState: Number.isFinite(node.state) ? node.state : null,
          record,
        });
      }
      for (const value of Object.values(node)) visit(value);
    };
    visit(root);
    return found;
  }

  function walkTransport(data, visitor) {
    const visited = new Set();
    let visitedNodes = 0;
    const visit = (node, depth) => {
      if (depth > MAX_ENVELOPE_DEPTH || visitedNodes >= MAX_ENVELOPE_NODES) return;
      visitedNodes += 1;
      if (typeof node === "string") {
        try {
          visit(JSON.parse(node), depth + 1);
        } catch {
          // Worker envelopes can contain unrelated text fields.
        }
        return;
      }
      if (!node || typeof node !== "object" || visited.has(node)) return;
      visited.add(node);
      if (requestFamily(node.reqId)) visitor(node);
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
      } else {
        for (const value of Object.values(node)) visit(value, depth + 1);
      }
    };
    visit(data, 0);
  }

  function freshState(generation, existingCatalog = new Map()) {
    return {
      generation,
      account: null,
      catalogByQuoteId: new Map(existingCatalog),
      tradeEntries: [],
      profits: [],
      balance: null,
      accountScopedGenerations: {
        trades: null,
        profits: null,
        balance: null,
      },
      completed: {
        account: false,
        catalog: existingCatalog.size > 0,
        trades: false,
        profits: false,
        balance: false,
      },
    };
  }

  function accountKey(account) {
    return account?.accountNo && account?.endpointID
      ? `${account.accountNo}\u0000${account.endpointID}`
      : null;
  }

  function copyAccount(record) {
    return {
      accountNo: opaqueToken(record?.accountID?.wtaccountid?.accountNo),
      endpointID: opaqueToken(record?.accountID?.wtaccountid?.endpointID),
      currency: typeof record?.currency === "string" ? record.currency : null,
    };
  }

  function copyCatalogRecord(record) {
    return {
      quoteId: opaqueToken(record?.quoteId),
      name: typeof record?.name === "string" ? record.name : null,
      displayName: typeof record?.displayName === "string" ? record.displayName : null,
    };
  }

  function copyTradeEntry(entry) {
    const record = entry?.record || {};
    return {
      elementState: entry?.elementState ?? null,
      record: {
        account: opaqueToken(record.account),
        login: opaqueToken(record.login),
        symbol: typeof record.symbol === "string" ? record.symbol : null,
        idQuote: opaqueToken(record.idQuote),
        recordType: Number.isFinite(record.recordType) ? record.recordType : null,
        tradeType: Number.isFinite(record.tradeType) ? record.tradeType : null,
        side: Number.isFinite(record.side) ? record.side : null,
        volume: Number.isFinite(record.volume) ? record.volume : null,
        openPrice: Number.isFinite(record.openPrice) ? record.openPrice : null,
        positionId: opaqueToken(record.positionId),
      },
    };
  }

  function copyProfit(record) {
    return { idPosition: opaqueToken(record?.idPosition) };
  }

  function copyBalance(record) {
    return {
      aid: {
        accountNo: opaqueToken(record?.aid?.accountNo),
        endpointID: opaqueToken(record?.aid?.endpointID),
      },
      balance: Number.isFinite(record?.balance) ? record.balance : null,
      equity: Number.isFinite(record?.equity) ? record.equity : null,
      freeMargin: Number.isFinite(record?.freeMargin) ? record.freeMargin : null,
      stockFreeMargin: Number.isFinite(record?.stockFreeMargin) ? record.stockFreeMargin : null,
      stockLock: Number.isFinite(record?.stockLock) ? record.stockLock : null,
      cashStockValue: Number.isFinite(record?.cashStockValue) ? record.cashStockValue : null,
      totalEquity: Number.isFinite(record?.totalEquity) ? record.totalEquity : null,
    };
  }

  function reduceKnownMessage(state, message) {
    if (!message || typeof message !== "object" || message.completed !== true) return state;
    const family = requestFamily(message.reqId);
    if (!family) return state;

    if (family === "getAccountData") {
      const records = collectNamedObjects(message, "xmt4account");
      if (records.length === 0) return state;
      const nextAccount = records.length === 1 ? copyAccount(records[0]) : null;
      const previousKey = accountKey(state.account);
      const nextKey = accountKey(nextAccount);
      if (!nextKey) return freshState(state.generation + 1, state.catalogByQuoteId);
      const previousCurrency = typeof state.account?.currency === "string"
        ? state.account.currency.trim().toUpperCase() : null;
      const nextCurrency = typeof nextAccount?.currency === "string"
        ? nextAccount.currency.trim().toUpperCase() : null;
      if (previousKey && nextKey
        && (previousKey !== nextKey || previousCurrency !== nextCurrency)) {
        state = freshState(state.generation + 1, state.catalogByQuoteId);
      }
      state.account = nextAccount;
      state.completed.account = true;
      return state;
    }

    if (family === "getAllSymbolsLight") {
      const records = collectNamedObjects(message, "xcfdsymbol");
      if (records.length === 0) return state;
      const catalog = new Map();
      for (const record of records) {
        const copied = copyCatalogRecord(record);
        if (copied.quoteId) {
          const matches = catalog.get(copied.quoteId) || [];
          matches.push(copied);
          catalog.set(copied.quoteId, matches);
        }
      }
      state.catalogByQuoteId = catalog;
      state.completed.catalog = true;
      return state;
    }

    if (!state.completed.account || !accountKey(state.account)) return state;

    if (family === "getAndSubscribeTradeRecord") {
      state.tradeEntries = collectElementRecords(message, "xcfdtrade").map(copyTradeEntry);
      state.accountScopedGenerations.trades = state.generation;
      state.completed.trades = true;
      return state;
    }

    if (family === "getAndSubscribeTradeProfit") {
      state.profits = collectNamedObjects(message, "xtradeprofit").map(copyProfit);
      state.accountScopedGenerations.profits = state.generation;
      state.completed.profits = true;
      return state;
    }

    if (family === "getAndSubscribeTotalBalance") {
      const records = collectNamedObjects(message, "xtotalbalance");
      if (records.length === 0) return state;
      state.balance = records.length === 1 ? copyBalance(records[0]) : null;
      state.accountScopedGenerations.balance = state.generation;
      state.completed.balance = true;
    }
    return state;
  }

  function copySnapshot(state) {
    return {
      generation: state.generation,
      account: state.account ? { ...state.account } : null,
      catalogByQuoteId: new Map([...state.catalogByQuoteId]
        .map(([key, values]) => [key, values.map((value) => ({ ...value }))])),
      tradeEntries: state.tradeEntries.map((entry) => ({
        elementState: entry.elementState,
        record: { ...entry.record },
      })),
      profits: state.profits.map((profit) => ({ ...profit })),
      balance: state.balance ? { ...state.balance, aid: { ...state.balance.aid } } : null,
      accountScopedGenerations: { ...state.accountScopedGenerations },
      completed: { ...state.completed },
    };
  }

  function createStreamReducer() {
    let state = freshState(0);
    return {
      inspectTransport(direction, data) {
        if (direction !== "incoming") return;
        walkTransport(data, (message) => {
          state = reduceKnownMessage(state, message);
        });
      },
      snapshot() {
        return copySnapshot(state);
      },
      resetAccountState() {
        state = freshState(state.generation + 1, state.catalogByQuoteId);
      },
    };
  }

  function calibrationError(errorCode) {
    return {
      ok: false,
      needsCalibration: true,
      errorCode,
      error: ERRORS[errorCode] || ERRORS.incomplete,
    };
  }

  function isEligiblePositionRecord(entry) {
    const trade = entry?.record;
    return entry?.elementState === 1
      && trade?.recordType === 0
      && trade?.tradeType === 0
      && trade?.side === 0;
  }

  function closeEnough(left, right) {
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    return Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-12);
  }

  function isPendingOrderRecord(entry) {
    const trade = entry?.record;
    return entry?.elementState === 1
      && trade?.recordType === 1
      && trade?.tradeType === 1;
  }

  function cashConsensus(balance, tradeEntries = []) {
    const values = [balance?.balance, balance?.equity, balance?.freeMargin, balance?.stockFreeMargin];
    if (!values.every(Number.isFinite) || !values.every((value) => closeEnough(value, values[0]))) {
      return { cashValue: null, warning: CASH_WARNING };
    }

    const pendingBuys = tradeEntries.filter((entry) => (
      isPendingOrderRecord(entry) && entry?.record?.side === 0
    ));

    const stockLock = balance?.stockLock;
    const cashStockValue = balance?.cashStockValue;
    const totalEquity = balance?.totalEquity;
    if (!Number.isFinite(stockLock) || stockLock < 0
      || !Number.isFinite(cashStockValue) || cashStockValue < 0
      || !Number.isFinite(totalEquity)
      || (stockLock > 0 && pendingBuys.length === 0)) {
      return { cashValue: null, warning: CASH_WARNING };
    }

    const cashValue = balance.freeMargin + stockLock;
    if (!closeEnough(cashStockValue + cashValue, totalEquity)) {
      return { cashValue: null, warning: CASH_WARNING };
    }
    return { cashValue, warning: null };
  }

  function toYahooTicker(rawSymbol) {
    const source = String(rawSymbol || "").trim().toUpperCase().replace(/^\$/, "");
    if (!SYMBOL_RE.test(source)) return { ticker: null, currency: null, knownVenue: false };
    const dot = source.lastIndexOf(".");
    if (dot < 0) return { ticker: source, currency: null, knownVenue: false };
    const suffix = source.slice(dot);
    const stem = source.slice(0, dot);
    if (suffix === ".US") return { ticker: stem, currency: "USD", knownVenue: true };
    const venue = VENUES[suffix];
    if (!venue) return { ticker: source, currency: null, knownVenue: false };
    const [currency, yahooSuffix] = venue;
    const yahooStem = yahooSuffix === ".HK" ? stem.replace(/^0+/, "") : stem;
    return { ticker: `${yahooStem}${yahooSuffix}`, currency, knownVenue: true };
  }

  function sameOpaqueSet(left, right) {
    return left.size > 0 && left.size === right.size
      && [...left].every((value) => right.has(value));
  }

  function buildPayloadFromStreamSnapshot(snapshot, now = new Date().toISOString()) {
    const completed = snapshot?.completed;
    if (!completed || !completed.account || !completed.catalog || !completed.trades
      || !completed.profits || !completed.balance) return calibrationError("incomplete");
    const generations = snapshot?.accountScopedGenerations;
    if (!generations || generations.trades !== snapshot.generation
      || generations.profits !== snapshot.generation
      || generations.balance !== snapshot.generation) return calibrationError("incomplete");

    const account = snapshot?.account;
    const activeKey = accountKey(account);
    const currency = typeof account?.currency === "string" ? account.currency.trim().toUpperCase() : "";
    if (!activeKey || !ACCOUNT_CURRENCIES.includes(currency)) return calibrationError("account");

    const balance = snapshot?.balance;
    if (!balance || opaqueToken(balance?.aid?.accountNo) !== account.accountNo
      || opaqueToken(balance?.aid?.endpointID) !== account.endpointID) {
      return calibrationError("account");
    }

    const totalValue = balance.totalEquity;
    if (!Number.isFinite(totalValue) || totalValue < 0) return calibrationError("summary");

    const tradeEntries = Array.isArray(snapshot?.tradeEntries) ? snapshot.tradeEntries : [];
    for (const entry of tradeEntries) {
      const identifiers = [entry?.record?.account, entry?.record?.login].filter(Boolean);
      if (!identifiers.length || identifiers.some((identifier) => identifier !== account.accountNo)) {
        return calibrationError("account");
      }
    }

    const eligible = tradeEntries.filter(isEligiblePositionRecord);
    const profits = Array.isArray(snapshot?.profits) ? snapshot.profits : [];
    const eligibleIds = eligible.map((entry) => opaqueToken(entry?.record?.positionId));
    const profitIds = profits.map((profit) => opaqueToken(profit?.idPosition));
    if (!eligible.length || eligibleIds.some((value) => !value) || profitIds.some((value) => !value)) {
      return calibrationError("positions");
    }
    const eligibleIdSet = new Set(eligibleIds);
    const profitIdSet = new Set(profitIds);
    if (eligibleIdSet.size !== eligible.length || profitIdSet.size !== profits.length
      || !sameOpaqueSet(eligibleIdSet, profitIdSet)) return calibrationError("positions");

    const catalog = snapshot?.catalogByQuoteId instanceof Map ? snapshot.catalogByQuoteId : new Map();
    const groups = new Map();
    for (const entry of eligible) {
      const trade = entry.record;
      const tradeSymbol = typeof trade.symbol === "string" ? trade.symbol.trim().toUpperCase() : "";
      const catalogRecords = catalog.get(opaqueToken(trade.idQuote));
      const catalogRecord = Array.isArray(catalogRecords)
        ? catalogRecords.find((record) => (
          typeof record?.name === "string" && record.name.trim().toUpperCase() === tradeSymbol
        ))
        : null;
      const symbol = typeof catalogRecord?.name === "string" ? catalogRecord.name.trim().toUpperCase() : "";
      if (!symbol || tradeSymbol !== symbol) return calibrationError("instrument");
      if (!Number.isFinite(trade.volume) || trade.volume <= 0
        || !Number.isFinite(trade.openPrice) || trade.openPrice < 0) {
        return calibrationError("positions");
      }
      const mapped = toYahooTicker(symbol);
      if (!mapped.knownVenue || !mapped.ticker || !mapped.currency) return calibrationError("instrument");
      let group = groups.get(symbol);
      if (!group) {
        const displayName = typeof catalogRecord.displayName === "string"
          ? catalogRecord.displayName.trim()
          : "";
        group = {
          mapped,
          shares: 0,
          weightedCost: 0,
          note: displayName ? `${symbol} (${displayName})` : symbol,
        };
        groups.set(symbol, group);
      }
      group.shares += trade.volume;
      group.weightedCost += trade.volume * trade.openPrice;
    }

    const positions = [...groups.values()].map((group) => ({
      ticker: group.mapped.ticker,
      shares: group.shares,
      avgCost: group.weightedCost / group.shares,
      currency: group.mapped.currency,
      note: group.note,
    })).sort((left, right) => left.ticker.localeCompare(right.ticker));
    if (!positions.length || positions.some((position) => !Number.isFinite(position.avgCost))) {
      return calibrationError("positions");
    }

    const cash = cashConsensus(balance, tradeEntries);
    return {
      ok: true,
      payload: {
        broker: "xtb",
        brokerLabel: "XTB",
        totalValue,
        cashValue: cash.cashValue,
        currency,
        positions,
        warnings: cash.warning ? [cash.warning] : [],
        scrapedAt: now,
      },
    };
  }

  function publicResult(result) {
    if (result?.ok === true && result.payload && typeof result.payload === "object") {
      return { ok: true, payload: result.payload };
    }
    return {
      ok: false,
      needsCalibration: true,
      error: typeof result?.error === "string" ? result.error : ERRORS.incomplete,
    };
  }

  function rootNow(root) {
    return typeof root?.Date?.now === "function" ? root.Date.now() : Date.now();
  }

  function waitForReadyResult(reducer, root, timeoutMs = MAIN_READY_TIMEOUT_MS) {
    const expectedGeneration = reducer.snapshot().generation;
    const startedAt = rootNow(root);
    return new Promise((resolve) => {
      const probe = () => {
        const snapshot = reducer.snapshot();
        if (snapshot.generation !== expectedGeneration) {
          resolve(publicResult(calibrationError("account")));
          return;
        }
        const result = buildPayloadFromStreamSnapshot(snapshot);
        if (result.ok || result.errorCode !== "incomplete") {
          resolve(publicResult(result));
          return;
        }
        const elapsed = rootNow(root) - startedAt;
        if (elapsed >= timeoutMs) {
          resolve(publicResult(calibrationError("incomplete")));
          return;
        }
        const delay = Math.min(50, Math.max(0, timeoutMs - elapsed));
        Reflect.apply(root.setTimeout, root, [probe, delay]);
      };
      probe();
    });
  }

  function installWorkerObserver(root, reducer) {
    const NativeWorker = root?.Worker;
    if (typeof NativeWorker !== "function" || !reducer) return false;
    let WrappedWorker;
    WrappedWorker = new Proxy(NativeWorker, {
      construct(Target, args, newTarget) {
        const effectiveNewTarget = newTarget === WrappedWorker ? Target : newTarget;
        const worker = Reflect.construct(Target, args, effectiveNewTarget);
        worker.addEventListener("message", (event) => {
          reducer.inspectTransport("incoming", event.data);
        });
        return worker;
      },
    });
    root.Worker = WrappedWorker;
    return true;
  }

  function installMainWorld(root, options = {}) {
    if (!root || root[INSTALL_MARKER]) return false;
    const reducer = options.reducer || createStreamReducer();
    if (!installWorkerObserver(root, reducer)) return false;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : MAIN_READY_TIMEOUT_MS;
    const handledRequests = new Set();
    root.addEventListener("message", async (event) => {
      if (event.source !== root || event.origin !== root.location?.origin) return;
      const message = event.data;
      if (message?.channel !== BRIDGE_CHANNEL || message.type !== "request"
        || typeof message.requestId !== "string" || !message.requestId
        || typeof message.nonce !== "string" || !message.nonce) return;
      const requestKey = `${message.requestId}\u0000${message.nonce}`;
      if (handledRequests.has(requestKey)) return;
      handledRequests.add(requestKey);
      const result = await waitForReadyResult(reducer, root, timeoutMs);
      root.postMessage({
        channel: BRIDGE_CHANNEL,
        type: "response",
        requestId: message.requestId,
        nonce: message.nonce,
        result,
      }, root.location.origin);
    });
    root[INSTALL_MARKER] = true;
    return true;
  }

  return {
    BRIDGE_CHANNEL,
    ERRORS,
    buildPayloadFromStreamSnapshot,
    cashConsensus,
    collectElementRecords,
    collectNamedObjects,
    createStreamReducer,
    installMainWorld,
    installWorkerObserver,
    isEligiblePositionRecord,
    requestFamily,
    toYahooTicker,
    waitForReadyResult,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = IKXtbStreamMain;
} else {
  IKXtbStreamMain.installMainWorld(globalThis);
}
