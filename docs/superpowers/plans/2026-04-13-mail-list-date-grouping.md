# Mail list date grouping (Outlook-style) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the thread list in **chronological sections** (Pinned, Today, Yesterday, Last week, This month, Last month, Older) with **collapsible section headers**, matching the Outlook-style UX in the reference screenshot—without changing backend APIs.

**Architecture:** Keep `useThreads()` and `useMailNavigation({ items })` on the **thread-only array** (`filteredItems`) so keyboard navigation, bulk selection, and `data-thread-id` scrolling stay correct. Build a **derived virtual row model** (header rows + thread rows) only for rendering `VList`. Section expand/collapse **drops thread rows** from the virtual list when collapsed (no Radix `CollapsibleContent` across virtualized siblings). Pure functions in `lib/mail` compute buckets from `receivedOn` + “now”; starred threads (tag `STARRED` on list payload) optionally populate **Pinned** at the top.

**Tech Stack:** React 19, `virtua` `VList`, `date-fns` v4, Vitest (`apps/mail/tests`), Paraglide (`apps/mail/messages/*.json`).

**Terminology (for search/docs):** Product and Microsoft docs call this **message list grouping by date** (or **Arrange by** date); it is **not** the same as “sort” (order within the list stays newest-first within each section).

---

## Zero-context engineer primer

- **Repo root:** Monorepo root (folder containing `apps/mail`). Commands below assume `pnpm` from root.
- **Package:** `@zero/mail` → path `apps/mail`.
- **Thread list UI:** [`apps/mail/components/mail/mail-list.tsx`](../../../apps/mail/components/mail/mail-list.tsx) — `VList` with `count={filteredItems.length}`, `useMailNavigation({ items })` uses the same `items` from `useThreads()` (not the virtual row index).
- **Thread sort:** [`apps/mail/hooks/use-threads.ts`](../../../apps/mail/hooks/use-threads.ts) already returns threads in API order; treat that as **descending by `receivedOn`** for display (do not re-sort unless you confirm API order invariants).
- **Date field:** [`ParsedMessage.receivedOn`](../../../apps/mail/types/index.ts) is an ISO string; invalid dates fall back to a single **Older** bucket (see Task 1).
- **Tests:** `pnpm --filter=@zero/mail run test:demo` (Vitest, `environment: 'node'` in [`apps/mail/vitest.config.ts`](../../../apps/mail/vitest.config.ts)).
- **Lint:** `pnpm --filter=@zero/mail run lint`.
- **i18n:** After editing `apps/mail/messages/en.json`, run `pnpm --filter=@zero/mail run machine-translate` (see [`apps/mail/package.json`](../../../apps/mail/package.json)) to propagate new keys, then spot-check one non-English file.

**Out of scope unless explicitly requested:**

- Server-side grouping, new tRPC fields, or persisting pin order.
- Exact calendar-week boundaries matching every Outlook locale (v1 uses **simple rolling windows**; see Task 1 comments).
- “Arrange by” dropdown with multiple modes (Conversation / Sender) — only **date sections**.

**Optional context:** Prior art in-repo: [`docs/superpowers/plans/2026-04-11-mail-fe-navigation-performance.md`](./2026-04-11-mail-fe-navigation-performance.md) (navigation must stay on thread indices).

---

## File structure (create / modify)

| File | Responsibility |
|------|------------------|
| [`apps/mail/lib/mail/thread-date-bucket.ts`](../../../apps/mail/lib/mail/thread-date-bucket.ts) | Pure: `MailDateBucket` union, `getDateBucket(receivedOn, now)`, `orderDateBuckets`, `isThreadStarredForPin(message)` |
| [`apps/mail/lib/mail/build-mail-list-virtual-rows.ts`](../../../apps/mail/lib/mail/build-mail-list-virtual-rows.ts) | Pure: `buildMailListVirtualRows(threads, now, expandedBuckets, options)` → discriminated union rows |
| [`apps/mail/tests/thread-date-bucket.test.ts`](../../../apps/mail/tests/thread-date-bucket.test.ts) | Unit tests for bucketing edge cases |
| [`apps/mail/tests/build-mail-list-virtual-rows.test.ts`](../../../apps/mail/tests/build-mail-list-virtual-rows.test.ts) | Unit tests for row expansion + ordering |
| [`apps/mail/components/mail/mail-list-section-header.tsx`](../../../apps/mail/components/mail/mail-list-section-header.tsx) | Presentational header row (chevron, label, `aria-expanded`, keyboard-friendly `button`) |
| [`apps/mail/components/mail/mail-list.tsx`](../../../apps/mail/components/mail/mail-list.tsx) | Wire grouping when not searching; map virtual rows in `VList`; fix `isKeyboardFocused` / spinner row |
| [`apps/mail/messages/en.json`](../../../apps/mail/messages/en.json) (+ other locales after translate) | Labels: Pinned, Today, Yesterday, … |

---

### Task 1: `thread-date-bucket` pure logic

**Files:**

- Create: [`apps/mail/lib/mail/thread-date-bucket.ts`](../../../apps/mail/lib/mail/thread-date-bucket.ts)
- Test: [`apps/mail/tests/thread-date-bucket.test.ts`](../../../apps/mail/tests/thread-date-bucket.test.ts)

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import { getDateBucket, MAIL_DATE_BUCKET_ORDER } from '../lib/mail/thread-date-bucket';

describe('getDateBucket', () => {
  const now = new Date('2026-04-13T12:00:00.000Z');

  it('classifies today', () => {
    expect(getDateBucket('2026-04-13T08:00:00.000Z', now)).toBe('today');
  });

  it('classifies yesterday', () => {
    expect(getDateBucket('2026-04-12T23:59:59.000Z', now)).toBe('yesterday');
  });

  it('classifies last 7 days excluding today and yesterday as lastWeek', () => {
    expect(getDateBucket('2026-04-11T10:00:00.000Z', now)).toBe('lastWeek');
    expect(getDateBucket('2026-04-07T10:00:00.000Z', now)).toBe('lastWeek');
  });

  it('classifies before lastWeek but in current calendar month as thisMonth', () => {
    expect(getDateBucket('2026-04-01T10:00:00.000Z', now)).toBe('thisMonth');
  });

  it('classifies previous calendar month as lastMonth', () => {
    expect(getDateBucket('2026-03-20T10:00:00.000Z', now)).toBe('lastMonth');
  });

  it('classifies older as older', () => {
    expect(getDateBucket('2025-12-01T10:00:00.000Z', now)).toBe('older');
  });

  it('returns older for invalid date string', () => {
    expect(getDateBucket('not-a-date', now)).toBe('older');
  });
});

describe('MAIL_DATE_BUCKET_ORDER', () => {
  it('lists pinned first then chronological sections', () => {
    expect(MAIL_DATE_BUCKET_ORDER[0]).toBe('pinned');
    expect(MAIL_DATE_BUCKET_ORDER).toContain('today');
    expect(MAIL_DATE_BUCKET_ORDER).toContain('older');
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `pnpm --filter=@zero/mail exec vitest run tests/thread-date-bucket.test.ts`

Expected: FAIL — cannot resolve module `../lib/mail/thread-date-bucket` or missing exports.

- [ ] **Step 3: Implement `thread-date-bucket.ts`**

Use `date-fns`: `parseISO`, `isValid`, `startOfDay`, `startOfMonth`, `subMonths`, `differenceInCalendarDays`.

**Bucket rules (v1, rolling “last week”):**

- Normalize `received` and `now` with `startOfDay`.
- `today`: same calendar day as `now`.
- `yesterday`: calendar yesterday.
- `lastWeek`: `received < startOfDay(yesterday)` AND `differenceInCalendarDays(startOfDay(now), received) < 7` (i.e. within the 7-day window but not today/yesterday).
- `thisMonth`: not in above buckets, same month/year as `now`.
- `lastMonth`: calendar month immediately before `now`’s month.
- `older`: everything else.

```typescript
import {
  differenceInCalendarDays,
  parseISO,
  startOfDay,
  startOfMonth,
  subMonths,
  isValid,
} from 'date-fns';

export type MailDateBucket =
  | 'pinned'
  | 'today'
  | 'yesterday'
  | 'lastWeek'
  | 'thisMonth'
  | 'lastMonth'
  | 'older';

/** Section order when rendering (pinned is special: only if non-empty). */
export const MAIL_DATE_BUCKET_ORDER: MailDateBucket[] = [
  'pinned',
  'today',
  'yesterday',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'older',
];

export function getDateBucket(receivedOnIso: string, now: Date): MailDateBucket {
  const received = parseISO(receivedOnIso);
  if (!isValid(received)) return 'older';

  const d0 = startOfDay(received);
  const n0 = startOfDay(now);
  const dayDiff = differenceInCalendarDays(n0, d0);

  if (dayDiff === 0) return 'today';
  if (dayDiff === 1) return 'yesterday';
  if (dayDiff > 1 && dayDiff < 7) return 'lastWeek';

  const startThisMonth = startOfMonth(n0);
  if (d0 >= startThisMonth) return 'thisMonth';

  const startPrevMonth = startOfMonth(subMonths(n0, 1));
  if (d0 >= startPrevMonth && d0 < startThisMonth) return 'lastMonth';

  return 'older';
}

import type { ParsedMessage } from '@/types';

export function isThreadStarredForPin(message: Pick<ParsedMessage, 'tags'>): boolean {
  return message.tags?.some((t) => t.name === 'STARRED') ?? false;
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `pnpm --filter=@zero/mail exec vitest run tests/thread-date-bucket.test.ts -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/mail/thread-date-bucket.ts apps/mail/tests/thread-date-bucket.test.ts
git commit -m "feat(mail): add date bucket helper for list grouping"
```

---

### Task 2: Build virtual rows (headers + threads)

**Files:**

- Create: [`apps/mail/lib/mail/build-mail-list-virtual-rows.ts`](../../../apps/mail/lib/mail/build-mail-list-virtual-rows.ts)
- Test: [`apps/mail/tests/build-mail-list-virtual-rows.test.ts`](../../../apps/mail/tests/build-mail-list-virtual-rows.test.ts)

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import { buildMailListVirtualRows } from '../lib/mail/build-mail-list-virtual-rows';
import type { ParsedMessage } from '@/types';

function t(id: string, receivedOn: string, starred = false): ParsedMessage {
  return {
    id,
    title: '',
    subject: '',
    tags: starred ? [{ id: 's', name: 'STARRED' }] : [],
    sender: { email: 'a@b.c' },
    to: [],
    cc: null,
    bcc: null,
    tls: true,
    receivedOn,
    unread: false,
    body: '',
    processedHtml: '',
    blobUrl: '',
  };
}

describe('buildMailListVirtualRows', () => {
  const now = new Date('2026-04-13T12:00:00.000Z');

  it('inserts header then threads per bucket; omits empty buckets', () => {
    const rows = buildMailListVirtualRows([t('a', '2026-04-13T10:00:00.000Z')], now, new Set(), {
      groupByDate: true,
    });
    const kinds = rows.map((r) => r.type);
    expect(kinds).toEqual(['header', 'thread']);
    expect(rows[0].type === 'header' && rows[0].bucket).toBe('today');
    expect(rows[1].type === 'thread' && rows[1].threadIndex).toBe(0);
  });

  it('places starred threads in pinned with pinned header first', () => {
    const rows = buildMailListVirtualRows(
      [t('old', '2026-01-01T10:00:00.000Z', true), t('today', '2026-04-13T10:00:00.000Z')],
      now,
      new Set(),
      { groupByDate: true },
    );
    expect(rows[0].type === 'header' && rows[0].bucket).toBe('pinned');
    expect(rows[1].type === 'thread' && rows[1].message.id).toBe('old');
  });

  it('when section collapsed, keeps header but drops threads', () => {
    const collapsed = new Set(['today']);
    const rows = buildMailListVirtualRows([t('a', '2026-04-13T10:00:00.000Z')], now, collapsed, {
      groupByDate: true,
    });
    expect(rows.map((r) => r.type)).toEqual(['header']);
  });

  it('when groupByDate false, returns one thread row per item with correct indices', () => {
    const rows = buildMailListVirtualRows([t('a', '2026-04-13T10:00:00.000Z')], now, new Set(), {
      groupByDate: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].type === 'thread' && rows[0].threadIndex).toBe(0);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `pnpm --filter=@zero/mail exec vitest run tests/build-mail-list-virtual-rows.test.ts`

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `build-mail-list-virtual-rows.ts`**

```typescript
import type { ParsedMessage } from '@/types';
import {
  getDateBucket,
  isThreadStarredForPin,
  MAIL_DATE_BUCKET_ORDER,
  type MailDateBucket,
} from './thread-date-bucket';

export type MailListVirtualRow =
  | { type: 'header'; bucket: MailDateBucket; key: string }
  | { type: 'thread'; key: string; message: ParsedMessage; threadIndex: number };

export type BuildMailListVirtualRowsOptions = {
  groupByDate: boolean;
};

export function buildMailListVirtualRows(
  threads: ParsedMessage[],
  now: Date,
  collapsedBuckets: ReadonlySet<MailDateBucket>,
  options: BuildMailListVirtualRowsOptions,
): MailListVirtualRow[] {
  if (!options.groupByDate) {
    return threads.map((message, threadIndex) => ({
      type: 'thread' as const,
      key: `thread:${message.id}`,
      message,
      threadIndex,
    }));
  }

  const byBucket = new Map<MailDateBucket, ParsedMessage[]>();
  for (const b of MAIL_DATE_BUCKET_ORDER) {
    byBucket.set(b, []);
  }

  for (const message of threads) {
    if (isThreadStarredForPin(message)) {
      byBucket.get('pinned')!.push(message);
    } else {
      byBucket.get(getDateBucket(message.receivedOn, now))!.push(message);
    }
  }

  const idToIndex = new Map<string, number>();
  threads.forEach((message, i) => idToIndex.set(message.id, i));

  const rows: MailListVirtualRow[] = [];

  for (const bucket of MAIL_DATE_BUCKET_ORDER) {
    const list = byBucket.get(bucket)!;
    if (list.length === 0) continue;

    rows.push({ type: 'header', bucket, key: `header:${bucket}` });
    if (!collapsedBuckets.has(bucket)) {
      for (const message of list) {
        const threadIndex = idToIndex.get(message.id) ?? 0;
        rows.push({
          type: 'thread',
          key: `thread:${message.id}`,
          message,
          threadIndex,
        });
      }
    }
  }

  return rows;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter=@zero/mail exec vitest run tests/build-mail-list-virtual-rows.test.ts -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/mail/build-mail-list-virtual-rows.ts apps/mail/tests/build-mail-list-virtual-rows.test.ts
git commit -m "feat(mail): build virtual rows for date-grouped mail list"
```

---

### Task 3: Section header component

**Files:**

- Create: [`apps/mail/components/mail/mail-list-section-header.tsx`](../../../apps/mail/components/mail/mail-list-section-header.tsx)

- [ ] **Step 1: Implement component**

```tsx
import { cn } from '@/lib/utils';
import { ChevronRight } from 'lucide-react';
import type { MailDateBucket } from '@/lib/mail/thread-date-bucket';

export type MailListSectionHeaderProps = {
  bucket: MailDateBucket;
  label: string;
  expanded: boolean;
  onToggle: () => void;
};

export function MailListSectionHeader({ label, expanded, onToggle }: MailListSectionHeaderProps) {
  return (
    <div className="border-border/60 border-b px-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          'hover:bg-offsetLight dark:hover:bg-primary/5 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium text-muted-foreground',
          'focus-visible:ring-ring outline-none focus-visible:ring-2',
        )}
      >
        <ChevronRight
          className={cn('size-4 shrink-0 transition-transform', expanded && 'rotate-90')}
          aria-hidden
        />
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Lint**

Run: `pnpm --filter=@zero/mail run lint`

Expected: no new errors in this file.

- [ ] **Step 3: Commit**

```bash
git add apps/mail/components/mail/mail-list-section-header.tsx
git commit -m "feat(mail): add collapsible mail list section header"
```

---

### Task 4: i18n labels for sections

**Files:**

- Modify: [`apps/mail/messages/en.json`](../../../apps/mail/messages/en.json) (inside `common.mail` object, same nesting level as `noEmailsToSelect`)

- [ ] **Step 1: Add English strings**

Insert these keys (valid JSON — watch commas):

```json
"listSection": {
  "pinned": "Pinned",
  "today": "Today",
  "yesterday": "Yesterday",
  "lastWeek": "Last week",
  "thisMonth": "This month",
  "lastMonth": "Last month",
  "older": "Older"
}
```

- [ ] **Step 2: Machine-translate other locales**

Run: `pnpm --filter=@zero/mail run machine-translate`

- [ ] **Step 3: Regenerate Paraglide types if required by your workflow**

If `m['common.mail.listSection.today']` is missing at compile time, run the project’s usual `paraglide` / `inlang` compile step (often part of dev server).

- [ ] **Step 4: Commit**

```bash
git add apps/mail/messages
git commit -m "feat(mail): i18n strings for mail list date sections"
```

---

### Task 5: Integrate into `mail-list.tsx`

**Files:**

- Modify: [`apps/mail/components/mail/mail-list.tsx`](../../../apps/mail/components/mail/mail-list.tsx)

- [ ] **Step 1: Add state and row builder**

Near `MailList`:

```typescript
import { useMemo, useState, useCallback } from 'react';
import type { MailDateBucket } from '@/lib/mail/thread-date-bucket';
import { buildMailListVirtualRows } from '@/lib/mail/build-mail-list-virtual-rows';
import { MailListSectionHeader } from '@/components/mail/mail-list-section-header';

// inside MailList:
const [collapsedSections, setCollapsedSections] = useState<Set<MailDateBucket>>(() => new Set());

const toggleSection = useCallback((bucket: MailDateBucket) => {
  setCollapsedSections((prev) => {
    const next = new Set(prev);
    if (next.has(bucket)) next.delete(bucket);
    else next.add(bucket);
    return next;
  });
}, []);

const groupList = !isFiltering;

const virtualRows = useMemo(
  () =>
    buildMailListVirtualRows(filteredItems, new Date(), collapsedSections, {
      groupByDate: groupList,
    }),
  [filteredItems, collapsedSection, groupList],
);
```

Fix typo: dependency array must be `[filteredItems, collapsedSections, groupList]`.

- [ ] **Step 2: Map bucket → label**

```typescript
import { m } from '@/paraglide/messages';

function sectionLabel(bucket: MailDateBucket): string {
  switch (bucket) {
    case 'pinned':
      return m['common.mail.listSection.pinned']();
    case 'today':
      return m['common.mail.listSection.today']();
    case 'yesterday':
      return m['common.mail.listSection.yesterday']();
    case 'lastWeek':
      return m['common.mail.listSection.lastWeek']();
    case 'thisMonth':
      return m['common.mail.listSection.thisMonth']();
    case 'lastMonth':
      return m['common.mail.listSection.lastMonth']();
    case 'older':
      return m['common.mail.listSection.older']();
    default:
      return bucket;
  }
}
```

- [ ] **Step 3: Replace `VList` count and renderer**

- Set `count={virtualRows.length}`.
- Renderer: `const row = virtualRows[index];` — if `row.type === 'header'`, render `MailListSectionHeader` with `expanded={!collapsedSections.has(row.bucket)}` and `onToggle={() => toggleSection(row.bucket)}`.
- If `row.type === 'thread'`, render `<Comp message={row.message} isKeyboardFocused={focusedIndex === row.threadIndex && keyboardActive} index={row.threadIndex} onClick={handleMailClick} />`.

**Spinner row:** Render the loading spinner when the **last virtual row** is a thread and that thread is the last item in `filteredItems` (e.g. `row.type === 'thread' && row.threadIndex === filteredItems.length - 1`), not when `index === filteredItems.length - 1`.

- [ ] **Step 4: Virtua keys and dynamic height**

Per [`virtua` docs](https://github.com/inokawa/virtua), prefer **stable keys** (`row.key`). If the current `VList` API in your version supports `item` / `getKey`, pass `getKey={(i) => virtualRows[i]?.key ?? i}` if required; otherwise ensure the outermost element in each rendered row has `key={row.key}`.

Optional: **remove** fixed `itemSize={100}` so virtua can measure (headers are shorter than threads); if scroll jank appears, set `itemSize` as initial hint only or give header wrapper `className="min-h-9"` and thread wrapper `className="min-h-[100px]"` for stable measurement.

- [ ] **Step 5: Manual smoke test**

1. `pnpm --filter=@zero/mail run dev` — open inbox.
2. Confirm sections and chevrons; collapse “Today”; threads disappear; header stays.
3. Arrow keys / j k: focus moves thread-to-thread only (headers skipped because navigation uses `items` indices).
4. Search active: flat list (no section headers).

- [ ] **Step 6: Run automated checks**

Run:

```bash
pnpm --filter=@zero/mail run test:demo
pnpm --filter=@zero/mail run lint
```

Expected: PASS / clean for touched files.

- [ ] **Step 7: Commit**

```bash
git add apps/mail/components/mail/mail-list.tsx
git commit -m "feat(mail): group inbox list by date with collapsible sections"
```

---

## Self-review (spec coverage)

| Requirement | Task |
|-------------|------|
| Sections: Today, Yesterday, Last week, This month, Last month (+ Older) | Task 1, 2, 5 |
| Pinned-style top section | Task 1–2 (`pinned` + `STARRED`), 4–5 |
| Collapsible headers with chevron | Task 3, 5 |
| Front-end only | All tasks |
| Virtual list + infinite scroll preserved | Task 5 (`findEndIndex` still vs `virtualRows.length`; load-more predicate updated if needed) |
| Search / filter UX | Task 5 (`groupList = !isFiltering`) |

**Placeholder scan:** None intentional.

**Type consistency:** `MailDateBucket` defined once in `thread-date-bucket.ts`; `collapsedSections` is `Set<MailDateBucket>` everywhere.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-13-mail-list-date-grouping.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Fresh subagent per task, review between tasks, fast iteration. **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development.

**2. Inline Execution** — Execute tasks in this session using superpowers:executing-plans with batch checkpoints.

Which approach?
