---
name: febe
description: Restarts local front-end and back-end dev servers after killing stale processes. Use when the user mentions FEBE, FE/BE restart, dev stack refresh, zombie Node or esbuild, ports 3000 or 8787 in use, or wants a clean local run after prior sessions.
---

# FEBE — front-end / back-end restart

## Goal

Tear down an old local dev stack, start a fresh one, and **report what happened** (terminals, processes, ports).

## Order of operations (non-negotiable)

Do these **in this order**. Skipping step 1 is a common reason cleanup feels incomplete.

### 1. Terminals first (human step)

**Before** running kill scripts or starting new servers:

- In each terminal that is still running dev for **this repo**, prefer **Ctrl+C** once (or twice if needed) to stop `pnpm dev` / `pnpm devfull` / Vite / Wrangler cleanly — same as a human would.
- Then **close the terminal tab** if they are done with that session (or they can close without Ctrl+C; IDE behavior varies).
- If the agent started the dev command in a terminal it controls, it may send **Ctrl+C** there before other cleanup.
- If the user already stopped or closed everything, they can say so and you proceed.

**Why:** **Ctrl+C** sends **SIGINT**; that tears down the process tree politely when the shell still owns the job. Closing the tab often ends the shell too, but Ctrl+C first is the most predictable “stop dev” step.

**Is Ctrl+C / closing enough on its own?** **Often no.** After agent sessions, crashed parents, or Windows quirks, **esbuild.exe** and **node.exe** can outlive the terminal ([vitejs/vite#5743](https://github.com/vitejs/vite/issues/5743), [evanw/esbuild issues](https://github.com/evanw/esbuild/issues/1566)). Treat **Ctrl+C then close** as **step one**, not the whole fix.

### 2. Automated cleanup (repo)

From the **repository root**:

```bash
pnpm cleanup:dev
```

This repo’s script matches **node / esbuild / workerd** tied to the worktree (path variants) and kills **listeners** on default dev ports with a **process tree** kill on Windows (`taskkill /T`).

Optional: override ports with `CLEANUP_DEV_PORTS` or `DEV_CLEANUP_PORTS` (comma-separated).

### 3. Counts (before → after, when the user wants numbers)

To report “killed N Node / M esbuild,” sample **before** step 2 and **after** step 2 (same query twice). On **Windows** (PowerShell), set `$repo` to the **absolute path of the clone** (repository root), then:

```powershell
$repo = 'C:/path/to/clone'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'esbuild.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($repo.ToLower()) } |
  Measure-Object | Select-Object -ExpandProperty Count
```

If path matching is messy, at least compare **listeners** on **3000** and **8787** (and **8788** if Wrangler shifted) before vs after.

**Terminals closed:** The agent usually **cannot** close Cursor terminal tabs programmatically. Report as **user-reported count** (e.g. “You closed 3 terminals”) or **“Instructed to close dev terminals; count not available.”**

### 4. Start fresh FE + BE

From repo root, typical full stack:

```bash
pnpm devfull
```

Or lean / split flows if the user prefers:

- `pnpm dev:frontend:lean` / `pnpm dev:frontend` (FE only)
- `pnpm dev:backend` (BE only)

Respect existing project env (e.g. `ZERO_DEMO_MODE`, `VITE_PUBLIC_BACKEND_URL`). If the backend binds **8788** because **8787** is busy, align `VITE_PUBLIC_BACKEND_URL` with the real listener.

### 5. Wait until both are up

- **Frontend:** listener on **3000** (or project-configured port).
- **Backend:** listener on **8787** / **8788** and/or HTTP probe (this repo’s frontend helper probes `VITE_PUBLIC_BACKEND_URL` + `/api/public/providers`).

Poll until both succeed or time out; if timeout, surface **which** side failed and **which port** is listening.

## Report template (copy and fill)

Use this verbatim shape so the user gets a human-style summary:

```text
FEBE restart — summary
- Terminals: [Ctrl+C / closed N terminals / user confirmed stopped; agent may have sent Ctrl+C in agent-owned terminals]
- Cleanup: pnpm cleanup:dev ran; ~X node + ~Y esbuild matched repo path before → after (or port listeners cleared)
- Frontend: started, listening on [host:port]
- Backend: started, listening on [host:port]; probe [ok / failed]
```

## Anti-patterns

- Running **only** `pnpm cleanup:dev` without **Ctrl+C / stopping dev in those terminals** (or asking the user to) when the problem is “leftover stuff from last time.”
- Starting **devfull** while old listeners are still bound without fixing **port / BACKEND_URL** mismatch.
- Claiming success without **checking listeners or HTTP** for both FE and BE.

## This monorepo

- Cleanup entrypoint: `pnpm cleanup:dev` → `scripts/cleanup-dev-processes.mjs`
- Full local stack driver: `pnpm devfull` → `scripts/run-frontend-local.mjs`

For deeper Windows / orphan-process context, see the header comment in `scripts/cleanup-dev-processes.mjs`.
