# Pomerado fast screen-stop source review

2026-10-27, owner asks 330–331. Focused independent source inspection of Pomerado `7349a1c2` for a smaller stop than a general dispatch framework. No code change, runtime, test, browser, credentials or HMS access. [Revised plan](../plans/2026-10-27-012-feat-pomerado-session-handoff-plan.md). Earlier lifecycle findings: [context handoff](2026-10-27-pomerado-context-handoff.md) and [Grok review](2026-10-27-pomerado-handoff-grok-review.md).

| Question | Source-backed candidate | Limit |
|---|---|---|
| Smallest stop | Bind a per-mint latch to the session used by `typescript/src/standalone/pomerado.ts`, and reject further live dispatch after the correct complete observation. `typescript/src/execution/playwright-execute.ts` exposes the execution interfaces. | This is a proposed host modification, not an existing flag or a verified guarantee. Atomically close the latch before releasing the observation's permit; queued calls must recheck. |
| Coverage | Dispatch also serves credential, reset, batch, marker and observation paths. See `typescript/src/standalone/mint-live-tests.ts` and `typescript/src/mint/harness.ts`. | Blocking just a model's named explore action misses other paths. The host seam must cover them or the one-screen stop is unproved. |
| Finish and publish | Preserve the accepted explore receipt and permit non-browser finishing. `typescript/src/standalone/mint-publication.ts` can retain a matching completed explore result under its stated conditions. | Publication for this hybrid task remains unproved; if it needs further live actions, report replay blocked. Cancellation can remove an unpublished artifact. |
| Actual screen | `typescript/src/standalone/request-context.ts` includes snapshot behavior that may omit or truncate information. | Verify complete visible content; a snapshot alone is not necessarily proof. |
| Within one execution | `typescript/src/execution/playwright-worker.ts` runs authored code; `typescript/src/runtime/kernel-operation.ts` also runs operations. | A post-result latch cannot undo combined actions, unawaited work, timers or page-side activity. Inspect proposed actions and fail closed when the read-only, one-screen scope cannot be established. |
| Offline execution | `typescript/src/execution/local-operation.ts`, `local-operation-child.ts` and `local-process.ts` run authored code/processes. | Blocking the host browser API is not an OS or network sandbox. Do not claim private-data or read-only isolation from the latch or Guardian alone. |

## Focused checks

On Product EC2, test the correct and incomplete observation; atomic closure and concurrent queued calls; refusal through each live browser and credential route; preservation of the completed receipt and offline finish; publication blocked when another live action is required; and a separately scoped fresh replay. Explicitly test the in-flight limitation rather than claiming the latch can reverse it. These are planned scenarios, not results.

The focused review does not establish execution feasibility, complete capture, artifact publication, runtime model routing or replay. The earlier Grok review covered an earlier plan draft, not this speed revision. No source or trial changes were made during this review.
