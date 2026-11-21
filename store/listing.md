# Chrome Web Store listing — Atrium 1.0

Copy each block into the matching field of the developer dashboard.

## Store listing tab

**Title** (from manifest.json, 40/75 chars)
```
Atrium — Vertical Tabs, Spaces & Sidebar
```

**Summary** (from manifest.json, 125/132 chars)
```
Spaces for Chrome’s vertical tabs: Favorites, Pinned tabs, a Command Bar, Peek, focus mode and screenshots in the side panel.
```

**Category:** Productivity → Tools (or Workflow & Planning)
**Language:** English

**Description**
```
Atrium turns Chrome's side panel into a calm home for your tabs. Organise vertical tabs into Spaces for work, home and projects, keep Favorites and Pinned tabs that never get lost, and find anything with a Command Bar — all inside Chrome, next to its own vertical tabs. Inspired by modern browsers like Arc, made for people who want that workflow without switching browsers.

SPACES
• One Space per part of your life, each with its own colour, icon and tabs. Switch with a click, a swipe or ⌥⇧1–9.
• Spaces are Chrome's own tab groups, so nothing is hidden from Chrome and your tabs survive a restart.
• Several windows: a Space's tabs from other windows show in the same list, and closing a window moves its tabs to the windows you keep.

FAVORITES, PINNED AND TODAY
• Favorites: your most-used sites as tiles at the top, shared by every Space.
• Pinned: a Space's permanent tabs, in folders. Closing one doesn't remove it; every morning they go back to their pinned page.
• Today: everything else, newest first, as a tree of which tab opened which. Drag tabs into your own order, sort by site or title, clean up tabs you haven't used for a week, undo closing.
• Split view: drop one tab onto another to open them side by side (Chrome 155+); the pair stays together in the list.
• Drag a tab out of the sidebar to open it in its own window.

COMMAND BAR AND NEW TAB
• Search open tabs, Spaces, bookmarks and history from the New Tab page, the Search button or ⌥⇧K.
• Your history day by day, grouped by site.
• @ commands: search Google, AI Mode, Perplexity, YouTube, Maps, GitHub, ChatGPT, Claude or Translate right from the bar.

PEEK
• Shift-click a link to preview it in a card over the page, then keep it as a tab or close it.

FOCUS MODE
• A Pomodoro timer (25 + 5 minutes) in the sidebar. While you focus, about 100 distracting sites are covered by a calm card (edit the list), older tabs fold away and new ones stay in view. A chime tells you when to take a break, and the next round starts when you're ready.

MORE
• Screenshots of the screen, an area or the whole page — copy or save as PNG.
• A mini player for whatever plays in any tab, plus microphone and camera buttons for calls; a dot shows which tab is in a call or being shared.
• Sleeping tabs free memory in Spaces you aren't using.
• Open any page in Incognito in one click.
• Keyboard shortcuts that work on any keyboard layout.
• Plain icons in Chrome's tab strip, so your eye stays on the sidebar.

PRIVATE BY DESIGN
No account, no server, no analytics, no ads. Everything stays in your browser.

Atrium is an independent project and is not affiliated with Google or with any browser maker.
```

**Official URL / Homepage:** https://pashaeye.github.io/atrium/
**Support URL:** https://github.com/pashaeye/atrium/issues

## Graphics (to make)
- Icon 128×128: icons/icon-128.png
- Screenshots 1280×800 (1–5): sidebar with Spaces; New Tab with history and @; Peek over a page; focus mode; screenshot tool / player.
- Small promo tile 440×280. Marquee 1400×560 optional.

## Privacy practices tab

**Single purpose**
```
Atrium organises the browser's tabs into Spaces in Chrome's side panel, with Favorites, Pinned tabs and a Command Bar to find and open tabs, history and bookmarks. Every feature (Peek, focus mode, screenshots, the media player, Incognito) works on the user's tabs inside that sidebar workflow.
```

**Permission justifications**

| Permission | Justification |
|---|---|
| tabs | Lists, opens, moves, closes and switches tabs in the sidebar; reads tab titles and URLs to show them and to keep Favorites and Pinned tabs linked to their tabs. |
| tabGroups | Each Space is a Chrome tab group; the extension creates, renames, colours, collapses and moves groups when you switch Spaces. |
| sidePanel | The whole interface is a side panel. |
| storage | Saves your Spaces, Favorites, Pinned tabs and settings locally. |
| history | Shows your history in the Command Bar and on the New Tab page, and removes pages from history when you click “Remove from history”. |
| bookmarks | Finds bookmarks in Command Bar search. |
| search | Runs a Command Bar search with your default search engine. |
| favicon | Shows site icons in the sidebar and Command Bar from Chrome's own favicon cache. |
| topSites | Puts your most visited sites first in Command Bar autocomplete. |
| alarms | Runs the focus timer, puts unused tabs to sleep and runs the morning reset of Pinned tabs on schedule. |
| sessions | Restores tabs you just closed (Undo). |
| declarativeNetRequestWithHostAccess | Lets a link open inside the Peek preview card when you ask for it (removes the page's frame-blocking header for that one preview). |
| notifications | Tells you when a focus or break phase ends, and reports when a screenshot or copy can't be done. |
| scripting | Injects the screenshot tool, the Command Bar card and the copy-link action into the current tab when you use them. |
| webNavigation | Knows which tab opened which (tab tree) and shows a loading ring as soon as a tab starts loading. |
| Host permission <all_urls> | Content scripts on pages you open: cover the sites you chose to pause during focus mode, accept a tab dragged out of the sidebar onto the page (it opens in a new window), detect playing media and calls for the sidebar player, open links in Peek, take screenshots (captureVisibleTab), show the Incognito frame, plain tab icons, and keyboard shortcuts that work on any keyboard layout. No page content is collected or sent. |
| Remote code | No. All code is in the package. |

**Data usage** — tick:
- Web history: **yes** (read locally to show it in the Command Bar; never leaves the device).
- Website content: **no**. Personally identifiable info, health, financial, authentication, personal communications, location, user activity: **no**.

Certify all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://pashaeye.github.io/atrium/privacy.html

## Distribution
Public · all regions · free.
