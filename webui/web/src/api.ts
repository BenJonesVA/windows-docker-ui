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
  baseImage: string;
}

export interface RetainedVolume {
  instanceId: string;
  name: string;
  volumeName: string;
  deletedAt: number;
}

export interface InstanceStats {
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
}

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
  egressMode: 'open' | 'blocked' | 'allowlist';
  egressAllowlist: string[];
  maxUptimeOverrideSeconds: number | null;
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
  setEgressPolicy: (id: string, mode: 'open' | 'blocked' | 'allowlist', allowlist?: string[]) =>
    request<{ ok: true; egressMode: string; egressAllowlist: string[] }>(`/api/instances/${id}/egress`, {
      method: 'POST',
      body: JSON.stringify({ mode, allowlist }),
    }),
  deleteInstance: (id: string, retainDisk: boolean) =>
    request<{ ok: true }>(`/api/instances/${id}?retain_disk=${retainDisk}`, { method: 'DELETE' }),
  listRetainedVolumes: () => request<RetainedVolume[]>('/api/instances/retained-volumes'),
  purgeRetainedVolume: (instanceId: string) =>
    request<{ ok: true }>(`/api/instances/${instanceId}/volume`, { method: 'DELETE' }),
  openViewer: (id: string) =>
    request<{ ok: true; viewerUrl: string }>(`/api/instances/${id}/viewer-session`, { method: 'POST' }),
  getStats: (id: string) => request<InstanceStats>(`/api/instances/${id}/stats`),

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
};
