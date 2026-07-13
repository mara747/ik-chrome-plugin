// Portu (www.portu.cz) — the member's portfolio value AND positions.
//
// API-ONLY, calibrated live (2026-07): the Nuxt SPA talks to same-origin
// /api/v1/* with an OAuth Bearer token kept in localStorage — which content
// scripts share with the page, so no credentials ever touch the extension:
//   localStorage "portu_session"        contains the access token (found by
//                                       key name /token/, not /refresh/)
//   localStorage "portu_client"         .clientData.id = client GUID
//   GET  /api/v1/dashboard?clientId=…&displayCurrency=CZK&taxTreatment=T
//        &from=…&to=…&productIds=…      → Portfolios[]: { Id, Name,
//                                        ActualBalance … }, PortfolioSummary
//   POST /api/v1/portfolio/composition  { clientId, portfolioId } →
//        PositionComposition.Instruments[]: { Symbol "CSPX LN", Isin, Name,
//        Shares, PurchasePrice (avg, in OriginalCurrency), OriginalCurrency,
//        MarketPriceTotalRef (CZK), … }, CashComposition
// Verified against the live account: ActualBalance and PurchasePrice match
// the page to the koruna/cent. Instrument symbols are Bloomberg-style
// "TICKER VENUE" → mapped to Yahoo via BBG_SUFFIX (LN → CSPX.L, GY → .DE).
//
// taxTreatment (from the app bundle enum): 0 = Default (běžné investice),
// 1 = DIP ("Důchodový účet" in the CZ app), 2 = Pension (SK). The same
// client + the same product GUID owns all three sets — the dashboard just
// filters by treatment. We query all three and merge, otherwise a member
// standing on their DIP portfolio gets "Nepoznám, které portfolio" (the
// 2026-07 member report). Child ("dětský") and corporate accounts are a
// DIFFERENT client (impersonation) and are still unsupported — the
// diagnostic error asks for a report.
//
// The open portfolio is picked via the ?id=<guid> query on
// /souhrn/investice/detail; with exactly one non-empty portfolio (or one
// non-empty DIP/pension portfolio when the URL path is the DIP section) it
// is picked automatically. An ?id= unknown to all three dashboards still
// gets a shot via /portfolio/composition (total = sum of positions + cash).
// If composition fails, degrade to VALUE-ONLY import (positions: [] → the
// club web shows the confirm dialog, not the grid).
"use strict";

(() => {
  // Product catalog GUID of "Portu Invest" — baked into the Portu app bundle,
  // identical for every client (it is NOT client data). /dashboard returns
  // 500 without it (and still lists gallery/crypto portfolios with it).
  const PRODUCT_IDS = "7BC950C4-0EDF-E711-80C6-00505601141C";

  const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Bloomberg venue code → Yahoo suffix. "" = US, bare ticker.
  const BBG_SUFFIX = {
    US: "", UN: "", UW: "", UQ: "", UR: "", UA: "",
    LN: ".L",                 // London
    GY: ".DE", GR: ".DE",     // Xetra / Germany composite
    FP: ".PA",                // Paris
    NA: ".AS",                // Amsterdam
    BB: ".BR",                // Brussels
    SW: ".SW", SE: ".SW", VX: ".SW", // SIX
    IM: ".MI",                // Milan
    SM: ".MC",                // Madrid
    PL: ".LS",                // Lisbon
    AV: ".VI",                // Vienna
    SS: ".ST",                // Stockholm
    DC: ".CO",                // Copenhagen
    NO: ".OL",                // Oslo
    FH: ".HE",                // Helsinki
    ID: ".IR",                // Dublin
    HK: ".HK",
    JT: ".T", JP: ".T",       // Tokyo
    AU: ".AX", AT: ".AX",     // Australia
    CN: ".TO", CT: ".TO",     // Canada
    SP: ".SI",                // Singapore
  };

  // "CSPX LN" → { ticker: "CSPX.L", venueKnown: true }.
  function bbgToYahoo(sym) {
    const parts = String(sym || "").trim().toUpperCase().split(/\s+/);
    const ticker = IK.yahooSymbol(parts[0] || "");
    const venue = parts[1] || null;
    const suffix = venue ? BBG_SUFFIX[venue] : undefined;
    return {
      ticker: suffix ? ticker + suffix : ticker,
      venueKnown: suffix !== undefined,
      venue,
    };
  }

  // Access token + client id from the SPA's localStorage; null when the
  // member isn't logged in (or Portu reshapes the storage).
  function readAuth() {
    const findTok = (o, depth) => {
      if (!o || typeof o !== "object" || depth > 3) return null;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string" && /token/i.test(k) && !/refresh/i.test(k)
            && v.length > 20) return v;
        const t = findTok(v, depth + 1);
        if (t) return t;
      }
      return null;
    };
    let token = null;
    let clientId = null;
    try { token = findTok(JSON.parse(localStorage.getItem("portu_session")), 0); }
    catch { /* not logged in */ }
    try {
      const id = JSON.parse(localStorage.getItem("portu_client")).clientData.id;
      if (GUID_RE.test(id)) clientId = id;
    } catch { /* not logged in */ }
    return token && clientId ? { token, clientId } : null;
  }

  // /souhrn/investice/detail?id=<portfolio guid> — which portfolio is open.
  function portfolioIdFromUrl() {
    const id = new URLSearchParams(location.search).get("id");
    return id && GUID_RE.test(id) ? id.toLowerCase() : null;
  }

  // Is the member inside the DIP / pension section? (CZ route segment
  // "dlouhodoby-investicni-produkt", SK "duchodovy-ucet".)
  function onDipPath() {
    return /\/(dlouhodoby-investicni-produkt|duchodovy-ucet)(\/|$)/
      .test(location.pathname);
  }

  async function apiFetch(url, { token }, init = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const resp = await fetch(url, {
        ...init,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function fetchDashboard(auth, taxTreatment) {
    const now = new Date().toISOString().slice(0, 19) + "Z";
    return apiFetch(
      "/api/v1/dashboard?clientId=" + encodeURIComponent(auth.clientId)
        + "&from=2020-01-01T00:00:00Z&to=" + now
        + "&displayCurrency=CZK&taxTreatment=" + taxTreatment
        + "&productIds=" + PRODUCT_IDS,
      auth,
    );
  }

  // Dashboard across all tax treatments (0 Default / 1 DIP / 2 Pension),
  // deduped by portfolio Id. A treatment the account doesn't have just
  // returns an empty list (or an error we ignore).
  async function fetchAllPortfolios(auth) {
    const dashes = await Promise.all(
      [0, 1, 2].map((t) => fetchDashboard(auth, t)),
    );
    const byId = new Map();
    let summary = null;
    let anyOk = false;
    dashes.forEach((dash, treatment) => {
      if (!dash || !Array.isArray(dash.Portfolios)) return;
      anyOk = true;
      if (!summary && dash.PortfolioSummary) summary = dash.PortfolioSummary;
      for (const p of dash.Portfolios) {
        const id = String(p && p.Id).toLowerCase();
        if (!byId.has(id)) byId.set(id, { portfolio: p, treatment });
      }
    });
    return { anyOk, summary, entries: [...byId.values()] };
  }

  function fetchComposition(auth, portfolioId) {
    return apiFetch("/api/v1/portfolio/composition", auth, {
      method: "POST",
      body: JSON.stringify({ clientId: auth.clientId, portfolioId }),
    });
  }

  // PositionComposition.Instruments → normalized positions + the CZK sum of
  // position market values (cash-difference warning, fallback total).
  function positionsFromComposition(comp) {
    const items = (comp && comp.PositionComposition
      && comp.PositionComposition.Instruments) || [];
    const positions = [];
    const unknownVenues = new Set();
    let investedRef = 0;
    if (Array.isArray(items)) {
      for (const it of items) {
        const shares = Number(it && it.Shares);
        if (!Number.isFinite(shares) || shares === 0) continue;
        const { ticker, venueKnown, venue } = bbgToYahoo(it.Symbol);
        if (!ticker) continue;
        if (!venueKnown && venue) unknownVenues.add(venue);
        const avg = Number(it.PurchasePrice);
        investedRef += Number(it.MarketPriceTotalRef) || 0;
        positions.push({
          ticker,
          shares,
          avgCost: Number.isFinite(avg) && avg > 0 ? avg : null,
          currency: String(it.OriginalCurrency || "").toUpperCase() || null,
          note: String(it.Name || "").trim() || null,
        });
      }
    }
    return { positions, investedRef, unknownVenues };
  }

  // CashComposition wasn't calibrated live — look for CZK-reference numbers
  // (same "…Ref" convention as MarketPriceTotalRef) and return null rather
  // than guess when nothing matches.
  const CASH_REF_KEYS = ["MarketPriceTotalRef", "AmountRef", "TotalRef", "BalanceRef"];
  function cashFromComposition(comp) {
    const cash = comp && comp.CashComposition;
    const items = Array.isArray(cash) ? cash : cash ? [cash] : [];
    let sum = 0;
    let found = false;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const known = CASH_REF_KEYS.find((k) => Number.isFinite(Number(item[k])));
      const key = known
        || Object.keys(item).find((k) => /Ref$/.test(k) && Number.isFinite(Number(item[k])));
      if (key) {
        sum += Number(item[key]);
        found = true;
      }
    }
    return found ? sum : null;
  }

  function unknownVenuesWarning(unknownVenues) {
    return `Neznámé kódy burz: ${[...unknownVenues].join(", ")} — tickery těchto pozic zkontroluj v tabulce.`;
  }

  IK.registerScraper({
    broker: "portu",
    brokerLabel: "Portu",
    portfolioUrl: "https://www.portu.cz/souhrn",
    isPortfolioPage: () => /^\/souhrn/.test(location.pathname),

    async scrape() {
      const auth = readAuth();
      if (!auth) {
        return {
          ok: false,
          error:
            "Vypadá to, že nejsi na Portu přihlášený (v prohlížeči chybí session). " +
            "Přihlas se na www.portu.cz a zkus to znovu.",
        };
      }

      const { anyOk, summary, entries } = await fetchAllPortfolios(auth);
      if (!anyOk) {
        return {
          ok: false,
          error:
            "Portu API nevrátilo přehled portfolií (/api/v1/dashboard). " +
            "Nejčastější příčina je vypršelá session — obnov stránku (F5), " +
            "případně se znovu přihlas, a zkus to znovu.",
        };
      }

      const urlId = portfolioIdFromUrl();
      let entry = urlId
        ? entries.find((e) => String(e.portfolio.Id).toLowerCase() === urlId) || null
        : null;

      // An ?id= none of the dashboards know (typically a child/corporate
      // account viewed under the member's login — a different client, so
      // ActualBalance is out of reach): composition may still answer for
      // the member's own client. Total = positions + cash from composition.
      if (!entry && urlId) {
        const comp = await fetchComposition(auth, urlId);
        const { positions, investedRef, unknownVenues } = positionsFromComposition(comp);
        if (positions.length) {
          const warnings = [];
          if (unknownVenues.size) warnings.push(unknownVenuesWarning(unknownVenues));
          const cash = cashFromComposition(comp);
          warnings.push(cash === null
            ? "Portfolio jsem načetl náhradní cestou (přehled účtu ho nevrací) — "
              + "celková hodnota je součet pozic BEZ hotovosti."
            : "Portfolio jsem načetl náhradní cestou (přehled účtu ho nevrací) — "
              + "celková hodnota je součet pozic a hotovosti.");
          return {
            ok: true,
            payload: {
              broker: "portu",
              brokerLabel: "Portu",
              totalValue: investedRef + (cash || 0),
              currency: (summary && summary.Currency) || "CZK",
              positions,
              warnings,
              scrapedAt: new Date().toISOString(),
            },
          };
        }
      }

      if (!entry) {
        const live = entries.filter((e) => Number(e.portfolio.ActualBalance) > 0);
        if (live.length === 1) {
          entry = live[0];
        } else if (onDipPath()) {
          // Inside the DIP/pension section a lone non-empty DIP portfolio
          // is unambiguous even when regular portfolios exist next to it.
          const dip = live.filter((e) => e.treatment > 0);
          if (dip.length === 1) entry = dip[0];
        }
      }

      if (!entry) {
        const names = entries
          .map((e) => String(e.portfolio.Name || "").trim())
          .filter(Boolean);
        return {
          ok: false,
          error:
            "Nepoznám, které portfolio importovat. Otevři na Portu detail " +
            "konkrétního portfolia (Souhrn → klikni na portfolio) a zkus to znovu." +
            (names.length ? ` Na účtu vidím: ${names.join(", ")}.` : "") +
            (urlId
              ? " Otevřený detail mi Portu API nevrátilo (dětský/firemní účet " +
                "zatím neumím) — napiš nám prosím, ať to doladíme."
              : ""),
        };
      }

      const target = entry.portfolio;
      const totalValue = Number(target.ActualBalance);
      if (!Number.isFinite(totalValue)) {
        return {
          ok: false,
          needsCalibration: true,
          error: "Portu API vrátilo portfolio bez hodnoty (ActualBalance) — formát se nejspíš změnil.",
        };
      }

      const warnings = [];
      const comp = await fetchComposition(auth, target.Id);
      const { positions, investedRef, unknownVenues } = positionsFromComposition(comp);
      if (unknownVenues.size) {
        warnings.push(unknownVenuesWarning(unknownVenues));
      }
      // Cash sits in the total but has no ticker → tell the member where
      // the difference between the total and the sum of positions is.
      const cashRef = totalValue - investedRef;
      if (positions.length && cashRef > Math.max(1, totalValue * 0.005)) {
        warnings.push(
          `Hotovost ≈ ${Math.round(cashRef).toLocaleString("cs-CZ")} Kč je ` +
          "součástí celkové hodnoty, ale ne pozic.",
        );
      }
      if (!positions.length) {
        warnings.push(comp
          ? "Portfolio nemá žádné pozice — importuje se jen celková hodnota."
          : "Složení portfolia se nepodařilo načíst — importuje se jen celková hodnota.");
      }

      const name = String(target.Name || "").trim();
      return {
        ok: true,
        payload: {
          broker: "portu",
          brokerLabel: name ? `Portu – ${name}` : "Portu",
          totalValue,
          // displayCurrency=CZK is requested explicitly above.
          currency: (summary && summary.Currency) || "CZK",
          positions,
          warnings,
          scrapedAt: new Date().toISOString(),
        },
      };
    },
  });
})();
