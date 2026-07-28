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

// RFC1918 private ranges + link-local (covers cloud metadata endpoints like
// 169.254.169.254, and any other bridge/LAN segment reachable through the
// host's routing table). General internet access is deliberately left open —
// dockur/windows fetches the Windows ISO from Microsoft on first boot, so a
// default-deny egress policy would hang every install (see docker/template.ts
// createInstanceNetwork comment).
const BLOCKED_EGRESS_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'];

// The webui container deliberately has no NET_ADMIN or host netns of its own
// (see compose.yml) — only Docker-socket access. Rather than widen the webui
// container's own privileges, spin up a short-lived helper container with
// --net=host --cap-add=NET_ADMIN via that same socket to run one iptables
// invocation against the host's real netfilter tables, then exit. Confirmed
// empirically that -C/-I/-D behave as expected (exit 1 when a rule is
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

// Two distinct gaps closed here (plan item #1):
//
// 1. Sandbox container -> host. Traffic a container sends to its own bridge
//    gateway IP terminates at the host, so it's the INPUT chain, not
//    FORWARD/DOCKER-USER — Docker's own filtering never touches INPUT.
//    Nothing on this bridge has a legitimate reason to reach the host itself
//    (the webui always initiates the viewer connection, never the reverse —
//    see template.ts), so this is a blanket drop.
//
// 2. Sandbox container -> other private networks (LAN, other docker bridges,
//    cloud metadata). This traffic terminates elsewhere, routed through the
//    host, so it's FORWARD — DOCKER-USER is the right hook (survives the
//    daemon reinserting its own chains, unlike raw FORWARD rules). Scoped to
//    `! -o <this bridge>` so the webui<->sandbox proxy path, which is
//    same-bridge-in/same-bridge-out traffic, is untouched — a shared-bridge
//    icc=false rule blocking exactly this path is what got rejected in
//    template.ts's network design; this rule must not repeat that mistake.
export async function ensureInstanceFirewall(networkId: string): Promise<void> {
  const iface = bridgeInterfaceName(networkId);
  await ensureRule('INPUT', ['-i', iface, '-j', 'DROP']);
  for (const cidr of BLOCKED_EGRESS_CIDRS) {
    await ensureRule('DOCKER-USER', ['-i', iface, '!', '-o', iface, '-d', cidr, '-j', 'DROP']);
  }
}

export async function removeInstanceFirewall(networkId: string): Promise<void> {
  const iface = bridgeInterfaceName(networkId);
  await removeRule('INPUT', ['-i', iface, '-j', 'DROP']);
  for (const cidr of BLOCKED_EGRESS_CIDRS) {
    await removeRule('DOCKER-USER', ['-i', iface, '!', '-o', iface, '-d', cidr, '-j', 'DROP']);
  }
}
