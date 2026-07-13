# Publikace verzí

Plugin se zatím **nedistribuuje přes Chrome Web Store** — členové ho stahují ze
stránky webu klubu (`/rozsireni`, „Chrome rozšíření") jako zip a načtou přes
„Načíst rozbalené". Nová verze = nový zip na webu + bump verze. Auto-aktualizace
nejsou (to umí až Web Store), takže po vydání členy vyzvi, ať plugin znovu
stáhnou a v `chrome://extensions` dají ↻.

## Kde žije číslo verze

Verze musí souhlasit na třech místech:

| Kde | Co |
| --- | --- |
| `manifest.json` → `"version"` | zdroj pravdy (Chrome ji zobrazuje) |
| `../investicni-klub/public/ik-portfolio-import-<verze>.zip` | soubor ke stažení |
| `../investicni-klub/src/routes/_app.rozsireni.tsx` → `PLUGIN_VERSION`, `PLUGIN_FILE` | odkaz a štítek na webu |

## Vydání nové verze

1. **Bump verze** v `manifest.json` (`"version": "0.2.0"`). Používej semver:
   patch = oprava scraperu, minor = nový broker / feature.
2. **Sestav zip** — z `ik-chrome-plugin` spusť:
   ```bash
   ./build-zip.sh
   ```
   Vytvoří `../investicni-klub/public/ik-portfolio-import-<verze>.zip` a vypíše,
   co nastavit v kroku 3. (Ručně: `zip -rq <cíl> manifest.json lib content popup README.md`.)
3. **Uprav web** v `../investicni-klub/src/routes/_app.rozsireni.tsx`:
   nastav `PLUGIN_VERSION` a `PLUGIN_FILE` na novou verzi. Starý zip z
   `public/` smaž (`git rm`), ať tam nebují staré soubory.
4. **Ověř web**: v `../investicni-klub` spusť `./node_modules/.bin/tsc --noEmit`
   a `npm run build` (repo lintuje „dirty", validuj tsc + buildem, ne `eslint .`).
5. **Commit + push** (obě složky jsou submoduly monorepa `~/Elbl`):
   - `ik-chrome-plugin` — commitni změnu scraperů + `manifest.json` a **pushni**
     (veřejné repo `mara747/ik-chrome-plugin` — členové z něj forkují a posílají
     PR).
   - `investicni-klub` — commitni nový zip + `_app.rozsireni.tsx` a **pushni**;
     pak nasaď přes Lovable (samo se nenasazuje).
   - v monorepu bumpni ukazatele: `git add ik-chrome-plugin investicni-klub
     && git commit`.
6. **Přidej zápis do „Co je nového"** (nepovinné u drobných oprav) — SQL insert
   do tabulky `whats_new` v Supabase SQL editoru:
   ```sql
   insert into whats_new (title, body) values (
     'Chrome rozšíření v0.2.0',
     'Stručně co je nového. Detaily na stránce **Chrome rozšíření**.'
   );
   ```
7. **Řekni členům**, ať si na `/rozsireni` stáhnou novou verzi a v
   `chrome://extensions` dají u rozšíření ↻ (Aktualizovat). Nová verze se sama
   nenačte — load-unpacked auto-update nemá.

## Až se zkouška osvědčí → Chrome Web Store

Pro pohodlnou distribuci a **auto-aktualizace** (bez vývojářského režimu):

- Jednorázový poplatek 5 USD, nahraje se stejný zip, viditelnost **Unlisted**
  (instalace přes přímý odkaz, nejde najít ve vyhledávání).
- Potřeba doplnit: **ikony** (16/32/48/128 px) do `manifest.json` + `icons/`,
  krátký popis, screenshot a „privacy justification" k oprávněním
  `storage`/`tabs` a doménám brokerů (u finančního rozšíření to prověřují víc).
- Po vydání se `_app.rozsireni.tsx` přepne z lokálního zipu na odkaz do Web Store.
