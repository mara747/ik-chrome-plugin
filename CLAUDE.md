# CLAUDE.md

Project notes for Claude Code. Keep short and accurate.

## What this is

Chrome extension (Manifest V3, vanilla JS, **no build step**) for Investiční
klub members: scrapes the member's OWN logged-in broker portfolio page (eToro,
IBKR, Trading 212, Portu, Fio, Anycoin, XTB) and imports value + positions into
the currently open portfolio on the club web (`../investicni-klub`, prod
https://investicni-klub.lovable.app). README.md has the member-facing docs and
the add-a-broker guide.

**PUBLIC repo** (`mara747/ik-chrome-plugin`, git submodule of the `~/Elbl`
monorepo since 2026-07-13): members debug their own broker quirks and send
PRs — README has the contributor section. Never commit anything secret or any
member's portfolio data here; push = publish.

Czech in user-facing strings (popup, error messages), English code/comments —
same convention as the sibling projects.

## How it works (message flow)

1. Broker scraper content script registers via `IK.registerScraper` in
   `lib/normalize.js`; popup drives it: `IK_DETECT` → `IK_SCRAPE`. Most brokers
   use one ISOLATED-world script. Trading 212 and XTB deliberately split their
   page-owned data source into a MAIN-world script and keep registration in a
   separate ISOLATED-world script, joined by a one-time nonce-bound same-origin
   `window.postMessage` bridge.
2. Popup asks the club tab for the member's portfolio list (IK_PING answered
   by the `_app.tsx` layout's ExtensionBridge with `{ portfolioId,
   portfolioName, portfolios }`), the member picks the TARGET portfolio, and
   the popup stores `{ payload, targetPortfolioId }` in `chrome.storage.local`
   (`ik_pending_import`) and steers the club tab to `/portfolio/<target>`. If
   no usable club tab exists, the popup boots one in the background and polls.
   There is NO background service worker.
3. `content/club.js` posts `IK_PORTFOLIO_IMPORT` (+ targetPortfolioId) into
   the page (retry every 800 ms, ≤2 min, drop if older than 10 min) until the
   page acks with `IK_PORTFOLIO_IMPORT_ACK`, then clears storage.
4. Receiving side lives in the club web:
   `src/routes/_app.portfolio.$portfolioId.tsx` — it ONLY accepts (acks) an
   import whose targetPortfolioId matches the open portfolio, so a pending
   payload can never land in whatever portfolio the member opens next.
   Positions → pre-filled grid editor (member reviews + saves via existing
   flow), empty positions → value-only confirm dialog; both stamp
   `member_portfolios.broker_*` columns (migration in
   `../value-invest/docs/supabase-schema.sql`).

Payload contract: `{ broker, brokerLabel, totalValue, cashValue?, currency,
positions: [{ticker, shares, avgCost, currency, note}], warnings[],
scrapedAt }` — tickers already normalized to Yahoo format (`IK.yahooSymbol`).
`cashValue` (optional, in payload currency, since 0.1.7 / ADR 0005 in the
monorepo) is the broker-reported cash inside totalValue: IBKR
`/summary.totalcashvalue` (can be negative on margin), Portu CashComposition
(fallback total − Σ MarketPriceTotalRef), Anycoin fiat wallets in CZK (0 =
really no fiat), Fio cash rows' Majetek, eToro total − Σ equity cells, and XTB
free funds plus a corroborated `stockLock` reservation for recognized pending
BUY orders. Trading 212 uses `investPot + spendingPot + pieCash`, plus
`blockedForStocks` only for verified, fully unfilled pending BUY orders.
Pending SELL orders do not affect cash and are ignored; an ambiguous pending
order or failed balance identity produces null.
null/absent = broker doesn't say → the web keeps deriving it from
`broker_value` − positions.

Some brokers carry their OWN symbol variant for an instrument — a numbered
ticker kept after the plain symbol was recycled to another company, or a
different listing line of the same fund — while Yahoo (and the club web, which
prices by Yahoo symbols) uses another one. No general suffix/venue rule can
derive those, so after a successful broker adapter has completed normal
venue/symbol mapping, `IK.registerScraper` applies the exact shared
`BROKER_TICKER_OVERRIDES` table from the top of `lib/normalize.js` (full
rationale in the comment above it). Its key is broker ID → already-normalized
ticker → native position currency (the currency guards against remapping an
innocent same-named ticker on another venue); current aliases are XTB
`DOC1/USD → DOC`, XTB `ISLN.UK/USD → ISLN.L`, T212
`WEBN1.DE/EUR → WEBN.DE`, and Portu
`SX5EEX.DE/EUR → EUEA.AS`. Do not put these non-derivable aliases in
individual scrapers; every new entry needs a test. If an alias would collide
with another final `(ticker, currency)` row, do not merge or reprice positions:
keep the original ticker and append the Czech collision audit note.

## Key invariants & gotchas

- **Selectors are candidate LISTS** and column mapping is header-text-driven —
  a broker UI change should degrade to `{ok:false, needsCalibration:true}`,
  never to silently wrong numbers.
- **Empty `positions` must NOT open the grid editor** on the web (grid save is
  replace-all → would wipe the portfolio). The web handles that; scrapers that
  can't read positions return `positions: []` + warning (Portu falls back to
  this when /portfolio/composition fails).
- Number parsing is locale-explicit: eToro/IBKR pass `"dot"`, Portu `"comma"`
  (`IK.parseNumber`). Don't rely on `"auto"` where the locale is known.
- Calibration status: **Portu and IBKR are calibrated live (2026-07) and are
  API-ONLY** — details in each scraper's header comment. Portu: same-origin
  `/api/v1/dashboard` with Bearer token from the SPA's localStorage
  (`portu_session`; content scripts share page localStorage), client GUID in
  `portu_client`, portfolio picked via `?id=` on /souhrn/investice/detail;
  `productIds` is the global "Portu Invest" catalog GUID baked into their
  bundle. The dashboard is queried for ALL THREE `taxTreatment` values
  (0 Default / 1 DIP "Důchodový účet" / 2 Pension SK — enum from the Portu
  bundle) and merged by portfolio Id: DIP portfolios are the same client and
  the same product GUID, just a different treatment (member report 2026-07,
  "Nepoznám, které portfolio importovat" on a DIP detail). Child ("dětský")
  and corporate accounts are a DIFFERENT client (impersonation) and remain
  unsupported — an `?id=` unknown to all dashboards falls back to
  composition-only import (total = positions + cash, see
  `cashFromComposition`), else the error asks the member to report. Portu
  POSITIONS come from POST `/api/v1/portfolio/composition`
  ({clientId, portfolioId}) → PositionComposition.Instruments: Bloomberg
  "TICKER VENUE" symbols mapped via BBG_SUFFIX (CSPX LN → CSPX.L), Shares,
  PurchasePrice (avg in OriginalCurrency). Cash is only in the total → the
  scraper warns about the difference.
- eToro is calibrated live (2026-07, DOM) against the copied-trader breakdown
  page `/portfolio/breakdown/<user>` (and own /portfolio/overview, same table).
  Cells via `portfolio-overview-table-body-cell-*` automation-ids (flat,
  index-aligned): market-name, units-value, avg-open-rate, market-last-name;
  total from `portfolio-breakdown-summary-equity`. `resolveTicker(sym, name)`
  handles eToro venue quirks (.US/.RTH US tags, BRK.B→BRK-B class shares,
  .NV→.AS, 01211.HK→1211.HK) and infers currency from the exchange (EXCHANGE
  map). Per-row currency is NOT exposed, so it's inferred from the exchange;
  London (.L) is split by name: GDRs (`/GDR/i`) → USD on Yahoo's International
  board `.IL` (SMSN.IL, KAP.IL), ordinary UK shares → GBX pence (RR.L, WIZZ.L;
  eToro/LSE quote UK shares in pence, the club divides GBX by 100 → GBP).
  Calibrated against a correct manual portfolio (v0.1.1). A soft warning still
  lists the GBX rows in case a `.L` instrument quotes directly in GBP.
  Fio e-Broker is DOM-calibrated live (2026-07): server-rendered CGI.
  PRIMARY source is Portfolio/Vývoj (`e-portfolio.cgi?menu=2`,
  `#portfolio_vyvoj_table`) — the only view with purchase data — fetched
  same-origin+credentials from whatever e-Broker page the member is on
  (the bare URL serves the LAST-VISITED sub-tab, so never rely on it).
  Grouped headers repeat (Akcie/Kurz/Majetek twice): first occurrence =
  period start, last = period end; shares/value = end state, closed
  positions (end 0) skipped. avgCost = Nákup / Kusy ONLY when the period
  covers the whole position (start 0, no sells, Kusy == end shares) AND the
  row is CZK/BCPP (Nákup currency verified only there) — else null +
  warning. Fallback: Portfolio/Stav `#portfolio_table` (no avg cost). Both:
  header-TEXT-driven column maps, `Součet (CZK)` row = total, cash rows
  (bare "CZK" on Vývoj, "CZK(OU)"/"CZK(na cestě)" on Stav) fold into the
  total only. BCPP symbols `BAA*` → strip + `.PR` (BAAKOMB → KOMB.PR, CZK);
  plain US tickers pass through; other venues (SRN/PLN/RMS) uncalibrated →
  1:1 + warning. Czech number locale → parseNumber "comma".
  IBKR is API-ONLY (user's call: "scraping webu se rozbije spíš než API"):
  scrape() reads the same-origin authenticated Client Portal API
  (`/v1/api/portfolio/accounts` → `…/positions/{page}` → `…/summary`, plus
  `/trsrv/secdef` to backfill listingExchange) → Yahoo suffix via
  EXCHANGE_SUFFIX (port of core/ibkr.py). Non-STK rows (options/futures/FX
  cash) are skipped with a warning. There is deliberately NO DOM-table
  fallback — each failing endpoint returns a Czech, actionable error
  (expired session → F5). Only DOM touchpoints: account id from the header
  (multi-account pick) and the `.ptf-positions[nlv]` Net Liq backup.
- Trading 212 is API-ONLY: a content script on `app.trading212.com` fetches
  the member's existing session at `live.services.trading212.com` with
  `credentials: "include"`: `GET /rest/v1/accounts`, then
  `POST /rest/v1/equity/multi-accounts/summary?targetCurrency=<account currency>`,
  then `POST /instrumentarium/v2/instruments/find`. If `/find` omits metadata
  for an open code, fetch `GET /instrumentarium/v2/instruments/0` and retain
  only the missing open-position instruments from that catalog. Position data
  must use `quantity`, **`averagePrice`** (never `averagePriceConverted`), and
  metadata `currency`; invalid or incomplete responses fail closed. Cash is
  `investPot + spendingPot + pieCash`. A zero/absent `blockedForStocks` with no
  ordinary or Pie orders is a normal state. Add a positive `blockedForStocks`
  only when ordinary pending orders are all `NEW`, entirely unfilled, contain
  at least one BUY, and have no unverified Pie `valueOrders`; pending SELL does
  not change cash or positions. A malformed, non-`NEW`, or partially filled
  ordinary order, any Pie `valueOrder`, an invalid/negative reservation, or a
  positive reservation without a verified BUY produces `cashValue: null` with
  the Czech warning. Instrument failures include a short, sanitized public
  ticker/code, currency, or venue diagnostic, never portfolio values or
  account/order identifiers. Never inspect,
  persist, log, or commit cookies, response bodies, account IDs, or member
  portfolio values. There is no DOM or CSV fallback.
- XTB is STREAM-ONLY and calibrated live (2026-08) against XStation 5. It must
  remain two files and two execution worlds. `xtb-stream.js` runs in MAIN at
  `document_start`, transparently wraps the page's Worker constructor, and
  passively reduces only known completed account, catalog, trade, profit, and
  balance response families emitted by XStation-created Workers.
  `xtb.js` runs in ISOLATED at `document_idle`, registers through
  `IK.registerScraper`, and requests one normalized result through the
  nonce-bound bridge. Never merge these files: MAIN is required to observe
  page-created Workers, while ISOLATED is required for extension registration.
  Never create a Worker/WebSocket/HTTP request or XTB command, switch/enumerate
  accounts, persist/log raw protocol data, or add DOM/logo/tooltip/API fallback.
  Import only one coherent active-account generation: account identity must
  agree across records, open trade position IDs must exactly match profit IDs,
  symbols must match the calibrated catalog/venue map, and total equity must be
  present. Ambiguous free funds are omitted with a warning; mixed, incomplete,
  or unknown data fail closed with an actionable Czech error.
  XStation's normal catalog and trade records do not expose native instrument
  currency. Infer it from the verified venue map only. Ambiguous `.UK` is not a
  general venue rule: an exact XTB symbol may receive a manually verified
  currency in `xtb-stream.js`, after which `xtb.js` requires the strict shared
  broker+ticker+currency override from `lib/normalize.js` before allowing the
  payload through. Keep both stages covered by one integration regression.

## Validation

No build step. Run `node --check` for every changed JS file and `node --test`
for the full regression suite. Then load unpacked in Chrome
(`chrome://extensions` → Developer mode) and exercise the changed broker
against the club web on localhost (`bun run dev`/`npm run dev` in
`../investicni-klub`) — its content script matches `http://localhost/*` too.
For MAIN/ISOLATED pairs, reload the extension and F5 the broker tab after any
manifest or filename change so the `document_start` observer is installed.
