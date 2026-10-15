# Zero Coding Workflow and Model Routing — Implementation Plan

> **For agentic workers:** This plan authorizes only the scoped documentation/skill work after the user explicitly starts implementation. Preserve unrelated work. Never contact Zero production, inspect credentials, or use production data. Do not install a proxy/router or incur model spend under this plan.

**Goal:** Add a low-overhead Cursor/Codex workflow skill for bounded Zero work, preserve Nava’s full path for real multi-step and high-risk changes, and make no unsupported cross-provider savings claims.

## Current context / assumptions

- User now prioritizes speed and efficient model use over maximal process on every edit; default child agents and repeated per-task reviews feel slow/token-heavy.
- `.cursor/rules/nava-workflow.mdc` routes actual multi-step plans through `/nava-plan`, paired engineering/simplicity reviews, and final plans through `/nava-run` with TDD/SDD, per-task review and final review. Preserve that contract when a plan is needed; add only a narrow bounded-implementation exception. Do not edit global `/nava-run` skill.
- Official Cursor and Codex docs support repo `.agents/skills/`; open the repo root for predictable discovery. Cursor invokes via `/` skill selection; Codex uses `/skills` or `$skill-name`. Grok Build project skills use `.grok/skills/`, so no Grok skill discovery is claimed here.
- Cursor and Codex have distinct auth, model-selection, and version/update controls; the shared skill does not configure them. Exact account model availability and auth/quota are unknown. Do not pin versions or add a bootstrapper; use each CLI's own documented controls and record the version checked.
- Inspected versions: Codex CLI `0.158.0`, Cursor Agent `2026.09.26-dd393fe`; `grok` and `codeburn` absent from inspected owner’s `PATH`. Codex logs expose usage records; inspected Cursor records lack comparable per-task costs. Neither source set matches spend/tokens to task quality and elapsed time. Historical savings are unknown.
- xAI public pricing lists Grok 4.6 at $2/M input, $0.50/M cached input, $6/M output below 200k prompt tokens (higher long-context rates above that). Official Grok 4.7 announcement states same base input/output rates and speed as 4.6; retrieved table lacks 4.7 cache/long-context rates. User-reported credits, membership pricing and Azure rates are separate/unknown. “4.7 costs almost twice as much” is not supported by public base rates.
- Grok Build docs expose custom aliases and `[subagents.models]`; they do not prove Azure Luna compatibility, child tool support, or actual runtime child model. No Grok/Azure request or user-config access is authorized here.
- **External-model data boundary:** any separately authorized Grok or other external-provider smoke test must use synthetic, non-sensitive prompts and a toy non-production workspace. Never send credentials, keys/tokens, raw mail/PII, or production-derived artifacts to an external provider. If the safe input boundary cannot be verified, block the test. No external route or child agent is active by default.
- Before implementation starts, refresh/reconfirm this final plan against required `gstack-plan-eng-review` and `ponytail-review`; because it adds a CLI/model-routing skill, also require `gstack-plan-devex-review`. Record dispositions and reconcile blockers. Existing reviews of an earlier plan revision do not count for this final revision.
- LiteLLM would add a running proxy, credentials and maintenance, and its docs state Cursor CLI cannot target its gateway. OpenCode supports multiple providers/subagents but adopting it adds another CLI and migration. Neither is recommended for this scoped change.
- Worktree began with 100 staged/untracked entries. Preserve all; never blanket-stage. Leave plan-owned changes uncommitted; any later landing needs separate authorization/isolation.

## Architecture / proposed approach

Create one explicit-only Agent Skill under `.agents/skills/zero-model-router/` for Cursor/Codex, plus concise rule/solution updates making a narrow direct lane binding. Bounded work uses the current CLI/model, one implementer and focused checks; true multi-step or high-risk work keeps `/nava-plan` → paired reviews → `/nava-run`. No proxy, daemon, automatic model switch, Greptile hook or default child-agent loop.

## Routing policy

The embedded skill below holds the authoritative Quick/Standard/Planned criteria. Keep the always-applied rule and canonical solution as short pointers: bounded, settled implementation may use direct lane; genuine multi-step planning and consequential risk retain `/nava-plan`, paired plan reviews and `/nava-run`. Never relabel planned work as bounded to skip gates.

### Model-routing research findings

- Codex custom parent providers are documented; provider config is user/machine scoped. Custom agents can specify models, but docs do not prove child sessions can independently switch provider. Do not assume Codex provides Grok-parent/Luna-child bridge without runtime proof.
- Grok Build documents per-subagent model mapping; Azure Luna compatibility remains unverified.
- If separately authorized, runtime proof must tie observed parent and child provider/model IDs to the same invocation, show the required child tool use, and show no fallback. If those traces are unavailable, report routing as unverified; a config alias alone is not proof.
- LiteLLM adds a service and cannot target Cursor CLI. OpenCode adds another CLI. Recommendation: keep native Cursor/Codex usage; workflow skill rather than automatic model-router service.
- Current evidence does not support enabling the optional Grok/Azure route or claiming savings. If later approved, limit scope to one compatibility smoke test with a per-request spend cap and synthetic input. Report provider-reported usage if exposed; it is not comparable account billing. Keep the route opt-in; any broader cost/quality comparison or default-route decision requires separate authorization and a separately reviewed measurement plan.

## Step-by-step tasks

### Task 1: Establish safe worktree baseline, resolve review gates, and validate discovery

**Files to read:** `.cursor/rules/nava-workflow.mdc`, `AGENT.md`, `.cursor/rules/pilot-rds-safety.mdc`, `docs/solutions/architecture-patterns/canonical-nava-skill-routing-surface.md`, `.gitignore`, `package.json`.

1. Run `git status --short --untracked-files=all`; capture exact output outside repo. Also record a baseline fingerprint: SHA-256 of `.git/index` and each pre-existing changed/untracked worktree file, without printing file contents. Do not read or hash `.env*`, credential/key/token files, or raw-PII corpora; record those paths/status only and do not touch them. Abort if any planned target already has staged or unstaged user changes. At the end, compare status and fingerprints, allowing only the explicitly planned edits/new files.
2. Before implementation, refresh/reconfirm this exact plan with `gstack-plan-eng-review` and `ponytail-review`; add `gstack-plan-devex-review` for the CLI/model-routing skill. Record dispositions and resolve blockers before editing. Use standard non-fast subagents only; if unavailable, review inline.
3. Open repository root in each installed CLI the user intends to use. Verify native repo-skill visibility without a model request: Cursor `/` skill search; Codex `/skills`. Record CLI/version and visible/not visible. If a CLI is absent, leave absent; if visibility requires a model request, mark unverified and retain manual fallback. Do not install, upgrade, pin versions, inspect provider secrets, or add a Grok copy. A separate skill-invocation test is optional only in an already authorized normal session; do not issue an extra model request just to test UX. Grok remains unsupported by this repo-local skill.
4. Confirm no production access is needed. Historical cross-provider savings remain unknown; do not recalculate usage, export prompts/transcripts, inspect secrets, install tools, or create telemetry artifacts. Record account-specific rates as unknown.

### Task 2: Add explicit-only Cursor/Codex skill

**Files:** Create `.agents/skills/zero-model-router/SKILL.md` and `.agents/skills/zero-model-router/agents/openai.yaml`.

1. Write `SKILL.md` exactly:

```markdown
---
name: zero-model-router
description: Use when choosing a fast, low-overhead coding workflow in Cursor or Codex. Route bounded work directly; retain Nava for planned or risky work.
disable-model-invocation: true
---

# Zero Model Router

This is workflow guidance, not a model API or automatic provider switch. You select CLI and model. Report workflow tier, CLI/version, selected model/effort as exposed by that CLI, and whether hybrid routing is verified. If provider-side model identity cannot be observed, label it unverified. Cursor and Codex auth/model-selection controls differ; use the selected CLI's native documented controls, do not assume shared config.

Delegation and data boundary: use standard non-fast subagents only, or work inline. External-model experiments use synthetic, non-sensitive inputs only. Never send credentials, keys/tokens, raw mail/PII, or production-derived artifacts to external providers. Keep raw PII confined to the repository-authorized local-only Zero model route and standard local subagents; that does not authorize Grok or other external routes.

## Route

- Quick: one bounded, low-risk edit with clear acceptance. Use current CLI/model, one agent, focused check and diff review. No plan artifact, child or extra reviewer model.
- Standard: one-area change with settled acceptance and no unresolved product/design/API/data/security decision or external dependency. Use one implementer and focused tests. No plan artifact, default child or per-task reviewer loop.
- Planned/high-risk: any genuine multi-step design/planning need, auth/security, schema/data, external contract, live/production, irreversible action, cross-system change or material ambiguity. Use `/nava-plan`, required paired plan reviews and `/nava-run` unchanged.

Respect model preferences only when the current CLI/account exposes the exact model ID and effort. Do not map friendly names to a different model. If the CLI/model is unavailable or auth fails, do not install, switch provider/CLI, or downgrade silently. Continue with the current selected model only if substitution is acceptable; otherwise stop and report blocker. If hybrid checks fail, use the current CLI’s single-model route only when acceptable.

Grok Build + Azure Luna is not an active default. Never inspect user provider config or make model requests for this route without separate, explicit authorization and a per-request spend cap. If later authorized, use at most one compatibility smoke test with synthetic, non-sensitive input in a toy non-production workspace; never send credentials, keys/tokens, raw mail/PII, or production-derived artifacts to an external provider. Capture parent/child provider and exact model IDs linked to the same invocation, required child tool use, and evidence of no fallback. If traces are unavailable, keep routing unverified. One smoke test cannot establish cost savings or quality parity.

Run focused tests/checks and inspect diff. Greptile is optional, only at the user-requested final review stage after local checks. Triage findings and rerun affected tests. Greptile never proves tests passed and never authorizes commit, push, PR, merge or deploy.

Preserve `.cursor/rules/pilot-rds-safety.mdc`: unset `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS` before Vitest; never test on pilot/production RDS; DB-required tests need a disposable non-production database.

Do not print secrets, add a proxy, change global provider config, spend credits or commit/push without separate authorization. Report route, verification and unknowns.

## Invocation

- Open Cursor Agent or Codex CLI at repository root. Cursor: select `/zero-model-router` from `/` skill search. Codex: open `/skills` and select it, or mention `$zero-model-router`. Verify repository skill discovery without a model request; otherwise apply instructions manually. Keep `agents/openai.yaml` `allow_implicit_invocation: false`.
- If selected model is missing or auth fails, do not silently install, switch CLI/provider, or downgrade. Continue only if user accepts the currently selected single-model fallback; otherwise stop and report blocker. Hybrid failure follows same rule.
- Grok Build project skills use `.grok/skills/`; this shared skill makes no Grok project-discovery claim.
```

2. Create `.agents/skills/zero-model-router/agents/openai.yaml` exactly:

```yaml
interface:
  display_name: "Zero Model Router"
  short_description: "Low-overhead Zero workflow for Cursor and Codex"
policy:
  allow_implicit_invocation: false
```

### Task 3: Add narrow direct-lane policy and align canonical solution

**Files:** Modify `.cursor/rules/nava-workflow.mdc` and `docs/solutions/architecture-patterns/canonical-nava-skill-routing-surface.md`.

1. Preserve `/nava-plan`, both paired plan reviews and `/nava-run` semantics. Add after `/nava-run` in `.cursor/rules/nava-workflow.mdc`:

```markdown
- Bounded, low-risk one-area implementation with explicit acceptance and no unresolved product/design/API/data/security decision or external dependency may use the direct lane or explicitly invoke `/zero-model-router`; true multi-step planning still uses `/nava-plan`.
```

2. Replace existing implementation bullet (`Final executable plans use ... fresh verification.`) with:

```markdown
- Final executable plans use `writing-plans`; implementation of those plans uses TDD, SDD, per-task review, final CE code review, and fresh verification. Direct-lane bounded work uses test-first for behavior changes, focused checks, and diff review; it adds no plan artifact, default child or per-task review loop.
```

Keep paired plan-review rule unchanged.
3. In canonical solution, immediately after `/nava-run` row under `## Canonical command map`, add:

```markdown
| Bounded implementation needing no plan | Direct or `/zero-model-router` | Explicit acceptance; no unresolved product/design/API/data/security decision or external dependency; focused checks; does not replace `/nava-plan` for actual multi-step planning |
```

Under `## When to Apply`, immediately before existing multi-step `/nava-plan` entry, add:

```markdown
- Bounded one-area implementation with explicit acceptance and no unresolved product/design/API/data/security decision or external dependency → direct lane or explicitly `/zero-model-router`.
```

Update solution summary of always-applied rule to name narrow exception. Leave paired-review procedure, `/nava-run` contract, planned-work examples, `AGENT.md`, and pilot-RDS rule unchanged.
4. Inspect the final skill and both policy files together. Confirm the direct lane has a clear acceptance/risk boundary, actual multi-step work still routes through Nava, paired plan gates and `/nava-run` requirements remain intact, and external-model/PII and pilot-RDS limits are explicit.

### Task 4: Final verification and review

**Files:** Four plan-owned files: skill, Codex metadata, Cursor rule, canonical solution.

Run `git diff --check -- .agents/skills/zero-model-router/SKILL.md .agents/skills/zero-model-router/agents/openai.yaml .cursor/rules/nava-workflow.mdc docs/solutions/architecture-patterns/canonical-nava-skill-routing-surface.md`. Require exit 0/no output. Inspect exact four-file diff against Task 3; confirm no credential-like values, pilot-RDS rule unchanged, `/nava-run` contract unchanged, and baseline status/fingerprints unchanged outside planned targets. Documentation/skill-only changes do not require application tests. Preserve unrelated staged entries; no commit/push under this plan. Any later landing needs separate authorization/isolation.

## Risks, tradeoffs, and open questions

- Published base-rate and speed announcements do not establish account-route cost, latency, or task quality. Actual bills, Azure rates and credits are unknown; cross-provider gains remain unmeasured.
- Grok/Azure child routing may fail despite documented mapping. One approved smoke test can establish invocation-level compatibility only, not efficiency or savings.
- Cursor CLI skill discovery needs installed-runtime confirmation. If it cannot be checked without a model request, leave unverified; do not spend just to check.
- Direct lane trades layered review for focused checks. Reserve it for clearly bounded, settled work; keep Nava for actual plans and consequential risk.
- No proxy, new CLI, auto-Greptile hook, telemetry exporter or default child-agent loop in scope.

## Research sources

- Repo: `docs/solutions/architecture-patterns/canonical-nava-skill-routing-surface.md`; `docs/solutions/workflow-issues/cursor-execution-backend-unavailable.md`.
- Cursor: [CLI parameters](https://cursor.com/docs/cli/reference/parameters), [CLI usage](https://cursor.com/docs/cli/using), [Agent Skills](https://cursor.com/docs/skills); use official CLI account/model controls and docs for current install/update behavior.
- Codex: [CLI reference](https://developers.openai.com/codex/cli/reference), [authentication](https://developers.openai.com/codex/auth), [advanced configuration](https://developers.openai.com/codex/config-advanced), [configuration reference](https://developers.openai.com/codex/config-reference), [subagents](https://developers.openai.com/codex/subagents), [Agent Skills](https://developers.openai.com/codex/skills). Use official version-matched docs for auth/model controls; no shared config is assumed.
- Grok Build: [custom models](https://docs.x.ai/build/overview), [settings](https://docs.x.ai/build/settings/reference), [subagents](https://docs.x.ai/build/features/subagents), [skills](https://docs.x.ai/build/features/skills-plugins-marketplaces), [CLI](https://docs.x.ai/build/cli/reference).
- Routing alternatives: [LiteLLM proxy overview](https://docs.litellm.ai/docs/), [Cursor CLI gateway limitation](https://docs.litellm.ai/docs/tutorials/cursor_integration), [OpenCode agents](https://opencode.ai/docs/agents/), [OpenCode providers](https://opencode.ai/docs/providers/).
- Pricing: [xAI API pricing](https://docs.x.ai/developers/pricing), [Grok 4.7 announcement](https://x.ai/news/grok-4-7), [Azure model catalog](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure).
- Review: [Greptile introduction](https://docs.greptile.com/introduction), [examples](https://docs.greptile.com/examples); local `.agents/skills/greptile-cli/SKILL.md` and `.agents/skills/greploop/SKILL.md`.
