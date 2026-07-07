---
title: "feat: Align server-pilot and mail frontend contracts"
type: "feat"
date: "2026-07-06"
---

# feat: Align server-pilot and mail frontend contracts

## Summary

Make `apps/mail` and `apps/server-pilot` converge on one production contract for core mail, drafts, hotel categories, folder actions, and search filters. The goal is not legacy feature parity; the goal is a reliable pilot where the frontend can keep the hotel category UX while the backend owns consistent storage and filtering semantics.

---

## Problem Frame

The current branch has a split-brain contract. `apps/server-pilot` has real POP3/S3/Postgres ingest, SMTP send, mailbox-scoped tRPC, and draft CRUD, while `apps/mail` still carries assumptions from the legacy `apps/server` router and demo-only hotel mailbox model. The result is broad drift: live drafts are undiscoverable, hotel folders are demo-gated, category filters are routed through label IDs, advanced/AI search UI overpromises, some move actions optimistically succeed while backend state does not change, and local dev can accidentally start the legacy backend.

The product direction is settled for this plan:

- System folders stay: `inbox`, `sent`, `spam`, `drafts`, `archive`, `bin`, `starred`, `snoozed`.
- Hotel categories stay live and are configurable multi-select filters, not a fixed hardcoded enum.
- A thread can be `Inbox + travel-agents + urgent`.
- Drafts stay separate from messages, with a thread-level draft card and stale-draft warning.
- Legacy AI, brain, notes, templates, and BIMI surfaces are hidden or inert for this pass.
- Search promises plain text plus explicit filters, not Gmail grammar or AI-generated search.

---

## Requirements

**Core Contract**

- R1. `apps/mail` must compile against `@zero/server` / `apps/server-pilot` contracts without importing legacy `apps/server/src/*` types for live mail behavior.
- R2. `apps/server-pilot` must export real mail, thread, draft, category, label, and connection wire types that match the live frontend contract.
- R3. Missing legacy surfaces must not break typecheck or runtime render in pilot mode; AI, brain, notes, templates, and BIMI must be hidden or served by inert compatibility stubs.

**System Folders and Actions**

- R4. System folders must be derived from backend mail state, not from mutable user labels or hotel category IDs.
- R5. Archive, spam, bin, snooze, inbox restore, starred, unread, and important actions must call backend procedures that mutate the matching backend state.
- R6. Frontend optimistic moves must refresh into the same folder state the backend persisted.

**Hotel Categories**

- R7. Hotel categories must be configurable per mailbox/transport and support multiple categories per thread.
- R8. Hotel categories must be stored separately from `mail_thread.labelIds` so product folder filters do not collide with user labels or system labels.
- R9. Category routes and category dropdown filters must work for `providerId: "mailbox"`, not only Google connections.
- R10. Category assignment logic is out of scope; this plan only creates the contract that later rules or LLM triage can write to.

**Drafts and Threads**

- R11. Live Drafts folder must list unsent `mail_draft` rows through `drafts.list`, not `mail.listThreads(folder: "draft")`.
- R12. `mail.get` must expose draft state for the thread without merging drafts into chronological `message` rows.
- R13. Sending an existing draft must detect a newer thread message than the draft was based on and return a conflict path the frontend can show as a warning or confirmation.
- R14. A new inbound message joining a thread with an unsent draft must leave the draft unsent, show the new message as latest, and expose the draft as stale if appropriate.

**Search and Filters**

- R15. Plain search must continue to search subject/snippet.
- R16. Explicit filters must cover unread, important, starred, hotel categories, and user labels without relying on Gmail-style grammar.
- R17. UI affordances for unsupported Gmail grammar, natural language AI search, or legacy search syntax must be hidden or downgraded in pilot mode.

**Verification and Dev Workflow**

- R18. Local development scripts must start `apps/server-pilot` only; this branch should not offer a legacy backend path.
- R19. Tests must cover the live contract gaps: draft discovery, stale draft conflict, category filtering, folder action persistence, search filters, and missing legacy surface handling.
- R20. Typecheck must be a meaningful gate for FE/server-pilot drift, not hidden by legacy type imports or demo-only code paths.

---

## Key Technical Decisions

- **Contract-first convergence:** Fix the shared API and type surface before implementing new triage logic. The current risk is not classifier quality; it is frontend and backend disagreeing about what live mail can represent.
- **System folders are state-derived:** `inbox`, `sent`, `spam`, `drafts`, `archive`, and `bin` are backend state views. They should not be stored as user labels or hotel categories.
- **Hotel categories are configurable multi-select filters:** Model them as mailbox-scoped category definitions plus thread-category membership. This supports changing the hotel taxonomy later and supports overlapping categories like `travel-agents + urgent`.
- **Drafts are thread metadata, not messages:** Keep drafts in `mail_draft` and expose `latestDraft` / `drafts` from `mail.get`. Do not insert draft pseudo-messages into `messages[]`; the frontend already has a bottom draft card pattern.
- **Stale draft conflict is checked at send time:** Store the thread latest-message timestamp or message id the draft was based on, then reject or confirm send if a newer message exists. This prevents accidental replies to stale context without rebuilding compose chronology.
- **Legacy features are hidden or inert:** AI, brain, notes, templates, and BIMI are not part of this pilot pass. Any compatibility route added here must be safe, empty, and clearly marked as pilot-inert.
- **Search uses explicit filters:** The pilot should not advertise Gmail grammar or AI search until the backend parser exists. Filter state should be structured and testable.

---

## High-Level Technical Design

```mermaid
flowchart TB
  FE[apps/mail]
  TRPC[@zero/server AppRouter]
  Mail[mail router]
  Drafts[drafts router]
  Categories[categories router or category procedures]
  DB[(Postgres)]

  FE -->|typed tRPC| TRPC
  TRPC --> Mail
  TRPC --> Drafts
  TRPC --> Categories

  Mail -->|threads/messages/system state| DB
  Drafts -->|mail_draft| DB
  Categories -->|mail_category + mail_thread_category| DB

  Mail -->|mail.get returns messages + latestDraft + categoryIds| FE
  Mail -->|listThreads filters system folder + categoryIds + user labelIds| FE
  Drafts -->|draft folder rows| FE
```

Core list behavior should resolve filters in this order:

1. Scope by active transport.
2. Apply system folder state (`inbox`, `sent`, `spam`, `archive`, `bin`, `snoozed`, `starred`).
3. Apply hotel category membership filters.
4. Apply user label filters.
5. Apply explicit system filters (`unread`, `important`, `starred`) and plain `q`.
6. Page by `latestMessageAt` keyset cursor.

---

## Scope Boundaries

### In Scope

- Server-pilot schema and tRPC contract changes needed for live frontend mail UX.
- Frontend wiring to consume server-pilot categories, draft state, filter state, and folder actions.
- Compatibility hiding/stubbing for legacy-only surfaces that currently break typecheck/runtime.
- Tests and local dev script corrections that prevent future FE/server-pilot drift.

### Deferred to Follow-Up Work

- LLM triage or deterministic classifier rules that assign hotel categories.
- Gmail-like search grammar (`from:`, `to:`, `before:`, `after:`, `has:attachment`).
- AI sidebar, Cloudflare Agents, brain prompts/summaries, notes, templates, and BIMI feature parity.
- Full Outlook/Gmail-style inline draft chronology.
- Real Exchange activation; wire/fixture mail transport work already has its own track.

### Outside This Plan

- Replacing POP3/S3/Postgres ingest architecture.
- Reworking legacy `apps/server` behavior.
- Broad UI redesign unrelated to making the pilot contract true.

---

## Implementation Units

### U1. Shared Pilot Mail Contract

- **Goal:** Replace legacy mail type imports with server-pilot-owned types and make the tRPC contract the source of truth for live mail.
- **Requirements:** R1, R2, R20.
- **Dependencies:** None.
- **Files:**
  - Modify: `apps/server-pilot/src/lib/driver/types.ts`
  - Modify: `apps/server-pilot/src/trpc/wire-compat.ts`
  - Modify: `apps/server-pilot/src/trpc/index.ts`
  - Modify: `apps/mail/hooks/use-threads.ts`
  - Modify: `apps/mail/components/mail/mail-list.tsx`
  - Modify: `apps/mail/types/index.ts`
  - Modify: `apps/mail/lib/demo-data/adapter.ts`
  - Modify: `apps/mail/lib/demo/folder-map.ts`
  - Test: `apps/server-pilot/tests/package-contract.test.ts`
  - Test: `apps/mail/tests/demo-data.adapter.test.ts`
- **Approach:** Define concrete `ParsedMessage`, `ParsedDraft`, `ThreadResponse`, `ThreadListItem`, `MailCategory`, and filter input types in `@zero/server`. Update frontend imports that currently point at `../../server/src/lib/driver/types` or `../../../server/src/*`. Keep demo-only types local to `apps/mail` when they are not part of live pilot.
- **Patterns to follow:** Existing package exports in `apps/server-pilot/package.json`; existing `toParsedMessage()` mapper in `apps/server-pilot/src/trpc/wire-compat.ts`.
- **Test scenarios:**
  - `@zero/server/driver/types` exports the live response types consumed by `apps/mail`.
  - Frontend demo adapter compiles without importing live-only server-pilot internals.
  - Package contract test fails if server-pilot removes a type the frontend imports.
- **Verification:** `@zero/mail` typecheck no longer reports legacy `apps/server` driver type mismatches for live mail contract files.

### U2. Inert Legacy Surface Boundary

- **Goal:** Stop legacy-only AI/brain/notes/templates/BIMI surfaces from breaking pilot compile or runtime without rebuilding those features.
- **Requirements:** R3, R20.
- **Dependencies:** U1.
- **Files:**
  - Modify: `apps/server-pilot/src/trpc/router.ts`
  - Create or modify: `apps/server-pilot/src/trpc/routes/ai.ts`
  - Create or modify: `apps/server-pilot/src/trpc/routes/brain.ts`
  - Create or modify: `apps/server-pilot/src/trpc/routes/notes.ts`
  - Create or modify: `apps/server-pilot/src/trpc/routes/templates.ts`
  - Create or modify: `apps/server-pilot/src/trpc/routes/bimi.ts`
  - Modify: `apps/mail/components/ui/ai-sidebar.tsx`
  - Modify: `apps/mail/components/ui/prompts-dialog.tsx`
  - Modify: `apps/mail/components/mail/note-panel.tsx`
  - Modify: `apps/mail/components/create/template-button.tsx`
  - Modify: `apps/mail/components/ui/bimi-avatar.tsx`
  - Test: `apps/mail/tests/demo-backend-guards.test.ts`
  - Test: `apps/server-pilot/tests/misc-wire-contract.test.ts`
- **Approach:** Add minimal pilot-inert routers only where type surface is needed. Return empty arrays, `null`, or disabled states. In the frontend, gate visible controls behind a pilot capability flag so users do not see dead AI/notes/template/BIMI UI. Replace imports of `Tools`, `EPrompts`, and prompt defaults from legacy `apps/server/src/*` with local FE constants or pilot-safe fallbacks.
- **Patterns to follow:** Existing demo guards in `apps/mail/tests/demo-backend-guards.test.ts`; server-pilot root router assembly in `apps/server-pilot/src/trpc/router.ts`.
- **Test scenarios:**
  - Rendering mail shell in pilot mode does not instantiate `agents/react` `ZeroAgent`.
  - Prompt dialog and AI sidebar are hidden or disabled when pilot capabilities omit AI.
  - Notes/templates/BIMI hooks do not call missing server routes in pilot mode.
  - Inert routers return safe empty data if a stale component calls them.
- **Verification:** `@zero/mail` typecheck sees the route names it imports, and pilot UI does not expose legacy-only actions.

### U3. Configurable Hotel Category Model

- **Goal:** Add backend storage and API contract for configurable multi-select hotel categories that are separate from system folders and user labels.
- **Requirements:** R7, R8, R9, R10, R16.
- **Dependencies:** U1.
- **Files:**
  - Modify: `apps/server-pilot/src/db/schema/mail.ts`
  - Create: `apps/server-pilot/drizzle/0005_mail_categories.sql`
  - Create or modify: `apps/server-pilot/src/trpc/routes/categories.ts`
  - Modify: `apps/server-pilot/src/trpc/router.ts`
  - Modify: `apps/server-pilot/src/lib/schemas.ts`
  - Modify: `apps/server-pilot/src/db/seed.ts`
  - Test: `apps/server-pilot/tests/schema-contract.test.ts`
  - Create: `apps/server-pilot/tests/categories-contract.test.ts`
  - Modify: `apps/server-pilot/tests/mail-router-isolation.test.ts`
- **Approach:** Add `mail_category` scoped by `transport_id` with stable `id`, `slug`, `name`, `icon`, `order`, and optional `is_default`. Add `mail_thread_category` join rows for many-to-many thread membership. Do not use `mail_thread.labelIds` for hotel categories. Seed initial categories from current FE vocabulary, but do not hardcode the enum as the only allowed set.
- **Patterns to follow:** `mail_label` transport scoping and unique index shape in `apps/server-pilot/src/db/schema/mail.ts`; settings category schema in `apps/server-pilot/src/lib/schemas.ts`.
- **Test scenarios:**
  - Creating two categories with the same slug on one transport returns conflict.
  - Same slug on different transports is allowed.
  - A thread can belong to `travel-agents` and `urgent`.
  - Category deletion or deactivation does not corrupt thread/message rows.
  - Category list returns categories in configured order for the active transport.
- **Verification:** Category routes and schema support multi-select hotel categories without touching user label CRUD.

### U4. Thread Listing Filters and Category Routes

- **Goal:** Teach `mail.listThreads` and the frontend route layer to filter by system folders, category slugs/ids, user labels, and explicit system filters.
- **Requirements:** R4, R6, R9, R15, R16, R17.
- **Dependencies:** U3.
- **Files:**
  - Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
  - Modify: `apps/server-pilot/src/trpc/routes/mail-helpers.ts`
  - Modify: `apps/mail/hooks/use-threads.ts`
  - Modify: `apps/mail/hooks/use-labels-search.ts`
  - Modify: `apps/mail/hooks/use-categories.ts`
  - Modify: `apps/mail/components/mail/mail.tsx`
  - Modify: `apps/mail/config/navigation.ts`
  - Modify: `apps/mail/lib/demo/folder-map.ts`
  - Create: `apps/mail/tests/search-filter-contract.test.ts`
  - Modify: `apps/mail/tests/demo-folder-map.test.ts`
  - Modify: `apps/server-pilot/tests/list-pagination.test.ts`
  - Create: `apps/server-pilot/tests/mail-category-filter.test.ts`
- **Approach:** Replace the current `folder` enum-only contract with a resolver that distinguishes known system folders from category slugs. Add structured filter input such as `filters.unread`, `filters.important`, `filters.starred`, `filters.categoryIds`, and `filters.labelIds`. Keep `q` as plain subject/snippet search. Enable category dropdown for `providerId: "mailbox"` and route category folder clicks into category filters. Hide or downgrade advanced search help that promises unsupported grammar.
- **Patterns to follow:** Existing keyset pagination in `mail.listThreads`; current category settings shape in `apps/mail/hooks/use-categories.ts`; demo folder normalization in `apps/mail/lib/demo/folder-map.ts`.
- **Test scenarios:**
  - `/mail/travel-agents` lists threads tagged with that category and excludes untagged threads.
  - A thread tagged `travel-agents + urgent` appears in both category routes.
  - Inbox route still applies system inbox state and can combine with a category filter.
  - `Unread` filter maps to `mail_thread.isRead = false`, not `labelIds` containing `UNREAD`.
  - Plain `q` still searches subject/snippet and paginates correctly.
  - Unsupported `from:` or `is:` grammar is not advertised as supported in pilot UI.
- **Verification:** Manual pilot navigation can move between core folders and hotel category folders without hitting backend validation errors.

### U5. Draft Folder and Thread Draft Contract

- **Goal:** Make live drafts discoverable in Drafts folder and visible as thread-level draft state.
- **Requirements:** R11, R12, R14.
- **Dependencies:** U1.
- **Files:**
  - Modify: `apps/server-pilot/src/db/schema/mail.ts`
  - Create: `apps/server-pilot/drizzle/0006_draft_thread_base.sql`
  - Modify: `apps/server-pilot/src/trpc/routes/drafts.ts`
  - Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
  - Modify: `apps/server-pilot/src/trpc/wire-compat.ts`
  - Modify: `apps/mail/hooks/use-threads.ts`
  - Modify: `apps/mail/hooks/use-drafts.ts`
  - Modify: `apps/mail/components/mail/thread-display.tsx`
  - Modify: `apps/mail/components/mail/mail-list.tsx`
  - Modify: `apps/mail/components/mail/thread-draft-card.tsx`
  - Test: `apps/server-pilot/tests/drafts-contract.test.ts`
  - Create: `apps/server-pilot/tests/draft-thread-contract.test.ts`
  - Test: `apps/mail/tests/thread-draft-view-model.test.ts`
  - Create: `apps/mail/tests/live-draft-folder.test.ts`
- **Approach:** Extend `drafts.list` with optional `threadId` and use it for live Drafts folder. Extend `mail.get` to return `latestDraft` or `drafts` alongside `messages`, keeping `messages[]` real messages only. Add `baseThreadLatestMessageAt` or equivalent base marker to `mail_draft` so stale checks are deterministic. Update `useThread()` to consume `thread.latestDraft` instead of searching `messages.findLast(isDraft)`.
- **Patterns to follow:** Current `ThreadDraftCard` trailing section in `apps/mail/components/mail/thread-display.tsx`; current `mail_draft` indexes in schema.
- **Test scenarios:**
  - `drafts.list` returns unsent drafts sorted by `updatedAt`.
  - Live `/mail/draft` renders rows from `drafts.list`, not empty `mail.listThreads`.
  - `mail.get` on a thread with one unsent draft returns non-null `latestDraft`.
  - `messages[]` returned by `mail.get` contains no draft pseudo-message.
  - Deleting a draft removes the thread draft card and Drafts folder row.
- **Verification:** Creating a reply draft, leaving the thread, and opening Drafts shows the saved draft and allows continuing it.

### U6. Stale Draft Conflict Policy

- **Goal:** Warn or block before sending a draft that was written against older thread context.
- **Requirements:** R13, R14.
- **Dependencies:** U5.
- **Files:**
  - Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
  - Modify: `apps/server-pilot/src/trpc/routes/drafts.ts`
  - Modify: `apps/mail/components/mail/reply-composer.tsx`
  - Modify: `apps/mail/components/create/email-composer.tsx`
  - Modify: `apps/mail/components/mail/thread-draft-card.tsx`
  - Create: `apps/server-pilot/tests/draft-stale-conflict.test.ts`
  - Create: `apps/mail/tests/stale-draft-warning.test.ts`
- **Approach:** When a draft is created for a thread, persist the thread latest-message marker that the user was composing against. On send with `draftId`, compare the marker to current thread latest inbound or latest message. If newer mail exists and the caller has not set an explicit confirmation flag, return a conflict error with current latest metadata. The frontend shows a banner on the draft card/composer and requires a confirm-send action to proceed.
- **Patterns to follow:** `TRPCError` usage in server-pilot routes; existing toast/error handling in `reply-composer.tsx`; current thread draft card display.
- **Test scenarios:**
  - Create draft on thread, ingest inbound reply joining same thread, then send draft without confirmation returns conflict.
  - Same setup with confirmation flag sends and marks draft sent.
  - Updating or reopening the draft after acknowledging current latest message clears the stale warning.
  - Draft remains unsent after inbound join and thread latest points at inbound message.
- **Verification:** User sees "new reply arrived since this draft" before they can accidentally send stale context.

### U7. Folder Action Semantics

- **Goal:** Align frontend move/action helpers with server-pilot state mutations.
- **Requirements:** R4, R5, R6.
- **Dependencies:** U4.
- **Files:**
  - Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
  - Modify: `apps/mail/lib/thread-actions.ts`
  - Modify: `apps/mail/hooks/use-optimistic-actions.ts`
  - Modify: `apps/mail/components/context/thread-context.tsx`
  - Modify: `apps/mail/components/mail/thread-display.tsx`
  - Test: `apps/server-pilot/tests/mail-thread-actions.test.ts`
  - Test: `apps/server-pilot/tests/trash-soft-delete.test.ts`
  - Create: `apps/mail/tests/thread-actions-contract.test.ts`
- **Approach:** Stop expressing archive/spam/snooze/bin/inbox restore as Gmail label add/remove operations. Use dedicated backend procedures for each state transition. Add missing procedures where needed, such as `bulkSpam` / `bulkUnspam` or a typed `moveThreads` mutation. Keep `modifyLabels` for user labels only.
- **Patterns to follow:** Existing `bulkArchive`, `bulkDelete`, `snoozeThreads`, and `unsnoozeThreads` procedures; optimistic action manager in `apps/mail/hooks/use-optimistic-actions.ts`.
- **Test scenarios:**
  - Moving inbox thread to archive sets `isArchived=true` and it disappears from inbox after refetch.
  - Moving inbox thread to spam persists spam state and it appears in spam after refetch.
  - Moving spam thread to inbox clears spam state without adding a fake `INBOX` label.
  - Moving thread to bin sets `trashedAt` and restore clears it.
  - Optimistic update matches backend state after query invalidation.
- **Verification:** Context menu and toolbar folder actions survive refresh.

### U8. Search and Filter UI Cleanup

- **Goal:** Make pilot search honest: plain search plus structured filters only.
- **Requirements:** R15, R16, R17.
- **Dependencies:** U4.
- **Files:**
  - Modify: `apps/mail/components/context/command-palette-context.tsx`
  - Modify: `apps/mail/components/mail/render-labels.tsx`
  - Modify: `apps/mail/hooks/use-search-value.ts`
  - Modify: `apps/mail/lib/utils.ts`
  - Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
  - Create: `apps/mail/tests/search-filter-contract.test.ts`
  - Create: `apps/server-pilot/tests/mail-search-filters.test.ts`
- **Approach:** Represent filters as structured state instead of text grammar for pilot. Keep current plain `q` path. Hide natural-language search and grammar help when server capabilities do not include AI/Gmail grammar. Label clicks should set `filters.labelIds`; category clicks should set `filters.categoryIds`.
- **Patterns to follow:** Existing `useSearchValue()` atom and command palette filter UI; `mail.listThreads` `q` filtering.
- **Test scenarios:**
  - Label pill click filters by user label id.
  - Category route/filter does not append `label:<name>` text to `q`.
  - `from:` text is treated as plain text or the UI hides grammar affordances in pilot mode.
  - Natural language search button does not call `trpc.ai.generateSearchQuery` in pilot mode.
- **Verification:** Users cannot trigger unsupported search syntax through first-party pilot UI.

### U9. Shape Drift Fixes for Existing Routes

- **Goal:** Fix smaller wire-shape mismatches in routes that already exist.
- **Requirements:** R1, R2, R20.
- **Dependencies:** U1.
- **Files:**
  - Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
  - Modify: `apps/server-pilot/src/trpc/routes/labels.ts`
  - Modify: `apps/mail/hooks/use-attachments.ts`
  - Modify: `apps/mail/components/mail/email-verification-badge.tsx`
  - Modify: `apps/mail/components/ui/recipient-autosuggest.tsx`
  - Modify: `apps/mail/components/mail/mail-display.tsx`
  - Test: `apps/server-pilot/tests/mail-get-attachments.test.ts`
  - Test: `apps/server-pilot/tests/labels-contract.test.ts`
  - Test: `apps/mail/tests/demo-backend-guards.test.ts`
- **Approach:** Pick one shape per route and update both sides. Prefer matching the frontend where the route is already consumed broadly, unless the backend wrapper shape is materially better. Known mismatches: `verifyEmail.isVerified` vs `verified`, `getMessageAttachments` array vs wrapper, `suggestRecipients.query` vs `q`, and label color object vs string.
- **Patterns to follow:** Existing tests around attachment access and label contracts.
- **Test scenarios:**
  - `verifyEmail` result drives badge visibility without undefined-property access.
  - Attachment hook returns the array shape `MailDisplay` expects or `MailDisplay` unwraps consistently.
  - Recipient autosuggest query input parses and returns an empty array rather than tRPC validation error.
  - Label settings UI can render and update server-pilot label color shape.
- **Verification:** The direct typecheck errors listed in the drift audit are removed or intentionally gated.

### U10. Dev Workflow and Drift Gates

- **Goal:** Make local development and CI expose server-pilot drift instead of hiding it behind legacy backend or demo mode.
- **Requirements:** R18, R19, R20.
- **Dependencies:** U1, U2, U4, U5, U7, U9.
- **Files:**
  - Modify: `scripts/run-backend-local.mjs`
  - Modify: `scripts/run-frontend-local.mjs`
  - Modify: `package.json`
  - Modify: `apps/mail/package.json`
  - Modify: `apps/server-pilot/tests/package-contract.test.ts`
  - Create: `apps/mail/tests/pilot-route-surface.test.ts`
  - Modify: `docs/production-readiness/2026-07-06-fe-server-pilot-drift-audit.md`
- **Approach:** Make local full-stack scripts start `apps/server-pilot` on port `8788` with no legacy backend escape hatch. Add a focused route-surface/type contract test that catches missing routers and shape drift before manual testing. Update the audit doc with resolved/remaining items after implementation.
- **Patterns to follow:** Current `scripts/run-frontend-local.mjs` backend auto-start pattern; server-pilot package contract tests.
- **Test scenarios:**
  - Local frontend script probes `http://localhost:8788/api/public/providers` by default.
  - Local backend startup never targets `apps/server`.
  - Pilot route-surface test fails if a frontend live import references a missing server-pilot router.
  - Demo-only tests still run without requiring server-pilot.
- **Verification:** A clean local dev start talks to server-pilot by default and catches missing contract before deploy.

---

## System-Wide Impact

- **Database:** Adds category tables and draft base metadata. Migration must preserve existing threads and drafts by leaving category membership empty until assignment exists.
- **Frontend routes:** `/mail/:folder` can now mean either a system folder or a hotel category slug. The resolver must keep system folders reserved so a category cannot shadow `inbox`, `sent`, `spam`, `draft`, `archive`, `bin`, `starred`, or `snoozed`.
- **Auth/mailbox scope:** Categories are transport-scoped like labels. All category list and assignment routes must use `mailboxProcedure` or equivalent active transport guard.
- **Testing posture:** Existing demo mode remains useful, but no live pilot decision should be proven only by demo tests.
- **Future agent/LLM work:** Category assignment becomes a backend-writeable contract for later rules/LLM routing. This plan does not choose the classifier.

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Category slugs collide with system folder slugs. | Reserve system folder slugs in category validation and tests. |
| Normalized categories feel heavier than JSON arrays. | The join table pays for itself because category filters are a first-class navigation path and need indexes. |
| Inert routers hide missing feature work forever. | Mark inert routers with pilot-only comments and add capability flags so UI remains honest. |
| Draft stale conflict annoys users if too strict. | Provide explicit confirm-send override after showing latest-message warning. |
| Typecheck still has unrelated noise. | Track direct FE/server-pilot contract errors separately so this plan can close them without claiming whole repo typecheck is clean. |
| Another LLM is implementing live hotel category folders concurrently. | Treat this plan as the contract boundary; reconcile any concurrent changes against R7-R10 and U3-U4 before implementation starts. |

---

## Acceptance Examples

- AE1. Given a live pilot mailbox with an inbound thread tagged `travel-agents` and `urgent`, when the user opens `/mail/travel-agents`, then the thread appears; when the user opens `/mail/urgent`, the same thread also appears.
- AE2. Given an unread thread, when the user selects the `Unread` filter, then the thread appears even though `mail_thread.labelIds` does not contain `UNREAD`.
- AE3. Given a thread with an unsent draft, when the user opens the thread, then the message timeline shows real messages and the draft card appears after the timeline.
- AE4. Given a draft based on message A, when message B arrives before send, then sending without confirmation returns a stale draft conflict and the UI warns the user.
- AE5. Given the user moves a thread from inbox to spam, when the list refetches, then the thread remains absent from inbox and appears in spam.
- AE6. Given pilot mode, when the user opens the app shell, then AI/sidebar/brain/notes/templates/BIMI controls do not call missing legacy backends.

---

## Documentation and Operational Notes

- Update `docs/production-readiness/2026-07-06-fe-server-pilot-drift-audit.md` after implementation with each resolved finding and any consciously deferred legacy surface.
- Add a short solution note under `docs/solutions/architecture-patterns/` if category storage introduces a reusable pattern for product folders vs user labels.
- Local scripts should print which backend they started and which `VITE_PUBLIC_BACKEND_URL` is being used.

---

## Sources and Research

- `docs/production-readiness/2026-07-06-fe-server-pilot-drift-audit.md` - primary audit source for FE/server-pilot drift.
- `apps/server-pilot/src/trpc/router.ts` - current server-pilot route surface.
- `apps/server-pilot/src/trpc/routes/mail.ts` - folder semantics, message listing, send, existing action procedures.
- `apps/server-pilot/src/trpc/routes/drafts.ts` - current draft CRUD and list contract.
- `apps/server-pilot/src/db/schema/mail.ts` - current thread/message/label/draft schema.
- `apps/mail/hooks/use-threads.ts` - current live thread/draft discovery behavior.
- `apps/mail/config/navigation.ts` and `apps/mail/lib/demo/folder-map.ts` - current demo-only hotel folder model.
- `apps/mail/lib/thread-actions.ts` - current label-based move abstraction that drifts from server-pilot state.
- `apps/mail/components/ui/ai-sidebar.tsx` - Cloudflare Agents dependency that server-pilot does not serve.
- Outlook/Gmail behavior check: both treat drafts as conversation-associated state; neither requires rebuilding draft chronology for this pilot, supporting the bottom draft card plus stale warning approach.
