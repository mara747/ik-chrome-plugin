// Trading 212 Invest (app.trading212.com) — isolated Chrome extension world.
//
// This is deliberately a small broker registration script: it answers the
// popup's IK_DETECT / IK_SCRAPE messages and receives an already normalized
// payload from the authenticated page context. It does NOT call Trading 212's
// session API itself: direct requests from an isolated content script do not
// share the page's effective network/session origin. The paired
// t212-api.js runs only in Chrome's MAIN world and performs those requests;
// this script communicates with it through one one-time, same-origin
// window.postMessage request/response channel.
//
// Do not merge the two files. A live Chrome test showed that using the same
// source for both execution worlds prevented this broker from registering.
// No DOM/HTML scraping, CSV fallback, response-body logging, or persistence
// of cookies, identifiers, API responses, or portfolio data is permitted.
"use strict";

(() => {
  const CHANNEL = "ik-t212-session-bridge";
  const BRIDGE_TIMEOUT_MS = 6000;
  const API_ERROR = "Trading 212 API se nepodařilo načíst. Obnov stránku (F5), zkontroluj přihlášení a zkus import znovu.";
  const BRIDGE_TIMEOUT_ERROR = "Spojení doplňku se stránkou Trading 212 se nepodařilo navázat. Obnov stránku (F5) a zkus import znovu.";

  function bridgeError() {
    return new Error(BRIDGE_TIMEOUT_ERROR);
  }

  function randomToken() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  }

  function fetchFromPageContext() {
    const requestId = randomToken();
    const nonce = randomToken();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(bridgeError()), BRIDGE_TIMEOUT_MS);
      const onMessage = (event) => {
        if (event.source !== window || event.origin !== location.origin) return;
        const message = event.data;
        if (message?.channel !== CHANNEL || message.type !== "response"
            || message.requestId !== requestId || message.nonce !== nonce) return;
        if (message.ok && message.result && typeof message.result.ok === "boolean") {
          finish(null, message.result);
        } else {
          finish(bridgeError());
        }
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
    broker: "t212",
    brokerLabel: "Trading 212",
    portfolioUrl: "https://app.trading212.com/",
    isPortfolioPage: () => true,

    async scrape() {
      try {
        return await fetchFromPageContext();
      } catch (error) {
        return {
          ok: false,
          needsCalibration: true,
          error: error?.message === BRIDGE_TIMEOUT_ERROR ? BRIDGE_TIMEOUT_ERROR : API_ERROR,
        };
      }
    },
  });
})();
