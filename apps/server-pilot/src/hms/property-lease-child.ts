import { spawn, type SpawnOptions } from 'node:child_process';

type LeaseChildOptions = Pick<SpawnOptions, 'cwd' | 'env' | 'uid' | 'gid' | 'windowsHide'> & {
  timeout?: number;
  maxBuffer?: number;
};

/**
 * Run an owned child in its own process group. A lost lease kills that group
 * synchronously, then waits for the child and its inherited pipes to close.
 */
export function execFileWithPropertyLease(
  file: string,
  args: readonly string[],
  options: LeaseChildOptions,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  if (process.platform === 'win32') throw new Error('property lease child requires process groups');
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('property lease lost'));
  const { timeout = 0, maxBuffer = 1_048_576, ...spawnOptions } = options;
  if (!Number.isFinite(timeout) || timeout < 0 || !Number.isSafeInteger(maxBuffer) || maxBuffer < 0) {
    throw new Error('invalid child limits');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      ...spawnOptions, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let terminationFailure: unknown;
    let childFailure: Error | undefined;
    let outputFailure: Error | undefined;
    let waitingForSpawn = false;
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const lengths = { stdout: 0, stderr: 0 };

    const terminate = () => {
      if (!child.pid) {
        if (!waitingForSpawn) {
          waitingForSpawn = true;
          child.once('spawn', () => { waitingForSpawn = false; terminate(); });
        }
        return;
      }
      try {
        // Descendants can outlive the group leader and keep its pipes open.
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
        terminationFailure = error;
        // Keep waiting for close even if signaling failed; never release merely
        // because a promise rejected while the child may still be alive.
        try { child.kill('SIGKILL'); } catch { /* close still owns completion */ }
      }
    };
    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const remaining = Math.max(0, maxBuffer - lengths[stream]);
      if (remaining) output[stream].push(chunk.subarray(0, remaining));
      lengths[stream] += chunk.length;
      if (lengths[stream] > maxBuffer && !outputFailure) {
        outputFailure = Object.assign(new Error(`property lease child ${stream} exceeded maxBuffer`), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
        terminate();
      }
    };
    const captureError = (error: Error) => { outputFailure ??= error; terminate(); };
    child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk));
    child.stdout.on('error', captureError);
    child.stderr.on('error', captureError);
    child.once('error', (error) => { childFailure = error; });
    child.once('close', (code, exitSignal) => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', terminate);
      const stdout = Buffer.concat(output.stdout).toString('utf8');
      const stderr = Buffer.concat(output.stderr).toString('utf8');
      if (terminationFailure) {
        reject(Object.assign(new Error('property lease child group stop unconfirmed'), {
          code: 'PROPERTY_LEASE_CHILD_STOP_UNCONFIRMED', cause: terminationFailure,
        }));
      } else if (signal.aborted) {
        reject(signal.reason ?? new Error('property lease lost'));
      } else if (timedOut) {
        reject(Object.assign(new Error('property lease child timed out'), { code: 'CHILD_TIMEOUT' }));
      } else if (outputFailure || childFailure) {
        reject(Object.assign(outputFailure ?? childFailure!, { stdout, stderr }));
      } else if (code !== 0 || exitSignal) {
        reject(Object.assign(new Error('property lease child failed'), {
          code, signal: exitSignal, stdout, stderr,
        }));
      } else {
        resolve({ stdout, stderr });
      }
    });
    signal.addEventListener('abort', terminate, { once: true });
    if (signal.aborted) terminate();
    if (timeout > 0) {
      timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
    }
  });
}
