# Reservationist Outlook quoting UI — handoff

**Worktree:** `/home/ubuntu/projects/zero/.worktrees/reservationist-quote-ui`  
**Branch:** `feat/reservationist-quote-ui`  
**HEAD:** post stale-PDF/unavailable admission fix (commit after this file)  
**Base:** `origin/main` `2e3f1b3f` (PR #28 mailbox history/live-sync)  
**Forbidden tree:** `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools` (`feat/reservationist-backtest`) — **not edited by this executor**  
**Verdict:** UI contracts exist. Production path does **not** synthesize offers/PDF. Stale async PDF/unavailable cannot mutate a newer session. **Not live-ready.** No merge, deploy, send, or PMS in this window.

## 1. Overlapping paths vs sibling

Same paths exist on **both** trees. Do not cherry-pick or copy sibling files.

| Path | This UI branch | Sibling (`feat/reservationist-backtest`) |
| --- | --- | --- |
| `apps/mail/app/(routes)/outlook-pane/page.tsx` | **Conflict.** RATE_TABLE UI removed. HITL panel. `onRunNext` / `onPreparePdf` never dispatch fixture money/PDF. Native insert requires authorised provenance. | Dirty reservationist/dashboard quoting work. Independent edits. |
| `apps/server-pilot/src/trpc/routes/workstation.ts` | Unchanged from main (old `quoteProposalPdf` unused by quoting path). | Dirty. |
| `apps/server-pilot/src/trpc/routes/drafts.ts` | Unchanged from main. | Dirty. |
| `apps/server-pilot/src/quote-proposal/*` | Unchanged from main. | Dirty (`description`, `gotenberg`, `patch-sheet`, `proposal-pdf`, plus untracked `quote-lines` / `quote-revision` / `rate-check`). |
| `apps/mail/components/create/email-composer.tsx`, `thread-display`, draft hooks | Unchanged from main. | Dirty. |
| `apps/server-pilot/src/ai/reservationist-*`, `qualifiedProposalChoices`, `qualifiedQuoteProposalPdf` | **Absent** on this branch / `origin/main`. | Present (mostly uncommitted). Do not import. |

**Exact landing conflict:** `outlook-pane/page.tsx` cannot be merged as a union of both diffs. Keep this branch’s quoting contracts; take sibling runtime/PDF only after that work lands on main, then rebind adapters.

## 2. Landing order

1. **Keep UI contracts stable:** `QuoteSession.evidence` bound to `selectionEpoch` + `inputRevision`. `requireReviewedNativeDraft` rejects fixture provenance and `Quote-fixture-not-live-hms.pdf`. `bindRunStep` ok-without-offers → unavailable. No second engine.
2. **After sibling `quote-revision` + `qualifiedProposalChoices` merge to main**, bind `runStep` to return real `offers` and `qualifiedProposalPdf` with `centsReconciled: true`. Replace adapters only.
3. **Staff-approved live `ai.enqueueHmsRead({ toolId: 'hms_quote_stay' })`** only with a **single** PMS/browser owner.
4. **Do not merge either branch to main in this window.**

## 3. Unverified integrations

| Seam | Bind target | Overnight status | Not verified |
| --- | --- | --- | --- |
| Mailbox analysis | `quoteWorkflow.analyseSelection` (`mailboxProcedure`) | Bound. Default **unsynced** without `internetMessageId` / matching row. Local regex fills **requirement cards only**, not money. | Live mailbox, disposable DB |
| Attachment bodies | S3 artifact readers | **Not fetched.** `bytesPresent: false`. | Production-bucket reads |
| Causal thread | `orderCausalPreceding` | Unit-tested | Live Outlook vs RDS `receivedAt` |
| Live inventory | `quoteWorkflow.runStep` → later `enqueueHmsRead(hms_quote_stay)` | **`integration_unavailable` / client unbound.** Production does **not** synthesize offers. | Any live HMS |
| Qualified PDF | sibling `qualifiedQuoteProposalPdf` | **unavailable.** Production does **not** substitute `FIXTURE_PDF`. | Reconciled cents PDF |
| Native unsent draft | `CREATE_REPLY_DRAFT` → `ADD_ATTACHMENT_TO_DRAFT` | Bound, but `requireReviewedNativeDraft` returns null without authorised evidence. Vitest uses authorised **test doubles**, not fixtures. | Windows Classic Outlook |
| Fixture preview | `?quotePreview=fixture` | Explicit non-production. Offers may render. Native insert still rejected. | Staff should not use this on live mail |

## 4. analyseSelection / evidence

- **Auth:** `mailboxProcedure` + `eq(message.transportId, ctx.activeTransportId)`.
- **Causal order:** oldest first, drop later replies, drop null `receivedAt`.
- **Attachments:** metadata ≠ bytes.
- **Regex ≠ reservationist.**
- **Provenance:** `results_ready` requires `{ kind, selectionEpoch, inputRevision }`. Staff edits increment `inputRevision` and clear offers/PDF/evidence. Stale results ignored. `pdf_ready` carries `selectionEpoch` + `inputRevision` + `selectedOfferIds`; reducer compares **current** session, not the React render closure. `results_unavailable` carries the same request selection/revision so a late unavailable cannot mutate a newer session. `canCreatePdf` / native insert require `kind: 'authorised'` matching current selection + revision.

## 5. What this branch did / did not do

**Did:** Isolated worktree. Removed RATE_TABLE UI. **Stopped fixture synthesis on production Run next / Prepare PDF.** Native insert cannot use fixture PDF. **PDF/unavailable admission is request-bound:** edit group, switch selection, or change selected offer while a PDF is pending rejects the old result; no native draft. Focused mail **97 PASS / 10 files** including new deferred tests (2026-10-06T02:54:41Z). Mail `pnpm --filter @zero/mail build` **exit 0** (02:58:52Z). Styled 380px Chromium with built `server-build-E6_kdtzl.css` is **prior** receipt (02:42:42Z); this rebuild emitted `server-build-z2y6fotO.css` and was **not** recaptured.

**Did not:** Live PMS, S3 bytes, qualified PDF, Windows Outlook, disposable-DB analysis, merge, deploy, send. **Not live-ready.**

## Receipts

- `docs/plans/handoff-reports/reservationist-quote-ui-test-receipts.md`
- `apps/mail/tests/outlook-pane-no-fake-evidence.test.tsx`
- `apps/mail/tests/browser-quote-workflow/styled-pane-380.png`
- `apps/mail/tests/browser-quote-workflow/styled-pane-receipt.json`
- `apps/mail/tests/browser-quote-workflow/capture-styled-pane.mjs`

Earlier 23:40:57Z “94 green” and 02:09:50Z “95 green” are **not** this HEAD (those still synthesized fixtures).
