import { useMemo, useState, type FormEvent } from 'react';
import { api, type InstanceMeta } from '../api';
import { formatMb, groupVersions, versionLabel } from '../status';

const RAM_STEPS_MB = [2048, 4096, 8192];
const CPU_STEPS = [1, 2, 4];
const DISK_STEPS_GB = [8, 16, 32, 64, 128];

type TierId = 'sm' | 'md' | 'lg' | 'custom';

const TIER_PRESETS: Array<{ id: TierId; label: string; cpu: number; ram: number; disk: number }> = [
  { id: 'sm', label: 'Small', cpu: 1, ram: 2048, disk: 8 },
  { id: 'md', label: 'Medium', cpu: 2, ram: 4096, disk: 32 },
  { id: 'lg', label: 'Large', cpu: 4, ram: 8192, disk: 64 },
];

// Checked against the real server-enforced bounds in InstanceMeta — never a
// hardcoded envelope — so a tier can only ever be offered as valid if the
// backend would actually accept it.
function tierInvalidReason(
  tier: { cpu: number; ram: number; disk: number },
  meta: InstanceMeta,
  windowsVersion: string,
): string | null {
  const minDisk = meta.diskMinByVersion[windowsVersion] ?? meta.diskMaxGb;
  if (tier.ram < meta.ramMinMb) return `needs ${formatMb(meta.ramMinMb)}+ RAM`;
  if (tier.ram > meta.ramMaxMb) return `over ${formatMb(meta.ramMaxMb)} cap`;
  if (tier.cpu < meta.cpuMinCores) return `needs ${meta.cpuMinCores}+ vCPU`;
  if (tier.cpu > meta.cpuMaxCores) return `over ${meta.cpuMaxCores} vCPU cap`;
  if (tier.disk < minDisk) return `needs ${minDisk} GB+ disk`;
  if (tier.disk > meta.diskMaxGb) return `over ${meta.diskMaxGb} GB cap`;
  return null;
}

function firstValidTier(meta: InstanceMeta, windowsVersion: string) {
  return TIER_PRESETS.find((t) => !tierInvalidReason(t, meta, windowsVersion)) ?? null;
}

export function CreateInstanceDrawer({
  meta,
  onClose,
  onCreated,
}: {
  meta: InstanceMeta;
  onClose: () => void;
  onCreated: () => void;
}) {
  const initialVersion = meta.versions[0];
  const initialTier = firstValidTier(meta, initialVersion);

  const [name, setName] = useState('');
  const [windowsVersion, setWindowsVersion] = useState(initialVersion);
  const [tier, setTier] = useState<TierId>(initialTier?.id ?? 'custom');
  const [cpuCores, setCpuCores] = useState(initialTier?.cpu ?? meta.cpuMinCores);
  const [ramMb, setRamMb] = useState(initialTier?.ram ?? meta.ramMinMb);
  const [diskGb, setDiskGb] = useState(initialTier?.disk ?? (meta.diskMinByVersion[initialVersion] ?? meta.diskMaxGb));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const versionGroups = useMemo(() => groupVersions(meta.versions), [meta.versions]);
  const minDiskForVersion = meta.diskMinByVersion[windowsVersion] ?? meta.diskMaxGb;

  function pickVersion(nextVersion: string) {
    const nextMinDisk = meta.diskMinByVersion[nextVersion] ?? meta.diskMaxGb;
    if (tier !== 'custom') {
      const current = TIER_PRESETS.find((t) => t.id === tier)!;
      if (!tierInvalidReason(current, meta, nextVersion)) {
        setWindowsVersion(nextVersion);
        return;
      }
      const fallback = firstValidTier(meta, nextVersion);
      setWindowsVersion(nextVersion);
      if (fallback) {
        setTier(fallback.id);
        setCpuCores(fallback.cpu);
        setRamMb(fallback.ram);
        setDiskGb(fallback.disk);
      } else {
        setTier('custom');
        setDiskGb(Math.max(diskGb, nextMinDisk));
      }
      return;
    }
    setWindowsVersion(nextVersion);
    setDiskGb((d) => Math.max(d, nextMinDisk));
  }

  function pickTier(t: (typeof TIER_PRESETS)[number]) {
    if (tierInvalidReason(t, meta, windowsVersion)) return;
    setTier(t.id);
    setCpuCores(t.cpu);
    setRamMb(t.ram);
    setDiskGb(t.disk);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.createInstance({ name, windowsVersion, ramMb, cpuCores, diskGb });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create instance');
    } finally {
      setCreating(false);
    }
  }

  const chipField = (
    key: 'cpuCores' | 'ramMb' | 'diskGb',
    label: string,
    steps: number[],
    value: number,
    setValue: (n: number) => void,
    fmt: (n: number) => string,
    min: number,
    max: number,
  ) => (
    <div style={{ display: 'grid', gap: 6 }} key={key}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--fg2)' }}>{label}</span>
        <span className="vm-mono-dim" style={{ marginLeft: 'auto', fontSize: 11 }}>
          allowed {fmt(min)}–{fmt(max)}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {steps.map((n) => {
          const disabled = n < min || n > max;
          const reason = disabled ? (n < min ? `below minimum` : `above maximum`) : '';
          return (
            <button
              key={n}
              type="button"
              disabled={disabled}
              title={reason}
              className={`vm-chip ${value === n ? 'vm-chip--on' : ''} ${disabled ? 'vm-chip--invalid' : ''}`}
              onClick={() => !disabled && setValue(n)}
            >
              {fmt(n)}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="vm-drawer-overlay">
      <div className="vm-drawer-scrim" onClick={onClose} />
      <div className="vm-drawer">
        <div className="vm-drawer-head">
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>New instance</div>
          </div>
          <div style={{ flex: 1 }} />
          <button className="vm-btn vm-btn--ghost vm-btn--sm" onClick={onClose} style={{ border: '1px solid var(--line)' }}>
            &#10005;
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'contents' }}>
          <div className="vm-drawer-body">
            <div className="vm-field">
              <span className="vm-section-label">1 · Name</span>
              <input className="vm-input" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span className="vm-section-label">2 · Windows image</span>
                <span style={{ fontSize: 11, color: 'var(--fg3)' }}>sets the resource envelope below</span>
              </div>
              <select
                className="vm-select"
                value={windowsVersion}
                onChange={(e) => pickVersion(e.target.value)}
              >
                {versionGroups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.codes.map((code) => (
                      <option key={code} value={code}>
                        {versionLabel(code)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span className="vm-section-label">3 · Resources</span>
                <span style={{ fontSize: 11, color: 'var(--fg2)' }}>
                  {versionLabel(windowsVersion)} allows {formatMb(meta.ramMinMb)}–{formatMb(meta.ramMaxMb)} RAM,{' '}
                  {meta.cpuMinCores}–{meta.cpuMaxCores} vCPU, {minDiskForVersion}–{meta.diskMaxGb} GB disk
                </span>
              </div>
              <div className="vm-tier-grid">
                {TIER_PRESETS.map((t) => {
                  const reason = tierInvalidReason(t, meta, windowsVersion);
                  return (
                    <button
                      type="button"
                      key={t.id}
                      disabled={!!reason}
                      title={reason ?? ''}
                      className={`vm-tier-card ${tier === t.id ? 'vm-tier-card--on' : ''}`}
                      onClick={() => pickTier(t)}
                    >
                      <div className="vm-tier-card-title">{t.label}</div>
                      <div className="vm-tier-card-meta">
                        {t.cpu} vCPU · {formatMb(t.ram)} · {t.disk} GB
                      </div>
                      {reason && <div className="vm-tier-card-reason">{reason}</div>}
                    </button>
                  );
                })}
                <button
                  type="button"
                  className={`vm-tier-card ${tier === 'custom' ? 'vm-tier-card--on' : ''}`}
                  onClick={() => setTier('custom')}
                >
                  <div className="vm-tier-card-title">Custom</div>
                  <div className="vm-tier-card-meta">pick your own</div>
                </button>
              </div>

              {tier === 'custom' && (
                <div style={{ border: '1px solid var(--line)', borderRadius: 6, background: 'var(--bg2)', padding: 12, display: 'grid', gap: 12, marginTop: 2 }}>
                  {chipField('cpuCores', 'vCPU', CPU_STEPS, cpuCores, setCpuCores, String, meta.cpuMinCores, meta.cpuMaxCores)}
                  {chipField('ramMb', 'Memory', RAM_STEPS_MB, ramMb, setRamMb, formatMb, meta.ramMinMb, meta.ramMaxMb)}
                  {chipField('diskGb', 'Disk', DISK_STEPS_GB, diskGb, setDiskGb, (n) => `${n} GB`, minDiskForVersion, meta.diskMaxGb)}
                </div>
              )}
            </div>

            <div className="vm-panel" style={{ background: 'var(--bg2)' }}>
              <div className="vm-panel-head">Resolved spec</div>
              <div style={{ padding: '9px 11px', display: 'grid', gap: 4 }}>
                {[
                  ['image', `dockur/windows:${windowsVersion}`],
                  ['name', name || '(unnamed)'],
                  ['vcpu', String(cpuCores)],
                  ['memory', formatMb(ramMb)],
                  ['disk', `${diskGb} GB`],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', gap: 10, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
                    <span style={{ color: 'var(--fg3)', width: 92, flex: 'none' }}>{k}</span>
                    <span>{v}</span>
                  </div>
                ))}
              </div>
            </div>

            {error && (
              <div className="vm-banner" style={{ marginBottom: 0 }}>
                <span className="vm-error-text" style={{ fontWeight: 700 }}>
                  !
                </span>
                <div className="vm-banner-detail" style={{ color: 'var(--fg)' }}>
                  {error}
                </div>
              </div>
            )}
          </div>

          <div className="vm-drawer-foot">
            <div style={{ flex: 1 }} />
            <button type="button" className="vm-btn vm-btn--secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="vm-btn vm-btn--primary" disabled={creating}>
              {creating ? 'Creating…' : 'Create instance'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
