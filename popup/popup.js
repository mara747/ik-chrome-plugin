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

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let scrapedPayload = null;
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

function showError(msg) {
  const el = $("error");
  el.textContent = msg;
  el.hidden = false;
}

// Populate the target-portfolio select. If no club tab is alive (or it sits on
// a login/marketing page), boot/steer one to /portfolio in the BACKGROUND and
// poll — the popup stays open, the member just picks the target when it lands.
async function loadTargets() {
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

function showResult(payload) {
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
  void loadTargets();
}

function brokerView(det, tab) {
  $("view-broker").hidden = false;
  $("broker-name").textContent = det.brokerLabel;
  const btn = $("btn-scrape");

  if (!det.onPortfolioPage && det.portfolioUrl) {
    $("broker-hint").textContent = "Nejsi na stránce portfolia.";
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
      $("error").hidden = true;
      $("result").hidden = true;
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: "IK_SCRAPE" });
        if (res?.ok) showResult(res.payload);
        else showError(res?.error || "Načtení se nepovedlo.");
      } catch (e) {
        showError(`Načtení selhalo: ${e.message}`);
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

async function init() {
  $("open-club").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: CLUB_HOME });
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return homeView();
  try {
    const det = await chrome.tabs.sendMessage(tab.id, { type: "IK_DETECT" });
    if (det?.supported) return brokerView(det, tab);
  } catch { /* no scraper on this page */ }
  homeView();
}

void init();
