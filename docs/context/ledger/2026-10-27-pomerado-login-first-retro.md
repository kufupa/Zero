# Pomerado login-first retrospective

Date: 2026-10-27. Owner asks 321–323. Scope: the authorized native HRCEN login-first attempt, then retrospective only. **Outcome: incomplete; Pomerado did not establish login or hotel identity. No integration was published.**

## Goal, result and timing

The owner said the same tenant URL and credentials worked manually in under 10 seconds. The approved [login-first plan](../../plans/2026-10-27-011-pomerado-login-first-plan.md) asked Pomerado itself to authenticate and report the signed-in HRCEN identity, without a guest lookup. Nava's existing helper had separately authenticated the same tenant in an earlier test; that is a baseline, not proof of Pomerado's login.

| Event, UTC | Observation |
|---|---|
| 21:13:17 | Owner authorized execution. |
| 21:14:31 | Guarded controller started; HRCEN slot stopped and the shared property lock held. |
| 21:35:00 | Private native outcome written: `build: incomplete`. Native job completed, but no credential request or authenticated execution appeared. |
| 21:37:27 | Cleanup watcher recorded completion; guard recorded `RESTORED`. |
| 21:38:01 | Read-only recheck: controller, watcher and guard inactive; both hotel slots active; zero granted named trial locks. |

The first-result-and-cleanup scenario was 10 minutes, not a successful-login forecast. From owner authorization to verified cleanup took 24 minutes 44 seconds, 2.47 times that scenario. Controller start to native outcome took 20 minutes 29 seconds. The owner saw manual login in under 10 seconds; this does not measure Pomerado time to success, because Pomerado failed. The ledger records a failed outcome.

## What Pomerado actually wrote and attempted

Before stopping the finished controller, three surviving native exploration scripts were preserved in the EC2 worktree's `.private/pomerado-readstay/` directory. They are a snapshot of remaining temporary files, not the complete history of generated code. They use the browser execution bridge and inspect the page:

- One examines username and password name selectors, form elements, and the sign-in button.
- Another inspects form and control attributes, visibility and text.
- Another enumerates inputs, placeholders, form attributes and frames.
- None of those three retained scripts contains a Playwright fill, click or submit call. This does not prove that no other transient script tried such an action.

The private terminal outcome records 17 execution receipts: 13 failed and four completed. Fourteen carried Guardian reviews and all 14 were `allow`; three completed receipts had no attached review. No execution receipt contains an authentication record. The MCP controller transcript contains no `provide_input` call. The recorded observations all say only that private observations are available through the screened execution response; the underlying failure messages are not present in the captured final outcome. Vendor source creates the original failed receipt with an error message in `typescript/src/standalone/mint-execution.ts:361-380`, then replaces observations with that placeholder in `typescript/src/mint/harness.ts:2040-2049` when building the execution ledger. Therefore the precise cause of the 13 failures remains unknown. The verified receipt fields do not establish that HMS rejected credentials, that Guardian blocked this run, that the unusual text-type password control caused failure, or why Chromium left the service cgroup.

## What went wrong

1. **The owner was right about task simplicity.** A human, and Nava's previously verified helper, can use the same login page. A native mint is an authoring and review workflow rather than a direct click sequence, so this run is not an apples-to-apples automation runtime benchmark. That distinction does not excuse failure to authenticate.
2. **We ran another attempt without resolving the prior sign-in failure.** The earlier [run retro](2026-10-27-pomerado-run2-retro.md) explicitly identified missing failure detail and warned against blind retries. A narrower prompt was a useful experiment, but a prompt hint was not proof of a fix.
3. **Our monitoring could not see the actual failure.** Capturing the terminal outcome kept review decisions and status but screened the execution error messages we needed. We observed code generation and a running job, not whether the page loaded, fields were found, or a sign-in step was attempted.
4. **Our cleanup coupling was too weak.** The watcher waited for the controller to exit, not the already-completed native job. The controller was still running after the terminal result. We preserved the private scripts, stopped the completed controller, and verified restoration. The user interrupted tool work during this interval, so this is not evidence that the controller would never have exited by itself.
5. **The 10-minute number was weak.** It mixed an old failed mint, unmeasured setup and a different cleanup, then applied a mixed ledger factor. It was labelled conditional, but it still understated the observed time to a failed result and cleanup.

## Recommendation and limits

1. Keep the working Nava login path for current product work. Do not replace it or claim Pomerado is faster until Pomerado passes a same-task comparison.
2. If the owner later wants further Pomerado work, first identify where the screened per-execution errors were retained, or capture them privately during a separately authorized attempt. Compare the first failed page operation with Nava's known field and submit sequence; no blind fresh mint.
3. If retried, have cleanup respond to a confirmed native terminal result as well as controller exit. Preserve private source before temporary workspace teardown. Do not add new role-proof or public-example gates.

GPT-6 Luna was configured for the controller and trial roles; per-call model and effort receipts were not retained. Full trial cost by model is unknown; the stopped controller emitted no final usage record, and internal-role usage is not captured. Guest-case work, real-guest writes, replay, deployment and flag changes were outside this login-only authorization; none is established by the evidence reviewed. The original selected case and three-case comparison remain outstanding and require owner direction.
