// Injected into the proxied noVNC page by the backend (see
// webui/src/proxy/viewer.ts, which rewrites the HTML response to add a
// <script src="/clipboard-sync.js"> tag). noVNC's own UI only ships a manual
// clipboard panel (open it, paste text in, click away to send; guest-copied
// text shows up there for you to copy out yourself) — this adds real
// two-way sync with the browser's actual OS clipboard, plan item #8.
//
// Served from a fixed top-level path (this file), but the page that loads
// it lives under a per-instance proxied prefix like /api/proxy/<id>/ — the
// noVNC UI module has to be located dynamically from that prefix, not
// imported with a literal specifier, since we don't know the instance id at
// build time. `location` here refers to the *document's* location (the
// iframe running this script), not this script's own URL, which is what
// makes that work.
(async () => {
  const prefix = location.pathname.replace(/[^/]*$/, '');

  let UI;
  try {
    ({ default: UI } = await import(prefix + 'app/ui.js'));
  } catch (err) {
    console.warn('[clipboard-sync] could not load noVNC UI module, sync disabled:', err);
    return;
  }

  // UI.rfb only exists once noVNC has actually connected (UI.connect()) —
  // could be immediate (autoconnect) or after a manual click, and it's
  // replaced/cleared across the reconnect-via-full-page-reload dockur/windows
  // itself already does on socket close (see InstanceDetail.tsx's comment on
  // the trailing slash) — a fresh page load re-runs this script fresh too,
  // so there's no need to handle an in-page rfb swap here.
  const rfb = await new Promise((resolve) => {
    const check = () => (UI.rfb ? resolve(UI.rfb) : setTimeout(check, 300));
    check();
  });

  // Guest copied something -> mirror it into the browser's own OS clipboard.
  rfb.addEventListener('clipboard', (e) => {
    navigator.clipboard.writeText(e.detail.text).catch(() => {
      // Expected if the iframe doesn't currently have focus/permission —
      // nothing actionable to do about it here.
    });
  });

  // Browser regained focus (e.g. clicking into the viewer) -> push whatever
  // is on the OS clipboard into the guest. Best-effort only: browsers
  // commonly restrict navigator.clipboard.readText() to genuine user-gesture
  // contexts, so this can silently no-op depending on browser/permission
  // state — there is no reliable fallback for that from inside a script.
  window.addEventListener('focus', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) rfb.clipboardPasteFrom(text);
    } catch {
      // No permission / browser restriction — same as above.
    }
  });
})();
