#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_PORT = 3000;
const BACKEND_PORT = 8787;
const STARTUP_MS = 55_000;
const SHUTDOWN_MS = 10_000;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'pipe', shell: false });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function countListeners() {
  if (process.platform === 'win32') {
    const r = await run('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-NetTCPConnection -LocalPort ${FRONTEND_PORT},${BACKEND_PORT} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count`,
    ]);
    return Number(r.out.trim() || '0');
  }
  const r = await run('bash', [
    '-lc',
    `lsof -iTCP:${FRONTEND_PORT} -sTCP:LISTEN -t 2>/dev/null; lsof -iTCP:${BACKEND_PORT} -sTCP:LISTEN -t 2>/dev/null`,
  ]);
  const pids = new Set(r.out.trim().split(/\n/).filter(Boolean));
  return pids.size;
}

function stopDevTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }
}

async function main() {
  const env = { ...process.env, ZERO_DEMO_MODE: '1' };
  const spawnOpts = {
    cwd: root,
    stdio: 'ignore',
    env,
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
  };
  const child = spawn('pnpm', ['devfull'], spawnOpts);

  await sleep(STARTUP_MS);
  stopDevTree(child);
  await sleep(SHUTDOWN_MS);

  const listeners = await countListeners();
  if (listeners !== 0) {
    console.error(`Expected 0 listeners on ports ${FRONTEND_PORT}/${BACKEND_PORT} after shutdown, got ${listeners}`);
    process.exit(1);
  }

  console.log('verify-dev-process-cleanup passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
