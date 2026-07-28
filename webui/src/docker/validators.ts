import { z } from 'zod';

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

// Bounds are deliberately conservative for a first deployment; make these
// admin-configurable resource_tiers rows once that table exists (see plan).
export const RAM_MB_MIN = 2048;
export const RAM_MB_MAX = 8192;
export const CPU_CORES_MIN = 1;
export const CPU_CORES_MAX = 4;
export const DISK_GB_MAX = 128;

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

// Numeric only — deliberately rejects upstream's own "half"/"max" string
// shortcuts for RAM_SIZE/CPU_CORES, which would otherwise let a request claim
// the entire host.
export const createInstanceSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    windowsVersion: z.enum(ALLOWED_WINDOWS_VERSIONS),
    ramMb: z.number().int().min(RAM_MB_MIN).max(RAM_MB_MAX),
    cpuCores: z.number().int().min(CPU_CORES_MIN).max(CPU_CORES_MAX),
    diskGb: z.number().int().min(ABSOLUTE_DISK_GB_MIN).max(DISK_GB_MAX),
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

export type CreateInstanceInput = z.infer<typeof createInstanceSchema>;
