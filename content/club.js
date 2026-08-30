// Bridge on the club web (investicni-klub.lovable.app / localhost dev).
//
// Delivery: the popup stores the scraped payload (+ targetPortfolioId picked
// by the member) in chrome.storage.local under IK_KEY and steers a club tab to
// /portfolio/<target>. This script (on load AND on storage change) posts
// { type: "IK_PORTFOLIO_IMPORT", payload, targetPortfolioId } into the page
// every 800 ms until the portfolio page acks with IK_PORTFOLIO_IMPORT_ACK —
// the page mounts its listener only on /portfolio/:id, SPA navigation takes
// time, and it ignores (no ack) imports addressed to a different portfolio.
// On ack the pending payload is cleared, so an import is delivered exactly once.
//
// Status: the popup asks IK_CLUB_STATUS; we ping the page (IK_PING) and relay
// its IK_PONG ({ portfolioId, portfolioName, portfolios }) — answered by the
// club web's app layout — so the popup can offer the target-portfolio picker.
"use strict";

const IK_KEY = "ik_pending_import";
const IK_DIAGNOSTIC_KEY = "ik_pending_diagnostic";
const IK_HANDOFF_FAILURE_KEY = "ik_failed_handoff";
const IK_MAX_AGE_MS = 10 * 60 * 1000;   // stale imports are dropped, not delivered
const IK_DIAGNOSTIC_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const IK_RETRY_MS = 800;
const IK_GIVE_UP_MS = 2 * 60 * 1000;

let ikTimer = null;
let diagnosticTimer = null;

function ikStopDelivery() {
  if (ikTimer) { clearInterval(ikTimer); ikTimer = null; }
}

function ikStartDelivery() {
  chrome.storage.local.get(IK_KEY).then((store) => {
    const entry = store[IK_KEY];
    ikStopDelivery();
    if (!entry?.payload) return;
    if (Date.now() - (entry.savedAt || 0) > IK_MAX_AGE_MS) {
      chrome.storage.local.remove(IK_KEY);
      return;
    }
    const t0 = Date.now();
    const post = () => {
      window.postMessage(
        {
          type: "IK_PORTFOLIO_IMPORT",
          payload: entry.payload,
          targetPortfolioId: entry.targetPortfolioId ?? null,
        },
        window.location.origin,
      );
      if (Date.now() - t0 > IK_GIVE_UP_MS) {
        ikStopDelivery();
        chrome.storage.local.set({
          [IK_HANDOFF_FAILURE_KEY]: {
            broker: entry.payload.broker,
            brokerLabel: entry.payload.brokerLabel,
            diagnostic: IKDiagnostics
              ? IKDiagnostics.failure({ phase: "handoff", errorCode: "handoff_timeout" })
              : {
                  phase: "handoff", errorCode: "handoff_timeout",
                  commonDetail: {}, brokerDetail: {},
                },
            savedAt: Date.now(),
          },
        });
      }
    };
    post();
    ikTimer = setInterval(post, IK_RETRY_MS);
  });
}

window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  if (e.data?.type === "IK_PORTFOLIO_IMPORT_ACK") {
    ikStopDelivery();
    chrome.storage.local.remove(IK_KEY);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[IK_KEY]?.newValue) ikStartDelivery();
});

ikStartDelivery(); // a payload may already be waiting when the tab (re)loads

function stopDiagnosticDelivery() {
  if (diagnosticTimer) { clearInterval(diagnosticTimer); diagnosticTimer = null; }
}

function startDiagnosticDelivery() {
  chrome.storage.local.get(IK_DIAGNOSTIC_KEY).then((store) => {
    const entry = store[IK_DIAGNOSTIC_KEY];
    stopDiagnosticDelivery();
    if (!entry?.report) return;
    if (Date.now() - (entry.savedAt || 0) > IK_DIAGNOSTIC_MAX_AGE_MS) {
      chrome.storage.local.remove(IK_DIAGNOSTIC_KEY);
      return;
    }
    const post = () => window.postMessage(
      { type: "IK_PLUGIN_DIAGNOSTIC", report: entry.report },
      window.location.origin,
    );
    post();
    diagnosticTimer = setInterval(post, IK_RETRY_MS);
  });
}

window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  if (e.data?.type !== "IK_PLUGIN_DIAGNOSTIC_ACK"
      && e.data?.type !== "IK_PLUGIN_DIAGNOSTIC_REJECTED") return;
  chrome.storage.local.get(IK_DIAGNOSTIC_KEY).then((store) => {
    const entry = store[IK_DIAGNOSTIC_KEY];
    if (entry?.report?.report_id !== e.data.reportId) return;
    stopDiagnosticDelivery();
    chrome.storage.local.remove(IK_DIAGNOSTIC_KEY);
    chrome.storage.local.set({
      ik_diagnostic_result: {
        reportId: e.data.reportId,
        referenceCode: e.data.referenceCode || null,
        rejected: e.data.type === "IK_PLUGIN_DIAGNOSTIC_REJECTED",
        savedAt: Date.now(),
      },
    });
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[IK_DIAGNOSTIC_KEY]?.newValue) {
    startDiagnosticDelivery();
  }
});

startDiagnosticDelivery();

// Popup status round-trip: chrome message → page ping → page pong → response.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "IK_CLUB_STATUS") return;
  let done = false;
  const onPong = (e) => {
    if (e.source !== window || e.data?.type !== "IK_PONG") return;
    done = true;
    window.removeEventListener("message", onPong);
    sendResponse({
      ok: true,
      portfolioId: e.data.portfolioId ?? null,
      portfolioName: e.data.portfolioName ?? null,
      portfolios: Array.isArray(e.data.portfolios) ? e.data.portfolios : null,
    });
  };
  window.addEventListener("message", onPong);
  window.postMessage({ type: "IK_PING" }, window.location.origin);
  setTimeout(() => {
    if (!done) {
      window.removeEventListener("message", onPong);
      // Bridge is present (we answered) but the app layout isn't mounted
      // (login page, marketing page…).
      sendResponse({ ok: true, portfolioId: null, portfolioName: null, portfolios: null });
    }
  }, 800);
  return true; // async sendResponse
});
