---
title: Canonical Nava Skill Routing Surface for Zero Agent Workflow
date: 2026-07-31
category: architecture-patterns
module: cursor-agent-skills
problem_type: architecture_pattern
component: development_workflow
severity: high
applies_when:
  - Planning multi-step software work for Zero mail pilot
  - Executing a final implementation plan after reviews
  - Adding autonomy to a plan or resuming stalled queued work
  - Choosing which Cursor, GStack, CE, or ponytail skills to invoke
  - Tempted to invent a new skill front door when a canonical successor exists
related_components:
  - tooling
  - documentation
tags:
  - nava-plan
  - nava-run
  - autonomous-plan
  - skill-routing
  - cursor-skills
  - gstack
  - pilot-rds-safety
  - development-workflow
---

# Canonical Nava Skill Routing Surface for Zero Agent Workflow

## Context

After a skill-ecosystem audit of the Zero Cursor surface, planning and execution no longer scatter across many one-off front doors. The always-applied Nava workflow rule names four canonical commands for the main loop: multi-step software planning via `/nava-plan`, final implementation-plan execution via `/nava-run`, full autonomy stamped onto a plan via `/autonomous-plan`, and queued resume when an agent stalls via `/continue-autonomously` (`.cursor/rules/nava-workflow.mdc:8-10`).

That routing table is easy to misuse in two ways. First, agents and humans treat `/autonomous-plan` as a substitute for the CE → paired review → `writing-plans` pipeline, when autonomous-plan only embeds a binding mandate into an existing implementation plan and does not replace planning. Second, teams skip or collapse the paired plan gate: `gstack-plan-eng-review` (completeness floor) and `ponytail-review` (simplicity ceiling) are both mandatory and must never substitute for each other (`.cursor/rules/nava-workflow.mdc:12`).

Adjacent traps remain common after pruning: routing through removed or deprecated front doors when successors exist (`.cursor/rules/nava-workflow.mdc:18`); turning on ponytail persistent mode by default even though ponytail is OFF unless explicitly invoked and `ponytail-review` stays review-only (`.cursor/rules/nava-workflow.mdc:16`; `.claude/skills/ponytail/SKILL.md:9`, `:20-23`); using fast subagent variants when the contract requires standard non-fast models only (`.cursor/rules/nava-workflow.mdc:15`); and treating overnight autonomy as permission to weaken pilot-RDS test safety, which the safety rule and Nava routing say overrides plans, skills, review findings, autonomy, and “make tests green” pressure (`.cursor/rules/nava-workflow.mdc:19`; `.cursor/rules/pilot-rds-safety.mdc:8`, `:17-20`).

Compatibility overlays and aliases still matter for muscle memory: `/overnight-autonomous-execution` and project `/overnight-autonomous-zero` remain supported while `/autonomous-plan` is the new canonical command (`.cursor/skills/overnight-autonomous-zero/SKILL.md:8`). The installed global continue-autonomously skill documents `/overnight-continue-working` as a compatibility alias. Durable non-obvious verified learnings belong in CE `docs/solutions/`; GStack learnings stay passive preference/tool memory (`.cursor/rules/nava-workflow.mdc:17`). User-kept Cursor skills such as `/adhd` and overnight compatibility aliases remain available alongside the Nava four-command surface; they are not defined by the Nava workflow rule itself.

## Guidance

### Canonical command map

| Need | Command | What it does / does not do |
|------|---------|----------------------------|
| Plan + paired review + executable TDD plan | `/nava-plan` | Per installed global nava-plan skill: produces one final executable plan under `docs/superpowers/plans/`; does not implement code |
| Implement final plan | `/nava-run` | Runs TDD/SDD, per-task review, final CE code review, and fresh verification (`.cursor/rules/nava-workflow.mdc:14`) |
| Stamp overnight autonomy onto a plan | `/autonomous-plan` | Edits the target plan in place with one autonomy mandate section (Zero overlay template title: `## Overnight Autonomous Execution Mandate`); per installed autonomous-plan skill, does not start execution unless requested |
| Queued resume if agent stalls | `/continue-autonomously` | Per installed global continue-autonomously skill: authorization to resume; inspect state first; not an invitation to ask again |

Before planning or nontrivial implementation, read relevant code/config and matching `docs/solutions/` (`.cursor/rules/nava-workflow.mdc:11`). Treat CE solutions as institutional evidence, not unquestioned truth.

### `/nava-plan` pipeline (do not skip steps)

1. Resolve input, then ground in repo rules, named artifacts, code/config, and `docs/solutions/`.
2. Close decision-critical evidence gaps with `/95`; stay local unless current external evidence is required.
3. Use `ce-plan` in pipeline mode to create or deepen the grounded technical plan.
4. Run the mandatory paired gate on that plan:
   - `gstack-plan-eng-review` — completeness floor: architecture, data flow, failures, security, tests, operations, performance.
   - `ponytail-review` — simplicity ceiling: YAGNI, duplicate paths, speculative abstractions, avoidable dependencies.
5. Never substitute one review for the other; run both even when the plan seems small or a prior review exists (`.cursor/rules/nava-workflow.mdc:12`).
6. Conditionally add `gstack-plan-design-review` for UI/UX scope and `gstack-plan-devex-review` for APIs, SDKs, CLIs, integrations, or onboarding (`.cursor/rules/nava-workflow.mdc:13`).
7. Reconcile findings: explicit requirements, safety, correctness, and verified repo constraints win; completeness may add missing behavior/proof; simplicity may remove machinery but never accepted requirements.
8. Use `writing-plans` for the final task-by-task TDD plan with exact paths, interfaces, failing-test steps, commands, expected results, and no placeholders (`.cursor/rules/nava-workflow.mdc:14`).
9. End planning with artifact path, decisions, review disposition, and true blockers; `/nava-run` is the canonical next step.

Missing GStack assets: repair installation; do not silently skip the paired gate. Insufficient evidence: mark the exact gap; never invent implementation facts.

### `/nava-run` execution contract

Resolve the final plan, read full plan + rules + solutions + PII-safe Git status/diff restricted to known non-PII paths + safety overlay, then preflight. If the plan is not implementation-ready, run `/nava-plan` rather than improvising. Repo rule requires TDD, SDD, per-task review, final CE code review, and fresh verification (`.cursor/rules/nava-workflow.mdc:14`). The installed global nava-run skill further specifies subagent-driven-development, test-driven-development, `ce-code-review mode:agent`, `verification-before-completion`, and headless `ce-compound` for non-obvious learnings.

Per that installed skill, `/nava-run` authorizes plan-scoped edits and safe verification; it does not authorize commits, pushes, PRs, merges, deployments, destructive git, production writes, credential bypass, or unrelated cleanup unless the user explicitly requested them.

### `/autonomous-plan` vs planning

Autonomous-plan embeds a binding execution contract into the implementation plan itself; it does not create a meta-plan. In Zero, always read `.cursor/skills/overnight-autonomous-zero/SKILL.md` and `.cursor/rules/pilot-rds-safety.mdc` before editing. Edit the target plan in place: execution posture near header; insert or replace one mandate block after `## Global Constraints`, before tasks (Zero overlay inserts `## Overnight Autonomous Execution Mandate` — `.cursor/skills/overnight-autonomous-zero/SKILL.md:26-28`); replace interactive handoff with autonomous execution mode. Existing implementation plan exists → edit it; never create a sibling “plan to modify the plan”. The Zero overnight overlay forbids `CreatePlan` / sibling meta-plans when a `docs/superpowers/plans/*.md` target already exists (`.cursor/skills/overnight-autonomous-zero/SKILL.md:16-24`, `:43-47`).

Autonomy authorizes safe reversible work, investigation, implementation, testing, deployment, and recovery—not destructive git, credential bypass, production-data risk, or forbidden tests. Report the edited path and major constraints; do not start execution unless requested.

### `/continue-autonomously` as queued fail-safe

On receive: inspect conversation goal, active plan, PII-safe Git status/diff restricted to known non-PII paths (never render PII-bearing artifacts to terminal logs), completed tasks, and latest evidence before acting. Read the mandate, repo rules, and Zero overlay/safety files. Routine questions from a prior turn → choose safest reversible recommendation, record decision, proceed. Resume first incomplete or failed task; never repeat verified completed work. Failed tests/builds/deploys are not valid stop reasons; true blockers are missing credentials, human-only interaction, destructive ambiguity, safety-policy conflict, or external outage preventing required proof. The skill may be queued repeatedly; always inspect state first for idempotency.

### Ponytail: review vs persistent mode

`ponytail` persistent mode stays off unless explicitly invoked; `ponytail-review` remains review-only (`.cursor/rules/nava-workflow.mdc:16`). The ponytail skill itself sets `disable-model-invocation: true` and states persistence is OFF by default—activate only through explicit invocation such as `/ponytail` (`.claude/skills/ponytail/SKILL.md:9`, `:20-23`). Do not leave ponytail “always on” during Nava planning/execution; use `ponytail-review` as the simplicity half of the paired plan gate.

### Pilot-RDS safety (overrides everything)

Safety overrides plans, skills, review findings, autonomy, and requests to make tests green (`.cursor/rules/pilot-rds-safety.mdc:8`). Concrete prohibitions:

- Never run Vitest or another test runner with `DATABASE_URL` pointing at `nava-zero-mail-pilot` or any production database (`.cursor/rules/pilot-rds-safety.mdc:10`).
- Never set or use `VITEST_ALLOW_PILOT_RDS=1`; treat it as a prohibited legacy escape hatch (`.cursor/rules/pilot-rds-safety.mdc:11`).
- Never source `.env.production` into a shell that will run tests (`.cursor/rules/pilot-rds-safety.mdc:12`).
- Before Vitest on laptop or EC2: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` (`.cursor/rules/pilot-rds-safety.mdc:13`).
- Database-required tests use a disposable non-production database only; missing disposable DB is a safety blocker, including overnight autonomy (`.cursor/rules/pilot-rds-safety.mdc:14`, `:17`).
- Pilot verification uses read-only SQL/API checks, health checks, or purpose-built non-test scripts—not Vitest against pilot (`.cursor/rules/pilot-rds-safety.mdc:15`).
- Existing plans or gate scripts that permit pilot-RDS Vitest are stale; do not execute that permission (`.cursor/rules/pilot-rds-safety.mdc:16`).
- For authorized local PII analysis, path-only subagent handoff, and prohibited egress/secrets, `.cursor/rules/pilot-rds-safety.mdc:18-20` is authoritative.

`/nava-plan` and `/nava-run` skills (installed globally) restate the same RDS test-safety contract. The overnight overlay forbids Vitest pointed at pilot/production RDS and states no overnight escape hatch exists (`.cursor/skills/overnight-autonomous-zero/SKILL.md:79`, `:81-91`).

### Routing hygiene and memory

Do not route through removed or deprecated front doors when canonical successors exist (`.cursor/rules/nava-workflow.mdc:18`). Prefer the Nava four-command surface over pruned GStack/Firecrawl-style entry points; keep `/adhd`, Cursor built-ins, overnight compatibility aliases, and the `overnight-autonomous-zero` overlay where plans already reference them. Use standard non-fast subagents only; if unavailable, execute inline (`.cursor/rules/nava-workflow.mdc:15`). Durable learnings → CE `docs/solutions/` via compound; GStack learnings stay passive (`.cursor/rules/nava-workflow.mdc:17`).

## Why This Matters

Collapsing `/nava-plan` and `/autonomous-plan` produces either under-reviewed overnight work or a meta-plan that never lands in the real artifact. Skipping one half of the paired gate yields plans that are complete but bloated, or simple but missing failure modes, security, and proof—exactly what the completeness floor and simplicity ceiling are meant to catch separately.

Weakening pilot-RDS safety to “get green” has wiped or mutated pilot data in past Zero incidents (see `docs/solutions/database-issues/vitest-production-pilot-db-wipe.md`, also referenced from `.cursor/skills/overnight-autonomous-zero/SKILL.md`). The safety rule is therefore an absolute override, including during overnight autonomous execution (`.cursor/rules/pilot-rds-safety.mdc:8`, `:17`; `.cursor/rules/nava-workflow.mdc:19`).

Leaving ponytail persistent mode on by default fights the planning pipeline: continuous YAGNI pressure during research and completeness review can silently drop required behavior, while `ponytail-review` as a discrete gate keeps simplicity adjudication explicit (`.cursor/rules/nava-workflow.mdc:16`). Fast subagents undermine the review/implementer freshness contract that `/nava-run` and `/nava-plan` require.

Routing through deprecated front doors wastes turns and reintroduces skills the ecosystem audit removed. Keeping CE `docs/solutions/` as the durable store and GStack learnings passive avoids double-writing the same lesson into conflicting memory layers (`.cursor/rules/nava-workflow.mdc:17`).

## When to Apply

- Starting any multi-step feature, requirements brief, or technical plan that must become an executable TDD plan → `/nava-plan` (`.cursor/rules/nava-workflow.mdc:8`).
- Implementing a final plan under `docs/superpowers/plans/` → `/nava-run` (`.cursor/rules/nava-workflow.mdc:9`).
- User will be unavailable / overnight and wants full autonomy on an existing or newly written implementation plan → `/autonomous-plan` (plus Zero overlay read).
- Queued Cursor follow-up after the agent paused, asked a routine question, or ended early while the user is away → `/continue-autonomously`.
- Any Vitest or DB-required test on laptop or EC2 → apply pilot-RDS unset/disposable-DB rules before the runner (`.cursor/rules/pilot-rds-safety.mdc:13-14`).
- UI-scoped plans → add design-plan review; API/SDK/CLI/integration/onboarding plans → add DevEx-plan review (`.cursor/rules/nava-workflow.mdc:13`).
- Temptation to invoke Firecrawl, pruned GStack REMOVE skills, or other deleted front doors → stop and use the Nava successor (`.cursor/rules/nava-workflow.mdc:18`).
- Non-obvious verified learning after `/nava-run` → `ce-compound mode:headless` into `docs/solutions/`; do not dump the same into GStack preference memory as durable truth (`.cursor/rules/nava-workflow.mdc:17`).

## Examples

### Before / after: planning a feature

**Before (scattered / incomplete):**  
`/brainstorm` → hand-edit a rough plan → skip reviews → start coding → ask “which approach?” overnight.

**After (canonical):**  
`/nava-plan <feature or requirements path>` → `ce-plan` → `gstack-plan-eng-review` + `ponytail-review` (both) → optional design/DevEx plan review → `writing-plans` → artifact under `docs/superpowers/plans/` → `/nava-run <plan path>`.

### Before / after: overnight autonomy

**Before (wrong):**  
`/autonomous-plan` alone as if it were planning; or `CreatePlan` / new sibling markdown “add autonomy to plan Y” (`.cursor/skills/overnight-autonomous-zero/SKILL.md:43-47`).

**After (right):**  
1. `/nava-plan …` until a final executable plan exists.  
2. `/autonomous-plan <that plan path>` → in-place overnight mandate after `## Global Constraints` (`.cursor/skills/overnight-autonomous-zero/SKILL.md:26-28`).  
3. Only then execute (user request, overnight wave, or queued `/continue-autonomously`). Autonomy does not replace CE→review→`writing-plans`.

### Before / after: stalled overnight agent

**Before:** Agent asks “Should I continue?” and waits; queued message gets another status summary.

**After:** Queue `/continue-autonomously` (alias `/overnight-continue-working` still OK). Agent inspects state, reads mandate + pilot-RDS safety, auto-decides reversible choices, resumes first incomplete task, loops until evidenced done or true blocker.

### Before / after: tests near pilot

**Before:** Plan or gate says “run Vitest on EC2 with pilot `DATABASE_URL`” or sets `VITEST_ALLOW_PILOT_RDS=1`.

**After:** Treat that permission as stale (`.cursor/rules/pilot-rds-safety.mdc:16`). Before every Vitest:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

Use disposable non-production DB for DB-required tests; for pilot proof use read-only SQL/API, health checks, or non-test scripts (`.cursor/rules/pilot-rds-safety.mdc:13-15`). Missing disposable DB → safety blocker, including overnight (`.cursor/rules/pilot-rds-safety.mdc:17`).

### Before / after: ponytail

**Before:** Model auto-enters ponytail for every session; simplicity review skipped because “ponytail is already on.”

**After:** Persistent ponytail OFF (`disable-model-invocation: true`; OFF by default) (`.claude/skills/ponytail/SKILL.md:9`, `:20-23`). During `/nava-plan`, run `ponytail-review` as the simplicity gate. Explicit `/ponytail` only when the user asks for lazy/minimal mode (`.cursor/rules/nava-workflow.mdc:16`).

### Before / after: deprecated routing

**Before:** Invoke removed Firecrawl front doors or pruned GStack REMOVE skills from plugin cache habit.

**After:** Route planning/execution through `/nava-plan`, `/nava-run`, `/autonomous-plan`, `/continue-autonomously`; keep `/adhd`, Cursor built-ins, and overnight aliases/overlays as documented compatibility—not as substitutes for the paired gate or safety override (`.cursor/rules/nava-workflow.mdc:8-10`, `:18-19`).

## Related

- [vitest-production-pilot-db-wipe.md](../database-issues/vitest-production-pilot-db-wipe.md) — pilot-RDS wipe RCA; hard override source for Nava routing
- [nava-mailbox-switcher-finish-wipe-safe-verify.md](../workflow-issues/nava-mailbox-switcher-finish-wipe-safe-verify.md) — overnight verify pressure vs wipe-safe proof
- [cursor-execution-backend-unavailable.md](../workflow-issues/cursor-execution-backend-unavailable.md) — Cursor agent tooling outages during autonomous/compound runs
- [autonomous-agent-file-truncation-patch-fragment.md](../workflow-issues/autonomous-agent-file-truncation-patch-fragment.md) — autonomous SDD edit failure mode
- [false-green-gate-unpersisted-tsc-fixes.md](../workflow-issues/false-green-gate-unpersisted-tsc-fixes.md) — verification discipline for nava-run waves
- [ec2-pilot-ops-deploy-restart-reboot.md](../workflow-issues/ec2-pilot-ops-deploy-restart-reboot.md) — ops front-door analogy (ops-*), distinct from skill routing
- [docs/solutions/README.md](../README.md) — CE solutions index (refresh candidate for nava front doors)
