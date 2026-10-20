# Grok run handbook — stay-request build v2 (2026-10-20)

**Who reads this:** the Grok orchestrator (first, in full) and every Grok lane it starts (§10 "Lane brief header" is pasted into every lane prompt). Claude Code had memory files, hooks and skills that Grok does **not** have. This file writes all of it down. If something here conflicts with the plan, PRODUCT.md hard rules win, then this file, then the plan.

Plan: `docs/plans/2026-10-20-006-stay-request-build-plan-v2.md`. Kickoff prompt: `docs/plans/2026-10-20-007-grok-orchestrator-kickoff.md`.

---

## 0. What Grok does NOT get automatically (and the fix)

| Claude Code had | Grok CLI 1.0.62 reality | Fix in this run |
|---|---|---|
| `CLAUDE.md` with `@PRODUCT.md @AGENTS.md @AGENT.md @docs/context/ACTIVE.md` imports | Grok loads `CLAUDE.md`/`AGENTS.md` from repo root → cwd, **each capped at 10,000 chars** (`~/.grok/README.md:1587-1600`). `@file` imports are **not** expanded (no import syntax in Grok docs). Root `AGENTS.md` is 14,244 chars → its last ~4,200 chars (the whole "Gates, evals and instructions" table: kill by PID, never relay approvals, DOM probe before batch, coordinator reads every diff) are **cut off** | Every agent `cat`s the files in §1 explicitly at start. §3 below repeats the cut-off rules |
| ~50 memory files (`~/.claude/projects/.../memory/`) | No access. Grok's `memory` is its own, empty for this repo | §3–§6 inline every memory that matters for this run |
| Hooks: block local `tsc`/`vitest`, RTK output compaction, codegraph context | Not wired for Grok | §4 states the bans; agents obey them by rule, not by hook |
| Skills (`orca-cli`, `ce-compound`, `greptile-cli`) | `~/.grok/skills` → same tree, so skills load. Invoke by name if needed | Commands below are written out in full anyway |
| Auto-compaction keeps Claude's memory | Grok auto-compacts at 85 % of 256k (`~/.grok/README.md:1388`). A compaction **loses** rules not in a file | Orchestrator re-reads this file + the plan's Waves table + `/tmp/sr2/state.md` after every compaction (§8) |


## 0b. Context the planning session had that you don't (read this, then look things up)

Claude Code sessions here carry ~50 memory files and know where the repo keeps its history. Grok has neither. This section is that memory, distilled for this run. **When unsure, look it up in the table below before guessing or asking the owner** (MISTAKES 2026-10-15: the driver asked the owner something the corpus already answered).

### Where things live (open the row's file when its trigger fires)

| Need | File (on `origin/main`) | Who / when |
|---|---|---|
| Owner spec, pass bars, hard rules | `PRODUCT.md` | Everyone, at start (§1) |
| Current live SHA, flags, open holds | `docs/context/ACTIVE.md` (top 60 lines) | Orchestrator at start + after compaction |
| Owner's original words, numbered | `docs/context/OWNER-ASKS.md` (rows 139–173 cover this run) | Orchestrator before any scope call; cite by row number |
| Decisions already made (do not re-open) | `docs/context/DECISIONS-2026-10-20.md` (D18 routing, D19 quote bar, D20/D21 Da Vinci) | Orchestrator before any design question |
| Settled facts (HMS lane, staff defaults, quote proof) | `docs/context/FACTS.md` §8 | Before any research or "is X true?" question |
| Past research, do not redo | `docs/research/README.md`, `docs/research/CATALOG.md`; this run: `docs/research/2026-10-20-*.md`, `docs/research/2026-10-20-arch-lanes/` | Before any analysis; a lane may re-analyse only if it names the prior file and why it is not enough |
| Mistakes already made (full table) | `docs/context/MISTAKES.md` — read the **whole** file once, not only the head | Orchestrator at start; lanes grep it for their module name |
| How the last runs went wrong | `docs/context/ledger/2026-10-19-evening-retro.md`, `2026-10-20-overnight-retro.md`, `2026-10-20-planning-retro.md`; `docs/research/2026-10-20-overnight-quote-retro.md` | Orchestrator at start (≈15 KB total) |
| Verified fixes / gotchas by module | `docs/solutions/<category>/*.md` — `grep -rl 'module:.*<area>' docs/solutions` (areas: `server-pilot`, `deploy`, `infor-hms`, `trpc`, `real mail`) | Lane, **before** changing behaviour in that area, and the orchestrator before deploy (`workflow-issues/ec2-pilot-*`) |
| Domain words (stay, party, transport, quarantine, prepared quote…) | `CONCEPTS.md` (repo root, 54 KB — grep the term, don't read whole) | Anyone meeting an unknown term |
| Infor HMS screens, traps, tool catalog | `docs/infor-hms/CONTEXT.md`, `capability-matrix.md` | Orchestrator before U4/U8 live runs |
| Run contract / overnight template | `docs/context/RUN-CONTRACT.md` | Orchestrator at start |
| All workstreams by ROI | `docs/context/WORKSTREAMS.md` | Only if a cut/next-item decision is needed (§6b) |
| Code lookup | `cd /home/ubuntu/projects/zero && codegraph explore "<symbol names or question>"` (index is on the main checkout, ≈ origin/main; lane worktrees have no index). Returns verbatim source + callers. Use before grep for "where/how does X work" | Anyone |

### Memory rules that apply to this run (owner-given unless marked)

| Rule | Why (evidence) | Applies to |
|---|---|---|
| **Both surfaces.** Any pane change works in the Outlook pane *and* the webmail panel (same `apps/mail` code; check no host-only branch breaks the other). Reply action = insert/save reply, never "copy reply" | Owner tests on webmail, staff use Outlook; drift made tests prove nothing (2026-10-09) | U2, U3, U6, U9, U10, U11 |
| **Pane UI: each fact once.** No per-field "From the email" captions; no orange/warning banner for neutral info; button text "Edit", never "Correct"; hide dead controls | Owner "commented on this so many times" (2026-10-14) | All UI lanes |
| **Generalise, no overfit.** No company/agency/sender-specific rules; edge cases become tests, not code paths. Rare cases (multi-room "options" quotes, ~0.2% of mail) stay simple | Woolworths-only rule was "the most shit thing ever"; v5 burned ~14 task-hours on a 0.2% case | All lanes, esp. U5a/U5r/UDV |
| **Never discard HMS data.** An HMS reader returns every column the screen already loaded (city, IATA, address, agency id); log any field you drop | 13 identical "Tourvest" rows unresolvable because city/IATA were dropped (2026-10-19) | U4, U8, any `*.mjs` tool change |
| **Diagnostics first.** A failure you can't see (client PC, HMS DOM): capture the real error/screenshot/DOM first, state the causal chain, then fix. Never ship a guessed fix | Clock-skew guess on 2026-10-08 was wrong; 2 h lost | U4 combo, any live failure |
| **Live proof = real runtime.** "Works in prod" is proven through pm2 or `ops-run.sh` (systemd-run), never an ad-hoc SSM shell or a direct function call that skips the tRPC route | AE3 PDF sandbox falsely "proven" from an unconfined shell (2026-10-10); a direct call skipped tRPC input validation (2026-10-14) | U12, H5 checks |
| **Done = live check passes after the last fix**, not merged/deployed. Pane change is live only after a staff bundle load is seen in nginx after the deploy | PRODUCT.md pass bars | Orchestrator |
| **Greptile P1s:** triage every one (real / already fixed / not a bug), fix real ones, reply to every thread before merge | 47 P1s merged open on 2026-10-10 | Orchestrator merges |
| **Prod ops gotchas:** `ops-deploy.sh` exits 1 when any dead letter exists in 24 h even if prod is healthy (check health + 4 procs + run `vpn-health-assert.sh` yourself); pending migration needs `ops-deploy.sh --migrate`; `ops-restart.sh` may exit 7 at 0 s uptime — re-check after 20 s; `systemd-run` under SSM needs `sudo -n`; SSM stdout cap ~24 KB; POP3 mailbox quiet ~20:00–01:00 UTC (live-arrival proofs need daytime) | `docs/solutions/workflow-issues/ec2-pilot-*`, 2026-10-11/14 runs | Orchestrator deploy (U12) |
| **Labtest only.** Writes only on guest "Proof Labtest", arrival ≥ 2027-01-01, profile `apps/server-pilot/tooling/playwright-quote/examples/lab-proof-request.json`. No Infor test property exists; this is live HRCEN | Owner 2026-10-14 | U4, U8 |
| **Pre-stay self-mail** (own mailbox → itself, "Pre Stay … Confirmation No <conf>") = existing stay, never new booking / create. General rule, not a Centurion string match | PRODUCT.md Front door | U5a, U5r |
| **OTA out of scope.** OTA/channel mail skipped at the door; travel-agent mail stays in scope | PRODUCT.md, owner 2026-10-14 | U5a, U5r, UDV |
| **Party data per HMS tenant.** HRCEN and HRDAV party/profile data never shared | Owner 2026-10-20 | UDV-1/2/3 |
| **Evidence-backed numbers.** Every ETA/rate/threshold names its source (run, file, ledger) or says "ballpark"; report n and source with every rate | Owner 2026-10-19 | Everyone |
| **Never invent constraints or owner rules.** Quote owner rules verbatim with a source; your own inference is labelled "my inference" | "<2%" and "load<12" were agent inventions copied as owner rules (MISTAKES 2026-10-14/15) | Everyone |
| **Look it up before asking.** Use 2–3 strategies (files above, codegraph, read-only SQL) before asking the owner. Ask only for real holds (§3, approvals) | MISTAKES 2026-10-15 | Orchestrator |
| **Orchestrator owns the plan; owner doesn't slice.** Scope change = a trade naming what it displaces + new ETA, logged in the run report | AGENTS.md "Slicing", PRODUCT.md rule 7 | Orchestrator |
| **Report in plain words**, short, tables, bold answer first; cost in $ by model | Owner style | Final report |

### Brief completeness check (orchestrator, before sending any lane brief)

A lane has no memory either. Before `terminal send`, confirm the brief file contains:
1. The §10 header verbatim.
2. The unit's plan section **pasted verbatim** (not summarised) incl. its test scenarios and gate thresholds.
3. Owned files (Waves table) and the exact test files it must update (rule 21).
4. Which rows of this §0b table apply to it (copy those rows in).
5. Any `docs/solutions` / `MISTAKES` lines that match its module (grep first).
6. Done definition + what it must NOT do (no live HMS, no merge, no deploy).

---

## 1. Read list (every agent, every start, every compaction)

Run, do not skim:

```bash
cd /home/ubuntu/projects/zero && git fetch -q origin && git rev-parse --short origin/main
git show origin/main:PRODUCT.md
git show origin/main:AGENTS.md            # FULL file — Grok's auto-load truncates it at 10k chars
git show origin/main:docs/context/ACTIVE.md | head -60
git show origin/main:docs/plans/2026-10-20-008-grok-run-handbook.md   # this file
git show origin/main:docs/plans/2026-10-20-006-stay-request-build-plan-v2.md
git show origin/main:docs/context/MISTAKES.md          # whole file, once (see §0b)
git show origin/main:docs/context/DECISIONS-2026-10-20.md | sed -n '/D18/,/D19/p'
```

Lanes additionally read only **their unit section** of the plan plus the files it names. Lanes do not read research folders unless their unit cites a file there.

First message of every agent: "Read: <files>. origin/main = <sha>." (AGENTS.md rule — skipping it caused two misses on 2026-10-13.)

---

## 2. Words used in this run

| Term | Meaning |
|---|---|
| **Nava / pane** | The AI reservationist UI staff see beside an email: Outlook add-in (WebView2) and the webmail panel at nava-admin. Same React code (`apps/mail`). Any pane change must work on both. |
| **HMS / Infor** | Infor HMS, the hotel's booking system of record. We drive it only with deterministic Playwright scripts (`apps/server-pilot/tooling/playwright-quote/*.mjs`). No LLM ever clicks in HMS. |
| **HRCEN / HRDAV** | HMS property codes: Centurion Hotel / Da Vinci Hotel. Separate tenants, separate secrets, separate browser slots (`hms-slot@hrcen`, `hms-slot@hrdav`). This run is Centurion only. |
| **conf#** | HMS confirmation number (8 digits, e.g. in `HRCEN_Confirmation_Letter_<conf>.pdf`). |
| **BAR** | Best Available Rate — the public rate. Contract/government rates are party-specific. |
| **B&B / DBB** | Bed & breakfast / dinner, bed & breakfast (board types). |
| **party** | The company or travel agency a booking is for; drives contract rates. |
| **Labtest** | The fake guest "Proof Labtest", arrival ≥ 2027-01-01, on live HRCEN (no Infor test property exists). The only guest any write in this run may touch. Profile: `apps/server-pilot/tooling/playwright-quote/examples/lab-proof-request.json` (Proof / Labtest, STQN, BAR, Walk in, Non-Guaranteed Individual). |
| **`RESERVATIONIST_PANE_SAVE`** | Env flag gating pane writes. Prod value `lab` on http/worker/ai-worker = writes only allowed for Labtest. Stays `lab`. Never set `on`. |
| **extraction** | The LLM step that reads an inbound mail and outputs JSON (kind, action, stays, rooms, contact). Schema `apps/server-pilot/src/ai/extraction/schema.ts`. Its prompt hash = `EXTRACTION_VERSION`. |
| **classifier / triage v4** | Action rules inside the extraction prompt (`ACTION_CLASSIFICATION_RULES`, `extract.ts:68,226`). Live v4 scores 90.3 % on the frozen 431-row test and 94.0 % on the 436-row Aug–Sep held-out set. |
| **frozen 431 rows** | Fixed test set at `/home/orca/nava-research/triage-20261019/work/` (`predict.py` → `score.py`). Used as the U5a regression gate. |
| **outbound gold** | Truth taken from what staff actually sent: text reply, HRCEN confirmation letter PDF, quote PDF. Not model labels. |
| **wave** | Group of plan units. A unit starts when every unit in its **After** column has merged. |
| **remote gate** | Typecheck / tests run on the product EC2 via SSM (`/home/orca/bin/remote-*.sh`). Never on this VPS. |
| **Greptile** | External AI PR reviewer (`greptile review`). Sometimes wrong; you judge each comment. |
| **P0 / P1 / P2** | P0 = data loss, real-guest write, prod down. P1 = wrong result reachable from a staff action or prod path **today**. P2 = everything else. Only P0/P1 block merge. |
| **dead letter** | An `ai_workflow_run` that failed permanently. `ops-deploy.sh` exits 1 if any exist in the last 24 h even when prod is healthy. |
| **pm2 procs** | The 4 prod processes: `http`, `worker`, `ai-worker`, `remote-http`. |
| **Orca** | The IDE/worktree manager. CLI on this Linux box is `orca-ide` (never bare `orca` — that is the screen reader). |
| **ETA ledger** | `~/.claude/eta-ledger.jsonl`, append-only, one JSON row per estimate start/close. |

---

## 3. Hard rules (complete list — includes the part Grok's loader truncates)

### Product / safety
1. No real-guest HMS writes. Writes only on Proof Labtest, ≤ 1 Save (U4) + ≤ 1 amend (U8) for the whole run. An attempt that stops before the Save click does not count.
2. Labtest Save only via the pane save path (takes `paneStayPropertyLock`, `pane-stay-save.ts:365`) or `create-lab-stay.mjs --proof` inside that lock. Running `create-lab-stay.mjs` **without** `--proof` is forbidden: its Labtest name/date guard runs only in proof mode (`create-lab-stay.mjs:246,273-279`).
3. Bot never accepts a cancellation-penalty dialog. No cancel writes in this run at all.
4. One HMS browser lock. Lanes never drive live HMS; only the orchestrator runs live HMS scripts, one at a time.
5. Live HMS tool path: one read-only DOM probe before any batch. On any DOM timeout: screenshot + DOM capture **before** a retry (MISTAKES 2026-10-20).
6. Nava never sends email. No flag or env change. `RESERVATIONIST_PANE_SAVE` stays `lab`.
7. Never ask hotel staff to run anything. Never show raw technical errors in the pane.
8. No mail bodies, guest names, emails or phones in logs, PR text, commits or chat. Counts and ids only.

### Machine / repo
9. Never run `tsc`, `tsgo`, `pnpm typecheck`, `vitest`, or any test runner on this VPS (8 vCPU / 30 GB, shared; it froze twice). Use §4.
10. Never edit `/home/orca/bin`. Never install packages globally. Kill everything you start before reporting.
11. Kill and monitor by **PID** only. Never `pkill -f` / `pgrep -f` (3 drivers killed their own shell that way).
12. No bare `git stash` (stash stack is shared across worktrees). Use a WIP commit.
13. No `--no-verify`. No force-push to `main`. Never push directly to `main`; every change goes through a PR.
14. No GitHub Actions: never add, enable or trigger a workflow file or GitHub check. All repo workflows are disabled; opening PRs is safe (verify: `gh api repos/kufupa/Zero/actions/workflows --jq '.workflows[]|.state'`).
15. Never test against pilot RDS. Before anything that could touch a DB: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL`. Never print secrets or `postgres://` URLs.
16. Prod SQL is read-only only: `BEGIN READ ONLY … ROLLBACK` via `apps/server-pilot/deploy/ssm-run-command.sh`, counts only. SSM truncates stdout at ~24 KB, so print aggregates, not id lists.

### Process (from AGENTS.md's truncated tail + 10-14/10-15/10-19 retros)
17. Never relay an owner approval between sessions. Approvals in the kickoff prompt are valid **only in the orchestrator chat** where the owner pasted them. Lanes have no write/deploy/merge authority.
18. A Greptile/reviewer P1 counts only if reachable from a staff action or prod path today. Eval-only or unused code = P2 or strip it.
19. Two Greptile rounds per PR. Round 3 with a fresh adjacent P1 = design flag: split, strip or redesign. Never a 4th round on the same design (#308 ran 6 rounds / ~2.5 h).
20. The orchestrator reads every product diff itself before merge, even after green gates (caught 2 of 4 P1s on 2026-10-19).
21. A UI lane's brief lists every test file that asserts UI it removes or renames (a lane without this list stalled ~25 min).
22. Replay/eval input must equal prod input: attachment text via `readQuoteAttachments` + `selectionToAgentPrompt`. Name input parity in every eval brief.
23. Accuracy rates need ≥ 100 truth ids not produced by the system under test; below that, report "behaviour check, n=…", not a rate.
24. PR size: one behaviour per PR, ≤ ~500 product lines (tests excluded). Never base a PR on an unmerged PR > 500 lines. Merge `origin/main` into the branch before its first review, then freeze.
25. Every number (ETA, bar, threshold) names its evidence, or is labelled "ballpark".

---

## 4. Commands (exact)

| Need | Command | Notes |
|---|---|---|
| Typecheck | `bash /home/orca/bin/remote-typecheck.sh <worktree> --app <mail\|server-pilot\|all>` | EC2 via SSM, ~2–3 min. Baseline: mail **62** errors, server-pilot **0**. Gate = no new errors. Exit 3 = EC2 low memory, 4 = lock timeout (retry) |
| Tests | `bash /home/orca/bin/remote-vitest.sh <worktree> <server-pilot\|mail> <file> [file…]` | Runs typecheck first unless `SKIP_TYPECHECK=1` after a green typecheck on the **same HEAD**. Exit 0 pass, 1 fail, 70 SSM failure. Shares one EC2 lock with typecheck → they serialize |
| Snapshot update | same, after editing; snapshots update only on EC2 | never `-u` locally |
| Greptile | `cd <wt> && git fetch -q origin && greptile review --branch main --json` | Must be on the final head. Stale base let 2 P1s reach main on 10-19 |
| Greptile, big PR | Same, add `--apex` when the PR is > ~500 changed product lines **or** touches mail ingest/persist, HMS writes, migrations or auth. Apex costs more credits but finds the whole bug class in one pass | Owner 2026-10-20: UDV-2 (~750 lines) ran 4 standard rounds, each finding a new P1 next to the last fix. Prefer small PRs; when one can't be small, apex first, not a 3rd standard round |
| DB-backed tests | `bash /tmp/sr2/bin/remote-vitest-db.sh <wt> server-pilot <files>` (copy of remote-vitest.sh that starts a throwaway `postgres:16` container on EC2 127.0.0.1:55432 and sets `TEST_DATABASE_URL` + `CONFIRM_DISPOSABLE_TEST_DB=1`; removed after) | Suites guarded by `describe.skipIf(!ingestionDbAvailable)` silently SKIP under plain remote-vitest.sh. A skipped DB suite is not a pass: grep the output for `skipped` |
| Grok review | `grok -p "<brief + git diff origin/main...HEAD>" -m grok-4.7 --effort xhigh --cwd <wt> --no-subagents --disable-web-search --permission-mode default --max-turns 60` | If it hits max-turns without a table, resume with `grok -c -p "Stop investigating. Output the final table now." --max-turns 6` (happened on 10-20) |
| Coder lane | see §7 | Grok 4.6 high |
| Research/eval worker | `codex exec --skip-git-repo-check -m gpt-6-luna -c model_reasoning_effort=xhigh -c features.collab=false -s read-only -C <dir> -o <out.md> "<prompt>"` | xhigh or max only, never lower |
| Prod read (script) | `bash /home/ubuntu/projects/zero/.worktrees/ops-run.sh '<scripts/x.ts args>'` | Runs under `systemd-run` as ubuntu with `.env.production` (same runtime as pm2). Never prove prod from a raw SSM shell |
| Prod health | `bash /home/ubuntu/projects/zero/.worktrees/prod-health.sh <since-iso>` | pm2 status, /health 8788+8789, dead letters since, key flags |
| Deploy | `git -C /home/ubuntu/projects/zero/.worktrees/recover-parse-failure fetch origin && git -C … merge --ff-only origin/main && bash apps/server-pilot/deploy/ops-deploy.sh` (from that worktree) | Record last-good SHA first (now `3e1acb694`). Pending migration → `ops-deploy.sh --migrate` |
| VPN check after deploy | `bash apps/server-pilot/deploy/vpn-health-assert.sh` | ops-deploy exits before it when the dead-letter gate fires |

Known deploy behaviour: `ops-deploy.sh` exits **1** when any dead letter exists in the last 24 h even if prod is healthy; it stops before the VPN assert, so run that by hand. `ops-restart.sh` curls `/health` at 0 s uptime and exits 7; re-check 20 s later.

---

## 5. Model routing (owner D18, 2026-10-20 17:02Z)

| Role | Model | Effort |
|---|---|---|
| Orchestrator (you) | grok-4.7 | xhigh |
| Coder per unit | grok-4.6 | **high** (only exception to the floor) |
| Reviewer per PR | grok-4.7 | xhigh |
| Fixer | the same coder terminal (grok-4.6 high) | high |
| Eval / research worker | gpt-6-luna via `codex exec` | xhigh or max |
| Greptile | external | — |

Never Sonnet, never "fast" SKUs, never Nova Lite. No Opus in this run.

---

## 6. Supervision (owner, 2026-10-20)

- **No command caps and no time caps.** A lane that is making progress keeps running however long it takes.
- Check every lane about **every 10 min** (a check-in, not a cap): `orca-ide terminal read --terminal <handle> --json`, look at the last commands and whether output moved.
- Steer a drifting lane with `orca-ide terminal send --terminal <handle> --text "<correction>" --enter`. Kill (by PID) and relaunch with a sharper brief only on drift or no progress across two check-ins.
- Wait with background waits / notifications, not `sleep` loops in the foreground.
- When a stop rule ends a lane early, take the next item in the plan list. The run ends only when the list is empty.
- At each unit merge, write one line to `/tmp/sr2/state.md` (unit, PR, merged SHA, gates, live check). That file is your memory across compactions.

---

## 6b. Run time-box (checkpoints, not lane caps)

T0 = kickoff. Lanes have no caps; the **run** has checkpoints. At each, write the state to `/tmp/sr2/state.md` and post a 5-line status in the orchestrator chat.

| Checkpoint | Expected (plan ETA 245–320 min) | If behind |
|---|---|---|
| T0 + 90 min | U1, U3, U7, UDV-1 merged; U2, U5a, UDV-2 in review; U4 combo DOM captured | keep going; note which unit is slow |
| T0 + 150 min | Wave A merged incl. U5a gate result | start Wave B anyway for units whose After is merged; consider cutting U10 (tags only) |
| T0 + 240 min | U6 merged or in final review | **cut** whatever is not in review (candidates in order: U5r, UDV-3, U10, U9 relabel, U6 split control; UDV-2 is not cut once in review, H5 needs it) and go to deploy |
| T0 + 300 min | deploy done, live checks running | deploy what is merged; report the rest as open |
| T0 + 360 min | hard stop for new merges | finish live checks + closeout only |

Cut order exists because the owner is the only human: a shipped smaller set beats an unshipped full set.

**Owner update 2026-10-20 ~22:30Z:** no staff use Nava on 2026-10-21, so the checkpoints above are progress markers, **not** a hard stop. Overrunning is fine; do not cut units to hit a clock. Goal: build fast and fully, test properly (real DB tests, live Labtest proof) without overkill plumbing. Deploy when a live check needs it or at the end; no deploy-per-merge.

## 7. Lane launch (exact)

**You (the orchestrator) create every worktree and terminal yourself with `orca-ide`.** No human or other session does it for you. Every worker is a visible Orca terminal (owner watches/steers in Orca). Grok built-in subagents are off for coders (`--no-subagents`); headless `grok -p` reviews and `codex exec` evals run as background shell commands inside the unit's worktree. Record each handle in `/tmp/sr2/state.md`.

```bash
orca-ide skills get orca-cli            # once, read the version-matched guide
orca-ide worktree create --repo path:/home/ubuntu/projects/zero --name sr2-<unit> --base-branch origin/main --parent-worktree active --json   # lanes show as children of sr2-orch in the Orca sidebar; run from the sr2-orch terminal (or pass --parent-worktree id:<repoId>::/home/orca/orca/workspaces/zero/sr2-orch)
# copy the full "id" field (<repoId>::<path>)
orca-ide terminal create --worktree id:<repoId>::<path> --title sr2-<unit> \
  --command 'grok -m grok-4.6 --effort high --permission-mode bypassPermissions --no-subagents' --json
orca-ide terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json   # send ONLY if satisfied:true; else wait once more with 120000
orca-ide terminal send --terminal <handle> --text "<lane brief>" --enter --json
```

A prompt typed into a TUI that is still starting is lost — check `satisfied`.

Other Orca commands you will need:

```bash
orca-ide terminal list --worktree id:<repoId>::<path> --json      # find handles again (after Orca restart / terminal_handle_stale)
orca-ide terminal read --terminal <handle> --json                 # 10-min check-in
orca-ide terminal send --terminal <handle> --text "<steer>" --enter --json
orca-ide terminal create --worktree id:<repoId>::<path> --title sr2-<unit>-eval --command '<codex exec ... | grok -p ...>' --json   # visible eval/review worker in the same unit worktree
```

Never `terminal create` a second coder in a worktree that already has one; steer the existing handle.

---

## 8. Compaction / context hygiene

- After any auto-compaction (Grok compacts at 85 % of 256k), re-run §1, re-read §0b and `/tmp/sr2/state.md` before the next action.
- Bulk reads (SQL dumps, eval output, logs > ~200 lines) go to a Luna worker that returns a ≤ 40-line summary. Do not paste them into the orchestrator context.
- Never trust a fact from before compaction that is not in a file: re-read it.

---

## 9. Failure handling (what to do when X)

| Event | Action |
|---|---|
| Typecheck exit 3/4 | wait 2 min, retry once; if again, note it and run tests with `SKIP_TYPECHECK=0` later |
| New typecheck errors vs baseline | back to coder; not mergeable |
| Test fail | back to coder with the failing output; if the failing test asserts behaviour the plan removes, update the test in the same PR |
| Greptile P1 you judge real | back to coder; max 2 rounds (rule 19) |
| Grok/Greptile disagree with the plan | follow the plan unless the finding is a P0 safety hole; log it in `/tmp/sr2/state.md` |
| U5a gate fails (> 20/431 action flips vs v4, > 10/431 fewer correct, or quote recall < 85 %) | do not merge U5a; strip the per-stay `action` field and re-gate; if still failing, ship U5a without `action` and record it |
| HMS DOM timeout | screenshot + DOM capture, then one retry; second failure = stop that unit's live step and report |
| Any path that could write a real guest | stop the run, report to owner |
| Deploy: health ≠ 200/200 or < 4 pm2 procs | roll back: `git -C …/recover-parse-failure reset --hard <last-good>` + `ops-deploy.sh`, then report. (Reset is allowed only in that deploy worktree, only to the recorded last-good SHA) |
| Unit not done when the rest are | ship without it (it stays unmerged), deploy the rest, report it as open |

---

## 10. Lane brief header (paste at the top of every lane prompt)

```text
You are a coding lane in the Nava repo (pnpm monorepo, TypeScript). You are NOT the orchestrator.
FIRST: cat these and say "Read: … origin/main=<sha>":
  git -C . fetch -q origin; git rev-parse --short origin/main
  git show origin/main:docs/plans/2026-10-20-008-grok-run-handbook.md   (sections 0b, 2, 3, 4)
  before changing behaviour: grep -rl "module:.*<your area>" docs/solutions; grep -i "<your module>" docs/context/MISTAKES.md; codegraph explore "<symbols>" (run from /home/ubuntu/projects/zero)
  your unit section of docs/plans/2026-10-20-006-stay-request-build-plan-v2.md
RULES (no exceptions):
- Never run tsc/tsgo/typecheck/vitest/any test runner here. Gates: bash /home/orca/bin/remote-typecheck.sh <this wt> --app <app>; bash /home/orca/bin/remote-vitest.sh <this wt> <app> <files>.
- Never edit /home/orca/bin. No bare git stash. No --no-verify. No GitHub Actions/workflow files. Never push to main.
- Never drive live HMS, never write prod, never change env/flags, never send email. No guest PII in code comments, tests, commits or PR text.
- Only edit the files your unit owns (Waves table). Need another file? Stop and ask the orchestrator.
- unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL before any test command.
- Kill by PID only. Kill anything you started before you report.
- One behaviour, <= ~500 product lines. Add new assertions for the new behaviour; a cited test line is a location hint, not coverage.
- UI change: list every test file that asserts UI you remove/rename and update them in this PR.
DONE = branch sr2-<unit> pushed, PR open (body ends with "🤖 Generated with Grok via Orca"), remote typecheck at baseline, remote tests on your files passing. Report: PR url, files changed, gate results, anything you could not do.
```

---

## 11. Closeout

- Update `docs/context/ACTIVE.md` (verified state, next acceptance check, holds) — keep it short.
- One retro line per unit and any new mistakes in `docs/context/MISTAKES.md`.
- Close every ETA-ledger row (`id`, `end`, `actual_min`, `ratio`, `drift`, `outcome`).
- `grok usage` per session → $ by model in the final report.
- Final chat report to the owner: what is live, what passed with numbers, what failed with evidence, open holds.
