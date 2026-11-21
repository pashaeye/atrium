# Changelog

All notable changes to Atrium (called Spaces before 1.0). Versions follow [Semantic Versioning](https://semver.org): a new feature set raises the middle number (1.**1**.0) and a fix raises the last one (1.0.**1**). The version shown in Chrome comes from `manifest.json`.

The history before 0.8.1 was reconstructed from the development log (239 requests, 14–20 November 2026), so the dates of the early versions are approximate.

## 1.5.21 — 2026-11-21
- The first-focus notification check is remembered under a new name, so it shows once more for anyone who saw the older note.

## 1.5.20 — 2026-11-21
- The first focus sends a notification right away, and the sidebar asks whether it showed up, with a button that opens the system's notification settings (macOS System Settings → Notifications → Google Chrome; Windows Settings → Notifications).
- Sidebar messages can have a close button and an action button.

## 1.5.19 — 2026-11-21
- Focus: the checking helpers are gone (the 1-minute test Pomodoro, “Test sound and notification”, the test button in the first-focus note).

## 1.5.18 — 2026-11-21
- Sidebar messages say what they're about: an icon and a short title (a tomato for focus, a bell for the notification test, a moon for sleeping tabs, a link for copying, a warning for errors) above the details.

## 1.5.17 — 2026-11-21
- Sidebar messages span the full width of the sidebar.

## 1.5.16 — 2026-11-21
- The “round done” message in the sidebar goes away as soon as the next phase starts, also when you start it from the macOS notification.

## 1.5.15 — 2026-11-21
- Clicking the end-of-round notification also brings Chrome to the front, in the window focus was started in.

## 1.5.14 — 2026-11-21
- Development builds only (loaded unpacked): the tomato's right-click menu has “Pomodoro · 1 + 1 min (test)” for checking the end of a round and a break quickly. Store builds don't show it.

## 1.5.13 — 2026-11-21
- The end-of-round notification has no buttons of its own (macOS put them, with Chrome's “Settings”, into an “Options” menu): it says “Click to start a 5 min break” and a click does that.

## 1.5.12 — 2026-11-21
- The end-of-round notification has one button, “Start break” or “Start focus”, shown right on it (macOS hid two buttons in an “Options” menu). Ending focus stays in the sidebar.

## 1.5.11 — 2026-11-21
- The end-of-round notification has buttons: “Start break” (or “Start focus” after a break) and “End focus”.

## 1.5.10 — 2026-11-21
- Longer sidebar messages show as a neat card instead of a stretched pill. After a notification test, the how-to-allow hint shows only the first time.

## 1.5.9 — 2026-11-21
- The first time you start focus, a short note explains how to allow Chrome's notifications in the system settings (so the end-of-round alert shows), with a “Send a test” button.

## 1.5.8 — 2026-11-21
- “Test sound and notification” says in the sidebar whether Chrome sent the notification, and where to turn notifications on if it didn't reach the screen.

## 1.5.7 — 2026-11-21
- Focus menu (click or right-click the tomato): “Test sound and notification” plays the end-of-round chime and shows the notification, to check they reach you.

## 1.5.6 — 2026-11-21
- Focus: the “round done” / “break is over” notification shows up every time (it used to replace an earlier one silently). Starting a break or a round yourself no longer leaves a notification behind.

## 1.5.5 — 2026-11-21
- Google Docs, Sheets, Slides and Forms each show their own icon: icons are remembered per app on docs.google.com, and every open tab keeps the icon it reported itself.

## 1.5.4 — 2026-11-21 · Ready for the Chrome Web Store
- Setup guide covers split view, the Search button, the new focus card and calls; privacy policy and store texts updated.
- Home page link: pashaeye.github.io/atrium.

## 1.5.3 — 2026-11-21
- Split view in other sort orders: By title and Recent keep a pair together in its frame; By domain marks each tab of a pair, and pointing at one lights up the other.

## 1.5.2 — 2026-11-21
- Split view: dragging one tab of a pair to another place in Today, to another Space or out to a new window separates the pair.

## 1.5.1 — 2026-11-21
- A tab let go inside the sidebar no longer opens in a new window: the sidebar doesn't redraw during a drag (a row replaced under the pointer confused Chrome), and only a drop really outside the sidebar opens one.

## 1.5.0 — 2026-11-21
- Split view (Chrome 155+): drop a tab onto the middle of another tab in Today and the two open side by side. A split pair shows together in one frame; right-click → “Separate split view” undoes it.

## 1.4.1 — 2026-11-21
- A tab dragged out of the sidebar and let go over a web page no longer slides back into the sidebar first: its new window grows out of the spot where you let go.

## 1.4.0 — 2026-11-21
- Dragging a tab out of the sidebar: its row lights up and “Release to open in a new window” shows at the bottom, so you know what letting go will do. Back over the sidebar, both go away.

## 1.3.5 — 2026-11-21
- A tab let go inside the sidebar (where it can't be dropped) no longer opens in a new window now and then; only one pulled out of the sidebar does.

## 1.3.4 — 2026-11-21
- Today: dragging a tab that was opened from another tab now works every time — it joins the level of the row you drop it next to (to the top level, if you drop it there) instead of staying under its old parent.

## 1.3.3 — 2026-11-21
- Today: a tab dropped on the New Tab button (or anywhere above the first tab) goes to the top of the list; it used to land at the bottom.

## 1.3.2 — 2026-11-21
- Focus: dark icons shown light (TIDAL…) stay light when they turn black and white; faded icons are evenly grey.

## 1.3.1 — 2026-11-21
- Focus survives a browser restart and goes on where it was, unless its time ran out meanwhile.
- Focus: tabs opened before Atrium was installed or updated are covered too, without a reload.
- “Search” button above Today (icon and label, in the sidebar's style) opens the Command Bar.
- Command Bar over a page is opaque, so the day headings no longer show a mismatched band.

## 1.3.0 — 2026-11-20
- Focus: paused sites are now covered by a calm card instead of being swapped for another page. The tab keeps its own title and icon, tabs that were already open are covered too, and everything opens again the moment a break starts, a round's time is up or focus ends — no reload. The card's only button is “Open for 1 minute”.
- Focus: when a round or a break ends, a short chime and a message in the sidebar join the pulsing tomato; the notification stays until you act on it.
- Focus: icons are black and white only for tabs you haven't used during this focus; shown hidden tabs get their own list under “Hidden while you focus”.
- Command Bar button moved to the line above Today, on the left.
- Player: after a browser restart, restored tabs stay out of the player until you open them.

## 1.2.0 — 2026-11-20
- Focus: when a round or a break ends, the next one waits for you — click the pulsing tomato or the notification.
- Focus: a hidden tab you open stays in view; icons stay in colour (no more black and white).
- Command Bar button in the sidebar, next to Settings.
- Player: a call drops out of it once you leave the call; after a browser restart, tabs show up only once they actually play.
- Closing a window's last tab from the sidebar brings in the topmost tab of the Space from another window.
- Closed every window and then quit Chrome? On the next start the window you closed last comes back with its tabs.

## 1.1.3 — 2026-11-20
- Command Bar: the suggested site (your top sites, popular sites) shows the site's real icon instead of a grey circle.

## 1.1.2 — 2026-11-20
- Closing the last tab of a window from the sidebar no longer closes the window when the Space has tabs in another window: the most recently used one moves in instead.
- Light versions of dark icons follow a switch between light and dark mode right away.
- @ commands show the sites' real icons (Google showed a grey circle).

## 1.1.1 — 2026-11-20
- The sidebar no longer opens when unfolding a site in the history list or picking an @ command — only when a page actually opens.

## 1.1.0 — 2026-11-20
- New window: the first Enter in the Command Bar or New Tab (a search, an address or a picked result) also opens the sidebar in that window. Once per window, so closing it yourself is respected.

## 1.0.8 — 2026-11-20
- Favorites no longer blink when switching tabs: tiles are updated in place instead of being redrawn with fresh icons.

## 1.0.7 — 2026-11-20
- Light versions of dark icons no longer flash dark when the sidebar redraws (e.g. switching between Favorites).

## 1.0.6 — 2026-11-20
- Light versions of dark icons now show in the sidebar too (open Favorites and tabs kept the dark original).

## 1.0.5 — 2026-11-20
- Dark icons that come straight from the site (not from Chrome's icon cache), like TIDAL's, are now turned light in dark mode too.

## 1.0.4 — 2026-11-20
- New Tab opened by another extension into its own tab group (e.g. Claude in Chrome) is no longer swapped for a copy, so that extension keeps its tab. This was the real cause of the Claude in Chrome problem.
- Dark site icons (TIDAL, GitHub…) show light in dark mode, in the sidebar and the Command Bar; Favorites that aren't open are less faded.
- No more darker band on the active tab when hovering other parts of the sidebar.
- A tab in a call keeps its speaker button in quiet moments.

## 1.0.3 — 2026-11-20
- Same for a window another extension opens: its tab is no longer grouped into a Space before that extension groups it.

## 1.0.2 — 2026-11-20
- Tabs that another extension puts into its own tab group (e.g. Claude in Chrome) stay in that group instead of being pulled into the current Space.

## 1.0.1 — 2026-11-20
- Icon: the violet orb now fills the whole icon, without the soft glow around it.

## 1.0.0 — 2026-11-20 · Atrium, first public release
- New name: **Atrium — Vertical Tabs, Spaces & Sidebar**.
- Incognito proxy and the Google country / language panel are switched off for now (they come back in a later version); the extension no longer asks for the proxy and network-request permissions.
- Fewer permissions: no unlimited storage.
- @ commands use the sites' own icons for GitHub and ChatGPT.
- Privacy policy, third-party notices, store texts.

## 0.8.7 — 2026-11-20
- Sharing a whole window or screen in a call: the red dot shows on the call's tab (there's no single presented tab to mark).

## 0.8.6 — 2026-11-20
- Red dot on the presented tab now works for any call site (Zoom, Teams, Telemost, Slack, Discord…), not only Google Meet.

## 0.8.5 — 2026-11-20
- Favorites: a tile shows the green call dot and the red presenting dot too (e.g. Google Meet kept as a Favorite).

## 0.8.4 — 2026-11-20
- “Plain icons in Chrome’s tab strip” is now on by default (it can still be turned off in Settings).

## 0.8.3 — 2026-11-20
- Favorites no longer duplicate after a browser restart (pinned tabs Chrome was still restoring were taken for new Favorites); duplicates left from before are merged.
- Favorites and Pinned tabs opened in a second window: clicking again reuses that window's tab instead of opening a new one each time.

## 0.8.2 — 2026-11-20
- Command Bar and New Tab: real site icons again with plain icons on (a site typed as linkedin.com now finds the icon remembered for www.linkedin.com instead of a grey circle).

## 0.8.1 — 2026-11-20
- Player: silent decorative videos (muted, no controls, e.g. animated page backgrounds) no longer show up in the sidebar player.

## 0.8.0 — 2026-11-19 · Several windows, shortcuts, settings
- **Several windows:** a Space's tabs from other windows show in the same list, grey, with a small window badge; the order is the same in every window. Clicking a grey tab moves the tab itself into this window, without reloading.
- **Closing a window** reopens its tabs in the remaining windows, each in the window where its Space is open, in the same place in the list.
- Floating picture-in-picture windows (Meet's call video) are ignored.
- **Shortcuts:** one scheme, ⌥⇧ + the action's letter (sidebar ⌥⇧Space, Command Bar ⌥⇧K, Spaces ⌥⇧. / ⌥⇧,, plus 16 assignable actions). They also work on the Russian and other non-Latin keyboard layouts.
- **Settings** (gear, bottom right): sleeping tabs, morning reset, focus sites, Incognito proxy, plain icons, shortcuts, setup guide. The “⋯” menu next to a Space keeps only that Space's actions, plus “Close copies from other windows”.
- **Plain icons in Chrome's tab strip** (setting): every page shows the same neutral circle there; the sidebar keeps real icons.
- **Calls:** a green dot on a tab that's in a call (camera or microphone in use), on any call site; microphone and camera buttons in the player for Meet, Zoom, Teams, Telemost and others.
- Tab tree: a tab is nested only when another page really opened it (not links from other apps or ⌘T).
- Opening something from the Command Bar, Pinned or Favorites stays in the current window.
- Dragging a tab out of the sidebar moves it into a new window.

## 0.7.0 — 2026-11-18 · Google in Incognito, proxy, loading
- **Google results in Incognito:** a panel to search as from another country (gl, 249 countries, the largest economies first), city (uule) and language (hl, 144 languages, the most used first). Defaults to United States / English. Full-page screenshot of the results.
- **Incognito proxy:** free public proxies by country or your own (HTTP / HTTPS / SOCKS5), Incognito windows only. Automatic switch to the next free proxy when a page can't load; a proxy panel on the toolbar icon in Incognito; a warning when Spaces isn't allowed in Incognito yet.
- Loading indicators: the Command Bar shows “Opening…” right after Enter; tabs in the sidebar show a spinning ring from the very start of loading.
- Today: newest tabs on top, New Tab button above the list; an empty New Tab takes the button's place.
- Focus: tabs opened during focus stay visible.

## 0.6.0 — 2026-11-17 · Focus, screenshots, Incognito, New Tab
- **Focus mode:** Pomodoro (25 + 5 min) or a fixed time, started from the tomato in the bottom-left corner with a progress ring; about 100 distracting sites paused while focusing (open one for 1 minute), other tabs folded, site icons in black and white, notifications between phases.
- **Screenshots:** a camera on each tab: visible screen, an area (movable, with Copy / Save next to it) or the whole page; copy or save as .png.
- **Incognito:** open a tab's page in Incognito; a violet frame and label on private pages.
- **Tab tree** in Today, with folding.
- **New Tab and Command Bar:** your history day by day, folded by site, loaded as you scroll; the list grows as you scroll; hover buttons on results (screenshot, Incognito, copy, close, remove from history); ⇧-click or ⇧↵ for a quick look in Peek; @ commands to search Google, AI Mode, Perplexity, YouTube, Maps, GitHub, ChatGPT, Claude and Translate.
- **Pinned:** every morning, open Pinned tabs and Favorites go back to their pinned pages; a softer check of whether a tab has moved away (query and #hash ignored); empty Pinned area can be hidden.
- Tooltips with the full title and useful details (site, last viewed, asleep, playing).

## 0.5.0 — 2026-11-17 · Peek, undo, copy
- **Peek:** a link opens in a card over the current page (works in full screen): ⇧-click, links a site opens in a new tab, and links to other sites from Favorites and Pinned. “Open in Space” with a Space picker.
- **Undo** chip after closing tabs.
- Copy link; ⌘-click copies it as Markdown.
- Native tooltips explaining the controls.

## 0.4.0 — 2026-11-16 · Media and sleeping tabs
- **Mini player** in the sidebar: what's playing in any tab, with play / pause, next / previous and mute (YouTube, Tidal and others).
- **Sleeping tabs:** other Spaces' tabs are unloaded from memory after a set time.
- Google Meet: a red dot on the tab being presented.
- Chrome's own tab groups for other Spaces stay collapsed.

## 0.3.0 — 2026-11-16 · Today tools and Command Bar
- Today sorting: manual, by domain (grouped), by title, recent.
- Clean up: close tabs unused for a week, choosing which.
- ⌘-click duplicates a tab.
- Command Bar on the New Tab page with inline site completion (your top sites, then 2,000 popular sites).
- Interface in English.

## 0.2.0 — 2026-11-14 · Look and feel
- iOS 26 / Arc-style design with neutral colours; the sidebar background is pastel paper tinted with the Space colour.
- Phosphor icons for Spaces and folders; the Orb extension icon.
- Space bar: the current Space's icon and small dots for the others; instant switching by swiping.

## 0.1.0 — 2026-11-14 · First version
- Spaces as Chrome tab groups, switched in the sidebar (Chrome's side panel next to its vertical tabs).
- Favorites shared by all Spaces, Pinned tabs with folders per Space, Today for everything else.
- Drag and drop between Favorites, Pinned, Today and Spaces.
- Setup guide.
