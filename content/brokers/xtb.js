// XTB XStation 5 — isolated Chrome extension world.
//
// XTB intentionally requires two content scripts. The paired xtb-stream.js
// runs at document_start in Chrome's MAIN world because only that JavaScript
// world can observe Workers created by the XStation page. This file must run in
// the ISOLATED extension world, where the shared IK helper registers the broker
// and handles the popup's IK_DETECT / IK_SCRAPE messages. Merging the files
// would remove access to one of those two required execution-world contexts.
//
// On each scrape this adapter creates independent request and nonce values,
// accepts only one same-window, same-origin matching response, and returns the
// already normalized active-account result. It never reads XTB protocol data
// directly, opens a network connection, sends an XTB command, switches an
// account, or persists a response. Do not add DOM, logo, tooltip, API, socket,
// or other fallback paths here.
"use strict";

(() => {
  const CHANNEL = "ik-xtb-stream-bridge";
  const BRIDGE_TIMEOUT_MS = 8000;
  const BRIDGE_ERROR = "Spojení doplňku se streamem XTB se nepodařilo navázat. Obnov stránku (F5), počkej na načtení XStation a zkus import znovu.";

  function randomToken() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  }

  function bridgeFailure() {
    return new Error(BRIDGE_ERROR);
  }

  function requestFromMainWorld() {
    const requestId = randomToken();
    const nonce = randomToken();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(bridgeFailure()), BRIDGE_TIMEOUT_MS);
      const onMessage = (event) => {
        if (event.source !== window || event.origin !== location.origin) return;
        const message = event.data;
        if (message?.channel !== CHANNEL || message.type !== "response"
          || message.requestId !== requestId || message.nonce !== nonce) return;
        if (!message.result || typeof message.result.ok !== "boolean") return;
        finish(null, message.result);
      };
      function finish(error, result) {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        if (error) reject(error);
        else resolve(result);
      }

      window.addEventListener("message", onMessage);
      window.postMessage({ channel: CHANNEL, type: "request", requestId, nonce }, location.origin);
    });
  }

  IK.registerScraper({
    broker: "xtb",
    brokerLabel: "XTB",
    portfolioUrl: "https://xstation5.xtb.com/#/_/loggedIn",
    isPortfolioPage: () => location.hostname === "xstation5.xtb.com",
    async scrape() {
      try {
        return await requestFromMainWorld();
      } catch {
        return { ok: false, needsCalibration: true, error: BRIDGE_ERROR };
      }
    },
  });
})();
