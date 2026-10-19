# 2026-10-19 afternoon lanes retro

**Verdict: Add-in 1.0.18, HRDAV slot and the small HMS flag fixes shipped live; #376 also deployed. F's #382 shipped, then broke every cold HMS login; #388 hot-fixed it, but storageState gave no speedup. D earned no valid holdout score, B2 stayed a proposal, and no PRODUCT.md workflow bar moved.**

Evidence: ETA ledger, last lane screens, Claude transcripts, merged PRs #374–#388, and coordinator verification at 13:15–13:40Z. Transcript locators: B `548a7e98`, C `93697740`, D `6c28db8a`, coordinator `e49ceaf9` (UTC). “Open” means no close was recorded. This retro changed no production/HMS state; only this requested doc branch is written.

## Lane results

| Lane | Model | Planned | Shipped / live? | ETA est / actual / ratio | Stuck min + cause | Over/under-engineered? |
|---|---|---|---|---|---|---|
| A / HMS | Opus 5.5 coordinator | Diagnose dead letters and party wait; deploy fix | #376 deployed 10:43Z | 230 / 55 / .24; diag 45 / 20 / .44 | 6m; SSM helper + dirty-tree gate; 5m rework | Right-sized after diagnosis: planned queue reorder became a 9-line fix (`chatA-20261019-diag-pr376`). |
| B / party eval | Grok 4.6 high, Cursor; Haiku plan driver | 72h bind truth and miss causes | #380, #383 docs; no product code | 40 / 12 / .30 | Not logged; no rework logged | Right-sized read-only work; only 7 independently labelled rows, so no variant loop (`lane-b-20261019-party-eval`). |
| B2 / party design | Opus 5.5 | Approved v3 plan | Proposal only; no plan file or owner go in screen | 290m proposed build / no actual / n.a.; 7m13 design screen is different work | No stuck minutes logged; waiting owner | Too broad for current truth: proposed ~250-reservation sweep before approval (`party-v3-design-20261019`; B2 screen 12:43Z). |
| C / remote-http | Haiku planner → Sonnet 5.5 code (“Luna max” slot) | Quote-prep allowlist; system_notice only after owner decision | #384 quote flag reported on remote-http; #387 Da Vinci-read allowlist; system_notice not shipped | 25m W row open; later 74m merge + 30m live rows open; n.a. | Not logged; plan checks consumed 101m before C plan | Good small W slice; correctly held S for owner decision (`ship-small`/`93697740` 09:53–11:34Z; coordinator 13:15–13:40Z). |
| D / triage holdout | Haiku planner → Luna/Sonnet + Sol | Aug–Sep holdout; GEPA only if valid gate finds gap | No valid score, PR or deploy; D0/D3 only | no-GEPA 56 / 52.4 / .94 partial; GEPA 96 / 52.4 / .55 abandoned before GEPA | 7m stuck, 9m rework; production-input parity failed | Under-validated parity; correct stop before a false score (`chat-d-20261019-run-nogepa`; D screen 13:05Z). |
| E / add-in | Grok 4.6 high, Cursor; Haiku plan | Harden 1.0.18, Windows build, Zero pin | Add-in PR #9 merged; installer published; #386 pin merged | 75 / 50 / .67; earlier 55m row has no close | Not logged; owner virus check was a release gate | Right-sized; code + two local reviews + CI took ~40m (`lane-e2-20261019-addin`; coordinator handoff). |
| F / session reuse | Grok 4.6 high, Cursor | storageState reuse across 12 tools; probe | #382 deployed 13:15Z; cold login broke; #388 hotfix merged 13:29:58Z. After fix: cold login 7.98s, `portable:false`; no speedup | 40m lane row open; follow-on 60m row open; n.a. | 25m bad-deploy window, 13:15–13:40Z; selector missed Infor's `type=text name=password` | Overbuilt the wrong lever: 12 callers + state file cannot help when Infor rejects fresh-context state. F2 one page / one spawn per party job is the real lever. |
| G / Da Vinci slot | Grok 4.6 high, Cursor | HRDAV unit + parallel reads | #381 service active; #387 webmail allowlist; coordinator checked all 4 pm2 processes and Da Vinci reads | 45m start has no matching close; separate 40m close has no start/estimate; n.a. | Not logged; separate close says 3 Greptile rounds | Focused script; potential over-review: 3 rounds on small unit work (`lane-g-20261019-hrdav-v2`; #381). |

## Model routing

| Route | Speed / rework | API-price equivalent |
|---|---|---|
| Grok 4.6 high, Cursor | B 12/40m (.30); E 50/75m (.67); F has no close. E had two local reviews; rework not logged. Fast on bounded work; no Cursor transcripts. | Not measured. |
| Haiku 5.5 max, planners | First prompt → plan: B 65m46s, C 101m03s, D 99m19s (B `548a7e98`; C `93697740`; D `6c28db8a`). B's final close was 56/33m (1.70); C/D spent most time checking before writing. Not a controlled model-speed test. | ~$11.72–$11.97 API-equivalent; worker transcripts only, not billed spend. |
| Luna max / Claude Code Sonnet 5.5 slot | D 52.4/56m (.94) partial, 7m stuck + 9m rework, no score. C's W flag shipped; no close in ledger. | ~$10.83–$12.90 API-equivalent; worker transcripts only. |
| Opus 5.5 coordinator | A diag 20/45m (.44), 4m stuck + 3m rework; full A 55/230m (.24), 6m stuck + 5m rework. #376 shipped; #382 went live before probe. | Coordinator cost not measured. Separate Opus worker/design logs: ~$10.32–$11.51 API-equivalent. |

Cost method: unique assistant messages at/after 09:53Z in eight worker JSONLs; token vectors (input / cache-write / cache-read / output, MTok): Haiku .00024/.661/16.006/4.204; Opus .00035/.396/26.596/.151; Sonnet .114/1.377/30.469/.412. Haiku uses the >100k tier per AGENTS.md; cache-write duration is unknown, so ranges. Opus coordinator JSONL and Cursor/Grok usage are not included. Rates: [Anthropic list pricing](https://platform.claude.com/docs/en/about-claude/pricing). These are estimates, not invoices.

## Keep / stop / try

| Call | Evidence |
|---|---|
| Keep: diagnose before coding; choose small, bounded work. | Nine-line fix replaced queue-reorder plan; #376 deployed; `chatA-20261019-diag-pr376` 20/45m. B used existing truth and stopped before a weak variant (`lane-b-20261019-party-eval`, #380/#383). |
| Keep: split small deployable slices. | #381 was 163 script lines + 248 tests; #375/#384/#387 were +19/+15/+7 lines. E shipped installer and pin (#386). |
| Stop: deploy an HMS runner before its live DOM probe. | #382's 12/12 unit tests never saw Infor's DOM; cold login waited 120s then timed out. Coordinator found it on HRDAV; #388 fixed the selector. Existing AGENTS.md gate was skipped. |
| Stop: let plan lanes verify everything before posting a plan. | Haiku B/C/D took 66/101/99m from prompt to plan (`548a7e98`, `93697740`, `6c28db8a`); C/D status still checked facts at 10:14, 10:45 and 11:13Z; coordinator said stop at 11:27Z (`e49ceaf9`). AGENTS.md says 67m for C/D, so elapsed-time sources disagree. |
| Stop: score D without production-input parity. | D had only 7 image-free quote examples; attachment/vision parity failed, so no valid holdout score (`chat-d-20261019-run-nogepa`, 13:05Z). |
| Try: switch F to one persistent page / one spawn per party job. | Probe after #388: 7.98s cold login, `portable:false`; state-file reuse has no payoff. See session-reuse plan slices 2–3. |
| Try: make the cold, read-only DOM probe a blocking pre-deploy gate for every changed HMS runner. | #382/#388, coordinator 13:15–13:40Z; match the actual Infor password field, not its `type` attribute. |
| Try: parity-first D rerun; stop before tuning if production attachment input or independent truth is too thin. | D's 52.4m partial run, 9m rework, 7m stuck; no score and no GEPA. |

## Coordinator mistakes

| Mistake | Evidence / correction |
|---|---|
| Copied the wrong HMS profile path into the handoff. | Handoff §2 and F screen used `/var/lib/nava/...`; coordinator `e49ceaf9` repeats it at 12:36, 12:47 and 12:54Z. Owner corrected it at 12:55Z: `/home/ubuntu/.nava-hms-slot/<prop>/profile`; a 13:15 note still mixed both paths. This retro did not inspect the live filesystem. |
| Re-checked whether a Da Vinci secret existed after owner said stop. | `OWNER-ASKS.md` line 228; coordinator `e49ceaf9` at 13:16Z. Adjacent commands mention secret checks, but do not prove a value fetch; no secret name or value belongs here. |
| Deployed #382 before its live probe. | Coordinator timeline: deploy 13:15Z; HRDAV probe found cold-login break ~13:30Z; #388 hot-patched it. Existing live-probe rule was already in AGENTS.md. |
| Let plan checks run too long. | C/D first prompts 09:53Z, plans 11:34/11:32Z (`93697740`, `6c28db8a`); owner said stop checking at 11:27Z (`e49ceaf9`). Transcript elapsed is 99–101m, not the 67m noted in AGENTS.md. |

## PRODUCT.md workflow progress

| Workflow | Pass bar | Last measured value + date | Moved today? |
|---|---|---|---|
| Quote | Staff rate plan + nightly price on every plannable proof ask (≥10 threads) | 7/29 passed, Oct 15 (FACTS §8); separate 2/2 quote `read_tool` runs succeeded at 09:55/09:58Z Oct 19; no new price-match score | No bar movement; C's remote-http flag is infra only. |
| Create | Human approves; Nava creates; ~3 golden rows; no numeric accuracy bar | Not measured; historical golden set had no create rows (ACTIVE.md) | No. |
| Amend | Correct reservation found on ≥95% of golden rows | Not measured; amend save still not wired (ACTIVE.md) | No. |
| Cancel | Correct reservation found on ≥95%; lab-only pending owner | Not measured; preview remains disabled (ACTIVE.md) | No. |
| Front door | ≥90% agreement, ≤1% failures at production concurrency/effort | Oct 19 frozen text-only test: 431 rows, 90.3% accuracy / 88.6 macro-F1; quote P/R 88.5%, new_booking P 85.9%; no afternoon valid holdout (`2026-10-19-leak-free-triage-eval.md`) | No. D stopped at input-parity gate. |
| Party bind | 0 wrong auto-binds; auto-bind ≥70%; top-3 ≥95% | Oct 19, 72h: 14/121 auto-bound (11.6%); 2/7 top-3; 0/1 wrong on independently labelled rows (`2026-10-19-party-eval-72h.md`) | Evidence only; bar not met, truth thin. |

## ETA ledger joined by ID

Actual ratio = recorded `actual_min / estimate_min`. “Stop” is elapsed to supersede, not task actual. Duplicate closes stay visible. Minutes rounded to 0.1; ratios to 2 decimals.

| ID | Est | Actual / ratio | Stuck / rework | Close or cause |
|---|---:|---|---|---|
| `c1-prior-only-20261019T024520Z` | 35 | 46.8 / 1.34 | 4 / 10 | Pass; 2 validated P1s. |
| `chat-a-20261019-hms-speed` | 70 | Open | — | Split into Chat A. |
| `chat-b-20261019-party-eval` | 36 | Stop 47.8 / 1.33 | — | Superseded; baseline/truth re-scope. |
| `chat-b-20261019-plan` | 33 | 40 / 1.21; 56 / 1.70 | 0 / 0 | First close superseded; corrected final close pass; work began 09:55Z. |
| `chat-b-20261019-steps12` | 39 | Open | — | No close. |
| `chat-b-20261019-variant-chain` | 81 | Open | — | Conditional on owner go; no close. |
| `chat-c-20261019-ship-live` | 30 | Open | — | No close row; coordinator later reported flag live. |
| `chat-c-20261019-ship-merge` | 59 | Stop 16.0 / .27 | — | Superseded after main/env/test probes. |
| `chat-c-20261019-ship-merge-v2` | 74 | Open | — | No close row. |
| `chat-c-20261019-ship-small` | 32 | Stop 97.3 / 3.04 | — | Superseded; main moved and env render needed. |
| `chat-d-20261019-chain-eta` | 96 | Stop 36.6 / .38 | — | Re-estimate; basis missed D0 export. |
| `chat-d-20261019-chain-gepa` | 87 | 45.6 / .52 | 0 / 0 | Superseded before corrected go; no eval work. |
| `chat-d-20261019-chain-nogepa` | 51 | 45.6 / .89 | 0 / 0 | Superseded before corrected go; no eval work. |
| `chat-d-20261019-plan-eta` | 135 | Stop 6.3 / .05 | — | Re-estimate; double-counted D5. |
| `chat-d-20261019-run-gepa` | 96 | 52.4 / .55 | 7 / 9 | Abandoned at parity gate; GEPA not reached. |
| `chat-d-20261019-run-nogepa` | 56 | 52.4 / .94 | 7 / 9 | Partial; no valid score. |
| `chat-d-20261019-triage-gepa` | 180 | Open | — | No close row; replaced by later D chain. |
| `chatA-20261019-diag-pr376` | 45 | 20 / .44 | 4 / 3 | Pass; #376 fix. |
| `chatA-20261019-hms-speed` | 230 | 55 / .24 | 6 / 5 | Superseded at handoff; #376 deployed. |
| `coord-deploy-f-davinci` | 15 | Open | — | No close row; coordinator later checked all 4 pm2 procs. |
| `fast-20261019-hms-reliability-quote-anchor` | 90 | Stop 23.0 / .26 | — | Superseded into 4 chats. |
| `hms-f-20261019-session-reuse` | 90 | 0 / .00 | — | Superseded before work; padded estimate. |
| `hms-f-20261019-session-reuse-v2` | 60 | Open | — | Probe/deploy happened; no ledger close. |
| `hms-f2-20261019-party-batch` | 50 | 0 / .00 | — | Superseded before work; padded estimate. |
| `hms-f2-20261019-party-batch-v2` | 30 | Open | — | Real lever still planned; no close. |
| `hms-g-20261019-hrdav-slot` | 100 | 0 / .00 | — | Superseded before work; padded estimate. |
| `hms-g-20261019-hrdav-slot-v2` | 60 | Open | — | #381/service reported live; no ledger close. |
| `lane-b-20261019-party-eval` | 40 | 12 / .30 | — | Pass. |
| `lane-c-20261019-ship-small-w` | 25 | Open | — | Coordinator later reported quote flag live. |
| `lane-d-20261019-triage-holdout` | 60 | Open | — | No close row; work moved to Chat D. |
| `lane-e-20261019-addin-1018` | 55 | Open | — | No close row; Haiku planning estimate. |
| `lane-e2-20261019-addin` | 75 | 50 / .67 | — | Pass; code/reviews/CI. |
| `lane-f-20261019-hms-reuse` | 40 | Open | — | #382 ready/deployed; no close row. |
| `lane-g-20261019-hrdav` | 45 | Open | — | No matching close. |
| `lane-g-20261019-hrdav-v2` | — | 40 / n.a. | — | Close-only; ledger's .67 has no estimate/start; 3 review rounds. |
| `next-20261019-live-quote-proof` | 8 | Open | — | No close row. |
| `next-20261019-quote-newbooking-bar` | 30 | Open | — | No close row. |
| `next-20261019-remote-http-prepare` | 12 | Stop 9.4 / .78 | — | Superseded into allowlist PR. |
| `next-20261019-remote-http-prepare-pr` | 31 | Open | — | Coordinator later reported remote-http flag live. |
| `next-20261019-system-notice-routing` | 40 | Open | — | Owner decision still needed. |
| `next-20261019-triage-v5-gepa` | 228 | Stop 18.8 / .08 | — | Owner replaced as too slow. |
| `overnight-20261019-triage-dspy` | 330 | Stop 6.1 / .02 | — | Superseded by v2 scope. |
| `overnight-20261019-triage-dspy-v2` | 330 | 195 / .59; 447 / 1.35 | 2/10; 0/15 | Two partial closes; final added live quote proof. |
| `party-v3-design-20261019` | 290 | Open | — | Proposed build chain; no owner go or close. |

Three close-only legacy IDs had no estimate/start: `wf-1-p1-gold-fix-20261018`, `wf-3-flagflip-a-d-20261018`, `wf-4-classifier-eval-20261018`; all were superseded, ratio n.a.

## Merged PR register

GitHub Greptile review events; “after” means timestamp is post-merge, not a pre-merge gate. #382's two reviews were local CLI rounds, not GitHub review events.

| PR | Title | Merged UTC | Additions / deletions | GH review events |
|---|---|---|---|---|
| #374 | docs: record final triage live proof and v5 decision | 11:51:08 | +437 | 1 after |
| #375 | fix(server-pilot): propagate retired classifier flag to remote-http | 10:21:44 | +19 | 1 before |
| #376 | fix(hms): background party/quote prep only for live mail that needs action | 10:39:04 | +84 | 2 before |
| #377 | docs: 2026-10-19 Chat A handoff (HMS speed) | 11:08:19 | +84 | 1 before |
| #378 | docs: 2026-10-19 afternoon lane briefs | 11:56:44 | +27 | 1 after |
| #379 | docs: drop client staff names from the add-in plan | 11:58:04 | +6 / -6 | 1 after |
| #380 | docs: party bind eval on 72h prod reads (lane B) | 12:11:06 | +96 | 1 after |
| #381 | feat(hms): coordinator install script for hms-slot@hrdav | 12:38:07 | +411 | 1 before |
| #382 | feat(hms): reuse borrowed-CDP login via slot storageState | 12:57:20 | +536 / -66 | 0 GH; 2 local |
| #383 | docs: split 72h party binds by answer-key sender vs gmail | 12:56:35 | +79 | 1 before |
| #384 | fix(server-pilot): allow remote quote preparation flags | 12:47:29 | +15 | 0 |
| #385 | docs: 2026-10-19 coordinator handoff | 12:47:26 | +27 | 0 |
| #386 | Pin Outlook add-in gitlink to 1.0.18 | 12:56:38 | +166 / -9 | 1 before |
| #387 | fix(deploy): pass HMS_DAVINCI_READS to remote-http | 13:13:33 | +7 | 0 |
| #388 | fix(hms): detect the Infor login form by password field name (P0 after #382) | 13:29:58 | +8 / -1 | 1 before |

## Candidate rules (do not edit AGENTS.md or MISTAKES.md here)

| Candidate one-line rule | Evidence |
|---|---|
| Before deploying a changed HMS runner, require one cold-login DOM probe on the target property; unit tests alone do not clear the gate. | #382 → #388; 12/12 units missed the live `type=text name=password` form; coordinator 13:15–13:40Z. |
| Use one verified HMS slot-profile path in every handoff; do not copy a path from an old screen without checking its source. | Handoff §2/F screen vs owner correction at 12:55Z; coordinator repeated both paths at 13:15Z. |
| If the owner already confirmed a secret exists, do not re-check its existence; inspect process injection only when needed and authorized. | `OWNER-ASKS.md` line 228; coordinator 13:16Z checks (no evidence of secret value fetch). |
