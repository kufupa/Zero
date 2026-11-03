import type { ChildProcess } from 'node:child_process';

// The fixture starts this child in its own process group. Do not leave its
// lock waiter behind if the command or an assertion hangs.
export async function waitForOwnedProcess(child: ChildProcess, exit: Promise<number | null>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exit,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
          }
          reject(new Error('owned fixture process did not exit'));
        }, 6_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
