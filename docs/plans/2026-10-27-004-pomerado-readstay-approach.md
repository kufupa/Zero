---
title: Pomerado read-stay trial approach
date: 2026-10-27
execution: knowledge-work
---

# Pomerado read-stay trial approach

**Historical approach:** Its earlier timing estimate and routing are superseded by `docs/plans/2026-10-27-006-pomerado-read-trial-model-plan.md`. Retained for audit history.

## Goal

Evaluate whether Pomerado can build and run a read-only HRCEN reservation lookup from a plain-language request. Test three reservations against the actual expanded Record View. Report coverage, time, model cost, failures and a good, mixed or bad verdict.

## Owner instructions and boundaries

- Use Pomerado's documented MCP workflow. Do not build a custom integration harness.
- Run the browser on Product EC2. Keep credentials, guest data, raw output and screenshots under `.private/pomerado-readstay/`.
- Use only the owner's approved Azure models. The latest instruction routes all Pomerado roles to GPT-6.1 Terra at xhigh.
- HMS reservation actions remain read-only. Do not send mail, modify bookings or accept penalty dialogs. Use Labtest reservations where practical.
- The owner permits Chromium and login changes and temporary production-pipeline interruption for this trial. Take and verify the HRCEN property lock first. Restore the slot and release the lock on every exit.
- The original trial deadline of approximately 15:50 UTC on 2026-10-27 has passed. Do not reuse it or impose an early coordinator cutoff on a future run. A complete, honest blocked result beats an unverified success claim.

## Evidence to reuse

- The current trial and its private evidence are indexed in `docs/research/2026-10-27-pomerado-readstay-test.md`. Earlier source-only findings are in `docs/research/2026-10-27-next-run/pomerado-trial.md`.
- Node and Pomerado are installed on EC2. Their Chromium cache is separate from the production slot cache. Do not repeat the system dependency installation without a demonstrated need: it upgraded system packages and restarted the Da Vinci slot.
- Azure rejected Pomerado's 12-hour cache breakpoint. An otherwise equivalent 30-minute request passed. The isolated installation was adjusted for the minter, Guardian and outcome reviewer. A later mint advanced beyond that rejection, but has not published.
- One mint started at the HMS host root, reported a 404 at sign-in, received the configured tenant login URL and stopped without retrying sign-in. A later mint used the configured URL but was cancelled at an early coordinator checkpoint without a terminal Pomerado result. Do not start competing mints or browsers while a property guard is held.
- Direct HTTP checks of the configured login produced different results between clients. A successful HTTP status is not proof that Chromium reached an authenticated HRCEN Guest Stay screen.
- The existing lookup runner at `apps/server-pilot/tooling/playwright-quote/stay-lookup.mjs` captures a record screen, but has not been shown to expand every section. Treat it as a possible independent reference, not complete field-coverage proof.

## Approach

1. **Check for existing work first.** If a guarded mint is already running, observe its existing MCP job and answer login questions from the private credential file. Do not restart or duplicate it. A job status of `completed` is not a published integration; check the build outcome and artifact.
2. **Check setup before a new mint.** Confirm the correct tenant entry, property lock, isolated browser cache, Azure role routing and 30-minute cache setting. Do not run a separate manual login preflight by default. The prior HTTP 200 with no visible password input did not prove the Pomerado login would fail.
3. **Mint through Pomerado.** Give it the correct tenant URL, the original read-only request and example input through its standard MCP tools. Let Pomerado navigate and sign in; answer its credential questions through the approved private client flow. Investigate the actual login or provider error only if this attempt fails. Preserve diagnostics and usage privately. Inspect the published artifact and authority before running it; do not change generated source to conceal an unsafe action.
4. **Run three cases serially.** Register the published integration using its generated instructions. Use the integration's own MCP server, job tracking and credential prompts. Record start, finish, outcome and output for each case privately. A failed case is reported as failed, not silently dropped.
5. **Compare with HMS, not another model.** Independently inspect each matching Record View, including collapsed sections after expanding them. Record a field inventory and compare returned names and values with the screen. Keep screenshots and raw values private. If a section cannot be opened or independently checked, mark coverage unknown rather than counting it as a match.
6. **Close and restore.** Stop trial browser and controller processes. Release the advisory lock. Verify HRCEN and any other interrupted slot are active, the lock session is gone and affected application processes are online. Update the trial report with the exact results, measured durations and cost by model; mark unobservable usage unknown.

## Our work versus Pomerado's work

| Work | Owner and size | Boundary |
|---|---|---|
| Product code for this standalone read trial | **Target: 0 new repo product LOC.** | The existing lookup can help independent reference, but is not the Pomerado integration and has not been proved to expand every section. |
| Integration operation | **Pomerado generates it; LOC unknown until publication.** | No hand-written integration operation or custom integration harness. Inspect the produced source, schema, permissions and destination before running it. |
| EC2, client, browser, model and lock setup | Prior trial used isolated Node, Pomerado, browser cache, client config and a property-lock guard. **Target: reuse; no fresh LOC promised.** | Historical setup is not proof it remains ready. Recreate only safety/configuration needed for this run; any additional guard lines are unmeasured and not a new integration harness. Do not repeat system-wide dependency installation without evidence. |
| Provider compatibility | Prior isolated install changed model and reasoning settings and four cache-breakpoint occurrences. **Target: 0 additional edits if still valid.** | Previously accepted Azure canary does not prove end-to-end mint. Total prior changed LOC was not independently counted. Do not patch blindly. |
| Prompts | One plain-language mint brief, one reusable instruction for the three calls, plus answers requested by the job. | Counts are planned interactions, not a guarantee of no follow-up. Keep confirmation identifiers and outputs private. |
| Verification | Three serial read calls, three independent expanded-screen inventories, value comparison, timings, costs and cleanup. | New automated test code is not required for this standalone experiment. Record coverage and any inaccessible section honestly. |

### Plain-language mint brief

Create a read-only HRCEN integration at the configured tenant URL. Find the reservation matching the provided confirmation, open its Record View, expand all collapsed sections, and return every displayed field label and value, including repeated rows. Mark unavailable fields or ambiguous matches rather than guessing. Login, searching and expanding views are allowed; creating, editing, cancelling, sending or other reservation writes are not. Supply example inputs and credentials through the existing private, approved client flow, not the written plan.

### Reusable run and comparison instruction

Call the published integration once for each of the three private test confirmations. For each, independently inspect the same reservation in HMS, expand its Record View sections, inventory visible field labels and values, and compare them to output. Report matched, missing, wrong, additional and uncheckable fields, along with duration and outcome. Never count an inaccessible or uninspected section as complete. A wrong reservation is a failure regardless of aggregate coverage.

## Booking and Add-On scope is separate

The read trial does not deliver staff booking or prove the second hotel. The owner wants Pomerado to lead the eventual booking operation layer for both properties; do not silently substitute a different architecture or a fallback. The separate product work includes property-specific read/create/rate/agency/Add-On operations; a shared typed booking contract; existing pane and extraction changes; property-scoped locks and credential routing; staff approval and Labtest-only write gates; duplicate-safe commit, independent readback and uncertain-write reconciliation; both surfaces; and property-specific live proofs. See `docs/plans/2026-10-27-003-new-booking-pomerado-shape.md`.

Pomerado's documented write mint actually performs the write once. A later replay is another write, not a free dry run. Use only approved Labtest records and reconcile an uncertain result before any retry. The documented runtime does not enforce mint authority at run time, so a reviewed artifact alone does not replace Nava's execution gates.

Historical source-only sizing at checkout `92be0e5d2`, not a current diff: one multi-room receipt-key correction was guessed at 15–25 product LOC plus 20–30 test LOC in `docs/research/2026-10-27-next-run/ask280-lanes.md`. An earlier, narrower Add-On wrapper was estimated at 120–200 product LOC plus 80–120 test LOC in `docs/research/2026-10-27-next-run/pomerado-trial.md`; it is not a size for the whole Pomerado booking product. The full product LOC, complete prompt count, and elapsed ETA remain unmeasured. Estimate them after a successful read mint and a current-source review of the selected runtime contract, not by multiplying this trial's 65-minute estimate.

## Operational and privacy gates

- Treat the previous active slots and released lock as historical observations. Before touching the hotel, confirm no competing operation owns the HRCEN lock; use the same lock domain for the isolated browser and restore any interrupted slot on every exit.
- Use the tenant login and configured view-only account, but do not claim account enforcement was tested. Pomerado handles authentication during minting; confirm it reaches the intended property. Inspect frames and redirects only if the attempt exposes a real login problem.
- Keep credentials, guest values, captures, output and raw logs under `.private/pomerado-readstay/`; report only safe counts and outcomes. Pomerado's client documentation says answers to `provide_input` are visible to the MCP client and its model provider. Verify both client and all Pomerado model roles use the owner's approved Azure route before supplying sensitive input.
- `completed` alone does not mean published. Verify the build result and artifact. The upstream documentation says generated runs do not enforce the mint authority, and generated source has local process privileges; inspect both before any run. Do not switch to write authority during this trial.
- Stop at an evidence-backed blocker, not an arbitrary early coordinator checkpoint. Release the named lock, stop only trial processes, restart HRCEN and verify all interrupted services. No reservation writes, messages, production deploys or flag flips are part of this plan.

**Source:** Pomerado's pinned `0.4.0-canary.399` README at https://unpkg.com/pomerado@0.4.0-canary.399/README.md. The login-input visibility warning is also in https://raw.githubusercontent.com/Pomerado/pomerado/main/docs/agent-setup.md; confirm any version-specific differences before execution.

## Acceptance and failure handling

| Check | Pass | Otherwise |
|---|---|---|
| Publication | Integration artifact exists and declares a read-only operation. | Report the actual Pomerado job and build result. |
| Calls | Three distinct inputs finish and their durations and outcomes are recorded. | Report each unrun or failed case. |
| Screen comparison | All displayed fields, including expanded sections, have a counted, independent comparison. | Report the coverage gap and do not assert completeness. |
| Safety and cleanup | No reservation write or send; private data remains private; interrupted slots active and lock absent. | Stop and document the specific unverified or failed check. |
| Cost and time | Report measured setup, mint and per-call durations and model spend by model. | Label missing usage or call times unknown. Gross controller estimates are not total billed spend. |

## Timing and cost

The original deadline was 15:50 UTC and is not the next run's cutoff. The revised **65-minute expected elapsed estimate** covers the read-only trial from starting to three independent screen comparisons and cleanup. The prior 90-minute plan added an unnecessary separate manual login step: Pomerado's documented workflow handles sign-in as part of minting. The earlier correct-tenant mint was cancelled, not proven to fail, and no successful mint or comparison has been timed.

| Work | Raw estimate | Calibrated, rounded |
|---|---:|---:|
| Check the existing isolated setup, acquire the lock and pause the HRCEN slot | 5 min | 5 min |
| Pomerado signs in, mints the read-only integration and produces a reviewable artifact | 25 min | 20 min |
| Run three serial cases and independently compare expanded HMS fields | 35 min | 30 min |
| Restore the slot, release the lock, verify recovery and report | 10 min | 10 min |
| **Total** | **75 min** | **65 min** |

The `live-hms` ledger median was 0.88 across 35 completed records: 75 × 0.88 = 66 min, rounded to 65 min. The intermediate estimate to a published integration is 30 × 0.88 = 26.4 min, rounded to 25 min. Setup to the first mint previously took 11.3 min including earlier setup work; the last completed mint took 7 min but failed. Pomerado documents 20 minutes of active mint work, with input waits additional. No successful mint or call was measured.

This forecast assumes the previously installed setup is still usable and a single mint succeeds. Login diagnostics, extra mint attempts, and missing or incomplete screenshot/field evidence are not silently counted as success. Pomerado signs in again for signed-in integration calls; prepare comparison material while minting, but keep hotel browser work serialized. If Pomerado fails to sign in, diagnose the actual failure then. Do not impose an early coordinator cutoff. The estimate is not for full booking or production delivery.

Known gross controller and diagnostic estimates from the closed trial were Terra $7.496204 and Luna $0.000003. Pomerado's internal model usage and interrupted usage were unmeasured, so these are not total trial cost or a price for another attempt.

## Deliverables

- Update `docs/research/2026-10-27-pomerado-readstay-test.md` with the final table and verdict.
- Keep its entry in `docs/research/README.md` accurate.
- Reply `LANE DONE` only if the actual trial passes. Otherwise reply `LANE BLOCKED` with the evidence-backed reason and unfinished checks.
