// Shared helpers for broker content scripts. Loaded BEFORE each broker scraper
// (see manifest content_scripts order); attaches a single `IK` global. Plain
// script, no modules — MV3 content scripts run in an isolated world, so this
// never leaks into the page.
"use strict";

// eslint-disable-next-line no-unused-vars
const IK = (() => {
  // ---- exact broker-specific ticker overrides --------------------------
  // WHY this table exists: broker catalogs sometimes carry their OWN symbol
  // variant for an instrument — typically a numbered ticker kept after the
  // plain symbol was recycled to another company, or a different listing line
  // of the same fund — while Yahoo (and therefore the club web, which prices
  // everything by Yahoo symbols) uses a different one. Example: XTB lists
  // Doximity as DOC1 because their plain DOC belonged to an older instrument;
  // Yahoo knows only DOC. No suffix/venue rule can derive that, so each case
  // is a hand-verified 1:1 exception here.
  //
  // HOW to extend: add only aliases that cannot be derived by a stable general
  // rule, keyed broker -> normalized input ticker -> native position currency
  // -> final Yahoo ticker. An adapter may pass an otherwise unresolved native
  // ticker only after it has supplied an exact, independently verified native
  // currency and explicitly required this shared override. The currency key is
  // always a guard: the same
  // ticker text can exist on another venue in another currency, and a naive
  // broker+ticker key would remap that innocent row too. Every entry needs a
  // test in tests/broker-ticker-overrides.test.js.
  //
  // Applied centrally in registerScraper AFTER the broker adapter finished its
  // normal mapping or explicitly marked an exact native ticker for this final
  // conversion — never duplicate final aliases inside a scraper. If the
  // alias would collide with an existing (ticker, currency) row, the rows are
  // NOT merged: the conversion is skipped and a Czech audit note is appended
  // (silently merging two positions could misstate shares and avg cost).
  function deepFreeze(value) {
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object" && !Object.isFrozen(nested)) {
        deepFreeze(nested);
      }
    }
    return Object.freeze(value);
  }

  const BROKER_TICKER_OVERRIDES = deepFreeze({
    xtb: {
      DOC1: { USD: "DOC" },
      "ISLN.UK": { USD: "ISLN.L" },
    },
    t212: {
      "WEBN1.DE": { EUR: "WEBN.DE" },
    },
    portu: {
      "SX5EEX.DE": { EUR: "EUEA.AS" },
    },
  });

  // ---- numbers & money -------------------------------------------------

  // Currency detection: symbol or ISO code anywhere in the cell text.
  const CURRENCY_SYMBOLS = [
    ["Kč", "CZK"], ["$", "USD"], ["€", "EUR"], ["£", "GBP"], ["zł", "PLN"],
  ];
  const CURRENCY_CODE_RE = /\b(USD|EUR|GBP|CZK|CHF|PLN|SEK|NOK|DKK|JPY|CAD|AUD)\b/;

  function detectCurrency(text) {
    if (!text) return null;
    const code = text.match(CURRENCY_CODE_RE);
    if (code) return code[1];
    for (const [sym, cur] of CURRENCY_SYMBOLS) if (text.includes(sym)) return cur;
    return null;
  }

  // Parse a number out of broker-page text. Brokers mix locales — eToro/IBKR
  // render "1,187.80", Portu "1 187,80 Kč" — so scrapers pass the decimal
  // separator they know ('dot' | 'comma'); 'auto' guesses: the LAST of [.,]
  // is the decimal iff it is followed by 1–2 digits, otherwise a thousands sep.
  function parseNumber(text, decimal = "auto") {
    if (text == null) return null;
    let s = String(text)
      .replace(/[  \s]/g, "")      // all space flavors = thousands seps
      .replace(/[−–]/g, "-")                 // unicode minus/dash
      .replace(/[^0-9.,\-]/g, "");           // currency symbols, %, letters
    if (!s) return null;
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    let dec = decimal;
    if (dec === "auto") {
      const last = Math.max(lastDot, lastComma);
      if (last === -1) dec = "dot";
      else {
        const frac = s.length - last - 1;
        dec = frac >= 1 && frac <= 2 ? (last === lastDot ? "dot" : "comma") : "none";
      }
    }
    if (dec === "comma") s = s.replace(/\./g, "").replace(",", ".");
    else if (dec === "dot") s = s.replace(/,/g, "");
    else s = s.replace(/[.,]/g, "");
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  // "$1,234.56" → { value: 1234.56, currency: "USD" } (currency null if unclear).
  function parseMoney(text, decimal = "auto") {
    return { value: parseNumber(text, decimal), currency: detectCurrency(text) };
  }

  // eToro-style symbol → Yahoo ticker (port of value-invest core/etoro.py
  // _yahoo_symbol): strip cashtag $, drop the .US suffix (Yahoo wants bare US
  // tickers), keep other exchange suffixes (.L, .DE, .PA … match Yahoo).
  function yahooSymbol(sym) {
    let s = String(sym || "").trim().toUpperCase().replace(/^\$/, "");
    if (s.endsWith(".US")) s = s.slice(0, -3);
    // Bloomberg class-share notation → Yahoo dash: BRK/B → BRK-B, BF/A → BF-A
    // (Portu case 2026-08-04). Trailing slash (LSE "RR/ LN") se jen zahodí.
    if (s.endsWith("/")) s = s.slice(0, -1);
    s = s.replace("/", "-");
    return s;
  }

  // ---- DOM helpers -------------------------------------------------------

  const txt = (el) => (el ? el.innerText.trim() : null);

  // First element matching any of the candidate selectors, in order. Scrapers
  // carry candidate LISTS so a broker UI change degrades to "needs calibration"
  // instead of a hard break.
  function pick(root, selectors) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch { /* invalid selector candidate — skip */ }
    }
    return null;
  }

  const pickText = (root, selectors) => txt(pick(root, selectors));

  function pickAll(root, selectors) {
    for (const sel of selectors) {
      try {
        const els = root.querySelectorAll(sel);
        if (els.length) return [...els];
      } catch { /* skip */ }
    }
    return [];
  }

  // Poll `fn` until it returns a truthy value or the timeout passes. SPAs
  // render tables late; scrape() calls this instead of assuming the DOM is ready.
  function waitFor(fn, { timeoutMs = 8000, intervalMs = 400 } = {}) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        let v = null;
        try { v = fn(); } catch { /* keep polling */ }
        if (v) return resolve(v);
        if (performance.now() - t0 > timeoutMs) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  // Find a data table by matching header texts. Returns { headers, rows } where
  // each row maps header index → cell text, or null when nothing matches.
  // Works on real <table> and ARIA grids (role=table/grid with role=row cells).
  function tableByHeaders(requiredHeaderRes) {
    const containers = [
      ...document.querySelectorAll("table"),
      ...document.querySelectorAll('[role="table"], [role="grid"]'),
    ];
    for (const t of containers) {
      const headerCells = t.querySelectorAll(
        'thead th, thead td, [role="columnheader"]');
      const headers = [...headerCells].map((h) => h.innerText.trim());
      if (!headers.length) continue;
      const ok = requiredHeaderRes.every((re) => headers.some((h) => re.test(h)));
      if (!ok) continue;
      const bodyRows = t.querySelectorAll('tbody tr, [role="row"]');
      const rows = [];
      for (const r of bodyRows) {
        const cells = [...r.querySelectorAll('td, [role="cell"], [role="gridcell"]')]
          .map((c) => c.innerText.trim());
        if (cells.length) rows.push(cells);
      }
      if (rows.length) return { headers, rows };
    }
    return null;
  }

  // Column index whose header matches `re`, or -1.
  const headerIndex = (headers, re) => headers.findIndex((h) => re.test(h));

  // Find a money value labelled by `labelRe` anywhere on the page: the smallest
  // element whose own text matches the label, then the first parseable number in
  // it or its parent. Used for "Net Liquidation" / "Celková hodnota" style totals.
  function findLabelledValue(labelRe, decimal = "auto") {
    const all = document.body.querySelectorAll("*");
    for (const el of all) {
      if (el.children.length > 3) continue;             // labels live in leaves
      const t = el.innerText || "";
      if (t.length > 200 || !labelRe.test(t)) continue;
      for (const scope of [el, el.parentElement, el.parentElement?.parentElement]) {
        if (!scope) continue;
        const m = (scope.innerText || "").replace(labelRe, "");
        const money = parseMoney(m, decimal);
        if (money.value != null && Math.abs(money.value) > 0) return money;
      }
    }
    return null;
  }

  // ---- scraper registration ---------------------------------------------

  function resolveBrokerTicker(
    broker,
    ticker,
    currency,
    overrides = BROKER_TICKER_OVERRIDES,
  ) {
    if (typeof broker !== "string"
        || typeof ticker !== "string"
        || typeof currency !== "string") return ticker;
    const brokerKey = broker.trim().toLowerCase();
    const tickerKey = ticker.trim().toUpperCase();
    const currencyKey = currency.trim().toUpperCase();
    return overrides[brokerKey]?.[tickerKey]?.[currencyKey] ?? ticker;
  }

  function appendCollisionNote(note, outputTicker) {
    const audit = `převod na ${outputTicker} přeskočen – `
      + `kolize s existující pozicí ${outputTicker}`;
    const current = typeof note === "string" ? note : "";
    if (current.includes(audit)) return current;
    return current.trim() ? `${current}; ${audit}` : audit;
  }

  function applyBrokerTickerOverrides(
    payload,
    overrides = BROKER_TICKER_OVERRIDES,
  ) {
    if (!payload || !Array.isArray(payload.positions)) return payload;

    const candidates = payload.positions.map((position) => {
      const inputTicker = position && position.ticker;
      const outputTicker = resolveBrokerTicker(
        payload.broker,
        inputTicker,
        position && position.currency,
        overrides,
      );
      const changed = typeof inputTicker === "string"
        && typeof outputTicker === "string"
        && outputTicker !== inputTicker;
      const tickerKey = typeof outputTicker === "string"
        ? outputTicker.trim().toUpperCase() : "";
      const currencyKey = typeof position?.currency === "string"
        ? position.currency.trim().toUpperCase() : "";
      return {
        position,
        outputTicker,
        changed,
        collisionKey: tickerKey && currencyKey
          ? `${tickerKey}\u0000${currencyKey}` : null,
      };
    });

    const counts = new Map();
    for (const candidate of candidates) {
      if (!candidate.collisionKey) continue;
      counts.set(
        candidate.collisionKey,
        (counts.get(candidate.collisionKey) || 0) + 1,
      );
    }

    const positions = candidates.map((candidate) => {
      if (!candidate.changed) return candidate.position;
      if ((counts.get(candidate.collisionKey) || 0) > 1) {
        return {
          ...candidate.position,
          note: appendCollisionNote(
            candidate.position?.note,
            candidate.outputTicker,
          ),
        };
      }
      return { ...candidate.position, ticker: candidate.outputTicker };
    });

    return { ...payload, positions };
  }

  // One scraper per broker page registers itself; the popup drives it over
  // chrome.runtime messages:
  //   IK_DETECT → { supported, broker, brokerLabel, onPortfolioPage, portfolioUrl }
  //   IK_SCRAPE → { ok: true, payload } | { ok: false, error, needsCalibration? }
  // payload: { broker, brokerLabel, totalValue, cashValue?, currency,
  //            positions[], scrapedAt, warnings[] }
  // cashValue (optional, in `currency`): broker-reported cash included in
  // totalValue but not in positions; null/absent = the broker doesn't say.
  function registerScraper(def) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "IK_DETECT") {
        let onPage = false;
        try { onPage = !!def.isPortfolioPage(); } catch { /* stay false */ }
        sendResponse({
          supported: true,
          broker: def.broker,
          brokerLabel: def.brokerLabel,
          portfolioUrl: def.portfolioUrl,
          onPortfolioPage: onPage,
        });
        return;
      }
      if (msg?.type === "IK_SCRAPE") {
        Promise.resolve()
          .then(() => def.scrape())
          .then((res) => {
            const response = res?.ok
              ? { ...res, payload: applyBrokerTickerOverrides(res.payload) }
              : (res?.diagnostic || !globalThis.IKDiagnostics ? res : {
                  ...res, diagnostic: globalThis.IKDiagnostics.failure({
                    phase: "scrape",
                    errorCode: res?.needsCalibration
                      ? "layout_changed" : "broker_request_failed",
                  }),
                });
            sendResponse(response);
          })
          .catch((e) => {
            const response = {
              ok: false, error: "Načtení skončilo neočekávanou chybou.",
            };
            if (globalThis.IKDiagnostics) {
              response.diagnostic = globalThis.IKDiagnostics.failure({
                phase: "scrape", errorCode: "unexpected_error",
                error: e, step: `${def.broker}.scrape`,
              });
            }
            sendResponse(response);
          });
        return true; // async sendResponse
      }
    });
  }

  return {
    parseNumber, parseMoney, detectCurrency, yahooSymbol,
    txt, pick, pickText, pickAll, waitFor, tableByHeaders, headerIndex,
    findLabelledValue, resolveBrokerTicker, applyBrokerTickerOverrides,
    registerScraper,
  };
})();
