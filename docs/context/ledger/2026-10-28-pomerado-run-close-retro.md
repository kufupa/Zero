# Pomerado run close retrospective

**Closed at 06:00 UK: goal not achieved; cleanup verified.** Owner ask 365: self-hosted Pomerado with native Codex, Centurion read-only, until 06:00 UK. [Approved plan](../../plans/2026-10-28-002-feat-pomerado-codex-read-plan.md) · [Trial evidence](../../research/2026-10-28-pomerado-native-codex-trial.md) · [05:34 retrospective](2026-10-28-pomerado-0534-retro.md).

## Goal and checkpoints

The required outcome is a verified exact previous-booking read, a published integration, reviewed fresh MCP replay, and comparison with the same reference. The original three-case comparison remains later scope. Native login is a separate result from the existing-login fallback.

| Step | Evidence before the final outcome | Limitation |
|---|---|---|
| Native Codex and Pomerado | A real native MCP call reached self-hosted Pomerado. The first native login mint ended incomplete and reported it could not safely fill a text-type password control. | This does not prove credential rejection or exact admission cause. |
| Existing helper fallback | The helper returned after its own same-browser readiness and origin checks during later mints. | This is not native login proof, independent hotel identity, or continued authentication. |
| Diagnosing incomplete builds | Diag5 captured twelve complete read observations and four failed explore receipts. Specific failures included `document is not defined` and an execution context destroyed during navigation. Guardian denied one step as correctable. | These are per-operation findings, not established root cause of the final incomplete outcome. |
| Diag7 | Two outputs showed Stay 360 as a navigable anchor. Nine complete observations contained no selected booking token. Its native outcome was `build=incomplete` with 13 execution records and one correctable Guardian denial. Independent owned-unit, credential and named-lock cleanup passed. | The denial rationale matched text-type password and uncertain-field patterns. Its exact action and causal impact are unproved; the anchor does not prove an open screen. |
| Diag8 | Native mint ran with effect `read`, intended hints and selected confirmation input. The helper returned after its checks. One complete observation had Stay 360 text but not the selected token. One explore receipt had `OperationFailure`. The guard timed out before 06:00; the trial was inactive and both owned control groups were empty. | The last captured native status was running, without a terminal outcome. Property identity, booking, publication and replay remain unverified. |
| Final cleanup | Independent SSM Success/0 verified the owned units and control groups, both one-use credentials absent, zero guard sessions and zero granted named locks. | This is a scoped audit of this lane, not a claim about unrelated sessions. |
| Reference | The selected identifier occurs as an exact value beside reservation labels in the retained reference, which contains an HRCEN marker; prior independent case-3 capture reported an exact identifier match. | Full visible-field coverage and the fresh trial match are unproved. |

## What cost time

- Native mint authors an integration; it is not simply a direct screen-read call. Generated files and completed receipts were mistaken for stronger progress signals until private observations were captured.
- The coordinator added a no-credential restriction to the first helper fallback, although it was not part of the owner's request. Its effect on the incomplete result is unknown; the corrected retry also ended incomplete.
- The diagnostic destination was stripped from the diag3 executor environment, so that run could not capture the intended detail. Later capture provided specific errors, but not a proven root cause. [Verified forwarding lesson](../../solutions/runtime-errors/clean-executor-diagnostic-environment-forwarding.md).
- An earlier process-environment watcher was too broad for the Centurion-only boundary and was stopped. The replacement inspects only named shared application roots and owns no other hotel's processes.

## What should change

1. Capture actual execution results and specific failures from the first attempt, not only generated code and terminal status. In diag3 the coordinator omitted the diagnostic environment variable from its own clean executor, losing the evidence it meant to collect.
2. Resolve native versus helper authentication state with observed evidence rather than assuming the host helper satisfies native tracking. The mismatch is a source-backed candidate, not a confirmed failure cause.
3. Test generated page-context navigation against the captured concrete errors and Guardian feedback. Diag7 received a context hint but ended incomplete. Diag8 added the observed login-field and signed-in menu context while retaining Guardian; it stopped at the deadline without a recorded native outcome.
4. Use the retained same-booking reference and preserve blanks, repeated rows, and gaps. Do not substitute an unrelated booking or count a text clue as a screen match.

## Accounting and hold

A prior 12-minute estimate for the isolated helper-login checkpoint closed at 86 seconds. That was a login-only checkpoint, not a successful mint or replay benchmark. A separate native login-first attempt was budgeted as a 10-minute first-result scenario and reached failed cleanup after 24m44s. Earlier mint and full-proof forecasts were superseded or ended partial, so they do not support a completion forecast. Public-only Exa Agent reported $0.5001. Azure model spend and per-call model/effort receipts were unavailable in the captured evidence. No defensible successful-completion ETA has been established. A ledger review found four older Pomerado-related estimates without close rows, including broader concurrent work; their actual endpoints are not established here, so no values were invented or retroactively closed.

**Next acceptance, only under new authorization:** establish same-session Centurion identity, open the exact selected booking, capture its visible details, publish and review the generated integration, replay it freshly, then compare the same booking against the retained reference. Preserve the later original three-case comparison. Do not start further live work under the expired window.
