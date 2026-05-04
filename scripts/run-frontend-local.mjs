#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const has = (bin) => {
  const check = spawnSync(`${bin} --version`, { shell: true, stdio: 'ignore' });
  return check.status === 0;
};

const hasPnpm = has('pnpm');
const cliArgs = new Set(process.argv.slice(2));
const forceHosted = cliArgs.has('--hosted');
const forceFrontendOnly = cliArgs.has('--frontend-only') || cliArgs.has('--no-backend');
const forceFull = cliArgs.has('--full');
const isDemoFrontendOnlyArg = cliArgs.has('--demo-frontend-only');
if (!forceHosted && (isDemoFrontendOnlyArg || forceFrontendOnly)) {
  process.env.ZERO_DEMO_MODE = '1';
  process.env.ZERO_DEMO_FRONTEND_ONLY = '1';
}
const demoFrontendOnly =
  process.env.ZERO_DEMO_MODE === '1' && process.env.ZERO_DEMO_FRONTEND_ONLY !== '0';

if (!hasPnpm) {
  console.error('pnpm was not found on PATH. Install pnpm and rerun this command.');
  process.exit(1);
}

const cmd = 'pnpm --dir apps/mail run dev';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backendUrl = process.env.VITE_PUBLIC_BACKEND_URL || 'http://localhost:8787';
const backendProbeUrl = `${backendUrl.replace(/\/$/, '')}/api/public/providers`;
const backendBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

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

const backendCmd = ['--dir', 'apps/server', 'run', 'dev'];
let backendProcess = null;

const shutdownBackendProcess = () => {
  if (!backendProcess || backendProcess.killed) return;
  try {
    backendProcess.kill('SIGTERM');
  } catch {}
};

const handleBackendLifecycle = () => {
  const cleanup = () => {
    shutdownBackendProcess();
  };

  process.once('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  if (process.platform === 'win32') {
    process.once('SIGBREAK', () => {
      cleanup();
      process.exit(0);
    });
  }
  process.once('exit', shutdownBackendProcess);
};

handleBackendLifecycle();

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
  backendProcess = spawn(backendBin, backendCmd, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: baseEnv,
  });
  let backendExited = false;

  backendProcess.on('error', (error) => {
    console.error(`[local-dev] backend start failed: ${error.message}`);
  });
  backendProcess.on('exit', (code, signal) => {
    backendExited = true;
    if (code !== 0) {
      console.error(
        `[local-dev] backend exited early (code=${code ?? 'unknown'}, signal=${signal ?? 'none'})`,
      );
    }
  });
  backendProcess.stdout?.on('data', (chunk) => {
    process.stdout.write(`[server] ${String(chunk)}`);
  });
  backendProcess.stderr?.on('data', (chunk) => {
    process.stderr.write(`[server] ${String(chunk)}`);
  });

  for (let i = 0; i < 30; i++) {
    if (backendExited) return false;
    await wait(1000);
    if (await isBackendReachable()) {
      console.log('[local-dev] Backend is up.');
      return true;
    }
  }

  return false;
};

const env = { ...process.env };
env.VITE_DISABLE_SENTRY = '1';

if (forceHosted) {
  env.VITE_PUBLIC_MAIL_API_MODE = 'hosted';
} else if (forceFull) {
  env.VITE_PUBLIC_MAIL_API_MODE = 'legacy';
} else if (forceFrontendOnly || isDemoFrontendOnlyArg || demoFrontendOnly) {
  env.VITE_PUBLIC_MAIL_API_MODE = 'demo';
}

if (demoFrontendOnly) {
  env.ZERO_DEMO_MODE = '1';
  env.ZERO_DEMO_FRONTEND_ONLY = '1';
  env.VITE_ZERO_DEMO_MODE = '1';
}

if (demoFrontendOnly) {
  console.log('[local-dev] FE-only demo mode active; skipping backend startup.');
  env.ZERO_DISABLE_OXLINT = process.env.ZERO_DISABLE_OXLINT || '1';
}

if (forceHosted) {
  console.log('[local-dev] Hosted mode shell (VITE_PUBLIC_MAIL_API_MODE=hosted); skipping backend startup.');
  env.ZERO_DISABLE_OXLINT = process.env.ZERO_DISABLE_OXLINT || '1';
}

const backendReachable = forceFrontendOnly || demoFrontendOnly || forceHosted
  ? false
  : await startBackendIfNeeded(env);
env.VITE_FRONTEND_ONLY = forceFrontendOnly || demoFrontendOnly ? '1' : backendReachable ? '0' : '1';

const child = spawnSync(cmd, { shell: true, stdio: 'inherit', env });

if (child.error) {
  console.error(child.error.message);
  process.exit(1);
}

process.exit(child.status ?? 1);
