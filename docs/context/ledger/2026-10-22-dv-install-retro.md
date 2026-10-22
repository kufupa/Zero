# DV install run retro — 2026-10-22 (10:05–15:48Z, Opus orchestrator)

Goal: get Da Vinci (HRDAV) "Make quote" and "Create provisional booking" to Centurion parity, plus Centurion create readback and PR #476. The owner paused the run at ~15:41Z for this retro.

## Result

| Item | Outcome |
|---|---|
| Merged + deployed | #476 and #480–#487. Live `e5231310a` (deploys at 11:51, 11:59, 13:53 and 14:37Z). Health 200/200, 4 procs |
| Centurion real-guest create | `PANE_WRITE_CREATE=on` at 12:07Z, back to `lab` at 15:47Z (owner: back to testing, no real bookings). `/proc` checked on all 4 procs |
| DV create (Labtest) | **Not proven.** 7 runs, 2 Save clicks, 0 bookings. `HMS_DAVINCI_CREATE=lab` on all 4 procs |
| DV quote | Blocked. The rate-policy source accepts Centurion docs only, and the DV truth set has 6 of the 10 threads needed |
| #488 (dialog logging) | Open; gates incomplete |
| ETA | Estimated 150 min, took 344 min (ratio 2.29). Outcome: partial |

## Timeline (Z)

| Phase | Time | Min | What consumed it |
|---|---|---:|---|
| Build / review / gates | 10:05–11:51 | 106 | #476 and #480–483 overlapped |
| Deploys 1a + 1b + create on | 11:51–12:08 | 17 | Deploy execution |
| #480 finalisation | 12:08–12:40 | 32 | Review rounds |
| Unattributed | 12:40–13:38 | 58 | DV quote-policy research ran in parallel. Idle time vs waiting was not logged |
| #485 + deploy 2 | 13:38–14:01 | 23 | |
| DV Save attempts 1–6 | 14:01–14:22 | 21 | 0 clicks. Causes: script pre-check bugs; pre-save search refused; all rooms restricted on 2027-11-16; Guest Stay node off-viewport |
| #487 + deploy 3 | 14:22–14:46 | 24 | PR open→merge took 10 min (14:27–14:37); deploy ~9 min |
| DV Save attempt 7 + Save 2 | 14:46–15:16 | 30 | Save 1: "page contains errors" (DV requires Reservation Note). Save 2 hung on the mask; no booking found |
| #488 + gates | 15:16–15:48 | 32 | Grok "Argument list too long"; a brittle old test; EC2 test clone missing the SHA |

## "A 10-line PR took 60 minutes"

- **#487** (+34/−5 runtime lines): **10 min** open→merge. The ~49 min was the whole chain: merge → deploy (~9 min) → live HMS attempt.
- **#488** (+12/−1): **≥18 min and still unmerged**. Three gate-tooling failures, none of them about the code.
- **Where the time really went:**
  - live HMS proof: 73 min, 7 runs, a new trap on each run
  - four deploys: ~31 min
  - an unlogged 58 min block

## Root causes

1. **Serial DOM/data discovery on live HMS.** Each Save attempt found the next trap: availability, then viewport, then a required field, then mask/hang. Two earlier lessons were not applied:
   - SR2: diagnose the whole commit screen before making sequential fixes.
   - SR3: run a fresh page and an exact-date availability preflight before Save.
2. **Gate tooling, not code.**
   - Grok got the diff in argv.
   - The EC2 node-test clone ran before remote-typecheck had shipped the commit.
   - A brittle source-slice test broke on an unrelated edit.
3. **Unlogged time.** 58 + 13 min have no phase record. The orchestrator did not log phase changes to the run log.
4. **Wrong estimate basis.** The 150 min covered code and deploy only. It did not budget live-HMS discovery, which was already measured: ~6 h in SR2, 184 min to the first confirmation in SR3.

## Rules (also in MISTAKES.md)

| Fix | Saves per similar run (est) |
|---|---:|
| Before any Save, run one read-only preflight per property. It covers: fresh tab; exact-date rate/room availability; a required-field scan of the commit screen; duplicate search in the same context; nav-node visibility | 25–45 min |
| Grok review input is a file path (`git diff origin/main... > f`, then the prompt says "read f"), never argv | 10–20 min |
| Fixed gate chain order: push → remote-typecheck (ships the SHA) → node and unit tests on the same SHA → Greptile. The runner checks the SHA exists first | 10–20 min |
| Live-HMS ETAs use the measured SR2/SR3/DV proof times (~70–180 min per new property or write type), not code-time medians | Fixes estimate error, not minutes |
| Log every phase change to the run log with a timestamp | Makes retros exact |

## Stagehand question

**Verdict: no for live HMS; maybe as an offline locator helper.**

- Of the 7 failure classes seen today, at most 1 (the off-viewport node) is a selector problem Stagehand might fix.
- The other 6 are HMS state, availability, required data and commit verification. A self-healing locator cannot fix those.
- Stagehand caching replays without an LLM only until the page changes. On a cache miss it calls the LLM again on live HMS, which breaks the "no LLM drives live HMS" rule.

Report: [2026-10-22 Stagehand decision](../../research/2026-10-22-stagehand-hms-decision.md).

## Cleanup done

- **Removed:**
  - 31 merged, clean, idle worktrees and 162 merged local branches. Their SHAs were appended to `~/.claude/cleanup-2026-10-10-deleted.tsv`.
  - sr2-Ud screenshots were archived first, to `~/.orca-archive/2026-10-22-sr2-Ud/`.
- **Kept:**
  - open-PR trees: #462, #463, #479, #488
  - dirty `ec2-disk-retention`
  - unpushed `handoff-20261020`
  - `sr3-plan`
  - the deploy tree and the coordinator tree
