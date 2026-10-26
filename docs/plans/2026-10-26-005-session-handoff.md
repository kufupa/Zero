# Session handoff — 2026-10-26 ~14:00 UK (or2 coordinator → next chat)

**Read this first. It is the single entry point.** Two audiences:
- **Parallel chat (now):** do anything that does NOT touch `/tmp/or2`, the or2 lane worktrees, or the deploy train. Running or2 lanes own their files until they merge.
- **Successor chat (after this one ends, ~15:00 UK):** take over or2 closeout (section 6) and then the next run (section 7).

Owner prefs that matter: caveman + adhd replies; times in UK; $ by model; speed mode always (max parallel); evidence behind every ETA; log asks in `docs/context/OWNER-ASKS.md`.

## 1. Read order (≈10 min)
1. `PRODUCT.md`, `AGENTS.md`, `docs/context/ACTIVE.md` (on main; ACTIVE needs the or2 update, section 6).
2. This file.
3. Retros: [or2 retro](../context/ledger/2026-10-26-or2-retro.md) (full overnight; §9 = 5 structural fixes) · [T2 ETA cut](../research/2026-10-26-t2-eta-cut.md) · deterministic nightly `~/retros/2026-10-26.md`.
4. Plans: [run plan](2026-10-26-002-overnight-run2-plan.md) · [T2 replan](2026-10-26-003-t2-fast-replan.md) · [green-main](2026-10-26-004-green-main-handoff.md).
5. Skill: `~/.claude/skills/speed-plan/SKILL.md` (turns a high-level plan into a max-parallel run; use it for the next run).
6. Runtime rules digest: `/tmp/or2/RULES.md`; lane prompt: `/tmp/or2/lane-protocol.md` (incl. NO-MEMORY CHECKLIST for Grok/Luna lanes).

## 2. Where things stand (13:55 UK)
**Live on prod:** `809f5fa` (deploy train, 13:47). T1 complete (34/34) + T2: H1, H2, I, L1, L2, HMSDOWN, plus green-main WORKITEMS, PANE-A, VITE. DISK #600 and PANE-B #604 merged, deploying next.

| Staff-visible | State |
|---|---|
| Book in HMS preview survives click-away (L1+L2) | live |
| HMS outage pause ("HMS is down… Nava will finish automatically") (HMSDOWN) | live |
| Undo/Redo, Reset to AI, AI/Edited markers in pane | **not yet**: J1 → J2 → WIRE, ETA ~14:40 UK |

**Running lanes** (`/tmp/or2/state/*.status`):
| Unit | PR | State / next |
|---|---|---|
| DS4-J1 (undo/redo server) | #597 | round-3 strip fix (refuse `history_stale` after extraction relink) → merge |
| DS4-J2 (undo/redo component) | #599 | ready, waits J1 |
| DS4-WIRE (mount controls in pane) | #607 | blocked on a P1 in J1's file; auto-relaunch queued for when J1 merges (`/tmp/or2/wire-after-j1.pid`) |
| GREEN-TYPES-PROD / -TESTS | — | Luna, fixing 51 mail type errors so typecheck = 0 with no baseline |

**Prod switches (checked /proc 12:45 UK, do not change without owner):** `HMS_DAVINCI_MAKE_QUOTE=on`, `HMS_DAVINCI_CREATE=on`, `PANE_WRITE_CREATE=on`, `RESERVATIONIST_PANE_SAVE=lab`, amend paid/unpaid `lab`, cancel unpaid `on` / paid `lab`, `HMS_QUOTE_PREPARE=true`.

**Da Vinci (owner ran DV training 13:00 UK):** BAR priced 10:28 UK and DOML 10:39 on `transport-davinci` (first priced DV BAR, DV P0 bar likely met; confirm price in canary write-up). 12:38 BAR on `transport-faith` failed: "Room profile out of date or missing" (multi-room-type ask) → open item 7.3. DOML "no rate for this meal plan" = HMS data, not a bug.

**HMS:** Centurion planned outage 10:00–16:00 SAST (08:00–14:00 UK) today; Wednesdays no longer down. 44 read jobs were queued since 08:12 (mostly HRCEN) and should drain after 14:00 UK.

## 3. Rules this run proved (keep)
- One reviewer: **Greptile Apex**. `merge-gate.sh` = Apex SUCCESS on head + 0 open P0/P1 + ≤500 product lines. Lanes fix their own P1s. Round 3 with a new P1 → coordinator decides **strip / split**, never round 4.
- Coders: **Grok 4.6 high via Cursor** `cursor-agent -p --output-format stream-json --model cursor-grok-4.6-high` (never the Grok CLI, never -fast); **Luna** `codex exec -m gpt-6-luna -c model_reasoning_effort=max`. Argon (agy) quota is exhausted until ~2026-11-01 (429).
- Non-Claude lanes have no memory: every rule is spelled out in `lane-protocol.md` + the brief.
- Dependencies = real API/data needs only; a shared file is never a dependency. Stack on the parent branch; merge main before the final gate.
- Gate once per head SHA; pass if failures ⊆ baseline (`/tmp/or2/baseline-failures.md`); a lane blocked on a test → run that suite on clean main remotely once, then baseline or bounce.
- Never local tsc/vitest (hook blocks). Remote: `/home/orca/bin/remote-typecheck.sh`, `remote-vitest.sh`, DB suites `/tmp/or2/bin/remote-vitest-db.sh` (now per-run container + random port).
- Prod SQL only `BEGIN READ ONLY … ROLLBACK` via `/tmp/or2/bin/prodsql.sh`. No real-guest HMS writes unless owner; Labtest always allowed; never send mail; no Actions; kill by PID.
- Deploy only via the deploy train (`speed-mode-scripts/scripts/orch/deploy-train.sh`, pid `/tmp/or2/deploy/train.pid`). Pause for owner meetings with `kill -STOP <pid>`, resume `kill -CONT`. rc=1 + "deadletter-gate" = normal.
- Every UI component unit must name the unit that mounts it (plan gap DS4-WIRE).

## 4. Mistakes this session (add to MISTAKES.md at closeout)
| Mistake | Fix |
|---|---|
| ETA 240 min quoted, actual 633 (2.64×); scope 22→34 units, never re-quoted | `eta.sh` from the DAG, re-quote on every added unit |
| Fake serial chains from shared-file locks | `needs` ≠ `files`; dispatcher never locks hubs |
| Lanes stalled ~60 min on main's own red tests | green-main lanes (done today) + `gate.sh` nightly baseline |
| Opus coordinator drove live DV canaries (~$82 Opus) | `canary.sh` lane |
| Planned HRCEN outage escalated as incident | HMSDOWN pause (live) + "check owner relay / maintenance memory first" |
| UI components shipped with no mounting unit | mount owner named in plan (speed-plan skill rule) |
| Shared disposable-DB container clobbered by parallel lanes | per-run container/port (fixed in runner) |
| Stacked PR reviewed parent's code → duplicate round-3 P1 | stacked PRs set base = parent branch, or request review after parent merges |
| Grok lanes logged nothing for 7 min (text mode) | `--output-format stream-json` in run-lane.sh |

## 5. For the PARALLEL chat (safe now)
Do NOT edit: `/tmp/or2/*`, worktrees under `/home/orca/orca/workspaces/zero/or2-*`, `.worktrees/speed-mode-scripts`, `.worktrees/recover-parse-failure`. Do not deploy (the train owns deploys). Do not merge or2 PRs.
Safe and useful now (pick by ROI):
1. **Build `gate.sh` / `eta.sh` / `canary.sh`** (retro §9 fixes 2, 5, 3; ~60+30+90 min, 3 parallel lanes) in a NEW worktree off origin/main under `scripts/orch/`. Do not swap them into `/tmp/or2` while or2 runs.
2. **DV multi-room-type "room profile out of date" diagnosis** (read-only HMS read on HRDAV is allowed; ~15 min diagnosis, fix as one unit).
3. **R-SEED redesign** (held): needs a DS1-P3b follow-up owning a source-aware append-only `staff_rate_pick` store + reader; see `/tmp/or2/fix/R-SEED.blocked`. Plan it, don't seed through fake work items.
4. Stay date/room provenance markers (WIRE follow-up, `/tmp/or2/fix/DS4-WIRE.followup.md`) — only AFTER WIRE #607 merges.

## 6. Closeout for the SUCCESSOR (after J1/J2/WIRE/GREEN-TYPES merge)
1. Confirm deploy of the last merge (`/tmp/or2/deploy/train.out` DEPLOYED) and a pane bundle load in nginx after it.
2. Browser-check Undo/Redo/Reset/markers on one Labtest/HRDAV mail (both surfaces share one pane).
3. Stop or2: `touch /tmp/or2/STOP` (coord loop exits), kill train PID when idle, remove merged lane worktrees (`orca-ide worktree rm`).
4. Close ETA ledger rows: `or2-t2-replan` (est 120), `or2-green-main` (75), `or2-ds4-wire` (70) with actual/ratio/drift (`jq -c` append only).
5. Update `docs/context/ACTIVE.md` (live SHA, what shipped, holds), append mistakes (section 4) to `docs/context/MISTAKES.md`, add OWNER-ASKS rows 234–237 (below), merge PR #552.
6. Delete `/tmp/or2/baseline-failures.md` rows once GREEN-TYPES lands (main should be 0 type errors / 0 known test failures).
7. DV canary write-up: confirm the 10:28 UK BAR price → P0 bar met.

## 7. Next run backlog (plan with `/speed-plan`)
| # | Item | Source |
|---|---|---|
| 7.1 | `gate.sh`, `eta.sh`, `canary.sh` (+ nightly main baseline that opens a GREEN unit when red) | retro §9 |
| 7.2 | dispatch.sh: `needs` column, no hub-file locks, stacked start on parent gates-pass | retro §9 fix 1 |
| 7.3 | DV multi-room-type room profile refresh | 12:38 UK failure |
| 7.4 | R-SEED via source-aware rate-pick store | R-SEED.blocked |
| 7.5 | Interim leftovers: idempotency keys ignore dead-letter state; `staff_quote_private_file_invalid` classed transient; prepared-quote attach dead-letters at attempt 1/2; deploy-train fixture tests (#576 P2) | retro §11 |
| 7.6 | DS4-G2a stale blocker: PR #589 merged earlier → just delete `/tmp/or2/fix/DS4-G2a.blocked` | coord |
| 7.7 | Owner canaries: Needs-you (DS2-S5), PDF on a priced DV quote (DS4-K2) | retro §11 |

## 8. Owner asks this session (log as rows 234–237 in OWNER-ASKS.md)
- 234 (~12:05 UK): "fix the main failures instead of having them always live… deploy another lane rn… maybe gemini argon 4 via antigravity; prompt it very explicitly" → GREEN lanes; Argon 429 → Grok/Luna fallback.
- 235 (~12:10 UK): "when is the UI done?" → plan gap found (WIRE).
- 236 (~12:45 UK): DV training 13:00 UK — quotes/provisional bookings, amend/cancel status, why BAR/DOML (rate types, not meal plans) → deploys paused 12:45–13:28.
- 237 (~13:55 UK): "handoff for another LLM so i can do shit in parallel… include retro + speed lanes… end this chat after this lane" → this file.

## 9. Key paths
| What | Where |
|---|---|
| or2 state | `/tmp/or2/{units.tsv,state,pr,ready,fix,briefs,logs,coord.log,hourly.md}` |
| Coordinator loop / tick | `/tmp/or2/coord-loop.sh` (pid `coord-loop.pid`), `/tmp/or2/coord-tick.sh` |
| Orch scripts | `.worktrees/speed-mode-scripts/scripts/orch/{dispatch,merge-gate,deploy-train}.sh` (detached at origin/main) |
| Prod read-only SQL | `/tmp/or2/bin/prodsql.sh <file.sql>` |
| SSM | `apps/server-pilot/deploy/ssm-run-command.sh` |
| Retro / research PR | #552 (`docs/mh1024-retro`, worktree `.worktrees/mh1024-retro`) |
