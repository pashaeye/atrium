// Content script on every page and frame (isolated world): relays between media-main.js (page world,
// which sees the playback and the page's media controls) and the extension's background worker.
(() => {
  if (window.__spacesMedia) return;
  window.__spacesMedia = true;

  // After the extension is reloaded or updated, this copy stays on already-open pages but can no longer
  // reach the extension (chrome.runtime.sendMessage throws "Extension context invalidated").
  // It then quietly switches itself off; the page gets a fresh copy when it is reloaded.
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  function onPageMessage(e) {
    if (e.source === window && e.data?.__spacesMedia && e.data.type === 'share' && alive()) {
      const { event, surface, handle } = e.data;
      try { chrome.runtime.sendMessage({ type: 'shareEvent', event: { type: event, surface, handle } }).catch(() => {}); } catch { /* reloaded */ }
      return;
    }
    if (e.source !== window || !e.data?.__spacesMedia || e.data.type !== 'state') return;
    if (!alive()) { window.removeEventListener('message', onPageMessage); return; }
    const { playing, hasMedia, title, artist, artwork, actions, mic, cam, capturing } = e.data;
    try {
      chrome.runtime.sendMessage({ type: 'mediaState', playing, hasMedia, title, artist, artwork, actions, mic, cam, capturing }).catch(() => {});
    } catch {
      window.removeEventListener('message', onPageMessage);
    }
  }
  window.addEventListener('message', onPageMessage);

  // When this page or frame goes away (navigation, a removed iframe such as a closed Peek card), media
  // events stop without a final "pause": tell the extension nothing plays here any more.
  window.addEventListener('pagehide', () => {
    if (!alive()) return;
    try { chrome.runtime.sendMessage({ type: 'mediaState', playing: false, hasMedia: false }).catch(() => {}); } catch {}
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'mediaControl') return false;
    window.postMessage({ __spacesMediaCmd: true, action: msg.action }, '*');
    sendResponse({ ok: true });
    return false;
  });
})();
