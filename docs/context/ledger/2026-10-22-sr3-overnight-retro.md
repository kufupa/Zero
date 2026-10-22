# 2026-10-22 SR3 overnight retro: write switches, Labtest proofs, Da Vinci quote (Grok orchestrator)

**Verdict: the code went fast and the proofs went slow. 11 product PRs merged, 6 deploys, 0 rollbacks, all five `PANE_WRITE_*` switches at `lab` on all 4 processes (checked in `/proc` at 09:31Z). On Labtest: create proved (2 confirmation numbers) and cancel proved (1). Amend is 0/2. Da Vinci Make quote stays off, and Government rates (O1) was cut. The whole write-code chain merged by 03:57Z, 93 min ahead of the plan. Then 140 min went into getting the first Labtest Save click and 184 min to the first confirmation number, and ~80 min went to the orchestrator sitting idle on one HOLD. Wall clock 423 min against a 380 min ETA (1.11×). Every one of the 5 hourly supervisor steers found a real problem.**

Window: 2026-10-22 02:27Z (kickoff) → 09:31Z. Live after: `5851aa930`, last-good `b11e5ac52`. Evidence:
- `/tmp/sr3/state.md` (append-only run log) and `/tmp/sr3/steer-{0432,0532,0632,0732,0832}.txt`
- `/tmp/sr3/briefs/*.txt`, and `/tmp/sr3/reviews/*` (Greptile JSON + Grok 4.7 high markdown)
- PR timestamps for #463–#478, and the ETA ledger rows `sr3-*`
- Proofs: [2026-10-22-sr3-proofs.md](../../research/2026-10-22-sr3-proofs.md). Plan: `docs/plans/2026-10-22-001-feat-sr3-writes-davinci-quote-plan.md` (branch `docs/sr3-plan`).

## 1. What shipped

| Area | PRs | State |
|---|---|---|
| Write switches | W1 #465 | Live. Five switches, `*_PAID` capped at lab. Cancel money state defaults to `unknown`, not `unpaid` (Grok P1 fix) |
| Create safety | W2 #468, W2b #470 (dismiss vanished JS dialogs), W2c #471/#472 (OK on the informational "no rooms" box only, money words refused) | Live. 3 Labtest Save clicks, 2 confirmation numbers (66865808-1 Reserved, 82126330-1 later cancelled); the first Save returned no number, see §5. **All 3 returned `committed_unverified`**, so readback is not working yet |
| Provisional cancel | W3 #469, W4 #467 (cancel hidden under CHECK) | Live. Labtest cancel 82126330-1 ✅ (balance 0.00). The penalty dialog was left unclicked |
| Da Vinci quote | D1 #464 gate, D2 #466 rates/rooms/boards, D3 #474 party index, D4 #473 branding | Live but `HMS_DAVINCI_MAKE_QUOTE` unset. D0 probe: 2 HRDAV reads, 45 options each |
| Multi-stay | M1 #475 stable stay id | Live. **Follow-up #476 open**: the leftover 1-to-1 matcher can pair the wrong stays |
| Government intent | O1 #463 | Cut at 07:45Z. The classifier gate's input (`selections.jsonl.gz`) does not exist |
| Not started (cut list §9d) | M2, O2, W5 amend proof (attempted, 0/2), L1c reprice, DV reprice (A5) | — |

## 2. Time per unit (lane start → merge; plan = code + review minutes from plan §9d)

| Unit | Plan min | Actual min | Ratio | Note |
|---|---:|---:|---:|---|
| D0 HRDAV probe | 30 | ~13 | 0.4 | 1 fail (dump dir ENOENT), fixed by root cause. Ledger row auto-closed by the reconciler at 321 min: wrong, ignore it |
| W1 switches | 115 | 42 | 0.37 | 2 Greptile apex rounds, Grok P1 real (cancel defaulted unpaid) |
| D1 DV gate | 80 | 32 | 0.40 | Greptile P1 "runStaffQuote installs HRCEN" deferred → this is why A5 was never reachable |
| W4 CHECK guard | 40 | 22 | 0.55 | Lane read a live mail with a guest name (§6) |
| W2 create safety | 120 | 25 | 0.21 | Greptile P1 "committed_unverified" was accepted as by spec, and it turned into the readback gap |
| D2 DV mappings | 95 | 43 | 0.45 | 2 rounds |
| W3 cancel | 110 | 19 | 0.17 | Grok pass, apex P2 only |
| Deploy A | 10–25 | 13 | ~0.7 | **From the wrong worktree** (sr3-W3) |
| W2b + W2c Save fixes | — (unplanned) | ~10 + ~26 | — | Unplanned because the Labtest DOM is different every night |
| D3 party index | 55 | 27 | 0.49 | — |
| D4 branding | 80 | 63 | 0.79 | PR sat ~45 min until the 06:32 steer; 3 Greptile rounds |
| M1 stable id | 60 | 21 | 0.35 | Merged with a leftover-pairing bug; #476 open |
| O1 Government | 85 | cut after 306 | — | Gate data missing; open 02:39→07:45 |
| **Labtest Save proof** | **35** | **140** to first Save click (04:16 first try → 06:36); **184** to first confirmation number (07:20) | **4.0 / 5.3** | 8 pre-Save failures (§3); the 06:36 click returned no number |
| Cancel proof | 35 | ~5 | 0.14 | 1/2: 82126330-1 preview + commit first try; 66865808-1 preview failed 08:28Z (confirmation number not visible), left Reserved |
| Amend proof | 35 | 0/2 | — | Synchronous SSM timed out at 10 min and 15 min |

Code ran at **~0.2–0.8× the plan** (median ~0.4). The plan's 1.44× SR2 inflation was wrong for small, well-scoped units. The proof driver ran **5×** over. The ETA miss is all `proof_driver` + idle; none of it is coding.

## 3. Where time went

| Bucket | Min | Evidence |
|---|---:|---|
| Orchestrator idle, 0 coder lanes, on one HOLD | ~51 | 04:41 HOLD → 05:32 steer. state.md logged "check-in continues" every 10 min |
| Orchestrator idle, 0 coder lanes, PR waiting | ~30–35 | D3/W2c merged ~06:00; D4 #473 untouched 05:48→06:32 steer; M1 launched only after the steer (06:38) |
| Save attempts that failed before Save was clicked | ~150 | 8 attempts: vanished JS dialog (04:17); "no rooms" Ext box, date had no inventory (04:41); Guest Stay off-screen from leftover UI (06:10, and again on 2027-11-18); message box during fill (2027-11-18, 2028-01-10); `refused_save_pre_save_search_unavailable` (2027-12-01); `refused_save_blank_required` (2028-02-01). **The first clean Save came 3 min after a read-only availability shop on a fresh page (06:33 → 06:36)** |
| SSM timeouts | 25 | `read-reservation-fields` 10 min (07:17), amend preview 15 min (07:27–07:43) |
| Wrong-worktree deploys | ~10 | 1 completed: Deploy A from sr3-W3 (03:58). 1 started from sr3-W2b and killed after the 04:32 steer |
| Missing slot secret | ~5 | create-lab-stay slot env had no `HMS_READ_SECRET_ARN` (04:17) |

## 4. What went well

| Practice | Evidence |
|---|---|
| Luna scoping + line estimates + Grok 4.7 plan review before kickoff | Units came in small (W4 48 LOC, W3 194, W2 328). No PR over 573 lines. No round 3 except D4 (Greptile) |
| Grok 4.7 high as reviewer | Caught the real money hole: cancel defaulted `unpaid`, which would have let a real-guest cancel through without an HMS read once switched on (W1). Also the O1 rateIntent drop |
| Flags on all 4 processes including remote-http | SR2's remote-http gap closed. `/proc` was checked after every deploy |
| Safety held | 0 real-guest writes. Penalty dialog never accepted. The W2c allowlist refuses money words. The Save budget stopped at 3 clicks |
| Root-cause on the first failure | D0 dump-dir ENOENT and the Save "no rooms" box text were both read before any fix (state.md 02:35, 05:34) |
| Steers obeyed in one turn | All 5 steers were logged and acted on within ~2 min |
| One owner per shared file (§9a) | No merge conflicts across 11 PRs; W4 went before W3 on the shared panel as planned |

## 5. What went badly

| Problem | Impact | Root cause |
|---|---|---|
| Orchestrator idle twice on a HOLD or an untouched PR | ~80 min, and 3 units cut | The 10-min monitor only re-read for steer files. The kickoff said "keep doing other units", but nothing enforced it. Same failure as SR2 retro lesson #1 |
| Deploys from lane worktrees | Hard-rule breach (PRODUCT.md): 1 completed deploy + 1 started and killed | The rule was in the kickoff and PRODUCT.md but not enforced by the script |
| Readback broken on every Save | Can't trust a Save result: 06:36 Save returned no number; a stay with that date (84701420-1) was later found Cancelled, and none of our scripts cancelled it | W2 Greptile P1 "committed_unverified" was waved through as by spec; the readback was never live-checked before the run |
| Two HMS jobs at once on HRCEN | §9c breach at ~07:26 (Save 2028-02-01 + amend preview) | No lock check in the orchestrator's own scripts |
| Amend never ran | 0/2 | Synchronous SSM with a 10–15 min cap on a slow HMS screen |
| A5 (DV Make quote) unreachable by design | Flag off, as predicted | The plan needed a DV reprice through `runStaffQuote`, but no unit wired the quote resolver to the HRDAV slot (D1 Greptile P1). DV quote asks were also ~8 < n≥10 |
| O1 gate unreachable | 5 h open, then cut | The plan named a classifier gate without checking that its input file exists |
| M1 merged with a pairing bug | Live bug (pane not in staff use) | Adjacent P1 judged "not round 3" and merged, then found again as #476 |
| Duplicate PR #471/#472 | Both merged, harmless | Orca prefixes branches `kufupa/`; the lane pushed both names |

## 6. Lane briefs

| Check | First wave (W1 D1 O1 W2 W3 W4 D2) | Later (D3 D4 M1 W2b W2c, ~1 KB each) |
|---|---|---|
| Plan unit section verbatim | Y | Partly (D4 pasted, M1 summarised) |
| Owned files | Y, but O1 omitted `ai/work-items.ts` → Greptile P1 | Y |
| Exact test files | Y | **D4 none**, M1 Y |
| No live mail / no PII line | **W4 missing** → lane read a live cancellation mail with a guest surname (03:26) | Generic "no live HMS" only |
| Handbook §10 header verbatim (kickoff demanded) | Partial | No: a 3-line summary |

Briefs got shorter as the orchestrator's context grew (262K at 04:30 → 390K at 08:30).

## 7. Plan critique

- **Estimates:** coding was over-inflated (×1.44 SR2 factor on ~0.4× work); the live proof was under-estimated (35 min vs 184). Next time: code at ledger median (~0.5–0.8), and Labtest Save at ≥120 min to the first click and ≥180 min to the first confirmed number until 3 nights pass cleanly.
- **Save budget rule was undefined.** The orchestrator decided that only clicks reaching Save count. That's right, but it belongs in the plan.
- **HMS queue (§9c) was right but unenforced.** It needs a lock file the scripts check.
- **A5 and the O1 gate were dead on arrival.** Both depended on code or data no unit produced. The plan review (4 P0 / 9 P1) did not catch it, and I wrote the A5 bar without checking the resolver.
- **Cut list worked:** M2 → O2 → W5 → L1c were taken without asking. D4 survived the cut because the code was fast.

## 8. My supervision (planning chat)

| Steer | Real problem? |
|---|---|
| 04:32 deploy worktree + last-good | Yes, hard-rule breach |
| 05:32 idle 51 min on HOLD | Yes |
| 06:32 idle again, 0 lanes | Yes |
| 07:32 Save budget spent + 2 HMS jobs at once | Yes, a 4th Save was close |
| 08:32 HRCEN slot left with the penalty dialog in staff hours | Yes |

5 of 5 found something, so hourly was too slow. A 30-min check would have cut each idle stretch to ≤30 min.

## 9. Rule changes for next run

1. **Supervisor every 30 min**, not 55–60. (5/5 hourly steers found a real problem; idle stretches 51 and ~35 min.)
2. **Orchestrator monitor tick = act, not log.** Each tick counts running lanes, open PRs untouched >15 min and the unit list. If lanes = 0 and the list isn't empty, launch the next unit in the same turn. Ban "check-in continues" with 0 lanes. (SR2 lesson #1, repeated.)
3. **`ops-deploy.sh` refuses to run outside `.worktrees/recover-parse-failure`** (code guard, small PR). Text rules failed twice tonight.
4. **Labtest write preflight:** fresh page (navigate home or re-login), then a read-only availability shop for the exact date and room, then Save. Pre-Save failures don't count against the budget; the plan template says so. (First clean Save came 3 min after the first shop.)
5. **Long HMS jobs never through synchronous SSM.** `systemd-run` on EC2, then poll a result file. (Amend lost both slots to 10/15 min SSM timeouts.)
6. **Briefs from a template with required fields:** owned files, test files, unit verbatim, the line "never open live mail, never copy guest names". The orchestrator checks the brief before sending. (W4 PII read, O1 missing file, D4 no tests.)
7. **Every gate and approval names its input, and the kickoff checks it exists** (data file, wired code path, n available). O1 and A5 were unreachable from minute 0.
8. **Create readback is a pass bar, not a P2.** `committed_unverified` with a confirmation number on screen = a bug. Fix it before `PANE_WRITE_CREATE=on`.

ETA ledger: `sr3-run-20261022` closed 423/380 = 1.11, outcome partial, mistake_class proof_driver.

## 10. Closeout gaps (added 2026-10-22 ~16:30Z)

| Item | State |
|---|---|
| Model spend vs budget | **Unavailable.** The run used Grok 4.6/4.7 CLIs with no per-run cost export, and no budget was set in the plan. Next run: set a $ cap in the plan and log spend per lane |
| PRODUCT.md pass bars | **Not measured.** No bar was scored: DV quote stayed off (A5 unreachable, ~8 asks < n≥10), create readback was broken on all 3 Saves, amend 0/2, golden set not re-scored. Merges and Labtest proofs are progress, not done |
| `nightly-retro.sh` / `ce-compound` lane-close | Not run by the orchestrator. This retro plus the [solutions note](../../solutions/workflow-issues/hms-live-write-preflight-and-long-jobs.md) are the closeout |
| Proofs report index | Added to `docs/research/README.md` and `CATALOG.md` |
| Follow-up | The same preflight lesson repeated in the [DV install run](2026-10-22-dv-install-retro.md) the same afternoon (7 runs, 0 bookings). The fix is now a planned tool, not a text rule |
