# 2026-10-20 quote-first plan evidence

Assessment only; no product implementation, test runner, HMS browser run, deploy, env change or guest write. Current planning branch was rebased by starting from `origin/main` `9ad55993e`; unique local gateway docs commit `3dd9cfba8` preserved on `preserve/sol-gateway-docs-20261020`. Live EC2 independently checked `1181ca923b1` at 00:42:56Z.

## Decision-critical corrections

- Original 315-minute estimate was phase guesses scaled by historical actual/estimate medians. It was not measured current-path delivery. Withdraw as committed ETA.
- Existing generic quote preparation, guarded receipt reuse, rate binding, PDF/Excel generation, reviewed reply and both draft paths are present. No evidence yet justifies preassigning all proposed backend/UI fix units. One current end-to-end quote is the next execution checkpoint.
- Receipt ready is not document/draft ready. Current header marker `quotePrepared=true` is set at enqueue; succeeded/fresh/current-source is a separate gate.
- ContactBlock quote boolean is not booking routing. Actual booking preparation/rendering state must be characterized.
- UI work and Grok/Greptile can run concurrently with proof. Typecheck and remote Vitest share `/home/ubuntu/typecheck/.lock` and the same checkout, so those executions serialize despite parallel submissions. Existing remote-vitest runs typecheck first unless its supported SKIP_TYPECHECK option is used after a valid same-head result. Never change shared tooling just to claim parallelism.
- Owner-observed Sol half/third Opus speed is not a benchmark. Apply it only to coordinator-dependent work. No human engineer-days guesses used.

## Live snapshot reused

Monday SAST window: 2026-10-18T22:00Z through 2026-10-19T22:00Z. 165 inbound: quote8, new_booking19, payment_proof7, group_event6, amend2, cancel1, other_actionable9, billing15, no_action79, no successful extraction19. Latest extractor labels only, not gold. Actor_kind=user events: pane.opened134/59 items, quote.prepared6/6, field.edit19/1; user-kind includes owner/testing activity.

System staff_quote runs for Monday inbound: succeeded/ready15 distinct messages, dead_letter7, succeeded/null1. Mixed action classes; no claim of 15/8 quote coverage or completion on Monday. /proc: HMS_JOB_QUEUE=on and HMS_QUOTE_PREPARE=true on all four PM2 processes; prefetch=1 on http/worker/ai-worker and unset remote-http. Save=lab on first three, unset remote. No flag change performed.

## Time evidence and uncertainty

Source: `docs/context/ledger/2026-10-19-evening-retro.md`, ETA ledger and prior `FACTS.md` section8 proof.

- Evening six PRs through deploy: 95min elapsed. Individual small lanes13/22/41/50min; worst UI lane92min including35 rework.
- Existing quote attach-failure slice: 46min actual. Existing guest-prefetch slice64min actual. Party one-spawn slice47min actual.
- Historical one quote priced after187s; price-only anchor, not saved-draft time. Three quotes proved across11min after deploy, not isolated stage timing.
- Historical29-thread proof consumed at least135min and still had6 untested at07:00Z. Expanding proof is serial HMS work, not multiplied agent throughput.
- Latest daily same-kind medians: server0.80, UI0.81, review0.87, deploy0.83, live-HMS0.80; these calibrate comparable raw guesses, not unknown scope.

Proposed conditional planning ranges, not promises: current-path assessment15–30min; bounded small defect code+gate30–90min including real shared-gate serialization; deployment/canary roughly10–20min from recent scripts/retro but exact last-fix staff bundle wait remains event-dependent. First staff-usable quote90–180min only if defects are bounded and actual Outlook host available. Monday coverage + independent ≥10-price bar adds roughly45–120min under existing HMS timing. A wide six-hour guarantee is unsupported; deadline remains an owner-run window, not an inferred task duration.

## Alternatives and consequences

1. Current-path-first: fewest speculative edits, fastest learning. Staff may get useful quoting sooner than a full accuracy claim.
2. Safe booking preparation: actual code exists, but create class includes GDS vouchers for existing bookings. Do not prioritize from19 new_booking labels alone. Preview/save path has duplicate reader, exact digest and lab guard; children refused; real guest proof not established.
3. POP copy+lookup: small truthful-copy slice is concrete. `hms-todo-card.ts` sets writesEnabled=false yet title says Post payment. Change to Review payment proof; no money posting or HMS upload claim. Not a quote prerequisite.
4. Framework/multi-label rewrite: defer. Primary label plus associated tasks can be scoped later; do not lose owner examples.

## External cross-check

- Temporal approval pattern: https://docs.temporal.io/design-patterns/approval . General confirmation of explicit approval metadata and safe duplicate handling. No Temporal adoption implied.
- Official Git worktree: https://git-scm.com/docs/git-worktree . Clean worktree removal differs from branch deletion; preserve dirty/unique work. Orca rm help additionally attempts safe branch deletion, so backup branch saved before approved removal.
- Microsoft add-in update: https://learn.microsoft.com/en-us/office/dev/add-ins/outlook/testing-and-tips . Source addresses Office web add-ins, not proof of this VSTO bridge. Do not promise installer replacement is unnecessary until the actual native-host bridge/version is checked. New Outlook does not support VSTO: https://learn.microsoft.com/en-us/office/dev/add-ins/outlook/one-outlook . No product migration planned.

## Cost evidence

Gateway local usage.jsonl, 2026-10-19 UTC reported response_cost sums: Opus133.0138, Luna6.0538, Haiku4.1510 USD. Scope gateway only; excludes direct Codex/Cursor/Grok and other gateways. Proxy pricing not independently validated; values not complete paid totals. Therefore owner-pasted Opus~220 remains unverified rather than corrected to133.

No private mail content, credentials, database URLs or raw IDs included.

## Opus independent critique incorporated

Confirmed PDF and reviewed reply are produced inside preparePdfFor after an explicit onPreparePdf click, not background-ready. Full automaticPDF/reply target is a new bounded feature. Current priced result reuse is24h. Main target120–240min guideline has lower-bound118min calculation and may exceed240 with extraPR gates; broader proof adds60–150min. Existing clickPDF path60–150min is explicit fallback, not quiet substitution. Opus high caught overloaded first assessment, missing cross-surface generation reuse, dinner/selection blockers, native-host limitation and shared-gate serialization. No guaranteed overnight delivery.

## Owner147 correction and current-source refinement

Latest ask supersedes automatic-document target: clicking generation acceptable, reliability and editable Excel matter. Existing single-stay generation already supplies PDF+reply. Top action suppresses document stage and generator stays under step6; promote existing qualified action rather than build automatic triggers/cache. Single generation lacks combined branch in-flight guard; pending protection needed if promoted. Reducer rejects stale input/selection and preserves staff-edited reply.

Excel button uses canCreatePdf, meaning valid quote inputs, NOT generated-PDF presence. Earlier provisional claim of unnecessary PDF dependency was wrong and corrected before planning a repair. Independent workbook route does not use converter. Template sheet/workbook have no protection, generated quantity×nights×rate and total formulas/fullCalcOnLoad remain; actual desktop edit/save not proved. No Excel reimport or automatic attachment promised.

Canonical prior120–240 range superseded. Current resource formula15baseline+32UI+Gremotegate+10deploy+18canary=75+G, plus proved repairs/rework and external native/staff wait. All non-observed component timings explicitly engineering reservations, not a delivery promise. Ledger UI medians include gates in some historical rows, so pure-code calibration imperfect and doublecount avoided. Isolated remote gate latency remains unmeasured. Opus revised review pending. No product execution.

## Revised Opus high critique, verified not rubber-stamped

Confirmed: single-stay PDF request has no in-flight exclusion; combined has it; top documents action omitted. Separate reliability/pending and optional placement PRs. Existing helper catches converter/mutate errors (staff-quote-bind.ts1413–1485) and caller toasts unavailable, so reviewer’s unhandled-error claim rejected. preparePdfFor only current caller passes null, so non-selected-key branch is unreachable from current UI and not assigned a fix. Duplicate requests can repeat conversion; no verified duplicate-mailbox write follows generation alone. Add normal/HTML-fallback PDF↔workbook total parity proof and real Excel edit/recalc/save. Opus30–45minute coding guess also not adopted as evidence. All actual native/desktop/live/staff-bundle results remain unperformed.

## Owner148 product critique and first-release scope

Recommendation now one coherent reliable accessible document-action PR, not separate pending guard and top placement micro-PRs. Existing actual prices and Prepared by Nava timestamp render in Rates (quote-workflow-panel.tsx1658–1668); authority has selector built from rateCatalogue/session.rateOptions (1286) and explains filters cards below (679–728). Do not duplicate price facts or invent another rate fetch. Original ask134 retained as explicit selector/results restructuring trade. First release working estimate90min:15baseline+45wholeUIlane includingtests/review/gates+10deploy+20canary. Raw23research×.66,55UI×.81,12deploy×.83,25live×.80. Suballocations judgement only, actual native/staff wait excluded, backend faults invalidate scope. This is conditional elapsed estimate, not full quote done or guaranteed deadline. Grok independent critique in progress, no further Opus reviewer. No product execution.

## Grok final product critique reconciled

Grok4.6 headless review completed with supplied evidence only; no independent code reread. Agreed one coherent reliable accessible action PR, no automaticdocument architecture, no duplicate price display, full correctness !=button output. Suggested55min code+deploy vs90min includingbaseline/finalproof. Coordinator retained90min as explicitly conditional conservative first browser-proof estimate: quoting must include source/price/document proof, not just deployment. Actualnativehost/staffbundlewait separate. Rate selector proposed beside existing price results as next45minall-in UI guideline, existingdata assumption. Grok requested extra owner choices already resolved by PRODUCT; not treated as blockers. No further Opus call. CLI warned supplied disallowed tool aliases matched no tools, but this single-turn evidence-only response performed no tools or product edits; do not use those invalid aliases for future review permissions.

Grok critique session01a156f8-e85d-7882-b9d7-d4d906ef534f persisted one model call. grok usage reports costUsdTicks919180000, but tick-to-USD scale was not verified in this session; no dollar total claimed. Existing Sol/Luna pass cost unmetered. Proposed90minfirstrelease logged in ETAledger as proposed-not-authorized, excluded from actual calibration until execution state resolved.
