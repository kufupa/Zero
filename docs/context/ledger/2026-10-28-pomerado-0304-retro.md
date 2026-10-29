# Pomerado half-hour retrospective

2026-10-28, 03:04 UK. Scope: owner ask 365, self-hosted Pomerado and native Codex, Centurion read-only. [Trial evidence](../../research/2026-10-28-pomerado-native-codex-trial.md) · [02:34 checkpoint](2026-10-28-pomerado-0234-retro.md) · [Approved plan](../../plans/2026-10-28-002-feat-pomerado-codex-read-plan.md).

## Goal, plan, actual

The goal remains an exact previous-booking read, a reviewed published tool and a fresh same-booking replay before 06:00 UK. No screen, booking, publication or replay is verified. The original three-case comparison remains outstanding.

| Step | Actual | Limit |
|---|---|---|
| Diagnostic mint | Guard started at 02:38:34 and stopped at 02:39:12 UTC with `LOCK_OR_CONFIG_LOST`; it killed its own trial before a terminal native result. | The message conflates several failure branches. A worker child appeared one second before exit, and a subsequent snapshot failed on a duplicate role. That strongly supports, but does not prove, the cause. |
| Cleanup | Both owned units failed with empty control groups, guard said `CLEAN`, both one-use credentials were absent, and a read-only query on the current runtime DB found zero named guard sessions and locks. | This covers the named guard, not unrelated holders or other property work. |
| New guard candidate | Allows a direct child only when its relevant lock-identity settings match its parent. Synthetic differing-identity and dual-key tests passed. | The observed child has a different effective pane tenant. The candidate remains conservative; a real HRCEN conflict is not established. |
| Diagnostic capture | Isolated private wrapper now records bounded, redacted sign-in failure labels. Synthetic propagation, refusal, redaction and omission tests passed. | Real failure capture remains unproven. Earlier terminal summaries contained no selected structured cause. |
| Coordinator mistake | Replacing the helper as root made it mode 600 and inaccessible to the `ubuntu` runtime user. A final runtime-user test caught `EACCES`; the watcher was stopped and the staged units had not started. | Ownership was corrected, the test passed as `ubuntu`, 629 other runtime files were readable, and runner/input access passed. Root-only smoke tests had given false confidence. |
| Retry readiness | The automatic watcher was re-armed after those checks. Its latest event was `SNAPSHOT_NOT_READY`; it waits for two valid snapshots and does not change the other process. | At the 03:04 check both staged units were not found and inactive. Guard status, both credential files, native event and diagnostic files were absent. This is an owned-unit check, not an audit of unrelated locks. |

## What went well and what must change

1. We preserved the prior failure and verified cleanup instead of claiming login or booking success. The private diagnostics now target the actual missing failure details.
2. We added too much coordinator-side machinery relative to the requested direct test. The service-user permission error and watcher churn consumed time without a live result. Future checks must run as the actual service user from the outset.
3. The global configuration snapshot is an assistant-added implementation of property exclusion, not itself the owner's desired result. Generic source shows a legitimate quote child can override its parent's pane tenant and receive a property-lock token. This does not establish the observed child's path or property. The candidate can reject legitimate work, but removing its check without equivalent HRCEN exclusion would be unsupported. Investigate a narrower property-specific check without inspecting or disturbing the other hotel.
4. No successful comparable mint and replay exists, so no reliable completion ETA is supported. The earlier public-only Exa Agent reported $0.5001 for the whole research run. Azure model spend and per-call role receipts remain unavailable.

## Next steps, ranked

1. Verify the current state of this lane's staged units and let the already-tested watcher run only when its guard is ready. Capture actual private diagnostic receipts and retain generated source. Preserve Guardian, both observed Centurion lock keys, read-only operation and the 06:00 deadline.
2. In parallel, inspect only generic guard and product lock source to determine whether its global duplicate-process condition can safely be narrowed. Do not inspect, stop or modify Da Vinci or its processes. Any narrower guard must demonstrably cover the actual HRCEN keys; unproved alternatives remain unadopted.
3. If a mint publishes, review all generated source, register its own MCP server, and replay it in a fresh guarded session for the exact same booking. Report missing and unmatched fields honestly.

No product deployment, flag flip, email or guest write was made by this lane. The next checkpoint is 03:34 UK; the 06:00 UK deadline remains.

### Lock-source follow-up

The quote path binds its installation's property to the resolved target before acquiring a lock and spawning its child. The child receives a parent-lock token plus its target tenant, and the read CLI verifies the token against its chosen tenant and property. This makes the global same-tenant child check potentially overbroad, but does not identify the observed child. The generic CLI also accepts an explicit tenant override. These source facts do not establish a complete set of live Centurion lock identities, so the guarded watcher remains unchanged while that gap is assessed.

The prior [two-lock evidence](../../research/2026-10-27-hrcen-two-locks.md) explicitly does not establish coverage of arbitrary tenant overrides. The source review therefore did not establish a safe narrower live guard for the unidentified child. No guard check was removed and no other hotel's process was inspected or changed during this follow-up.
