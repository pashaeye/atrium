document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.copy) {
    await navigator.clipboard.writeText(b.dataset.copy).catch(() => {});
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  } else if (b.dataset.open) {
    chrome.tabs.create({ url: b.dataset.open }).catch(() => {
      b.textContent = 'Open the address manually';
    });
  } else if (b.id === 'open-panel') {
    const win = await chrome.windows.getCurrent();
    chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
  }
});

/** A shortcut as key caps: "⇧⌘E" (macOS) or "Ctrl+Shift+K" (others) → one <kbd> per key. */
function keyCaps(shortcut) {
  const keys = shortcut.includes('+') ? shortcut.split('+') : [...shortcut.matchAll(/[⌃⌥⇧⌘]|[^⌃⌥⇧⌘]+/g)].map((m) => m[0]);
  const span = document.createElement('span');
  span.className = 'keys';
  for (const k of keys) {
    const kbd = document.createElement('kbd');
    kbd.textContent = k;
    span.append(kbd);
  }
  return span;
}

// Step 4 shows the sidebar's shortcut as key caps.
chrome.commands.getAll().then((cmds) => {
  const c = cmds.find((x) => x.name === '_execute_action');
  document.getElementById('k-panel').replaceChildren(c?.shortcut ? keyCaps(c.shortcut) : 'not set');
});
