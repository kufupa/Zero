# Compaction handoff: booking-completeness planning

Date: 2026-10-27. This is the handoff for this assessment/planning chat, not the parallel Phase 1 execution chat.

## Start here

**The assessment and proposed next plan are delivered. No product execution was launched.**
The owner asked whether to compact or write a handoff. This file preserves the state before compaction.
Continue discussion from the existing plan rather than doing another retro or source sweep.
A request to compact or preserve context is not implementation, install, deploy, flag, or send authorization.

- Working checkout: `recover-parse-failure`, branch `main`.
- Local HEAD: `92be0e5d2`.
- Last checked `origin/main`: `69ce8fc45`. Later main changes are handoff documentation; the assessed product source is still #654.
- This checkout is shared with another chat. Do not merge/reset/stash/clean it while another lane is active. Do not commit other sessions' work.
- All research and document-review agents from this session are finished. The Argon subprocess finished with quota failure. No background work from this session needs waiting or polling.

## Owner goal and scope

Original ask 275 is preserved verbatim in `docs/context/asks/2026-10-27-booking-completeness-owner-voice.md` and linked in `PRODUCT.md` and `docs/context/OWNER-ASKS.md`.

The owner accepts a longer run for the same completeness, but rejects tangents.
Priority is a complete new-booking side pane with relevant HMS fields and native Add-Ons.
They want a Pomerado Labtest trial early, current-tool integration, party/rate preparation at inbound time, editable human review, multi-room support, and amend/cancel assessment.
The couple-hour window is an allocation, not a new definition of done.

**Correction:** Extra PRs are not automatically scope creep. The classified total through #654 is 35 execution PRs: 17 original scope, 4 splits, 11 completion repairs, 2 infrastructure dependencies, 1 newly approved behavior, 0 identified tangents. The retro cutoff was 33. Later documentation PRs are not new product features.

## Delivered files

| File | Read for |
|---|---|
| `docs/plans/2026-10-27-001-booking-completeness-plan.md` | Proposed run, full target, ownership, units, tests and verification holds |
| `docs/research/2026-10-27-next-run/run-delta.md` | Exact PR ledger and latest Phase 1 handoff refresh |
| `docs/research/2026-10-27-next-run/booking-parity.md` | Current booking-field gaps and provisional seam sizing |
| `docs/research/2026-10-27-next-run/prefetch-parity.md` | Eligibility, persistence, hydration, caps and later forwarded-mail failure |
| `docs/research/2026-10-27-next-run/pomerado-trial.md` | Exact package/browser/provider/lock/readback prerequisites |
| `docs/research/2026-10-27-next-run/amend-cancel.md` | Date persistence and cancellation sequencing/approval gaps |
| `docs/research/2026-10-27-next-run/plan-review.md` | Independent review results, corrections and remaining holds |
| `docs/research/2026-10-27-next-run/plan-argon-review.md` | Required Argon review did not run because quota was exhausted |

The plan is long. Scan headings, then read Goal Capsule, the relevant unit, Verification Contract, and Definition of Done. Do not load the whole plan or all source again by default.
`docs/research/README.md` and `docs/context/ACTIVE.md` were updated for discovery.
The earlier full retro remains in the owner's existing dated retro file. Do not create a duplicate retro.

## Findings to retain

- Core child-free standard-rate create exists, but valid child-bearing creates are still refused by UI and server. Existing age editor is comma-separated. Canonical saved ages are whole years 0–17, at most nine per room row; do not silently truncate or infer child pricing from wider native technical limits.
- Native Add-Ons have no pane request, writer, or fresh native row reader. Meal plans, shuttle drafts, quoted extras and reservation notes are not native Add-On proof.
- Party prefetch includes booking intent. V2 persisted result lacks the property field required by pane hydration. Party names typed during create do not prove native party-record binding.
- The newer Phase 1 handoff reports an external booking forwarded by a hotel sender skipped by prefetch; another copy was classified other; booking name was mistaken for Company. Manual lookup took 53 seconds on that case. These are reported observations, not this session's independent runtime proof or an accuracy rate.
- Prepared availability has a pane reader, contrary to the older baseline. Pending availability does not keep refreshing. New-booking availability/rates remain excluded by quote-only preparation eligibility. Overflow can drop party/availability work.
- Supplied non-note required fields can still fail generic validation. Actual native HMS status is omitted from the saved pane receipt. Partial multi-room results must retain successful confirmations.
- Adult amend has a narrow live pass. Date Save reopened with old dates despite form changes and a bound-record experiment. Find the supported native date-change route instead of another blind fill loop.
- **Cancellation safety:** HMS became Cancelled before displaying the fee dialog. The bot left penalty Waive/OK untouched, but did not prevent cancellation. Full approved-stay snapshot is not forwarded by the current pane request. Never repeat “cancel refuses penalties” as stop-before-side-effect proof.

## Parallel Phase 1 ownership

The latest committed Phase 1 handoff was read from `origin/main` without merging it into this dirty checkout.
It reports #654 live at 11:17Z, but actual HMS confirmation arrival remains unproved.
Its first E4 attempt refused before Save because the proof runner dropped market segment and confirmation recipient.
Proof2 owns E3; booking-ui owns E4; the coordinator owns the multi-room rerun.
HRCEN cloud login/find are reported working, but cloud availability fails and the owner paused that quote work in that chat.

These are dated, reported facts, not authority transferred to this session.
Before execution, refresh only current file/slot ownership and proof outcomes through the supported Orca guide or peer session.
Do not start duplicate create/send/multi-room proofs or resume the paused HRCEN work on the strength of this handoff.

## Next-plan decisions

- Keep Phase 1's existing proof owners. Next booking area lane repairs children, required fields, native status and approved notes.
- One integration owner serializes overlapping booking UI/bind/create files. Independent new Add-On files and preparation queue work can run separately.
- Start Pomerado readiness early when the HRDAV slot is released. Pin inspected `pomerado@0.4.0-canary.439`, compatible Node and peer dependency. Use supported Playwright `launchServer`, not a custom CDP host.
- All Pomerado provider roles must use the approved Azure bridge. Non-sensitive routing smoke proof comes before any HMS observation is sent to a model.
- Acquire Nava's existing tenant/property PostgreSQL lock for the entire browser/model/write/readback window. Separate browsers or accounts are not a substitute.
- Establish native catalog, row identity, quantity/date/charge semantics and fresh readback before authoring. Mint is a live write. Guarded add/remove on Labtest A and replay on Labtest B precede pane integration. Possible commit means reconcile before retry; never recreate a reservation after Add-On failure.
- Wire every required/routinely used booking field. Inventory alone does not satisfy completeness. Remaining field work is split into evidenced one-behavior slices, not a monolithic U13 PR.
- Keep deterministic amend/cancel tools. Pomerado is the requested Add-On authoring path, not an assumed cure for native date or fee semantics.

## Review, authority and delivery holds

All seven independent Sonnet-slot max document reviewers returned. Nine reported issues were resolved through eight plan corrections, including shared-file ownership, actual field completion, rate hydration, age rules, rendered error states, authenticated approver binding, and staff-load proof.
Local plan structure and whitespace checks passed. Product tests and live canaries were not run.

**Argon review is still blocked:** Gemini 4 Argon High CLI returned subscription quota exhaustion before producing a review. No account, paid endpoint, or model was substituted to bypass it. Execution needs the required review or an explicit executing-session decision about that gate.
**Artifact URL unavailable:** Publication was refused because the session authenticates with an API key, not a claude.ai account. No URL exists and no authentication settings were changed. The repo file is the delivered plan.

Real-guest writes, new flags/configuration, installs, deployment, and HMS confirmation sends require their applicable executing-session authority. Labtest writes/read-only inspection remain generally allowed by product rules, but this planning turn did not launch them.
Never accept cancellation penalties. Never send Nava email independently. Never add/trigger GitHub Actions outside the authorized Outlook installer workflows.
Tests/typechecks use approved remote Product EC2 wrappers, never the coding VPS or pilot RDS. Both pane surfaces and current-SHA native proof remain mandatory.

Client-policy frontier: provisional guarantee/status; cancellation fee timing/charge authority; native Add-On charge/removal rules; routine additional booking fields; discount authorizers; confirmation recipients. Safe read-only/Labtest work does not wait for unrelated real-guest policy.

## Saved state and continuation

Locally modified docs: `PRODUCT.md`, `docs/context/OWNER-ASKS.md`, `docs/context/ACTIVE.md`, `docs/research/README.md`.
New local files include original ask 275, the proposed booking plan, this handoff and the bounded research/review directory.
No commit or push was made by this planning chat. Preserve these files and unrelated changes.

Existing bounded-subagent memory and evidence-backed-number memory were updated, with index pointers. Do not duplicate memories.
Brief workers with one question, exact version/files, known prior result, exclusions and owned output. Research overhead reduction was not measured; do not claim it.
No new ETA was quoted for full implementation and no ETA ledger row was opened for this assessment. The plan carries measured historical durations, not a fabricated Add-On ETA.

After compaction, read this handoff and the relevant plan sections. Continue from the owner's next instruction; do not automatically launch the proposed run or rerun completed research.
