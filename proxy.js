// Settings page for the Incognito proxy (see "proxy for Incognito windows only" in background.js).
const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e?.message || e) }));

function show(conf, state, error) {
  const s = state || {};
  let text = 'Off: Incognito windows go out directly.';
  if (s.mode === 'free') text = s.error || `Free proxy in ${(s.country || conf.country || 'us').toUpperCase()}: ${s.server} (${s.tried} of ${s.of})`;
  if (s.mode === 'own') text = s.error || `Your proxy: ${s.server}`;
  if (error) text = `Didn’t work: ${error}`;
  $('status').textContent = text;
  $('next').hidden = s.mode !== 'free';
}

async function load() {
  const r = await ask({ type: 'proxyGet', withOwn: true });
  const own = r?.conf?.own || {};
  $('scheme').value = own.scheme || 'http';
  $('host').value = own.host || '';
  $('port').value = own.port || '';
  $('user').value = own.user || '';
  $('pass').value = own.pass || '';
  show(r?.conf || {}, r?.state, r?.error);
}

async function set(patch) {
  const r = await ask({ type: 'proxySet', patch });
  const g = await ask({ type: 'proxyGet' });
  show(g?.conf || {}, r?.state || g?.state, r?.error);
}

$('off').addEventListener('click', () => set({ mode: 'off' }));
$('free').addEventListener('click', () => set({ mode: 'free' }));
$('next').addEventListener('click', async () => {
  const r = await ask({ type: 'proxyNext' });
  const g = await ask({ type: 'proxyGet' });
  show(g?.conf || {}, r?.state || g?.state, r?.error);
});
$('save').addEventListener('click', () => {
  const own = {
    scheme: $('scheme').value, host: $('host').value.trim(), port: $('port').value.trim(),
    user: $('user').value.trim(), pass: $('pass').value,
  };
  if (!own.host || !/^\d+$/.test(own.port)) { $('status').textContent = 'Fill in the host and a port number.'; return; }
  set({ mode: 'own', own });
});
// Without Incognito access Chrome refuses the proxy: say so up front.
chrome.extension.isAllowedIncognitoAccess().then((ok) => { $('access').hidden = ok; }, () => {});
$('allow').addEventListener('click', () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));
load();
