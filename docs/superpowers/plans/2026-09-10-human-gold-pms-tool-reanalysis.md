---
title: Human-gold PMS tool reanalysis (3949 Sent vs 420 labelled)
date: 2026-09-10
type: research
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: analysis-then-build
supersedes_analysis: docs/superpowers/plans/2026-09-04-gold-response-tool-agent-architecture.md
does_not_supersede: docs/superpowers/plans/2026-09-06-reservation-revenue-triage-drafting-plan.md
---

# Human-gold PMS tool reanalysis (3949 Sent vs 420 labelled)

**Execution posture:** overnight autonomous analysis, then tool-catalogue report, then implementation of revised contracts. Does **not** hijack the in-flight Codex live-read plan (`2026-09-06-reservation-revenue-triage-drafting-plan.md`).

## Goal Capsule

Use the Apr 1–Sep 10 human Sent gold (3949 eml) plus the labelled 420-gold / 314 Sent-body baseline to decide, with evidence, which PMS tools an AI reservationist needs: read, write, modify, edit. Produce a markdown report with schema + rationale + build order. Then begin building those tools under existing safety gates.

Ignore the 361 subtracted PMS/calendar autos for **human-reply tool ranking**. Still scope replacing those autos later (`document.generate_confirmation_proforma` / `document.send_confirmation`) — already named in older write roadmaps, **not implemented** in current TypeScript.

## Global Constraints

- Local private mail only. No mail bodies, addresses, names, or reservation numbers in git, Exa, web search, MCP, SSM, or CI.
- Git-tracked report = aggregates, tool IDs, schemas, counts. Private working files under `.private/gold-reanalysis-2026-09-10/`.
- 420 labelled gold is the **method/baseline**. 3949 is the **scale corpus** used to falsify whether 420 was enough.
- No live PMS writes, document generation, sends, queue/outbox, credential changes, or authorization bypass.
- No Vitest against pilot/production RDS. `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before tests.
- Do not edit Codex in-flight files: `apps/server-pilot/src/ai/worker.ts`, `thread-context.ts`, `hms/read-service.ts`, or its current tests, while that agent is running. New analysis/docs/private artifacts only until report lands; implementation after that in non-overlapping files or a new worktree.
- Standard non-fast subagents. `/caveman ultra`. Pass file paths, never raw PII, in dispatch prompts.
- Exa Agent MCP is unavailable in this session. Public Infor research uses ordinary Exa / docs.infor.com only. Generic queries, no tenant data.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No "which approach?" pause.

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

This analysis run additionally forbids live PMS mutation and Nava production deploy as a substitute for the report. Deploy only if a later implementation task explicitly requires it and does not collide with Codex.

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

This is Cursor's agent tool bridge, not Zero app/AWS/RDS. Full playbook: `docs/solutions/workflow-issues/cursor-execution-backend-unavailable.md`.

**Required agent behavior:**
1. Do **not** ask the user to wait or re-invoke.
2. Backoff-retry Shell/Write/StrReplace (≈5s → 15s → 45s) until `echo shell_ok` works or three attempts fail.
3. On recovery: `git status`, read `.superpowers/sdd/*progress*`, resume mid-task (resume subagent or re-dispatch with existing uncommitted work).
4. Only if retries exhaust **and** Shell still dead after ~5 minutes: record blocker in handoff with evidence; still do not invent an app RCA.

### Divergence authority

Better path to done criteria → take it. Log in handoff report.

### Decision authority

- Choose best safe reversible option without asking.
- Preserve requirements. Do not silently cut scope.
- Use standard non-fast subagents only; otherwise work inline.

### Done criteria

- [x] Deterministic census of 3949 human eml (subjects, authored vs quoted, attachments, RE/FW, month) written under `.private/gold-reanalysis-2026-09-10/` with **no git-bound PII**.
- [x] Same classifiers run against labelled 420 / 314 artifacts; overlap and divergence tables exist.
- [x] At least three falsifying hypotheses tested (420 sufficient; Sent-only undercounts inbound tools; ops/handoffs should not drive PMS tools).
- [x] Confirmation-letter auto-send: existing scope vs current code vs 361-auto corpus, documented.
- [x] Public Infor read vs write surfaces checked (ordinary Exa / official docs; no private mail egress).
- [x] Final report at `docs/superpowers/plans/2026-09-10-pms-tool-catalogue-from-human-gold.md` with evidence-backed table: tool ID, mode (read/write/amend), schema sketch, demand count, why, build order, existing-code status.
- [x] Close-read labels for **every** of 3949 human gold ids: 99 shards × ~40, `labels-all.jsonl` line count = 3949, unique ids match `all-ids.txt`. Aggregates in `labels-aggregate.json` (no PII).
- [x] Catalogue updated from those per-record labels (not regex lanes).
- [x] Writes remain fixture-only / human-gated in the catalogue; no live mutation performed.
- [ ] If time remains after the report: start implementation of highest-priority **non-overlapping** read/schema work without clobbering Codex.
- [x] No unresolved blocker affecting the analysis report.

### True blockers

Stop only for missing credentials/access that cannot be obtained safely, required human-only interaction, destructive ambiguity, safety-policy conflict, or external outage that prevents required proof. Missing Exa Agent is **not** a blocker (ordinary Exa fallback). Codex occupying this worktree is **not** a blocker for analysis (isolate files).

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"

## Corpora (do not mix)

| Corpus | Path | Role |
|---|---|---|
| 3949 human Sent gold | `.private/backup-zip-2026-09-10/gold-human-apr1-sep10/` (this worktree symlinks to main `.private`) | New scale frequency + body/subject analysis |
| 361 subtracted autos | same folder `auto-manifest.jsonl` | Later auto-replacement scope, not human ranking |
| 420 labelled gold | `.private/gold-product-research-2026-09-06/` | Method baseline; human_reply / template / handoff labels |
| Prior demand docs | `docs/infor-hms/centurion-pms-tool-demand-2026-08-04.md`, `docs/superpowers/plans/2026-09-04-gold-response-tool-agent-architecture.md`, `docs/infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md` | What 420 produced |

## Tasks

### T0. Private workspace

Create `.private/gold-reanalysis-2026-09-10/` with `progress.json`, `census.json`, `hypotheses.json`. Gitignore already covers `.private/`.

### T1. REPL census of 3949

Python over `human-manifest.jsonl` + `.eml` bodies:

- Physical shape: RE / FW / original; month; folder; attachment MIME/name class (no guest names in outputs).
- Authored-text vs quoted history (quote-boundary).
- Tool-demand regex families aligned to 420 labels: reservation identity, documents, folio/payment, rates/quote, group/event, mail artifacts, property knowledge, amend/cancel/create, refund, invoice, rooming list, ops reports.
- Template-family clustering (normalized body hash / structure), not prose copy-paste assumption.
- Counterevidence: sample "human" that is still template; sample "ops original" that is not a PMS tool.

### T2. Replay 420 classifiers

Run the same demand regex on 420 review records / 314 Sent bodies. Table: category share 420 vs 3949. Call a ≥2× relative shift a **priority change candidate**. Call a family that appears at scale in 3949 but was <5% in 420 a **new-tool candidate**.

### T3. Falsify 420 sufficiency

Hypotheses to try to break:

1. 420 already captured the same MVP (find, artifact, quote, folio, documents).
2. 3949 is mostly RE/FW wrapping, so it inflates mail-artifact and undercounts create.
3. Internal handoffs (Room Balancing, Res Checklist, Group Report) dominate originals and should **not** become PMS write tools.
4. Channel FW (Booking Update) needs a distinct "forwarded OTA payload" reader, not `hms_find_reservation`.
5. Auto confirmation send is already "being built" in this worktree — check code. Expected: scoped in roadmap, **not** in `READ_TOOL_IDS` / write adapters.

### T4. Public surface check

Ordinary Exa + `docs.infor.com` (2026.08): confirmation letter generate/send, stay wizard amend, cancellation finance effects, CRS availability hold. Confirm read vs write split. No tenant queries.

### T5. Report

Write `docs/superpowers/plans/2026-09-10-pms-tool-catalogue-from-human-gold.md`:

- Verdict: was 420 insufficient?
- Table: tool, mode, schema, 3949 demand, 420 demand, rationale, existing status, build order.
- Read MVP vs deferred vs write/amend/edit (fixture-only).
- Explicit auto-CL replacement track.
- Gaps.

### T6. After report

If Codex still owns `read-service.ts` / worker: do not edit those files. Start with catalogue + contract markdown + tests in new files. If Codex idle: implement highest-priority schema deltas with TDD.

## File map

- Plan (this file)
- Report: `docs/superpowers/plans/2026-09-10-pms-tool-catalogue-from-human-gold.md`
- Private: `.private/gold-reanalysis-2026-09-10/`
- Do not modify: `docs/superpowers/plans/2026-09-06-reservation-revenue-triage-drafting-plan.md` while Codex executes it
