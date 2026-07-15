// Per-broker member guidance for the top banner (lib/banner.js). Czech,
// member-facing. Two states per broker: `offPage` tells the member where to
// navigate for the import, `onPage` confirms this page works and points at
// the extension icon. `url` + `urlLabel` drive the banner's navigate button
// (shown only in the offPage state). Plain script (no build step) loaded
// before banner.js — see manifest content_scripts order.
"use strict";

// eslint-disable-next-line no-unused-vars
const IK_GUIDES = {
  etoro: {
    offPage: "Pro import portfolia otevři Portfolio — vlastní přehled, nebo "
      + "breakdown kopírovaného tradera (Portfolio → klikni na tradera).",
    onPage: "Odsud jde importovat portfolio — klikni na ikonu rozšíření "
      + "Investiční klub a pak „Načíst portfolio“.",
    url: "https://www.etoro.com/portfolio",
    urlLabel: "Otevřít portfolio",
  },
  ibkr: {
    offPage: "Pro import portfolia otevři Client Portal → Portfolio "
      + "(Positions).",
    onPage: "Odsud jde importovat portfolio — klikni na ikonu rozšíření "
      + "Investiční klub a pak „Načíst portfolio“.",
    url: "https://www.interactivebrokers.ie/portal",
    urlLabel: "Otevřít Client Portal",
  },
  portu: {
    offPage: "Pro import otevři Souhrn a klikni na KONKRÉTNÍ portfolio "
      + "(detail s ?id= v adrese) — jinak nepoznáme, které importovat.",
    onPage: "Odsud jde importovat portfolio — klikni na ikonu rozšíření "
      + "Investiční klub a pak „Načíst portfolio“. Máš-li víc portfolií, "
      + "otevři detail toho pravého.",
    url: "https://www.portu.cz/souhrn",
    urlLabel: "Otevřít Souhrn",
  },
  fio: {
    offPage: "Přihlas se do e-Brokeru — import pak funguje z kterékoli jeho "
      + "stránky.",
    onPage: "Odsud jde importovat portfolio — klikni na ikonu rozšíření "
      + "Investiční klub a pak „Načíst portfolio“. Průměrné nákupní ceny se "
      + "berou z Portfolio → Vývoj automaticky.",
    url: "https://ebroker.fio.cz/e-portfolio.cgi?menu=2",
    urlLabel: "Otevřít e-Broker",
  },
};
