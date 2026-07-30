import { nanoid } from 'nanoid';
import { docker } from './client.js';
import { execCapture, execWithStdin, withHelperContainer } from './exec.js';
import { db } from '../db/client.js';
import { processEvents } from '../db/schema.js';

const SHARED_MOUNT = '/shared';
const TELEMETRY_SUBDIR = 'telemetry';

// One volume, not per-instance — every guest gets byte-identical
// install.bat/collect-processes.ps1, so populate a single volume once and
// bind it read-only at /oem for every instance container (docker/template.ts),
// rather than duplicating the same two small files per instance.
export const OEM_VOLUME_NAME = 'sandbox-telemetry-oem';

// dockur/windows' own contract (windows/readme.md "How do I run a command
// after installation?", confirmed against the vendored windows/src/install.sh
// addFolder()): whatever is bound at /oem gets copied to C:\OEM on the
// install image, and C:\OEM\install.bat is executed at the final step of
// unattended setup. This is real SYSTEM-privileged code execution during
// setup — kept as a fixed, repo-authored constant, never built from any
// instance/user-supplied input, same discipline template.ts's buildEnv()
// comment calls for around this exact surface.
const INSTALL_BAT = `@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\OEM\\collect-processes.ps1" -Register
`;

// Deliberately poll-based (Win32_Process via WMI), not ETW/Sysmon — the
// lightest version that gets real process start/exit data without a driver
// install or code-signing story. Known limitation, accepted for this pass:
// a process that starts and exits entirely between two polls is invisible.
// Registers itself as a SYSTEM scheduled task (once, at install time via
// install.bat -Register) that re-invokes this same script every minute in
// poll mode.
//
// Events are appended as NDJSON to Z:\telemetry\processes-<bucket>.ndjson,
// bucketed into 5-minute windows by wall-clock time rather than tracked via
// any state shared with the host: docker/telemetry.ts's ingestion side
// independently computes the same "current bucket" and only ever reads+
// deletes buckets strictly in the past, so guest and host agree on which
// file is still being appended to without needing a handshake.
const COLLECT_PROCESSES_PS1 = `param([switch]$Register)

$ErrorActionPreference = 'Stop'
$StateDir = 'C:\\ProgramData\\SandboxTelemetry'
$StateFile = Join-Path $StateDir 'state.json'
$ShareDir = 'Z:\\telemetry'
$BucketMinutes = 5

function Get-Bucket {
    $epochMinutes = [long]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() / 60)
    return [math]::Floor($epochMinutes / $BucketMinutes) * $BucketMinutes
}

function Register-Telemetry {
    schtasks /create /tn "SandboxTelemetry" /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$PSCommandPath\`"" /sc minute /mo 1 /ru SYSTEM /f | Out-Null
    # Kick off an immediate first poll rather than waiting a full minute for
    # the first sample.
    schtasks /run /tn "SandboxTelemetry" | Out-Null
}

function Invoke-Poll {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

    $prev = @{}
    if (Test-Path $StateFile) {
        try {
            $raw = Get-Content $StateFile -Raw | ConvertFrom-Json
            foreach ($p in $raw.PSObject.Properties) { $prev[$p.Name] = $p.Value }
        } catch {
            $prev = @{}
        }
    }

    $current = @{}
    $events = New-Object System.Collections.Generic.List[string]
    $nowIso = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

    Get-CimInstance Win32_Process | ForEach-Object {
        $procId = [string]$_.ProcessId
        $current[$procId] = @{ ppid = $_.ParentProcessId; name = $_.Name; cmdline = $_.CommandLine }
        if (-not $prev.ContainsKey($procId)) {
            $events.Add((@{ ts = $nowIso; event = 'start'; pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmdline = $_.CommandLine } | ConvertTo-Json -Compress))
        }
    }

    foreach ($procId in $prev.Keys) {
        if (-not $current.ContainsKey($procId)) {
            $info = $prev[$procId]
            $events.Add((@{ ts = $nowIso; event = 'exit'; pid = [int]$procId; ppid = $info.ppid; name = $info.name; cmdline = $info.cmdline } | ConvertTo-Json -Compress))
        }
    }

    if ($events.Count -gt 0) {
        try {
            New-Item -ItemType Directory -Force -Path $ShareDir | Out-Null
            $bucket = Get-Bucket
            $target = Join-Path $ShareDir "processes-$bucket.ndjson"
            Add-Content -Path $target -Value $events -Encoding utf8
        } catch {
            # Z: not mounted yet (e.g. very first boot, Samba still coming
            # up) — skip this cycle's write. State below is still persisted
            # so the next successful cycle diffs from an accurate baseline
            # rather than re-reporting every already-running process as a
            # fresh "start".
        }
    }

    $current | ConvertTo-Json -Depth 4 | Set-Content -Path $StateFile -Encoding utf8
}

if ($Register) {
    Register-Telemetry
} else {
    Invoke-Poll
}
`;

// Idempotent and cheap (two small text files) — always overwrite rather than
// checking staleness first, so there's no second "is this already up to
// date" code path to keep in sync. Called from template.ts's
// createInstanceContainer before every create, so a webui upgrade that
// changes the collector script reaches the very next instance created,
// without a separate migration/deploy step.
export async function ensureOemAssets(): Promise<void> {
  await docker.createVolume({ Name: OEM_VOLUME_NAME }).catch((err: any) => {
    if (err.statusCode !== 409) throw err;
  });
  await withHelperContainer([`${OEM_VOLUME_NAME}:/oem`], async (containerId) => {
    const bat = await execWithStdin(containerId, ['sh', '-c', 'cat > /oem/install.bat'], Buffer.from(INSTALL_BAT, 'utf8'));
    if (bat.exitCode !== 0) {
      throw new Error(`failed to write install.bat: ${bat.stderr.toString('utf8').slice(0, 500)}`);
    }
    const ps1 = await execWithStdin(containerId, ['sh', '-c', 'cat > /oem/collect-processes.ps1'], Buffer.from(COLLECT_PROCESSES_PS1, 'utf8'));
    if (ps1.exitCode !== 0) {
      throw new Error(`failed to write collect-processes.ps1: ${ps1.stderr.toString('utf8').slice(0, 500)}`);
    }
  });
}

// Plan item #17/#2/#3 (passt --pcap network capture) — unlike the process
// collector above, which tolerates Z:\telemetry not existing yet and simply
// skips a poll cycle, passt opens its --pcap path once at container start,
// before Windows has even booted, let alone run any in-guest script. On a
// brand-new instance's first boot the reserved telemetry/ subfolder doesn't
// exist yet, so that open would fail — this ensures the directory exists
// BEFORE the container (and therefore passt) starts. Called from
// template.ts's createInstanceContainer, right after the shared volume
// itself is ensured.
export async function ensureTelemetryDir(sharedVolumeName: string): Promise<void> {
  await withHelperContainer([`${sharedVolumeName}:${SHARED_MOUNT}`], async (containerId) => {
    const result = await execCapture(containerId, ['mkdir', '-p', `${SHARED_MOUNT}/${TELEMETRY_SUBDIR}`]);
    if (result.exitCode !== 0) {
      throw new Error(`failed to create telemetry directory: ${result.stderr.toString('utf8').slice(0, 500)}`);
    }
  });
}

const BUCKET_MINUTES = 5;

function currentBucket(): number {
  return Math.floor(Date.now() / 1000 / 60 / BUCKET_MINUTES) * BUCKET_MINUTES;
}

interface ClosedFile {
  name: string;
  bucket: number;
}

// Only files whose bucket has fully elapsed are safe to consume — the guest
// only ever appends to the file matching *its* current bucket (see
// collect-processes.ps1), so anything with an older bucket number is closed
// for good. No shared state with the guest beyond wall-clock time.
async function listClosedTelemetryFiles(containerId: string): Promise<ClosedFile[]> {
  const dir = `${SHARED_MOUNT}/${TELEMETRY_SUBDIR}`;
  const result = await execCapture(containerId, [
    'sh',
    '-c',
    `for f in ${dir}/*.ndjson; do [ -e "$f" ] || continue; basename "$f"; done`,
  ]);
  if (result.exitCode !== 0) return [];

  const bucketNow = currentBucket();
  const files: ClosedFile[] = [];
  for (const name of result.stdout.toString('utf8').split('\n').filter(Boolean)) {
    const match = /^processes-(\d+)\.ndjson$/.exec(name);
    if (!match) continue;
    const bucket = Number(match[1]);
    if (bucket < bucketNow) files.push({ name, bucket });
  }
  return files;
}

interface ParsedEvent {
  ts: number;
  event: 'start' | 'exit';
  pid: number;
  ppid: number | null;
  name: string;
  cmdline: string | null;
}

function parseLine(line: string): ParsedEvent | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if ((obj.event !== 'start' && obj.event !== 'exit') || typeof obj.pid !== 'number' || typeof obj.name !== 'string' || typeof obj.ts !== 'string') {
    return null;
  }
  const tsMs = Date.parse(obj.ts);
  if (Number.isNaN(tsMs)) return null;
  return {
    ts: Math.floor(tsMs / 1000),
    event: obj.event,
    pid: obj.pid,
    ppid: typeof obj.ppid === 'number' ? obj.ppid : null,
    name: obj.name,
    cmdline: typeof obj.cmdline === 'string' ? obj.cmdline : null,
  };
}

// Reconciler-driven (reconciler/index.ts's ingestTelemetry), one instance at
// a time. Consume-and-delete, same as docker/files.ts's pattern elsewhere in
// this project: if the insert succeeds but the delete fails (helper
// container killed mid-cleanup), the same closed file is simply re-read and
// re-inserted next sweep. Duplicate telemetry rows are the failure mode, not
// data loss — acceptable for this data, not worth building dedup
// infrastructure for.
export async function ingestInstanceTelemetry(instanceId: string, sharedVolumeName: string): Promise<number> {
  return withHelperContainer([`${sharedVolumeName}:${SHARED_MOUNT}`], async (containerId) => {
    const closed = await listClosedTelemetryFiles(containerId);
    let inserted = 0;
    for (const file of closed) {
      const path = `${SHARED_MOUNT}/${TELEMETRY_SUBDIR}/${file.name}`;
      const read = await execCapture(containerId, ['cat', path]);
      if (read.exitCode === 0) {
        const rows = read.stdout
          .toString('utf8')
          .split('\n')
          .filter(Boolean)
          .map(parseLine)
          .filter((r): r is ParsedEvent => r !== null)
          .map((r) => ({
            id: nanoid(16),
            instanceId,
            ts: r.ts,
            event: r.event,
            pid: r.pid,
            ppid: r.ppid,
            name: r.name,
            cmdline: r.cmdline,
          }));
        if (rows.length > 0) {
          await db.insert(processEvents).values(rows);
          inserted += rows.length;
        }
      }
      await execCapture(containerId, ['rm', '-f', path]).catch(() => {});
    }
    return inserted;
  });
}

// Reserved name in the shared volume's top level — docker/files.ts's
// listSharedFiles/validators.ts's sharedFileNameSchema both exclude this so a
// user's own upload named "telemetry" can't collide with this subfolder.
export const TELEMETRY_RESERVED_NAME = TELEMETRY_SUBDIR;
