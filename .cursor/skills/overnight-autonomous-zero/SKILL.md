---
name: overnight-autonomous-zero
description: Use when autonomous-plan or overnight-autonomous-execution is active in the Zero mail pilot repo, or when full autonomy must be added to an existing implementation plan.
---

# Overnight Autonomous — Zero Mail Pilot Overlay

Compatibility name retained for existing plans and muscle memory. Canonical front door: `/autonomous-plan`.

**REQUIRED PROJECT OVERLAY** when `autonomous-plan` or `overnight-autonomous-execution` is active in this repo.

## Plan merge protocol (read first)

**Violating the letter of this rule is violating the spirit.**

When user attaches this skill to an **existing** implementation plan (or says "add autonomy to the plan"):

1. **Edit the target plan file in place** — the `docs/superpowers/plans/YYYY-MM-DD-*.md` file already on disk.
2. **Do NOT** call `CreatePlan`, **do NOT** create `.cursor/plans/*.plan.md`, **do NOT** spawn a second markdown file that describes edits to the first.

| Wrong | Right |
|-------|-------|
| New `wire_mock_autonomous.plan.md` summarizing mandate to add elsewhere | `StrReplace` / edit on `2026-07-04-mail-wire-mock-option-b.md` |
| "Plan complete — here's a meta-plan" | "Merged mandate into `docs/superpowers/plans/…`" |

**Where to insert:** after `## Global Constraints`, before task sections / file map.

**What to insert:** full `## Overnight Autonomous Execution Mandate` block (template below).

**What to replace:** any `## Execution Handoff` that asks "Which approach?" → `## Execution Mode` stating autonomous overnight, no user checkpoint.

**Canonical example:** docs/superpowers/plans/2026-07-04-nava-fixture-loopback-autonomous-e2e.md

### Rationalization table

| Excuse | Reality |
|--------|---------|
| "CreatePlan is the plan mode tool" | Plan mode ≠ meta-plan. User's implementation plan is the artifact. Edit it. |
| "Safer to show a preview plan first" | Preview = duplicate doc. Edit source file; user reviews git diff. |
| "I'll merge later" | Later never comes. Merge now in the same turn. |
| "Autonomy is just an overlay doc" | Overlay **is** a section inside the implementation plan, not a sibling file. |

### Red flags — STOP

- About to create any new `.md` whose only job is "add X to plan Y"
- `CreatePlan` invoked when a `docs/superpowers/plans/*.md` target already exists
- Two plan files for one feature

---

## Mandate template (paste into target plan)

Adapt goal line + done criteria to the feature; keep infra block verbatim.

```markdown
## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| **Primary deploy** | `apps/server-pilot/deploy/ops-deploy.sh` (`--migrate` when schema) |
| **Primary app bounce** | `apps/server-pilot/deploy/ops-restart.sh` |
| **Primary box reboot** | `apps/server-pilot/deploy/ops-reboot.sh` |
| Guts (fallback) | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |

**Allowed:** ops wrappers, bundle sync, deploy, migrate (via `ops-deploy --migrate`), seed (no `--rotate` unless fix requires), read-only SSM checks, PM2 logs, health curl, and tests against a disposable non-production database.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds, any Vitest/test command pointed at pilot or production RDS, setting `VITEST_ALLOW_PILOT_RDS=1`, or sourcing `.env.production` into a test process.

### Pilot RDS safety (overrides autonomy)

Never run Vitest against `nava-zero-mail-pilot` or any production database. No overnight escape hatch exists.

Before every local or EC2 Vitest command:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

If a test requires Postgres, use a disposable test database. If none exists, use read-only SQL/API health checks where they prove the requirement; otherwise report a safety blocker. Never weaken this rule to make a gate green.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume. Do not stop at first failure.

### Cursor execution-backend flake (not a human gate)

Exact error: `Execution backend unavailable. Do not retry tool calls — the execution environment is down.`

This is Cursor's agent tool bridge, not Zero app/AWS/RDS.

**Required agent behavior:**
1. Do **not** ask the user to wait or re-invoke.
2. Backoff-retry Shell/Write/StrReplace (≈5s → 15s → 45s) until `echo shell_ok` works or three attempts fail.
3. On recovery: `git status`, read `.superpowers/sdd/*progress*`, resume mid-task (resume subagent or re-dispatch with existing uncommitted work).
4. Only if retries exhaust **and** Shell still dead after ~5 minutes: record blocker in handoff with evidence; still do not invent an app RCA.

### Divergence authority

Better path to done criteria → take it. Log in handoff report.

### Done criteria

- [ ] (feature-specific — copy from plan tasks)

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"
```

---

## Typical overnight wave

```text
local: tests on disposable/no DB + builds green → commit → push EC2-pilot
→ ops-deploy.sh            # or ops-deploy.sh --migrate when schema changed
→ SSM: read-only checks and DB-safe gate script(s) from plan
→ handoff report under docs/superpowers/plans/handoff-reports/ if plan requires
```

## SSM stdout

Windows AWS CLI may choke on command output unicode. Use `ssm-run-command.sh` (wraps `ssm-format-invocation.cjs`). See the pilot RDS rules in `AGENTS.md` before any EC2 test workflow.
