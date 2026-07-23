---
title: PM2 ESM Workers Silent Exit from Unref Sleep and isMain Mismatch
date: 2026-07-22
category: runtime-errors
module: server-pilot
problem_type: runtime_error
component: background_job
severity: high
symptoms:
  - "PM2 worker status errored with empty logs after navaai real-mail cutover"
  - "PM2 restart storm hitting max_restarts while process exited cleanly with code 0"
  - "Manual node dist/mail/ingest/worker.js ran and logged normally"
  - "Empty POP3 poll cycle left no event-loop handles when abortableSleep used timer.unref()/tick.unref()"
  - "Same latent isMain failure on ai-worker under PM2 fork (argv[1] is ProcessContainerFork.js)"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - email_processing
  - tooling
tags:
  - pm2
  - esm
  - is-cli-entry
  - unref
  - abortable-sleep
  - mail-ingest
  - ai-worker
  - ec2-pilot
---

# PM2 ESM Workers Silent Exit from Unref Sleep and isMain Mismatch

## Problem

After flipping the EC2 mail pilot to `MAIL_TRANSPORT_MODE=real`, PM2 reported `worker` as `errored` with empty logs and a restart storm, while a manual `node dist/mail/ingest/worker.js` poll loop worked. One-shot activate proofs looked green, but durable PM2 processes were not reliably running `main()`.

## Symptoms

- `pm2 list`: `worker` → `errored`, `restarts` climbing to `max_restarts`, near-zero uptime
- PM2 out/error logs empty (0 bytes) despite `pm2.config.cjs` pointing at `dist/mail/ingest/worker.js`
- Manual `node dist/mail/ingest/worker.js` with sourced `.env.production` printed poll cycles and stayed alive until SIGTERM
- `ai-worker` often `online` with empty logs — same silent `main()` skip under PM2 (import-side handles can keep the process "online" without running the loop)
- Fixing only `.unref()` made manual runs survive 45s (`timeout` exit 124) but PM2 still storming

## What Didn't Work

- Blaming only stale PM2 env / leftover `WORKER_ONE_SHOT` — presence checks passed; flags were cleared
- Assuming empty logs meant a crash before `console.log` — the process exited cleanly without entering `main()`
- Fixing only `abortableSleep` `.unref()` — required for empty-inbox keep-alive, not sufficient under the PM2 fork wrapper
- `ops-restart` / delete+start without an entrypoint fix — same silent exit loop

(session history: 7d Cursor scan after `PYTHONUTF8=1` — keyword hits were this-run compound subagents plus VPN/cutover session using “worker” as noun only; no prior RCA for `unref` / `isMain` / `ProcessContainerFork`.)

## Solution

Two complementary fixes on `EC2-pilot`:

### 1. Keep poll sleep timers ref'd

In `apps/server-pilot/src/mail/ingest/worker.ts`, `abortableSleep` previously called `timer.unref()` / `tick.unref()`. After an empty POP3 cycle, nothing else held the event loop → Node exited 0 → PM2 restarted.

**Before:**

```ts
const timer = setTimeout(resolve, ms);
const tick = setInterval(() => { /* stop check */ }, 100);
timer.unref?.();
tick.unref?.();
```

**After:** leave timers ref'd; clear the interval when the timeout fires.

### 2. Detect CLI entry under PM2 (`isCliEntry`)

ESM guard `import.meta.url === pathToFileURL(process.argv[1]).href` fails under PM2 fork because `argv[1]` is `.../pm2/lib/ProcessContainerFork.js`, not the worker script.

Added `apps/server-pilot/src/lib/is-cli-entry.ts` — matches direct `node` path, optional `pm_exec_path`, or `pm_id` + ecosystem `name`.

Wired:

- `mail/ingest/worker.ts` → `isCliEntry(import.meta.url, 'worker')`
- `ai/worker.ts` → `isCliEntry(import.meta.url, 'ai-worker')`

Tests: `apps/server-pilot/tests/is-cli-entry.test.ts`.

Verified on EC2 after `ops-deploy`: `http` / `worker` / `ai-worker` `online`, `restarts=0`, worker out logs show poll cycles.

## Why This Works

- **Unref:** Node exits when the event loop has no ref'd handles. Poll wait must keep the loop alive between cycles when POP3 leaves no sockets open.
- **isCliEntry:** PM2 does not put the app script in `argv[1]`. Matching `pm_id` + ecosystem `name` (or `pm_exec_path`) is the reliable entry signal for fork mode, while vitest can still import the module without auto-starting `main()`.

## Prevention

- Never use bare `import.meta.url === pathToFileURL(process.argv[1])` for PM2-managed ESM apps — use a shared helper that understands ProcessContainerFork
- Do not `.unref()` long-lived poll/sleep timers in background workers unless something else always holds the loop
- Diagnose PM2 `errored` + empty logs by probing `argv[1]` / entry detection inside a tiny PM2-started script before chasing env/TLS
- After real↔fixture flips, confirm worker **logs** (not only `pm2 status online`)
- Keep unit coverage for `isCliEntry` (direct node + PM2-shaped env)

## Related Issues

- [ec2-pilot-ops-deploy-restart-reboot.md](../workflow-issues/ec2-pilot-ops-deploy-restart-reboot.md) — PM2 dump / fixture worker / ops scripts (adjacent ops surface)
- [live-ai-mail-pipeline-mastra-worker-gates.md](../architecture-patterns/live-ai-mail-pipeline-mastra-worker-gates.md) — assumes `ai-worker` process stays in its product loop
- [mail-transport-mode-fixture-vs-real.md](../architecture-patterns/mail-transport-mode-fixture-vs-real.md) — transport mode flip that surfaces durable worker health
- [ec2-pilot-autonomous-deploy-and-ssm-gotchas.md](../workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) — deploy starts PM2 workers that must actually enter `main()`
- Handoff: `docs/superpowers/plans/handoff-reports/2026-07-22-navaai-real-mail-cutover.md`
