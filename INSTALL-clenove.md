# Import portfolia od brokera — návod pro členy

Rozšíření do Chrome, které načte hodnotu a pozice z tvé **přihlášené** stránky
brokera (eToro, Interactive Brokers, Trading 212, Portu, Fio e-Broker, Anycoin
a XTB) a naimportuje je do tvého portfolia na webu klubu. Nic se neukládá samo
— na webu se otevře tabulka, kterou zkontroluješ a uložíš.

Rozšíření **nezná tvé heslo ani přístup do databáze**. Data jen předá otevřené
stránce webu klubu, přihlášené pod tvým účtem.

## Instalace (2 minuty)

1. Rozbal `investicni-klub-plugin.zip` do složky, kterou nesmažeš (rozšíření se
   načítá z ní — např. `Dokumenty/investicni-klub-plugin`).
2. V Chrome otevři `chrome://extensions`.
3. Vpravo nahoře zapni **Režim pro vývojáře**.
4. Klikni **Načíst rozbalené** a vyber tu složku.
5. Hotovo — v liště přibude ikona rozšíření (případně ji připni přes ikonu
   puzzle 🧩).

> Používáš jen Chrome (nebo Edge/Brave). Ve Firefoxu ani Safari to zatím nejede.

## Použití

1. Přihlas se u svého brokera a otevři stránku portfolia:
   - **eToro** — Portfolio → klikni na portfolio, které kopíruješ (rozpad
     pozic), nebo svůj přehled.
   - **Interactive Brokers** — přihlas se do Client Portalu (stačí být kdekoli
     po přihlášení).
   - **Trading 212** — přihlas se na `app.trading212.com` k účtu Invest; stačí
     mít otevřenou aplikaci brokera.
   - **Portu** — otevři detail konkrétního portfolia (Souhrn → klikni na
     portfolio).
   - **Fio e-Broker** — přihlas se do e-Brokeru; rozšíření načte Portfolio →
     Vývoj samo z kterékoli přihlášené stránky.
   - **Anycoin** — přihlas se a otevři přehled zůstatků.
   - **XTB** — v XStation 5 vyber účet, který chceš importovat, počkej na jeho
     úplné načtení a nech stránku XStation otevřenou.
2. Klikni na ikonu rozšíření → **Načíst portfolio**.
3. Zkontroluj souhrn (počet pozic, hodnota) a vyber **cílové portfolio na webu
   klubu** (seznam se načte sám; stačí být na webu přihlášený).
4. **Odeslat do webu klubu** → web se otevře na vybraném portfoliu s tabulkou
   načtených pozic. Zkontroluj a **Ulož**.

> Uložení nahradí celé portfolio obsahem tabulky. Import se aplikuje jen na
> vybrané portfolio, nikam jinam.

## Na co si dát pozor

- **eToro, londýnské akcie (.L):** britské akcie se obchodují v pencích a GDR
  v dolarech — rozšíření to nepozná vždy a upozorní tě žlutým varováním.
  Před uložením zkontroluj u těchto řádků měnu (GBX / USD).
- **Interactive Brokers:** hodnota i pozice se čtou z tvé přihlášené session —
  když to hlásí „vypršelou session", obnov stránku (F5) a zkus znovu.
- **Trading 212:** import používá pouze přihlášenou session aplikace a načte
  otevřené pozice, průměrné nákupní ceny v původních měnách instrumentů,
  celkovou hodnotu účtu a hotovost. Nevyžaduje CSV export, heslo ani API klíč.
  Když import ohlásí chybu API, obnov stránku brokera (F5) a zkus jej znovu.
- **Portu:** importuje se hodnota + fondy vybraného portfolia; hotovost je
  součástí celkové hodnoty, ne pozic.
- **Fio e-Broker:** průměrná cena se načte jen tehdy, když období ve Vývoji
  bezpečně pokrývá celou otevřenou pozici; jinak ji doplň v kontrolní tabulce.
- **Anycoin:** nákupní ceny API neposkytuje, proto je případně doplň ručně.
- **XTB:** importuje se vždy právě vybraný účet XStation. Po přepnutí účtu
  počkej na načtení nových dat; při chybě obnov XStation (F5), znovu vyber účet
  a zkus import opakovat. Rozšíření pouze pozoruje data, která už načetla
  XStation — nevyžaduje heslo, API klíč ani export souboru.

Něco nefunguje? Napiš Markovi a přilož, co rozšíření nebo web ukázaly.
