// Content script on every page (top frame, isolated world): Peek.
// Shift+click on a link opens it in a card over the current page (works in full screen too) instead of
// a new window:
// a dimmed backdrop and, in the middle, the extension's peek-frame.html showing the link.
// Click the backdrop, press Esc or × to close; "Open in Space" keeps it as a normal tab.
// As in modern browsers: in Favorites and Pinned tabs, a plain click on a link to another site opens it in Peek too,
// so the pinned page stays where it is.
(() => {
  if (window.__spacesPeek) return;
  window.__spacesPeek = true;

  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const send = (msg) => {
    if (!alive()) return Promise.resolve(null);
    try { return chrome.runtime.sendMessage(msg).catch(() => null); } catch { return Promise.resolve(null); }
  };

  let overlay = null;
  let prevOverflow = '';

  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.documentElement.style.overflow = prevOverflow;
    send({ type: 'peekDone' });
  }

  async function open(url) {
    close();
    // Let the previewed site be shown inside this tab (sites often forbid being embedded).
    await send({ type: 'peekPrepare' });
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const root = overlay.attachShadow({ mode: 'closed' });
    const src = chrome.runtime.getURL(`peek-frame.html?url=${encodeURIComponent(url)}`);
    root.innerHTML = `
      <style>
        .back { position: fixed; inset: 0; background: rgba(12, 12, 20, 0.38);
          -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); animation: fade .18s ease-out; }
        .card { position: fixed; left: 50%; top: 50%; width: min(1280px, 88vw); height: 88vh;
          transform: translate(-50%, -50%); border-radius: 14px; overflow: hidden; background: #fff;
          box-shadow: 0 0 0 0.5px rgba(0,0,0,.18), 0 24px 70px rgba(0,0,0,.35); animation: rise .22s cubic-bezier(.32,.72,0,1); }
        iframe { width: 100%; height: 100%; border: 0; display: block; }
        @keyframes fade { from { opacity: 0; } }
        @keyframes rise { from { opacity: 0; transform: translate(-50%, -48%) scale(.98); } }
      </style>
      <div class="back"></div>
      <div class="card"><iframe src="${src}" allow="fullscreen; clipboard-write; autoplay; encrypted-media; picture-in-picture"></iframe></div>`;
    root.querySelector('.back').addEventListener('click', close);
    prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden'; // don't scroll the page behind the card
    document.documentElement.append(overlay);
    root.querySelector('iframe').focus();
  }

  // The card's own page asks to close (× / Esc / after "Open in Space").
  const frameOrigin = (() => { try { return new URL(chrome.runtime.getURL('/')).origin; } catch { return ''; } })();
  window.addEventListener('message', (e) => {
    if (e.origin === frameOrigin && e.data?.__spacesPeek === 'close') close();
  });
  window.addEventListener('keydown', (e) => { if (overlay && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } }, true);
  // The extension's New Tab page (which also loads this file) opens cards itself, from its list.
  window.__spacesPeekOpen = (url) => open(url);

  // ---- automatic Peek in Favorites / Pinned tabs ----
  let autoPeek = false;
  const refreshContext = () => send({ type: 'peekContext' }).then((r) => { autoPeek = !!r?.auto; });
  refreshContext();
  window.addEventListener('focus', refreshContext);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshContext(); });

  // "Same site" = same registrable domain, so mail.google.com and docs.google.com count as one site.
  const TWO_PART = /\.(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/;
  const site = (host) => {
    const h = host.replace(/^www\./, '');
    const parts = h.split('.');
    return parts.slice(TWO_PART.test(h) ? -3 : -2).join('.');
  };
  // Sign-in flows often go through links to another site: leave those alone.
  const isAuth = (u) => /^(accounts|login|auth|sso|id|signin|oauth)\./.test(u.hostname)
    || /(^|\/)(oauth2?|authorize|sso|saml|signin|login)(\/|$|\?)/i.test(u.pathname);

  function linkFrom(e) {
    // composedPath() also finds links inside shadow DOM (web-component sites such as Reddit).
    const a = e.composedPath().find((n) => (n instanceof HTMLAnchorElement || n instanceof SVGAElement) && n.href);
    if (!a) return null;
    let url;
    try { url = new URL(typeof a.href === 'string' ? a.href : a.href.baseVal, location.href); } catch { return null; }
    if (!/^https?:$/.test(url.protocol)) return null;
    // Google wraps outgoing links (e.g. in Gmail) as google.com/url?q=<real link>: look through it.
    if (site(url.hostname).startsWith('google.') && url.pathname === '/url') {
      try {
        const real = new URL(url.searchParams.get('q') || url.searchParams.get('url') || '');
        if (/^https?:$/.test(real.protocol)) url = real;
      } catch { /* keep the wrapper */ }
    }
    return { a, url };
  }

  // Opens in Peek:
  //  - Shift+click on any link, on any site;
  //  - a plain click on a link the site opens in a new tab / window (target="_blank"), on any site;
  //  - in Favorites / Pinned tabs, also a plain click on a link to another site.
  // Cmd+click (Ctrl+click) keeps Chrome's own "open in a background tab".
  window.addEventListener('click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const link = linkFrom(e);
    if (!link) return;
    const { a, url } = link;
    if (!e.shiftKey) {
      if (a.hasAttribute?.('download')) return;
      if (isAuth(url)) return;
      const target = (a.getAttribute?.('target') || '').toLowerCase();
      const newTab = !!target && !['_self', '_parent', '_top'].includes(target);
      const otherSite = site(url.hostname) !== site(location.hostname);
      if (!newTab && !(autoPeek && otherSite)) return;
    }
    if (!alive()) return; // extension reloaded: let Chrome do its default
    e.preventDefault();
    e.stopImmediatePropagation();
    open(url.href);
  }, true);
})();
