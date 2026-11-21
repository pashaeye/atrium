// Content script (top frame, document_start): focus mode's site pause.
// While you focus, a distracting site is covered by a calm card and its sound and video stop. The tab keeps
// its own title and icon, pages that were already open are covered too, and everything comes back the
// moment focus ends, a break starts or you take a 1-minute pass — no reload.
// background.js keeps local.focusBlock = { sites, exempt, passes: { site: until }, endsAt } while focusing.
(() => {
  if (window.__atriumFocusGuard || window !== window.top) return;
  window.__atriumFocusGuard = true;
  if (!/^https?:$/.test(location.protocol)) return;
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  const host = location.hostname.replace(/^www\./, '');
  const onSite = (site) => host === site || host.endsWith(`.${site}`);
  let block = null, card = null, timer = 0;

  /** The paused site this page belongs to, or '' when it isn't paused right now. */
  function pausedSite() {
    if (!block) return '';
    const site = (block.sites || []).find(onSite);
    if (!site || (block.exempt || []).some(onSite)) return '';
    const now = Date.now();
    const pass = Object.entries(block.passes || {}).find(([s, until]) => onSite(s) && until > now);
    return pass ? '' : site;
  }

  // Nothing plays behind the card.
  const hush = (e) => { if (card && e.target instanceof HTMLMediaElement) e.target.pause(); };
  document.addEventListener('play', hush, true);
  const pauseAll = () => document.querySelectorAll('video, audio').forEach((m) => { try { m.pause(); } catch { /* ignore */ } });

  const left = () => {
    if (!block?.endsAt) return 'while focus is on';
    const m = Math.max(1, Math.ceil((block.endsAt - Date.now()) / 60e3));
    return `for ${m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`} more`;
  };

  function show(site) {
    if (!card) {
      card = document.createElement('div');
      card.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
      const root = card.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
          :host { all: initial; }
          .wrap { position: fixed; inset: 0; display: grid; place-items: center; padding: 24px;
            background: #f4f3f8; color: #1d1b26; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
          @media (prefers-color-scheme: dark) { .wrap { background: #18171f; color: #ecebf3; } .sub { color: #a09db2 !important; }
            button { background: #2a2836 !important; color: #ecebf3 !important; border-color: #3a3747 !important; } }
          .box { max-width: 420px; text-align: center; display: grid; gap: 10px; justify-items: center; }
          .dot { width: 44px; height: 44px; border-radius: 50%; background: radial-gradient(circle at 34% 30%, #fff, #d6ccff 22%, #8b6bff 55%, #4a2fc9 85%, #2a1a80); }
          h1 { font-size: 20px; font-weight: 600; margin: 6px 0 0; }
          .sub { color: #6b6880; margin: 0; }
          button { margin-top: 8px; font: inherit; font-size: 14px; padding: 8px 16px; border-radius: 999px; cursor: pointer;
            background: #fff; color: #1d1b26; border: 1px solid #dcd9e6; }
          button:hover { border-color: #8b6bff; }
          button:focus-visible { outline: 2px solid #8b6bff; outline-offset: 2px; }
        </style>
        <div class="wrap"><div class="box">
          <div class="dot" aria-hidden="true"></div>
          <h1></h1>
          <p class="sub"></p>
          <button type="button">Open for 1 minute</button>
        </div></div>`;
      card._h = root.querySelector('h1');
      card._sub = root.querySelector('.sub');
      const btn = root.querySelector('button');
      card._btn = btn;
      btn.addEventListener('click', () => {
        btn.disabled = true;
        if (alive()) chrome.runtime.sendMessage({ type: 'focusPass', url: location.href }).catch(() => { btn.disabled = false; });
      });
    }
    card._h.textContent = `${site} is paused while you focus`;
    card._sub.textContent = `It opens again ${left()}.`;
    card._btn.disabled = false;
    if (!card.isConnected) {
      (document.documentElement || document).appendChild(card);
      document.documentElement.style.setProperty('overflow', 'hidden', 'important');
    }
    pauseAll();
  }

  function hide() {
    if (!card?.isConnected) return;
    card.remove();
    document.documentElement.style.removeProperty('overflow');
  }

  function update() {
    clearTimeout(timer);
    const site = pausedSite();
    if (site) show(site); else hide();
    // Wake up when a pass runs out, and refresh the "opens again in" line.
    const now = Date.now();
    const next = Math.min(...Object.values(block?.passes || {}).filter((t) => t > now), now + 30e3);
    if (block) timer = setTimeout(update, Math.max(500, next - now + 200));
  }

  try {
    chrome.storage.local.get('focusBlock').then((r) => { block = r.focusBlock || null; update(); }, () => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch.focusBlock) return;
      block = ch.focusBlock.newValue || null;
      update();
    });
  } catch { /* extension reloaded */ }
})();
