# Nava plan readiness review — 4 November

**Verdict: original plan failed implementation-readiness. Repaired in place. Initial release specified; U7/U8 native gates remain explicit.**

Used EGM Stage9 implementation-readiness + codebase personas, fresh Orca chats; no re-draft/full five-stage ritual.
[Standard](/home/orca/.codex/plugins/cache/egm/egm/0.1.0/resources/document_standards/implementation-readiness-standard.md): implementer should not need architectural choices.
Owner authorised choosing solutions and meaningful tests. No routine approval gates added.
This is critique + parent repair, not an independent second-pass EGM certification.

## Defects → decisions

| Defect | Chosen fix |
|---|---|
| “Separate stays or finish Amend…” | R alone Saves. A1618525656-1: Amend→Filing→Cancel; B separate new Create. Fresh identity/status/hold check; named blocker if unavailable |
| Broad units, missing models/dependencies | Atomic budgets; four writer file owners; core-rate→Amend release, history later; visible Orca milestones |
| Full prefill = unspecified fields | Exact scalar/object WorkItem paths; strict validation; staff/extracted/HMS layers; false CMS support; durable per-room profile/party/CMS choices |
| Triage authorities disagree | work-items effectiveStayAction; per-stay correction→extracted action; owner single-stay correction retained. Native bind/approval/dispatch uses stayId; classifier/gold/TreatAs cannot authorise writes |
| Preview prop masks action semantics | Separate ReadOnlyRequestPreview snapshot on nava-preview; no NavaPane workflow hooks/jobs/mutations. Normal /mail remains staff action surface; no new preview router/auth platform |
| Rates API/ranking undefined | quoteWorkflow.rateCandidates; exact context; native labels/price/status; typed-code check; history priors + bounded Luna candidate suggestion |
| Memory “exists” but no deployment | Two existing private source files verified; existing bootstrap S3/SSM transfer; immutable data key, runtime-private JSON/cache; failure clearly labelled |
| Grid removal loses dimensions | Selected-room picker default; existing room×rate×board comparison and dated prices collapsed |
| Amend final price differs from review | Reprice: currency/total/average at Save gate + trusted no-Save recovery. Retain: approve current-rate instruction; final total from readback, never invented preview |
| Cancel/Filing “coherent” vague | Fee Go visible independent of screenshot; explicit PDF choice binds only selected facts/bytes/digest; target change resets review |
| Numeric amount mistaken for native | Quote override remains Quote-only. Saved Wizard native route chosen; no guessed pre-Save Create amount/composite workflow |
| Profile “find/create” undecided | FSGSPF New; strict guest attribution; separate profile Go/readback then reservation Go; native duplicate prompts never auto-confirmed |
| Tests banned despite latest owner | Focused meaningful additions allowed; no test framework/corpus build, repeated probes or broad suites |
| ETA borrowed whole overnight | Task budgets + max/sum critical path; two release waves; parallel final-head reviews/serial merges and proofs. Withdraw unsupported20m extra-wave assumption |

One readiness reviewer claimed Cloud files absent and Create Track/recipient unsupported. Rejected: it followed behind-main root paths.
Verified all five child HEADs =9d388ab751; current Cloud files/mapper are present. Kept independently sourced timing rows.
Current native facts beat older linked snippets.

## Measured comparators — AI elapsed, UTC

Task spans include reasoning/tools/waits; not CPU coding time. Confidence refers timing/scope, not transferable speed.

| Date/time | Elapsed | Model / scope | Source |
|---|---:|---|---|
| Nov4 03:18:16.006–03:40:49.759 | 22m34 | Terra Max; Create candidate | [Create session](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T03-18-15-01a1a490-8092-7210-a90b-c633f647283a.jsonl:1), task completion1608 |
| Nov4 03:18:28.529–03:38:25.039 | 19m57 | Terra Max; Filing candidate | [Filing session](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T03-18-28-01a1a490-b17c-7883-a7ca-cd0da0220635.jsonl:1), completion1519 |
| Nov4 04:30:42.208–04:44:56.436 | 14m14 | Terra Max; source/Filing UI | [Source UI session](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T04-30-42-01a1a4d2-d1c7-7910-b1d6-be2e40bcf2b5.jsonl:1), completion1209 |
| Nov4 04:17:56.312–04:23:52.451 | 5m56 | Luna Max; bounded source-ID research | [Source research](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T04-17-56-01a1a4c7-2209-7e32-bda7-f4dcba4769ff.jsonl:1), completion360 |
| Nov3 23:41:53–23:50:40 | 8m47 | Luna Max; native rate-stage guard fix | [Evening retro](2026-11-03-evening-plan-retro-125-to-200min.md) |
| Nov3 22:01:17–22:11:05 | 9m48 | Mixed; typecheck/compiler fixes | [Earlier retro](2026-11-03-evening-plan-retro-125min.md) |
| Nov3 22:11:05–22:25:40 | 14m35 | Mixed; stale fixture/recheck | [Earlier retro](2026-11-03-evening-plan-retro-125min.md) |
| Nov3 22:54:15–23:03:16 | 9m01 | Sol/ops; deploy/restart/health | [Evening retro](2026-11-03-evening-plan-retro-125-to-200min.md) |
| Nov3 23:03:16–23:07:44 | 4m28 | Sol/native; deployed Quote read | [Evening retro](2026-11-03-evening-plan-retro-125-to-200min.md) |
| Nov3 23:25:37–23:31:34 | 5m57 | Sol/native; preview + Labtest Save | [Evening retro](2026-11-03-evening-plan-retro-125-to-200min.md) |
| Nov3 23:31:34–23:38:21 | 6m47 | Sol/native; reconcile, no retry | [Evening retro](2026-11-03-evening-plan-retro-125-to-200min.md) |
| Nov4 04:57:35–05:26:36 | 29m01 | Sol; coordinator gap, cause unknown | [Overnight retro](2026-11-04-big-fat-4-hour-chat-retro.md) |

[Halloween build](halloween/2026-10-31-hms-cloud-build-retro.md): PR open→merge median11.8m, range5.8–35; excludes coding.
Prior4h28 full run useful sanity check. Its ~90m after primary merges included more fixes/code/deploy/proof; not fixed overhead.
No empirical end-to-end comparator for new rate recommendation, durable complete form or entire UI redesign. Forecasts explicitly conditional.

## Native discoveries affecting scope

- **U7:** Nov3 fake saved-stay Wizard OVER→Submit changed one night; independent dated readback matched. Nov4 blank Create amount fields read-only. Multi-night/tax/pre-Submit preview unproved.
- OSSTWZ.UpdateStayWizard is a write despite ONLY_DATA_REQUIRED; generic save-path guard misses it. Explicit fence required.
- Native No/Extend continuation keys in Nov3 controller differ from current matcher; early current-controller check, narrow correction if confirmed.
- **U8:** one fresh fenced FSGSPF master read returned exact native ID/audit. Existing fake master mobile blank; current New marks mobile required. Server Save/duplicate behavior unproved.
- [U7 evidence](2026-11-04-u7-native-nightly-research.md) · [U8 evidence](2026-11-04-u8-native-guest-profile-research.md) · [UI evidence](2026-11-04-shared-pane-ui-research.md).

## Orca visibility

Run run_e90413ed9082. All five Tasks completed; tabs/worktrees retained for owner conversation.

| Child | Verified live model | Output |
|---|---|---|
| plan-code-gaps-20261104 | Luna Max | Exact code/path/action/API critique |
| plan-critical-path-20261104 | Luna Max | Timing research + readiness critique |
| plan-ui-system-20261104 | Terra Max | Shared five-workflow UI |
| u7-native-nightly-20261104 | Terra Max | Native amount research |
| u8-native-profile-20261104 | Terra Max | Profile master research |

worker-start created tabs but timed out at readiness before delivering Tasks. Reused same terminals through direct dispatch; no duplicate workers.
Live turn_context verified requested models/Max; launch receipt effort=null alone was insufficient.
Reviewers exceeded initial15m allowance; parent ended further reading and requested collected findings. No claim all time saved.
U7 briefly delegated a native child despite task restriction; stopped further hidden delegation. Execution lanes must remain Orca-visible.

Scope this turn: docs/research, one blank HMS Create read, one exact master read, existing captures/source/logs.
No product changes, RDS mutations, HMS Saves/sends/charges, tests/build/deploy/PR.

Final arithmetic: Amend114–203m; full187–346m. Four workflow PRs; two deploy waves. Conditional task forecasts, not measured completion times. Similar upper band is explained by the chain, not worked backwards from the old estimate.
