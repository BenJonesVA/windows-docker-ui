import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  disabledAt: integer('disabled_at'),
});

// Plan item #14 — admin-editable replacement for the constants that used to
// be hardcoded in reconciler/index.ts and docker/validators.ts. A true
// multi-tier system (several rows, a tier assigned per instance or per user)
// is bigger scope than this pass covers — deliberately not built yet, since
// that needs its own design pass (which tier a user picks, whether users are
// restricted to specific tiers). For now this table only ever holds one row;
// `db/resourceTiers.ts`'s getActiveTier() lazily seeds it with today's
// existing hardcoded values on first read, so behavior is unchanged until an
// admin actually edits it.
export const resourceTiers = sqliteTable('resource_tiers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ramMbMin: integer('ram_mb_min').notNull(),
  ramMbMax: integer('ram_mb_max').notNull(),
  cpuCoresMin: integer('cpu_cores_min').notNull(),
  cpuCoresMax: integer('cpu_cores_max').notNull(),
  diskGbMax: integer('disk_gb_max').notNull(),
  idleTimeoutSeconds: integer('idle_timeout_seconds').notNull(),
  maxLifetimeSeconds: integer('max_lifetime_seconds').notNull(),

  // Plan item #15 — per-user quotas, sibling to the per-instance bounds
  // above. A per-instance cap alone doesn't stop resource exhaustion from
  // many *concurrent* instances owned by one user; enforced at
  // instance-create time in api/instances.ts by counting/summing that
  // user's own live (non-deleted) instances against these ceilings.
  // Defaults here (unlike the columns above) exist so `ALTER TABLE ADD
  // COLUMN` has something to backfill the already-seeded tier row with on an
  // upgrading deploy — SQLite requires a DEFAULT for a NOT NULL column added
  // this way. Matches db/resourceTiers.ts's DEFAULT_TIER; only meaningful for
  // that backfill, since getActiveTier() only ever inserts a brand-new row
  // with explicit values, never relying on the column default itself.
  maxConcurrentInstances: integer('max_concurrent_instances').notNull().default(5),
  maxAggregateRamMb: integer('max_aggregate_ram_mb').notNull().default(5 * 8192),
  maxAggregateDiskGb: integer('max_aggregate_disk_gb').notNull().default(5 * 128),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  expiresAt: integer('expires_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull().default(sql`(unixepoch())`),
});

// container_state: raw Docker-observed state (created|running|exited|error)
// phase: derived install lifecycle (installing|ready|failed) — kept separate from
// container_state so the reaper can reason about them independently (e.g. never
// reap something still installing).
export const sandboxInstances = sqliteTable('sandbox_instances', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  windowsVersion: text('windows_version').notNull(),
  ramMb: integer('ram_mb').notNull(),
  cpuCores: integer('cpu_cores').notNull(),
  diskGb: integer('disk_gb').notNull(),

  containerId: text('container_id'),
  containerName: text('container_name').notNull(),
  volumeName: text('volume_name').notNull(),
  // Set once createInstanceContainer resolves (see api/instances.ts) — the
  // only way to recover the Windows account password dockur/windows was
  // given at boot, since it's randomized per instance and dockur has no API
  // to re-fetch or reset it.
  accountPassword: text('account_password'),

  containerState: text('container_state', {
    enum: ['pending', 'created', 'running', 'exited', 'error'],
  })
    .notNull()
    .default('pending'),
  phase: text('phase', { enum: ['installing', 'ready', 'failed'] })
    .notNull()
    .default('installing'),
  // Per-instance egress policy (plan item #16, supersedes #23's plain
  // egress_blocked boolean — 'blocked' is that same case, 'allowlist' is new).
  // 'open': only the always-on RFC1918/link-local/host-protection rules
  // apply (today's default). 'blocked': deny all egress. 'allowlist': deny
  // all egress except DNS and the CIDRs in egress_allowlist. Reconciler
  // treats these columns as the source of truth every sweep (see
  // reconciler/index.ts ensureFirewallRules), so a change self-heals even if
  // the API call that made it crashes mid-flight. This is a live per-instance
  // override a user/admin triggers themselves — distinct from a future
  // admin-set default policy per resource tier (plan item #14, not yet
  // implemented).
  egressMode: text('egress_mode', { enum: ['open', 'blocked', 'allowlist'] })
    .notNull()
    .default('open'),
  // JSON-encoded array of CIDR strings, meaningful only when egressMode is
  // 'allowlist'. Stored as text rather than a child table — bounded in size
  // by the API's own validation (docker/validators.ts), so a relational
  // table would be overhead without a real query need.
  egressAllowlist: text('egress_allowlist').notNull().default('[]'),

  // Plan item #14 — lets an admin force-cap (or effectively force-suspend,
  // by setting a value already in the past) an individual running sandbox
  // ahead of the tier's default max lifetime, without changing the tier
  // itself for everyone else. Null means "use the tier's maxLifetimeSeconds"
  // — see reconciler/index.ts's reapIdleAndExpired.
  maxUptimeOverrideSeconds: integer('max_uptime_override_seconds'),

  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  startedAt: integer('started_at'),
  stoppedAt: integer('stopped_at'),
  lastSeenAt: integer('last_seen_at'),
  deletedAt: integer('deleted_at'),
});

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type SandboxInstance = typeof sandboxInstances.$inferSelect;
export type NewSandboxInstance = typeof sandboxInstances.$inferInsert;
export type ResourceTier = typeof resourceTiers.$inferSelect;
