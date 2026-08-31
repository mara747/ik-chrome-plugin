// George — Česká spořitelna (george.csas.cz) — the member's mutual funds
// held on a "Majetkový účet" (securities account).
//
// API-ONLY, calibrated live (2026-09) against a real account. The George SPA
// talks to same-origin /webapi with an OAuth Bearer token the app keeps in
// sessionStorage — which ISOLATED-world content scripts share with the page,
// so no credentials ever touch the extension:
//   sessionStorage "gt"    the Bearer access token (verified: equals the
//                          Authorization header the app sends)
//   web-api-key            static public header baked into the George bundle,
//                          identical for every client (verified sufficient on
//                          its own; the ggw endpoints add a second `apikey`
//                          we don't need)
//   GET /webapi/api/v3/netbanking/my/securities →
//     securitiesAccounts[]: { accountno, balance, investedAmount,
//       cz-agreementType "MUIN1", subSecAccounts[]: { titles[]: { isin,
//       title, securityType "FUND"|"SHARE"…, currency, numberOfShares,
//       marketValue, investedValue, positions[]: { lastPrice, … } } } }
// Money comes as integer value + precision: { value: 1551696, precision: 2 }
// = 15516.96. Verified against the live account to the haléř.
//
// v1 imports FUND titles only (web ADR 0010 in the club repo): Czech mutual
// funds have an ISIN but no Yahoo ticker, so each becomes a `kind: "fund"`
// position (ticker = ISIN + name + price snapshot) and the club web values it
// from the imported price. Non-FUND titles (George Invest stocks/ETF live on
// the SAME account — verified with a live pending AVGO order) are skipped
// LOUDLY with a warning + diagnostic counts, never silently.
//
// Cash: a Majetkový účet has no cash layer — orders settle against the
// member's current bank account (verified on the pending order's
// settlementAccount), so balance == Σ title market values. We still send an
// explicit cashValue = balance − Σ titles (normally 0): it switches off the
// club web's derived-cash estimate, which would otherwise read skipped
// non-FUND titles or rounding as cash. Pending orders are ignored.
"use strict";

(() => {
  // Static public API key from the George web bundle (see file header).
  // If ČS rotates it the request fails 412 KEY_MISSING → loud calibration
  // error, never silently wrong numbers.
  const WEB_API_KEY = "a4f280d7-476c-4480-ae3f-e364308f9c87";
  const SECURITIES_URL = "/webapi/api/v3/netbanking/my/securities";

  // { value: 1551696, precision: 2 } → 15516.96 (null when absent/malformed).
  function money(m) {
    if (!m || typeof m.value !== "number") return null;
    const p = typeof m.precision === "number" ? m.precision : 0;
    return m.value / Math.pow(10, p);
  }

  function readToken() {
    try { return sessionStorage.getItem("gt") || null; } catch { return null; }
  }

  async function fetchSecurities(token) {
    try {
      const resp = await fetch(SECURITIES_URL, {
        credentials: "include",
        headers: {
          authorization: "Bearer " + token,
          "web-api-key": WEB_API_KEY,
          accept: "application/json",
        },
      });
      const meta = {
        request_ok: resp.ok,
        request_status: resp.status,
        request_redirected: resp.redirected,
      };
      if (!resp.ok) return { body: null, meta };
      return { body: await resp.json(), meta };
    } catch {
      return {
        body: null,
        meta: { request_ok: false, request_status: null, request_redirected: false },
      };
    }
  }

  // Safe diagnostic detail: booleans and counts only — never ISINs, names,
  // account numbers, shares, prices or values (allowlist by construction).
  function diagnosticDetail({ hadToken, meta, body }) {
    const accounts = Array.isArray(body?.securitiesAccounts)
      ? body.securitiesAccounts : [];
    const byType = {};
    let titles = 0;
    for (const acc of accounts) {
      for (const sub of acc.subSecAccounts || []) {
        for (const t of sub.titles || []) {
          titles += 1;
          const type = typeof t.securityType === "string"
            ? t.securityType.slice(0, 30) : "unknown";
          byType[type] = (byType[type] || 0) + 1;
        }
      }
    }
    return {
      had_token: hadToken,
      request_ok: meta.request_ok,
      request_status: meta.request_status,
      request_redirected: meta.request_redirected,
      accounts_count: accounts.length,
      titles_count: titles,
      titles_by_type: byType,
    };
  }

  IK.registerScraper({
    broker: "george",
    brokerLabel: "George (Česká spořitelna)",
    portfolioUrl: "https://george.csas.cz/",
    // The API is reachable from any George route (SPA) — same rule as Fio:
    // never guess from the URL, let scrape() report the real outcome.
    isPortfolioPage: () => true,

    async scrape() {
      const token = readToken();
      if (!token) {
        return {
          ok: false,
          needsCalibration: false,
          diagnostic: IKDiagnostics.failure({
            phase: "scrape",
            errorCode: "login_required",
            brokerDetail: diagnosticDetail({
              hadToken: false,
              meta: { request_ok: false, request_status: null, request_redirected: false },
              body: null,
            }),
          }),
          error: "Vypadá to, že nejsi v George přihlášený. Přihlas se a zkus to znovu.",
        };
      }

      const { body, meta } = await fetchSecurities(token);
      if (!body) {
        const expired = meta.request_status === 401 || meta.request_status === 403;
        // 412 = KEY_MISSING: ČS rotated the web-api-key → needs recalibration.
        const keyRotated = meta.request_status === 412;
        return {
          ok: false,
          needsCalibration: keyRotated,
          diagnostic: IKDiagnostics.failure({
            phase: "scrape",
            errorCode: expired ? "login_required" : "broker_request_failed",
            brokerDetail: diagnosticDetail({ hadToken: true, meta, body: null }),
          }),
          error: expired
            ? "Přihlášení do George vypršelo — obnov stránku (F5), přihlas se a zkus to znovu."
            : keyRotated
              ? "George odmítl servisní klíč rozšíření — formát se nejspíš změnil, dej nám vědět."
              : "Nepodařilo se načíst data z George — zkus obnovit stránku (F5) a znovu.",
        };
      }

      const accounts = Array.isArray(body.securitiesAccounts)
        ? body.securitiesAccounts : null;
      if (!accounts) {
        return {
          ok: false,
          needsCalibration: true,
          diagnostic: IKDiagnostics.failure({
            phase: "scrape",
            errorCode: "layout_changed",
            brokerDetail: diagnosticDetail({ hadToken: true, meta, body }),
          }),
          error: "Odpověď George má nečekaný tvar — formát se nejspíš změnil.",
        };
      }
      if (!accounts.length) {
        return {
          ok: false,
          needsCalibration: false,
          diagnostic: IKDiagnostics.failure({
            phase: "scrape",
            errorCode: "portfolio_view_missing",
            brokerDetail: diagnosticDetail({ hadToken: true, meta, body }),
          }),
          error: "V George jsme nenašli žádný majetkový účet s cennými papíry.",
        };
      }

      const positions = [];
      const skippedTypes = {};   // securityType → count (George Invest etc.)
      const noAvg = [];
      let totalValue = 0;
      let titlesValue = 0;       // Σ market values of ALL titles (incl. skipped)
      let currency = null;
      let mixedCurrency = false;

      for (const acc of accounts) {
        const bal = money(acc.balance);
        const cur = acc.balance?.currency || null;
        if (currency === null) currency = cur;
        else if (cur && cur !== currency) mixedCurrency = true;
        if (bal != null) totalValue += bal;

        for (const sub of acc.subSecAccounts || []) {
          for (const t of sub.titles || []) {
            const mv = money(t.marketValue);
            if (mv != null) titlesValue += mv;
            if (t.securityType !== "FUND") {
              const type = typeof t.securityType === "string"
                ? t.securityType : "unknown";
              skippedTypes[type] = (skippedTypes[type] || 0) + 1;
              continue;
            }
            const shares = t.numberOfShares;
            if (!Number.isFinite(shares) || shares <= 0) continue; // sold-out fund
            const isin = typeof t.isin === "string" ? t.isin.trim().toUpperCase() : "";
            if (!isin) continue;
            const invested = money(t.investedValue);
            // George gives no explicit average — derive it from the snapshot
            // (blended across all buys, matches the app's Zisk/Ztráta).
            const avgCost = invested != null && invested > 0
              ? invested / shares : null;
            if (avgCost == null) noAvg.push(t.title || isin);
            // NAV snapshot for the club web to value the fund with (web ADR
            // 0010). Prefer the position-level lastPrice; fall back to
            // marketValue / shares (same number, fewer decimals).
            const lastPrice = money(t.positions?.[0]?.lastPrice);
            const price = lastPrice != null && lastPrice > 0
              ? lastPrice
              : mv != null && mv > 0 ? mv / shares : null;
            positions.push({
              kind: "fund",
              ticker: isin,
              name: t.title || t.fullTitle || null,
              shares,
              avgCost,
              price,
              currency: t.currency || cur || null,
              note: null,
            });
          }
        }
      }

      if (mixedCurrency) {
        // Never sum money across currencies — degrade to positions-only.
        totalValue = null;
      }

      const warnings = [];
      const skippedCount = Object.values(skippedTypes).reduce((a, b) => a + b, 0);
      if (skippedCount) {
        warnings.push(
          `Na účtu ${skippedCount === 1 ? "je" : "jsou"} i ${skippedCount} `
          + "burzovní tituly (George Invest) — ty zatím neumíme, naimportovaly "
          + "se jen fondy. Dej nám vědět a doplníme je.",
        );
      }
      if (!positions.length) {
        warnings.push("Na majetkovém účtu nejsou žádné podílové fondy — "
          + "importuje se jen celková hodnota.");
      }
      if (noAvg.length) {
        warnings.push(
          `U fondů ${noAvg.join(", ")} se nákupní cena nedala odvodit — `
          + "doplň ji v tabulce ručně.",
        );
      }
      if (mixedCurrency) {
        warnings.push("Účty jsou ve více měnách — celková hodnota se "
          + "neimportuje, jen pozice.");
      }

      // Explicit cash (normally 0): balance minus ALL titles, so skipped
      // non-FUND titles never masquerade as cash on the club web. Clamp
      // sub-haléř rounding noise.
      let cashValue = null;
      if (totalValue != null) {
        const cash = totalValue - titlesValue;
        cashValue = cash > 0.005 ? Math.round(cash * 100) / 100 : 0;
      }

      return {
        ok: true,
        payload: {
          broker: "george",
          brokerLabel: "George (Česká spořitelna)",
          totalValue,
          cashValue,
          currency: currency || "CZK",
          positions,
          warnings,
          scrapedAt: new Date().toISOString(),
        },
      };
    },
  });
})();
