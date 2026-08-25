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

Členům se distribuuje zip ze stránky klubu:
**<https://investicni-klub.lovable.app/rozsireni>** (včetně návodu k instalaci).
Publikace do Chrome Web Store (jednorázový poplatek 5 USD + review) až se
rozšíření osvědčí.

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
| Trading 212 | kalibrováno (API) | z přihlášené session načte účet, otevřené pozice a metadata instrumentů; množství, `averagePrice` v původní měně instrumentu, celkovou hodnotu i hotovost. Interní kód `TICKER_ZEMĚ_EQ` převádí na Yahoo symbol (např. nizozemský titul na `.AS`); neznámou burzu nechá k ověření. Žádný HTML ani CSV fallback — změněná nebo neúplná odpověď import bezpečně zastaví s výzvou k obnovení stránky. |
| Portu | kalibrováno (API) | hodnota z `/api/v1/dashboard`, pozice z `/api/v1/portfolio/composition` (Bearer token z localStorage SPA); Bloomberg symboly → Yahoo (CSPX LN → CSPX.L), frakce + průměrná nákupní cena + měna instrumentu; portfolio se pozná z `?id=` v URL detailu; hotovost zůstává jen v celkové hodnotě |
| Fio e-Broker | kalibrováno podle živého DOM | primárně Portfolio → **Vývoj** (`e-portfolio.cgi?menu=2`, stáhne se same-origin z kterékoli stránky e-Brokeru): pozice = koncový stav, **průměrná nákupní cena = Nákup ÷ Kusy** (jen když období pokrývá celou pozici — jinak null s upozorněním), uzavřené pozice se přeskočí; fallback Portfolio → Stav (bez nákupních cen). Sloupce mapované podle textů hlaviček (pořadí se mezi pohledy liší, názvy se ve Vývoji opakují — první výskyt = začátek, poslední = konec); BCPP symboly `BAA*` → Yahoo `.PR` (BAAKOMB → KOMB.PR), US tickery 1:1, ostatní trhy s upozorněním; hotovost (`CZK`, `CZK(OU)`, `CZK(na cestě)`) jen v celkové hodnotě |
| Anycoin | kalibrováno (API) | zůstatky z `/api/user/accounts` (Bearer token z `localStorage`, stejně jako u Portu), kurzy z veřejného `/api/rates`; celková hodnota v Kč = množství × **prodejní** kurz Anycoinu (nákupní je o spread výš, číslo se proto může o jednotky procent lišit od webu), staking se počítá do množství. Tickery jdou na Yahoo krypto páry v dolarech (`BTC-USD`) — Yahoo `-CZK` páry nemá. Zkratky nejde odvodit: Yahoo nechává holý ticker první minci, která si ho vzala, a jmenovcům dává číslo (`SUI-USD` je „Salmonation", Sui je `SUI20947-USD`), takže scraper nese tabulku 307 ověřených symbolů + 68 přemapování (Anycoin `XDG` = Dogecoin, `POL` = Polygon → `POL28321-USD`); ostatní projdou 1:1 s upozorněním, ať je člen zkontroluje. Anycoin nevrací nákupní ceny → doplň je v tabulce ručně |
| XTB | kalibrováno (pasivní Worker/WebSocket stream) | z již existujícího streamu XStation 5 načte právě vybraný účet, otevřené pozice, nativní vážené průměrné ceny, celkovou hodnotu a jednoznačně potvrzenou hotovost. U rozpoznaných čekajících BUY pokynů zahrne do hotovosti také brokerem vykázanou rezervaci `stockLock`; čekající SELL hotovost nemění a ignoruje se. Při nejednoznačné účetní identitě doplněk pošle `cashValue: null` a web klubu hotovost bezpečně dopočítá. Doplněk neotevírá vlastní spojení, neposílá XTB příkazy a nepoužívá DOM ani URL ikon. Neúplná, smíšená nebo neznámá data import bezpečně zastaví. Kvůli odděleným kontextům Chromu používá dvojici `xtb-stream.js` (MAIN world od `document_start`, pozorování Workerů stránky) a `xtb.js` (ISOLATED world, registrace doplňku a jednorázový zabezpečený bridge). |

Vzácné symboly, které nelze spolehlivě převést obecným pravidlem, opravuje až
společná přesná tabulka v `lib/normalize.js`. Klíčem je broker + již
normalizovaný ticker + nativní měna instrumentu; aktuálně obsahuje
`XTB/DOC1/USD → DOC`, `T212/WEBN1.DE/EUR → WEBN.DE` a
`Portu/SX5EEX.DE/EUR → EUEA.AS`. Při kolizi s jinou pozicí se řádky neslučují
ani nepřepočítávají — převod se přeskočí a do poznámky se přidá upozornění.

## Architektura

```
popup/            UI: detekce brokera na aktivním tabu → scrape → odeslání
lib/normalize.js  sdílené: parsování čísel/měn (en i cs formáty), yahooSymbol,
                  přesné tickerové výjimky, DOM helpery a registrace scraperu
                  (IK_DETECT / IK_SCRAPE)
content/brokers/  broker adapter; obvykle jeden soubor, T212 a XTB mají zvlášť
                  MAIN-world zdroj dat a ISOLATED-world registraci/bridge
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
   error, needsCalibration }`. Když broker umí říct, kolik z celkové hodnoty
   je hotovost, pošli ji ve volitelném `payload.cashValue` (v měně payloadu) —
   web ji ukáže u portfolia; bez ní si rozdíl jen odhadne.
2. Pokud zdroj dat musí běžet v page contextu, použij samostatný MAIN-world
   soubor a malý ISOLATED-world registrační soubor. Neslučuj je: každý potřebuje
   jiný execution world. Předávej jen normalizovaný výsledek přes jednorázový,
   nonce-bound, same-origin `window.postMessage` bridge (viz T212 a XTB).
3. Do `manifest.json` přidej potřebné bloky `content_scripts`; u běžného
   ISOLATED-world scraperu načti `lib/normalize.js` jako první.
4. Nedovoditelnou výjimku tickeru přidej nahoru do
   `BROKER_TICKER_OVERRIDES` v `lib/normalize.js`, nikoli do jednotlivého
   scraperu. Musí mít přesný klíč broker + normalizovaný ticker + měna a test.
5. Volitelně přidej zkratku do `popup/popup.html` (`.broker-link`).

Přijímací strana na webu je generická — novému brokerovi stačí přidat label do
`BROKER_LABELS` v `_app.portfolio.$portfolioId.tsx` (jinak se zobrazí klíč).

## Vývoj a příspěvky (pro členy)

Nefunguje ti import? Můžeš si to odladit sám a poslat pull request — přesně
proto je tohle repo veřejné.

1. **Fork + clone** repa, načti rozšíření přes „Načíst rozbalené" (viz výše) —
   od té chvíle jedeš na svém kódu; po každé úpravě dej v `chrome://extensions`
   u rozšíření ↻.
2. **Debug scraperu**: na stránce brokera otevři DevTools (F12). ISOLATED-world
   content script vyber v přepínači kontextu konzole; page/MAIN-world provoz
   sleduj v kontextu stránky a v Network. Popup se debuguje pravým klikem na
   ikonu rozšíření → „Prozkoumat vyskakovací okno". Nikdy nekopíruj do issue
   cookies, tokeny, ID účtu ani surové odpovědi s osobními daty.
3. **Konvence**: scraper nikdy nesmí vrátit tiše špatná čísla — když se broker
   změní, vrať `{ ok: false, error: "<česky, co má člen udělat>",
   needsCalibration: true }`. Prázdné pozice = import jen celkové hodnoty
   (web pak NEotevře tabulku, která by portfolio přepsala).
4. **Kontrola**: spusť `node --check` na každý změněný JS soubor a `node --test`.
   Projekt nemá build krok; živě navíc ověř dotčeného brokera v načteném
   rozšíření a zkontroluj výslednou tabulku před uložením.
5. **Pull request**: popiš, na které stránce brokera to padalo a co rozšíření
   hlásilo. **Nikdy nevkládej osobní data** — hodnoty portfolia, jména ani ID
   účtů v issue/PR začerni nebo nahraď smyšlenými.
