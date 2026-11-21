// Shared helpers for the background worker and the extension pages.

export const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

export const COLOR_HEX = {
  grey: '#80868b', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038',
  pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e',
};

/** Title of the Chrome tab group that represents a Space. Used to re-match groups after a restart. */
export const spaceTitle = (s) => (s.emoji ? `${s.emoji} ${s.name}` : s.name);

/** Favicon for any URL via the extension `_favicon` endpoint (works for closed tabs too). */
export function favicon(pageUrl, size = 32) {
  if (!pageUrl) return '';
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', String(size));
  return u.toString();
}

/** Same page, ignoring the #hash. */
export function sameUrl(a, b) {
  if (!a || !b) return false;
  return a.split('#')[0] === b.split('#')[0];
}

/**
 * Same page for Pinned / Favorites: same site and path. Ignores www., a trailing slash, the ?query and the
 * #hash, which sites often add on their own (tracking, filters, sessions), so they don't count as "moved".
 */
export function samePage(a, b) {
  if (!a || !b) return false;
  try {
    const x = new URL(a), y = new URL(b);
    const host = (u) => u.hostname.replace(/^www\./, '');
    const path = (u) => u.pathname.replace(/\/+$/, '') || '/';
    return x.protocol.replace('http:', 'https:') === y.protocol.replace('http:', 'https:') && host(x) === host(y) && path(x) === path(y);
  } catch {
    return sameUrl(a, b);
  }
}

/**
 * A site's remembered real icon (see plain-icons.js): by host, with or without "www." (linkedin.com finds
 * the one remembered for www.linkedin.com). '' when unknown. Other subdomains don't count: mail.google.com's
 * icon isn't google.com's.
 */
export function realIconFor(icons, pageUrl) {
  if (!icons || !pageUrl) return '';
  let host;
  try { host = new URL(pageUrl).hostname; } catch { return ''; }
  const bare = host.replace(/^www\./, '');
  return icons[host] || icons[bare] || icons[`www.${bare}`] || '';
}

/** Message to the background worker; resolves with its reply or throws its error. */
export async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (res && res.error) throw new Error(res.error);
  return res?.result;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Small fuzzy matcher: 0 = no match, higher = better. Substring hits beat scattered letters. */
export function fuzzy(query, text) {
  if (!text) return 0;
  const q = query.toLowerCase().trim();
  const s = text.toLowerCase();
  if (!q) return 1;
  const idx = s.indexOf(q);
  if (idx >= 0) {
    const wordStart = idx === 0 || /[\s\-_/.:]/.test(s[idx - 1]);
    return 100 - Math.min(idx, 40) + (wordStart ? 25 : 0);
  }
  let si = 0, score = 0, streak = 0;
  for (const c of q) {
    if (c === ' ') continue;
    const f = s.indexOf(c, si);
    if (f < 0) return 0;
    streak = f === si ? streak + 1 : 0;
    score += 1 + streak;
    si = f + 1;
  }
  return Math.min(60, score * 2);
}

export function looksLikeUrl(q) {
  const t = q.trim();
  if (!t || /\s/.test(t)) return false;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^localhost(:\d+)?(\/|$)/i.test(t) || /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t);
}

export function normalizeUrl(q) {
  const t = q.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(chrome|about|file):/i.test(t) ? t : `https://${t}`;
}

// Dark site icons (TIDAL, GitHub, X…) disappear on a dark background: in dark mode they get class "inv"
// (shown inverted, see ui.css). An <img> from another site can't be read, so its file is fetched again
// (the extension may read any site) and measured from that.
const darkIcon = new Map(); // src → Promise<boolean>
const darkKnown = new Map(); // src → boolean, once measured
function measureDark(source) {
  const n = 16, c = new OffscreenCanvas(n, n), x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(source, 0, 0, n, n);
  const d = x.getImageData(0, 0, n, n).data;
  let sum = 0, seen = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    seen++;
  }
  return seen > n * n * 0.08 && sum / seen < 0.2;
}
function isDarkIcon(img) {
  const src = img.currentSrc || img.src;
  if (!darkIcon.has(src)) {
    darkIcon.set(src, (async () => {
      let dark = false;
      try { dark = measureDark(img); } catch {
        // another site's image
        try {
          const blob = await (await fetch(src, { credentials: 'omit' })).blob();
          dark = measureDark(await createImageBitmap(blob));
        } catch { /* unreadable */ }
      }
      darkKnown.set(src, dark);
      return dark;
    })());
  }
  return darkIcon.get(src);
}
/** Marks dark icons matching `selector` as they load. */
export function watchDarkIcons(selector) {
  const darkMode = matchMedia('(prefers-color-scheme: dark)');
  // Re-rendered icons whose answer is known get the class before they're painted (no dark flash).
  new MutationObserver((records) => {
    if (!darkMode.matches) return;
    for (const r of records) for (const node of r.addedNodes) {
      if (node.nodeType !== 1) continue;
      for (const img of node.matches?.(selector) ? [node] : node.querySelectorAll(selector)) {
        if (darkKnown.get(img.getAttribute('src') ? img.src : '')) img.classList.add('inv');
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  // Switching between light and dark mode: icons already on screen follow.
  darkMode.addEventListener('change', () => {
    for (const img of document.querySelectorAll(selector)) img.classList.toggle('inv', darkMode.matches && !!darkKnown.get(img.src));
  });
  document.addEventListener('load', async (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.matches(selector)) return;
    img.classList.toggle('inv', darkMode.matches && (await isDarkIcon(img)));
  }, true);
}
