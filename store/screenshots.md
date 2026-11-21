# Store screenshots

The store wants 1–5 screenshots, **1280×800** (or 640×400), PNG or JPEG. Real ones from your Chrome, dark or light,
same theme for all five. Close tabs with private things (mail, banking) before shooting.

## The five shots
1. **Sidebar with Spaces** — a Space with Favorites, a couple of Pinned folders, Today with a tab tree and one split-view pair.
2. **New Tab / Command Bar** — history by day, and `@yt` or `@ai` typed in the field.
3. **Peek** — a link Shift-clicked open in the card over a page.
4. **Focus** — the tomato running, a paused site's card on the page, “N tabs hidden” in the sidebar.
5. **Screenshots or the player** — the screenshot bar over a page, or the mini player with music and a call.

## Making them exactly 1280×800
1. Set the Chrome window to 1280×800:
   `osascript -e 'tell application "Google Chrome" to set bounds of front window to {0, 25, 1280, 825}'`
2. Take the window: ⌘⇧4, then Space, then click the Chrome window (hold ⌥ while clicking to drop the shadow).
3. On a Retina screen the file is 2560×1600; bring it down:
   `sips -z 800 1280 ~/Desktop/Screenshot*.png --out ~/Desktop/atrium-1.png` (one file at a time)
4. Check: `sips -g pixelWidth -g pixelHeight ~/Desktop/atrium-1.png` → 1280 × 800.

Promo images (already made): `store/promo/tile-440x280.png` (small tile, required) and
`store/promo/marquee-1400x560.png` (marquee, optional). Sources: `tile.html`, `marquee.html`.
