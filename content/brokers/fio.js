// Fio e-Broker (ebroker.fio.cz) — the member's portfolio value AND positions.
//
// DOM scraper calibrated live (2026-07) against Portfolio/Stav
// (e-portfolio.cgi). e-Broker is a classic server-rendered CGI app — no SPA,
// no JSON API — so this is table parsing:
//
//   <table id="portfolio_table" class="data_table">
//     tr.title_row  "Portfolio: základní OÚ: 1800258063"
//     tr.col_row    Pokyn | Název CP | Symbol | Množství | Kurz | … | Majetek | …
//     tr.e / tr.o   data rows (zebra)
//     tr with .sum  "Součet (CZK)" + the grand total in the Majetek column
//
// Column ORDER differs between Portfolio views (Stav vs Investice drops
// "Název CP" and moves Množství), so the mapping is header-text-driven — the
// repo rule: a layout change degrades to needsCalibration, never to silently
// wrong numbers. Czech number locale (space thousands, comma decimals) →
// IK.parseNumber "comma".
//
// Cash rows have Symbol like "CZK(OU)" / "CZK(na cestě)" — ISO currency +
// source in parens. They are part of the total but not positions (same
// warning pattern as Portu). Prague (BCPP) symbols carry the BAA prefix
// (BAAKOMB) → strip + ".PR" = Yahoo (KOMB.PR), currency CZK. US symbols are
// plain tickers and pass through bare. Other Fio markets (SRN/PLN/RMS) had
// no live rows to calibrate against → the ticker passes through 1:1 with a
// check-it warning.
//
// e-Broker's portfolio pages show NO purchase price (only the current Kurz;
// avg cost would need reconstructing from the Obchody history — out of scope
// for a snapshot import, ADR 0002) → avgCost: null + warning; the member can
// fill prices in the club's grid editor.
"use strict";

(() => {
  const CASH_SYMBOL_RE = /^([A-Z]{3})\(/;      // "CZK(OU)", "CZK(na cestě)"
  const BCPP_RE = /^BAA([A-Z0-9]+)$/;          // Prague: BAAKOMB → KOMB.PR
  const SUM_RE = /^Součet(\s*\((\w{3})\))?/;   // "Součet (CZK)"

  function findPortfolioTable() {
    return (
      document.querySelector("#portfolio_table")
      || [...document.querySelectorAll("table.data_table")].find((t) =>
        [...t.rows].some((r) => /(^|\s)col_row(\s|$)/.test(r.className)))
      || null
    );
  }

  // Header-driven column map; null when the required columns are missing.
  function headerMap(table) {
    const rows = [...table.rows];
    const colRow = rows.find((r) => /(^|\s)col_row(\s|$)/.test(r.className))
      || rows.find((r) => [...r.cells].some(
        (c) => c.innerText.trim() === "Symbol"));
    if (!colRow) return null;
    const headers = [...colRow.cells].map((c) => c.innerText.trim());
    const idx = (re) => headers.findIndex((h) => re.test(h));
    const map = {
      afterRow: rows.indexOf(colRow),
      symbol: idx(/^Symbol$/i),
      qty: idx(/^Množství$/i),
      value: idx(/^Majetek$/i),
      name: idx(/^Název CP$/i), // optional (Investice view has no name column)
    };
    return map.symbol >= 0 && map.qty >= 0 && map.value >= 0 ? map : null;
  }

  // "BAAKOMB" → { ticker: "KOMB.PR", currency: "CZK", calibrated: true }.
  function fioToYahoo(sym) {
    const s = IK.yahooSymbol(sym);
    const bcpp = s.match(BCPP_RE);
    if (bcpp) return { ticker: bcpp[1] + ".PR", currency: "CZK", calibrated: true };
    // US tickers are plain (AAPL). Other venues (SRN/PLN/RMS) uncalibrated —
    // pass through and let the warning point the member at the row.
    return { ticker: s, currency: null, calibrated: /^[A-Z0-9-]{1,6}$/.test(s) };
  }

  function portfolioName(table) {
    const title = [...table.rows].find(
      (r) => /(^|\s)title_row(\s|$)/.test(r.className));
    const m = title && title.innerText.match(/Portfolio:\s*(.+?)\s*OÚ:/);
    return m ? m[1].trim() : null;
  }

  IK.registerScraper({
    broker: "fio",
    brokerLabel: "Fio e-Broker",
    portfolioUrl: "https://ebroker.fio.cz/e-portfolio.cgi",
    isPortfolioPage: () => /^\/e-portfolio/.test(location.pathname),

    async scrape() {
      const table = await IK.waitFor(findPortfolioTable, { timeoutMs: 4000 });
      if (!table) {
        const login = document.querySelector("input[type=password]");
        return {
          ok: false,
          needsCalibration: !login,
          error: login
            ? "Vypadá to, že nejsi v e-Brokeru přihlášený. Přihlas se a otevři "
              + "Portfolio → Stav."
            : "Na stránce nevidím tabulku portfolia (#portfolio_table) — otevři "
              + "Portfolio → Stav, případně se formát stránky změnil.",
        };
      }
      const map = headerMap(table);
      if (!map) {
        return {
          ok: false,
          needsCalibration: true,
          error: "Tabulka portfolia nemá očekávané sloupce (Symbol / Množství / "
            + "Majetek) — formát e-Brokeru se nejspíš změnil.",
        };
      }

      const positions = [];
      const uncalibrated = [];
      let totalValue = null;
      let totalCurrency = null;
      let positionsValue = 0;

      for (const row of [...table.rows].slice(map.afterRow + 1)) {
        const cells = [...row.cells];
        const symbol = (cells[map.symbol]?.innerText || "").trim();
        if (!symbol) continue;

        const sum = symbol.match(SUM_RE);
        if (sum) {
          totalValue = IK.parseNumber(cells[map.value]?.innerText, "comma");
          totalCurrency = sum[2] || totalCurrency;
          continue; // per-market subtotals may follow; the CZK one wins below
        }
        if (CASH_SYMBOL_RE.test(symbol)) continue; // hotovost: jen v součtu

        const shares = IK.parseNumber(cells[map.qty]?.innerText, "comma");
        if (!Number.isFinite(shares) || shares === 0) continue;
        const { ticker, currency, calibrated } = fioToYahoo(symbol);
        if (!ticker) continue;
        if (!calibrated) uncalibrated.push(ticker);
        positionsValue += IK.parseNumber(cells[map.value]?.innerText, "comma") || 0;
        positions.push({
          ticker,
          shares,
          avgCost: null, // e-Broker průměrnou nákupní cenu nezobrazuje
          currency,
          note: map.name >= 0
            ? (cells[map.name]?.innerText || "").trim() || null
            : null,
        });
      }

      if (totalValue === null) {
        if (!positions.length) {
          return {
            ok: false,
            needsCalibration: true,
            error: "V tabulce portfolia jsem nenašel ani pozice, ani řádek "
              + "Součet — formát e-Brokeru se nejspíš změnil.",
          };
        }
        totalValue = positionsValue; // bez součtového řádku: aspoň součet pozic
      }

      const warnings = [];
      if (positions.length) {
        warnings.push(
          "Fio e-Broker nezobrazuje průměrnou nákupní cenu — pozice se "
          + "importují bez ní, v tabulce ji můžeš doplnit ručně.",
        );
      } else {
        warnings.push("Portfolio nemá žádné pozice — importuje se jen "
          + "celková hodnota.");
      }
      const cashRef = totalValue - positionsValue;
      if (positions.length && cashRef > Math.max(1, totalValue * 0.005)) {
        warnings.push(
          `Hotovost ≈ ${Math.round(cashRef).toLocaleString("cs-CZ")} `
          + `${totalCurrency || "CZK"} je součástí celkové hodnoty, ale ne pozic.`,
        );
      }
      if (uncalibrated.length) {
        warnings.push(
          `Tickery mimo pražskou burzu a USA jsem převedl 1:1 — zkontroluj je `
          + `v tabulce: ${uncalibrated.join(", ")}.`,
        );
      }

      const name = portfolioName(table);
      return {
        ok: true,
        payload: {
          broker: "fio",
          brokerLabel: name ? `Fio – ${name}` : "Fio e-Broker",
          totalValue,
          currency: totalCurrency || "CZK",
          positions,
          warnings,
          scrapedAt: new Date().toISOString(),
        },
      };
    },
  });
})();
