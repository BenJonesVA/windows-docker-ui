import { useEffect, useState } from 'react';
import { api, type AdminUser, type AdminInstance, type Me, type ResourceTier } from '../api';
import { statusMeta, formatMb, versionLabel, humanDuration } from '../status';

const TIER_FIELDS: Array<{ key: keyof Omit<ResourceTier, 'id' | 'name'>; label: string }> = [
  { key: 'ramMbMin', label: 'RAM min (MB)' },
  { key: 'ramMbMax', label: 'RAM max (MB)' },
  { key: 'cpuCoresMin', label: 'vCPU min' },
  { key: 'cpuCoresMax', label: 'vCPU max' },
  { key: 'diskGbMax', label: 'Disk max (GB)' },
  { key: 'idleTimeoutSeconds', label: 'Idle timeout (seconds)' },
  { key: 'maxLifetimeSeconds', label: 'Max lifetime (seconds)' },
];

// Plan item #6 — user management and admin-wide instance visibility, plus
// (plan item #14) the resource tier that replaces the old hardcoded bounds/
// timeouts. Still just ONE tier (see db/resourceTiers.ts) — a real multi-tier
// picker at instance-create time is bigger scope, not built here.
export function Admin({ me }: { me: Me }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [instances, setInstances] = useState<AdminInstance[]>([]);
  const [tier, setTier] = useState<ResourceTier | null>(null);
  const [tierDraft, setTierDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tierBusy, setTierBusy] = useState(false);
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});
  const [overrideBusyId, setOverrideBusyId] = useState<string | null>(null);

  async function refresh() {
    try {
      const [u, i, t] = await Promise.all([api.listAdminUsers(), api.listAdminInstances(), api.getResourceTier()]);
      setUsers(u);
      setInstances(i);
      setTier(t);
      setTierDraft((prev) => (Object.keys(prev).length > 0 ? prev : Object.fromEntries(TIER_FIELDS.map((f) => [f.key, String(t[f.key])]))));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admin data');
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function saveTier() {
    setTierBusy(true);
    setError(null);
    try {
      const input = Object.fromEntries(TIER_FIELDS.map((f) => [f.key, Number(tierDraft[f.key])])) as Omit<
        ResourceTier,
        'id' | 'name'
      >;
      const updated = await api.updateResourceTier(input);
      setTier(updated);
      setTierDraft(Object.fromEntries(TIER_FIELDS.map((f) => [f.key, String(updated[f.key])])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update resource tier');
    } finally {
      setTierBusy(false);
    }
  }

  async function setOverride(instanceId: string, seconds: number | null) {
    setOverrideBusyId(instanceId);
    setError(null);
    try {
      await api.setMaxUptimeOverride(instanceId, seconds);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update max-uptime override');
    } finally {
      setOverrideBusyId(null);
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

      <div className="vm-panel" style={{ marginBottom: 16 }}>
        <div className="vm-panel-head">Resource tier</div>
        <div style={{ padding: '9px 11px 11px' }}>
          <div style={{ fontSize: 12, color: 'var(--fg2)', marginBottom: 10 }}>
            Applies to every new instance's create-time bounds and to the reconciler's idle/lifetime reaping. One tier
            today — a per-instance/per-user tier picker is future work.
          </div>
          {!tier ? (
            <div style={{ fontSize: 12, color: 'var(--fg3)' }}>Loading…</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
                {TIER_FIELDS.map((f) => (
                  <label className="vm-field" key={f.key}>
                    <span className="vm-label">{f.label}</span>
                    <input
                      className="vm-input"
                      type="number"
                      min={1}
                      value={tierDraft[f.key] ?? ''}
                      disabled={tierBusy}
                      onChange={(e) => setTierDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
              <button className="vm-btn vm-btn--primary vm-btn--sm" style={{ marginTop: 10 }} disabled={tierBusy} onClick={saveTier}>
                Save tier
              </button>
            </>
          )}
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
                <div className="vm-spec-row" key={inst.id} style={{ alignItems: 'flex-start' }}>
                  <span className="vm-spec-k" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span>{inst.name}</span>
                    <span className="vm-mono-dim" style={{ fontSize: 10 }}>{inst.ownerEmail}</span>
                  </span>
                  <span className="vm-spec-v" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`vm-badge ${m.className}`}>
                        <span className="vm-badge-dot" />
                        {m.label}
                      </span>
                      <span className="vm-mono-dim" style={{ fontSize: 11 }}>
                        {versionLabel(inst.windowsVersion)} · {inst.cpuCores} vCPU · {formatMb(inst.ramMb)}
                      </span>
                    </span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className="vm-mono-dim" style={{ fontSize: 10.5 }}>
                        max uptime:{' '}
                        {inst.maxUptimeOverrideSeconds != null ? `override ${humanDuration(inst.maxUptimeOverrideSeconds)}` : 'tier default'}
                      </span>
                      <input
                        className="vm-input"
                        style={{ width: 70, padding: '3px 6px', fontSize: 11 }}
                        type="number"
                        min={1}
                        placeholder="hours"
                        value={overrideDrafts[inst.id] ?? ''}
                        disabled={overrideBusyId === inst.id}
                        onChange={(e) => setOverrideDrafts((d) => ({ ...d, [inst.id]: e.target.value }))}
                      />
                      <button
                        className="vm-btn vm-btn--ghost vm-btn--sm"
                        disabled={overrideBusyId === inst.id || !overrideDrafts[inst.id]}
                        onClick={() => setOverride(inst.id, Math.round(Number(overrideDrafts[inst.id]) * 3600))}
                      >
                        Set
                      </button>
                      {inst.maxUptimeOverrideSeconds != null && (
                        <button
                          className="vm-btn vm-btn--ghost vm-btn--sm"
                          disabled={overrideBusyId === inst.id}
                          onClick={() => setOverride(inst.id, null)}
                        >
                          Clear
                        </button>
                      )}
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
