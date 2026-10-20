---
title: "fix: Prove and simplify Centurion quote review"
date: 2026-10-20
type: fix
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
approval: proposed-not-authorized
review_status: owner148-Grok-critique-reconciled
origin: docs/context/OWNER-ASKS.md
---

# Centurion quote review plan

**Recommend background facts and HMS rates, then one deliberate Prepare PDF + reply action, review and explicit unsent draft save.** The owner clarified that reliable connections matter more than eliminating the document click. Automatic PDF-on-open is no longer the target. Editable Excel remains a first-class alternative.

Owner148 asks a final critical product recommendation, not implementation. Current recommendation: one coherent reliable document-action PR, not separate guard and placement PRs. Grok owns normal final review; no routine extra Opus review.

Planning only. No product implementation, tests, live HMS browser probe, mailbox draft write, deploy, flag change or guest write performed. This document is an execution proposal, not execution authorization. Required context reused: PRODUCT, AGENTS, AGENT, ACTIVE, OWNER-ASKS, WORKSTREAMS, FACTS, MISTAKES, research README/CATALOG, prior quote-proof and queue reports. Current base origin/main9ad55993e; last independent prod snapshot1181ca923 at00:42:56Z, not current permission.

## Goal Capsule

Centurion reservationists open quote mail, check prefilled contact/party/stay and actual HMS-priced options, correct any missing facts, and deliberately generate a PDF with editable reply. They can download Excel from the same qualified quote without first generating a PDF. They review before saving one unsent reply with its matching PDF. Nothing sends; nothing books HMS from this action. Both Outlook and webmail retain the existing pane.

First useful proof and full quote correctness are different milestones. A complete current quote validates connections, not broad readiness. Full PRODUCT quote acceptance requires representative independent price truth, final-head both-surface proof and real staff bundle delivery.

## Product Contract

### Original ask and correction

OWNER-ASKS139–146 remain. New147: "PDF needs a click maybe we just put that at the very top like ‘1 click generate PDF + draft’ and get them to review it"; "my main reason of saying quote 100% autonomously is to ensure all our connections and shit work fully and reliably"; "even better would be giving them the excel so they can edit it too"; "im not too happy that u quoted smth120-240 minutes without a deeper breakdown how can i trust that?".

### Requirements

- R1. Preserve production attachment input parity, mailbox/source identity and latest qualified party/stay/rate facts. Queued is not ready.
- R2. Automatic read preparation stays. Prove current receipt consumption and staff/manual fallback; do not invent backend work from dead-letter aggregates.
- R3. A single prominent state-dependent action uses existing PDF/reply generation when quote eligibility passes. Label Generate PDF + reply, not a claim that mailbox draft was already saved.
- R4. Pending generation disables repeat clicks; failure allows deliberate retry. Preserve stale-response rejection and staff-written reply.
- R5. Review remains in existing Documents section. Explicit Save reply / Insert draft creates the actual unsent mailbox draft with matching PDF and correct thread. Nava never sends.
- R6. Excel downloads independently from the same approved quote. Verify actual edit/recalculation/save. Local workbook edits do not update Nava, the generated PDF or HMS.
- R7. Preserve all existing rate authority, override authorization, date-option and extra choices. Do not auto-pick uncertain rates or dinner amounts.
- R8. Both Outlook and webmail work. Native capability and real desktop behavior are separate from browser tests.
- R9. Keep missing-information reply, sold-out one-line decline, ambiguity and stale-rate blockers truthful. Named refusals are not priced quote success.

### Scope decisions and rejected alternatives

| Choice | Verdict | Why / fact that would change it |
|---|---|---|
| Keep background party/stay/rate preparation | Keep and prove | Waiting on HMS matters more than one generation click; fresh runtime timing could expose a concrete seam |
| Promote existing PDF + reply action | Recommended smallest UI behavior | Current top action disappears when documents become next action; generation exists in step6 |
| Automatic PDF on open with new artifact cache | Defer | No measured staff time saving; adds triggers, cache invalidation and duplicate-state complexity. Reconsider only if generation delay materially disrupts real use |
| One click generates and immediately saves mailbox draft | Not default | Hides preparation versus mailbox side effect and skips pane review. Existing explicit Save/Insert is clearer |
| Editable Excel download | Keep and prove | Existing formulas and recalculation support; no converter dependency. Staff format preference and desktop behavior still unmeasured |
| Attach Excel automatically / import edits back into Nava | Out of this slice | Current draft contract attaches PDF; import requires new trusted price/authorization/version reconciliation |
| No product change; demonstrate current chain | Strong alternative | If staff readily find current action, proof alone may be enough. Current buried next-action location is code-backed but real usability impact unmeasured |

### Staff sequence

1. Open mail. Automatic extraction/reads fill facts; say what is waiting or needs a decision.
2. Review company/agency, dates, occupancy, actual rate options, extras and total. Missing facts retain next-action priority.
3. When eligible, top primary action generates PDF and reply. Existing Documents section shows result and editable reply; no duplicate primary button below.
4. Download Excel instead if needed. PDF generation is not a prerequisite; no converter failure should disable an otherwise qualified workbook.
5. Explicitly save/insert reviewed reply and PDF into unsent correct-thread draft. Staff send manually.

## Planning Contract

### Evidence pack

- Current single-stay click already calls qualified PDF route and supplies generated reply: apps/mail/components/nava-pane/nava-pane.tsx1772–1901.
- Existing top next-action excludes documents, while step6 renders generator: apps/mail/components/quote-workflow/quote-workflow-panel.tsx1499–1545,1937–1964.
- DocumentReview uses quote eligibility for both PDF and Excel, not PDF existence: apps/mail/components/quote-workflow/document-review.tsx122–157; apps/mail/lib/quote-workflow/session.ts550–620.
- Single-stay has no shared in-flight guard; existing combined branch alone uses pdfInFlight. Raising action prominence therefore needs consistent pending protection, not just label change.
- Current pdf_ready reducer rejects stale input/selection and preserves staff edits: apps/mail/lib/quote-workflow/session.ts1966–2005.
- Excel export uses approved revision/total/file signature validation: apps/mail/lib/quote-workflow/quote-workbook-download.ts. Existing template workbook/sheet protection absent. Generated formulas and fullCalcOnLoad preserved: apps/server-pilot/src/quote-proposal/quote-workbook.ts349–435; apps/server-pilot/tests/quote-workbook.test.ts111–130. Desktop edit/save is not proved.
- PDF conversion can fail while Excel remains viable: apps/server-pilot/src/quote-proposal/proposal-pdf.ts171–228.
- Monday snapshot165inbound includes8extractor-labeled quotes and19without successful extraction. Neither is outbound gold or quote demand count. User-kind134pane-open events/59items and6quote-prepared events/6items include owner testing, not verified staff adoption. Detailed snapshot: docs/research/2026-10-20-quote-plan-evidence.md.

### First release, later work and elapsed estimate

Previous315 and120–240 automatic-document estimates superseded. Latest first release is ONE behavior: the same qualified Prepare PDF + reply action becomes accessible, pending-safe and nonduplicated. Guard plus placement are one coherent staff interaction, not separate two-gate micro-PRs. Split only if actual diff exceeds repo size or behavior boundary.

| Phase | Working elapsed estimate | Scope and evidence |
|---|---:|---|
| Current-chain baseline |15min | Raw23research ×0.66; read current failed phase, compatible receipt and converter path. Native host absence reported, not waited on |
| One UI behavior through tests/review/merge-ready |45min | Raw55code-ui ×0.81=44.55; includes focused assertion edits, remote tests/typecheck, Grok/Greptile and coordinator diff read. Comparable completed small UI lanes13/22/41min; larger92min with35rework. No second separate gate allocation |
| Authorized deploy |10min | Raw12deploy ×0.83≈10; same-path prior deploy10min. No flag flip/HMS write |
| Narrow final-head both-surface canary |20min | Raw25live-HMS ×0.80; reserve not measured complete current proof. Valid source/price/documents/reply and native draft only where actual host present |
| First-release longest dependency chain |90min working estimate |15+45+10+20. This includes diagnosis and final browser proof; Grok suggested55min code+deploy only, which is not verified quoting and is not called done |

Raw55min all-in UI lane comprises pending/ref/finally and ownership10; reuse top callback/remove duplicate8; focused assertion/regression edits12; same-head remote gates + Grok/Greptile/coordinator review25. These are judgement suballocations; isolated gate timings unknown. Apply one whole-lane median because historical code-ui rows contain gates. Do not multiply lower-level durations again or charge gates twice. Review and remote work overlap within lane where possible; shared EC2 test/typecheck lock still serializes executions.

At baseline, a backend/price/binding/converter fault changes scope: name failed seam and revise longest-chain estimate before adding repair. Native desktop/Excel availability and actual staff bundle load are event-dependent and excluded from90min. Until those are observed, claim final-head browser functionality only, not complete delivered native/staff acceptance. No guarantee of production-done at90min.

Recommended next UI behavior: put existing rate selector beside existing priced rate results, so Rate authority is no longer a generic disconnected step. Reuse current rateCatalogue/session.rateOptions and bound result; preserve HMS notes, contract/BAR/government choices and discount authorization. One rate decision and one price display, not cloned price cards. Original134 is preserved and addressed by proposed restructuring, not silently deleted. Working incremental allowance45min through tests/review from raw55×.81, conditional on presentation-only work with existing data; a missing-data backend seam changes scope. This is separate from first useful document-action release, not added invisibly.

Full quote price proof is subsequent acceptance work, not hidden inside20min canary. Minimum10 independent plannable real asks per PRODUCT, every plan/nightly price exact with HMS-side reasons for differences; false negatives outside quote folder checked separately. Historical187s price read implies31min for ten fresh reads alone; historical29-thread proof took≥135min and remained incomplete. Full workflow elapsed ETA unresolved until truth locators/input availability and first actual failing classes known. No broad accuracy claim from model-labeled cohort; ≥100truth-row policy applies to broad accuracy rates, not every functional button release.

Monday snapshot165inbound includes8model-labeled quotes and19without succeeded extraction, not actual quote demand. User-kind6quote-prepared events/6items include testing, not verified staff adoption. Minutes saved unmeasured; qualitative return is fewer manual HMS searches/rekeying and reliable review. Actual routed model API cost unavailable for this pass; Grok persisted usage will be reported only if session accounting yields it. No invented cost estimate from unverified CLI model prices.

### Parallelism and ownership

Luna max owns one small UI behavior in a clean named branch/worktree after authorization. Grok/Greptile exact-head review can overlap remote gates. Grok handles normal final product/code review, Greptile remains PR gate, Sol coordinates and reads every product diff. No routine extra Opus reviewer. Existing executing-session authority and specialized live-operation rules remain separate; this review change grants no deploy/HMS permission. One coordinator owns HMS browser; subagents never drive it. Baseline can overlap non-runtime source/test preparation, not conflicting HMS use. No new Actions, shared-tool edits, local test runners, typecheck or extra heavy installs.

### Preserved work

Pre-read rates in Rate authority remains ask134, planned explicitly as U6 after connection proof; do not silently append it to the small action PR. Shuttle/extras136, accepted booking summary137, login reuse132, create/amend/cancel, POP versus voucher/upload/payment, compound tasks, group≥12, GDS both hotels128, classifier feedback/D5 and Exa tooling remain parked. Starting one trades time explicitly, never silently grows quote scope.

### Proposed units and priority

| Unit | Requirement completeness | Working ETA | ROI | Models / hold |
|---|---:|---|---|---|
| U1 bounded current-chain baseline |10/10 bounded diagnosis |15min | Highest, prevents speculative repairs | Sol coordinates; deterministic authorized HMS owner; no live execution approved |
| U2 reliable accessible document action |10/10 specified action |45min all-in to merge-ready | High, directly usable safe quote output | Luna max writer; Grok final review; Greptile gate; build authorization |
| U4 existing Excel and draft proof |10/10 declared evidence |20min narrow canary allocation; actual desktop wait excluded | High, staff-useful documents and correct-thread draft | Existing deterministic/host path; actual Outlook/Excel needed |
| U5 authorized deploy + full verification |10/10 specified delivery gates |10min deploy; wider price bar unestimated | Required, not new feature | Exact-head gates included U2; staff bundle event separate |
| U6 existing selector alongside real price results |10/10 specified behavior |45min incremental all-in guideline, presentation-only assumption | Medium/high clarity, one rate decision not duplicated facts | Luna/Grok, shared-file queue; preserves original ask134 |

Completeness measures proposed requirement coverage, not observed product correctness. All units unexecuted. Actual API$ by routed model unmetered; Grok price/accounting not assumed.

## Implementation Units

### U1. Prove present quote chain and identify actual failing seam

Requirements:R1/R2/R5/R8/R9. Dependencies:none. Kind:bounded learning, no product change by default.
Files: apps/server-pilot/scripts/nava-quote-proof.ts; apps/server-pilot/scripts/nava-quote-proof-result.ts; docs/research/2026-10-20-centurion-quote-proof.md.
Use current runner/DOM probe and production attachment+prompt inputs. Read-only DB separates admission, queued, lock wait, party, rate, persistence, pane binding and converter failures. Source snapshot counts are not evidence of a generic network fault. Trace one representative complete current quote through selected facts, fresh/compatible receipt, price, PDF, workbook and editable reply. Check native bridge capability availability without claiming successful write. Actual mailbox save needs scoped execution authority and real host, not a read-only proof script. Missing native/Excel host is reported promptly, not allowed to consume the bounded baseline.
Acceptance: identify exact working/failing seams and phase elapsed times; preserve source/revision identity. No fixture PDF, body-only replay, obsolete selector, named refusal or pre-deploy open counts as present success.

### U2. One reliable accessible qualified document action

Requirements:R3/R4/R5/R7/R8/R9. Depends:U1 verified current generator or isolated unrelated seam. ONE behavior PR. No automatic generation/cache, backend rewrite or second placement PR by default.
Files: apps/mail/components/nava-pane/nava-pane.tsx; apps/mail/components/quote-workflow/quote-workflow-panel.tsx; apps/mail/components/quote-workflow/document-review.tsx; apps/mail/tests/outlook-pane-quote-pdf.test.tsx; apps/mail/tests/quote-workflow-panel.test.tsx; apps/mail/tests/quote-workflow-session.test.ts.
Reuse onPreparePdf and current canCreatePdf/pdfBlocker. Expose top Prepare PDF + reply only at eligible stage, not ahead of missing questions. One live request at a time for single/combined with visible pending and operation-appropriate cleanup; normal backend error already catches/returns unavailable and caller warns. After success, top action reviews existing documents. No duplicate generator below while top owns it. No source/date/rate edit may accept old async response; preserve staff-edited reply. Do not reset global pending so old request completion permits parallel newer generation.
Scenarios: eligible callback once; missing/stale/dinner blocks; doubleclick one request; failed converter releases retry while qualified Excel remains; switch mail/date/rate before result rejects stale response; edited/cleared reply preserved; every combined stay rated; no mailbox command until Save/Insert; no duplicated primary/generator. Existing normal/safe manual fallback retained.

### U4. Verify existing editable workbook and draft contracts

Requirements:R5/R6/R8. Depends:U1 data; can prepare non-overlapping assertions alongside U2, no conflicting writer.
Files: apps/mail/tests/quote-workbook-download.test.ts; apps/mail/tests/quote-workflow-native-draft.test.ts; apps/mail/tests/outlook-pane-quote-pdf.test.tsx; apps/server-pilot/tests/quote-workbook.test.ts; apps/server-pilot/tests/save-reply-draft.test.ts; apps/mail/components/nava-pane/use-insert-ai-draft.ts as existing pattern, not planned rewrite.
Scenarios: Excel succeeds without a generated PDF and when converter unavailable; PDF/workbook totals agree in normal conversion and HTML fallback; correct revision/contact/dates/nightly rate/quantity/total; workbook formulas recalculate after one local quantity/night/rate edit and save; no HMS/server/PDF mutation from workbook edit. Actual unsent mailbox draft has reviewed HTML/PDF and correct thread; attachment-only retry keeps same operation/PDF; ambiguous outcome no blind fresh duplicate; existing hand-edited draft needs explicit replacement confirmation.
Acceptance: open/edit/recalculate/save on real Excel-compatible desktop where available; package inspection alone is capability evidence, not desktop proof. Preserve unsupported status if native environment absent. No promise auto-attaching Excel or importing changes.

### U5. Exact-head gates, authorized deploy and final evidence

Requirements:R1–R9. Depends:applicableU2 andU4. No deployment needed if U1 proves current behavior and no change.
Files: focused tests named above; apps/server-pilot/tests/hms-jobs.test.ts and prepared-quote-attach-retry.test.ts only if a demonstrated backend defect requires separate PR; docs/research/2026-10-20-centurion-quote-proof.md; docs/context/ACTIVE.md.
Use existing remote same-head typecheck/Vitest, targeted oxlint, exact origin/main Greptile plus coordinator diff review. Serialize shared clone even if requests submitted concurrently; SKIP_TYPECHECK only with verified same-head setup and valid preceding result. Never edit shared wrappers. Current P0/P1 fixed before merge. Authorized deploy only from recover-parse-failure, record last-good first; final viewer/document/draft checks both surfaces after last fix. Actual staff bundle load is separate asynchronous gate. No GitHub Actions.

### Conditional repair units, not assigned speculative tasks

If U1 proves a broken ingress/receipt/binding/price/converter/native seam, create one explicit behavior/test/PR at that exact source. For existing prepared quote paths use hms-jobs.ts, workstation.ts, staff-quote-bind.ts and relevant focused tests as patterns. Need causal evidence, input parity, same failed class reproduced and final-head proof. Do not flip flags, change24h reuse, rewrite matcher/login, or invent network diagnoses from defaults. Re-estimate Delta before execution of new scope.

### U6. Place existing rate selection beside current pre-read HMS prices

Requirements:R2/R7/R8. Original ask134. Depends:U1 validates current rate binding; U2 shared-file ownership released. Separate behavior PR, not required to claim existing rates can be quoted.
Files: apps/mail/components/quote-workflow/quote-workflow-panel.tsx; apps/mail/lib/quote-workflow/staff-quote-bind.ts as current preparedAt/preparedByNava data pattern; apps/mail/tests/quote-workflow-panel.test.tsx; apps/mail/tests/staff-quote-job-bind.test.ts.
Use actual current scoped rate data in selector and existing Rates step. Keep prices and observation age once in existing rate results. If original ask134 needs prices nearer selection, move/combine existing selection and results deliberately rather than copy same prices into another panel. Owner-approved original ask is not silently changed; proposed restructuring must be explicit. Preserve manual/one-off/saved choices and discount authorization. No fixture pricing, entity special cases, new HMS requests just from rendering, or blanket auto-selection. Exact available price shape must be checked against current bound result before field-level implementation; absent nightly breakdown stays absent, not reconstructed from totals.
Scenarios: compatible prepared result visible; pending/refused/missing result has truthful state; source/party/date/occupancy/meal edits invalidate old display; changing authority follows current approved rerun path; no duplicate rate facts in separate places; saved/manual discount still requires authorizer; both surfaces share same behavior.
Time/cost:45min incremental working allowance raw55×.81 through focused tests/review, only presentation restructure using existing rate data. Not included in first90min release. Re-estimate if existing bound data cannot support the selector. Qualitative high value if staff currently re-search or cannot see already-read rates; current staff minutes saved unmeasured. Luna max implement, Grok/Greptile review, Opus delivery; actual API$ unmetered. Build authorization and shared-file queue remain holds.

## Verification Contract

| Outcome | Required evidence |
|---|---|
| Connections work for sampled request | Source/attachment parity; one identity/revision through read, pane price, PDF, Excel, editable reply and correctly attached unsent draft |
| Price correct | Independent staff outbound/PDF plus read-only HMS reason for differences; per-night plan/rate and totals, not model labels |
| Safe UI change | Actual both-surface state transitions, pending/failure/stale/edit tests and final-head viewer green |
| Excel editable | Actual desktop open/edit/recalculate/save; generated file is unprotected and formulas preserved |
| Delivered to staff | nginx staff bundle load after last deploy, not owner/test runner load alone |
| Full quote acceptance | All plannable representative ≥10price requests pass; missed-action coverage checked; no wrong bind/rate/document/thread |

## Definition of Done

Do not call merged/deployed/tests green full quote done. First functional proof is narrow progress. Full quote bar remains PRODUCT's price correctness and both-surface live proof after last fix, with genuine staff bundle delivery. Report unsupported native/desktop evidence explicitly. Ready-before-open, converter readiness, downloaded workbook and saved mailbox draft have different denominators.

## Appendix

- Opus5.5 high reviewed latest click-first plan. Verified confirmed single-path duplicate-request/pending gap and buried document action. Rejected reviewer’s unhandled-error claim because bindQualifiedStaffProposalPdf catches backend errors and existing caller warns. Non-selected-key branch has no live caller and is not a product-repair task. Earlier critique suggested split reliability from placement; latest product review recombines them into one coherent small action PR. Retain converter/fallback price parity and real desktop proof. Rejected reviewer’s unsupported30–45-minute build range as well as old95-minute total. Review is evidence, not authorization.
- Cleanup already complete: five merged-clean Orca trees removed with archive branches; three parent untracked docs copied byte-exact and tar-backed. Dirty triage/disk-retention/mainWIP, open handoffPR420 and deployment tree preserved. Do not repeat cleanup.
- Latest Grok critique used supplied source evidence, not an independent repo reread. Agreed one action PR, rejected duplicate rate display and full-quote claim. Reviewer suggested55min code+deploy; coordinator keeps90min conservative connection-check/release guideline because first useful quote must include diagnosis and final proof. Native/staff event wait and full price correctness remain outside that estimate. No unsound prerequisite questions added: readiness-gated button, both surfaces, no sends and truthful quote prices already specified.
- Research evidence: docs/research/2026-10-20-quote-plan-evidence.md. No share page published because current API-key session cannot authenticate Artifact publishing; do not retry without changed login.
