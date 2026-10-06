# Reservationist Outlook quoting UI — progress

**Worktree:** `/home/ubuntu/projects/zero/.worktrees/reservationist-quote-ui`  
**Branch:** `feat/reservationist-quote-ui` (tracks `origin/main` at start `2e3f1b3f`)  
**Forbidden tree:** `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools` (`feat/reservationist-backtest`) — read-only

| Clock | UTC |
| --- | --- |
| Start | 2026-10-05T23:12:03Z |
| Deadline | 2026-10-06T07:12:03Z |
| Stop launching long tasks | 2026-10-06T06:57:03Z |
| Last update | 2026-10-06T01:10:00Z |

Do not treat the 23:42 ledger “94 green” as current. That run is **earlier green** at 23:40:57Z, before RATE_TABLE native-PDF removal.

## Current task

Backend seams documented and client-bound where safe. Native insert uses reviewed PDF only. Narrow-pane Chromium screenshot of production `QuoteWorkflowPanel` exists. Next: scoped commits, leftover September Search Criteria card, Windows/live mailbox still out of scope.

## Completed evidence

- Isolated linked worktree from `origin/main`. Sibling tree not modified by this agent.
- Plan + session reducer + fixtures already committed (`3bd1c547`, `139f3c51`, `9389d510`).
- HITL panel: editable groups, tool steps, document review. Insert Draft visible (`hasSearched` default false). Screenshot control labelled demo not authorised.
- Native insert: `requireReviewedNativeDraft` only. No `workstation.quoteProposalPdf`, no generic wrapper HTML, no RATE_TABLE bytes on the quoting path. RATE_TABLE still exists for leftover gated Search Criteria visuals.
- Pane calls `quoteWorkflow.analyseSelection` / `runStep` via `backend-bind.ts` when the tRPC client has them. Tests mock a partial client → `unavailable`. Local classification still fills HITL so staff can walk fixture PDF; banner says mailbox analysis is unsynced/unbound.
- **Earlier green (not this HEAD):** 2026-10-05T23:40:57Z — 94 mail tests PASS (RATE_TABLE fallback still present).
- **Latest visible fail (preserve):** 2026-10-06T00:23:04Z — 4 failed / 81 passed (85) after RATE_TABLE cut (`Run next` missing without mailbox; selection-switch inserts blocked without HITL). 00:55:09Z rerun 4 failed then 1 failed (259 vs 258) until in-flight wait.
- **Latest green (this HEAD):** 2026-10-06T01:04:06Z — mail **94 passed / 10 files**; server `quote-workflow-router` **7 passed**. `DATABASE_URL` unset.
- Narrow pane: `apps/mail/tests/browser-quote-workflow/narrow-pane-380.png` Chromium-1243, viewport 380×900, production panel markup. Playwright 1.52 wanted missing `chromium_headless_shell-1169`. Not live Outlook/Windows.

## Backend integration seams (existing APIs only)

| Adapter | Bind to | Overnight status |
| --- | --- | --- |
| Mailbox analysis | `trpc.quoteWorkflow.analyseSelection` (`mailboxProcedure`) → `loadSyncedQuoteSelectionFromMailbox` (`getDb` + `message.messageIdHeader` + preceding `receivedAt` + `attachment` identity) | Default **unsynced** without `internetMessageId` or matching row. No S3 bodies. No PMS. |
| Live inventory | `trpc.quoteWorkflow.runStep` → later `ai.enqueueHmsRead({ toolId: 'hms_quote_stay' })` | **`integration_unavailable`**. Not called into HMS. No second PMS owner. |
| Native unsent draft | Classic Outlook `CREATE_REPLY_DRAFT` then `ADD_ATTACHMENT_TO_DRAFT` | Bound. Bytes = reviewed session PDF. |
| Qualified PDF | sibling `qualifiedQuoteProposalPdf` / `qualifiedProposalChoices` | **Not on this branch.** Honest gap. Fixture PDF labelled not live HMS. |

Missing backend is an honest gap, not a reason to add another quote engine.

## Remaining

- September sample calendar / RATE_TABLE cards still in leftover Search Criteria DOM (gated `hasSearched`).
- `analyseSelection` default unsynced until live mailbox `internetMessageId` + disposable DB. S3 attachment bytes not read.
- `runStep` unavailable until the authorised PMS owner binds `enqueueHmsRead`.
- Pane still uses local `analyseLocalEmail` for HITL groups when tRPC is unsynced/unavailable (labelled).
- Narrow-pane screenshot is production component markup, not a logged-in Outlook add-in session.
- Windows Classic Outlook + production mailbox still required before staff use.
- No merge/deploy.

## Blockers

None for UI. Live PMS owner is the other executor. No disposable DB verified for real mailbox `analyseSelection`. Playwright 1.52 browser revision missing; used cached Chromium-1243.

## Owned processes / ports

None.

## Time spent

~2h this resume (test fix + bind + screenshot) + prior isolation/plan/session. Deadline 07:12Z.

## Next highest-value action

Scoped commits in this worktree, then strip leftover September RATE_TABLE Search Criteria from the quoting path (visual only; insert already blocked).
