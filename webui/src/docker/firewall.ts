import { docker } from './client.js';

// Built locally at deploy time (see webui/firewall-helper/Dockerfile and the
// build step documented in compose.yml) — never pushed to a registry, so
// there's no digest to pin the way template.ts pins the sandbox image.
const FIREWALL_HELPER_IMAGE =
  process.env.FIREWALL_HELPER_IMAGE ?? 'sandbox-firewall-helper:latest';

// Plan item #26 — a SEPARATE minimal privileged image (webui/net-helper/
// Dockerfile) rather than widening firewall-helper's own contract (e.g.
// removing its fixed `ENTRYPOINT ["iptables"]` so it could also run
// `sysctl`). That would be a breaking change for any already-deployed host
// that hasn't rebuilt the firewall-helper image — its Cmd-is-iptables-args
// contract would silently become "Cmd is the whole argv including the
// binary name," making every `iptables ...` call fail until rebuilt. A
// second image with its own build step (see compose.yml) means a host that
// never builds this one just doesn't get anti-spoofing hardening — it can't
// break the iptables enforcement every other feature in this module depends
// on.
const NET_HELPER_IMAGE = process.env.NET_HELPER_IMAGE ?? 'sandbox-net-helper:latest';

// Docker Engine's own default naming for a bridge network's host-side
// interface: `br-` + the first 12 hex chars of the network ID. There's no
// field in the Docker API that returns this directly (confirmed against
// `docker network inspect` / the host's real interface list) — it has to be
// derived deterministically from the network ID we already have.
function bridgeInterfaceName(networkId: string): string {
  return `br-${networkId.slice(0, 12)}`;
}

// One dedicated filter-table chain per instance, jumped to from DOCKER-USER.
// "SBX-" + the 12 hex chars already used for the bridge name — well under
// the ~28-char chain name limit. Keeping each instance's rules in its own
// chain (rather than appending everything flat into DOCKER-USER, as #1/#23
// originally did) is what makes rule ORDER controllable: an allowlist policy
// needs its ACCEPT rules evaluated before its final DROP, and DOCKER-USER's
// `-I chain 1` insert-at-top idiom (still fine for order-independent flat
// DROPs) can't express that — whichever rule was last (re)applied would land
// on top across sweeps, silently reordering ACCEPT vs DROP.
function chainName(iface: string): string {
  return `SBX-${iface.slice('br-'.length)}`;
}

// Plan item #26 — a dedicated sub-chain per instance holding only the
// new-TCP-connection rate limit (see ensureSynFloodChain/populateChain).
// "SBX-<iface>-SYN" — well under iptables' ~28-char chain name limit
// alongside the 16-char main chain name.
function synChainName(iface: string): string {
  return `${chainName(iface)}-SYN`;
}

// RFC1918 private ranges + link-local (covers cloud metadata endpoints like
// 169.254.169.254, and any other bridge/LAN segment reachable through the
// host's routing table). Applied inside every instance's chain regardless of
// egress mode — this is the VM-to-VM/VM-to-LAN isolation from plan item #1,
// orthogonal to the internet-egress policy below.
const BLOCKED_EGRESS_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'];

// One ordered rule in a firewall profile (db/schema.ts firewallProfiles).
// Array order in the profile IS iptables evaluation order once compiled —
// see populateChain's 'profile' branch below.
export interface FirewallRule {
  id: string;
  action: 'allow' | 'deny';
  protocol: 'tcp' | 'udp' | 'any';
  cidr: string;
  portFrom?: number;
  portTo?: number;
}

export interface EgressPolicy {
  mode: 'open' | 'blocked' | 'allowlist' | 'profile';
  allowlist: string[];
  // Only meaningful when mode === 'profile'. This module stays DB-agnostic
  // (same as the mode/allowlist pair above) — callers (api/instances.ts,
  // api/firewallProfiles.ts, reconciler/index.ts) resolve a firewall_profiles
  // row and pass its compiled shape in via compileProfilePolicy below.
  rules?: FirewallRule[];
  defaultAction?: 'allow' | 'deny';
}

export const OPEN_EGRESS_POLICY: EgressPolicy = { mode: 'open', allowlist: [] };

// Shared by every caller that needs to turn a stored firewall_profiles row
// into the EgressPolicy shape populateChain understands. Takes the raw
// column shapes (rules as JSON text) directly so callers don't each need
// their own parse-with-fallback — malformed stored JSON degrades to "no
// rules" (falls through to defaultAction only) rather than throwing, same
// posture as egressAllowlist parsing elsewhere in this app.
export function compileProfilePolicy(profile: { rules: string; defaultAction: 'allow' | 'deny' }): EgressPolicy {
  let rules: FirewallRule[] = [];
  try {
    rules = JSON.parse(profile.rules);
  } catch {
    // Malformed stored value — treat as empty; the profile's defaultAction
    // still applies below.
  }
  return { mode: 'profile', allowlist: [], rules, defaultAction: profile.defaultAction };
}

// A rule's destination CIDR + optional protocol/port scoping, compiled to
// the trailing args of an `iptables -A <chain> ...` call. Port matching
// requires -p tcp/udp (validated at the schema level, docker/validators.ts —
// 'any' + a port range is rejected before it ever reaches here).
function ruleToIptablesArgs(rule: FirewallRule): string[] {
  const args = ['-d', rule.cidr];
  if (rule.protocol !== 'any') {
    args.push('-p', rule.protocol);
    if (rule.portFrom !== undefined) {
      const port =
        rule.portTo !== undefined && rule.portTo !== rule.portFrom ? `${rule.portFrom}:${rule.portTo}` : String(rule.portFrom);
      args.push('--dport', port);
    }
  }
  args.push('-j', rule.action === 'allow' ? 'ACCEPT' : 'DROP');
  return args;
}

// The webui container deliberately has no NET_ADMIN or host netns of its own
// (see compose.yml) — only Docker-socket access. Rather than widen the webui
// container's own privileges, spin up a short-lived helper container with
// --net=host --cap-add=NET_ADMIN via that same socket to run one iptables
// invocation against the host's real netfilter tables, then exit. Confirmed
// empirically that -C/-I/-D behave as expected (exit 1 when a rule/chain is
// absent, 0 once present) run this way, which is what makes the
// check-then-mutate calls below safe to repeat every reconciler sweep.
async function spawnPrivilegedHelper(image: string, cmd: string[]): Promise<number> {
  const container = await docker.createContainer({
    Image: image,
    Cmd: cmd,
    HostConfig: {
      NetworkMode: 'host',
      CapAdd: ['NET_ADMIN'],
      AutoRemove: true,
    },
  });
  await container.start();
  const { StatusCode } = await container.wait();
  return StatusCode;
}

async function runHostIptables(args: string[]): Promise<number> {
  return spawnPrivilegedHelper(FIREWALL_HELPER_IMAGE, args);
}

// Plan item #26 — same spawn pattern as runHostIptables, against the
// separate net-helper image (ENTRYPOINT ["sysctl"], see NET_HELPER_IMAGE's
// comment above).
async function runHostSysctl(args: string[]): Promise<number> {
  return spawnPrivilegedHelper(NET_HELPER_IMAGE, args);
}

async function ensureRule(chain: string, ruleArgs: string[]): Promise<void> {
  const exists = (await runHostIptables(['-C', chain, ...ruleArgs])) === 0;
  if (exists) return;
  const inserted = await runHostIptables(['-I', chain, '1', ...ruleArgs]);
  if (inserted !== 0) {
    throw new Error(`iptables -I ${chain} ${ruleArgs.join(' ')} failed with exit code ${inserted}`);
  }
}

// Like ensureRule, but appends (-A, end of chain) rather than inserts (-I,
// position 1) when the rule is missing. ensureRule's insert-at-top is fine
// when a chain only ever holds one such rule (order among a single rule
// doesn't matter); it's WRONG for a fixed multi-rule sequence added via
// separate idempotent calls — inserting each one at position 1 would leave
// the LAST-added rule on top, reversing the intended order. This is what
// ensureSynFloodChain needs: its two rules must stay in the order they were
// first created in, forever, across a chain that (unlike the main policy
// chain) is never flushed to re-establish order the normal way.
async function ensureRuleAppended(chain: string, ruleArgs: string[]): Promise<void> {
  const exists = (await runHostIptables(['-C', chain, ...ruleArgs])) === 0;
  if (exists) return;
  const appended = await runHostIptables(['-A', chain, ...ruleArgs]);
  if (appended !== 0) {
    throw new Error(`iptables -A ${chain} ${ruleArgs.join(' ')} failed with exit code ${appended}`);
  }
}

async function removeRule(chain: string, ruleArgs: string[]): Promise<void> {
  const exists = (await runHostIptables(['-C', chain, ...ruleArgs])) === 0;
  if (!exists) return;
  const deleted = await runHostIptables(['-D', chain, ...ruleArgs]);
  if (deleted !== 0) {
    throw new Error(`iptables -D ${chain} ${ruleArgs.join(' ')} failed with exit code ${deleted}`);
  }
}

async function chainExists(chain: string): Promise<boolean> {
  return (await runHostIptables(['-L', chain, '-n'])) === 0;
}

async function ensureChain(chain: string): Promise<void> {
  if (await chainExists(chain)) return;
  const created = await runHostIptables(['-N', chain]);
  if (created !== 0) {
    throw new Error(`iptables -N ${chain} failed with exit code ${created}`);
  }
}

// Appends run one at a time, awaited in sequence — that program order IS the
// resulting rule order (each is its own helper-container invocation, so
// nothing here can race). This is the property that makes an allowlist safe:
// ACCEPT rules are always appended before the trailing DROP.
async function appendRule(chain: string, ruleArgs: string[]): Promise<void> {
  const appended = await runHostIptables(['-A', chain, ...ruleArgs]);
  if (appended !== 0) {
    throw new Error(`iptables -A ${chain} ${ruleArgs.join(' ')} failed with exit code ${appended}`);
  }
}

// Plan item #26 — strict reverse-path filtering on this instance's bridge
// interface: the kernel drops any packet whose source address wouldn't be
// routed back out the interface it arrived on, which is exactly what a
// forged/spoofed source IP looks like. Best-effort and silent by design:
// - The bridge interface may not exist yet the moment this is first called
//   (ensureInstanceFirewall runs right after network creation, before a
//   container has necessarily attached) — sysctl -w against a nonexistent
//   /proc/sys path fails, and that's expected, not exceptional; the
//   reconciler's every-60s reapply (reconciler/index.ts ensureFirewallRules)
//   retries until it succeeds.
// - This module has no logger of its own (every other function here throws
//   and lets its caller decide how to log) — but a real policy-enforcement
//   failure and a missing anti-spoofing nicety are not the same severity,
//   and this is the one operation in this module that must never be allowed
//   to block instance creation or the main policy chain from being applied.
// - Linux takes max(net.ipv4.conf.all.rp_filter, this per-interface value) —
//   deliberately NOT touching the host-wide `all` setting here (that's a
//   bigger blast-radius change than a per-instance feature should make on
//   its own), so this is only fully effective if the host's own default is
//   already >= 1 (common, not guaranteed).
async function ensureRpFilter(iface: string): Promise<void> {
  try {
    await runHostSysctl(['-w', `net.ipv4.conf.${iface}.rp_filter=1`]);
  } catch {
    // Swallowed deliberately — see comment above.
  }
}

// Plan item #26 — rate-limits new outbound TCP connection attempts from
// this instance. There is no inbound path to protect (see plan item #23 —
// ingress is already zero by design), so this isn't classic "protect a
// server from a SYN flood"; it's defense-in-depth against a compromised
// guest being used as a SYN-flood or port-scan SOURCE against someone else.
// Deliberately generous — 15 new connections/sec with a 45-connection burst
// tolerates a browser opening a page's worth of parallel connections at
// once while still meaningfully throttling a scan/flood attempt. Not
// user-configurable (unlike egress mode/profiles), so there's no path today
// that changes these constants — if that ever changes, note that -C compares
// the FULL rule spec including these numbers: bumping either constant makes
// ensureRuleAppended's -C check "rule not found" and APPEND a second, newer
// rule below the stale one rather than replacing it. That's fine as long as
// nothing changes them; it's the thing to fix first if something ever does.
const SYN_RATE_PER_SECOND = 15;
const SYN_BURST = 45;

// A dedicated per-instance sub-chain, created once and NEVER flushed —
// unlike the main policy chain (which populateChain intentionally rebuilds
// from scratch every call), flushing this one would reset the `-m limit`
// token bucket every reconciler sweep, making the rate limit meaningless.
// ensureRuleAppended's -C-then-append idempotency is what makes calling
// this every sweep safe: once its two rules exist, this never touches them
// again.
async function ensureSynFloodChain(iface: string): Promise<void> {
  const synChain = synChainName(iface);
  await ensureChain(synChain);
  // Order matters: within-budget SYNs RETURN to wherever they were jumped
  // from (see populateChain's jump into this chain) and continue normal
  // evaluation there; over-budget ones hit the unconditional DROP below and
  // never return at all. Only correct because the ONLY thing that ever
  // jumps here is `-p tcp --syn` traffic (see populateChain) — nothing
  // inside this chain re-checks that itself.
  await ensureRuleAppended(synChain, ['-m', 'limit', '--limit', `${SYN_RATE_PER_SECOND}/s`, '--limit-burst', `${SYN_BURST}`, '-j', 'RETURN']);
  await ensureRuleAppended(synChain, ['-j', 'DROP']);
}

// Rebuilds an instance's chain from scratch every call rather than diffing —
// simpler to reason about correctly (no partial-update edge cases), at the
// cost of a flush + N appends worth of helper-container spawns on every
// reconciler sweep for every instance. Acceptable at today's scale; revisit
// (e.g. skip the rebuild when policy is unchanged from last sweep) if
// instance counts or allowlist sizes grow enough for that to matter.
async function populateChain(chain: string, iface: string, policy: EgressPolicy): Promise<void> {
  const flushed = await runHostIptables(['-F', chain]);
  if (flushed !== 0) {
    throw new Error(`iptables -F ${chain} failed with exit code ${flushed}`);
  }

  // Plan item #26 — explicit stateful fast-path. Return/related traffic for
  // a connection that was already permitted skips re-evaluation against
  // every rule below on every single packet — a real (if incidental until
  // now) property this app already depended on: return traffic for an
  // 'open'-mode connection never even enters this chain today (see the
  // DOCKER-USER jump's `! -o <iface>` scoping — this chain only ever sees
  // the egress direction), so this doesn't change what's reachable, only
  // how much of THIS chain's own rule list re-runs per packet of an
  // already-established connection. Placed first, unconditionally, for
  // every mode: a packet can only be in ESTABLISHED/RELATED state because
  // its connection's initial (NEW) packet already passed every check below
  // once — nothing here weakens the baseline/policy evaluation a fresh
  // connection attempt still goes through.
  await appendRule(chain, ['-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT']);

  // Plan item #26 — new TCP connection attempts are rate-limited via a
  // dedicated sub-chain (ensureSynFloodChain) BEFORE the baseline/policy
  // rules below, defense-in-depth against this instance being used as a
  // flood/scan source. This jump rule is rebuilt every populateChain call
  // (like everything else in this chain) — only the sub-chain it points to
  // is exempt from flushing, so its accumulated rate-limit state survives.
  await appendRule(chain, ['-p', 'tcp', '--syn', '-j', synChainName(iface)]);

  for (const cidr of BLOCKED_EGRESS_CIDRS) {
    await appendRule(chain, ['-d', cidr, '-j', 'DROP']);
  }

  if (policy.mode === 'blocked') {
    await appendRule(chain, ['-j', 'DROP']);
    return;
  }

  if (policy.mode === 'allowlist') {
    // DNS is allowed unconditionally rather than left to the admin-supplied
    // list — the guest resolves names through whatever resolver its DHCP
    // lease points at, which isn't necessarily one of the allowlisted
    // destination CIDRs, and there is no way to express "allow DNS" as a
    // destination-IP rule the admin would think to add themselves.
    await appendRule(chain, ['-p', 'udp', '--dport', '53', '-j', 'ACCEPT']);
    await appendRule(chain, ['-p', 'tcp', '--dport', '53', '-j', 'ACCEPT']);
    for (const cidr of policy.allowlist) {
      await appendRule(chain, ['-d', cidr, '-j', 'ACCEPT']);
    }
    await appendRule(chain, ['-j', 'DROP']);
    return;
  }

  if (policy.mode === 'profile') {
    // Same "DNS always resolves regardless of policy" rationale as allowlist
    // mode above — a default-deny profile with no explicit DNS rule would
    // otherwise leave the guest unable to resolve any name at all, which
    // nothing in the graph editor would obviously surface as the cause.
    await appendRule(chain, ['-p', 'udp', '--dport', '53', '-j', 'ACCEPT']);
    await appendRule(chain, ['-p', 'tcp', '--dport', '53', '-j', 'ACCEPT']);
    // Appended in array order, after the unconditional baseline drops above
    // — a rule "allowing" an RFC1918/link-local destination can never
    // actually match, since the earlier baseline DROP for that range wins
    // first (iptables is first-match). This is what makes it safe to let a
    // user freely draw an "allow 192.168.0.0/16" edge in the graph editor:
    // the compiled chain structurally cannot let it reach host/LAN traffic.
    for (const rule of policy.rules ?? []) {
      await appendRule(chain, ruleToIptablesArgs(rule));
    }
    if (policy.defaultAction === 'deny') {
      await appendRule(chain, ['-j', 'DROP']);
    }
    // defaultAction 'allow': nothing further — same open-egress fallthrough
    // as 'open' mode below.
    return;
  }

  // 'open': nothing further — falling off the end of a custom chain returns
  // to DOCKER-USER, which (once past this instance's jump rule) falls
  // through to Docker's own FORWARD rules, i.e. the same "general internet
  // open" behavior plan item #1 established as the default.
}

// One-time cleanup of the flat-in-DOCKER-USER rule shape #1/#23 used before
// this per-instance-chain design (plan item #16) existed. Confirmed
// empirically on a host upgraded mid-session: the reconciler's per-sweep
// reapply only ever ADDS the new chain/jump — nothing removed the old shape
// for instances that predate this code, so both shapes were found stacked in
// DOCKER-USER at once (harmless today, since both are DROPs targeting the
// same CIDRs and the new jump rule is inserted above them — but pure cruft
// that would never self-clean, and a foot-gun if a future rule shape needs
// the old one gone to behave correctly). removeRule no-ops via -C when a
// rule isn't present, so this is safe to run unconditionally every call.
async function removeLegacyFlatRules(iface: string): Promise<void> {
  for (const cidr of BLOCKED_EGRESS_CIDRS) {
    await removeRule('DOCKER-USER', ['-i', iface, '!', '-o', iface, '-d', cidr, '-j', 'DROP']);
  }
  // #23's plain deny-all-egress toggle, in case any instance had it set.
  await removeRule('DOCKER-USER', ['-i', iface, '!', '-o', iface, '-j', 'DROP']);
}

// Two distinct gaps closed by the always-on rules here (plan item #1):
//
// 1. Sandbox container -> host. Traffic a container sends to its own bridge
//    gateway IP terminates at the host, so it's the INPUT chain, not
//    FORWARD/DOCKER-USER — Docker's own filtering never touches INPUT.
//    Nothing on this bridge has a legitimate reason to reach the host itself
//    (the webui always initiates the viewer connection, never the reverse —
//    see template.ts), so this is a blanket drop.
//
// 2. Sandbox container -> other private networks (LAN, other docker bridges,
//    cloud metadata) — the BLOCKED_EGRESS_CIDRS drops inside the instance's
//    own chain, populated below.
//
// The jump into that chain is scoped `! -o <this bridge>` so the webui<->
// sandbox proxy path, which is same-bridge-in/same-bridge-out traffic, never
// enters it at all — a shared-bridge icc=false rule blocking exactly this
// path is what got rejected in template.ts's network design; this must not
// repeat that mistake.
//
// `policy` (plan item #16, supersedes #23's plain block-everything toggle)
// is the per-instance internet-egress policy layered on top of the always-on
// baseline. Rebuilds the instance's chain to match `policy` on every call, so
// the reconciler's per-sweep reapply (reconciler/index.ts ensureFirewallRules)
// converges to the stored DB state even if a prior policy-change call crashed
// mid-flight.
export async function ensureInstanceFirewall(
  networkId: string,
  policy: EgressPolicy = OPEN_EGRESS_POLICY,
): Promise<void> {
  const iface = bridgeInterfaceName(networkId);
  const chain = chainName(iface);
  await ensureRpFilter(iface);
  await ensureRule('INPUT', ['-i', iface, '-j', 'DROP']);
  await removeLegacyFlatRules(iface);
  await ensureChain(chain);
  await ensureSynFloodChain(iface);
  await ensureRule('DOCKER-USER', ['-i', iface, '!', '-o', iface, '-j', chain]);
  await populateChain(chain, iface, policy);
}

// Every caller of this function (instance teardown in template.ts,
// orphan-network cleanup in reconciler/index.ts) deletes the network right
// after, so there is no "reapply next sweep" to fall back on — leaving the
// jump rule or chain behind here leaks them permanently once the network
// (and the interface name they're keyed on) is gone. Order matters: the jump
// rule referencing the chain must go before the chain itself can be deleted.
export async function removeInstanceFirewall(networkId: string): Promise<void> {
  const iface = bridgeInterfaceName(networkId);
  const chain = chainName(iface);
  await removeRule('INPUT', ['-i', iface, '-j', 'DROP']);
  await removeRule('DOCKER-USER', ['-i', iface, '!', '-o', iface, '-j', chain]);
  if (await chainExists(chain)) {
    const flushed = await runHostIptables(['-F', chain]);
    if (flushed !== 0) {
      throw new Error(`iptables -F ${chain} failed with exit code ${flushed}`);
    }
    const deleted = await runHostIptables(['-X', chain]);
    if (deleted !== 0) {
      throw new Error(`iptables -X ${chain} failed with exit code ${deleted}`);
    }
  }

  // Plan item #26 — the SYN-limit sub-chain, cleaned up strictly AFTER the
  // main chain above (whose flush/delete removes the only rule that ever
  // referenced it — iptables refuses -X on a still-referenced chain).
  // Deliberately swallowed rather than thrown: every caller of this function
  // (template.ts's teardown, reconciler's orphan-network cleanup) still has
  // real work to do right after this returns (removing the network itself),
  // and a rare "-X" failure here must never block that — the cost of
  // swallowing is, at worst, one leaked/orphaned sub-chain, the same
  // accepted risk this function's own top comment already documents for the
  // main chain in the crash-mid-teardown case.
  try {
    const synChain = synChainName(iface);
    if (await chainExists(synChain)) {
      await runHostIptables(['-F', synChain]);
      await runHostIptables(['-X', synChain]);
    }
  } catch {
    // Swallowed — see comment above.
  }
}
