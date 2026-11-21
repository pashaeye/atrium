// Shortcuts on any keyboard layout. Chrome matches letter shortcuts by the character typed, so with Russian
// (or another non-Latin) layout ⌥⇧S etc. don't fire. This script — in every page and in the extension's
// own pages — catches the same keys by their physical position (event.code) and asks background.js to run
// the command. The map of keys comes from the shortcuts set in chrome://extensions/shortcuts.
(() => {
  if (window.__spacesKeys) return;
  window.__spacesKeys = true;
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  let map = {};
  try {
    chrome.storage.local.get('shortcutKeys').then((r) => { map = r.shortcutKeys || {}; }, () => {});
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.shortcutKeys) map = ch.shortcutKeys.newValue || {}; });
  } catch { return; }
  // Extension pages without a tab of their own (the sidebar) say which window they're in.
  let windowId = null;
  try { chrome.windows?.getCurrent?.().then((w) => { windowId = w.id; }, () => {}); } catch { /* content script */ }

  addEventListener('keydown', (e) => {
    if (!e.altKey && !e.ctrlKey && !e.metaKey) return; // every shortcut has a modifier
    const k = `${e.ctrlKey ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${e.metaKey ? 'meta+' : ''}${e.code}`;
    const command = map[k];
    if (!command || !alive()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    try {
      chrome.runtime.sendMessage({ type: 'runCommand', command, windowId })
        .then((r) => { if (r?.error) console.warn('[spaces] couldn’t run', command, '—', r.error); }, () => {});
    } catch { /* reloaded */ }
  }, true);
})();
