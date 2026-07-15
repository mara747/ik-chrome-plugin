# Investiční klub — import portfolia (Chrome rozšíření)

Chrome rozšíření pro členy Investičního klubu: na **vlastní přihlášené** stránce
brokera přečte hodnotu portfolia a pozice a naimportuje je do právě otevřeného
portfolia na webu klubu (https://investicni-klub.lovable.app). Nic se neukládá
automaticky — na webu se otevře kontrolní tabulka a člen import sám uloží.

Rozšíření nemá přístup k žádným přihlašovacím údajům ani do databáze; jen předá
načtená data otevřené stránce webu klubu (`window.postMessage`), která je uloží
pod přihlášeným účtem člena.

## Instalace (vývoj / před publikací do Web Store)

1. Naklonuj tohle repo (nebo stáhni zip z GitHubu) do složky, kterou nesmažeš.
2. Otevři `chrome://extensions` a zapni **Režim pro vývojáře** (vpravo nahoře).
3. **Načíst rozbalené** → vyber složku repa.

Členům se distribuuje zip ze stránky klubu (`/rozsireni`). Publikace do
Chrome Web Store (jednorázový poplatek 5 USD + review) až se rozšíření osvědčí.

## Použití

1. Přihlas se k brokerovi a otevři stránku portfolia (popup má zkratky).
2. Klikni na ikonu rozšíření → **Načíst portfolio** → zkontroluj souhrn.
3. Vyber **cílové portfolio** (seznam se načte z webu klubu; stačí být tam
   přihlášený — popup si web otevře na pozadí sám) → **Odeslat do webu klubu**.
4. Web klubu se otevře rovnou na vybraném portfoliu s tabulkou načtených
   pozic — zkontroluj a **Ulož**. Uložení nahradí celé portfolio obsahem
   tabulky. Import se aplikuje jen na vybrané portfolio, nikdy jinam.

## Stav brokerů

| Broker | Stav | Poznámka |
| --- | --- | --- |
| eToro | kalibrováno podle živého DOM | breakdown kopírovaného tradera (`/portfolio/breakdown/<user>`) i vlastní přehled: tabulka přes `automation-id`, symboly už s Yahoo příponou (RHM.DE, 3750.HK, BRK.B→BRK-B, ASML.NV→ASML.AS, ADBE.RTH→ADBE); měnu odvozuje z burzy, GDR (Samsung/Kazatomprom) → USD na `.IL`, britské `.L` akcie → pence (GBX, web přepočte na libry) |
| Interactive Brokers | kalibrováno (API) | pozice + Net Liq z interního API Client Portalu (`/v1/api/portfolio/…`, přihlášená session) vč. měny a burzy každé pozice → Yahoo tickery automaticky (RHM → RHM.DE, 9880 → 9880.HK); záměrně bez DOM fallbacku — při selhání API dostane člen srozumitelnou chybu (nejčastěji vypršelá session → F5) |
| Portu | kalibrováno (API) | hodnota z `/api/v1/dashboard`, pozice z `/api/v1/portfolio/composition` (Bearer token z localStorage SPA); Bloomberg symboly → Yahoo (CSPX LN → CSPX.L), frakce + průměrná nákupní cena + měna instrumentu; portfolio se pozná z `?id=` v URL detailu; hotovost zůstává jen v celkové hodnotě |
| Fio e-Broker | kalibrováno podle živého DOM | `e-portfolio.cgi` (Portfolio → Stav i Investice): tabulka `#portfolio_table`, sloupce mapované podle textů hlaviček (pořadí se mezi pohledy liší); BCPP symboly `BAA*` → Yahoo `.PR` (BAAKOMB → KOMB.PR), US tickery 1:1, ostatní trhy s upozorněním; hotovost (`CZK(OU)`, `CZK(na cestě)`) jen v celkové hodnotě; **bez průměrné nákupní ceny** (e-Broker ji v portfoliu nezobrazuje — doplní se ručně v editoru) |
| XTB | plán | přidat přes registr scraperů (viz níže) |

## Architektura

```
popup/            UI: detekce brokera na aktivním tabu → scrape → odeslání
lib/normalize.js  sdílené: parsování čísel/měn (en i cs formáty), yahooSymbol,
                  DOM helpery, registrace scraperu (IK_DETECT / IK_SCRAPE)
content/brokers/  jeden scraper na brokera; registruje se přes IK.registerScraper
content/club.js   bridge na webu klubu: doručí payload stránce (postMessage
                  s retry, dokud stránka portfolia nepošle ACK)
```

Předání dat: popup uloží payload do `chrome.storage.local` a aktivuje tab webu
klubu; `club.js` ho doručuje stránce, dokud portfolio stránka nepotvrdí ACK
(idempotentní, payload starší 10 minut se zahodí). Service worker není potřeba.

## Přidání nového brokera

1. Nový soubor `content/brokers/<broker>.js` — zavolej `IK.registerScraper({
   broker, brokerLabel, portfolioUrl, isPortfolioPage, scrape })`; `scrape()`
   vrací `{ ok: true, payload }` s pozicemi `{ ticker, shares, avgCost,
   currency, note }` (ticker ve formátu Yahoo Finance) nebo `{ ok: false,
   error, needsCalibration }`.
2. Do `manifest.json` přidej blok `content_scripts` s doménami brokera
   (`lib/normalize.js` vždy jako první).
3. Volitelně přidej zkratku do `popup/popup.html` (`.broker-link`).

Přijímací strana na webu je generická — novému brokerovi stačí přidat label do
`BROKER_LABELS` v `_app.portfolio.$portfolioId.tsx` (jinak se zobrazí klíč).

## Vývoj a příspěvky (pro členy)

Nefunguje ti import? Můžeš si to odladit sám a poslat pull request — přesně
proto je tohle repo veřejné.

1. **Fork + clone** repa, načti rozšíření přes „Načíst rozbalené" (viz výše) —
   od té chvíle jedeš na svém kódu; po každé úpravě dej v `chrome://extensions`
   u rozšíření ↻.
2. **Debug scraperu**: na stránce brokera otevři DevTools (F12) → Console —
   content script `content/brokers/<broker>.js` běží přímo tam, takže vidíš
   jeho chyby; můžeš si v konzoli i ručně sáhnout na API brokera. Popup se
   debuguje pravým klikem na ikonu rozšíření → „Prozkoumat vyskakovací okno".
3. **Konvence**: scraper nikdy nesmí vrátit tiše špatná čísla — když se broker
   změní, vrať `{ ok: false, error: "<česky, co má člen udělat>",
   needsCalibration: true }`. Prázdné pozice = import jen celkové hodnoty
   (web pak NEotevře tabulku, která by portfolio přepsala).
4. **Kontrola**: `node --check` na každý změněný soubor (žádný build ani testy
   tu nejsou).
5. **Pull request**: popiš, na které stránce brokera to padalo a co rozšíření
   hlásilo. **Nikdy nevkládej osobní data** — hodnoty portfolia, jména ani ID
   účtů v issue/PR začerni nebo nahraď smyšlenými.
