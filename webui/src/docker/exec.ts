import { Writable } from 'node:stream';
import type Docker from 'dockerode';
import { docker } from './client.js';

export interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

// exec.inspect() called immediately after the hijacked stream's 'end' event
// can still report a stale Running: true / null ExitCode for an exec that
// actually already finished — confirmed empirically (spiked against a real
// container: a write-then-read pair intermittently saw ExitCode null on a
// write that had, in fact, already succeeded and persisted). Poll until
// Docker itself reports the exec as no longer running before trusting
// ExitCode, rather than treating the first read as authoritative.
async function waitForExit(exec: Docker.Exec): Promise<number> {
  let info = await exec.inspect();
  let tries = 0;
  while (info.Running && tries < 50) {
    await new Promise((r) => setTimeout(r, 20));
    info = await exec.inspect();
    tries++;
  }
  return info.ExitCode ?? 1;
}

async function runExec(containerId: string, cmd: string[], input?: Buffer): Promise<ExecResult> {
  const exec = await docker.getContainer(containerId).exec({
    Cmd: cmd,
    AttachStdin: input !== undefined,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: input !== undefined });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdoutChunks.push(chunk);
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      stderrChunks.push(chunk);
      cb();
    },
  });
  docker.modem.demuxStream(stream, stdout, stderr);

  const ended = new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  // Only touch the write side when there's actually input to send — spiked
  // this empirically too: attaching stdin and immediately calling .end() on
  // an exec that has nothing to write is flaky (observed reads intermittently
  // come back truncated to 0 bytes when stdin is attached-but-unused), where
  // never attaching stdin at all is 100% reliable across repeated runs.
  if (input !== undefined) {
    stream.write(input);
    stream.end();
  }

  await ended;
  const exitCode = await waitForExit(exec);
  return { stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks), exitCode };
}

export async function execCapture(containerId: string, cmd: string[]): Promise<ExecResult> {
  return runExec(containerId, cmd);
}

export async function execWithStdin(containerId: string, cmd: string[], input: Buffer): Promise<ExecResult> {
  return runExec(containerId, cmd, input);
}
