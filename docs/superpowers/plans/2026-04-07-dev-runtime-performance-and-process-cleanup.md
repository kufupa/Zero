# Dev Runtime Performance and Process Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce local dev RAM/CPU usage and eliminate lingering `node`/`esbuild`/`workerd` processes with minimal behavior changes to production code paths.

**Architecture:** Keep the existing Vite + React Router + Wrangler stack, but harden process lifecycle management and add a lean dev profile that disables expensive dev-only plugins/features. Ship upgrades in stages: first deterministic cleanup behavior, then low-risk dependency refresh, then optional canary for bigger toolchain shifts.

**Tech Stack:** Node.js scripts, pnpm, Turbo, React Router v7, Vite, Wrangler/Miniflare, PowerShell/Bash process checks.

---

## Scope Check

This request touches one cohesive subsystem: **local development runtime ergonomics**.  
Production request handling, feature logic, and demo/mock API behavior are out of scope for this plan.

## File Structure

- Create: `scripts/verify-dev-process-cleanup.mjs`  
  - One-purpose regression checker for orphaned dev processes/ports after controlled shutdown.
- Create: `scripts/verify-lean-dev-profile.mjs`  
  - Asserts lean profile env toggles are active and expected plugin set is reduced.
- Create: `scripts/cleanup-dev-processes.mjs`  
  - Cross-platform emergency cleanup command scoped to this repo path.
- Modify: `scripts/run-frontend-local.mjs`  
  - Replace detached backend launching with parent-managed lifecycle and explicit signal cleanup.
- Modify: `apps/mail/vite.config.ts`  
  - Add env-gated heavy feature toggles (`oxlint`, React compiler babel transform, warmup).
- Modify: `package.json`  
  - Add reproducible scripts for lean dev + cleanup + verification.
- Modify: `pnpm-workspace.yaml`  
  - Low-risk catalog bump for `wrangler` only.
- Modify: `apps/mail/package.json`  
  - Low-risk `react-router`/`@react-router/dev` bump.
- Modify: `README.md`  
  - Document new dev modes, cleanup command, and runtime version guidance.
- Modify: `.nvmrc`  
  - Pin to validated Node version used in verification.

### Task 1: Add Orphan-Process Regression Harness

**Files:**
- Create: `scripts/verify-dev-process-cleanup.mjs`
- Modify: `package.json`
- Test: `scripts/verify-dev-process-cleanup.mjs`

- [ ] **Step 1: Write the failing test**

```js
#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';

const FRONTEND_PORT = 3000;
const BACKEND_PORT = 8787;

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
  const r = await run('bash', ['-lc', `lsof -iTCP:${FRONTEND_PORT} -sTCP:LISTEN -t; lsof -iTCP:${BACKEND_PORT} -sTCP:LISTEN -t`]);
  return r.out.trim() ? r.out.trim().split('\n').length : 0;
}

const child = spawn('pnpm', ['devfull'], { shell: true, stdio: 'ignore' });
await sleep(15000);
child.kill('SIGINT');
await sleep(4000);

const listeners = await countListeners();
if (listeners !== 0) {
  console.error(`Expected 0 listeners after shutdown, got ${listeners}`);
  process.exit(1);
}

console.log('verify-dev-process-cleanup passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/verify-dev-process-cleanup.mjs`  
Expected: FAIL on current code because backend can remain alive after frontend exits.

- [ ] **Step 3: Wire script into package scripts**

```json
{
  "scripts": {
    "verify:dev:cleanup": "node ./scripts/verify-dev-process-cleanup.mjs"
  }
}
```

- [ ] **Step 4: Run test to verify harness is callable**

Run: `pnpm verify:dev:cleanup`  
Expected: still FAIL (regression reproduced), but command and reporting work.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-dev-process-cleanup.mjs package.json
git commit -m "test: add regression harness for lingering dev processes"
```

### Task 2: Fix Frontend Script Process Lifecycle (No Detached Backend)

**Files:**
- Modify: `scripts/run-frontend-local.mjs`
- Test: `scripts/verify-dev-process-cleanup.mjs`

- [ ] **Step 1: Write the failing test**

```bash
pnpm verify:dev:cleanup
```

Expected: FAIL before lifecycle fix.

- [ ] **Step 2: Implement minimal lifecycle-safe backend management**

```js
// scripts/run-frontend-local.mjs (core change excerpt)
let backendProcess = null;

const stopBackend = () => {
  if (!backendProcess || backendProcess.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(backendProcess.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    backendProcess.kill('SIGTERM');
  }
};

const installShutdownHandlers = () => {
  const shutdown = (code = 0) => {
    stopBackend();
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('exit', () => stopBackend());
};

const startServerProcess = async (baseEnv) => {
  backendProcess = spawn(backendCmd, {
    shell: true,
    stdio: 'ignore',
    detached: false,
    env: baseEnv,
  });
  installShutdownHandlers();
  // ... existing readiness polling stays
};
```

- [ ] **Step 3: Run test to verify it now passes**

Run: `pnpm verify:dev:cleanup`  
Expected: PASS with zero listeners after controlled shutdown.

- [ ] **Step 4: Verify normal dev still works**

Run: `ZERO_DEMO_MODE=1 pnpm devfull`  
Expected: frontend + backend boot normally; Ctrl+C exits both.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-frontend-local.mjs
git commit -m "fix: manage backend child lifecycle to prevent lingering dev processes"
```

### Task 3: Add Lean Dev Profile (Lower RAM/CPU Without Stack Migration)

**Files:**
- Modify: `apps/mail/vite.config.ts`
- Create: `scripts/verify-lean-dev-profile.mjs`
- Modify: `package.json`
- Test: `scripts/verify-lean-dev-profile.mjs`

- [ ] **Step 1: Write the failing test**

```js
#!/usr/bin/env node
import process from 'node:process';

const required = {
  ZERO_DISABLE_OXLINT: '1',
  ZERO_DISABLE_REACT_COMPILER: '1',
  ZERO_DISABLE_VITE_WARMUP: '1',
};

for (const [k, v] of Object.entries(required)) {
  if (process.env[k] !== v) {
    console.error(`${k} expected ${v}, got ${process.env[k] ?? '<unset>'}`);
    process.exit(1);
  }
}

console.log('verify-lean-dev-profile passed');
```

- [ ] **Step 2: Run test to verify it fails in default env**

Run: `node scripts/verify-lean-dev-profile.mjs`  
Expected: FAIL because vars are not set by default.

- [ ] **Step 3: Implement lean toggles in Vite config**

```ts
// apps/mail/vite.config.ts (core change excerpt)
const shouldRunOxlint = process.env.ZERO_DISABLE_OXLINT !== '1';
const shouldRunReactCompiler = process.env.ZERO_DISABLE_REACT_COMPILER !== '1';
const shouldRunWarmup = process.env.ZERO_DISABLE_VITE_WARMUP !== '1';

const plugins = [
  ...(shouldRunOxlint ? [oxlintPlugin()] : []),
  ...reactRouter(),
  cloudflare(),
  ...(shouldRunReactCompiler
    ? [
        babel({
          exclude: [/node_modules/, /[\\/]paraglide[\\/]/],
          filter: /\.[jt]sx?$/,
          babelConfig: {
            presets: ['@babel/preset-typescript'],
            plugins: [['babel-plugin-react-compiler', ReactCompilerConfig]],
            compact: false,
          },
        }),
      ]
    : []),
  tsconfigPaths(),
  tailwindcss(),
  paraglideVitePlugin({ project: './project.inlang', outdir: './paraglide', strategy: ['cookie', 'baseLocale'] }),
];

server: {
  port: 3000,
  ...(shouldRunWarmup
    ? {
        warmup: {
          clientFiles: ['./app/**/*', './components/**/*'],
        },
      }
    : {}),
}
```

- [ ] **Step 4: Add lean scripts and validate**

```json
{
  "scripts": {
    "dev:frontend:lean": "ZERO_DISABLE_OXLINT=1 ZERO_DISABLE_REACT_COMPILER=1 ZERO_DISABLE_VITE_WARMUP=1 dotenv -- node ./scripts/run-frontend-local.mjs --frontend-only",
    "verify:dev:lean": "ZERO_DISABLE_OXLINT=1 ZERO_DISABLE_REACT_COMPILER=1 ZERO_DISABLE_VITE_WARMUP=1 node ./scripts/verify-lean-dev-profile.mjs"
  }
}
```

Run: `pnpm verify:dev:lean`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/vite.config.ts scripts/verify-lean-dev-profile.mjs package.json
git commit -m "perf: add lean frontend dev profile with optional heavy plugin toggles"
```

### Task 4: Low-Risk Toolchain Refresh (Patch/Minor First)

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `apps/mail/package.json`
- Modify: `pnpm-lock.yaml`
- Test: `apps/mail` and `apps/server` dev startup + verification scripts

- [ ] **Step 1: Write the failing compatibility check**

```bash
pnpm -C apps/mail dev
```

Expected: may still work, but this step establishes baseline before bump.

- [ ] **Step 2: Update constrained dependencies**

```yaml
# pnpm-workspace.yaml
catalog:
  wrangler: ^4.80.0
```

```json
// apps/mail/package.json (dependency excerpts)
{
  "dependencies": {
    "@react-router/dev": "^7.14.0",
    "react-router": "^7.14.0"
  }
}
```

Run: `pnpm install`

- [ ] **Step 3: Run focused verification**

Run:
- `pnpm -C apps/server dev -- --host 127.0.0.1 --port 8787`
- `ZERO_DISABLE_OXLINT=1 ZERO_DISABLE_REACT_COMPILER=1 ZERO_DISABLE_VITE_WARMUP=1 pnpm -C apps/mail dev`
- `ZERO_DEMO_MODE=1 APP_URL=http://localhost:3000 BACKEND_URL=http://127.0.0.1:8787 node scripts/verify-mock-demo.mjs`

Expected: all boot and verification pass.

- [ ] **Step 4: Re-run process regression**

Run: `pnpm verify:dev:cleanup`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml apps/mail/package.json pnpm-lock.yaml
git commit -m "chore: update wrangler and react-router to include recent dev runtime fixes"
```

### Task 5: Add Explicit Cleanup Command + Docs + Runtime Pin

**Files:**
- Create: `scripts/cleanup-dev-processes.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `.nvmrc`
- Test: cleanup command + docs command snippets

- [ ] **Step 1: Write the failing test**

```bash
pnpm cleanup:dev
```

Expected: FAIL before command exists.

- [ ] **Step 2: Implement cleanup script**

```js
#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform === 'win32') {
  const ps = `
    $root = "${root.replace(/\\/g, '\\\\')}";
    $procs = Get-CimInstance Win32_Process | Where-Object {
      ($_.Name -eq "node.exe" -or $_.Name -eq "esbuild.exe" -or $_.Name -eq "workerd.exe")
      -and $_.CommandLine -like ("*" + $root + "*")
    };
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Output "cleanup_complete";
  `;
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
} else {
  spawnSync('bash', ['-lc', `pkill -f "${root}" || true`], { stdio: 'inherit' });
}
```

- [ ] **Step 3: Add scripts + runtime doc updates**

```json
{
  "scripts": {
    "cleanup:dev": "node ./scripts/cleanup-dev-processes.mjs",
    "dev:frontend:lean": "ZERO_DISABLE_OXLINT=1 ZERO_DISABLE_REACT_COMPILER=1 ZERO_DISABLE_VITE_WARMUP=1 dotenv -- node ./scripts/run-frontend-local.mjs --frontend-only"
  }
}
```

```md
# README.md (new section excerpt)
## Lean Dev Mode

- `pnpm dev:frontend:lean` for lower RAM/CPU local UI work
- `pnpm cleanup:dev` if a previous session left watcher/runtime processes behind
- Use Node version from `.nvmrc` before running dev scripts
```

```txt
# .nvmrc
v22.14.0
```

- [ ] **Step 4: Verify docs workflow commands**

Run:
- `pnpm dev:frontend:lean`
- `pnpm cleanup:dev`
- `pnpm verify:dev:cleanup`

Expected: commands run successfully; cleanup removes repo-scoped leftovers.

- [ ] **Step 5: Commit**

```bash
git add scripts/cleanup-dev-processes.mjs package.json README.md .nvmrc
git commit -m "docs: add lean dev workflow and repo-scoped cleanup command"
```

## Alternatives Matrix (Minimal-Change First)

1. **Recommended now:** lifecycle fix + lean profile + low-risk upgrades (this plan)  
   - Lowest risk to production behavior, immediate RAM/process gains.
2. **Next option:** Vite 7 migration only (separate plan)  
   - Moderate change risk, potential memory/build improvements.
3. **Highest impact/risk:** `rolldown-vite` canary or bundler swap  
   - Larger perf upside, but plugin compatibility risk; run in separate branch/spec.

## Evidence Summary Used for This Plan

- Repo-local cause identified: `scripts/run-frontend-local.mjs` starts backend with `detached: true` and `unref()`.
- Upstream ecosystem signals:
  - React Router watcher leak fixed in `7.0.1+` (`remix-run/react-router#12331`).
  - React Router high CPU/memory reports in typegen watchers (`remix-run/react-router#12721`).
  - Wrangler had multiple cleanup fixes, but orphan reports still appear in later versions (`cloudflare/workers-sdk#4693`, `#6510`, `#9193`).
  - Current local versions lag latest significantly (`wrangler 4.32.0 -> 4.80.0`, `@react-router/dev 7.6.x -> 7.14.0`).

## Self-Review

1. **Spec coverage:**  
   - Lingering processes: Tasks 1, 2, 5  
   - RAM/CPU reduction: Task 3  
   - Outdated dependencies check/update: Task 4  
   - Minimal-change alternatives: matrix + staged rollouts

2. **Placeholder scan:**  
   - No TBD/TODO placeholders; each task has file paths, code, commands, expected outcomes.

3. **Type/signature consistency:**  
   - Script names and env keys are consistent across tasks (`verify:dev:cleanup`, `verify:dev:lean`, `ZERO_DISABLE_*` flags).

