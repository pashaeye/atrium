// Content script on every page (isolated world, top frame only).
// Labels this tab with a Capture Handle ("spaces:<tabId>"). When a call site (Meet, Zoom, Teams, Telemost…)
// presents a tab, the captured track carries this label, so the extension can tell which tab is being shown
// (the red dot). The label is only Chrome's internal tab number; nothing else about the page is exposed.
(async () => {
  try {
    if (!navigator.mediaDevices?.setCaptureHandleConfig) return;
    const res = await chrome.runtime.sendMessage({ type: 'myTabId' });
    if (res?.result == null) return;
    navigator.mediaDevices.setCaptureHandleConfig({
      handle: `spaces:${res.result}`,
      exposeOrigin: false,
      permittedOrigins: ['*'],
    });
  } catch {
    // Not available on this page (or the extension was reloaded): no label, no harm.
  }
})();
