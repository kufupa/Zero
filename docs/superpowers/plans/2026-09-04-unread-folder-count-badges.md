---
title: "feat: unread folder count badges"
date: 2026-09-04
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
plan_depth: standard
execution: code
---

# Unread Folder Count Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Use superpowers:test-driven-development for each implementation unit and keep the task ledger outside the product diff.

**Goal:** Show the number of unread mail threads beside each supported Inbox, workflow Folder, and My folder entry so a Nava user can see pending mail without opening every folder.

**Architecture:** Add one mailbox-scoped `mail.unreadCounts` read procedure that computes direct-folder unread thread counts from the existing `mail_thread`, category, and label state. A React Query hook will poll that contract and invalidate it after read/move/label/sync actions; the sidebar will resolve counts by stable system/category/label IDs while legacy providers keep their existing `Do_State` fallback. Existing sidebar badges and magicui Folder count rendering are reused, with recursive children receiving their own count and synthetic parent groups deliberately remaining uncounted.

**Tech Stack:** TypeScript, tRPC, Drizzle/PostgreSQL, React, TanStack Query, Vitest, existing shadcn `Badge` and magicui `Folder` components.

## Global Constraints

- The badge means **unread threads directly in the selected folder**, not a total-item count and not a recursive sum of child folders. Nava’s visible list and `filters.unread` are thread-based, so use `mail_thread.is_read = false` as the source of truth. This is intentionally a thread-row count, whereas Outlook/Microsoft Graph’s `unreadItemCount` counts heterogeneous message/calendar/contact items; document that difference in the UI/API contract rather than implying exact parity with Outlook’s item total.
- Keep system-folder predicates aligned with `mail.listThreads`: active `transportId`, spam/trash exclusivity, archive/snooze/inbound/outbound rules, category relation, and user-label membership all remain authoritative.
- Scope every server query through `mailboxProcedure` and `ctx.activeTransportId`; never accept a client-supplied transport ID for counts.
- Do not add a counter table, trigger, cache service, or denormalized unread column in v1. Measure the aggregate query first; add a focused index only if an observed plan/latency regression proves it necessary.
- Supported unread badges are Inbox, Sent, Archive, Snoozed, Bin, Spam, live workflow categories, and My folders. Drafts do not receive an unread badge because draft rows have no read-state contract. No total-count or hover-details UX is part of this change.
- Pilot (`providerId === 'mailbox'`) uses the new count procedure. Demo and non-pilot providers retain the existing `Do_State`/driver behavior; a pilot query error must not blank or block the mail sidebar.
- Render a badge/count only when it is greater than zero. Reuse existing muted badge tokens; do not introduce a new color system or notification sound.
- Synthetic slash-name parents such as `group-projects` and `group-other` have no folder membership and therefore show no aggregate count in the pilot. Their real child labels show their own direct counts; legacy Google/Microsoft/demo name-based stats keep their existing behavior.
- Count changes must become visible after arrival/sync, mark read/unread, archive/unarchive, snooze/unsnooze, spam/bin moves, label filing/removal, and mailbox switching.
- Preserve the existing My folders default-open/collapse affordance and the distinction between AI **Folders** (`categoryIds`) and user **My folders** (`mailLabel`/`labelIds`).
- Never run Vitest with a pilot/production `DATABASE_URL` or `VITEST_ALLOW_PILOT_RDS`; server tests require `TEST_DATABASE_URL` plus `CONFIRM_DISPOSABLE_TEST_DB=1` and a disposable database.
- Use targeted package commands only; do not run project-wide `pnpm check`, `pnpm lint`, or formatting commands.

## Problem Frame and Product Contract

The client is asking for the Outlook-style signal that answers “how many emails are not read?” after Nava added Inbox, workflow folders, and user folders. Without a count in the navigation tree, users must open each folder to discover pending work.

Outlook calls this a folder/navigation-pane item count. Desktop Outlook normally shows an unread count beside most folders; total items are a separate per-folder mode/detail. Microsoft Graph exposes `unreadItemCount` and `totalItemCount` for the current folder, and Microsoft’s support/Q&A material describes counts as direct-folder contents rather than child-folder aggregation. Nava will intentionally use the unread mode only and will count thread rows, which matches Nava’s UI semantics even though Graph counts heterogeneous Outlook items.

### Settled behavior

| Visible entry | Count predicate | Badge in v1 |
| --- | --- | --- |
| Inbox | unread thread, not archived/spam/bin, not currently snoozed, has inbound message | Yes |
| Sent | unread thread with an outbound message, not spam/bin | Yes |
| Archive | unread archived thread, not spam/bin | Yes |
| Snoozed | unread thread with a non-expired snooze, not spam/bin | Yes |
| Bin | unread trashed thread with spam cleared | Yes |
| Spam | unread spam thread with trash cleared | Yes |
| Live workflow Folder | unread Inbox thread linked to that active category ID | Yes |
| My folder child (normal label) | unread archived thread containing that user-label ID, with spam/trash cleared | Yes |
| My folder child (`Quarantine`) | unread spam thread containing that user-label ID, with trash cleared | Yes |
| My folder synthetic slash parent | no direct label membership | No aggregate |
| Drafts | draft rows do not expose read state | No |

The API returns zero rows/counts for empty supported targets so a previously non-zero badge is cleared. It does not return totals, descendants, search-result counts, Focused/Other view counts, or mobile app-icon counts.

`Quarantine` is a reserved spam-scoped My folder in the existing route contract: identify it by the active label ID (case-insensitive name match to `Quarantine`), count it with Spam predicates plus that label ID, and exclude it from normal Archive label counts. Other labels use Archive predicates plus their ID. A label rename is therefore a deliberate semantic change: the same ID follows the current name and is re-evaluated on the next query; an existing spam thread can leave the badge rather than appear in Archive until its folder state also matches the renamed label’s predicate.

## Requirements Traceability

| ID | Requirement | Planned proof |
| --- | --- | --- |
| R1 | Users can see unread counts beside Inbox and supported folder rows. | `mail.unreadCounts` contract plus sidebar rendering tests show positive counts and hide zeroes. |
| R2 | Counts are direct-folder unread counts, not totals or child sums. | Server fixtures include unread children, archived/labelled rows, and synthetic UI parents; expected parent remains zero. |
| R3 | Workflow categories and My folders use stable IDs rather than display-name matching. | API returns opaque category/label IDs; mapping tests cover renamed labels and duplicate-looking names. |
| R4 | Counts track read/unread and folder transitions. | Disposable-DB route tests mutate `isRead`, archive, snooze, spam, trash, categories, and labels, then assert changed counts. |
| R5 | Active-mailbox isolation is preserved. | Route test seeds a second transport with matching IDs and asserts it is excluded. |
| R6 | Existing providers and demo remain compatible. | Legacy `Do_State` mapping tests remain green; pilot query is enabled only for `providerId === 'mailbox'`. |
| R7 | Counts recover from sync/mutation/cache events without a new state system. | Hook polling/focus/reconnect options and mutation invalidation tests/source contracts cover refresh paths. |
| R8 | UI remains quiet and accessible. | Positive-only rendering, existing `Badge`/`Folder` tokens, stable labels, and manual light/dark/sidebar checks are documented. |
| R9 | The implementation is safe to operate and test. | Targeted Vitest commands use disposable DB guards; no pilot-RDS execution or denormalized write path is introduced. |

## External Research and Repository Evidence

### Outlook research

- Microsoft Support, “Display the total number of messages in a folder in Outlook” (unread is the normal navigation mode; total is a separate mode/detail): <https://support.microsoft.com/en-us/outlook/mail/display-the-total-number-of-messages-in-a-folder-in-outlook>
- Outlook VBA `OlShowItemCount` enum (no count, unread count, total count): <https://learn.microsoft.com/en-us/office/vba/api/outlook.olshowitemcount>
- Microsoft Graph `mailFolder` resource (`unreadItemCount`, `totalItemCount`, `childFolderCount`): <https://learn.microsoft.com/en-us/graph/api/resources/mailfolder?view=graph-rest-1.0>
- Microsoft Graph message organization guidance: <https://learn.microsoft.com/en-us/graph/outlook-organize-messages>
- Microsoft Q&A direct-folder caveat for collapsed parents: <https://learn.microsoft.com/en-us/answers/questions/4749451/i-have-created-folders-in-my-outlook-inbox-with-su> and <https://learn.microsoft.com/en-us/answers/questions/4526058/collapsed-parent-folder-notifications-for-subfolde>
- Outlook read/unread transitions: <https://support.microsoft.com/en-us/outlook/mark-a-message-as-read-or-unread-in-outlook>
- Outlook change notifications/delta background (used as freshness precedent, not a Nava dependency): <https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview>

### Local patterns to preserve

- `apps/server-pilot/src/trpc/routes/mail.ts` already defines folder predicates, unread filtering, mailbox scoping, and `markAsRead`/`markAsUnread`.
- `apps/server-pilot/src/db/schema/mail.ts` stores thread read/archive/spam/trash/snooze state, category links, and JSONB user-label IDs; existing transport/list indexes are the v1 starting point.
- `apps/mail/components/ui/nav-main.tsx` renders `Badge` and the My folders section; `apps/mail/components/ui/app-sidebar.tsx` currently mutates Inbox/Sent badges by array index and must move to stable-key resolution.
- `apps/mail/components/ui/sidebar-labels.tsx` maps legacy stats by label name; `apps/mail/components/ui/recursive-folder.tsx` currently passes the parent count to every child and must resolve child counts independently.
- `apps/mail/hooks/use-stats.ts` and `apps/mail/components/mail/use-do-state.ts` are legacy state and must remain available to non-pilot/demo paths.
- `apps/mail/config/navigation.ts`, `apps/mail/hooks/use-categories.ts`, `apps/mail/hooks/use-labels.ts`, and `apps/mail/lib/mail/my-folders-sidebar-tree.ts` define the stable system slugs, live category slug→opaque-ID mapping, user-label IDs, and synthetic parent groups.
- `docs/solutions/architecture-patterns/my-folders-label-archive-filing.md` and `docs/solutions/architecture-patterns/folder-first-spam-at-folder-matrix.md` freeze My folders/category separation and spam/bin/archive predicates.
- `docs/solutions/integration-issues/fe-pilot-trpc-wire-contract-drift.md` requires contract tests to mirror the actual frontend tRPC wire shape.

## Architecture and Data Flow

```text
ingest / read / move / label / sync
              │ updates existing mail_thread state
              ▼
mail.unreadCounts (mailboxProcedure, activeTransportId)
              │ arrays keyed by folder slug, category ID, label ID
              ▼
useUnreadCounts (React Query polling + mutation invalidation)
       ┌──────┴─────────┐
       ▼                ▼
NavMain / NavItem   SidebarLabels / RecursiveFolder
       │                │
       └────── Badge / Folder count (> 0 only)
```

The server count loader should share the existing folder predicate builder with `mail.listThreads`, or extract that builder before adding the route. System counts can be one conditional aggregate query; category and label counts should be grouped queries, avoiding one query per user folder. The loader fills missing grouped keys with zero and returns only active categories/visible user labels for the active transport. “Visible” follows `labels.list`: transport-scoped `mailLabel` rows except case-insensitive `SPAM`; there is no `isVisible`/`type` column to consult.

### API contract

Add a query under the existing `mail` router:

```ts
type MailUnreadFolderId = 'inbox' | 'sent' | 'archive' | 'snoozed' | 'bin' | 'spam';

type MailUnreadCounts = {
  folders: Array<{ id: MailUnreadFolderId; unreadCount: number }>;
  categories: Array<{ categoryId: string; unreadCount: number }>;
  labels: Array<{ labelId: string; unreadCount: number }>;
};

// mailbox-scoped; no input and no caller-selected transport
mail.unreadCounts(): Promise<MailUnreadCounts>;
```

All returned numbers are non-negative JavaScript integers. PostgreSQL `count(*)`/`count(DISTINCT ...)` values must be explicitly cast to `int` in SQL or normalized with `Number(value ?? 0)` before the tRPC result is built; never leak a driver bigint/string into the wire contract. `folders` always contains the six supported system IDs in the fixed order shown in `MailUnreadFolderId`; `categories` and `labels` are deterministic (sort by opaque ID after filtering) so contract snapshots cannot depend on database insertion order. `categories` contains active `mailCategory` rows for the active transport; `labels` contains visible `mailLabel` rows (exclude case-insensitive `SPAM`) for the active transport. The route must not return message subjects, thread/message IDs, addresses, or any cross-mailbox data.

### Count query semantics

1. Clear expired snoozes with the same lazy-clear behavior used by `listThreads`, then evaluate counts against the resulting state.
2. Apply `transport_id = ctx.activeTransportId` and `is_read = false` to every count.
3. Reuse the existing non-bin/non-spam base predicates and folder-specific rules from `listThreads`; bin clears spam, spam clears trash, and Inbox requires an inbound message. Preserve the route-filter special case for `Quarantine`: its label group uses Spam + non-trash, while every other user-label group uses Archive + non-spam + non-trash.
4. Count a category only when the unread thread satisfies Inbox predicates and has a matching `mail_thread_category` row for that active category.
5. Count a normal user label only when the unread thread satisfies Archive predicates and its `label_ids` JSONB array contains that label ID. Count the reserved `Quarantine` label with Spam predicates instead. Expand `jsonb_array_elements_text(mail_thread.label_ids)` (or the equivalent parameterized Drizzle expression), de-duplicate `(thread_id, label_id)` before grouping, and group by label ID so one thread increments each label it directly contains even if malformed JSON repeats an ID.
6. Do not count descendant labels for synthetic slash parents, and do not count a thread once per message; the row is one `mail_thread`.

## File Map

| Responsibility | Files |
| --- | --- |
| Shared folder predicates | Create `apps/server-pilot/src/mail/folder-semantics.ts`; preserve the existing `MAIL_FOLDER_VALUES` export from `apps/server-pilot/src/trpc/routes/mail.ts` as a re-export so current callers do not change. |
| Count loader | Create `apps/server-pilot/src/mail/folder-unread-counts.ts` and consume the shared semantics module. |
| Pilot tRPC procedure | Modify `apps/server-pilot/src/trpc/routes/mail.ts` |
| Server route/DB contract tests | Create `apps/server-pilot/tests/mail-unread-counts.test.ts`; modify `apps/server-pilot/tests/pilot-route-surface.test.ts`; reuse `apps/server-pilot/tests/helpers/seed-inbox-thread.ts` and `tests/helpers/test-db.ts` |
| Frontend query/mapping | Create `apps/mail/hooks/use-unread-counts.ts`, `apps/mail/lib/mail/sidebar-unread-counts.ts` |
| Navigation badge wiring | Modify `apps/mail/components/ui/nav-main.tsx`, `apps/mail/components/ui/app-sidebar.tsx` |
| My folder badge wiring | Modify `apps/mail/components/ui/sidebar-labels.tsx`, `apps/mail/components/ui/recursive-folder.tsx` |
| Frontend contract tests | Create `apps/mail/tests/sidebar-unread-counts.test.ts`; extend `apps/mail/tests/sidebar-labels.test.ts`; add/update a focused nav source/render contract test near `apps/mail/tests/mail-sidebar-section-disclosures.test.ts` |
| Optional schema/index work | No migration in v1; add only after an EXPLAIN/latency proof and then create the generated Drizzle migration under `apps/server-pilot/drizzle/`. |

## Review Gate Results

The required paired `gstack-plan-eng-review` and `ponytail-review`, plus conditional design and DevEx reviews, were checked against this source plan. The repository does not contain the expected executable assets, so criterion-based reviewer passes are recorded below rather than silently skipped. Any findings that changed the contract, file map, or task sequence were incorporated before marking this artifact final.

## Implementation Units (TDD)

### Task 1: Define and expose the pilot unread-count contract

**Files:**

- Create: `apps/server-pilot/src/mail/folder-semantics.ts`
- Create: `apps/server-pilot/src/mail/folder-unread-counts.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Create: `apps/server-pilot/tests/mail-unread-counts.test.ts`
- Modify: `apps/server-pilot/tests/pilot-route-surface.test.ts`
- Reuse: `apps/server-pilot/tests/helpers/seed-inbox-thread.ts`, `apps/server-pilot/tests/helpers/test-db.ts`, `apps/server-pilot/tests/helpers/trpc-caller.ts`

**Interfaces:**

- `MAIL_FOLDER_VALUES` and `MailFolderValue` move to `apps/server-pilot/src/mail/folder-semantics.ts`; `mail.ts` re-exports `MAIL_FOLDER_VALUES` to preserve its existing import surface.
- `clearExpiredSnoozes(db: DB, transportId: string): Promise<void>` — the single lazy-expiry mutation used by both list and count routes.
- `buildMailFolderConditions(db: DB, transportId: string, folder: MailFolderValue): SQL[]` — produces the shared base/folder predicates used by `mail.listThreads` and the count loader; list-only search/unread/category/label predicates remain layered by the caller.
- `loadUnreadCounts(db: DB, transportId: string): Promise<MailUnreadCounts>` — returns the exact API payload described above.
- `mail.unreadCounts()` — a no-input `mailboxProcedure` query that calls `loadUnreadCounts(getDb(), ctx.activeTransportId)`.

- [ ] **Step 1: Write the failing disposable-DB route tests.** In `mail-unread-counts.test.ts`, use `describe.skipIf(!TEST_DB_AVAILABLE || !reachable)` and `withSeededTestDb`. Seed at least: two unread and one read Inbox threads; one outbound-only thread; archived unread/read threads; active/expired snoozes; one spam and one bin thread; two active categories linked to one unread Inbox thread; two user labels with archived unread threads; a `Quarantine` label with a spam thread; a case-variant/renamed label fixture; and a second transport with matching unread rows. Use opaque category/label IDs (not UUID-shaped assumptions). Assert the expected six `folders` IDs/counts, category/label ID counts, zero entries, numeric output (`typeof unreadCount === 'number'`), and transport isolation. Assert a category thread is counted once even when linked to two categories and a label thread increments each directly attached label once. Assert `Quarantine` is counted under its label and Spam, never Archive; renaming the same label changes its predicate on the next query; synthetic `group-*` IDs are not returned.

  Also assert transition behavior by calling `mail.markAsRead({ ids })`, `mail.markAsUnread({ ids })`, `mail.moveThreads({ threadIds: [id], destination: 'archive' })`, `mail.moveThreads({ threadIds: [id], destination: 'bin' })`, `mail.moveThreads({ threadIds: [id], destination: 'spam' })`, `mail.fileThreads(...)`, `mail.modifyLabels(...)`, and `categories.setThreadCategories(...)`, then re-querying counts. Include explicit spam→bin and spam→archive assertions so a thread cannot be counted in both folders; use `moveThreads` for those spam exits because `bulkArchive` preserves `spamAt` and can leave an invisible/orphaned spam state. Use `seedInboxThread` for Inbox fixtures so the inbound-message requirement is honored.

- [ ] **Step 2: Run the server test RED with a disposable DB only.**

  ```bash
  cd apps/server-pilot
  if [ -z "$TEST_DATABASE_URL" ]; then echo 'TEST_DATABASE_URL is required'; exit 1; fi
  env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS \
    TEST_DATABASE_URL="$TEST_DATABASE_URL" CONFIRM_DISPOSABLE_TEST_DB=1 \
    pnpm exec vitest run tests/mail-unread-counts.test.ts --reporter=dot
  ```

  Expected: FAIL because `mail.unreadCounts` and the loader do not exist. Keep the existing `describe.skipIf` guard for an unreachable disposable database; never substitute a pilot URL.

- [ ] **Step 3: Implement the minimal server loader and route.** Move `MAIL_FOLDER_VALUES`, the lazy snooze expiry update, and the existing base/folder condition assembly into `folder-semantics.ts`; re-export the constant from `mail.ts` and make `listThreads` call the shared helper so list and count cannot drift. Add the typed output and grouped SQL described in the API section. The system aggregate must include the six fixed IDs; category and label queries must be transport-scoped, active/visible filtered, and default missing keys to zero. Add the route to the existing `mailRouter`; do not create a second top-level router or a counter table.

  The loader’s directional query shape is:

  ```sql
  -- one row, one count per supported system folder
  SELECT
    count(*) FILTER (WHERE <inbox predicate>)   AS inbox,
    count(*) FILTER (WHERE <sent predicate>)    AS sent,
    count(*) FILTER (WHERE <archive predicate>) AS archive,
    count(*) FILTER (WHERE <snoozed predicate>) AS snoozed,
    count(*) FILTER (WHERE <bin predicate>)     AS bin,
    count(*) FILTER (WHERE <spam predicate>)    AS spam
  FROM mail_thread
  WHERE transport_id = $transportId AND is_read = false;
  ```

  Category and label grouped queries must use `count(DISTINCT mail_thread.id)`/one row per thread relation and retain the same Inbox/Archive predicates respectively (with the `Quarantine` Spam exception). Use parameterized Drizzle expressions; do not interpolate caller strings into SQL. The route test must assert `typeof unreadCount === 'number'` for every system/category/label result.

- [ ] **Step 4: Run the server tests GREEN and the route-surface type check.** Update `pilot-route-surface.test.ts` to assert that `unreadCounts` is a key of the nested mail router (not merely that the top-level `mail` router exists):

  ```ts
  type MailRouterKeys = keyof AppRouter['_def']['record']['mail']['_def']['record'];
  const expectedMail = ['listThreads', 'unreadCounts'] satisfies MailRouterKeys[];
  expect(expectedMail).toContain('unreadCounts');
  ```

  Then run:

  ```bash
  cd apps/server-pilot
  if [ -z "$TEST_DATABASE_URL" ]; then echo 'TEST_DATABASE_URL is required'; exit 1; fi
  env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS \
    TEST_DATABASE_URL="$TEST_DATABASE_URL" CONFIRM_DISPOSABLE_TEST_DB=1 \
    pnpm exec vitest run tests/mail-unread-counts.test.ts --reporter=dot
  cd ../mail
  unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
  pnpm exec vitest run tests/pilot-route-surface.test.ts --reporter=dot
  ```

  Expected: all selected tests pass; TypeScript sees `trpc.mail.unreadCounts` through `AppRouter`.

- [ ] **Step 5: Review the server diff for query, auth, and performance safety.** Confirm every loader query includes the active transport, no client input controls scope, category/label joins cannot multiply counts, JSONB label expansion is de-duplicated, Quarantine uses Spam predicates, and no pilot-RDS test command was used. On a disposable/staging fixture with at least 100,000 threads for the active transport (20,000 unread), 100 active categories, 1,000 visible labels, and a similarly sized second transport, warm the database, run 30 loader invocations, and record p50/p95 plus `EXPLAIN (ANALYZE, BUFFERS)` for each of the system/category/label queries. The rollout gate is p95 ≤ 250 ms for the complete loader and no sequential scan that grows with unrelated transports. If the gate fails, use the explain output to choose a focused partial/JSONB index or query rewrite, add a generated Drizzle migration, and rerun the gate; do not ship a denormalized counter table as a workaround. Only then proceed to frontend wiring.

### Task 2: Add the frontend count query and stable-key mapping

**Files:**

- Create: `apps/mail/hooks/use-unread-counts.ts`
- Create: `apps/mail/lib/mail/sidebar-unread-counts.ts`
- Create: `apps/mail/tests/sidebar-unread-counts.test.ts`

**Interfaces:**

- `useUnreadCounts(): { data: SidebarUnreadCountSnapshot | undefined; isLoading: boolean; isError: boolean }` — calls `trpc.mail.unreadCounts` only for live pilot mailboxes and retains legacy stats for other providers/demo.
- `PilotUnreadCounts` is inferred from the generated tRPC wire output (`Outputs['mail']['unreadCounts']` from `apps/server-pilot/src/trpc/index.ts`, or the existing `TrpcHook['mail']['unreadCounts']['~types']['output']` pattern in `apps/mail/providers/query-provider.tsx`); do not duplicate the server payload interface in a hand-maintained frontend type.
- `SidebarUnreadCountSnapshot` contains `folders: Record<MailUnreadFolderId, number>`, `categories: Record<string, number>`, `labels: Record<string, number>`, `legacy: readonly { label: string; count: number }[]`, `source: 'pilot' | 'legacy' | 'none'`, and the active transport `scopeKey` (or `null` for legacy/demo). A retained snapshot is eligible only when its `scopeKey` matches the current connection; account switching must never display the previous mailbox’s snapshot.
- Pure mapping exports in `sidebar-unread-counts.ts`: `toSidebarUnreadCountSnapshot(payload, legacyStats, providerId)`; `getNavUnreadCount(snapshot, itemId, categoryIdForSlug?)`; `getLabelUnreadCount(snapshot, labelId, labelName?)`. They return `number | undefined`, with `undefined` meaning “no badge contract” and `0` meaning “known empty.” `getNavUnreadCount` must map the existing navigation ID `trash` to the API folder ID `bin`; never make the API adopt the display/navigation typo just to preserve that UI ID.

- [ ] **Step 1: Write mapping and query-option tests.** Assert pilot system/category/label opaque IDs are resolved without lowercasing or display-name matching; `trash` resolves to API `bin`; zero is returned for known empty targets; drafts and pilot synthetic group IDs return `undefined`; a label rename still resolves by ID; legacy Google/Microsoft/demo stats still resolve case-insensitively by label name. Assert the query is disabled for demo/non-mailbox providers and configured with `refetchOnWindowFocus`, reconnect, and the exact `resolveThreadPollingMs` result while preserving the last successful data on a transient error only within the same `scopeKey`; changing scope clears the old snapshot.

- [ ] **Step 2: Run the frontend tests RED.**

  ```bash
  cd apps/mail
  unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
  pnpm exec vitest run tests/sidebar-unread-counts.test.ts --reporter=dot
  ```

  Expected: FAIL because the hook and pure mapping module do not exist.

- [ ] **Step 3: Implement the hook and pure mapping.** Use `useActiveConnection`, `isFrontendOnlyDemo`, `useStats`, `useTRPC`, and TanStack Query. Enable the pilot query only when `!demoMode && activeConnection?.providerId === 'mailbox'`; call `resolveThreadPollingMs(import.meta.env.VITE_MAIL_POLL_MS)` exactly as `useThreads` does (`undefined` → 15 seconds; invalid or under 15 seconds → `null`/`refetchInterval: false`; valid values are preserved), with `refetchOnWindowFocus: true`, `refetchOnReconnect: true`, `refetchIntervalInBackground: false`, and no background error toast. Convert the array payload to ID-keyed records and retain the last successful snapshot while React Query reports an error. Preserve legacy `Do_State` data for all other providers.

- [ ] **Step 4: Run the mapping/query tests GREEN.** Re-run the command from Step 2 and expect all provider, opaque-ID, zero/undefined, and polling cases to pass. Then run `pnpm exec tsc --noEmit -p tsconfig.json` from `apps/mail`; do not run a project-wide checker.

### Task 3: Wire stable counts into navigation and My folders

**Files:**

- Modify: `apps/mail/components/ui/nav-main.tsx`
- Modify: `apps/mail/components/ui/app-sidebar.tsx`
- Modify: `apps/mail/components/ui/sidebar-labels.tsx`
- Modify: `apps/mail/components/ui/recursive-folder.tsx`
- Modify or create: `apps/mail/tests/mail-sidebar-unread-contract.test.ts`
- Modify: `apps/mail/tests/sidebar-labels.test.ts`
- Preserve: `apps/mail/tests/my-folders-default-open.test.ts`, `apps/mail/tests/mail-sidebar-section-disclosures.test.ts`

**Interfaces:**

- `AppSidebar` calls `useUnreadCounts` exactly once and passes the snapshot to both `NavMain` instances; the main `NavMain` passes it to `SidebarLabels`. Each `NavMain` resolves an item’s `badge` by stable system ID or live category slug→opaque-ID mapping; `NavItem` renders `item.badge` only when `> 0`.
- `SidebarLabels` resolves a root/child count by user-label ID and passes a `getCount(label)` callback into `RecursiveFolder`.
- `RecursiveFolder` keeps its `count` prop for the rendered node but computes each child’s count with `getCount(childLabel)` instead of reusing the parent count; pilot synthetic `group-*` nodes resolve to zero.

- [ ] **Step 1: Add failing UI contract tests.** Extend the existing sidebar label test to pass different root/child counts and assert the recursive child callback returns the child ID count, not the root count. Add navigation contract coverage for Inbox/Sent/system IDs, `trash`→`bin`, a live category slug mapping to its category ID, a pilot user-label ID, hidden zero badges, legacy stats fallback, stable values when `stats` array ordering changes, and absent Drafts/pilot synthetic-group badges. Assert the My folders default-open and section-disclosure source contracts remain present, and assert `useUnreadCounts` is called once by `AppSidebar` while both rendered `NavMain` trees receive the same snapshot.

- [ ] **Step 2: Run focused UI tests RED.**

  ```bash
  cd apps/mail
  unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
  pnpm exec vitest run tests/sidebar-labels.test.ts tests/mail-sidebar-unread-contract.test.ts tests/my-folders-default-open.test.ts tests/mail-sidebar-section-disclosures.test.ts --reporter=dot
  ```

  Expected: FAIL because AppSidebar still assigns stats by array index, NavItem still reads only legacy stats, and RecursiveFolder passes the parent count to children.

- [ ] **Step 3: Implement stable-key navigation wiring.** Call `useUnreadCounts` once in `app-sidebar.tsx`, pass its snapshot through both `NavMain` calls, and pass it from the main `NavMain` to `SidebarLabels`; remove `useStats` and the `items[0].items[index]` badge mutations from `app-sidebar.tsx`. In `nav-main.tsx`, derive a copy of each section item with `badge` from `getNavUnreadCount`; map live category `item.id` slugs through `useCategorySettings` to category IDs; leave Drafts and unknown IDs without a badge. Replace the `NavItem` stats lookup with `item.badge !== undefined && item.badge > 0`, keeping the existing `Badge` class and link layout. When the sidebar is icon-collapsed, hide the numeric pill to avoid clipping/occlusion and include the count in the existing tooltip and link `aria-label` (for example, `${item.title}: ${item.badge} unread`); in expanded mode show the positive pill. Apply the same accessible count text to My-folder buttons while keeping synthetic parent counts hidden.

  In `sidebar-labels.tsx`, use the new snapshot and pass `getCount` into every root `RecursiveFolder`. In `recursive-folder.tsx`, accept the callback and pass `getCount(childLabel)` recursively; do not aggregate children into a synthetic parent. Preserve DnD, navigation, context-menu, and My folders collapse behavior.

- [ ] **Step 4: Run focused UI tests GREEN and inspect both themes.**

  ```bash
  cd apps/mail
  unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
  pnpm exec vitest run tests/sidebar-labels.test.ts tests/mail-sidebar-unread-contract.test.ts tests/my-folders-default-open.test.ts tests/mail-sidebar-section-disclosures.test.ts --reporter=dot
  ```

  Expected: all selected tests pass. Manually inspect a pilot mailbox in light and dark themes at expanded and icon-collapsed widths: positive counts align at the right edge, collapsed mode exposes counts through tooltip/accessible text without a clipped pill, zero counts leave no empty pill, category and child ID counts differ correctly, and existing My folders/Folders disclosure and drag affordances remain intact.

### Task 4: Invalidate and verify freshness across mail actions

**Files:**

- Modify: `apps/mail/hooks/use-optimistic-actions.ts`
- Modify: `apps/mail/components/ui/nav-user.tsx`
- Modify: `apps/mail/app/(routes)/settings/connections/page.tsx`
- Modify: `apps/mail/tests/mail-sidebar-unread-contract.test.ts` or create `apps/mail/tests/unread-count-invalidation.test.ts`
- Reuse: `apps/mail/lib/mail/thread-polling-policy.ts` (`resolveThreadPollingMs` is already exported; do not add a second polling policy).

**Interfaces:**

- The existing `refreshData()` helper invalidates/refetches both `trpc.labels.list` and `trpc.mail.unreadCounts` for pilot; legacy paths keep their current label refresh. Any action that can change a count—`markAsRead`, `markAsUnread`, `moveThreads`, `fileThreads`, `modifyLabels`, `categories.setThreadCategories`, snooze/unsnooze, spam/bin operations—must reach that same refresh/invalidation point.
- Force-sync and mailbox-switch handlers invalidate/refetch the count query after the active transport changes or ingest completes.
- The count hook’s polling catches external arrival/read changes even when no local mutation runs.

- [ ] **Step 1: Write failing invalidation/source tests.** Assert `refreshData` includes `trpc.mail.unreadCounts.queryKey()` alongside labels, and that read/unread, move, file, label, category, snooze, spam, and bin actions all call it after their existing optimistic/undo completion. Assert force-sync invalidates the count query with list threads, and mailbox switching cannot reuse a previous transport’s count snapshot. Assert the count hook consumes the exported `resolveThreadPollingMs` contract rather than introducing another interval parser.

- [ ] **Step 2: Run the focused invalidation tests RED.**

  ```bash
  cd apps/mail
  unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
  pnpm exec vitest run tests/unread-count-invalidation.test.ts tests/mail-sidebar-unread-contract.test.ts --reporter=dot
  ```

  Expected: FAIL because current refresh/force-sync paths only refresh labels or thread lists.

- [ ] **Step 3: Implement invalidation without a second state store.** Update `refreshData` to refetch the count query alongside labels after the final pending action; keep existing optimistic/undo ordering and ensure `fileThreads` and `modifyLabels` use that helper too. The current frontend has no `categories.setThreadCategories` caller, so add a focused contract/helper for that mutation before its first caller rather than inventing a parallel state path; server-side category changes remain covered by polling. In `nav-user.tsx`, add count-query removal/invalidation when `handleAccountSwitch` changes transport scope: clear/remove the old no-input tRPC query before enabling the new scope, set the new cache scope, then refetch the list and count queries only after the new transport is active. This prevents a mailbox-A snapshot from rendering while mailbox B loads. Add count invalidation to `handleForceSyncAction` next to list invalidation. In `settings/connections/page.tsx`, include the count key in the existing `invalidateThreads` callback used after disconnect/default-mailbox changes. Do not invalidate on every render; rely on mutation completion, focus/reconnect, and the polling interval.

- [ ] **Step 4: Run freshness tests GREEN.** Re-run the focused command and assert all transitions are covered. Run the server route test and frontend mapping/sidebar suites together using the safe commands from Tasks 1–3.

### Task 5: Completion verification and rollout evidence

**Files:**

- Modify: `docs/superpowers/plans/2026-09-04-unread-folder-count-badges.md` only for implementation evidence/decisions after execution

- [ ] **Step 1: Run the complete targeted verification set.**

  ```bash
  cd apps/server-pilot
  if [ -z "$TEST_DATABASE_URL" ]; then echo 'TEST_DATABASE_URL is required'; exit 1; fi
  env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS \
    TEST_DATABASE_URL="$TEST_DATABASE_URL" CONFIRM_DISPOSABLE_TEST_DB=1 \
    pnpm exec vitest run tests/mail-unread-counts.test.ts tests/mail-category-filter.test.ts --reporter=dot

  cd ../mail
  unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
  pnpm exec vitest run \
    tests/sidebar-unread-counts.test.ts \
    tests/sidebar-labels.test.ts \
    tests/mail-sidebar-unread-contract.test.ts \
    tests/unread-count-invalidation.test.ts \
    tests/my-folders-default-open.test.ts \
    tests/mail-sidebar-section-disclosures.test.ts \
    tests/pilot-route-surface.test.ts --reporter=dot
  git diff --check
  ```

  Expected: all selected suites pass, no pilot-RDS guard is bypassed, and `git diff --check` is clean.

- [ ] **Step 2: Run the live-read-only UI spot check.** In a disposable/staging pilot mailbox, verify an unread Inbox thread increments Inbox and its category; mark it read and confirm both clear; file it into a My folder and confirm it leaves Inbox and appears in that child count; move a spam thread to Bin and confirm it is counted only in Bin; switch mailboxes and confirm counts change with the transport. Check light/dark, expanded/collapsed sidebar, mobile navigation, and a label rename.

- [ ] **Step 3: Record rollout/rollback posture.** Ship the route and UI together behind no new feature flag because the pilot provider gate is already explicit. Rollback is the previous application release; the endpoint is additive and old clients ignore it. Monitor count-query latency/error rate and badge freshness; if the query is slow, first inspect the grouped query plan and add a targeted partial index in a follow-up migration rather than introducing denormalized counters during this change.
- [ ] **Step 4: Record the performance evidence.** Attach the representative-fixture row counts, `EXPLAIN (ANALYZE, BUFFERS)` output, and 30-run p50/p95 measurements to the implementation change. Do not mark the rollout complete until the complete-loader p95 is at or below 250 ms or the plan records the approved focused-index follow-up and an explicit hold/rollback decision.

## Failure, Security, and Performance Behavior

- **Query failure:** keep the last successful pilot snapshot in React Query; if none exists, omit badges and leave the mailbox usable. Do not show a fabricated zero that could falsely claim no unread mail. Log/monitor the query error through existing client/server telemetry without a toast on every poll.
- **Stale data:** polling and focus/reconnect refetch provide eventual freshness for external ingest; local mutations invalidate immediately after their existing optimistic/undo workflow completes. Exact sub-second parity is not promised.
- **Mailbox isolation:** every system/category/label query filters by the active transport; categories and labels are joined/scoped by that transport; no caller-provided IDs are trusted for scope.
- **Count correctness:** use `count(DISTINCT thread.id)` for relation joins; avoid message joins that multiply a thread. Group labels by opaque ID after de-duplicating JSONB-expanded `(thread_id, label_id)` pairs, and filter visible user labels using the existing `labels.list` rule (exclude case-insensitive `SPAM`).
- **Performance:** fixed-size system aggregate plus two grouped queries; no per-label N+1 loop and no full unread-message payload. Validate on the representative 100,000-thread fixture with 30 warm runs, `EXPLAIN (ANALYZE, BUFFERS)`, and a complete-loader p95 gate of ≤250 ms. The plan must show work bounded by the active transport/unread subset rather than unrelated mailboxes. If it misses the gate, inspect the plan and add only the focused partial/JSONB index justified by the evidence in a follow-up migration; the fallback is to hold rollout until the query meets the gate, not to fabricate cached counts.
- **Privacy:** return only folder/category/label identifiers and integer counts; never return subjects, senders, message IDs, or counts from another mailbox.

## Review Disposition

The paired executable review tools (`gstack-plan-eng-review`, `ponytail-review`, and the conditional design/DevEx variants) are not installed in this repository. Their criterion-based passes were therefore performed manually and recorded here; the independent Outlook/repository review findings were reconciled into the contract and task list above.

- **Engineering completeness — PASS.** Active-transport auth boundaries, shared predicates, Quarantine scope, JSONB de-duplication, numeric normalization, transition coverage, failure behavior, measurable EXPLAIN/p95 gates, rollout, and rollback are explicit.
- **Simplicity/YAGNI — PASS.** The design keeps one additive tRPC query, existing polling/invalidation, and existing badge components; it rejects counter tables, event buses, total-count mode, recursive aggregation, push notifications, and new dependencies until measured evidence requires a follow-up.
- **Design/UI — PASS.** Positive-only badges reuse current tokens; collapsed sidebars hide pills but expose counts through tooltip/ARIA text; light/dark and My-folder child/parent semantics are tested; the Outlook thread-vs-item difference is documented.
- **DevEx/API — PASS.** `Outputs['mail']['unreadCounts']`/the existing generated hook type is the single wire type; `trash → bin`, opaque category/label IDs, deterministic ordering, numeric counts, provider fallback, one-hook ownership, and pilot-safe disposable-DB commands are covered by focused tests.
- **Final plan scan — PASS.** The placeholder/open-question/root-path scan is clean, and there are no contradictory `mail.setThreadCategories`/ID type references; `git diff --check` is clean for this artifact. The unrelated untracked plan and host-provided `AGENTS.md` remain untouched.

## Deferred Scope

- Outlook-style total counts, hover/right-click details, per-folder count-mode preferences, and message-item (rather than thread-row) counts.
- Recursive parent aggregation for nested My folders.
- Focused/Other view-specific counts and mobile app-icon badge policy.
- Server push/change notifications; v1 uses existing polling plus local invalidation.
- Denormalized counters or a dedicated unread-count index without a measured query bottleneck.
- Draft total/unread counts until drafts have an explicit count contract.
