# FE-Only Demo Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Centurion demo inbox with `ZERO_DEMO_MODE=1` without starting `apps/server`, while keeping normal FE+BE behavior unchanged outside demo.

**Architecture:** Keep production/non-demo path on existing tRPC backend. Add a frontend-only demo data adapter that serves `mail.listThreads` + `mail.get` from local JSON, and gate backend-dependent hooks behind a single `isFrontendOnlyDemo()` flag. Update dev startup script to skip backend boot/probe when frontend-only demo is active.

**Tech Stack:** React Router + Vite, TanStack Query, existing mail hooks (`useThreads`, `useLabels`, `useConnections`, `useSettings`), JSON demo corpus + Zod validation, Vitest (mail package tests).

---

## Feasibility Verdict

This is feasible for the current demo scope (read-only inbox + thread viewing).

- Feasible now: inbox list, thread detail, navigation, screenshots.
- Requires explicit stubbing: labels/connections/settings queries that currently call backend.
- Not in scope for FE-only v1: real sync, force-sync, send mail, server-side processing endpoints.

---

## File Structure (planned)

### New files

- `apps/mail/lib/demo-mail/centurion-threads.json`
  - Frontend-local copy of demo corpus (same contract as server corpus loader uses for list/get mapping).
- `apps/mail/lib/demo-mail/schema.ts`
  - Zod schema for frontend corpus validation.
- `apps/mail/lib/demo-mail/adapter.ts`
  - Pure functions: `listDemoThreads()` + `getDemoThread()` returning app-consumable data.
- `apps/mail/lib/demo-frontonly.ts`
  - Single source of truth for `isFrontendOnlyDemo()`.
- `apps/mail/tests/demo-mail.adapter.test.ts`
  - Unit tests for corpus adapter (list + get + filter behavior).
- `apps/mail/vitest.config.ts`
  - Vitest config for mail package.

### Modified files

- `apps/mail/package.json`
  - Add `test:demo` script and vitest dev dependency.
- `apps/mail/hooks/use-threads.ts`
  - Branch query source: frontend adapter in FE-only demo, tRPC otherwise.
- `apps/mail/hooks/use-labels.ts`
  - Short-circuit to empty labels in FE-only demo (no backend query).
- `apps/mail/hooks/use-connections.ts`
  - Return demo connection in FE-only demo.
- `apps/mail/hooks/use-settings.ts`
  - Disable backend settings query in FE-only demo.
- `scripts/run-frontend-local.mjs`
  - Skip backend boot/probe for FE-only demo mode.
- `package.json`
  - Add ergonomic root script for FE-only demo launch.

---

### Task 1: Frontend Demo Data Adapter + Tests

**Files:**
- Create: `apps/mail/lib/demo-mail/centurion-threads.json`
- Create: `apps/mail/lib/demo-mail/schema.ts`
- Create: `apps/mail/lib/demo-mail/adapter.ts`
- Create: `apps/mail/tests/demo-mail.adapter.test.ts`
- Create: `apps/mail/vitest.config.ts`
- Modify: `apps/mail/package.json`

- [ ] **Step 1: Write the failing tests for adapter contract**

```ts
// apps/mail/tests/demo-mail.adapter.test.ts
import { describe, expect, it } from 'vitest';
import { getDemoThread, listDemoThreads } from '../lib/demo-mail/adapter';

describe('demo-mail adapter', () => {
  it('returns inbox threads for default list call', () => {
    const result = listDemoThreads({ folder: 'inbox', q: '', cursor: '', maxResults: 50, labelIds: [] });
    expect(result.threads.length).toBeGreaterThan(0);
    expect(result.nextPageToken).toBeNull();
  });

  it('returns empty list for non-inbox folder', () => {
    const result = listDemoThreads({ folder: 'sent', q: '', cursor: '', maxResults: 50, labelIds: [] });
    expect(result.threads).toEqual([]);
  });

  it('returns thread detail for known id', () => {
    const list = listDemoThreads({ folder: 'inbox', q: '', cursor: '', maxResults: 50, labelIds: [] });
    const firstId = list.threads[0]?.id;
    expect(firstId).toBeTruthy();
    const thread = getDemoThread(firstId!);
    expect(thread.latest?.subject).toBeTruthy();
    expect(thread.messages.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/mail exec vitest run tests/demo-mail.adapter.test.ts`  
Expected: FAIL with module-not-found for `../lib/demo-mail/adapter` and/or missing vitest config.

- [ ] **Step 3: Implement minimal adapter + schema + config**

```ts
// apps/mail/lib/demo-mail/adapter.ts (core shape)
import corpus from './centurion-threads.json';
import { CenturionCorpusSchema } from './schema';

const parsed = CenturionCorpusSchema.parse(corpus);

export function listDemoThreads(input: {
  folder?: string;
  q?: string;
  cursor?: string;
  maxResults?: number;
  labelIds?: string[];
}) {
  if ((input.folder ?? 'inbox') !== 'inbox') return { threads: [], nextPageToken: null };
  if ((input.labelIds ?? []).length > 0) return { threads: [], nextPageToken: null };
  const rows = parsed.threads.map((t) => ({ id: t.id, historyId: null }));
  return { threads: rows, nextPageToken: null };
}

export function getDemoThread(id: string) {
  const thread = parsed.threads.find((t) => t.id === id);
  if (!thread) throw new Error(`Demo thread not found: ${id}`);
  // map to IGetThreadResponse-compatible shape used by mail components
  return {
    messages: thread.messages.map((m) => ({ ...m, threadId: thread.id })),
    latest: thread.messages[thread.messages.length - 1],
    hasUnread: thread.messages.some((m) => m.unread),
    totalReplies: thread.messages.length,
    labels: thread.labels ?? [{ id: 'INBOX', name: 'INBOX' }],
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --dir apps/mail exec vitest run tests/demo-mail.adapter.test.ts`  
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/demo-mail apps/mail/tests/demo-mail.adapter.test.ts apps/mail/vitest.config.ts apps/mail/package.json
git commit -m "test(mail): add FE demo corpus adapter with list/get coverage"
```

---

### Task 2: Route Mail Hooks to Local Adapter in FE-Only Demo

**Files:**
- Modify: `apps/mail/lib/demo-frontonly.ts` (create if absent)
- Modify: `apps/mail/hooks/use-threads.ts`
- Test: `apps/mail/tests/demo-mail.adapter.test.ts`

- [ ] **Step 1: Add failing integration-style test for frontend-only toggle behavior**

```ts
// extend apps/mail/tests/demo-mail.adapter.test.ts
import { isFrontendOnlyDemo } from '../lib/demo-frontonly';

it('frontend-only demo flag resolves true when demo + frontend-only are set', () => {
  // test helper in file can pass env values directly
  expect(isFrontendOnlyDemo({ ZERO_DEMO_MODE: '1', VITE_FRONTEND_ONLY: '1' })).toBe(true);
  expect(isFrontendOnlyDemo({ ZERO_DEMO_MODE: '1', VITE_FRONTEND_ONLY: '0' })).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/mail exec vitest run tests/demo-mail.adapter.test.ts -t frontend-only`  
Expected: FAIL because `isFrontendOnlyDemo` helper does not exist yet.

- [ ] **Step 3: Implement frontend-only flag helper + hook branch**

```ts
// apps/mail/lib/demo-frontonly.ts
import { isDemoMode } from './demo-session';

export function isFrontendOnlyDemo(
  env: { ZERO_DEMO_MODE?: string; VITE_FRONTEND_ONLY?: string } = import.meta.env,
) {
  return (env.ZERO_DEMO_MODE ?? (isDemoMode() ? '1' : '0')) === '1' && env.VITE_FRONTEND_ONLY === '1';
}
```

```ts
// apps/mail/hooks/use-threads.ts (key logic)
const demoFrontendOnly = isFrontendOnlyDemo();

const threadsQuery = useInfiniteQuery(
  demoFrontendOnly
    ? {
        queryKey: ['demo-mail', 'listThreads', folder, searchValue.value, labels.join(',')],
        initialPageParam: '',
        queryFn: ({ pageParam }) =>
          Promise.resolve(
            listDemoThreads({ folder, q: searchValue.value, cursor: String(pageParam ?? ''), maxResults: 50, labelIds: labels }),
          ),
        getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
      }
    : trpc.mail.listThreads.infiniteQueryOptions({ q: searchValue.value, folder, labelIds: labels }, { initialCursor: '' }),
);

const threadQuery = useQuery(
  demoFrontendOnly
    ? {
        queryKey: ['demo-mail', 'getThread', id],
        queryFn: () => Promise.resolve(getDemoThread(id!)),
        enabled: !!id,
      }
    : trpc.mail.get.queryOptions({ id: id! }, { enabled: !!id && (!!session?.user?.id || isDemoMode()) }),
);
```

- [ ] **Step 4: Run tests + smoke check**

Run:
- `pnpm --dir apps/mail exec vitest run tests/demo-mail.adapter.test.ts`
- `ZERO_DEMO_MODE=1 VITE_FRONTEND_ONLY=1 pnpm dev:frontend`

Expected:
- Tests PASS
- Inbox renders Centurion threads without backend process running.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/demo-frontonly.ts apps/mail/hooks/use-threads.ts apps/mail/tests/demo-mail.adapter.test.ts
git commit -m "feat(mail): source demo thread data locally in FE-only mode"
```

---

### Task 3: Stub Backend-Dependent Ancillary Hooks in FE-Only Demo

**Files:**
- Modify: `apps/mail/hooks/use-labels.ts`
- Modify: `apps/mail/hooks/use-connections.ts`
- Modify: `apps/mail/hooks/use-settings.ts`
- Modify: `apps/mail/components/ui/nav-user.tsx`
- Test: `apps/mail/tests/demo-mail.adapter.test.ts`

- [ ] **Step 1: Write failing tests for no-network fallback helpers**

```ts
// add to apps/mail/tests/demo-mail.adapter.test.ts
import { getDemoConnection } from '../hooks/use-connections';

it('returns demo connection shape', () => {
  const connection = getDemoConnection();
  expect(connection.providerId).toBe('google');
  expect(connection.email).toContain('legacyhotels.com');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/mail exec vitest run tests/demo-mail.adapter.test.ts -t demo\\ connection`  
Expected: FAIL because helper/export does not exist.

- [ ] **Step 3: Implement demo short-circuits**

```ts
// apps/mail/hooks/use-labels.ts (early return)
if (isFrontendOnlyDemo()) {
  return {
    userLabels: [],
    systemLabels: [],
    data: [],
    isLoading: false,
    isFetching: false,
  } as const;
}
```

```ts
// apps/mail/hooks/use-connections.ts
export const getDemoConnection = () => ({
  id: 'demo-connection',
  providerId: 'google',
  email: 'centurion@legacyhotels.com',
  name: 'The Centurion',
  picture: null,
  createdAt: new Date().toISOString(),
});

if (isFrontendOnlyDemo()) {
  return { data: getDemoConnection(), isLoading: false, isFetching: false } as const;
}
```

```ts
// apps/mail/hooks/use-settings.ts
const settingsQuery = useQuery(
  trpc.settings.get.queryOptions(void 0, {
    enabled: !isFrontendOnlyDemo() && !!session?.user?.id,
    staleTime: Infinity,
  }),
);
```

- [ ] **Step 4: Run tests + manual browser verification**

Run:
- `pnpm --dir apps/mail exec vitest run tests/demo-mail.adapter.test.ts`
- Start FE-only demo and load `/mail/inbox`

Expected:
- No blocking tRPC failures from labels/connections/settings in console.
- Inbox still renders demo threads.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/hooks/use-labels.ts apps/mail/hooks/use-connections.ts apps/mail/hooks/use-settings.ts apps/mail/components/ui/nav-user.tsx apps/mail/tests/demo-mail.adapter.test.ts
git commit -m "fix(mail): bypass backend-only hooks in FE-only demo mode"
```

---

### Task 4: Startup Script + Developer Workflow for FE-Only Demo

**Files:**
- Modify: `scripts/run-frontend-local.mjs`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-04-07-centurion-mock-inbox-design.md`

- [ ] **Step 1: Write failing script-level expectation (manual test note)**

```text
Expectation: with ZERO_DEMO_MODE=1 and ZERO_DEMO_FRONTEND_ONLY not set to 0,
run-frontend-local must not attempt backend probe/start and must set VITE_FRONTEND_ONLY=1.
```

- [ ] **Step 2: Run existing command to show current behavior fails expectation**

Run: `ZERO_DEMO_MODE=1 pnpm devfull`  
Expected (current): logs backend probe/start attempt (`Backend not reachable ... attempting to start apps/server...`).

- [ ] **Step 3: Implement script changes + root command**

```js
// scripts/run-frontend-local.mjs (key block)
const demoFrontendOnly =
  process.env.ZERO_DEMO_MODE === '1' && process.env.ZERO_DEMO_FRONTEND_ONLY !== '0';

const backendReachable =
  forceFrontendOnly || demoFrontendOnly ? false : await startBackendIfNeeded(env);

env.VITE_FRONTEND_ONLY =
  forceFrontendOnly || demoFrontendOnly ? '1' : backendReachable ? '0' : '1';

if (demoFrontendOnly) {
  console.log('[local-dev] FE-only demo mode active; skipping backend startup.');
}
```

```json
// package.json scripts
{
  "dev:demo:frontend": "ZERO_DEMO_MODE=1 ZERO_DEMO_FRONTEND_ONLY=1 pnpm dev:frontend"
}
```

- [ ] **Step 4: Verify end-to-end behavior**

Run:
- `pnpm cleanup:dev`
- `pnpm dev:demo:frontend`

Expected:
- No backend process on `8787`.
- Frontend on `3000`.
- `/mail/inbox` renders Centurion threads.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-frontend-local.mjs package.json docs/superpowers/specs/2026-04-07-centurion-mock-inbox-design.md
git commit -m "chore(dev): add FE-only demo startup path without backend"
```

---

## Self-Review

### 1. Spec coverage

- Demo corpus availability in UI: covered (Task 1 + Task 2).
- Demo-mode behavior simplification: covered (Task 3 + Task 4).
- Maintain non-demo behavior: covered by conditional `isFrontendOnlyDemo()` routing.
- Lightweight verification in UI: covered in each task’s verification steps.

No spec gaps found for the requested FE-only feasibility/implementation path.

### 2. Placeholder scan

- No `TODO/TBD` placeholders in tasks.
- Every code-change step contains explicit code.
- Every validation step contains explicit commands and expected outcomes.

### 3. Type consistency

- Single flag function `isFrontendOnlyDemo()` used consistently across hooks/scripts.
- Demo connection shape references `providerId/email/name/id` used by `NavUser`.
- Thread list/get adapter output mirrors existing `useThreads/useThread` consumption (`id/historyId`, `messages/latest/labels`).

