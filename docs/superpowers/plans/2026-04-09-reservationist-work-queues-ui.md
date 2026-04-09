# Reservationist work queues and AI draft preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class `/mail/work/:queue` demo routes, sidebar “Work queues,” inbox-style filtering over demo corpus data, urgent row stripes, and a read-only AI draft preview in the reading pane until the reservationist enters edit mode.

**Architecture:** Demo-only behavior is gated with `isFrontendOnlyDemo()`. Thread list data continues to come from `listDemoThreads` in `apps/mail/lib/demo-mail/adapter.ts`, extended with a `workQueue` filter and optional `$raw.demo` list metadata for urgent stripes without N+1 fetches. Work-queue routes register **before** `/:folder` in React Router so `work` is not captured as a folder name. AI draft preview lives in `thread-display.tsx` (or a small child component) for FE-only demo when the thread has a draft message and the user has not yet opened edit mode; `jotai` atomFamily tracks per-thread “reviewed” in the client session.

**Tech Stack:** React Router 7 (`@react-router/dev`), React 19, TanStack Query, Jotai, Vitest, Paraglide (`apps/mail/messages/en.json`), Tailwind, existing `centurion-threads.json` corpus.

---

## File map

| File | Role |
|------|------|
| `apps/mail/app/routes.ts` | Register `route('/work/:queue', ...)` **above** `/:folder`. |
| `apps/mail/app/(routes)/mail/work/[queue]/page.tsx` | Validate slug; render `MailLayout` like `[folder]/page.tsx`. |
| `apps/mail/lib/demo-mail/work-queue.ts` | `WORK_QUEUE_SLUGS`, types, `parseWorkQueueSlug`, `threadMatchesWorkQueue`. |
| `apps/mail/lib/demo-mail/schema.ts` | Extend corpus thread: `demoCategory`, `urgent`, optional `llmIssueMessage`. |
| `apps/mail/lib/demo-mail/centurion-threads.json` | Seed new fields on every thread (valid for Zod min/max). |
| `apps/mail/lib/demo-mail/adapter.ts` | `listDemoThreads({ workQueue })`, attach `$raw.demo` on list rows; `getDemoThread` adds optional `demo` on response. |
| `apps/mail/hooks/use-threads.ts` | Read `queue` from `useParams`, pass `workQueue` into demo `queryKey` + `listDemoThreads`. |
| `apps/server/src/lib/driver/types.ts` | Extend `IGetThreadResponse` with optional `demo?: { urgent: boolean; demoCategory: string; llmIssueMessage?: string }` (always `undefined` outside demo adapter). |
| `apps/mail/types/index.ts` | Extend `ThreadProps['message']` with optional `$raw?: { demo?: { urgent: boolean; demoCategory: string } }`. |
| `apps/mail/components/mail/mail-list.tsx` | Red right-edge stripe when `$raw.demo.urgent`; `aria-label` includes urgent; work-queue empty copy + link to inbox. |
| `apps/mail/components/ui/app-sidebar.tsx` | When `isFrontendOnlyDemo()`, append “Work queues” `NavSection` to mail `navItems`. |
| `apps/mail/messages/en.json` | Keys for section title and five queue labels (then compile Paraglide). |
| `apps/mail/store/demo-ai-draft-reviewed.ts` | `atomFamily` keyed by `threadId`, default `false`, set `true` when entering draft edit. |
| `apps/mail/components/mail/thread-display.tsx` | FE-only: `AiDraftPreviewPanel` above sticky `ReplyCompose`; wire `mode` / `activeReplyId`. |
| `apps/mail/components/mail/ai-draft-preview-panel.tsx` | New presentational + interaction component (keeps `thread-display` smaller). |
| `apps/mail/tests/demo-mail.adapter.test.ts` | Extend tests for `workQueue` filtering and `$raw.demo`. |
| `apps/mail/tests/work-queue-filter.test.ts` | Unit tests for `threadMatchesWorkQueue` (isolated, no full JSON load). |

---

### Task 1: Work queue constants and pure filter

**Files:**
- Create: `apps/mail/lib/demo-mail/work-queue.ts`
- Test: `apps/mail/tests/work-queue-filter.test.ts`

- [ ] **Step 1: Write failing tests for `threadMatchesWorkQueue`**

Create `apps/mail/tests/work-queue-filter.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { threadMatchesWorkQueue, type DemoCorpusThreadShape } from '../lib/demo-mail/work-queue';

const t = (overrides: Partial<DemoCorpusThreadShape>): DemoCorpusThreadShape => ({
  id: 'x',
  demoCategory: 'group',
  urgent: false,
  messages: [{ isDraft: false }],
  ...overrides,
});

describe('threadMatchesWorkQueue', () => {
  it('matches category slug', () => {
    expect(threadMatchesWorkQueue(t({ demoCategory: 'hr' }), 'hr')).toBe(true);
    expect(threadMatchesWorkQueue(t({ demoCategory: 'hr' }), 'group')).toBe(false);
  });

  it('matches urgent rollup', () => {
    expect(threadMatchesWorkQueue(t({ urgent: true, demoCategory: 'individual' }), 'urgent')).toBe(
      true,
    );
    expect(threadMatchesWorkQueue(t({ urgent: false }), 'urgent')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run:

```bash
cd apps/mail && pnpm exec vitest run tests/work-queue-filter.test.ts -v
```

Expected: FAIL (module not found or `threadMatchesWorkQueue` undefined).

- [ ] **Step 3: Implement `work-queue.ts`**

Create `apps/mail/lib/demo-mail/work-queue.ts`:

```typescript
export const WORK_QUEUE_SLUGS = [
  'group',
  'individual',
  'travel-agent',
  'hr',
  'urgent',
] as const;

export type WorkQueueSlug = (typeof WORK_QUEUE_SLUGS)[number];

export type DemoCorpusThreadShape = {
  id: string;
  demoCategory: 'group' | 'individual' | 'travel-agent' | 'hr';
  urgent: boolean;
  messages: { isDraft?: boolean }[];
};

export function parseWorkQueueSlug(value: string | undefined): WorkQueueSlug | null {
  if (!value) return null;
  return (WORK_QUEUE_SLUGS as readonly string[]).includes(value)
    ? (value as WorkQueueSlug)
    : null;
}

export function threadMatchesWorkQueue(
  thread: DemoCorpusThreadShape,
  queue: WorkQueueSlug,
): boolean {
  if (queue === 'urgent') return thread.urgent === true;
  return thread.demoCategory === queue;
}
```

- [ ] **Step 4: Run tests — expect pass**

Run:

```bash
cd apps/mail && pnpm exec vitest run tests/work-queue-filter.test.ts -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/demo-mail/work-queue.ts apps/mail/tests/work-queue-filter.test.ts
git commit -m "feat(demo-mail): add work queue slug types and filter helper"
```

---

### Task 2: Corpus schema + JSON seed fields

**Files:**
- Modify: `apps/mail/lib/demo-mail/schema.ts`
- Modify: `apps/mail/lib/demo-mail/centurion-threads.json`

- [ ] **Step 1: Extend Zod schema**

In `apps/mail/lib/demo-mail/schema.ts`, add to `centurionCorpusThreadSchema` (inside `.object({...})`):

```typescript
    demoCategory: z.enum(['group', 'individual', 'travel-agent', 'hr']),
    urgent: z.boolean().default(false),
    llmIssueMessage: z.string().min(1).optional(),
```

Ensure every thread in the corpus includes `demoCategory` and `urgent` (and `llmIssueMessage` on at least one thread for banner testing).

- [ ] **Step 2: Validate JSON against schema**

Run from repo root (adjust if your project uses a different script):

```bash
cd apps/mail && pnpm exec vitest run tests/demo-mail.adapter.test.ts -v
```

If parsing runs at import time, fix any Zod errors until tests load.

- [ ] **Step 3: Commit**

```bash
git add apps/mail/lib/demo-mail/schema.ts apps/mail/lib/demo-mail/centurion-threads.json
git commit -m "feat(demo-mail): add work queue fields to centurion corpus schema"
```

---

### Task 3: `listDemoThreads` workQueue + list `$raw.demo`

**Files:**
- Modify: `apps/mail/lib/demo-mail/adapter.ts`
- Modify: `apps/mail/tests/demo-mail.adapter.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Append to `apps/mail/tests/demo-mail.adapter.test.ts`:

```typescript
import { listDemoThreads } from '../lib/demo-mail/adapter';

it('filters by workQueue group', () => {
  const all = listDemoThreads({
    folder: 'inbox',
    workQueue: 'group',
    q: '',
    cursor: '',
    maxResults: 200,
    labelIds: [],
  });
  expect(all.threads.length).toBeGreaterThan(0);
  for (const row of all.threads) {
    const raw = row.$raw as { demo?: { demoCategory: string; urgent: boolean } } | undefined;
    expect(raw?.demo?.demoCategory).toBe('group');
  }
});

it('returns urgent rollup across categories', () => {
  const urgent = listDemoThreads({
    folder: 'inbox',
    workQueue: 'urgent',
    q: '',
    cursor: '',
    maxResults: 200,
    labelIds: [],
  });
  for (const row of urgent.threads) {
    const raw = row.$raw as { demo?: { urgent: boolean } } | undefined;
    expect(raw?.demo?.urgent).toBe(true);
  }
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd apps/mail && pnpm exec vitest run tests/demo-mail.adapter.test.ts -v
```

Expected: FAIL (unknown param or missing `$raw`).

- [ ] **Step 3: Implement adapter changes**

In `listDemoThreads` signature add optional `workQueue?: WorkQueueSlug`. After building `sortedThreads`, if `workQueue` is set, `.filter((t) => threadMatchesWorkQueue(t, workQueue))` before search/label filtering.

When mapping to list rows, attach:

```typescript
$raw: {
  demo: {
    urgent: thread.urgent,
    demoCategory: thread.demoCategory,
  },
},
```

Keep existing behavior: when `folder !== 'inbox'` and **no** `workQueue`, still return `[]` (preserves current non-inbox semantics). When `workQueue` is set, treat the corpus as the source even if `folder` is not `inbox`, **or** require callers to pass `folder: 'inbox'` from `useThreads` only—pick one rule and document it in a one-line comment; recommended: **if `workQueue` is defined, ignore `folder` gate** so `/mail/work/*` does not depend on folder param.

- [ ] **Step 4: Run tests — expect pass**

```bash
cd apps/mail && pnpm exec vitest run tests/demo-mail.adapter.test.ts -v
```

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/demo-mail/adapter.ts apps/mail/tests/demo-mail.adapter.test.ts
git commit -m "feat(demo-mail): filter list by workQueue and expose demo list metadata"
```

---

### Task 4: `getDemoThread` demo envelope + types

**Files:**
- Modify: `apps/server/src/lib/driver/types.ts`
- Modify: `apps/mail/lib/demo-mail/adapter.ts` (`centurionThreadToGetResponse`)

- [ ] **Step 1: Extend `IGetThreadResponse`**

In `apps/server/src/lib/driver/types.ts`, add optional field:

```typescript
  demo?: {
    urgent: boolean;
    demoCategory: 'group' | 'individual' | 'travel-agent' | 'hr';
    llmIssueMessage?: string;
  };
```

- [ ] **Step 2: Populate in `centurionThreadToGetResponse`**

When building the return value from `CenturionCorpusThread`, set:

```typescript
demo: {
  urgent: thread.urgent,
  demoCategory: thread.demoCategory,
  ...(thread.llmIssueMessage
    ? { llmIssueMessage: thread.llmIssueMessage }
    : {}),
},
```

- [ ] **Step 3: Typecheck mail app**

```bash
pnpm exec tsc --noEmit -p apps/mail
```

(Use the repo’s actual typecheck command if different, e.g. `pnpm turbo run types`.)

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/lib/driver/types.ts apps/mail/lib/demo-mail/adapter.ts
git commit -m "feat(demo-mail): attach demo metadata to getThread response"
```

---

### Task 5: Routes and `work/[queue]` page

**Files:**
- Modify: `apps/mail/app/routes.ts`
- Create: `apps/mail/app/(routes)/mail/work/[queue]/page.tsx`

- [ ] **Step 1: Register nested route**

In `apps/mail/app/routes.ts`, inside `prefix('/mail', [`, add **before** `route('/:folder', ...)`:

```typescript
        route('/work/:queue', '(routes)/mail/work/[queue]/page.tsx'),
```

- [ ] **Step 2: Add page**

Create `apps/mail/app/(routes)/mail/work/[queue]/page.tsx` modeled on `apps/mail/app/(routes)/mail/[folder]/page.tsx`, but:

- `clientLoader` reads `params.queue`, runs `parseWorkQueueSlug`; if null, redirect to `/mail/inbox`.
- Render `<MailLayout />` (same as folder page after validation).

```typescript
import { useLoaderData } from 'react-router';
import { MailLayout } from '@/components/mail/mail';
import { getSessionOrRedirect } from '@/lib/route-auth-shim';
import type { Route } from './+types/page';
import { parseWorkQueueSlug } from '@/lib/demo-mail/work-queue';

export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const session = await getSessionOrRedirect({ request });
  if (session instanceof Response) return session;

  const queue = parseWorkQueueSlug(params.queue);
  if (!queue) {
    return Response.redirect(`${import.meta.env.VITE_PUBLIC_APP_URL}/mail/inbox`);
  }
  return { queue };
}

export default function MailWorkQueuePage() {
  useLoaderData<typeof clientLoader>();
  return <MailLayout />;
}
```

- [ ] **Step 3: Run dev build / route types**

```bash
cd apps/mail && pnpm run build
```

Fix any generated `+types` import paths if the compiler rewrites them.

- [ ] **Step 4: Commit**

```bash
git add apps/mail/app/routes.ts "apps/mail/app/(routes)/mail/work/[queue]/page.tsx"
git commit -m "feat(mail): add /mail/work/:queue routes"
```

---

### Task 6: `useThreads` reads `queue` param

**Files:**
- Modify: `apps/mail/hooks/use-threads.ts`

- [ ] **Step 1: Pass `workQueue` into demo query**

Replace single `folder` param extraction with:

```typescript
const params = useParams<{ folder?: string; queue?: string }>();
const folder = params.folder;
const workQueue = parseWorkQueueSlug(params.queue);
```

In `demoFrontendOnly` branch, extend `queryKey` to include `workQueue ?? null` and call:

```typescript
listDemoThreads({
  folder: folder ?? 'inbox',
  workQueue: workQueue ?? undefined,
  q: searchValue.value,
  cursor: String(pageParam ?? ''),
  maxResults: 50,
  labelIds: labels,
}),
```

- [ ] **Step 2: Typecheck**

```bash
pnpm exec tsc --noEmit -p apps/mail
```

- [ ] **Step 3: Commit**

```bash
git add apps/mail/hooks/use-threads.ts
git commit -m "feat(mail): wire useThreads to work queue routes in demo mode"
```

---

### Task 7: Thread list stripe, `ThreadProps`, empty state

**Files:**
- Modify: `apps/mail/types/index.ts`
- Modify: `apps/mail/components/mail/mail-list.tsx`

- [ ] **Step 1: Extend `ThreadProps`**

```typescript
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

- [ ] **Step 2: Urgent stripe + `aria-label`**

In the outer row `div` for each thread (where `data-thread-id` is set), add a **right border** or **pseudo-element** when `message.$raw?.demo?.urgent === true`, e.g. `border-r-4 border-r-red-600` (tune to match design). Append to `aria-label` text: “urgent” when urgent (read English string or Paraglide key).

- [ ] **Step 3: Empty state for work queues**

When `useParams().queue` is set and `threads.length === 0` and not loading, show copy + `Link` to `/mail/inbox` (Paraglide message).

- [ ] **Step 4: Manual smoke**

Run `pnpm --filter @zero/mail dev`, visit `/mail/work/group` with demo env flags on; confirm list loads.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/types/index.ts apps/mail/components/mail/mail-list.tsx
git commit -m "feat(mail): urgent stripe and work queue empty state in list"
```

---

### Task 8: Sidebar “Work queues” (demo only)

**Files:**
- Modify: `apps/mail/components/ui/app-sidebar.tsx`
- Modify: `apps/mail/messages/en.json`
- Run Paraglide compile (see `AGENT.md` or `package.json` for this repo)

- [ ] **Step 1: Add message keys**

In `apps/mail/messages/en.json`, add entries such as:

```json
"navigation.sidebar.workQueues": "Work queues",
"navigation.sidebar.workQueue.group": "Group bookings",
"navigation.sidebar.workQueue.individual": "Individual bookings",
"navigation.sidebar.workQueue.travelAgent": "Travel agent",
"navigation.sidebar.workQueue.hr": "Internal HR",
"navigation.sidebar.workQueue.urgent": "Urgent"
```

Run the project’s Paraglide / inlang compile command so `m['navigation.sidebar.workQueues']()` exists.

- [ ] **Step 2: Merge section in `AppSidebar`**

When `currentSection === 'mail'` and `isFrontendOnlyDemo()`, append a `NavSection`-shaped object to `items` before returning from `useMemo`: title `m['navigation.sidebar.workQueues']()`, items with `url` `/mail/work/group`, etc., and icons reused from `lucide-react` or existing icons (e.g. `Users`, `User`, `Plane2`, `LockIcon`, `ExclamationCircle`).

- [ ] **Step 3: Commit**

```bash
git add apps/mail/components/ui/app-sidebar.tsx apps/mail/messages/en.json
git commit -m "feat(mail): work queues sidebar section for frontend-only demo"
```

---

### Task 9: Jotai “draft reviewed” + `AiDraftPreviewPanel`

**Files:**
- Create: `apps/mail/store/demo-ai-draft-reviewed.ts`
- Create: `apps/mail/components/mail/ai-draft-preview-panel.tsx`
- Modify: `apps/mail/components/mail/thread-display.tsx`

- [ ] **Step 1: Atom family**

`apps/mail/store/demo-ai-draft-reviewed.ts`:

```typescript
import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';

export const demoAiDraftReviewedAtomFamily = atomFamily((threadId: string) =>
  atom(false),
);
```

- [ ] **Step 2: Preview component**

`AiDraftPreviewPanel` props (illustrative):

```typescript
export function AiDraftPreviewPanel(props: {
  threadId: string;
  draftHtml: string;
  llmIssueMessage?: string;
  onBeginReview: () => void;
}) {
  // ScrollArea, muted prose, border-red-500/ring, banner if llmIssueMessage,
  // role="region" aria-readonly on preview, button "Review & edit",
  // onClick on region calls onBeginReview
}
```

- [ ] **Step 3: Integrate in `ThreadDisplay`**

When `isFrontendOnlyDemo()`, `latestDraft` exists, and `useAtom(demoAiDraftReviewedAtomFamily(threadId))[0] === false`, render `AiDraftPreviewPanel` in the **bottom stack** (above the sticky `ReplyCompose` slot). Implement `onBeginReview` to:

1. `setReviewed(true)` for that threadId atom.
2. `setMode('reply')` and `setActiveReplyId` to the **draft message id** (last message when `isDraft`).

Hide preview when `mode` is already set to reply for that draft or when reviewed is true.

- [ ] **Step 4: Manual acceptance**

Confirm: grey full draft, red outline, banner on seeded thread with `llmIssueMessage`, click preview and button both open composer and clear outline.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/store/demo-ai-draft-reviewed.ts apps/mail/components/mail/ai-draft-preview-panel.tsx apps/mail/components/mail/thread-display.tsx
git commit -m "feat(mail): AI draft read-only preview until review in demo mode"
```

---

### Task 10: Spec + feature log (optional but recommended)

**Files:**
- Modify: `docs/superpowers/specs/2026-04-09-reservationist-work-queues-ui-design.md` (set **Status** to “Approved” once shipped)
- Modify: `FEATURE_CHANGES.md` (new entry per project convention)

- [ ] **Step 1: Add FEATURE_CHANGES entry** describing work queues, stripes, and draft preview.

- [ ] **Step 2: Commit**

```bash
git add FEATURE_CHANGES.md docs/superpowers/specs/2026-04-09-reservationist-work-queues-ui-design.md
git commit -m "docs: log reservationist work queue demo UI"
```

---

## Spec coverage checklist (self-review)

| Spec requirement | Task(s) |
|------------------|---------|
| First-class `/mail/work/...` routes | 5, 6 |
| Sidebar group when `isFrontendOnlyDemo()` | 8 |
| Urgent rollup + category filters | 1, 3 |
| Red stripe only for urgent | 7 |
| Draft preview read-only, outline, edit entry C | 9 |
| Optional LLM banner | 2, 4, 9 |
| Invalid slug → inbox | 5 |
| Empty queue UX | 7 |
| i18n for nav | 8 |
| Accessibility (aria on urgent row) | 7 |
| Tests | 1, 3 |

**Placeholder scan:** No TBD/TODO left in tasks; corpus assignment is explicit editing of JSON.

**Type consistency:** `WorkQueueSlug`, `demoCategory` union, and `parseWorkQueueSlug` are the single sources of truth—reuse imports across adapter, page loader, and `useThreads`.

---

## Execution handoff

**Plan complete and saved to** `docs/superpowers/plans/2026-04-09-reservationist-work-queues-ui.md`. **Two execution options:**

1. **Subagent-driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. **Required sub-skill:** superpowers:subagent-driven-development.

2. **Inline execution** — Run tasks in this session using executing-plans with batch checkpoints. **Required sub-skill:** superpowers:executing-plans.

**Which approach do you want?**
