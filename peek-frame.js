// The Peek card's content (an extension page shown in an iframe over the current site):
// a small bar (site, "Open in <Space> ▾", ×) and the previewed page below it.
import { icon } from './icons.js';

const COLOR_HEX = {
  grey: '#80868b', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038',
  pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e',
};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const glyph = (s) => (s.icon ? icon(s.icon) : s.emoji ? esc(s.emoji) : `<span class="dot" style="background:${COLOR_HEX[s.color] ?? '#888'}"></span>`);

const url = new URLSearchParams(location.search).get('url');
let u = null;
try { u = new URL(url); } catch {}

if (u && /^https?:$/.test(u.protocol)) {
  $('#page').src = u.href;
  const b = document.createElement('b');
  b.textContent = u.hostname.replace(/^www\./, '');
  $('#host').append(b, document.createTextNode(u.pathname.length > 1 ? u.pathname : ''));
  const fav = new URL(chrome.runtime.getURL('/_favicon/'));
  fav.searchParams.set('pageUrl', u.href);
  fav.searchParams.set('size', '32');
  $('#fav').src = fav.href;

  const close = () => window.parent.postMessage({ __spacesPeek: 'close' }, '*');
  const keep = async (spaceId) => {
    try { await chrome.runtime.sendMessage({ type: 'peekKeep', url: u.href, spaceId }); } catch {}
    close();
  };

  // Spaces of this window: the main button opens in the current one, ▾ lists all of them.
  let spaces = [];
  let current = null;
  (async () => {
    try {
      const windowId = (await chrome.windows.getCurrent()).id;
      const res = await chrome.runtime.sendMessage({ type: 'getIndex', windowId });
      spaces = res?.result?.spaces ?? [];
      current = spaces.find((s) => s.id === res?.result?.activeSpaceId) ?? spaces[0] ?? null;
    } catch {}
    if (current) {
      $('#cur-ico').innerHTML = glyph(current);
      $('#cur-name').textContent = current.name;
    }
    if (spaces.length < 2) $('#more').hidden = true;
  })();

  $('#more').innerHTML = icon('caret-down');
  $('#keep').addEventListener('click', () => keep(current?.id));
  $('#more').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('#spaces');
    if (!m.hidden) { m.hidden = true; return; }
    m.innerHTML = spaces.map((s) => `<button data-id="${s.id}"><span class="s-ico">${glyph(s)}</span>${esc(s.name)}${s.id === current?.id ? '<span class="cur">current</span>' : ''}</button>`).join('');
    m.hidden = false;
  });
  $('#spaces').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) keep(b.dataset.id);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#spaces, #more')) $('#spaces').hidden = true; });

  $('#close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#spaces').hidden) { $('#spaces').hidden = true; return; }
    close();
  });
}
