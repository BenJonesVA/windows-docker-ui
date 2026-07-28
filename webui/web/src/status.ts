import type { SandboxInstance } from './api';

export function formatMb(mb: number): string {
  return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`;
}

export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// Condensed uptime/age display ("2h 14m", "41m", "3d 2h") — used for the
// dashboard's Uptime column and the detail page's stopped-since note.
export function humanDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return `${s}s`;
}

export interface TimeRemaining {
  seconds: number;
  reason: 'idle' | 'lifetime';
  // False once the instance isn't actually running+ready — the reconciler
  // only reaps rows in that state (reconciler/index.ts reapIdleAndExpired),
  // so the figure is still the true deadline but nothing is currently
  // counting down toward it.
  armed: boolean;
}

// Mirrors reconciler/index.ts's reapIdleAndExpired precedence exactly
// (idle-timeout vs. max-lifetime, whichever fires first) so this can never
// show a number that doesn't match what will actually happen to the
// instance. maxLifetimeSeconds is the server-resolved instance ?? owner ??
// tier override (db/resourceTiers.ts resolveMaxLifetimeSeconds).
export function timeRemaining(
  instance: Pick<SandboxInstance, 'containerState' | 'phase' | 'createdAt' | 'startedAt' | 'lastSeenAt' | 'maxLifetimeSeconds'>,
  idleTimeoutSeconds: number,
  nowSeconds: number,
): TimeRemaining {
  const lifetimeRemaining = instance.createdAt + instance.maxLifetimeSeconds - nowSeconds;
  const armed = instance.containerState === 'running' && instance.phase === 'ready';
  if (!armed) return { seconds: lifetimeRemaining, reason: 'lifetime', armed };

  const lastActive = instance.lastSeenAt ?? instance.startedAt ?? instance.createdAt;
  const idleRemaining = lastActive + idleTimeoutSeconds - nowSeconds;
  return idleRemaining < lifetimeRemaining
    ? { seconds: idleRemaining, reason: 'idle', armed }
    : { seconds: lifetimeRemaining, reason: 'lifetime', armed };
}

export interface StatusMeta {
  label: string;
  className: string;
}

// Precedence mirrors the design: a failed/error state always wins, an
// in-progress install is the next most important thing to surface, then the
// plain container lifecycle state.
export function statusMeta(instance: Pick<SandboxInstance, 'containerState' | 'phase' | 'createdAt'>): StatusMeta {
  if (instance.containerState === 'error' || instance.phase === 'failed') {
    return { label: 'Error', className: 'vm-badge--error' };
  }
  if (instance.phase === 'installing') {
    const elapsed = Math.floor(Date.now() / 1000) - instance.createdAt;
    return { label: `Installing ${mmss(elapsed)}`, className: 'vm-badge--installing' };
  }
  if (instance.containerState === 'running') return { label: 'Running', className: 'vm-badge--running' };
  if (instance.containerState === 'exited') return { label: 'Exited', className: 'vm-badge--exited' };
  if (instance.containerState === 'created') return { label: 'Created', className: 'vm-badge--created' };
  return { label: 'Pending', className: 'vm-badge--pending' };
}

export type FilterKey = 'all' | 'running' | 'installing' | 'stopped' | 'error';

export function filterKey(instance: Pick<SandboxInstance, 'containerState' | 'phase'>): Exclude<FilterKey, 'all'> {
  if (instance.containerState === 'error' || instance.phase === 'failed') return 'error';
  if (instance.phase === 'installing') return 'installing';
  if (instance.containerState === 'running') return 'running';
  return 'stopped';
}

// Presentation-only display names for the real VERSION codes — always falls
// back to the raw code so a new entry in ALLOWED_WINDOWS_VERSIONS never
// renders blank.
const VERSION_LABELS: Record<string, string> = {
  '11': 'Windows 11',
  '11l': 'Windows 11 LTSC',
  '11e': 'Windows 11 Enterprise',
  '10': 'Windows 10',
  '10l': 'Windows 10 LTSC',
  '10e': 'Windows 10 Enterprise',
  '8e': 'Windows 8.1 Enterprise',
  '7u': 'Windows 7 Ultimate',
  vu: 'Windows Vista Ultimate',
  xp: 'Windows XP',
  '2k': 'Windows 2000',
  '2025': 'Windows Server 2025',
  '2022': 'Windows Server 2022',
  '2019': 'Windows Server 2019',
  '2016': 'Windows Server 2016',
  '2012': 'Windows Server 2012',
  '2008': 'Windows Server 2008',
  '2003': 'Windows Server 2003',
  core11: 'Windows 11 Core',
  tiny11: 'Tiny 11',
  tiny10: 'Tiny 10',
};

export function versionLabel(code: string): string {
  return VERSION_LABELS[code] ?? code;
}

// Grouping for the create-drawer version picker — 21 codes is too many for a
// flat list, so bucket them the way the upstream project documents them.
// Any real version not covered here (e.g. a future ALLOWED_WINDOWS_VERSIONS
// addition) still renders, just under "Other".
const VERSION_GROUPS: Array<{ label: string; codes: string[] }> = [
  { label: 'Windows 11', codes: ['11', '11l', '11e'] },
  { label: 'Windows 10', codes: ['10', '10l', '10e'] },
  { label: 'Server', codes: ['2025', '2022', '2019', '2016', '2012', '2008', '2003'] },
  { label: 'Legacy', codes: ['8e', '7u', 'vu', 'xp', '2k'] },
  { label: 'Lightweight', codes: ['core11', 'tiny11', 'tiny10'] },
];

export function groupVersions(versions: string[]): Array<{ label: string; codes: string[] }> {
  const known = new Set(VERSION_GROUPS.flatMap((g) => g.codes));
  const groups = VERSION_GROUPS.map((g) => ({ label: g.label, codes: g.codes.filter((c) => versions.includes(c)) })).filter(
    (g) => g.codes.length > 0,
  );
  const other = versions.filter((v) => !known.has(v));
  if (other.length > 0) groups.push({ label: 'Other', codes: other });
  return groups;
}
