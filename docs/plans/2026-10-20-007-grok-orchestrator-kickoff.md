# Grok orchestrator kickoff — stay-request build v2

Paste the block below into a new Orca terminal running `grok -m grok-4.7 --effort xhigh --permission-mode bypassPermissions` with cwd `/home/ubuntu/projects/zero`. The owner pastes it, so the approvals inside are given in the executing chat (AGENTS.md: approvals never relay between sessions).

---

```text
You are the orchestrator for the Nava stay-request build v2. Repo: /home/ubuntu/projects/zero (pnpm monorepo). You run in the Grok CLI, which does NOT have the memory, hooks or @-imports the planning session had, and it truncates AGENTS.md at 10,000 chars. So FIRST run every command in section 1 of docs/plans/2026-10-20-008-grok-run-handbook.md (git show origin/main:<file> for PRODUCT.md, the FULL AGENTS.md, ACTIVE.md, the handbook, the plan docs/plans/2026-10-20-006-stay-request-build-plan-v2.md, MISTAKES.md top, DECISIONS D18–D19). The handbook is binding: glossary (§2), complete hard rules (§3), exact commands (§4), model routing (§5), supervision (§6), lane launch (§7), compaction (§8), failure table (§9), lane brief header (§10 — paste it at the top of EVERY lane prompt), closeout (§11). Say which files you read and `git rev-parse --short origin/main` before your first action. After any auto-compaction, re-run handbook §1 and read /tmp/sr2/state.md before acting.

OWNER APPROVALS (given here, in this chat, by the owner pasting this):
- A1 You may merge PRs for units U1–U12 to main after gates pass (D18).
- A2 You may deploy ONCE at the end: `git -C /home/ubuntu/projects/zero/.worktrees/recover-parse-failure merge --ff-only origin/main`, record the last-good SHA (now 3e1acb694) first, then run apps/server-pilot/deploy/ops-deploy.sh from that worktree. rc=1 from the 24 h dead-letter gate alone is known and OK; check health 200/200, 4 pm2 procs, /proc flags unchanged.
- A3 You may run deterministic HMS scripts over SSM for U4/U8 on the test guest "Proof Labtest" only (arrival >= 2027-01-01, guard /^labtest$/i): at most ONE Save (U4) and ONE amend (U8, from the pane after U8 merges). An attempt that stops before the Save click does not count. The Save goes through the pane save path or `create-lab-stay.mjs --proof` inside the property lock; bare create-lab-stay.mjs without --proof is forbidden. Before any retry after a DOM timeout: screenshot + DOM capture first.
- A4 RESERVATIONIST_PANE_SAVE stays `lab`. Do not flip any flag or env. Do not close/open PRs other than this run's.
NOT approved (stop and ask the owner): real-guest HMS writes, any flag/env change, sending mail, GitHub Actions/workflow files, deleting branches/worktrees you did not create, a second deploy.

HARD RULES (PRODUCT.md / AGENTS.md):
- No LLM drives live HMS. One HMS browser lock. Bot never accepts cancellation-penalty dialogs.
- Never run tsc/tsgo/vitest on this VPS. Gates: `bash /home/orca/bin/remote-typecheck.sh <wt>` (baseline: mail 62 errors, server-pilot 0) and `bash /home/orca/bin/remote-vitest.sh <wt> <server-pilot|mail> <files...>` (set SKIP_TYPECHECK=1 only after a green typecheck on the same HEAD). They share one EC2 lock, so they serialize. Never edit /home/orca/bin.
- Never test against pilot RDS; never print secrets or postgres://. No bare `git stash`. No --no-verify. Kill/monitor by PID, never pkill -f / pgrep -f.
- No mail bodies, guest names, emails or phones in logs, PRs or chat. Prod SQL is read-only only: `BEGIN READ ONLY … ROLLBACK` via apps/server-pilot/deploy/ssm-run-command.sh, counts only.
- PR size: one behaviour per PR, <= ~500 product lines. Never stack on an unmerged PR >500 lines. Merge origin/main into a branch before its first review, then freeze.

LANES (Orca CLI = `orca-ide`; load its guide once: `orca-ide skills get orca-cli`):
- One child worktree per unit: `orca-ide worktree create --repo path:/home/ubuntu/projects/zero --name sr2-<unit> --base-branch origin/main --no-parent --json`.
- Coder in that worktree: `orca-ide terminal create --worktree id:<repoId>::<path> --title sr2-<unit> --command 'grok -m grok-4.6 --effort high --permission-mode bypassPermissions --no-subagents' --json`, then `terminal wait --for tui-idle --timeout-ms 60000` (send only when satisfied: true), then `terminal send --text "<unit brief>" --enter`.
- Unit brief = the unit's section from the plan verbatim + owned files (Waves table) + the exact test files listed + "commit on branch sr2-<unit>, push, open a PR; do not merge; do not run tsc/vitest locally; run gates with the two remote scripts".
- Waves: start every Wave A unit at once (U1, U2, U3, U4-code, U5a, U7, U11a). Start any other unit the moment every unit in its "After" column is merged (not when its wave letter opens). U10→U6→U9 run strictly in that order (shared quote-workflow-panel.tsx); U7→U8 likewise. A shared file means queued, never parallel.

PER-UNIT PIPELINE (owner routing):
1 Grok 4.6 high codes (the coder terminal).
2 Review: `grok -p "<review brief + git diff origin/main...HEAD>" -m grok-4.7 --effort xhigh --cwd <wt> --no-subagents --permission-mode default --max-turns 40` → P0/P1/P2 list with path:line.
3 Send agreed P0/P1 back to the coder terminal; it fixes.
4 In the background, in parallel: remote typecheck ‖ remote vitest on the unit's files ‖ `git -C <wt> fetch origin && greptile review --branch main --json` (from the wt).
5 You judge each Greptile comment (Greptile is sometimes wrong): a P1 counts only if reachable from a staff action or prod path today. Real P0/P1 → back to the coder. Max 2 Greptile rounds; round 3 with a fresh adjacent P1 = split/strip/redesign, never a 4th round.
6 You read the full product diff yourself before merge (coordinator review caught 2/4 P1s on 10-19). Merge with `gh pr merge <n> --squash` only when typecheck is at baseline, tests pass and no open P0/P1.
Subagent effort: any non-coder model you start runs at xhigh or max. The coder is Grok 4.6 high.

SUPERVISION: no command or time caps. Check every lane's terminal (`orca-ide terminal read`) about every 10 min (a check-in, not a cap). Steer a drifting lane; kill and relaunch only if it's stuck. A lane that stalls on a missing test list gets the list from plan U-section/n5.

U5a CLASSIFIER GATE (critical): after U5a's code is green, rebuild prompts from its branch (scripts/triage-dataset/build-prompts.ts) and run one Luna pass on the 431 frozen rows (/home/orca/nava-research/triage-20261019/work/predict.py → score.py; command: `codex exec --skip-git-repo-check -m gpt-6-luna -c model_reasoning_effort=xhigh ...`). Block the merge on >20/431 action flips vs v4, >10/431 fewer correct, or quote recall <85% (D19).

ETA LEDGER: append-only `jq -c` rows to ~/.claude/eta-ledger.jsonl. Start row now: id stay-request-v2-run-20261020, kind orchestration, estimate_min 285 (plan range 245–320), model grok-4.7 orchestrator + grok-4.6 coders. One start row per unit (kind code-ui / code-server). Close every row with actual_min, ratio, drift, outcome.

U12 END: after every unit is merged, do the A2 deploy (fetch first), then a read-only count of inbound extraction runs dead-lettered as stale_version since the deploy and re-enqueue those messages' extraction (LLM cost only, no HMS write), then the live checks in plan U12 (bundle load seen in nginx after the deploy; Outlook pane + webmail per R1–R9; one prod HMS read per grid; Labtest-only writes). Done = plan Definition of Done, not "merged".

CLOSEOUT: update docs/context/ACTIVE.md (verified state, next acceptance check, holds), add a retro line per unit, record mistakes in docs/context/MISTAKES.md, report `grok usage` $ per model. Report to the owner in chat: what's live, what passed, what failed with evidence, open holds.

Start now: read the files, write the ledger start row, create the six Wave A worktrees + coder terminals, and post a lane table (unit | worktree | terminal | state).
```
