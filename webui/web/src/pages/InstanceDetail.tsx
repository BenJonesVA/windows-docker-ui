import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, type SandboxInstance } from '../api';
import { formatMb, humanDuration, mmss, statusMeta, versionLabel } from '../status';
import { useInstanceLogs } from '../useInstanceLogs';

export function InstanceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [instance, setInstance] = useState<SandboxInstance | null>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [egressBusy, setEgressBusy] = useState(false);
  const [egressMode, setEgressMode] = useState<'open' | 'blocked' | 'allowlist'>('open');
  const [egressAllowlistText, setEgressAllowlistText] = useState('');
  const [egressInitialized, setEgressInitialized] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  async function refresh() {
    if (!id) return;
    try {
      setInstance(await api.getInstance(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load instance');
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Reset the draft on navigation to a different instance...
  useEffect(() => {
    setEgressInitialized(false);
  }, [id]);

  // ...then seed it from the server exactly once per instance. Not every
  // refresh() poll — that would blow away an in-progress edit the user
  // hasn't saved yet.
  useEffect(() => {
    if (!instance || egressInitialized) return;
    setEgressMode(instance.egressMode);
    setEgressAllowlistText(instance.egressAllowlist.join('\n'));
    setEgressInitialized(true);
  }, [instance, egressInitialized]);

  const ready = instance?.containerState === 'running' && instance.phase === 'ready';

  // Re-mint per instance — the cookie is scoped to Path=/api/proxy/<id>/, so
  // switching between two running instances needs a fresh mint each time.
  useEffect(() => {
    setViewerUrl(null);
    if (!id || !ready) return;
    api
      .openViewer(id)
      .then(({ viewerUrl }) => setViewerUrl(viewerUrl))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to open viewer'));
  }, [id, ready]);

  const installing = instance?.phase === 'installing';
  const logs = useInstanceLogs(id, installing);

  async function doAction(action: 'start' | 'stop' | 'delete') {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      if (action === 'start') await api.startInstance(id);
      else if (action === 'stop') await api.stopInstance(id);
      else {
        await api.deleteInstance(id, false);
        navigate('/');
        return;
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action}`);
    } finally {
      setBusy(false);
    }
  }

  const egressAllowlistDraft = egressAllowlistText
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const egressDirty =
    !!instance &&
    (egressMode !== instance.egressMode ||
      (egressMode === 'allowlist' &&
        egressAllowlistDraft.join(',') !== instance.egressAllowlist.join(',')));

  async function saveEgressPolicy() {
    if (!id) return;
    setEgressBusy(true);
    setError(null);
    try {
      await api.setEgressPolicy(id, egressMode, egressMode === 'allowlist' ? egressAllowlistDraft : undefined);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update egress policy');
    } finally {
      setEgressBusy(false);
    }
  }

  if (!instance) return <div className="vm-page">Loading…</div>;

  const m = statusMeta(instance);
  const running = instance.containerState === 'running';
  const errored = instance.containerState === 'error' || instance.phase === 'failed';
  const stopped = (instance.containerState === 'exited' || instance.containerState === 'created') && instance.phase === 'ready';
  const elapsed = installing ? Math.floor(Date.now() / 1000) - instance.createdAt : 0;

  return (
    <div className="vm-page" style={{ maxWidth: 'none' }}>
      <button className="vm-btn vm-btn--ghost" style={{ padding: 0, marginBottom: 12, fontFamily: 'var(--font-mono)', fontSize: 11.5 }} onClick={() => navigate('/')}>
        ← instances
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h1 style={{ fontFamily: 'var(--font-mono)', fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>{instance.name}</h1>
        <span className={`vm-badge ${m.className}`}>
          <span className="vm-badge-dot" />
          {m.label}
        </span>
        {error && <span className="vm-error-text">{error}</span>}
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="vm-btn vm-btn--secondary"
            disabled={busy || installing || errored}
            onClick={() => doAction(running ? 'stop' : 'start')}
          >
            {running ? 'Stop' : 'Start'}
          </button>
          {confirmingDelete ? (
            <>
              <button className="vm-btn vm-btn--danger" disabled={busy} onClick={() => doAction('delete')}>
                Confirm delete
              </button>
              <button className="vm-btn vm-btn--ghost" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="vm-btn vm-btn--danger" onClick={() => setConfirmingDelete(true)}>
              Delete
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 302px', gap: 16, alignItems: 'start' }}>
        <div className="vm-panel">
          <div className="vm-viewer-head">
            <span className="vm-section-label">Remote viewer · {instance.containerName}</span>
            <div style={{ flex: 1 }} />
            {ready && viewerUrl && (
              <button
                className="vm-btn vm-btn--ghost vm-btn--sm"
                style={{ border: '1px solid var(--line)' }}
                onClick={() => stageRef.current?.requestFullscreen()}
              >
                Fullscreen
              </button>
            )}
          </div>

          {ready && viewerUrl && (
            <div className="vm-viewer-stage" ref={stageRef}>
              {/* Trailing slash matters — dockur/windows' viewer JS derives its
                  WebSocket URL from window.location.pathname, so the iframe
                  must be loaded at the directory path, not a bare id. */}
              <iframe title="Sandbox viewer" src={viewerUrl} allow="clipboard-read; clipboard-write" />
            </div>
          )}

          {installing && (
            <div className="vm-viewer-stage" style={{ padding: 26, display: 'block' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4 }}>
                <span
                  style={{
                    width: 13,
                    height: 13,
                    border: '2px solid var(--line2)',
                    borderTopColor: 'var(--accent)',
                    borderRadius: '50%',
                    display: 'inline-block',
                    animation: 'spin .8s linear infinite',
                  }}
                />
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>Installing</span>
                <span className="vm-mono-dim" style={{ marginLeft: 'auto', fontSize: 11 }}>
                  {mmss(elapsed)} elapsed
                </span>
              </div>
              <div className="vm-log-box">
                {logs.length === 0 ? (
                  <div className="vm-log-line" style={{ color: 'var(--fg3)' }}>
                    waiting for container output…
                  </div>
                ) : (
                  logs.map((line, i) => (
                    <div className="vm-log-line" key={i}>
                      {line}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {errored && (
            <div className="vm-viewer-stage" style={{ padding: 26 }}>
              <div style={{ width: '100%', maxWidth: 440, textAlign: 'left' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--danger)', fontWeight: 600, fontSize: 13.5, marginBottom: 6 }}>
                  <span>!</span>Instance failed
                </div>
                <div style={{ color: 'var(--fg2)', fontSize: 12.5, marginBottom: 12 }}>
                  The container is in an error state. Check recent output below, or recreate the instance.
                </div>
                {logs.length > 0 && (
                  <div className="vm-log-box">
                    {logs.map((line, i) => (
                      <div className="vm-log-line" key={i}>
                        {line}
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 7, marginTop: 13 }}>
                  <button className="vm-btn vm-btn--primary" onClick={() => navigate('/', { state: { openCreate: true } })}>
                    Create new instance
                  </button>
                </div>
              </div>
            </div>
          )}

          {stopped && (
            <div className="vm-viewer-stage">
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>Instance is stopped</div>
                <div style={{ color: 'var(--fg3)', fontSize: 12, marginBottom: 14 }}>Disk is preserved.</div>
                <button className="vm-btn vm-btn--primary" disabled={busy} onClick={() => doAction('start')}>
                  Start instance
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          <div className="vm-panel">
            <div className="vm-panel-head">Specification</div>
            <div style={{ padding: '4px 11px 9px' }}>
              {[
                ['Image', versionLabel(instance.windowsVersion)],
                ['Version code', instance.windowsVersion],
                ['vCPU', String(instance.cpuCores)],
                ['Memory', formatMb(instance.ramMb)],
                ['Disk', `${instance.diskGb} GB`],
                ['Container', instance.containerName],
                ['State', instance.containerState],
                ['Phase', instance.phase],
                ['Created', new Date(instance.createdAt * 1000).toLocaleString()],
                ...(instance.startedAt && running
                  ? [['Uptime', humanDuration(Math.floor(Date.now() / 1000) - instance.startedAt)]]
                  : []),
              ].map(([k, v]) => (
                <div className="vm-spec-row" key={k}>
                  <span className="vm-spec-k">{k}</span>
                  <span className="vm-spec-v">{v}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="vm-panel">
            <div className="vm-panel-head">Access</div>
            <div className="vm-panel-body" style={{ display: 'grid', gap: 9 }}>
              <div style={{ fontSize: 12, color: 'var(--fg2)' }}>
                Clipboard passthrough is enabled between your browser and the guest. File transfer and RDP are not exposed —
                the viewer is the only path in.
              </div>
              <div className="vm-spec-row">
                <span className="vm-spec-k">Internet access</span>
                <span className="vm-spec-v">
                  Currently: {instance.egressMode === 'open' ? 'Open' : instance.egressMode === 'blocked' ? 'Blocked' : `Allowlist (${instance.egressAllowlist.length})`}
                </span>
              </div>
              <div style={{ display: 'grid', gap: 6 }}>
                <select
                  className="vm-select"
                  value={egressMode}
                  disabled={egressBusy || installing}
                  title={installing ? 'Changing egress during install would hang the Windows ISO fetch' : undefined}
                  onChange={(e) => setEgressMode(e.target.value as typeof egressMode)}
                >
                  <option value="open">Open — general internet allowed</option>
                  <option value="blocked">Blocked — all outbound traffic cut off</option>
                  <option value="allowlist">Allowlist — only listed CIDRs</option>
                </select>
                {egressMode === 'allowlist' && (
                  <textarea
                    className="vm-textarea"
                    rows={3}
                    placeholder={'One CIDR per line, e.g.\n8.8.8.8/32\n93.184.216.0/24'}
                    value={egressAllowlistText}
                    disabled={egressBusy || installing}
                    onChange={(e) => setEgressAllowlistText(e.target.value)}
                  />
                )}
                <div style={{ fontSize: 12, color: 'var(--fg2)' }}>
                  {egressMode === 'open' && 'Lateral traffic to other private networks (LAN, other sandboxes) is always blocked regardless of this setting.'}
                  {egressMode === 'blocked' && "All outbound network traffic from this instance is cut off. The viewer connection (browser to this instance, through the webui's own proxy) is unaffected."}
                  {egressMode === 'allowlist' && 'DNS is always allowed. Only traffic to the CIDRs above (plus DNS) can leave the instance; everything else is dropped.'}
                </div>
                <button
                  className="vm-btn vm-btn--secondary vm-btn--sm"
                  style={{ justifySelf: 'start' }}
                  disabled={egressBusy || installing || !egressDirty || (egressMode === 'allowlist' && egressAllowlistDraft.length === 0)}
                  onClick={saveEgressPolicy}
                >
                  Save
                </button>
              </div>
              {instance.accountPassword && (
                <>
                  <div className="vm-spec-row">
                    <span className="vm-spec-k">Username</span>
                    <span className="vm-spec-v" style={{ fontFamily: 'var(--font-mono)' }}>Docker</span>
                  </div>
                  <div className="vm-spec-row">
                    <span className="vm-spec-k">Password</span>
                    <span className="vm-spec-v" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <code style={{ fontFamily: 'var(--font-mono)' }}>
                        {passwordVisible ? instance.accountPassword : '••••••••••••'}
                      </code>
                      <button
                        className="vm-btn vm-btn--ghost vm-btn--sm"
                        onClick={() => setPasswordVisible((v) => !v)}
                      >
                        {passwordVisible ? 'Hide' : 'Show'}
                      </button>
                      <button
                        className="vm-btn vm-btn--ghost vm-btn--sm"
                        onClick={() => navigator.clipboard.writeText(instance.accountPassword!)}
                      >
                        Copy
                      </button>
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
