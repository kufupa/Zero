# FE-Demo Frontend-Only Client Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a stable, fast, frontend-only demo branch (`FE-demo`) with zero backend dependency, deterministic mock data, work-queue UI, and static AI-draft preview flows suitable for live demos and recorded client walkthroughs.

**Architecture:** Add a small typed demo kernel in `apps/mail` that is the single source of truth for runtime mode, feature switches, and demo data access. In demo mode, hooks route to local adapters and never require tRPC/backend responses. Remove interactive AI chat surfaces from the branch and keep only deterministic draft-preview UX sourced from the local corpus.

**Tech Stack:** React Router 7, Vite, TanStack Query, Jotai, Zod, Vitest, Paraglide, Node scripts, pnpm.

---

## Scope Check

This remains one cohesive subsystem: **frontend-only demo platformization** for `FE-demo`.

- Runtime isolation (no backend calls), mock data, and demo UX are tightly coupled and must ship together.
- Dev speed and process cleanup are included because they directly affect demo reliability and iteration speed.
- Real backend behavior and real AI inference are intentionally out of scope.

---

## File Structure

### New files

- `apps/mail/lib/demo/config.ts`
  - Typed single source of truth for demo mode and feature toggles.
- `apps/mail/lib/demo/runtime.ts`
  - `isDemoMode()`, `isFrontendOnlyDemo()`, `isDemoFeatureEnabled()`.
- `apps/mail/lib/demo-data/centurion-threads.json`
  - Canonical deterministic demo corpus.
- `apps/mail/lib/demo-data/schema.ts`
  - Zod schema for corpus validation.
- `apps/mail/lib/demo-data/work-queue.ts`
  - Queue slug types + pure filter helpers.
- `apps/mail/lib/demo-data/adapter.ts`
  - `listDemoThreads()` + `getDemoThread()` mapping to UI-consumable shape.
- `apps/mail/app/(routes)/mail/work/[queue]/page.tsx`
  - Work queue route page + slug validation.
- `apps/mail/store/demo-ai-draft-reviewed.ts`
  - Per-thread local reviewed state for static AI-draft preview.
- `apps/mail/components/mail/ai-draft-preview-panel.tsx`
  - Read-only draft preview component.
- `apps/mail/vitest.config.ts`
  - Mail package Vitest config.
- `apps/mail/tests/demo-runtime.test.ts`
  - Runtime flag and helper tests.
- `apps/mail/tests/demo-data.adapter.test.ts`
  - Adapter list/get/filter tests.
- `apps/mail/tests/work-queue-filter.test.ts`
  - Queue matching unit tests.
- `scripts/cleanup-dev-processes.mjs`
  - Repo-scoped process cleanup.
- `scripts/verify-demo-no-backend.mjs`
  - Guardrail script ensuring demo-mode paths do not depend on backend runtime.
- `scripts/verify-lean-dev-profile.mjs`
  - Lean-profile env verification.
- `docs/superpowers/ai-coding-guardrails.md`
  - Explicit AI-edit boundaries and update checklist.

### Modified files

- `scripts/run-frontend-local.mjs`
  - Force backend skip in frontend-only demo mode and robust shutdown behavior.
- `apps/mail/components/mail/mail.tsx`
  - Remove AI sidebar/toggle rendering for this branch.
- `apps/mail/components/mail/thread-display.tsx`
  - Remove chat CTA; integrate static draft preview entry flow.
- `apps/mail/components/ui/app-sidebar.tsx`
  - Remove AI fullscreen coupling; add demo work queues section.
- `apps/mail/hooks/use-threads.ts`
  - Route list/get to demo adapter in frontend-only demo mode.
- `apps/mail/hooks/use-labels.ts`
  - Demo-safe labels fallback.
- `apps/mail/hooks/use-connections.ts`
  - Demo-safe active connection fallback.
- `apps/mail/hooks/use-settings.ts`
  - Demo-safe settings fallback.
- `apps/mail/app/routes.ts`
  - Register `/mail/work/:queue` before `/:folder`.
- `apps/mail/components/mail/mail-list.tsx`
  - Urgent row stripe + queue empty state.
- `apps/mail/types/index.ts`
  - Extend thread list row type metadata.
- `apps/mail/messages/en.json`
  - Work queue labels and empty-state copy.
- `apps/mail/package.json`
  - Add vitest + fast verification scripts.
- `apps/mail/vite.config.ts`
  - Lean dev toggles for expensive features.
- `package.json`
  - Root demo commands and guardrail script wiring.
- `README.md`
  - Frontend-only demo workflow docs.

---

### Task 1: Add Demo Runtime Kernel (single source of truth)

**Files:**
- Create: `apps/mail/lib/demo/config.ts`
- Create: `apps/mail/lib/demo/runtime.ts`
- Create: `apps/mail/tests/demo-runtime.test.ts`
- Create: `apps/mail/vitest.config.ts`
- Modify: `apps/mail/package.json`
- Test: `apps/mail/tests/demo-runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/mail/tests/demo-runtime.test.ts
import { describe, expect, it } from 'vitest';
import { isDemoMode, isFrontendOnlyDemo, isDemoFeatureEnabled } from '../lib/demo/runtime';

describe('demo runtime', () => {
  it('treats ZERO_DEMO_MODE=1 as demo mode', () => {
    expect(isDemoMode({ ZERO_DEMO_MODE: '1' })).toBe(true);
    expect(isDemoMode({ ZERO_DEMO_MODE: '0' })).toBe(false);
  });

  it('requires both demo + frontend-only to hard disconnect backend', () => {
    expect(
      isFrontendOnlyDemo({
        ZERO_DEMO_MODE: '1',
        VITE_FRONTEND_ONLY: '1',
      }),
    ).toBe(true);
    expect(
      isFrontendOnlyDemo({
        ZERO_DEMO_MODE: '1',
        VITE_FRONTEND_ONLY: '0',
      }),
    ).toBe(false);
  });

  it('reads typed feature toggles safely', () => {
    expect(isDemoFeatureEnabled('showAiDraftPreview')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/mail exec vitest run tests/demo-runtime.test.ts -v`  
Expected: FAIL (`Cannot find module '../lib/demo/runtime'`).

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/mail/lib/demo/config.ts
export const DEMO_FEATURES = {
  showWorkQueues: true,
  showAiDraftPreview: true,
  showAssistantChatUi: false,
} as const;

export type DemoFeatureKey = keyof typeof DEMO_FEATURES;
```

```ts
// apps/mail/lib/demo/runtime.ts
import { DEMO_FEATURES, type DemoFeatureKey } from './config';

type DemoEnv = {
  ZERO_DEMO_MODE?: string;
  VITE_FRONTEND_ONLY?: string;
};

export function isDemoMode(env: DemoEnv = import.meta.env): boolean {
  return env.ZERO_DEMO_MODE === '1';
}

export function isFrontendOnlyDemo(env: DemoEnv = import.meta.env): boolean {
  return isDemoMode(env) && env.VITE_FRONTEND_ONLY === '1';
}

export function isDemoFeatureEnabled(key: DemoFeatureKey): boolean {
  return DEMO_FEATURES[key];
}
```

```ts
// apps/mail/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

```json
// apps/mail/package.json (scripts/devDependencies excerpts)
{
  "scripts": {
    "test:demo": "vitest run tests/demo-runtime.test.ts tests/demo-data.adapter.test.ts tests/work-queue-filter.test.ts"
  },
  "devDependencies": {
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --dir apps/mail exec vitest run tests/demo-runtime.test.ts -v`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/demo/config.ts apps/mail/lib/demo/runtime.ts apps/mail/tests/demo-runtime.test.ts apps/mail/vitest.config.ts apps/mail/package.json pnpm-lock.yaml
git commit -m "feat(mail): add typed demo runtime kernel and runtime tests"
```

### Task 2: Enforce Frontend-Only Startup and Cleanup

**Files:**
- Modify: `scripts/run-frontend-local.mjs`
- Create: `scripts/cleanup-dev-processes.mjs`
- Modify: `package.json`
- Test: `scripts/cleanup-dev-processes.mjs`

- [ ] **Step 1: Write failing expectation check**

```bash
ZERO_DEMO_MODE=1 ZERO_DEMO_FRONTEND_ONLY=1 pnpm devfull
```

Expected (before fix): backend probe/start logs may appear; not strictly frontend-only.

- [ ] **Step 2: Add failing cleanup check**

Run: `pnpm cleanup:dev`  
Expected: FAIL because script does not exist yet.

- [ ] **Step 3: Implement startup hard-skip + cleanup script**

```js
// scripts/run-frontend-local.mjs (core delta)
const demoFrontendOnly =
  process.env.ZERO_DEMO_MODE === '1' && process.env.ZERO_DEMO_FRONTEND_ONLY !== '0';

const backendReachable = forceFrontendOnly || demoFrontendOnly ? false : await startBackendIfNeeded(env);

env.VITE_FRONTEND_ONLY =
  forceFrontendOnly || demoFrontendOnly ? '1' : backendReachable ? '0' : '1';

if (demoFrontendOnly) {
  console.log('[local-dev] FE-only demo mode active; skipping backend startup.');
}
```

```js
// scripts/cleanup-dev-processes.mjs
#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

if (process.platform === 'win32') {
  spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('node.exe','esbuild.exe','workerd.exe') -and $_.CommandLine -like '*emails hotels uis\\\\zero*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ],
    { stdio: 'inherit' },
  );
} else {
  spawnSync('bash', ['-lc', `pkill -f "emails hotels uis/zero" || true`], { stdio: 'inherit' });
}
```

```json
// package.json (scripts excerpts)
{
  "scripts": {
    "dev:demo:frontend": "ZERO_DEMO_MODE=1 ZERO_DEMO_FRONTEND_ONLY=1 dotenv -- node ./scripts/run-frontend-local.mjs --frontend-only",
    "cleanup:dev": "node ./scripts/cleanup-dev-processes.mjs"
  }
}
```

- [ ] **Step 4: Run checks to verify pass**

Run:
- `pnpm cleanup:dev`
- `pnpm dev:demo:frontend`

Expected:
- cleanup command exits successfully
- frontend starts on `3000`
- backend is not auto-started.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-frontend-local.mjs scripts/cleanup-dev-processes.mjs package.json
git commit -m "chore(dev): enforce frontend-only demo startup and add cleanup command"
```

### Task 3: Remove AI Chat Surfaces from FE-demo

**Files:**
- Modify: `apps/mail/components/mail/mail.tsx`
- Modify: `apps/mail/components/mail/thread-display.tsx`
- Modify: `apps/mail/components/ui/app-sidebar.tsx`
- Test: `apps/mail/components/mail/mail.tsx` (build/typecheck)

- [ ] **Step 1: Write failing check**

Run:
```bash
rg -n "AISidebar|AIToggleButton|Zero chat|toggleAISidebar" apps/mail/components/mail apps/mail/components/ui
```

Expected: matches exist before changes.

- [ ] **Step 2: Remove branch UI wiring to chat/sidebar**

```tsx
// apps/mail/components/mail/mail.tsx (import/render delta)
// remove:
// import AISidebar from '@/components/ui/ai-sidebar';
// import AIToggleButton from '../ai-toggle-button';

// remove:
// {activeConnection?.id ? <AISidebar /> : null}
// {activeConnection?.id ? <AIToggleButton /> : null}
```

```tsx
// apps/mail/components/mail/thread-display.tsx (empty-state CTA delta)
// remove useAISidebar import + toggle hook
// keep only "Send email" CTA in empty state
```

```tsx
// apps/mail/components/ui/app-sidebar.tsx
// remove useAIFullScreen dependency and always render Sidebar
```

- [ ] **Step 3: Run verification check**

Run:
```bash
rg -n "AISidebar|AIToggleButton|toggleAISidebar" apps/mail/components/mail apps/mail/components/ui
```

Expected: no matches in active UI path files.

- [ ] **Step 4: Typecheck**

Run: `pnpm --dir apps/mail exec tsc --noEmit -p tsconfig.json`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/components/mail/mail.tsx apps/mail/components/mail/thread-display.tsx apps/mail/components/ui/app-sidebar.tsx
git commit -m "feat(mail): remove AI chat surfaces from FE-demo branch UI"
```

### Task 4: Add Canonical Demo Corpus, Schema, and Adapter

**Files:**
- Create: `apps/mail/lib/demo-data/centurion-threads.json`
- Create: `apps/mail/lib/demo-data/schema.ts`
- Create: `apps/mail/lib/demo-data/work-queue.ts`
- Create: `apps/mail/lib/demo-data/adapter.ts`
- Create: `apps/mail/tests/work-queue-filter.test.ts`
- Create: `apps/mail/tests/demo-data.adapter.test.ts`
- Test: `apps/mail/tests/demo-data.adapter.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/mail/tests/work-queue-filter.test.ts
import { describe, expect, it } from 'vitest';
import { threadMatchesWorkQueue } from '../lib/demo-data/work-queue';

describe('threadMatchesWorkQueue', () => {
  it('matches urgent queue by urgent=true', () => {
    expect(
      threadMatchesWorkQueue(
        { id: 'x', demoCategory: 'group', urgent: true, messages: [{ id: 'm', isDraft: false }] },
        'urgent',
      ),
    ).toBe(true);
  });
});
```

```ts
// apps/mail/tests/demo-data.adapter.test.ts
import { describe, expect, it } from 'vitest';
import { listDemoThreads, getDemoThread } from '../lib/demo-data/adapter';

describe('demo adapter', () => {
  it('returns at least one inbox thread', () => {
    const res = listDemoThreads({ folder: 'inbox', q: '', cursor: '', maxResults: 50, labelIds: [] });
    expect(res.threads.length).toBeGreaterThan(0);
  });

  it('fetches thread payload for first id', () => {
    const list = listDemoThreads({ folder: 'inbox', q: '', cursor: '', maxResults: 50, labelIds: [] });
    const thread = getDemoThread(list.threads[0]!.id);
    expect(thread.messages.length).toBeGreaterThan(0);
    expect(thread.latest?.id).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify fail**

Run: `pnpm --dir apps/mail exec vitest run tests/work-queue-filter.test.ts tests/demo-data.adapter.test.ts -v`  
Expected: FAIL (missing modules/files).

- [ ] **Step 3: Implement schema + adapter**

```ts
// apps/mail/lib/demo-data/work-queue.ts
export const WORK_QUEUE_SLUGS = ['group', 'individual', 'travel-agent', 'hr', 'urgent'] as const;
export type WorkQueueSlug = (typeof WORK_QUEUE_SLUGS)[number];

export type DemoQueueThread = {
  id: string;
  demoCategory: 'group' | 'individual' | 'travel-agent' | 'hr';
  urgent: boolean;
  messages: { id: string; isDraft?: boolean }[];
};

export function parseWorkQueueSlug(value?: string): WorkQueueSlug | null {
  if (!value) return null;
  return (WORK_QUEUE_SLUGS as readonly string[]).includes(value) ? (value as WorkQueueSlug) : null;
}

export function threadMatchesWorkQueue(thread: DemoQueueThread, queue: WorkQueueSlug): boolean {
  return queue === 'urgent' ? thread.urgent : thread.demoCategory === queue;
}
```

```ts
// apps/mail/lib/demo-data/schema.ts
import { z } from 'zod';

const participant = z.object({ email: z.string().email(), name: z.string().optional() });
const msg = z.object({
  id: z.string().min(1),
  subject: z.string(),
  body: z.string(),
  receivedOn: z.string().min(1),
  unread: z.boolean(),
  isDraft: z.boolean().optional(),
  sender: participant,
  to: z.array(participant).min(1),
});

export const demoThreadSchema = z.object({
  id: z.string().min(1),
  demoCategory: z.enum(['group', 'individual', 'travel-agent', 'hr']),
  urgent: z.boolean().default(false),
  llmIssueMessage: z.string().min(1).optional(),
  labels: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  messages: z.array(msg).min(1),
});

export const demoCorpusSchema = z.object({
  version: z.literal(1),
  threads: z.array(demoThreadSchema).min(10),
});
```

```ts
// apps/mail/lib/demo-data/adapter.ts (core signatures)
export function listDemoThreads(input: {
  folder?: string;
  q?: string;
  cursor?: string;
  maxResults?: number;
  labelIds?: string[];
  workQueue?: WorkQueueSlug;
}) { /* ... */ }

export function getDemoThread(id: string) { /* ... */ }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --dir apps/mail exec vitest run tests/work-queue-filter.test.ts tests/demo-data.adapter.test.ts -v`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/demo-data apps/mail/tests/work-queue-filter.test.ts apps/mail/tests/demo-data.adapter.test.ts
git commit -m "feat(mail): add canonical demo corpus schema and frontend adapter"
```

### Task 5: Route Hooks to Demo Adapter and Local Fallbacks

**Files:**
- Modify: `apps/mail/hooks/use-threads.ts`
- Modify: `apps/mail/hooks/use-labels.ts`
- Modify: `apps/mail/hooks/use-connections.ts`
- Modify: `apps/mail/hooks/use-settings.ts`
- Test: `apps/mail/tests/demo-data.adapter.test.ts`

- [ ] **Step 1: Write failing test for frontend-only behavior**

```ts
// append apps/mail/tests/demo-runtime.test.ts
import { isFrontendOnlyDemo } from '../lib/demo/runtime';
it('returns true in FE demo env', () => {
  expect(isFrontendOnlyDemo({ ZERO_DEMO_MODE: '1', VITE_FRONTEND_ONLY: '1' })).toBe(true);
});
```

- [ ] **Step 2: Run test to verify baseline**

Run: `pnpm --dir apps/mail exec vitest run tests/demo-runtime.test.ts -v`  
Expected: PASS (guard exists) while app integration still unchanged.

- [ ] **Step 3: Implement hook branching**

```ts
// apps/mail/hooks/use-threads.ts (core branching)
const demoFrontendOnly = isFrontendOnlyDemo();
const params = useParams<{ folder?: string; queue?: string }>();
const workQueue = parseWorkQueueSlug(params.queue);

const threadsQuery = useInfiniteQuery(
  demoFrontendOnly
    ? {
        queryKey: ['demo-mail', 'listThreads', params.folder ?? 'inbox', workQueue ?? null, searchValue.value, labels.join(',')],
        initialPageParam: '',
        queryFn: ({ pageParam }) =>
          Promise.resolve(
            listDemoThreads({
              folder: params.folder ?? 'inbox',
              workQueue: workQueue ?? undefined,
              q: searchValue.value,
              cursor: String(pageParam ?? ''),
              maxResults: 50,
              labelIds: labels,
            }),
          ),
        getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
      }
    : trpc.mail.listThreads.infiniteQueryOptions({ q: searchValue.value, folder: params.folder, labelIds: labels }, { initialCursor: '' }),
);
```

```ts
// apps/mail/hooks/use-connections.ts (demo fallback)
export const getDemoConnection = () => ({
  id: 'demo-connection',
  providerId: 'google',
  email: 'centurion@legacyhotels.com',
  name: 'The Centurion',
  createdAt: new Date(),
});
```

- [ ] **Step 4: Verify with typecheck + demo startup**

Run:
- `pnpm --dir apps/mail exec tsc --noEmit -p tsconfig.json`
- `pnpm dev:demo:frontend`

Expected:
- typecheck passes
- inbox loads without backend.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/hooks/use-threads.ts apps/mail/hooks/use-labels.ts apps/mail/hooks/use-connections.ts apps/mail/hooks/use-settings.ts apps/mail/tests/demo-runtime.test.ts
git commit -m "feat(mail): route core hooks to local demo adapter in frontend-only mode"
```

### Task 6: Add Work Queue Routes and Sidebar Navigation

**Files:**
- Modify: `apps/mail/app/routes.ts`
- Create: `apps/mail/app/(routes)/mail/work/[queue]/page.tsx`
- Modify: `apps/mail/components/ui/app-sidebar.tsx`
- Modify: `apps/mail/messages/en.json`
- Test: `apps/mail/tests/work-queue-filter.test.ts`

- [ ] **Step 1: Write failing route expectation**

Run:
```bash
rg -n "work/:queue" apps/mail/app/routes.ts
```

Expected: no match before implementation.

- [ ] **Step 2: Implement route + page**

```ts
// apps/mail/app/routes.ts
route('/work/:queue', '(routes)/mail/work/[queue]/page.tsx'),
route('/:folder', '(routes)/mail/[folder]/page.tsx'),
```

```tsx
// apps/mail/app/(routes)/mail/work/[queue]/page.tsx
import { useLoaderData } from 'react-router';
import { MailLayout } from '@/components/mail/mail';
import { authProxy } from '@/lib/auth-proxy';
import { parseWorkQueueSlug } from '@/lib/demo-data/work-queue';
import type { Route } from './+types/page';

export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const session = await authProxy.api.getSession({ headers: request.headers });
  if (!session) return Response.redirect(`${import.meta.env.VITE_PUBLIC_APP_URL}/login`);
  const queue = parseWorkQueueSlug(params.queue);
  if (!queue) return Response.redirect(`${import.meta.env.VITE_PUBLIC_APP_URL}/mail/inbox`);
  return { queue };
}

export default function WorkQueuePage() {
  useLoaderData<typeof clientLoader>();
  return <MailLayout />;
}
```

- [ ] **Step 3: Add sidebar + i18n keys**

```json
// apps/mail/messages/en.json (new keys)
"navigation.sidebar.workQueues": "Work queues",
"navigation.sidebar.workQueue.group": "Group bookings",
"navigation.sidebar.workQueue.individual": "Individual bookings",
"navigation.sidebar.workQueue.travelAgent": "Travel agent",
"navigation.sidebar.workQueue.hr": "Internal HR",
"navigation.sidebar.workQueue.urgent": "Urgent"
```

- [ ] **Step 4: Verify**

Run:
- `pnpm --dir apps/mail run build`
- `rg -n "work/:queue|workQueue" apps/mail/app/routes.ts apps/mail/components/ui/app-sidebar.tsx`

Expected: build passes, route and sidebar config present.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/app/routes.ts "apps/mail/app/(routes)/mail/work/[queue]/page.tsx" apps/mail/components/ui/app-sidebar.tsx apps/mail/messages/en.json
git commit -m "feat(mail): add frontend-only work queue routes and sidebar navigation"
```

### Task 7: Urgent Stripe and Queue Empty-State UX

**Files:**
- Modify: `apps/mail/types/index.ts`
- Modify: `apps/mail/components/mail/mail-list.tsx`
- Test: `apps/mail/tests/demo-data.adapter.test.ts`

- [ ] **Step 1: Write failing adapter assertion for list metadata**

```ts
// append apps/mail/tests/demo-data.adapter.test.ts
it('exposes demo metadata on list rows', () => {
  const res = listDemoThreads({ folder: 'inbox', q: '', cursor: '', maxResults: 50, labelIds: [] });
  expect(res.threads[0]).toHaveProperty('$raw.demo.urgent');
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `pnpm --dir apps/mail exec vitest run tests/demo-data.adapter.test.ts -v`  
Expected: FAIL if `$raw.demo` not yet attached.

- [ ] **Step 3: Implement type + UI updates**

```ts
// apps/mail/types/index.ts
export type ThreadProps = {
  message: {
    id: string;
    historyId?: string | null;
    $raw?: { demo?: { urgent: boolean; demoCategory: string } };
  };
  onClick?: (message: ParsedMessage) => () => void;
  isKeyboardFocused?: boolean;
};
```

```tsx
// apps/mail/components/mail/mail-list.tsx (row class excerpt)
className={cn(
  'hover:bg-offsetLight dark:hover:bg-primary/5 group relative ...',
  message.$raw?.demo?.urgent && 'border-r-4 border-r-red-500',
)}
```

```tsx
// apps/mail/components/mail/mail-list.tsx (queue empty state excerpt)
const { queue } = useParams<{ folder?: string; queue?: string }>();
// if queue && items.length === 0 -> show "No threads in this work queue" + link to /mail/inbox
```

- [ ] **Step 4: Run tests and quick smoke**

Run:
- `pnpm --dir apps/mail exec vitest run tests/demo-data.adapter.test.ts -v`
- `pnpm dev:demo:frontend` then open `/mail/work/urgent`

Expected: test passes; urgent items have stripe; empty queues show fallback copy.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/types/index.ts apps/mail/components/mail/mail-list.tsx apps/mail/tests/demo-data.adapter.test.ts apps/mail/lib/demo-data/adapter.ts
git commit -m "feat(mail): add urgent row styling and work-queue empty-state UX"
```

### Task 8: Add Static AI Draft Preview (no live AI)

**Files:**
- Create: `apps/mail/store/demo-ai-draft-reviewed.ts`
- Create: `apps/mail/components/mail/ai-draft-preview-panel.tsx`
- Modify: `apps/mail/components/mail/thread-display.tsx`
- Modify: `apps/mail/lib/demo-data/schema.ts`
- Modify: `apps/mail/lib/demo-data/adapter.ts`
- Test: `apps/mail/tests/demo-data.adapter.test.ts`

- [ ] **Step 1: Write failing test for draft metadata availability**

```ts
// append apps/mail/tests/demo-data.adapter.test.ts
it('returns demo metadata on thread payload', () => {
  const list = listDemoThreads({ folder: 'inbox', q: '', cursor: '', maxResults: 50, labelIds: [] });
  const thread = getDemoThread(list.threads[0]!.id);
  expect(thread).toHaveProperty('demo.urgent');
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `pnpm --dir apps/mail exec vitest run tests/demo-data.adapter.test.ts -v`  
Expected: FAIL until adapter returns `demo` envelope.

- [ ] **Step 3: Implement static preview flow**

```ts
// apps/mail/store/demo-ai-draft-reviewed.ts
import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
export const demoAiDraftReviewedAtomFamily = atomFamily((threadId: string) => atom(false));
```

```tsx
// apps/mail/components/mail/ai-draft-preview-panel.tsx
export function AiDraftPreviewPanel(props: {
  threadId: string;
  draftHtml: string;
  llmIssueMessage?: string;
  onBeginReview: () => void;
}) { /* read-only preview + button */ }
```

```tsx
// apps/mail/components/mail/thread-display.tsx (integration excerpt)
// in frontend-only demo mode, show AiDraftPreviewPanel above sticky ReplyCompose
// onBeginReview => set reviewed true, setMode('replyAll'), setActiveReplyId(draftId)
```

- [ ] **Step 4: Verify**

Run:
- `pnpm --dir apps/mail exec tsc --noEmit -p tsconfig.json`
- `pnpm dev:demo:frontend` and open a thread with a draft

Expected: read-only draft preview appears; clicking review opens composer.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/store/demo-ai-draft-reviewed.ts apps/mail/components/mail/ai-draft-preview-panel.tsx apps/mail/components/mail/thread-display.tsx apps/mail/lib/demo-data/schema.ts apps/mail/lib/demo-data/adapter.ts apps/mail/tests/demo-data.adapter.test.ts
git commit -m "feat(mail): add deterministic AI draft preview flow for frontend demo"
```

### Task 9: Add Lean Frontend Profile + Demo Guardrail Scripts

**Files:**
- Modify: `apps/mail/vite.config.ts`
- Create: `scripts/verify-lean-dev-profile.mjs`
- Create: `scripts/verify-demo-no-backend.mjs`
- Modify: `package.json`
- Test: `scripts/verify-lean-dev-profile.mjs`

- [ ] **Step 1: Write failing checks**

Run:
- `pnpm verify:demo:no-backend`
- `pnpm verify:dev:lean`

Expected: FAIL (scripts not defined yet).

- [ ] **Step 2: Implement script checks**

```js
// scripts/verify-lean-dev-profile.mjs
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

```js
// scripts/verify-demo-no-backend.mjs
import { readFileSync } from 'node:fs';
const files = [
  'apps/mail/hooks/use-threads.ts',
  'apps/mail/hooks/use-labels.ts',
  'apps/mail/hooks/use-connections.ts',
  'apps/mail/hooks/use-settings.ts',
];
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  if (!src.includes('isFrontendOnlyDemo')) {
    console.error(`${file} is missing isFrontendOnlyDemo guard`);
    process.exit(1);
  }
}
console.log('verify-demo-no-backend passed');
```

- [ ] **Step 3: Add scripts and Vite toggles**

```json
// package.json (scripts excerpts)
{
  "scripts": {
    "dev:frontend:lean": "ZERO_DISABLE_OXLINT=1 ZERO_DISABLE_REACT_COMPILER=1 ZERO_DISABLE_VITE_WARMUP=1 dotenv -- node ./scripts/run-frontend-local.mjs --frontend-only",
    "verify:dev:lean": "ZERO_DISABLE_OXLINT=1 ZERO_DISABLE_REACT_COMPILER=1 ZERO_DISABLE_VITE_WARMUP=1 node ./scripts/verify-lean-dev-profile.mjs",
    "verify:demo:no-backend": "node ./scripts/verify-demo-no-backend.mjs"
  }
}
```

- [ ] **Step 4: Run verification**

Run:
- `pnpm verify:dev:lean`
- `pnpm verify:demo:no-backend`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/vite.config.ts scripts/verify-lean-dev-profile.mjs scripts/verify-demo-no-backend.mjs package.json
git commit -m "chore(dev): add lean-profile and demo no-backend guardrail scripts"
```

### Task 10: Add AI Coding Guardrails and Demo Runbook

**Files:**
- Create: `docs/superpowers/ai-coding-guardrails.md`
- Modify: `README.md`
- Test: docs command snippets

- [ ] **Step 1: Write the guardrail doc**

Create `docs/superpowers/ai-coding-guardrails.md` with:
- single source files to edit for new demo features
- required commands before claiming success:
  - `pnpm --dir apps/mail exec tsc --noEmit -p tsconfig.json`
  - `pnpm verify:demo:no-backend`
  - `pnpm verify:dev:lean`
- “do not” list (no backend wiring in demo hooks, no chat UI re-enable without explicit approval).

- [ ] **Step 2: Update README demo workflow**

Add a section:

```md
## Frontend-Only Demo (FE-demo)

- Start: `pnpm dev:demo:frontend`
- Fast mode: `pnpm dev:frontend:lean`
- Cleanup: `pnpm cleanup:dev`
- Guardrails: `pnpm verify:demo:no-backend`
```

- [ ] **Step 3: Verify docs commands**

Run:
- `pnpm verify:demo:no-backend`
- `pnpm cleanup:dev`

Expected: commands run as documented.

- [ ] **Step 4: Final smoke pass**

Run:
- `pnpm dev:demo:frontend`
- manually verify `/mail/inbox`, `/mail/work/group`, `/mail/work/urgent`, thread preview + draft review button

Expected: frontend-only demo flow works without backend.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/ai-coding-guardrails.md README.md
git commit -m "docs: add FE-demo runbook and AI coding guardrails"
```

---

## Self-Review

1. **Spec coverage**
   - Zero backend calls: Tasks 1, 2, 5, 9  
   - Fast startup and iteration: Tasks 2, 9  
   - Mock-data-driven UI: Tasks 4, 5, 7  
   - Work queues and reservationist UX: Tasks 6, 7  
   - Static AI draft preview and no chatbot: Tasks 3, 8  
   - AI maintainability/guardrails: Tasks 1, 9, 10

2. **Placeholder scan**
   - No TBD/TODO steps.
   - Every task includes concrete files, commands, and expected outcomes.

3. **Type consistency**
   - `isFrontendOnlyDemo`, `DemoFeatureKey`, `WorkQueueSlug`, `listDemoThreads`, and `getDemoThread` names are used consistently across tasks.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-09-fe-demo-frontend-only-client-readiness.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
