# FE-demo Full Refactor — Rollout Log

## Worktree and branch

- **Branch:** `FE-demo-refactor` (created from `FE-demo` @ `ff05946b`).
- **Worktree path:** `C:/Users/gamin/.config/superpowers/worktrees/zero/FE-demo-refactor` (isolated from main workspace dirty files).

## Baseline (pre-refactor)

### Commands

```bash
cd apps/mail && pnpm exec paraglide-js compile --project ./project.inlang --outdir ./paraglide
cd ../.. && pnpm --filter=@zero/mail exec vitest run tests/demo-runtime.test.ts tests/demo-backend-guards.test.ts tests/demo-query-policy.test.ts tests/entry-server-wait.test.ts
```

### Result

**PASS** — 4 files, 56 tests, after Paraglide compile.

### Blocker discovered

`vitest` importing `app/(routes)/settings/general/page.tsx` failed with `Cannot find module '@/paraglide/runtime'` until Paraglide output existed. Output lives under `apps/mail/paraglide/` (generated, not committed). Mitigation: `apps/mail` now exposes `pnpm paraglide:compile`; `test:demo` runs compile first.

### Original workspace (not this worktree)

Known dirty at plan time: `.gitignore`, `apps/mail/vercel.json`. Left unchanged unless a task edits them.

## Task checkpoints

| Task | Summary | Tests | SHA |
|------|---------|-------|-----|
| 0 | Baseline doc + `paraglide:compile` before `test:demo` | baseline suite (after paraglide) | `d3cc1cd9` |
| 1 | `VITE_PUBLIC_MAIL_API_MODE`, `mail-mode.ts`, `FORCE_FRONTEND_ONLY_DEMO=false`, instrument | `mail-mode`, `demo-runtime`, `support-links`, `entry-server-wait` | `098f0276` |
| 2 | `FrontendApi` contract, DTOs, `hosted-http` proxy, errors | `api-contract` | `efb61571` |
| 3 | `apiQueryKeys`, query-provider mode+IDB v2, `CACHE_BURST_KEY` bump, trpc mode gate | `api-query-keys`, `demo-query-policy`, full mail `162` tests | `1961db54` |
| 4 | `legacy-trpc`, `demo-local`, `getFrontendApi`, factory tests | `api-factory`, `legacy-adapter-routes`, `demo-data`, `demo-local-store` | _(this commit)_ |

### Follow-up (not done here)

Tasks **5–13** from the final plan: AuthApi + login, remove server imports from UI, migrate hooks through `getFrontendApi` / `apiQueryKeys`, folder domain, remove demo tRPC proxy, drift-guard tests, `run-frontend-local.mjs` + `dev:hosted`, final `pnpm build:frontend` gate.

### Paraglide + Vitest

Fresh clones/worktrees: run `pnpm --filter=@zero/mail paraglide:compile` (or `pnpm --filter=@zero/mail test:demo` which runs compile first) before Vitest, or imports of `@/paraglide/runtime` fail.

## 2026-05-04 — Hosted rename + automated gates

| Gate | Command | Result |
|------|---------|--------|
| Vitest (mail) | `pnpm --filter=@zero/mail test:demo` | PASS — 177 tests, 35 files |
| Mail production build | `pnpm --filter=@zero/mail build` | PASS (client + SSR) |
| Mail ESLint | `pnpm --filter=@zero/mail lint` | FAIL — 137 errors, 41 warnings (pre-existing debt; small fixes: hotkey unused binding, DELETE_DRAFT params type) |
| Monorepo frontend build | `pnpm build:frontend` | PASS |

**Rename (Phase A):** Root script `dev:hosted` replaces `dev:hotel`; `scripts/run-frontend-local.mjs` uses `--hosted` and sets `VITE_PUBLIC_MAIL_API_MODE=hosted`. Removed token `hotel` is rejected by `resolveMailMode` (falls through to `legacy`); see `apps/mail/tests/mail-mode.test.ts`.

**Manual smoke (demo / legacy / hosted):** not recorded here — fill when validated.

### Demo draft seed tests

`listDemoDrafts()` only auto-seeds when `resolveMailMode() === 'demo'`. `tests/demo-draft-seed.test.ts` stubs `VITE_PUBLIC_MAIL_API_MODE=demo` in `beforeEach`.
