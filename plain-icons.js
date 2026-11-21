// Content script (top frame). With "Plain icons in Chrome's tab strip" on (Settings; on unless turned off), every page shows the
// same neutral circle as its icon, so Chrome's own tab strip next to the sidebar stays calm. The page's real
// icon is reported to background.js first, so the sidebar and the Command Bar keep showing real icons.
// The page's own icon links are only switched off (rel renamed), so turning the setting off restores them.
(() => {
  if (window.__spacesPlainIcons || window !== window.top) return;
  window.__spacesPlainIcons = true;
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  if (!/^(https?|file):$/.test(location.protocol)) return;

  const PLAIN = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" data-spaces="plain"><circle cx="8" cy="8" r="5" fill="#8e8e93"/></svg>');
  const ICON_REL = /(^|\s)(shortcut\s+)?icon(\s|$)|apple-touch-icon|mask-icon/i;
  let on = false, mine = null, observer = null, reported = '';

  const pageIcons = () => [...document.querySelectorAll('link[rel]')].filter((l) => l !== mine && ICON_REL.test(l.rel));

  /** The page's own icon: the first declared one, else /favicon.ico. */
  function realIcon() {
    const l = pageIcons().find((x) => /icon/i.test(x.rel) && !/mask|apple/i.test(x.rel)) || pageIcons()[0]
      || [...document.querySelectorAll('link[data-spaces-rel]')][0];
    const href = l?.getAttribute('href');
    try { return new URL(href || '/favicon.ico', location.href).href; } catch { return ''; }
  }
  function report() {
    const url = realIcon();
    if (!url || url === reported || !alive()) return;
    reported = url;
    try { chrome.runtime.sendMessage({ type: 'realIcon', host: location.hostname, url }).catch(() => {}); } catch { /* reloaded */ }
  }

  function apply() {
    if (!document.head) return;
    report();
    for (const l of pageIcons()) { l.dataset.spacesRel = l.rel; l.rel = 'x-spaces-icon'; }
    if (!mine) {
      mine = document.createElement('link');
      mine.rel = 'icon';
      mine.href = PLAIN;
    }
    if (mine.parentNode !== document.head || document.head.lastElementChild !== mine) document.head.append(mine);
  }
  function restore() {
    observer?.disconnect();
    observer = null;
    mine?.remove();
    for (const l of document.querySelectorAll('link[data-spaces-rel]')) { l.rel = l.dataset.spacesRel; delete l.dataset.spacesRel; }
  }
  function start() {
    apply();
    // Sites change their icon (unread counts…): put the circle back, after noting the new real one.
    observer ??= new MutationObserver(() => { if (on) apply(); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['rel', 'href'] });
  }
  function set(value) {
    on = !!value;
    if (on) {
      if (document.head) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      restore();
    }
  }

  try {
    // On by default: only an explicit "off" in Settings turns it off.
    chrome.storage.local.get('plainTabIcons').then((r) => set(r.plainTabIcons !== false), () => {});
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.plainTabIcons) set(ch.plainTabIcons.newValue !== false); });
  } catch { /* extension reloaded */ }
})();
