// Content script (top frame): a tab dragged out of the Atrium sidebar and let go over this page.
// The page accepts the drop, so the system doesn't animate the tab sliding back into the sidebar, and the
// tab opens in its own window there (background.js grows the window from the spot where it was let go).
// Only drags that carry Atrium's own type are touched; everything else on the page works as usual.
(() => {
  if (window.__atriumTabDrop || window !== window.top) return;
  window.__atriumTabDrop = true;
  const TYPE = 'application/x-atrium-tab';
  const ours = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes(TYPE);
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  for (const type of ['dragenter', 'dragover']) {
    window.addEventListener(type, (e) => {
      if (!ours(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.dataTransfer.dropEffect = 'move';
    }, true);
  }
  window.addEventListener('drop', (e) => {
    if (!ours(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const tabId = Number(e.dataTransfer.getData(TYPE));
    if (!Number.isFinite(tabId) || !alive()) return;
    chrome.runtime.sendMessage({ type: 'tabToNewWindow', tabId, left: e.screenX, top: e.screenY }).catch(() => {});
  }, true);
})();
