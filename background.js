// Background service worker: the single source of truth.
//
// Persistent (chrome.storage.local):
//   spaces:    [{ id, name, icon, emoji (legacy), color, pinned: Tree }]
//   favorites: [{ id, url, title }]
// Session (chrome.storage.session — cleared on browser restart, same lifetime as tab/group ids):
//   wins:       { [windowId]: { active: spaceId, groups: { [spaceId]: groupId } } }
//   links:      { [itemId | favId]: tabId }          // which open tab a Pinned item / Favorite is
//   lastTab:    { ["windowId:spaceId"]: tabId }      // tab to return to when switching back
//   lastActive: spaceId                              // default Space for new windows
//
// Tree node: { id, type: 'item', url, title } | { id, type: 'folder', name, icon, collapsed, children: Tree }

import { COLORS, spaceTitle, sameUrl, samePage, realIconFor } from './shared.js';

const uid = () => crypto.randomUUID().slice(0, 8);

// ---------- serial queue: every mutation runs one at a time ----------
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn);
  chain = p.catch((e) => console.error('[spaces]', e));
  return p;
}

// ---------- tab edits with retry ----------
// Chrome rejects tab/group edits while the user drags a tab or a group animates
// ("Tabs cannot be edited right now"). Retry for up to a few seconds.
async function retry(fn, tries = 15) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !/cannot be edited right now|dragging/i.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 120 + i * 40));
    }
  }
}
const api = {
  group: (o) => retry(() => chrome.tabs.group(o)),
  move: (id, o) => retry(() => chrome.tabs.move(id, o)),
  update: (id, o) => retry(() => chrome.tabs.update(id, o)),
  remove: (ids) => retry(() => chrome.tabs.remove(ids)),
  updateGroup: (id, o) => retry(() => chrome.tabGroups.update(id, o)),
};

// ---------- storage ----------
async function getData() {
  const d = await chrome.storage.local.get(['spaces', 'favorites']);
  return { spaces: d.spaces ?? [], favorites: d.favorites ?? [] };
}
const saveData = (data) => chrome.storage.local.set({ spaces: data.spaces, favorites: data.favorites });

async function getSess() {
  const s = await chrome.storage.session.get(['wins', 'links', 'lastTab', 'lastActive']);
  return { wins: s.wins ?? {}, links: s.links ?? {}, lastTab: s.lastTab ?? {}, lastActive: s.lastActive ?? null };
}
const saveSess = (S) => chrome.storage.session.set(S);

// ---------- tree helpers ----------
function* walk(tree) {
  for (const n of tree) {
    yield n;
    if (n.type === 'folder') yield* walk(n.children);
  }
}
const items = (tree) => [...walk(tree)].filter((n) => n.type === 'item');

function locate(tree, id) {
  for (let i = 0; i < tree.length; i++) {
    const n = tree[i];
    if (n.id === id) return { arr: tree, i, node: n };
    if (n.type === 'folder') {
      const r = locate(n.children, id);
      if (r) return r;
    }
  }
  return null;
}

function insertNode(tree, node, targetId, position) {
  const loc = targetId ? locate(tree, targetId) : null;
  if (!loc) return void tree.push(node);
  if (position === 'into' && loc.node.type === 'folder') {
    loc.node.children.push(node);
    loc.node.collapsed = false;
    return;
  }
  loc.arr.splice(position === 'after' ? loc.i + 1 : loc.i, 0, node);
}

function findNode(data, id) {
  for (const space of data.spaces) {
    const loc = locate(space.pinned, id);
    if (loc) return { space, ...loc };
  }
  return null;
}

// ---------- tab / group helpers ----------
async function tabOrNull(id) {
  if (id == null) return null;
  try { return await chrome.tabs.get(id); } catch { return null; }
}
async function groupExists(id) {
  try { await chrome.tabGroups.get(id); return true; } catch { return false; }
}
/** A browser window Spaces works in: not Incognito, and not a floating picture-in-picture window (Meet's
    small call video when you switch tabs), which Chrome also reports as a window with a tab. */
const isSpacesWindow = (w) => !!w && w.type === 'normal' && !w.incognito && !w.alwaysOnTop;
async function isNormalWindow(windowId) {
  try { return isSpacesWindow(await chrome.windows.get(windowId)); } catch { return false; }
}
const spaceOfGroup = (win, groupId) =>
  groupId === -1 || !win ? null : Object.keys(win.groups).find((sid) => win.groups[sid] === groupId) ?? null;

function unlinkTab(S, tabId) {
  for (const [k, v] of Object.entries(S.links)) if (v === tabId) delete S.links[k];
}
const linkedKey = (S, tabId) => Object.keys(S.links).find((k) => S.links[k] === tabId) ?? null;

/** Put tabs into the Space's group in that window, creating the group if needed. */
/** Take a tab out of Chrome's split view, if it's in one (its partner becomes a normal tab too). */
async function unsplitTab(tabId) {
  const t = await tabOrNull(tabId);
  if (t && (t.splitViewId ?? -1) !== -1 && typeof chrome.tabs.unsplit === 'function') await chrome.tabs.unsplit(t.splitViewId).catch(() => {});
}

const ADOPT_DELAY = 500; // ms a loose tab waits before joining the active Space (see adoptLooseTab)

async function groupInto(windowId, spaceId, tabIds, data, S) {
  const win = S.wins[windowId];
  const space = data.spaces.find((s) => s.id === spaceId);
  if (!win || !space || !tabIds.length) return null;
  let gid = win.groups[spaceId];
  if (gid != null && !(await groupExists(gid))) gid = null;
  if (gid != null) {
    await api.group({ groupId: gid, tabIds });
  } else {
    gid = await api.group({ tabIds, createProperties: { windowId } });
    win.groups[spaceId] = gid;
    await api.updateGroup(gid, groupLook(space, spaceId === win.active));
  }
  return gid;
}

// The active Space's group can't be collapsed (Chrome won't keep the active tab in a collapsed group),
// so it is made as quiet as possible instead: no name and grey. The others are collapsed and show
// their Space name and colour. The name is how groups are found again after a restart, so the
// unnamed one is matched to the last active Space (see reconcileWindow).
const HIDDEN_LOOK = { title: '', color: 'grey', collapsed: false };
const groupLook = (space, active) => (active ? HIDDEN_LOOK : { title: spaceTitle(space), color: space.color, collapsed: true });

/** Collapse every Space group except the active one (which is shown unnamed and grey).
    Call only after the active tab is in the active Space. */
async function collapseOthers(windowId, win) {
  const { spaces } = await getData();
  const groups = await chrome.tabGroups.query({ windowId });
  for (const g of groups) {
    const sid = spaceOfGroup(win, g.id);
    const space = sid && spaces.find((x) => x.id === sid);
    if (!space) continue;
    const want = groupLook(space, sid === win.active);
    if (g.title !== want.title || g.color !== want.color || g.collapsed !== want.collapsed) {
      await api.updateGroup(g.id, want).catch(() => {});
    }
  }
  if (win.active) chrome.storage.local.set({ lastActiveSpace: win.active }).catch(() => {});
}

// ---------- reconciliation (startup, new windows, after restarts) ----------
async function initData() {
  const data = await getData();
  if (data.spaces.length) return data;

  // First run: existing tab groups become Spaces, native pinned tabs become Favorites.
  const spaces = [{ id: uid(), name: 'Home', icon: 'house', emoji: '', color: 'blue', pinned: [] }];
  for (const g of await chrome.tabGroups.query({})) {
    const name = g.title?.trim() || `Group ${spaces.length}`;
    if (g.title !== name) await api.updateGroup(g.id, { title: name }).catch(() => {});
    if (!spaces.some((s) => spaceTitle(s) === name)) spaces.push({ id: uid(), name, icon: '', emoji: '', color: g.color, pinned: [] });
  }
  const favorites = [];
  for (const t of await chrome.tabs.query({ pinned: true })) {
    const url = t.url || t.pendingUrl;
    if (url && !favorites.some((f) => sameUrl(f.url, url))) favorites.push({ id: uid(), url, title: t.title || url });
  }
  data.spaces = spaces;
  data.favorites = favorites;
  await saveData(data);
  return data;
}

async function reconcileWindow(windowId, data, S) {
  const win = S.wins[windowId] ?? { active: null, groups: {} };
  S.wins[windowId] = win;
  const groups = await chrome.tabGroups.query({ windowId });
  const byId = new Map(groups.map((g) => [g.id, g]));

  for (const [sid, gid] of Object.entries(win.groups)) {
    if (!byId.has(gid) || !data.spaces.some((s) => s.id === sid)) delete win.groups[sid];
  }
  const used = new Set(Object.values(win.groups));
  for (const s of data.spaces) {
    if (win.groups[s.id] != null) continue;
    const g = groups.find((g) => !used.has(g.id) && g.title === spaceTitle(s));
    if (g) { win.groups[s.id] = g.id; used.add(g.id); }
  }
  // The active Space's group is unnamed and grey: give it to the Space that was active last,
  // or else to the first Space that has no group in this window.
  const unnamed = groups.find((g) => !used.has(g.id) && !g.title && g.color === 'grey');
  if (unnamed) {
    const { lastActiveSpace } = await chrome.storage.local.get('lastActiveSpace');
    const target = [lastActiveSpace, ...data.spaces.map((x) => x.id)]
      .find((sid) => sid && data.spaces.some((x) => x.id === sid) && win.groups[sid] == null);
    if (target) { win.groups[target] = unnamed.id; used.add(unnamed.id); }
  }

  if (!data.spaces.some((s) => s.id === win.active)) {
    const [activeTab] = await chrome.tabs.query({ windowId, active: true });
    win.active =
      spaceOfGroup(win, activeTab?.groupId ?? -1) ??
      (data.spaces.some((s) => s.id === S.lastActive) ? S.lastActive : null) ??
      data.spaces[0]?.id ?? null;
  }

  // Loose tabs join the active Space a moment later (see ADOPT_DELAY): in a window that another extension
  // has just opened, its tab may be on its way into that extension's own group.
  for (const t of await chrome.tabs.query({ windowId })) {
    if (!t.pinned && t.groupId === -1) setTimeout(() => serial(() => adoptLooseTab(t.id)), ADOPT_DELAY);
  }
}

/** Re-attach Pinned items / Favorites to open tabs (tab ids change after a restart). */
async function relinkAll(data, S) {
  let deduped = false;
  // Duplicate Favorites (same address) left by older versions: keep the first, move its link if needed.
  for (let i = data.favorites.length - 1; i >= 0; i--) {
    const f = data.favorites[i];
    const first = data.favorites.findIndex((g) => g !== f && sameUrl(g.url, f.url));
    if (first < 0 || first > i) continue;
    const keep = data.favorites[first];
    if (S.links[keep.id] == null && S.links[f.id] != null) S.links[keep.id] = S.links[f.id];
    delete S.links[f.id];
    data.favorites.splice(i, 1);
    deduped = true;
  }
  const tabs = await chrome.tabs.query({});
  const alive = new Set(tabs.map((t) => t.id));
  for (const [k, v] of Object.entries(S.links)) if (!alive.has(v)) delete S.links[k];
  const linked = new Set(Object.values(S.links));
  const take = (t, key) => { S.links[key] = t.id; linked.add(t.id); };

  for (const f of data.favorites) {
    if (S.links[f.id] != null) continue;
    const t = tabs.find((t) => t.pinned && !linked.has(t.id) && sameUrl(t.url || t.pendingUrl, f.url));
    if (t) take(t, f.id);
  }
  // A Favorite's tab may have moved to another page of the same site (an article instead of the
  // front page): match the remaining pinned tabs by host, so they don't turn into duplicate Favorites.
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  for (const f of data.favorites) {
    if (S.links[f.id] != null) continue;
    const h = hostOf(f.url);
    const t = h && tabs.find((t) => t.pinned && !linked.has(t.id) && hostOf(t.url || t.pendingUrl) === h);
    if (t) take(t, f.id);
  }
  // Any other native pinned tab is a Favorite too: one you pinned in Chrome yourself. Not a pinned tab of a
  // site that already is a Favorite (its copy in another window, or a tab Chrome is still restoring after a
  // restart), and not one without a real address yet — those used to turn into duplicate Favorites.
  let changed = false;
  const favHosts = new Set(data.favorites.map((f) => hostOf(f.url)));
  for (const t of tabs) {
    if (!t.pinned || linked.has(t.id)) continue;
    const u = t.url || t.pendingUrl || '';
    if (!/^(https?|file):/.test(u) || favHosts.has(hostOf(u))) continue;
    favHosts.add(hostOf(u));
    const fav = { id: uid(), url: t.url || t.pendingUrl || '', title: t.title || '' };
    data.favorites.push(fav);
    take(t, fav.id);
    changed = true;
  }
  for (const s of data.spaces) {
    const gids = new Set(Object.values(S.wins).map((w) => w.groups[s.id]).filter((g) => g != null));
    for (const item of items(s.pinned)) {
      if (S.links[item.id] != null) continue;
      const t = tabs.find((t) => gids.has(t.groupId) && !linked.has(t.id) && sameUrl(t.url || t.pendingUrl, item.url));
      if (t) take(t, item.id);
    }
    // Same for Pinned items whose tab moved within its site.
    for (const item of items(s.pinned)) {
      if (S.links[item.id] != null) continue;
      const h = hostOf(item.url);
      const t = h && tabs.find((t) => gids.has(t.groupId) && !linked.has(t.id) && hostOf(t.url || t.pendingUrl) === h);
      if (t) take(t, item.id);
    }
  }
  if (changed || deduped) await saveData(data);
}

async function reconcileAll() {
  const data = await initData();
  const S = await getSess();
  const wins = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter(isSpacesWindow);
  const live = new Set(wins.map((w) => String(w.id)));
  for (const k of Object.keys(S.wins)) if (!live.has(k)) delete S.wins[k];
  for (const w of wins) await reconcileWindow(w.id, data, S);
  await relinkAll(data, S);
  await saveSess(S);
  // Apply the group look (others collapsed and named, the active one unnamed and grey).
  for (const w of wins) if (S.wins[w.id]) await collapseOthers(w.id, S.wins[w.id]);
}

/** Load state for a window, reconciling it the first time we see it. Returns null for non-normal windows. */
async function ctx(windowId) {
  if (windowId != null && !(await isNormalWindow(windowId))) return null;
  const data = await initData();
  const S = await getSess();
  if (windowId != null && !S.wins[windowId]) {
    await reconcileWindow(windowId, data, S);
    await relinkAll(data, S);
    await saveSess(S);
  }
  return { data, S, win: windowId != null ? S.wins[windowId] : null };
}

// ---------- core operations ----------
async function switchSpace(windowId, spaceId, data, S) {
  const win = S.wins[windowId];
  if (!win || !data.spaces.some((s) => s.id === spaceId)) return;
  win.active = spaceId;
  S.lastActive = spaceId;
  let gid = win.groups[spaceId];
  if (gid != null && !(await groupExists(gid))) { delete win.groups[spaceId]; gid = null; }
  const tabs = gid != null ? await chrome.tabs.query({ windowId, groupId: gid }) : [];
  const target = tabs.find((t) => t.id === S.lastTab[`${windowId}:${spaceId}`]) ?? tabs.at(-1);
  if (target) {
    await api.update(target.id, { active: true });
  } else {
    const t = await chrome.tabs.create({ windowId, active: true });
    await groupInto(windowId, spaceId, [t.id], data, S);
  }
  await collapseOthers(windowId, win);
}

async function cycleSpace(windowId, dir, data, S) {
  const win = S.wins[windowId];
  const i = data.spaces.findIndex((s) => s.id === win?.active);
  if (i < 0 || data.spaces.length < 2) return;
  const next = data.spaces[(i + dir + data.spaces.length) % data.spaces.length];
  await switchSpace(windowId, next.id, data, S);
}

/** Open (or focus) a tab for a Pinned item. */
async function openItem(windowId, itemId, data, S) {
  const found = findNode(data, itemId);
  if (!found || found.node.type !== 'item') return;
  const existing = await tabOrNull(S.links[itemId]);
  if (existing && existing.windowId === windowId) {
    await api.update(existing.id, { active: true });
    return;
  }
  // Already open in another window: don't jump there, open it here too (as a normal tab of this Space).
  if (existing) return openHereOnce(windowId, found.node.url, { group: S.wins[windowId]?.groups[found.space.id] }, data, S);
  const win = S.wins[windowId];
  win.active = found.space.id;
  S.lastActive = found.space.id;
  const t = await chrome.tabs.create({ windowId, url: found.node.url, active: true });
  await groupInto(windowId, found.space.id, [t.id], data, S);
  S.links[itemId] = t.id;
  await collapseOthers(windowId, win);
}

/** A Favorite (pinned: true) or Pinned item whose tab lives in another window: this window's tab of the same
    site if there is one (a pinned tab for a Favorite, a tab of that Space for an item), else one new tab
    here — so clicking it again doesn't open another and another. */
async function openHereOnce(windowId, url, { pinned = false, group = null }, data, S) {
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const here = (await chrome.tabs.query({ windowId })).find((t) => (pinned ? t.pinned : group != null && t.groupId === group)
    && (samePage(t.url || t.pendingUrl, url) || (pinned && host(t.url || t.pendingUrl) === host(url))));
  if (here) { await api.update(here.id, { active: true }); return; }
  if (pinned) { await chrome.tabs.create({ windowId, url, pinned: true, active: true }); return; }
  return openCopyHere(windowId, url, data, S);
}

/** A Pinned item or Favorite whose tab lives in another window: a plain copy here, in the active Space. */
async function openCopyHere(windowId, url, data, S) {
  const t = await chrome.tabs.create({ windowId, url, active: true });
  const active = S.wins[windowId]?.active;
  if (active) await groupInto(windowId, active, [t.id], data, S);
}

async function openFavorite(windowId, favId, data, S) {
  const fav = data.favorites.find((f) => f.id === favId);
  if (!fav) return;
  const existing = await tabOrNull(S.links[favId]);
  if (existing && existing.windowId === windowId) {
    await api.update(existing.id, { active: true });
    return;
  }
  if (existing) return openHereOnce(windowId, fav.url, { pinned: true }, data, S);
  const t = await chrome.tabs.create({ windowId, url: fav.url, pinned: true, active: true });
  S.links[favId] = t.id;
}

/** Make an open tab a Favorite (native pinned tab), or add a Favorite from a URL. */
async function addFavorite({ tabId, url, title, beforeFavId }, data, S) {
  let fav;
  if (tabId != null) {
    const t = await tabOrNull(tabId);
    if (!t) return;
    const key = linkedKey(S, t.id);
    if (key && data.favorites.some((f) => f.id === key)) return; // already a Favorite
    if (key) delete S.links[key]; // was a Pinned item's tab: the item stays, now closed
    fav = { id: uid(), url: t.url || t.pendingUrl || '', title: t.title || '' };
    S.links[fav.id] = t.id;
    await api.update(t.id, { pinned: true });
  } else {
    fav = { id: uid(), url, title: title || url };
  }
  const at = beforeFavId ? data.favorites.findIndex((f) => f.id === beforeFavId) : -1;
  if (at >= 0) data.favorites.splice(at, 0, fav); else data.favorites.push(fav);
}

async function removeFavorite(windowId, favId, data, S) {
  data.favorites = data.favorites.filter((f) => f.id !== favId);
  const t = await tabOrNull(S.links[favId]);
  delete S.links[favId];
  if (t) {
    await api.update(t.id, { pinned: false });
    const win = S.wins[t.windowId];
    if (win?.active) await groupInto(t.windowId, win.active, [t.id], data, S);
  }
}

/** Pin an open tab into the active Space's Pinned tree. */
async function pinTab({ tabId, targetId, position }, data, S) {
  const t = await tabOrNull(tabId);
  if (!t) return;
  const win = S.wins[t.windowId];
  let spaceId = spaceOfGroup(win, t.groupId) ?? win?.active;
  const space = data.spaces.find((s) => s.id === spaceId);
  if (!space) return;
  const key = linkedKey(S, t.id);
  if (key && data.favorites.some((f) => f.id === key)) {
    // From Favorites: un-favorite it and bring it into the Space.
    data.favorites = data.favorites.filter((f) => f.id !== key);
    delete S.links[key];
    await api.update(t.id, { pinned: false });
    await groupInto(t.windowId, space.id, [t.id], data, S);
  } else if (key) {
    return; // already pinned
  }
  const node = { id: uid(), type: 'item', url: t.url || t.pendingUrl || '', title: t.title || '' };
  insertNode(space.pinned, node, targetId, position);
  S.links[node.id] = t.id;
}

async function moveTabToSpace(tabId, spaceId, data, S) {
  const t = await tabOrNull(tabId);
  if (!t || !data.spaces.some((s) => s.id === spaceId)) return;
  const win = S.wins[t.windowId];
  if (!win) return;
  const key = linkedKey(S, t.id);
  if (key) {
    if (data.favorites.some((f) => f.id === key)) {
      data.favorites = data.favorites.filter((f) => f.id !== key);
      await api.update(t.id, { pinned: false });
    }
    delete S.links[key]; // a Pinned item stays in its own Space, closed
  }
  if (t.active && spaceId !== win.active) {
    S.lastTab[`${t.windowId}:${spaceId}`] = t.id;
    win.active = spaceId;
    S.lastActive = spaceId;
    await groupInto(t.windowId, spaceId, [t.id], data, S);
    await collapseOthers(t.windowId, win);
  } else {
    await groupInto(t.windowId, spaceId, [t.id], data, S);
  }
}

async function reorderToday(windowId, tabId, beforeTabId, data, S) {
  const win = S.wins[windowId];
  const t = await tabOrNull(tabId);
  const gid = win?.groups[win.active];
  if (!t || gid == null) return;
  const key = linkedKey(S, tabId);
  if (key) {
    // Dragged from Favorites or Pinned into Today.
    if (data.favorites.some((f) => f.id === key)) {
      data.favorites = data.favorites.filter((f) => f.id !== key);
      await api.update(tabId, { pinned: false });
    } else {
      const found = findNode(data, key);
      if (found) found.arr.splice(found.i, 1);
    }
    delete S.links[key];
  }
  const groupTabs = await chrome.tabs.query({ windowId, groupId: gid });
  const fresh = await tabOrNull(tabId);
  const before = groupTabs.find((x) => x.id === beforeTabId);
  let index = before ? before.index : (groupTabs.at(-1)?.index ?? fresh.index) + 1;
  if (fresh.windowId === windowId && fresh.index < index) index -= 1;
  await api.move(tabId, { windowId, index });
  const moved = await tabOrNull(tabId);
  if (moved && moved.groupId !== gid) await api.group({ groupId: gid, tabIds: [tabId] });
}

async function createSpace(windowId, { name, icon, color }, data, S) {
  const used = new Set(data.spaces.map((s) => s.color));
  const space = {
    id: uid(),
    name: (name || '').trim() || `Space ${data.spaces.length + 1}`,
    icon: icon || '',
    emoji: '',
    color: COLORS.includes(color) ? color : COLORS.find((c) => !used.has(c)) ?? 'grey',
    pinned: [],
  };
  data.spaces.push(space);
  await saveData(data);
  if (windowId != null && S.wins[windowId]) await switchSpace(windowId, space.id, data, S);
  return space.id;
}

async function updateSpace(spaceId, patch, data, S) {
  const space = data.spaces.find((s) => s.id === spaceId);
  if (!space) return;
  if (patch.name != null && patch.name.trim()) space.name = patch.name.trim();
  if (patch.icon) { space.icon = patch.icon; space.emoji = ''; }
  if (['manual', 'domain', 'title', 'recent'].includes(patch.todaySort)) space.todaySort = patch.todaySort;
  if (COLORS.includes(patch.color)) space.color = patch.color;
  for (const win of Object.values(S.wins)) {
    const gid = win.groups[spaceId];
    if (gid != null) await api.updateGroup(gid, groupLook(space, win.active === spaceId)).catch(() => {});
  }
}

async function deleteSpace(spaceId, data, S) {
  if (data.spaces.length < 2) throw new Error('You can’t delete the last Space');
  const idx = data.spaces.findIndex((s) => s.id === spaceId);
  if (idx < 0) return;
  const fallback = data.spaces[idx === 0 ? 1 : idx - 1].id;
  for (const [wid, win] of Object.entries(S.wins)) {
    if (win.active === spaceId) await switchSpace(Number(wid), fallback, data, S);
    const gid = win.groups[spaceId];
    if (gid != null) {
      const tabs = await chrome.tabs.query({ groupId: gid });
      if (tabs.length) await api.remove(tabs.map((t) => t.id));
      delete win.groups[spaceId];
    }
  }
  for (const item of items(data.spaces[idx].pinned)) delete S.links[item.id];
  data.spaces.splice(idx, 1);
  if (S.lastActive === spaceId) S.lastActive = fallback;
}

// ---------- state for the UI ----------
async function getState(windowId) {
  const c = await ctx(windowId);
  if (!c) return null;
  const { data, S, win } = c;
  const allTabs = await chrome.tabs.query({});
  const byId = new Map(allTabs.map((t) => [t.id, t]));
  const parents = await getParents();
  const mediaNow = await getMedia();
  const orderKeys = await getOrderKeys();
  const realIcons = await getRealIcons();
  const picture = await getTabPicture();
  const spacesWins = new Set((await chrome.windows.getAll({ windowTypes: ['normal'] })).filter(isSpacesWindow).map((w) => w.id));
  const { copies = {} } = await chrome.storage.session.get('copies'); // copy tab id → the grey tab it came from
  const tabInfo = (t) => t && {
    id: t.id, title: t.title, url: t.url || t.pendingUrl || '', favIconUrl: realFavicon(t, realIcons),
    active: t.active && t.windowId === windowId, audible: !!t.audible, muted: !!t.mutedInfo?.muted, windowId: t.windowId, lastAccessed: t.lastAccessed ?? 0, discarded: !!t.discarded, loading: t.status === 'loading',
    openerTabId: parents[t.id] ?? null, // the tab it was really opened from (see "tab tree" below)
    inCall: !!mediaNow[t.id]?.capturing, // using the camera or microphone: a call (green dot)
    order: orderKeys[t.id] ?? t.id, // place in "Newest first", the same in every window (see "tab order" below)
    split: t.splitViewId ?? -1, // Chrome's split view: both tabs of a pair share it (-1 = not split)
  };

  const counts = {};
  for (const [sid, gid] of Object.entries(win.groups)) counts[sid] = allTabs.filter((t) => t.groupId === gid).length;

  const active = data.spaces.find((s) => s.id === win.active) ?? data.spaces[0];
  const linkedTabIds = new Set(Object.values(S.links));
  const decorate = (tree) => tree.map((n) => {
    if (n.type === 'folder') return { ...n, children: decorate(n.children) };
    const tab = tabInfo(byId.get(S.links[n.id]));
    return { ...n, tab, moved: !!tab && !!tab.url && !samePage(tab.url, n.url) };
  });
  const todayOf = (spaceId) => {
    const gid = win.groups[spaceId];
    return gid == null ? [] : allTabs
      .filter((t) => t.windowId === windowId && t.groupId === gid && !linkedTabIds.has(t.id))
      .sort((a, b) => a.index - b.index)
      .map(tabInfo);
  };
  // The same Space's tabs in other windows (each window has its own groups): listed too, so a page that's
  // open over there can be brought here instead of opened twice.
  const elsewhereOf = (spaceId) => Object.entries(S.wins)
    .filter(([wid]) => Number(wid) !== windowId && spacesWins.has(Number(wid)))
    .flatMap(([wid, w]) => {
      const gid = w.groups?.[spaceId];
      return gid == null ? [] : allTabs.filter((t) => t.windowId === Number(wid) && t.groupId === gid && !linkedTabIds.has(t.id));
    })
    // Already open here too (e.g. after clicking it, even while it's still loading): no grey copy.
    .filter((t) => !allTabs.some((h) => h.windowId === windowId && (sameUrl(h.url, t.url) || sameUrl(h.pendingUrl, t.url) || copies[h.id] === t.id)))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    .map(tabInfo)
    // A window that just closed: its tabs keep their place (grey) until they're opened here a moment later.
    .concat(Object.entries(picture)
      .filter(([, e]) => e.moving && e.spaceId === spaceId)
      .map(([id, e]) => ({
        id: Number(id), title: e.title, url: e.url, favIconUrl: realIconFor(realIcons, e.url),
        active: false, windowId: e.windowId, lastAccessed: 0, discarded: false, order: orderKeys[id] ?? Number(id), moving: true,
      })));

  // Every Space is sent in full so the sidebar carousel can show neighbours while swiping.
  return {
    windowId,
    activeSpaceId: active?.id,
    spaces: data.spaces.map((s) => ({
      id: s.id, name: s.name, icon: s.icon || '', emoji: s.emoji, color: s.color, todaySort: s.todaySort || 'manual', tabCount: counts[s.id] ?? 0,
      pinned: decorate(s.pinned), today: todayOf(s.id), elsewhere: elsewhereOf(s.id),
    })),
    favorites: data.favorites.map((f) => ({ ...f, tab: tabInfo(byId.get(S.links[f.id])) })),
    share: await getShare(),
    player: await playerList(allTabs, await getFocus()),
    sleepAfter: await getSleepAfter(),
    plainTabIcons: (await chrome.storage.local.get('plainTabIcons')).plainTabIcons !== false, // on by default
    realIcons,
    morningReset: await getMorningReset(),
    focus: await getFocus(),
    focusDone: (await chrome.storage.session.get('focusDone')).focusDone ?? null,
    lastFocusMode: (await chrome.storage.local.get('lastFocusMode')).lastFocusMode ?? 'pomodoro',
  };
}

/** Flat index for the Command Bar: which Space each tab belongs to, and every Pinned item. */
async function getIndex(windowId) {
  const c = await ctx(windowId);
  const data = c?.data ?? (await initData());
  const S = c?.S ?? (await getSess());
  const tabSpace = {};
  const allTabs = await chrome.tabs.query({});
  for (const t of allTabs) {
    const sid = spaceOfGroup(S.wins[t.windowId], t.groupId);
    if (sid) tabSpace[t.id] = sid;
  }
  return {
    activeSpaceId: c?.win?.active ?? S.lastActive,
    spaces: data.spaces.map(({ id, name, icon, emoji, color }) => ({ id, name, icon: icon || '', emoji, color })),
    favorites: data.favorites.map((f) => ({ ...f, tabId: S.links[f.id] ?? null })),
    pinned: data.spaces.flatMap((s) => items(s.pinned).map((n) => ({ ...n, spaceId: s.id, tabId: S.links[n.id] ?? null }))),
    tabSpace,
  };
}

// ---------- message API for the side panel / Command Bar ----------
const handlers = {
  getState: ({ windowId }) => getState(windowId),
  getIndex: ({ windowId }) => getIndex(windowId),
  /** A tab group that isn't one of the Spaces: another extension's (Claude in Chrome, tab managers). */
  async isForeignGroup({ groupId }) {
    if (groupId == null || groupId === -1) return false;
    const S = await getSess();
    return !Object.values(S.wins).some((w) => Object.values(w.groups).includes(groupId));
  },
  async openCommandBar({ windowId }) { await openCommandBar(windowId); },
  async openCommandOverlay({ windowId }) { await openCommandOverlay(windowId); },

  async switchSpace({ windowId, spaceId }, c) { await switchSpace(windowId, spaceId, c.data, c.S); },
  async cycleSpace({ windowId, dir }, c) { await cycleSpace(windowId, dir, c.data, c.S); },
  async createSpace({ windowId, name, icon, color }, c) { return createSpace(windowId, { name, icon, color }, c.data, c.S); },
  async updateSpace({ spaceId, name, icon, color, todaySort }, c) { await updateSpace(spaceId, { name, icon, color, todaySort }, c.data, c.S); return 'saveData'; },
  async deleteSpace({ spaceId }, c) { await deleteSpace(spaceId, c.data, c.S); return 'saveData'; },
  async reorderSpaces({ ids }, c) {
    c.data.spaces.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    return 'saveData';
  },

  async newTab({ windowId, url }, c) {
    // An empty New Tab already open in this Space? Go to it instead of piling up another one.
    if (!url) {
      const gid = c.win.groups[c.win.active];
      const blank = gid == null ? null : (await chrome.tabs.query({ windowId, groupId: gid }))
        .find((t) => { const u = t.url || t.pendingUrl || ''; return !u || u === 'chrome://newtab/' || u.startsWith(chrome.runtime.getURL('newtab.html')); });
      if (blank) { await api.update(blank.id, { active: true }); return; }
    }
    const t = await chrome.tabs.create({ windowId, url: url || undefined, active: true });
    await groupInto(windowId, c.win.active, [t.id], c.data, c.S);
  },
  async activateTab({ tabId }) {
    const t = await api.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
  },
  /** Closing a window's last tab would close the window. If the same Space has tabs in another window,
      the topmost of them moves in first (without reloading), so the window stays. */
  async closeTab({ tabId }, c) {
    const t = await tabOrNull(tabId);
    if (!t) return;
    const here = await chrome.tabs.query({ windowId: t.windowId });
    if (here.length <= 1 && !t.pinned) {
      const win = c.S.wins[t.windowId];
      const sid = (win && spaceOfGroup(win, t.groupId)) || win?.active;
      const others = [];
      for (const [wid, w] of Object.entries(c.S.wins)) {
        const gid = w.groups?.[sid];
        if (Number(wid) === t.windowId || gid == null) continue;
        others.push(...(await chrome.tabs.query({ windowId: Number(wid), groupId: gid }).catch(() => [])));
      }
      // The one at the top of the list ("Newest first", the same order in every window).
      const keys = await getOrderKeys();
      const next = others.sort((a, b) => (keys[b.id] ?? b.id) - (keys[a.id] ?? a.id))[0];
      if (next && sid) {
        const left = await chrome.tabs.query({ windowId: next.windowId });
        if (left.length <= 1) await chrome.tabs.create({ windowId: next.windowId, active: false }).catch(() => {});
        await retry(() => chrome.tabs.move(next.id, { windowId: t.windowId, index: -1 }));
        await groupInto(t.windowId, sid, [next.id], c.data, c.S);
        await api.update(next.id, { active: true });
      }
    }
    await api.remove(tabId);
  },
  async mediaControl({ tabId, action }) {
    const m = (await getMedia())[tabId];
    if (!m) return;
    await chrome.tabs.sendMessage(tabId, { type: 'mediaControl', action }, { frameId: m.frameId ?? 0 }).catch(() => {});
  },
  async dismissMedia({ tabId }) {
    await updateMedia((m) => {
      m[tabId] = m[tabId] ? { ...m[tabId], dismissed: true } : { audibleOnly: true, playing: true, frameId: -1, at: Date.now(), dismissed: true };
    });
  },
  async screenshotTab({ tabId }) { await openScreenshot(tabId); },
  /** Drag and drop in "Newest first": the tab's new place, as a number between its new neighbours. */
  /** Chrome's split view: a tab dropped onto another opens side by side with it in that tab's window.
      Chrome wants the two next to each other, in the same window and group, and neither already split. */
  async splitTabs({ tabId, withTabId }) {
    const api = chrome.tabs;
    if (typeof api.createSplit !== 'function') throw new Error('Split view needs Chrome 155 or newer');
    let a = await tabOrNull(withTabId), b = await tabOrNull(tabId);
    if (!a || !b || a.id === b.id) return;
    if (a.pinned || b.pinned) throw new Error('Favorites can’t be split');
    if ((b.splitViewId ?? -1) !== -1) await api.unsplit(b.splitViewId);
    if ((a.splitViewId ?? -1) !== -1) await api.unsplit(a.splitViewId);
    if (b.windowId !== a.windowId) await retry(() => api.move(b.id, { windowId: a.windowId, index: -1 }));
    a = await tabOrNull(a.id);
    if (a.groupId !== -1) await api.group({ groupId: a.groupId, tabIds: [b.id] });
    else await api.ungroup(b.id).catch(() => {});
    a = await tabOrNull(a.id); b = await tabOrNull(b.id);
    if (Math.abs(b.index - a.index) !== 1) await retry(() => api.move(b.id, { index: b.index < a.index ? a.index : a.index + 1 }));
    await api.createSplit([a.id, b.id]);
    await api.update(b.id, { active: true });
    await chrome.windows.update(a.windowId, { focused: true }).catch(() => {});
  },
  async unsplitTabOf({ tabId }) { await unsplitTab(tabId); },
  async unsplitTabs({ splitId }) {
    if (typeof chrome.tabs.unsplit === 'function' && splitId != null && splitId !== -1) await chrome.tabs.unsplit(splitId);
  },
  /** Manual order in Today; `parent` is the tab it now sits under in the tree (null = top level). */
  async setTabOrder({ tabId, order, parent, unsplit = false }) {
    if (!Number.isFinite(order)) return;
    if (unsplit) await unsplitTab(tabId); // dragged away from its split-view partner
    await setOrderKeys({ ...(await getOrderKeys()), [tabId]: order });
    if (parent !== undefined) {
      await updateParents((p) => {
        if ((p[tabId] ?? null) === (parent ?? null)) return false;
        if (parent == null) delete p[tabId]; else p[tabId] = parent;
      });
    }
  },
  /** This Space's tabs in this window whose page is also open in another window (of the same Space): close
      the ones here; the other window's tab shows up grey instead. Returns how many were closed. */
  async closeCopies({ windowId, spaceId }, c) {
    const gid = c.win.groups[spaceId];
    if (gid == null) return 0;
    const all = await chrome.tabs.query({});
    const elsewhere = all.filter((t) => t.windowId !== windowId && Object.entries(c.S.wins)
      .some(([wid, w]) => Number(wid) === t.windowId && w.groups?.[spaceId] === t.groupId));
    const linked = new Set(Object.values(c.S.links));
    const ids = all.filter((t) => t.windowId === windowId && t.groupId === gid && !t.active && !linked.has(t.id)
      && elsewhere.some((o) => sameUrl(o.url, t.url))).map((t) => t.id);
    if (ids.length) await api.remove(ids);
    return ids.length;
  },
  /** A Space's tab from another window: move it here (one page lives in one window), into that Space,
      switching to it, and show it. Same tab, so its page, history and place in the list are kept; the other
      window's sidebar shows it grey in the same spot. A window never closes for losing its last tab. */
  async openHere({ windowId, tabId, spaceId }, c) {
    const src = await tabOrNull(tabId);
    if (!src) return;
    const target = c.data.spaces.some((s) => s.id === spaceId) ? spaceId : c.win.active;
    if (src.windowId !== windowId) {
      const left = await chrome.tabs.query({ windowId: src.windowId });
      if (left.length <= 1) await chrome.tabs.create({ windowId: src.windowId, active: false }).catch(() => {});
      await retry(() => chrome.tabs.move(tabId, { windowId, index: -1 }));
    }
    await groupInto(windowId, target, [tabId], c.data, c.S);
    if (target !== c.win.active) await switchSpace(windowId, target, c.data, c.S);
    await api.update(tabId, { active: true });
    await chrome.windows.update(windowId, { focused: true }).catch(() => {});
  },
  /** A tab dragged out of the sidebar: its own new window, where it was let go (same size as this one). */
  async tabToNewWindow({ windowId, tabId, left, top }) {
    await unsplitTab(tabId); // a tab pulled out of a split view goes alone
    const t = await tabOrNull(tabId);
    if (!t) return;
    const from = await chrome.windows.get(windowId ?? t.windowId).catch(() => null);
    const normal = from && from.state === 'normal';
    const width = normal ? from.width : 1200, height = normal ? from.height : 800;
    if (!(Number.isFinite(left) && Number.isFinite(top) && (left || top))) {
      await chrome.windows.create({ tabId, focused: true, width, height }).catch(() => chrome.windows.create({ tabId, focused: true }));
      return;
    }
    // The window grows out of the spot where the tab was let go, up to its full size (about a fifth of a second).
    const end = { left: Math.max(0, Math.round(left - 120)), top: Math.max(0, Math.round(top - 20)), width, height };
    const start = { left: Math.max(0, Math.round(left - 140)), top: Math.max(0, Math.round(top - 16)), width: 280, height: 180 };
    const win = await chrome.windows.create({ tabId, focused: true, ...start }).catch(() => null);
    if (!win) { await chrome.windows.create({ tabId, focused: true }).catch(() => {}); return; }
    const frames = 8;
    for (let i = 1; i <= frames; i++) {
      const k = 1 - (1 - i / frames) ** 3; // ease out
      const at = (a, b) => Math.round(a + (b - a) * k);
      await chrome.windows.update(win.id, { left: at(start.left, end.left), top: at(start.top, end.top), width: at(start.width, end.width), height: at(start.height, end.height) }).catch(() => {});
      await new Promise((r) => setTimeout(r, 16));
    }
  },
  /** Open a tab's page in an Incognito window too (an open one if the extension can see it, else a new one).
      The original tab stays. The page loads fresh there: signed out, nothing from your normal profile. */
  async toIncognito({ tabId }) {
    const t = await tabOrNull(tabId);
    if (!t) return;
    await openIncognito(t.url || t.pendingUrl, t.windowId);
  },
  /** Any address (a History or Bookmark result, a closed Pinned item) in an Incognito window. */
  async openIncognito({ url, windowId }) { await openIncognito(url, windowId); },
  async setPlainTabIcons({ on }) { await chrome.storage.local.set({ plainTabIcons: !!on }); },
  async setMorningReset({ on }) { await chrome.storage.local.set({ morningReset: !!on }); },
  async resetHomePages() { return morningReset({ force: true }); },
  async setSleepAfter({ minutes }) {
    if (SLEEP_OPTIONS.includes(minutes)) await chrome.storage.local.set({ sleepAfterMin: minutes });
  },
  async startFocus({ windowId, goal, mode }, c) { await startFocus(windowId, { goal, mode }, c); },
  async skipFocusPhase() { await focusTick({ skip: true }); },
  async endFocus() { await endFocus(false); },
  async extendFocus({ minutes }) {
    const focus = await getFocus();
    if (!focus) return;
    if (focus.mode !== 'timer' || !focus.phaseEndsAt) return;
    focus.phaseEndsAt = Math.max(focus.phaseEndsAt, Date.now()) + minutes * 60e3;
    await setFocus(focus);
    await scheduleFocusAlarm(focus);
  },
  getFocusSites: () => getFocusSites(),
  async setFocusSites({ sites }) {
    const clean = [...new Set((sites ?? []).map((x) => bareHost(/^https?:/.test(x) ? x : `https://${x.trim()}`)).filter((h) => h.includes('.')))];
    await chrome.storage.local.set({ focusSites: clean });
    const focus = await getFocus();
    if (focus) await applyFocusRules(focus);
  },
  async sleepSpace({ spaceId }, c) { return sleepInactiveSpaces({ force: true, spaceId, S: c.S }); },
  /** Undo closing tabs: restore them from Chrome's recently closed list (same place, with their history)
      and give Pinned items / Favorites their tab back. tabs: [{ url, itemId?, favId? }] */
  async undoClose({ windowId, tabs }, c) {
    let recent = [];
    try { recent = await chrome.sessions.getRecentlyClosed({ maxResults: 25 }); } catch (e) { console.warn('[spaces] recently closed', e); }
    // Closed tabs can be listed on their own or inside a closed window entry.
    const closedTabs = recent.flatMap((e) => (e.tab ? [e.tab] : e.window?.tabs ?? []));
    const used = new Set();
    for (const t of tabs ?? []) {
      const entry = closedTabs.find((x) => x.sessionId && !used.has(x.sessionId) && sameUrl(x.url, t.url));
      let restored = null;
      if (entry) {
        used.add(entry.sessionId);
        const session = await chrome.sessions.restore(entry.sessionId).catch((e) => { console.warn('[spaces] restore', e); return null; });
        restored = session?.tab ?? null;
      }
      if (!restored) {
        // Not in Chrome's list (or it couldn't restore it): open the page again in the active Space.
        restored = await chrome.tabs.create({ windowId, url: t.url, active: true, pinned: !!t.favId });
        if (!t.favId) await groupInto(windowId, c.win.active, [restored.id], c.data, c.S);
      }
      const key = t.itemId || t.favId;
      if (key) c.S.links[key] = restored.id;
    }
  },
  async toggleMute({ tabId }) {
    const t = await tabOrNull(tabId);
    if (t) await api.update(tabId, { muted: !t.mutedInfo?.muted });
  },
  async closeTabs({ tabIds }) {
    const alive = [];
    for (const id of tabIds ?? []) if (await tabOrNull(id)) alive.push(id);
    if (alive.length) await api.remove(alive);
  },
  /** Copy of a tab as a regular Today tab in the same Space (a copy of a Favorite lands in the active Space). */
  async duplicateTab({ tabId }, c) {
    const src = await tabOrNull(tabId);
    if (!src) return;
    const win = c.S.wins[src.windowId];
    const spaceId = spaceOfGroup(win, src.groupId) ?? win?.active;
    const dup = await retry(() => chrome.tabs.duplicate(tabId));
    if (!dup) return;
    if (dup.pinned) await api.update(dup.id, { pinned: false });
    if (spaceId) await groupInto(src.windowId, spaceId, [dup.id], c.data, c.S);
  },
  async clearToday({ windowId }, c) {
    const st = await getState(windowId);
    const ids = (st.spaces.find((s) => s.id === st.activeSpaceId)?.today ?? []).map((t) => t.id);
    if (!ids.length) return;
    const t = await chrome.tabs.create({ windowId, active: true });
    await groupInto(windowId, c.win.active, [t.id], c.data, c.S);
    await api.remove(ids);
  },
  async moveTabToSpace({ tabId, spaceId }, c) { await unsplitTab(tabId); await moveTabToSpace(tabId, spaceId, c.data, c.S); return 'saveData'; },
  async reorderToday({ windowId, tabId, beforeTabId }, c) { await reorderToday(windowId, tabId, beforeTabId, c.data, c.S); return 'saveData'; },

  async pinTab({ tabId, targetId, position }, c) { await pinTab({ tabId, targetId, position }, c.data, c.S); return 'saveData'; },
  async unpinItem({ itemId }, c) {
    const f = findNode(c.data, itemId);
    if (!f) return;
    f.arr.splice(f.i, 1);
    for (const n of walk([f.node])) delete c.S.links[n.id];
    return 'saveData';
  },
  async openItem({ windowId, itemId }, c) { await openItem(windowId, itemId, c.data, c.S); },
  async resetItem({ itemId }, c) {
    const f = findNode(c.data, itemId);
    const t = await tabOrNull(c.S.links[itemId]);
    if (f && t) await api.update(t.id, { url: f.node.url });
  },
  async updateItem({ itemId, title, url }, c) {
    const f = findNode(c.data, itemId);
    if (!f || f.node.type !== 'item') return;
    if (title != null) f.node.title = title.trim() || f.node.title;
    if (url != null && url.trim()) f.node.url = url.trim();
    return 'saveData';
  },
  async closeItemTab({ itemId }, c) {
    const t = await tabOrNull(c.S.links[itemId]);
    if (t) await api.remove(t.id);
  },
  async addFolder({ name, icon, targetId, position }, c) {
    const space = c.data.spaces.find((s) => s.id === c.win.active);
    if (!space) return;
    const folder = { id: uid(), type: 'folder', name: (name || '').trim() || 'New Folder', icon: icon || 'folder', collapsed: false, children: [] };
    insertNode(space.pinned, folder, targetId, position);
    return 'saveData';
  },
  async updateFolder({ folderId, name, icon, collapsed }, c) {
    const f = findNode(c.data, folderId);
    if (!f || f.node.type !== 'folder') return;
    if (name != null && name.trim()) f.node.name = name.trim();
    if (icon) f.node.icon = icon;
    if (collapsed != null) f.node.collapsed = !!collapsed;
    return 'saveData';
  },
  async deleteFolder({ folderId }, c) {
    const f = findNode(c.data, folderId);
    if (!f || f.node.type !== 'folder') return;
    f.arr.splice(f.i, 1, ...f.node.children); // children move up a level
    return 'saveData';
  },
  async moveNode({ nodeId, targetId, position }, c) {
    if (nodeId === targetId) return;
    const src = findNode(c.data, nodeId);
    if (!src) return;
    if (targetId && [...walk([src.node])].some((n) => n.id === targetId)) return; // folder into itself
    src.arr.splice(src.i, 1);
    const dest = targetId ? findNode(c.data, targetId)?.space : c.data.spaces.find((s) => s.id === c.win.active);
    insertNode((dest ?? src.space).pinned, src.node, targetId, position);
    return 'saveData';
  },

  async openFavorite({ windowId, favId }, c) { await openFavorite(windowId, favId, c.data, c.S); },
  async addFavorite(msg, c) { await addFavorite(msg, c.data, c.S); return 'saveData'; },
  async itemToFavorite({ itemId, beforeFavId }, c) {
    const f = findNode(c.data, itemId);
    if (!f || f.node.type !== 'item') return;
    const tabId = c.S.links[itemId];
    f.arr.splice(f.i, 1);
    delete c.S.links[itemId];
    if (await tabOrNull(tabId)) await addFavorite({ tabId, beforeFavId }, c.data, c.S);
    else await addFavorite({ url: f.node.url, title: f.node.title, beforeFavId }, c.data, c.S);
    return 'saveData';
  },
  async removeFavorite({ windowId, favId }, c) { await removeFavorite(windowId, favId, c.data, c.S); return 'saveData'; },
  async reorderFavorites({ ids }, c) {
    c.data.favorites.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    return 'saveData';
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  serial(async () => {
    if (msg.type === 'getState' || msg.type === 'getIndex') return h(msg);
    if (msg.type === 'openCommandBar') return h(msg);
    const c = await ctx(msg.windowId ?? null);
    if (!c) throw new Error('This window is not supported');
    if (msg.windowId != null && !c.win) throw new Error('Window not found');
    const result = await h(msg, c);
    if (result === 'saveData') await saveData(c.data);
    await saveSess(c.S);
    return result === 'saveData' ? undefined : result;
  }).then(
    (result) => sendResponse({ result }),
    (e) => sendResponse({ error: String(e?.message || e) }),
  );
  return true;
});

// ---------- Chrome events ----------
async function adoptLooseTab(tabId) {
  const t = await tabOrNull(tabId);
  if (!t || t.pinned || t.groupId !== -1) return;
  const c = await ctx(t.windowId);
  if (!c?.win?.active) return;
  const again = await tabOrNull(tabId); // ctx() may already have grouped it
  if (!again || again.groupId !== -1 || again.pinned) return void (await saveSess(c.S));

  // Collapsing the group that holds the active tab makes Chrome open a blank tab.
  // The active Space never collapses: undo the collapse and drop that blank tab.
  if (isBlankTab(again) && (await activeGroupCollapsed(t.windowId, c.win))) {
    await restoreActiveSpace(t.windowId, c.win, c.S);
    await api.remove(tabId).catch(() => {});
    return void (await saveSess(c.S));
  }
  await groupInto(t.windowId, c.win.active, [tabId], c.data, c.S);
  await saveSess(c.S);
}

const isBlankTab = (t) => {
  const u = t.pendingUrl || t.url || '';
  return !u || u === 'chrome://newtab/' || u.startsWith(chrome.runtime.getURL('newtab.html'));
};

async function activeGroupCollapsed(windowId, win) {
  const gid = win.groups[win.active];
  if (gid == null) return false;
  try { return (await chrome.tabGroups.get(gid)).collapsed; } catch { return false; }
}

/** Re-expand the active Space's group and return to its last tab. */
async function restoreActiveSpace(windowId, win, S) {
  const gid = win.groups[win.active];
  if (gid == null) return;
  await api.updateGroup(gid, { collapsed: false }).catch(() => {});
  const tabs = await chrome.tabs.query({ windowId, groupId: gid });
  const back = tabs.find((x) => x.id === S.lastTab[`${windowId}:${win.active}`]) ?? tabs.at(-1);
  if (back) await api.update(back.id, { active: true });
}

// Native tab strip group headers act as Space switches:
//  - expanding another Space's group → switch to that Space;
//  - collapsing the active Space's group → undone (the active Space stays open).
chrome.tabGroups.onUpdated.addListener((group) => serial(async () => {
  const c = await ctx(group.windowId);
  if (!c?.win) return;
  const sid = spaceOfGroup(c.win, group.id);
  if (!sid) return;
  let g;
  try { g = await chrome.tabGroups.get(group.id); } catch { return; }
  if (sid === c.win.active && g.collapsed) {
    const [activeTab] = await chrome.tabs.query({ windowId: group.windowId, active: true });
    // Only when the user did it: our own code never collapses the active Space.
    await api.updateGroup(g.id, { collapsed: false }).catch(() => {});
    if (activeTab && activeTab.groupId !== g.id && !activeTab.pinned && !isBlankTab(activeTab)) {
      await restoreActiveSpace(group.windowId, c.win, c.S);
    }
  } else if (sid !== c.win.active && !g.collapsed) {
    const [activeTab] = await chrome.tabs.query({ windowId: group.windowId, active: true });
    if (activeTab?.groupId === g.id) {
      // Chrome expanded it because one of its tabs was activated: just follow.
      c.win.active = sid;
      c.S.lastActive = sid;
      await collapseOthers(group.windowId, c.win);
    } else {
      await switchSpace(group.windowId, sid, c.data, c.S);
    }
  }
  await saveSess(c.S);
}));

// A new tab waits a moment (ADOPT_DELAY) before joining the active Space: another extension (Claude in
// Chrome, tab managers) may be putting it into its own group, and that group is left alone.
chrome.tabs.onCreated.addListener((tab) => setTimeout(() => serial(() => adoptLooseTab(tab.id)), ADOPT_DELAY));
chrome.tabs.onAttached.addListener((tabId) => serial(() => adoptLooseTab(tabId)));

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!('pinned' in change) && !('groupId' in change)) return;
  serial(async () => {
    const t = await tabOrNull(tabId);
    if (!t) return;
    const c = await ctx(t.windowId);
    if (!c) return;
    const { data, S } = c;
    const key = linkedKey(S, tabId);
    const isFav = key && data.favorites.some((f) => f.id === key);
    if ('pinned' in change) {
      if (t.pinned && !isFav) {
        // Pinned through Chrome's own menu → becomes a Favorite.
        if (key) delete S.links[key];
        const fav = { id: uid(), url: t.url || t.pendingUrl || '', title: t.title || '' };
        data.favorites.push(fav);
        S.links[fav.id] = tabId;
        await saveData(data);
      } else if (!t.pinned && isFav) {
        // Unpinned through Chrome's own menu → no longer a Favorite.
        data.favorites = data.favorites.filter((f) => f.id !== key);
        delete S.links[key];
        await saveData(data);
      }
    }
    if (!t.pinned && t.groupId === -1 && c.win?.active) await groupInto(t.windowId, c.win.active, [tabId], data, S);
    await saveSess(S);
  });
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => serial(async () => {
  const c = await ctx(windowId);
  if (!c?.win) return;
  const t = await tabOrNull(tabId);
  if (!t || t.pinned) return;
  const sid = spaceOfGroup(c.win, t.groupId);
  if (!sid) return;
  c.S.lastTab[`${windowId}:${sid}`] = tabId;
  c.S.lastActive = sid;
  if (sid !== c.win.active) {
    // User picked a tab of another Space (native tab strip, Command Bar…) → follow it.
    c.win.active = sid;
    await collapseOthers(windowId, c.win);
  }
  await saveSess(c.S);
}));

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const share = await getShare();
  if (share?.meetTabId === tabId) await setShare(null);
  else if (share?.sharedTabId === tabId) await setShare({ ...share, sharedTabId: null });
});

chrome.tabs.onRemoved.addListener((tabId) => serial(async () => {
  const S = await getSess();
  unlinkTab(S, tabId);
  for (const [k, v] of Object.entries(S.lastTab)) if (v === tabId) delete S.lastTab[k];
  await saveSess(S);
}));

chrome.tabGroups.onRemoved.addListener((group) => serial(async () => {
  const S = await getSess();
  const win = S.wins[group.windowId];
  if (!win) return;
  for (const [sid, gid] of Object.entries(win.groups)) if (gid === group.id) delete win.groups[sid];
  await saveSess(S);
}));

chrome.windows.onRemoved.addListener((windowId) => serial(async () => {
  const S = await getSess();
  delete S.wins[windowId];
  await saveSess(S);
}));

chrome.commands.onCommand.addListener((command, tab) => runCommand(command, tab));

// Chrome matches letter shortcuts by the character typed, so with a non-Latin keyboard layout (Russian…)
// they don't fire. keys.js (in pages) and the extension's own pages catch the same keys by their physical
// position instead and ask for the command here. A command already run by Chrome for the same key press
// isn't run twice.
let lastRun = { command: '', at: 0 };
// Sidebars that are open, by window (each keeps a port open while it's showing).
const openPanels = new Map();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidebar') return;
  let wid = null;
  port.onMessage.addListener((m) => { if (m?.windowId != null) { wid = m.windowId; openPanels.set(wid, port); } });
  port.onDisconnect.addListener(() => { if (wid != null && openPanels.get(wid) === port) openPanels.delete(wid); });
});

function runCommand(command, tab) {
  if (lastRun.command === command && Date.now() - lastRun.at < 400) return;
  lastRun = { command, at: Date.now() };
  if (command === '_execute_action') {
    if (tab?.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => console.warn('[spaces] sidebar', e));
    return;
  }
  if (command === 'command-bar') {
    openCommandOverlay(tab?.windowId).catch((e) => console.warn(e));
    return;
  }
  serial(async () => {
    const windowId = tab?.windowId ?? (await chrome.windows.getLastFocused()).id;
    const c = await ctx(windowId);
    if (!c?.win) return;
    if (command === 'toggle-focus') {
      if (await getFocus()) await endFocus(false);
      else await startFocus(windowId, { mode: (await chrome.storage.local.get('lastFocusMode')).lastFocusMode ?? 'pomodoro' }, c);
    } else if (command === 'next-space') await cycleSpace(windowId, 1, c.data, c.S);
    else if (command === 'prev-space') await cycleSpace(windowId, -1, c.data, c.S);
    else if (command.startsWith('space-')) {
      const s = c.data.spaces[Number(command.slice(6)) - 1];
      if (s) await switchSpace(windowId, s.id, c.data, c.S);
    } else {
      await tabCommand(command, windowId, c);
    }
    await saveSess(c.S);
  });
}

// ---------- shortcuts that act on the current tab (⌥⇧ + the action's letter) ----------
async function tabCommand(command, windowId, c) {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab) return;
  const url = tab.url || tab.pendingUrl || '';
  const itemId = Object.keys(c.S.links).find((k) => c.S.links[k] === tab.id && findNode(c.data, k));
  const save = async (r) => { if (r === 'saveData') await saveData(c.data); };
  switch (command) {
    case 'pin-tab':
      if (itemId) await save(await handlers.unpinItem({ itemId }, c));
      else if (!tab.pinned) await save(await handlers.pinTab({ tabId: tab.id }, c));
      return;
    case 'add-favorite':
      if (!tab.pinned) await save(await handlers.addFavorite({ tabId: tab.id }, c));
      return;
    case 'copy-link':
    case 'copy-markdown': {
      const md = command === 'copy-markdown';
      const title = (tab.title || url).replace(/\s+/g, ' ').trim().replace(/([\[\]\\])/g, '\\$1');
      const text = md ? `[${title}](${url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20')})` : url;
      await copyInTab(tab.id, text, md ? 'Markdown link copied' : 'Link copied');
      return;
    }
    case 'screenshot': await openScreenshot(tab.id).catch((e) => notify('shot', 'No screenshot here', e.message)); return;
    case 'incognito':
      if (!(await chrome.extension.isAllowedIncognitoAccess())) {
        notify('incognito', 'Allow Atrium in Incognito first', 'chrome://extensions → Atrium → Details → Allow in Incognito. Opening it anyway.');
      }
      await openIncognito(url, windowId).catch((e) => notify('incognito', 'Can’t open in Incognito', e.message));
      return;
    case 'duplicate-tab': await handlers.duplicateTab({ tabId: tab.id }, c); return;
    case 'reset-pinned': if (itemId) await handlers.resetItem({ itemId }, c); return;
    case 'player-toggle': {
      const list = await playerList(await chrome.tabs.query({}), await getFocus());
      const p = list.find((x) => x.playing) || list[0];
      if (!p) return;
      if (p.controllable) await handlers.mediaControl({ tabId: p.tabId, action: 'toggle' });
      else await handlers.toggleMute({ tabId: p.tabId });
      return;
    }
  }
}

/** Copy text from inside the page (the worker has no clipboard) and show a small note there. */
async function copyInTab(tabId, text, note) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [text, note],
      func: async (t, n) => {
        try { await navigator.clipboard.writeText(t); } catch {
          const ta = document.createElement('textarea');
          ta.value = t; ta.style.cssText = 'position:fixed;opacity:0;';
          document.documentElement.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
        }
        const el = document.createElement('div');
        el.textContent = n;
        el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;padding:8px 14px;border-radius:999px;background:rgba(28,28,30,.9);color:#fff;font:600 13px -apple-system,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);pointer-events:none;transition:opacity .3s;';
        document.documentElement.append(el);
        setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, 1300);
      },
    });
  } catch {
    notify('copy', 'Can’t copy on this page', 'Chrome doesn’t let extensions into its own pages.');
  }
}

// The toolbar icon (and its shortcut) only opens the sidebar. Clear any popup an older version left set.
chrome.action.setPopup({ popup: '' }).catch(() => {});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.warn(e));

/** The Command Bar over the current page, as a card (cmd-overlay.js): nothing opens until you pick a result.
    Where Chrome doesn't let the extension into the page (chrome:// pages, the Web Store), the popup window
    is used instead; on the extension's own New Tab page the bar is already there. */
async function openCommandOverlay(windowId) {
  const [tab] = await chrome.tabs.query({ active: true, ...(windowId != null ? { windowId } : { lastFocusedWindow: true }) });
  if (!tab) return openCommandBar(windowId);
  const url = tab.url || tab.pendingUrl || '';
  if (url.startsWith(chrome.runtime.getURL('newtab.html'))) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return;
  }
  if (/^(https?|file):/.test(url)) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['cmd-overlay.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'cmdOverlayOpen', windowId: tab.windowId });
      return;
    } catch (e) {
      console.warn('[spaces] command overlay', e);
    }
  }
  return openCommandBar(tab.windowId);
}

/** Command Bar = a small popup window centred over the browser window (closes itself on blur). */
let commandWindowId = null;
async function openCommandBar(windowId) {
  if (commandWindowId != null) await chrome.windows.remove(commandWindowId).catch(() => {});
  const base = windowId != null
    ? await chrome.windows.get(windowId)
    : await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  const width = 640, height = 460;
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`command.html?win=${base.id}`),
    type: 'popup', focused: true, width, height,
    left: Math.round(base.left + (base.width - width) / 2),
    top: Math.round(base.top + Math.max(60, Math.min(140, (base.height - height) / 2))),
  });
  commandWindowId = win.id;
}
chrome.windows.onRemoved.addListener((id) => { if (id === commandWindowId) commandWindowId = null; });

// ---------- Google Meet: which tab is being presented ----------
// session.share = { meetTabId, surface: 'browser'|'window'|'monitor'|'unknown', sharedTabId | null }
async function getShare() { return (await chrome.storage.session.get('share')).share ?? null; }
const setShare = (share) => chrome.storage.session.set({ share });

async function onMeetEvent(tab, ev) {
  const tabFromHandle = (h) => { const m = /^spaces:(\d+)$/.exec(h || ''); return m ? Number(m[1]) : null; };
  if (ev.type === 'share-started') {
    await setShare({ meetTabId: tab.id, surface: ev.surface || 'unknown', sharedTabId: tabFromHandle(ev.handle) });
  } else if (ev.type === 'share-handle') {
    const share = await getShare();
    if (share?.meetTabId === tab.id) await setShare({ ...share, sharedTabId: tabFromHandle(ev.handle) ?? share.sharedTabId });
  } else if (ev.type === 'share-ended') {
    const share = await getShare();
    if (share?.meetTabId === tab.id) await setShare(null);
  }
}

// ---------- sleeping tabs of inactive Spaces ----------
// Tabs of Spaces that aren't open in their window are unloaded from memory (chrome.tabs.discard) once
// they haven't been used for a while. They stay in the list and reload when opened. Never put to sleep:
// active tabs, tabs playing sound or media, the Google Meet tab and the tab it presents, and tabs that
// asked Chrome not to discard them.
const SLEEP_OPTIONS = [0, 15, 30, 60, 180]; // minutes; 0 = never
async function getSleepAfter() {
  const { sleepAfterMin } = await chrome.storage.local.get('sleepAfterMin');
  return SLEEP_OPTIONS.includes(sleepAfterMin) ? sleepAfterMin : 30;
}

async function sleepInactiveSpaces({ force = false, spaceId = null, S = null } = {}) {
  const after = await getSleepAfter();
  if (!after && !force) return 0;
  S ??= await getSess();
  const [share, media] = await Promise.all([getShare(), getMedia()]);
  const cutoff = Date.now() - after * 60e3;
  let n = 0;
  for (const [wid, win] of Object.entries(S.wins)) {
    for (const [sid, gid] of Object.entries(win.groups)) {
      if (sid === win.active || (spaceId && sid !== spaceId)) continue;
      for (const t of await chrome.tabs.query({ windowId: Number(wid), groupId: gid })) {
        if (t.discarded || t.active || t.audible || t.autoDiscardable === false || t.status === 'loading') continue;
        if (share && (t.id === share.sharedTabId || t.id === share.meetTabId)) continue;
        if (media[t.id]?.playing) continue;
        if (!force && (t.lastAccessed ?? Date.now()) > cutoff) continue;
        try { await chrome.tabs.discard(t.id); n++; } catch { /* Chrome refused: leave it awake */ }
      }
    }
  }
  return n;
}

const SLEEP_ALARM = 'sleep-spaces';
const ensureSleepAlarm = () => chrome.alarms.get(SLEEP_ALARM).then((a) => a || chrome.alarms.create(SLEEP_ALARM, { periodInMinutes: 5 }));
chrome.runtime.onInstalled.addListener(ensureSleepAlarm);
chrome.runtime.onStartup.addListener(ensureSleepAlarm);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === SLEEP_ALARM) serial(() => sleepInactiveSpaces()); });

// Older Chrome versions give a discarded tab a new id: move links and memory over to it.
chrome.tabs.onReplaced.addListener((added, removed) => serial(async () => {
  const S = await getSess();
  let changed = false;
  for (const k of Object.keys(S.links)) if (S.links[k] === removed) { S.links[k] = added; changed = true; }
  for (const k of Object.keys(S.lastTab)) if (S.lastTab[k] === removed) { S.lastTab[k] = added; changed = true; }
  if (changed) await saveSess(S);
}));

// ---------- Peek: preview a link in a card over the current page ----------
// The card embeds the link in an iframe. Many sites forbid that (X-Frame-Options / CSP frame-ancestors),
// so while a card is open in a tab, a session rule removes those headers from that tab's frames only.
// The rule is dropped when the card closes or the tab goes away.
const peekRuleId = (tabId) => tabId; // tab ids are unique positive integers
async function allowEmbedding(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [peekRuleId(tabId)],
    addRules: [{
      id: peekRuleId(tabId),
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
        ],
      },
      condition: { tabIds: [tabId], resourceTypes: ['sub_frame'] },
    }],
  });
}
const disallowEmbedding = (tabId) => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [peekRuleId(tabId)] }).catch(() => {});
chrome.tabs.onRemoved.addListener((tabId) => disallowEmbedding(tabId));

// ---------- mini player: what's playing in which tab ----------
// session.media = { [tabId]: { playing, title, artist, artwork, frameId, at, dismissed } } from media.js
async function getMedia() { return (await chrome.storage.session.get('media')).media ?? {}; }

let mediaChain = Promise.resolve();
function updateMedia(fn) {
  mediaChain = mediaChain.then(async () => {
    const media = await getMedia();
    if (fn(media) !== false) await chrome.storage.session.set({ media });
  }).catch((e) => console.warn(e));
  return mediaChain;
}

function onMediaState(sender, st) {
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  updateMedia((media) => {
    const prev = media[tabId];
    // A frame with nothing left to play only clears the entry it created itself.
    if (!st.hasMedia && !st.playing) {
      if (!prev || prev.frameId !== sender.frameId) return false;
      delete media[tabId];
      return;
    }
    // Another frame of the tab already playing (or in a call) wins over a paused one.
    if (prev && prev.frameId !== sender.frameId && (prev.playing || prev.capturing) && !st.playing && !st.capturing) return false;
    media[tabId] = {
      playing: !!st.playing, title: st.title || '', artist: st.artist || '', artwork: st.artwork || '',
      actions: Array.isArray(st.actions) ? st.actions : [],
      mic: typeof st.mic === 'boolean' ? st.mic : null, cam: typeof st.cam === 'boolean' ? st.cam : null,
      capturing: !!st.capturing,
      // Has it really played (or been in a call) since the page loaded? Pages that only have a paused
      // player (after a browser restart, say) stay out of the sidebar player until they do.
      played: !!(st.playing || st.capturing || prev?.played),
      frameId: sender.frameId ?? 0, at: Date.now(),
      dismissed: st.playing && !prev?.playing ? false : !!prev?.dismissed,
    };
  });
}

chrome.tabs.onRemoved.addListener((tabId) => updateMedia((m) => (m[tabId] ? void delete m[tabId] : false)));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) updateMedia((m) => (m[tabId] ? void delete m[tabId] : false)); // navigated away
});

/** Tabs for the mini player: playing ones first, then recently paused ones (up to 2 hours), max 3. */
async function playerList(allTabs, focus = null) {
  const media = await getMedia();
  const visited = new Set((await chrome.storage.session.get('visited')).visited ?? []);
  const playerIcons = await getRealIcons();
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const out = [];
  for (const t of allTabs) {
    const m = media[t.id];
    const playing = m ? m.playing : !!t.audible;
    if (!m && !t.audible) continue;
    if (m?.dismissed) continue;
    if (m && !playing && Date.now() - m.at > 2 * 3600e3) continue;
    if (m && !m.played && !playing && !t.audible) continue; // never played yet
    if (!t.audible && !t.active && !visited.has(t.id)) continue; // restored after a restart, not opened yet
    // A call isn't something to pause or skip: for calls the player offers mic, camera and sound.
    const call = host(t.url || '') === 'meet.google.com' || !!m?.capturing || m?.mic != null || m?.cam != null;
    if (call && !m?.capturing && !t.audible) continue; // the call is over (still on the call site's page)
    out.push({
      tabId: t.id, playing, muted: !!t.mutedInfo?.muted, controllable: !call && !!m && !m.audibleOnly, actions: call ? [] : m?.actions ?? [],
      mic: m?.mic ?? null, cam: m?.cam ?? null,
      // "Meet – Weekly sync" → "Weekly sync"
      title: (call ? (m?.title || t.title || '').replace(/^Meet\s*[–—-]\s*/i, '') : m?.title || t.title || ''), sub: m?.artist || host(t.url || ''),
      call,
      artwork: m?.artwork || '', favIconUrl: realFavicon(t, playerIcons), url: t.url || '',
      at: m?.at ?? Date.now(),
    });
  }
  return out.sort((a, b) => (b.playing - a.playing) || (b.at - a.at)).slice(0, 3);
}

// Messages from content scripts (answered directly, outside the main queue).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'peekContext' && sender.tab) {
    // Is this tab a Favorite or an open Pinned item? Then links to other sites open in Peek automatically.
    getSess().then((S) => sendResponse({ auto: !!sender.tab.pinned || Object.values(S.links).includes(sender.tab.id) }),
      () => sendResponse({ auto: false }));
    return true;
  }
  if (msg?.type === 'peekPrepare' && sender.tab) {
    allowEmbedding(sender.tab.id).then(() => sendResponse({ ok: true }), (e) => { console.warn(e); sendResponse({ ok: false }); });
    return true;
  }
  if (msg?.type === 'peekDone' && sender.tab) {
    const tabId = sender.tab.id;
    // Media that played inside the card belonged to one of its frames: it's gone with the card.
    updateMedia((m) => (m[tabId] && m[tabId].frameId !== 0 ? void delete m[tabId] : false));
    disallowEmbedding(tabId).then(() => sendResponse({}));
    return true;
  }
  if (msg?.type === 'peekKeep' && sender.tab && /^https?:/.test(msg.url || '')) {
    // From the card: open the link as a normal tab in the chosen Space of this window and go there.
    const windowId = sender.tab.windowId;
    serial(async () => {
      const c = await ctx(windowId);
      if (!c?.win) return;
      const spaceId = c.data.spaces.some((s) => s.id === msg.spaceId) ? msg.spaceId : c.win.active;
      // Peek opened from the New Tab page, kept in the current Space: that New Tab becomes the page.
      if (spaceId === c.win.active && (sender.tab.url || '').startsWith(chrome.runtime.getURL('newtab.html'))) {
        await api.update(sender.tab.id, { url: msg.url });
        return;
      }
      const t = await chrome.tabs.create({ windowId, url: msg.url, active: spaceId === c.win.active });
      await groupInto(windowId, spaceId, [t.id], c.data, c.S);
      if (spaceId !== c.win.active) {
        c.S.lastTab[`${windowId}:${spaceId}`] = t.id;
        await switchSpace(windowId, spaceId, c.data, c.S);
      }
      await saveSess(c.S);
    }).then(() => sendResponse({}), () => sendResponse({}));
    return true;
  }
  if (msg?.type === 'mediaState') {
    onMediaState(sender, msg);
    sendResponse({});
    return false;
  }
  if (msg?.type === 'realIcon' && typeof msg.host === 'string' && /^(https?|file|data):/.test(msg.url || '')) {
    rememberRealIcon(msg.host, msg.url);
    sendResponse({});
    return false;
  }
  if (msg?.type === 'myTabId') {
    sendResponse({ result: sender.tab?.id ?? null });
    return false;
  }
  // Screen sharing from any call site (media-main.js), and Meet's own hook (meet-hook.js).
  if (msg?.type === 'shareEvent' && sender.tab) {
    onMeetEvent(sender.tab, msg.event ?? {}).then(() => sendResponse({}), () => sendResponse({}));
    return true;
  }
  if (msg?.type === 'meetShareEvent' && sender.tab && sender.url?.startsWith('https://meet.google.com/')) {
    onMeetEvent(sender.tab, msg.event ?? {}).then(() => sendResponse({}), () => sendResponse({}));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  serial(reconcileAll);
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
});
chrome.runtime.onStartup.addListener(() => serial(reconcileAll));

// ---------- Focus mode (Pomodoro) ----------
// session.focus = {
//   goal, windowId, spaceId, mode: 'pomodoro' | 'timer' | 'open', startedAt,
//   phase: 'work' | 'break', round, phaseStartedAt, phaseEndsAt | null, workedMs,
//   passes: { site: until } }
// Pomodoro: 25 min of focus, then a 5 min break, round after round until ended.
// 'timer' is one focus block of a set length, 'open' has no limit.
// While focusing (not on a break) distracting sites are covered by focus-guard.js (see applyFocusRules).
// That's all it does: tabs, sound and Spaces are left alone. Lives in session storage, so a browser
// restart ends it.
const FOCUS_RULE = 1999999000;          // the blocking rule
const FOCUS_PASS = FOCUS_RULE + 1;      // + n: "open for 1 minute" passes
const FOCUS_ALARM = 'focus-tick';
const FOCUS_PASS_MIN = 1;
const POMODORO = { work: 25, rest: 5 };
// What people tend to get stuck in: social networks, video, news, link aggregators, shopping, sports.
const DEFAULT_FOCUS_SITES = [
  // social
  'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'threads.net', 'bsky.app', 'mastodon.social', 'tiktok.com',
  'snapchat.com', 'pinterest.com', 'tumblr.com', 'linkedin.com', 'reddit.com', 'quora.com', '9gag.com', 'imgur.com',
  'vk.com', 'ok.ru', 'pikabu.ru', 'weibo.com', 'douyin.com', 'joyreactor.cc', 'ifunny.co', 'tinder.com',
  // video and streaming
  'youtube.com', 'twitch.tv', 'kick.com', 'netflix.com', 'primevideo.com', 'disneyplus.com', 'hulu.com', 'max.com',
  'hbomax.com', 'peacocktv.com', 'paramountplus.com', 'tv.apple.com', 'crunchyroll.com', 'vimeo.com', 'dailymotion.com',
  'bilibili.com', 'rutube.ru', 'vkvideo.ru', 'kinopoisk.ru', 'ivi.ru', 'okko.tv', 'imdb.com',
  // news and reading
  'news.ycombinator.com', 'news.google.com', 'news.yahoo.com', 'msn.com', 'cnn.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com',
  'theguardian.com', 'washingtonpost.com', 'foxnews.com', 'nbcnews.com', 'reuters.com', 'bloomberg.com', 'forbes.com',
  'businessinsider.com', 'huffpost.com', 'dailymail.co.uk', 'buzzfeed.com', 'theverge.com', 'techcrunch.com', 'wired.com',
  'engadget.com', 'arstechnica.com', 'gizmodo.com', 'mashable.com', 'vox.com', 'axios.com', 'politico.com', 'medium.com',
  'producthunt.com', 'dzen.ru', 'ria.ru', 'lenta.ru', 'rbc.ru', 'meduza.io', 'kommersant.ru', 'tass.ru', 'gazeta.ru',
  'iz.ru', 'fontanka.ru', 'vc.ru', 'dtf.ru', 'habr.com',
  // shopping
  'amazon.com', 'ebay.com', 'aliexpress.com', 'aliexpress.ru', 'temu.com', 'shein.com', 'etsy.com', 'ozon.ru',
  'wildberries.ru', 'avito.ru',
  // sports and games
  'espn.com', 'sports.ru', 'championat.com', 'chess.com', 'lichess.org', 'store.steampowered.com',
];
// Music keeps playing (and isn't blocked) during focus.
const MUSIC_SITES = ['music.youtube.com', 'tidal.com', 'spotify.com', 'music.apple.com', 'soundcloud.com',
  'deezer.com', 'music.yandex.ru', 'music.yandex.com', 'bandcamp.com', 'music.amazon.com', 'pandora.com'];

// Kept in local storage so it survives a browser restart (see the onStartup check below).
async function getFocus() { return (await chrome.storage.local.get('focus')).focus ?? null; }
const setFocus = (focus) => chrome.storage.local.set({ focus });
async function getFocusSites() {
  const { focusSites } = await chrome.storage.local.get('focusSites');
  return Array.isArray(focusSites) ? focusSites : DEFAULT_FOCUS_SITES;
}
const bareHost = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const onSite = (host, site) => host === site || host.endsWith(`.${site}`);
// Sites are paused during a focus round, not on a break, and not once the round's time is up (waiting).
const focusing = (focus) => !!focus && focus.phase === 'work' && !focus.waiting;

/** What focus-guard.js needs to cover paused sites: local.focusBlock while focusing, else nothing.
    Favorites, Pinned and music sites are never paused. (Older versions redirected pages with network
    rules; any left over are removed here.) */
async function applyFocusRules(focus, data = null) {
  const old = (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id).filter((id) => id >= FOCUS_RULE && id < FOCUS_RULE + 500);
  if (old.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: old }).catch(() => {});
  if (!focusing(focus)) { await chrome.storage.local.set({ focusBlock: null }); return; }
  data ??= await getData();
  const exempt = new Set(MUSIC_SITES);
  for (const f of data.favorites) exempt.add(bareHost(f.url));
  for (const s of data.spaces) for (const n of items(s.pinned)) exempt.add(bareHost(n.url));
  exempt.delete('');
  const now = Date.now();
  const passes = Object.fromEntries(Object.entries(focus.passes ?? {}).filter(([, until]) => until > now));
  const sites = (await getFocusSites()).filter(Boolean);
  await chrome.storage.local.set({ focusBlock: { sites, exempt: [...exempt], passes, endsAt: focus.phaseEndsAt ?? null } });
  // Pages loaded before the extension was installed or updated have no focus-guard yet: add it now.
  for (const t of await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })) {
    const h = bareHost(t.url || '');
    if (!t.discarded && sites.some((s) => onSite(h, s)) && ![...exempt].some((s) => onSite(h, s))) {
      chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['focus-guard.js'] }).catch(() => {});
    }
  }
}

// After a browser restart focus goes on where it was, as long as its time isn't up: a round (or a timer)
// whose end has passed is dropped, and so is an open-ended focus started over 25 minutes ago.
chrome.runtime.onStartup.addListener(() => serial(async () => {
  const focus = await getFocus();
  if (!focus) { await applyFocusRules(null); return; }
  const now = Date.now();
  const over = focus.phaseEndsAt ? now >= focus.phaseEndsAt : now - focus.phaseStartedAt > 25 * 60e3;
  if (over || focus.waiting) { await setFocus(null); await applyFocusRules(null); await chrome.alarms.clear(FOCUS_ALARM); return; }
  focus.before = []; // tab ids change after a restart
  await setFocus(focus);
  await applyFocusRules(focus);
  await scheduleFocusAlarm(focus);
}));

/** Next wake-up: the end of the current phase or the first pass running out. */
async function scheduleFocusAlarm(focus) {
  await chrome.alarms.clear(FOCUS_ALARM);
  if (!focus) return;
  const times = [focus.phaseEndsAt, ...Object.values(focus.passes ?? {})].filter((t) => t && t > Date.now());
  if (times.length) await chrome.alarms.create(FOCUS_ALARM, { when: Math.min(...times) + 300 });
}

function notify(id, title, message) {
  try {
    // The end of a focus round or a break stays on screen until you act on it.
    chrome.notifications?.create(`spaces-focus-${id}`, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), title, message: message || ' ', priority: 1, requireInteraction: id === 'phase' }, () => void chrome.runtime.lastError);
  } catch { /* notifications unavailable */ }
}
const fmtMinutes = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);

/** mode: 'pomodoro' | 'open' | minutes (number or numeric string). */
async function startFocus(windowId, { goal = '', mode = 'pomodoro' } = {}, c) {
  if (await getFocus()) await endFocus(false);
  const now = Date.now();
  const kind = mode === 'pomodoro' ? 'pomodoro' : mode === 'open' ? 'open' : 'timer';
  const minutes = kind === 'pomodoro' ? POMODORO.work : kind === 'timer' ? Math.max(1, Number(mode) || 50) : 0;
  const focus = {
    goal: String(goal || '').trim().slice(0, 120), windowId, spaceId: c.win.active, mode: kind, startedAt: now,
    phase: 'work', round: 1, phaseStartedAt: now, phaseEndsAt: minutes ? now + minutes * 60e3 : null,
    workedMs: 0, passes: {},
    // Tabs open when focus started: only these fold away in the sidebar; tabs opened while focusing stay.
    before: (await chrome.tabs.query({})).map((t) => t.id),
  };
  await chrome.storage.local.set({ lastFocusMode: kind === 'timer' ? String(minutes) : kind });
  await setFocus(focus);
  await applyFocusRules(focus, c.data);
  await scheduleFocusAlarm(focus);
}

async function endFocus(finished = true) {
  const focus = await getFocus();
  await applyFocusRules(null);
  await chrome.alarms.clear(FOCUS_ALARM);
  if (!focus) return;
  await setFocus(null);
  const worked = focus.workedMs + (focus.phase === 'work' ? Date.now() - focus.phaseStartedAt : 0);
  const minutes = Math.max(1, Math.round(worked / 60e3));
  const rounds = focus.mode === 'pomodoro' ? focus.round - (focus.phase === 'work' && Date.now() < focus.phaseEndsAt ? 1 : 0) : 0;
  await chrome.storage.session.set({ focusDone: { at: Date.now(), finished, goal: focus.goal, minutes, rounds } });
  if (finished) notify('done', `Focus done · ${fmtMinutes(minutes)}`, focus.goal);
}

/** Pomodoro: from focus to a break, or from a break to the next round. */
async function nextPhase(focus, now = Date.now()) {
  if (focus.phase === 'work') {
    focus.workedMs += now - focus.phaseStartedAt;
    Object.assign(focus, { phase: 'break', phaseStartedAt: now, phaseEndsAt: now + POMODORO.rest * 60e3 });
    notify('phase', `Break · ${POMODORO.rest} min`, `Round ${focus.round} done. Stand up, look away from the screen.`);
  } else {
    focus.round += 1;
    Object.assign(focus, { phase: 'work', phaseStartedAt: now, phaseEndsAt: now + POMODORO.work * 60e3, passes: {} });
    notify('phase', `Focus · round ${focus.round}`, focus.goal || 'Distracting sites are paused again.');
  }
}

async function focusTick({ skip = false } = {}) {
  const focus = await getFocus();
  if (!focus) return;
  const now = Date.now();
  if (skip) {
    if (focus.mode !== 'pomodoro') return endFocus(true);
    await nextPhase(focus, now);
    focus.waiting = false;
  } else if (focus.phaseEndsAt && now >= focus.phaseEndsAt - 1000 && !focus.waiting) {
    if (focus.mode !== 'pomodoro') return endFocus(true);
    // Pomodoro: the phase is over, but the next one starts only when you say so (the tomato or the
    // notification). Until then sites stay as they are.
    focus.waiting = true;
    notify('phase', focus.phase === 'work' ? `Round ${focus.round} done` : 'Break is over',
      focus.phase === 'work' ? 'Click to start a 5 min break.' : 'Click to start the next round of focus.');
  }
  for (const [site, until] of Object.entries(focus.passes)) if (until <= now) delete focus.passes[site];
  await setFocus(focus);
  await applyFocusRules(focus);
  await scheduleFocusAlarm(focus);
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === FOCUS_ALARM) serial(() => focusTick()); });
// The "round done / break is over" notification: a click starts the next phase.
chrome.notifications?.onClicked.addListener((id) => {
  if (id !== 'spaces-focus-phase') return;
  chrome.notifications.clear(id);
  serial(async () => { if ((await getFocus())?.waiting) await focusTick({ skip: true }); });
});
// Tabs opened or looked at since the browser started (session storage is empty after a restart): the
// player leaves out restored tabs until you open them.
chrome.tabs.onActivated.addListener(({ tabId }) => chrome.storage.session.get('visited').then(({ visited = [] }) => {
  if (!visited.includes(tabId)) chrome.storage.session.set({ visited: [...visited.slice(-500), tabId] });
}).catch(() => {}));
// A tab hidden by focus that you open stays in view from then on.
chrome.tabs.onActivated.addListener(({ tabId }) => serial(async () => {
  const focus = await getFocus();
  if (!focus?.before?.includes(tabId)) return;
  focus.before = focus.before.filter((id) => id !== tabId);
  await setFocus(focus);
}));

// The blocked page asks what's going on and for a short pass.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'focusInfo') {
    Promise.all([getFocus(), getFocusSites()]).then(([focus, sites]) => {
      const h = bareHost(msg.url || '');
      sendResponse({ focus, site: sites.find((s) => onSite(h, s)) || h });
    }, () => sendResponse({ focus: null }));
    return true;
  }
  if (msg?.type === 'focusPass') {
    serial(async () => {
      const focus = await getFocus();
      if (!focusing(focus)) return;
      const sites = await getFocusSites();
      const h = bareHost(msg.url || '');
      const site = sites.find((s) => onSite(h, s)) || h;
      focus.passes[site] = Date.now() + FOCUS_PASS_MIN * 60e3;
      await setFocus(focus);
      await applyFocusRules(focus);
      await scheduleFocusAlarm(focus);
    }).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

// ---------- every morning: Pinned and Favorites go back to their own pages ----------
// Once a day, from 5:00 local time (at the first check after it: browser start or the 5-minute alarm),
// open Pinned items and Favorites whose tab has wandered off to another page are sent back to the page
// that was pinned. Left alone: the tab you're looking at, tabs playing sound and the tab Google Meet
// presents. Closed items stay closed. Can be switched off in the sidebar's "⋯" menu.
const MORNING_HOUR = 5;
const dayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
async function getMorningReset() {
  const { morningReset } = await chrome.storage.local.get('morningReset');
  return morningReset !== false;
}

async function morningReset({ force = false } = {}) {
  const now = new Date();
  if (!force) {
    if (now.getHours() < MORNING_HOUR || !(await getMorningReset())) return 0;
    const { morningResetDay } = await chrome.storage.local.get('morningResetDay');
    if (morningResetDay === dayKey(now)) return 0;
  }
  await chrome.storage.local.set({ morningResetDay: dayKey(now) });
  const [data, S, share] = await Promise.all([getData(), getSess(), getShare()]);
  const home = [
    ...data.favorites.map((f) => [f.id, f.url]),
    ...data.spaces.flatMap((s) => items(s.pinned).map((n) => [n.id, n.url])),
  ];
  let n = 0;
  for (const [id, url] of home) {
    const t = await tabOrNull(S.links[id]);
    if (!t || !url || samePage(t.url || t.pendingUrl, url)) continue;
    if (t.active || t.audible || t.id === share?.sharedTabId || t.id === share?.meetTabId) continue;
    try { await api.update(t.id, { url }); n++; } catch (e) { console.warn('[spaces] morning reset', e); }
  }
  return n;
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === SLEEP_ALARM) serial(() => morningReset()); });
chrome.runtime.onStartup.addListener(() => serial(() => morningReset()));

// ---------- screenshots ----------
// The camera on a tab row opens shot.js over that page (injected on demand): pick the visible screen, an
// area or the whole page, then copy or save. The page script asks for captures here, because only the
// extension can take them (chrome.tabs.captureVisibleTab). Chrome allows about 2 captures a second, so
// they are spaced out; a full page is several captures, scrolled and stitched together by shot.js.
const CAPTURE_GAP_MS = 550;
let lastCapture = 0;
let captureChain = Promise.resolve();
function captureTab(windowId) {
  const run = async () => {
    const wait = lastCapture + CAPTURE_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } finally {
      lastCapture = Date.now();
    }
  };
  const p = captureChain.then(run, run);
  captureChain = p.catch(() => {});
  return p;
}

const NO_SHOT = 'Chrome doesn’t allow screenshots of this page';
async function openScreenshot(tabId, mode = null) {
  const t = await tabOrNull(tabId);
  if (!t) return;
  if (!/^(https?|file):/.test(t.url || '')) throw new Error(NO_SHOT);
  await api.update(tabId, { active: true });
  await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['shot.js'] });
    await chrome.tabs.sendMessage(tabId, { type: 'shotOpen', mode });
  } catch (e) {
    console.warn('[spaces] screenshot', e);
    throw new Error(NO_SHOT);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // A page asks for a screenshot of itself (the Google results panel in Incognito).
  if (msg?.type === 'shotSelf' && sender.tab) {
    openScreenshot(sender.tab.id, msg.mode === 'full' ? 'full' : null).then(() => sendResponse({}), () => sendResponse({}));
    return true;
  }
  if (msg?.type !== 'shotCapture' || !sender.tab) return false;
  captureTab(sender.tab.windowId).then(
    (dataUrl) => sendResponse({ dataUrl }),
    (e) => sendResponse({ error: String(e?.message || e) }),
  );
  return true;
});

// ---------- Incognito ----------
/** Open an address in an Incognito window: an open one if the extension can see it, else a new one (full
    screen if the window it came from is). The page loads fresh there: signed out, nothing from your profile. */
async function openIncognito(url, fromWindowId) {
  if (!/^(https?|file):/.test(url || '')) throw new Error('This page can’t be opened in Incognito');
  const inc = (await chrome.windows.getAll({ windowTypes: ['normal'] })).find((w) => w.incognito);
  if (inc) {
    await chrome.tabs.create({ windowId: inc.id, url, active: true });
    await chrome.windows.update(inc.id, { focused: true });
    return;
  }
  const from = fromWindowId != null ? await chrome.windows.get(fromWindowId).catch(() => null) : null;
  await chrome.windows.create({ incognito: true, url, focused: true, state: from?.state === 'fullscreen' ? 'fullscreen' : 'normal' });
}

// ---------- proxy for Incognito windows only ----------
// Incognito windows can go out through a proxy in another country (so Google, and its ads, see you there),
// while normal windows stay direct. Chrome applies "incognito_persistent" proxy settings to Incognito only;
// it needs the extension allowed in Incognito.
//   local.proxyConf = { mode: 'off' | 'free' | 'own', country: 'us', own: { scheme, host, port, user, pass } }
//   session.proxyState = { mode, country, server: 'host:port', tried: n, error }
// Free mode takes public proxies (GeoNode and ProxyScrape lists, anonymous ones only, those that work with
// Google first) and moves on to the next one when Chrome reports a proxy error. Free proxies are slow and
// come and go; they can see which sites you open (not the content of HTTPS pages), so they're for checks
// like search results, not for logging in anywhere.
const PROXY_SCOPE = { scope: 'incognito_persistent' };
// Switched off in 1.0 (back in a later version): the manifest no longer asks for the proxy and webRequest
// permissions, so none of this runs. Turn FEATURE_PROXY on together with those permissions and serp.js.
const FEATURE_PROXY = false;
if (FEATURE_PROXY && chrome.proxy && chrome.webRequest) {
async function getProxyConf() {
  const { proxyConf } = await chrome.storage.local.get('proxyConf');
  return { mode: 'off', country: 'us', own: null, ...(proxyConf || {}) };
}
const setProxyState = (proxyState) => chrome.storage.session.set({ proxyState });
async function getProxyState() { return (await chrome.storage.session.get('proxyState')).proxyState ?? null; }

let freePool = { country: '', list: [], at: 0, i: 0 };
async function freeProxies(country) {
  const cc = country.toUpperCase();
  if (freePool.country === cc && freePool.list.length && Date.now() - freePool.at < 20 * 60e3) return freePool;
  const list = [];
  const seen = new Set();
  const add = (host, port, good) => {
    const k = `${host}:${port}`;
    if (!host || !port || seen.has(k)) return;
    seen.add(k);
    list.push({ host, port: Number(port), good });
  };
  try {
    const r = await fetch(`https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&country=${cc}&protocols=http%2Chttps`);
    const j = await r.json();
    for (const p of j.data ?? []) {
      if (p.anonymityLevel === 'transparent') continue; // would pass your real IP along
      add(p.ip, p.port, p.google ? 2 : 1);
    }
  } catch (e) { console.warn('[spaces] geonode', e); }
  try {
    const r = await fetch(`https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=${cc}&ssl=yes&anonymity=elite`);
    for (const line of (await r.text()).split(/\s+/)) {
      const [host, port] = line.split(':');
      add(host, port, 1);
    }
  } catch (e) { console.warn('[spaces] proxyscrape', e); }
  list.sort((a, b) => b.good - a.good);
  freePool = { country: cc, list, at: Date.now(), i: 0 };
  return freePool;
}

async function applyProxy({ next = false } = {}) {
  const conf = await getProxyConf();
  if (conf.mode === 'off') {
    await chrome.proxy.settings.clear(PROXY_SCOPE).catch(() => {});
    await setProxyState({ mode: 'off' });
    return;
  }
  if (conf.mode === 'own') {
    const o = conf.own;
    if (!o?.host || !o?.port) { await setProxyState({ mode: 'own', error: 'Set up your proxy first' }); return; }
    await chrome.proxy.settings.set({
      ...PROXY_SCOPE,
      value: { mode: 'fixed_servers', rules: { singleProxy: { scheme: o.scheme || 'http', host: o.host, port: Number(o.port) }, bypassList: ['localhost', '127.0.0.1'] } },
    });
    await setProxyState({ mode: 'own', server: `${o.host}:${o.port}` });
    return;
  }
  const pool = await freeProxies(conf.country || 'us');
  if (!pool.list.length) {
    await chrome.proxy.settings.clear(PROXY_SCOPE).catch(() => {});
    await setProxyState({ mode: 'free', country: conf.country, error: `No free proxies for ${pool.country} right now` });
    return;
  }
  if (next) pool.i = (pool.i + 1) % pool.list.length;
  const p = pool.list[pool.i];
  await chrome.proxy.settings.set({
    ...PROXY_SCOPE,
    value: { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'http', host: p.host, port: p.port }, bypassList: ['localhost', '127.0.0.1'] } },
  });
  await setProxyState({ mode: 'free', country: conf.country, server: `${p.host}:${p.port}`, tried: pool.i + 1, of: pool.list.length });
}

async function setProxyConf(patch) {
  const conf = { ...(await getProxyConf()), ...patch };
  await chrome.storage.local.set({ proxyConf: conf });
  await applyProxy();
  return getProxyState();
}

// When a page in Incognito can't load because of the proxy, Chrome shows its own error page, where no
// panel can appear. So the extension steps in: with free proxies it moves on to the next one and loads the
// page again (up to PROXY_RETRIES times), then goes back to your own IP; with your own proxy it says so.
// The toolbar icon in Incognito windows also opens a small proxy panel (proxy-popup.html) at any time.
const PROXY_RETRIES = 6;
const PROXY_FAILS = /ERR_(PROXY|TUNNEL|TIMED_OUT|CONNECTION_TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|EMPTY_RESPONSE|NO_SUPPORTED_PROXIES|SSL_PROTOCOL_ERROR|HTTPS_PROXY)/;
const proxyRetries = new Map(); // tabId → tries for the current page
chrome.webNavigation.onErrorOccurred.addListener((d) => {
  if (d.frameId !== 0 || !PROXY_FAILS.test(d.error || '')) return;
  serial(async () => {
    const tab = await tabOrNull(d.tabId);
    if (!tab?.incognito) return;
    const conf = await getProxyConf();
    if (conf.mode === 'off') return;
    if (conf.mode === 'own') {
      notify('proxy', 'Your proxy isn’t responding', 'Click the Atrium icon in this window to switch to your own IP or another proxy.');
      return;
    }
    const n = (proxyRetries.get(d.tabId) ?? 0) + 1;
    proxyRetries.set(d.tabId, n);
    if (n > PROXY_RETRIES) {
      proxyRetries.delete(d.tabId);
      await setProxyConf({ mode: 'off' });
      notify('proxy', 'Free proxies didn’t work', `After ${PROXY_RETRIES} tries Incognito is back on your own IP. Try again later or use your own proxy.`);
    } else {
      await applyProxy({ next: true });
    }
    await chrome.tabs.update(d.tabId, { url: d.url }).catch(() => {});
  });
});
// A page that loads fine resets the count.
chrome.webNavigation.onCompleted.addListener((d) => { if (d.frameId === 0) proxyRetries.delete(d.tabId); });
chrome.tabs.onRemoved.addListener((tabId) => proxyRetries.delete(tabId));
chrome.proxy.onProxyError.addListener((e) => console.warn('[spaces] proxy error', e?.error));

// Incognito tabs: the toolbar icon opens the proxy panel (the sidebar doesn't work there anyway).
function proxyPopupFor(tab) {
  if (tab?.incognito && tab.id != null) chrome.action.setPopup({ tabId: tab.id, popup: 'proxy-popup.html' }).catch(() => {});
}
chrome.tabs.onCreated.addListener(proxyPopupFor);
chrome.tabs.onUpdated.addListener((_id, change, tab) => { if (change.status === 'loading') proxyPopupFor(tab); });
chrome.runtime.onStartup.addListener(async () => { for (const t of await chrome.tabs.query({})) proxyPopupFor(t); });

// Your own proxy's login and password, when it asks for them.
chrome.webRequest.onAuthRequired.addListener((details, callback) => {
  if (!details.isProxy) return callback({});
  getProxyConf().then((conf) => {
    const o = conf.own;
    if (conf.mode === 'own' && o?.user && details.challenger?.host === o.host) callback({ authCredentials: { username: o.user, password: o.pass || '' } });
    else callback({});
  }, () => callback({}));
}, { urls: ['<all_urls>'] }, ['asyncBlocking']);

// The Google panel and the setup page ask for the state and change the mode.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'proxyGet') {
    Promise.all([getProxyConf(), getProxyState()]).then(([conf, state]) => sendResponse({
      conf: { mode: conf.mode, country: conf.country, hasOwn: !!conf.own?.host, own: msg.withOwn ? conf.own : undefined }, state,
    }), () => sendResponse({}));
    return true;
  }
  if (msg?.type === 'proxySet') {
    setProxyConf(msg.patch || {}).then((state) => sendResponse({ state }), (e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'proxyNext') {
    applyProxy({ next: true }).then(getProxyState).then((state) => sendResponse({ state }), () => sendResponse({}));
    return true;
  }
  if (msg?.type === 'proxySetup') {
    chrome.tabs.create({ url: chrome.runtime.getURL('proxy.html') }).then(() => sendResponse({}), () => sendResponse({}));
    return true;
  }
  return false;
});
// Session proxy state is gone after a browser restart; Chrome keeps the setting, so describe it again.
chrome.runtime.onStartup.addListener(() => applyProxy().catch(() => {}));
} // end of the Incognito proxy (off in 1.0)

// Chrome restores only the windows that were open when it quit. Close every window and then quit, and the
// next start shows a single empty window. Then the window closed last comes back, with all its tabs.
chrome.runtime.onStartup.addListener(() => setTimeout(async () => {
  try {
    const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const normal = wins.filter((w) => !w.incognito);
    const empty = normal.every((w) => w.tabs.every((t) => t.pinned || /^chrome:\/\/newtab|^chrome-extension:\/\/[^/]+\/newtab\.html|^about:blank/.test(t.pendingUrl || t.url || '')));
    const unpinned = normal.flatMap((w) => w.tabs.filter((t) => !t.pinned));
    if (!normal.length || !empty || unpinned.length > 1) return;
    const [last] = await chrome.sessions.getRecentlyClosed({ maxResults: 1 });
    if (!last?.window?.sessionId || (last.window.tabs?.length ?? 0) < 2) return;
    await chrome.sessions.restore(last.window.sessionId);
    for (const t of unpinned) await chrome.tabs.remove(t.id).catch(() => {});
  } catch (e) { console.warn('[atrium] restore last window', e); }
}, 1500));


// ---------- tab tree: which tab a tab was really opened from ----------
// Chrome's own openerTabId also names the tab that was simply active when a tab appeared: a link opened from
// Telegram or another app, or ⌘T, lands "under" whatever you were looking at. Only a page opening a new tab
// itself (a link to a new tab, ⌘-click, window.open) counts here, as webNavigation reports it.
// session.parents = { [tabId]: parentTabId }
async function getParents() { return (await chrome.storage.session.get('parents')).parents ?? {}; }
async function updateParents(fn) {
  const parents = await getParents();
  if (fn(parents) !== false) await chrome.storage.session.set({ parents });
}
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  if (d.sourceTabId == null || d.tabId == null || d.sourceTabId === d.tabId) return;
  updateParents((p) => { p[d.tabId] = d.sourceTabId; });
});
chrome.tabs.onRemoved.addListener((tabId) => updateParents((p) => {
  if (!(tabId in p) && !Object.values(p).includes(tabId)) return false;
  delete p[tabId]; // its children keep pointing at it and simply show at the top level
}));
chrome.tabs.onReplaced.addListener((added, removed) => updateParents((p) => {
  let changed = false;
  for (const k of Object.keys(p)) if (p[k] === removed) { p[k] = added; changed = true; }
  if (removed in p) { p[added] = p[removed]; delete p[removed]; changed = true; }
  return changed;
}));

// ---------- tab order: the same in every window ----------
// "Newest first" sorts a Space's tabs by a number that's the same for all windows, so the grey tabs from
// other windows sit in their places. By default it's the tab id, which Chrome hands out in increasing order
// (newer tab → bigger id). Dragging a tab or opening a grey one here stores another number for that tab.
// session.orderKeys = { [tabId]: number }
async function getOrderKeys() { return (await chrome.storage.session.get('orderKeys')).orderKeys ?? {}; }
const setOrderKeys = (orderKeys) => chrome.storage.session.set({ orderKeys });
chrome.tabs.onRemoved.addListener((tabId, info) => serial(async () => {
  const k = await getOrderKeys();
  // A tab closing with its window keeps its number: it's about to be opened again in another window.
  if (tabId in k && !info.isWindowClosing) { delete k[tabId]; await setOrderKeys(k); }
  const { copies = {} } = await chrome.storage.session.get('copies');
  if (tabId in copies) { delete copies[tabId]; await chrome.storage.session.set({ copies }); }
}));
chrome.tabs.onReplaced.addListener((added, removed) => serial(async () => {
  const k = await getOrderKeys();
  if (removed in k) { k[added] = k[removed]; delete k[removed]; await setOrderKeys(k); }
}));

// ---------- shortcuts by physical key (any keyboard layout) ----------
// local.shortcutKeys = { "alt+shift+KeyS": "_execute_action", … } from the shortcuts set in Chrome.
const KEY_CODES = { '.': 'Period', ',': 'Comma', ' ': 'Space', Space: 'Space', Period: 'Period', Comma: 'Comma',
  Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete' };
function shortcutKey(sc) {
  if (!sc) return null;
  const mods = { alt: false, shift: false, ctrl: false, meta: false };
  let rest = sc;
  // macOS shows ⌃⌥⇧⌘ glyphs in front, other systems "Ctrl+Alt+Shift+…"
  for (const [g, m] of [['⌃', 'ctrl'], ['⌥', 'alt'], ['⇧', 'shift'], ['⌘', 'meta']]) if (rest.includes(g)) { mods[m] = true; rest = rest.split(g).join(''); }
  const parts = rest.split('+').map((p) => p.trim()).filter(Boolean);
  let key = parts.pop() ?? '';
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'alt' || l === 'option') mods.alt = true; else if (l === 'shift') mods.shift = true;
    else if (l === 'ctrl' || l === 'control' || l === 'macctrl') mods.ctrl = true; else if (l === 'command' || l === 'cmd') mods.meta = true;
  }
  let code = KEY_CODES[key] || '';
  if (!code && /^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
  if (!code && /^\d$/.test(key)) code = `Digit${key}`;
  if (!code) return null;
  return `${mods.ctrl ? 'ctrl+' : ''}${mods.alt ? 'alt+' : ''}${mods.shift ? 'shift+' : ''}${mods.meta ? 'meta+' : ''}${code}`;
}
async function refreshShortcutKeys() {
  const map = {};
  for (const c of await chrome.commands.getAll()) {
    const k = shortcutKey(c.shortcut);
    if (k) map[k] = c.name;
  }
  await chrome.storage.local.set({ shortcutKeys: map });
}
refreshShortcutKeys().catch(() => {});
chrome.runtime.onStartup.addListener(() => refreshShortcutKeys().catch(() => {}));
chrome.commands.onChanged?.addListener(() => refreshShortcutKeys().catch(() => {}));
// The shortcuts page may change them without telling: refresh when Chrome's shortcuts tab is left.
chrome.tabs.onActivated.addListener(() => refreshShortcutKeys().catch(() => {}));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'runCommand' || typeof msg.command !== 'string') return false;
  console.info('[spaces] shortcut by key position:', msg.command);
  // The sidebar shortcut toggles it. Closing: the open sidebar closes itself. Opening has to happen right
  // away, while Chrome may still count it as the key press; if Chrome refuses, the page logs why.
  if (msg.command === '_execute_action') {
    const where = sender.tab?.windowId ?? msg.windowId;
    lastRun = { command: msg.command, at: Date.now() };
    const panel = where != null && openPanels.get(where);
    if (panel) { try { panel.postMessage({ type: 'close' }); } catch { /* gone */ } sendResponse({ closed: true }); return false; }
    if (where == null) { sendResponse({ error: 'no window' }); return false; }
    chrome.sidePanel.open({ windowId: where }).then(() => sendResponse({ opened: true }), (e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }
  (async () => {
    const tab = sender.tab ?? (msg.windowId != null ? (await chrome.tabs.query({ active: true, windowId: msg.windowId }))[0] : null);
    runCommand(msg.command, tab ?? { windowId: msg.windowId });
  })().then(() => sendResponse({}), () => sendResponse({}));
  return true;
});

// ---------- closing a window: its tabs move to the windows that stay ----------
// Chrome closes a window together with its tabs, before any extension can step in, and the worker may have
// been asleep (forgetting everything in memory). So a picture of every Space tab (page, title, window,
// Space) is kept in session storage, refreshed shortly after any tab change. When a window closes, its
// tabs are opened again in a remaining window (the one where that Space is open, else the active one), in
// the same Space and the same place in the list (order and tree); until then they show there. Pinned items, Favorites, empty
// New Tabs and Incognito windows are left out. When Chrome itself quits (every window closing), nothing moves.
// session.tabPicture = { [tabId]: { windowId, url, title, spaceId, gone } }
async function getTabPicture() { return (await chrome.storage.session.get('tabPicture')).tabPicture ?? {}; }
let pictureTimer = null;
function refreshTabPicture() {
  clearTimeout(pictureTimer);
  pictureTimer = setTimeout(() => serial(async () => {
    const [tabs, wins, S, old] = await Promise.all([
      chrome.tabs.query({}), chrome.windows.getAll({ windowTypes: ['normal'] }).then((ws) => ws.filter(isSpacesWindow)), getSess(), getTabPicture(),
    ]);
    const liveWins = new Set(wins.map((w) => w.id));
    const linked = new Set(Object.values(S.links));
    const pic = {};
    // Tabs of a window that just closed stay in the picture for a while, so the move can still use them.
    for (const [id, e] of Object.entries(old)) {
      if (!liveWins.has(e.windowId) && Date.now() - (e.gone || Date.now()) < 15000) pic[id] = { ...e, gone: e.gone || Date.now() };
    }
    for (const t of tabs) {
      const url = t.url || t.pendingUrl || '';
      if (t.incognito || t.pinned || linked.has(t.id) || !/^(https?|file):/.test(url)) continue;
      const spaceId = spaceOfGroup(S.wins[t.windowId], t.groupId);
      if (spaceId) pic[t.id] = { windowId: t.windowId, url, title: t.title || '', spaceId };
    }
    await chrome.storage.session.set({ tabPicture: pic });
  }), 600);
}
refreshTabPicture();
for (const ev of ['onCreated', 'onUpdated', 'onAttached', 'onDetached', 'onMoved', 'onActivated']) chrome.tabs[ev].addListener(refreshTabPicture);
chrome.tabGroups.onUpdated.addListener(refreshTabPicture);
chrome.runtime.onStartup.addListener(refreshTabPicture);

chrome.windows.onRemoved.addListener((windowId) => {
  // Read the picture right away, before anything refreshes it; move after a moment (Chrome may be quitting).
  getTabPicture().then(async (pic) => {
    const list = Object.entries(pic).filter(([, e]) => e.windowId === windowId).map(([id, e]) => ({ id: Number(id), ...e }));
    if (!list.length) return;
    // Shown in their places meanwhile (see elsewhereOf in getState).
    for (const e of list) pic[e.id] = { ...pic[e.id], moving: true, gone: Date.now() };
    await chrome.storage.session.set({ tabPicture: pic });
    setTimeout(() => serial(() => rescueTabs(list)).catch((e) => console.warn('[spaces] moving tabs of a closed window', e)), 900);
  });
});

async function rescueTabs(list) {
  const wins = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter(isSpacesWindow);
  if (!wins.length) return;
  const fallback = wins.find((w) => w.focused) ?? wins[0];
  const c = await ctx(fallback.id);
  if (!c?.win) return;
  // Each tab goes to the window where its Space is open right now; otherwise to the active window.
  const windowFor = (spaceId) => wins.find((w) => c.S.wins[w.id]?.active === spaceId)?.id ?? fallback.id;
  const keys = await getOrderKeys();
  const parents = await getParents();
  const newId = new Map(); // old tab id → new tab id
  let moved = 0;
  for (const e of list) {
    if (!e.spaceId || !c.data.spaces.some((s) => s.id === e.spaceId)) continue;
    const w = windowFor(e.spaceId);
    const wid = c.S.wins[w] ? w : fallback.id;
    const t = await chrome.tabs.create({ windowId: wid, url: e.url, active: false }).catch(() => null);
    if (!t) continue;
    newId.set(e.id, t.id);
    await groupInto(wid, e.spaceId, [t.id], c.data, c.S);
    keys[t.id] = keys[e.id] ?? e.id; // same place in "Newest first"
    moved++;
  }
  // The placeholders go as the real tabs arrive.
  const pic = await getTabPicture();
  for (const e of list) delete pic[e.id];
  await chrome.storage.session.set({ tabPicture: pic });
  if (!moved) return;
  // The tree: a moved tab under its (also moved) parent.
  for (const [oldId, nid] of newId) {
    const p = parents[oldId];
    if (p != null) parents[nid] = newId.get(p) ?? p;
  }
  await setOrderKeys(keys);
  await chrome.storage.session.set({ parents });
  await saveSess(c.S);
  notify('rescue', `${moved} tab${moved === 1 ? '' : 's'} moved from the closed window`, 'They’re in their Spaces here, in the same places.');
}

// ---------- plain icons in Chrome's tab strip ----------
// With the setting on, plain-icons.js gives every page the same neutral circle (so Chrome's own tab strip
// doesn't distract) and reports the page's real icon here, per site. The sidebar and the Command Bar use those.
// local.realIcons = { host: iconUrl } (the last 800 sites)
async function getRealIcons() { return (await chrome.storage.local.get('realIcons')).realIcons ?? {}; }
let realIconWrite = Promise.resolve();
function rememberRealIcon(host, url) {
  realIconWrite = realIconWrite.then(async () => {
    const icons = await getRealIcons();
    if (icons[host] === url) return;
    delete icons[host];
    icons[host] = url;
    const hosts = Object.keys(icons);
    for (const h of hosts.slice(0, Math.max(0, hosts.length - 800))) delete icons[h];
    await chrome.storage.local.set({ realIcons: icons });
  }).catch(() => {});
}
const isPlainIcon = (u) => { try { return !!u && u.startsWith('data:image/svg') && decodeURIComponent(u).includes('data-spaces="plain"'); } catch { return false; } };
/** A tab's icon for our own lists: the real one when the page shows the plain circle. */
function realFavicon(t, icons) {
  const fav = t.favIconUrl || '';
  if (!isPlainIcon(fav)) return fav;
  return realIconFor(icons, t.url || t.pendingUrl || '');
}
