---
title: Pomerado read-stay model and trial plan
date: 2026-10-27
execution: knowledge-work
---

# Pomerado read-stay model and trial plan

**Status: planning only. Await owner confirmation before any model configuration, call, browser access or trial execution.** This supersedes the retry approach in `docs/plans/2026-10-27-005-pomerado-setup-debug-plan.md`, not the full trial goal.

## Decision and scope

Recommend **GPT-6.1 Terra xhigh for every role**: outer MCP controller, Pomerado's internal authoring minter, Guardian and outcome reviewer. The controller and Pomerado's minter are separate roles; a controller model setting alone does not select the minter. The read-only installed-role audit reports Terra xhigh configured for these roles. Per-call model and effort metadata were not retained, so configuration is not proof of every effective call. `xhigh` is an effort setting, not a model ID. This plan does not authorize a model or configuration change.

Why: the minter must explore, reason about login and generate code. Independent [Artificial Analysis comparisons](https://artificialanalysis.ai/models/comparisons/gpt-6-1-terra-xhigh-vs-gpt-6-luna) report Terra xhigh ahead of Luna max on agentic terminal coding and business-software workflows. The previous trial already used the Terra family, so preserving that routing while removing the contradictory prompt avoids adding an unnecessary model-switch variable to the diagnosis. Those benchmarks are not Pomerado or HMS, and do not establish that Terra will succeed, save time or produce fewer Guardian false denials. Luna remains a lower-list-price alternative for either the controller or minter; actual Azure billing and per-role performance remain unknown. Do not silently change provider, disable Guardian, or use an unapproved model. If the recommended route is unavailable, report the constraint rather than silently substituting a role or provider.

**Full original goal:** Pomerado independently authors and publishes an HRCEN read-only stay lookup, then runs the three specified confirmations. Compare every displayed field and repeated row against an independently inspected, expanded Record View for the same confirmation. Report per-case correctness, coverage, time, cost and failures. Do not substitute a smaller public smoke for the HMS trial or claim the eventual booking/Add-On feature is delivered.

**Allowed only after confirmation:** private, read-only HRCEN work under the hotel lock and the existing approved Azure route. Pomerado handles its own login and authoring through the documented local MCP workflow. No custom integration harness, real-guest write, email send, production deploy or flag flip. Pomerado may require the previously authorized temporary slot interruption; restore it and release the lock on every exit.

## Evidence and unresolved cause

- `docs/research/2026-10-27-pomerado-readstay-test.md` records Guardian denials of broad exploration and unconfirmed sign-in. It does not prove credentials were rejected or received by HMS. The last actual brief contained contradictory URL-check guidance; its causal effect is unknown.
- Independent Chromium authenticated and opened all three matching confirmations. That proves neither Pomerado authentication nor full Record View coverage. Two expanded panels and DOM counts are not a complete field inventory.
- The isolated package is Pomerado `0.4.0-canary.399`. Prior isolated changes include Azure 30-minute cache compatibility and a private outcome-capture patch. Preserve those and their backups until a deliberate closeout. Neither a successful Azure request nor job status `completed` establishes publication.
- `docs/research/2026-10-27-pomerado-model-routing-research.md` records official model, API, price and vendor references. Current upstream guides and Cloud-only parameters must not be assumed to match the installed local MCP version. Current upstream says signed-in read builds are judged on one example, which is another reason not to substitute publication for our independent three-case proof.
- The owner is right that the core task was already tried. Actual private mint intents for mint7, mint9 and mint10 all requested a read-only confirmation lookup and displayed fields. Mint9 already mentioned the text-type password field; mint10 already restricted tabs and requested an exact match. Its additional contradictory URL instruction is removed. A fuller navigation hint is a practical change, not a proven login fix.
- The existing header Quick Search can use an arrival or bounded date hint for its search window; the confirmation number, not the hint, identifies the stay. Two initial reference searches missed without date hints. Reuse private hints already found, but do not hard-code a guest or mistake a hint for the actual arrival.
- Retaining Terra avoids a model-switch variable, but the expanded prompt and any changed setup or safety controls still make the next mint a practical recovery experiment, not a controlled comparison. Diagnose errors from their actual evidence. Choosing the Luna alternative adds another variable.

## Execution sequence after approval

1. **Minimal readiness.** Reuse the existing isolated installation, Azure/Terra configuration and private diagnostic capture. Check the approved private route, tenant, property lock and service state. Verify effective read-only enforcement for all mint and generated-runtime execution paths, including direct requests as well as browser actions. Prefer existing server-enforced account permissions or an independently enforced equivalent covering the entire process tree. Guardian remains enabled. The reference browser's partial guard and a `view_only` label alone do not prove this restriction. Before sensitive input, verify an effective private-data boundary for mint and runtime processes and redirects, including destination controls for the approved Azure route, the configured HMS site and any necessary trusted endpoints. Verify restrictive private-file permissions and trial temporary/log destinations. If a required boundary cannot be established, report the blocker rather than use real guest records or add an unapproved harness. No public-site example or dependency reinstall.
2. **Mint our task directly.** Acquire the same PostgreSQL advisory property lock used by production HRCEN readers. One real holder retains its connection throughout mint, reference capture and generated calls. Verify ownership before each browser phase and stop hotel work if the holder is lost. A parent token alone is not proof that a real holder remains. Stop only conflicting processes if needed. Give Pomerado the exact tenant URL, private credentials, one actual confirmation example and the fuller brief below. Let it handle login, navigation and authoring through its normal local MCP flow. Keep all raw trial data private. Do not cancel a progressing mint at an invented early checkpoint.
3. **Prepare proof while it mints.** Work offline on existing private reference screenshots and inventories: mark which tabs, checkbox states, rows and sections are missing, and prepare the comparison layout. Do not open a second HRCEN browser or treat the existing partial captures as a complete, current answer key.
4. **Review and complete references in parallel after publication.** A private reviewer inspects the generated artifact's schema, tenant binding, credentials handling, requests, exact-match behavior and side effects. Before any model review, remove credentials and unnecessary guest data from the review input while retaining relevant logic. If it cannot be safely redacted, do not send it for model review. Use only the approved Azure route. The operator confirms these findings and the runtime restriction before any generated call. In parallel, the sole HRCEN browser owner captures any missing independent reference views for all three cases. Reuse old captures only if completeness and freshness can be established; otherwise inspect the screen. The reviewer reads saved source without accessing the hotel browser; an Azure model review is a network call, not offline execution. Never send guest data or credentials to Greptile.
5. **Run and compare.** After review passes, invoke the generated operation for each exact confirmation as its only required input. Do not hard-code example confirmations, guest details or dates. An optional date hint may assist authoring or reference search, but a call that requires a hint does not satisfy the original confirmation-only acceptance. Compare each result against its independent reference, preserving section and repeated-row identity, blank values and visible checkbox/radio states. Pipeline offline comparison of a completed case with the next browser action, but never run two HRCEN browser operators at once. If a mismatch requires another screen inspection, reacquire exclusive browser access. Missing, incorrect, unexpected or uncheckable data is a trial gap; report it, do not infer a pass.
6. **Diagnose a real failure.** If sign-in, Guardian or the provider blocks, inspect the existing private outcome and locate the exact failure and whether credential submission or the authenticated property was observed. The more detailed prompt is not a proven fix. Test only one evidence-backed change at a time; add instrumentation only if existing evidence cannot answer the actual question. Do not treat an account label, text-type password field, credentials or model as the cause without evidence.
7. **Restore and report on every exit.** Preserve logs and private evidence. Stop trial-started processes, restore any services actually interrupted, restart `hms-slot@hrcen` as directed and verify it active. Preserve private logs and evidence under restrictive permissions. Release and verify the property lock only after browser work has ended. Record elapsed time, measured spend by model, coverage and unknowns. Reporting can proceed offline while cleanup runs, but final success requires verified restoration and lock release. No staff communication has been sent; coordinate any necessary quiet period without asking staff to run scripts.

### Plain-language mint brief

> Using the privately supplied HRCEN tenant URL and credentials, create a reusable read-only reservation lookup. Work only in the authorized site. Use the relevant login fields, and confirm sign-in and the HRCEN property before reading reservation details. Do not inspect unrelated browser tabs or unrelated form inputs.
>
> On Guest Stay, use the header search to find the supplied confirmation number. A private bounded date hint can help during authoring if needed, but the reusable operation must accept the confirmation as its only required input. Do not hard-code example confirmations, guest details or dates. A hint is not proof of the stay's arrival date. Open the Record View only for the exact confirmation. If no unique match is found, report that instead of guessing.
>
> Inspect the accessible Record View tabs and expand collapsed sections. Return all displayed labels and values, including blanks, visible checkbox or radio states, and repeated rows. Preserve section and row identity, and report inaccessible sections rather than guessing. Do not create, change or cancel reservations, send messages or perform other writes.

The HRCEN password-named login control was observed as a text input in the independent browser. Provide that as a hint if Pomerado needs it, not as a claimed cause or a reason to include credentials in the prompt or code. Do not repeat the earlier contradictory origin/URL instruction.

Credentials, actual confirmation numbers, guest fields, raw logs, screenshots, generated artifacts and output stay in `.private/pomerado-readstay/` on Product EC2. MCP `provide_input` answers are visible to the client and its model provider; verify the approved Azure route for **both** the controller and all internal roles before sensitive inputs. A vendor Cloud protected-login page is not assumed available in this local installation.

## Our work versus Pomerado's work

| Work | Owner | Planned scope |
|---|---|---|
| Model routing and setup | Us | Reuse the existing isolated configuration and verify only the private route, access boundary, lock and service readiness. No product-code edit or new logging is planned. |
| Integration | Pomerado | Author and publish its own operation through the supported local MCP workflow. Generated source size is unknown until published. No custom integration harness. |
| Prompt and credentials | Us | One plain-language task, private example input and credential responses requested by the job. Further interaction is evidence-driven, not pre-scripted navigation. |
| Verification and cleanup | Us | Review generated source while the sole browser owner finishes independent reference screens. Run three cases, pipeline offline comparison with subsequent browser work, then verify cleanup. Reference helpers are not substitutes for the generated integration. |

## Alternatives and failure handling

| Option | When | Trade-off |
|---|---|---|
| Terra xhigh for all roles | Recommended first trial after approval | Retains prior model family and avoids a model-switch confound; stronger agentic coding and workflow benchmarks are directional, not HMS proof. Actual Azure cost and trial speed remain unknown. |
| Luna controller; Terra minter, Guardian and outcome review | Lower-list-price coordination alternative | Could reduce controller spend, but changes another variable and may change latency; not yet compared on this trial. |
| Luna minter; Terra Guardian and outcome review | Lower-list-price authoring alternative | Owner's proposal; may reduce model cost, but published coding benchmarks favor Terra. No controlled Pomerado comparison yet. |
| Terra minter; Luna Guardian | Not recommended as first trial | No evidence the cheaper model is equally reliable at the safety review role. An A/B trial would be required to compare. |
| Existing deterministic HMS reader | Independent reference and operational fallback only | Can help locate the correct stay, but does not establish Pomerado succeeded or replace the requested complete trial. |
| Greptile Apex CLI | Later review of a non-private committed product diff | The installed CLI supports Apex but reviews committed changes, not an uncommitted private artifact. Do not commit or disclose the generated trial artifact just to run it. The Azure/private alternative is not Apex and needs the same safety review. |

The earlier 65-, 85- and 100-minute estimates are superseded. **Working estimate: 50 minutes after approval**, conditional on the existing read-only and private-data boundaries being verifiable, a successful first mint, straightforward source review and no material field discrepancies. The estimate excludes building a missing enforcement mechanism. This is a working allocation, not a measured success time or an early cancellation deadline. Any permission, sign-in, Guardian, publication or comparison blocker invalidates the forecast.

| Critical-path phase | Raw working allocation | Basis and limit |
|---|---:|---|
| Existing setup, private route, lock and read-only evidence | 5 min | Assumes existing evidence is sufficient; unknown if not. |
| Direct mint; prepare private reference checklist offline | 20 min | Last two incomplete mints took about six minutes each; successful publication has never been timed. |
| Artifact safety review **in parallel** with finishing independent reference screens | 15 min | Reference work is the assumed longer branch. Artifact review is budgeted at 5 minutes within that overlap; neither complete activity has been timed. |
| Three generated calls and field comparisons | 10 min | Assumes small, straightforward records and offline comparison pipelined between exclusive browser operations. Complete comparisons have never been timed. |
| Restore slot, release lock and finalize report | 5 min | Assumes straightforward restoration; reporting can start offline during cleanup. |
| **Raw critical path** | **55 min** | One HRCEN browser owner throughout. |

The `live-hms` ledger median is 0.88 over 40 closed records. Applying it to 55 minutes gives 48.4 minutes, rounded to 50. This historical multiplier does not validate the assumed phase durations. In a retained partial reference run, the observed active timestamp and completion timestamp were 53 seconds apart and three exact confirmations were found. That excludes setup and did not cover every tab or displayed field. No successful generated call, full field comparison or artifact review has been timed. Owner-approval wait is excluded. Ledger ID: `pomerado-direct-speed-20261027T180412Z-2788499`.

The earlier 50-minute allocation bundled source review, all three generated calls and independent comparisons; it was not a measured review duration. It increased from the earlier plan's unsplit 35-minute comparison allocation without measured justification. The shorter forecast changes the dependency schedule and working assumptions, not the definition of success.

The previous Terra gross estimate used OpenAI Fast list prices without a verified Azure tier. Illustrative short-context Standard pricing gives $8.57 instead of the previously quoted $17.15 for that same gross controller estimate, before cache adjustments. Neither is the total bill: internal Pomerado usage, interrupted usage and actual Azure contract/tier are unknown. See the research report for model list prices and sources.

## Acceptance and output

| Check | Pass | Otherwise |
|---|---|---|
| Model routing | Approved route and configured roles checked; available per-call evidence recorded | If per-call metadata is absent, report effective model, effort or cost as unknown; do not invent tracing. |
| Publication | Generated read-only artifact exists, reviewed, and runtime boundaries established | Record exact block and do not run it. |
| Three calls | Each of three specified confirmations is supplied as the only required input and returns its exact record | Report failed or unrun cases, required date hints, hard-coded examples and wrong matches. |
| Independent comparison | The full requested Record View is inspected for each correct confirmation; all displayed fields, checkbox states and repeated rows match, with no missing, wrong or uncheckable fields | Report each missing, incorrect, inaccessible or uncheckable field and section. Any gap blocks full trial acceptance. |
| Safety and cleanup | No write or send; private data contained; all interrupted services restored; property lock released and checked | State the unverified or failed safety check, with time-stamped evidence. |
| Time and cost | Measure each phase and model cost using available usage and actual billing evidence | Mark unavailable role costs and invoice unknown; never substitute list prices for actual spend. |

For review-tool constraints and the retained timing receipt, see `docs/research/2026-10-27-pomerado-review-speed.md`. Update `docs/research/2026-10-27-pomerado-readstay-test.md`, its research index and the active handoff with evidence. Say **LANE DONE** only when every acceptance check passes. Otherwise say **LANE BLOCKED** and name all remaining checks.
