// Screenshot tool, injected into a page from the sidebar's camera button (see "screenshots" in background.js).
// While it's open the page is dimmed and can only be scrolled (clicks and typing are blocked). A bar on top:
// Screen (what you see), Area (drag a rectangle) or Full page, then Copy (clipboard) or Save (.png in
// Downloads). A selected area can be dragged around; Copy / Save / × (select again) sit next to it.
// Captures come from the extension; a full page is taken screen by screen while scrolling, with fixed
// headers hidden after the first screen, and stitched. Our own UI is hidden while capturing.
(() => {
  if (window.__spacesShot) return;
  window.__spacesShot = true;

  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Two animation frames (the page has repainted), or 120 ms if frames are paused (hidden tab).
  const frame = () => new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 120); });
  const MAX_HEIGHT = 30000; // canvas limit, in image pixels
  const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

  let host = null, root = null, mode = 'screen', area = null, busy = false, dragging = false;

  // ---------- UI ----------
  const CAMERA = '<svg viewBox="0 0 256 256" fill="currentColor"><path d="M208,56H180.28L166.65,35.56A8,8,0,0,0,160,32H96a8,8,0,0,0-6.65,3.56L75.71,56H48A24,24,0,0,0,24,80V192a24,24,0,0,0,24,24H208a24,24,0,0,0,24-24V80A24,24,0,0,0,208,56Zm-44,76a36,36,0,1,1-36-36A36,36,0,0,1,164,132Z"/></svg>';
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
    .pill {
      display: flex; align-items: center; gap: 6px; padding: 5px; border-radius: 999px;
      background: rgba(250, 250, 252, 0.9); color: #1c1c1e;
      -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
      box-shadow: 0 0 0 0.5px rgba(0,0,0,.14), 0 10px 34px rgba(0,0,0,.22);
      font-size: 13px;
    }
    .bar { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 4; animation: in .22s cubic-bezier(.32,.72,0,1); }
    @keyframes in { from { opacity: 0; transform: translate(-50%, -6px); } }
    .ico { width: 30px; height: 30px; display: grid; place-items: center; opacity: .7; }
    .ico svg { width: 16px; height: 16px; }
    .seg { display: flex; padding: 2px; gap: 2px; border-radius: 999px; background: rgba(0,0,0,.06); }
    .seg button, .btn, .x {
      all: unset; cursor: default; padding: 6px 12px; border-radius: 999px; font-weight: 600; white-space: nowrap;
      transition: background .15s, opacity .15s;
    }
    .seg button { color: inherit; opacity: .65; }
    .seg button:hover { opacity: 1; }
    .seg button[aria-pressed=true] { background: #fff; opacity: 1; box-shadow: 0 1px 3px rgba(0,0,0,.14); }
    .btn { background: rgba(0,0,0,.07); }
    .btn:hover { filter: brightness(.97); }
    .btn.primary { background: #1c1c1e; color: #fff; }
    .btn[disabled] { opacity: .4; pointer-events: none; }
    .x { padding: 6px 10px; opacity: .6; font-size: 16px; line-height: 1; }
    .x:hover { opacity: 1; }
    .status { padding: 0 10px; opacity: .75; font-weight: 600; white-space: nowrap; }

    /* The page under a dim layer: it can still be scrolled (the wheel passes through to the page), nothing else. */
    .shade { position: fixed; inset: 0; z-index: 1; background: rgba(0,0,0,.3); }
    .shade.area { cursor: crosshair; }
    .shade.picked { background: transparent; }
    .sel {
      position: fixed; z-index: 2; border: 1.5px solid #fff; border-radius: 2px; cursor: move;
      box-shadow: 0 0 0 9999px rgba(0,0,0,.36), 0 0 0 0.5px rgba(0,0,0,.4);
    }
    .size { position: absolute; left: -1.5px; top: -24px; padding: 2px 7px; border-radius: 6px; font-size: 11px; font-weight: 600; color: #fff; background: rgba(0,0,0,.6); white-space: nowrap; pointer-events: none; }
    .sel-actions { position: fixed; z-index: 3; padding: 4px; gap: 4px; animation: pop .16s ease-out; }
    .sel-actions .btn { padding: 5px 11px; }
    @keyframes pop { from { opacity: 0; transform: translateY(-3px); } }
    .hint { position: fixed; top: 64px; left: 50%; transform: translateX(-50%); z-index: 2; color: #fff; font-weight: 600; font-size: 13px; text-shadow: 0 1px 3px rgba(0,0,0,.5); pointer-events: none; }

    /* Dark mode last, so it wins over the light rules above. */
    @media (prefers-color-scheme: dark) {
      .pill { background: rgba(38, 38, 42, 0.9); color: #f2f2f4; box-shadow: 0 0 0 0.5px rgba(255,255,255,.14), 0 10px 34px rgba(0,0,0,.5); }
      .seg { background: rgba(255,255,255,.08); }
      .seg button[aria-pressed=true] { background: rgba(255,255,255,.18); }
      .btn { background: rgba(255,255,255,.1); }
      .btn.primary { background: #f2f2f4; color: #1c1c1e; }
    }
  `;

  function open(startMode = null) {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="shade" style="pointer-events:auto"></div>
      <div class="bar pill" style="pointer-events:auto">
        <span class="ico">${CAMERA}</span>
        <div class="seg">
          <button data-mode="screen" title="What you see now">Screen</button>
          <button data-mode="area" title="Drag to select a part of the screen">Area</button>
          <button data-mode="full" title="The whole page, top to bottom">Full page</button>
        </div>
        <button class="btn" data-out="copy" title="Copy the image (Enter)">Copy</button>
        <button class="btn primary" data-out="save" title="Save a .png to Downloads">Save</button>
        <button class="x" title="Close (Esc)">×</button>
      </div>`;
    document.documentElement.append(host);
    document.activeElement?.blur?.(); // so typing doesn't go into a field on the page
    mode = startMode === 'full' ? 'full' : 'screen';
    area = null;
    window.postMessage({ __spacesShot: 'open' }, '*'); // other parts of the extension on the page step aside
    root.addEventListener('click', onClick);
    root.querySelector('.shade').addEventListener('mousedown', onShadeDown);
    for (const ev of ['keydown', 'keyup', 'keypress']) addEventListener(ev, onKey, true);
    sync();
  }

  function close() {
    for (const ev of ['keydown', 'keyup', 'keypress']) removeEventListener(ev, onKey, true);
    if (host) window.postMessage({ __spacesShot: 'close' }, '*');
    host?.remove();
    host = root = null;
    area = null;
    busy = false;
  }

  // Only scrolling keys reach the page; Esc closes, Enter copies.
  function onKey(e) {
    if (SCROLL_KEYS.has(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'keydown') return;
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && !busy) output('copy');
  }

  function onClick(e) {
    const m = e.target.closest('[data-mode]');
    if (m && !busy) { mode = m.dataset.mode; area = null; return sync(); }
    const out = e.target.closest('[data-out]');
    if (out && !busy) return output(out.dataset.out);
    if (e.target.closest('[data-reselect]')) { area = null; return sync(); }
    if (e.target.closest('.x')) close();
  }

  function sync() {
    root.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    root.querySelectorAll('.bar [data-out]').forEach((b) => { b.disabled = busy || (mode === 'area' && !area); });
    const shade = root.querySelector('.shade');
    shade.classList.toggle('area', mode === 'area');
    shade.classList.toggle('picked', mode === 'area' && !!area);
    if (mode !== 'area' || !area) {
      root.querySelector('.sel')?.remove();
      root.querySelector('.sel-actions')?.remove();
    }
    let hint = root.querySelector('.hint');
    if (mode === 'area' && !area) {
      if (!hint) { hint = document.createElement('div'); hint.className = 'hint'; root.append(hint); }
      hint.textContent = 'Drag to select an area';
    } else {
      hint?.remove();
    }
    if (mode === 'area' && area) { drawSel(area); if (!dragging) drawActions(area); }
  }

  // ---------- area: draw a new one on the shade, move the selected one by dragging it ----------
  const clamp = (r) => {
    const w = Math.min(r.w, innerWidth), h = Math.min(r.h, innerHeight);
    return { x: Math.max(0, Math.min(r.x, innerWidth - w)), y: Math.max(0, Math.min(r.y, innerHeight - h)), w, h };
  };

  function track(onMove, onEnd) {
    dragging = true;
    root.querySelector('.sel-actions')?.remove();
    const move = (ev) => { ev.preventDefault(); onMove(ev); };
    const up = (ev) => {
      removeEventListener('mousemove', move, true);
      removeEventListener('mouseup', up, true);
      dragging = false;
      onEnd(ev);
    };
    addEventListener('mousemove', move, true);
    addEventListener('mouseup', up, true);
  }

  function onShadeDown(e) {
    if (mode !== 'area' || e.button !== 0 || busy) return;
    e.preventDefault();
    const x0 = e.clientX, y0 = e.clientY;
    root.querySelector('.hint')?.remove();
    root.querySelector('.shade').classList.add('picked');
    let r = { x: x0, y: y0, w: 0, h: 0 };
    track((ev) => {
      r = clamp({ x: Math.min(x0, ev.clientX), y: Math.min(y0, ev.clientY), w: Math.abs(ev.clientX - x0), h: Math.abs(ev.clientY - y0) });
      drawSel(r);
    }, () => {
      area = r.w > 4 && r.h > 4 ? r : null;
      sync();
    });
  }

  function onSelDown(e) {
    if (e.button !== 0 || busy || !area) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { ...area }, x0 = e.clientX, y0 = e.clientY;
    track((ev) => {
      area = clamp({ ...start, x: start.x + ev.clientX - x0, y: start.y + ev.clientY - y0 });
      drawSel(area);
    }, () => sync());
  }

  function drawSel(r) {
    let sel = root.querySelector('.sel');
    if (!sel) {
      sel = document.createElement('div');
      sel.className = 'sel';
      sel.style.pointerEvents = 'auto';
      sel.title = 'Drag to move';
      sel.innerHTML = '<span class="size"></span>';
      sel.addEventListener('mousedown', onSelDown);
      root.append(sel);
    }
    Object.assign(sel.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    sel.firstChild.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    sel.firstChild.style.top = r.y < 28 ? '4px' : '-24px'; // inside the area when there's no room above it
    sel.firstChild.style.left = r.y < 28 ? '4px' : '-1.5px';
  }

  /** Copy / Save / × right under the area (above it, or inside, when there's no room below). */
  function drawActions(r) {
    let box = root.querySelector('.sel-actions');
    if (!box) {
      box = document.createElement('div');
      box.className = 'sel-actions pill';
      box.style.pointerEvents = 'auto';
      box.innerHTML = `<button class="x" data-reselect title="Select again">×</button>
        <button class="btn" data-out="copy" title="Copy the image (Enter)">Copy</button>
        <button class="btn primary" data-out="save" title="Save a .png to Downloads">Save</button>`;
      root.append(box);
    }
    const bw = box.offsetWidth || 190, bh = box.offsetHeight || 38, gap = 8;
    let top = r.y + r.h + gap;
    if (top + bh > innerHeight - 4) top = r.y - bh - gap;
    if (top < 4) top = r.y + r.h - bh - gap;
    const left = Math.max(4, Math.min(r.x + r.w - bw, innerWidth - bw - 4));
    Object.assign(box.style, { top: `${Math.max(4, top)}px`, left: `${left}px` });
  }

  // ---------- capture ----------
  async function grab() {
    const res = await chrome.runtime.sendMessage({ type: 'shotCapture' });
    if (!res?.dataUrl) throw new Error(res?.error || 'Capture failed');
    const img = new Image();
    img.src = res.dataUrl;
    await img.decode();
    return img;
  }

  /** Hide our own UI (dimming included), let the page repaint, run fn, show the UI again. */
  async function hidden(fn) {
    host.style.visibility = 'hidden';
    await frame();
    await sleep(40);
    try { return await fn(); } finally { if (host) host.style.visibility = ''; }
  }

  function status(text) {
    let s = root?.querySelector('.bar .status');
    if (!s && root) { s = document.createElement('span'); s.className = 'status'; root.querySelector('.bar .ico').after(s); }
    if (s) s.textContent = text;
  }

  const canvasBlob = (canvas) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image too large'))), 'image/png'));

  async function shotScreen(crop = null) {
    const img = await hidden(grab);
    const k = img.naturalWidth / innerWidth;
    const r = crop ?? { x: 0, y: 0, w: innerWidth, h: innerHeight };
    const c = document.createElement('canvas');
    c.width = Math.round(r.w * k);
    c.height = Math.round(r.h * k);
    c.getContext('2d').drawImage(img, Math.round(r.x * k), Math.round(r.y * k), c.width, c.height, 0, 0, c.width, c.height);
    return canvasBlob(c);
  }

  /** Elements that stay on screen while scrolling (headers, chat buttons): hidden after the first screen. */
  function stickyElements() {
    const out = [];
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (let i = 0; i < all.length && i < 20000; i++) {
      const el = all[i];
      if (el === host) continue;
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') out.push(el);
    }
    return out;
  }

  async function shotFull() {
    const se = document.scrollingElement || document.documentElement;
    const total = Math.max(se.scrollHeight, document.body?.scrollHeight ?? 0);
    const vh = innerHeight;
    if (total <= vh + 2) return shotScreen(); // nothing to scroll (or the page scrolls inside a box)
    const startX = scrollX, startY = scrollY;
    const htmlStyle = document.documentElement.style;
    const prevBehavior = htmlStyle.scrollBehavior;
    htmlStyle.scrollBehavior = 'auto';
    const steps = Math.ceil(total / vh);
    const frames = [];
    let hiddenEls = [];
    try {
      for (let i = 0; i < steps; i++) {
        status(`${i + 1} / ${steps}`);
        window.scrollTo(0, Math.min(i * vh, total - vh));
        await sleep(i ? 180 : 60); // let lazy images and scroll effects settle
        if (i === 1) {
          hiddenEls = stickyElements().map((el) => [el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
          hiddenEls.forEach(([el]) => el.style.setProperty('visibility', 'hidden', 'important'));
          await frame();
        }
        const y = scrollY;
        frames.push({ y, img: await hidden(grab) });
        if (y + vh >= total - 1) break;
      }
    } finally {
      hiddenEls.forEach(([el, v, p]) => (v ? el.style.setProperty('visibility', v, p) : el.style.removeProperty('visibility')));
      window.scrollTo(startX, startY);
      htmlStyle.scrollBehavior = prevBehavior;
      status('');
    }
    const k = frames[0].img.naturalWidth / innerWidth;
    const c = document.createElement('canvas');
    c.width = frames[0].img.naturalWidth;
    c.height = Math.min(Math.round(total * k), MAX_HEIGHT);
    const ctx = c.getContext('2d');
    for (const f of frames) ctx.drawImage(f.img, 0, Math.round(f.y * k));
    return canvasBlob(c);
  }

  function take() {
    if (mode === 'area' && area) return shotScreen(area);
    return mode === 'full' ? shotFull() : shotScreen();
  }

  /** screenshot-github-com-2026-11-17-14-05-33.png: no spaces or dots, only dashes. */
  const fileName = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const site = (location.hostname.replace(/^www\./, '') || 'page').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    return `screenshot-${site}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.png`;
  };

  function save(blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName();
    a.style.display = 'none';
    document.documentElement.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30e3);
  }

  async function output(kind) {
    if (busy || !alive()) return;
    if (mode === 'area' && !area) return;
    busy = true;
    root.querySelectorAll('[data-out], [data-mode], [data-reselect]').forEach((b) => { b.disabled = true; });
    const blob = take();
    try {
      if (kind === 'copy') {
        try {
          // Started right in the click, so the browser allows it even though the image takes a moment.
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          done('Copied to clipboard');
        } catch (e) {
          if (!(await blob.catch(() => null))) throw e;
          save(await blob); // the page doesn't allow the clipboard: save instead
          done('Saved to Downloads (copying isn’t allowed here)');
        }
      } else {
        save(await blob);
        done('Saved to Downloads');
      }
    } catch (e) {
      console.warn('[spaces] screenshot', e);
      done(`Screenshot failed: ${e?.message || e}`, true);
    }
  }

  /** The tool is finished: give the page back right away and show a short note, then remove the bar too. */
  function done(text, failed = false) {
    if (!root) return;
    for (const ev of ['keydown', 'keyup', 'keypress']) removeEventListener(ev, onKey, true);
    root.querySelectorAll('.shade, .sel, .sel-actions, .hint').forEach((el) => el.remove());
    root.querySelector('.bar').innerHTML = `<span class="ico">${CAMERA}</span><span class="status">${text.replace(/[<&]/g, '')}</span>`;
    const h = host;
    setTimeout(() => { if (host === h) close(); }, failed ? 4000 : 1400);
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type !== 'shotOpen') return false;
    open(msg.mode);
    sendResponse({ ok: true });
    return false;
  });
})();
