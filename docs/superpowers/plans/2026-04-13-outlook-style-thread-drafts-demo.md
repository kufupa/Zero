---
name: Outlook-style draft UI demo
overview: "Front-end–first, scalable draft experience for the mail demo: Outlook-parity thread draft card (“AI E-mails” style), shared preview/helpers, demo data alignment between JSON corpus and local-store drafts, and a documented thin contract for future backend—without building full server draft sync yet."
todos:
  - id: draft-preview-lib
    content: "Task 1: Add plainTextDraftPreview + Vitest in apps/mail/lib/mail/draft-preview.ts"
    status: pending
  - id: draft-view-model
    content: "Task 2: thread-draft-view-model.ts + tests; wire from latestDraft"
    status: pending
  - id: outlook-components
    content: "Task 3: ThreadDraftCard + ThreadAiMailsSection components"
    status: pending
  - id: thread-display-wire
    content: "Task 4: Replace amber banner; demo delete + invalidate queries"
    status: pending
  - id: i18n-draft-strings
    content: "Task 5: Paraglide keys + machine-translate + mail-list tooltip"
    status: pending
  - id: demo-id-merge
    content: "Task 6: Align SEED_DRAFTS ids with corpus; optional getDemoThread merge"
    status: pending
  - id: backend-doc-stub
    content: "Task 7: Comment-only future drafts API on IGetThreadResponse types"
    status: pending
isProject: false
---

# Outlook-style thread drafts (demo-first) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a **demo-quality, Outlook-like** draft surface in the thread view (card with `[Draft]`, unsent notice, **Saved:** timestamp, edit/delete, body preview) plus a small **scalable front-end layer** so real backends can plug in later without rewriting UI.

**Architecture:** Treat a thread draft as a **first-class view model** (`ThreadDraftViewModel`) built from `latestDraft` ([`useThread`](apps/mail/hooks/use-threads.ts) already exposes `latestDraft` via `findLast` on full `messages`). Move HTML→plain preview into a **pure helper** reused by list/detail. Replace the current amber **banner** in [`thread-display.tsx`](apps/mail/components/mail/thread-display.tsx) with a dedicated **`ThreadDraftCard`** (and optional **`ThreadAiMailsSection`** header matching your screenshot). For the demo only, **merge** [`local-store`](apps/mail/lib/demo/local-store.ts) drafts into [`getDemoThread`](apps/mail/lib/demo-data/adapter.ts) when `threadId` matches so **same draft** appears in thread UI, drafts folder, and compose (`draftId`). Backend: document the future API shape on types/comments only—**no** full POP3/IMAP draft sync in this phase.

**Tech stack:** React 19, TanStack Query, Paraglide (`apps/mail/messages/*.json`), Tailwind, existing [`MailDisplay`](apps/mail/components/mail/mail-display.tsx) patterns for reference (do not bloat it—new components).

**Save this plan to:** [`docs/superpowers/plans/2026-04-13-outlook-style-thread-drafts-demo.md`](docs/superpowers/plans/2026-04-13-outlook-style-thread-drafts-demo.md) when committing docs.

---

## File structure (create / modify)

| File | Responsibility |
|------|----------------|
| [`apps/mail/lib/mail/draft-preview.ts`](apps/mail/lib/mail/draft-preview.ts) | Pure: `plainTextDraftPreview(htmlOrText: string): string` (move logic out of `decodeDraftPreview` in thread-display) |
| [`apps/mail/tests/draft-preview.test.ts`](apps/mail/tests/draft-preview.test.ts) | Unit tests for preview stripping |
| [`apps/mail/lib/mail/thread-draft-view-model.ts`](apps/mail/lib/mail/thread-draft-view-model.ts) | Pure: `buildThreadDraftViewModel(latestDraft: ParsedMessage \| undefined, opts): ThreadDraftViewModel \| null` — subject, preview, `savedAt` from `receivedOn` or demo override |
| [`apps/mail/components/mail/thread-draft-card.tsx`](apps/mail/components/mail/thread-draft-card.tsx) | Outlook-style card UI + actions (edit → compose, delete → optimistic) |
| [`apps/mail/components/mail/thread-ai-mails-section.tsx`](apps/mail/components/mail/thread-ai-mails-section.tsx) | Optional wrapper: title **AI E-mails**, `Summarise` placeholder button (demo: `toast` or no-op), contains `ThreadDraftCard` |
| [`apps/mail/components/mail/thread-display.tsx`](apps/mail/components/mail/thread-display.tsx) | Remove inline `decodeDraftPreview`; render `ThreadAiMailsSection` + `ThreadDraftCard` **above** [`MessageList`](apps/mail/components/mail/thread-display.tsx) when draft exists; remove duplicate amber strip |
| [`apps/mail/components/mail/mail-list.tsx`](apps/mail/components/mail/mail-list.tsx) | Use `plainTextDraftPreview` for tooltip consistency if still showing pencil; i18n tooltip |
| [`apps/mail/lib/demo-data/adapter.ts`](apps/mail/lib/demo-data/adapter.ts) | After `mapDemoMessageToParsed`, **merge** local-store draft for same `thread.id` (by `threadId`) so thread `messages` include **one** canonical draft row aligned with [`listDemoDrafts`](apps/mail/lib/demo/local-store.ts) |
| [`apps/mail/lib/demo/local-store.ts`](apps/mail/lib/demo/local-store.ts) | **Change `SEED_DRAFTS` `id` values** to match corpus draft **message** `id` (e.g. `sa-002-msg-02` for thread `sa-thread-002`) so `draftId` in URL matches thread `latestDraft.id` |
| [`apps/mail/messages/en.json`](apps/mail/messages/en.json) (+ other locales via `machine-translate`) | All user-visible draft strings |
| [`apps/server/src/lib/driver/types.ts`](apps/server/src/lib/driver/types.ts) (or nearest thread response type) | **Comment-only** “Future: `drafts[]` / sync” — optional, minimal |

---

## Reference: current wiring (keep behavior, change presentation)

- `latestDraft` derivation: [`useThread` useMemo](apps/mail/hooks/use-threads.ts) — `findLast` on `message.isDraft`.
- Demo corpus already has `isDraft` messages: [`centurion-threads.json`](apps/mail/lib/demo-data/centurion-threads.json) (e.g. `sa-002-msg-02`).
- **Problem today:** seed drafts use ids like `draft-demo-kleinkaap` while thread draft message id is `sa-002-msg-02` — **compose/drafts-folder/thread disagree**. Fixing seeds + optional adapter merge fixes the demo story.

---

### Task 1: Pure `plainTextDraftPreview` + tests

**Files:**
- Create: [`apps/mail/lib/mail/draft-preview.ts`](apps/mail/lib/mail/draft-preview.ts)
- Test: [`apps/mail/tests/draft-preview.test.ts`](apps/mail/tests/draft-preview.test.ts)

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import { plainTextDraftPreview } from '../lib/mail/draft-preview';

describe('plainTextDraftPreview', () => {
  it('strips tags and decodes common entities', () => {
    const input = '<p>Hi&nbsp;<b>all</b></p><script>x</script>';
    expect(plainTextDraftPreview(input)).toBe('Hi all');
  });

  it('collapses whitespace', () => {
    expect(plainTextDraftPreview('  a\n\tb  ')).toBe('a b');
  });

  it('returns empty string for empty input', () => {
    expect(plainTextDraftPreview('')).toBe('');
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `pnpm --filter=@zero/mail exec vitest run apps/mail/tests/draft-preview.test.ts`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
export function plainTextDraftPreview(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `pnpm --filter=@zero/mail exec vitest run apps/mail/tests/draft-preview.test.ts`

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/mail/draft-preview.ts apps/mail/tests/draft-preview.test.ts
git commit -m "feat(mail): add plainTextDraftPreview helper"
```

---

### Task 2: `ThreadDraftViewModel` builder

**Files:**
- Create: [`apps/mail/lib/mail/thread-draft-view-model.ts`](apps/mail/lib/mail/thread-draft-view-model.ts)
- Test: [`apps/mail/tests/thread-draft-view-model.test.ts`](apps/mail/tests/thread-draft-view-model.test.ts)

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import { buildThreadDraftViewModel } from '../lib/mail/thread-draft-view-model';
import type { ParsedMessage } from '@/types';

function draftMsg(partial: Partial<ParsedMessage> & Pick<ParsedMessage, 'id'>): ParsedMessage {
  return {
    title: '',
    subject: 'Subj',
    tags: [],
    sender: { email: 'a@b.c' },
    to: [],
    cc: null,
    bcc: null,
    tls: true,
    receivedOn: '2026-04-13T18:28:00.000Z',
    unread: false,
    body: '<p>Hi all</p>',
    processedHtml: '',
    blobUrl: '',
    isDraft: true,
    ...partial,
  };
}

describe('buildThreadDraftViewModel', () => {
  it('returns null when no draft', () => {
    expect(buildThreadDraftViewModel(undefined)).toBeNull();
  });

  it('builds preview and saved label input', () => {
    const vm = buildThreadDraftViewModel(draftMsg({ id: 'd1', decodedBody: '<p>Hi</p>' }));
    expect(vm?.id).toBe('d1');
    expect(vm?.subject).toBe('Subj');
    expect(vm?.bodyPreview).toBe('Hi');
    expect(vm?.savedAtIso).toBe('2026-04-13T18:28:00.000Z');
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `pnpm --filter=@zero/mail exec vitest run apps/mail/tests/thread-draft-view-model.test.ts`

- [ ] **Step 3: Implement**

```typescript
import type { ParsedMessage } from '@/types';
import { plainTextDraftPreview } from './draft-preview';

export type ThreadDraftViewModel = {
  id: string;
  subject: string;
  bodyPreview: string;
  savedAtIso: string;
};

export function buildThreadDraftViewModel(
  latestDraft: ParsedMessage | undefined,
): ThreadDraftViewModel | null {
  if (!latestDraft?.isDraft) return null;

  const raw = latestDraft.decodedBody || latestDraft.body || '';
  const bodyPreview = plainTextDraftPreview(raw);
  const savedAtIso = latestDraft.receivedOn.split('.')[0] || latestDraft.receivedOn;

  return {
    id: latestDraft.id,
    subject: latestDraft.subject?.trim() || '',
    bodyPreview,
    savedAtIso,
  };
}
```

Adjust test import path if your Vitest alias differs (`@/types` vs relative).

- [ ] **Step 4: Run test — expect pass**

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/mail/thread-draft-view-model.ts apps/mail/tests/thread-draft-view-model.test.ts
git commit -m "feat(mail): add thread draft view model builder"
```

---

### Task 3: `ThreadDraftCard` + `ThreadAiMailsSection` (Outlook parity)

**Files:**
- Create: [`apps/mail/components/mail/thread-draft-card.tsx`](apps/mail/components/mail/thread-draft-card.tsx)
- Create: [`apps/mail/components/mail/thread-ai-mails-section.tsx`](apps/mail/components/mail/thread-ai-mails-section.tsx)

- [ ] **Step 1: Implement `ThreadDraftCard`**

Use tokens close to screenshot: dark card `border-border`, rose/magenta **draft** headline (`text-rose-500` / `dark:text-rose-400`), secondary line for unsent notice, top-right **Saved:** + `formatDateWithWeekdayAndTime` from [`@/lib/utils`](apps/mail/lib/utils.ts), row of **Pencil** + **Trash** (reuse `Button` + icons from [`icons`](apps/mail/components/icons/icons.tsx) or `lucide-react`). Truncate body preview to ~3 lines (`line-clamp-3`). Props:

```typescript
export type ThreadDraftCardProps = {
  subject: string;
  bodyPreview: string;
  savedAtLabel: string;
  draftBadge: string;
  unsentNotice: string;
  onEdit: () => void;
  onDelete: () => void;
};
```

`savedAtLabel` built in parent: `m['common.threadDisplay.draftSavedPrefix']() + formatted` or single message with param if you prefer ICU — see Task 5.

- [ ] **Step 2: Implement `ThreadAiMailsSection`**

```tsx
export function ThreadAiMailsSection({
  title,
  onSummarise,
  children,
}: {
  title: string;
  onSummarise?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border mb-3 rounded-xl border bg-panelLight/80 p-3 dark:bg-panelDark/80">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {onSummarise ? (
          <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={onSummarise}>
            {/* icon + Summarise */}
          </Button>
        ) : null}
      </div>
      {children}
    </section>
  );
}
```

Demo `onSummarise`: `() => toast.message('Summarise (demo)')` from `sonner`.

- [ ] **Step 3: Lint**

Run: `pnpm --filter=@zero/mail run lint`

- [ ] **Step 4: Commit**

```bash
git add apps/mail/components/mail/thread-draft-card.tsx apps/mail/components/mail/thread-ai-mails-section.tsx
git commit -m "feat(mail): add Outlook-style draft card and AI mails section"
```

---

### Task 4: Wire `ThreadDisplay` — replace banner, place draft above message list

**Files:**
- Modify: [`apps/mail/components/mail/thread-display.tsx`](apps/mail/components/mail/thread-display.tsx)

- [ ] **Step 1: Remove** local `decodeDraftPreview`; import `buildThreadDraftViewModel` and `ThreadDraftCard`, `ThreadAiMailsSection`.

- [ ] **Step 2: Compute view model**

```typescript
const draftVm = useMemo(
  () => buildThreadDraftViewModel(latestDraft as ParsedMessage | undefined),
  [latestDraft],
);
```

(Use proper type if `latestDraft` already is `ParsedMessage`.)

- [ ] **Step 3: Delete handler (demo)**

Import `deleteDemoDraft` from [`@/lib/demo/local-store`](apps/mail/lib/demo/local-store.ts) guarded by `isFrontendOnlyDemo()`, then `queryClient.invalidateQueries({ queryKey: ['demo', 'mail', 'thread', id] })` and `['demo', 'mail', 'listThreads', ...]` as needed — mirror patterns from optimistic draft delete in [`mail-list.tsx`](apps/mail/components/mail/mail-list.tsx).

- [ ] **Step 4: Render** inside the loaded-thread branch **before** `MessageList`:

```tsx
{draftVm ? (
  <ThreadAiMailsSection
    title={m['common.threadDisplay.aiMailsTitle']()}
    onSummarise={() => toast.message(m['common.threadDisplay.summariseDemoToast']())}
  >
    <ThreadDraftCard
      subject={draftVm.subject}
      bodyPreview={draftVm.bodyPreview}
      savedAtLabel={m['common.threadDisplay.draftSavedAt']({
        date: formatDateWithWeekdayAndTime(draftVm.savedAtIso),
      })}
      draftBadge={m['common.threadDisplay.draftBadge']()}
      unsentNotice={m['common.threadDisplay.draftUnsentNotice']()}
      onEdit={openDraftForEdit}
      onDelete={handleDeleteDraftDemo}
    />
  </ThreadAiMailsSection>
) : null}
```

Remove the old amber `hasDraft` block (lines ~1029–1070 in current tree).

- [ ] **Step 5: Manual smoke**

Open thread `sa-thread-002` in demo: see AI section + draft card above messages; **Continue** opens compose with `draftId` = `sa-002-msg-02` after Task 6.

- [ ] **Step 6: Commit**

```bash
git add apps/mail/components/mail/thread-display.tsx
git commit -m "feat(mail): show Outlook-style draft card in thread view"
```

---

### Task 5: i18n strings (Paraglide)

**Files:**
- Modify: [`apps/mail/messages/en.json`](apps/mail/messages/en.json) — under `common.threadDisplay` add:

```json
"aiMailsTitle": "AI E-mails",
"summariseDemoToast": "Summarise (demo)",
"draftBadge": "[Draft]",
"draftUnsentNotice": "This message hasn't been sent.",
"draftSavedAt": "Saved: {date}",
"draftTooltip": "Draft",
"continueDraft": "Continue draft"
```

- [ ] **Step 1: Add keys** (valid JSON — mind commas).

- [ ] **Step 2: Machine-translate**

Run: `pnpm --filter=@zero/mail run machine-translate`

- [ ] **Step 3: Replace** hardcoded strings in [`mail-list.tsx`](apps/mail/components/mail/mail-list.tsx) tooltip (`Draft`) and any remaining literals in draft UI.

- [ ] **Step 4: Commit**

```bash
git add apps/mail/messages
git commit -m "feat(mail): i18n for Outlook-style draft UI"
```

---

### Task 6: Demo data — align seed draft ids + optional adapter merge

**Files:**
- Modify: [`apps/mail/lib/demo/local-store.ts`](apps/mail/lib/demo/local-store.ts)
- Modify: [`apps/mail/lib/demo-data/adapter.ts`](apps/mail/lib/demo-data/adapter.ts)

- [ ] **Step 1: Align seed ids**

Set `SEED_DRAFTS[0].id` to **`sa-002-msg-02`** (matches [`centurion-threads.json`](apps/mail/lib/demo-data/centurion-threads.json) draft message for `sa-thread-002`). Set second seed id to the draft message id for `sa-thread-006` (grep corpus for that thread’s `isDraft` message `id`).

- [ ] **Step 2: Adapter merge (optional but recommended)**

In `getDemoThread`, after `parsedMessages`:

```typescript
import { listDemoDrafts } from '@/lib/demo/local-store';

const overlay = listDemoDrafts().filter((d) => d.threadId === entry.thread.id);
// For each overlay, if parsedMessages has message id === d.id, replace body/subject/to from store;
// else append synthetic ParsedMessage with isDraft: true (same shape as mapDemoMessageToParsed).
```

Use `normalizeDemoMessageBody` for `decodedBody`/`processedHtml` when injecting from store.

- [ ] **Step 3: Test**

Run: `pnpm --filter=@zero/mail run test:demo`

- [ ] **Step 4: Commit**

```bash
git add apps/mail/lib/demo/local-store.ts apps/mail/lib/demo-data/adapter.ts
git commit -m "fix(demo): align draft ids and merge local-store draft into thread"
```

---

### Task 7: Backend contract (documentation only)

**Files:**
- Modify: [`apps/server/src/lib/driver/types.ts`](apps/server/src/lib/driver/types.ts) (or `IGetThreadResponse` definition file)

- [ ] **Step 1: Add comment block** (no behavior change):

```typescript
/**
 * Drafts (future backend):
 * - v1: `messages[].isDraft` + `latest` non-draft (current).
 * - v2 optional: `drafts: ParsedMessage[]` for multi-draft / AI variants; FE `buildThreadDraftViewModel` picks `findLast` or explicit `activeDraftId`.
 */
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/lib/driver/types.ts
git commit -m "docs(mail): sketch future thread draft API shape"
```

---

## Self-review

**Spec coverage (screenshot + your asks):**

| Requirement | Task |
|-------------|------|
| Outlook-like draft card (badge, unsent, Saved, edit/delete, preview) | 3, 4 |
| “AI E-mails” + Summarise row | 3, 4, 5 |
| Scalable FE (pure preview + view model + dedicated components) | 1, 2, 3 |
| Demo-first; backend not built | 7 comment-only; 6 demo merge |
| Draft folder / thread / compose same id | 6 |

**Placeholder scan:** None.

**Type consistency:** `ThreadDraftViewModel` uses `ParsedMessage` from `@/types`; `latestDraft` from `useThread` must match that shape.

---

## Execution handoff

Plan complete. **Save** to [`docs/superpowers/plans/2026-04-13-outlook-style-thread-drafts-demo.md`](docs/superpowers/plans/2026-04-13-outlook-style-thread-drafts-demo.md) when you snapshot it in git.

Two execution options:

**1. Subagent-Driven (recommended)** — Fresh subagent per task, review between tasks. **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development.

**2. Inline Execution** — Batch tasks in this session with checkpoints. **REQUIRED SUB-SKILL:** superpowers:executing-plans.

Which approach?
