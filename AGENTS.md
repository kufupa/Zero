# AGENTS.md

Read by Cursor CLI, Codex CLI, and any agent that looks for `AGENTS.md`. Claude Code loads `CLAUDE.md`, which points here.

**Read in this order, every session:**

1. `PRODUCT.md` — owner product spec. Do not invent requirements.
2. `docs/context/ACTIVE.md` and `docs/context/OWNER-ASKS.md` — current run and original asks.
3. `docs/research/README.md` — current index, dated conclusions and evidence locators; do not redo settled research.
4. `AGENT.md` — repo layout and commands.

- Before any research or analysis lane, read `docs/context/FACTS.md` and `docs/research/CATALOG.md` and reuse.
- A lane may only re-analyse when it names the prior artifact and why it’s insufficient.
- Latest settled facts (live quote proof, HMS lane, staff defaults, "same move as staff" metric): `docs/context/FACTS.md` section 8 (2026-10-15).
- New or migrated VPS: restore from `docs/context/VPS-MIGRATION.md` (GitHub branches, S3 backups, local tooling, backup cron).

Done = score on the golden set in `PRODUCT.md`, not a merge.

**Before your first claim or plan in a session:** say which required files you read (with `git rev-parse --short origin/main`). Before saying a tool, command or flag does not exist, check it (`claude --help`, `codex --help`, the docs). Both misses happened on 2026-10-13.

## Bounded session startup and handoff

- Batch-read the mandatory rules and short ACTIVE context, then inspect relevant changes since its checkpoint. A new session alone is not a reason to scan every transcript or corpus.
- Open the research index and exact evidence for the chosen slice. Refresh volatile runtime/price/authorization facts; do not treat dated observations as live permission.
- Start product discussion from settled conclusions while independent verification runs. Bulk archives go to Luna; fresh Haiku max reviews bounded changes, not the entire product.
- Preserve original asks in OWNER-ASKS.md. At handoff update ACTIVE.md with verified state, the next acceptance check and holds; put detailed findings and methods in dated research files.
- Root CLAUDE.md already imports ACTIVE.md. These files improve discovery, not behavioural enforcement; no new startup hook or memory system is implied.

## Limits that keep runs finishing (2026-10-14 retro)

| Limit                | Rule                                                                                                                                                                                                                                                                      | Why                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| PR size              | One behaviour per PR, ≤ ~500 changed product lines (tests and fixtures excluded). Split before review, not after                                                                                                                                                          | #214 grew to 58 files / +3.4k and took 16 Greptile rounds; Greptile's own data: 1,000+ line PRs average 3.5 rounds |
| Stacking             | Never base a feature PR on an unmerged PR over 500 lines                                                                                                                                                                                                                  | #222 (quote-ready) waited on #214 and missed the 07:30Z target                                                     |
| Main merges          | Merge `origin/main` into a long-lived PR before its first review, then freeze the diff                                                                                                                                                                                    | the late main merge into #214 brought 4 more rounds of new P1s                                                     |
| Review rounds        | Two Greptile rounds. After that, validate each new P1 (real path, real impact); fix the real ones and send the rest to the owner with a one-line reason. Never merge with an unvalidated P1                                                                               | rounds r12–r16 on #214 cost ~2 h on the critical path                                                              |
| Writers              | Unbounded writers **iff** disjoint files, own worktree, own branch from `origin/main`. Shared file = queued. One verifier **per PR** (Haiku/Luna), not a global mutex. Impl: Grok 4.6 HI (Cursor) or Luna max; merge/deploy/live HMS: Opus. No Fast. | Cursor: 20 agents on a shared lock → 1–3 throughput. Isolation + file ownership scale; a count cap does not.     |
| Orchestrator context | Opus orchestrator `/clear`s (or hands off) at each slice boundary; state lives in the scoreboard, not the chat. Wait for background work with run-in-background notifications, not `sleep` polls. Bulk reads (SQL dumps, transcripts, eval output) go to a subagent that returns a summary. At ~150k context, write the handoff into the plan file and start a fresh session | overnight 2026-10-14: 867 Opus turns at ~253k context = $44 of cache reads alone. Overnight 2026-10-19: 514 Opus turns, 92M cache reads ≈ $46 of ~$63 Opus spend |
| Early stop           | When a stop rule ends a lane early (target, plateau), take the next item in the plan's list instead of ending the run. A run ends only when the list is empty or the wall clock is spent | overnight 2026-10-19 finished in 3.2 h of a 5.5 h window and stopped                                               |
| Haiku                | Budget Haiku at the >100k tier ($0.50 / $2.50 per M): a 100k cap can't be enforced (owner, 2026-10-14). Still start a fresh agent per review/label task instead of resuming one; send long-context reading (transcripts, corpora) to Luna, whose cache reads are ~$0.01/M | 65% of overnight Haiku calls ran over 100k even with "keep under 100k" in every brief                              |
| Slicing              | The orchestrator plans the PR slices before any lane starts (the owner doesn't): each slice = one behaviour, its test, its PR. Commit and push every green slice; deploy only when someone needs to see it                                                                | owner, 2026-10-14: "smaller PRs, more often, always — on you to plan it"                                           |
| Flags and env        | A flag flip covers every pm2 process that reads it (`http`, `worker`, `ai-worker`, `remote-http`), sources the right env files, and checks `/proc/<pid>/environ` for each before anything is enqueued                                                                     | 6 quote-ready proofs dead-lettered on 2026-10-14 (login-shell pm2 restart); webmail never got the flag             |
| ETAs                 | Quote the ledger-scaled ETA of the **longest dependency chain** (code + review + deploy + live proof). If the owner doubts it, show the evidence; change the number only for new evidence                                                                                 | the 8 h quote-ready ETA was cut to 6 h under pushback; actual was > 8 h                                            |

## VPS resources: never overload this machine (owner, 2026-10-15)

This 8-vCPU / 30 GB VPS runs every lane, the gateway and the owner's tools. Twice now, parallel heavy checks froze it (first `tsc --noEmit` ×2, then several full Vitest suites at once).

| Never | Instead |
|---|---|
| `tsc`, `tsgo`, or any `typecheck` script here | `bash /home/orca/bin/remote-typecheck.sh <clean worktree>` (EC2 via SSM; baseline mail 62, server-pilot 0) |
| Vitest / any test runner on this coding VPS | Product EC2 only. Full suite: `bash /home/orca/bin/vitest-full.sh` is VPS-flock and is **not** the owner rule — do not run Vitest here. |
| Docker/bake-off installs while lanes run checks | Research lanes run no heavy installs. Typecheck only via remote-typecheck.sh |
| Leaving servers, containers or test runners behind | Every lane kills what it started before it reports |

A PreToolUse hook (`~/.claude/hooks/block-local-tsc.sh`) denies tsc and direct full Vitest runs. There is no lane or load cap (owner, 2026-10-15: "i didnt add this rule im ok w more load"). The limits are the heavy checks above, not lane count.

## Gates, evals and instructions (2026-10-15 retro)

All four drivers hit the same wall: **gate latency and eval validity, not lane count.**

| Rule | Why |
|---|---|
| Chain gates in the lane's own background job: `lane && remote-typecheck && diff-only Luna verify`. A finished lane never waits for the driver | Main driver had 0 lanes running 19:30–20:00 while fix lanes sat finished ~35 min |
| A Luna/Greptile P1 counts only if it is reachable from a staff action or a prod path **today**. Eval-only or unused code = P2, or strip the path | Diff-only verify found one fresh adjacent P1 per round (#310 ×3, #321 ×4, #318 ×3, #308 ×6) |
| Round 3 with a fresh adjacent P1 = design flag: split, strip or redesign. Never a 4th round on the same design | #308 ran 6 rounds (~2.5 h) and is still blocked; #307 merged within the hour once split |
| Replay/eval input must equal prod input (attachment text via prod's own `readQuoteAttachments` + `selectionToAgentPrompt`). Name the input parity in every eval brief | Every replay score on 2026-10-15 was body-only; 74% of gold inbound carry attachments |
| Gate tuning on fresh rows with the baseline run ×2 (noise band) before any tuning. A single baseline run cannot pass or fail a change | No-SOP baseline varied 30↔37 on one 99-row set; tuning-slice SOP gains (7→27/30) vanished on fresh rows |
| Kill and monitor by PID, never `pkill -f` / `pgrep -f` patterns | 3 drivers matched their own shell (exit 144) or a monitor's own command line |
| Never relay an owner approval between sessions. Prod/auth approvals are given in the executing session's own chat | The watchdog relayed a "pre-approval" for `--apply`; the main driver correctly refused |
| Live HMS tool path is DOM-verified with one read-only probe before any batch | 6 wasted live searches on an unverified Guest Search path |

Run contracts, `/goal` vs `/loop`, and the overnight template: `docs/context/RUN-CONTRACT.md`.

Do not copy this file into other worktrees by hand. It lives on `main`. A worktree sees it when that worktree’s HEAD contains this commit (`git merge origin/main` on an **idle** tree). Never merge into a live Luna/Codex lane.
