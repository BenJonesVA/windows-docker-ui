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
  { key: 'maxLifetimeSeconds', label: 'Max uptime — global default (seconds)' },
  { key: 'maxConcurrentInstances', label: 'Max concurrent instances / user' },
  { key: 'maxAggregateRamMb', label: 'Max aggregate RAM / user (MB)' },
  { key: 'maxAggregateDiskGb', label: 'Max aggregate disk / user (GB)' },
];

// Small inline "set/clear a max-uptime override" control, shared shape
// between the per-user row and the per-instance row below — same three
// pieces of state (current value, draft hours, busy flag), just pointed at
// a different id and a different API call.
function UptimeOverrideControl({
  currentSeconds,
  draftHours,
  busy,
  onDraftChange,
  onSet,
  onClear,
}: {
  currentSeconds: number | null;
  draftHours: string;
  busy: boolean;
  onDraftChange: (v: string) => void;
  onSet: () => void;
  onClear: () => void;
}) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span className="vm-mono-dim" style={{ fontSize: 10.5 }}>
        max uptime: {currentSeconds != null ? `override ${humanDuration(currentSeconds)}` : 'default'}
      </span>
      <input
        className="vm-input"
        style={{ width: 64, padding: '3px 6px', fontSize: 11 }}
        type="number"
        min={1}
        placeholder="hours"
        value={draftHours}
        disabled={busy}
        onChange={(e) => onDraftChange(e.target.value)}
      />
      <button className="vm-btn vm-btn--ghost vm-btn--sm" disabled={busy || !draftHours} onClick={onSet}>
        Set
      </button>
      {currentSeconds != null && (
        <button className="vm-btn vm-btn--ghost vm-btn--sm" disabled={busy} onClick={onClear}>
          Clear
        </button>
      )}
    </span>
  );
}

// Plan item #6 — user management and admin-wide instance visibility, plus
// (plan item #14) the resource tier that replaces the old hardcoded bounds/
// timeouts, and (plan #14 follow-up) a per-user max-uptime default that sits
// between the tier's global default and a single instance's own override.
// Precedence: instance override > user override > tier default (see
// reconciler/index.ts reapIdleAndExpired). Still just ONE tier (see
// db/resourceTiers.ts) — a real multi-tier picker at instance-create time is
// bigger scope, not built here.
export function Admin({ me }: { me: Me }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [instances, setInstances] = useState<AdminInstance[]>([]);
  const [tier, setTier] = useState<ResourceTier | null>(null);
  const [tierDraft, setTierDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tierBusy, setTierBusy] = useState(false);
  const [instanceOverrideDrafts, setInstanceOverrideDrafts] = useState<Record<string, string>>({});
  const [instanceOverrideBusyId, setInstanceOverrideBusyId] = useState<string | null>(null);
  const [userOverrideDrafts, setUserOverrideDrafts] = useState<Record<string, string>>({});
  const [userOverrideBusyId, setUserOverrideBusyId] = useState<string | null>(null);

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

  async function toggleUser(user: AdminUser) {
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

  async function setInstanceOverride(instanceId: string, seconds: number | null) {
    setInstanceOverrideBusyId(instanceId);
    setError(null);
    try {
      await api.setMaxUptimeOverride(instanceId, seconds);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update max-uptime override');
    } finally {
      setInstanceOverrideBusyId(null);
    }
  }

  async function setUserOverride(userId: string, seconds: number | null) {
    setUserOverrideBusyId(userId);
    setError(null);
    try {
      await api.setUserMaxUptimeOverride(userId, seconds);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user max-uptime override');
    } finally {
      setUserOverrideBusyId(null);
    }
  }

  return (
    <div className="vm-page">
      <h1 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.015em', marginBottom: 16 }}>Admin</h1>
      {error && <div className="vm-error-text" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="vm-panel" style={{ marginBottom: 16 }}>
        <div className="vm-panel-head">Users ({users.length})</div>
        <div style={{ padding: '2px 11px 4px' }}>
          {users.map((u) => (
            <div className="vm-admin-row" key={u.id}>
              <span className="vm-admin-row-main">
                <span>{u.email}</span>
                {u.role === 'admin' && (
                  <span className="vm-badge vm-badge--created" style={{ fontSize: 9.5, padding: '1px 6px', flex: 'none' }}>
                    admin
                  </span>
                )}
                {u.id === me.id && (
                  <span className="vm-mono-dim" style={{ fontSize: 10, flex: 'none' }}>
                    (you)
                  </span>
                )}
              </span>
              <span className="vm-admin-row-side">
                <span className="vm-mono-dim" style={{ fontSize: 11 }}>
                  {u.disabledAt ? 'disabled' : 'active'} · joined {new Date(u.createdAt * 1000).toLocaleDateString()}
                </span>
                <UptimeOverrideControl
                  currentSeconds={u.maxUptimeOverrideSeconds}
                  draftHours={userOverrideDrafts[u.id] ?? ''}
                  busy={userOverrideBusyId === u.id}
                  onDraftChange={(v) => setUserOverrideDrafts((d) => ({ ...d, [u.id]: v }))}
                  onSet={() => setUserOverride(u.id, Math.round(Number(userOverrideDrafts[u.id]) * 3600))}
                  onClear={() => setUserOverride(u.id, null)}
                />
                <button
                  className="vm-btn vm-btn--ghost vm-btn--sm"
                  disabled={busyId === u.id || u.id === me.id}
                  title={u.id === me.id ? "Can't disable your own account" : undefined}
                  onClick={() => toggleUser(u)}
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
            Applies to every new instance's create-time bounds, the reconciler's idle/lifetime reaping, and each user's
            concurrent-instance/aggregate RAM+disk quotas. "Max uptime — global default" is the fallback used whenever
            neither a user nor an instance has its own override set below. One tier today — a per-instance/per-user
            tier picker is future work.
          </div>
          {!tier ? (
            <div style={{ fontSize: 12, color: 'var(--fg3)' }}>Loading…</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
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
        <div style={{ padding: '2px 11px 4px' }}>
          {instances.length === 0 ? (
            <div style={{ padding: '6px 0', fontSize: 12, color: 'var(--fg3)' }}>None.</div>
          ) : (
            instances.map((inst) => {
              const m = statusMeta(inst);
              return (
                <div className="vm-admin-row" key={inst.id}>
                  <span className="vm-admin-row-main" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
                    <span>{inst.name}</span>
                    <span className="vm-mono-dim" style={{ fontSize: 10 }}>
                      {inst.ownerEmail}
                    </span>
                  </span>
                  <span className="vm-admin-row-side" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <span className={`vm-badge ${m.className}`}>
                      <span className="vm-badge-dot" />
                      {m.label}
                    </span>
                    <span className="vm-mono-dim" style={{ fontSize: 11 }}>
                      {versionLabel(inst.windowsVersion)} · {inst.cpuCores} vCPU · {formatMb(inst.ramMb)}
                    </span>
                    <UptimeOverrideControl
                      currentSeconds={inst.maxUptimeOverrideSeconds}
                      draftHours={instanceOverrideDrafts[inst.id] ?? ''}
                      busy={instanceOverrideBusyId === inst.id}
                      onDraftChange={(v) => setInstanceOverrideDrafts((d) => ({ ...d, [inst.id]: v }))}
                      onSet={() => setInstanceOverride(inst.id, Math.round(Number(instanceOverrideDrafts[inst.id]) * 3600))}
                      onClear={() => setInstanceOverride(inst.id, null)}
                    />
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
