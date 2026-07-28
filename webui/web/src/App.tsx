import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { api, type Me, type SandboxInstance } from './api';
import { applyTheme, getStoredTheme, type Theme } from './theme';
import { statusMeta } from './status';
import { Login } from './pages/Login';
import { Setup } from './pages/Setup';
import { Dashboard } from './pages/Dashboard';
import { InstanceDetail } from './pages/InstanceDetail';

// Suffix of statusMeta's badge className ("vm-badge--running" -> "running")
// doubles as the nav dot's modifier — one status vocabulary, two renderings.
function navDotClass(badgeClassName: string): string {
  return `vm-nav-dot ${badgeClassName.replace('vm-badge--', 'vm-nav-dot--')}`;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const [navInstances, setNavInstances] = useState<SandboxInstance[]>([]);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setChecked(true));
  }, []);

  // Only matters pre-login — a logged-in session means setup already
  // happened (there's at least one user: whoever is logged in). Checked
  // alongside `me` rather than only once !me is known, so the Setup/Login
  // decision resolves before the unauthenticated screen ever paints — this
  // is what avoids a Login flash on a truly fresh deploy.
  useEffect(() => {
    if (me) return;
    api
      .getSetupStatus()
      .then((s) => setNeedsSetup(s.needsSetup))
      .catch(() => setNeedsSetup(false));
  }, [me]);

  // Polled independently of the Dashboard's own list — this needs to render
  // on every route (including InstanceDetail, where Dashboard isn't mounted
  // at all), not just while the Dashboard page happens to be open.
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    async function poll() {
      try {
        const rows = await api.listInstances();
        if (!cancelled) setNavInstances(rows);
      } catch {
        // Sidebar list is a convenience, not the source of truth — a
        // transient failure here shouldn't surface a banner; Dashboard's own
        // fetch already reports load errors when the user is on that page.
      }
    }
    poll();
    const interval = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [me]);

  if (!checked || (!me && needsSetup === null)) return null;

  if (!me) {
    if (needsSetup) {
      return <Setup onComplete={() => api.me().then(setMe)} />;
    }
    return <Login onLogin={() => api.me().then(setMe)} />;
  }

  const initials = me.email.slice(0, 2).toUpperCase();

  return (
    <div className="vm-shell">
      <aside className="vm-sidebar">
        <div className="vm-sidebar-brand">
          <div className="vm-logo">S</div>
          <div className="vm-sidebar-title">Sandbox</div>
        </div>
        <div className="vm-nav">
          <button className="vm-nav-item" onClick={() => navigate('/')}>
            <span className="vm-nav-glyph">&#9636;</span>
            Instances
            {navInstances.length > 0 && <span className="vm-nav-count">{navInstances.length}</span>}
          </button>
          <div className="vm-nav-instances">
            {navInstances.length === 0 ? (
              <div className="vm-nav-empty">No instances yet</div>
            ) : (
              navInstances.map((inst) => {
                const m = statusMeta(inst);
                const active = location.pathname === `/instances/${inst.id}`;
                return (
                  <button
                    key={inst.id}
                    className={`vm-nav-instance ${active ? 'vm-nav-instance--active' : ''}`}
                    title={`${inst.name} — ${m.label}`}
                    onClick={() => navigate(`/instances/${inst.id}`)}
                  >
                    <span className={navDotClass(m.className)} />
                    <span className="vm-nav-instance-name">{inst.name}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
        <div className="vm-sidebar-spacer" />
        <div className="vm-sidebar-user">
          <div className="vm-avatar">{initials}</div>
          <div style={{ minWidth: 0 }}>
            <div className="vm-user-email">{me.email}</div>
          </div>
          <button
            className="vm-signout"
            title="Sign out"
            onClick={async () => {
              await api.logout();
              setMe(null);
            }}
          >
            &#9211;
          </button>
        </div>
      </aside>

      <div>
        <div className="vm-topbar">
          <div className="vm-topbar-spacer" />
          <button
            className="vm-theme-toggle"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? '☾ Dark' : '☀ Light'}
          </button>
        </div>
        <main className="vm-main">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/instances/:id" element={<InstanceDetail />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
