# FE-demo Next Phase (Post–FE-demo-refactor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the completed `FE-demo-refactor` transport/migration work onto the line of development you ship from, then close v2 **Task 14** (gates + checklist), fix the **`hotel` CLI vs `MailApiMode` mismatch**, and drive **ESLint** toward a clean `pnpm --filter=@zero/mail lint` without weakening product rules.

**Architecture:** Treat `FE-demo-refactor` as the source of truth for `getFrontendApi()`, adapters (`legacy-trpc`, `demo-local`, `hosted-http`), query keys/options, and drift tests. After merge, add a thin **mode-normalization** layer so `VITE_PUBLIC_MAIL_API_MODE=hotel` (from `run-frontend-local.mjs --hotel`) maps to the same runtime branch as `hosted`. UI surfaces `UnsupportedFeatureError` as disabled states via shared helpers (query `meta` / error boundaries / small hooks), not ad-hoc strings in every screen.

**Tech Stack:** React 19, React Router 7, Vite, TanStack Query, tRPC (`legacy`), Vitest, ESLint flat config (`@zero/eslint-config`), existing v2 spec: `docs/superpowers/plans/2026-05-03-fe-demo-full-refactor-v2.md`.

---

I'm using the writing-plans skill to create the implementation plan.

## Baseline analysis (this repo, 2026-05-04)

| Where | What |
|--------|------|
| Current branch (`FE-demo`) | No `apps/mail/lib/api/**`, no `getFrontendApi`, `lib/trpc.ts` + `providers/query-provider.tsx` still use failing demo proxy, `FORCE_FRONTEND_ONLY_DEMO = true` in `apps/mail/lib/demo/runtime.ts`, many `useTRPC` imports from `@/providers/query-provider`. |
| `FE-demo-refactor` (local + `origin`) | ~105 files under `apps/mail` changed vs `FE-demo`; full `lib/api` layer, `getFrontendApi`, `command-palette-context` migrated, `packages/eslint-config` adds `**/paraglide/**` ignore, `UnsupportedFeatureError` in `apps/mail/lib/api/errors.ts`. |
| Risk found on refactor | `scripts/run-frontend-local.mjs` sets `VITE_PUBLIC_MAIL_API_MODE=hotel`, but `apps/mail/lib/runtime/mail-mode.ts` on that branch only accepts `legacy \| hosted \| demo` in `CANONICAL`; unknown non-empty raw falls through to **`legacy`**, so `--hotel` likely boots **full tRPC**, not hosted shell — must fix immediately after merge. |
| ESLint on current `FE-demo` | `pnpm --filter=@zero/mail exec eslint` may fail with `eslint not found` if deps not installed; with install, expect large noise until `paraglide` ignore + merge. |

## File map (this phase)

### Create

- `docs/superpowers/plans/2026-05-03-fe-demo-full-refactor-v2-rollout-checklist.md` (pass/fail matrix for Task 14)
- `apps/mail/lib/runtime/mail-mode-hotel-map.test.ts` (or extend `apps/mail/tests/mail-mode.test.ts` if present post-merge) — asserts `hotel` env resolves to hosted behavior

### Modify (after merge; exact lines shift — use search)

- `apps/mail/lib/runtime/mail-mode.ts` — normalize `hotel` → `hosted` before `CANONICAL` check
- `apps/mail/lib/api/client.ts` — ensure `resolveMailMode()` after normalization still selects `createHostedHttpAdapter()` when mode is `hosted` (no duplicate string checks)
- `docs/superpowers/plans/2026-05-03-fe-demo-full-refactor-v2.md` — optional one-line note under Task 13 that CLI uses `hotel` while internal mode is `hosted` if you keep both strings

---

### Task 1: Merge integration (do not reimplement the 105-file diff on `FE-demo`)

**Files:**

- Git: `FE-demo` ← `FE-demo-refactor`
- Reference: full file map already in `docs/superpowers/plans/2026-05-03-fe-demo-full-refactor-v2.md` § "File map"

- [ ] **Step 1: Preflight on refactor branch (separate shell or worktree)**

```bash
git fetch origin
git checkout FE-demo-refactor
pnpm install
pnpm test:demo
pnpm --filter=@zero/mail build
pnpm --filter=@zero/mail lint
```

Expected: tests + build green; lint may still show non-zero errors — record counts in rollout checklist.

- [ ] **Step 2: Merge into integration branch**

From your shipping branch (example: `FE-demo`):

```bash
git checkout FE-demo
git merge FE-demo-refactor --no-ff -m "merge: FE-demo-refactor transport + hook migration"
```

If conflicts: resolve preferring refactor-side for `apps/mail/lib/api/**`, `lib/trpc.ts`, `providers/query-provider.tsx`, `hooks/use-*.ts`; use `git checkout --theirs` / `--ours` only with intent, not blindly.

- [ ] **Step 3: Post-merge gates**

```bash
pnpm install
pnpm test:demo
pnpm --filter=@zero/mail build
pnpm --filter=@zero/mail lint
```

Expected: same as preflight; fix any merge regressions before Task 2.

- [ ] **Step 4: Commit**

If merge commit already created, only commit follow-up fixes on top.

```bash
git add -A
git commit -m "fix: resolve merge regressions after FE-demo-refactor"
```

---

### Task 2: Fix `hotel` env → hosted mode (v2 behavior gate blocker)

**Files:**

- Modify: `apps/mail/lib/runtime/mail-mode.ts`

- [ ] **Step 1: Write failing test**

Create or extend `apps/mail/tests/mail-mode.test.ts` (if missing after merge, create file):

```typescript
import { describe, expect, it } from 'vitest';
import { resolveMailMode } from '@/lib/runtime/mail-mode';

describe('resolveMailMode hotel cli', () => {
  it('maps VITE_PUBLIC_MAIL_API_MODE hotel to hosted', () => {
    expect(
      resolveMailMode({
        VITE_PUBLIC_MAIL_API_MODE: 'hotel',
      }),
    ).toBe('hosted');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pnpm --filter=@zero/mail exec vitest run apps/mail/tests/mail-mode.test.ts
```

Expected: assertion fails (`legacy` or wrong value).

- [ ] **Step 3: Minimal implementation**

In `apps/mail/lib/runtime/mail-mode.ts`, normalize before canonical check:

```typescript
export function resolveMailMode(env: MailModeEnv = import.meta.env as MailModeEnv): MailApiMode {
  const raw = String(env.VITE_PUBLIC_MAIL_API_MODE ?? '')
    .trim()
    .toLowerCase();
  const normalized = raw === 'hotel' ? 'hosted' : raw;
  if (CANONICAL.has(normalized)) {
    return normalized as MailApiMode;
  }
  if (raw) {
    return 'legacy';
  }
  if (env.VITE_ZERO_DEMO_MODE === '1' || env.VITE_FRONTEND_ONLY === '1') {
    return 'demo';
  }
  return 'legacy';
}
```

- [ ] **Step 4: Run test — expect PASS**

```bash
pnpm --filter=@zero/mail exec vitest run apps/mail/tests/mail-mode.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/runtime/mail-mode.ts apps/mail/tests/mail-mode.test.ts
git commit -m "fix(mail-mode): map CLI hotel to hosted API mode"
```

---

### Task 3: Task 14 rollout checklist + manual behavior matrix

**Files:**

- Create: `docs/superpowers/plans/2026-05-03-fe-demo-full-refactor-v2-rollout-checklist.md`

- [ ] **Step 1: Create checklist file with required rows**

```markdown
# FE-demo Refactor v2 — Rollout checklist

Evidence columns: `date`, `command` or `manual step`, `result` (pass/fail), `notes`.

## Automated

| Gate | Command | Result |
|------|---------|--------|
| Vitest mail | `pnpm test:demo` | |
| Mail build | `pnpm --filter=@zero/mail build` | |
| Mail lint | `pnpm --filter=@zero/mail lint` | |
| Frontend build (monorepo) | `pnpm build:frontend` | |

## Demo (`VITE_PUBLIC_MAIL_API_MODE=demo`)

| Area | Check | Result |
|------|-------|--------|
| Network | No requests to real backend URL for mail APIs | |
| Inbox / thread | List + open thread | |
| Compose / send | Local success path | |
| Drafts / labels / notes / templates / settings | Smoke each | |

## Legacy (`VITE_PUBLIC_MAIL_API_MODE=legacy`)

| Area | Check | Result |
|------|-------|--------|
| Session | Login works | |
| Threads | List + detail from backend | |
| Mutations | Archive / label / send hit backend | |

## Hosted shell (`pnpm dev:hotel` → `hotel` → hosted)

| Area | Check | Result |
|------|-------|--------|
| Boot | App loads, no backend required | |
| Mail action | Any mail mutation throws or surfaces unsupported — not silent success | |
| UI | Disabled / copy where applicable | |

## Regressions

| Item | Result |
|------|--------|
| No `FORCE_FRONTEND_ONLY_DEMO` required for demo | |
| Drift tests: `frontend-import-boundary`, `no-old-demo-branches` | |
```

- [ ] **Step 2: Fill after running commands**

Execute each command in the table; paste exit code / summary into `notes` if fail.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-05-03-fe-demo-full-refactor-v2-rollout-checklist.md
git commit -m "docs: add v2 rollout checklist with gate evidence"
```

---

### Task 4: ESLint — bucketed cleanup (after merge; do not disable product rules globally)

**Files:**

- Modify: only files reported by ESLint for each batch (typical: `@typescript-eslint/no-explicit-any`, `no-unused-vars`, `react-hooks/rules-of-hooks`, `react/jsx-no-target-blank`)

- [ ] **Step 1: Capture machine-readable report**

```bash
pnpm --filter=@zero/mail lint 2>&1 | tee /tmp/mail-lint.txt
```

- [ ] **Step 2: Group by rule**

Use editor search on `/tmp/mail-lint.txt` for `error  ` suffix patterns, or:

```bash
grep -oE '@typescript-eslint/[a-z-]+|react-hooks/[a-z-]+|react/[a-z-]+' /tmp/mail-lint.txt | sort | uniq -c | sort -nr
```

- [ ] **Step 3: Fix one rule family per commit**

Example priority:

1. `react-hooks/rules-of-hooks` in tests — rename mock factories so they are not `use*` prefixed unless they are real hooks.
2. `no-unused-vars` — remove or prefix `_` consistently with project ESLint config for unused args.
3. `no-explicit-any` — replace with `unknown` + narrow, or proper router types from `FrontendApi`.

- [ ] **Step 4: Gate**

```bash
pnpm --filter=@zero/mail lint
pnpm test:demo
```

- [ ] **Step 5: Commit per family**

```bash
git commit -am "chore(mail): eslint fix react-hooks in tests"
```

---

### Task 5 (optional polish): Surface `UnsupportedFeatureError` in UI consistently

**Files:**

- Modify: high-traffic entry points already throwing from `createHostedHttpAdapter` — e.g. `apps/mail/components/mail/mail-display.tsx`, settings pages that call mail APIs on load

- [ ] **Step 1: Add small type guard (if not already in merge)**

```typescript
import { UnsupportedFeatureError } from '@/lib/api/errors';

export function isUnsupportedFeatureError(e: unknown): e is UnsupportedFeatureError {
  return e instanceof UnsupportedFeatureError;
}
```

Place in `apps/mail/lib/api/errors.ts` next to class export, or `apps/mail/lib/api/guards.ts` if you prefer zero churn in `errors.ts`.

- [ ] **Step 2: Use in one list query `throwOnError` / `useQuery` error render**

Pick one screen (e.g. mail list shell): when `isUnsupportedFeatureError(error)`, render a single shared `<UnsupportedFeatureBanner feature={error.feature} mode={error.mode} />` component.

- [ ] **Step 3: Test**

Add Vitest unit test for `isUnsupportedFeatureError` + optional component test if you already use RTL patterns in repo.

- [ ] **Step 4: Commit**

```bash
git add apps/mail/lib/api/errors.ts apps/mail/components/...
git commit -m "feat(mail): banner for hosted unsupported features"
```

---

## Self-review

1. **Spec coverage:** v2 Task 14 (gates + checklist) → Tasks 1–3. `hotel` behavior → Task 2. ESLint debt → Task 4. Optional UI polish for unsupported → Task 5.
2. **Placeholder scan:** No TBD steps; commands and file paths are concrete.
3. **Consistency:** Uses `hosted` as internal `MailApiMode` (matches `FE-demo-refactor`); CLI `hotel` normalized in Task 2 so script and runtime agree.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-04-fe-demo-next-phase-after-refactor-branch.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — one subagent per task (merge, hotel map, checklist, ESLint batches, UI polish); review between tasks.
2. **Inline Execution** — same session, checkpoints after Task 1 and Task 2 (merge + mode fix are highest risk).

**Which approach?**

---

## Caveman summary

`FE-demo` = empty API layer. `FE-demo-refactor` = real work. Next: **merge first**, not rewrite. Then **`hotel` string → `hosted`** in `resolveMailMode` + test. Then **checklist + manual smoke**. Then **ESLint by rule**. Optional: **shared unsupported banner**.
