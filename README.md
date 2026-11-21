# Atrium — Vertical Tabs, Spaces & Sidebar for Chrome

Plain JavaScript (ES modules), no build step and no dependencies.

## Install
1. Open `chrome://extensions` and turn on Developer mode.
2. Click “Load unpacked” and choose the `arc-spaces` folder.
3. The setup page opens. Follow the steps: vertical tabs, sidebar, shortcuts.

After changing the code, click ⟳ on the extension card in `chrome://extensions` and reopen the sidebar.

## Versions
The version is in `manifest.json` (shown at the bottom of Settings in the sidebar); what changed in each one is in [CHANGELOG.md](CHANGELOG.md). New features raise the middle number (1.0.0 → 1.1.0), fixes the last one (1.0.0 → 1.0.1). Each change adds a line to the top section of the changelog.

## Files
| File | What it does |
|---|---|
| `manifest.json` | Permissions, side panel, New Tab override, shortcuts |
| `background.js` | State and all logic: Spaces ↔ tab groups, Favorites, Pinned, Chrome events, message API |
| `sidepanel.*` | Sidebar: Favorites, Pinned with folders, Today with sorting, Space carousel, drag & drop, menus |
| `command.*`, `newtab.html` | Command Bar: popup window (shortcut) and the New Tab page |
| `ui.js`, `ui.css` | Menus, dialogs (incl. icon picker), toasts, shared styles |
| `icons.js`, `icons/ph/` | Phosphor Icons (Fill, MIT) used for Spaces and folders |
| `shared.js` | Colors, favicons, fuzzy search, messaging |
| `onboarding.*` | First-run setup page |
| `proxy*.{html,js}`, `serp.js` | Incognito proxy and the Google country / language panel — **off in 1.0** (`FEATURE_PROXY` in background.js; needs the `proxy`, `webRequest`, `webRequestAuthProvider` permissions and serp.js back in the manifest) |
| `focus-guard.js` | Covers paused sites during focus (content script) |
| `tab-drop.js` | Lets a page accept a tab dragged out of the sidebar (content script) |
| `docs/` | Privacy policy page for GitHub Pages |
| `store/` | Chrome Web Store texts and permission justifications (not packaged) |
| `build.sh` | Makes the zip to upload |

## Model
- **Space** is one Chrome tab group per window. The group is named after the Space; that name is how it is found again after a restart.
- **Favorites** are Chrome’s pinned tabs (shared by all Spaces).
- **Pinned** is a tree of links inside a Space. The “item ↔ open tab” link lives in `storage.session`.
- **Today** is the rest of the Space group’s tabs.

## Limitations
- If you rename a Space’s group in Chrome’s own tab strip, the link to that group is lost after a restart.
- Groups created manually after install are left alone and not shown in the sidebar.
- Chrome keeps focus in the address bar on New Tab pages, so the page reopens itself once to move the cursor into search.

## Licence
Copyright © 2026 pashaeye. All rights reserved — see [LICENSE](LICENSE). Third-party parts keep their own licences:

## Third-party licences
Third-party icons and lists: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
