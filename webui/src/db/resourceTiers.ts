import { nanoid } from 'nanoid';
import { db } from './client.js';
import { resourceTiers, type ResourceTier } from './schema.js';

// Exactly the values that used to be hardcoded in docker/validators.ts
// (RAM_MB_MIN/MAX, CPU_CORES_MIN/MAX, DISK_GB_MAX) and reconciler/index.ts
// (IDLE_TIMEOUT_SECONDS, MAX_LIFETIME_SECONDS) — preserved here so a fresh
// deploy behaves identically to before this table existed, until an admin
// actually edits it.
const DEFAULT_TIER: Omit<ResourceTier, 'id'> = {
  name: 'default',
  ramMbMin: 2048,
  ramMbMax: 8192,
  cpuCoresMin: 1,
  cpuCoresMax: 4,
  diskGbMax: 128,
  idleTimeoutSeconds: 30 * 60,
  maxLifetimeSeconds: 8 * 60 * 60,
};

// Lazily seeds the single row this table holds today (see schema.ts's
// comment on resourceTiers) rather than a migration data-seed step — keeps
// `npm run db:migrate` schema-only, consistent with how this project already
// treats migrations vs. app-level bootstrapping (db/seed.ts is a separate,
// deliberate manual step for the first admin user).
export async function getActiveTier(): Promise<ResourceTier> {
  const [existing] = await db.select().from(resourceTiers).limit(1);
  if (existing) return existing;

  const id = nanoid(16);
  const [inserted] = await db.insert(resourceTiers).values({ id, ...DEFAULT_TIER }).returning();
  return inserted;
}
