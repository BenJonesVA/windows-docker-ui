import { docker } from './client.js';

// Built locally at deploy time (see webui/firewall-helper/Dockerfile and the
// build step documented in compose.yml) — never pushed to a registry, so
// there's no digest to pin the way template.ts pins the sandbox image.
const FIREWALL_HELPER_IMAGE =
  process.env.FIREWALL_HELPER_IMAGE ?? 'sandbox-firewall-helper:latest';

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

// RFC1918 private ranges + link-local (covers cloud metadata endpoints like
// 169.254.169.254, and any other bridge/LAN segment reachable through the
// host's routing table). Applied inside every instance's chain regardless of
// egress mode — this is the VM-to-VM/VM-to-LAN isolation from plan item #1,
// orthogonal to the internet-egress policy below.
const BLOCKED_EGRESS_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'];

export interface EgressPolicy {
  mode: 'open' | 'blocked' | 'allowlist';
  allowlist: string[];
}

export const OPEN_EGRESS_POLICY: EgressPolicy = { mode: 'open', allowlist: [] };

// The webui container deliberately has no NET_ADMIN or host netns of its own
// (see compose.yml) — only Docker-socket access. Rather than widen the webui
// container's own privileges, spin up a short-lived helper container with
// --net=host --cap-add=NET_ADMIN via that same socket to run one iptables
// invocation against the host's real netfilter tables, then exit. Confirmed
// empirically that -C/-I/-D behave as expected (exit 1 when a rule/chain is
// absent, 0 once present) run this way, which is what makes the
// check-then-mutate calls below safe to repeat every reconciler sweep.
async function runHostIptables(args: string[]): Promise<number> {
  const container = await docker.createContainer({
    Image: FIREWALL_HELPER_IMAGE,
    Cmd: args,
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

async function ensureRule(chain: string, ruleArgs: string[]): Promise<void> {
  const exists = (await runHostIptables(['-C', chain, ...ruleArgs])) === 0;
  if (exists) return;
  const inserted = await runHostIptables(['-I', chain, '1', ...ruleArgs]);
  if (inserted !== 0) {
    throw new Error(`iptables -I ${chain} ${ruleArgs.join(' ')} failed with exit code ${inserted}`);
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

// Rebuilds an instance's chain from scratch every call rather than diffing —
// simpler to reason about correctly (no partial-update edge cases), at the
// cost of a flush + N appends worth of helper-container spawns on every
// reconciler sweep for every instance. Acceptable at today's scale; revisit
// (e.g. skip the rebuild when policy is unchanged from last sweep) if
// instance counts or allowlist sizes grow enough for that to matter.
async function populateChain(chain: string, policy: EgressPolicy): Promise<void> {
  const flushed = await runHostIptables(['-F', chain]);
  if (flushed !== 0) {
    throw new Error(`iptables -F ${chain} failed with exit code ${flushed}`);
  }

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
  await ensureRule('INPUT', ['-i', iface, '-j', 'DROP']);
  await removeLegacyFlatRules(iface);
  await ensureChain(chain);
  await ensureRule('DOCKER-USER', ['-i', iface, '!', '-o', iface, '-j', chain]);
  await populateChain(chain, policy);
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
}
