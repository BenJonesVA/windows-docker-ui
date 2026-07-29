import { desc, eq, lt } from 'drizzle-orm';
import { db } from './client.js';
import { processEvents, type ProcessEvent } from './schema.js';

// Plan item #13. Rows arrive via docker/telemetry.ts's ingestInstanceTelemetry
// (called from reconciler/index.ts) — this module only ever reads/prunes.
export async function listRecentProcessEvents(instanceId: string, limit: number): Promise<ProcessEvent[]> {
  return db
    .select()
    .from(processEvents)
    .where(eq(processEvents.instanceId, instanceId))
    .orderBy(desc(processEvents.ts))
    .limit(limit);
}

// 7 days — generous enough to look back on a completed analysis run, short
// enough that an always-on poller doesn't grow this table unbounded. No
// per-tier knob for this yet, same scoping caveat as docker/files.ts's fixed
// shared-folder cap.
const RETENTION_SECONDS = 7 * 24 * 60 * 60;

export async function pruneOldProcessEvents(nowSeconds: number): Promise<void> {
  const cutoff = nowSeconds - RETENTION_SECONDS;
  await db.delete(processEvents).where(lt(processEvents.ts, cutoff));
}
