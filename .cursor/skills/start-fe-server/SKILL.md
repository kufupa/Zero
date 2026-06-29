---
name: start-fe-server
description: Use when starting or debugging this repo's local frontend dev server on Windows, especially after restart, stuck loading, localhost hangs, stale ports, React Router/Vite dev, or frontend-only demo mode.
---

# Start FE Server

## Overview
Start one clean frontend server, then prove page responds. Never trust `Local:` alone.

## When To Use
- User asks to start local FE, frontend, demo, app, React Router, or Vite server.
- Page stuck loading, `localhost:3000` hangs, `curl` times out, or port already used.
- Windows restart left stale `node.exe` / `workerd.exe` listeners.

## Quick Start
From repo root:

```bash
ZERO_DEMO_MODE=1 ZERO_DEMO_FRONTEND_ONLY=1 VITE_ZERO_DEMO_MODE=1 VITE_FRONTEND_ONLY=1 VITE_DISABLE_SENTRY=1 ZERO_DISABLE_OXLINT=1 pnpm --dir "C:/Users/gamin/Desktop/projs/emails hotels uis/zero/apps/mail" exec react-router dev --host 127.0.0.1 --port 3000 --strictPort --force
```

Open `http://127.0.0.1:3000/` or `http://localhost:3000/`.

## Verification
Success requires all:
- Dev log prints local URL.
- `curl -4 -I --max-time 15 "http://127.0.0.1:3000/"` returns headers, not timeout.
- Browser renders `http://127.0.0.1:3000/mail/inbox` or redirects there from `/`.
- No dev overlay, crash loop, `EADDRINUSE`, or blocking console/network error.

## If It Hangs
Inspect exact port owners:

```bash
powershell.exe -NoProfile -Command 'Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 3000,3001,9229,9230 } | Select-Object LocalAddress,LocalPort,OwningProcess | Format-List'
```

Copy actual `OwningProcess` values into this command:

```bash
powershell.exe -NoProfile -Command '$ids = @(1992,14176); Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | Format-List'
```

Replace `1992,14176` with real owners from previous output. Kill only stale repo-scoped React Router dev tree:

```bash
taskkill //PID <react-router-node-pid> //T //F
```

Then restart with Quick Start command.

Repo-scoped means command line contains this repo path and React Router dev, e.g. `emails hotels uis\zero\apps\mail` and `@react-router\dev\bin.js`. Do not kill generic `node.exe`, unrelated backend, browser, editor, or package-manager processes.

## Common Mistakes
| Mistake | Fix |
|---|---|
| Saying "up" after `Local:` | Verify HTTP + browser render. |
| Using plain `pnpm dev` | Use frontend-only demo env when backend should be skipped. |
| Hitting `localhost` only | Test `127.0.0.1`; Windows may bind/hang on IPv6 `::1`. |
| Restarting repeatedly | Inspect/kill stale `node` + `workerd` owners first. |
| Killing all Node | Kill only repo-scoped React Router dev tree. |

## Red Flags
- `curl` hangs with zero bytes.
- `127.0.0.1` refuses but `::1` accepts and hangs.
- Inspector port `9229` unavailable unexpectedly.
- More than one React Router dev server running.
