// Investiční klub banner on supported broker pages: a fixed top strip with
// context-aware guidance (texts in lib/guides.js). `IK.registerScraper` calls
// `IK_BANNER.attach(def)` — the banner reuses the scraper's isPortfolioPage()
// and re-evaluates every 2 s (eToro/Portu/IBKR are SPAs that navigate without
// a reload). Shadow DOM isolates the styles from the broker's CSS; the strip
// OVERLAYS the page (pushing content down breaks fixed SPA headers).
//
// Dismissal: ✕ hides until the end of the browser session (sessionStorage of
// the broker origin); „už neukazovat“ hides permanently per broker
// (chrome.storage.local, key ik_banner_hidden_<broker>).
"use strict";

// eslint-disable-next-line no-unused-vars
const IK_BANNER = (() => {
  const hideKey = (broker) => `ik_banner_hidden_${broker}`;
  const sessionKey = (broker) => `ik_banner_closed_${broker}`;

  const CSS = `
    .bar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483646;
      display: flex; align-items: center; gap: 10px;
      padding: 7px 12px; box-sizing: border-box;
      background: #0f172a; color: #e2e8f0;
      font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 1px 6px rgba(0,0,0,.35);
    }
    .bar.ready { background: #064e3b; color: #d1fae5; }
    .logo {
      flex: none; padding: 2px 7px; border-radius: 6px; font-weight: 700;
      background: #34d399; color: #052e21; font-size: 12px;
    }
    .msg { flex: 1 1 auto; min-width: 0; }
    button {
      flex: none; cursor: pointer; border: 0; border-radius: 6px;
      font: inherit; padding: 4px 10px;
    }
    .go { background: #34d399; color: #052e21; font-weight: 600; }
    .never {
      background: transparent; color: inherit; opacity: .6;
      text-decoration: underline; padding: 4px 2px;
    }
    .x { background: transparent; color: inherit; font-size: 15px; padding: 2px 6px; }
    .never:hover, .x:hover { opacity: 1; }
  `;

  async function attach(def) {
    const guide = typeof IK_GUIDES !== "undefined" ? IK_GUIDES[def.broker] : null;
    if (!guide || document.getElementById("ik-banner-host")) return;
    try {
      if (sessionStorage.getItem(sessionKey(def.broker))) return;
    } catch { /* sandboxed page — pruh prostě ukážeme */ }
    try {
      const st = await chrome.storage.local.get(hideKey(def.broker));
      if (st && st[hideKey(def.broker)]) return;
    } catch { /* storage nedostupná — neblokuj banner */ }
    render(def, guide);
  }

  function render(def, guide) {
    const host = document.createElement("div");
    host.id = "ik-banner-host";
    const shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = CSS;
    const bar = document.createElement("div");
    bar.className = "bar";
    const logo = document.createElement("span");
    logo.className = "logo";
    logo.textContent = "Investiční klub";
    const msg = document.createElement("span");
    msg.className = "msg";
    const go = document.createElement("button");
    go.className = "go";
    go.textContent = guide.urlLabel || "Otevřít";
    const never = document.createElement("button");
    never.className = "never";
    never.textContent = "už neukazovat";
    const x = document.createElement("button");
    x.className = "x";
    x.title = "Zavřít (do konce session)";
    x.textContent = "✕";
    bar.append(logo, msg, go, never, x);
    shadow.append(style, bar);

    const update = () => {
      let onPage = false;
      try { onPage = !!def.isPortfolioPage(); } catch { /* stay false */ }
      msg.textContent = onPage ? guide.onPage : guide.offPage;
      go.hidden = onPage;
      bar.classList.toggle("ready", onPage);
    };
    update();
    const timer = setInterval(update, 2000); // SPA mění URL bez reloadu

    const close = () => {
      clearInterval(timer);
      host.remove();
    };
    x.addEventListener("click", () => {
      try { sessionStorage.setItem(sessionKey(def.broker), "1"); } catch { /* ok */ }
      close();
    });
    never.addEventListener("click", () => {
      try { chrome.storage.local.set({ [hideKey(def.broker)]: true }); } catch { /* ok */ }
      close();
    });
    go.addEventListener("click", () => { location.href = guide.url; });

    // documentElement, ne body — přežije SPA re-rendery obsahu stránky.
    document.documentElement.appendChild(host);
  }

  return { attach };
})();
