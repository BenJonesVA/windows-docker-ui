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
  // User/admin-triggered live override (plan item #23) — distinct from #16's
  // admin-set per-tier default policy. Reconciler treats this as the source
  // of truth every sweep (see reconciler/index.ts ensureFirewallRules), so
  // toggling it back off self-heals even if the API call that flipped it
  // crashes mid-flight.
  egressBlocked: integer('egress_blocked', { mode: 'boolean' }).notNull().default(false),

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
