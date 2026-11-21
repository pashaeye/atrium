// Small proxy panel on the toolbar icon in Incognito windows (set per tab by background.js). Works even
// when a page couldn't load through a proxy and shows Chrome's error page.
const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e?.message || e) }));
const COUNTRIES = ['us', 'gb', 'de', 'fr', 'nl', 'ca', 'au', 'jp', 'in', 'br', 'es', 'it', 'mx', 'kr', 'tr', 'ch', 'se', 'pl', 'sg', 'ae'];
const name = (() => { try { const d = new Intl.DisplayNames(['en'], { type: 'region' }); return (c) => d.of(c.toUpperCase()) || c; } catch { return (c) => c; } })();

function show(r) {
  const conf = r?.conf || {}, st = r?.state || {};
  const cc = (conf.country || 'us').toLowerCase();
  $('country').innerHTML = [...new Set([cc, ...COUNTRIES])].map((c) => `<option value="${c}"${c === cc ? ' selected' : ''}>${name(c)}</option>`).join('');
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === (conf.mode || 'off'))));
  $('own').disabled = !conf.hasOwn;
  $('next').hidden = conf.mode !== 'free';
  let text = 'Your own IP: Incognito goes out directly.';
  if (st.mode === 'free') text = st.error || `Free proxy in ${name(st.country || cc)}: ${st.server} (${st.tried} of ${st.of})`;
  if (st.mode === 'own') text = st.error || `Your proxy: ${st.server}`;
  if (r?.error) text = r.error;
  $('status').textContent = text;
}

async function reloadPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.reload(tab.id).catch(() => {});
  window.close();
}

async function set(patch) {
  const r = await ask({ type: 'proxySet', patch });
  if (r?.error || r?.state?.error) { show({ ...(await ask({ type: 'proxyGet' })), error: r.error || r.state.error }); return; }
  reloadPage();
}

document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', (e) => {
  if (e.target.closest('select')) return;
  set({ mode: b.dataset.mode, ...(b.dataset.mode === 'free' ? { country: $('country').value } : {}) });
}));
$('country').addEventListener('change', () => set({ mode: 'free', country: $('country').value }));
$('next').addEventListener('click', async () => { await ask({ type: 'proxyNext' }); reloadPage(); });
$('setup').addEventListener('click', () => { ask({ type: 'proxySetup' }); window.close(); });
ask({ type: 'proxyGet' }).then(show);
