import type { SandboxInstance, FirewallProfile } from '../db/schema.js';
import type { FirewallRule } from '../docker/firewall.js';

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

// rules/nodeLayout are stored as JSON text (see db/schema.ts
// firewallProfiles) for the same reason egressAllowlist is above — parsed
// once here rather than leaving every caller to know to JSON.parse them.
export function serializeFirewallProfile(row: FirewallProfile) {
  let rules: FirewallRule[] = [];
  try {
    rules = JSON.parse(row.rules);
  } catch {
    // Malformed stored value — surface as empty rather than throwing.
  }
  let nodeLayout: Record<string, { x: number; y: number }> = {};
  try {
    nodeLayout = JSON.parse(row.nodeLayout);
  } catch {
    // Same posture as above — cosmetic data only, never worth a 500.
  }
  return { ...row, rules, nodeLayout };
}
