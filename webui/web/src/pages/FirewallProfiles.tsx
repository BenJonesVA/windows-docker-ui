import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type FirewallProfile } from '../api';

export function FirewallProfiles() {
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState<FirewallProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    try {
      setProfiles(await api.listFirewallProfiles());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load firewall profiles');
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function doDelete(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api.deleteFirewallProfile(id);
      setConfirmingDeleteId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete profile');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="vm-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <h1 style={{ fontFamily: 'var(--font-mono)', fontSize: 17, fontWeight: 600 }}>Firewall profiles</h1>
        {error && <span className="vm-error-text">{error}</span>}
        <div style={{ flex: 1 }} />
        <button className="vm-btn vm-btn--primary" onClick={() => navigate('/firewall-profiles/new')}>
          + New profile
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--fg2)', marginBottom: 14 }}>
        A saved, reusable egress policy you can assign to any of your sandbox instances from its Access panel. Edits here
        apply immediately to every instance currently assigned the profile.
      </div>

      {!profiles ? (
        <div className="vm-panel">
          <div className="vm-fw-empty">Loading…</div>
        </div>
      ) : profiles.length === 0 ? (
        <div className="vm-panel">
          <div className="vm-fw-empty">No firewall profiles yet. Create one to start building a reusable egress policy.</div>
        </div>
      ) : (
        <div className="vm-fw-list">
          {profiles.map((p) => (
            <div className="vm-fw-card" key={p.id}>
              <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => navigate(`/firewall-profiles/${p.id}`)}>
                <div className="vm-fw-card-name">{p.name}</div>
                <div className="vm-fw-card-meta">
                  {p.rules.length} rule{p.rules.length === 1 ? '' : 's'} · default {p.defaultAction === 'allow' ? 'allow' : 'block'} ·
                  updated {new Date(p.updatedAt * 1000).toLocaleString()}
                </div>
              </div>
              {confirmingDeleteId === p.id ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="vm-btn vm-btn--danger vm-btn--sm" disabled={busyId === p.id} onClick={() => doDelete(p.id)}>
                    Confirm delete
                  </button>
                  <button className="vm-btn vm-btn--ghost vm-btn--sm" onClick={() => setConfirmingDeleteId(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="vm-btn vm-btn--secondary vm-btn--sm" onClick={() => navigate(`/firewall-profiles/${p.id}`)}>
                    Edit
                  </button>
                  <button className="vm-btn vm-btn--danger vm-btn--sm" onClick={() => setConfirmingDeleteId(p.id)}>
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
