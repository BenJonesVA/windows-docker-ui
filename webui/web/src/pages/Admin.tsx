import { useEffect, useState } from 'react';
import { api, type AdminUser, type AdminInstance, type Me } from '../api';
import { statusMeta, formatMb, versionLabel } from '../status';

// Plan item #6 — user management and admin-wide instance visibility only.
// Resource-tier editing (RAM/CPU/disk bounds, idle/lifetime timeouts) is
// plan item #14, a separate DB table this doesn't touch.
export function Admin({ me }: { me: Me }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [instances, setInstances] = useState<AdminInstance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    try {
      const [u, i] = await Promise.all([api.listAdminUsers(), api.listAdminInstances()]);
      setUsers(u);
      setInstances(i);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admin data');
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, []);

  async function toggle(user: AdminUser) {
    setBusyId(user.id);
    setError(null);
    try {
      if (user.disabledAt) await api.enableAdminUser(user.id);
      else await api.disableAdminUser(user.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="vm-page">
      <h1 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.015em', marginBottom: 16 }}>Admin</h1>
      {error && <div className="vm-error-text" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="vm-panel" style={{ marginBottom: 16 }}>
        <div className="vm-panel-head">Users ({users.length})</div>
        <div style={{ padding: '4px 11px 9px' }}>
          {users.map((u) => (
            <div className="vm-spec-row" key={u.id}>
              <span className="vm-spec-k" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {u.email}
                {u.role === 'admin' && (
                  <span className="vm-badge vm-badge--created" style={{ fontSize: 9.5, padding: '1px 6px' }}>
                    admin
                  </span>
                )}
                {u.id === me.id && <span className="vm-mono-dim" style={{ fontSize: 10 }}>(you)</span>}
              </span>
              <span className="vm-spec-v" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="vm-mono-dim" style={{ fontSize: 11 }}>
                  {u.disabledAt ? 'disabled' : 'active'} · joined {new Date(u.createdAt * 1000).toLocaleDateString()}
                </span>
                <button
                  className="vm-btn vm-btn--ghost vm-btn--sm"
                  disabled={busyId === u.id || u.id === me.id}
                  title={u.id === me.id ? "Can't disable your own account" : undefined}
                  onClick={() => toggle(u)}
                >
                  {u.disabledAt ? 'Enable' : 'Disable'}
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="vm-panel">
        <div className="vm-panel-head">All instances ({instances.length})</div>
        <div style={{ padding: '4px 11px 9px' }}>
          {instances.length === 0 ? (
            <div style={{ padding: '4px 0', fontSize: 12, color: 'var(--fg3)' }}>None.</div>
          ) : (
            instances.map((inst) => {
              const m = statusMeta(inst);
              return (
                <div className="vm-spec-row" key={inst.id}>
                  <span className="vm-spec-k" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span>{inst.name}</span>
                    <span className="vm-mono-dim" style={{ fontSize: 10 }}>{inst.ownerEmail}</span>
                  </span>
                  <span className="vm-spec-v" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className={`vm-badge ${m.className}`}>
                      <span className="vm-badge-dot" />
                      {m.label}
                    </span>
                    <span className="vm-mono-dim" style={{ fontSize: 11 }}>
                      {versionLabel(inst.windowsVersion)} · {inst.cpuCores} vCPU · {formatMb(inst.ramMb)}
                    </span>
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
