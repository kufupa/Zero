---
name: overnight-autonomous-zero
description: Use when overnight-autonomous-execution is active in the zero mail pilot repo, or when user asks to add full autonomy to an existing implementation plan under docs/superpowers/plans/.
---

# Overnight Autonomous — Zero Mail Pilot Overlay

**REQUIRED SUB-SKILL** when `overnight-autonomous-execution` is active in this repo.

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

**Canonical example:** [docs/superpowers/plans/2026-07-04-nava-fixture-loopback-autonomous-e2e.md](docs/superpowers/plans/2026-07-04-nava-fixture-loopback-autonomous-e2e.md)

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

**Allowed:** ops wrappers, bundle sync, deploy, migrate (via `ops-deploy --migrate`), seed (no `--rotate` unless fix requires), SSM remote tests, PM2 logs, health curl, RDS vitest on EC2.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume. Do not stop at first failure.

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
local: tests + builds green → commit → push EC2-pilot
→ ops-deploy.sh            # or ops-deploy.sh --migrate when schema changed
→ SSM: gate script(s) from plan
→ handoff report under docs/superpowers/plans/handoff-reports/ if plan requires
```

## SSM stdout

Windows AWS CLI may choke on vitest unicode. Use `ssm-run-command.sh` (wraps `ssm-format-invocation.cjs`). See `docs/solutions/workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md`.
