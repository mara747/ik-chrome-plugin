// Trading 212 Invest (app.trading212.com) — the member's live Invest account.
//
// API-ONLY, calibrated live (2026-08): the SPA uses the authenticated page
// session for account, portfolio, and instrument requests:
//   GET  /rest/v1/accounts
//   POST /rest/v1/equity/multi-accounts/summary?targetCurrency=<account ccy>
//   POST /instrumentarium/v2/instruments/find
//   GET  /instrumentarium/v2/instruments/0       metadata fallback only
// Position quantity comes from quantity and average purchase cost must come
// from averagePrice in the instrument's original metadata currency — never
// averagePriceConverted. The account summary supplies total value and cash in
// the account currency.
//
// This file runs ONLY in Chrome's MAIN world. It must stay separate from
// t212.js: that file runs in the isolated extension world to register the
// broker with IK, while this one must share Trading 212's page/session origin.
// Loading the same source in both worlds made the broker registration fail in
// a live Chrome test. The one-time same-origin window.postMessage bridge below
// is therefore intentional. No DOM/CSV fallback, response-body logging, or
// persistence of cookies, identifiers, session responses, or portfolio data.
"use strict";

var IKT212Api = (() => {
  const API_ROOT = "https://live.services.trading212.com";
  const ENDPOINTS = Object.freeze({
    accounts: "/rest/v1/accounts",
    summary: "/rest/v1/equity/multi-accounts/summary",
    instruments: "/instrumentarium/v2/instruments/find",
    instrumentCatalog: "/instrumentarium/v2/instruments/0",
  });

  const COUNTRY_TO_YAHOO_SUFFIX = Object.freeze({
    US: "", NL: ".AS", DE: ".DE", GB: ".L", CA: ".TO", AU: ".AX",
    SE: ".ST", DK: ".CO", NO: ".OL", FI: ".HE", CH: ".SW", FR: ".PA",
    BE: ".BR", IE: ".IR", IT: ".MI", ES: ".MC", PT: ".LS", AT: ".VI",
    PL: ".WA", HK: ".HK", JP: ".T",
  });
  const T212_SHORTHAND_TO_YAHOO_SUFFIX = Object.freeze({
    a: ".AS",
    d: ".DE",
    l: ".L",
    p: ".PA",
  });

  const isFiniteNumber = (value) => Number.isFinite(Number(value));
  const asNumber = (value) => (isFiniteNumber(value) ? Number(value) : null);
  const asCurrency = (value) => {
    const currency = String(value || "").trim().toUpperCase();
    return /^[A-Z]{3}$/.test(currency) ? currency : null;
  };

  function calibrationError(error) {
    return { ok: false, needsCalibration: true, error };
  }

  function toYahooSymbol(code) {
    const ticker = String(code || "").trim();
    const countryMatch = /^(.+)_([A-Z]{2})_EQ$/i.exec(ticker);
    if (countryMatch) {
      const baseTicker = countryMatch[1].replace(/_/g, "-").toUpperCase();
      const venue = countryMatch[2].toUpperCase();
      const suffix = COUNTRY_TO_YAHOO_SUFFIX[venue];
      if (suffix == null) return { ticker: baseTicker, venue, knownVenue: false };
      return { ticker: `${baseTicker}${suffix}`, venue, knownVenue: true };
    }

    const shorthandMatch = /^(.+)([adlp])_EQ$/.exec(ticker);
    if (!shorthandMatch) return null;
    const baseTicker = shorthandMatch[1].replace(/_/g, "-").toUpperCase();
    const venue = shorthandMatch[2];
    return {
      ticker: `${baseTicker}${T212_SHORTHAND_TO_YAHOO_SUFFIX[venue]}`,
      venue,
      knownVenue: true,
    };
  }

  function noteFor(instrument) {
    const parts = [];
    if (instrument.isin) parts.push(`ISIN: ${String(instrument.isin).trim()}`);
    const name = instrument.shortName || instrument.fullName;
    if (name) parts.push(`název: ${String(name).trim()}`);
    return parts.length ? parts.join("; ") : null;
  }

  function readTotalValue(summary, account) {
    const tradingType = String(account?.tradingType || "").toUpperCase();
    return asNumber(summary?.accountsByType?.[tradingType]?.cash?.total);
  }

  function readCashValue(cash) {
    const investPot = asNumber(cash?.investPot);
    const spendingPot = asNumber(cash?.spendingPot);
    if (investPot != null && spendingPot != null) return investPot + spendingPot;
    const candidates = [
      cash?.free,
      cash?.free?.total,
      cash?.free?.result,
    ];
    return candidates.map(asNumber).find((value) => value != null) ?? null;
  }

  function buildPayload({ account, summary, instruments, now = new Date().toISOString() }) {
    const currency = asCurrency(account?.currencyCode);
    if (!currency) return calibrationError("Trading 212 nevrátilo měnu investičního účtu.");
    if (!summary || !Array.isArray(summary.open)) {
      return calibrationError("Trading 212 nevrátilo seznam otevřených pozic.");
    }
    if (!Array.isArray(instruments)) {
      return calibrationError("Trading 212 nevrátilo metadata instrumentů.");
    }

    const totalValue = readTotalValue(summary, account);
    if (totalValue == null) {
      return calibrationError("Trading 212 nevrátilo celkovou hodnotu účtu.");
    }
    const cashValue = readCashValue(summary?.cash);
    if (cashValue == null) {
      return calibrationError("Trading 212 nevrátilo hotovost na účtu.");
    }

    const metadataByTicker = new Map();
    for (const instrument of instruments) {
      const ticker = String(instrument?.ticker || "").trim();
      if (ticker) metadataByTicker.set(ticker.toUpperCase(), instrument);
    }

    const positions = [];
    const warnings = [];
    for (const position of summary.open) {
      const code = String(position?.code || "").trim();
      const shares = asNumber(position?.quantity);
      if (!code || shares == null) {
        return calibrationError("Trading 212 nevrátilo kód nebo počet kusů u některé pozice.");
      }
      if (shares === 0) continue;

      // This deliberately uses averagePrice, not averagePriceConverted.
      const avgCost = asNumber(position?.averagePrice);
      if (avgCost == null || avgCost <= 0) {
        return calibrationError("Trading 212 nevrátilo průměrnou nákupní cenu u některé pozice.");
      }
      const instrument = metadataByTicker.get(code.toUpperCase());
      if (!instrument) {
        return calibrationError("Trading 212 nevrátilo metadata instrumentu u některé pozice.");
      }
      const instrumentCurrency = asCurrency(instrument?.currency);
      if (!instrumentCurrency) {
        return calibrationError("Trading 212 nevrátilo měnu instrumentu u některé pozice.");
      }
      const mapped = toYahooSymbol(instrument.ticker);
      if (!mapped) {
        return calibrationError("Trading 212 vrátilo ticker v neznámém formátu.");
      }
      if (!mapped.knownVenue) {
        return calibrationError(`Trading 212 vrátilo ticker z neznámé burzy (${mapped.venue}). Nahlaste prosím tento ticker, aby šlo doplnit správnou Yahoo příponu.`);
      }
      positions.push({
        ticker: mapped.ticker,
        shares,
        avgCost,
        currency: instrumentCurrency,
        note: noteFor(instrument),
      });
    }

    return {
      ok: true,
      payload: {
        broker: "t212",
        brokerLabel: "Trading 212",
        totalValue,
        cashValue,
        currency,
        positions,
        warnings,
        scrapedAt: now,
      },
    };
  }

  function readLiveAccounts(accountsResponse) {
    if (Array.isArray(accountsResponse)) return accountsResponse;
    if (!accountsResponse
      || !Array.isArray(accountsResponse.liveAccounts)
      || !Array.isArray(accountsResponse.demoAccounts)) {
      throw requestError("accounts");
    }
    return accountsResponse.liveAccounts;
  }

  function findLiveEquityAccount(accountsResponse) {
    const accounts = readLiveAccounts(accountsResponse);
    const account = accounts.find((candidate) => String(candidate?.tradingType || "").toUpperCase() === "EQUITY"
      && String(candidate?.type || "").toUpperCase() === "LIVE"
      && asCurrency(candidate?.currencyCode));
    if (!account) throw requestError("accounts");
    return account;
  }

  function readAccountSummary(summaryResponse, account) {
    if (!summaryResponse || typeof summaryResponse !== "object" || Array.isArray(summaryResponse)) {
      throw requestError("summary");
    }

    const tradingType = String(account?.tradingType || "").toUpperCase();
    const accountSummary = summaryResponse.accountsByType?.[tradingType];
    if (accountSummary !== undefined) {
      if (!accountSummary
        || !Array.isArray(accountSummary.open)
        || !accountSummary.cash
        || typeof accountSummary.cash !== "object"
        || Array.isArray(accountSummary.cash)) {
        throw requestError("summary");
      }
      return { ...summaryResponse, open: accountSummary.open, cash: accountSummary.cash };
    }

    if (!Array.isArray(summaryResponse.open)
      || !summaryResponse.cash
      || typeof summaryResponse.cash !== "object"
      || Array.isArray(summaryResponse.cash)) {
      throw requestError("summary");
    }
    return summaryResponse;
  }

  function createClientContext(overrides = {}) {
    const deviceId = String(overrides.deviceId || globalThis.crypto?.randomUUID?.() || "");
    if (!deviceId) throw requestError("runtime");
    return {
      deviceId,
      appVersion: String(overrides.appVersion || "8.41.0"),
    };
  }

  function traderHeaders(client, accountId) {
    const clientParts = [
      "application=WC4",
      `version=${client.appVersion}`,
      `dUUID=${client.deviceId}`,
    ];
    if (accountId != null) clientParts.push(`accountId=${accountId}`);
    return {
      "X-Trader-Device-Model": "Chrome",
      "X-Trader-Client": clientParts.join(","),
      "X-Trader-Target-Type": "EQUITY",
    };
  }

  function requestError(stage, status) {
    const error = new Error("Trading 212 API request failed");
    error.t212Stage = stage;
    if (Number.isInteger(status)) error.t212Status = status;
    return error;
  }

  function formatApiError(error) {
    const labels = {
      accounts: "účty",
      summary: "souhrn portfolia",
      instruments: "metadata instrumentů",
      bridge: "spojení doplňku se stránkou",
      runtime: "spuštění importéru",
    };
    const stage = labels[error?.t212Stage] || "připojení k API";
    const status = Number.isInteger(error?.t212Status) ? ` (HTTP ${error.t212Status})` : "";
    return `Trading 212 API se nepodařilo načíst v kroku „${stage}“${status}. Obnov stránku (F5), zkontroluj přihlášení a zkus import znovu.`;
  }

  async function requestJson(fetchImpl, path, init = {}, headers = {}, stage) {
    const { headers: initHeaders, ...requestInit } = init;
    const hasBody = Object.prototype.hasOwnProperty.call(requestInit, "body");
    let response;
    try {
      response = await fetchImpl(`${API_ROOT}${path}`, {
        credentials: "include",
        ...requestInit,
        headers: {
          ...headers,
          ...initHeaders,
          Accept: "application/json",
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
      });
    } catch {
      throw requestError(stage);
    }
    if (!response?.ok) throw requestError(stage, response?.status);
    try {
      return await response.json();
    } catch {
      throw requestError(stage, response?.status);
    }
  }

  async function fetchT212Data(fetchImpl = globalThis.fetch, clientOverrides) {
    if (typeof fetchImpl !== "function") throw requestError("runtime");
    const client = createClientContext(clientOverrides);
    const accounts = await requestJson(fetchImpl, ENDPOINTS.accounts, {}, traderHeaders(client), "accounts");
    const account = findLiveEquityAccount(accounts);
    const headers = traderHeaders(client, account.id);
    const summaryResponse = await requestJson(
      fetchImpl,
      `${ENDPOINTS.summary}?targetCurrency=${encodeURIComponent(account.currencyCode)}`,
      { method: "POST", body: "[]" },
      headers,
      "summary",
    );
    const summary = readAccountSummary(summaryResponse, account);
    const codes = [...new Set(summary.open.map((position) => String(position?.code || "").trim()).filter(Boolean))];
    let instruments = await requestJson(
      fetchImpl,
      ENDPOINTS.instruments,
      { method: "POST", body: JSON.stringify(codes) },
      headers,
      "instruments",
    );
    if (!Array.isArray(instruments)) throw requestError("instruments");

    const foundCodes = new Set(instruments
      .map((instrument) => String(instrument?.ticker || "").trim().toUpperCase())
      .filter(Boolean));
    const missingCodes = codes.filter((code) => !foundCodes.has(code.toUpperCase()));
    if (missingCodes.length > 0) {
      const catalog = await requestJson(
        fetchImpl,
        ENDPOINTS.instrumentCatalog,
        {},
        headers,
        "instruments",
      );
      if (!catalog || !Array.isArray(catalog.instruments)) throw requestError("instruments");
      const missingCodeSet = new Set(missingCodes.map((code) => code.toUpperCase()));
      instruments = instruments.concat(catalog.instruments.filter((instrument) => {
        const ticker = String(instrument?.ticker || "").trim().toUpperCase();
        return ticker && missingCodeSet.has(ticker);
      }));
    }
    return { account, summary, instruments };
  }

  const exported = {
    API_ROOT,
    ENDPOINTS,
    COUNTRY_TO_YAHOO_SUFFIX,
    toYahooSymbol,
    buildPayload,
    fetchT212Data,
    formatApiError,
  };
  return exported;
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = IKT212Api;
} else {
  globalThis.IKT212Api = IKT212Api;

// MAIN-world bridge. Keep this next to the API adapter: both parts depend on
// the page session, but expose no Chrome extension API to the page.
(() => {
  const CHANNEL = "ik-t212-session-bridge";
  const API_ERROR = "Trading 212 API se nepodařilo načíst. Obnov stránku (F5), zkontroluj přihlášení a zkus import znovu.";
  const ADAPTER_UNAVAILABLE_ERROR = "Importér Trading 212 se na stránce nespustil. Obnov stránku (F5) a zkus import znovu.";

  function response(requestId, nonce, result) {
    window.postMessage({ channel: CHANNEL, type: "response", requestId, nonce, ...result }, location.origin);
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== CHANNEL || message.type !== "request"
        || typeof message.requestId !== "string" || typeof message.nonce !== "string") return;

    let result;
    const api = globalThis.IKT212Api;
    if (!api) {
      result = { ok: false, needsCalibration: true, error: ADAPTER_UNAVAILABLE_ERROR };
    } else try {
      const data = await api.fetchT212Data(globalThis.fetch);
      result = api.buildPayload({ ...data, now: new Date().toISOString() });
    } catch (error) {
      result = {
        ok: false,
        needsCalibration: true,
        error: api?.formatApiError?.(error) || API_ERROR,
      };
    }
    response(message.requestId, message.nonce, { ok: true, result });
  });
})();
}
