// Runs inside Google Meet's own page (MAIN world) from document_start.
// Only observes: when Meet starts presenting (getDisplayMedia), it reports which surface is shown and
// the shown tab's Capture Handle ("spaces:<tabId>", set by capture-handle.js), and reports when the
// presentation ends. It doesn't change what Meet sends.
// Talks to meet-bridge.js (isolated world) through window.postMessage.
(() => {
  if (window.__spacesMeetHook) return;
  window.__spacesMeetHook = true;

  const post = (msg) => window.postMessage({ __spacesMeet: true, ...msg }, location.origin);
  const handleOf = (t) => { try { return t.getCaptureHandle?.()?.handle || null; } catch { return null; } };
  const report = (type, t) => post({ type, surface: t.getSettings?.().displaySurface || 'unknown', handle: handleOf(t) });

  let current = null;
  const end = (t) => {
    if (current !== t) return;
    current = null;
    post({ type: 'share-ended' });
  };

  const md = navigator.mediaDevices;
  const nativeGDM = md?.getDisplayMedia?.bind(md);
  if (!nativeGDM) return;
  md.getDisplayMedia = async function (constraints) {
    const stream = await nativeGDM(constraints);
    const track = stream.getVideoTracks()[0];
    if (track) {
      current = track;
      report('share-started', track);
      track.addEventListener('ended', () => end(track)); // stopped from Chrome's "Stop sharing" bar
      track.addEventListener('capturehandlechange', () => { if (current === track) report('share-handle', track); });
      const nativeStop = track.stop.bind(track);
      track.stop = () => { end(track); nativeStop(); }; // Meet's own "Stop presenting"
    }
    return stream;
  };
})();
