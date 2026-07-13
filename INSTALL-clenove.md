# Import portfolia od brokera — návod pro členy

Rozšíření do Chrome, které načte hodnotu a pozice z tvé **přihlášené** stránky
brokera (eToro, Interactive Brokers, Portu) a naimportuje je do tvého portfolia
na webu klubu. Nic se neukládá samo — na webu se otevře tabulka, kterou
zkontroluješ a uložíš.

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
   - **Portu** — otevři detail konkrétního portfolia (Souhrn → klikni na
     portfolio).
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
- **Portu:** importuje se hodnota + fondy vybraného portfolia; hotovost je
  součástí celkové hodnoty, ne pozic.

Něco nefunguje? Napiš Markovi a přilož, co rozšíření nebo web ukázaly.
