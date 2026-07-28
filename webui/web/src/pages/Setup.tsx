import { useState, type FormEvent } from 'react';
import { api } from '../api';

// Plan item #5 — shown only when GET /api/setup/status reports no users
// exist yet (see App.tsx). Same shell as Login (vm-login-*) since this
// replaces the login screen for exactly one visit, not a distinct flow.
export function Setup({ onComplete }: { onComplete: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.completeSetup(email, password);
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vm-login-wrap">
      <div className="vm-login-box">
        <div className="vm-login-brand">
          <div className="vm-logo">S</div>
          <div className="vm-login-title">Sandbox Console</div>
        </div>
        <div className="vm-login-card">
          <div className="vm-login-heading">Create admin account</div>
          <div className="vm-login-sub">First-time setup — this becomes the first administrator.</div>

          {error && (
            <div className="vm-login-error">
              <span className="vm-error-text" style={{ fontWeight: 600 }}>
                !
              </span>
              <div style={{ fontWeight: 500 }}>{error}</div>
            </div>
          )}

          <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 12 }}>
            <label className="vm-field">
              <span className="vm-label">Email</span>
              <input
                className="vm-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                required
              />
            </label>
            <label className="vm-field">
              <span className="vm-label">Password</span>
              <input
                className="vm-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                minLength={8}
                required
              />
            </label>
            <label className="vm-field">
              <span className="vm-label">Confirm password</span>
              <input
                className="vm-input"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={busy}
                minLength={8}
                required
              />
            </label>
            <button
              type="submit"
              className="vm-btn vm-btn--primary"
              style={{ marginTop: 4, justifyContent: 'center' }}
              disabled={busy}
            >
              Create account
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
