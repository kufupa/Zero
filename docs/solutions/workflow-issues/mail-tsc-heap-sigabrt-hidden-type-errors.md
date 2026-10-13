---
title: Bare tsc on apps/mail Aborts at Node's Heap Limit and Hides Type Errors
date: 2026-10-13
category: workflow-issues
module: apps/mail typecheck / agent verification
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - An agent or worker runs `tsc --noEmit -p apps/mail` (or `cd apps/mail && tsc --noEmit`)
  - A typecheck "fails" with no `error TS` lines
  - Parallel worker worktrees typecheck at the same time on the Orca VPS
symptoms:
  - "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command was killed with SIGABRT (Aborted): tsc --noEmit -p apps/mail"
  - "<--- Last few GCs ---> ... allocation failure" near ~2,000 MB in stderr
  - Typecheck takes 80-130 s, peaks ~2.2-2.6 GB RSS, then prints nothing useful
  - Kernel cgroup OOM kills of node/tsc inside orca-serve.service when several run at once
  - In a fresh worktree, dozens of TS2307 errors for `@/paraglide/*` and `./+types/*`
tags:
  - typescript
  - tsc
  - node-heap
  - sigabrt
  - apps-mail
  - parallel-workers
  - orca-vps
  - memory
---

# Bare tsc on apps/mail Aborts at Node's Heap Limit and Hides Type Errors

## Problem

A full `apps/mail` typecheck needs ~2.6 GB of V8 heap (7.1k files, ~6.8M type instantiations, ~64 s check time). Node's default old-space limit on the 16 GB VPS is ~2 GB, so bare `tsc --noEmit -p apps/mail` aborts with SIGABRT before reporting anything. Codex worker logs showed 22+ such aborts across two days versus 2 cgroup SIGKILLs.

Because the check never completed, `main` accumulated 10 real `apps/mail` type errors and one hidden runtime contract bug (`mail.send` rejected Azure Foundry draft approvals; fixed in the same PR). Agents read the abort as "killed" or "flaky" and either retried (another ~2 GB, ~100 s) or skipped typechecking.

## Root cause

1. **Heap, not types.** `apps/mail` imports server types from source (`@zero/server/trpc`, `driver/types`, `schemas`, `auth`), so tsc also checks all of `apps/server-pilot/src` (~23 s of ~64 s check time). zod and drizzle add ~220k types.
2. **Generated inputs missing in fresh worktrees.** Paraglide messages (`apps/mail/paraglide/`) and React Router route types (`apps/mail/.react-router/`) are gitignored and generated only by vite/dev. Without them tsc reports ~50 TS2307 errors that are not real.
3. **`wrangler types` is a trap.** Its `worker-configuration.d.ts` declares Workers runtime globals that clash with the DOM lib and adds ~38 false errors (`HTMLSelectElement` casts, `Response` overloads). Do not generate it for the mail typecheck.
4. **Stale incremental caches make it worse.** Copying `apps/mail/tsconfig.tsbuildinfo` from an older branch increased peak heap and still aborted. Seeding caches across worktrees is not a fix.

## Solution

Use the package script, which generates inputs and raises the heap:

```bash
pnpm --dir apps/mail run typecheck
# paraglide-js compile ... && react-router typegen && NODE_OPTIONS=--max-old-space-size=3072 tsc --noEmit
```

Measured: exit 0, 0 errors, ~89 s, ~2.6 GB peak.

Operational rules (also in `AGENT.md` "Typecheck (shared VPS memory budget)"):

- Typecheck only packages you changed. `apps/server-pilot` alone: `pnpm --dir apps/server-pilot exec tsc --noEmit -p .` (~10 s, ~0.7 GB).
- Run the `apps/mail` typecheck when you touch `apps/mail` or server-pilot code it imports types from.
- `apps/mail` is green on `main`; no baseline runs.
- Parallel workers: only workers that touched mail or shared types run the mail check; orchestrators run it once after merging.
- SIGABRT or SIGKILL from tsc means memory pressure, not a type error.

## Diagnosis recipe

```bash
NODE_OPTIONS=--max-old-space-size=4096 node node_modules/typescript/lib/tsc.js \
  --noEmit --incremental false -p apps/mail --extendedDiagnostics --generateTrace /tmp/mail-trace
```

Group `checkSourceFile` B/E events in `trace.json` by directory to see where check time goes; group `types.json` by declaration path for type volume.

## Prevention

- Check tsc exit status and stderr, not just `grep -c "error TS"`. Zero matches with a non-zero exit is an abort.
- If the mail typecheck heap creeps toward 3 GB, split server types behind declarations (project references or an emitted `AppRouter` .d.ts) rather than raising the heap again.

## Related

- `docs/solutions/workflow-issues/false-green-gate-unpersisted-tsc-fixes.md`
- `docs/solutions/workflow-issues/orca-serve-needrestart-and-cgroup-memory.md`
