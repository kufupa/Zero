# Advanced Folder Counts & Search Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand Zero's mailbox folder counters and search feedback by adding (1) active Draft counts, (2) total thread count computation alongside unread counts in a single SQL aggregation pass, (3) accessible rich folder tooltips (`"X unread of Y threads"`), (4) right-click "Mark all as read" context actions, and (5) search result aggregate count badges in `MailSearchBar`.

**Architecture:**
- **Backend (`apps/server-pilot`)**:
  - Update `loadUnreadCounts` in `apps/server-pilot/src/mail/folder-unread-counts.ts` to compute both `unreadCount` and `totalCount` in one single conditional `count(*) FILTER (WHERE ...)` query.
  - Aggregate active unsent drafts from `mailDraft` where `status in ('active', 'candidate')` and `isSent = false`.
  - Add `markFolderAsRead` mutation in `apps/server-pilot/src/trpc/routes/mail.ts` to bulk-mark an entire folder, category, or label as read in 1 SQL query.
- **Frontend (`apps/mail`)**:
  - Update `sidebar-unread-counts.ts` to support both unread and total counts, map `'drafts'` to the active drafts count, and provide tooltip formatting helpers.
  - Wire `drafts` badge and tooltips into `nav-main.tsx`, `sidebar-labels.tsx`, and `recursive-folder.tsx`.
  - Wrap sidebar folder and category items with a context menu providing "Mark all as read" alongside existing label actions.
  - Surface active search match count in `MailSearchBar` as an accessible counter badge (`"14 results"`).
  - Add cache invalidations across draft lifecycle events and folder mark-as-read mutations.

**Tech Stack:** TypeScript, Next.js (React 19), tRPC v11, Drizzle ORM, PostgreSQL, Radix UI ContextMenu & Tooltip, Jotai, Vitest.

## Global Constraints
- Zero tolerance for running tests against pilot or production RDS; disposable test DB only (`TEST_DATABASE_URL` + `CONFIRM_DISPOSABLE_TEST_DB=1`).
- Strict isolation from concurrent workspace activity (do NOT touch `apps/mail/tests/file-drag.test.ts` or related files).
- NEVER run project-wide lint/format commands (`pnpm check`, `pnpm lint`, `pnpm format`).
- Maintain backward compatibility with existing `mail.unreadCounts` callers.

---

## Review Gates & Reconciled Decisions

1. **Eng Review (Completeness Floor):**
   - Single SQL query for both unread and total thread counts avoids dual database round-trips.
   - Server-side `markFolderAsRead` mutation is necessary to prevent client payload overflows when folders contain hundreds or thousands of unread threads.
   - Draft count lifecycle must invalidate `trpc.mail.unreadCounts` on draft save, send, and discard.

2. **Ponytail Review (Simplicity Ceiling):**
   - No database migrations or new tables: badge mode preference lives in `localStorage` via Jotai atom.
   - No speculative folder properties modals or color pickers.
   - Search count uses existing `threadsQuery.data` count, not an extra search count endpoint.

3. **Design Review (Visual & Ergonomics):**
   - Expanded mode shows unread count badge; hovering reveals `"3 unread of 124 threads"` (or `"124 threads (all read)"`).
   - Drafts badge follows system badge styling and displays total active drafts.
   - Search count pill sits cleanly in `MailSearchBar` next to active filter chips.

---

## Bite-Sized Implementation Tasks

### Task 1: Server-Side Single-Pass Unread + Total Counts and Active Drafts

**Files:**
- Modify: `apps/server-pilot/src/mail/folder-unread-counts.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Test: `apps/server-pilot/tests/mail-unread-counts.test.ts`

**Interfaces:**
- `MailUnreadFolderId`: `'inbox' | 'sent' | 'archive' | 'snoozed' | 'bin' | 'spam'`
- `MailFolderCountItem`: `{ id: MailUnreadFolderId; unreadCount: number; totalCount: number }`
- `MailCategoryCountItem`: `{ categoryId: string; unreadCount: number; totalCount: number }`
- `MailLabelCountItem`: `{ labelId: string; unreadCount: number; totalCount: number }`
- `MailUnreadCounts`: `{ folders: MailFolderCountItem[]; categories: MailCategoryCountItem[]; labels: MailLabelCountItem[]; draftsCount: number }`

- [x] **Step 1: Write failing server tests for total counts and draft counts**

In `apps/server-pilot/tests/mail-unread-counts.test.ts`:
Add assertions checking:
1. `counts.folders.find(f => f.id === 'inbox').totalCount` reflects both read and unread threads.
2. `counts.folders.find(f => f.id === 'inbox').unreadCount` reflects unread threads only.
3. `counts.draftsCount` returns active non-sent draft count.
4. Categories and labels return `{ unreadCount, totalCount }`.

- [x] **Step 2: Run test to verify failure**

Run: `CONFIRM_DISPOSABLE_TEST_DB=1 TEST_DATABASE_URL=postgres://zero:zero@127.0.0.1:5433/zero_test pnpm --filter server-pilot test tests/mail-unread-counts.test.ts --run`
Expected: FAIL with missing `totalCount` and `draftsCount`.

- [x] **Step 3: Implement single-pass unread + total SQL query and draft count**

In `apps/server-pilot/src/mail/folder-unread-counts.ts`:
```ts
// 1. Single conditional aggregate query computing both unread and total counts:
const systemCounts = await db
  .select({
    inboxUnread: sql<number>`count(*) FILTER (WHERE ${mailThread.isRead} = false AND ${inboxCondition})`,
    inboxTotal: sql<number>`count(*) FILTER (WHERE ${inboxCondition})`,
    sentUnread: sql<number>`count(*) FILTER (WHERE ${mailThread.isRead} = false AND ${sentCondition})`,
    sentTotal: sql<number>`count(*) FILTER (WHERE ${sentCondition})`,
    archiveUnread: sql<number>`count(*) FILTER (WHERE ${mailThread.isRead} = false AND ${archiveCondition})`,
    archiveTotal: sql<number>`count(*) FILTER (WHERE ${archiveCondition})`,
    snoozedUnread: sql<number>`count(*) FILTER (WHERE ${mailThread.isRead} = false AND ${snoozedCondition})`,
    snoozedTotal: sql<number>`count(*) FILTER (WHERE ${snoozedCondition})`,
    binUnread: sql<number>`count(*) FILTER (WHERE ${mailThread.isRead} = false AND ${binCondition})`,
    binTotal: sql<number>`count(*) FILTER (WHERE ${binCondition})`,
    spamUnread: sql<number>`count(*) FILTER (WHERE ${mailThread.isRead} = false AND ${spamCondition})`,
    spamTotal: sql<number>`count(*) FILTER (WHERE ${spamCondition})`,
  })
  .from(mailThread)
  .where(eq(mailThread.transportId, transportId));

// 2. Drafts count:
const [draftsRow] = await db
  .select({ count: sql<number>`count(*)` })
  .from(mailDraft)
  .where(
    and(
      eq(mailDraft.transportId, transportId),
      eq(mailDraft.isSent, false),
      inArray(mailDraft.status, ['active', 'candidate']),
    ),
  );
const draftsCount = Number(draftsRow?.count ?? 0);
```
Update categories and user labels aggregation queries to return `{ unreadCount, totalCount }`.

- [x] **Step 4: Run server tests to verify they pass**

Run: `CONFIRM_DISPOSABLE_TEST_DB=1 TEST_DATABASE_URL=postgres://zero:zero@127.0.0.1:5433/zero_test pnpm --filter server-pilot test tests/mail-unread-counts.test.ts --run`
Expected: PASS (all assertions passing).

- [x] **Step 5: Commit server changes**

```bash
git add apps/server-pilot/src/mail/folder-unread-counts.ts apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/tests/mail-unread-counts.test.ts
git commit -m "feat(server-pilot): single-pass unread and total thread counts with active drafts"
```

---

### Task 2: Server-Side `markFolderAsRead` Bulk Mutation

**Files:**
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Test: `apps/server-pilot/tests/mail-unread-counts.test.ts`

**Interfaces:**
- Input: `z.object({ folder: z.string().optional(), categoryId: z.string().optional(), labelId: z.string().optional() })`
- Returns: `{ updated: number }`

- [x] **Step 1: Write failing test for `markFolderAsRead`**

In `apps/server-pilot/tests/mail-unread-counts.test.ts`:
Add test verifying calling `caller.mail.markFolderAsRead({ folder: 'inbox' })` marks all unread inbox threads as `isRead = true` and updates `unreadCounts` to 0.

- [x] **Step 2: Run test to verify failure**

Run: `CONFIRM_DISPOSABLE_TEST_DB=1 TEST_DATABASE_URL=postgres://zero:zero@127.0.0.1:5433/zero_test pnpm --filter server-pilot test tests/mail-unread-counts.test.ts --run`
Expected: FAIL with `markFolderAsRead` is not a function.

- [x] **Step 3: Implement `markFolderAsRead` in `mail.ts`**

In `apps/server-pilot/src/trpc/routes/mail.ts`:
```ts
markFolderAsRead: mailboxProcedure
  .input(
    z.object({
      folder: z.string().optional(),
      categoryId: z.string().optional(),
      labelId: z.string().optional(),
    }),
  )
  .mutation(async ({ input, ctx }) => {
    const db = getDb();
    const transportId = ctx.activeTransportId;
    // Build conditions matching the folder, category, or label
    // Update mail_thread set isRead = true, updatedAt = now()
    // where transportId = transportId and isRead = false and [conditions]
    return { updated };
  }),
```

- [x] **Step 4: Run test to verify pass**

Run: `CONFIRM_DISPOSABLE_TEST_DB=1 TEST_DATABASE_URL=postgres://zero:zero@127.0.0.1:5433/zero_test pnpm --filter server-pilot test tests/mail-unread-counts.test.ts --run`
Expected: PASS.

- [x] **Step 5: Commit mutation**

```bash
git add apps/server-pilot/src/trpc/routes/mail.ts apps/server-pilot/tests/mail-unread-counts.test.ts
git commit -m "feat(server-pilot): add markFolderAsRead mutation"
```

---

### Task 3: Frontend Snapshot Mapping & Tooltip Formatter

**Files:**
- Modify: `apps/mail/lib/mail/sidebar-unread-counts.ts`
- Modify: `apps/mail/hooks/use-unread-counts.ts`
- Test: `apps/mail/tests/sidebar-unread-counts.test.ts`

**Interfaces:**
- `FolderCountData`: `{ unread: number; total: number }`
- `FolderCountsSnapshot`:
  - `getCount(key: string): number | undefined`
  - `getTotal(key: string): number | undefined`
  - `getTooltip(key: string, title?: string): string`
  - `hasData: boolean`

- [x] **Step 1: Write unit tests for total counts and tooltips in `sidebar-unread-counts.test.ts`**

Test:
1. `snapshot.getCount('drafts')` returns `draftsCount` when > 0.
2. `snapshot.getTotal('inbox')` returns total threads.
3. `snapshot.getTooltip('inbox', 'Inbox')` returns `"3 unread of 124 threads"` when unread > 0.
4. `snapshot.getTooltip('inbox', 'Inbox')` returns `"124 threads (all read)"` when unread = 0.
5. `snapshot.getTooltip('drafts', 'Drafts')` returns `"2 active drafts"`.

- [x] **Step 2: Run test to verify failure**

Run: `pnpm --filter mail test tests/sidebar-unread-counts.test.ts --run`
Expected: FAIL.

- [x] **Step 3: Implement snapshot enhancements and `formatFolderTooltip`**

In `apps/mail/lib/mail/sidebar-unread-counts.ts`:
- Update `FolderCountsSnapshot` interface.
- Add `formatFolderTooltip(title: string, count: number, total: number, isDrafts?: boolean): string`.
- Store both unread and total in count maps.
- Map `'drafts'` key to `draftsCount`.

- [x] **Step 4: Run test to verify pass**

Run: `pnpm --filter mail test tests/sidebar-unread-counts.test.ts --run`
Expected: PASS.

- [x] **Step 5: Commit frontend snapshot mapping**

```bash
git add apps/mail/lib/mail/sidebar-unread-counts.ts apps/mail/hooks/use-unread-counts.ts apps/mail/tests/sidebar-unread-counts.test.ts
git commit -m "feat(mail): add draft counts and tooltip formatter to sidebar snapshot"
```

---

### Task 4: UI Tooltips & Draft Badges in Navigation and My Folders

**Files:**
- Modify: `apps/mail/components/ui/nav-main.tsx`
- Modify: `apps/mail/components/ui/sidebar-labels.tsx`
- Modify: `apps/mail/components/ui/recursive-folder.tsx`
- Test: `apps/mail/tests/mail-sidebar-unread-contract.test.ts`

- [x] **Step 1: Update UI contract test for Drafts badge and rich tooltips**

In `apps/mail/tests/mail-sidebar-unread-contract.test.ts`:
Verify:
1. Drafts navigation item renders count badge when `draftsCount > 0`.
2. Badge wrapper includes `title` or tooltip showing formatted count string.

- [x] **Step 2: Run test to verify failure**

Run: `pnpm --filter mail test tests/mail-sidebar-unread-contract.test.ts --run`
Expected: FAIL.

- [x] **Step 3: Wire Drafts badge and tooltips in navigation components**

In `apps/mail/components/ui/nav-main.tsx`:
- Render badge on Drafts row using `counts.getCount('drafts')`.
- Wrap badge pill with `Tooltip`:
  ```tsx
  <Tooltip>
    <TooltipTrigger asChild>
      <span className="...">{count}</span>
    </TooltipTrigger>
    <TooltipContent side="right">
      {counts.getTooltip(item.title, item.title)}
    </TooltipContent>
  </Tooltip>
  ```
- In `sidebar-labels.tsx` and `recursive-folder.tsx`:
  - Add `Tooltip` on folder badges showing `counts.getTooltip(folder.id, folder.name)`.

- [x] **Step 4: Run test to verify pass**

Run: `pnpm --filter mail test tests/mail-sidebar-unread-contract.test.ts --run`
Expected: PASS.

- [x] **Step 5: Commit navigation UI updates**

```bash
git add apps/mail/components/ui/nav-main.tsx apps/mail/components/ui/sidebar-labels.tsx apps/mail/components/ui/recursive-folder.tsx apps/mail/tests/mail-sidebar-unread-contract.test.ts
git commit -m "feat(mail): wire draft badge and rich tooltips into sidebar navigation"
```

---

### Task 5: Folder Context Menu ("Mark All as Read")

**Files:**
- Modify: `apps/mail/components/context/label-sidebar-context.tsx`
- Modify: `apps/mail/components/ui/nav-main.tsx`
- Test: `apps/mail/tests/sidebar-labels.test.ts`

- [x] **Step 1: Write test for folder context menu actions**

In `apps/mail/tests/sidebar-labels.test.ts`:
Verify context menu includes "Mark all as read" trigger and executes the mutation.

- [x] **Step 2: Run test to verify failure**

Run: `pnpm --filter mail test tests/sidebar-labels.test.ts --run`
Expected: FAIL.

- [x] **Step 3: Implement Context Menu in `nav-main.tsx` and extend `label-sidebar-context.tsx`**

- In `label-sidebar-context.tsx`:
  - Add `ContextMenuItem` for "Mark all as read" calling `trpc.mail.markFolderAsRead.mutate({ labelId })`.
  - On success: invalidate `trpc.mail.unreadCounts` and refetch active thread queries.
- In `nav-main.tsx`:
  - Wrap system folder buttons and category buttons with `ContextMenu`.
  - Context menu items:
    - "Mark all as read" (calls `trpc.mail.markFolderAsRead.mutate({ folder: item.title.toLowerCase() })`).

- [x] **Step 4: Run test to verify pass**

Run: `pnpm --filter mail test tests/sidebar-labels.test.ts --run`
Expected: PASS.

- [x] **Step 5: Commit context menu**

```bash
git add apps/mail/components/context/label-sidebar-context.tsx apps/mail/components/ui/nav-main.tsx apps/mail/tests/sidebar-labels.test.ts
git commit -m "feat(mail): add right-click mark all as read context menu on folders"
```

---

### Task 6: Search Result Aggregate Count Badge in `MailSearchBar`

**Files:**
- Modify: `apps/mail/components/mail/mail-search-bar.tsx`
- Modify: `apps/mail/components/mail/mail-list.tsx`
- Test: `apps/mail/tests/mail-search-bar.test.tsx`

- [x] **Step 1: Write test for search result count badge**

In `apps/mail/tests/mail-search-bar.test.tsx`:
Verify:
1. When search has active query and results exist, renders result counter pill (e.g. `"14 results"`).
2. When search query is empty, result counter pill is not rendered.
3. Accessible `aria-label="14 search results found"`.

- [x] **Step 2: Run test to verify failure**

Run: `pnpm --filter mail test tests/mail-search-bar.test.tsx --run`
Expected: FAIL.

- [x] **Step 3: Implement search result counter pill**

In `apps/mail/components/mail/mail-search-bar.tsx`:
- Accept optional `resultCount?: number` or read from a shared search result atom.
- When `activeSearch` is present and `resultCount !== undefined`, render:
  ```tsx
  <Badge
    variant="secondary"
    className="h-5 px-1.5 text-[11px] font-normal text-muted-foreground shrink-0"
    aria-label={`${resultCount} results found`}
  >
    {resultCount} {resultCount === 1 ? 'result' : 'results'}
  </Badge>
  ```
- In `apps/mail/components/mail/mail-list.tsx` / `mail.tsx`: pass `filteredItems.length` into `MailSearchBar`.

- [x] **Step 4: Run test to verify pass**

Run: `pnpm --filter mail test tests/mail-search-bar.test.tsx --run`
Expected: PASS.

- [x] **Step 5: Commit search result count badge**

```bash
git add apps/mail/components/mail/mail-search-bar.tsx apps/mail/components/mail/mail-list.tsx apps/mail/tests/mail-search-bar.test.tsx
git commit -m "feat(mail): add aggregate search result count badge to mail search bar"
```

---

### Task 7: Draft Lifecycle Invalidation & Full End-to-End Verification

**Files:**
- Modify: `apps/mail/hooks/use-compose-editor.ts` or `apps/mail/hooks/use-optimistic-actions.ts`
- Test: `apps/mail/tests/unread-count-invalidation.test.ts`

- [x] **Step 1: Add test asserting draft mutations invalidate `unreadCounts`**

In `apps/mail/tests/unread-count-invalidation.test.ts`:
Verify saving, discarding, or sending a draft triggers `queryClient.invalidateQueries({ queryKey: trpc.mail.unreadCounts.queryKey() })`.

- [x] **Step 2: Run test to verify failure**

Run: `pnpm --filter mail test tests/unread-count-invalidation.test.ts --run`
Expected: FAIL.

- [x] **Step 3: Wire draft invalidation**

In `use-compose-editor.ts` / draft mutation handlers:
Ensure draft save, delete, and send calls invalidate `trpc.mail.unreadCounts.queryKey()`.

- [x] **Step 4: Run test to verify pass**

Run: `pnpm --filter mail test tests/unread-count-invalidation.test.ts --run`
Expected: PASS.

- [x] **Step 5: Run full verification suite**

1. Server tests:
   `CONFIRM_DISPOSABLE_TEST_DB=1 TEST_DATABASE_URL=postgres://zero:zero@127.0.0.1:5433/zero_test pnpm --filter server-pilot test tests/mail-unread-counts.test.ts --run`
2. Mail tests:
   `pnpm --filter mail test tests/sidebar-unread-counts.test.ts tests/sidebar-labels.test.ts tests/mail-sidebar-unread-contract.test.ts tests/unread-count-invalidation.test.ts tests/mail-search-bar.test.tsx --run`
3. Pre-commit OxLint check on staged files.

- [x] **Step 6: Commit draft invalidation & plan mark complete**

```bash
git add apps/mail/hooks/use-compose-editor.ts apps/mail/tests/unread-count-invalidation.test.ts docs/superpowers/plans/2026-09-04-advanced-folder-counts-and-search.md
git commit -m "feat(mail): invalidate folder counts on draft mutations and complete plan"
```
