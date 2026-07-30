import { execCapture, withHelperContainer } from './exec.js';
import { TELEMETRY_RESERVED_NAME } from './telemetry.js';

const SHARED_MOUNT = '/shared';
const CAPTURE_FILENAME = 'network.pcap';

// Plan item #17/#2/#3 — resolved decision (2026-07-29): passt's own
// `--pcap FILE` flag ("Log tap-facing traffic to pcap file", confirmed via
// `passt --help` in the pulled dockurr/windows image) rather than switching
// networking modes. This is the exact container-internal path
// docker/template.ts's PASST_OPTS tells passt to write to, inside the same
// reserved telemetry/ subfolder #13's process collector uses — exported so
// the two never drift apart.
export const NETWORK_CAPTURE_PATH = `${SHARED_MOUNT}/${TELEMETRY_RESERVED_NAME}/${CAPTURE_FILENAME}`;

export interface NetworkCaptureInfo {
  sizeBytes: number;
  mtimeSeconds: number;
}

// No ingestion or rotation here, unlike #13's process events — passt's pcap
// output has no per-record boundary meaningful to parse into structured DB
// rows; the useful consumption model is "download the file, open it in
// Wireshark," so this module only ever stats/reads what passt already wrote,
// never mutates it. Deliberately NOT truncating or rotating the live file:
// passt holds its own file descriptor open for the container's entire
// lifetime, and externally truncating a file out from under an open writer
// doesn't reset that writer's own offset — its next write would land wherever
// it left off, leaving a zeroed gap followed by orphaned record bytes with no
// valid pcap global header at the start of the file. Growth is bounded only
// by the instance's own idle-timeout/max-lifetime reaping, not by any cap
// this module enforces — a known, accepted limitation (matches #9's/#15's
// "no per-tier knob for this yet" scoping).
export async function getNetworkCaptureInfo(sharedVolumeName: string): Promise<NetworkCaptureInfo | null> {
  return withHelperContainer([`${sharedVolumeName}:${SHARED_MOUNT}`], async (containerId) => {
    const result = await execCapture(containerId, [
      'sh',
      '-c',
      `[ -f "${NETWORK_CAPTURE_PATH}" ] && stat -c '%s\t%Y' "${NETWORK_CAPTURE_PATH}"`,
    ]);
    if (result.exitCode !== 0) return null;
    const [size, mtime] = result.stdout.toString('utf8').trim().split('\t');
    if (!size) return null;
    return { sizeBytes: Number(size), mtimeSeconds: Math.floor(Number(mtime)) };
  });
}

export async function downloadNetworkCapture(sharedVolumeName: string): Promise<Buffer> {
  return withHelperContainer([`${sharedVolumeName}:${SHARED_MOUNT}`], async (containerId) => {
    const result = await execCapture(containerId, ['cat', NETWORK_CAPTURE_PATH]);
    if (result.exitCode !== 0) {
      throw new Error(`network capture not available: ${result.stderr.toString('utf8').slice(0, 500)}`);
    }
    return result.stdout;
  });
}
