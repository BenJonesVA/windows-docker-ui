import { useState, type ReactNode } from 'react';

// Reuses .vm-panel/.vm-panel-head/.vm-panel-body (style.css) — same look as
// every other panel, just with the head made clickable. Collapsed state is
// per-panel, in-memory only (resets on remount, same as Dashboard.tsx's
// "Retained disks" section) — not persisted across navigation or reloads.
// Doesn't own a body wrapper div itself — every existing panel already has
// its own (some `vm-panel-body`, some a bare div with inline padding), and
// forcing one shape here would mean re-wrapping all of them. Callers just
// pass their existing body markup as children.
export function CollapsiblePanel({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="vm-panel">
      <button
        type="button"
        className="vm-panel-head vm-panel-head--toggle"
        style={open ? undefined : { borderBottom: 'none' }}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>{title}</span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && children}
    </div>
  );
}
