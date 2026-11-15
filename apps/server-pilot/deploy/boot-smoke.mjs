#!/usr/bin/env node
// Boot smoke: prove every PM2 app's entrypoint evaluates its whole static module
// graph without throwing (for example an ESM import cycle), before PM2 restarts.
//
// Before merge, from apps/server-pilot (no build needed; evaluates src through tsx):
//   node deploy/boot-smoke.mjs --source
// Against a build (deploy-ec2.sh runs this after the server build, before PM2):
//   node deploy/boot-smoke.mjs
//
// Each entry runs in its own child with a clean environment: no production env
// file, no database URL, no PM2 variables. The child refuses to listen or open
// a socket, so it cannot take a production port or reach HMS or the database.
// - worker and ai-worker are imported whole; they only start when run as the
//   process entry (isCliEntry), so importing evaluates them without starting.
// - main.js listens and reads the database in its own body, so only its static
//   imports are evaluated, in order. That is the same dependency evaluation
//   Node performs before the first statement of main.js.
// Lazy `import()` calls and code that depends on the production env are not covered.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const SERVER_PILOT = join(dirname(SCRIPT), '..');
const APPS = [
  { name: 'http', entry: 'main', importsOnly: true, env: { NAVA_AUTH_SESSION_PROFILE: 'legacy' } },
  { name: 'remote-http', entry: 'main', importsOnly: true, env: { NAVA_AUTH_SESSION_PROFILE: 'remote' } },
  { name: 'worker', entry: 'mail/ingest/worker', importsOnly: false, env: {} },
  { name: 'ai-worker', entry: 'ai/worker', importsOnly: false, env: { AI_WORKER_LANE: 'default' } },
];
// hms-ai-worker runs the ai-worker entry and is never started by a deploy.
const SAME_ENTRY = { 'hms-ai-worker': 'ai-worker' };

async function child([mode, entry, importsOnly]) {
  const refuse = (what) => function refused() {
    throw new Error(`boot-smoke: entrypoint tried to ${what} during module evaluation`);
  };
  net.Server.prototype.listen = refuse('listen');
  net.Socket.prototype.connect = refuse('open a network connection');
  const file = join(SERVER_PILOT, mode === 'source' ? 'src' : 'dist', `${entry}.${mode === 'source' ? 'ts' : 'js'}`);
  const url = pathToFileURL(file);
  if (importsOnly !== 'imports-only') {
    await import(url.href);
    return;
  }
  const imports = [...readFileSync(file, 'utf8')
    .matchAll(/^import\s[^'"()]*?['"]([^'"]+)['"](\s*with\s*\{\s*type:\s*['"]json['"]\s*\})?/gm)];
  if (imports.length === 0) throw new Error(`boot-smoke: no static imports found in ${file}`);
  for (const [, specifier, json] of imports) {
    const target = /^\.{1,2}\//.test(specifier) ? new URL(specifier, url).href : specifier;
    await (json ? import(target, { with: { type: 'json' } }) : import(target));
  }
}

function run(app, mode, timeoutMs) {
  return new Promise((resolve) => {
    const args = [...(mode === 'source' ? ['--import', 'tsx'] : []), SCRIPT, '--child', mode, app.entry,
      app.importsOnly ? 'imports-only' : 'whole'];
    // A clean env keeps PM2's pm_exec_path and IPC channel, and every secret, out of the child.
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production', PORT: '0', ...app.env };
    const started = Date.now();
    const proc = spawn(process.execPath, args, { cwd: SERVER_PILOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk) => { output = (output + chunk).slice(-6000); };
    proc.stdout.on('data', collect);
    proc.stderr.on('data', collect);
    const timer = setTimeout(() => { output += `\nboot-smoke: timed out after ${timeoutMs} ms`; proc.kill('SIGKILL'); }, timeoutMs);
    proc.on('error', (error) => { output += `\n${error.message}`; });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ app, ok: code === 0, code, seconds: ((Date.now() - started) / 1000).toFixed(1), output: output.trim() });
    });
  });
}

async function main(argv) {
  const mode = argv.includes('--source') ? 'source' : 'build';
  if (argv.some((arg) => arg !== '--source')) {
    console.error('usage: node deploy/boot-smoke.mjs [--source]');
    return 2;
  }
  const timeoutMs = Number(process.env.BOOT_SMOKE_TIMEOUT_MS ?? 180_000);
  const configured = createRequire(import.meta.url)('./pm2.config.cjs').apps.map((app) => app.name);
  const unknown = configured.filter((name) => !APPS.some((app) => app.name === name) && !SAME_ENTRY[name]);
  if (unknown.length) {
    console.error(`boot-smoke FAIL: PM2 app without a smoke entry: ${unknown.join(', ')}`);
    return 1;
  }
  let failed = 0;
  // One at a time: the box is small and the ai-worker graph is large.
  for (const app of APPS) {
    const result = await run(app, mode, timeoutMs);
    if (result.ok) {
      console.log(`boot-smoke ok ${app.name} (${mode} ${app.entry}, ${result.seconds}s)`);
    } else {
      failed += 1;
      console.error(`boot-smoke FAIL ${app.name} (${mode} ${app.entry}, exit ${result.code})\n${result.output}`);
    }
  }
  if (failed) {
    console.error(`boot-smoke FAIL: ${failed} of ${APPS.length} PM2 entrypoints cannot boot`);
    return 1;
  }
  console.log(`boot-smoke ok: ${APPS.length} PM2 entrypoints evaluate cleanly`);
  return 0;
}

if (process.argv[2] === '--child') {
  child(process.argv.slice(3)).then(() => process.exit(0), (error) => {
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
} else {
  process.exitCode = await main(process.argv.slice(2));
}
