# Inbox Chronological List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make hotel Inbox a chronological latest-first list (Outlook-like), with category/urgency as row tags only — not section headers or sort keys.

**Architecture:** Remove FE `groupByQueue` mode entirely. Inbox (and other non-search lists) use existing `groupByDate` virtual rows, which preserve API newest-first order inside each date bucket. Category pills and sidebar/Views filters stay unchanged. Server `listThreads` order already correct — no BE change.

**Tech Stack:** React mail app (`apps/mail`), Vitest unit tests, existing `buildMailListVirtualRows` / `mail-list.tsx`.

## Global Constraints

- Pilot-RDS safety: never run Vitest with `DATABASE_URL` pointing at pilot/prod; always `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before tests.
- FE-only change; no `apps/server-pilot` orderBy / triage edits.
- Do not add sort UI, pin UI, or new feature flags for queue mode.
- Delete dead queue-grouping code; do not leave `groupByQueue` behind “just in case.”
- Repo-relative paths only in this plan.
- Supersedes hotel-inbox IA that required segmented `groupByQueue` (see `docs/plans/2026-07-29-001-feat-hotel-revenue-inbox-ia-plan.md` KTD7 / Task 6 in `docs/superpowers/plans/2026-07-29-hotel-revenue-queues-implementation.md`) for **default Inbox presentation only**; sidebar queue folders remain.

## Review disposition

| Gate | Result | Applied |
|---|---|---|
| Eng completeness | approve-with-fixes | Exact test commands; QueueSlug delete fallout; residual starred-date-pin called out |
| Ponytail simplicity | cut more → delete full queue mode | No flag; delete `QueueSlug` / queue-header / compareQueueThreads |
| Design | keep date headers | Outlook-adjacent Today/Yesterday; pills no longer compete with queue sections |
| Subagent dispatch | unavailable (only fast slug allowed) | Reviews run inline; independence not claimed |

### Decisions locked

1. **Date buckets on Inbox** (not flat list). Escape hatch: set Inbox `groupByDate: false` if product rejects headers.
2. **Delete** `groupByQueue` implementation and call sites.
3. **Keep** pre-existing date-mode starred → `pinned` bucket as residual (not in scope). If product later demands absolute latest-only including starred, remove pin in a follow-up.
4. **Keep** category pills + sidebar/Views filters.

---

## File map

| File | Responsibility |
|---|---|
| `apps/mail/lib/mail/build-mail-list-virtual-rows.ts` | Date / flat virtual rows only; remove queue mode |
| `apps/mail/components/mail/mail-list.tsx` | Stop enabling queue grouping; drop queue-header render + related imports/memos |
| `apps/mail/tests/build-mail-list-virtual-rows.test.ts` | Prove chronological-in-bucket; urgent does not reorder; no queue-header API |
| `apps/mail/lib/mail/hotel-folder-presentation.ts` | Unchanged — pills/nav still use `HOTEL_PRIMARY_CATEGORY_SLUGS` |

---

### Task 1: Failing tests for chronological Inbox contract

**Files:**
- Modify: `apps/mail/tests/build-mail-list-virtual-rows.test.ts`
- Modify (implementation in Task 2): `apps/mail/lib/mail/build-mail-list-virtual-rows.ts`

- [x] **Step 1: Rewrite queue-mode tests into chronological contract tests**

Replace the three queue-focused cases (`emits four queue headers…`, `sorts urgent then starred then recency…`, `falls back unknown primary to ops`) with:

1. **Urgent does not reorder within a date bucket** — newer non-urgent before older urgent when `groupByDate: true` and input is newest-first.
2. **No `queue-header` row type produced** — call builder with only `{ groupByDate: true }` / `{ groupByDate: false }`; assert no row has `type === 'queue-header'` (and after Task 2, TypeScript should not allow queue options).
3. **Keep** existing date / pinned / collapse / flat tests that still apply.

Example shape for the urgent ordering test (adjust helpers as needed):

```typescript
it('preserves newest-first within a date bucket; urgent does not jump ahead', () => {
  const now = new Date('2026-04-13T12:00:00.000Z');
  const threads = [
    thread('newer', '2026-04-13T11:00:00.000Z'),
    thread('older-urgent', '2026-04-13T09:00:00.000Z'),
  ];
  const rows = buildMailListVirtualRows(threads, now, new Set(), { groupByDate: true });
  const ids = rows.filter((r) => r.type === 'thread').map((r) => (r.type === 'thread' ? r.message.id : ''));
  expect(ids).toEqual(['newer', 'older-urgent']);
});
```

Remove `QueueSlug` / `QUEUE_ORDER` / `QUEUE_LABELS` / `groupByQueue: true` usage from this file.

- [x] **Step 2: Run tests — expect fail or compile fail until queue API removed / behavior matches**

```bash
cd apps/mail
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run tests/build-mail-list-virtual-rows.test.ts
```

Expected: fail if queue tests still assert old behavior, or fail compile once options removed in Task 2 mid-flight; after Step 1 alone, new urgent test should **pass already** on date mode (characterization), and deleted queue tests mean green until Task 2 deletes types — **prefer writing the urgent test first (passes), then add a compile-level assertion by removing queue exports in Task 2 (mail-list still importing QueueSlug will fail typecheck/tests collect).**

Practical TDD order for autonomous run:

1. Add urgent-ordering test (should pass on current date path).
2. Delete queue tests (suite still green).
3. Task 2 deletes queue API → `mail-list.tsx` breaks → fix mail-list → green.

- [ ] **Step 3: Commit**

```bash
git add apps/mail/tests/build-mail-list-virtual-rows.test.ts
git commit -m "$(cat <<'EOF'
test(mail): require chronological inbox rows without queue sort

EOF
)"
```

---

### Task 2: Delete queue grouping; wire Inbox to date mode only

**Files:**
- Modify: `apps/mail/lib/mail/build-mail-list-virtual-rows.ts`
- Modify: `apps/mail/components/mail/mail-list.tsx`

- [x] **Step 1: Strip queue mode from `build-mail-list-virtual-rows.ts`**

Delete:

- `export type QueueSlug`
- `groupByQueue` / `queueOrder` / `queueLabels` / `resolveQueue` on options
- `queue-header` variant on `MailListVirtualRow`
- `DEFAULT_QUEUE_ORDER`, `compareQueueThreads`, `buildQueueGroupedRows`, and the `if (options.groupByQueue)` branch
- Helpers only used by queue sort if unused after (`threadRecencyMs` only used by compareQueueThreads — delete if unused; keep `isThreadStarredForPin` for date pin)

Keep date + flat paths unchanged.

- [x] **Step 2: Simplify `mail-list.tsx`**

Remove:

- Import of `QueueSlug` from `build-mail-list-virtual-rows` (keep `buildMailListVirtualRows` / `MailListVirtualRow` as needed)
- `groupByQueue` boolean
- `queueLabels` / `resolveQueue` memos
- Spread that passes `groupByQueue: true` into `buildMailListVirtualRows`
- `vListRenderer` branch for `row.type === 'queue-header'`

Set:

```typescript
const groupByDate = !isFiltering;
```

`buildMailListVirtualRows(..., { groupByDate })` only.

Stop importing `HOTEL_PRIMARY_CATEGORY_SLUGS` from presentation **if** it was only used for queue wiring; keep presentation imports still needed for pills (`resolveThreadCategoryPresentation`, `buildCategoryIdToSlugMap`, etc.).

- [x] **Step 3: Run unit tests**

```bash
cd apps/mail
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run tests/build-mail-list-virtual-rows.test.ts
```

Expected: PASS.

- [x] **Step 4: Grep for leftovers**

```bash
rg "groupByQueue|queue-header|QueueSlug" apps/mail --glob '*.{ts,tsx}'
```

Expected: no matches (or only historical comments/docs outside apps/mail).

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/mail/build-mail-list-virtual-rows.ts apps/mail/components/mail/mail-list.tsx apps/mail/tests/build-mail-list-virtual-rows.test.ts
git commit -m "$(cat <<'EOF'
fix(mail): show inbox chronologically without queue sections

EOF
)"
```

---

### Task 3: Verification

**Files:** none required beyond prior tasks

- [x] **Step 1: Broader mail unit slice (no DB)**

```bash
cd apps/mail
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run tests/build-mail-list-virtual-rows.test.ts tests/hotel-folder-presentation.test.ts tests/thread-date-bucket.test.ts
```

Expected: PASS.

- [ ] **Step 2: Manual checklist (pilot or local demo)**

1. Open `/mail/inbox` with no Views chips → **no** At risk / New Bookings / Groups / Ops section headers.
2. Newest mail near top within Today (or top of list).
3. Older urgent mail does **not** jump above newer non-urgent.
4. Category / urgent **pills still show** on rows.
5. Sidebar `/mail/at-risk` (etc.) still filters; list remains date-chronological, not queue-sorted.
6. Views chips still filter; same chronological presentation.

- [ ] **Step 3: Commit only if verification docs/notes added; otherwise stop**

No extra commit required if Tasks 1–2 already committed.

---

## Residuals (explicit non-blockers)

- Date-mode **starred → Pinned** section remains. Not queue urgency. Follow-up if product wants zero pin behavior.
- Old hotel-revenue plans still document `groupByQueue` Inbox; treat this plan as superseding default Inbox presentation.
- Layout “emails move right after reply” is a separate bug; out of scope.

## Autonomous execution notes

- Safe for `/nava-run` / overnight: FE unit tests only; no RDS.
- Do not reopen product debate on date headers vs flat unless manual verification fails product intent — then set Inbox `groupByDate: false` as the minimal fix.
