import { docker } from './client.js';
import { execCapture, execWithStdin } from './exec.js';

// Reuses the same locally-built helper image firewall.ts spawns (see
// webui/firewall-helper/Dockerfile + the manual build step in compose.yml)
// — it's already alpine, already a required deploy step, and the file
// operations below never invoke its `iptables` entrypoint at all (overridden
// to a plain `sleep` below so the container has something to keep running
// while exec'd into). Not worth a second image/build step just for a label.
const FILE_HELPER_IMAGE = process.env.FIREWALL_HELPER_IMAGE ?? 'sandbox-firewall-helper:latest';
const SHARED_MOUNT = '/shared';

// One upload's worth. Multipart itself also caps this (api/files.ts) — this
// second check guards the total-folder cap below from being bypassed by
// many uploads just under the multipart limit.
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
// Total shared-folder size per instance. No per-tier knob for this yet
// (plan item #14's resource_tiers table doesn't cover it) — a fixed,
// generous-but-bounded cap so this new surface can't silently fill the host
// disk one upload at a time.
export const MAX_SHARED_FOLDER_BYTES = 2 * 1024 * 1024 * 1024;

export interface SharedFileEntry {
  name: string;
  size: number;
  mtimeSeconds: number;
}

async function withSharedVolumeContainer<T>(sharedVolumeName: string, fn: (containerId: string) => Promise<T>): Promise<T> {
  const container = await docker.createContainer({
    Image: FILE_HELPER_IMAGE,
    // Overrides the image's own `ENTRYPOINT ["iptables"]` (firewall.ts's
    // use) — `docker exec` requires a running container, and plain
    // `iptables` with no args exits immediately. 300s is just a safety net
    // in case removal below is ever skipped by a crash; every call path
    // force-removes explicitly rather than relying on this timeout.
    Entrypoint: ['sleep'],
    Cmd: ['300'],
    HostConfig: { Binds: [`${sharedVolumeName}:${SHARED_MOUNT}`] },
  });
  await container.start();
  try {
    return await fn(container.id);
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

export async function listSharedFiles(sharedVolumeName: string): Promise<SharedFileEntry[]> {
  return withSharedVolumeContainer(sharedVolumeName, async (containerId) => {
    // busybox's `stat -c` doesn't interpret `\t` escapes the way GNU
    // coreutils does (confirmed empirically — it prints a literal
    // backslash-t) — use `printf` for the actual formatting instead, which
    // both busybox and coreutils interpret correctly. The `for f in dir/*`
    // + `[ -e "$f" ]` guard is the standard POSIX idiom for "handle an empty
    // directory without a glob match" (also confirmed empirically: a
    // non-matching glob left as a literal string just fails -e cleanly).
    const result = await execCapture(containerId, [
      'sh',
      '-c',
      `for f in ${SHARED_MOUNT}/*; do [ -e "$f" ] || continue; ` +
        `printf '%s\\t%s\\t%s\\n' "$(basename "$f")" "$(stat -c '%s' "$f")" "$(stat -c '%Y' "$f")"; done`,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`failed to list shared files: ${result.stderr.toString('utf8').slice(0, 500)}`);
    }
    return result.stdout
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, size, mtime] = line.split('\t');
        return { name, size: Number(size), mtimeSeconds: Math.floor(Number(mtime)) };
      });
  });
}

async function sharedFolderTotalBytes(containerId: string): Promise<number> {
  const result = await execCapture(containerId, [
    'sh',
    '-c',
    `total=0; for f in ${SHARED_MOUNT}/*; do [ -e "$f" ] || continue; ` +
      `total=$((total + $(stat -c '%s' "$f"))); done; echo "$total"`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`failed to sum shared folder size: ${result.stderr.toString('utf8').slice(0, 500)}`);
  }
  return Number(result.stdout.toString('utf8').trim() || '0');
}

// Filename reaches the shell as a positional arg ($1), never interpolated
// into the script text — sh -c 'script' "$0" "$1" is the standard pattern
// for passing untrusted values to a shell command without any risk of the
// value itself being parsed as shell syntax. This does NOT protect against
// path traversal via a literal ".." component (quoting a value doesn't stop
// the OS from following ".." in the resulting path) — that's why
// api/files.ts's schema rejects "/", "\", and ".." before any of this runs.
export async function uploadSharedFile(sharedVolumeName: string, filename: string, data: Buffer): Promise<void> {
  if (data.length > MAX_FILE_BYTES) {
    throw new Error(`file exceeds the ${MAX_FILE_BYTES} byte limit`);
  }
  await withSharedVolumeContainer(sharedVolumeName, async (containerId) => {
    const existingTotal = await sharedFolderTotalBytes(containerId);
    if (existingTotal + data.length > MAX_SHARED_FOLDER_BYTES) {
      throw new Error(`shared folder is at its ${MAX_SHARED_FOLDER_BYTES} byte limit for this instance`);
    }
    const result = await execWithStdin(containerId, ['sh', '-c', `cat > "${SHARED_MOUNT}/$1"`, 'sh', filename], data);
    if (result.exitCode !== 0) {
      throw new Error(`upload failed: ${result.stderr.toString('utf8').slice(0, 500)}`);
    }
  });
}

export async function downloadSharedFile(sharedVolumeName: string, filename: string): Promise<Buffer> {
  return withSharedVolumeContainer(sharedVolumeName, async (containerId) => {
    const result = await execCapture(containerId, ['sh', '-c', `cat "${SHARED_MOUNT}/$1"`, 'sh', filename]);
    if (result.exitCode !== 0) {
      throw new Error(`download failed: ${result.stderr.toString('utf8').slice(0, 500)}`);
    }
    return result.stdout;
  });
}

export async function deleteSharedFile(sharedVolumeName: string, filename: string): Promise<void> {
  await withSharedVolumeContainer(sharedVolumeName, async (containerId) => {
    const result = await execCapture(containerId, ['sh', '-c', `rm -f -- "${SHARED_MOUNT}/$1"`, 'sh', filename]);
    if (result.exitCode !== 0) {
      throw new Error(`delete failed: ${result.stderr.toString('utf8').slice(0, 500)}`);
    }
  });
}
