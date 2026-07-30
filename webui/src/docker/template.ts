import { randomBytes } from 'node:crypto';
import type Docker from 'dockerode';
import { docker } from './client.js';
import { ensureInstanceFirewall, removeInstanceFirewall, OPEN_EGRESS_POLICY } from './firewall.js';
import { execCapture } from './exec.js';
import { ensureOemAssets, ensureTelemetryDir, OEM_VOLUME_NAME } from './telemetry.js';
import { NETWORK_CAPTURE_PATH } from './networkCapture.js';
import type { CreateInstanceInput } from './validators.js';

// Pin by digest, not `:latest` — re-verify this against `docker inspect
// dockurr/windows` when intentionally bumping the base image; never let this
// float automatically.
export const IMAGE_REF =
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

// Plan item #9/#18's resolved decision: a per-instance scratch volume bound
// to dockur/windows' own built-in `/shared` mount (SAMBA=Y below), rather
// than any host-filesystem path — same "everything is a Docker volume, no
// host path dependency" posture as the main /storage disk. docker/files.ts
// reads/writes into it via short-lived helper containers, the same pattern
// firewall.ts uses for host iptables — it's never bind-mounted into the
// long-lived webui container itself.
export function sharedVolumeNameFor(instanceId: string): string {
  return `sbx-${instanceId}-shared`;
}

// A hard byte-for-byte allowlist of env vars this template will ever set.
// Everything else documented in windows/docs/environment.md — ARGUMENTS,
// COMMAND, DISK_OPTIONS, DISK_FLAGS, CPU_FLAGS, SM_BIOS, MONITOR, SERIAL,
// BIOS, DNSMASQ_OPTS, STORAGE, DHCP, GPU, VMX, SAMBA, etc. — is either pinned
// below to a fixed safe value or simply never set. None of it is ever derived
// from caller input. This is the actual code-execution surface identified
// during planning; treat any change here as security sensitive. (PASST_OPTS
// moved from "never set" to "pinned below" for plan item #17/#2/#3 — still a
// fixed value, never caller-derived.)
function buildEnv(input: CreateInstanceInput, accountPassword: string): string[] {
  return [
    `VERSION=${input.windowsVersion}`,
    `RAM_SIZE=${input.ramMb}M`,
    `CPU_CORES=${input.cpuCores}`,
    `DISK_SIZE=${input.diskGb}G`,
    'NETWORK=user', // usermode/passt QEMU networking — no guest L2 presence on the bridge
    // Plan item #17/#2/#3 (resolved 2026-07-29): passt's own traffic-capture
    // flag ("Log tap-facing traffic to pcap file", confirmed via `passt
    // --help` in the pulled dockurr/windows image), not a networking-mode
    // switch — NAT/tap mode was investigated and rejected, since it still
    // NATs guest traffic out through the container's single IP before
    // anything reaches the Docker bridge, no better a capture point than
    // passt already is. Written to the same reserved telemetry/ subfolder
    // #13's process collector uses (docker/networkCapture.ts's
    // NETWORK_CAPTURE_PATH) — ensureTelemetryDir below guarantees that
    // directory exists before this container (and therefore passt) starts.
    `PASST_OPTS=--pcap ${NETWORK_CAPTURE_PATH}`,
    'VMX=N', // no nested virtualization exposed to the guest
    'DHCP=N',
    'GPU=N',
    // Plan item #9/#18 (file upload, resolved 2026-07-28): turns on
    // dockur/windows' own built-in shared-folder feature, which surfaces the
    // /shared bind (added below in createInstanceContainer) as a desktop
    // shortcut + drive Z: inside the guest. This is real new attack surface
    // (a Samba server now runs inside the container) — accepted deliberately
    // in exchange for host-filesystem-independent file exchange; the
    // previous N here was the "viewer is the only path in" invariant, which
    // this change intentionally ends.
    'SAMBA=Y',
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
  await ensureVolume(sharedVolumeNameFor(target.id));
  // Plan item #17/#2/#3 — must run before the container is created: passt
  // opens its --pcap path once at container start, before Windows has even
  // booted, so the reserved telemetry/ subfolder needs to already exist on a
  // brand-new instance's very first boot (unlike the process collector,
  // which tolerates the folder not existing yet and just skips a cycle).
  await ensureTelemetryDir(sharedVolumeNameFor(target.id));
  // Plan item #13 — populates/refreshes the single shared OEM asset volume
  // (install.bat + collect-processes.ps1) bound read-only below. Called here
  // rather than once at webui startup so a webui upgrade that changes the
  // collector script reaches the very next instance created, with no
  // separate migration step.
  await ensureOemAssets();
  const network = await createInstanceNetwork(target.id);
  const netName = network.name;
  // Applied before the container is even created — the bridge interface
  // exists as soon as the network does, so this closes the window rather
  // than leaving it open until the next reconciler sweep. New instances
  // always start with egress open (plan item #16's policy is an opt-in
  // change a user makes after create, not a create-time setting) — needed
  // anyway for the Windows ISO fetch on first boot.
  await ensureInstanceFirewall(network.id, OPEN_EGRESS_POLICY);

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
      // /dev/net/tun was previously granted here on the belief that without
      // it, dockur/windows "silently falls back to user-mode (passt)
      // networking." That was stale: confirmed by reading the actual
      // (unvendored) windows/src/network.sh from the pulled dockurr/windows
      // image during plan item #17's investigation — /dev/net/tun is only
      // ever touched by configureNAT(), which only runs when isNAT()
      // matches, and isNAT() explicitly excludes "user" (this app's fixed
      // NETWORK= value above). Grepped every script in the image for
      // "dev/net/tun" to confirm network.sh is the only consumer before
      // removing this. Passt (the mode actually in use) needs no tun/tap
      // device at all — it operates entirely in userspace over a unix
      // socket. Not verified against a live boot with the device actually
      // removed (no /dev/kvm in this dev environment) — verify empirically
      // before relying on this if guest networking ever regresses.
      Devices: [
        {
          PathOnHost: '/dev/kvm',
          PathInContainer: '/dev/kvm',
          CgroupPermissions: 'rwm',
        },
      ],
      // Plan item #13 — dockur/windows copies whatever is bound at /oem to
      // C:\OEM on the install image and runs C:\OEM\install.bat at the final
      // step of unattended setup (windows/readme.md, confirmed against the
      // vendored windows/src/install.sh addFolder()). :ro since nothing
      // guest-side needs to write back into it — the collector's own state
      // lives on C:\ProgramData and its output goes to /shared instead (see
      // docker/telemetry.ts).
      Binds: [
        `${target.volumeName}:/storage`,
        `${sharedVolumeNameFor(target.id)}:/shared`,
        `${OEM_VOLUME_NAME}:/oem:ro`,
      ],
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
    // Tied to the same removeVolume flag as the main disk — "retain disk"
    // (plan item #19) is about keeping the OS install around, which the
    // shared scratch folder isn't; simplest to give it the same lifecycle
    // rather than invent a second independent retention choice for it.
    await docker.getVolume(sharedVolumeNameFor(opts.instanceId)).remove().catch((err: any) => {
      if (err.statusCode !== 404) throw err;
    });
  }
}

export async function inspectInstanceContainer(containerId: string) {
  return docker.getContainer(containerId).inspect();
}

export interface InstanceStats {
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
}

// Plan item #12 — no new instrumentation needed, Docker already tracks this
// per container. `stats({ stream: false })` isn't a single instantaneous
// sample despite the name: dockerd takes two samples ~1s apart internally
// and returns both (cpu_stats + precpu_stats), which is what makes the
// standard delta formula below meaningful rather than divide-by-zero on a
// single snapshot.
//
// Deliberately doesn't report disk usage — the guest's actual disk lives in
// a bind-mounted volume (`Binds: ["<volume>:/storage"]`, createInstanceContainer
// above), not the container's own writable layer, so `docker inspect --size`
// wouldn't reflect it. Getting real volume usage means inspecting the mount
// on the host (e.g. a `du` via a helper container, same pattern as
// firewall.ts) — out of scope for this pass.
export async function getInstanceStats(containerId: string): Promise<InstanceStats> {
  const stats: any = await docker.getContainer(containerId).stats({ stream: false });
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const numCpus = stats.cpu_stats.online_cpus ?? stats.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;
  return {
    cpuPercent,
    memUsageBytes: stats.memory_stats?.usage ?? 0,
    memLimitBytes: stats.memory_stats?.limit ?? 0,
  };
}

// Plan item #7 — live thumbnail preview. dockur/windows' own base image
// (qemux/qemu) always starts QEMU with an HMP monitor on a unix socket at
// $QEMU_DIR/monitor.sock (QEMU_DIR defaults to /run/shm — confirmed by
// pulling dockurr/windows and reading /run/config.sh + /run/reset.sh
// directly; not documented in windows/docs). HMP's `screendump` command
// dumps the current framebuffer to a PPM file inside the container — no
// extra capture infrastructure needed, just two `docker exec`s into the
// instance's own container using tools already present in the image
// (openbsd-nc for the unix-socket monitor command, python3+zlib — no PIL —
// for the PPM->PNG re-encode, since the image ships neither ImageMagick nor
// netpbm). Confirmed both are present in the pulled image before writing
// this.
const QEMU_MONITOR_SOCKET = '/run/shm/monitor.sock';
const SCREENSHOT_PPM_PATH = '/run/shm/sbx-screenshot.ppm';

// Pure-stdlib PPM(P6)->PNG encoder (zlib is always available in CPython,
// unlike PIL/ImageMagick/netpbm — none of which this image ships). Passed to
// `python3 -c` as a single exec Cmd array element, so no shell quoting is
// involved.
const PPM_TO_PNG_PY = `
import struct
import sys
import zlib

def read_ppm(path):
    with open(path, 'rb') as f:
        data = f.read()
    if not data[:2] == b'P6':
        raise SystemExit('not a P6 PPM')
    idx = 2
    vals = []
    while len(vals) < 3:
        while data[idx] in b' \\t\\r\\n':
            idx += 1
        if data[idx:idx + 1] == b'#':
            while data[idx] not in b'\\r\\n':
                idx += 1
            continue
        start = idx
        while data[idx] not in b' \\t\\r\\n':
            idx += 1
        vals.append(int(data[start:idx]))
    idx += 1  # single whitespace byte required by the format right after maxval
    width, height, _maxval = vals
    pixels = data[idx:idx + width * height * 3]
    if len(pixels) != width * height * 3:
        # The triggering exec's stability check should prevent this, but
        # cheap to double-check here rather than emit a PNG whose IHDR
        # promises more scanlines than IDAT actually holds.
        raise SystemExit('truncated PPM: expected %d pixel bytes, got %d' % (width * height * 3, len(pixels)))
    return width, height, pixels

def write_png(width, height, pixels):
    def chunk(tag, payload):
        return struct.pack('>I', len(payload)) + tag + payload + struct.pack('>I', zlib.crc32(tag + payload) & 0xffffffff)
    stride = width * 3
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 (None) per scanline
        raw.extend(pixels[y * stride:(y + 1) * stride])
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    out = b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b'')
    sys.stdout.buffer.write(out)

w, h, px = read_ppm('${SCREENSHOT_PPM_PATH}')
write_png(w, h, px)
`;

// Two execs, not one shell one-liner: keeps the nc/wait step (whose only job
// is to produce a file) and the python conversion step (whose stdout IS the
// response body) from sharing a single stdout stream, which would otherwise
// require careful separation of QEMU-monitor chatter from PNG bytes.
export async function captureInstanceScreenshot(containerId: string): Promise<Buffer> {
  const trigger = await execCapture(containerId, [
    'sh',
    '-c',
    // -q 1: close the nc connection ~1s after stdin EOF, giving QEMU's
    // monitor time to process the command before the socket is torn down.
    // `screendump` on a full 1080p framebuffer is several MB — HMP has no
    // "done" signal, so `-s file` (exists, non-empty) alone races a partial
    // write. Require the file size to read identical on two consecutive
    // polls 0.2s apart before treating it as complete.
    `rm -f ${SCREENSHOT_PPM_PATH}; printf 'screendump %s\\n' ${SCREENSHOT_PPM_PATH} | nc -U -q 1 ${QEMU_MONITOR_SOCKET}; ` +
      `prev=-1; for i in $(seq 1 40); do ` +
      `if [ -s ${SCREENSHOT_PPM_PATH} ]; then cur=$(wc -c < ${SCREENSHOT_PPM_PATH}); ` +
      `if [ "$cur" = "$prev" ]; then exit 0; fi; prev=$cur; fi; sleep 0.2; done; exit 1`,
  ]);
  if (trigger.exitCode !== 0) {
    throw new Error('screendump produced no stable file — instance may still be booting or the monitor socket is unavailable');
  }

  const convert = await execCapture(containerId, ['python3', '-c', PPM_TO_PNG_PY]);
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // Trust the payload over the exit code: exec.inspect() immediately after
  // the hijacked stream's 'end' can still report a stale/null ExitCode for
  // an otherwise-successful run. A real PNG magic header is the actual
  // source of truth for "did this work."
  if (!convert.stdout.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error(
      `screenshot conversion failed (exit ${convert.exitCode}): ${convert.stderr.toString('utf8').slice(0, 500)}`,
    );
  }

  await execCapture(containerId, ['rm', '-f', SCREENSHOT_PPM_PATH]).catch(() => {
    // Best-effort tmpfs cleanup — a leaked PPM is wasted memory-cgroup-backed
    // storage, not a correctness problem, so a failure here shouldn't fail
    // the whole capture.
  });

  return convert.stdout;
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
