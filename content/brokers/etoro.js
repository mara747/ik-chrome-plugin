// eToro — the logged-in member's portfolio, calibrated live (2026-07) against
// the copied-trader breakdown page www.etoro.com/portfolio/breakdown/<user>
// (and the own /portfolio/overview, which uses the same table component).
//
// The Angular table exposes stable automation-ids; cells are flat, index-
// aligned arrays (one entry per position):
//   portfolio-overview-table-body-cell-market-name    "SMSN.L", "DELL 24/5"
//   portfolio-overview-table-body-cell-market-last-name  full instrument name
//   portfolio-overview-table-body-cell-units-value    fractional units (shares)
//   portfolio-overview-table-body-cell-avg-open-rate  avg open price, NATIVE ccy
//   portfolio-overview-table-body-cell-invested-value display-ccy invested (CZK)
//   portfolio-overview-table-body-cell-equity         display-ccy value (CZK)
//   portfolio-breakdown-summary-equity / -header-equity   total portfolio value
//   portfolio-breakdown-header-symbol-name-mirror     copied trader username
// Symbols already carry the Yahoo exchange suffix (SMSN.L, RHM.DE, 3750.HK),
// US tickers are bare with a "24/5"/"24/7" trading-hours badge to strip.
//
// Currency: eToro does NOT expose the instrument's native currency per row, so
// avg-open-rate's currency is inferred from the exchange suffix (.DE→EUR,
// .HK→HKD, US→USD…). London (.L/.IL) is genuinely ambiguous — real UK shares
// quote in GBX pence, GDRs in USD (e.g. Samsung SMSN.L, iShares CSPX.L) — so
// those get a best-effort GBP + a warning listing them for the member to fix
// in the review grid before saving. Total value uses the account display
// currency (detected from the Kč/$ symbol).
"use strict";

(() => {
  const CELL = (name) =>
    `[automation-id="portfolio-overview-table-body-cell-${name}"]`;
  const TOTAL_SELECTORS = [
    '[automation-id="portfolio-breakdown-summary-equity"]',
    '[automation-id="portfolio-breakdown-header-equity"]',
    '[automation-id="account-balance-total-value"]',
    '[automation-id="footer-unit-value"]',
  ];
  const COPIED_NAME_SELECTORS = [
    '[automation-id="portfolio-breakdown-header-symbol-name-mirror"]',
    '[automation-id="portfolio-breakdown-header-display-name-mirror"]',
  ];

  // eToro venue suffix → [currency, Yahoo suffix]. eToro's codes mostly match
  // Yahoo (.DE, .HK, .PA…) but some differ (.NV = Euronext Amsterdam → .AS),
  // so we remap the ticker's suffix to Yahoo's where they diverge.
  const EXCHANGE = {
    ".DE": ["EUR", ".DE"], ".F": ["EUR", ".F"], ".SG": ["EUR", ".SG"],
    ".MU": ["EUR", ".MU"], ".BE": ["EUR", ".BE"],
    ".PA": ["EUR", ".PA"], ".AS": ["EUR", ".AS"], ".NV": ["EUR", ".AS"],
    ".BR": ["EUR", ".BR"], ".MI": ["EUR", ".MI"], ".MC": ["EUR", ".MC"],
    ".LS": ["EUR", ".LS"], ".VI": ["EUR", ".VI"], ".IR": ["EUR", ".IR"],
    ".HE": ["EUR", ".HE"],
    ".SW": ["CHF", ".SW"],
    ".L": ["GBP", ".L"], ".IL": ["GBP", ".IL"],   // AMBIGUOUS — see below
    ".HK": ["HKD", ".HK"],
    ".T": ["JPY", ".T"],
    ".AX": ["AUD", ".AX"],
    ".TO": ["CAD", ".TO"], ".V": ["CAD", ".V"],
    ".ST": ["SEK", ".ST"], ".CO": ["DKK", ".CO"], ".OL": ["NOK", ".OL"],
    ".SI": ["SGD", ".SI"], ".TA": ["ILS", ".TA"],
    ".MX": ["MXN", ".MX"], ".SA": ["BRL", ".SA"], ".WA": ["PLN", ".WA"],
  };
  // eToro US venue tags that aren't exchanges — strip like ".US" → bare US ticker.
  const US_VENUE_TAGS = new Set([".US", ".RTH"]);
  // London (.L/.IL) is two different things on eToro, told apart by name:
  //   • GDRs ("… GDR")  → USD, and Yahoo lists them on the International board
  //     → suffix .IL (Samsung SMSN.IL, Kazatomprom KAP.IL).
  //   • ordinary UK shares → LSE quotes them in PENCE, so eToro's avg-open-rate
  //     is GBX (the club divides GBX by 100 → GBP). RR.L, WIZZ.L.
  const LONDON_SUFFIX = new Set([".L", ".IL"]);

  // "DELL 24/5" / "BRK.B" / "ASML.NV" / "01211.HK" → normalized Yahoo ticker +
  // trading currency. `name` (instrument description) disambiguates GDRs.
  // Returns { ticker, currency, pence, unknown }.
  function resolveTicker(raw, name) {
    let s = String(raw || "").trim().split(/\s+/)[0].toUpperCase().replace(/^\$/, "");
    let dot = s.lastIndexOf(".");
    // eToro US venue tags (.US, .RTH) → bare US ticker.
    if (dot >= 0 && US_VENUE_TAGS.has(s.slice(dot))) {
      s = s.slice(0, dot);
      dot = s.lastIndexOf(".");
    }
    const suffix = dot >= 0 ? s.slice(dot) : "";
    const stem = dot >= 0 ? s.slice(0, dot) : s;

    if (!suffix) return { ticker: s, currency: "USD" };
    // US class share (BRK.B, BF.B): a single trailing letter, not an exchange.
    if (/^\.[A-Z]$/.test(suffix) && !EXCHANGE[suffix]) {
      return { ticker: `${stem}-${suffix.slice(1)}`, currency: "USD" };
    }
    const ex = EXCHANGE[suffix];
    if (!ex) return { ticker: s, currency: null, unknown: true };
    const [currency, ySuffix] = ex;
    // Hong Kong: Yahoo drops the leading zero (eToro 01211.HK → 1211.HK).
    const bare = ySuffix === ".HK" ? stem.replace(/^0+/, "") : stem;

    if (LONDON_SUFFIX.has(suffix)) {
      // GDR → USD on Yahoo's International board (.IL).
      if (/\bGDR\b/i.test(name || "")) return { ticker: `${bare}.IL`, currency: "USD" };
      // Ordinary UK share → GBX pence (kept as-is; the club renders it as GBP).
      return { ticker: `${bare}.L`, currency: "GBX", pence: true };
    }
    return { ticker: `${bare}${ySuffix}`, currency };
  }

  // Read a per-column cell array by automation-id (flat, index-aligned).
  const col = (name) =>
    IK.pickAll(document, [CELL(name)]).map((e) => e.innerText.trim());

  function scrapeRows() {
    const names = col("market-name");
    const full = col("market-last-name");
    const units = col("units-value");
    const avg = col("avg-open-rate");

    const warnings = new Set();
    const pence = new Set();
    const unknown = new Set();
    const positions = [];
    for (let i = 0; i < names.length; i += 1) {
      const r = resolveTicker(names[i], full[i]);
      if (!r.ticker || !/[A-Z0-9]/.test(r.ticker)) continue;
      const shares = IK.parseNumber(units[i], "dot");
      if (shares == null || shares === 0) continue;
      const avgCost = IK.parseNumber(avg[i], "dot");

      if (r.unknown) unknown.add(r.ticker);
      else if (r.pence) pence.add(r.ticker);

      positions.push({
        ticker: r.ticker,
        shares: Number(shares.toFixed(6)),
        avgCost: avgCost != null ? Number(avgCost.toFixed(4)) : null,
        currency: r.currency,
        note: (full[i] || "").trim() || null,
      });
    }
    if (pence.size) {
      warnings.add(
        `Londýnské akcie (${[...pence].join(", ")}) bereme v pencích (GBX) — ` +
        "web je přepočítá na libry. Když některá kotuje rovnou v librách, oprav měnu.",
      );
    }
    if (unknown.size) {
      warnings.add(
        `Neznámá burza u: ${[...unknown].join(", ")} — doplň měnu a případně oprav ticker v tabulce.`,
      );
    }
    return { positions, warnings: [...warnings] };
  }

  IK.registerScraper({
    broker: "etoro",
    brokerLabel: "eToro",
    portfolioUrl: "https://www.etoro.com/portfolio",
    isPortfolioPage: () => /^\/portfolio/i.test(location.pathname),

    async scrape() {
      if (/^\/people\//i.test(location.pathname)) {
        return {
          ok: false,
          error:
            "Tohle je veřejný profil (jen procenta). Otevři portfolio, které kopíruješ " +
            "(Portfolio → klikni na kopírovaného tradera), nebo své vlastní portfolio.",
        };
      }
      const ready = await IK.waitFor(
        () => IK.pickAll(document, [CELL("market-name")]).length > 0 || null,
        { timeoutMs: 10000 },
      );
      if (!ready) {
        return {
          ok: false,
          needsCalibration: true,
          error:
            "Nenašel jsem tabulku pozic. Otevři portfolio (Portfolio → detail " +
            "kopírovaného tradera nebo vlastní přehled), počkej na načtení a zkus to znovu.",
        };
      }

      const { positions, warnings } = scrapeRows();
      if (!positions.length) {
        return {
          ok: false,
          needsCalibration: true,
          error: "Tabulku vidím, ale nepřečetl jsem z ní žádné pozice — selektory potřebují kalibraci.",
        };
      }

      // Total = portfolio value in the account display currency (Kč/$…).
      let total = IK.parseMoney(IK.pickText(document, TOTAL_SELECTORS) || "", "dot");
      if (total.value == null) {
        total = IK.findLabelledValue(/hodnota|equity|value/i, "dot")
          || { value: null, currency: null };
      }
      if (total.value == null) {
        warnings.push("Celkovou hodnotu portfolia jsem na stránce nenašel — pošlu jen pozice.");
      }

      const copied = (IK.pickText(document, COPIED_NAME_SELECTORS) || "").trim();
      const brokerLabel = copied ? `eToro – ${copied}` : "eToro";

      return {
        ok: true,
        payload: {
          broker: "etoro",
          brokerLabel,
          totalValue: total.value,
          currency: total.currency || "USD",
          positions,
          warnings,
          scrapedAt: new Date().toISOString(),
        },
      };
    },
  });
})();
