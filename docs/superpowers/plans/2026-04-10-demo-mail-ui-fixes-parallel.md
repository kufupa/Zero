# Demo Mail UI Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the demo inbox UX regressions (important-action toast bug, missing right-pane message body, queue/folder IA mismatch, support links visibility, and demo-mode backend noise) while preserving frontend-only behavior.

**Architecture:** Add small pure helper modules for decision logic, keep UI edits minimal in existing components, and enforce demo-mode gates where backend calls can still leak. Use TDD per bug surface, then wire component behavior to tested helpers. Integrate in small commits to reduce merge conflicts across parallel subagents.

**Tech Stack:** React Router v7, React, TanStack Query, Vitest, TypeScript, demo corpus adapter (`apps/mail/lib/demo-data/*`), Chrome DevTools MCP for final smoke checks.

---

## File Structure / Responsibility Map

- [apps/mail/components/mail/thread-display.tsx](apps/mail/components/mail/thread-display.tsx)
  - Important toggle handler and right-pane thread actions/toasts.
- [apps/mail/components/mail/mail-list.tsx](apps/mail/components/mail/mail-list.tsx)
  - Left-list thread row visuals (including new important stripe indicator).
- [apps/mail/components/mail/mail-content.tsx](apps/mail/components/mail/mail-content.tsx)
  - Right-pane message HTML rendering pipeline.
- [apps/mail/app/(routes)/mail/[folder]/page.tsx](apps/mail/app/(routes)/mail/%5Bfolder%5D/page.tsx)
  - Folder route validation and redirect behavior.
- [apps/mail/config/navigation.ts](apps/mail/config/navigation.ts)
  - Main sidebar nav folder/queue definitions.
- [apps/mail/components/ui/nav-main.tsx](apps/mail/components/ui/nav-main.tsx)
  - Bottom links (Live Support / Feedback) rendering.
- [apps/mail/lib/demo-data/client.ts](apps/mail/lib/demo-data/client.ts)
  - Folder-to-demo-query context mapping for demo mode.
- [apps/mail/providers/query-provider.tsx](apps/mail/providers/query-provider.tsx)
  - Persisted query hydration/refetch policy and backend noise controls in demo mode.

### New helper files

- [apps/mail/lib/mail/important-ui.ts](apps/mail/lib/mail/important-ui.ts)
  - `buildImportantToastResult()` and `isImportantThread()` pure helpers.
- [apps/mail/lib/mail/resolve-mail-html.ts](apps/mail/lib/mail/resolve-mail-html.ts)
  - Demo-safe HTML resolution fallback logic.
- [apps/mail/lib/demo/folder-map.ts](apps/mail/lib/demo/folder-map.ts)
  - Source of truth for requested folder model and queue aliases.
- [apps/mail/lib/demo/support-links.ts](apps/mail/lib/demo/support-links.ts)
  - Feature-gated support link visibility.
- [apps/mail/lib/demo/query-policy.ts](apps/mail/lib/demo/query-policy.ts)
  - Demo-mode persisted-query hydration policy.

### New/updated test files

- [apps/mail/tests/important-ui.test.ts](apps/mail/tests/important-ui.test.ts)
- [apps/mail/tests/resolve-mail-html.test.ts](apps/mail/tests/resolve-mail-html.test.ts)
- [apps/mail/tests/demo-folder-map.test.ts](apps/mail/tests/demo-folder-map.test.ts)
- [apps/mail/tests/support-links.test.ts](apps/mail/tests/support-links.test.ts)
- [apps/mail/tests/demo-query-policy.test.ts](apps/mail/tests/demo-query-policy.test.ts)

---

## Parallelization Plan

### Wave 1 (parallel-safe)

- **Task 1:** Important action + toast bug + red stripe.
- **Task 2:** Right-pane message body fallback rendering.
- **Task 5:** Demo query hydration/noise policy.

These tasks touch different files and can run concurrently with low conflict risk.

### Wave 2 (partially parallel)

- **Task 3:** Folder/queue IA remodel.
- **Task 4:** Hide Live Support/Feedback for now (commented via feature gate).

Task 3 and 4 are mostly independent; both touch sidebar behavior but different files.

### Wave 3 (sequential)

- **Task 6:** Integration verification + MCP smoke checklist after all merges.

---

### Task 1: Fix Important Toggle UX + Add Red Stripe in Thread List

**Files:**
- Create: `apps/mail/lib/mail/important-ui.ts`
- Modify: `apps/mail/components/mail/thread-display.tsx`
- Modify: `apps/mail/components/mail/mail-list.tsx`
- Test: `apps/mail/tests/important-ui.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { buildImportantToastResult, isImportantThread } from '../lib/mail/important-ui';

describe('important-ui', () => {
  it('returns success toast metadata when mark-important mutation succeeds', () => {
    expect(buildImportantToastResult({ ok: true, nextImportant: true }).type).toBe('success');
  });

  it('returns error toast metadata when mark-important mutation fails', () => {
    expect(buildImportantToastResult({ ok: false, nextImportant: true }).type).toBe('error');
  });

  it('detects important status from optimistic or tag fallback', () => {
    expect(isImportantThread({ optimisticImportant: true, tags: [] })).toBe(true);
    expect(isImportantThread({ optimisticImportant: null, tags: ['IMPORTANT'] })).toBe(true);
    expect(isImportantThread({ optimisticImportant: null, tags: ['INBOX'] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/mail exec vitest run tests/important-ui.test.ts`  
Expected: FAIL (`Cannot find module '../lib/mail/important-ui'`).

- [ ] **Step 3: Write minimal implementation**

```ts
export function buildImportantToastResult(input: { ok: boolean; nextImportant: boolean }) {
  if (input.ok) {
    return {
      type: 'success' as const,
      message: input.nextImportant ? 'Marked as important' : 'Removed important flag',
    };
  }
  return { type: 'error' as const, message: 'Failed to update important status' };
}

export function isImportantThread(input: {
  optimisticImportant: boolean | null;
  tags: string[];
}) {
  if (input.optimisticImportant !== null) return input.optimisticImportant;
  return input.tags.some((tag) => tag.toUpperCase() === 'IMPORTANT');
}
```

- [ ] **Step 4: Wire components**

```tsx
// thread-display.tsx
const nextImportant = !isImportant;
try {
  await toggleImportant({ ids: [id] });
  await refetchThread();
  const toastResult = buildImportantToastResult({ ok: true, nextImportant });
  setIsImportant(nextImportant);
  toast.success(toastResult.message);
} catch {
  const toastResult = buildImportantToastResult({ ok: false, nextImportant });
  toast.error(toastResult.message);
}
```

```tsx
// mail-list.tsx (thread row container)
{displayImportant ? (
  <span className="absolute inset-y-0 right-0 w-1 rounded-r-md bg-red-500" aria-hidden="true" />
) : null}
```

- [ ] **Step 5: Run tests**

Run: `pnpm --dir apps/mail exec vitest run tests/important-ui.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mail/lib/mail/important-ui.ts apps/mail/components/mail/thread-display.tsx apps/mail/components/mail/mail-list.tsx apps/mail/tests/important-ui.test.ts
git commit -m "fix(mail): correct important toggle feedback and add important stripe indicator"
```

---

### Task 2: Restore Right-Pane Message Body in Frontend-Only Demo

**Files:**
- Create: `apps/mail/lib/mail/resolve-mail-html.ts`
- Modify: `apps/mail/components/mail/mail-content.tsx`
- Test: `apps/mail/tests/resolve-mail-html.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { resolveMailHtml } from '../lib/mail/resolve-mail-html';

describe('resolve-mail-html', () => {
  it('uses processed html when available in live mode', () => {
    expect(resolveMailHtml({ isDemo: false, processedHtml: '<p>Processed</p>', rawHtml: '<p>Raw</p>' }))
      .toBe('<p>Processed</p>');
  });

  it('falls back to raw html in demo mode', () => {
    expect(resolveMailHtml({ isDemo: true, processedHtml: '', rawHtml: '<p>Raw</p>' }))
      .toContain('Raw');
  });

  it('falls back to raw html when processed html is empty', () => {
    expect(resolveMailHtml({ isDemo: false, processedHtml: '', rawHtml: '<p>Fallback</p>' }))
      .toContain('Fallback');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/mail exec vitest run tests/resolve-mail-html.test.ts`  
Expected: FAIL (`Cannot find module '../lib/mail/resolve-mail-html'`).

- [ ] **Step 3: Write minimal implementation**

```ts
import { cleanHtml } from '@/lib/email-utils';

export function resolveMailHtml(input: {
  isDemo: boolean;
  processedHtml?: string | null;
  rawHtml: string;
}) {
  if (!input.isDemo && input.processedHtml && input.processedHtml.trim().length > 0) {
    return input.processedHtml;
  }
  return cleanHtml(input.rawHtml || '');
}
```

- [ ] **Step 4: Wire `MailContent` to fallback and disable backend processor in demo**

```tsx
const demoMode = isFrontendOnlyDemo();
const { data: processedData } = useQuery({
  // ...
  enabled: !demoMode,
});

const htmlToRender = resolveMailHtml({
  isDemo: demoMode,
  processedHtml: processedData?.html ?? '',
  rawHtml: html,
});

shadowRootRef.current.innerHTML = htmlToRender;
```

- [ ] **Step 5: Run tests**

Run: `pnpm --dir apps/mail exec vitest run tests/resolve-mail-html.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mail/lib/mail/resolve-mail-html.ts apps/mail/components/mail/mail-content.tsx apps/mail/tests/resolve-mail-html.test.ts
git commit -m "fix(mail): render thread body in demo mode without backend html processor"
```

---

### Task 3: Replace Folder IA with Requested Queue-Oriented Model

**Files:**
- Create: `apps/mail/lib/demo/folder-map.ts`
- Modify: `apps/mail/lib/demo-data/client.ts`
- Modify: `apps/mail/app/(routes)/mail/[folder]/page.tsx`
- Modify: `apps/mail/config/navigation.ts`
- Test: `apps/mail/tests/demo-folder-map.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { resolveFolderContext, DEMO_PRIMARY_FOLDERS } from '../lib/demo/folder-map';

describe('demo folder map', () => {
  it('exposes requested primary folders', () => {
    expect(DEMO_PRIMARY_FOLDERS.map((f) => f.id)).toEqual([
      'internal',
      'individual',
      'group',
      'spam',
      'urgent',
    ]);
  });

  it('maps internal to hr queue context', () => {
    expect(resolveFolderContext('internal')).toEqual({ folder: 'inbox', workQueue: 'hr' });
  });

  it('maps spam to spam folder with no queue', () => {
    expect(resolveFolderContext('spam')).toEqual({ folder: 'spam', workQueue: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/mail exec vitest run tests/demo-folder-map.test.ts`  
Expected: FAIL (`Cannot find module '../lib/demo/folder-map'`).

- [ ] **Step 3: Write minimal implementation**

```ts
export const DEMO_PRIMARY_FOLDERS = [
  { id: 'internal', title: 'Internal mail' },
  { id: 'individual', title: 'Individual room bookings' },
  { id: 'group', title: 'Group bookings' },
  { id: 'spam', title: 'Spam' },
  { id: 'urgent', title: 'Urgent' },
] as const;

export function resolveFolderContext(folder: string) {
  switch (folder) {
    case 'internal':
      return { folder: 'inbox', workQueue: 'hr' as const };
    case 'individual':
      return { folder: 'inbox', workQueue: 'individual' as const };
    case 'group':
      return { folder: 'inbox', workQueue: 'group' as const };
    case 'urgent':
      return { folder: 'inbox', workQueue: 'urgent' as const };
    case 'spam':
      return { folder: 'spam', workQueue: null };
    default:
      return { folder: 'inbox', workQueue: null };
  }
}
```

- [ ] **Step 4: Wire route and nav**

```ts
// [folder]/page.tsx
const ALLOWED_FOLDERS = new Set(['internal', 'individual', 'group', 'spam', 'urgent']);
```

```ts
// navigation.ts (mail sections)
items: [
  { id: 'internal', title: 'Internal mail', url: '/mail/internal', icon: Inbox },
  { id: 'individual', title: 'Individual room bookings', url: '/mail/individual', icon: Users },
  { id: 'group', title: 'Group bookings', url: '/mail/group', icon: Users },
  { id: 'spam', title: m['navigation.sidebar.spam'](), url: '/mail/spam', icon: ExclamationCircle },
  { id: 'urgent', title: 'Urgent', url: '/mail/urgent', icon: ExclamationCircle },
]
```

```ts
// demo-data/client.ts
// use resolveFolderContext(folder) instead of parseWorkQueueSlug directly
```

- [ ] **Step 5: Run tests**

Run: `pnpm --dir apps/mail exec vitest run tests/demo-folder-map.test.ts tests/demo-client-data.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mail/lib/demo/folder-map.ts apps/mail/lib/demo-data/client.ts apps/mail/app/(routes)/mail/[folder]/page.tsx apps/mail/config/navigation.ts apps/mail/tests/demo-folder-map.test.ts
git commit -m "feat(mail): align demo folders with internal/individual/group/spam/urgent model"
```

---

### Task 4: Hide Live Support + Feedback for Now (Without Deleting)

**Files:**
- Create: `apps/mail/lib/demo/support-links.ts`
- Modify: `apps/mail/components/ui/nav-main.tsx`
- Test: `apps/mail/tests/support-links.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { getSupportLinks } from '../lib/demo/support-links';

describe('support links visibility', () => {
  it('returns no support links in demo mode', () => {
    expect(getSupportLinks({ isDemo: true })).toEqual([]);
  });

  it('returns support links in non-demo mode', () => {
    expect(getSupportLinks({ isDemo: false }).map((x) => x.id)).toEqual(['live-support', 'feedback']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/mail exec vitest run tests/support-links.test.ts`  
Expected: FAIL (`Cannot find module '../lib/demo/support-links'`).

- [ ] **Step 3: Write minimal implementation**

```ts
export function getSupportLinks(input: { isDemo: boolean }) {
  if (input.isDemo) return [];
  return [
    { id: 'live-support', title: 'Live Support' },
    { id: 'feedback', title: 'Feedback', url: 'https://feedback.0.email' },
  ];
}
```

- [ ] **Step 4: Wire into `nav-main.tsx` and keep old JSX as comments**

```tsx
const supportLinks = getSupportLinks({ isDemo: isFrontendOnlyDemo() });
// keep the old Live Support / Feedback JSX block commented below for quick restore
```

- [ ] **Step 5: Run tests**

Run: `pnpm --dir apps/mail exec vitest run tests/support-links.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mail/lib/demo/support-links.ts apps/mail/components/ui/nav-main.tsx apps/mail/tests/support-links.test.ts
git commit -m "chore(mail): hide live support and feedback links in demo mode without deleting implementation"
```

---

### Task 5: Stop Demo-Mode Backend Console Noise and Settings Blank State

**Files:**
- Create: `apps/mail/lib/demo/query-policy.ts`
- Modify: `apps/mail/providers/query-provider.tsx`
- Test: `apps/mail/tests/demo-query-policy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { shouldHydratePersistedQueries, shouldInvalidateThreadsOnPersistRestore } from '../lib/demo/query-policy';

describe('demo query policy', () => {
  it('disables persisted query hydration in demo mode', () => {
    expect(shouldHydratePersistedQueries({ isDemo: true })).toBe(false);
  });

  it('skips thread invalidation hook in demo mode', () => {
    expect(shouldInvalidateThreadsOnPersistRestore({ isDemo: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/mail exec vitest run tests/demo-query-policy.test.ts`  
Expected: FAIL (`Cannot find module '../lib/demo/query-policy'`).

- [ ] **Step 3: Write minimal implementation**

```ts
export function shouldHydratePersistedQueries(input: { isDemo: boolean }) {
  return !input.isDemo;
}

export function shouldInvalidateThreadsOnPersistRestore(input: { isDemo: boolean }) {
  return !input.isDemo;
}
```

- [ ] **Step 4: Wire provider policy**

```tsx
const demoMode = isFrontendOnlyDemo();
const allowHydration = shouldHydratePersistedQueries({ isDemo: demoMode });
const shouldInvalidate = shouldInvalidateThreadsOnPersistRestore({ isDemo: demoMode });

if (!allowHydration) {
  return <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>{children}</TRPCProvider>;
}

// PersistQueryClientProvider path stays for non-demo
// guard onSuccess invalidation by `shouldInvalidate`
```

- [ ] **Step 5: Run tests**

Run: `pnpm --dir apps/mail exec vitest run tests/demo-query-policy.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mail/lib/demo/query-policy.ts apps/mail/providers/query-provider.tsx apps/mail/tests/demo-query-policy.test.ts
git commit -m "fix(demo): disable persisted query hydration paths that trigger backend noise"
```

---

### Task 6: Integration Verification + MCP Smoke Checklist

**Files:**
- Modify: `docs/superpowers/plans/2026-04-10-demo-mail-ui-fixes-parallel.md` (checklist state updates only)

- [ ] **Step 1: Run unit tests for all new helper modules**

Run:
```bash
pnpm --dir apps/mail exec vitest run tests/important-ui.test.ts tests/resolve-mail-html.test.ts tests/demo-folder-map.test.ts tests/support-links.test.ts tests/demo-query-policy.test.ts
```
Expected: all PASS.

- [ ] **Step 2: Run demo runtime test pack**

Run:
```bash
pnpm --dir apps/mail exec vitest run tests/demo-runtime.test.ts tests/demo-session.test.ts tests/demo-client-data.test.ts tests/demo-data.adapter.test.ts tests/work-queue-filter.test.ts tests/entry-server-wait.test.ts
```
Expected: all PASS.

- [ ] **Step 3: Manual MCP smoke script**

```text
1) /mail/inbox loads without navigation timeout
2) click first thread -> right pane displays sender text body
3) "Mark as important" shows success toast only (no failure toast)
4) thread row shows red stripe when important
5) sidebar folders show: internal, individual, group, spam, urgent
6) /mail/urgent works as real folder (no "Folder not found" bounce)
7) Live Support/Feedback are hidden
8) /login has no localhost:8787 fetch errors in console
9) /settings/general renders non-empty UI
```

- [ ] **Step 4: Final integration commit**

```bash
git add .
git commit -m "feat(demo): stabilize inbox UX and align folder model for frontend-only client demos"
```

---

## Spec Coverage Self-Review

- **Important action bug:** covered in Task 1 (`thread-display` handler + tests).
- **Right pane message text missing:** covered in Task 2 (`mail-content` fallback + tests).
- **Important visual in list (red stripe):** covered in Task 1 (`mail-list` row marker).
- **Folder model request (internal/individual/group/spam/urgent):** covered in Task 3.
- **Support links hidden without deletion:** covered in Task 4.
- **Demo backend noise + settings blank symptom:** covered in Task 5 plus Task 6 MCP verification.
- **Parallelization guidance:** included in Wave 1/2/3 plan.

No placeholder/TODO items remain; each task includes concrete files, test code, commands, and commit steps.
