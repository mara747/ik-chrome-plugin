// Interactive Brokers Client Portal — the member's own positions + Net Liq.
//
// API-ONLY by design: the Client Portal SPA is a thin client over /v1/api/*
// on the same origin and the member's session is already authenticated, so
// we read the portfolio straight from the API — complete data (all pages,
// machine precision, currency + listingExchange per position), independent
// of the DOM. Deliberately NO DOM-table fallback: the API contract is more
// stable than the markup; when it breaks we fix the scraper, and until then
// the member gets an actionable error message instead of silently odd data.
//   GET {base}/portfolio/accounts                  account list (prerequisite)
//   GET {base}/portfolio/{acct}/positions/all      every position: conid, ticker,
//       position, avgPrice/avgCost, currency, listingExchange, assetClass
//       (verified live 2026-07; older gateways page via /positions/{page})
//   GET {base}/portfolio/{acct}/summary            netliquidation {amount,currency}
//   GET {base}/trsrv/secdef?conids=…               listingExchange backfill
// {base} differs by host/portal generation — the browser Client Portal
// proxies under /portal.proxy/v1/portal (verified live on
// www.interactivebrokers.ie, 2026-07), the CP gateway uses /v1/api — so the
// first /portfolio/accounts probe walks API_BASES and pins the winner.
// listingExchange → Yahoo suffix via EXCHANGE_SUFFIX (port of value-invest
// core/ibkr.py IB_TO_YAHOO_SUFFIX): IBIS → RHM.DE, SEHK → 9880.HK.
//
// The only DOM touchpoints (calibrated from a live dump, 2026-07):
//   .account-alias__container__account_alias .fg70   account id "U16241433"
//     — picks the right account when the member has several
//   div.ptf-positions[nlv] + account header numeric    Net Liq backup when
//     only the /summary call fails
"use strict";

(() => {
  const NLV_HOLDER = ".ptf-positions[nlv]";
  const ACCOUNT_VALUE = ".account-alias__container__account-values";
  const ACCOUNT_ID = ".account-alias__container__account_alias .fg70";

  // IB exchange code → Yahoo suffix (port of value-invest core/ibkr.py
  // IB_TO_YAHOO_SUFFIX). "" = US listing, bare symbol.
  const EXCHANGE_SUFFIX = {
    NASDAQ: "", NYSE: "", ARCA: "", AMEX: "", BATS: "", ISLAND: "", PINK: "",
    SMART: "",
    IBIS: ".DE", IBIS2: ".DE", XETRA: ".DE", FWB: ".F", TRADEGATE: ".DE",
    GETTEX: ".DE",
    LSE: ".L", LSEETF: ".L", LSEIOB: ".IL",
    SBF: ".PA", PAR: ".PA",
    AEB: ".AS",
    "ENEXT.BE": ".BR",
    EBS: ".SW", VIRTX: ".SW", SWX: ".SW",
    BVME: ".MI", MTAA: ".MI",
    BM: ".MC",
    BVL: ".LS",
    OMX: ".ST", SFB: ".ST", OMXNO: ".OL", HEX: ".HE", ICEX: ".IC",
    VSE: ".VI",
    TASE: ".TA",
    SEHK: ".HK", SEHKNTL: ".HK",
    TSEJ: ".T",
    ASX: ".AX",
    TSE: ".TO", VENTURE: ".V",
    SGX: ".SI",
    MEXI: ".MX",
  };

  // IB symbol (+ its listing exchange when known) → Yahoo ticker. Port of
  // core/ibkr.py guess_yahoo_symbol: US listings turn '.'/' ' class
  // separators into '-' ("BRK B" → BRK-B); foreign listings get the Yahoo
  // exchange suffix (IBIS → RHM.DE). Unknown/missing exchange → bare symbol.
  function toYahoo(sym, exch) {
    // The portal API annotates non-primary symbols with the venue
    // ("9880 @SEHK", "ENR @IBIS") — cut it; the suffix comes from `exch`.
    const bare = String(sym || "").split("@")[0].trim();
    const suffix = exch ? EXCHANGE_SUFFIX[exch] : undefined;
    let s = IK.yahooSymbol(bare.replace(/\s+/g, "-"));
    if (suffix === "") s = s.replace(/\./g, "-");
    else if (suffix && !s.includes(".")) s += suffix;
    return s;
  }

  const API_PAGE_SIZE = 100;
  const API_MAX_PAGES = 5; // the club web caps imports at 500 positions anyway

  // Candidate API path prefixes, most likely first. Pinned per page load by
  // the first /portfolio/accounts call that answers with a JSON array.
  const API_BASES = [
    "/portal.proxy/v1/portal", // browser Client Portal (www.interactivebrokers.ie/.co.uk/.com)
    "/portal.proxy/v1/api",
    "/v1/api",                 // Client Portal gateway style
    "/v1/portal",
  ];
  let apiBase = null;

  // Same-origin GET riding the member's session; null on any failure.
  async function apiGet(path) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const resp = await fetch(path, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // Uniform, actionable error for the popup when an endpoint fails —
  // the most common cause by far is an expired/not-yet-ready session.
  const apiError = (what) => ({
    ok: false,
    error:
      `IBKR API nevrátilo ${what}. Nejčastější příčina je odhlášená nebo ` +
      "vypršelá session — obnov stránku Client Portalu (F5), případně se " +
      "znovu přihlas, a pak import spusť znovu.",
  });

  // { [conid]: { exchange, currency } } from /trsrv/secdef, or null.
  async function fetchSecdefs(conids) {
    if (!conids.length || !apiBase) return null;
    const body = await apiGet(`${apiBase}/trsrv/secdef?conids=${conids.join(",")}`);
    const list = Array.isArray(body) ? body : body && body.secdef;
    if (!Array.isArray(list)) return null;
    const map = {};
    for (const sd of list) {
      if (!sd || sd.conid == null) continue;
      map[String(sd.conid)] = {
        exchange: String(sd.listingExchange || "").toUpperCase() || null,
        currency: String(sd.currency || "").toUpperCase() || null,
      };
    }
    return map;
  }

  // Net Liq backup straight from the page when only /summary fails: the
  // holdings wrapper carries it as a raw attribute, the account header
  // (<small>USD</small><span class="numeric">…) is the second choice.
  function readTotalFromDom() {
    const holder = document.querySelector(NLV_HOLDER);
    const raw = holder ? parseFloat(holder.getAttribute("nlv")) : NaN;
    if (Number.isFinite(raw) && raw > 0) return raw;
    const n = IK.parseNumber(
      IK.pickText(document, [`${ACCOUNT_VALUE} .numeric`]), "dot");
    return n != null && n > 0 ? n : null;
  }

  const readBaseCurrency = () =>
    IK.detectCurrency(IK.pickText(document, [`${ACCOUNT_VALUE} small`]) || "");

  IK.registerScraper({
    broker: "ibkr",
    brokerLabel: "Interactive Brokers",
    // IBIE (Ireland) — where Czech club members live; the scraper itself
    // works on any interactivebrokers.* host thanks to relative API paths.
    portfolioUrl: "https://www.interactivebrokers.ie/portal",
    // The API works from any logged-in Client Portal page; only the SSO/login
    // routes make no sense as a starting point.
    isPortfolioPage: () => !/\/sso\//i.test(location.pathname),

    async scrape() {
      // 1) Accounts — documented prerequisite for the /portfolio/* endpoints;
      // the same call also pins which API base this host uses.
      let accounts = apiBase
        ? await apiGet(`${apiBase}/portfolio/accounts`)
        : null;
      if (!Array.isArray(accounts) || !accounts.length) {
        for (const base of API_BASES) {
          const res = await apiGet(`${base}/portfolio/accounts`);
          if (Array.isArray(res) && res.length) {
            apiBase = base;
            accounts = res;
            break;
          }
        }
      }
      if (!Array.isArray(accounts) || !accounts.length) {
        return apiError("seznam účtů (/portfolio/accounts)");
      }
      const domId = (IK.pickText(document, [ACCOUNT_ID]) || "").trim();
      const account = accounts.find((a) => a && a.id === domId) || accounts[0];
      if (!account || !account.id) {
        return apiError("použitelný účet (/portfolio/accounts)");
      }

      // 2) Positions — the browser portal returns everything via
      // /positions/all (verified live); older gateways page by 100.
      let rows = null;
      let truncated = false;
      let pagesFailed = false;
      const all = await apiGet(
        `${apiBase}/portfolio/${account.id}/positions/all`);
      if (Array.isArray(all)) rows = all;
      else if (all && Array.isArray(all[account.id])) rows = all[account.id];
      else if (all && Array.isArray(all.positions)) rows = all.positions;
      if (rows == null) {
        rows = [];
        for (let page = 0; page < API_MAX_PAGES; page += 1) {
          const batch = await apiGet(
            `${apiBase}/portfolio/${account.id}/positions/${page}`);
          if (!Array.isArray(batch)) {
            pagesFailed = true;
            break;
          }
          rows.push(...batch);
          if (batch.length < API_PAGE_SIZE) break;
          if (page === API_MAX_PAGES - 1) truncated = true;
        }
        if (pagesFailed && !rows.length) {
          return apiError(`pozice účtu ${account.id} (/portfolio/positions)`);
        }
      }

      // Stocks/ETFs only (assetClass STK); options, futures and FX cash lines
      // are not importable positions — count them for the warning instead.
      const skippedKinds = new Map();
      const picked = [];
      for (const r of rows) {
        if (!r || typeof r !== "object") continue;
        const qty = Number(r.position);
        if (!Number.isFinite(qty) || qty === 0) continue;
        const cls = String(r.assetClass || r.secType || "STK").toUpperCase();
        if (cls !== "STK") {
          skippedKinds.set(cls, (skippedKinds.get(cls) || 0) + 1);
          continue;
        }
        picked.push(r);
      }

      // 3) listingExchange is usually inline; backfill the rest via secdef.
      const missing = picked.filter((r) => !r.listingExchange && r.conid != null);
      const secdefs = missing.length
        ? await fetchSecdefs(missing.map((r) => String(r.conid)))
        : null;

      const warnings = [];
      const unknownExchanges = new Set();
      const positions = [];
      for (const r of picked) {
        const sd = secdefs && r.conid != null ? secdefs[String(r.conid)] : null;
        // The "@VENUE" annotation in the symbol doubles as an exchange
        // fallback when listingExchange/secdef give nothing.
        const annot = String(r.ticker || r.contractDesc || "")
          .match(/@\s*([A-Z0-9.]+)/);
        const exch = String(
          r.listingExchange || (sd && sd.exchange) || (annot && annot[1]) || "",
        ).toUpperCase() || null;
        if (exch && !(exch in EXCHANGE_SUFFIX)) unknownExchanges.add(exch);
        const ticker = toYahoo(r.ticker || r.contractDesc || "", exch);
        if (!ticker || !/[A-Z0-9]/.test(ticker)) continue;
        const avgPrice = Number(r.avgPrice);
        const avgCost = Number(r.avgCost);
        positions.push({
          ticker,
          shares: Number(r.position),
          avgCost: avgPrice > 0 ? avgPrice : (avgCost > 0 ? avgCost : null),
          currency: String(r.currency || (sd && sd.currency) || "")
            .toUpperCase() || null,
          note: null,
        });
      }

      if (pagesFailed) {
        warnings.push(
          "Část stránek s pozicemi se nepodařilo načíst — zkontroluj, že počet pozic sedí.",
        );
      }
      // The club web rejects imports with more than 500 positions.
      if (positions.length > 500) {
        truncated = true;
        positions.length = 500;
      }
      if (truncated) {
        warnings.push(
          `Účet má víc než ${API_PAGE_SIZE * API_MAX_PAGES} pozic — ` +
          `importováno prvních ${positions.length}.`,
        );
      }
      if (skippedKinds.size) {
        const parts = [...skippedKinds].map(([k, n]) => `${k} ×${n}`);
        warnings.push(
          `Vynechány ne-akciové položky (${parts.join(", ")}) — importují se ` +
          "jen akcie/ETF; hotovost je součástí celkové hodnoty účtu.",
        );
      }
      if (unknownExchanges.size) {
        warnings.push(
          `Neznámé burzy: ${[...unknownExchanges].join(", ")} — tickery těchto pozic zkontroluj ručně.`,
        );
      }
      if (!positions.length) {
        warnings.push(
          "Na účtu nejsou žádné akcie/ETF — importuje se jen celková hodnota účtu.",
        );
      }

      // 4) Net Liquidation.
      const summary = await apiGet(`${apiBase}/portfolio/${account.id}/summary`);
      const nl = summary && summary.netliquidation;
      let totalValue = nl && Number(nl.amount) > 0 ? Number(nl.amount) : null;
      let currency = (nl && nl.currency) || null;
      if (totalValue == null) {
        totalValue = readTotalFromDom();
        currency = currency || readBaseCurrency();
      }
      if (totalValue == null) {
        if (!positions.length) {
          return apiError(
            `hodnotu účtu ${account.id} (/portfolio/summary) a účet nemá ani pozice k importu`,
          );
        }
        warnings.push("Net Liquidation (celkovou hodnotu účtu) jsem nenašel — pošlu jen pozice.");
      }

      return {
        ok: true,
        payload: {
          broker: "ibkr",
          brokerLabel: `Interactive Brokers – ${account.id}`,
          totalValue,
          currency: currency || readBaseCurrency() || "USD",
          positions,
          warnings,
          scrapedAt: new Date().toISOString(),
        },
      };
    },
  });
})();
