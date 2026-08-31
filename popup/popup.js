// Popup flow: detect a broker scraper on the active tab → scrape → pick the
// TARGET club portfolio (list comes from the club tab's IK_PING bridge) →
// hand the payload over. Handoff = chrome.storage.local (payload + target
// portfolio id) + navigating a club tab straight to /portfolio/<target>;
// content/club.js then delivers it into the page, and the page applies it
// only when the open portfolio matches the target (see its header comment).
"use strict";

const CLUB_HOME = "https://investicni-klub.lovable.app";
const CLUB_TAB_PATTERNS = [
  "https://investicni-klub.lovable.app/*",
  "http://localhost/*",
  "http://127.0.0.1/*",
];
const IK_KEY = "ik_pending_import";
const IK_DIAGNOSTIC_KEY = "ik_pending_diagnostic";
const IK_HANDOFF_FAILURE_KEY = "ik_failed_handoff";
const IK_DIAGNOSTIC_RESULT_KEY = "ik_diagnostic_result";
const PLUGIN_VERSION = chrome.runtime.getManifest().version;
const BROKER_HOSTS = [
  [/^(www\.)?etoro\.com$/, ["etoro", "eToro"]],
  [/(^|\.)interactivebrokers\.(com|co\.uk|ie)$/, ["ibkr", "Interactive Brokers"]],
  [/(^|\.)portu\.cz$/, ["portu", "Portu"]],
  [/^ebroker\.fio\.cz$/, ["fio", "Fio e-Broker"]],
  [/^(www\.)?anycoin\.cz$/, ["anycoin", "Anycoin"]],
  [/^app\.trading212\.com$/, ["t212", "Trading 212"]],
  [/^xstation5\.xtb\.com$/, ["xtb", "XTB"]],
];

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let scrapedPayload = null;
let diagnosticContext = null;
// Last known club-tab state: { tab, origin, currentId, currentName, portfolios }.
let clubState = { tab: null, origin: CLUB_HOME };

function fmtTotal(value, currency) {
  if (value == null) return "—";
  try {
    return new Intl.NumberFormat("cs-CZ", {
      style: "currency", currency: currency || "USD", maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${Math.round(value).toLocaleString("cs-CZ")} ${currency || ""}`.trim();
  }
}

// A club tab we can hand the payload to. Prefer production, then any tab
// running our bridge (localhost dev).
async function findClubTab() {
  const tabs = await chrome.tabs.query({ url: CLUB_TAB_PATTERNS });
  const prod = tabs.find((t) => t.url?.startsWith(CLUB_HOME));
  if (prod) return prod;
  for (const t of tabs) {
    try {
      const st = await chrome.tabs.sendMessage(t.id, { type: "IK_CLUB_STATUS" });
      if (st?.ok) return t;
    } catch { /* not our bridge (some other localhost app) */ }
  }
  return null;
}

// One status round-trip: which portfolio is open + the member's portfolio list
// (answered by the club web's app layout via IK_PING/IK_PONG).
async function queryClub() {
  const tab = await findClubTab();
  if (!tab) return { tab: null, origin: CLUB_HOME };
  let origin = CLUB_HOME;
  try { origin = new URL(tab.url).origin; } catch { /* keep default */ }
  try {
    const st = await chrome.tabs.sendMessage(tab.id, { type: "IK_CLUB_STATUS" });
    if (st?.ok) {
      return {
        tab,
        origin,
        currentId: st.portfolioId != null ? String(st.portfolioId) : null,
        currentName: st.portfolioName ?? null,
        portfolios: Array.isArray(st.portfolios) && st.portfolios.length
          ? st.portfolios : null,
      };
    }
  } catch { /* bridge not loaded (discarded tab, login page…) */ }
  return { tab, origin };
}

async function refreshClubStatus() {
  const el = $("club-status");
  const st = await queryClub();
  clubState = st;
  if (!st.tab) { el.textContent = "Web klubu není otevřený"; return; }
  el.textContent = st.currentName
    ? `Na webu otevřené portfolio „${st.currentName}"`
    : "Web klubu otevřený";
}

function showError(msg, context = null) {
  const el = $("error");
  el.textContent = msg;
  $("error-box").hidden = false;
  diagnosticContext = context;
  $("btn-diagnostic").hidden = !context;
}

function openDiagnostic() {
  if (!diagnosticContext) return;
  const report = IKDiagnostics.createReport({
    broker: diagnosticContext.broker,
    brokerLabel: diagnosticContext.brokerLabel,
    pluginVersion: PLUGIN_VERSION,
    diagnostic: diagnosticContext.diagnostic,
  });
  $("diagnostic-note").value = "";
  $("diagnostic").dataset.report = JSON.stringify(report);
  refreshDiagnosticPreview();
  $("error-box").hidden = true;
  $("diagnostic").hidden = false;
}

function refreshDiagnosticPreview() {
  const base = JSON.parse($("diagnostic").dataset.report || "null");
  if (!base) return;
  const exact = {
    ...base,
    member_note: $("diagnostic-note").value.trim().slice(0, 500),
  };
  $("diagnostic-preview").textContent = JSON.stringify(exact, null, 2);
}

async function sendDiagnostic() {
  const base = JSON.parse($("diagnostic").dataset.report || "null");
  if (!base) return;
  const report = {
    ...base,
    member_note: $("diagnostic-note").value.trim().slice(0, 500),
  };
  await chrome.storage.local.set({
    [IK_DIAGNOSTIC_KEY]: { report, savedAt: Date.now() },
  });
  const st = await queryClub();
  if (st.tab) {
    await chrome.tabs.update(st.tab.id, { url: `${st.origin}/rozsireni`, active: true });
    await chrome.windows.update(st.tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: `${CLUB_HOME}/rozsireni` });
  }
  window.close();
}

// Populate the target-portfolio select. If no club tab is alive (or it sits on
// a login/marketing page), boot/steer one to /portfolio in the BACKGROUND and
// poll — the popup stays open, the member just picks the target when it lands.
async function loadTargets(det) {
  const sel = $("target-select");
  const hint = $("target-hint");
  const send = $("btn-send");
  sel.disabled = true;
  send.disabled = true;
  hint.textContent = "Načítám portfolia z webu klubu…";

  let st = await queryClub();
  if (!st.tab) {
    await chrome.tabs.create({ url: `${CLUB_HOME}/portfolio`, active: false });
  } else if (!st.portfolios) {
    await chrome.tabs.update(st.tab.id, { url: `${st.origin}/portfolio` });
  }
  for (let i = 0; i < 16 && !st.portfolios; i += 1) {
    await sleep(500);
    st = await queryClub();
  }
  clubState = st;

  if (!st.portfolios) {
    hint.textContent =
      "Portfolia se nepodařilo načíst — přihlas se na webu klubu a klikni znovu na „Načíst portfolio“.";
    showError("Nepodařilo se načíst cílová portfolia z webu klubu.", {
      broker: det.broker,
      brokerLabel: det.brokerLabel,
      diagnostic: IKDiagnostics.failure({
        phase: "targets", errorCode: "broker_request_failed",
      }),
    });
    return;
  }
  sel.replaceChildren(...st.portfolios.map((p) => {
    const o = document.createElement("option");
    o.value = String(p.id);
    o.textContent = p.name;
    return o;
  }));
  if (st.currentId && st.portfolios.some((p) => String(p.id) === st.currentId)) {
    sel.value = st.currentId;
  }
  sel.disabled = false;
  send.disabled = false;
  hint.textContent = "";
}

function showResult(payload, det) {
  scrapedPayload = payload;
  $("res-count").textContent = String(payload.positions.length);
  $("res-total").textContent = fmtTotal(payload.totalValue, payload.currency);
  const ul = $("res-warnings");
  ul.replaceChildren();
  for (const w of payload.warnings || []) {
    const li = document.createElement("li");
    li.textContent = w;
    ul.appendChild(li);
  }
  $("result").hidden = false;
  void loadTargets(det);
}

function brokerView(det, tab) {
  $("view-broker").hidden = false;
  $("broker-name").textContent = det.brokerLabel;
  const btn = $("btn-scrape");

  if (!det.onPortfolioPage && det.portfolioUrl) {
    $("broker-hint").textContent = "Nejsi na stránce portfolia.";
    showError("Plugin na této stránce nerozpoznal portfolio.", {
      broker: det.broker,
      brokerLabel: det.brokerLabel,
      diagnostic: IKDiagnostics.failure({
        phase: "detect", errorCode: "page_not_recognized",
      }),
    });
    btn.textContent = "Přejít na stránku portfolia";
    btn.onclick = () => {
      chrome.tabs.update(tab.id, { url: det.portfolioUrl });
      window.close();
    };
  } else {
    $("broker-hint").textContent = "Načtu hodnotu a pozice z této stránky.";
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Načítám…";
      $("error-box").hidden = true;
      $("diagnostic").hidden = true;
      $("result").hidden = true;
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: "IK_SCRAPE" });
        if (res?.ok) showResult(res.payload, det);
        else showError(res?.error || "Načtení se nepovedlo.", res?.diagnostic ? {
          broker: det.broker,
          brokerLabel: det.brokerLabel,
          diagnostic: res.diagnostic,
        } : null);
      } catch (e) {
        showError("Načtení skončilo neočekávanou chybou.", {
          broker: det.broker,
          brokerLabel: det.brokerLabel,
          diagnostic: IKDiagnostics.failure({
            phase: "scrape", errorCode: "unexpected_error", error: e,
            step: "popup.scrape_message",
          }),
        });
      } finally {
        btn.disabled = false;
        btn.textContent = "Načíst portfolio";
      }
    };
  }

  $("btn-send").onclick = async () => {
    if (!scrapedPayload) return;
    const sel = $("target-select");
    const targetId = sel.value || null;
    if (!targetId) return;
    const targetName = sel.selectedOptions[0]?.textContent || null;
    await chrome.storage.local.set({
      [IK_KEY]: {
        payload: scrapedPayload,
        savedAt: Date.now(),
        targetPortfolioId: targetId,
        targetPortfolioName: targetName,
      },
    });
    const st = clubState.tab ? clubState : await queryClub();
    if (st.tab) {
      // Steer the club tab straight to the chosen portfolio; delivery matches
      // on the target id, so the import can't land anywhere else.
      if (st.currentId !== targetId) {
        await chrome.tabs.update(st.tab.id, {
          url: `${st.origin}/portfolio/${targetId}`, active: true,
        });
      } else {
        await chrome.tabs.update(st.tab.id, { active: true });
      }
      await chrome.windows.update(st.tab.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: `${CLUB_HOME}/portfolio/${targetId}` });
    }
    window.close();
  };

  void refreshClubStatus();
}

function homeView() {
  $("view-home").hidden = false;
  for (const b of document.querySelectorAll(".broker-link")) {
    b.addEventListener("click", () => chrome.tabs.create({ url: b.dataset.url }));
  }
}

function brokerForUrl(url) {
  try {
    const host = new URL(url).hostname;
    const match = BROKER_HOSTS.find(([pattern]) => pattern.test(host));
    return match ? { broker: match[1][0], brokerLabel: match[1][1] } : null;
  } catch {
    return null;
  }
}

function detectionFailureView(broker) {
  $("view-broker").hidden = false;
  $("broker-name").textContent = broker.brokerLabel;
  $("broker-hint").textContent = "Rozšíření tuto stránku nedokázalo načíst.";
  $("btn-scrape").hidden = true;
  showError("Obnov stránku brokera a zkus import znovu.", {
    ...broker,
    diagnostic: IKDiagnostics.failure({
      phase: "detect", errorCode: "page_not_recognized",
    }),
  });
}

async function init() {
  $("open-club").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: CLUB_HOME });
  });
  $("btn-diagnostic").addEventListener("click", openDiagnostic);
  $("btn-diagnostic-back").addEventListener("click", () => {
    $("diagnostic").hidden = true;
    $("error-box").hidden = false;
  });
  $("btn-diagnostic-send").addEventListener("click", () => void sendDiagnostic());
  $("diagnostic-note").addEventListener("input", refreshDiagnosticPreview);
  $("btn-result-close").addEventListener("click", () => window.close());
  $("btn-result-retry").addEventListener("click", async () => {
    await chrome.storage.local.remove(IK_DIAGNOSTIC_RESULT_KEY);
    location.reload();
  });

  const resultStore = await chrome.storage.local.get(IK_DIAGNOSTIC_RESULT_KEY);
  const diagnosticResult = resultStore[IK_DIAGNOSTIC_RESULT_KEY];
  if (diagnosticResult && Date.now() - (diagnosticResult.savedAt || 0) < 24 * 60 * 60 * 1000) {
    $("view-diagnostic-result").hidden = false;
    $("diagnostic-result-text").textContent = !diagnosticResult.rejected
      ? `Diagnostika byla odeslána pod kódem ${diagnosticResult.referenceCode}.`
      : diagnosticResult.rejectReason === "rate_limited"
        ? "Další diagnostiku teď neposíláme — podkladů už máme dost."
        : "Diagnostiku se nepodařilo přijmout — zkus to znovu později.";
    await chrome.storage.local.remove(IK_DIAGNOSTIC_RESULT_KEY);
    return;
  }

  const stored = await chrome.storage.local.get(IK_HANDOFF_FAILURE_KEY);
  const handoff = stored[IK_HANDOFF_FAILURE_KEY];
  if (handoff?.diagnostic && Date.now() - (handoff.savedAt || 0) < 24 * 60 * 60 * 1000) {
    await chrome.storage.local.remove(IK_HANDOFF_FAILURE_KEY);
    $("view-broker").hidden = false;
    $("broker-name").textContent = handoff.brokerLabel || handoff.broker || "Plugin";
    $("broker-hint").textContent = "Předání dat webu klubu se nedokončilo.";
    $("btn-scrape").hidden = true;
    showError("Web klubu nepotvrdil převzetí importu do dvou minut.", handoff);
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return homeView();
  try {
    const det = await chrome.tabs.sendMessage(tab.id, { type: "IK_DETECT" });
    if (det?.supported) return brokerView(det, tab);
  } catch { /* no scraper on this page */ }
  const knownBroker = brokerForUrl(tab.url);
  if (knownBroker) return detectionFailureView(knownBroker);
  homeView();
}

void init();
