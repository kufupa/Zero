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

if (!hasPnpm) {
  console.error('pnpm was not found on PATH. Install pnpm and rerun this command.');
  process.exit(1);
}

const cmd = 'pnpm --dir apps/mail run dev';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backendUrl = process.env.VITE_PUBLIC_BACKEND_URL || 'http://localhost:8787';
const backendProbeUrl = `${backendUrl.replace(/\/$/, '')}/api/public/providers`;

const isBackendReachable = async () => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    await fetch(backendProbeUrl, { method: 'GET', signal: controller.signal });
    clearTimeout(timeout);
    return true;
  } catch {
    return false;
  }
};

const backendCmd = 'pnpm --dir apps/server run dev';

const startBackendIfNeeded = async (baseEnv) => {
  if (process.env.ZERO_AUTO_START_BACKEND === '0') return isBackendReachable();
  if (process.env.ZERO_AUTO_START_BACKEND === '1' || forceFull) {
    if (await isBackendReachable()) return true;
    console.log(`[local-dev] Backend not reachable at ${backendUrl}, attempting to start apps/server...`);
    return startServerProcess(baseEnv);
  }

  return isBackendReachable();
};

const startServerProcess = async (baseEnv) => {
  const backend = spawn(backendCmd, {
    shell: true,
    stdio: 'ignore',
    detached: true,
    env: baseEnv,
  });
  backend.unref();

  for (let i = 0; i < 30; i++) {
    await wait(1000);
    if (await isBackendReachable()) {
      console.log('[local-dev] Backend is up.');
      return true;
    }
  }

  return false;
};

const env = { ...process.env };
env.VITE_DISABLE_AUTUMN = '1';
env.VITE_DISABLE_SENTRY = '1';

const backendReachable = forceFrontendOnly
  ? false
  : await startBackendIfNeeded(env);
env.VITE_FRONTEND_ONLY = forceFrontendOnly ? '1' : backendReachable ? '0' : '1';

const child = spawnSync(cmd, { shell: true, stdio: 'inherit', env });

if (child.error) {
  console.error(child.error.message);
  process.exit(1);
}

process.exit(child.status ?? 1);
