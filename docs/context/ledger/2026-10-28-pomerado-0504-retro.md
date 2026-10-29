# Pomerado half-hour retrospective

2026-10-28, 05:04 UK. Scope: owner ask 365, self-hosted Pomerado and native Codex, Centurion read-only. [Trial evidence](../../research/2026-10-28-pomerado-native-codex-trial.md) · [04:34 retrospective](2026-10-28-pomerado-0434-retro.md) · [Approved plan](../../plans/2026-10-28-002-feat-pomerado-codex-read-plan.md).

## Goal and actual

The exact prior-booking read, published integration and fresh same-booking replay remain unproved. No complete Stay 360 screen or booking output is verified. The original three-case comparison remains outstanding.

| Item | Actual | Limit |
|---|---|---|
| Diag4 mint | Native job completed with `build=incomplete` and a generic stop-before-publication summary. The live outcome hook recorded 18 executions and zero diagnostics, with no captured stop, recovery or host-failure reason. | The capture omitted successful observations and some possible outcome fields. This does not establish the root cause or exact attempted actions. |
| Login and exploration | The existing helper returned after its authenticated-shell readiness and origin checks. The native records include 14 completed explore, two completed authenticate and two failed explore executions. Native authenticate receipts lacked a verified-authentication marker. | Helper readiness is point-in-time evidence, not independent hotel identity, continued login or evidence that HMS rejected credentials. Failed codes were `OperationFailure` and `BrowserActionTimeout`; their exact actions and causes remain unknown. |
| Input | The native controller supplied nonempty username and password fields with `saveLogin=false`. Its input response exposed running status and no explicit error flag. | This does not prove HMS received or accepted the credentials. |
| Cleanup | The owned guard and trial stopped; both control groups were empty, credentials absent, and named guard sessions and granted advisory locks zero. | This audits this lane's owned session, not other sessions. |
| Diag5 retry | An isolated runtime now retains completed read-exploration observations privately and captures more outcome metadata. Synthetic multi-chunk and redaction checks passed. The scoped guard and native mint were observed running; both currently derived Centurion keys were independently verified held. One explore receipt reported `OperationFailure`. | Live observation capture, selected booking, publication and replay remain unproved. The observation writer caps each observation at two million characters and records truncation. Arbitrary custom tenant lock keys remain unproved. |

## What went wrong and what changes

1. The previous capture deliberately omitted all successful observations. That prevented us from telling what the completed browser reads saw. The new isolated capture keeps read-exploration results under the private root with session-secret screening and an extra sensitive-key redaction layer. Authentication observations remain excluded.
2. Staging repeated avoidable permissions and shell mistakes: an old root-owned backup blocked an unprivileged runtime copy; the root-owned guard blocked an unprivileged input copy; a POSIX shell rejected Bash `[[` while an unconditional success line still printed. Each was corrected and tested before launch. Do not treat a zero local shell exit or a success line as proof without the SSM response and stderr.
3. Native source requires tracker-recorded identifier and proof before marking sign-in verified. The external helper's authenticated-shell result is not represented as those native tracker submissions. This is a candidate mismatch, not proof of the failed mint's cause. Do not mark the tracker verified without evidence.
4. The earlier broad process matcher incorrectly classified unrelated owned subprocesses as Codex. A refined own-control-group check identified the actual Codex executable and native Node runtime, both with the expected diagnostic destination. No global or other-hotel process scan was used.
5. No evidence-backed successful-completion ETA is available. Public-only Exa Agent research reported $0.5001; Azure model spend and per-call provider-role receipts remain unavailable.

## Next steps, ranked

1. Let the current read-only mint proceed under the existing Centurion locks and Guardian. Classify private read observations as they appear, and verify exact booking identity rather than inferring it from a token or generated source.
2. If it publishes, review its generated source and configuration, then register and run its own MCP server in a fresh guarded context and compare the same booking against the retained reference. If incomplete, inspect the captured outcome and diagnose before selecting any further retry.
3. Keep the 05:34 UK retrospective and 06:00 UK owner deadline. Stop owned trial work by the deadline and verify owned units, credentials and locks. No deployment, flag change, guest write, other hotel, or email is authorized by this lane.
