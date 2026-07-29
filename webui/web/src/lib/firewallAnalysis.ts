import type { FirewallRule } from '../api';

// Mirrors docker/firewall.ts's BLOCKED_EGRESS_CIDRS exactly — those baseline
// drops are appended to every instance's chain before any profile rule
// (populateChain), so a rule whose destination falls entirely inside one of
// these ranges can structurally never match, regardless of its own action.
const BASELINE_BLOCKED_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'];

interface CidrRange {
  network: number;
  prefix: number;
}

function parseCidr(cidr: string): CidrRange | null {
  const trimmed = cidr.trim();
  const slash = trimmed.indexOf('/');
  const addr = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const prefixStr = slash === -1 ? '32' : trimmed.slice(slash + 1);
  const octets = addr.split('.');
  if (octets.length !== 4) return null;

  let network = 0;
  for (const o of octets) {
    const n = Number(o);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    network = ((network << 8) | n) >>> 0;
  }
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;

  // Special-cased rather than `(0xffffffff << (32 - prefix)) >>> 0` for
  // prefix === 0 — JS shift amounts are taken mod 32, so `<< 32` is a no-op
  // (same as `<< 0`), which would silently produce a full /32 mask instead
  // of "match everything" for a /0 network.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network: (network & mask) >>> 0, prefix };
}

// True if every address `inner` matches is also matched by `outer` — i.e.
// `outer` is the same size or broader, AND inner's network falls inside it.
function cidrContains(outerCidr: string, innerCidr: string): boolean {
  const outer = parseCidr(outerCidr);
  const inner = parseCidr(innerCidr);
  if (!outer || !inner) return false;
  if (outer.prefix > inner.prefix) return false;
  const outerMask = outer.prefix === 0 ? 0 : (0xffffffff << (32 - outer.prefix)) >>> 0;
  return ((inner.network & outerMask) >>> 0) === outer.network;
}

export function isAlwaysBlockedByBaseline(cidr: string): boolean {
  return BASELINE_BLOCKED_CIDRS.some((blocked) => cidrContains(blocked, cidr));
}

// True if `earlier`, evaluated first (docker/firewall.ts appends rules in
// array order — first match wins), matches every packet `rule` would ever
// match, making `rule` unreachable regardless of its own action.
function ruleCovers(earlier: FirewallRule, rule: FirewallRule): boolean {
  if (!cidrContains(earlier.cidr, rule.cidr)) return false;
  if (earlier.protocol === 'any') return true;
  if (earlier.protocol !== rule.protocol) return false;
  if (earlier.portFrom === undefined) return true;
  if (rule.portFrom === undefined) return false;
  const earlierTo = earlier.portTo ?? earlier.portFrom;
  const ruleTo = rule.portTo ?? rule.portFrom;
  return earlier.portFrom <= rule.portFrom && earlierTo >= ruleTo;
}

export interface RuleWarning {
  ruleId: string;
  message: string;
}

// Policy dry-run / rule-conflict detection (plan item #25/#26) — a purely
// client-side pass over the rule list as drawn in the graph editor. Two
// distinct failure modes, reported with different wording since the cause
// (and the fix) differs:
// - a destination that's always blocked by the baseline private-network
//   isolation, independent of anything in this profile
// - a rule shadowed by an earlier, broader rule in the SAME profile
export function analyzeRules(rules: FirewallRule[]): RuleWarning[] {
  const warnings: RuleWarning[] = [];
  rules.forEach((rule, i) => {
    if (isAlwaysBlockedByBaseline(rule.cidr)) {
      warnings.push({
        ruleId: rule.id,
        message: `${rule.cidr} is always blocked by baseline private-network isolation (RFC1918/link-local) — this rule can never match, regardless of its action.`,
      });
      return;
    }
    for (let j = 0; j < i; j++) {
      if (ruleCovers(rules[j], rule)) {
        const earlierName = rules[j].label || rules[j].cidr;
        warnings.push({
          ruleId: rule.id,
          message: `Shadowed by an earlier rule ("${earlierName}") that already matches everything this rule would — this rule can never be reached.`,
        });
        return;
      }
    }
  });
  return warnings;
}
