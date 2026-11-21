// Command Bar over the current page (injected on demand by background.js, e.g. from the sidebar's New Tab
// button). No window and no tab is created up front: the bar is the extension's command.html in a card
// on top of the page, and a tab only opens once you pick or type something there.
// Click outside the card or press Esc to close it. The card's page tells us its height, and asks to close.
(() => {
  if (window.__spacesCmdOverlay) return;
  window.__spacesCmdOverlay = true;

  let host = null;
  const origin = (() => { try { return new URL(chrome.runtime.getURL('/')).origin; } catch { return ''; } })();

  function close() {
    host?.remove();
    host = null;
  }

  function open(win) {
    close();
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const src = chrome.runtime.getURL(`command.html?win=${encodeURIComponent(win ?? '')}&overlay=1`);
    root.innerHTML = `
      <style>
        .back { position: fixed; inset: 0; background: rgba(12, 12, 20, 0.22); animation: fade .15s ease-out; }
        .card {
          position: fixed; left: 50%; top: 16vh; width: min(660px, calc(100vw - 32px)); height: 120px;
          transform: translateX(-50%); border-radius: 22px; overflow: hidden; background: transparent;
          box-shadow: 0 24px 70px rgba(0,0,0,.35); animation: rise .22s cubic-bezier(.32,.72,0,1);
          transition: height .12s ease-out;
        }
        iframe { width: 100%; height: 100%; border: 0; display: block; background: transparent; color-scheme: normal; }
        @keyframes fade { from { opacity: 0; } }
        @keyframes rise { from { opacity: 0; transform: translate(-50%, -6px) scale(.985); } }
      </style>
      <div class="back"></div>
      <div class="card"><iframe src="${src}" allow="clipboard-write"></iframe></div>`;
    root.querySelector('.back').addEventListener('mousedown', close);
    const frame = root.querySelector('iframe');
    frame.addEventListener('load', () => frame.focus());
    document.documentElement.append(host);
    frame.focus();
    host._card = root.querySelector('.card');
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== origin || !host) return;
    if (e.data?.__spacesCmd === 'close') close();
    if (e.data?.__spacesCmd === 'height') {
      const h = Math.min(Number(e.data.h) || 120, Math.round(innerHeight * 0.76));
      host._card.style.height = `${h}px`;
    }
  });
  window.addEventListener('keydown', (e) => { if (host && e.key === 'Escape') { e.preventDefault(); close(); } }, true);

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type !== 'cmdOverlayOpen') return false;
    open(msg.windowId);
    sendResponse({ ok: true });
    return false;
  });
})();
