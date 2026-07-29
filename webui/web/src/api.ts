const BASE = ''; // same-origin in prod; Vite dev proxy handles /api in dev

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    // Only set Content-Type when there's actually a body — Fastify's default
    // JSON parser rejects an empty body under application/json with a 400,
    // which broke every no-body POST (start/stop/viewer-session).
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface Me {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

export interface InstanceMeta {
  versions: string[];
  diskMinByVersion: Record<string, number>;
  diskMaxGb: number;
  ramMinMb: number;
  ramMaxMb: number;
  cpuMinCores: number;
  cpuMaxCores: number;
  // Tier-wide idle-reap threshold — paired with a per-instance createdAt +
  // maxLifetimeSeconds, this is enough to compute the same "time remaining"
  // the reconciler enforces (reconciler/index.ts reapIdleAndExpired).
  idleTimeoutSeconds: number;
  baseImage: string;
}

export interface RetainedVolume {
  instanceId: string;
  name: string;
  volumeName: string;
  deletedAt: number;
}

export interface SharedFileEntry {
  name: string;
  size: number;
  mtimeSeconds: number;
}

export interface InstanceStats {
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
}

export interface ProcessEvent {
  id: string;
  instanceId: string;
  ts: number;
  event: 'start' | 'exit';
  pid: number;
  ppid: number | null;
  name: string;
  cmdline: string | null;
}

export interface FirewallRule {
  id: string;
  action: 'allow' | 'deny';
  protocol: 'tcp' | 'udp' | 'any';
  cidr: string;
  portFrom?: number;
  portTo?: number;
  label?: string;
}

export interface FirewallProfile {
  id: string;
  name: string;
  defaultAction: 'allow' | 'deny';
  rules: FirewallRule[];
  nodeLayout: Record<string, { x: number; y: number }>;
  createdAt: number;
  updatedAt: number;
}

export type FirewallProfileDraft = {
  name: string;
  defaultAction: 'allow' | 'deny';
  rules: FirewallRule[];
  nodeLayout?: Record<string, { x: number; y: number }>;
};

export type EgressPolicyInput =
  | { mode: 'open' }
  | { mode: 'blocked' }
  | { mode: 'allowlist'; allowlist: string[] }
  | { mode: 'profile'; firewallProfileId: string };

export interface SandboxInstance {
  id: string;
  name: string;
  windowsVersion: string;
  ramMb: number;
  cpuCores: number;
  diskGb: number;
  containerName: string;
  containerState: 'pending' | 'created' | 'running' | 'exited' | 'error';
  phase: 'installing' | 'ready' | 'failed';
  egressMode: 'open' | 'blocked' | 'allowlist' | 'profile';
  egressAllowlist: string[];
  firewallProfileId: string | null;
  maxUptimeOverrideSeconds: number | null;
  // Resolved instance-override ?? owner-override ?? tier-default (see
  // db/resourceTiers.ts resolveMaxLifetimeSeconds) — the actual seconds the
  // reconciler enforces from createdAt, not just this instance's own override.
  maxLifetimeSeconds: number;
  // Last activity through the viewer proxy (proxy/viewer.ts) — null until the
  // viewer's ever been opened, in which case the idle clock runs from
  // startedAt/createdAt instead (mirrors reconciler/index.ts's fallback).
  lastSeenAt: number | null;
  accountPassword: string | null;
  createdAt: number;
  startedAt: number | null;
  stoppedAt: number | null;
}

export interface AdminUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  createdAt: number;
  disabledAt: number | null;
  maxUptimeOverrideSeconds: number | null;
}

export interface AdminInstance extends SandboxInstance {
  ownerEmail: string;
}

export interface ResourceTier {
  id: string;
  name: string;
  ramMbMin: number;
  ramMbMax: number;
  cpuCoresMin: number;
  cpuCoresMax: number;
  diskGbMax: number;
  idleTimeoutSeconds: number;
  maxLifetimeSeconds: number;
  maxConcurrentInstances: number;
  maxAggregateRamMb: number;
  maxAggregateDiskGb: number;
}

export const api = {
  login: (email: string, password: string) =>
    request<Me>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<Me>('/api/auth/me'),
  getSetupStatus: () => request<{ needsSetup: boolean }>('/api/setup/status'),
  completeSetup: (email: string, password: string) =>
    request<Me>('/api/setup', { method: 'POST', body: JSON.stringify({ email, password }) }),

  getMeta: () => request<InstanceMeta>('/api/instances/meta'),
  listInstances: () => request<SandboxInstance[]>('/api/instances'),
  createInstance: (input: {
    name: string;
    windowsVersion: string;
    ramMb: number;
    cpuCores: number;
    diskGb: number;
  }) => request<SandboxInstance>('/api/instances', { method: 'POST', body: JSON.stringify(input) }),
  getInstance: (id: string) => request<SandboxInstance>(`/api/instances/${id}`),
  renameInstance: (id: string, name: string) =>
    request<SandboxInstance>(`/api/instances/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  startInstance: (id: string) => request<{ ok: true }>(`/api/instances/${id}/start`, { method: 'POST' }),
  stopInstance: (id: string) => request<{ ok: true }>(`/api/instances/${id}/stop`, { method: 'POST' }),
  setEgressPolicy: (id: string, input: EgressPolicyInput) =>
    request<{ ok: true; egressMode: string; egressAllowlist: string[]; firewallProfileId: string | null }>(
      `/api/instances/${id}/egress`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  listFirewallProfiles: () => request<FirewallProfile[]>('/api/firewall-profiles'),
  getFirewallProfile: (id: string) => request<FirewallProfile>(`/api/firewall-profiles/${id}`),
  createFirewallProfile: (input: FirewallProfileDraft) =>
    request<FirewallProfile>('/api/firewall-profiles', { method: 'POST', body: JSON.stringify(input) }),
  updateFirewallProfile: (id: string, input: FirewallProfileDraft) =>
    request<FirewallProfile>(`/api/firewall-profiles/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteFirewallProfile: (id: string) =>
    request<{ ok: true }>(`/api/firewall-profiles/${id}`, { method: 'DELETE' }),
  deleteInstance: (id: string, retainDisk: boolean) =>
    request<{ ok: true }>(`/api/instances/${id}?retain_disk=${retainDisk}`, { method: 'DELETE' }),
  listRetainedVolumes: () => request<RetainedVolume[]>('/api/instances/retained-volumes'),
  purgeRetainedVolume: (instanceId: string) =>
    request<{ ok: true }>(`/api/instances/${instanceId}/volume`, { method: 'DELETE' }),
  openViewer: (id: string) =>
    request<{ ok: true; viewerUrl: string }>(`/api/instances/${id}/viewer-session`, { method: 'POST' }),
  getStats: (id: string) => request<InstanceStats>(`/api/instances/${id}/stats`),
  // Plan item #13 — historical, so this reads fine whether the instance is
  // currently running or not (rows are already ingested off the guest by the
  // reconciler by the time they're queryable here).
  getProcesses: (id: string, limit = 200) => request<ProcessEvent[]>(`/api/instances/${id}/processes?limit=${limit}`),
  // Not a JSON request() call — this is consumed directly as an <img src>,
  // which sends the session cookie itself (same-origin) without needing a
  // fetch+blob-URL round trip. cacheBust just needs to change per request to
  // force a re-fetch instead of the browser reusing a cached image byte-for-byte.
  screenshotUrl: (id: string, cacheBust: number) => `/api/instances/${id}/screenshot?t=${cacheBust}`,

  // Plan item #9/#18 — file exchange via dockur/windows' own Samba /shared
  // folder. Works regardless of whether the instance is currently running
  // (the volume exists independently of the container).
  listFiles: (id: string) => request<SharedFileEntry[]>(`/api/instances/${id}/files`),
  uploadFile: async (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    // Not the shared request() helper — that always sets Content-Type:
    // application/json when a body is present, which would break the
    // multipart boundary the browser needs to set itself for FormData.
    const res = await fetch(`/api/instances/${id}/files`, { method: 'POST', credentials: 'include', body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error ?? `Upload failed: ${res.status}`);
    }
  },
  deleteFile: (id: string, filename: string) =>
    request<{ ok: true }>(`/api/instances/${id}/files/${encodeURIComponent(filename)}`, { method: 'DELETE' }),
  // Consumed as an <a href download> — same-origin cookie auth applies
  // automatically, same rationale as screenshotUrl above.
  downloadFileUrl: (id: string, filename: string) => `/api/instances/${id}/files/${encodeURIComponent(filename)}`,

  listAdminUsers: () => request<AdminUser[]>('/api/admin/users'),
  disableAdminUser: (id: string) => request<{ ok: true }>(`/api/admin/users/${id}/disable`, { method: 'POST' }),
  enableAdminUser: (id: string) => request<{ ok: true }>(`/api/admin/users/${id}/enable`, { method: 'POST' }),
  listAdminInstances: () => request<AdminInstance[]>('/api/admin/instances'),
  getResourceTier: () => request<ResourceTier>('/api/admin/resource-tier'),
  updateResourceTier: (input: Omit<ResourceTier, 'id' | 'name'>) =>
    request<ResourceTier>('/api/admin/resource-tier', { method: 'PUT', body: JSON.stringify(input) }),
  setMaxUptimeOverride: (instanceId: string, maxUptimeOverrideSeconds: number | null) =>
    request<{ ok: true }>(`/api/admin/instances/${instanceId}/max-uptime`, {
      method: 'POST',
      body: JSON.stringify({ maxUptimeOverrideSeconds }),
    }),
  setUserMaxUptimeOverride: (userId: string, maxUptimeOverrideSeconds: number | null) =>
    request<{ ok: true }>(`/api/admin/users/${userId}/max-uptime`, {
      method: 'POST',
      body: JSON.stringify({ maxUptimeOverrideSeconds }),
    }),
};
