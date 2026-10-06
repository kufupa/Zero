# Reservationist Outlook quoting UI — handoff

**Worktree:** `/home/ubuntu/projects/zero/.worktrees/reservationist-quote-ui`  
**Branch:** `feat/reservationist-quote-ui`  
**HEAD:** `dac83c1d` + closeout ledger (04:21 harness stopped)  
**Base:** `origin/main` `2e3f1b3f` (PR #28 mailbox history/live-sync)  
**Forbidden tree:** `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools` (`feat/reservationist-backtest`) — **not edited by this executor**  
**Verdict:** Independent **UI checkpoint complete**. Live AI / S3 / PMS / qualified PDF / Windows Outlook still **unavailable**. **Not product-ready.** Do **not** mark the original overnight product goal complete. No merge, deploy, send, or PMS in this window.

## 1. Overlapping paths vs sibling

Same paths exist on **both** trees. Do not cherry-pick or copy sibling files.

| Path | This UI branch | Sibling (`feat/reservationist-backtest`) |
| --- | --- | --- |
| `apps/mail/app/(routes)/outlook-pane/page.tsx` | **Conflict.** RATE_TABLE UI removed. HITL panel. Shared `runQuoteStep` for Run next / per-step Run. Native insert requires authorised provenance. | Dirty reservationist/dashboard quoting work. Independent edits. |
| `apps/server-pilot/src/trpc/routes/workstation.ts` | Unchanged from main (old `quoteProposalPdf` unused by quoting path). | Dirty. |
| `apps/server-pilot/src/trpc/routes/quote-workflow.ts` | `runStep` accepts `inputRevision` + `inputs`, still returns `integration_unavailable`. Does **not** enqueue HMS. | Unchanged / independent. |
| `apps/server-pilot/src/trpc/routes/drafts.ts` | Unchanged from main. | Dirty. |
| `apps/server-pilot/src/quote-proposal/*` | Unchanged from main. | Dirty (`description`, `gotenberg`, `patch-sheet`, `proposal-pdf`, plus untracked `quote-lines` / `quote-revision` / `rate-check`). |
| `apps/mail/components/create/email-composer.tsx`, `thread-display`, draft hooks | Unchanged from main. | Dirty. |
| `apps/server-pilot/src/ai/reservationist-*`, `qualifiedProposalChoices`, `qualifiedQuoteProposalPdf` | **Absent** on this branch / `origin/main`. | Present (mostly uncommitted). Do not import. |

**Exact landing conflict:** `outlook-pane/page.tsx` cannot be merged as a union of both diffs. Keep this branch’s quoting contracts; take sibling runtime/PDF only after that work lands on main, then rebind adapters.

## 2. Landing order

1. **Keep UI contracts stable:** `requireReviewedNativeDraft` calls `canCreatePdf`. Selected allocations must **exactly** match each requested group’s quantity, dates, board, and child ages (no `>=` qty, no missing-date acceptance). `bindRunStep` quote_stay ok-without-offers → unavailable. `party_lookup` requires a backend `partyRef` (no invented entitlement). Rejected mutate → typed unavailable, running step released. Qualified PDF requires `centsReconciled === true` plus nonempty filename/bytes. No second engine.
2. **After sibling `quote-revision` + `qualifiedProposalChoices` merge to main**, bind `runStep` to return real `offers` and `qualifiedProposalPdf` with `centsReconciled: true`. Replace adapters only.
3. **Staff-approved live `ai.enqueueHmsRead({ toolId: 'hms_quote_stay' })`** only with a **single** PMS/browser owner.
4. **Do not merge either branch to main in this window.**

## 3. Unverified integrations

| Seam | Bind target | Overnight status | Not verified |
| --- | --- | --- | --- |
| Mailbox analysis | `quoteWorkflow.analyseSelection` (`mailboxProcedure`) | Bound. Default **unsynced** without `internetMessageId` / matching row. Local regex fills **requirement cards only**, not money. | Live mailbox, disposable DB |
| Attachment bodies | S3 artifact readers | **Not fetched.** `bytesPresent: false`. | Production-bucket reads |
| Causal thread | `orderCausalPreceding` | Unit-tested | Live Outlook vs RDS `receivedAt` |
| Live inventory | `quoteWorkflow.runStep` → later `enqueueHmsRead(hms_quote_stay)` | Client sends `stepId` + `selectionEpoch` + **`inputRevision` + typed `QuoteStepInputs`** (`stepKind`, binding, full approved groups: qty/type/adults/child ages/board/party). Server still **`integration_unavailable`**. No HMS. | Any live HMS |
| Qualified PDF | sibling `qualifiedQuoteProposalPdf` | **unavailable.** Production does **not** substitute `FIXTURE_PDF`. | Reconciled cents PDF |
| Native unsent draft | `CREATE_REPLY_DRAFT` → `ADD_ATTACHMENT_TO_DRAFT` | Bound, but `requireReviewedNativeDraft` returns null unless `canCreatePdf` is true (authorised + exact group coverage). Vitest uses authorised **test doubles**, not fixtures. | Windows Classic Outlook |
| Fixture preview | `?quotePreview=fixture` | Explicit non-production. Offers may render. Native insert still rejected. | Staff should not use this on live mail |

## 4. analyseSelection / evidence

- **Auth:** `mailboxProcedure` + `eq(message.transportId, ctx.activeTransportId)`.
- **Causal order:** oldest first, drop later replies, drop null `receivedAt`.
- **Attachments:** metadata ≠ bytes.
- **Regex ≠ reservationist.**
- **Provenance:** `results_ready` requires `{ kind, selectionEpoch, inputRevision }`. Staff edits increment `inputRevision`, **replan steps from current groups**, and clear offers/PDF/evidence/partyLookup. `pdf_ready` / `results_unavailable` are request-bound. `canCreatePdf` requires authorised evidence and selected allocations whose `coversGroupIds` cover **every stay group** with **exact** quantity/date/board/child ages. Missing dates or `board: unknown` stay unavailable. Alternatives cannot mix with allocations. Per-step **Run** shares `runQuoteStep`; rejected mutate releases running so retry works. `pickNextRunnableStep` skips succeeded. `party_lookup` success is `lookup_ready` with `partyRef` (no offers, no invented entitlement). Blank children ages parse to `[]`, not age 0.

## 5. What this branch did / did not do

**Did:** Isolated worktree. Removed RATE_TABLE UI. No fixture synthesis on production. Request-bound PDF/unavailable. HITL per-step Run; patch dates/party replans steps. Group-ID coverage; typed `QuoteStepInputs`; party lookup separate; succeeded steps not rerun. **03:50:** rejected binds caught; PDF `centsReconciled` runtime check; exact coverage; `partyRef` preserved. **04:14:** production `QuoteWorkflowPanel` hydrated in cached Chromium-1243 via Vite test entry, labelled MOCK adapter/bridge, built CSS. **Not live-ready.**

**Did not:** Live PMS, S3 bytes, qualified PDF engine, Windows Outlook, disposable-DB analysis, merge, deploy, send. **No server-pilot edits this round.** `styled-pane.html` dump remains generated/gitignored — not the React proof.

## 6. Original-scope checklist (final)

### A–E product scope (not blanket complete)

| Scope | Delivered | Safe-unavailable | Deferred |
| --- | --- | --- | --- |
| **A. Selected-email analysis** | Binding + selection epochs; pane states; mailbox `analyseSelection` bound; analysis never enqueues HMS; local regex fills cards only and is labelled | Live mailbox **ready** path (default unsynced without `internetMessageId` + matching row); S3 attachment **bytes** (`bytesPresent: false`) | Reservationist extraction in place of regex |
| **B. Editable requirements** | One card per stay group; Y-M-D dates, qty, room, adults, children ages, board, org, special requests; staff edit mints `inputRevision` and replans steps. **Chromium:** Adults 2→4 on group 1, React state, readable payload `g-double: 1 × twin, 4 adults` | — | — |
| **C. Human-approved tool steps** | Readable inputs/status; same-date groups share one `quote_stay`; per-step **Run** + Run next; `canRunQuoteStep` skips succeeded; no PDF before authorised coverage. **Chromium:** per-step Run on shared 2026-10-16→18 step | Live `runStep` / `enqueueHmsRead(hms_quote_stay)` — labelled MOCK returns `integration_unavailable` | Live party identity |
| **D. Results and evidence** | Offer cards; alternatives not summed; joint-availability copy; screenshots only if authorised else honest unavailable. **Chromium:** same-date two-group select `mix-a` + `mix-b` (third Queen unselected) | Production inventory / authorised screenshots | `qualifiedProposalChoices` after sibling lands |
| **E. PDF, reply, native Outlook draft** | PDF gated on authorised evidence + exact group coverage; native `CREATE_REPLY_DRAFT` / `ADD_ATTACHMENT_TO_DRAFT` bound, blocked without that; `requireReviewedNativeDraft` calls `canCreatePdf`. **Chromium:** unavailable → 0 offers, PDF false, nativeCalls `[]`; fixture-select PDF button **disabled** (fixture ≠ authorised) | `qualifiedQuoteProposalPdf` not on origin/main; Windows Classic Outlook insert | Live Gotenberg from authorised offers after single PMS owner |

### Real vs mocked

| Surface | Real on this branch | Mocked / double in tests | Absent |
| --- | --- | --- | --- |
| Requirement cards | Local `analyseLocalEmail` regex (labelled, not the reservationist) | Pane tests mock Outlook selection body | Mailbox `analyseSelection` ready path |
| Tool Run / next | Client `runQuoteStep` + `bindRunStep` | `runStep.mutate` returns `integration_unavailable` or test doubles | Live HMS / `enqueueHmsRead` |
| Party lookup | Typed `partyRef` preserved when backend returns it | Test doubles supply `party: { organisation, partyRef }` | Server party identity |
| Quote offers / money | Only if `runStep` returns authorised offers | `AUTHORISED_QUOTE_OFFERS` test doubles; 04:14 select scenario uses **labelled fixture** offers | Production inventory |
| PDF | Only if `qualifiedProposalPdf` returns `centsReconciled===true` + nonempty filename/bytes | `AUTHORISED_QUOTE_PDF` test double | `qualifiedQuoteProposalPdf` on origin/main |
| Native unsent draft | Outlook `CREATE_REPLY_DRAFT` / `ADD_ATTACHMENT_TO_DRAFT` commands | `sendCommand` mock in Vitest; Chromium harness never calls native | Windows Classic Outlook |
| Styled 380px PNG | Real Chromium of **static HTML dump** + built CSS | DOM events, `reactHydrated: false` | Does **not** prove React |
| Interactive 380px PNG | Real Chromium of **hydrated** production `QuoteWorkflowPanel` + built CSS | Labelled MOCK adapter/bridge. **Browser UI, not Outlook** | Live HMS / Windows native |

### Remaining blockers (exact)

1. `quoteWorkflow.runStep` still returns `integration_unavailable`. No PMS owner in this tree.
2. `qualifiedQuoteProposalPdf` / `qualifiedProposalChoices` not on `origin/main`. Client will not invent PDF bytes.
3. Mailbox `analyseSelection` default **unsynced** without `internetMessageId` + matching row. No disposable-DB proof.
4. S3 attachment **bytes** not fetched (`bytesPresent: false`).
5. Native insert unverified on Windows Classic Outlook.
6. Local regex is not the reservationist. Staff must fill dates/board when extraction leaves them missing — PDF/native stay blocked until representable.
7. Sibling `feat/reservationist-backtest` dirty on overlapping `outlook-pane/page.tsx`. Do not merge as a union.

### Screenshots: static vs React

- `styled-pane-380.png` / `styled-pane-receipt.json`: **static dump**. Built CSS inlined. Keyboard via raw DOM events. `reactHydrated: false`. Does **not** prove step Run, reducer, or React state.
- `styled-pane.html`: generated dump, **gitignored** in-place (kept on disk, not committed).
- `interactive-pane-unavailable-380.png` / `interactive-pane-select-380.png` / `interactive-pane-receipt.json` (2026-10-06T04:14:03Z): **hydrated React** in Chromium-1243 via Vite test entry `tests/browser-quote-workflow`. Built `server-build-*.css`. Labelled MOCK adapter. Adults edit → payload; per-step Run → unavailable; two-group select `mix-a`+`mix-b`; no native. **Not Outlook.**
- happy-dom `OutlookPanePage` / `QuoteWorkflowPanel` tests remain the unit coverage for rejected mutate, party lookup, PDF admission.

### Integration DTO mapping (client → existing `inputs: z.record(z.unknown())`)

Server schema **unchanged** this round (`quote-workflow.ts` still `integration_unavailable`).

| Client field | Where | Server today | Later bind (single owner) |
| --- | --- | --- | --- |
| `QuoteStepInputs.stepKind` | `runStep.inputs.stepKind` | ignored | `party_lookup` vs `hms_quote_stay` |
| `QuoteStepInputs.binding` | transport/mailbox/store/folder/entry/`selectionEpoch` | ignored | mailbox-scoped read |
| `QuoteStepInputs.groups[]` | id, arrival/departure, **quantity**, roomPreference, adults, **childrenAges**, **board**, organisation, specialRequests | ignored | quote request body |
| `QuoteStepInputs.party` | `{ organisation, partyRef }` after lookup | absent | must **not** invent entitlement |
| `RunStepResult.party` | `{ organisation, partyRef }` | not returned | lookup identity only |
| `QuoteOffer.coversGroupIds` + quantity/board/`quoteRequestKey`/childrenAges | authorised inventory DTO | not produced | coverage facts for PDF |
| `QualifiedProposalPdfResult` | `centsReconciled===true`, nonempty `fileName`/`pdfBase64` | procedure absent | `qualifiedQuoteProposalPdf` |

Rejected `analyseSelection` / `runStep` / `qualifiedProposalPdf` mutate → typed `unavailable`, never unhandled; running step released.

## Receipts

- `docs/plans/handoff-reports/reservationist-quote-ui-test-receipts.md`
- `apps/mail/tests/outlook-pane-no-fake-evidence.test.tsx`
- `apps/mail/tests/browser-quote-workflow/styled-pane-380.png`
- `apps/mail/tests/browser-quote-workflow/styled-pane-receipt.json`
- `apps/mail/tests/browser-quote-workflow/capture-styled-pane.mjs`
- `apps/mail/tests/browser-quote-workflow/interactive-pane-unavailable-380.png`
- `apps/mail/tests/browser-quote-workflow/interactive-pane-select-380.png`
- `apps/mail/tests/browser-quote-workflow/interactive-pane-receipt.json`
- `apps/mail/tests/browser-quote-workflow/capture-interactive-pane.mjs`

## 7. Checkpoint close (04:21)

Independent UI scope for this branch is **done**: HITL pane, no fixture synthesis on production, request-bound PDF/unavailable, hydrated Chromium proof with labelled mocks.

Still **unavailable** (not this checkpoint): live reservationist/AI, S3 attachment bytes, PMS/`enqueueHmsRead`, `qualifiedQuoteProposalPdf`, Windows Classic Outlook native insert.

Owned Vite 2628921/2628933 + esbuild 2628946 stopped. Port 4181 closed. `styled-pane.html` ignored, not deleted. Working tree recorded after this ledger commit.

**Do not ship. Do not merge. Product goal remains open.**
