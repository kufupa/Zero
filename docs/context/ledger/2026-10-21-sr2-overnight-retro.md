# 2026-10-21 SR2 overnight retro: stay-request v2 build (Grok orchestrator)

**Verdict: 22 product PRs merged, deployed 7 times with no rollback and no flag flips, and the first Labtest Save through the pane passed. But the "done" bar in PRODUCT.md was not met: the quote replay never ran (U11b stuck as a 598-line draft) and the amend never committed. The run took 3.2× the 285-min launch ETA overall, but only ~1.4× on coding. The rest was orchestrator idle time (~76–170 min), waiting on the owner (~8 h of exposure on H5, U11b and the amend rule), a 5-round Labtest fix loop, and the planned Wednesday HMS maintenance.**

Window: 2026-10-20 20:30Z (kickoff) → 2026-10-21 11:37Z (H5 done). Live after: `b11e5ac52` (last-good `621058d23`). Evidence:
- `/tmp/sr2/state.md` (611-line run log; line refs below as `L<n>`) and the ETA ledger rows `sr2-*`.
- PR timestamps, Greptile/apex review JSON in `/tmp/sr2/reviews/`, lane briefs in `/tmp/sr2/briefs/`.
- Grok `usage.json` per lane.
- Three read-only Luna max lanes (time, engineering fit, client readiness), outputs in `/tmp/sr2/retro/lanes/L{1,2,3}.out`.

## 1. What shipped

| Area | PRs | Live state |
|---|---|---|
| Pane | U1 Contact label #431, U2 BAR grid before room pick #439, U7 CHECK screen #437, U6 one card per stay #448, U9 Make quote / Create booking labels #450 | Live; bundle `nava-pane-CP6dZvHL.js` built 04:15Z, after the last pane merge (#450 03:39Z). Loaded 05:08Z, 07:05Z and 11:06Z (who loaded it not checked) |
| Quote | U10 BAR tagged public/government/contract #441, U3 email-named party ranks over history #436 | Live |
| Extraction | U5a per-stay guests and action #435, U5b multi-stay consume #444, U5r internal-staff stay asks #445 | Live; classifier gate 431 rows ×2 runs, within noise of v4; quote recall 11/11 |
| Labtest create | U4 #433, U4b #449, U4c #452, U4d #453 | First pane Save in Labtest passed (`25526053-1`); nothing cancelled |
| Amend | U8 #442, U8b #454 | Built; preview refuses safely on blank Deposit Received (`payment_unknown`). 0 commits. Needs the owner's payment rule |
| Multi-mailbox ingest | UDV-1 #432, UDV-2 #438, UDV-2b #446, UDV-3 #447, UH5 #455 | Live; H5 promoted 3,363 Da Vinci rows, 0 duplicates, AI skipped (no cost) |
| Eval | U11a scorer #434 (merged); U11b replay runner #451 | **#451 is a draft**: 598 product LOC, 4 review rounds, stopped. Replay never ran |

## 2. Where the time went (L1 lane)

| Bucket | Min | Note |
|---|---:|---|
| Wall clock, kickoff → last work | 906 | vs 285 launch ETA = **3.18×** |
| Coding (18 closed ledger rows, minus logged stuck) | 723 lane-min vs 502 ETA | **~1.44×**. Lanes overlap, so this is not wall time |
| Orchestrator idle, nothing running | ≥76 strict, ~170 incl. state-labelled gaps | Gaps: 00:11–00:54, 03:00–03:54, 05:32–05:55, 06:01–06:54Z |
| Waiting on owner decisions | ~482 exposure (overlaps work) | H5 scope 03:58–07:10Z; U11b design 05:20Z→; amend rule 07:55Z→ |
| Deploys (7) | ~59 | 5–7 min each after #1. All health 200 |
| Planned HMS maintenance | 191 | Wed 10:04–13:15Z. Hotel IT: every Wednesday ~12:00 to 15:00–15:30 SAST. Not a fault |

Owner rule (2026-10-22): idle and owner-wait time are not ETA misses. On coding alone the estimate held (~1.4×, the ledger median is 0.87 for code-server). The overrun is a supervision problem, not an estimation one.

Biggest sinks:
- **Labtest create:** 5 fix-and-deploy rounds, 358 min from first try to the amend stop (L236, L329, L366, L439, L475).
- **H5 / UH5:** 221 active min vs 90 ETA. 3 review rounds found 4 real P1s (L500–L550).
- **UDV-2:** 220 min vs 76 ETA. 569 product LOC, 2 real P1s, recovery split off late as UDV-2b.
- **U5b:** 175 min vs 28 ETA. 4 real P1s in stay identity, room-guest allocation and edits.

Savers:
- **H5 rest apply:** 21 min vs 45 ETA.
- **UDV-3:** 36 min vs 47 ETA.
- **U4d:** 7 min vs 21 ETA, once the live probe had found the real cause.

## 3. What went well

| Practice | Evidence |
|---|---|
| Parallel lanes in their own worktrees, as Orca children of sr2-orch | 22 merged PRs in ~11 h; Orca cleaned as lanes merged (only sr2-orch, U8, U11b left) |
| Reviews earned their keep | 20 real prod-path P1s caught before merge, 0 P0: U2 3, U5b 4, U6 3, UDV-2/2b/3 5, UH5 4, U8 1 |
| Apex review for big PRs (owner ask 174) | UDV-2's 2 real bugs found; fixes split into UDV-2b |
| DB-test helper `/tmp/sr2/bin/remote-vitest-db.sh` (throwaway Postgres on EC2) | UDV-2's DB tests had been silently skipped; now they ran |
| Eval validity check (input-token means) | U5a's baseline rerun was invalid (mean 6,679 vs 7,181 tokens, 37 rows lost). Caught and redone, not used to pass the gate |
| Safety held | 1 Save, never a second; no cancel; amend refused when payment was unreadable; H5 left Centurion-only rows (owner option A) |
| Deploys | 7 deploys, 0 rollbacks, flags checked in `/proc` each time (`SAVE=lab` on 3 procs) |
| Live probe once used | U4d took 7 min after a read-only probe showed Track was already valid and the lookup opened the wrong control |
| Planning chat as supervisor | Steer files plus one-line pointers unblocked each idle gap; H5 was run by the planning chat |

## 4. What went wrong

| # | Problem | Cost | Root cause | Rule (next run) |
|---|---|---|---|---|
| 1 | Orchestrator idle 4× (23–54 min each) | ~76–170 min | No wake-up armed when the orchestrator ended a turn. Asked several times; never set up. The hourly planning check was too coarse | Never end a turn with lanes running and nothing armed. One background watcher per lane (PR head / gate result / terminal idle) that wakes the orchestrator. The supervisor checks every ~20 min, not every hour |
| 2 | Owner decisions sat ~8 h | Blocked H5 (3 h), U11b and the amend | Decisions surfaced one at a time, overnight, as they came up | List likely forks at kickoff (H5 filter, payment rule, size splits) with recommended defaults. A reversible fork takes the default and is logged; only holds wait |
| 3 | Labtest create: 5 fix rounds (U4→U4b→c→d→U8b) | ~6 h span | Guessed from failure screenshots one at a time. One wrong planner guess ("wait for the room rate before guarantee") cost ~1 h and a deploy | One read-only DOM dump of the whole commit screen before the first fix; check each new gate against earlier passing previews |
| 4 | Done metric never ran | Quote score unmeasured | U11b scheduled last, grew to 598 LOC and 4 rounds | Run the scorer first. Split anything planned over 500 product LOC at planning time (UDV-2, U11b) |
| 5 | U6 split control built then stripped | ~$43, the most expensive lane | Optional behaviour bundled into the main card PR | Optional controls go in their own PR (U6b) |
| 6 | Orchestrator context filled twice (216K, 168K) | Compaction stalls; $120 of the $335 Grok spend (0.83M cached tokens per turn) | One long chat for 15 h | Hand off at slice boundaries per AGENTS.md (~150K) |
| 7 | My HMS monitor counted `ok` as a failure | False "still failing" alarm | Guessed the status value | `hitl_tool_run` success = `ok`. Check enum values before writing a watcher |
| 8 | Treated planned maintenance as an outage | Owner asked to escalate needlessly | Didn't know the weekly window | Logged in memory and state; label Wednesday-window failures as maintenance |

## 5. Engineering fit (L2 lane)

| Verdict | Units |
|---|---|
| Right-sized | U1, U3, U4 family, U5a, U5r, U7, U8 family, U9, U10, UDV-1, UDV-2b, UDV-3 |
| Under-engineered (P1s found in review) | U2 (dropped grid rows, mixed occupancy, 200-option cap), U5b (stay identity, room guests, edits), UH5 (filter order, Sender, limit, CLI) |
| Over-engineered or too big | U6 (split control), U11a (458 LOC scorer), U11b (598 LOC replay), UDV-2 (569 LOC) |

Patterns:
- Real P1s cluster where persisted or edited shapes change (U5b, U6). Test them with stable ids and real room counts.
- Replay and eval code kept growing defects (pairing window, failure cases). Keep runners thin and freeze the truth set separately.
- Two review P1s were churn: U4 #433 pointed at files not in the diff; UDV-2's stamp-routing finding conflicted with the accepted rule.

Cost, for the record: Grok $335 across 21 sessions (orchestrator $120, lanes $215; ~$9 per merged unit PR). Luna eval runs ~$4. The owner treats this as acceptable.

## 6. Learnings promoted

- **AGENTS.md:** the idle-watcher rule and the kickoff decision list are added to the limits table.
- **MISTAKES.md:** rows 1–4 and 7–8 above.
- **Memory:** Wednesday HMS maintenance; `hitl_tool_run` status values.
- **Client readiness:** [2026-10-22 client readiness](../../research/2026-10-22-client-readiness.md).

## 7. Next acceptance checks

1. Quote score on ≥10 real threads (U11b decision D2, option A: frozen truth file plus a slim runner).
2. One Labtest amend commit after the owner's payment rule (D1).
3. Centurion stay-lookup reliability: 66 failures (22 distinct bookings) and 66 lock-busy refusals in 7 days, outside maintenance.
4. A live Da Vinci mail routed to its transport and visible in the pane.
