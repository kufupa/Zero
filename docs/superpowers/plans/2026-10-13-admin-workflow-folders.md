# Nava admin workflow folders and Quote Desk

## Scope and decisions

- Replace visible legacy hotel-triage navigation with workflow folders, plus Inbox, All mail, and Sent.
- Keep legacy triage/routing implementations intact but unused by this console.
- The server is the single source of folder membership: a succeeded inbound extraction's source route wins for `automated-channel` / `system_notice`, otherwise `action` (column first, then payload) wins, otherwise legacy `kind` is used.
- Render one row per thread, keyed by its newest inbound message with a succeeded extraction. The thread inspector may select any inbound message in that thread.
- Use stored extraction/workflow-run snapshots only. The Quote Desk is read-only except for an append-only `admin_review` work event; it never starts an HMS or network action.
- Review notes are masked and bounded before they are stored. All reads and writes are scoped to the active transport.

## Implementation

1. Add a server workflow-folder definition and pure mapper with action-first and legacy fallback behavior; test action precedence, legacy kinds, system source routing, and unknown action handling.
2. Add mailbox-scoped workflow summary/list/thread queries. Choose the latest succeeded extraction per inbound message, then the newest qualifying message per thread; include latest review snapshots and stored workflow results only.
3. Add `workItems.adminReview`, writing a typed `admin_review` event bound to the currently latest succeeded extraction; test valid, stale, and cross-transport requests.
4. Replace visible hotel-triage nav with the new workflow links and live total badges; retain Inbox, All mail, and Sent. Add a render test for labels, links, and counts.
5. Add the three-column Quote Desk: workflow list, read-only mail body with exact extracted text highlights, and read-only Nava result panel with review strip and footer stats. Accept the workflow slugs in the mail route.
6. Run touched Vitest tests with `--maxWorkers=2`, then typecheck `apps/server-pilot` and `apps/mail` with the repository's memory constraints. Report only errors introduced by this work; do not run live HMS/network or CI/workflows.

## Verification

- Pure mapper tests cover the decision table and source override.
- Mutation-handler tests with a fake database prove event persistence, note masking, active-transport isolation, and stale-extraction rejection without a live database.
- Nav render test checks the new menu and absence of retired triage labels.
- Touched tests and per-package TypeScript checks are the only planned verification.
- Screenshots to request/capture for design review: the expanded sidebar plus a populated three-column folder, and the same thread with a saved Right/Edited/Wrong review state.
