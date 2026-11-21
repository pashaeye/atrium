// Command Bar: used both as a small popup window (command.html?win=<browser window id>) and as the New Tab page (newtab.html).
import { COLOR_HEX, favicon, send, esc, fuzzy, looksLikeUrl, normalizeUrl, spaceTitle, realIconFor, watchDarkIcons } from './shared.js';
import { POPULAR } from './popular.js';
import { icon } from './icons.js';
import { incognitoGate } from './ui.js';

watchDarkIcons('.ico img, .chip img');

const IS_NEWTAB = document.body.classList.contains('newtab');
// command.html?overlay=1: shown in a card over a web page (cmd-overlay.js) instead of in its own window.
const IS_OVERLAY = !IS_NEWTAB && new URLSearchParams(location.search).has('overlay');
if (IS_OVERLAY) { document.body.classList.remove('popup'); document.body.classList.add('overlay'); }
const toParent = ({ kind, h }) => window.parent.postMessage({ __spacesCmd: kind, h }, '*');
const input = document.getElementById('q');
const list = document.getElementById('list');
const ghost = document.getElementById('ghost');
// Plain line icons: the magnifier for the field and "Search the web", an arrow for "Open address".
const SEARCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 20 20"/></svg>';
const GO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';
document.querySelector('.cb-ico').innerHTML = SEARCH_SVG;

let windowId, selfTab = null, activeTab = null, targetTab = null;
let idx = null, tabs = [];
let results = [], sel = 0, seq = 0;

// Sites' real icons, remembered while Chrome's tab strip shows plain circles (see plain-icons.js).
let realIcons = {};
chrome.storage.local.get('realIcons').then((r) => { realIcons = r.realIcons || {}; }, () => {});
const siteIcon = (u) => realIconFor(realIcons, u) || favicon(u);
// @ commands and the site completion (your top sites, popular sites): the site's own icon. Chrome's icon
// cache can't be trusted here (with plain tab icons it may hold the grey circle), so fall back to the
// site's /favicon.ico.
const ownSiteIcon = (home) => realIconFor(realIcons, home) || new URL('/favicon.ico', home).href;
const isNewTabUrl = (u) => !u || u === 'chrome://newtab/' || u.startsWith(chrome.runtime.getURL('newtab.html'));
const spaceById = (id) => idx.spaces.find((s) => s.id === id);

// ---------- actions ----------
function finish() {
  if (IS_OVERLAY) toParent({ kind: 'close' });
  else if (!IS_NEWTAB) window.close();
}
// The popup window disappears as soon as the user clicks back into the browser.
if (!IS_NEWTAB && !IS_OVERLAY) addEventListener('blur', () => window.close());
/** After jumping to an existing tab, drop the empty New Tab we came from. */
async function dropTargetTab() {
  if (targetTab) await chrome.tabs.remove(targetTab.id).catch(() => {});
}

/** Tell the sidebar right away that this tab is about to load (Chrome only says so once the site answers). */
const announce = (tabId) => chrome.runtime.sendMessage({ type: 'tabOpening', tabId }).catch(() => {});

async function openUrl(url, inNewTab) {
  if (targetTab && !inNewTab) { announce(targetTab.id); await chrome.tabs.update(targetTab.id, { url }); }
  else await send('newTab', { windowId, url });
  finish();
}
async function search(text, inNewTab) {
  if (targetTab && !inNewTab) { announce(targetTab.id); await chrome.search.query({ text, tabId: targetTab.id }); }
  else await chrome.search.query({ text, disposition: 'NEW_TAB' });
  finish();
}
async function jump(type, payload) {
  await send(type, { windowId, ...payload });
  await dropTargetTab();
  finish();
}

// ---------- results ----------
const W = { tab: 1.2, fav: 1.15, item: 1.1, space: 1.1, action: 1.0, bookmark: 0.9, history: 0.85 };
const TAG = { scope: '@', site: 'Site', tab: 'Tab', fav: 'Favorite', item: 'Pinned', space: 'Space', action: 'Action', bookmark: 'Bookmark', history: 'History' };

function scoreOf(q, title, url) {
  return Math.max(fuzzy(q, title), url ? fuzzy(q, url.replace(/^https?:\/\/(www\.)?/, '')) * 0.8 : 0);
}

function localResults(q) {
  const out = [];
  const add = (r, score) => { if (score > 0) out.push({ ...r, score: score * W[r.type] }); };

  for (const t of tabs) {
    if (t.id === selfTab?.id || (targetTab && t.id === targetTab.id)) continue;
    // Only this window's tabs: picking a page that's open in another window shouldn't throw you over there.
    if (t.windowId !== windowId) continue;
    const sp = spaceById(idx.tabSpace[t.id]);
    const url = t.url || t.pendingUrl || '';
    add({
      type: 'tab', tabId: t.id, title: t.title || url, sub: sp ? spaceTitle(sp) : t.pinned ? 'Favorites' : url, url,
      // (the plain circle Chrome's tab strip may show isn't the site's icon)
      icon: t.favIconUrl && /^(https?|data):/.test(t.favIconUrl) && !/data-spaces%3D%22plain/.test(t.favIconUrl) ? t.favIconUrl : siteIcon(url),
      run: () => jump('activateTab', { tabId: t.id }),
      recency: t.lastAccessed ?? 0,
    }, q ? scoreOf(q, t.title, url) : 1);
  }
  if (!q) return out.sort((a, b) => b.recency - a.recency).slice(0, 8);

  const openTabIds = new Set(tabs.filter((t) => t.windowId === windowId).map((t) => t.id)); // listed as Tab rows
  for (const f of idx.favorites) {
    if (f.tabId != null && openTabIds.has(f.tabId)) continue; // already listed as a tab
    add({ type: 'fav', title: f.title || f.url, sub: f.url, url: f.url, icon: siteIcon(f.url), run: () => jump('openFavorite', { favId: f.id }) }, scoreOf(q, f.title, f.url));
  }
  for (const p of idx.pinned) {
    if (p.tabId != null && openTabIds.has(p.tabId)) continue;
    const sp = spaceById(p.spaceId);
    add({ type: 'item', title: p.title || p.url, sub: sp ? spaceTitle(sp) : p.url, url: p.url, icon: siteIcon(p.url), run: () => jump('openItem', { itemId: p.id }) }, scoreOf(q, p.title, p.url));
  }
  for (const s of idx.spaces) {
    if (s.id === idx.activeSpaceId) continue;
    add({ type: 'space', title: spaceTitle(s), sub: 'Switch to Space', dot: COLOR_HEX[s.color], run: () => jump('switchSpace', { spaceId: s.id }) }, fuzzy(q, s.name));
  }

  const actions = [
    { title: `New Space “${q}”`, run: async () => { await send('createSpace', { windowId, name: q }); await dropTargetTab(); finish(); }, always: true },
  ];
  if (activeTab && !targetTab) {
    actions.push(
      { title: 'Copy link of current tab', run: async () => { await navigator.clipboard.writeText(activeTab.url || ''); finish(); } },
      { title: 'Close current tab', run: async () => { await chrome.tabs.remove(activeTab.id); finish(); } },
      { title: 'Pin current tab', run: async () => { await send('pinTab', { windowId, tabId: activeTab.id }); finish(); } },
      { title: 'Add current tab to Favorites', run: async () => { await send('addFavorite', { windowId, tabId: activeTab.id }); finish(); } },
      ...idx.spaces.filter((s) => s.id !== idx.activeSpaceId).map((s) => ({
        title: `Move tab to ${spaceTitle(s)}`,
        run: async () => { await send('moveTabToSpace', { windowId, tabId: activeTab.id, spaceId: s.id }); finish(); },
      })),
    );
  }
  actions.push({ title: 'Open sidebar', run: async () => { await chrome.sidePanel.open({ windowId }); finish(); } });
  for (const a of actions) {
    const score = a.always ? 30 : fuzzy(q, a.title);
    add({ type: 'action', title: a.title, sub: '', icon: null, glyph: '⚡', run: a.run }, score);
  }
  return out;
}

async function remoteResults(q) {
  if (!q) return [];
  const [bookmarks, history] = await Promise.all([
    chrome.bookmarks.search(q).catch(() => []),
    chrome.history.search({ text: q, maxResults: 25, startTime: 0 }).catch(() => []),
  ]);
  const out = [];
  const seen = new Set(tabs.filter((t) => t.windowId === windowId).map((t) => (t.url || '').split('#')[0]));
  const push = (type, title, url) => {
    const key = url.split('#')[0];
    if (!url || seen.has(key)) return;
    seen.add(key);
    const score = scoreOf(q, title, url);
    if (score > 0) out.push({ type, title: title || url, sub: url, url, icon: siteIcon(url), score: score * W[type], run: (newTab) => openUrl(url, newTab) });
  };
  for (const b of bookmarks.slice(0, 15)) if (b.url) push('bookmark', b.title, b.url);
  for (const h of history) push('history', h.title, h.url);
  return out;
}

// ---------- inline site autocomplete ----------
// Typing the start of a site name ("yo") completes it in grey ("utube.com"); Tab or → accepts it and
// Enter opens the site. Your own most visited sites (chrome.topSites) come first, then popular ones.
let siteList = POPULAR;
let completion = null;     // { domain, rest } for the current input, or null
let suppressComplete = false; // true right after Backspace/Delete, like a browser address bar

const bareHost = (s) => s.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
function findCompletion(raw) {
  if (suppressComplete || !raw || /\s/.test(raw) || raw.includes('/')) return null;
  const t = bareHost(raw);
  if (!t) return null;
  const domain = siteList.find((d) => d.startsWith(t));
  return domain ? { domain, rest: domain.slice(t.length) } : null;
}
function paintGhost() {
  const v = input.value;
  ghost.innerHTML = completion && completion.rest && input.selectionStart === v.length
    ? `<span class="typed">${esc(v)}</span><span class="rest">${esc(completion.rest)}</span>`
    : '';
}
function acceptCompletion() {
  if (!completion?.rest) return false;
  input.value += completion.rest;
  completion = { ...completion, rest: '' };
  paintGhost();
  update();
  return true;
}
function siteRow() {
  if (!completion) return null;
  const url = `https://${completion.domain}/`;
  return { type: 'site', title: completion.domain, sub: 'Open site', icon: ownSiteIcon(url), score: Infinity, run: (newTab) => openUrl(url, newTab) };
}

function topRow(q) {
  if (!q) return null;
  if (looksLikeUrl(q)) {
    const url = normalizeUrl(q);
    return { type: 'go', title: url, sub: 'Open address', svg: GO_SVG, score: Infinity, run: (newTab) => openUrl(url, newTab) };
  }
  return { type: 'go', title: q, sub: 'Search the web', svg: SEARCH_SVG, score: Infinity, run: (newTab) => search(q, newTab) };
}

function compose(q, local, remote) {
  const ranked = [...local, ...remote].sort((a, b) => b.score - a.score).slice(0, 12);
  const top = topRow(q);
  if (!top) return ranked;
  const site = siteRow();
  if (site) return [site, top, ...ranked.filter((r) => r.url?.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') !== completion.domain)];
  // A strong title hit (e.g. typing the start of an open tab's name) goes above "search the web".
  return ranked[0] && ranked[0].score >= 125 ? [ranked[0], top, ...ranked.slice(1)] : [top, ...ranked];
}

// ---------- history feed: with an empty field, recent tabs and then your history, day by day ----------
// More is loaded as you scroll down (or arrow past the end).
const FEED_PAGE = 60;
let feed = [], feedEnd = Date.now(), feedDone = false, feedLoading = null, recent = [];
const ownPage = (u) => !u || u.startsWith(chrome.runtime.getURL('')) || u.startsWith('chrome://newtab');
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const pathOf = (u) => { try { const x = new URL(u); return decodeURI(x.pathname + x.search) || '/'; } catch { return u; } };

function loadFeed() {
  if (feedDone) return Promise.resolve(false);
  feedLoading ??= (async () => {
    try {
      const items = await chrome.history.search({ text: '', startTime: 0, endTime: feedEnd, maxResults: FEED_PAGE });
      if (items.length < FEED_PAGE) feedDone = true;
      const before = feedEnd;
      const known = new Set(feed.map((f) => f.url));
      for (const h of items) {
        const at = h.lastVisitTime ?? 0;
        if (at && at < feedEnd) feedEnd = at - 1;
        if (ownPage(h.url) || known.has(h.url)) continue;
        known.add(h.url);
        feed.push({
          type: 'history', feed: true, title: h.title || h.url, sub: hostOf(h.url), url: h.url, icon: siteIcon(h.url),
          at: Math.min(at || before, before), run: (newTab) => openUrl(h.url, newTab),
        });
      }
      // Pages visited again later keep their newest time; don't get stuck on them.
      if (feedEnd >= before && !feedDone) feedEnd = before - 3600e3;
      return true;
    } catch (e) {
      console.warn('[spaces] history feed', e);
      feedDone = true;
      return false;
    } finally {
      feedLoading = null;
    }
  })();
  return feedLoading;
}

// Within a day, pages of the same site fold into one row ("github.com · 12 pages") at the place of the
// latest visit. Click it (or Enter) to unfold; the pages show under it, indented. A site with one page
// that day is a normal row.
const unfolded = new Set(); // "day|host" of unfolded groups
function feedRows() {
  const out = [];
  const byDay = new Map();
  for (const f of feed) {
    const day = dayLabel(f.at);
    if (!byDay.has(day)) byDay.set(day, new Map());
    const hosts = byDay.get(day);
    if (!hosts.has(f.sub)) hosts.set(f.sub, []);
    hosts.get(f.sub).push(f);
  }
  for (const [day, hosts] of byDay) {
    for (const [host, pages] of hosts) {
      if (pages.length === 1) { out.push(pages[0]); continue; }
      const key = `${day}|${host}`;
      const open = unfolded.has(key);
      out.push({
        type: 'history', feed: true, group: true, open, key, pages, at: pages[0].at,
        title: host, sub: `${pages.length} pages`, icon: pages[0].icon,
        run: () => toggleGroup(key),
      });
      // Under its site row a page shows its path instead of repeating the site.
      if (open) out.push(...pages.map((p) => ({ ...p, child: true, sub: pathOf(p.url) })));
    }
  }
  return out;
}

function toggleGroup(key) {
  unfolded.has(key) ? unfolded.delete(key) : unfolded.add(key);
  const at = results.findIndex((r) => r.key === key);
  results = [...recent, ...feedRows()];
  const now = results.findIndex((r) => r.key === key);
  sel = now >= 0 ? now : Math.max(0, Math.min(at, results.length - 1));
  render({ keepScroll: list.scrollTop });
  input.focus();
}

async function moreFeed() {
  if (input.value.trim() || feedDone) return;
  const top = list.scrollTop;
  if (!(await loadFeed()) || input.value.trim()) return;
  results = [...recent, ...feedRows()];
  render({ keepScroll: top });
}

const dayLabel = (t) => {
  const d = new Date(t), today = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(today) - day(d)) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
};
const timeLabel = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// ---------- @ commands: search a service ----------
// Type "@" for the list; "@yt" + Tab or space turns into a chip at the start of the field, then type the
// query. Enter searches (⌘↵ in a new tab, ⇧↵ in Peek on the New Tab page). Backspace on an empty field
// removes the chip.
const SCOPES = [
  { key: 'g', name: 'Google', alias: ['g', 'google'], kind: 'engine', home: 'https://www.google.com/', url: 'https://www.google.com/search?q=%s' },
  { key: 'ai', name: 'Google AI Mode', alias: ['ai', 'aimode'], kind: 'engine', home: 'https://www.google.com/', url: 'https://www.google.com/search?udm=50&q=%s' },
  { key: 'p', name: 'Perplexity', alias: ['p', 'pplx', 'perplexity'], kind: 'engine', home: 'https://www.perplexity.ai/', url: 'https://www.perplexity.ai/search?q=%s' },
  { key: 'yt', name: 'YouTube', alias: ['yt', 'youtube'], kind: 'engine', home: 'https://www.youtube.com/', url: 'https://www.youtube.com/results?search_query=%s' },
  { key: 'maps', name: 'Google Maps', alias: ['maps', 'map', 'm'], kind: 'engine', home: 'https://www.google.com/maps', url: 'https://www.google.com/maps/search/%s' },
  { key: 'gh', name: 'GitHub', alias: ['gh', 'github'], kind: 'engine', home: 'https://github.com/', url: 'https://github.com/search?q=%s&type=repositories' },
  { key: 'chat', name: 'ChatGPT', alias: ['chat', 'chatgpt', 'gpt'], kind: 'engine', home: 'https://chatgpt.com/', url: 'https://chatgpt.com/?q=%s' },
  { key: 'claude', name: 'Claude', alias: ['claude'], kind: 'engine', home: 'https://claude.ai/', url: 'https://claude.ai/new?q=%s' },
  { key: 'tr', name: 'Google Translate', alias: ['tr', 'translate'], kind: 'engine', home: 'https://translate.google.com/', url: 'https://translate.google.com/?sl=auto&tl=en&op=translate&text=%s' },
];
let scope = null;
const DEFAULT_PLACEHOLDER = input.placeholder;
const scopeIcon = (s) => (s.mark ? s.mark : s.kind === 'engine' ? `<img src="${esc(ownSiteIcon(s.home))}" alt="">` : `<span class="glyph">${s.svg}</span>`);
const scopeUrl = (s, q) => s.url.replace('%s', encodeURIComponent(q));

// The chip lives in the input row, before the field.
const chip = document.createElement('span');
chip.className = 'chip';
chip.hidden = true;
document.querySelector('.cb-field').before(chip);
chip.addEventListener('mousedown', (e) => { e.preventDefault(); setScope(null); });

function setScope(s, rest = '') {
  scope = s;
  chip.hidden = !s;
  chip.innerHTML = s ? `${scopeIcon(s)}<span>${esc(s.name)}</span>` : '';
  chip.title = s ? 'Click or Backspace on an empty field to remove' : '';
  input.placeholder = !s ? DEFAULT_PLACEHOLDER : s.kind === 'engine' ? `Search ${s.name}` : s.hint;
  input.value = rest;
  completion = null;
  paintGhost();
  input.focus();
  update();
}

function findScope(word) {
  const w = word.toLowerCase();
  return SCOPES.find((s) => s.alias.includes(w)) ?? null;
}
function scopeSuggestions(word) {
  const w = word.toLowerCase();
  return SCOPES
    .filter((s) => !w || s.alias.some((a) => a.startsWith(w)) || s.name.toLowerCase().startsWith(w))
    .map((s) => ({
      type: 'scope', title: `@${s.key}`, sub: s.kind === 'engine' ? `Search ${s.name}` : s.hint,
      icon: s.mark ? null : ownSiteIcon(s.home), svg: s.mark, run: () => setScope(s),
    }));
}

/** Results inside a chip: one "search" row for the service. */
async function scopedResults(q, my) {
  if (scope.kind === 'engine') {
    const s = scope;
    return q
      ? [{ type: 'go', title: q, sub: `Search ${s.name}`, url: scopeUrl(s, q), icon: s.mark ? null : ownSiteIcon(s.home), svg: s.mark, score: Infinity, run: (newTab) => openUrl(scopeUrl(s, q), newTab) }]
      : [{ type: 'go', title: `Type to search ${s.name}`, sub: '', icon: s.mark ? null : ownSiteIcon(s.home), svg: s.mark, run: () => input.focus() }];
  }
  return [];
}

async function update() {
  if (!idx) return; // still loading; init() calls update() once data is here
  const q = input.value.trim();
  const my = ++seq;
  // "@…" with no chip yet: the list of services and filters.
  if (!scope && input.value.startsWith('@')) {
    completion = null;
    paintGhost();
    results = scopeSuggestions(input.value.slice(1).trim());
    sel = 0;
    render();
    return;
  }
  if (scope) {
    completion = null;
    paintGhost();
    const rows = await scopedResults(q, my);
    if (my !== seq) return;
    results = rows;
    sel = 0;
    render();
    return;
  }
  completion = findCompletion(q);
  paintGhost();
  const local = localResults(q);
  if (!q) {
    recent = local;
    results = [...recent, ...feedRows()];
    sel = 0;
    render();
    if (!feed.length && (await loadFeed()) && my === seq) { results = [...recent, ...feedRows()]; render(); }
    return;
  }
  results = compose(q, local, []);
  sel = 0;
  render();
  const remote = await remoteResults(q);
  if (my !== seq) return;
  const keep = results[sel];
  results = compose(q, local, remote);
  sel = Math.max(0, results.indexOf(keep));
  render();
}

function rowHtml(r, i) {
  return `
    <div class="res ${i === sel ? 'sel' : ''}${r.group ? ' group' : ''}${r.group && r.open ? ' open' : ''}${r.child ? ' child' : ''}" data-i="${i}" role="option" aria-selected="${i === sel}"${r.group ? ` title="${r.open ? 'Fold' : 'Show'} the ${r.pages.length} pages from ${esc(r.title)}"` : ''}>
      <span class="ico">${r.icon ? `<img src="${esc(r.icon)}" alt="" loading="lazy">` : r.svg ? r.svg : r.dot ? `<span class="dot" style="background:${r.dot}"></span>` : esc(r.glyph || '•')}</span>
      <span class="txt"><span class="t">${esc(r.title)}</span><span class="s">${esc(r.sub || '')}</span>${r.group ? `<span class="caret">${icon('caret-right')}</span>` : ''}</span>
      <span class="tag">${esc(r.feed ? timeLabel(r.at) : TAG[r.type] || '')}</span>
      ${rowActions(r)}
    </div>`;
}

/** The whole list; history-feed rows get a day heading ("Today", "Yesterday", "Monday, 15 November"). */
function render({ keepScroll = null } = {}) {
  let lastDay = '';
  list.innerHTML = results.map((r, i) => {
    let head = '';
    if (r.feed) {
      const day = dayLabel(r.at);
      if (day !== lastDay) head = `<div class="day">${esc(day)}</div>`;
      lastDay = day;
    }
    return head + rowHtml(r, i);
  }).join('');
  if (keepScroll != null) list.scrollTop = keepScroll;
  else list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  if (IS_OVERLAY) toParent({ kind: 'height', h: document.querySelector('.cb').offsetHeight });
}

/** Move the selection without rebuilding the list (it can be long). */
function setSel(i, scroll = true) {
  if (i === sel || i < 0 || i >= results.length) return;
  list.querySelector('.res.sel')?.classList.remove('sel');
  sel = i;
  const el = list.querySelector(`.res[data-i="${i}"]`);
  el?.classList.add('sel');
  if (scroll) el?.scrollIntoView({ block: 'nearest' });
}

// ---------- row buttons (on hover / the selected row), like the sidebar's ----------
const webPage = (url) => /^(https?|file):/.test(url || '');
// Peek (a quick look in a card over this page, ⇧-click or ⇧↵) only on the New Tab page, where peek.js is loaded.
const canPeek = () => IS_NEWTAB && typeof window.__spacesPeekOpen === 'function';
const ACT = {
  shot: ['camera-line', 'Screenshot: the screen, an area or the whole page'],
  incognito: ['detective-line', 'Open in Incognito (signed out)'],
  copy: ['copy-line', 'Copy link&#10;⌘-click: copy as Markdown'],
  forget: ['trash-line', 'Remove from history'],
  forgetAll: ['trash-line', 'Remove all these pages from history'],
  close: [null, 'Close tab'],
};
function rowActions(r) {
  const acts = [];
  if (r.type === 'tab' && webPage(r.url)) acts.push('shot');
  if (['tab', 'fav', 'item', 'history', 'bookmark'].includes(r.type) && webPage(r.url)) acts.push('incognito');
  if (['tab', 'fav', 'item', 'history', 'bookmark'].includes(r.type) && r.url && !isNewTabUrl(r.url)) acts.push('copy');
  if (r.type === 'history') acts.push(r.group ? 'forgetAll' : 'forget');
  if (r.type === 'tab') acts.push('close');
  if (!acts.length) return '';
  return `<span class="acts">${acts.map((a) => `<button class="ra" data-ra="${a}" title="${ACT[a][1]}">${ACT[a][0] ? icon(ACT[a][0]) : '×'}</button>`).join('')}</span>`;
}

function markdownLink(title, url) {
  const t = (title || url).replace(/\s+/g, ' ').trim().replace(/([\[\]\\])/g, '\\$1');
  return `[${t}](${url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20')})`;
}

/** Briefly show a word in place of the row's type ("Copied"). */
function flash(i, text) {
  const tag = list.querySelector(`.res[data-i="${i}"] .tag`);
  const row = tag?.closest('.res');
  if (!row) return;
  tag.textContent = text;
  row.classList.add('flash');
  setTimeout(() => render({ keepScroll: list.scrollTop }), 1200);
}

async function rowAct(i, act, e) {
  const r = results[i];
  if (!r) return;
  try {
    if (act === 'copy') {
      const md = e.metaKey || e.ctrlKey;
      await navigator.clipboard.writeText(md ? markdownLink(r.title, r.url) : r.url);
      return flash(i, md ? 'Markdown copied' : 'Copied');
    }
    if (act === 'incognito') {
      if (!(await incognitoGate())) return;
      if (r.type === 'tab') await send('toIncognito', { windowId, tabId: r.tabId });
      else await send('openIncognito', { windowId, url: r.url });
      return finish();
    }
    if (act === 'shot') {
      await send('screenshotTab', { windowId, tabId: r.tabId });
      return finish();
    }
    if (act === 'close') {
      await send('closeTab', { windowId, tabId: r.tabId });
      tabs = tabs.filter((t) => t.id !== r.tabId);
      results.splice(i, 1);
      sel = Math.max(0, Math.min(sel, results.length - 1));
      render();
      return input.focus();
    }
    if (act === 'forget' || act === 'forgetAll') return removeFromHistory(i);
  } catch (err) {
    console.warn('[spaces] command bar', err);
    flash(i, String(err?.message || 'Didn’t work'));
  }
}

/** Forget a History result: every visit to that address is deleted from Chrome's history. */
async function removeFromHistory(i) {
  const r = results[i];
  if (r?.type !== 'history') return;
  const urls = r.group ? r.pages.map((p) => p.url) : [r.url];
  try {
    for (const url of urls) await chrome.history.deleteUrl({ url });
  } catch (e) { console.warn('[spaces] history', e); return; }
  const gone = new Set(urls);
  feed = feed.filter((f) => !gone.has(f.url));
  if (r.feed && !input.value.trim()) results = [...recent, ...feedRows()];
  else results.splice(i, 1);
  sel = Math.min(sel, results.length - 1);
  render({ keepScroll: list.scrollTop });
  input.focus();
}

function peekRow(r) {
  if (!r || r.type === 'tab' || r.group || !/^https?:/.test(r.url || '') || !canPeek()) return false;
  window.__spacesPeekOpen(r.url);
  return true;
}
// After a card closes, typing goes back to the field.
addEventListener('message', (e) => { if (e.data?.__spacesPeek === 'close') setTimeout(() => input.focus(), 0); });

// After Enter on something that opens a page: at once the field's icon turns into a spinner and the row says
// "Opening…", and further Enters are ignored. On the New Tab page this stays until the page is replaced.
let running = false;
const SPINNER = '<span class="spin" aria-hidden="true"></span>';
// The first Enter (or click on a result) in a window also opens the sidebar there: Chrome lets an extension
// open its side panel only in answer to a key press or click, and a new window has none until then.
// Once per window, so a sidebar you closed yourself stays closed. session.panelAuto = [windowId, …]
let panelAutoDone = true;
function openPanelOnce() {
  if (panelAutoDone || windowId == null) return;
  panelAutoDone = true;
  chrome.sidePanel.open({ windowId }).catch(() => {}); // must run before any await: it needs the key press
  chrome.storage.session.get('panelAuto').then(({ panelAuto = [] }) =>
    chrome.storage.session.set({ panelAuto: [...panelAuto.slice(-50), windowId] })).catch(() => {});
}

async function runSelected(newTab) {
  const r = results[sel];
  if (!r || running) return;
  const opens = !!r.url || r.type === 'go' || r.type === 'site';
  if (r.group || r.type === 'scope' || !opens) {
    try { await r.run(newTab); } catch (e) { console.error(e); }
    return;
  }
  openPanelOnce(); // only when something actually opens (not unfolding a site in history, not picking @)
  running = true;
  const row = list.querySelector(`.res[data-i="${sel}"]`);
  document.querySelector('.cb-ico').innerHTML = SPINNER;
  row?.classList.add('busy');
  const tag = row?.querySelector('.tag');
  if (tag) tag.textContent = 'Opening…';
  try {
    await r.run(newTab);
  } catch (e) {
    console.error(e);
  } finally {
    running = false;
    // Still here (e.g. the page is loading in another tab, or this tab hasn't navigated yet): keep showing
    // it for a moment, then put things back.
    setTimeout(() => {
      document.querySelector('.cb-ico').innerHTML = SEARCH_SVG;
      row?.classList.remove('busy');
    }, IS_NEWTAB ? 8000 : 0);
  }
}

// ---------- events ----------
let debounce;
input.addEventListener('input', (e) => {
  // "@yt " (a known command followed by a space) becomes the chip right away.
  const m = !scope && /^@(\S+)\s(.*)$/.exec(input.value);
  if (m && findScope(m[1])) { setScope(findScope(m[1]), m[2]); return; }
  suppressComplete = e.inputType?.startsWith('delete') ?? false;
  completion = findCompletion(input.value.trim());
  paintGhost(); // instantly, without waiting for the results
  clearTimeout(debounce);
  debounce = setTimeout(update, 40);
});
input.addEventListener('keydown', (e) => {
  // Picking from the "@" list: Tab, or Enter on a suggestion.
  if (!scope && input.value.startsWith('@') && (e.key === 'Tab' || e.key === 'Enter') && results[sel]?.type === 'scope') {
    e.preventDefault();
    results[sel].run();
    return;
  }
  if (e.key === 'Backspace' && scope && !input.value) { e.preventDefault(); setScope(null); return; }
  if (e.key === 'Tab' && !e.shiftKey && completion?.rest) { e.preventDefault(); acceptCompletion(); return; }
  if (e.key === 'ArrowRight' && completion?.rest && input.selectionStart === input.value.length) { e.preventDefault(); acceptCompletion(); return; }
  if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
    e.preventDefault();
    setSel(Math.min(results.length - 1, sel + 1));
    if (sel >= results.length - 5) moreFeed();
  } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); setSel(Math.max(0, sel - 1)); }
  else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); peekRow(results[sel]); }
  else if (e.key === 'Enter') { e.preventDefault(); runSelected(e.metaKey || e.ctrlKey); }
  else if (e.key === 'Escape') { e.preventDefault(); if (IS_NEWTAB || input.value) { input.value = ''; update(); } else finish(); }
});
list.addEventListener('mousemove', (e) => {
  const el = e.target.closest('.res');
  if (el) setSel(Number(el.dataset.i), false);
});
// New Tab page: the list starts short and grows taller as you scroll into it (up to most of the window),
// so the whole history isn't in front of you all the time. Scrolling back to the top shrinks it again.
const LIST_START = 360;
function sizeList() {
  if (!IS_NEWTAB) return;
  const max = Math.max(LIST_START, innerHeight * 0.8 - 120);
  list.style.maxHeight = `${Math.round(Math.min(max, LIST_START + list.scrollTop * 1.5))}px`;
}
addEventListener('resize', sizeList);
list.addEventListener('scroll', () => {
  sizeList();
  if (list.scrollTop + list.clientHeight > list.scrollHeight - 300) moreFeed();
}, { passive: true });
list.addEventListener('click', (e) => {
  const el = e.target.closest('.res');
  if (!el) return;
  const btn = e.target.closest('[data-ra]');
  if (btn) { e.preventDefault(); rowAct(Number(el.dataset.i), btn.dataset.ra, e); return; }
  if (e.shiftKey && peekRow(results[Number(el.dataset.i)])) return;
  sel = Number(el.dataset.i);
  runSelected(e.metaKey || e.ctrlKey);
});

// ---------- init ----------
(async () => {
  // In the popup window, act on the browser window it was opened over.
  windowId = Number(new URLSearchParams(location.search).get('win')) || (await chrome.windows.getCurrent()).id;
  chrome.storage.session.get('panelAuto').then(({ panelAuto = [] }) => { panelAutoDone = panelAuto.includes(windowId); }).catch(() => {});
  if (IS_NEWTAB) {
    selfTab = await chrome.tabs.getCurrent();
    targetTab = selfTab;
    // Chrome keeps keyboard focus in the address bar on a New Tab page. A tab that the extension opens
    // with its own page URL gets keyboard focus in the page instead, so open a copy of this page in a new
    // tab right next to this one and close this one. If that fails, keep working here without focus.
    // Not for a New Tab another extension opened into its own tab group (Claude in Chrome and the like):
    // it keeps working with this very tab, so the tab stays as it is (by then its group is set).
    let foreign = false;
    if (selfTab && !new URLSearchParams(location.search).has('focus')) {
      await new Promise((r) => setTimeout(r, 150));
      const now = await chrome.tabs.get(selfTab.id).catch(() => null);
      foreign = !!now && now.groupId !== -1 && !!(await send('isForeignGroup', { groupId: now.groupId }).catch(() => false));
    }
    if (selfTab && !foreign && !new URLSearchParams(location.search).has('focus')) {
      try {
        await chrome.tabs.create({
          url: chrome.runtime.getURL('newtab.html?focus=1'),
          windowId: selfTab.windowId, index: selfTab.index + 1, active: true,
        });
        await chrome.tabs.remove(selfTab.id);
        return;
      } catch (e) {
        console.warn('focus handoff failed', e);
      }
    }
  } else {
    [activeTab] = await chrome.tabs.query({ active: true, windowId });
    // Opened over an empty New Tab → behave like the New Tab page: Enter navigates that tab.
    if (activeTab && isNewTabUrl(activeTab.url || activeTab.pendingUrl)) targetTab = activeTab;
  }
  [idx, tabs] = await Promise.all([send('getIndex', { windowId }), chrome.tabs.query({})]);
  // Your most visited sites first, then the popular list (no duplicates).
  try {
    const mine = (await chrome.topSites.get()).map((s) => { try { return bareHost(new URL(s.url).hostname); } catch { return ''; } });
    siteList = [...new Set([...mine.filter(Boolean), ...POPULAR])];
  } catch { /* topSites unavailable: popular list only */ }
  const space = spaceById(idx.activeSpaceId);
  input.focus();
  update();
})();
