// Runs inside every page and frame (MAIN world) from document_start, for the sidebar mini player.
// Sees all playback, including <audio> that is never added to the page or lives in a shadow root
// (common in music players such as Tidal), and remembers the page's own Media Session handlers
// (the ones the Mac media keys use) so the sidebar can press play / pause / next / previous.
// In video calls it also reports and switches the microphone and camera.
// Talks to media.js (isolated world) through window.postMessage.
(() => {
  if (window.__spacesMediaMain) return;
  window.__spacesMediaMain = true;

  const post = (m) => window.postMessage({ __spacesMedia: true, ...m }, '*');
  const els = new Set();
  const handlers = {};
  const ms = navigator.mediaSession;
  const isPlaying = (m) => !m.paused && !m.ended;
  let last = null;
  // Only pages that actually played something show up in the player. A music site that restores its last
  // track after a browser restart (and registers its media buttons) isn't listed until playback starts.
  let everPlayed = false;

  // ---- calls: microphone and camera ----
  // Video-call sites can tell the browser about the mic / camera (Media Session: setMicrophoneActive,
  // setCameraActive, and "togglemicrophone" / "togglecamera" handlers). Google Meet also gets a fallback
  // through its own buttons, found by the shortcut at the end of their label ("… (⌘ + d)" mic,
  // "… (⌘ + e)" camera), which is the same in every language; data-is-muted tells whether it's off.
  const session = { mic: null, cam: null };
  const isMeet = location.hostname === 'meet.google.com' && window === window.top;
  const SHORTCUT = { mic: /\+\s*d\s*\)?\s*$/i, cam: /\+\s*e\s*\)?\s*$/i };
  function meetButton(kind) {
    if (!isMeet) return null;
    for (const el of document.querySelectorAll('[data-is-muted]')) {
      const label = (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '').trim();
      if (SHORTCUT[kind].test(label)) return el;
    }
    return null;
  }
  const ACTION = { mic: 'togglemicrophone', cam: 'togglecamera' };

  // Any call site (Zoom, Teams, Telemost, Slack, Discord, WhatsApp, Telegram…): the page is "in a call" while
  // it holds a live camera or microphone from getUserMedia. Those tracks also tell whether the mic / camera
  // is on (a muted app usually disables its track or stops it). Screen sharing (getDisplayMedia) isn't counted.
  const tracks = new Set();
  const mediaDevices = navigator.mediaDevices;
  if (mediaDevices?.getUserMedia) {
    const nativeGum = mediaDevices.getUserMedia.bind(mediaDevices);
    mediaDevices.getUserMedia = async (constraints) => {
      const stream = await nativeGum(constraints);
      for (const t of stream.getTracks()) {
        tracks.add(t);
        nativeAdd.call(t, 'ended', () => { tracks.delete(t); report(); });
      }
      report();
      return stream;
    };
  }
  // Screen sharing on any call site: which tab (or window / screen) is being presented, for the red dot.
  if (mediaDevices?.getDisplayMedia) {
    const nativeGdm = mediaDevices.getDisplayMedia.bind(mediaDevices);
    mediaDevices.getDisplayMedia = async (constraints) => {
      const stream = await nativeGdm(constraints);
      const v = stream.getVideoTracks()[0];
      if (v) {
        const handle = () => { try { return v.getCaptureHandle?.()?.handle || ''; } catch { return ''; } };
        post({ type: 'share', event: 'share-started', surface: v.getSettings?.().displaySurface || 'unknown', handle: handle() });
        nativeAdd.call(v, 'capturehandlechange', () => post({ type: 'share', event: 'share-handle', handle: handle() }));
        nativeAdd.call(v, 'ended', () => post({ type: 'share', event: 'share-ended' }));
      }
      return stream;
    };
  }
  const liveTracks = () => [...tracks].filter((t) => t.readyState === 'live');
  const capturing = () => liveTracks().length > 0;
  /** From the tracks: true on, false off (none live, or all disabled), null when not in a call at all. */
  function trackState(kind) {
    if (!capturing()) return null;
    const ts = liveTracks().filter((t) => t.kind === (kind === 'mic' ? 'audio' : 'video'));
    return ts.some((t) => t.enabled);
  }
  // Apps have no common API to flip the mic / camera, so in a call their own buttons are used when found:
  // a button whose label names the microphone or the camera (English and Russian), not "share" or
  // "settings" ones. Its label or aria-pressed tells the state where it can.
  const BTN = { mic: /(micro|mute|микрофон)/i, cam: /(camera|video|камер|видео)/i };
  const NOT_BTN = /(share|screen|present|демонстр|экран|setting|настро|effect|эффект|background|фон|device|устройств|more|ещё|option|параметр|caption|субтитр|record|запис)/i;
  const labelOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-tooltip') || el.getAttribute('data-tid') || el.id || '').trim();
  function appButton(kind) {
    if (isMeet || !capturing()) return null;
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      const label = labelOf(el);
      if (!label || NOT_BTN.test(label) || !BTN[kind].test(label)) continue;
      if (kind === 'mic' && BTN.cam.test(label)) continue;
      if (kind === 'cam' && BTN.mic.test(label) && !/video|камер|видео|camera/i.test(label)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue; // hidden
      return el;
    }
    return null;
  }
  function buttonState(el) {
    const label = labelOf(el);
    // The label says what a click will do: "Unmute" / "Turn on camera" → it's off now.
    if (/(unmute|turn on|start|enable|включить|вкл\b|разрешить)/i.test(label)) return false;
    if (/(\bmute|turn off|stop|disable|выключить|отключить|выкл\b)/i.test(label)) return true;
    const pressed = el.getAttribute('aria-pressed') ?? el.getAttribute('aria-checked');
    return pressed == null ? null : pressed !== 'true'; // usually "pressed" = muted
  }

  /** true = on, false = off, null = this page has no such control. */
  function callState(kind) {
    const b = meetButton(kind);
    if (b) return b.getAttribute('data-is-muted') !== 'true';
    if (session[kind] != null) return session[kind];
    const ab = appButton(kind);
    const fromButton = ab ? buttonState(ab) : null;
    if (fromButton != null) return fromButton;
    const fromTracks = trackState(kind);
    if (fromTracks != null) return fromTracks;
    return handlers[ACTION[kind]] ? true : null;
  }
  function toggleCall(kind) {
    const b = meetButton(kind) || appButton(kind);
    if (b) { b.click(); return; }
    if (handlers[ACTION[kind]]) {
      try { handlers[ACTION[kind]]({ action: ACTION[kind] }); return; } catch { /* page's handler failed */ }
    }
    // Last resort: switch our side of the call's own tracks (the others hear / see nothing). The app's own
    // button may not show it.
    const ts = liveTracks().filter((t) => t.kind === (kind === 'mic' ? 'audio' : 'video'));
    const on = ts.some((t) => t.enabled);
    ts.forEach((t) => { t.enabled = !on; });
  }
  // In a call, check every couple of seconds: apps flip their buttons and tracks without any event.
  setInterval(() => { if (capturing()) report(); }, 2000);

  function snapshot() {
    const md = ms?.metadata;
    const art = md?.artwork?.length ? md.artwork[md.artwork.length - 1].src : '';
    // Decorative videos (silent backgrounds and animations: muted, no controls) aren't something to play or
    // pause, so they don't count; one counts once it has sound or controls (e.g. the visitor unmutes it).
    const live = [...els].filter((m) => (m.isConnected || !m.paused || m === last) && !decorative(m));
    const playing = live.some(isPlaying) || ms?.playbackState === 'playing';
    if (playing) everPlayed = true;
    const mic = callState('mic'), cam = callState('cam');
    const inCall = capturing() || mic != null || cam != null;
    post({
      type: 'state',
      playing,
      hasMedia: inCall || (everPlayed && (live.length > 0 || !!handlers.play || !!handlers.pause)),
      mic, cam, capturing: capturing(),
      title: md?.title || '', artist: md?.artist || '', artwork: art || '',
      actions: Object.keys(handlers).filter((k) => handlers[k]),
    });
  }
  let timer;
  const report = () => { clearTimeout(timer); timer = setTimeout(snapshot, 150); };

  const decorative = (m) => !m.controls && (m.muted || m.volume === 0 || (m instanceof HTMLVideoElement && !hasAudio(m)));
  /** Whether a video carries any sound at all (where the browser can tell). */
  function hasAudio(v) {
    if (typeof v.mozHasAudio === 'boolean') return v.mozHasAudio;
    if (typeof v.webkitAudioDecodedByteCount === 'number' && v.currentTime > 1 && !v.paused) return v.webkitAudioDecodedByteCount > 0;
    if (v.audioTracks) return v.audioTracks.length > 0;
    return true;
  }
  const nativeAdd = EventTarget.prototype.addEventListener;
  function track(el) {
    if (els.has(el)) return;
    els.add(el);
    for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied', 'volumechange']) {
      nativeAdd.call(el, ev, () => { if (ev === 'play' || ev === 'playing') last = el; report(); });
    }
  }

  // Every play() call, wherever the element lives (detached, shadow DOM, iframe content).
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    track(this);
    last = this;
    const p = nativePlay.apply(this, args);
    report();
    return p;
  };
  // Autoplaying elements in the page that never call play().
  nativeAdd.call(document, 'play', (e) => {
    if (e.target instanceof HTMLMediaElement) { track(e.target); last = e.target; report(); }
  }, true);

  // Calls: what the page tells the browser about its mic / camera.
  if (ms?.setMicrophoneActive) {
    const nativeMic = ms.setMicrophoneActive.bind(ms);
    ms.setMicrophoneActive = (on) => { session.mic = !!on; report(); return nativeMic(on); };
  }
  if (ms?.setCameraActive) {
    const nativeCam = ms.setCameraActive.bind(ms);
    ms.setCameraActive = (on) => { session.cam = !!on; report(); return nativeCam(on); };
  }
  // Meet: notice the mic / camera buttons appearing and switching.
  if (isMeet) {
    const watch = () => new MutationObserver(report).observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['data-is-muted'],
    });
    if (document.documentElement) watch(); else addEventListener('DOMContentLoaded', watch);
  }

  // Media Session: keep the page's handlers and notice metadata / playback state changes.
  if (ms?.setActionHandler) {
    const nativeSet = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (action, handler) => {
      handlers[action] = handler || null;
      report();
      return nativeSet(action, handler);
    };
    const proto = Object.getPrototypeOf(ms);
    for (const prop of ['metadata', 'playbackState']) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (d?.get && d?.set) {
        Object.defineProperty(ms, prop, {
          configurable: true,
          get() { return d.get.call(ms); },
          set(v) { d.set.call(ms, v); report(); },
        });
      }
    }
  }

  const call = (action) => {
    const h = handlers[action];
    if (!h) return false;
    try { h({ action }); return true; } catch { return false; }
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data?.__spacesMediaCmd) return;
    const all = [...els];
    const el = (last && els.has(last) ? last : null) || all.find(isPlaying) || all.find((m) => m.isConnected) || null;
    const playing = el ? isPlaying(el) : ms?.playbackState === 'playing';
    switch (e.data.action) {
      case 'toggle':
        if (playing) { if (!call('pause')) el?.pause(); }
        else if (!call('play')) el?.play().catch(() => {});
        break;
      case 'next': call('nexttrack'); break;
      case 'prev': if (!call('previoustrack') && el) el.currentTime = 0; break;
      case 'mic': toggleCall('mic'); break;
      case 'cam': toggleCall('cam'); break;
    }
    report();
  });
})();
