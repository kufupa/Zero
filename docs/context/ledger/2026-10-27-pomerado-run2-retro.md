# Pomerado approved run retrospective

Date: 2026-10-27. Scope: owner authorization in ask 313 through owner pause in ask 318. **Outcome: partial and paused. No integration was published, no generated call was replayed, and no case comparison was completed.**

## Goal and verified outcome

The [approved plan](../../plans/2026-10-27-008-pomerado-fast-proof.md) asked Pomerado's native flow to publish a read-only HRCEN Guest Stay lookup. The selected screenshot example and the original three cases remained required; a distinct screenshot case would add a fourth. Staff-facing booking and Add-Ons were not part of this proof.

| Milestone | Outcome |
|---|---|
| Isolated setup | Configured the controller and Pomerado role defaults for Luna max; actual per-call provider and effort receipts were not retained. |
| First native mint | At 20:25Z it returned `completed`, `build: incomplete`, with sign-in unconfirmed. Its summary reported an HTML text-type password control. |
| Native retry | Login input initially failed validation, then a corrected input call returned without error. Sign-in remained unconfirmed. The owner paused the running retry before any native terminal result. |
| Screenshot | The retry example differs from the first candidate. Original-resolution crop reading and two crop OCR modes matched the first candidate, but none established that the token is the actual confirmation field. Overlap with the original cases remains unverified. |
| Comparison | No generated operation, source review, replay, complete answer key or field comparison was verified. Existing references remain partial. |
| Cleanup | At 20:53:36Z the controller was inactive, both hotel slots were active, guard status was `RESTORED`, and a read-only query found zero granted named trial locks. The guard unit reported `failed` after stop and was not running. |

Elapsed from owner go at 19:50:08Z to verified pause at 20:53:36Z: **63 min 28 s**. The 100-minute planning budget was a conditional scenario, not a measured success estimate. The run was stopped before that budget ended; its interrupted duration cannot estimate time to success. The ledger closes this execution as partial, not a successful completion.

## Where time and control were lost

| Period UTC | What occurred | Assessment |
|---|---|---|
| 19:50–20:07 | Set up roles and lock; first controller mistook its own process for another run and was replaced before invoking mint. | About 17 minutes before an actual native job, versus an untimed 5-minute setup allowance. This was our orchestration error, not vendor authoring time. |
| 20:07–20:25 | First native mint reached an incomplete terminal result. | We obtained a result but not a confirmed login. The native summary did not establish why sign-in failed. |
| 20:25–20:32 | Restored HRCEN, verified the old lock, ported an existing private outcome-capture hook, and prepared a fresh guarded retry. | Retry changed the password hint and private capture. Its screenshot example was also different. This was not a clean single-variable diagnosis. |
| 20:32–20:53 | Retried; the first credential response was rejected, the corrected response was accepted, and the owner paused before terminal output. Offline screenshot checks ran in parallel. | The first response omitted mandatory `saveLogin`, despite the exact contract being documented before the run in [prior research](../../research/2026-10-27-pomerado-speed-mastra.md). This was our handoff/controller mistake. Acceptance did not establish successful HMS sign-in. |

## What failed and what remains unknown

1. **We repeated an unresolved sign-in problem.** A previous mint had already used the text-type password hint without publishing. This run reused that hint without proving its causal role. The earlier [retro](2026-10-27-pomerado-trial-retro.md) warned against blind retries; we repeated that pattern.
2. **We missed an already-documented input detail.** The vendor requires an explicit `saveLogin` boolean. The first retry answer omitted it; the second supplied `false` and was accepted. We should have passed the known native answer shape to the controller, not rediscovered it during the job.
3. **We mishandled the example.** The retry changed its private candidate based on a low-resolution reading. A later original-resolution crop supported the first candidate instead, but did not independently identify its field. We cannot attribute the sign-in failure or the interrupted retry to either number.
4. **We did not connect the proven baseline to the failure analysis.** Nava's existing helper locates the password by name and checks the expected tenant and property after login. Independent Chromium had authenticated HRCEN earlier. Pomerado's isolated build contains a signed-in safeguard selecting password-type inputs; that check misses the observed text-type field. It does not prove that autofill failed, that HMS rejected credentials, or that this safeguard caused the incomplete mint. The user did not ask us to replace Pomerado with the existing helper.
5. **We lacked terminal evidence for the retry.** The newer build's earlier native summary omitted internals. We ported the private diagnostic capture after the first result, but the owner paused the second job before a result existed. No retry outcome file was captured. We cannot infer success or failure from a running job.

The plan was right to keep the real HRCEN task, original cases, privacy, lock, native workflow and cleanup. It correctly labeled its 100-minute budget conditional. It did not ensure the already-researched credential shape was given to the controller, nor did it make the unresolved Pomerado-versus-working-helper login discrepancy the first targeted diagnosis after failure. The owner did not cause these execution mistakes.

## Cost and useful follow-up if directed later

| Model | Known evidence | Limit |
|---|---|---|
| GPT-6 Luna | **$0.101794** illustrative OpenAI short-context Standard list-price estimate for the completed first controller turn and two completed screenshot-only turns. | Not an Azure invoice. Excludes interrupted controllers, Pomerado's internal roles, other setup calls, regional/contract terms and any unrecorded usage. Total is unknown. |
| Claude Fable 5.1 | Unknown. | No coordinator billing record available. |

Ranked improvements are retrospective, not permission to resume:

1. **Trace the actual login path against the working helper.** Separate field discovery, credential delivery, submit and signed-in marker. Use retained private diagnostics and the known native question schema. Do not claim a cause without evidence.
2. **Fix the handoff before another mint.** Provide the native credential answer shape and use a verified selected example; retain Pomerado's native flow and the original full proof. Avoid simultaneous unexplained changes that make the next outcome ambiguous.
3. **Time and price each real stage.** Measure setup, actual mint, review, references and replay separately. Compare against the existing deterministic reader on the same case before any speed or cost claim. An interrupted run is not a successful-duration benchmark.

**Current hold:** Trial remains paused. No mint, hotel browser work, deployment, flag change, real-guest write or mail send is authorized by this retrospective. Read-only authority, Guardian, the approved private route, the actual property lock, source review before replay and the complete original comparisons remain the prior trial boundaries if the owner later directs a resumption. Do not reinstate previously removed assistant-added sandbox or role-proof prerequisites.
