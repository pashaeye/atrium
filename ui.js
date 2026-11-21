// Small UI primitives: context menu, modal form, toast.
import { COLORS, COLOR_HEX, esc } from './shared.js';
import { icon } from './icons.js';

let menuEl = null;
let subEl = null;
const closeSub = () => { subEl?.remove(); subEl = null; };
export function closeMenu() {
  closeSub();
  menuEl?.remove();
  menuEl = null;
}

/** Build a menu element. Entries with `submenu` show "›" and open a nested menu on click. */
function buildMenu(entries, onPick) {
  const el = document.createElement('div');
  el.className = 'menu';
  el.innerHTML = entries.map((e, i) =>
    e.separator ? '<hr>' :
    e.heading ? `<div class="label">${esc(e.heading)}</div>` :
    `<button data-i="${i}" class="${e.danger ? 'danger' : ''}${e.submenu ? ' has-sub' : ''}"><span class="m-label">${esc(e.label)}</span>${e.hint ? `<span class="m-hint">${esc(e.hint)}</span>` : ''}${e.submenu ? '<span class="m-arrow">›</span>' : ''}</button>`).join('');
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-i]');
    if (b) onPick(entries[Number(b.dataset.i)], b);
  });
  return el;
}

function place(el, x, y) {
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
}

function openSub(entry, anchor) {
  closeSub();
  subEl = buildMenu(entry.submenu, (e) => { if (e.run) { closeMenu(); e.run(); } });
  subEl.classList.add('sub');
  document.body.append(subEl);
  const a = anchor.getBoundingClientRect();
  const w = subEl.getBoundingClientRect().width;
  // To the right of the item if it fits, otherwise to the left, otherwise just below it.
  const x = a.right + w + 4 <= innerWidth ? a.right - 2 : a.left - w + 2 >= 4 ? a.left - w + 2 : a.left + 12;
  const y = a.right + w + 4 <= innerWidth || a.left - w + 2 >= 4 ? a.top - 6 : a.bottom + 2;
  place(subEl, x, y);
}

/** entries: [{ label, run, danger, hint, submenu: [entries] }] | { separator: true } | { heading: 'text' } */
/** opts.above: open upwards from y (for buttons at the bottom of the panel). */
export function openMenu(x, y, entries, opts = {}) {
  closeMenu();
  menuEl = buildMenu(entries, (entry, b) => {
    if (entry.submenu) {
      // Submenus open (and close again) on click only.
      if (subEl?.dataset.for === b.dataset.i) return closeSub();
      openSub(entry, b);
      subEl.dataset.for = b.dataset.i;
      return;
    }
    closeMenu();
    entry.run?.();
  });
  document.body.append(menuEl);
  place(menuEl, x, opts.above ? y - menuEl.offsetHeight : y);
}
addEventListener('mousedown', (e) => {
  if (menuEl && !menuEl.contains(e.target) && !subEl?.contains(e.target)) closeMenu();
}, true);
addEventListener('blur', closeMenu);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

/**
 * fields: [{ name, label, value, type: 'text' | 'textarea' | 'color' | 'icon' | 'choice', options?, placeholder?, note? }]
 * 'choice' options: [[value, label], …] shown as a segmented control.
 * Resolves with { [name]: value } or null when cancelled.
 */
export function openModal({ title, text = '', fields, submitLabel = 'Save', altLabel = '' }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    const field = (f) => {
      if (f.type === 'color') {
        return `<div class="field"><span class="field-label">${esc(f.label)}</span><div class="swatches" data-name="${f.name}">${COLORS.map((c) =>
          `<button type="button" class="swatch" data-pick="${c}" aria-pressed="${c === f.value}" title="${c}" style="background:${COLOR_HEX[c]}"></button>`).join('')}</div></div>`;
      }
      if (f.type === 'icon') {
        // f.options: [[iconName, label], …] — a fixed, single-colour set.
        return `<div class="field"><span class="field-label">${esc(f.label)}</span><div class="icon-grid" data-name="${f.name}">${f.options.map(([n, label]) =>
          `<button type="button" class="icon-opt" data-pick="${n}" aria-pressed="${n === f.value}" title="${esc(label)}">${icon(n)}</button>`).join('')}</div></div>`;
      }
      const note = f.note ? `<span class="field-note">${esc(f.note)}</span>` : '';
      if (f.type === 'choice') {
        return `<div class="field"><span class="field-label">${esc(f.label)}</span><div class="seg" data-name="${f.name}">${f.options.map(([v, label]) =>
          `<button type="button" class="seg-opt" data-pick="${esc(String(v))}" aria-pressed="${String(v) === String(f.value)}">${esc(label)}</button>`).join('')}</div>${note}</div>`;
      }
      if (f.type === 'textarea') {
        return `<label class="field"><span class="field-label">${esc(f.label)}</span><textarea name="${f.name}" rows="8" spellcheck="false" placeholder="${esc(f.placeholder ?? '')}">${esc(f.value ?? '')}</textarea>${note}</label>`;
      }
      return `<label class="field"><span class="field-label">${esc(f.label)}</span><input type="text" name="${f.name}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}" autocomplete="off">${note}</label>`;
    };
    back.innerHTML = `<form class="modal">
      <h3>${esc(title)}</h3>
      ${text ? `<p class="modal-text">${esc(text)}</p>` : ''}
      ${fields.map(field).join('')}
      <div class="actions"><button type="button" class="btn" data-cancel>Cancel</button>${altLabel ? `<button type="button" class="btn" data-alt>${esc(altLabel)}</button>` : ''}<button class="btn primary">${esc(submitLabel)}</button></div>
    </form>`;
    document.body.append(back);
    const form = back.querySelector('form');
    const done = (v) => { back.remove(); resolve(v); };
    form.querySelectorAll('.swatches, .icon-grid, .seg').forEach((group) => group.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      group.querySelectorAll('[data-pick]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const out = {};
      for (const f of fields) {
        out[f.name] = f.type === 'color' || f.type === 'icon' || f.type === 'choice'
          ? form.querySelector(`[data-name="${f.name}"] [aria-pressed=true]`)?.dataset.pick ?? f.value
          : form.elements[f.name].value;
      }
      done(out);
    });
    form.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    form.querySelector('[data-alt]')?.addEventListener('click', () => done('alt'));
    back.addEventListener('mousedown', (e) => { if (e.target === back) done(null); });
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
    const first = form.querySelector('input[name], textarea[name]') || form.querySelector('.btn.primary');
    first?.focus();
    first?.select?.();
  });
}

export function confirmModal(title, okLabel = 'Delete') {
  return openModal({ title, fields: [], submitLabel: okLabel }).then((v) => v !== null);
}

/**
 * A list with checkboxes (all checked to start). Resolves with the ids still checked, or null if cancelled.
 * items: [{ id, title, sub, icon }]; submitLabel(n) builds the button text for n checked items.
 */
export function pickModal({ title, note, items, submitLabel }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<form class="modal pick">
      <h3>${esc(title)}</h3>
      ${note ? `<p class="pick-note">${esc(note)}</p>` : ''}
      <div class="pick-tools"><button type="button" class="link" data-all>Select all</button><button type="button" class="link" data-none>Select none</button></div>
      <div class="pick-list">${items.map((it) => `
        <label class="pick-row">
          <input type="checkbox" value="${esc(it.id)}" checked>
          ${it.icon ? `<img src="${esc(it.icon)}" alt="">` : ''}
          <span class="pick-text"><span class="pick-title">${esc(it.title)}</span><span class="pick-sub">${esc(it.sub || '')}</span></span>
        </label>`).join('')}</div>
      <div class="actions"><button type="button" class="btn" data-cancel>Cancel</button><button class="btn primary" data-submit></button></div>
    </form>`;
    document.body.append(back);
    const form = back.querySelector('form');
    const boxes = [...form.querySelectorAll('input[type=checkbox]')];
    const submit = form.querySelector('[data-submit]');
    const sync = () => {
      const n = boxes.filter((b) => b.checked).length;
      submit.textContent = submitLabel(n);
      submit.disabled = n === 0;
    };
    sync();
    form.addEventListener('change', sync);
    form.querySelector('[data-all]').addEventListener('click', () => { boxes.forEach((b) => { b.checked = true; }); sync(); });
    form.querySelector('[data-none]').addEventListener('click', () => { boxes.forEach((b) => { b.checked = false; }); sync(); });
    const done = (v) => { back.remove(); resolve(v); };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      done(boxes.filter((b) => b.checked).map((b) => b.value));
    });
    form.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    back.addEventListener('mousedown', (e) => { if (e.target === back) done(null); });
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
    submit.focus();
  });
}

let toastTimer;
/** A short message at the bottom. With `title` and/or `icon` (SVG markup) it's a small card that says
    what it's about; `tone` ('focus' | 'error' | 'done') colours the icon. */
export function toast(msg, ms = 3500, { title = '', icon = '', tone = '', action = null } = {}) {
  const el = document.getElementById('toast');
  if (!el) return console.warn(msg);
  if (title || icon || action) {
    el.innerHTML = `${icon ? `<span class="t-ico">${icon}</span>` : ''}<span class="t-body">${title ? '<b class="t-title"></b>' : ''}<span class="t-text"></span>${action ? '<button type="button" class="t-act"></button>' : ''}</span><button type="button" class="t-x" aria-label="Close">×</button>`;
    if (title) el.querySelector('.t-title').textContent = title;
    el.querySelector('.t-text').textContent = msg;
    // `action` = { label, run }: a button inside the message (it stays until clicked or closed).
    if (action) {
      const b = el.querySelector('.t-act');
      b.textContent = action.label;
      b.addEventListener('click', () => { action.run(); el.hidden = true; });
    }
    el.querySelector('.t-x').addEventListener('click', () => { el.hidden = true; });
  } else {
    el.textContent = msg;
  }
  el.classList.toggle('rich', !!(title || icon));
  el.dataset.tone = tone;
  el.classList.toggle('long', String(msg).length > 44); // more than a line: a card, not a pill
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/**
 * Before opening something in Incognito: the extension's own part there (the private-page frame) only works when Chrome lets the extension into Incognito. If it doesn't yet, say so and offer
 * the switch. Resolves true to go ahead (allowed, or "Open anyway"), false to stop.
 */
export async function incognitoGate() {
  let allowed = true;
  try { allowed = await chrome.extension.isAllowedIncognitoAccess(); } catch { /* unknown: don't block */ }
  if (allowed) return true;
  const v = await openModal({
    title: 'Allow Atrium in Incognito first',
    text: 'Without it, private pages get no violet frame and “Incognito” label. In the settings that open, turn on “Allow in Incognito”, then come back.',
    fields: [], submitLabel: 'Open settings', altLabel: 'Open anyway',
  });
  if (v === 'alt') return true;
  if (v) chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  return false;
}
