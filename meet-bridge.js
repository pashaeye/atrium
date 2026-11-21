// Content script on meet.google.com (isolated world): forwards presentation events from
// meet-hook.js (page world) to the extension's background worker.
// After the extension is reloaded, this copy can't reach it any more and quietly switches itself off.
(() => {
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  function onPageMessage(e) {
    if (e.source !== window || !e.data?.__spacesMeet) return;
    if (!alive()) { window.removeEventListener('message', onPageMessage); return; }
    const { type, surface, handle } = e.data;
    try {
      chrome.runtime.sendMessage({ type: 'meetShareEvent', event: { type, surface, handle } }).catch(() => {});
    } catch {
      window.removeEventListener('message', onPageMessage);
    }
  }
  window.addEventListener('message', onPageMessage);
})();
