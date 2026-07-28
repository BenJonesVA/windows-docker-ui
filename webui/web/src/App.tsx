import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { api, type Me } from './api';
import { applyTheme, getStoredTheme, type Theme } from './theme';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { InstanceDetail } from './pages/InstanceDetail';

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const navigate = useNavigate();

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

  if (!checked) return null;

  if (!me) {
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
          </button>
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
