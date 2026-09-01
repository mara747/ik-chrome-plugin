// George — Česká spořitelna (george.csas.cz) — the member's mutual funds and
// shares held on a "Majetkový účet" (securities account).
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
// FUND titles (web ADR 0010 in the club repo): Czech mutual funds have an ISIN
// but no Yahoo ticker, so each becomes a `kind: "fund"` position (ticker =
// ISIN + name + price snapshot) and the club web values it from the imported
// price.
//
// SHARE titles (George Invest — they live on the SAME securities account,
// verified with a live pending AVGO order; ADR 0010 addendum 2026-09-01) become
// ORDINARY ticker positions with `ticker = ISIN`: George exposes no exchange
// symbol at all (search, quotes and orders all run on ISIN + MIC + currency),
// so the translation to a Yahoo quote is left to the club web's existing ticker
// alias table. The plugin never guesses a symbol and never calls a third party.
// The derived average (investedValue / shares) is only honest when the title
// currency equals the account currency — George reports invested amounts in the
// ACCOUNT currency — so a foreign-currency share is imported without an average
// (member fills it in) and its money FIELD NAMES + currencies go to calibration.
//
// Every other securityType (ETF, bonds, certificates — exact strings unknown)
// is skipped LOUDLY: a warning naming the titles plus their identity in the
// calibration report, never a silent drop.
//
// Cash: a Majetkový účet has no cash layer — orders settle against the
// member's current bank account (verified on the pending order's
// settlementAccount), so balance == Σ title market values. We still send an
// explicit cashValue = balance − Σ titles (normally 0): it switches off the
// club web's derived-cash estimate, which would otherwise read skipped
// titles or rounding as cash. Pending orders are ignored.
"use strict";

(() => {
  // Static public API key from the George web bundle (see file header).
  // If ČS rotates it the request fails 412 KEY_MISSING → loud calibration
  // error, never silently wrong numbers.
  const WEB_API_KEY = "a4f280d7-476c-4480-ae3f-e364308f9c87";
  const SECURITIES_URL = "/webapi/api/v3/netbanking/my/securities";
  // The club server caps broker_detail at 8192 B — calibration lists are cut
  // here so a member with an exotic account never gets a rejected report.
  const MAX_CALIBRATION_ITEMS = 20;
  const MAX_TEXT = 80;

  // { value: 1551696, precision: 2 } → 15516.96 (null when absent/malformed).
  function money(m) {
    if (!m || typeof m.value !== "number") return null;
    const p = typeof m.precision === "number" ? m.precision : 0;
    return m.value / Math.pow(10, p);
  }

  // Every string that may end up in a report or a note is trimmed, length
  // capped and never coerced from a non-string (a changed API shape must not
  // smuggle an object into the payload).
  function safeText(value, max = MAX_TEXT) {
    if (typeof value !== "string") return null;
    const s = value.trim();
    return s ? s.slice(0, max) : null;
  }

  const isMoney = (m) => !!m && typeof m === "object"
    && typeof m.value === "number" && typeof m.precision === "number";

  // Identity of a title we could NOT import (ADR 0015 addendum 2026-09-01):
  // what it is, never how big it is. The member sees this in the preview and
  // confirms it with a second button.
  function titleIdentity(t) {
    return {
      isin: safeText(t.isin, 20),
      title: safeText(t.title || t.fullTitle),
      security_type: safeText(t.securityType, 30),
      security_sub_type: safeText(t.securitySubType, 30),
      exchange: safeText(t.positions?.[0]?.stockExchangeCode, 20),
      currency: safeText(t.currency, 8),
    };
  }

  // NAMES + currencies of every money-shaped field on a title (and on its first
  // position), so we can learn which field carries a foreign share's invested
  // amount in its NATIVE currency. Amounts, shares and performance are never
  // read here — only the key and the currency tag.
  function moneyFieldCurrencies(t) {
    const fields = {};
    const scan = (obj, prefix) => {
      if (!obj || typeof obj !== "object") return;
      for (const [key, value] of Object.entries(obj)) {
        if (!isMoney(value)) continue;
        if (Object.keys(fields).length >= MAX_CALIBRATION_ITEMS) return;
        fields[(prefix + key).slice(0, 60)] = safeText(value.currency, 8);
      }
    };
    scan(t, "");
    scan(t.positions?.[0], "positions[0].");
    return fields;
  }

  // UTF-8 size of a string without TextEncoder (content scripts and the test
  // sandbox both have it, but this keeps the module dependency-free).
  function byteLength(s) {
    let bytes = 0;
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    }
    return bytes;
  }

  // The item cap is not enough on its own — 20 long Czech titles can still pass
  // the server's 8192 B broker_detail limit, and an oversized report is simply
  // rejected. Drop calibration items from the tail (never a field value) until
  // the detail fits, longest list first.
  function fitDetail(detail) {
    const fitted = { ...detail };
    while (byteLength(JSON.stringify(fitted)) > 7500
        && (fitted.money_fields.length || fitted.skipped_titles.length)) {
      if (fitted.money_fields.length >= fitted.skipped_titles.length) {
        fitted.money_fields = fitted.money_fields.slice(0, -1);
      } else {
        fitted.skipped_titles = fitted.skipped_titles.slice(0, -1);
      }
    }
    return fitted;
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
      const skippedTitles = [];  // identity of every title we can't import yet
      const skippedNames = [];   // the same titles, for the member's warning
      const moneyFields = [];    // { isin, fields: { name: currency|null } }
      const noAvg = [];          // average not derivable from the snapshot
      const fxNoAvg = [];        // …because the title is in another currency
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

            if (t.securityType === "SHARE") {
              // Exchange-traded share (George Invest): an ordinary ticker row
              // carrying the ISIN — the club web resolves it to a Yahoo quote
              // through its alias table (ADR 0010 addendum). No price snapshot:
              // shares are priced by the club, funds are not.
              const shareCount = t.numberOfShares;
              if (!Number.isFinite(shareCount) || shareCount <= 0) continue;
              const shareIsin = safeText(t.isin, 20)?.toUpperCase() || "";
              if (!shareIsin) continue;
              const titleCurrency = safeText(t.currency, 8);
              const invested = money(t.investedValue);
              // George reports investedValue in the ACCOUNT currency while the
              // share itself lives in its native one, so dividing across
              // currencies would produce a silently wrong average.
              const sameCurrency = !!titleCurrency && !!cur && titleCurrency === cur;
              const shareAvg = sameCurrency && invested != null && invested > 0
                ? invested / shareCount : null;
              const shareName = safeText(t.title || t.fullTitle);
              if (shareAvg == null) {
                (sameCurrency ? noAvg : fxNoAvg).push(shareName || shareIsin);
                // Which money field would hold the native amount? Names and
                // currencies only — that is exactly what we lack (ADR 0015).
                if (moneyFields.length < MAX_CALIBRATION_ITEMS) {
                  moneyFields.push({
                    isin: shareIsin, fields: moneyFieldCurrencies(t),
                  });
                }
              }
              const exchange = safeText(t.positions?.[0]?.stockExchangeCode, 20);
              positions.push({
                ticker: shareIsin,
                shares: shareCount,
                avgCost: shareAvg,
                currency: titleCurrency || cur || null,
                note: shareName && exchange
                  ? `${shareName} · ${exchange}`
                  : shareName || exchange || null,
              });
              continue;
            }

            if (t.securityType !== "FUND") {
              // Unknown type (ETF, bond, certificate — we have no live sample).
              // Skipped loudly, with its identity offered for calibration.
              const identity = titleIdentity(t);
              if (skippedTitles.length < MAX_CALIBRATION_ITEMS) {
                skippedTitles.push(identity);
              }
              skippedNames.push(identity.title || identity.isin || "neznámý titul");
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
      if (skippedNames.length) {
        const shown = skippedNames.slice(0, 5).join(", ");
        const rest = skippedNames.length - 5;
        warnings.push(
          `Tituly ${shown}${rest > 0 ? ` a další (${rest})` : ""} zatím neumíme `
          + "naimportovat — přeskočily se. Klikni prosím na „Odeslat "
          + "diagnostiku“, pošleš nám jejich typ a my je doplníme.",
        );
      }
      if (!positions.length) {
        warnings.push("Na majetkovém účtu nejsou žádné fondy ani akcie, "
          + "které umíme naimportovat — importuje se jen celková hodnota.");
      }
      if (noAvg.length) {
        warnings.push(
          `U titulů ${noAvg.join(", ")} se nákupní cena nedala odvodit — `
          + "doplň ji v tabulce ručně.",
        );
      }
      if (fxNoAvg.length) {
        warnings.push(
          `U akcií ${fxNoAvg.join(", ")} v cizí měně neumíme nákupní cenu `
          + "spočítat (George vede investovanou částku v měně účtu) — doplň ji "
          + "v tabulce ručně a pošli nám prosím diagnostiku.",
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

      // A successful but incomplete import still carries what we need to
      // finish the adapter (ADR 0015 addendum 2026-09-01): the popup offers
      // "Odeslat diagnostiku" next to the normal success flow, through the very
      // same two-step confirmation. Identity of the AFFECTED titles only —
      // never shares, amounts, values or performance.
      const calibration = skippedTitles.length || moneyFields.length
        ? IKDiagnostics.failure({
          phase: "scrape",
          errorCode: "partial_import",
          brokerDetail: fitDetail({
            ...diagnosticDetail({ hadToken: true, meta, body }),
            skipped_titles: skippedTitles.slice(0, MAX_CALIBRATION_ITEMS),
            money_fields: moneyFields.slice(0, MAX_CALIBRATION_ITEMS),
          }),
        })
        : null;

      return {
        ok: true,
        ...(calibration ? { calibration } : {}),
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
