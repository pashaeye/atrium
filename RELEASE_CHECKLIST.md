# Release checklist: Chrome Web Store, public

**you** = needs you (accounts, uploads, forms); everything marked done is already in this folder.

## Decided
- [x] Name **Atrium — Vertical Tabs, Spaces & Sidebar** (no “Arc” in the title; once in the description).
- [x] Publisher: your name · English only · non-trader account (EEA).
- [x] Incognito proxy and the Google country panel: off (`FEATURE_PROXY` in background.js), back in a later version.
- [x] Code: public GitHub repository **pashaeye/atrium**, all rights reserved (LICENSE). Privacy policy on GitHub Pages.

## Ready in this folder
- [x] Extension, version in `manifest.json`; `./build.sh` → `dist/atrium-<version>.zip` (run it after any change).
- [x] Privacy policy `docs/privacy.html`, home page `docs/index.html`.
- [x] Store texts, permission justifications, data-usage answers: `store/listing.md`.
- [x] Promo tile 440×280 and marquee 1400×560: `store/promo/`.
- [x] Third-party notices, licence, changelog.

## Your steps
1. [ ] **GitHub repository** — on github.com create a public repository named `atrium` (no README, no licence: they're here). Then in Terminal:
   ```
   cd "/Users/pavel/Documents/Arc Spaces/arc-spaces"
   git init -b main && git add . && git commit -m "Atrium 1.5.4"
   git remote add origin https://github.com/pashaeye/atrium.git && git push -u origin main
   ```
2. [ ] **GitHub Pages** — repository → Settings → Pages → Source: “Deploy from a branch”, Branch `main`, folder `/docs` → Save. After a minute check https://pashaeye.github.io/atrium/privacy.html opens.
3. [ ] **Screenshots** — 3–5 at 1280×800, how-to in `store/screenshots.md`.
4. [ ] **Developer account** — https://chrome.google.com/webstore/devconsole/register ($5, once).
5. [ ] **Upload** — Developer Dashboard → New item → `dist/atrium-<version>.zip`.
6. [ ] **Store listing tab** — description, category, language, screenshots, promo tile, home page and support links (all in `store/listing.md`).
7. [ ] **Privacy practices tab** — single purpose, one justification per permission, data usage, privacy policy URL (`store/listing.md`).
8. [ ] **Distribution** — public, all regions, free. Submit for review (usually a few days with broad permissions).
9. [ ] Answer reviewer questions if any (send them to me).

## After release
- Updates: change → version + CHANGELOG → `./build.sh` → upload the new zip in the dashboard (same item).
- Next: settings and Spaces sync between computers; the Incognito proxy and Google panel back.
