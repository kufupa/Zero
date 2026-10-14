# Handoff — move to an agent-team session (2026-10-14 ~14:00Z)

**Read in this order:** `docs/context/OWNER-ASKS.md` (every ask, by number) → this file → `PRODUCT.md` → `AGENTS.md` → `docs/plans/2026-10-14-002-one-click-case-card-plan.md` → memory index `/home/orca/.claude/projects/-home-ubuntu-projects-zero/memory/MEMORY.md`.

**Goal now:** a complete product for Centurion (and next, Da Vinci): quote, new booking, amend, cancel each reach "one click, human approves", plus the highest possible triage coverage. HMS is back.

## 1. State

| Thing | State |
|---|---|
| Prod | `c2adb9afc` (deployed by `-70`, migration 0049 applied). Next deploy needs `ops-deploy.sh --migrate` only if a migration is pending |
| Deploy | Only from `.worktrees/recover-parse-failure`: `git pull --ff-only origin main && git fetch origin main:main && bash apps/server-pilot/deploy/ops-deploy.sh` (exit 1 can be the 24 h dead-letter gate only) |
| Labelling | Review set live in nava-admin (Quote Desk marking): 350 Centurion + 48 nava emails. Owner labels there |
| Staff demo | `https://hermes.trynava.io/designs/outlook-side-pane-demo.html` (static, real threads). Staff liked it; feedback below |
| Open PRs | #227 missing-details reply on read fallback · #230 local CI queue · #235 C3 nightly stock/prices · #236 C1 party-first card · #237 asks ledger + this file |
| Greptile P1s | Being fixed by Luna lanes (`/tmp/g2/lane*.out`) on #230, #235, #236 before merge |

## 2. Staff + owner feedback on the pane (build into the live pane, not the demo)

The owner's real complaint is **repetition and controls in two places**, inside the side pane:
1. **Booked by:** "HMS match", the company name twice, "picked by Nava" and the rate line say the same thing. Show one party row: the HMS profile (changeable), what HMS knows that matters (rate plans the party can use — changeable, loyalty / Legacy Rewards level, account / on-account status), and the lookup trace collapsed.
2. **Multiple nights:** availability and price can differ per night. Show every night, flag the nights where the chosen type is short or the price changes, and say how Nava decided (e.g. one type all nights, or a room move).
3. **Availability:** show the real count of rooms free per night (C3 data), never just "Free".
4. **Room type editable in one place only.** Today it's a dropdown in Stay and again as rows in Rates.
5. **Totals once.** Not in the rates box, again in the totals box, again in quote documents.
6. **Never remove options staff have in Infor.** Pre-fill everything; keep every choice editable (full room-type list, rate plans, meal plans).
7. Make clickable things look clickable. Staff liked the progress strip (Party · Stay · Rates · Quote · Reply).

**Product review rule (owner, 2026-10-14):** when the owner suggests a change ("merge sections 2 and 3"), review it with evidence (staff gold outbound, HMS facts, workflow) and push back if it's wrong *before* building. Agreeing without review is the worst failure.

## 3. Work queue (ROI order)

| # | Work | Owner of files | Notes |
|---|---|---|---|
| 1 | Merge #236/#235/#230/#227 after P1 triage, one deploy | lead | Owner approved batch 2 |
| 2 | Owner labels in nava-admin; score classifier on the labels | owner + lane | Coverage is the biggest lever |
| 3 | C5: pane Stay & rooms with per-night availability + price, one room-type control, totals once, party row with HMS facts | `quote-workflow-panel.tsx`, `rate-cards.tsx` | Needs C3 (#235) merged |
| 4 | Extraction year bug: a 12 Oct request for "12–15 October" was read as 2027 | extraction | Thread `2c54fa90` (Pep) |
| 5 | C4: party-scoped rates for every type × night (contract vs BAR) | `staff-quote-workflow.ts`, `hms-jobs.ts` | Live HMS reads only |
| 6 | C6: background find for amend/cancel on strong identity | `pane-stay-lookup.ts`, `amend-lookup-panel.tsx` | |
| 7 | C8 amend writer (fields staff change in gold outbound) + cancel live authorisation | `pane-hms-write.ts` | Owner asks staff the cancellation questions (OWNER-ASKS §3) |
| 8 | nava-admin = production version of the hermes demo layout | admin app | Plan with evidence first |
| 9 | Da Vinci: owner will paste the client-call notes; new mailbox to create | — | Waiting on owner |

## 4. How to run (operating model)

- **One primary lead session.** Other sessions/teammates own named files and write a HANDBACK. List every running session and lane before launching anything (`ListAgents`, `pgrep -f 'codex exec'`).
- **Code lanes:** GPT-6 Luna max via `codex exec` in worktrees (cheapest: $0.10 / $0.50, cached input $0.01). Haiku 5.5 max for reviews (same price as Luna up to 100k context, 5× more above). Opus only for synthesis and hard calls. Never Sonnet.
- **Before building any feature:** evidence pack (gold inbound + outbound, HMS facts, corpus counts) → 2–3 independent lenses (staff workflow, product/ROI, engineering) → one synthesis with "where the owner's idea is wrong" → owner decides → slices ≤ ~500 lines.
- **Research:** use Exa (`/95-exa-agent`) freely; credits are free.
- **Merge:** local targeted tests + Greptile P0/P1 triaged (2 rounds, then validate). **Deploy:** batched.
- **Cost:** today's spend ≈ Opus orchestrator ~$26 (long context re-read every turn), Sol ~$5.8 (mostly `-70`), Luna ~$3.8 (25 lanes), Haiku ~$0.8, Exa ~$1.5. The orchestrator is the cost: start fresh sessions per phase with this handoff, don't poll, keep replies short.

## 5. Research done today (don't redo)

| Question | Answer | Source |
|---|---|---|
| Agent teams vs subagents | Teams: experimental flag `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, interactive only, teammates are Claude sessions, shared task list + messaging, `TeammateIdle`/`TaskCompleted` hooks for gates, more tokens. Best for research/review and separate modules | code.claude.com/docs/en/agent-teams |
| Luna/Sol inside Claude Code | Not supported by Anthropic. Possible via a LiteLLM gateway that routes by model name (claude-* → Foundry, gpt-* → Azure Responses). Known failure modes: parallel tool calls, thinking params, `/model` probe. Local test result: see §6 | Exa runs `agent_run_83b4…`, LiteLLM docs |
| Headroom | In the path on paper, but with `CLAUDE_CODE_USE_FOUNDRY=1` Claude Code goes straight to Foundry: Headroom saw only health checks today, 0 tokens saved | `~/.headroom/logs/proxy-8788.log` |
| Anti-sycophancy | No proof persona debate fixes it. What helps: separate evidence from approval, steelman + attack the owner's idea and the do-nothing option, name what would change the view, one synthesis | Anthropic sycophancy research; Exa `agent_run_1bb1…` |
| Skills | Impeccable installed. gstack/superpowers dropped by owner (slow, TDD-heavy, not parallel). PM skill candidates: deanpeters/Product-Manager-Skills (discovery, evidence-linked PRD), alirezarezvani/claude-skills (product discovery). No proven FDE skill | Exa runs |

## 6. Luna-in-Claude-Code local test

**Verdict: works, with one open stall. Use it for a trial, keep Codex lanes as fallback.**

| Item | Result |
|---|---|
| Gateway | LiteLLM 1.105.1 on `127.0.0.1:4000`, home `/home/orca/.local/share/nava-gateway/` (`bin/nava-gateway start\|stop\|status\|restart`, per-request costs in `logs/usage.jsonl`) |
| Routing (verified 14:50Z, one request each in `usage.jsonl`) | Claude Code has 4 model slots, so each maps to one model: `opus` → Opus 5.5 (Foundry) · `haiku` → Haiku 5.5 (Foundry) · `sonnet` → **GPT-6 Luna** (gateway id `claude-sonnet-5-5`) · `fable` → **GPT-6.1 Sol** (gateway id `claude-fable-5-1`). Luna/Sol run at `reasoning_effort: xhigh` (`max` is rejected with 400). Real Sonnet is never used. In agent files and spawn prompts write `model: sonnet` for Luna, `model: fable` for Sol |
| Gotcha | `~/.claude/settings.json` has `availableModels: [opus, haiku]`; any other model silently became Opus. `claude-team` widens the list with `--settings`, so plain `claude` is unchanged. Raw names like `--model gpt-6-luna` still become Opus: use the slot names |
| Launcher | `/home/orca/.local/bin/claude-team`: starts the gateway if down, enables agent teams, points Claude Code at the gateway, and strips Foundry vars from the tmux session so teammates can't bypass it |
| Team test | Run 2: lead on Opus, teammate-b did 13 requests on Luna and finished its task; teammate-a stalled for 4 min with 0 completed requests. Cost of run 2: Opus $0.35, Luna $0.013 |
| Fix after test | Luna deployments now have `timeout: 300`, `stream_timeout: 120`, `num_retries: 1` (backup: `config.yaml.bak-20261014`) |
| Not survived | Gateway doesn't restart on reboot (no systemd linger); `claude-team` restarts it |

**Start a team session:** `tmux new-session -s team -c "$PWD" claude-team` (add your usual permission mode). The lead is still Opus: keep its context short, which is where the money goes (96% of the test's cost).
