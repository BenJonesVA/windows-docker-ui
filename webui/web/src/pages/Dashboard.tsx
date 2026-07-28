import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type SandboxInstance, type InstanceMeta, type RetainedVolume } from '../api';
import { CreateInstanceDrawer } from '../components/CreateInstanceDrawer';
import { filterKey, formatMb, humanDuration, statusMeta, versionLabel, type FilterKey } from '../status';

const FILTERS: Array<{ id: FilterKey; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'installing', label: 'Installing' },
  { id: 'stopped', label: 'Stopped' },
  { id: 'error', label: 'Error' },
];

function uptimeFor(instance: SandboxInstance): string {
  const now = Math.floor(Date.now() / 1000);
  if (instance.containerState === 'running' && instance.startedAt) {
    return humanDuration(now - instance.startedAt);
  }
  if (instance.containerState === 'exited' && instance.stoppedAt) {
    return `stopped ${humanDuration(now - instance.stoppedAt)} ago`;
  }
  return '—';
}

export function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const [instances, setInstances] = useState<SandboxInstance[]>([]);
  const [meta, setMeta] = useState<InstanceMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(() => Boolean((location.state as { openCreate?: boolean } | null)?.openCreate));
  const [filter, setFilter] = useState<FilterKey>('all');
  const [query, setQuery] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [retainedVolumes, setRetainedVolumes] = useState<RetainedVolume[]>([]);
  const [purgingId, setPurgingId] = useState<string | null>(null);
  const [showRetained, setShowRetained] = useState(false);

  async function refresh() {
    try {
      setInstances(await api.listInstances());
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to load instances');
    } finally {
      setLoading(false);
    }
  }

  async function refreshRetainedVolumes() {
    try {
      setRetainedVolumes(await api.listRetainedVolumes());
    } catch {
      // Housekeeping panel is secondary — a transient failure here shouldn't
      // block the main instance list from rendering.
    }
  }

  useEffect(() => {
    api.getMeta().then(setMeta);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    refreshRetainedVolumes();
  }, []);

  async function purgeVolume(volume: RetainedVolume) {
    setPurgingId(volume.instanceId);
    setBannerError(null);
    try {
      await api.purgeRetainedVolume(volume.instanceId);
      await refreshRetainedVolumes();
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to remove disk');
    } finally {
      setPurgingId(null);
    }
  }

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: instances.length, running: 0, installing: 0, stopped: 0, error: 0 };
    for (const i of instances) c[filterKey(i)]++;
    return c;
  }, [instances]);

  const visible = useMemo(
    () =>
      instances.filter(
        (i) => (filter === 'all' || filterKey(i) === filter) && i.name.toLowerCase().includes(query.toLowerCase()),
      ),
    [instances, filter, query],
  );

  async function toggleRun(instance: SandboxInstance) {
    setBusyId(instance.id);
    setBannerError(null);
    try {
      if (instance.containerState === 'running') await api.stopInstance(instance.id);
      else await api.startInstance(instance.id);
      await refresh();
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  async function saveRename(instance: SandboxInstance) {
    const trimmed = editDraft.trim();
    if (!trimmed) return;
    setBusyId(instance.id);
    setBannerError(null);
    try {
      await api.renameInstance(instance.id, trimmed);
      setEditingId(null);
      await refresh();
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Rename failed');
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete(instance: SandboxInstance) {
    setBusyId(instance.id);
    setBannerError(null);
    try {
      await api.deleteInstance(instance.id, false);
      setConfirmId(null);
      await refresh();
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="vm-page">
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.015em' }}>Instances</h1>
          <div className="vm-mono-dim" style={{ fontSize: 11.5, marginTop: 2 }}>
            {counts.all} total · {counts.running} running · {counts.installing} installing
          </div>
        </div>
        <div style={{ flex: 1 }} />
        {meta && (
          <button className="vm-btn vm-btn--primary" onClick={() => setShowCreate(true)}>
            <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>New instance
          </button>
        )}
      </div>

      {bannerError && (
        <div className="vm-banner">
          <span className="vm-error-text" style={{ fontWeight: 700 }}>
            !
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="vm-banner-title">Action failed</div>
            <div className="vm-banner-detail">{bannerError}</div>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <button className="vm-btn vm-btn--ghost vm-btn--sm" onClick={() => setBannerError(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="vm-filterbar">
        <div className="vm-segment">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={`vm-segment-btn ${filter === f.id ? 'vm-segment-btn--on' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              <span className="vm-segment-count">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <input
          className="vm-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter by name…"
          style={{ flex: 1, minWidth: 160, maxWidth: 260 }}
        />
        <div className="vm-live">
          <span className="vm-live-dot" />
          live · polling 5s
        </div>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : visible.length > 0 ? (
        <div className="vm-table">
          <div className="vm-table-head">
            <div>Name</div>
            <div>Status</div>
            <div>Image</div>
            <div>Resources</div>
            <div>Uptime</div>
            <div style={{ textAlign: 'right' }}>Actions</div>
          </div>
          {visible.map((inst) => {
            const m = statusMeta(inst);
            const running = inst.containerState === 'running';
            const busy = inst.phase === 'installing' || inst.containerState === 'error' || busyId === inst.id;
            return (
              <div className="vm-row" key={inst.id}>
                <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {editingId === inst.id ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input
                        className="vm-input"
                        style={{ padding: '3px 6px', fontSize: 12.5, width: 140 }}
                        value={editDraft}
                        autoFocus
                        maxLength={64}
                        disabled={busyId === inst.id}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveRename(inst);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                      />
                      <button
                        className="vm-btn vm-btn--ghost vm-btn--sm"
                        disabled={busyId === inst.id || !editDraft.trim()}
                        onClick={() => saveRename(inst)}
                      >
                        Save
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <button className="vm-row-name" onClick={() => navigate(`/instances/${inst.id}`)}>
                        {inst.name}
                      </button>
                      <button
                        className="vm-btn vm-btn--ghost vm-btn--sm"
                        title="Rename"
                        onClick={() => {
                          setEditDraft(inst.name);
                          setEditingId(inst.id);
                        }}
                      >
                        ✎
                      </button>
                    </div>
                  )}
                  <span className="vm-row-sub">{inst.containerName}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                  <span className={`vm-badge ${m.className}`}>
                    <span className="vm-badge-dot" />
                    {m.label}
                  </span>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {versionLabel(inst.windowsVersion)}
                  </div>
                  <div className="vm-mono-dim" style={{ fontSize: 10 }}>
                    {inst.windowsVersion}
                  </div>
                </div>
                <div className="vm-mono-dim">
                  {inst.cpuCores} vCPU · {formatMb(inst.ramMb)} · {inst.diskGb} GB
                </div>
                <div className="vm-mono-dim">{uptimeFor(inst)}</div>
                <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', alignItems: 'flex-start' }}>
                  {confirmId === inst.id ? (
                    <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 500 }}>Delete?</span>
                      <button
                        className="vm-btn vm-btn--sm"
                        style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)', color: 'var(--danger)' }}
                        disabled={busyId === inst.id}
                        onClick={() => confirmDelete(inst)}
                      >
                        Yes
                      </button>
                      <button className="vm-btn vm-btn--sm vm-btn--ghost" onClick={() => setConfirmId(null)}>
                        No
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        className="vm-btn vm-btn--sm vm-btn--secondary"
                        disabled={busy}
                        title={busy ? `Unavailable while ${m.label.toLowerCase()}` : running ? 'Stop container' : 'Start container'}
                        onClick={() => toggleRun(inst)}
                      >
                        {running ? 'Stop' : 'Start'}
                      </button>
                      <button
                        className="vm-btn vm-btn--sm vm-btn--secondary"
                        disabled={!running}
                        title={running ? 'Open remote viewer' : 'Viewer available when running'}
                        onClick={() => navigate(`/instances/${inst.id}`)}
                      >
                        Viewer
                      </button>
                      <button
                        className="vm-btn vm-btn--sm vm-btn--danger"
                        title="Delete"
                        onClick={() => setConfirmId(inst.id)}
                      >
                        Del
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="vm-empty">
          <div className="vm-empty-glyph" />
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 5 }}>
            {instances.length === 0 ? 'No instances yet' : 'No matches'}
          </div>
          <div style={{ color: 'var(--fg2)', fontSize: 12.5, maxWidth: 400, margin: '0 auto 16px' }}>
            {instances.length === 0
              ? 'Spin up an isolated Windows VM sandbox. First boot pulls the image and installs Windows, which can take several minutes.'
              : 'No instance matches this filter.'}
          </div>
          <button
            className="vm-btn vm-btn--primary"
            onClick={() => {
              if (instances.length === 0) setShowCreate(true);
              else {
                setFilter('all');
                setQuery('');
              }
            }}
          >
            {instances.length === 0 ? 'Create your first instance' : 'Clear filters'}
          </button>
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        <button
          className="vm-btn vm-btn--ghost vm-btn--sm"
          style={{ padding: 0, color: 'var(--fg3)' }}
          onClick={() => setShowRetained((v) => !v)}
        >
          {showRetained ? '▾' : '▸'} Retained disks{retainedVolumes.length > 0 ? ` (${retainedVolumes.length})` : ''}
        </button>
        {showRetained && (
          <div className="vm-panel" style={{ marginTop: 8 }}>
            <div style={{ padding: '8px 11px', fontSize: 12, color: 'var(--fg2)' }}>
              Disks kept from deleted instances (via "retain disk" on delete). These consume storage but aren't attached
              to anything — permanently remove them here to reclaim the space.
            </div>
            {retainedVolumes.length === 0 ? (
              <div style={{ padding: '4px 11px 11px', fontSize: 12, color: 'var(--fg3)' }}>None.</div>
            ) : (
              <div style={{ padding: '0 11px 9px' }}>
                {retainedVolumes.map((v) => (
                  <div className="vm-spec-row" key={v.instanceId}>
                    <span className="vm-spec-k">{v.name}</span>
                    <span className="vm-spec-v" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="vm-mono-dim" style={{ fontSize: 11 }}>
                        deleted {new Date(v.deletedAt * 1000).toLocaleDateString()}
                      </span>
                      <button
                        className="vm-btn vm-btn--ghost vm-btn--sm"
                        disabled={purgingId === v.instanceId}
                        onClick={() => purgeVolume(v)}
                      >
                        Delete disk
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {meta && (
          <div className="vm-mono-dim" style={{ fontSize: 10.5, marginTop: 10 }}>
            Base image: {meta.baseImage}
          </div>
        )}
      </div>

      {showCreate && meta && (
        <CreateInstanceDrawer
          meta={meta}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}
