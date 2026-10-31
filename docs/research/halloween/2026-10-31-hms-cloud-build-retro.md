# Retro: 30 October 2026 HMS Cloud build

The run delivered a useful, live-checked Cloud HMS slice, not a finished staff workflow. It kept writes to unsaved fake/Labtest drafts; no real stay was saved, no email was sent, and pane integration, deployment and product-accuracy evaluation stayed out of scope ([build plan](pre-autonomous-build-new-tools-md-30-oct.md#definition-of-done), [PRODUCT.md](../../../PRODUCT.md)).

## Outcome and pace

| Measure | Observed |
|---|---|
| Run | Work began ~19:07 UTC; final feature PR #781 merged at 22:59, ~3h52 later. Closeout was recorded at 23:03. |
| First value | First composed live example at 19:13; first party-context PR merged at 19:41. |
| Scope | 26 in-scope feature/fix PRs, **not 26 tools**. The original 20-PR spine was complete by 21:59:52; six useful follow-on fixes/features extended the run by ~59 minutes. Unrelated concurrent research PR #761 is excluded. |
| PR latency | Median 11.8 minutes; range 5.8–35.0. Recomputed from GitHub open/merge timestamps for the 26 in-scope PRs. This excludes design, live probing and coding before PR open; reviews overlapped implementation, so it is not a coding-rate estimate. |

The first 20 landed within the plan's provisional 1–3 hour window; the expanded final scope did not. The follow-ons addressed real findings—occupancy and quantity conflicts, explicit zero-child state, memory hints and guarded selection order—but the next run should separate must-have work from stretch work and use a deliberate stop/re-scope checkpoint.

## What worked

- **Live-first found the real surface.** The availability overlay did not inherit dates, occupancy or organization from the blank Guest Stay, so the flow was corrected to set and verify criteria on the screen being read. A diverse, non-random 12-request read sample matched its submitted criteria in 12/12 sessions over 2m15s. Its 33 nightly observations included four zero-inventory and three closed/restricted cases (one overlap); party context and requested quantity were unknown, so this was an exploratory tool check—not an accuracy or bookability result. ([evidence ledger](pre-autonomous-build-new-tools-md-30-oct.md#evidence-gathered-during-the-build))
- **Same-page reuse composed.** The JSONL/session seam reused memory, lookup, availability and selection rather than adding an app adapter. One quote-to-unsaved-draft example closed Availability, selected the corresponding room/rate, and read the same draft back with guest and confirmation IDs blank. That is a useful vertical slice, not proof of general rate eligibility or a saved booking. See the [Cloud module contract](../../../apps/server-pilot/tooling/hms-cloud/README.md).
- **Parallel review overlapped implementation without synthetic padding.** Live probes and reviews overlapped. An unnecessary 140-line synthetic test on #779 was reverted at owner direction after the live zero → child → zero check; a synthetic-test-only P2 suggestion on #780 did not drive a large mock suite. Live and bounded corpus/mutation evidence remained explicitly scoped.

## Misses and changes for next run

| Evidence from this run | Next-run change |
|---|---|
| Fresh child worktrees initially lacked the pinned Stagehand/Playwright dependency, blocking live startup. One later startup returned `UNEXPECTED_REQUEST_BLOCKED`; the blocked path was not captured, and three subsequent no-wait starts did not reproduce it. | Preflight pinned browser dependencies in every live worktree. Capture sanitized request class/path at the first unexpected block; if it will not reproduce, keep cause unresolved rather than infer a delay fixes it. |
| A blank native child-count spinner was treated as numeric zero, but HMS submitted a nonnumeric value. Separately, removing a temporary field-change route after timeout could let a delayed POST reach HMS; timeout did not prove cancellation. | Set and read back explicit zero through native controls. Quarantine uncertain pages, inspect draft state, and start a fresh page before retry; an already-dispatched request may still complete. |
| **#780 gate-order miss:** memory hints merged around 22:50 before the separate remote `hms-production-boundary` test returned. It passed 10/10 around 22:55, but checks the app boundary—not memory behavior—so it cannot count as a pre-merge gate or feature proof. This was a process miss, not evidence that the memory feature failed. Its final private comparison covered 23 observed-corpus checks plus 12 controlled mutations. The source cohort was still limited: 612 observed confirmation numbers, 21 with multiple-match metadata, no independently supplied stay IDs, and unknown lookup completeness; these are historical hints, not verified stays or current availability. | Keep merge blocked until exact-head remote results are returned and independently checked. Inspect the tested SHA and test contents; a gate record alone is not proof. Keep boundary checks separate from behavior evidence. |
| A diagnostic printed an opaque request token into agent output; it was disclosed at the time. A later report must not repeat its value, raw request URLs or private captures. | Capture privately, redact before display, and publish only sanitized aggregates. This retro contains no guest records, token values or raw HMS URLs. |

**Evidence trail:** the [plan's schedule notes](pre-autonomous-build-new-tools-md-30-oct.md#review-and-schedule-evidence) and [live-evidence ledger](pre-autonomous-build-new-tools-md-30-oct.md#evidence-gathered-during-the-build), GitHub PR timestamps, and private `STATUS.md` / `root-coordinator-checkpoint-20261030.md` run records (kept outside Git). Raw live captures remain private.
