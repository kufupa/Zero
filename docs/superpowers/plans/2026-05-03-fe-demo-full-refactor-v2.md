# FE-demo Full Refactor v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `FE-demo` into a full-stack-capable product with a hard boundary for transport, while preserving demo mode end-to-end and avoiding breakage from one-off `frontend-only` branches.

**Architecture:** Introduce one frontend transport boundary (`MailApi`) with modes `legacy | hotel | demo`, where:

- `legacy` = existing `@zero/server` tRPC path (Google/Microsoft currently supported in server behind `createDriver(provider)`).
- `hotel` = future production hosted API path (SES/IMAP/S3/SQS/AI infra lives in backend, not UI).
- `demo` = current local mock/demo data path.

`AuthApi` is separate and also mode-aware (`legacy` uses Better Auth, `demo` uses local session). Demo and legacy do not need to be perfect mid-edit, but they must pass the checkpoint gates after each task group and must both work after the full plan.

**Tech Stack:** React 19, React Router 7, Vite, TypeScript, TanStack Query, Better Auth, Jotai, Nuqs, Radix UI, TipTap/Novel, Tailwind 4, tRPC for legacy, Vitest for regression tests.

---

I'm using the writing-plans skill.

I’m being explicit because your next coder is a faster but shallower model.

## 0) Model-aware constraints (for a "dumber" coding model)

- Do not infer behavior from tests that are currently green in demo and assume same behavior in legacy.
- Do not invent method names on `AppRouter`; verify route names in existing code before writing adapter code.
- Do not do big, all-at-once hook rewrites. Slice by slices, run targeted tests, commit.
- Never create automatic fallback:
  - `hotel -> demo` is forbidden.
  - `legacy -> demo` is forbidden.
- Never leave `FORCE_FRONTEND_ONLY_DEMO = true` as the mechanism for demo. FE-only demo must still exist, but via `VITE_PUBLIC_MAIL_API_MODE=demo` / dev script flags.
- Do not reintroduce two required demo flags. One canonical flag controls mode.
- Never leave `isFrontendOnlyDemo` branches in UI/components as transport logic.
- No provider strings in UI mode checks (`imap`, `gmail`, `aws`, `ses` etc). UI modes are only `legacy | hotel | demo`.
- For each mode/feature: return typed unsupported errors from API, do not fake success.
- Keep TipTap/Novel in place.
- Do not break `Session` type exports from `auth-client.ts`.
- Include mode in query keys to avoid demo/legacy cache collisions.
- Commit small units often.

## Why this plan is needed (critical findings)

- `apps/mail/lib/demo/runtime.ts` currently hardcodes `FORCE_FRONTEND_ONLY_DEMO = true`.
- `isFrontendOnlyDemo()` is widely spread in hooks/components/tests (`isFrontendOnlyDemo` branches across `apps/mail`).
- `trpc.ts` / `query-provider.tsx` return demo-proxy tRPC clients that reject backend calls.
- Auth session, route guards, and local actions bypass real auth in demo mode.
- Several frontend files import backend driver/internal types directly.
- Multiple feature callsites currently branch manually between demo and live paths.
- Existing tests already model behavior well but depend on old query keys.

## 0b) Decisions from code review and user comments

### Decision 1: keep one frontend `legacy` adapter, not separate Google/Microsoft adapters

Use one `legacy` adapter. Do not split frontend adapters into `google` and `microsoft`.

Reason: server already has provider adapters. `apps/server/src/lib/driver/index.ts` maps `google -> GoogleMailManager` and `microsoft -> OutlookMailManager`, both behind `MailManager` from `apps/server/src/lib/driver/types.ts`. The frontend currently calls routes like `trpc.mail.listThreads`, `trpc.mail.get`, `trpc.drafts.get`, `trpc.labels.list`; those routes already resolve active connection and provider server-side.

Splitting at frontend would duplicate an existing backend boundary and risk breaking provider differences for no gain.

### Decision 2: checkpoint stability, not "must never break mid-edit"

Do not require demo/legacy to be fully working during every individual edit. Refactors can have temporary failing state inside a task.

Required instead:
- after each task group, targeted tests pass;
- before handing off, demo + legacy gates pass;
- final state has no performance regression by design (mode-keyed cache, fewer UI branches, fewer duplicated fetch paths).

### Decision 3: FE-only demo remains first-class

Removing `FORCE_FRONTEND_ONLY_DEMO = true` does not mean removing FE-only demo.

Required final startup modes:
- `pnpm dev:demo:frontend` or `--frontend-only` starts `demo`.
- `pnpm devfull` starts `legacy`.
- `pnpm dev:hotel` starts `hotel` unsupported shell.

### Decision 4: demo tricks are allowed inside the demo adapter

Smart local shortcuts are allowed if they reduce risk:
- local store reads;
- deterministic AI/demo outputs;
- local auth session;
- no backend startup;
- local mutation simulation for labels/notes/templates/drafts.

Not allowed:
- global failing tRPC proxy as final architecture;
- UI components knowing transport;
- fake hotel/legacy success using demo data.

During migration, old demo proxy may remain until equivalent feature has moved into `MailApi`. Final state must not depend on `createDemoTrpcClient()` in `trpc.ts`, `trpc.server.ts`, or `query-provider.tsx`.

### Decision 5: `hotel` mode explicit unsupported is correct

Keep `hotel` mostly unimplemented for now, but make every unsupported path typed and obvious.

Required behavior:
- `hotel` boot works;
- missing feature throws `UnsupportedFeatureError`;
- UI shows disabled/unsupported state where feature can be reached;
- no silent fallback to demo or legacy;
- backend continuation later only fills adapter methods, not UI branches.

### Decision 6: use one canonical mode flag

Use one canonical env flag: `VITE_PUBLIC_MAIL_API_MODE=legacy|hotel|demo`.

Reason: in this branch, demo effectively means FE-only demo. The older two-flag model (`ZERO_DEMO_MODE` plus `VITE_FRONTEND_ONLY`) came from a possible distinction between "demo features/branding" and "backend disconnected". That distinction is not useful for this refactor and creates confusion.

Implementation rule:
- `VITE_PUBLIC_MAIL_API_MODE=demo` means FE-only demo.
- `VITE_PUBLIC_MAIL_API_MODE=legacy` means current full-stack Google/Microsoft backend.
- `VITE_PUBLIC_MAIL_API_MODE=hotel` means future hosted hotel backend shell.
- Old flags may be accepted as a temporary compatibility shim, but one old demo flag should be enough to map to `demo`; do not require `ZERO_DEMO_MODE && VITE_FRONTEND_ONLY`.

### Decision 7: remove frontend dependency on server internals, not every server package type

Task 9 is still the right decision, but it should be narrower than "delete every `@zero/server` import".

Remove:
- relative imports from `../../server/...` or `../../../server/...` in frontend code;
- imports from `@zero/server/src/lib/driver/types`;
- driver/provider response types in UI hooks/components.

Allow for now:
- `import type { AppRouter } from '@zero/server/trpc'` inside transport files and the legacy adapter;
- schema imports from stable server package entrypoints only if already used and not pulling server-only runtime code into browser bundles.

Risk: copying DTOs into `apps/mail/lib/api/types.ts` can drift from backend. Mitigation: legacy adapter maps backend output to canonical DTOs and adapter tests cover the mapping. Do not make UI depend directly on driver types again.

## 0a) Exa-based risk note on coding model

Spark is optimized for fast interactive edits, minimal edits, and no auto-test behavior unless asked. In fast mode, it can make plausible but incorrect assumptions.  
Plan consequence: this implementation requires explicit checks and concrete commands between every major slice.

## Migration rules

1. Preserve demo behavior at every checkpoint gate; temporary breakage inside a task is acceptable if fixed before commit.
2. Preserve legacy behavior at every checkpoint gate; temporary breakage inside a task is acceptable if fixed before commit.
3. `hotel` starts explicit and may return unsupported errors where not ready.
4. All data access in UI goes through `MailApi` or pure local helpers.
5. No UI-level provider-specific branches after migration.
6. Auth remains one of 2 modes at this stage: `legacy` and `demo` (hotel auth strategy can be added later).
7. Cache keys from new adapters include mode and account.

## File map

### New files

- `apps/mail/lib/runtime/mail-mode.ts`
- `apps/mail/lib/api/errors.ts`
- `apps/mail/lib/api/types.ts`
- `apps/mail/lib/api/query-keys.ts`
- `apps/mail/lib/api/contract.ts`
- `apps/mail/lib/api/factory.ts`
- `apps/mail/lib/api/client.ts`
- `apps/mail/lib/api/adapters/legacy-trpc.ts`
- `apps/mail/lib/api/adapters/demo-local.ts`
- `apps/mail/lib/api/adapters/hotel-http.ts`
- `apps/mail/lib/api/adapters/index.ts`
- `apps/mail/lib/auth/contract.ts`
- `apps/mail/lib/auth/adapters/legacy-better-auth.ts`
- `apps/mail/lib/auth/adapters/demo-auth.ts`
- `apps/mail/lib/auth/factory.ts`
- `apps/mail/lib/domain/folders.ts`
- `apps/mail/tests/mail-mode.test.ts`
- `apps/mail/tests/mail-api-contract.test.ts`
- `apps/mail/tests/mail-api-factory.test.ts`
- `apps/mail/tests/mail-api-legacy-adapter.test.ts`
- `apps/mail/tests/auth-adapter.test.ts`
- `apps/mail/tests/frontend-import-boundary.test.ts`
- `apps/mail/tests/no-old-demo-branches.test.ts`
- `docs/superpowers/plans/2026-05-03-fe-demo-full-refactor-v2-baseline.md`
- `docs/superpowers/plans/2026-05-03-fe-demo-full-refactor-v2-rollout-checklist.md`
- `apps/mail/tests/folder-domain.test.ts`

### Modified files

- `apps/mail/lib/demo/runtime.ts`
- `apps/mail/lib/trpc.ts`
- `apps/mail/lib/trpc.server.ts`
- `apps/mail/providers/query-provider.tsx`
- `apps/mail/lib/auth-client.ts`
- `apps/mail/lib/auth-proxy.ts`
- `apps/mail/hooks/use-threads.ts`
- `apps/mail/hooks/use-drafts.ts`
- `apps/mail/hooks/use-settings.ts`
- `apps/mail/hooks/use-labels.ts`
- `apps/mail/hooks/use-notes.tsx`
- `apps/mail/hooks/use-templates.ts`
- `apps/mail/hooks/use-summary.ts`
- `apps/mail/hooks/use-attachments.ts`
- `apps/mail/hooks/use-undo-send.ts`
- `apps/mail/hooks/use-optimistic-actions.ts`
- `apps/mail/components/context/thread-context.tsx`
- `apps/mail/components/context/label-sidebar-context.tsx`
- `apps/mail/components/context/command-palette-context.tsx`
- `apps/mail/components/mail/mail-display.tsx`
- `apps/mail/components/mail/mail-content.tsx`
- `apps/mail/components/ui/recipient-autosuggest.tsx`
- `apps/mail/components/create/create-email.tsx`
- `apps/mail/components/create/template-button.tsx`
- `apps/mail/components/mail/note-panel.tsx`
- `apps/mail/app/(auth)/login/page.tsx`
- `apps/mail/app/(routes)/mail/layout.tsx`
- `apps/mail/app/(routes)/mail/[folder]/page.tsx`
- `apps/mail/app/(routes)/settings/general/page.tsx`
- `apps/mail/app/(routes)/settings/privacy/page.tsx`
- `apps/mail/app/(routes)/settings/appearance/page.tsx`
- `apps/mail/app/(routes)/settings/connections/page.tsx`
- `apps/mail/app/(routes)/settings/danger-zone/page.tsx`
- `apps/mail/config/navigation.ts`
- `apps/mail/types/index.ts`
- `apps/mail/lib/demo-data/adapter.ts`
- `apps/mail/lib/demo/folder-map.ts`
- `scripts/run-frontend-local.mjs`
- `package.json`

## Baseline and required commands before any edits

### Task 0: freeze baseline state

- Files: `docs/superpowers/plans/2026-05-03-fe-demo-full-refactor-v2-baseline.md`

- [ ] Step 1: Create baseline doc with current blockers, preserved behavior, and known risks.

```markdown
# FE-demo Full Refactor v2 Baseline

## Source
- Source branch: FE-demo
- Target branch: FE-demo-full-refactor

## Known blockers
- `FORCE_FRONTEND_ONLY_DEMO = true`
- demo-only tRPC proxy path still active
- demo session/session fallback in auth layers
- `@zero/server/src/lib/driver/types` imports in frontend

## Must preserve
- Demo mode list/detail/send/save/settings/labels/notes/templates.
- Legacy full backend mode list/detail/send/settings.
- No UI/provider branch leakage into visual layer.
```

- [ ] Step 2: Run baseline status + diff.

```bash
git status --short
git diff --name-status origin/main...HEAD
```

- [ ] Step 3: Run baseline tests before edit.

```bash
pnpm --filter=@zero/mail exec vitest run tests/demo-runtime.test.ts tests/demo-backend-guards.test.ts
```

- [ ] Step 4: Commit baseline note.

```bash
git add docs/superpowers/plans/2026-05-03-fe-demo-full-refactor-v2-baseline.md
git commit -m "docs: baseline refactor risks for FE-demo full stack migration"
```

## Task 1: Add deterministic mode resolver

### Files
- Create: `apps/mail/lib/runtime/mail-mode.ts`
- Modify: `apps/mail/lib/demo/runtime.ts`
- Test: `apps/mail/tests/mail-mode.test.ts`

### Step 1: Add mode tests

Create `apps/mail/tests/mail-mode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isDemoMode, isFrontendOnlyDemo, resolveMailMode } from '../lib/runtime/mail-mode';

describe('mail mode resolver', () => {
  it('defaults to legacy', () => {
    expect(resolveMailMode({})).toBe('legacy');
  });

  it('supports explicit mode', () => {
    expect(resolveMailMode({ VITE_PUBLIC_MAIL_API_MODE: 'legacy' })).toBe('legacy');
    expect(resolveMailMode({ VITE_PUBLIC_MAIL_API_MODE: 'hotel' })).toBe('hotel');
    expect(resolveMailMode({ VITE_PUBLIC_MAIL_API_MODE: 'demo' })).toBe('demo');
  });

  it('maps old single demo flags to demo for compatibility', () => {
    expect(resolveMailMode({ ZERO_DEMO_MODE: '1' })).toBe('demo');
    expect(resolveMailMode({ VITE_FRONTEND_ONLY: '1' })).toBe('demo');
  });
});
```

### Step 2: Add resolver and compatibility exports

Create `apps/mail/lib/runtime/mail-mode.ts`:

```ts
export type MailApiMode = 'legacy' | 'hotel' | 'demo';

export type MailModeEnv = {
  VITE_PUBLIC_MAIL_API_MODE?: string;
  ZERO_MAIL_API_MODE?: string;
  ZERO_DEMO_MODE?: string;
  VITE_ZERO_DEMO_MODE?: string;
  VITE_FRONTEND_ONLY?: string;
  VITE_ZERO_DEMO_FRONTEND_ONLY?: string;
  ZERO_DEMO_FRONTEND_ONLY?: string;
};

const valid = (v: unknown): v is MailApiMode => v === 'legacy' || v === 'hotel' || v === 'demo';
const isTrue = (v?: string) => v === '1' || v === 'true';

export function resolveMailMode(env: MailModeEnv = import.meta.env as unknown as MailModeEnv): MailApiMode {
  const explicit = env.VITE_PUBLIC_MAIL_API_MODE ?? env.ZERO_MAIL_API_MODE;
  if (valid(explicit)) return explicit;

  const legacyDemoFlag =
    isTrue(env.ZERO_DEMO_MODE) ||
    isTrue(env.VITE_ZERO_DEMO_MODE) ||
    isTrue(env.VITE_FRONTEND_ONLY) ||
    isTrue(env.VITE_ZERO_DEMO_FRONTEND_ONLY) ||
    isTrue(env.ZERO_DEMO_FRONTEND_ONLY);

  if (legacyDemoFlag) return 'demo';
  return 'legacy';
}

export function isDemoMode(env?: MailModeEnv) {
  return resolveMailMode(env) === 'demo';
}

export function isFrontendOnlyDemo(env?: MailModeEnv) {
  return resolveMailMode(env) === 'demo';
}
```

Update `apps/mail/lib/demo/runtime.ts`:

```ts
import { DEMO_FEATURES, type DemoFeatureKey } from './config';
export { isDemoMode, isFrontendOnlyDemo, resolveMailMode, type MailApiMode } from '../runtime/mail-mode';

export const FORCE_FRONTEND_ONLY_DEMO = false;

export function isDemoFeatureEnabled(key: DemoFeatureKey) {
  return DEMO_FEATURES[key];
}
```

### Step 3: Run tests

```bash
pnpm --filter=@zero/mail exec vitest run tests/mail-mode.test.ts tests/demo-runtime.test.ts
```

### Step 4: Commit

```bash
git add apps/mail/lib/runtime/mail-mode.ts apps/mail/lib/demo/runtime.ts apps/mail/tests/mail-mode.test.ts apps/mail/tests/demo-runtime.test.ts
git commit -m "feat: add explicit mail mode resolver"
```

## Task 2: Add Mail API contract + canonical types + query-key ownership

### Files
- Create: `apps/mail/lib/api/errors.ts`
- Create: `apps/mail/lib/api/types.ts`
- Create: `apps/mail/lib/api/query-keys.ts`
- Create: `apps/mail/lib/api/contract.ts`
- Test: `apps/mail/tests/mail-api-contract.test.ts`

### Step 1: Add typed errors and tests

Create `apps/mail/lib/api/errors.ts` and `apps/mail/tests/mail-api-contract.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BackendUnavailableError, UnsupportedFeatureError } from '../lib/api/errors';
import { createMailQueryKeys } from '../lib/api/query-keys';

describe('contract helpers', () => {
  it('maps unsupported errors to stable metadata', () => {
    const err = new UnsupportedFeatureError('aiSummary', 'hotel');
    expect(err.code).toBe('UNSUPPORTED_FEATURE');
    expect(err.mode).toBe('hotel');
  });

  it('maps backend unavailable errors', () => {
    const err = new BackendUnavailableError('legacy');
    expect(err.code).toBe('BACKEND_UNAVAILABLE');
    expect(err.mode).toBe('legacy');
  });

  it('includes mode and account in keys', () => {
    const keys = createMailQueryKeys({ mode: 'demo', accountId: 'a1' });
    expect(keys.threads.list({ folder: 'inbox', q: '', labelIds: [] })).toEqual([
      'mailApi',
      'demo',
      'a1',
      'threads',
      'list',
      { folder: 'inbox', q: '', labelIds: [] },
    ]);
  });
});
```

Create `apps/mail/lib/api/types.ts` (canonical DTOs, no server driver/internal imports in UI-facing code).

Create `apps/mail/lib/api/query-keys.ts` with mode/account root keys.

Create `apps/mail/lib/api/contract.ts` including:
- `MailApiMode`
- `MailApiCapabilities`
- `MailApi` surface:
  - threads: `list`, `get`, `delete`, `archive`
  - drafts: `get`, `save`
  - compose: `send`, `unsend`
  - labels: `list`, `create`, `delete`
  - folders: `list`
  - ai: `summarizeThread`, `draftReply`, `expandSearchQuery`, `webSearch`
  - settings: `get`, `save`

### Step 2: run and commit

```bash
pnpm --filter=@zero/mail exec vitest run tests/mail-api-contract.test.ts
git add apps/mail/lib/api/*.ts apps/mail/tests/mail-api-contract.test.ts
git commit -m "feat: define strict mail api contract and typed DTOs"
```

## Task 3: Build adapter registry and hotel unsupported shell

### Files
- Create: `apps/mail/lib/api/adapters/index.ts`
- Create: `apps/mail/lib/api/adapters/hotel-http.ts`
- Create: `apps/mail/lib/api/adapters/demo-local.ts`
- Create: `apps/mail/lib/api/factory.ts`
- Create: `apps/mail/lib/api/client.ts`
- Test: `apps/mail/tests/mail-api-factory.test.ts`

### Step 1: Add unsupported shell tests

Create `apps/mail/tests/mail-api-factory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { UnsupportedFeatureError } from '../lib/api/errors';
import { createMailApiForMode } from '../lib/api/factory';

describe('mail adapter factory', () => {
  it('returns demo adapter', () => {
    expect(createMailApiForMode('demo').capabilities.mode).toBe('demo');
  });

  it('returns legacy adapter', () => {
    expect(createMailApiForMode('legacy').capabilities.mode).toBe('legacy');
  });

  it('returns hotel unsupported features explicitly', async () => {
    const api = createMailApiForMode('hotel');
    await expect(api.ai.draftReply({ prompt: 'x' })).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });
});
```

### Step 2: Add `hotel-http` with unsupported functions

Create `apps/mail/lib/api/adapters/hotel-http.ts` where all methods return `Promise.reject(new UnsupportedFeatureError(..., 'hotel'))` initially.

### Step 3: Add adapter entry files and factory

- `apps/mail/lib/api/adapters/index.ts` should export:
  - `createHotelHttpAdapter`
  - `createDemoAdapter` (or stub import)
  - `createLegacyTrpcAdapter` placeholder for now.
- `apps/mail/lib/api/factory.ts` selects mode.
- `apps/mail/lib/api/client.ts` creates singleton `mailApi`.

### Step 4: run + commit

```bash
pnpm --filter=@zero/mail exec vitest run tests/mail-api-factory.test.ts
git add apps/mail/lib/api apps/mail/tests/mail-api-factory.test.ts
git commit -m "feat: add mail api adapter registry and mode factory"
```

## Task 4: Move `threads` path to mail adapter

### Files
- Modify: `apps/mail/lib/api/adapters/index.ts` (or `demo-local.ts`) to add real thread methods.
- Modify: `apps/mail/lib/api/adapters/legacy-trpc.ts` later in Task 6.
- Modify: `apps/mail/hooks/use-threads.ts`
- Test: `apps/mail/tests/demo-backend-guards.test.ts`

### Step 1: Hook migration (safe slice)

Update `useThreads` to:
- resolve `mode = resolveMailMode()`
- use `mailApi.threads.list(...)` and `mailApi.threads.get(...)`
- use `createMailQueryKeys` for keys
- keep all existing public hook return signatures unchanged

### Step 2: Ensure demo behavior unchanged

Run targeted tests and update expected query keys to new names (`mailApi` root + mode).

```bash
pnpm --filter=@zero/mail exec vitest run tests/use-threads.test.ts tests/demo-backend-guards.test.ts tests/demo-data.adapter.test.ts
```

### Step 3: commit

```bash
git add apps/mail/hooks/use-threads.ts apps/mail/lib/api apps/mail/tests/demo-backend-guards.test.ts
git commit -m "refactor: route thread reads via mail api"
```

## Task 5: Implement legacy tRPC adapter before touching large callsites

### Files
- Create: `apps/mail/lib/api/adapters/legacy-trpc.ts`
- Modify: `apps/mail/lib/api/adapters/index.ts`
- Test: `apps/mail/tests/mail-api-legacy-adapter.test.ts`

### Step 1: adapter contract probe test

Write test that calls:
- `listThreads.query`
- `get.query`
- `labels.list.query`
- `ai` methods via real route names from existing code.

### Step 2: create adapter with method names from verified router usage

Avoid guessing route names. Copy from existing hook usage before writing methods.

### Step 3: run and commit

```bash
pnpm --filter=@zero/mail exec vitest run tests/mail-api-legacy-adapter.test.ts
git add apps/mail/lib/api/adapters/legacy-trpc.ts apps/mail/lib/api/adapters/index.ts apps/mail/tests/mail-api-legacy-adapter.test.ts
git commit -m "feat: implement legacy trpc mail adapter"
```

## Task 6: Remove demo tRPC proxy from transport providers

### Files
- Modify: `apps/mail/lib/trpc.ts`
- Modify: `apps/mail/lib/trpc.server.ts`
- Modify: `apps/mail/providers/query-provider.tsx`
- Test: `apps/mail/tests/demo-backend-guards.test.ts`

### Step

Do not do this early. The demo tRPC proxy is currently a safety net while old feature hooks still have mixed transport behavior.

Remove `createDemoTrpcClient`/demo-proxy branches only after migrated feature groups cover:
- threads;
- drafts/settings;
- labels/notes/templates/summary;
- compose/send/undo;
- AI/search.

Final state: provider files always create real tRPC clients, and demo behavior is controlled by `MailApi` / `AuthApi`, not by global failing proxy.

If removing proxy breaks demo before all old callsites are migrated, revert this task and continue feature migration first.

### Verify

```bash
pnpm --filter=@zero/mail exec vitest run tests/demo-backend-guards.test.ts
```

Commit and move on only if this compiles.

## Task 7: Migrate feature hooks in bounded groups

This is the main refactor. Use one group per commit.

### Group A: drafts + settings
- `apps/mail/hooks/use-drafts.ts`
- `apps/mail/hooks/use-settings.ts`
- `apps/mail/tests/demo-backend-guards.test.ts`
- `apps/mail/app/(routes)/settings/general/page.tsx`

### Group B: labels + notes + templates + summary
- `apps/mail/hooks/use-labels.ts`
- `apps/mail/hooks/use-notes.tsx`
- `apps/mail/hooks/use-templates.ts`
- `apps/mail/hooks/use-summary.ts`
- `apps/mail/components/context/thread-context.tsx`
- `apps/mail/components/context/label-sidebar-context.tsx`

### Group C: attachments + undo + optimistic actions
- `apps/mail/hooks/use-attachments.ts`
- `apps/mail/hooks/use-undo-send.ts`
- `apps/mail/hooks/use-optimistic-actions.ts`
- `apps/mail/components/mail/note-panel.tsx`
- `apps/mail/components/create/template-button.tsx`

For each group:
- replace transport checks with `mailApi`
- keep existing external behavior identical
- run:
  - `pnpm --filter=@zero/mail exec vitest run tests/demo-backend-guards.test.ts`
  - targeted component tests if touched
- commit each group.

## Task 8: Add auth adapter boundary

### Files
- Create: `apps/mail/lib/auth/contract.ts`
- Create: `apps/mail/lib/auth/adapters/legacy-better-auth.ts`
- Create: `apps/mail/lib/auth/adapters/demo-auth.ts`
- Create: `apps/mail/lib/auth/factory.ts`
- Modify: `apps/mail/lib/auth-client.ts`
- Modify: `apps/mail/lib/auth-proxy.ts`
- Test: `apps/mail/tests/auth-adapter.test.ts`

### Rules
- Keep existing export names used by existing callers.
- `demo` auth returns local demo session.
- Legacy uses current Better Auth client.
- Keep route guards behavior for `legacy` and `hotel`; demo bypasses backend.

### Run

```bash
pnpm --filter=@zero/mail exec vitest run tests/auth-adapter.test.ts tests/demo-session.test.ts
```

## Task 9: Remove server-internal type coupling in frontend

### Files
- Modify: `apps/mail/types/index.ts`
- Modify: `apps/mail/lib/demo-data/adapter.ts`
- Modify: `apps/mail/hooks/use-threads.ts`
- Modify: `apps/mail/components/mail/mail-list.tsx`
- Add test: `apps/mail/tests/frontend-import-boundary.test.ts`

### Step

Create import-scan test that fails on server internals and driver types in frontend feature code:

- `../../server/src/lib/driver/types`
- `../../../server/src/lib/driver/types`
- `@zero/server/src/lib/driver/types`

Do not fail transport-only imports of `@zero/server/trpc` yet; the legacy adapter needs `AppRouter` typing. Move affected driver/response types into `apps/mail/lib/api/types.ts` and map them in adapters.

### Run

```bash
pnpm --filter=@zero/mail exec vitest run tests/frontend-import-boundary.test.ts
```

## Task 10: Normalize folder/domain and navigation model

### Files
- Create: `apps/mail/lib/domain/folders.ts`
- Modify: `apps/mail/lib/demo/folder-map.ts`
- Modify: `apps/mail/config/navigation.ts`
- Modify: `apps/mail/app/(routes)/mail/[folder]/page.tsx`
- Test: `apps/mail/tests/folder-domain.test.ts`

### Rule

No Centurion/provider-specific folder strings in components once migrated; keep them in demo mapping/adapters.

## Task 11: Move AI/search paths into mail API

### Files
- Modify: `apps/mail/components/context/command-palette-context.tsx`
- Modify: `apps/mail/components/mail/mail-display.tsx`
- Modify: `apps/mail/components/ui/ai-sidebar.tsx`
- Modify: `apps/mail/components/create/create-email.tsx`
- Modify: `apps/mail/lib/api/contract.ts`
- Modify: `apps/mail/lib/api/adapters/index.ts`
- Test: existing `demo-backend-guards.test.ts` cases.

### Rule

Demo mode returns deterministic results for expansion/search. Legacy/hotel use adapter behavior with explicit unsupported handling.

## Task 12: Add static drift guards

### Files
- Create: `apps/mail/tests/no-old-demo-branches.test.ts`

### Step

Fail build if old `isFrontendOnlyDemo()` usage remains in UI/feature files outside `lib/demo/runtime.ts` and `tests/` boundaries.  
Commit when clean.

## Task 13: Update scripts + mode docs

### Files
- Modify: `scripts/run-frontend-local.mjs`
- Modify: `package.json`
- Add: `docs/superpowers/plans/2026-05-03-fe-demo-full-refactor-v2-rollout-checklist.md`

### Script mapping (required)

- `--frontend-only` => `VITE_PUBLIC_MAIL_API_MODE=demo`
- `--full` => `VITE_PUBLIC_MAIL_API_MODE=legacy`
- `--hotel` => `VITE_PUBLIC_MAIL_API_MODE=hotel`

Add `dev:hotel` script.

## Task 14: Final gates

### Test gates

Run:

```bash
pnpm --filter=@zero/mail exec vitest run tests
pnpm --filter=@zero/mail lint
pnpm build:frontend
```

### Behavior gates

- Demo: inbox/thread/compose/send/draft/labels/notes/templates/settings all work; no backend calls.
- Legacy: login/session/thread/detail/send/settings/labels all use backend path.
- Hotel: unsupported features throw `UnsupportedFeatureError` and show disabled UI states.

Update checklist file with pass/fail evidence.

## Common irreversible mistakes this plan prevents

- Migrating without removing demo-proxy from `query-provider.tsx` and `trpc.ts` (causes “backend is disabled” even in legacy mode).
- Leaving `FORCE_FRONTEND_ONLY_DEMO = true`.
- Letting `demo` data bleed into real cache.
- Accidentally breaking UI imports and adding backend coupling back through new helper methods.
- Route guard deadlocks from auth adapter regression.

## Execution order recommended for stability

1) Task 1  
2) Task 2  
3) Task 3  
4) Task 4  
5) Task 5  
6) Task 7 group A  
8) Task 8  
9) Task 7 group B  
10) Task 7 group C  
11) Task 11  
12) Task 6  
13) Task 9  
14) Task 10  
15) Task 12  
16) Task 13  
17) Task 14

No single task can skip test+commit.

## Open questions for you before execution

- `hotel` initial feature set: keep AI, labels, settings, notes blocked initially or partial rollout?
- Should `hotel` include folders at v1 or show backend-defined folder list from a dedicated endpoint?
- Should unauthenticated mode in hotel remain a redirect to login immediately, same as legacy?
- Which UI copy should be used for unsupported features (`hotel` mode)?

## Plan complete and saved to `docs/superpowers/plans/2026-05-03-fe-demo-full-refactor-v2.md`.

Two execution options:

1) Subagent-Driven (recommended): one task per subagent + review between tasks.
2) Inline Execution: same session, checkpoint-based.
