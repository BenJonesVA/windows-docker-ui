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

export const setEgressPolicySchema = z
  .object({
    mode: z.enum(['open', 'blocked', 'allowlist']),
    allowlist: z.array(z.string().refine(isValidCidr, { message: 'must be an IPv4 address or CIDR' })).max(EGRESS_ALLOWLIST_MAX_ENTRIES).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === 'allowlist' && (!data.allowlist || data.allowlist.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowlist'],
        message: 'allowlist mode requires at least one CIDR entry',
      });
    }
  });

export type SetEgressPolicyInput = z.infer<typeof setEgressPolicySchema>;

export const renameInstanceSchema = z.object({ name: instanceNameSchema });

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
