import { randomBytes } from 'node:crypto';
import type Docker from 'dockerode';
import { docker } from './client.js';
import { ensureInstanceFirewall, removeInstanceFirewall } from './firewall.js';
import type { CreateInstanceInput } from './validators.js';

// Pin by digest, not `:latest` — re-verify this against `docker inspect
// dockurr/windows` when intentionally bumping the base image; never let this
// float automatically.
const IMAGE_REF =
  process.env.SANDBOX_IMAGE_REF ??
  'dockurr/windows@sha256:743847e75b776790c059f33ac6654f84727ba36a6d458a61e37cb2b2f043d168';

// The webui's own container name, so it can join each instance's dedicated
// network (see networkNameFor below). Must match the `container_name:` this
// service is deployed under (or --name in dev). Validated at app startup in
// index.ts — fail loudly there rather than surfacing a confusing dockerode
// error on the first instance create.
export const SELF_CONTAINER_NAME = process.env.SELF_CONTAINER_NAME ?? '';

function networkNameFor(instanceId: string): string {
  return `sbx-${instanceId}-net`;
}

// A hard byte-for-byte allowlist of env vars this template will ever set.
// Everything else documented in windows/docs/environment.md — ARGUMENTS,
// COMMAND, DISK_OPTIONS, DISK_FLAGS, CPU_FLAGS, SM_BIOS, MONITOR, SERIAL,
// BIOS, DNSMASQ_OPTS, PASST_OPTS, STORAGE, DHCP, GPU, VMX, SAMBA, etc. — is
// either pinned below to a fixed safe value or simply never set. None of it
// is ever derived from caller input. This is the actual code-execution
// surface identified during planning; treat any change here as security
// sensitive.
function buildEnv(input: CreateInstanceInput, accountPassword: string): string[] {
  return [
    `VERSION=${input.windowsVersion}`,
    `RAM_SIZE=${input.ramMb}M`,
    `CPU_CORES=${input.cpuCores}`,
    `DISK_SIZE=${input.diskGb}G`,
    'NETWORK=user', // usermode/passt QEMU networking — no guest L2 presence on the bridge
    'VMX=N', // no nested virtualization exposed to the guest
    'DHCP=N',
    'GPU=N',
    'SAMBA=N',
    'RAM_CHECK=Y',
    'WEB=Y',
    // PROTECT=Y (HTTP Basic Auth on the container's own web viewer, realm
    // "NoVNC") was tried and rejected — confirmed empirically that it 401s
    // our own proxy's requests, since the proxy never forwards that
    // credential. It adds no real security here: the container is
    // unreachable by anyone except this webui's own proxy in the first place
    // (no published ports, isolated per-instance network — see docker
    // network model note above), which is the actual access boundary.
    // PASSWORD below is set only for the Windows account itself (used by
    // AUTOLOGIN), not for gating the viewer.
    `PASSWORD=${accountPassword}`,
  ];
}

export interface InstanceTarget {
  id: string;
  ownerId: string;
  containerName: string;
  volumeName: string;
}

export async function ensureVolume(volumeName: string): Promise<void> {
  await docker.createVolume({ Name: volumeName }).catch((err: any) => {
    // 409 = already exists, fine or from a previous crashed attempt
    if (err.statusCode !== 409) throw err;
  });
}

// Each instance gets its OWN bridge network, not a network shared by every
// tenant. This was not the original design — a single shared bridge with
// `enable_icc=false` was tried first and confirmed EMPIRICALLY to also block
// this webui's own proxy from reaching sandbox containers (icc=false blocks
// ALL inter-container traffic on that bridge uniformly; there is no allowlist
// for "trusted proxy yes, sibling tenant no"). One network per instance,
// joined only by that instance's container and this webui container, gives
// the same isolation structurally (tenants are never on a network together
// at all) while keeping the trusted path open. Not `internal: true` for
// either design — dockur/windows fetches the Windows ISO from Microsoft on
// first boot, so a fully airgapped network hangs every install.
//
// Requires `default-address-pools` to be widened in the Docker daemon config
// — the built-in pool only supports ~30 user-defined networks total and a
// per-instance model exhausts that almost immediately (confirmed
// empirically: creation started failing at the 30th network). See the plan's
// Local Dev Environment section for the daemon.json change this required.
async function createInstanceNetwork(instanceId: string): Promise<{ name: string; id: string }> {
  const netName = networkNameFor(instanceId);
  await docker.createNetwork({ Name: netName, Driver: 'bridge' }).catch((err: any) => {
    if (err.statusCode !== 409) throw err;
  });
  // Fetch the Id regardless of whether this call just created the network or
  // hit the 409-already-exists path (a retried create) — either way we need
  // it to derive the bridge interface name for firewall.ts.
  const { Id } = await docker.getNetwork(netName).inspect();
  return { name: netName, id: Id };
}

async function joinSelfToNetwork(netName: string): Promise<void> {
  if (!SELF_CONTAINER_NAME) {
    throw new Error('SELF_CONTAINER_NAME is not set — cannot join instance network');
  }
  await docker
    .getNetwork(netName)
    .connect({ Container: SELF_CONTAINER_NAME })
    .catch((err: any) => {
      // already connected — fine (can happen on a retried create)
      if (err.statusCode !== 403) throw err;
    });
}

async function leaveSelfAndRemoveNetwork(netName: string): Promise<void> {
  const network = docker.getNetwork(netName);
  // Firewall rules are keyed by network Id (see firewall.ts), so fetch it
  // before the network itself is gone — inspect() 404s if a previous crashed
  // teardown already removed it, in which case the rules are moot too.
  const info = await network.inspect().catch((err: any) => {
    if (err.statusCode === 404) return null;
    throw err;
  });
  if (info) {
    await removeInstanceFirewall(info.Id);
  }
  await network
    .disconnect({ Container: SELF_CONTAINER_NAME, Force: true })
    .catch((err: any) => {
      if (err.statusCode !== 404 && err.statusCode !== 500) throw err;
    });
  await network.remove().catch((err: any) => {
    if (err.statusCode !== 404) throw err;
  });
}

export async function createInstanceContainer(
  target: InstanceTarget,
  input: CreateInstanceInput,
): Promise<{ containerId: string; accountPassword: string }> {
  await ensureVolume(target.volumeName);
  const network = await createInstanceNetwork(target.id);
  const netName = network.name;
  // Applied before the container is even created — the bridge interface
  // exists as soon as the network does, so this closes the window rather
  // than leaving it open until the next reconciler sweep. New instances
  // always start with egress open (plan item #23 is an opt-in toggle a user
  // flips after create, not a create-time setting).
  await ensureInstanceFirewall(network.id, { blockEgress: false });

  const accountPassword = randomBytes(18).toString('base64url');

  const createOptions: Docker.ContainerCreateOptions = {
    name: target.containerName,
    Image: IMAGE_REF,
    Env: buildEnv(input, accountPassword),
    Labels: {
      'sandbox.instance_id': target.id,
      'sandbox.owner_id': target.ownerId,
      'sandbox.network': netName,
    },
    HostConfig: {
      Memory: input.ramMb * 1024 * 1024,
      MemorySwap: input.ramMb * 1024 * 1024, // equal to Memory — blocks swap-based escape of the cap
      NanoCpus: input.cpuCores * 1_000_000_000,
      CapDrop: ['ALL'],
      // Confirmed empirically — NET_ADMIN alone is NOT sufficient; the
      // container's own nginx/websockify web-viewer stack fails to start
      // under cap_drop:ALL without also restoring these four. The failure
      // chain, in the order it was hit while narrowing this down:
      //   1. missing CHOWN       -> chown("/var/lib/nginx/body") EPERM, server.sh exits 1
      //   2. missing DAC_OVERRIDE -> open("/var/log/nginx/error.log") EACCES
      //   3. missing SETGID/SETUID -> nginx worker setgid(33) EPERM, master
      //      has no worker and never actually serves anything (connections
      //      just hang — no error, no listener)
      // All five are required together; do not narrow this back down without
      // re-verifying the web viewer actually serves content end-to-end.
      CapAdd: ['NET_ADMIN', 'CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETUID'],
      SecurityOpt: ['no-new-privileges'],
      PidsLimit: 512,
      Devices: [
        {
          PathOnHost: '/dev/kvm',
          PathInContainer: '/dev/kvm',
          CgroupPermissions: 'rwm',
        },
      ],
      Binds: [`${target.volumeName}:/storage`],
      NetworkMode: netName,
      // Reconciler owns lifecycle decisions, not Docker's own restart
      // policy — a permanently-broken instance (bad template, host resource
      // exhaustion) must not restart-loop and burn host CPU/log volume
      // forever. Confirmed this bites in practice: an earlier
      // `unless-stopped` test spun a failing container in a tight restart
      // loop until stopped manually.
      RestartPolicy: { Name: 'no' },
      // No PortBindings — never published to the host; reached only via the
      // internal proxy, over this instance's dedicated network, by
      // container name.
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [netName]: {},
      },
    },
  };

  const container = await docker.createContainer(createOptions);
  await joinSelfToNetwork(netName);
  return { containerId: container.id, accountPassword };
}

export async function startInstanceContainer(containerId: string): Promise<void> {
  await docker.getContainer(containerId).start();
}

export async function stopInstanceContainer(containerId: string): Promise<void> {
  // Grace period matches windows/compose.yml's stop_grace_period so
  // SHUTDOWN=Y gets a real ACPI shutdown instead of a hard kill.
  await docker.getContainer(containerId).stop({ t: 120 });
}

export async function removeInstanceContainer(
  containerId: string,
  opts: { instanceId: string; removeVolume: boolean; volumeName: string },
): Promise<void> {
  await docker.getContainer(containerId).remove({ force: true });
  await leaveSelfAndRemoveNetwork(networkNameFor(opts.instanceId));
  if (opts.removeVolume) {
    await docker.getVolume(opts.volumeName).remove().catch((err: any) => {
      if (err.statusCode !== 404) throw err;
    });
  }
}

export async function inspectInstanceContainer(containerId: string) {
  return docker.getContainer(containerId).inspect();
}

export async function tailInstanceLogs(containerId: string, sinceSeconds = 60) {
  return docker.getContainer(containerId).logs({
    stdout: true,
    stderr: true,
    tail: 200,
    since: Math.floor(Date.now() / 1000) - sinceSeconds,
  });
}

// The container was created without Tty (see createInstanceContainer), so
// .logs() returns Docker's multiplexed stream format — each frame is an
// 8-byte header (1-byte stream type, 3 reserved, 4-byte big-endian payload
// length) followed by the payload, not plain text. Strip the headers before
// this ever reaches a caller, or every consumer downstream sees binary noise
// mixed into the log text.
export function demuxDockerLogs(buffer: Buffer): string {
  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) break;
    parts.push(buffer.subarray(start, end).toString('utf8'));
    offset = end;
  }
  return parts.join('');
}

export { networkNameFor };
