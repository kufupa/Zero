---
title: "Advanced folder counts, draft counts, rich tooltips, and search aggregate counts"
date: 2026-09-04
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Advanced folder counts, draft counts, rich tooltips, and search aggregate counts

## Goal Capsule

Expand Zero's mailbox folder counters and search feedback by adding (1) active Draft counts, (2) single-pass total thread count computation alongside unread counts in SQL aggregation, (3) accessible rich folder tooltips (`"X unread of Y threads"` / `"Y threads (all read)"`), (4) right-click "Mark all as read" context actions, and (5) search result aggregate count badges in `MailSearchBar`.

**Stop when:** Drafts navigation badge shows active draft counts; folders display rich tooltips on badge hover; right-clicking folders/categories/labels allows marking all contained threads as read; `MailSearchBar` renders a count badge for active filter matches; and tests pass on a disposable local database.

**Executable TDD plan:** `docs/superpowers/plans/2026-09-04-advanced-folder-counts-and-search.md` (reconciled eng + ponytail + design).

---

## Product Contract

### Requirements

1. **Active Draft Counts** — Navigation item `Drafts` renders a badge showing total active non-sent drafts (`status in ('active', 'candidate')` and `isSent = false`). Hides when 0.
2. **Total Thread Count Computation** — Backend `mail.unreadCounts` returns both `unreadCount` and `totalCount` per folder, category, and user label, computed in a single SQL query pass.
3. **Rich Folder Tooltips** — Hovering folder badges in expanded or collapsed sidebar displays structured counts:
   - When unread > 0: `"{unread} unread of {total} threads"`
   - When unread = 0: `"{total} threads (all read)"`
   - For Drafts: `"{drafts} active draft{s}"`
4. **Folder Context Menu ("Mark All as Read")** — Right-clicking system folders, categories, or custom My Folders reveals a context menu with "Mark all as read", executing server-side bulk update without transferring full thread ID lists to the client.
5. **Search Result Aggregate Count Badge** — When a search query or filter chip is active, `MailSearchBar` renders a pill badge showing the number of matching results (`"{N} results"`), accessible via screen readers.
6. **Mutation & Lifecycle Invalidation** — Draft save, send, discard, and folder mark-as-read mutations invalidate `trpc.mail.unreadCounts.queryKey()` so counts remain fresh.
7. **Out of Scope** — User setting database migration for unread vs total toggle (use local state/atoms); complex folder properties dialogs; denormalized counter tables.

### Acceptance Examples

- User creates 2 drafts: Sidebar displays `Drafts [2]`.
- User hovers Inbox badge showing 3 unread out of 42 threads: Tooltip renders `"3 unread of 42 threads"`.
- User right-clicks "Bookings" category folder and clicks "Mark all as read": All unread threads in Bookings are marked read, and the badge disappears.
- User types "invoice" into search bar with 14 matches: Search bar displays a badge `"14 results"`.
- User clears search bar: Results badge disappears.

---

## Planning Contract

### Key Technical Decisions

| Decision | Choice | Rationale |
| :--- | :--- | :--- |
| **SQL Aggregation Pass** | Single conditional query with `count(*) FILTER (WHERE ...)` | In PostgreSQL, computing both `unreadCount` and `totalCount` in one query incurs zero additional table scans or round trips. |
| **Draft Count Source** | Count rows in `mailDraft` where `status in ('active', 'candidate')` and `isSent = false` | Drafts have no read/unread concept; counting active drafts matches Outlook and Gmail behavior. |
| **Bulk Mark As Read** | Dedicated `markFolderAsRead` tRPC mutation | Avoids transmitting hundreds or thousands of thread IDs across the wire when marking large folders as read. |
| **Search Result Count** | Client-side length from `filteredItems` / active query data | Avoids an extra search-count API round trip; instant feedback as virtualized list renders. |
| **Badge Preference Persistence** | Frontend Jotai atom with `localStorage` fallback | Ponytail simplicity: avoids adding DB schema columns or migration friction. |

### Current Code Map

- Server unread count loader: `apps/server-pilot/src/mail/folder-unread-counts.ts`
- Server mail route: `apps/server-pilot/src/trpc/routes/mail.ts`
- Frontend snapshot & mapping: `apps/mail/lib/mail/sidebar-unread-counts.ts`
- Frontend hook: `apps/mail/hooks/use-unread-counts.ts`
- Sidebar navigation: `apps/mail/components/ui/nav-main.tsx`
- Label context menu: `apps/mail/components/context/label-sidebar-context.tsx`
- Search bar: `apps/mail/components/mail/mail-search-bar.tsx`
- Mail list: `apps/mail/components/mail/mail-list.tsx`

---

## Review Disposition

### Eng Review (`gstack-plan-eng-review`)
- **MUST-FIX Absorbed**: Add server-side `markFolderAsRead` mutation rather than relying on `markAsRead({ ids })` so large folders do not hit URL/payload limit errors.
- **MUST-FIX Absorbed**: Invalidate `mail.unreadCounts` query key on all draft mutations (`saveDraft`, `deleteDraft`, `sendDraft`) in `use-compose-editor.ts`.
- **Performance**: Single-query conditional filtering guarantees constant-time aggregation for system folders.

### Ponytail Review (`ponytail-review`)
- **YAGNI Cut**: No database migrations or new tables for user count preferences.
- **YAGNI Cut**: No multi-field folder properties modals or color configuration sheets.
- **YAGNI Cut**: No separate search count backend endpoint; use list query item count.

### Design Review (`gstack-plan-design-review`)
- **Absorbed**: Drafts badge inherits standard system pill styling (`text-xs bg-muted/60 text-muted-foreground`).
- **Absorbed**: Radix UI tooltips provide accessible count breakdowns on hover.
- **Absorbed**: Search result badge sits next to active filter chips in `MailSearchBar`.

---

## Implementation Units

### U1. Server-Side Counts Expansion & Drafts
**Files:** `apps/server-pilot/src/mail/folder-unread-counts.ts`, `apps/server-pilot/src/trpc/routes/mail.ts`, `apps/server-pilot/tests/mail-unread-counts.test.ts`
**Does:** Computes unread and total thread counts in single SQL pass; adds active draft count; updates `MailUnreadCounts` return type.

### U2. Server-Side `markFolderAsRead` Mutation
**Files:** `apps/server-pilot/src/trpc/routes/mail.ts`, `apps/server-pilot/tests/mail-unread-counts.test.ts`
**Does:** Bulk marks matching threads in folder/category/label as `isRead = true`.

### U3. Frontend Snapshot & Tooltip Helpers
**Files:** `apps/mail/lib/mail/sidebar-unread-counts.ts`, `apps/mail/hooks/use-unread-counts.ts`, `apps/mail/tests/sidebar-unread-counts.test.ts`
**Does:** Extends `FolderCountsSnapshot` with `getTotal()` and `getTooltip()`; maps `'drafts'` to active draft count.

### U4. UI Tooltips & Draft Badges in Sidebar
**Files:** `apps/mail/components/ui/nav-main.tsx`, `apps/mail/components/ui/sidebar-labels.tsx`, `apps/mail/components/ui/recursive-folder.tsx`, `apps/mail/tests/mail-sidebar-unread-contract.test.ts`
**Does:** Displays Drafts badge; wires rich hover tooltips into all folder and label badges.

### U5. Folder Context Menu ("Mark All as Read")
**Files:** `apps/mail/components/context/label-sidebar-context.tsx`, `apps/mail/components/ui/nav-main.tsx`, `apps/mail/tests/sidebar-labels.test.ts`
**Does:** Adds right-click context menu to sidebar folders with "Mark all as read".

### U6. Search Result Aggregate Count in `MailSearchBar`
**Files:** `apps/mail/components/mail/mail-search-bar.tsx`, `apps/mail/components/mail/mail-list.tsx`, `apps/mail/tests/mail-search-bar.test.tsx`
**Does:** Renders `"N results"` counter pill in search bar when filtering.

### U7. Draft Lifecycle Invalidation & Full Verification
**Files:** `apps/mail/hooks/use-compose-editor.ts`, `apps/mail/tests/unread-count-invalidation.test.ts`
**Does:** Invalidates counts on draft mutations; runs full disposable test DB verification suite.
