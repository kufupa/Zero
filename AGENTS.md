# AGENTS.md

Read by Cursor CLI, Codex CLI, and any agent that looks for `AGENTS.md`. Claude Code loads `CLAUDE.md`, which points here.

**Read in this order, every session:**

1. `PRODUCT.md` — owner product spec. Do not invent requirements.
2. `docs/context/ACTIVE.md` and `docs/context/OWNER-ASKS.md` — current run and original asks.
3. `docs/research/README.md` — current index, dated conclusions and evidence locators; do not redo settled research.
4. `AGENT.md` — repo layout and commands.

- Before any research or analysis lane, read `docs/context/FACTS.md` and `docs/research/CATALOG.md` and reuse.
- A lane may only re-analyse when it names the prior artifact and why it’s insufficient.

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
| Writers              | One Luna writer per workflow, plus one independent verifier (Haiku review or eval). More writers only for slices with no shared files                                                                                                                                     | Cursor 2026: 20 agents gave 2–3 agents' worth of throughput                                                        |
| Orchestrator context | Opus orchestrator `/clear`s (or hands off) at each slice boundary; state lives in the scoreboard, not the chat. Wait for background work with run-in-background notifications, not `sleep` polls                                                                          | overnight 2026-10-14: 867 Opus turns at ~253k context = $44 of cache reads alone                                   |
| Haiku                | Budget Haiku at the >100k tier ($0.50 / $2.50 per M): a 100k cap can't be enforced (owner, 2026-10-14). Still start a fresh agent per review/label task instead of resuming one; send long-context reading (transcripts, corpora) to Luna, whose cache reads are ~$0.01/M | 65% of overnight Haiku calls ran over 100k even with "keep under 100k" in every brief                              |
| Slicing              | The orchestrator plans the PR slices before any lane starts (the owner doesn't): each slice = one behaviour, its test, its PR. Commit and push every green slice; deploy only when someone needs to see it                                                                | owner, 2026-10-14: "smaller PRs, more often, always — on you to plan it"                                           |
| Flags and env        | A flag flip covers every pm2 process that reads it (`http`, `worker`, `ai-worker`, `remote-http`), sources the right env files, and checks `/proc/<pid>/environ` for each before anything is enqueued                                                                     | 6 quote-ready proofs dead-lettered on 2026-10-14 (login-shell pm2 restart); webmail never got the flag             |
| ETAs                 | Quote the ledger-scaled ETA of the **longest dependency chain** (code + review + deploy + live proof). If the owner doubts it, show the evidence; change the number only for new evidence                                                                                 | the 8 h quote-ready ETA was cut to 6 h under pushback; actual was > 8 h                                            |

Run contracts, `/goal` vs `/loop`, and the overnight template: `docs/context/RUN-CONTRACT.md`.

Do not copy this file into other worktrees by hand. It lives on `main`. A worktree sees it when that worktree’s HEAD contains this commit (`git merge origin/main` on an **idle** tree). Never merge into a live Luna/Codex lane.
