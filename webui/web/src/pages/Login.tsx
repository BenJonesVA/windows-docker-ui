import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.login(email, password);
      onLogin();
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
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
          <div className="vm-login-heading">Sign in</div>
          <div className="vm-login-sub">Isolated Windows VMs on Docker</div>

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
                required
              />
            </label>
            <button type="submit" className="vm-btn vm-btn--primary" style={{ marginTop: 4, justifyContent: 'center' }}>
              Sign in
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
