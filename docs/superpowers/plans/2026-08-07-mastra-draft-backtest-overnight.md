# Mastra Centurion Draft Backtest Overnight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/nava-run` with `superpowers:subagent-driven-development` (or `superpowers:executing-plans`) task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Queued resume uses `/continue-autonomously`.

**Goal:** Build a Mastra claim-safe drafting agent over Phase B **read-only** HMS/mail tools, backtest drafts against every Centurion-eligible inbound thread on pilot RDS, compare to real Centurion outbound replies (or note forwards), run failure analysis + improvement loops, and stop in a workable state by **08:00 Europe/London** — finish proper work, not race to “done.”

**Architecture:** Extend existing claim-safe Mastra `createTool` path (`candidate-draft-agent` + `draft-evidence` + code-owned claims). Overnight: **no new Mastra Workflow file** — runner calls claim-safe draft directly (Agent tools already Mastra). Flow: corpus → bounded read tools → structured draft plan → brackets → **eval-only** JSONL store → scorer. Model never invents PMS facts; missing fields become `[MISSING: … | how to get: …]`.

**Tech Stack:** TypeScript, Mastra (`@mastra/core` Agent/Workflow/`createTool`), Bedrock via existing adapter factory, Drizzle/Postgres read-only corpus queries on EC2, Vitest on disposable DB only, SSM/`ops-deploy`, existing HMS active registry.

**Research (2026-08-07):**
- Exa Agent `agent_run_86e7626a43ce40bf931d49311edb5f08`: prefer least-privilege Agent tools + Workflow wrapper; `maxSteps` + `beforeToolCall` allowlist; structured output; app-owned citations ([mastra.ai agents/tools/workflows](https://mastra.ai/docs/agents/overview)).
- Codebase: claim-safe agent already exists; production `candidateToolEffects` = find/quote/artifact only; EC2 registry has six live actives including folio/sent-email; HMS shadow discards bodies today; no draft↔Centurion-outbound scorer yet ([explore](cd924fcb-e737-46d0-a235-cf35144a866e)).

## Global Constraints

- **PMS:** read-only forever this plan. No create/edit/modify/delete/post/save/print/email/resend in Infor HMS.
- **Mail:** drafts + eval artifacts only. **Zero SMTP sends.** Never enqueue `outbound_send_queue` from AI/backtest.
- **Hallucination ban:** unresolved facts → square brackets with expected detail + how to obtain (tool/surface/hotel grant). Never invent rates, balances, confirmations, policies.
- **Pilot RDS Vitest ban:** never Vitest/`VITEST_ALLOW_PILOT_RDS` against `nava-zero-mail-pilot`. Corpus backtest = purpose-built read-only script on EC2 (or disposable DB fixtures for unit tests).
- **PII:** no raw guest values, addresses, card data, full bodies in prompts to subagents, logs, SSM, commits, or public reports. Aggregates + redacted hashes only in git.
- **Tools:** only registry-active read tools + mail artifact. Company/group/event remain blocked surfaces — bracket, do not fake.
- **Promote/send:** human product path unchanged; backtest must not call promote/send tRPC.
- **Clock:** hard stop **08:00 Europe/London**. Prefer correct partial progress over unfinished “everything.”
- **Cost:** full corpus preferred; if time/rate-limit force triage, document sampling rule and continue improvement on scored set.

---

## Overnight Autonomous Execution Mandate

**User granted full autonomy for planning and execution.** User asleep. No blocking questions. No “which approach?” No wait for `/continue-autonomously` unless queue injects it — when injected, treat as resume authorization and continue.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**
- Plan file is source of truth. Do not create meta-plans or `.cursor/plans/*` duplicates.

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) — **read-only corpus queries via purpose-built scripts only** |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| **Primary deploy** | `apps/server-pilot/deploy/ops-deploy.sh` |
| **Primary app bounce** | `apps/server-pilot/deploy/ops-restart.sh` |
| Guts | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |

**Allowed:** ops wrappers, bundle sync, deploy, read-only SSM, PM2 logs, health curl, Bedrock draft generation for backtest, purpose-built read-only SQL against pilot for corpus export/scoring, disposable-DB Vitest, `/95` + Exa when evidence gaps named.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail credential rotation, Vitest against pilot/production RDS, `VITEST_ALLOW_PILOT_RDS=1`, sourcing `.env.production` into Vitest, SMTP send, HMS writes, auto-promote of AI drafts to human send path.

### Pilot RDS safety (overrides autonomy)

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
```

before every Vitest. Corpus backtest scripts may read pilot on EC2 with production env **only** when: (1) not Vitest, (2) SELECT-only / Drizzle read APIs, (3) no mutation SQL, (4) no PII in stdout/SSM.

### Hard deadline — 08:00 Europe/London

| Rule | Behavior |
|------|----------|
| Check clock | Every task boundary + every improvement-loop iteration via `TZ=Europe/London date` (shell). Do **not** trust LLM clock or stale web widgets. |
| Soft warn | From **07:15** UK: no new improvement loops; finish current score + handoff only. |
| Hard stop | At **08:00** UK: stop mid-task if needed after making **workable state** (committed code, documented score, known next step). |
| Success ≠ finished | Morning review/steer is expected. Partial corpus + clear RCA beats fake 100% complete. |
| `/continue-autonomously` | Resume incomplete tasks until deadline; never duplicate green gates. |

### `/loop` improvement protocol (time permitting)

After first full (or documented sample) backtest scorecard:

1. Rank failures by severity (invented fact > missing bracket > tone/format > soft similarity).
2. Pick top N (≤10) with causal RCA (`file:line`).
3. One minimal fix (prompt, claim mapper, tool wiring, scorer, bracket template).
4. Regression Vitest (disposable DB) → re-score **affected cohort** → then optional full rescore if time.
5. Repeat until **07:15** UK or diminishing returns.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume.

### Divergence authority

Better path to morning-reviewable agent → take it. Log in handoff. Prefer extending claim-safe agent over greenfield freeform Mastra Agent that invents facts.

### Done criteria (overnight — check what evidence allows by 08:00)

- [ ] Claim-safe Mastra draft path can call Phase B **active** read tools (find, quote, artifact, folio deposit, sent-email/list-docs as proven) under read-only + no-send firewall
- [ ] Bracket policy for missing/write-only/blocked surfaces implemented + tested
- [ ] Purpose-built corpus backtest runner reads Centurion-eligible threads from pilot RDS (read-only) without Vitest-on-pilot
- [ ] Eval-only draft artifacts stored efficiently (hash-keyed files or compact JSONL under private root; not product send queue)
- [ ] Scorer compares agent draft vs Centurion outbound (or labels forward/no-reply/external) with aggregate report + per-thread failure classes (PII-free)
- [ ] Handoff report with clock, scores, blockers, commits; workable for 08:00 human steer
- [ ] Production boundary tests still prove no SMTP/HMS-write from draft agent graph
- [ ] Optional: improvement loop if clock allows (not a success gate)

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Queued fail-safe: `/continue-autonomously`. Plan reviews: `gstack-plan-eng-review` + `ponytail-review` (both required; folded below). Do not ask “which approach?”

### Dataflow (locked)

```text
Centurion inbound (transport-centurion)
  → same thread_id earliest later Centurion outbound (else NO_GOLD / FORWARD)
  → claim-safe Mastra createTools (registry-active reads only)
  → draft body + brackets
  → JSONL eval store {runId, messageIdHash}
  → scorer (INVENTED_FACT hard gate)
```

### Review fold-ins (2026-08-07)

**Eng [APPROVE_WITH_NOTES](02d2dbb8-56f5-4b43-9fc4-230918043be6):** gold pairing same-thread; invented-fact = token∉evidence∪brackets; Vitest fixtures only; resume skip by messageIdHash; Bedrock concurrency=1, 90s abort, first run `--limit 25`.

**Ponytail [CUT_COUNT=12](2c5f4612-ed3e-4493-b8b2-4cdbae11efb6):** drop new Workflow/`mastra.ts` register/`eval-runner` mode; collapse backtest to `draft-backtest.ts` + CLI; inline brackets into `draft-evidence` if small; soft failure classes optional.

---

## File map

| File | Responsibility |
|------|----------------|
| `apps/server-pilot/src/ai/draft-evidence.ts` | Inline `formatMissingBracket` + claim render hooks |
| `apps/server-pilot/src/ai/draft-backtest.ts` | Corpus select + runner + JSONL store + scorer (one module overnight) |
| `apps/server-pilot/src/ai/candidate-draft-agent.ts` | Expand tools to active Phase B reads; keep claim-safe |
| `apps/server-pilot/scripts/run-centurion-draft-backtest.ts` | EC2 CLI entry (read-only RDS; concurrency=1) |
| `apps/server-pilot/tests/draft-bracket.test.ts` | Bracket + no-hallucination unit tests |
| `apps/server-pilot/tests/draft-backtest-scorer.test.ts` | Scorer + invented-fact fixtures (synthetic, no PII) |
| `apps/server-pilot/tests/production-boundary*.ts` / existing | Ensure agent graph still no-send/no-write |
| `docs/superpowers/plans/handoff-reports/2026-08-07-mastra-draft-backtest.md` | Morning handoff |

---

## Priority waves (clock-aware)

| Wave | Must before | Intent |
|------|-------------|--------|
| **W0** Safety harness | 02:30 | Bracket + no-send/no-write gates + fixture scorer |
| **W1** Agent tool expand | 04:00 | Wire active read tools into claim-safe draft |
| **W2** Corpus backtest CLI | 06:00 | EC2 read-only run vs Centurion outbound |
| **W3** Improvement loops | 07:15 | RCA → fix → rescore |
| **W4** Handoff freeze | 08:00 | Workable stop |

If behind clock: skip W3 breadth; keep W0–W2 depth.

---

## Task 0: Clock + safety freeze

**Steps:**

- [ ] Record start: `TZ=Europe/London date` into `.superpowers/sdd/draft-backtest-progress.md` (gitignored OK)
- [ ] Confirm `production-boundary` still blocks SMTP/MCP/write-lab for AI draft modules
- [ ] Confirm EC2 folio gen includes `deposit_ledger_summary`; note blocked tools (company/group/event/tax)
- [ ] Decision (locked): **extend claim-safe agent**, do not ship freeform inventing Agent

---

## Task 1: Bracket policy + tests (TDD)

**Files:** `draft-evidence.ts` (inline `formatMissingBracket`), `tests/draft-bracket.test.ts`

**Steps:**

- [ ] Write failing tests: missing confirmation → `[MISSING: confirmation number | how: hms_find_reservation]`; write-only surface → `[MISSING: … | how: hotel grant / PMS write not allowed]`; blocked company trio → named blocker code in bracket
- [ ] Implement `formatMissingBracket({ need, acquisition })` + assert renderer never leaves bare invented literals for claim kinds without evidence
- [ ] `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS && pnpm exec vitest run tests/draft-bracket.test.ts`
- [ ] Commit: `feat(ai): add draft missing-detail bracket policy`

---

## Task 2: Expand claim-safe tools to Phase B actives (TDD)

**Files:** `candidate-draft-agent.ts`, claim mappers, `candidate-read-plan.ts` as needed, production-boundary tests

**Steps:**

- [ ] RED: tests that folio / sent-email / list-documents tool IDs are admissible when registry-active and still `effect:'read'`
- [ ] Wire `createTool` wrappers only for allowlisted tool IDs; `beforeToolCall`/session refuse anything else
- [ ] Keep opaque candidate IDs — model never receives raw guest strings as tool args
- [ ] Cap tool budget (raise modestly if needed; document)
- [ ] Vitest green + production-boundary still passes
- [ ] Commit: `feat(ai): wire Phase B read tools into claim-safe draft agent`

---

## Task 3: (skipped — ponytail) Mastra Workflow file

Overnight uses existing Mastra `createTool` claim-safe agent. No new workflow registration.

---

## Task 4: Corpus + JSONL store inside `draft-backtest.ts` (TDD)

**Steps:**

- [ ] Gold pairing: `transport-centurion` inbound → same `thread_id` → earliest later Centurion `direction=outbound`; else `NO_GOLD_REPLY` / `FORWARD_OR_EXTERNAL`
- [ ] Synthetic pairing fixtures (no live PII)
- [ ] JSONL under `DRAFT_BACKTEST_ROOT` / `{runId}/results.jsonl` keyed by `messageIdHash`; resume skips scored hashes
- [ ] Commit: `feat(ai): add draft backtest corpus contracts and eval store`

---

## Task 5: Scorer (TDD)

**Hard classes:** `INVENTED_FACT`, `MISSING_BRACKET`, `NO_GOLD_REPLY`. Soft bucket: underuse / blocked-correct / forward / format.

- [ ] Invented-fact detector: critical tokens from claims/evidence vs draft body; token ∉ evidence∪brackets → `INVENTED_FACT`
- [ ] Commit: `feat(ai): add centurion draft backtest scorer`

---

## Task 6: EC2 backtest CLI (purpose-built, not Vitest)

**Files:** `scripts/run-centurion-draft-backtest.ts`, `src/ai/draft-backtest.ts`

**Steps:**

- [ ] Flags: `--limit` (first smoke 25), `--run-id`, `--offline-fixtures`
- [ ] concurrency=1; 90s/thread abort → error class; resume skip
- [ ] `source .env.production` **only inside script subprocess**; parent Vitest shells always unset
- [ ] Preflight refuse if mutating SQL/SMTP/send/promote patterns present
- [ ] Deploy + run; aggregates only in handoff
- [ ] Commit: `feat(ai): add centurion draft backtest EC2 runner`

---

## Task 7: Improvement loop (`/loop`)

**Steps (repeat until 07:15 UK):**

- [ ] Clock check
- [ ] Open top failures from scorecard
- [ ] RCA → minimal fix → Vitest → partial rescore → optional full rescore
- [ ] Commit each fix: `fix(ai): <symptom> for draft backtest`
- [ ] Stop new loops at 07:15

---

## Task 8: Handoff freeze (≤08:00)

**Files:** `docs/superpowers/plans/handoff-reports/2026-08-07-mastra-draft-backtest.md`

Must include:

- UK clock start/stop
- Commits + EC2 HEAD
- Corpus size attempted vs scored
- Aggregate scorecard (no PII)
- Top failure classes + fixes applied
- Remaining gaps for morning steer
- Explicit: **workable stop, not claiming finished product agent**

- [ ] Push `EC2-pilot` (no force)
- [ ] Commit handoff

---

## True blockers (stop tool/surface, not whole overnight)

- HMS/AWS/Bedrock/VPN outage
- Observed non-view-only role or mutating tool exposure
- Pilot Vitest safety conflict
- Corpus inaccessible (credentials) — fall back to fixture offline mode + document
- 08:00 hard stop

Not blockers: empty product `promotionEvidence.live` in source (use EC2 active registry for live tools); blocked company/group/event/tax (bracket); incomplete improvement loops at deadline.

## NOT in scope

- Autonomous email send or draft promote-to-send
- PMS writes / Phase C write portfolio
- Replacing triage
- MCP server for HMS
- Claiming portfolio ΔFull / Phase C expansion

## Plan review checklist (must complete before `/nava-run`)

- [x] `gstack-plan-eng-review` — APPROVE_WITH_NOTES; folded
- [x] `ponytail-review` — CUT_COUNT=12; folded
- [x] Autonomy mandate + 08:00 stop + `/continue-autonomously` present (this file)
- [x] Pilot-RDS + no-send + no-HMS-write explicit

---

## Autonomous decision log (planning)

| Decision | Choice | Why |
|----------|--------|-----|
| Agent style | Extend claim-safe Mastra tools; skip new Workflow file | User wants Mastra; ponytail cuts speculative Workflow |
| Tool set | EC2 registry actives only | Proven reads; blocked surfaces bracketed |
| Storage | Private eval root JSONL | Overnight only; no product draft pollution |
| RDS access | Purpose-built read script | Satisfies backtest without Vitest-on-pilot |
| Deadline | 08:00 UK hard stop workable | User morning steer |
| First EC2 run | `--limit 25` then expand | Eng perf note |
