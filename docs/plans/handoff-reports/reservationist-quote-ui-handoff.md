# Reservationist Outlook quoting UI — handoff

**Worktree:** `/home/ubuntu/projects/zero/.worktrees/reservationist-quote-ui`  
**Branch:** `feat/reservationist-quote-ui`  
**HEAD at handoff write:** `7f728d66` plus this docs/screenshot commit  
**Base:** `origin/main` `2e3f1b3f` (PR #28 mailbox history/live-sync)  
**Forbidden tree:** `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools` (`feat/reservationist-backtest`) — **not edited by this executor**  
**Verdict:** UI-owned HITL quoting path exists. **Not live-ready.** No merge, deploy, send, or PMS in this window.

## 1. Overlapping paths vs sibling

Same paths exist on **both** trees. Do not cherry-pick or copy sibling files.

| Path | This UI branch | Sibling (`feat/reservationist-backtest`) |
| --- | --- | --- |
| `apps/mail/app/(routes)/outlook-pane/page.tsx` | **Conflict.** RATE_TABLE calendar/search/demo screenshot removed. HITL `QuoteWorkflowPanel` + reviewed native insert. | Dirty reservationist/dashboard quoting work. Independent edits. |
| `apps/server-pilot/src/trpc/routes/workstation.ts` | Unchanged from main on this branch (native ping / old `quoteProposalPdf` still exist; pane quoting path does not call it). | Dirty. |
| `apps/server-pilot/src/trpc/routes/drafts.ts` | Unchanged from main. | Dirty. |
| `apps/server-pilot/src/quote-proposal/*` | Unchanged from main. | Dirty (`description`, `gotenberg`, `patch-sheet`, `proposal-pdf`, plus untracked `quote-lines` / `quote-revision` / `rate-check`). |
| `apps/mail/components/create/email-composer.tsx`, `thread-display`, draft hooks | Unchanged from main. | Dirty. |
| `apps/server-pilot/src/ai/reservationist-*`, `qualifiedProposalChoices`, `qualifiedQuoteProposalPdf` | **Absent** on this branch / `origin/main`. | Present (mostly uncommitted). Do not import. |

**Exact landing conflict:** `outlook-pane/page.tsx` cannot be merged as a union of both diffs. Keep this branch’s quoting contracts; take sibling runtime/PDF only after that work lands on main, then rebind adapters.

## 2. Landing order

1. **Keep UI contracts stable** on this branch: `QuoteSession` / `QuoteWorkflowPanel`, `quoteWorkflow.analyseSelection` + `runStep` shapes, `requireReviewedNativeDraft`, `CREATE_REPLY_DRAFT` → `ADD_ATTACHMENT_TO_DRAFT`, honest `integration_unavailable` / fixture PDF labels.
2. **After sibling `quote-revision` + `qualifiedProposalChoices` merge to main**, replace fixture result/PDF adapters **only** (`bindRunStep` / `bindQualifiedProposalPdf`). Do not invent a second PDF or pricing engine on this UI branch.
3. **Staff-approved live `ai.enqueueHmsRead({ toolId: 'hms_quote_stay' })`** only with a **single** PMS/browser owner. This overnight UI must not enqueue it.
4. **Do not merge either branch to main in this window.** No deploy, no production drafts, no sends.

## 3. Unverified integrations

| Seam | Bind target on main / later sibling | Overnight status | What was not verified |
| --- | --- | --- | --- |
| Mailbox analysis | `trpc.quoteWorkflow.analyseSelection` (`mailboxProcedure`) → `loadSyncedQuoteSelectionFromMailbox` | Bound. Default **unsynced** without `internetMessageId` or matching `message.transportId` + `messageIdHeader` row. | Live mailbox, disposable DB, real `internetMessageId` from Classic Outlook. |
| Attachment bodies | S3 via existing mail artifact readers | **Not fetched.** `bytesPresent: false`. Filename/size is identity. Missing bytes → `missing_source`. | Production-bucket reads. |
| Causal thread | Same authorised `transportId` + `threadId`, `orderCausalPreceding` (oldest first, drop later replies, drop null `receivedAt`) | Unit-tested. | Live Outlook thread vs RDS `receivedAt`. |
| Live inventory | `quoteWorkflow.runStep` → later `ai.enqueueHmsRead({ toolId: 'hms_quote_stay' })` | Returns `integration_unavailable`. Not called. | Any live HMS / Playwright PMS. |
| Qualified PDF | sibling `qualifiedQuoteProposalPdf` / `qualifiedProposalChoices` | **Not on this branch.** `bindQualifiedProposalPdf` returns `unavailable`. Prepare PDF stays `FIXTURE_PDF` (`Quote-fixture-not-live-hms.pdf`, `JVBERi0xLjQK`). | Reconciled cents PDF. |
| Native unsent draft | `CREATE_REPLY_DRAFT` then `ADD_ATTACHMENT_TO_DRAFT` | Bound in pane. Vitest mocks only. | Windows Classic Outlook add-in. |
| Staff drafts hydration | existing drafts tRPC / composer | Not rewired on this branch. | Composer autosave/refetch on Outlook pane. |

Missing backend is an honest gap, not a second engine.

## 4. analyseSelection review (this branch)

- **Auth:** `mailboxProcedure` (session + `resolveMailboxContext`). Loader filters `eq(message.transportId, ctx.activeTransportId)`.
- **Causal order:** `orderCausalPreceding` — same thread, `receivedAt <= selected`, oldest first, later replies excluded, null `receivedAt` not treated as earlier.
- **Attachments:** id / filename / `sizeBytes` / `bytesPresent: false`. Filenames are not document bytes.
- **Classifier:** `analyseQuoteSources` / client `analyseLocalEmail` are **mailbox-side regex**. They are **not** the AI reservationist. Pane banner says so when mailbox is unsynced/unbound. Local preview still drives fixture HITL when remote is unavailable.

## 5. What this branch did / did not do

**Did:** Isolated worktree from `origin/main`. HITL quoting UI. Removed leftover September calendar, NCOR/RATE_TABLE cards, and demo `quote-rate-proof.png` from the staff quoting path. Native insert uses reviewed session PDF only. Focused mail **95 PASS** (2026-10-06T02:09:50Z). Server quote-workflow **13 PASS / 2 skip** (02:09:17Z). Mail build + server `tsc` exit 0 (02:13:38Z). Mounted `OutlookPanePage` HITL dump + Chromium-1243 380×900 PNG.

**Did not:** Live PMS, S3 attachment bytes, qualified PDF, Windows Outlook, disposable-DB mailbox analysis, merge, deploy, send.

## Receipts

- `docs/plans/handoff-reports/reservationist-quote-ui-test-receipts.md`
- `apps/mail/tests/browser-quote-workflow/mounted-pane.html` (post-HITL happy-dom dump)
- `apps/mail/tests/browser-quote-workflow/mounted-pane-380.png` (unstyled Tailwind classes; content is post-HITL pane)
- `apps/mail/tests/browser-quote-workflow/mounted-pane-receipt.json`

Earlier 23:40:57Z “94 green” is **not** this HEAD.
