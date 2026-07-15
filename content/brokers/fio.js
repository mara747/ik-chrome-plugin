// Fio e-Broker (ebroker.fio.cz) — the member's portfolio value AND positions.
//
// DOM scraper calibrated live (2026-07) against a real account. e-Broker is a
// classic server-rendered CGI app — no SPA, no JSON API — so this is table
// parsing over two views:
//
// PRIMARY: Portfolio/Vývoj (e-portfolio.cgi?menu=2, #portfolio_vyvoj_table) —
// the only view with PURCHASE data. Grouped columns (names repeat!):
//   [Stav na začátku: Akcie Kurz Majetek] [Změna: Kusy Nákup Prodej Výnosy]
//   [Stav na konci: Akcie Kurz Majetek] [Výsledek: Zisk Výnos]
// → shares = last "Akcie", value = last "Majetek" (first occurrences are the
// period start). avgCost = Nákup / Kusy, but ONLY when the period covers the
// whole position: start shares 0, no sells, Kusy == end shares — otherwise
// the average would lie (partial sells, buys before the period start) and we
// send null instead. Closed positions (end shares 0 — e.g. a sold CEZ row)
// are skipped. The view is fetched same-origin with credentials whatever
// e-Broker page the member is on, so the import works from any tab.
//
// FALLBACK: Portfolio/Stav (#portfolio_table) — value + positions without
// avgCost, used when the Vývoj fetch/parse fails.
//
// Shared calibration: column mapping is header-TEXT-driven (order differs
// between views — repo rule: layout change degrades to needsCalibration,
// never to silently wrong numbers). Czech number locale → parseNumber
// "comma". Cash rows: bare currency code ("CZK") on Vývoj, "CZK(OU)" /
// "CZK(na cestě)" on Stav — folded into the total, not positions. Prague
// (BCPP) symbols carry the BAA prefix → strip + ".PR" = Yahoo (BAAKOMB →
// KOMB.PR, CZK); plain US tickers pass through; other venues (SRN/PLN/RMS)
// uncalibrated → 1:1 + check-it warning. avgCost only for CZK rows — the
// currency of Vývoj's Nákup column is only verified for BCPP.
"use strict";

(() => {
  const CASH_PAREN_RE = /^([A-Z]{3})\(/;       // Stav: "CZK(OU)", "CZK(na cestě)"
  const CASH_CODE_RE = /^[A-Z]{3}$/;           // Vývoj: bare "CZK"
  const BCPP_RE = /^BAA([A-Z0-9]+)$/;          // Prague: BAAKOMB → KOMB.PR
  const SUM_RE = /^Součet(\s*\((\w{3})\))?/;   // "Součet (CZK)"

  // "BAAKOMB" → { ticker: "KOMB.PR", currency: "CZK", calibrated: true }.
  function fioToYahoo(sym) {
    const s = IK.yahooSymbol(sym);
    const bcpp = s.match(BCPP_RE);
    if (bcpp) return { ticker: bcpp[1] + ".PR", currency: "CZK", calibrated: true };
    // US tickers are plain (AAPL). Other venues (SRN/PLN/RMS) uncalibrated —
    // pass through and let the warning point the member at the row.
    return { ticker: s, currency: null, calibrated: /^[A-Z0-9-]{1,6}$/.test(s) };
  }

  function isCashSymbol(symbol) {
    return CASH_PAREN_RE.test(symbol)
      || (CASH_CODE_RE.test(symbol) && IK.detectCurrency(symbol) === symbol);
  }

  function colRowOf(table) {
    return [...table.rows].find((r) => /(^|\s)col_row(\s|$)/.test(r.className))
      || null;
  }

  function portfolioName(table) {
    const title = [...table.rows].find(
      (r) => /(^|\s)title_row(\s|$)/.test(r.className));
    const m = title && title.innerText.match(/Portfolio:\s*(.+?)\s*OÚ:/);
    return m ? m[1].trim() : null;
  }

  const num = (cell) => IK.parseNumber(cell ? cell.innerText : null, "comma");

  // ---- Portfolio/Vývoj (?menu=2): positions + avgCost --------------------

  async function fetchVyvojDoc() {
    try {
      const resp = await fetch("/e-portfolio.cgi?menu=2",
        { credentials: "same-origin" });
      if (!resp.ok) return null;
      const html = await resp.text();
      return new DOMParser().parseFromString(html, "text/html");
    } catch {
      return null;
    }
  }

  function parseVyvoj(doc) {
    const table = doc.querySelector("#portfolio_vyvoj_table");
    if (!table) return null;
    const colRow = colRowOf(table);
    if (!colRow) return null;
    const headers = [...colRow.cells].map((c) => c.innerText.trim());
    // Header names repeat across the start/end column groups: the FIRST
    // occurrence belongs to the period start, the LAST to the period end.
    const map = {
      symbol: headers.indexOf("Symbol"),
      startShares: headers.indexOf("Akcie"),
      deltaQty: headers.indexOf("Kusy"),
      buys: headers.indexOf("Nákup"),
      sells: headers.indexOf("Prodej"),
      endShares: headers.lastIndexOf("Akcie"),
      endValue: headers.lastIndexOf("Majetek"),
    };
    if (map.symbol < 0 || map.endShares < 0 || map.endValue < 0
        || map.endShares === map.startShares) return null;

    const rows = [...table.rows].slice([...table.rows].indexOf(colRow) + 1);
    const positions = [];
    const noAvg = [];
    const uncalibrated = [];
    let totalValue = null;
    let totalCurrency = null;
    let positionsValue = 0;

    for (const row of rows) {
      const cells = [...row.cells];
      const symbol = (cells[map.symbol]?.innerText || "").trim();
      if (!symbol) continue;
      const sum = symbol.match(SUM_RE);
      if (sum) {
        totalValue = num(cells[map.endValue]);
        totalCurrency = sum[2] || totalCurrency;
        continue;
      }
      if (isCashSymbol(symbol)) continue; // hotovost: jen v součtu

      const shares = num(cells[map.endShares]);
      if (!Number.isFinite(shares) || shares === 0) continue; // uzavřená pozice
      const { ticker, currency, calibrated } = fioToYahoo(symbol);
      if (!ticker) continue;
      if (!calibrated) uncalibrated.push(ticker);

      const startShares = num(cells[map.startShares]) || 0;
      const buys = map.buys >= 0 ? num(cells[map.buys]) : null;
      const sells = map.sells >= 0 ? num(cells[map.sells]) || 0 : 0;
      const deltaQty = map.deltaQty >= 0 ? num(cells[map.deltaQty]) : null;
      // Průměr jen když období pokrývá celou pozici (viz hlavička souboru) a
      // měnu Nákupu známe (kalibrováno jen pro CZK/BCPP).
      const avgOk = currency === "CZK" && startShares === 0 && sells === 0
        && deltaQty === shares && Number.isFinite(buys) && buys > 0;
      if (!avgOk) noAvg.push(ticker);

      positionsValue += num(cells[map.endValue]) || 0;
      positions.push({
        ticker,
        shares,
        avgCost: avgOk ? buys / shares : null,
        currency,
        note: null, // Vývoj nemá sloupec s názvem CP
      });
    }

    if (totalValue === null && !positions.length) return null;
    return {
      positions, noAvg, uncalibrated,
      totalValue: totalValue === null ? positionsValue : totalValue,
      totalCurrency, positionsValue,
      name: portfolioName(table),
    };
  }

  // ---- Portfolio/Stav (fallback bez nákupních cen) ------------------------

  function parseStav(doc) {
    const table = doc.querySelector("#portfolio_table")
      || [...doc.querySelectorAll("table.data_table")].find(colRowOf);
    if (!table) return null;
    const colRow = colRowOf(table);
    if (!colRow) return null;
    const headers = [...colRow.cells].map((c) => c.innerText.trim());
    const idx = (re) => headers.findIndex((h) => re.test(h));
    const map = {
      symbol: idx(/^Symbol$/i),
      qty: idx(/^Množství$/i),
      value: idx(/^Majetek$/i),
      name: idx(/^Název CP$/i), // optional (Investice view has no name column)
    };
    if (map.symbol < 0 || map.qty < 0 || map.value < 0) return null;

    const rows = [...table.rows].slice([...table.rows].indexOf(colRow) + 1);
    const positions = [];
    const uncalibrated = [];
    let totalValue = null;
    let totalCurrency = null;
    let positionsValue = 0;

    for (const row of rows) {
      const cells = [...row.cells];
      const symbol = (cells[map.symbol]?.innerText || "").trim();
      if (!symbol) continue;
      const sum = symbol.match(SUM_RE);
      if (sum) {
        totalValue = num(cells[map.value]);
        totalCurrency = sum[2] || totalCurrency;
        continue;
      }
      if (isCashSymbol(symbol)) continue;

      const shares = num(cells[map.qty]);
      if (!Number.isFinite(shares) || shares === 0) continue;
      const { ticker, currency, calibrated } = fioToYahoo(symbol);
      if (!ticker) continue;
      if (!calibrated) uncalibrated.push(ticker);
      positionsValue += num(cells[map.value]) || 0;
      positions.push({
        ticker,
        shares,
        avgCost: null, // Stav nákupní cenu nezobrazuje
        currency,
        note: map.name >= 0
          ? (cells[map.name]?.innerText || "").trim() || null
          : null,
      });
    }

    if (totalValue === null && !positions.length) return null;
    return {
      positions, noAvg: positions.map((p) => p.ticker), uncalibrated,
      totalValue: totalValue === null ? positionsValue : totalValue,
      totalCurrency, positionsValue,
      name: portfolioName(table),
    };
  }

  // ---- scraper -------------------------------------------------------------

  IK.registerScraper({
    broker: "fio",
    brokerLabel: "Fio e-Broker",
    portfolioUrl: "https://ebroker.fio.cz/e-portfolio.cgi?menu=2",
    isPortfolioPage: () => /^\/e-/.test(location.pathname),

    async scrape() {
      // Primárně Vývoj (?menu=2) — jediný pohled s nákupními cenami. Když je
      // člen přímo na něm, parsuj DOM; jinak si ho stáhni same-origin.
      let parsed = parseVyvoj(document);
      if (!parsed) {
        const doc = await fetchVyvojDoc();
        parsed = doc ? parseVyvoj(doc) : null;
      }
      if (!parsed) parsed = parseStav(document);

      if (!parsed) {
        const login = document.querySelector("input[type=password]")
          || /Login/i.test(document.title);
        return {
          ok: false,
          needsCalibration: !login,
          error: login
            ? "Vypadá to, že nejsi v e-Brokeru přihlášený. Přihlas se a zkus "
              + "to znovu."
            : "Nenašel jsem tabulku portfolia (Portfolio → Vývoj ani Stav) — "
              + "formát e-Brokeru se nejspíš změnil.",
        };
      }

      const warnings = [];
      if (!parsed.positions.length) {
        warnings.push("Portfolio nemá žádné otevřené pozice — importuje se "
          + "jen celková hodnota.");
      } else if (parsed.noAvg.length === parsed.positions.length) {
        warnings.push(
          "Průměrné nákupní ceny se nepodařilo z e-Brokeru odvodit — pozice "
          + "se importují bez nich, v tabulce je můžeš doplnit ručně.",
        );
      } else if (parsed.noAvg.length) {
        warnings.push(
          `U pozic ${parsed.noAvg.join(", ")} se průměrná nákupní cena nedala `
          + "spolehlivě odvodit (prodeje v období / nákupy před začátkem "
          + "období ve Vývoji) — doplň ji ručně.",
        );
      }
      const cashRef = parsed.totalValue - parsed.positionsValue;
      if (parsed.positions.length
          && cashRef > Math.max(1, parsed.totalValue * 0.005)) {
        warnings.push(
          `Hotovost ≈ ${Math.round(cashRef).toLocaleString("cs-CZ")} `
          + `${parsed.totalCurrency || "CZK"} je součástí celkové hodnoty, `
          + "ale ne pozic.",
        );
      }
      if (parsed.uncalibrated.length) {
        warnings.push(
          "Tickery mimo pražskou burzu a USA jsem převedl 1:1 — zkontroluj "
          + `je v tabulce: ${parsed.uncalibrated.join(", ")}.`,
        );
      }

      return {
        ok: true,
        payload: {
          broker: "fio",
          brokerLabel: parsed.name ? `Fio – ${parsed.name}` : "Fio e-Broker",
          totalValue: parsed.totalValue,
          currency: parsed.totalCurrency || "CZK",
          positions: parsed.positions,
          warnings,
          scrapedAt: new Date().toISOString(),
        },
      };
    },
  });
})();
