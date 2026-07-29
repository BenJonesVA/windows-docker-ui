import { z } from 'zod';
import type { ResourceTier } from '../db/schema.js';

// Whitelist of VERSION codes this project supports, taken verbatim from
// windows/readme.md ("How do I select the Windows version?"). Deliberately
// excludes the two upstream escape hatches that bypass this list entirely:
// an arbitrary ISO URL, and a bind-mounted /custom.iso — neither must ever be
// reachable from user input.
// Note: 'reactos' is listed in windows/readme.md but was rejected as
// "Invalid VERSION specified" when tested empirically against this image
// build — excluded until that's reconciled with upstream.
export const ALLOWED_WINDOWS_VERSIONS = [
  '11', '11l', '11e',
  '10', '10l', '10e',
  '8e', '7u', 'vu', 'xp', '2k',
  '2025', '2022', '2019', '2016', '2012', '2008', '2003',
  'core11', 'tiny11', 'tiny10',
] as const;

// 32GB was never a dockur/windows requirement — there's no enforced minimum
// in its scripts (define.sh/image.sh), and 64GB in its docs is only the
// image's *default*, not a floor. The real constraint is per-Windows-version:
// modern Windows 10/11 realistically needs room for installation + updates;
// legacy and stripped-down options can run on much less.
export const VERSION_DISK_MIN_GB: Record<(typeof ALLOWED_WINDOWS_VERSIONS)[number], number> = {
  // Full Windows 10/11 — needs headroom for install + updates
  '11': 32, '11l': 32, '11e': 32,
  '10': 32, '10l': 32, '10e': 32,
  // Windows Server, modern-ish — comparable footprint to desktop 10/11
  '2025': 32, '2022': 32, '2019': 32, '2016': 32, '2012': 32,
  // Legacy desktop/server — small, well-understood footprint
  '8e': 8, '7u': 8, 'vu': 8, 'xp': 8, '2k': 8, '2008': 8, '2003': 8,
  // Stripped-down modern builds
  core11: 16, tiny11: 16, tiny10: 16,
};

const ABSOLUTE_DISK_GB_MIN = Math.min(...Object.values(VERSION_DISK_MIN_GB));

// Shared between create and rename (docker/validators.ts's single source of
// truth for what a display name is allowed to look like) — kept as one
// export so the two paths can't silently drift apart.
export const instanceNameSchema = z.string().trim().min(1).max(64);

type ResourceBounds = Pick<ResourceTier, 'ramMbMin' | 'ramMbMax' | 'cpuCoresMin' | 'cpuCoresMax' | 'diskGbMax'>;

// Bounds come from the active resource tier (plan item #14, db/resourceTiers.ts)
// rather than static constants — built fresh per request in api/instances.ts
// (create route and /meta) so an admin's edit to the tier takes effect
// immediately, not just for instances created after a restart.
//
// Numeric only — deliberately rejects upstream's own "half"/"max" string
// shortcuts for RAM_SIZE/CPU_CORES, which would otherwise let a request claim
// the entire host.
export function buildCreateInstanceSchema(tier: ResourceBounds) {
  return z
    .object({
      name: instanceNameSchema,
      windowsVersion: z.enum(ALLOWED_WINDOWS_VERSIONS),
      ramMb: z.number().int().min(tier.ramMbMin).max(tier.ramMbMax),
      cpuCores: z.number().int().min(tier.cpuCoresMin).max(tier.cpuCoresMax),
      diskGb: z.number().int().min(ABSOLUTE_DISK_GB_MIN).max(tier.diskGbMax),
    })
    .superRefine((data, ctx) => {
      const minForVersion = VERSION_DISK_MIN_GB[data.windowsVersion];
      if (data.diskGb < minForVersion) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['diskGb'],
          message: `diskGb must be at least ${minForVersion} for windowsVersion "${data.windowsVersion}"`,
        });
      }
    });
}

export type CreateInstanceInput = z.infer<ReturnType<typeof buildCreateInstanceSchema>>;

// IPv4 dotted-quad, optional /0-32 prefix. IPv6 and hostnames deliberately
// excluded — the firewall helper (docker/firewall.ts) only ever emits IPv4
// iptables rules today, so accepting a form we can't enforce would silently
// no-op an admin's intended allow rule.
const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(\d|[12]\d|3[0-2]))?$/;

function isValidCidr(value: string): boolean {
  const match = CIDR_RE.exec(value);
  if (!match) return false;
  return match[1]
    .concat('.', match[2], '.', match[3], '.', match[4])
    .split('.')
    .every((octet) => Number(octet) <= 255);
}

// Bounds the number of ACCEPT rules an allowlist policy generates — each
// entry is one iptables rule in the instance's dedicated chain (see
// docker/firewall.ts), and each rule application is one privileged helper
// container spawn (see reconciler ensureFirewallRules, which reapplies every
// sweep). 50 is generous for a hand-maintained allowlist while keeping a
// pathological request from ballooning sweep cost.
const EGRESS_ALLOWLIST_MAX_ENTRIES = 50;

// Same rationale/bound as EGRESS_ALLOWLIST_MAX_ENTRIES above — one rule is
// one iptables -A call, reapplied every reconciler sweep for every instance
// the profile is assigned to.
const FIREWALL_PROFILE_MAX_RULES = 50;

const PORT_MIN = 1;
const PORT_MAX = 65535;

// A single edge in the graph editor: a destination (cidr) reached from the
// instance's "This Sandbox" source node, scoped by protocol/port and
// resolved to allow/deny. `id` is client-generated (crypto.randomUUID() in
// the browser) so the editor's nodeLayout can key positions by it and rules
// can be reordered/deleted stably — validated for uniqueness in
// firewallProfileSchema's superRefine below, not here (needs the whole array).
export const firewallRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    action: z.enum(['allow', 'deny']),
    protocol: z.enum(['tcp', 'udp', 'any']),
    cidr: z.string().refine(isValidCidr, { message: 'must be an IPv4 address or CIDR' }),
    portFrom: z.number().int().min(PORT_MIN).max(PORT_MAX).optional(),
    portTo: z.number().int().min(PORT_MIN).max(PORT_MAX).optional(),
    label: z.string().trim().max(64).optional(),
  })
  .superRefine((data, ctx) => {
    // iptables --dport requires -p tcp/udp — 'any' + a port range can't be
    // expressed, and silently dropping the port would mean the rule doesn't
    // do what its own fields claim.
    if (data.protocol === 'any' && (data.portFrom !== undefined || data.portTo !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['protocol'], message: 'ports require protocol tcp or udp' });
    }
    if (data.portFrom !== undefined && data.portTo !== undefined && data.portFrom > data.portTo) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['portTo'], message: 'portTo must be >= portFrom' });
    }
    // portTo alone (no portFrom) would otherwise reach ruleToIptablesArgs
    // (docker/firewall.ts) with portFrom undefined, which gates the whole
    // --dport clause off — silently widening the rule to match every port
    // instead of the single port the form appeared to set.
    if (data.portTo !== undefined && data.portFrom === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['portFrom'], message: 'portTo requires portFrom' });
    }
  });

export type FirewallRuleInput = z.infer<typeof firewallRuleSchema>;

// A saved, reusable, graphically-edited firewall/router profile (plan
// item #24). `rules` order is enforcement order (docker/firewall.ts
// populateChain) — this is the one thing the graph editor's node
// positions must translate into on save. `nodeLayout` is purely cosmetic,
// bounded implicitly by rules.length via the superRefine below (every key
// must correspond to a real rule id) rather than its own separate cap.
export const firewallProfileSchema = z
  .object({
    name: instanceNameSchema,
    defaultAction: z.enum(['allow', 'deny']),
    rules: z.array(firewallRuleSchema).max(FIREWALL_PROFILE_MAX_RULES),
    nodeLayout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
  })
  .superRefine((data, ctx) => {
    const ids = new Set<string>();
    data.rules.forEach((rule, i) => {
      if (ids.has(rule.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rules', i, 'id'], message: 'duplicate rule id' });
      }
      ids.add(rule.id);
    });
    if (data.nodeLayout) {
      for (const key of Object.keys(data.nodeLayout)) {
        if (key !== 'source' && key !== '__default__' && !ids.has(key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodeLayout'], message: `nodeLayout references unknown rule id "${key}"` });
        }
      }
    }
  });

export type FirewallProfileInput = z.infer<typeof firewallProfileSchema>;

export const setEgressPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('open') }),
  z.object({ mode: z.literal('blocked') }),
  z.object({
    mode: z.literal('allowlist'),
    allowlist: z
      .array(z.string().refine(isValidCidr, { message: 'must be an IPv4 address or CIDR' }))
      .min(1, 'allowlist mode requires at least one CIDR entry')
      .max(EGRESS_ALLOWLIST_MAX_ENTRIES),
  }),
  z.object({
    mode: z.literal('profile'),
    firewallProfileId: z.string().trim().min(1),
  }),
]);

export type SetEgressPolicyInput = z.infer<typeof setEgressPolicySchema>;

export const renameInstanceSchema = z.object({ name: instanceNameSchema });

// Plan item #9/#18 (file upload). The value reaches the shell as a
// positional arg, never interpolated into script text (docker/files.ts), so
// this isn't guarding against shell injection — it's guarding against path
// traversal, which quoting a value does NOT prevent (confirmed empirically:
// a literal ".." component in a quoted path still walks out of /shared at
// the OS level). No slashes, no backslashes, no ".." — a flat folder only,
// matching what dockur/windows' own Samba share exposes.
export const sharedFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((name) => !name.includes('/') && !name.includes('\\') && !name.includes('\0'), {
    message: 'filename cannot contain path separators',
  })
  .refine((name) => name !== '.' && name !== '..', { message: 'invalid filename' });

// Plan item #14 admin routes (api/admin.ts). Bounds themselves are
// deliberately unopinionated here (an admin can set genuinely wide limits) —
// the invariant this enforces is internal consistency (min <= max), not a
// specific ceiling.
export const updateResourceTierSchema = z
  .object({
    ramMbMin: z.number().int().positive(),
    ramMbMax: z.number().int().positive(),
    cpuCoresMin: z.number().int().positive(),
    cpuCoresMax: z.number().int().positive(),
    diskGbMax: z.number().int().positive(),
    idleTimeoutSeconds: z.number().int().positive(),
    maxLifetimeSeconds: z.number().int().positive(),
  })
  .superRefine((data, ctx) => {
    if (data.ramMbMin > data.ramMbMax) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ramMbMin'], message: 'ramMbMin must be <= ramMbMax' });
    }
    if (data.cpuCoresMin > data.cpuCoresMax) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cpuCoresMin'], message: 'cpuCoresMin must be <= cpuCoresMax' });
    }
  });

export type UpdateResourceTierInput = z.infer<typeof updateResourceTierSchema>;

// null clears the override (falls back to the tier's maxLifetimeSeconds).
export const setMaxUptimeOverrideSchema = z.object({
  maxUptimeOverrideSeconds: z.number().int().positive().nullable(),
});
