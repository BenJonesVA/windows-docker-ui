import type { SandboxInstance } from '../db/schema.js';

// egress_allowlist is stored as a JSON string (see db/schema.ts) — parse it
// before it ever reaches a client, so every response gives callers a real
// array instead of a string they'd have to know to JSON.parse themselves.
// Shared between api/instances.ts (a user's own instances) and api/admin.ts
// (every user's instances) so the wire shape can't drift between the two.
export function serializeInstance(row: SandboxInstance) {
  let egressAllowlist: string[] = [];
  try {
    egressAllowlist = JSON.parse(row.egressAllowlist);
  } catch {
    // Malformed stored value — surface as empty rather than throwing a 500
    // on every read; reconciler/index.ts's ensureFirewallRules logs this
    // same condition loudly on the enforcement side.
  }
  return { ...row, egressAllowlist };
}
