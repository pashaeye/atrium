// Content script on every page (top frame). In an Incognito window (only when the extension is allowed in
// Incognito: chrome://extensions → Atrium → Details → Allow in Incognito) it frames the page with a thin
// violet border and a small "Incognito" label in the corner, so it's obvious this tab is private.
// Nothing is shown in normal windows. Both elements ignore the mouse.
(() => {
  if (window.__spacesIncognito) return;
  window.__spacesIncognito = true;
  let incognito = false;
  try { incognito = !!chrome.extension?.inIncognitoContext; } catch { /* extension reloaded */ }
  if (!incognito) return;

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
      :host { all: initial; }
      .frame { position: fixed; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 3px rgba(139, 92, 246, 0.85); }
      .tag {
        position: fixed; left: 10px; bottom: 10px; display: flex; align-items: center; gap: 6px; padding: 5px 10px 5px 8px;
        border-radius: 999px; pointer-events: none; color: #fff; background: rgba(76, 45, 160, 0.88);
        font: 600 12px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25); transition: opacity 0.6s;
      }
      .tag.quiet { opacity: 0.45; }
      svg { width: 15px; height: 15px; display: block; }
    </style>
    <div class="frame"></div>
    <div class="tag"><svg viewBox="0 0 256 256" fill="currentColor"><path d="M248,112H220.08l-47.5-65.41a16,16,0,0,0-21.63-3.93L128,56.24l-23-13.58a16,16,0,0,0-21.62,3.93L35.92,112H8a8,8,0,0,0,0,16H248a8,8,0,0,0,0-16ZM180,144a36,36,0,0,0-35.77,32H111.77A36,36,0,1,0,109,192h38a36,36,0,1,0,33-48ZM76,200a20,20,0,1,1,20-20A20,20,0,0,1,76,200Zm104,0a20,20,0,1,1,20-20A20,20,0,0,1,180,200Z"/></svg>Incognito</div>`;
  const mount = () => document.documentElement.append(host);
  if (document.documentElement) mount(); else addEventListener('DOMContentLoaded', mount);
  // Not in screenshots: shot.js says when it opens and closes.
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data?.__spacesShot === 'open') host.style.display = 'none';
    if (e.data?.__spacesShot === 'close') host.style.display = '';
  });
  // The label is clear at first, then steps back so it doesn't get in the way.
  setTimeout(() => root.querySelector('.tag')?.classList.add('quiet'), 4000);
})();
