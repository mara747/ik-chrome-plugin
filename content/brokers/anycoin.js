// Anycoin (www.anycoin.cz) — the member's crypto balances AND portfolio value.
//
// API-ONLY, calibrated live (2026-07): the SPA talks to same-origin /api/* with
// a JWT kept in localStorage — which content scripts share with the page, so no
// credentials ever touch the extension:
//   localStorage "token_anycoin"     the Bearer token (plain JWT string)
//   GET /api/user/accounts           → accounts[]: { currency, amount,
//                                      stakedAmount, blockedAmount,
//                                      pendingWithdrawalsAmount, is_fiat,
//                                      currency_precision, … } — one row per
//                                      supported currency, most of them zero
//   GET /api/rates (public, no auth) → data[]: { cryptoCurrency, fiatCurrency,
//                                      isFiatToCrypto, value, currency_name, … }
// Cookies alone are NOT enough (both user endpoints answer 401), and the SPA
// also sends x-portal/x-lang — replicated here. x-version is deliberately NOT
// sent: it pins a frontend build and would rot.
//
// VALUE: Anycoin has no "portfolio total" endpoint — the page computes it from
// the rates. Rates come in both directions: fiatCurrency=CZK with
// isFiatToCrypto=true is the BUY rate (what the member pays, spread included),
// false is the SELL rate (what they'd get). We value the portfolio at the SELL
// rate, so the total can read a few percent below what Anycoin shows — hence
// the warning. Fiat balances (is_fiat) fold into the total only, never into
// positions (same convention as Fio's cash rows); EUR is converted through the
// CZK/EUR rate pair of the same coin.
//
// TICKERS: Yahoo has no crypto/CZK pairs (BTC-CZK → 404), so positions go out
// as USD pairs. Yahoo hands the bare ticker to whichever coin claimed it first
// and gives later namesakes a numeric suffix, so the mapping CANNOT be derived
// — SUI-USD is "Salmonation", XDG-USD is "Decentral Games", POL-USD is "Proof
// Of Liquidity". Every symbol below was verified 2026-07 against Yahoo BY COIN
// NAME (Anycoin currency_name vs Yahoo shortName): VERIFIED = the bare
// SYM-USD pair is the right coin, ALIAS = it is not. Anything else degrades to
// SYM-USD plus a check-it warning — never a silent swap.
//
// NO PURCHASE PRICES: the API only carries quantities, so avgCost is always
// null and the member fills the column in on the club web.
"use strict";

(() => {
  const TOKEN_KEY = "token_anycoin";
  const JWT_RE = /^ey[\w-]+\.[\w-]+\./;

  // Anycoin symbol === Yahoo symbol (verified by coin name, 2026-07). Renames
  // are in here too when both sides mean the same coin: FET = Artificial
  // Superintelligence Alliance, EIGEN = EigenCloud, HDX = Hydration,
  // RAD = Radworks, CLV = Clover Finance, SYRUP = Maple Finance.
  const VERIFIED = new Set([
    "1INCH", "AAVE", "ACA", "ACH", "ADA", "AEVO", "AGLD", "AI16Z", "AIOZ",
    "AIXBT", "AKT", "ALCX", "ALGO", "ALICE", "ALPHA", "ANKR", "ANLOG", "ANON",
    "ANT", "APE", "API3", "ARB", "ARKM", "ARPA", "ASTR", "ATLAS", "ATOM",
    "AUCTION", "AUDIO", "AVAAI", "AVAX", "AXS", "B3", "BADGER", "BAL", "BANANAS31",
    "BAND", "BAT", "BCH", "BEAM", "BICO", "BIGTIME", "BLUR", "BLZ", "BMT",
    "BNB", "BNT", "BOBA", "BOND", "BONK", "BSX", "BTC", "BTT", "C98",
    "CAKE", "CELR", "CFG", "CHEEMS", "CHEX", "CHR", "CHZ", "CLV", "COMP",
    "COTI", "CPOOL", "CQT", "CRO", "CRV", "CSM", "CTSI", "CVC", "CVX",
    "CYBER", "DAI", "DASH", "DENT", "DOT", "DYDX", "EGLD", "EIGEN", "ELIZAOS",
    "ENA", "ENJ", "ENS", "ENSO", "EOS", "ESX", "ETC", "ETH", "ETHFI",
    "ETHW", "EUL", "EURC", "EURQ", "EURR", "EWT", "FARM", "FARTCOIN", "FET",
    "FHE", "FIDA", "FIL", "FIS", "FLOKI", "FLOW", "FLR", "FLUX", "FORTH",
    "FWOG", "FXS", "GALA", "GARI", "GHST", "GLMR", "GNO", "GOMINING", "GRASS",
    "GRIFFAIN", "GUN", "H", "HDX", "HNT", "ICP", "ICX", "IDEX", "INJ",
    "INTR", "JAILSTOOL", "JASMY", "JTO", "JUNO", "JUP", "KAITO", "KAR", "KAS",
    "KAVA", "KEEP", "KERNEL", "KET", "KEY", "KILT", "KIN", "KINT", "KMNO",
    "KNC", "KP3R", "KSM", "KTA", "L3", "LCX", "LDO", "LINK", "LMWR",
    "LOCKIN", "LPT", "LQTY", "LRC", "LSETH", "LSK", "LTC", "LUNA2", "MANA",
    "MANTRA", "MC", "MERL", "MICHI", "MINA", "MIRROR", "MLN", "MNGO", "MOG",
    "MOODENG", "MORPHO", "MOVR", "MSOL", "MUBARAK", "MV", "MXC", "NANO", "NEAR",
    "NEIRO", "NMR", "NOBODY", "NODL", "NOS", "NOT", "OCEAN", "ODOS", "OGN",
    "OM", "OMG", "OMNI", "ONDO", "OOB", "OP", "ORCA", "OXT", "OXY",
    "PAXG", "PDA", "PENDLE", "PENGU", "PEPE", "PERP", "PHA", "PLUME", "PNUT",
    "POLS", "POND", "PONKE", "POPCAT", "PORTAL", "POWR", "PRCL", "PROVE", "PSTAKE",
    "PUFFER", "PYTH", "QNT", "QTUM", "RAD", "RARI", "RAY", "RBC", "RED",
    "REN", "RENDER", "REP", "REPV2", "REQ", "REZ", "RLC", "ROOK", "RPL",
    "RSR", "RUNE", "SAFE", "SAMO", "SAND", "SAPIEN", "SBR", "SC", "SCRT",
    "SDN", "SHIB", "SHX", "SIGMA", "SKY", "SNX", "SOL", "SPELL", "SPICE",
    "SRM", "STEP", "STORJ", "SUNDOG", "SUSHI", "SWARMS", "SWELL", "SYRUP", "T",
    "TBTC", "TLM", "TNSR", "TOKE", "TOKEN", "TOSHI", "TRAC", "TRIBE", "TRX",
    "TURBO", "TVK", "UFD", "UMA", "UNFI", "USDC", "USDQ", "USDT", "USELESS",
    "UST", "USUAL", "VANRY", "VINE", "VIRTUAL", "VSN", "W", "WAVES", "WBTC",
    "WELL", "WIF", "WLD", "WOO", "XLM", "XMR", "XNY", "XRP", "XRT",
    "XTZ", "YFI", "YGG", "ZEC", "ZEREBRO", "ZETA", "ZEUS", "ZEX", "ZORA",
    "ZRX",
  ]);

  // Anycoin symbol → Yahoo symbol, where the bare pair is a DIFFERENT coin.
  // Yahoo keeps the plain ticker for whoever claimed it first and suffixes the
  // namesakes, so e.g. Anycoin's SUI (Sui) is Yahoo's SUI20947-USD while
  // SUI-USD is "Salmonation", and XDG (Anycoin's ticker for Dogecoin) collides
  // with "Decentral Games Governance".
  const ALIAS = {
    A: "A36462-USD", ACT: "ACT33566-USD", ACX: "ACX22620-USD",
    AERO: "AERO29270-USD", AIR: "AIR12209-USD", ALT: "ALT29073-USD",
    APT: "APT21794-USD", APU: "APU30008-USD", ATH: "ATH30083-USD",
    BIO: "BIO34812-USD", BIT: "BIT11221-USD", BNC: "BNC8705-USD",
    COOKIE: "COOKIE31838-USD", COW: "COW19269-USD", CXT: "CXT32526-USD",
    DBR: "DBR31528-USD", DEEP: "DEEP33391-USD", DMC: "DMC36920-USD",
    DOGS: "DOGS32698-USD", DRIFT: "DRIFT31278-USD", DRV: "DRV35014-USD",
    GFI: "GFI13967-USD", GIGA: "GIGA30063-USD", GMT: "GMT18069-USD",
    GMX: "GMX11857-USD", GOAT: "GOAT33440-USD", GRT: "GRT6719-USD",
    GST: "GST16352-USD", GTC: "GTC10052-USD", HFT: "HFT22461-USD",
    HONEY: "HONEY22850-USD", IMX: "IMX10603-USD", LAYER: "LAYER35429-USD",
    LUNA: "LUNC-USD", M: "M35491-USD", MASK: "MASK8536-USD",
    ME: "ME32197-USD", MELANIA: "MELANIA35347-USD", MEME: "MEME28301-USD",
    MEW: "MEW30126-USD", MNT: "MNT27075-USD", MOVE: "MOVE32452-USD",
    MULTI: "MULTI17050-USD", NPC: "NPC27960-USD", OPEN: "OPEN37456-USD",
    POL: "POL28321-USD", POLIS: "POLIS11213-USD", PRIME: "PRIME23711-USD",
    PUMP: "PUMP36507-USD", RARE: "RARE11294-USD", SGB: "SGB12186-USD",
    SONIC: "SONIC35051-USD", SPX: "SPX28081-USD", STG: "STG18934-USD",
    STX: "STX4847-USD", SUI: "SUI20947-USD", SUPER: "SUPER8290-USD",
    SYN: "SYN12147-USD", TON: "TON11419-USD", TRU: "TRU7725-USD",
    TRUMP: "TRUMP35336-USD", UNI: "UNI7083-USD", USDR: "USDR35372-USD",
    VELODROME: "VELO20435-USD", VVV: "VVV35509-USD", WAL: "WAL36119-USD",
    XCN: "XCN18679-USD", XDG: "DOGE-USD", ZRO: "ZRO26997-USD",
  };

  function readToken() {
    let t = null;
    try { t = localStorage.getItem(TOKEN_KEY); } catch { /* not logged in */ }
    return t && JWT_RE.test(t) ? t : null;
  }

  // { ticker, calibrated } — `calibrated` false means the member has to check
  // the row (Yahoo may list a namesake under the same bare ticker).
  function cryptoToYahoo(sym) {
    const s = IK.yahooSymbol(sym);
    if (!s) return { ticker: null, calibrated: false };
    if (ALIAS[s]) return { ticker: ALIAS[s], calibrated: true };
    return { ticker: `${s}-USD`, calibrated: VERIFIED.has(s) };
  }

  async function apiFetch(path, token) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const resp = await fetch(path, {
        signal: ctrl.signal,
        credentials: "include",
        headers: {
          accept: "application/json",
          "x-portal": "anycoin",
          "x-lang": "cs_CZ",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!resp.ok) return { status: resp.status, data: null };
      return { status: resp.status, data: await resp.json() };
    } catch {
      return { status: 0, data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  // rates → { sellCzk, sellEur, names } keyed by crypto symbol. Only the SELL
  // direction (isFiatToCrypto false) is kept; `value` is fiat per 1 coin.
  function indexRates(list) {
    const sellCzk = new Map();
    const sellEur = new Map();
    const names = new Map();
    for (const r of Array.isArray(list) ? list : []) {
      const sym = String(r && r.cryptoCurrency || "").toUpperCase();
      if (!sym) continue;
      const name = String(r.currency_name || "").trim();
      if (name && !names.has(sym)) names.set(sym, name);
      const value = Number(r.value);
      if (!Number.isFinite(value) || value <= 0) continue;
      if (r.isFiatToCrypto) continue;            // buy side — carries the spread
      if (r.fiatCurrency === "CZK") { if (!sellCzk.has(sym)) sellCzk.set(sym, value); }
      else if (r.fiatCurrency === "EUR") { if (!sellEur.has(sym)) sellEur.set(sym, value); }
    }
    return { sellCzk, sellEur, names };
  }

  // CZK per 1 EUR, derived from a coin quoted in both — Anycoin has no fiat
  // pair endpoint. BTC first (deepest market), else any coin with both rates.
  function eurToCzk({ sellCzk, sellEur }) {
    const from = (sym) => {
      const czk = sellCzk.get(sym);
      const eur = sellEur.get(sym);
      return czk > 0 && eur > 0 ? czk / eur : null;
    };
    const btc = from("BTC");
    if (btc) return btc;
    for (const sym of sellCzk.keys()) {
      const f = from(sym);
      if (f) return f;
    }
    return null;
  }

  const czk = (n) => `${Math.round(n).toLocaleString("cs-CZ")} Kč`;

  IK.registerScraper({
    broker: "anycoin",
    brokerLabel: "Anycoin",
    portfolioUrl: "https://www.anycoin.cz/balance",
    // The API is same-origin, so scraping works from any Anycoin page — the
    // token is what decides whether we can read anything at all.
    isPortfolioPage: () => !!readToken(),

    async scrape() {
      const token = readToken();
      if (!token) {
        return {
          ok: false,
          error:
            "Vypadá to, že nejsi na Anycoinu přihlášený (v prohlížeči chybí " +
            "session). Přihlas se na www.anycoin.cz a zkus to znovu.",
        };
      }

      const acc = await apiFetch("/api/user/accounts", token);
      if (acc.status === 401 || acc.status === 403) {
        return {
          ok: false,
          error:
            "Přihlášení na Anycoinu vypršelo — obnov stránku (F5), případně se " +
            "znovu přihlas, a zkus to znovu.",
        };
      }
      const accounts = acc.data && acc.data.accounts;
      if (!Array.isArray(accounts)) {
        return {
          ok: false,
          needsCalibration: true,
          error:
            "Anycoin API nevrátilo zůstatky (/api/user/accounts) — formát se " +
            "nejspíš změnil. Napiš nám prosím, ať to doladíme.",
        };
      }

      const rates = await apiFetch("/api/rates", token);
      const rateList = rates.data && rates.data.data;
      if (!Array.isArray(rateList) || !rateList.length) {
        return {
          ok: false,
          needsCalibration: rates.status === 200,
          error:
            "Kurzy z Anycoinu se nepodařilo načíst (/api/rates) — zkus to za " +
            "chvíli znovu.",
        };
      }
      const { sellCzk, sellEur, names } = indexRates(rateList);

      const positions = [];
      const uncalibrated = [];
      const noRate = [];
      const staked = [];
      const blocked = [];
      let totalValue = 0;
      let cashValue = 0;
      let missingFiat = false;

      for (const a of accounts) {
        const sym = String(a && a.currency || "").toUpperCase();
        if (!sym) continue;
        const amount = Number(a.amount) || 0;
        const stakedAmount = Number(a.stakedAmount) || 0;
        const shares = amount + stakedAmount;
        if (shares <= 0) continue;

        // Fiat wallets have no ticker — they only lift the total (Fio does the
        // same with its CZK cash rows).
        if (a.is_fiat) {
          if (sym === "CZK") cashValue += shares;
          else if (sym === "EUR") {
            const f = eurToCzk({ sellCzk, sellEur });
            if (f) cashValue += shares * f;
            else missingFiat = true;
          } else missingFiat = true;
          continue;
        }

        const { ticker, calibrated } = cryptoToYahoo(sym);
        if (!ticker) continue;
        if (!calibrated) {
          const name = names.get(sym);
          uncalibrated.push(name ? `${ticker} (${name})` : ticker);
        }
        if (stakedAmount > 0) staked.push(sym);
        if (Number(a.blockedAmount) > 0) blocked.push(sym);

        const rate = sellCzk.get(sym);
        if (rate > 0) totalValue += shares * rate;
        else noRate.push(sym);

        positions.push({
          ticker,
          shares,
          avgCost: null,     // Anycoin API nevrací nákupní ceny
          currency: null,
          note: names.get(sym) || null,
        });
      }

      totalValue += cashValue;

      const warnings = [];
      if (!positions.length) {
        warnings.push(
          "Na účtu nevidím žádné kryptoměny — importuje se jen celková hodnota.",
        );
      } else {
        warnings.push(
          "Celkovou hodnotu počítám prodejními kurzy Anycoinu (co bys dostal " +
          "při prodeji) — Anycoin může kvůli spreadu ukazovat o jednotky " +
          "procent víc.",
        );
        warnings.push(
          "Anycoin nevrací průměrné nákupní ceny — pozice se importují bez " +
          "nich, v tabulce je můžeš doplnit ručně.",
        );
      }
      if (uncalibrated.length) {
        warnings.push(
          "Tickery " + uncalibrated.join(", ") + " jsem odvodil 1:1 — Yahoo " +
          "vede pod stejnou zkratkou i jiné mince, zkontroluj je v tabulce.",
        );
      }
      if (noRate.length) {
        warnings.push(
          "Pro " + noRate.join(", ") + " Anycoin nevrací kurz v korunách — do " +
          "celkové hodnoty se nezapočítaly.",
        );
      }
      if (staked.length) {
        warnings.push(
          "Do množství jsem započítal i mince ve stakingu (" +
          staked.join(", ") + ").",
        );
      }
      if (blocked.length) {
        warnings.push(
          "Část zůstatku je blokovaná (" + blocked.join(", ") + ") — zkontroluj " +
          "u těchto pozic množství.",
        );
      }
      if (cashValue > 0) {
        warnings.push(
          `Hotovost ≈ ${czk(cashValue)} je součástí celkové hodnoty, ale ne pozic.`,
        );
      }
      if (missingFiat) {
        warnings.push(
          "Hotovost v jiné měně než CZK/EUR jsem do celkové hodnoty nezapočítal.",
        );
      }

      return {
        ok: true,
        payload: {
          broker: "anycoin",
          brokerLabel: "Anycoin",
          totalValue,
          currency: "CZK",
          positions,
          warnings,
          scrapedAt: new Date().toISOString(),
        },
      };
    },
  });
})();
