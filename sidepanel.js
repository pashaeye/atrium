import { COLOR_HEX, favicon, send, esc, spaceTitle, realIconFor, watchDarkIcons } from './shared.js';
import { openMenu, openModal, confirmModal, pickModal, toast, incognitoGate } from './ui.js';
import { icon, SPACE_ICONS, FOLDER_ICONS } from './icons.js';

const $ = (s) => document.querySelector(s);
const viewport = $('#viewport');
const track = $('#track');

let windowId = null;
let state = null;
let drag = null; // { kind: 'tab'|'item'|'folder'|'fav'|'space', id }

// ---------- data ----------
async function act(type, payload = {}) {
  try {
    return await send(type, { windowId, ...payload });
  } catch (e) {
    toast(e.message);
  } finally {
    schedule();
  }
}

async function refresh() {
  let next;
  try {
    next = await send('getState', { windowId });
  } catch (e) {
    toast(e.message);
    return;
  }
  state = next;
  $('#app').hidden = !state;
  $('#unsupported').hidden = !!state;
  if (state) render();
}
let timer;
// While a tab or tile is being dragged the lists aren't redrawn: a row replaced under the pointer makes
// Chrome lose track of the drag (it then looks as if the tab left the sidebar). The update waits for the drop.
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => (drag ? schedule() : refresh()), drag ? 200 : 60);
}

// ---------- carousel state ----------
let index = 0;          // page shown when not dragging
let offset = 0;         // px the finger has moved since the gesture started (+ = towards next Space)
let pending = null;     // { spaceId, until } — optimistic target while the background switches
const pageW = () => viewport.clientWidth || 1;

/** Space the sidebar should show: an in-flight switch wins over (possibly stale) state. */
function shownSpaceId() {
  if (pending && (Date.now() > pending.until || state.activeSpaceId === pending.spaceId)) pending = null;
  return pending?.spaceId ?? state.activeSpaceId;
}
const activePage = () => state.spaces.find((s) => s.id === shownSpaceId()) ?? state.spaces[0];

/** Show page `index`. Switching is instant: no slide animation. */
function place() {
  track.style.transition = 'none';
  track.style.transform = `translateX(${-(index * pageW())}px)`;
}

/** Colours and the space bar follow the Space under the finger. */
let paintedId = null; // Space whose icon and colour are currently shown (follows the finger while swiping)
function paintChrome(spaceId) {
  paintedId = spaceId;
  const s = state.spaces.find((x) => x.id === spaceId);
  document.documentElement.style.setProperty('--accent', COLOR_HEX[s?.color] ?? COLOR_HEX.blue);
  document.querySelectorAll('.space-btn[data-id]').forEach((b) => {
    if (b.classList.contains('active') !== (b.dataset.id === spaceId)) b.classList.toggle('active', b.dataset.id === spaceId);
  });
}

function goTo(i) {
  const n = state.spaces.length;
  i = Math.max(0, Math.min(n - 1, i));
  const target = state.spaces[i];
  index = i;
  offset = 0;
  place();
  paintChrome(target.id);
  if (target.id !== state.activeSpaceId) {
    pending = { spaceId: target.id, until: Date.now() + 2000 };
    act('switchSpace', { spaceId: target.id });
  }
}

// ---------- render ----------
// A tab's icon; without one (closed Pinned item, plain icons in Chrome) the site's remembered real icon,
// then Chrome's icon store.
const hostIcon = (u) => realIconFor(state?.realIcons, u);
const iconOf = (tab, url) =>
  tab?.favIconUrl && /^(https?|data):/.test(tab.favIconUrl) ? tab.favIconUrl : hostIcon(tab?.url || url) || favicon(tab?.url || url);

// ---------- Today sorting (view only: Chrome's own tab order is not changed) ----------
const SORTS = { manual: 'Newest first', domain: 'By domain', title: 'By title', recent: 'Recent' };
const domainOf = (url) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : 'Other';
  } catch { return 'Other'; }
};
const STALE_DAYS = 7;
/** "9 days ago", "3 weeks ago", "2 months ago" */
function ago(ms) {
  const d = Math.floor((Date.now() - ms) / 864e5);
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  return `${Math.floor(d / 30)} months ago`;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago" */
function since(ms) {
  const m = Math.floor((Date.now() - ms) / 6e4);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return h < 48 ? 'yesterday' : ago(ms);
}

/** Hover text for a row: the full page title, then what's useful about the tab (site, when used, state). */
function tipOf(title, t, url, extra = []) {
  const host = domainOf(url || t?.url || '');
  const meta = [host === 'Other' ? '' : host];
  meta.push(...extra);
  if (t) {
    if (t.active) meta.push('current tab');
    else if (t.lastAccessed) meta.push(`viewed ${since(t.lastAccessed)}`);
    if (t.discarded) meta.push('asleep');
    if (t.audible && !t.muted) meta.push('playing sound');
    if (t.muted) meta.push('muted');
    if (state?.share?.sharedTabId === t.id) meta.push('presented in Google Meet');
  }
  const lines = [title || url || 'New Tab'];
  if (t?.title && title && t.title !== title) lines.push(t.title);
  lines.push(meta.filter(Boolean).join(' · '));
  return lines.map(esc).join('&#10;');
}

// ---------- tab tree ----------
// In the Manual order, a tab opened from another tab (a link opened in a new tab) is shown under it,
// indented. A parent's favicon turns into a caret on hover: click it to fold its branch away (the number
// of hidden tabs shows next to the title). A branch holding the current tab is never folded. Tabs whose
// opener is closed, or lives in another Space, Pinned or Favorites, are shown at the top level.
const TREE_MAX_DEPTH = 4;
const foldedTabs = new Set(); // ids of tabs whose branch is folded (for as long as the sidebar is open)

const orderOf = (t) => t.order ?? t.id;
const byOrder = (list) => [...list].sort((a, b) => orderOf(b) - orderOf(a));

const SPLIT_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="3" width="12.5" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 3v10" stroke="currentColor" stroke-width="1.4"/></svg>';
/** A Chrome split-view pair: both rows in one frame. */
const splitPairHtml = (a, b, rowA, rowB) => `<div class="split-pair${a.active || b.active ? ' on' : ''}" title="Split view">${rowA}${rowB}</div>`;

function treeHtml(tabs) {
  const ids = new Set(tabs.map((t) => t.id));
  const kids = new Map();
  const roots = [];
  for (const t of tabs) {
    const p = t.openerTabId;
    if (p != null && p !== t.id && ids.has(p)) {
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(t);
    } else {
      roots.push(t);
    }
  }
  const seen = new Set();
  const count = (t) => (kids.get(t.id) ?? []).reduce((n, c) => n + 1 + count(c), 0);
  const hasActive = (t) => (t.active && !t.far) || (kids.get(t.id) ?? []).some(hasActive);
  // Folded branches are marked as seen too, so they don't turn up again below as "left over".
  const skip = (t) => { if (seen.has(t.id)) return; seen.add(t.id); (kids.get(t.id) ?? []).forEach(skip); };
  const walk = (t, depth) => {
    if (seen.has(t.id)) return '';
    seen.add(t.id);
    const children = kids.get(t.id) ?? [];
    const folded = children.length > 0 && foldedTabs.has(t.id) && !children.some(hasActive);
    if (folded) children.forEach(skip);
    let row = tabRow(t, { depth: Math.min(depth, TREE_MAX_DEPTH), branch: children.length > 0, folded, hidden: folded ? count(t) : 0 });
    // Chrome's split view: the two tabs of a pair sit together in one frame, wherever the second one is.
    const mate = t.split > -1 ? tabs.find((x) => x.id !== t.id && x.split === t.split && !seen.has(x.id)) : null;
    if (mate) {
      seen.add(mate.id);
      row = splitPairHtml(t, mate, row, tabRow(mate, { depth: Math.min(depth, TREE_MAX_DEPTH) }))
        + byOrder(kids.get(mate.id) ?? []).map((c) => walk(c, depth + 1)).join('');
    }
    return row + (folded ? '' : byOrder(children).map((c) => walk(c, depth + 1)).join(''));
  };
  // Newest on top, by the order number shared by all windows.
  let html = byOrder(roots).map((t) => walk(t, 0)).join('');
  // Anything left (an opener loop) still shows, at the top level.
  for (const t of tabs) if (!seen.has(t.id)) html += walk(t, 0);
  return html;
}

function todayHtml(s) {
  const tabs = [...s.today];
  const mode = s.todaySort || 'manual';
  if (mode === 'title') tabs.sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url));
  if (mode === 'recent') tabs.sort((a, b) => b.lastAccessed - a.lastAccessed);
  if (mode === 'manual') return treeHtml(tabs);
  // By title / Recent: a split-view pair stays together, in its frame, where its first tab sorts
  // (Recent: the one used last; By title: the one first in the alphabet).
  if (mode !== 'domain') {
    const done = new Set();
    return tabs.map((t) => {
      if (done.has(t.id)) return '';
      done.add(t.id);
      const mate = t.split > -1 ? tabs.find((x) => x.id !== t.id && x.split === t.split) : null;
      if (!mate) return tabRow(t);
      done.add(mate.id);
      return splitPairHtml(t, mate, tabRow(t), tabRow(mate));
    }).join('');
  }
  // By domain the two tabs of a pair usually belong to different sites, so each stays in its own group
  // with a split mark; pointing at one lights up the other (see the mouseover handler).
  const mark = (t) => tabRow(t, { splitMark: true });
  // Group by domain: biggest groups first, then alphabetically; manual order inside a group.
  // A domain with a single tab isn't grouped: those tabs follow the groups as ordinary rows.
  const groups = new Map();
  for (const t of tabs) {
    const d = domainOf(t.url);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(t);
  }
  const multi = [...groups].filter(([, list]) => list.length > 1)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const singles = tabs.filter((t) => groups.get(domainOf(t.url)).length === 1);
  return multi
    .map(([d, list]) => `<div class="domain-head"><img class="ico" src="${esc(iconOf(list[0]))}" alt=""><span>${esc(d)}</span><span class="count">${list.length}</span></div><div class="domain-group">${list.map(mark).join('')}</div>`)
    .join('') + (multi.length && singles.length ? '<div class="domain-sep"></div>' : '') + singles.map(mark).join('');
}

const COPY_ICON = icon('copy-line');
const CAMERA_ICON = icon('camera-line');
const INCOGNITO_ICON = icon('detective-line');
const INCOGNITO_TIP = 'Open in Incognito&#10;Opens this page in an Incognito window, signed out; this tab stays';
const SHOT_TIP = 'Screenshot: the screen, an area or the whole page';

// ---------- Google Meet presentation ----------
/** Red dot next to the tab that Google Meet is presenting. */
function shareMarkup(tabId) {
  const share = state?.share;
  if (share && tabId != null && tabId === share.sharedTabId) return '<span class="live-dot" title="Presented in a call"></span>';
  // A whole window or screen is being shown (no single tab): the red dot goes on the call's own tab.
  if (share && tabId != null && share.sharedTabId == null && tabId === share.meetTabId) {
    return `<span class="live-dot" title="Sharing ${share.surface === 'window' ? 'a window' : share.surface === 'monitor' ? 'the screen' : 'the screen'} from this call"></span>`;
  }
  // A tab in a call (it's using the camera or microphone): a green dot in the same corner.
  const t = tabId != null && (allToday().find((x) => x.id === tabId) || state?.favorites.map((f) => f.tab).find((x) => x?.id === tabId)
    || state?.spaces.flatMap((x) => [...(function* walkP(n) { for (const i of n) { if (i.tab) yield i.tab; if (i.children) yield* walkP(i.children); } })(x.pinned)]).find((x) => x?.id === tabId));
  return t?.inCall ? '<span class="live-dot call" title="In a call"></span>' : '';
}

// ---------- mini player ----------
/** What's playing (or was just paused), above the Space bar: artwork, title, play/pause, mute. */
function renderPlayer() {
  const el = $('#player');
  const items = state.player ?? [];
  el.hidden = !items.length;
  setHTML(el, items.map((p) => {
    const art = p.artwork || iconOf({ favIconUrl: p.favIconUrl, url: p.url });
    return `<div class="pl-item${p.playing ? ' playing' : ''}" data-tab="${p.tabId}">
      <img class="pl-art${p.artwork ? '' : ' fav'}" src="${esc(art)}" alt="">
      <button class="pl-text" data-cmd="pl-go" data-tab="${p.tabId}" title="Go to tab">
        <span class="pl-title">${esc(p.title)}</span><span class="pl-sub">${esc(p.sub)}</span>
      </button>
      ${p.actions?.includes('previoustrack') ? `<button class="pl-btn" data-cmd="pl-prev" data-tab="${p.tabId}" title="Previous">${icon('skip-back')}</button>` : ''}
      ${p.controllable ? `<button class="pl-btn" data-cmd="pl-toggle" data-tab="${p.tabId}" title="${p.playing ? 'Pause' : 'Play'}">${icon(p.playing ? 'pause' : 'play')}</button>` : ''}
      ${p.actions?.includes('nexttrack') ? `<button class="pl-btn" data-cmd="pl-next" data-tab="${p.tabId}" title="Next">${icon('skip-forward')}</button>` : ''}
      ${p.mic != null ? `<button class="pl-btn${p.mic ? '' : ' alert'}" data-cmd="pl-mic" data-tab="${p.tabId}" title="${p.mic ? 'Turn off microphone' : 'Turn on microphone'}">${icon(p.mic ? 'microphone' : 'microphone-slash')}</button>` : ''}
      ${p.cam != null ? `<button class="pl-btn${p.cam ? '' : ' alert'}" data-cmd="pl-cam" data-tab="${p.tabId}" title="${p.cam ? 'Turn off camera' : 'Turn on camera'}">${icon(p.cam ? 'video-camera' : 'video-camera-slash')}</button>` : ''}
      <button class="pl-btn${p.muted ? ' off' : ''}" data-cmd="pl-mute" data-tab="${p.tabId}" title="${p.muted ? 'Unmute' : 'Mute'}">${icon(p.muted ? 'speaker-slash' : 'speaker-high')}</button>
      <button class="pl-btn pl-x" data-cmd="pl-dismiss" data-tab="${p.tabId}" title="Hide from the player">×</button>
    </div>`;
  }).join(''));
}


/** Speaker on tabs that play sound (or are muted): click to mute / unmute. */
function audioButton(t) {
  // A call tab keeps its speaker even in a quiet moment (Chrome reports sound only while someone speaks).
  if (!t.audible && !t.muted && !t.inCall) return '';
  return t.muted
    ? `<button class="aud muted" data-act="mute" data-tab="${t.id}" title="Unmute tab">${icon('speaker-slash')}</button>`
    : `<button class="aud" data-act="mute" data-tab="${t.id}" title="Mute tab">${icon('speaker-high')}</button>`;
}

/** An empty New Tab: Chrome's own, or the extension's New Tab page. */
const isNewTab = (url) => !url || url === 'chrome://newtab/' || url.startsWith(chrome.runtime.getURL('newtab.html'));
/** Pages Chrome lets the extension screenshot. */
const canShoot = (url) => /^(https?|file):/.test(url || '');

function tabRow(t, tree = {}) {
  if (t.far) return farRow(t, tree.depth ?? 0);
  const { depth = 0, branch = false, folded = false, hidden = 0, splitMark = false } = tree;
  const mate = splitMark && t.split > -1 ? allToday().find((x) => x.id !== t.id && x.split === t.split) : null;
  const twisty = branch
    ? `<button class="twisty${folded ? '' : ' open'}" data-act="twisty" title="${folded ? 'Show the tabs opened from this one' : 'Hide the tabs opened from this one'}">${icon('caret-right')}</button>`
    : '';
  return `<div class="row tab ${t.active ? 'active' : ''}${focusDim(t.id) ? ' focus-dim' : ''}${t.discarded ? ' asleep' : ''}${state?.share?.sharedTabId === t.id ? ' presenting' : ''}${branch ? ' branch' : ''}" draggable="true" data-kind="tab" data-id="${t.id}"${t.split > -1 ? ` data-split="${t.split}"` : ''} style="--depth:${depth}" title="${tipOf(t.title, { ...t, title: '' }, t.url)}">
    <span class="ico-wrap${isLoading(t) ? ' loading' : ''}"><img class="ico" src="${esc(iconOf(t))}" alt="">${twisty}</span>
    <span class="title">${esc(t.title || t.url || 'New Tab')}</span>
    ${mate ? `<span class="split-mark" title="Split view with “${esc(mate.title || mate.url)}”">${SPLIT_ICON}</span>` : ''}
    ${hidden ? `<span class="fold-count" title="${hidden} tab${hidden === 1 ? '' : 's'} folded under this one">${hidden}</span>` : ''}
    ${audioButton(t)}
    ${shareMarkup(t.id)}
    ${canShoot(t.url) ? `<button class="btn-icon" data-act="shot" title="${SHOT_TIP}">${CAMERA_ICON}</button>` : ''}
    ${canShoot(t.url) ? `<button class="btn-icon" data-act="incognito" title="${INCOGNITO_TIP}">${INCOGNITO_ICON}</button>` : ''}
    ${isNewTab(t.url) ? '' : `<button class="btn-icon" data-act="copy" title="Copy link&#10;⌘-click: copy as Markdown">${COPY_ICON}</button>`}
    <button class="btn-icon" data-act="close" title="Close tab">×</button>
  </div>`;
}

function treeRows(nodes, depth) {
  return nodes.map((n) => {
    if (n.type === 'folder') {
      return `<div class="row folder" draggable="true" data-kind="folder" data-id="${n.id}" style="--depth:${depth}" title="Click to open or close · drag pinned tabs into it">
          <span class="caret${n.collapsed ? '' : ' open'}">${icon('caret-right')}</span><span class="f-ico">${icon(n.icon || 'folder')}</span>
          <span class="title">${esc(n.name)}</span>
        </div>${n.collapsed ? '' : treeRows(n.children, depth + 1)}`;
    }
    const t = n.tab;
    return `<div class="row item ${t ? 'open' : ''} ${t?.active ? 'active' : ''}${t?.discarded ? ' asleep' : ''}" draggable="true" data-kind="item" data-id="${n.id}" style="--depth:${depth}" title="${tipOf(n.title, t, n.url, [t ? (n.moved ? 'pinned · moved to another page' : 'pinned') : 'pinned · not open'])}">
        <span class="ico-wrap${isLoading(t) ? ' loading' : ''}"><img class="ico" src="${esc(iconOf(t, n.url))}" alt=""></span>
        <span class="title">${esc(n.title || n.url)}</span>
        ${t ? audioButton(t) : ''}
        ${t ? shareMarkup(t.id) : ''}
        ${t && canShoot(t.url) ? `<button class="btn-icon" data-act="shot" title="${SHOT_TIP}">${CAMERA_ICON}</button>` : ''}
        <button class="btn-icon" data-act="copy" title="Copy link&#10;⌘-click: copy as Markdown">${COPY_ICON}</button>
        ${t ? '<button class="btn-icon" data-act="close-item" title="Close tab (stays in Pinned)">×</button>' : ''}
      </div>`;
  }).join('');
}

const FOLDER_PLUS = icon('folder-simple-plus');

/** Space glyph: chosen icon, else legacy emoji, else ''. */
const glyph = (s) => (s.icon ? icon(s.icon) : s.emoji ? esc(s.emoji) : '');

// Empty Pinned area: a drop hint that can be hidden; it shows up again while something is being dragged.
const PIN_EMPTY = '<div class="pin-empty"><span>Drag a tab here to pin it</span><button class="btn-icon" data-cmd="hide-pinned" title="Hide this area&#10;It shows up again when you drag a tab">×</button></div>';
const pinnedHidden = (spaceId) => { try { return localStorage.getItem(`pinnedHidden:${spaceId}`) === '1'; } catch { return false; } };
function setPinnedHidden(spaceId, on) {
  try { on ? localStorage.setItem(`pinnedHidden:${spaceId}`, '1') : localStorage.removeItem(`pinnedHidden:${spaceId}`); } catch { /* storage blocked */ }
}

// The Space's tabs open in other windows sit in the same list, in their places by the same sort, grey, with
// a small window badge in the top-left corner. A click moves the tab here (same tab, same place in the
// list); the other window then shows it grey.
function farRow(t, depth = 0) {
  return `<div class="row far" data-kind="far" data-id="${t.id}" style="--depth:${depth}" title="${tipOf(t.title, { ...t, title: '' }, t.url, ['in another window · click to move it here'])}">
      <span class="far-badge">${icon('app-window')}</span>
      <span class="ico-wrap"><img class="ico" src="${esc(iconOf(t))}" alt=""></span>
      <span class="title">${esc(t.title || t.url || 'New Tab')}</span>
    </div>`;
}
/** This window's tabs and, grey, the same Space's tabs from other windows: one list for every window. */
// (Tabs of a window that just closed, about to reopen here, keep a normal look in their place meanwhile.)
const mergedToday = (s) => [...s.today, ...(s.elsewhere ?? []).map((t) => ({ ...t, far: !t.moving }))];

function pageHtml(s) {
  // An empty New Tab sits where the "New Tab" button is, and the button is hidden while it's there: the
  // two never show at once. Once you pick something in it, it becomes a normal tab and the button is back.
  const blank = s.today.filter((t) => isNewTab(t.url));
  const listed = mergedToday(s).filter((t) => !isNewTab(t.url));
  // While focusing, Today shows the current tab and tabs opened since focus started; the rest folds into one row.
  const fold = focusing() && !focusReveal;
  // Tabs opened during focus stay in view; only the ones from before it fold away.
  const before = new Set(state.focus?.before ?? []);
  const inView = (t) => (t.active && !t.far) || !before.has(t.id);
  const today = focusing() ? listed.filter(inView) : listed;
  const hiddenTabs = focusing() ? listed.filter((t) => !inView(t)) : [];
  const hidden = fold ? hiddenTabs.length : 0;
  // Shown on request, the hidden tabs get their own list under a heading, apart from the tabs in view.
  const more = hidden
    ? `<button class="row ghost focus-more" data-cmd="focus-reveal" title="Hidden while you focus. Click to show them">${hidden} tab${hidden === 1 ? '' : 's'} hidden</button>`
    : focusing() && focusReveal && hiddenTabs.length
      ? `<div class="hidden-head"><span>Hidden while you focus</span><button class="btn-icon keep" data-cmd="focus-reveal" title="Hide them again">${icon('caret-down')}</button></div>
         <div class="today hidden-list">${hiddenTabs.map((t) => tabRow(t)).join('')}</div>`
      : '';
  s = { ...s, today };
  return `<section class="page" data-space="${s.id}" style="--accent:${COLOR_HEX[s.color] ?? COLOR_HEX.blue}">
    <div class="page-scroll">
      <div class="space-head">
        <span class="space-title">${glyph(s) ? `<span class="space-ico">${glyph(s)}</span>` : ''}<span class="space-name">${esc(s.name)}</span></span>
        <button class="btn-icon" data-cmd="add-folder" title="New folder for pinned tabs">${FOLDER_PLUS}</button>
        <button class="btn-icon" data-cmd="space-menu" title="This Space: edit, new, delete">⋯</button>
      </div>
      <div class="pinned${!s.pinned.length && pinnedHidden(s.id) ? ' tucked' : ''}" data-zone="pinned">${s.pinned.length ? treeRows(s.pinned, 0) : PIN_EMPTY}</div>
      <div class="divider">
        <button class="search-btn" data-cmd="cmdbar" title="Command Bar (⌥⇧K)&#10;Search tabs, Spaces, history or open a site">${icon('magnifying-glass')}<span>Search</span></button>
        <span class="line"></span>
        ${s.todaySort !== 'manual' ? `<span class="sort-badge">${esc(SORTS[s.todaySort])}</span>` : ''}
        <button class="btn-icon" data-cmd="sort" title="Sort Today tabs (now: ${esc(SORTS[s.todaySort] ?? SORTS.manual)})">${icon('sort-ascending')}</button>
        <button class="btn-icon" data-cmd="clear" title="Clean up: close tabs you haven’t used for a week (you choose which)">${icon('broom')}</button>
      </div>
      ${blank.length ? `<div class="blank-tabs">${blank.map((t) => tabRow(t)).join('')}</div>` : '<button class="row ghost" data-cmd="new-tab" title="New tab (⌘T)">New Tab</button>'}
      <div class="today" data-zone="today">${todayHtml(s)}</div>
      ${more}
    </div>
  </section>`;
}

/** Replace an element's markup only when it changed: no flicker, animations don't restart. */
function setHTML(el, html) {
  if (el._html === html) return false;
  el.innerHTML = html;
  el._html = html;
  return true;
}

watchDarkIcons('.fav img, img.ico');

/** Favorites are updated in place: a tile whose icon is unchanged keeps its <img>, so switching tabs
    doesn't reload and repaint every icon (they used to blink). */
function patchFavs(el, html) {
  if (el._html === html) return;
  el._html = html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const old = new Map([...el.children].map((n) => [n.dataset.id, n]));
  const next = [...tpl.content.children].map((n) => {
    const prev = old.get(n.dataset.id);
    const img = prev?.querySelector(':scope > img'), nimg = n.querySelector(':scope > img');
    if (!prev || !img || !nimg || img.getAttribute('src') !== nimg.getAttribute('src')) return n;
    for (const a of [...prev.attributes]) if (!n.hasAttribute(a.name)) prev.removeAttribute(a.name);
    for (const a of [...n.attributes]) if (prev.getAttribute(a.name) !== a.value) prev.setAttribute(a.name, a.value);
    for (const c of [...prev.childNodes]) if (c !== img) c.remove();
    for (const c of [...n.childNodes]) if (c !== nimg) prev.append(c);
    return prev;
  });
  el.replaceChildren(...next);
}

function render() {
  if (drag) return void schedule(); // not while dragging (see schedule)
  rememberTabs();
  renderFocus();
  renderPlayer();
  // Which Space the bar should highlight: the one under the finger while swiping, else the shown one.
  const activeId = gesture && paintedId ? paintedId : shownSpaceId();

  patchFavs($('#favs'), state.favorites.map((f) =>
    `<div class="fav ${f.tab ? 'open' : ''} ${f.tab?.active ? 'active' : ''}${focusDim(f.tab?.id) ? ' focus-dim' : ''}${isLoading(f.tab) ? ' loading' : ''}" draggable="true" data-kind="fav" data-id="${f.id}" title="${tipOf(f.title, f.tab, f.url, [f.tab ? 'favorite' : 'favorite · not open'])}">
      <img src="${esc(iconOf(f.tab, f.url))}" alt="">${f.tab ? shareMarkup(f.tab.id) : ''}
    </div>`).join(''));

  // Keep each page's scroll position when the pages are rebuilt.
  const scroll = {};
  track.querySelectorAll('.page').forEach((p) => { scroll[p.dataset.space] = p.firstElementChild.scrollTop; });
  if (setHTML(track, state.spaces.map(pageHtml).join(''))) {
    track.querySelectorAll('.page').forEach((p) => { p.firstElementChild.scrollTop = scroll[p.dataset.space] ?? 0; });
  }

  // The bar's markup depends only on the Spaces themselves (icon, colour, order). The active Space and
  // the tooltips change all the time, so they are set on the existing buttons below; rebuilding the bar
  // on every tab event would restart the icon animation and make it flicker.
  setHTML($('#spaces'), state.spaces.map((s) =>
    `<button class="space-btn" draggable="true" data-kind="space" data-id="${s.id}">
      <span class="glyph">${glyph(s) || `<span class="gdot" style="background:${COLOR_HEX[s.color]}"></span>`}</span>
      <span class="sdot"></span>
    </button>`).join('') + '<button class="space-btn add" data-cmd="add-space" title="New Space"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>');
  document.querySelectorAll('.space-btn[data-id]').forEach((b, i) => {
    const sp = state.spaces[i];
    if (b.classList.contains('active') !== (b.dataset.id === activeId)) b.classList.toggle('active', b.dataset.id === activeId);
    const title = `${spaceTitle(sp)} · ${sp.tabCount} tabs${i < 9 ? ` · Space ${i + 1}` : ''}\nSwipe sideways on the sidebar to switch Spaces`;
    if (b.title !== title) b.title = title;
  });

  if (!gesture) {
    const shown = shownSpaceId();
    const i = Math.max(0, state.spaces.findIndex((s) => s.id === shown));
    const moved = i !== index;
    index = i;
    if (moved || !rendered) place();
    paintChrome(state.spaces[index]?.id);
  } else if (!locked) {
    place();
  }
  rendered = true;
}
let rendered = false;

// ---------- two-finger swipe ----------
// Discrete and instant: once a horizontal swipe has travelled far enough, the next/previous Space is
// shown at once. One swipe = one switch: after a switch, the rest of that swipe (fingers still speeding
// up, then the decaying momentum tail) is ignored. A new swipe is only recognised once the deltas have
// started to decay and then grow again, and not sooner than 200 ms after the switch.
const SWIPE_DISTANCE = 60; // px of accumulated deltaX that make a swipe
let gesture = false, locked = false, idleTimer, lastAbs = 0, acc = 0, decaying = false, lockedAt = 0;
viewport.addEventListener('wheel', (e) => {
  if (!state) return;
  const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
  if (!gesture && !horizontal) return; // ordinary vertical scrolling of the list
  e.preventDefault();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(endGesture, 120);
  const abs = Math.abs(e.deltaX);
  if (locked) {
    if (abs < lastAbs) decaying = true;
    const newSwipe = decaying && Date.now() - lockedAt > 200 && abs >= 4 && abs > lastAbs * 1.5 + 2;
    lastAbs = abs;
    if (!newSwipe) return; // momentum tail of the swipe that already switched
    locked = false;
    acc = 0;
  }
  lastAbs = abs;
  gesture = true;
  // A change of direction starts counting again.
  if (acc && Math.sign(e.deltaX) !== Math.sign(acc)) acc = 0;
  acc += e.deltaX;
  if (Math.abs(acc) < SWIPE_DISTANCE) return;
  const dir = Math.sign(acc);
  const n = state.spaces.length;
  locked = true;
  decaying = false;
  lockedAt = Date.now();
  acc = 0;
  if ((dir > 0 && index < n - 1) || (dir < 0 && index > 0)) goTo(index + dir);
}, { passive: false });

function endGesture() {
  gesture = false;
  locked = false;
  acc = 0;
}

addEventListener('resize', () => state && place());

// ---------- lookups ----------
const allToday = () => state.spaces.flatMap((s) => s.today);
const findTab = (id) => allToday().find((t) => t.id === Number(id));
const findFav = (id) => state.favorites.find((f) => f.id === id);
function findNode(id, nodes = state.spaces.flatMap((s) => s.pinned)) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.type === 'folder') {
      const r = findNode(id, n.children);
      if (r) return r;
    }
  }
  return null;
}
/** Open tab id behind any draggable thing, if there is one. */
function tabIdOf(d) {
  if (d.kind === 'tab') return Number(d.id);
  if (d.kind === 'item') return findNode(d.id)?.tab?.id ?? null;
  if (d.kind === 'fav') return findFav(d.id)?.tab?.id ?? null;
  return null;
}

// ---------- clicks ----------
document.addEventListener('click', async (e) => {
  const actBtn = e.target.closest('[data-act]');
  const row = e.target.closest('[data-kind]');
  if (actBtn && row) {
    e.stopPropagation();
    const id = row.dataset.id;
    if (actBtn.dataset.act === 'twisty') {
      const tid = Number(id);
      foldedTabs.has(tid) ? foldedTabs.delete(tid) : foldedTabs.add(tid);
      return render();
    }
    if (actBtn.dataset.act === 'mute') return act('toggleMute', { tabId: Number(actBtn.dataset.tab) });
    if (actBtn.dataset.act === 'copy') {
      const k = row.dataset.kind;
      const t = k === 'tab' ? findTab(id) : k === 'far' ? state.spaces.flatMap((x) => x.elsewhere ?? []).find((x) => x.id === Number(id)) : null;
      const n = k === 'item' ? findNode(id) : null;
      const url = t?.url || n?.tab?.url || n?.url || '';
      const title = t?.title || n?.title || n?.tab?.title || '';
      // Cmd/Ctrl+click: copy as a Markdown link, [Title](url)
      if (e.metaKey || e.ctrlKey) return copy(markdownLink(title, url), 'Markdown link copied');
      return copy(url);
    }
    if (actBtn.dataset.act === 'shot') {
      const tabId = row.dataset.kind === 'tab' ? Number(id) : findNode(id)?.tab?.id;
      return tabId != null && act('screenshotTab', { tabId });
    }
    if (actBtn.dataset.act === 'incognito') return (await incognitoGate()) && act('toIncognito', { tabId: Number(id) });
    if (actBtn.dataset.act === 'close') return act('closeTab', { tabId: Number(id) });
    if (actBtn.dataset.act === 'close-item') return act('closeItemTab', { itemId: id });
    if (actBtn.dataset.act === 'reset') return act('resetItem', { itemId: id });
  }
  if (row) {
    const { kind, id } = row.dataset;
    // Cmd/Ctrl+click duplicates an open tab (Today, Pinned or Favorite) instead of switching to it.
    if (e.metaKey || e.ctrlKey) {
      const tabId = tabIdOf({ kind, id });
      if (tabId != null) return act('duplicateTab', { tabId });
    }
    if (kind === 'tab') return act('activateTab', { tabId: Number(id) });
    if (kind === 'far') return act('openHere', { tabId: Number(id), spaceId: row.closest('.page')?.dataset.space });
    if (kind === 'item') return act('openItem', { itemId: id });
    if (kind === 'folder') return act('updateFolder', { folderId: id, collapsed: !findNode(id)?.collapsed });
    if (kind === 'fav') return act('openFavorite', { favId: id });
    if (kind === 'space') return goTo(state.spaces.findIndex((s) => s.id === id));
  }
  const cmd = e.target.closest('[data-cmd]');
  switch (cmd?.dataset.cmd) {
    case 'pl-go': return act('activateTab', { tabId: Number(cmd.dataset.tab) });
    case 'pl-toggle': {
      const tabId = Number(cmd.dataset.tab);
      const wasPlaying = state.player?.find((p) => p.tabId === tabId)?.playing;
      await act('mediaControl', { tabId, action: 'toggle' });
      // Chrome doesn't let a page start sound until you've interacted with that tab (e.g. after a
      // browser restart). If Play didn't start anything, open the tab so you can press play there.
      if (!wasPlaying) {
        setTimeout(async () => {
          await refresh();
          const p = state.player?.find((x) => x.tabId === tabId);
          if (p && !p.playing) {
            act('activateTab', { tabId });
            toast('Chrome needs a click in this tab before it can play: press play there once', 5000);
          }
        }, 1200);
      }
      return;
    }
    case 'pl-prev': return act('mediaControl', { tabId: Number(cmd.dataset.tab), action: 'prev' });
    case 'pl-next': return act('mediaControl', { tabId: Number(cmd.dataset.tab), action: 'next' });
    case 'pl-mic': return act('mediaControl', { tabId: Number(cmd.dataset.tab), action: 'mic' });
    case 'pl-cam': return act('mediaControl', { tabId: Number(cmd.dataset.tab), action: 'cam' });
    case 'pl-mute': return act('toggleMute', { tabId: Number(cmd.dataset.tab) });
    case 'pl-dismiss': return act('dismissMedia', { tabId: Number(cmd.dataset.tab) });
    case 'open-appearance': return chrome.tabs.create({ url: 'chrome://settings/appearance' });
    case 'dismiss-hint': {
      try { localStorage.setItem('sideHintDismissed', '1'); } catch {}
      $('#side-hint').hidden = true;
      return;
    }
    case 'new-tab': return act('newTab');
    case 'clear': {
      // Today tabs not used for over a week; the user unticks the ones to keep.
      const cutoff = Date.now() - STALE_DAYS * 864e5;
      const stale = activePage().today
        .filter((t) => !t.active && t.lastAccessed && t.lastAccessed < cutoff)
        .sort((a, b) => a.lastAccessed - b.lastAccessed);
      if (!stale.length) return toast(`No tabs unused for over ${STALE_DAYS} days`);
      const ids = await pickModal({
        title: 'Clean up Today',
        note: `Tabs not used for over ${STALE_DAYS} days. Untick the ones you want to keep.`,
        items: stale.map((t) => ({ id: String(t.id), title: t.title || t.url, sub: `${ago(t.lastAccessed)} · ${domainOf(t.url)}`, icon: iconOf(t) })),
        submitLabel: (n) => (n ? `Close ${n} tab${n === 1 ? '' : 's'}` : 'Nothing selected'),
      });
      if (ids?.length) act('closeTabs', { tabIds: ids.map(Number) });
      return;
    }
    case 'sort': {
      const page = activePage();
      const r = cmd.getBoundingClientRect();
      return openMenu(r.left - 150, r.bottom + 4, [
        { heading: 'Sort Today' },
        ...Object.entries(SORTS).map(([key, label]) => ({
          label: (page.todaySort === key ? '✓\u2002' : '\u2003\u2002') + label,
          run: () => act('updateSpace', { spaceId: page.id, todaySort: key }),
        })),
      ]);
    }
    case 'add-folder': {
      const v = await openModal({ title: 'New Folder', fields: folderFields('', 'folder'), submitLabel: 'Create' });
      if (v) act('addFolder', v);
      return;
    }
    case 'add-space': return createSpaceDialog();
    case 'focus-end': return act('endFocus');
    case 'focus-start': return startFocus();
    case 'cmdbar': return act('openCommandOverlay');
    case 'settings': {
      const r = cmd.getBoundingClientRect();
      return openMenu(r.right - 220, r.top - 6, settingsMenu(), { above: true });
    }
    case 'focus-reveal': focusReveal = !focusReveal; return render();
    case 'hide-pinned': setPinnedHidden(activePage().id, true); return render();
    case 'focus-next': return act('skipFocusPhase');
    case 'focus-menu': {
      const r = cmd.getBoundingClientRect();
      return openMenu(r.left, r.top - 6, focusMenu(), { above: true });
    }
    case 'space-menu': {
      const r = cmd.getBoundingClientRect();
      return openMenu(r.left, r.bottom + 4, spaceMenu(activePage().id));
    }
  }
});

document.addEventListener('dblclick', (e) => {
  const sb = e.target.closest('.space-btn[data-id]') ?? (e.target.closest('.space-title') && { dataset: { id: activePage().id } });
  if (sb) editSpaceDialog(sb.dataset.id);
});

const folderFields = (name, ic) => [
  { name: 'name', label: 'Name', value: name },
  { name: 'icon', label: 'Icon', value: ic, type: 'icon', options: FOLDER_ICONS },
];

async function createSpaceDialog() {
  const v = await openModal({
    title: 'New Space',
    submitLabel: 'Create',
    fields: [
      { name: 'name', label: 'Name', value: '' },
      { name: 'icon', label: 'Icon', value: 'house', type: 'icon', options: SPACE_ICONS },
      { name: 'color', label: 'Color', value: null, type: 'color' },
    ],
  });
  if (v) act('createSpace', v);
}

async function editSpaceDialog(spaceId) {
  const s = state.spaces.find((x) => x.id === spaceId);
  if (!s) return;
  const v = await openModal({
    title: 'Edit Space',
    fields: [
      { name: 'name', label: 'Name', value: s.name },
      { name: 'icon', label: 'Icon', value: s.icon, type: 'icon', options: SPACE_ICONS },
      { name: 'color', label: 'Color', value: s.color, type: 'color' },
    ],
  });
  if (v) act('updateSpace', { spaceId, ...v });
}

const SLEEP_CHOICES = [[15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [180, '3 hours'], [0, 'Never']];

/** "⋯" next to the Space name: only things about this Space. Everything else is in Settings (bottom right). */
function spaceMenu(spaceId) {
  const s = state.spaces.find((x) => x.id === spaceId);
  return [
    { label: 'Edit…', run: () => editSpaceDialog(spaceId) },
    { label: 'New Space…', run: createSpaceDialog },
    ...(pinnedHidden(spaceId) ? [{ label: 'Show the Pinned area', run: () => { setPinnedHidden(spaceId, false); render(); } }] : []),
    {
      label: 'Close copies from other windows',
      run: async () => {
        const n = await act('closeCopies', { spaceId });
        toast(n ? `${n} cop${n === 1 ? 'y' : 'ies'} closed` : 'No copies here');
      },
    },
    { separator: true },
    {
      label: 'Delete Space', danger: true,
      run: async () => {
        if (await confirmModal(`Delete “${spaceTitle(s)}”? All its tabs will be closed.`)) act('deleteSpace', { spaceId });
      },
    },
  ];
}

/** Settings: the gear in the bottom-right corner of the sidebar. */
function settingsMenu() {
  return [
    {
      label: 'Sleep other Spaces after',
      hint: (SLEEP_CHOICES.find(([m]) => m === state.sleepAfter) ?? [0, ''])[1].replace(' minutes', ' min'),
      submenu: SLEEP_CHOICES.map(([min, label]) => ({
        label: (state.sleepAfter === min ? '✓\u2002' : '\u2003\u2002') + label,
        run: () => act('setSleepAfter', { minutes: min }),
      })),
    },
    ...(state.spaces.length > 1 ? [{
      label: 'Put other Spaces to sleep now',
      run: async () => {
        const n = await act('sleepSpace', { spaceId: null });
        toast(n ? `${n} tab${n === 1 ? '' : 's'} put to sleep` : 'Nothing to put to sleep');
      },
    }] : []),
    {
      label: 'Reset Pinned & Favorites',
      submenu: [
        {
          label: (state.morningReset ? '✓\u2002' : '\u2003\u2002') + 'Every morning',
          run: () => act('setMorningReset', { on: !state.morningReset }),
        },
        {
          label: '\u2003\u2002Now',
          run: async () => {
            const n = await act('resetHomePages');
            toast(n ? `${n} tab${n === 1 ? '' : 's'} back to the pinned page` : 'All pinned tabs are on their pages');
          },
        },
      ],
    },
    { separator: true },
    {
      label: (state.plainTabIcons ? '✓\u2002' : '\u2003\u2002') + 'Plain icons in Chrome’s tab strip',
      run: () => act('setPlainTabIcons', { on: !state.plainTabIcons }),
    },
    { separator: true },
    { label: 'Paused sites during focus…', run: focusSitesDialog },
    { label: 'Shortcuts…', run: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) },
    { separator: true },
    { label: 'Setup guide', run: () => chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') }) },
    { heading: `Atrium ${chrome.runtime.getManifest().version}` },
  ];
}

const moveToEntries = (tabId) => {
  const others = state.spaces.filter((s) => s.id !== activePage().id);
  if (!others.length || tabId == null) return [];
  return [{ heading: 'Move to Space' }, ...others.map((s) => ({ label: spaceTitle(s), run: () => act('moveTabToSpace', { tabId, spaceId: s.id }) }))];
};

// ---------- context menus ----------
document.addEventListener('contextmenu', (e) => {
  const fb = e.target.closest('#tomato');
  if (fb) {
    e.preventDefault();
    const r = fb.getBoundingClientRect();
    openMenu(r.left, r.top - 6, focusMenu(), { above: true });
    return;
  }
  const row = e.target.closest('[data-kind]');
  if (!row) return;
  e.preventDefault();
  const { kind, id } = row.dataset;
  let entries = [];
  if (kind === 'tab') {
    const tabId = Number(id);
    entries = [
      { label: 'Pin', run: () => act('pinTab', { tabId }) },
      { label: 'Add to Favorites', run: () => act('addFavorite', { tabId }) },
      { label: 'Copy link', run: () => copy(findTab(id)?.url) },
      { label: 'Copy as Markdown', run: () => { const t = findTab(id); copy(markdownLink(t?.title, t?.url || ''), 'Markdown link copied'); } },
      ...(/^(https?|file):/.test(findTab(id)?.url || '') ? [{ label: 'Open in Incognito', run: async () => (await incognitoGate()) && act('toIncognito', { tabId }) }] : []),
      ...moveToEntries(tabId).length ? [{ separator: true }, ...moveToEntries(tabId)] : [],
      ...((findTab(id)?.split ?? -1) > -1 ? [{ separator: true }, { label: 'Separate split view', run: () => act('unsplitTabs', { splitId: findTab(id).split }) }] : []),
      { separator: true },
      { label: 'Close', danger: true, run: () => act('closeTab', { tabId }) },
    ];
  } else if (kind === 'item') {
    const n = findNode(id);
    entries = [
      { label: 'Rename…', run: () => renameItem(n) },
      n.moved && { label: 'Back to the pinned page', run: () => act('resetItem', { itemId: id }) },
      n.moved && { label: 'Pin current URL', run: () => act('updateItem', { itemId: id, url: n.tab.url, title: n.tab.title }) },
      { label: 'Copy link', run: () => copy(n.tab?.url || n.url) },
      { label: 'Copy as Markdown', run: () => copy(markdownLink(n.title, n.tab?.url || n.url), 'Markdown link copied') },
      { label: 'Move to Favorites', run: () => act('itemToFavorite', { itemId: id }) },
      ...moveToEntries(n.tab?.id).length ? [{ separator: true }, ...moveToEntries(n.tab?.id)] : [],
      { separator: true },
      n.tab && { label: 'Close tab', run: () => act('closeItemTab', { itemId: id }) },
      { label: 'Unpin', danger: true, run: () => act('unpinItem', { itemId: id }) },
    ].filter(Boolean);
  } else if (kind === 'folder') {
    const n = findNode(id);
    entries = [
      { label: 'Edit…', run: async () => {
        const v = await openModal({ title: 'Edit Folder', fields: folderFields(n.name, n.icon || 'folder') });
        if (v) act('updateFolder', { folderId: id, ...v });
      } },
      { label: 'New folder inside', run: () => act('addFolder', { name: '', targetId: id, position: 'into' }) },
      { separator: true },
      { label: 'Delete folder (keep contents)', danger: true, run: () => act('deleteFolder', { folderId: id }) },
    ];
  } else if (kind === 'fav') {
    const f = findFav(id);
    entries = [
      { label: 'Copy link', run: () => copy(f.tab?.url || f.url) },
      { label: 'Copy as Markdown', run: () => copy(markdownLink(f.title, f.tab?.url || f.url), 'Markdown link copied') },
      f.tab && { label: 'Close tab', run: () => act('closeTab', { tabId: f.tab.id }) },
      { separator: true },
      { label: 'Remove from Favorites', danger: true, run: () => act('removeFavorite', { favId: id }) },
    ].filter(Boolean);
  } else if (kind === 'space') {
    return; // the dots have no menu: use ⋯ next to the Space name
  }
  if (!entries.length) return;
  openMenu(e.clientX, e.clientY, entries);
});

async function renameItem(n) {
  const v = await openModal({
    title: 'Pinned Tab',
    fields: [{ name: 'title', label: 'Name', value: n.title }, { name: 'url', label: 'URL', value: n.url }],
  });
  if (v) act('updateItem', { itemId: n.id, title: v.title, url: v.url });
}

async function copy(text, done = 'Link copied') {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('Couldn’t copy');
  }
}

/** [Title](url) with the characters that would break Markdown escaped. */
function markdownLink(title, url) {
  const t = (title || url).replace(/\s+/g, ' ').trim().replace(/([\[\]\\])/g, '\\$1');
  const u = url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20');
  return `[${t}](${u})`;
}

// ---------- drag & drop ----------
function clearIndicators() {
  document.querySelectorAll('.drop-before,.drop-after,.drop-into,.zone-over').forEach((el) =>
    el.classList.remove('drop-before', 'drop-after', 'drop-into', 'zone-over'));
}

/** Where would a drop land? Returns { zone, el, id, pos } or null. */
function dropTarget(e) {
  let zoneEl = e.target.closest('[data-zone]');
  if (!zoneEl) {
    // Empty area of a page: above the divider counts as Pinned, below as Today.
    const page = e.target.closest('.page');
    if (!page) return null;
    const divider = page.querySelector('.divider').getBoundingClientRect();
    zoneEl = page.querySelector(e.clientY < divider.top ? '[data-zone=pinned]' : '[data-zone=today]');
    // Between the divider and the list (the New Tab button or an empty New Tab): the top of Today.
    if (zoneEl.dataset.zone === 'today' && e.clientY < zoneEl.getBoundingClientRect().top) {
      const first = [...zoneEl.querySelectorAll('.row.tab')].find((r) => r.dataset.id !== drag?.id);
      if (first) return { zone: 'today', el: first, id: first.dataset.id, pos: 'before' };
    }
  }
  const zone = zoneEl.dataset.zone;
  const sel = { favs: '.fav', pinned: '.row.item, .row.folder', today: '.row.tab', spaces: '.space-btn[data-id]' }[zone];
  const el = e.target.closest(sel);
  if (!el) return { zone, el: zoneEl, id: null, pos: 'end' };
  const r = el.getBoundingClientRect();
  let pos;
  if (zone === 'favs' || zone === 'spaces') {
    const x = (e.clientX - r.left) / r.width;
    pos = zone === 'spaces' && drag?.kind !== 'space' ? 'into' : x < 0.5 ? 'before' : 'after';
  } else {
    const y = (e.clientY - r.top) / r.height;
    // Folders take a drop "into" their middle; so does a tab in Today when a tab is dropped on it (split view).
    const into = el.classList.contains('folder') || (zone === 'today' && drag?.kind === 'tab' && el.dataset.id !== drag.id && !el.classList.contains('far'));
    pos = into ? (y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'into') : (y < 0.5 ? 'before' : 'after');
  }
  return { zone, el, id: el.dataset.id, pos };
}

/** Next sibling id in a flat list, for turning "after X" into "before Y". */
function nextId(list, id) {
  const i = list.findIndex((x) => String(x.id) === String(id));
  return i >= 0 && i + 1 < list.length ? list[i + 1].id : null;
}
function reordered(ids, moving, targetId, pos) {
  const out = ids.filter((x) => x !== moving);
  if (!targetId) return [...out, moving];
  const i = out.indexOf(targetId);
  out.splice(pos === 'after' ? i + 1 : i, 0, moving);
  return out;
}

/** The action a drop would perform, or null if not allowed. */
function dropAction(d, t) {
  if (!d || !t) return null;
  if (t.id != null && t.id === d.id && t.zone !== 'spaces') return null;
  const tabId = tabIdOf(d);
  const page = activePage();
  switch (t.zone) {
    case 'favs': {
      const beforeFavId = t.id == null ? null : t.pos === 'before' ? t.id : nextId(state.favorites, t.id);
      if (d.kind === 'fav') return () => act('reorderFavorites', { ids: reordered(state.favorites.map((f) => f.id), d.id, t.id, t.pos) });
      if (d.kind === 'tab') return () => act('addFavorite', { tabId, beforeFavId });
      if (d.kind === 'item') return () => act('itemToFavorite', { itemId: d.id, beforeFavId });
      return null;
    }
    case 'pinned': {
      const targetId = t.id, position = t.id == null ? 'end' : t.pos;
      if (d.kind === 'item' || d.kind === 'folder') return () => act('moveNode', { nodeId: d.id, targetId, position });
      if ((d.kind === 'tab' || d.kind === 'fav') && tabId != null) return () => act('pinTab', { tabId, targetId, position });
      return null;
    }
    case 'today': {
      if (tabId == null || d.kind === 'folder' || d.kind === 'space') return null;
      // A tab dropped onto the middle of another tab: the two open side by side (Chrome's split view).
      if (t.pos === 'into') {
        if (d.kind !== 'tab' || t.id == null) return null;
        const withTabId = Number(t.id);
        return () => act('splitTabs', { tabId, withTabId });
      }
      // In the Manual order the list is newest-first (Chrome's order upside down): dropping above a tab puts
      // the dragged one after it in Chrome, below a tab puts it before it, and at the bottom of the list is
      // the very start of the group.
      if ((page.todaySort || 'manual') === 'manual') {
        // "Newest first" follows an order number shared by all windows: give the tab one between its new
        // neighbours (above a tab = a bit bigger than it, below = a bit smaller).
        if (d.kind !== 'tab') return () => act('reorderToday', { tabId, beforeTabId: null });
        // The tree: the tab joins the level of the row it's dropped next to (and leaves its old parent),
        // then takes an order number between its new neighbours on that level.
        const all = mergedToday(page);
        const ids = new Set(all.map((x) => x.id));
        const parentOf = (x) => (x.openerTabId != null && ids.has(x.openerTabId) && x.openerTabId !== x.id ? x.openerTabId : null);
        const target = t.id == null ? null : all.find((x) => x.id === Number(t.id));
        let parent = target ? parentOf(target) : null;
        // Never under itself or one of its own children.
        for (let p = parent, n = 0; p != null && n < 50; p = parentOf(all.find((x) => x.id === p) ?? {}), n++) {
          if (p === tabId) { parent = null; break; }
        }
        // Dragged away from its split-view partner: the pair comes apart.
        const me = all.find((x) => x.id === tabId);
        const unsplit = (me?.split ?? -1) > -1 && !(target && target.split === me.split);
        const list = byOrder(all.filter((x) => x.id !== tabId && parentOf(x) === parent));
        const at = target ? list.findIndex((x) => x.id === target.id) : -1;
        let order;
        if (at < 0) order = list.length ? orderOf(list[list.length - 1]) - 1 : 0;
        else if (t.pos === 'before') order = at > 0 ? (orderOf(list[at - 1]) + orderOf(list[at])) / 2 : orderOf(list[at]) + 1;
        else order = at < list.length - 1 ? (orderOf(list[at]) + orderOf(list[at + 1])) / 2 : orderOf(list[at]) - 1;
        return () => act('setTabOrder', { tabId, order, parent, unsplit });
      }
      const beforeTabId = t.id == null ? null : t.pos === 'before' ? Number(t.id) : nextId(page.today, t.id);
      const me = findTab(tabId), tg = t.id == null ? null : findTab(t.id);
      const unsplit = (me?.split ?? -1) > -1 && !(tg && tg.split === me.split);
      return async () => { if (unsplit) await act('unsplitTabOf', { tabId }); return act('reorderToday', { tabId, beforeTabId }); };
    }
    case 'spaces': {
      if (d.kind === 'space') {
        if (t.id == null || t.id === d.id) return null;
        return () => act('reorderSpaces', { ids: reordered(state.spaces.map((s) => s.id), d.id, t.id, t.pos) });
      }
      if (t.id == null || t.id === page.id || tabId == null) return null;
      return () => act('moveTabToSpace', { tabId, spaceId: t.id });
    }
  }
  return null;
}

document.addEventListener('dragstart', (e) => {
  const el = e.target.closest('[draggable][data-kind]');
  if (!el) return;
  drag = { kind: el.dataset.kind, id: el.dataset.id };
  e.dataTransfer.effectAllowed = 'move';
  const url = drag.kind === 'tab' ? findTab(drag.id)?.url : drag.kind === 'item' ? findNode(drag.id)?.url : drag.kind === 'fav' ? findFav(drag.id)?.url : '';
  // Plain text only: a link (text/uri-list) dropped on the page next to the sidebar would make Chrome open it
  // there, instead of the tab moving to its own window (see dragend).
  e.dataTransfer.setData('text/plain', url || drag.id);
  // Lets the page next to the sidebar accept a tab dropped on it (tab-drop.js): no slide-back animation.
  if (drag.kind === 'tab') e.dataTransfer.setData('application/x-atrium-tab', drag.id);
  draggedOut = false;
  requestAnimationFrame(() => { el.classList.add('dragging'); document.body.classList.add('is-dragging'); });
});
// Dragging a tab out of the sidebar and letting go anywhere outside it moves the tab into a new window there,
// like pulling a tab off Chrome's tab strip.
// Chrome may send a stray "left" event (at 0,0) right as you let go inside the sidebar, so leaving alone
// isn't trusted: "dragover" fires every ~50 ms while the pointer is over the sidebar, anywhere in it, and a
// drop counts as outside only when the last one is older than that.
let draggedOut = false, lastOver = 0;
// While a tab is outside the sidebar, its row and a hint at the bottom say it will open in a new window.
// (The page next to the sidebar can't be drawn on, so the sidebar shows it.)
const showOut = (on) => document.body.classList.toggle('drag-out', on && drag?.kind === 'tab');
document.addEventListener('dragleave', (e) => {
  if (!drag || e.relatedTarget) return;
  draggedOut = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight;
  // Wait a moment: a stray "left" at the moment of letting go is followed by nothing, a real one by no dragover.
  if (draggedOut) setTimeout(() => { if (drag && draggedOut && Date.now() - lastOver > 120) showOut(true); }, 150);
});
document.addEventListener('dragenter', () => { draggedOut = false; showOut(false); });
document.addEventListener('dragover', () => { lastOver = Date.now(); showOut(false); }, true);
document.addEventListener('dragend', (e) => {
  showOut(false);
  document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  document.body.classList.remove('is-dragging');
  clearIndicators();
  // Outside: it left the sidebar, the pointer hasn't been over it since, and where it was let go is really
  // outside the sidebar (Chrome reports 0,0 for a cancelled drag, which counts as inside).
  const beyond = e.clientX < 0 || e.clientY < 0 || e.clientX > innerWidth || e.clientY > innerHeight;
  const outside = draggedOut && beyond && Date.now() - lastOver > 250 && !(e.screenX === 0 && e.screenY === 0);
  if (outside && drag?.kind === 'tab' && e.dataTransfer.dropEffect === 'none') {
    act('tabToNewWindow', { tabId: Number(drag.id), left: e.screenX, top: e.screenY });
  }
  draggedOut = false;
  drag = null;
});
document.addEventListener('dragover', (e) => {
  const t = dropTarget(e);
  clearIndicators();
  if (!dropAction(drag, t)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!t.id) t.el?.classList.add('zone-over');
  else t.el.classList.add(t.pos === 'into' ? 'drop-into' : t.pos === 'after' ? 'drop-after' : 'drop-before');
});
document.addEventListener('drop', (e) => {
  const run = dropAction(drag, dropTarget(e));
  clearIndicators();
  if (!run) return;
  e.preventDefault();
  run();
});

// ---------- keyboard (when the panel has focus) ----------
document.addEventListener('keydown', (e) => {
  if (!state || e.target.closest('input, .modal-back')) return;
  if (e.key === 'ArrowRight' && (e.metaKey || e.ctrlKey || e.altKey)) { goTo(index + 1); e.preventDefault(); }
  if (e.key === 'ArrowLeft' && (e.metaKey || e.ctrlKey || e.altKey)) { goTo(index - 1); e.preventDefault(); }
});

// ---------- "panel is on the right" hint ----------
// Chrome doesn't tell extensions which side the panel is on. A mouse event does:
// screenX - clientX is the panel's left edge on screen; compare it with the browser window's centre.
async function checkSide(e) {
  try { if (localStorage.getItem('sideHintDismissed')) return; } catch {}
  const panelLeft = e.screenX - e.clientX;
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (!win) return;
  $('#side-hint').hidden = panelLeft < win.left + win.width / 2;
}
let sideChecked = 0;
document.addEventListener('mousemove', (e) => {
  if (Date.now() - sideChecked < 5000 || windowId == null) return;
  sideChecked = Date.now();
  checkSide(e);
});

// ---------- "Closed … · Undo" chip ----------
// The panel remembers what each open tab is (so it still knows after Chrome closed it). Tabs closed in
// this window within a moment of each other are grouped into one chip; Undo restores them all.
let known = new Map(); // tabId → { url, title, itemId?, favId? }
function rememberTabs() {
  known = new Map();
  const walk = (nodes) => nodes.forEach((n) => {
    if (n.type === 'folder') walk(n.children);
    else if (n.tab) known.set(n.tab.id, { url: n.tab.url, title: n.title || n.tab.title, itemId: n.id });
  });
  for (const s of state.spaces) {
    for (const t of s.today) known.set(t.id, { url: t.url, title: t.title });
    walk(s.pinned);
  }
  for (const f of state.favorites) if (f.tab) known.set(f.tab.id, { url: f.tab.url, title: f.title || f.tab.title, favId: f.id });
}

let closedBatch = [], batchTimer, chipTimer;
// Loading ring from the very start of a navigation, as early as Chrome's own tab strip: the sidebar marks the
// tab itself (from the earliest navigation event, or the Command Bar's "about to open" note) and redraws at
// once, instead of waiting for the full state from the background. Cleared when the page has loaded or
// failed, or after 20 s.
const opening = new Map(); // tabId → timer
function markOpening(tabId) {
  if (tabId == null || tabId < 0) return;
  clearTimeout(opening.get(tabId));
  opening.set(tabId, setTimeout(() => { opening.delete(tabId); schedule(); }, 20e3));
  if (state) render();
}
function doneOpening(tabId) {
  if (!opening.has(tabId)) return;
  clearTimeout(opening.get(tabId));
  opening.delete(tabId);
  schedule();
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'tabOpening') markOpening(msg.tabId);
  return false;
});
chrome.webNavigation?.onBeforeNavigate.addListener((d) => { if (d.frameId === 0) markOpening(d.tabId); });
chrome.webNavigation?.onCompleted.addListener((d) => { if (d.frameId === 0) doneOpening(d.tabId); });
chrome.webNavigation?.onErrorOccurred.addListener((d) => { if (d.frameId === 0) doneOpening(d.tabId); });
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'complete') doneOpening(tabId); });
const isLoading = (t) => !!t && (t.loading || opening.has(t.id));

chrome.tabs.onRemoved.addListener((tabId, info) => {
  if (info.isWindowClosing || info.windowId !== windowId) return;
  const k = known.get(tabId);
  if (!k?.url || !/^https?:|^file:/.test(k.url)) return; // empty new tabs etc. aren't worth an undo
  closedBatch.push(k);
  clearTimeout(batchTimer);
  batchTimer = setTimeout(showUndo, 250);
});

function showUndo() {
  const batch = closedBatch;
  closedBatch = [];
  if (!batch.length) return;
  const chip = $('#undo-chip');
  const what = batch.length === 1 ? `<b>${esc(batch[0].title || batch[0].url)}</b>` : `<b>${batch.length} tabs</b>`;
  chip.innerHTML = `<span class="uc-text">Closed ${what}</span><button class="uc-btn">Undo</button><button class="uc-x" title="Dismiss">×</button>`;
  // Sit just above the mini player (or the Space bar) so it doesn't cover them.
  const above = !$('#player').hidden ? $('#player') : document.querySelector('.spacebar');
  chip.style.bottom = `${Math.max(8, innerHeight - above.getBoundingClientRect().top + 6)}px`;
  chip.hidden = false;
  chip.querySelector('.uc-btn').onclick = () => {
    chip.hidden = true;
    act('undoClose', { tabs: batch.map(({ url, itemId, favId }) => ({ url, itemId, favId })) });
  };
  chip.querySelector('.uc-x').onclick = () => { chip.hidden = true; };
  clearTimeout(chipTimer);
  chipTimer = setTimeout(() => { chip.hidden = true; }, 6000);
}

// ---------- focus mode (Pomodoro) ----------
// A tomato in the bottom-left corner of the sidebar. Click it to start; while focus runs, a ring around it fills up as the
// phase runs out, and hovering it unfolds the countdown and the controls. While focusing, distracting
// sites are paused (see background.js) and Today shows only the current tab; Spaces work as usual.
const FOCUS_CHOICES = [['pomodoro', 'Pomodoro'], ['50', '50 min'], ['90', '90 min'], ['open', 'No limit']];
// Tomato icon: IconPark (ByteDance), Apache-2.0.
const TOMATO = `<svg viewBox="0 0 48 48" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="4"><path fill="currentColor" d="M24 44c11.046 0 20-7.387 20-16.5c0-6.442-4.475-11.799-11-14.516L29.5 14.5L30 20l-6.5-2l-6.5 2v-5.5l-3-1.516C8.022 15.837 4 21.393 4 27.5C4 36.613 12.954 44 24 44"/><path d="m23.5 4l3.809 5.117L36 9.91l-6.337 4.573L31.5 21l-8-3l-8 3l1.837-6.517L11 9.91l8.691-.793z"/></g></svg>`;
let focusReveal = false;
const focusing = () => state?.focus?.phase === 'work' && !state.focus.waiting;
/** While focusing, icons of tabs you haven't used in this focus are black and white. */
const focusDim = (tabId) => focusing() && tabId != null && (state.focus.before ?? []).includes(tabId);
let announcedEnd = '';
/** Two soft notes (no sound file needed). Plays only if the sidebar has been clicked before, as Chrome requires. */
function chime() {
  try {
    const ac = new AudioContext();
    [[880, 0], [1175, 0.18]].forEach(([hz, at]) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = hz;
      g.gain.setValueAtTime(0, ac.currentTime + at);
      g.gain.linearRampToValueAtTime(0.18, ac.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + at + 0.6);
      o.connect(g).connect(ac.destination);
      o.start(ac.currentTime + at); o.stop(ac.currentTime + at + 0.65);
    });
    setTimeout(() => ac.close().catch(() => {}), 1500);
  } catch { /* no audio */ }
}
const seenDoneAt = Date.now();
let lastDoneAt = 0;

const fmtMin = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')} min` : ''}`);
/** 1:05:09 / 24:59 */
function clock(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function renderFocus() {
  const f = state?.focus;
  const el = $('#tomato');
  el.classList.toggle('on', !!f);
  el.classList.toggle('break', f?.phase === 'break');
  document.body.classList.toggle('focus', focusing());
  if (!focusing()) focusReveal = false;
  if (!f) {
    setHTML(el, `<button class="ft" data-cmd="focus-start" title="Start focus: 25 min, then a 5 min break&#10;Distracting sites are paused while you focus&#10;Right-click for other timers">
        <span class="ft-ico">${TOMATO}</span>
        <span class="ft-more"><span class="ft-label">Start focus</span><span class="ft-sub">25 + 5 min</span></span>
      </button>`);
  } else {
    const round = f.mode === 'pomodoro' ? `<span class="ft-sub" title="Pomodoro round ${f.round}">#${f.round}</span>` : '';
    if (f.waiting) {
      // The phase is over: the next one starts on a click. Say so once, with a short chime.
      const key = `${f.round}:${f.phase}`;
      if (announcedEnd !== key) {
        announcedEnd = key;
        if (Date.now() - (f.phaseEndsAt ?? 0) < 90e3) chime(); // only right when it ends, not on opening later
        toast(f.phase === 'work' ? `Round ${f.round} done. Click the tomato to start a 5 min break.` : 'Break is over. Click the tomato for the next round.', 10000);
      }
      const next = f.phase === 'work' ? 'Start break' : 'Start focus';
      const tip = f.phase === 'work' ? `Round ${f.round} done. Click to start a ${5} min break` : 'Break is over. Click to start the next round';
      setHTML(el, `<div class="ft waiting">
          <button class="ft-ico" data-cmd="focus-next" title="${tip}">${TOMATO}</button>
          <span class="ft-more">
            <button class="ft-main" data-cmd="focus-next" title="${tip}"><span class="ft-label">${next}</span>${round}</button>
            <button class="btn-icon" data-cmd="focus-end" title="End focus">×</button>
          </span>
        </div>`);
      el.style.setProperty('--p', '1');
      el.classList.add('waiting');
      return;
    }
    el.classList.remove('waiting');
    const tip = f.phase === 'break' ? 'Break: distracting sites are open' : 'Focus: distracting sites are paused';
    setHTML(el, `<div class="ft">
        <button class="ft-ico" data-cmd="focus-menu" title="${tip}&#10;Click for options">${TOMATO}</button>
        <span class="ft-more">
          <button class="ft-main" data-cmd="focus-menu" title="${tip}&#10;Click for options">
            <span class="ft-label">${f.phase === 'break' ? 'Break' : 'Focus'}</span>${round}<span class="ft-time"></span>
          </button>
          <button class="btn-icon" data-cmd="focus-end" title="End focus">×</button>
        </span>
      </div>`);
    tickFocus();
  }
  const done = state?.focusDone;
  if (done && done.at > seenDoneAt && done.at !== lastDoneAt) {
    lastDoneAt = done.at;
    if (done.finished || done.rounds) {
      toast(`Focus done · ${fmtMin(done.minutes)}${done.rounds ? ` · ${done.rounds} round${done.rounds === 1 ? '' : 's'}` : ''}`, 6000);
    }
  }
}

/** Every second: the countdown and how much of the ring is filled (a full ring = the phase is over). */
function tickFocus() {
  const f = state?.focus;
  if (!f || f.waiting) return;
  const el = $('#tomato');
  const now = Date.now();
  let text, p = 0;
  if (f.phaseEndsAt) {
    text = clock(f.phaseEndsAt - now);
    p = Math.min(1, Math.max(0, (now - f.phaseStartedAt) / (f.phaseEndsAt - f.phaseStartedAt)));
  } else {
    text = clock(now - f.phaseStartedAt); // no limit: count up
  }
  const time = el.querySelector('.ft-time');
  if (time && time.textContent !== text) time.textContent = text;
  el.style.setProperty('--p', p.toFixed(4));
}
setInterval(tickFocus, 1000);

/** One click and it runs: Pomodoro by default; other timers are in the button's right-click menu. */
const startFocus = (mode = 'pomodoro') => act('startFocus', { mode });

async function focusSitesDialog() {
  const sites = await send('getFocusSites', { windowId }).catch(() => []);
  const v = await openModal({
    title: 'Paused during focus',
    fields: [{
      name: 'sites', type: 'textarea', label: `One site per line (${(sites ?? []).length})`, value: (sites ?? []).join('\n'),
      note: 'Subdomains are included. Your Favorites, Pinned tabs and music sites are never paused.',
    }],
  });
  if (v) act('setFocusSites', { sites: v.sites.split(/[\s,]+/).filter(Boolean) });
}

function focusMenu() {
  const f = state.focus;
  if (!f) return [
    { heading: 'Start focus' },
    ...FOCUS_CHOICES.map(([mode, label]) => ({ label: mode === 'pomodoro' ? 'Pomodoro · 25 + 5 min' : label, run: () => startFocus(mode) })),
    { separator: true },
    { label: 'Paused sites…', run: focusSitesDialog },
  ];
  return [
    ...(f.mode === 'pomodoro' ? [{ label: f.phase === 'work' ? 'Take a break now' : 'Skip break', run: () => act('skipFocusPhase') }] : []),
    ...(f.mode === 'timer' ? [{ label: 'Add 10 minutes', run: () => act('extendFocus', { minutes: 10 }) }] : []),
    ...(focusing() ? [{ label: focusReveal ? 'Hide other tabs' : 'Show all tabs', run: () => { focusReveal = !focusReveal; render(); } }] : []),
    { label: 'Paused sites…', run: focusSitesDialog },
    { separator: true },
    { label: 'End focus', run: () => act('endFocus') },
  ];
}

$('#settings').innerHTML = icon('gear-six');


// By domain: pointing at a tab in a split view lights up its partner in the other group.
document.addEventListener('mouseover', (e) => {
  const row = e.target.closest?.('.row.tab[data-split]');
  const id = row?.dataset.split ?? null;
  if (id === litSplit) return;
  document.querySelectorAll('.split-lit').forEach((el) => el.classList.remove('split-lit'));
  litSplit = id;
  if (id != null && row.querySelector('.split-mark')) {
    document.querySelectorAll(`.row.tab[data-split="${CSS.escape(id)}"]`).forEach((el) => { if (el !== row) el.classList.add('split-lit'); });
  }
});
let litSplit = null;

// ---------- live updates ----------
for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onActivated', 'onAttached', 'onDetached']) {
  chrome.tabs[ev].addListener(schedule);
}
for (const ev of ['onCreated', 'onUpdated', 'onRemoved', 'onMoved']) chrome.tabGroups[ev].addListener(schedule);
chrome.storage.onChanged.addListener(schedule);

(async () => {
  windowId = (await chrome.windows.getCurrent()).id;
  // Tell the background this window's sidebar is open; it may ask it to close (the sidebar shortcut).
  const panelPort = chrome.runtime.connect({ name: 'sidebar' });
  panelPort.postMessage({ windowId });
  panelPort.onMessage.addListener((m) => { if (m?.type === 'close') window.close(); });
  refresh();
})();


