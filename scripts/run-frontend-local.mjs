#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const has = (bin) => {
  const check = spawnSync(`${bin} --version`, { shell: true, stdio: 'ignore' });
  return check.status === 0;
};

const hasPnpm = has('pnpm');
const cliArgs = new Set(process.argv.slice(2));
const forceFrontendOnly = cliArgs.has('--frontend-only') || cliArgs.has('--no-backend');
const forceFull = cliArgs.has('--full');
const demoFrontendOnly = process.env.ZERO_DEMO_MODE === '1' && process.env.ZERO_DEMO_FRONTEND_ONLY !== '0';

if (!hasPnpm) {
  console.error('pnpm was not found on PATH. Install pnpm and rerun this command.');
  process.exit(1);
}

const cmd = 'pnpm --dir apps/mail run dev';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backendUrl = process.env.VITE_PUBLIC_BACKEND_URL || 'http://localhost:8787';
const backendProbeUrl = `${backendUrl.replace(/\/$/, '')}/api/public/providers`;

let backendProcess = null;
let shutdownHandlersInstalled = false;

const stopBackend = () => {
  if (!backendProcess || backendProcess.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(backendProcess.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      spawnSync('kill', ['-TERM', String(backendProcess.pid)], { stdio: 'ignore' });
    } catch {
      try {
        backendProcess.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }
  backendProcess = null;
};

const installShutdownHandlers = () => {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  const shutdown = (code = 0) => {
    stopBackend();
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('exit', () => stopBackend());
};

const isBackendReachable = async () => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(backendProbeUrl, { method: 'GET', signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
};

const backendCmd = 'pnpm --dir apps/server run dev';

const startServerProcess = async (baseEnv) => {
  installShutdownHandlers();
  backendProcess = spawn(backendCmd, {
    shell: true,
    stdio: 'ignore',
    detached: false,
    env: baseEnv,
  });

  const attempts = Math.max(
    1,
    Number.parseInt(process.env.ZERO_BACKEND_PROBE_ATTEMPTS ?? '', 10) || 120,
  );
  for (let i = 0; i < attempts; i++) {
    await wait(1000);
    if (await isBackendReachable()) {
      console.log('[local-dev] Backend is up.');
      return true;
    }
  }

  stopBackend();
  return false;
};

const startBackendIfNeeded = async (baseEnv) => {
  if (process.env.ZERO_AUTO_START_BACKEND === '1' || forceFull) {
    if (await isBackendReachable()) return true;
    console.log(`[local-dev] Backend not reachable at ${backendUrl}, attempting to start apps/server...`);
    return startServerProcess(baseEnv);
  }
  if (process.env.ZERO_AUTO_START_BACKEND === '0') return isBackendReachable();

  return isBackendReachable();
};

const env = { ...process.env };
env.VITE_DISABLE_SENTRY = '1';
const runFrontendOnly = forceFrontendOnly || (demoFrontendOnly && !forceFull);

if (demoFrontendOnly && !forceFull) {
  console.log('[local-dev] FE-only demo mode active; skipping backend startup.');
}

const backendReachable = runFrontendOnly ? false : await startBackendIfNeeded(env);
env.VITE_FRONTEND_ONLY = runFrontendOnly ? '1' : backendReachable ? '0' : '1';

const child = spawnSync(cmd, { shell: true, stdio: 'inherit', env });

stopBackend();

if (child.error) {
  console.error(child.error.message);
  process.exit(1);
}

process.exit(child.status ?? 1);
