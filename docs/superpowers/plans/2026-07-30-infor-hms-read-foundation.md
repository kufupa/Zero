# Infor HMS Read Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: Use `overnight-autonomous-execution` and `superpowers:subagent-driven-development`. Execute task-by-task with a fresh implementer and separate reviewer. Steps use checkbox (`- [ ]`) syntax for tracking.

**Execution posture:** Overnight autonomous after explicit execution authorization; user unavailable; implement, test, review, fix, and resume until every done criterion is green or a true human-only blocker remains.

**Goal:** Ship a fail-closed, read-only HMS evidence path that can enrich hotel email candidates with reservation, rate/inventory, and embedded attachment facts without mutating live Infor HMS.

**Architecture:** Reuse Zero's existing AI run ledger, Mastra integration, draft lifecycle, mail search, attachment storage, and review UI. Add a dedicated HMS execution lane that owns one Playwright browser, accepts only server-derived lookup candidates, and converts typed read results into typed claims. The model selects tools, claims, and approved copy templates; deterministic code renders all text and HTML, then persistence and send paths recheck thread state and evidence freshness.

**Tech Stack:** TypeScript, Node.js, Drizzle/PostgreSQL, Mastra 1.50, Zod, Playwright Core pinned to deployed Chromium, AWS Secrets Manager, Bedrock, S3, Vitest, Playwright Test, Poppler `pdfinfo`/`pdftotext`, `bubblewrap`, `prlimit`.

## Global Constraints

- Work on current `EC2-pilot` branch/worktree. Do not create another worktree.
- Autonomous live HMS activity is read-only. Never submit, save, create, amend, cancel, assign, post, settle, refund, send, print, export, or open write-form screens.
- Current audited write-capable account may access only exact documentation-backed read screens with reviewed request templates. Any mixed or uncertain screen requires a view-only account or later human-supervised plan.
- CRS `Check Availability` is forbidden because Infor documents reservation creation.
- Unknown origin, path, method, query value, body value, redirect, popup, download, WebSocket, service worker, or request shape aborts before intentional continuation.
- Total HMS candidate execution budget is 150 seconds from first claim across every retry/reclaim. Queue time before first claim does not consume it.
- One retry maximum, and only while enough absolute budget remains for cleanup.
- One HMS worker process owns Chromium and serializes HMS browser sessions. Existing triage/feedback worker remains independent.
- Production tool registry contains read effects only.
- Model never receives arbitrary URL, selector, guest name search, attachment key, property, transport, or form-submit capability.
- Reservation searches use server-derived opaque candidates scoped to current transport/thread.
- `hms_quote_stay` never claims bookability. Partial, ambiguous, stale, unresolved, or `draftReady: false` results cannot support a candidate.
- No full attachment text persists. Persist hash-bound evidence metadata only.
- Embedded text extraction supports `text/plain` and PDF text. Scanned/image/encrypted/malformed PDFs return `manual_required`. OCR and document vision remain deferred.
- No auto-send. Promotion and send revalidate server-side.
- HMS mode `off` preserves current skeleton candidate behavior and existing thread-staleness checks.
- HMS mode `shadow` executes and scores but creates no visible candidate.
- HMS mode `enabled` may create a candidate only after all evidence gates pass.
- No MCP server, generic browser tool, artifact cache table, new search engine, or generic operation framework.
- No fixture write adapters in this plan. Write work starts in a separate child plan after read contracts are observed.
- Later write-capable Playwright functions may be production-real code, but may execute only against literal-loopback synthetic fixtures until a separate human-supervised live-validation plan. Live PMS research remains read-only even while those functions are being built.
- Never log credentials, cookies, raw guest data, raw attachment text, or unredacted request values.
- Commits occur only if user explicitly authorizes them.

## Overnight Autonomous Execution Mandate

**User granted full autonomy after they explicitly invoke execution of this plan.** No blocking questions overnight. No manual login. No "which approach?" pause. This edit is plan-only and does not start implementation.

### Communication and model selection

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**
- **Model override (2026-07-30 overnight):** use Cursor **auto** for every subagent dispatch. Do not hard-block on named Grok/Composer availability. Prefer non-fast when auto offers a choice; never force GPT-5.6 Sol Max for routine implementation.
- Prefer **Composer 2** / **Grok 4.5** normal when auto selects them. Fast variants acceptable only when auto has no other option.
- Keep orchestration messages short. Durable task briefs, reports, review packages, and progress ledger carry detail.

### AWS / infra (use freely after execution authorization)

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

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds, pilot/production-RDS Vitest, `VITEST_ALLOW_PILOT_RDS=1`, or sourcing `.env.production` into tests.

Deploy and live-read canary work begins only in Task 9 after Tasks 0–8 and their task reviews are green. No deployment step authorizes a live HMS mutation.

Task 9 overnight wave:

```text
local tests/builds green
  -> exact task commits
  -> non-force push EC2-pilot
  -> apps/server-pilot/deploy/ops-deploy.sh --migrate
  -> SSM gate scripts
  -> shadow metrics + approved live read canary
  -> final review
  -> handoff report under docs/superpowers/plans/handoff-reports/
```

Use `ssm-run-command.sh` for remote commands because Windows AWS CLI output can break on Vitest Unicode. Follow `docs/solutions/workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md`.

### Live HMS and future write-function boundary

The following rules bind the orchestrator, implementers, researchers, reviewers, scripts, tests, and any future write-adapter child plan:

1. Live Infor HMS is always read-only during autonomous development. An audited write-capable credential does not grant write authority.
2. Current foundation tasks must not add write adapters. Later write-capable functions may contain real request construction and deterministic submit logic, but they run only against literal-loopback synthetic fixtures.
3. Production HMS origin, cookies, and credentials are forbidden inputs to any write-function test harness. A production-boundary test must prove such execution aborts before transmission.
4. Never open a live write-form screen, type into a live form, trigger input/change/blur, click submit/save/confirm, or call a mutation request while inferring a write workflow.
5. Live observation may use only reviewed read screens and canonical read requests. Documentation plus synthetic fixtures supply write-form contracts until the separate human-supervised validation plan.
6. Write-capable functions stay outside the Mastra tool registry and production dependency graph until one operation passes fixture replay, human review, supervised live validation, post-action reread, and audit checks.
7. Any uncertainty about whether an action can mutate is a hard deny. Abort, record a sanitized blocked signature, and continue with docs/fixture work.

### Research and expert escalation

- Search before guessing. For Infor behavior, use `user-exa-agent.agent_run` in automatic effort mode with a precise research prompt; escalate effort for conflicting/ambiguous docs. Treat official Infor documentation as primary evidence and record URL, product version, capability, and unresolved tenant assumptions.
- For Playwright, Mastra, AWS, Drizzle/PostgreSQL, Poppler, or browser-security behavior, search current official documentation and existing repository patterns before introducing custom machinery.
- A read-only research/expert subagent may run in parallel with the active implementer only when it cannot edit the worktree, access live PMS, receive secrets, or touch raw guest/mail data.
- If implementation becomes unfamiliar or fails twice for the same mechanism, dispatch a fresh domain expert/investigator with the failing command, sanitized evidence, exact file scope, and requirement. Expert returns root cause and options; implementer owns the fix.
- Use relevant skills when they match the task: `test-driven-development` during implementation, `systematic-debugging` on red, Exa research for current docs, `requesting-code-review` for the final branch review, and `verification-before-completion` before any success claim.

### RCA loop (mandatory on any red)

```text
FAIL
  -> reproduce minimally
  -> identify root cause (file:line + mechanism)
  -> search official docs / Exa when behavior is uncertain
  -> consult fresh expert agent when needed
  -> choose smallest correct fix
  -> run focused test, then affected suite
  -> commit exact task files
  -> resume next plan step
```

Do not stop at first failure, patch symptoms, remove assertions, skip tests, weaken the request policy, widen selectors, or mark a required gate skipped. Reach at least 95% confidence in the failure mechanism before moving on.

### Divergence authority

- Better path to done criteria: take it, then record what changed and why in the task report and final handoff.
- Global constraints and live-HMS safety override example code and task prose.
- Correctness evidence may replace illustrative snippets, but not product behavior, safety gates, fixed budgets, or test intent.
- If a contradiction could enable PMS mutation, expose secrets, destroy data, or require unavailable human authorization, stop. These are valid human-only blockers.
- Missing convenience, flaky tooling, unfamiliar APIs, or a failed first approach are not blockers; use RCA, research, expert escalation, and continue.

### Done criteria

- [x] Tasks 0–9 each have an implementer report, clean spec/quality review, focused tests, and task-scoped commit range.
- [x] Every command in Final Verification passes with zero required-test skips. *(fixture/security/shadow gates; live not-found canary separate dual-gate probe)*
- [x] Request-policy, production-boundary, and fixture tests prove no live mutation path can transmit.
- [x] Shadow evaluation uses frozen denominators and meets the plan's factual/readiness gates.
- [x] Any live HMS action performed during rollout is an approved read canary, against the bound property, after fixture/security gates pass. *(login + HRCEN title + Guest Stay OSRESS.search not-found)*
- [x] No credentials, cookies, raw guest data, raw attachment text, or unredacted request values appear in logs, reports, commits, or subagent prompts.
- [x] Final whole-branch review has no open Critical or Important findings.
- [x] Final handoff records commits, tests, deployment/canary evidence, divergences, remaining deferred work, and any true blocker.

## Execution Mode

Dormant until the user explicitly invokes `superpowers:subagent-driven-development` for this plan. That invocation authorizes autonomous task implementation, task-scoped commits, and non-force push of the current `EC2-pilot` branch when needed for the planned EC2 deploy; it never authorizes merge, main/master push, force-push, PR mutation, or live HMS write. Once invoked, do not ask "should I continue?"; continue until done criteria are green or a valid human-only blocker is documented.

## Subagent-Driven Execution Protocol

### Orchestrator owns

- Read this plan once, run the pre-flight contradiction scan, create todos, and check `.superpowers/sdd/progress.md` before dispatching anything.
- Resolve non-safety pre-flight conflicts autonomously using this precedence: Global Constraints -> Done criteria -> task Interfaces/behavior -> illustrative snippets. Log the resolution. Ask only when every safe option requires human authorization or could mutate HMS/expose secrets/destroy data.
- Preserve task order, global constraints, safety decisions, exact task file scopes, and the durable progress ledger.
- Extract each task with the `subagent-driven-development` `scripts/task-brief` helper. Never make a fresh subagent read this whole plan or chat history.
- Record base commit before each task; generate `scripts/review-package BASE HEAD` after implementation; pass brief, report, and review package paths to the reviewer.
- Resolve reviewer `Cannot verify from diff` items using cross-task context. Never mark a task complete while Critical/Important findings remain.
- Own all EC2 deploy commands and every live HMS interaction. Generic implementer, research, fix, and reviewer agents never receive live credentials or directly navigate production HMS.
- Stage only task-owned files. Never include unrelated pre-existing worktree changes in task commits.

### Per-task loop

```text
orchestrator creates task brief + records BASE
  -> fresh implementer follows TDD, tests, self-reviews, commits, writes report
  -> orchestrator creates BASE..HEAD review package
  -> fresh reviewer checks spec compliance + code quality
       -> Critical/Important: resume task implementer or dispatch scoped fixer
       -> rerun covering tests and append fix evidence
       -> fresh re-review until clean
  -> append "Task N: complete (commits BASE..HEAD, review clean)" to ledger
  -> next task
```

One implementation subagent at a time in the shared worktree. Parallelism is allowed only for read-only research agents with no shared mutable state. After Task 9, run one broad whole-branch review; if it finds issues, send the complete list to one fixer, verify, and re-review.

Tasks 5 and 9 have orchestrator-only post-review gates. Do not write their completion ledger entries immediately after code review: Task 5 also needs guarded live read discovery; Task 9 also needs deploy, shadow, and live read canary evidence. Any defect found there reopens the task's fix/test/re-review loop.

### Task routing

| Task | Explicit model | Implementer/expert profile | Subagent allowed work | Orchestrator-only work |
|---|---|---|---|---|
| 0 | auto | Infor/corpus research specialist | Exa/official-doc research, denominator tests, capability matrix | Approve active discovery surfaces; no live PMS |
| 1 | auto | PostgreSQL/worker-concurrency expert | Schema, claim fencing, deadlines, heartbeat, tests | Reconcile migration/deploy ordering |
| 2 | auto | Mail-context/evidence-contract expert | Context builder, typed evidence, deterministic rendering, tests | Resolve cross-task contract conflicts |
| 3 | auto | Linux sandbox/document-security expert | Bounded S3 stream, `pdfinfo`/`pdftotext`, sandbox, tests | No production attachment inspection by subagent |
| 4 | auto | Playwright network-policy/security expert | Canonical request policy and escape-path fixture tests | Approve exact production read policy |
| 5 | auto | Playwright/AWS runtime expert | Runtime, secret-loader interface, fixture discovery, abort tests | Secret import, EC2 execution, and any live read discovery |
| 6 | auto | Infor read-adapter expert | Reservation/quote adapters against sanitized fixtures and approved manifest | Any live comparison/read sampling |
| 7 | auto | Mastra/LLM evidence expert | Typed tool orchestration, template selection, deterministic candidate path | Approve factual-evidence boundary |
| 8 | auto | Draft-lifecycle/UI integration expert | Refresh, stale-state, promotion/send guards, UI tests | Reconcile backend/frontend rollout state |
| 9 | auto | E2E/eval/release expert | Loopback E2E, fixed-denominator eval, gate scripts, fixture verification | EC2 deploy, RDS migration, shadow rollout, live read canary |

Every task gets a separate fresh reviewer on auto. Prefer stronger auto picks for Tasks 1, 3, 4, 5, 8, 9 and final whole-branch review when available.

### Where subagents must not be used

- No generic browser-use subagent against live HMS.
- No parallel implementer subagents in this worktree.
- No subagent gets `.env.hms.local`, secret values, cookies, raw RDS guest rows, raw message dumps, or live attachment contents.
- No reviewer edits implementation. Findings return through the fix/re-review loop.
- No research agent turns documentation into an approved production request manifest without orchestrator review.
- No task agent deploys, migrates production, restarts PM2, runs the live canary, pushes, merges, or promotes modes.
- No subagent invents or tests a live write workflow. Future write code remains fixture-only under the boundary above.

---

## Scope and Product Position

This plan is next executable lake from `2026-07-29-infor-hms-full-tool-portfolio-roadmap.md`. It covers:

1. Core run ownership, absolute deadline, evidence, and freshness contracts.
2. Required Wave 0 thread context and native attachment evidence.
3. Wave 1A read-only HMS runtime, discovery, reservation lookup, and stay-option reads.
4. Candidate integration, review UI, fixture E2E, shadow evaluation, and rollout.

It intentionally ends before:

- Wave 1B communication/configuration reads.
- Finance/document reads.
- Group/event/operations reads.
- Fixture write adapters.
- Any live write validation.

## Data Flow

```text
Inbound message
      |
      v
Existing triage worker
      |
      | enqueues executor_lane=hms when mailbox binding + mode allow
      v
AI run ledger
  - claim token
  - immutable deadline_at
  - heartbeat
  - thread state version
      |
      v
HMS AI worker (single browser owner)
      |
      +--> Deterministic thread context
      |      - trigger/latest first
      |      - quoted text collapsed
      |      - related messages bounded
      |      - opaque lookup candidates
      |
      +--> mail_read_artifact
      |      - authorized attachment ID
      |      - text/plain or pdftotext
      |      - no OCR, no text persistence
      |
      +--> Playwright read session
             - exact property binding
             - canonical request templates
             - service workers blocked
             - unknown request aborts
             - hms_find_reservation
             - hms_quote_stay
      |
      v
Typed evidence claims
      |
      v
Mastra draft plan
  - selected claim IDs only
  - approved salutation/opening/closing template IDs
  - no raw authoritative values
      |
      v
Deterministic text + HTML renderer
      |
      +--> shadow: metrics only
      |
      +--> enabled: atomic generation + candidate
                          |
                          v
                 Existing review UI
                          |
              Refresh / promote / send
                          |
                          v
        Recheck claim fence, thread state, TTL
```

## What Already Exists

- `apps/server-pilot/src/ai/run-ledger.ts`: queue, idempotency, skip-locked claim, retry, terminal states. Extend; do not replace.
- `apps/server-pilot/src/ai/worker.ts`: one entrypoint for triage, candidates, and feedback. Parameterize by execution lane; do not create a second worker implementation.
- `apps/server-pilot/src/ai/workflows/candidate-draft.ts`: current skeleton flow. Preserve for HMS mode `off`; add enriched path beside it.
- `apps/server-pilot/src/ai/drafts.ts`: candidate persistence and revisions. Reuse transaction path.
- `apps/server-pilot/src/mail/search/*`: transport-scoped FTS and structured conditions. Reuse for bounded related-message lookup.
- `apps/server-pilot/src/mail/collapse-quoted-html.ts` and `sanitize-email-html.ts`: reuse for context normalization.
- `apps/server-pilot/src/storage/s3.ts`: authorized S3 abstraction. Reuse; model never receives S3 keys.
- `apps/server-pilot/src/trpc/routes/drafts.ts` and `mail.ts`: promotion/send boundaries. Extend with HMS evidence checks.
- `apps/mail/lib/mail/thread-draft-view-model.ts`: existing draft view model. Extend; do not add parallel candidate card model.
- `apps/mail/components/mail/thread-draft-card.tsx`: existing draft card. Add states/actions rather than a second card component.
- `packages/testing/playwright.config.ts`: general browser tests. Keep unchanged; add HMS-only loopback config.

## File Structure

### Create

- `docs/infor-hms/capability-matrix.md` — docs/corpus-backed active and deferred capability evidence.
- `apps/server-pilot/drizzle/0015_hms_read_foundation.sql` — lane, claim-fence, deadline, evidence, and thread-state columns.
- `apps/server-pilot/src/ai/thread-context.ts` — bounded thread context, related-message lookup, high-water version, opaque lookup candidates.
- `apps/server-pilot/src/ai/draft-evidence.ts` — evidence unions, typed claims, readiness/freshness validation, deterministic renderer.
- `apps/server-pilot/src/ai/candidate-draft-agent.ts` — Mastra read tools and structured draft-plan generation.
- `apps/server-pilot/src/hms/contracts.ts` — manifest, request template, tool input/output schemas.
- `apps/server-pilot/src/hms/request-policy.ts` — canonical request parsing and fail-closed routing.
- `apps/server-pilot/src/hms/runtime.ts` — browser lifecycle, secret loading, property binding, session semaphore, canary/circuit.
- `apps/server-pilot/src/hms/adapter.ts` — reservation and stay-option reads only.
- `apps/server-pilot/src/hms/centurion.manifest.json` — generated/reviewed exact read manifest.
- `apps/server-pilot/src/mail/artifacts/read-artifact.ts` — authorized bounded text/PDF extraction.
- `apps/server-pilot/scripts/hms-discover-read.ts` — builder-only abort-first read discovery.
- `apps/server-pilot/deploy/import-hms-secret.sh` — non-printing local secret import.
- `apps/server-pilot/deploy/hms-read-gate.sh` — EC2 dependency, fixture, canary, and shadow gate.
- `apps/server-pilot/tests/helpers/hms-fixture-server.ts` — single source of synthetic HMS HTML/state/request fixtures.
- `apps/server-pilot/tests/hms-contracts.test.ts`
- `apps/server-pilot/tests/hms-request-policy.test.ts`
- `apps/server-pilot/tests/hms-runtime.test.ts`
- `apps/server-pilot/tests/hms-discovery.test.ts`
- `apps/server-pilot/tests/hms-adapter.test.ts`
- `apps/server-pilot/tests/hms-thread-context.test.ts`
- `apps/server-pilot/tests/hms-artifact.test.ts`
- `apps/server-pilot/tests/hms-candidate-agent.test.ts`
- `apps/server-pilot/tests/hms-candidate-state.test.ts`
- `apps/server-pilot/tests/hms-production-boundary.test.ts`
- `apps/server-pilot/evals/hms/denominators.v1.json` — immutable 56/61/68/97/116 membership manifests and rules.
- `packages/testing/playwright.hms-fixture.config.ts` — self-contained literal-loopback fixture E2E.
- `packages/testing/e2e/hms-draft-pipeline.spec.ts`

### Modify

- `apps/server-pilot/src/db/schema/mail.ts`
- `apps/server-pilot/src/env.ts`
- `apps/server-pilot/src/ai/run-ledger.ts`
- `apps/server-pilot/src/ai/worker.ts`
- `apps/server-pilot/src/ai/workflows/candidate-draft.ts`
- `apps/server-pilot/src/ai/eval-runner.ts`
- `apps/server-pilot/src/ai/drafts.ts`
- `apps/server-pilot/src/trpc/routes/drafts.ts`
- `apps/server-pilot/src/trpc/routes/mail.ts`
- `apps/server-pilot/src/trpc/routes/ai.ts`
- `apps/server-pilot/deploy/pm2.config.cjs`
- `apps/server-pilot/deploy/write-ec2-env.sh`
- `apps/server-pilot/package.json`
- `apps/server-pilot/tests/ai-workflow-run-contract.test.ts`
- `apps/server-pilot/tests/ai-worker-contract.test.ts`
- `apps/server-pilot/tests/ai-eval-runner.test.ts`
- `apps/server-pilot/tests/draft-ai-promotion-contract.test.ts`
- `apps/server-pilot/tests/draft-stale-conflict.test.ts`
- `apps/mail/lib/mail/thread-draft-view-model.ts`
- `apps/mail/components/mail/thread-draft-card.tsx`
- `apps/mail/components/mail/thread-display.tsx`
- `apps/mail/tests/thread-draft-view-model.test.ts`
- `apps/mail/tests/stale-draft-send-flow.test.ts`

### Reuse Unchanged

- `apps/server-pilot/src/mail/search/query.ts`
- `apps/server-pilot/src/mail/search/parse.ts`
- `apps/server-pilot/src/mail/collapse-quoted-html.ts`
- `apps/server-pilot/src/mail/sanitize-email-html.ts`
- `apps/server-pilot/src/storage/s3.ts`
- `apps/server-pilot/src/mail/send/validate-outbound.ts`

---

### Task 0: Lock evidence baseline and safe discovery scope

**Execution routing:** Fresh Infor/corpus research implementer + fresh reviewer. Implementer may use read-only Exa research agents and official docs; no agent accesses live HMS. Orchestrator approves active discovery surfaces before Task 5.

**Files:**
- Create: `apps/server-pilot/evals/hms/denominators.v1.json`
- Create: `docs/infor-hms/capability-matrix.md`
- Test: `apps/server-pilot/tests/hms-contracts.test.ts`

**Interfaces:**
- Consumes: corpus audits and official Infor links in portfolio roadmap.
- Produces: immutable eval membership, active read-surface list, and explicit discovery prohibitions.

- [ ] **Step 1: Write failing denominator and capability tests**

```typescript
import denominators from '../evals/hms/denominators.v1.json';

it('keeps coverage denominators disjointly named and immutable', () => {
  expect(denominators.version).toBe(1);
  expect(denominators.draftEligible.members).toHaveLength(56);
  expect(denominators.operationalPortfolio.members).toHaveLength(116);
  expect(new Set(denominators.draftEligible.members).size).toBe(56);
  expect(new Set(denominators.operationalPortfolio.members).size).toBe(116);
  expect(denominators.referenceCounts).toEqual({
    toolDependentHistorical: 61,
    historicalWorkflow: 68,
    replyWorthy: 97,
  });
});

it('permits only active read surfaces in autonomous discovery', () => {
  expect(activeDiscoveryCapabilities()).toEqual([
    'login',
    'reservation-search',
    'room-availability',
    'display-rates',
  ]);
  expect(activeDiscoveryCapabilities()).not.toContain('write-forms');
  expect(activeDiscoveryCapabilities()).not.toContain('crs-check-availability');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --dir apps/server-pilot exec vitest run tests/hms-contracts.test.ts
```

Expected: FAIL because denominator artifact and active capability contract do not exist.

- [ ] **Step 3: Create denominator manifest**

Use explicit thread IDs from completed corpus audit. Schema:

```json
{
  "version": 1,
  "sourceWindow": {
    "from": "2026-07-27T00:00:00+02:00",
    "to": "2026-07-29T23:59:59+02:00"
  },
  "draftEligible": {
    "rule": "52 human reply/action threads plus internally routed requests 19, 127, 129, 172",
    "members": [
      2, 4, 5, 6, 10, 13, 15, 17, 18, 19, 20, 22, 26, 27, 28, 29,
      31, 45, 46, 47, 71, 72, 74, 76, 83, 85, 86, 87, 88, 92, 97, 98,
      101, 102, 103, 105, 107, 108, 109, 112, 115, 116, 119, 120, 124,
      127, 129, 132, 136, 152, 159, 166, 172, 185, 187, 191
    ]
  },
  "operationalPortfolio": {
    "rule": "mutually exclusive operational workflow census",
    "members": [
      1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20,
      22, 23, 26, 27, 28, 29, 31, 32, 33, 34, 39, 43, 44, 45, 46, 47,
      58, 63, 64, 65, 67, 68, 70, 71, 72, 73, 74, 75, 76, 78, 79, 80,
      81, 83, 84, 85, 86, 87, 88, 91, 92, 94, 95, 97, 98, 99, 100,
      102, 103, 104, 105, 106, 107, 108, 109, 112, 113, 114, 115, 116,
      117, 119, 120, 122, 124, 125, 130, 132, 137, 138, 139, 147, 150,
      152, 154, 156, 158, 159, 162, 163, 164, 165, 166, 168, 171, 172,
      173, 175, 176, 177, 182, 183, 185, 186, 187, 189, 191, 192, 193
    ]
  },
  "referenceCounts": {
    "toolDependentHistorical": 61,
    "historicalWorkflow": 68,
    "replyWorthy": 97
  }
}
```

These arrays come from completed privacy-safe corpus audits. Reference-only counts are not executable denominator memberships until a later reconciliation artifact supplies exact thread IDs.

- [ ] **Step 4: Update capability matrix**

Each row must contain:

```typescript
type CapabilityRow = {
  id: string;
  officialDocs: string[];
  corpusThreadIds: number[];
  phase: 'active_read' | 'roadmap_read' | 'future_write';
  credentialRequirement: 'documented_read_screen' | 'view_only' | 'human_supervised';
  autonomousAllowed: boolean;
  mutationRisk: string;
  evidenceNeeded: string[];
};
```

Only login, reservation search, Room Availability, and Display Rates are `active_read`.

- [ ] **Step 5: Run tests**

Expected: PASS with exact counts and no write surface in active discovery.

- [ ] **Step 6: Commit if explicitly authorized**

```bash
git add apps/server-pilot/evals/hms/denominators.v1.json docs/infor-hms/capability-matrix.md apps/server-pilot/tests/hms-contracts.test.ts
git commit -m "test: lock HMS evidence baseline"
```

---

### Task 1: Add execution lanes, immutable budget, and claim fencing

**Execution routing:** Fresh PostgreSQL/worker-concurrency expert + fresh concurrency reviewer. No HMS, browser, AWS, or deployment access. Orchestrator owns migration sequencing and rejects any deadline/lease shortcut.

**Files:**
- Create: `apps/server-pilot/drizzle/0015_hms_read_foundation.sql`
- Modify: `apps/server-pilot/src/db/schema/mail.ts`
- Modify: `apps/server-pilot/src/env.ts`
- Modify: `apps/server-pilot/src/ai/run-ledger.ts`
- Modify: `apps/server-pilot/src/ai/worker.ts`
- Modify: `apps/server-pilot/deploy/pm2.config.cjs`
- Test: `apps/server-pilot/tests/ai-workflow-run-contract.test.ts`
- Test: `apps/server-pilot/tests/ai-worker-contract.test.ts`

**Interfaces:**
- Produces:

```typescript
type AiExecutorLane = 'default' | 'hms';
type AiRunFence = {
  runId: string;
  claimOwner: string;
  claimToken: string;
  deadlineAt: Date;
};

type AiFailureClass =
  | 'RUN_DEADLINE'
  | 'LEASE_LOST'
  | 'POLICY_BLOCK'
  | 'AUTH'
  | 'PROPERTY_MISMATCH'
  | 'SCHEMA_DRIFT'
  | 'TRANSIENT_NETWORK'
  | 'BEDROCK_TRANSIENT'
  | 'ARTIFACT_TRANSIENT'
  | 'UNKNOWN';

function claimNextAiRun(input: {
  ownerId: string;
  lane: AiExecutorLane;
  now?: Date;
  db?: DB;
}): Promise<AiWorkflowRun | null>;

function heartbeatAiRun(fence: AiRunFence, db?: DB): Promise<boolean>;
function remainingRunBudgetMs(fence: AiRunFence, now?: Date): number;
```

- [ ] **Step 1: Add failing ledger tests**

Cover:

```typescript
it('claims only requested executor lane');
it('sets deadline once and preserves it across retry and stale reclaim');
it('rejects heartbeat and final commit from stale claim token');
it('does not retry when less than cleanup reserve remains');
it('keeps default worker progressing while HMS run is stalled');
```

Use fake clock. Assert first HMS claim sets `deadlineAt = firstClaimAt + 150_000`; second claim returns same timestamp.

- [ ] **Step 2: Run focused tests**

Expected: FAIL on missing lane/token/deadline fields.

- [ ] **Step 3: Add schema and migration**

```sql
CREATE TYPE "ai_executor_lane" AS ENUM ('default', 'hms');
ALTER TABLE "ai_workflow_run"
  ADD COLUMN "executor_lane" "ai_executor_lane" NOT NULL DEFAULT 'default',
  ADD COLUMN "claim_token" text,
  ADD COLUMN "heartbeat_at" timestamp,
  ADD COLUMN "deadline_at" timestamp,
  ADD COLUMN "failure_class" text;
CREATE INDEX "ai_workflow_run_lane_claim_idx"
  ON "ai_workflow_run" ("executor_lane", "state", "next_run_at", "created_at");

ALTER TABLE "ai_draft_generation"
  ADD COLUMN "outcome" text,
  ADD COLUMN "thread_state_version" text,
  ADD COLUMN "evidence" jsonb NOT NULL DEFAULT '[]'::jsonb;
```

- [ ] **Step 4: Implement lane-scoped claim**

Claim transaction must:

1. Filter `executorLane`.
2. Generate new `claimToken`.
3. Set `deadlineAt` only when null.
4. Refuse expired rows and dead-letter them as `RUN_DEADLINE`.
5. Fence every heartbeat/retry/success transaction by run ID, owner, token, and expected state.

Only `TRANSIENT_NETWORK`, `BEDROCK_TRANSIENT`, and `ARTIFACT_TRANSIENT` may retry once. Policy, auth, property, schema, lease, deadline, and unknown failures are terminal for the run.

```typescript
const deadlineAt =
  candidate.deadlineAt ?? new Date(now.getTime() + env.HMS_RUN_DEADLINE_MS);
const claimToken = randomUUID();
```

- [ ] **Step 5: Parameterize existing worker entrypoint**

```typescript
const lane = env.AI_WORKER_LANE;
const owner = `${lane}-ai-worker-${process.pid}`;
const claimed = await claimNextAiRun({ ownerId: owner, lane });
```

Default process claims `default`; HMS process claims `hms`. Only HMS process initializes HMS runtime.

- [ ] **Step 6: Add PM2 process without new worker implementation**

Add second PM2 entry using same `dist/ai/worker.js`:

```javascript
{
  name: 'hms-ai-worker',
  script: 'dist/ai/worker.js',
  instances: 1,
  exec_mode: 'fork',
  env: {
    NODE_ENV: 'production',
    AI_WORKER_LANE: 'hms',
    HMS_DRAFT_ENRICHMENT_MODE: process.env.HMS_DRAFT_ENRICHMENT_MODE ?? 'off',
  },
}
```

Existing process sets `AI_WORKER_LANE: 'default'`.

- [ ] **Step 7: Implement one absolute AbortSignal**

```typescript
const remaining = remainingRunBudgetMs(fence);
if (remaining <= 10_000) throw new RunDeadlineError();
const budgetSignal = AbortSignal.timeout(remaining);
const signal = AbortSignal.any([budgetSignal, leaseAbort.signal, shutdownSignal]);
```

Pass this exact signal into Mastra, Playwright, S3, and subprocess calls.

- [ ] **Step 8: Run tests and build**

Expected: lane isolation, immutable deadline, stale-token fencing, heartbeat, and cleanup pass.

- [ ] **Step 9: Commit if authorized**

```bash
git add apps/server-pilot/drizzle/0015_hms_read_foundation.sql apps/server-pilot/src/db/schema/mail.ts apps/server-pilot/src/env.ts apps/server-pilot/src/ai/run-ledger.ts apps/server-pilot/src/ai/worker.ts apps/server-pilot/deploy/pm2.config.cjs apps/server-pilot/tests/ai-workflow-run-contract.test.ts apps/server-pilot/tests/ai-worker-contract.test.ts
git commit -m "feat: isolate HMS AI execution"
```

---

### Task 2: Build bounded thread context and typed evidence contracts

**Execution routing:** Fresh mail-context/evidence implementer + fresh reviewer. Use synthetic/redacted fixtures only; subagent receives no raw message dump or guest data. Orchestrator resolves interfaces consumed by Tasks 3, 6, and 7.

**Files:**
- Create: `apps/server-pilot/src/ai/thread-context.ts`
- Create: `apps/server-pilot/src/ai/draft-evidence.ts`
- Test: `apps/server-pilot/tests/hms-thread-context.test.ts`
- Test: `apps/server-pilot/tests/hms-candidate-agent.test.ts`

**Interfaces:**

```typescript
type LookupCandidate =
  | { id: string; kind: 'confirmation'; value: string }
  | { id: string; kind: 'external_reference'; value: string }
  | {
      id: string;
      kind: 'surname_dates';
      surname: string;
      arrivalDate: string;
      departureDate: string;
    };

type ThreadContext = {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  includedMessageIds: string[];
  threadStateVersion: string;
  normalizedText: string;
  lookupCandidates: LookupCandidate[];
  authorizedAttachmentIds: string[];
};

type HmsEvidenceRef = {
  kind: 'hms';
  id: string;
  toolId: string;
  toolVersion: string;
  propertyCode: string;
  observedAt: string;
  expiresAt: string;
  claimKeys: string[];
  sourceHash: string;
};

type MailEvidenceRef = {
  kind: 'mail_attachment';
  id: string;
  toolId: 'mail_read_artifact';
  toolVersion: string;
  attachmentId: string;
  observedAt: string;
  sourceHash: string;
  claimKeys: string[];
};

type ToolResult<T> = {
  status: 'ok' | 'partial' | 'not_found' | 'ambiguous' | 'manual_required';
  draftReady: boolean;
  data: T;
  unresolvedFields: string[];
  evidence: HmsEvidenceRef | MailEvidenceRef;
};
```

- [ ] **Step 1: Write failing context tests**

```typescript
it('always includes trigger and newest messages before older history');
it('measures UTF-8 bytes rather than string length');
it('collapses quoted replies and sanitizes HTML');
it('keeps all queries transport and thread scoped');
it('extracts only thread-present confirmation/external refs');
it('never exposes S3 keys or arbitrary surname search to model');
it('changes threadStateVersion after inbound, outbound, or sent revision');
```

- [ ] **Step 2: Implement context order**

Load trigger separately, load newest messages descending, dedupe trigger, then append older messages until 64 KiB using:

```typescript
const nextBytes = Buffer.byteLength(next.normalizedText, 'utf8');
```

Never truncate away trigger or latest inbound/outbound.

- [ ] **Step 3: Reuse existing search**

Related-message lookup is not a model tool. When exact reservation/external reference exists, call existing transport-scoped search primitives with max 20 and return only message IDs plus normalized excerpts.

- [ ] **Step 4: Build thread state version**

Hash ordered message IDs/directions/timestamps plus latest draft revision ID:

```typescript
const threadStateVersion = createHash('sha256')
  .update(JSON.stringify(versionParts))
  .digest('hex');
```

- [ ] **Step 5: Add discriminated evidence schemas**

HMS evidence requires property; attachment evidence requires attachment ID. Neither schema accepts raw body/text.

- [ ] **Step 6: Run tests**

Expected: newest-state preservation, scope, opaque candidates, and evidence unions pass.

- [ ] **Step 7: Commit if authorized**

```bash
git add apps/server-pilot/src/ai/thread-context.ts apps/server-pilot/src/ai/draft-evidence.ts apps/server-pilot/tests/hms-thread-context.test.ts apps/server-pilot/tests/hms-candidate-agent.test.ts
git commit -m "feat: add bounded draft evidence context"
```

---

### Task 3: Add authorized text and embedded-PDF artifact reads

**Execution routing:** Fresh Linux sandbox/document-security expert + fresh security-focused reviewer. Subagent implements and tests synthetic fixture artifacts only; orchestrator never forwards production attachment contents.

**Files:**
- Create: `apps/server-pilot/src/mail/artifacts/read-artifact.ts`
- Create: `apps/server-pilot/deploy/pdf-text-gate.sh`
- Test: `apps/server-pilot/tests/hms-artifact.test.ts`

**Interfaces:**

```typescript
type ArtifactReadResult = ToolResult<{
  mimeType: 'text/plain' | 'application/pdf';
  text: string | null;
  pageCount: number | null;
  reason:
    | 'text'
    | 'no_embedded_text'
    | 'encrypted'
    | 'malformed'
    | 'too_large'
    | 'too_many_pages'
    | 'timeout'
    | 'unsupported';
}>;

async function readAuthorizedArtifact(input: {
  attachmentId: string;
  authorizedAttachmentIds: ReadonlySet<string>;
  s3: S3Storage;
  signal: AbortSignal;
}): Promise<ArtifactReadResult>;
```

- [ ] **Step 1: Write failing tests**

Cover:

- Unauthorized attachment ID blocks before S3.
- `text/plain` reads directly with UTF-8 normalization.
- Embedded PDF text returns `status: ok`.
- Scanned/no-text, encrypted, malformed, unsupported return `manual_required`.
- 20 MiB input, 50 pages, 256 KiB output, and 10-second subprocess limits.
- Abort kills subprocess and deletes temp directory.
- Missing binaries fail startup gate.
- Result enters common tool ledger with hash-bound mail evidence.
- No OCR command appears.

- [ ] **Step 2: Implement bounded S3 read**

Use attachment DB row selected by current transport/thread. Compare declared and streamed bytes. Never accept model-provided key.

- [ ] **Step 3: Implement unprivileged parser**

Run `/usr/bin/pdfinfo` then `/usr/bin/pdftotext` through `bwrap` and `prlimit` with `signal`, `timeout`, and `maxBuffer`. Temp directory mode `0700`; input mode `0600`; cleanup in `finally`.

- [ ] **Step 4: Return common evidence envelope**

Hash source bytes; persist only evidence metadata later. Tool result text remains run-memory only.

- [ ] **Step 5: Run unit and EC2 dependency gates**

```bash
pnpm --dir apps/server-pilot exec vitest run tests/hms-artifact.test.ts
bash apps/server-pilot/deploy/pdf-text-gate.sh
```

Expected: all parser branches pass; OCR absent.

- [ ] **Step 6: Commit if authorized**

```bash
git add apps/server-pilot/src/mail/artifacts/read-artifact.ts apps/server-pilot/deploy/pdf-text-gate.sh apps/server-pilot/tests/hms-artifact.test.ts
git commit -m "feat: read bounded mail artifacts"
```

---

### Task 4: Implement canonical fail-closed HMS request policy

**Execution routing:** Fresh Playwright network-policy expert + fresh security-focused reviewer. Fixture requests only. Orchestrator approves every production read template; subagent cannot widen origins, values, methods, redirects, or escape paths from live observation.

**Files:**
- Create: `apps/server-pilot/src/hms/contracts.ts`
- Create: `apps/server-pilot/src/hms/request-policy.ts`
- Create: `apps/server-pilot/tests/hms-request-policy.test.ts`
- Test: `apps/server-pilot/tests/hms-contracts.test.ts`

**Interfaces:**

```typescript
const requestRuleSchema = z.object({
  id: z.string().min(1),
  origin: z.string().url(),
  method: z.enum(['GET', 'POST']),
  path: z.string().startsWith('/'),
  resourceTypes: z.array(z.string()).min(1),
  fixedQuery: z.record(z.union([z.string(), z.array(z.string())])).default({}),
  variableQuery: z.record(z.object({
    pattern: z.string(),
    maxLength: z.number().int().positive(),
  })).default({}),
  contentType: z.string().optional(),
  fixedBody: z.record(z.union([z.string(), z.array(z.string())])).default({}),
  variableBody: z.record(z.object({
    pattern: z.string(),
    maxLength: z.number().int().positive(),
  })).default({}),
  maxBodyBytes: z.number().int().positive().default(16_384),
  redirectPolicy: z.literal('same-reviewed-chain'),
}).strict();

type RequestDecision =
  | { action: 'allow'; ruleId: string }
  | { action: 'block'; code: string; redactedSignature: RedactedRequestSignature };
```

- [ ] **Step 1: Write failing request-policy matrix**

Assert block-before-continue for:

- Unknown origin/path/method/resource type.
- Extra, duplicate, missing, or changed fixed query/body values.
- Invalid variable value, malformed encoding, JSON, multipart, oversized body.
- `action=delete`, submit button values, changed tenant/property.
- Cross-origin and unreviewed same-origin redirects.
- WebSocket, popup, download, service worker, and `data:`/`blob:` escape.
- CRS `Check Availability`.

Assert allow only exact fixture signatures.

- [ ] **Step 2: Implement canonical parsing**

Parse query and form bodies into sorted multimaps. Reject duplicate keys unless rule explicitly expects an array. Compare fixed values exactly. Validate every variable value against anchored regex and max length. Never compare key sets alone.

- [ ] **Step 3: Install one context-wide route before page creation**

```typescript
const context = await browser.newContext({
  acceptDownloads: false,
  serviceWorkers: 'block',
});
await context.route('**/*', route => enforceRequestPolicy(route, manifest));
```

Context routing covers pages/popups. Any policy exception aborts route, records redacted signature, aborts run, and closes context.

- [ ] **Step 4: Add browser event guards**

Close unexpected popup; cancel download; reject WebSocket; verify each committed navigation URL remains in reviewed path set.

- [ ] **Step 5: Run tests**

Expected: altered values and escape paths never reach fixture request recorder.

- [ ] **Step 6: Commit if authorized**

```bash
git add apps/server-pilot/src/hms/contracts.ts apps/server-pilot/src/hms/request-policy.ts apps/server-pilot/tests/hms-request-policy.test.ts apps/server-pilot/tests/hms-contracts.test.ts
git commit -m "feat: enforce canonical HMS read requests"
```

---

### Task 5: Build browser runtime and abort-first read discovery

**Execution routing:** Fresh Playwright/AWS runtime expert + fresh security-focused reviewer for runtime and fixture discovery. Implementer must not import secrets, use production credentials, deploy, or run live discovery. After review is clean, orchestrator alone may import the secret and perform exact read-only discovery under the Task 4 policy.

**Files:**
- Create: `apps/server-pilot/src/hms/runtime.ts`
- Create: `apps/server-pilot/scripts/hms-discover-read.ts`
- Create: `apps/server-pilot/deploy/import-hms-secret.sh`
- Create: `apps/server-pilot/tests/helpers/hms-fixture-server.ts`
- Create: `apps/server-pilot/tests/hms-runtime.test.ts`
- Create: `apps/server-pilot/tests/hms-discovery.test.ts`
- Modify: `apps/server-pilot/src/env.ts`
- Modify: `apps/server-pilot/deploy/write-ec2-env.sh`

**Interfaces:**

```typescript
type HmsSecret = {
  loginUrl: string;
  username: string;
  password: string;
  expectedTenant: string;
  expectedPropertyCode: string;
  expectedPropertyName: string;
  mailboxTransportId: string;
  credentialMode: 'audited_write' | 'view_only';
};

type HmsRuntime = {
  start(signal: AbortSignal): Promise<void>;
  openReadSession(input: {
    transportId: string;
    signal: AbortSignal;
  }): Promise<HmsReadSession>;
  health(): HmsHealth;
  close(): Promise<void>;
};
```

- [ ] **Step 1: Write synthetic fixture server once**

Programmatic routes:

- login/property header
- reservation search/results/detail
- Room Availability
- Display Rates
- blocked mutation, redirect, popup, download, timeout, malformed DOM

Fixture server owns request recorder and authoritative before/after state. No duplicate static HTML fixtures.

- [ ] **Step 2: Write failing runtime tests**

Cover singleton start, one-session semaphore, wrong tenant/property, secret failure, Chromium failure, circuit open/recovery, abort closes context, timeout, unknown request, credential/transport mismatch, and graceful shutdown.

- [ ] **Step 3: Load secret once**

Use process-wide Secrets Manager client and exact configured ARN. Redact errors. Verify login URL origin equals manifest origin. Verify displayed tenant/property IDs, not loose substring only.

- [ ] **Step 4: Bind abort signal**

```typescript
const closeOnAbort = () => void context.close();
signal.addEventListener('abort', closeOnAbort, { once: true });
try {
  // session work
} finally {
  signal.removeEventListener('abort', closeOnAbort);
  await context.close();
}
```

Every locator/navigation uses remaining budget.

- [ ] **Step 5: Add runtime canary**

Startup canary must:

1. Login.
2. Verify tenant/property.
3. Execute one fixture/live reservation not-found read.
4. Execute one harmless Room Availability or Display Rates read only after manifest approval.
5. Close context.

Runtime remains unavailable if any step fails.

- [ ] **Step 6: Write discovery tests before script**

Assert blocked request atomically writes redacted signature and nonzero exit. Stale output is removed. No raw value/cookie/credential persists. Script has no write-form phase.

- [ ] **Step 7: Implement four discovery phases**

Allowed phase enum:

```typescript
z.enum(['login', 'reservation-search', 'room-availability', 'display-rates']);
```

Each command requires explicit manifest path, secret ARN, output path, and phase inputs. No silent defaults for origin/property.

- [ ] **Step 8: Import secret without printing**

`.env.hms.local` skeleton:

```dotenv
HMS_LOGIN_URL=
HMS_USERNAME=NAVAAI
HMS_PASSWORD=
HMS_EXPECTED_TENANT=HMS_LEGACY
HMS_EXPECTED_PROPERTY_CODE=
HMS_EXPECTED_PROPERTY_NAME=
HMS_MAILBOX_TRANSPORT_ID=
HMS_CREDENTIAL_MODE=audited_write
```

Script reads locally, validates non-empty values, calls Secrets Manager, then unsets variables. File stays gitignored.

- [ ] **Step 9: Run fixture tests**

Expected: PASS with no external origin and no mutation.

- [ ] **Step 10: Commit fixture-validated implementation if authorized**

```bash
git add apps/server-pilot/src/hms/runtime.ts apps/server-pilot/scripts/hms-discover-read.ts apps/server-pilot/deploy/import-hms-secret.sh apps/server-pilot/tests/helpers/hms-fixture-server.ts apps/server-pilot/tests/hms-runtime.test.ts apps/server-pilot/tests/hms-discovery.test.ts apps/server-pilot/src/env.ts apps/server-pilot/deploy/write-ec2-env.sh
git commit -m "feat: add read-only HMS runtime"
```

- [ ] **Step 11: After task review is clean, run orchestrator-only live discovery**

Orchestrator imports the secret, runs each phase separately, and reviews the redacted blocked signature between phases. Never continue from an unknown request automatically. Implementer/reviewer subagents receive only sanitized outputs. If live observation requires code or manifest changes, resume the scoped implementer, rerun fixture tests, commit, and re-review before accepting Task 5.

---

### Task 6: Implement reservation and stay-option read tools

**Execution routing:** Fresh Infor read-adapter expert + fresh reviewer. Implement and test against sanitized Task 5 captures and synthetic fixtures. Orchestrator alone may perform any later live read comparison; neither implementer nor reviewer may navigate HMS.

**Files:**
- Create: `apps/server-pilot/src/hms/adapter.ts`
- Create: `apps/server-pilot/tests/hms-adapter.test.ts`
- Modify: `apps/server-pilot/src/hms/contracts.ts`
- Modify: `apps/server-pilot/src/hms/centurion.manifest.json`

**Interfaces:**

```typescript
type ReservationLookupInput = { candidateId: string };

type QuoteInput = {
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  rooms: number;
  roomType?: string;
  ratePlan?: string;
  boardBasis?: string;
  currency: string;
};

interface HmsReadAdapter {
  findReservation(
    input: ReservationLookupInput,
    candidates: ReadonlyMap<string, LookupCandidate>,
    signal: AbortSignal,
  ): Promise<ToolResult<ReservationReadData>>;
  quoteStay(
    input: QuoteInput,
    signal: AbortSignal,
  ): Promise<ToolResult<StayOptionReadData>>;
}
```

- [ ] **Step 1: Write reservation tests**

Cover exact confirmation, exact external reference, bounded surname/date fallback, zero, one, and multiple matches, 20-row cap, wrong property, malformed fields, canceled/no-show status, and no detail navigation on ambiguity.

Assert model-visible output minimizes unrelated identities.

- [ ] **Step 2: Implement reservation adapter**

Resolve `candidateId` server-side. Do not accept raw guest values from tool input. Search exact candidate. Return `ambiguous` without opening detail if multiple rows.

- [ ] **Step 3: Write stay-option tests**

Cover:

- Requested room count used and `availableCount >= rooms`.
- Every requested night present.
- Inventory dates have no gaps.
- Room type/rate plan/currency match request.
- Amount basis explicit.
- Tax, inclusions, restrictions, board basis, organization eligibility.
- Zero inventory, malformed count/amount, partial rate, mismatched screens.
- `bookable: false` always.
- `draftReady: false` whenever any required claim is unresolved.

- [ ] **Step 4: Implement separate inventory/rate reads**

Room Availability and Display Rates remain separate observations. Never merge them into a guaranteed offer.

```typescript
const draftReady =
  inventoryCoversEveryNight &&
  inventorySupportsRooms &&
  rateMatchesRequest &&
  unresolvedFields.length === 0;
```

Even when `draftReady` is true, `bookable` remains false.

- [ ] **Step 5: Generate manifest from reviewed observations**

Exact Zod selector schema; no loose selector record plus second manual key list. Manifest stores exact request rules from Task 4.

- [ ] **Step 6: Run tests**

Expected: reservation and stay-option branches pass; CRS route never appears.

- [ ] **Step 7: Commit if authorized**

```bash
git add apps/server-pilot/src/hms/adapter.ts apps/server-pilot/src/hms/contracts.ts apps/server-pilot/src/hms/centurion.manifest.json apps/server-pilot/tests/hms-adapter.test.ts
git commit -m "feat: add HMS reservation and rate reads"
```

---

### Task 7: Build claim-safe Mastra candidate generation

**Execution routing:** Fresh Mastra/LLM-evidence expert + fresh reviewer. Use mocked typed read tools; no browser, AWS secret, or live HMS access. Orchestrator owns approval of claim/template boundaries and any change that could reintroduce free-form factual output.

**Files:**
- Create: `apps/server-pilot/src/ai/candidate-draft-agent.ts`
- Modify: `apps/server-pilot/src/ai/draft-evidence.ts`
- Modify: `apps/server-pilot/src/ai/worker.ts`
- Modify: `apps/server-pilot/src/ai/workflows/candidate-draft.ts`
- Modify: `apps/server-pilot/src/ai/drafts.ts`
- Test: `apps/server-pilot/tests/hms-candidate-agent.test.ts`
- Test: `apps/server-pilot/tests/ai-worker-contract.test.ts`

**Interfaces:**

```typescript
type EvidenceClaim = {
  id: string;
  kind:
    | 'reservation_status'
    | 'stay_dates'
    | 'inventory'
    | 'displayed_rate'
    | 'attachment_fact';
  value: unknown;
  evidenceId: string;
  expiresAt?: string;
};

type CandidateDraftPlan =
  | {
      outcome: 'candidate';
      salutation: 'first_name' | 'generic';
      openingTemplate: 'acknowledge_request' | 'thanks_for_details';
      selectedClaimIds: string[];
      closingTemplate: 'invite_questions' | 'await_confirmation';
    }
  | {
      outcome: 'needs_clarification' | 'insufficient_evidence';
      questionCodes: string[];
      unavailableSources: string[];
    };
```

- [ ] **Step 1: Write failing agent tests**

Cover:

- Tool registry effects are all `read`.
- Only opaque candidate IDs accepted.
- Failed calls count toward four-call budget.
- Abort propagates into tool execution.
- Model receives minimized `toModelOutput`, not raw page/tool data.
- Candidate rejected for partial/ambiguous/stale/manual/`draftReady:false`.
- Selected claim must exist and cite current evidence.
- Model-authored money/date/reference literals are rejected outside claims.
- HTML derives from validated text; model never supplies HTML.
- Prompt injection from email, DOM, PDF, or credential metadata cannot alter tool scope.
- Off mode still runs existing skeleton flow.

- [ ] **Step 2: Register strict read tools**

Use Mastra `createTool` with strict Zod inputs, outputs, `abortSignal`, and `toModelOutput`. Tool effect registry is code-owned:

```typescript
export const candidateToolEffects = {
  hms_find_reservation: 'read',
  hms_quote_stay: 'read',
  mail_read_artifact: 'read',
} as const;
```

- [ ] **Step 3: Build claims in code**

Tools return typed data. Code converts eligible fields to `EvidenceClaim`. Model sees claim IDs and safe summaries, not authority to invent claim values.

- [ ] **Step 4: Generate draft plan**

Model outputs approved template enums, selected claim IDs, or non-candidate question codes. It does not output free-form factual prose, HTML, or text bodies.

- [ ] **Step 5: Render deterministically**

```typescript
function renderCandidate(plan: CandidateDraftPlan, claims: Map<string, EvidenceClaim>) {
  if (plan.outcome !== 'candidate') return plan;
  const factualLines = plan.selectedClaimIds.map(id => renderClaim(requireClaim(claims, id)));
  const textBody = [
    renderSalutation(plan.salutation),
    renderOpening(plan.openingTemplate),
    ...factualLines,
    renderClosing(plan.closingTemplate),
  ].join('\n\n');
  return { textBody, htmlBody: textToSafeHtml(textBody) };
}
```

Use deterministic templates for every salutation, opening, claim, clarification question, and closing.

- [ ] **Step 6: Persist atomically**

One DB transaction:

1. Recheck run fence.
2. Recheck thread state version.
3. Insert generation outcome/evidence refs.
4. In `enabled`, persist candidate/revision.
5. Mark run succeeded with same claim token.

`shadow` stores metrics/generation outcome only. `off` stays on existing workflow and evidence rules do not apply.

- [ ] **Step 7: Run tests and eval fixtures**

Expected: no candidate can contain uncited material fact; non-candidate outcomes persist without draft.

- [ ] **Step 8: Commit if authorized**

```bash
git add apps/server-pilot/src/ai/candidate-draft-agent.ts apps/server-pilot/src/ai/draft-evidence.ts apps/server-pilot/src/ai/worker.ts apps/server-pilot/src/ai/workflows/candidate-draft.ts apps/server-pilot/src/ai/drafts.ts apps/server-pilot/tests/hms-candidate-agent.test.ts apps/server-pilot/tests/ai-worker-contract.test.ts
git commit -m "feat: generate evidence-bound hotel drafts"
```

---

### Task 8: Reuse draft UI and enforce Refresh/promotion/send freshness

**Execution routing:** Fresh draft-lifecycle/UI integration expert + fresh integration reviewer. Fixture/database tests only. Orchestrator resolves cross-layer state semantics and blocks any implementation that weakens existing send or staleness guards.

**Files:**
- Modify: `apps/server-pilot/src/trpc/routes/ai.ts`
- Modify: `apps/server-pilot/src/trpc/routes/drafts.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`
- Modify: `apps/mail/lib/mail/thread-draft-view-model.ts`
- Modify: `apps/mail/components/mail/thread-draft-card.tsx`
- Modify: `apps/mail/components/mail/thread-display.tsx`
- Test: `apps/server-pilot/tests/hms-candidate-state.test.ts`
- Test: `apps/server-pilot/tests/draft-ai-promotion-contract.test.ts`
- Test: `apps/server-pilot/tests/draft-stale-conflict.test.ts`
- Test: `apps/mail/tests/thread-draft-view-model.test.ts`
- Test: `apps/mail/tests/stale-draft-send-flow.test.ts`

**Interfaces:**

```typescript
type HmsCandidateState = {
  visibleCandidate: ParsedDraft | null;
  activeRun: {
    id: string;
    state: 'queued' | 'claimed' | 'running' | 'retry_wait';
  } | null;
  outcome: 'candidate' | 'needs_clarification' | 'insufficient_evidence' | null;
  freshness: 'fresh' | 'stale_thread' | 'stale_evidence' | 'unknown';
  unresolvedFields: string[];
  refreshedAt: string | null;
};
```

- [ ] **Step 1: Write failing state tests**

Cover:

- Prior successful candidate remains visible during queued/running/failed Refresh.
- Atomic new success replaces old candidate.
- Later inbound, outbound, sent revision, or completed action marks candidate stale.
- Attachment hash change marks stale.
- Expired 15-minute rate/inventory evidence marks stale.
- Reservation evidence TTL follows configured field policy.
- Concurrent Refresh idempotency returns same run.
- New message during Refresh prevents final commit.
- Off-mode skeleton promotion/send keeps current behavior.

- [ ] **Step 2: Implement candidate state query**

Query latest successful candidate independently from latest active run. Do not select one latest run and infer both.

- [ ] **Step 3: Implement Refresh**

Idempotency key includes thread state version and toolset version:

```typescript
`hms-refresh:${transportId}:${threadId}:${threadStateVersion}:${toolsetVersion}`
```

- [ ] **Step 4: Extend existing view model**

Add `aiOutcome`, `freshness`, `refreshState`, and `unresolvedFields` to `ThreadDraftViewModel`. Reuse `ThreadDraftCard`; no new candidate card abstraction.

- [ ] **Step 5: Recheck promotion and send**

Server-side checks:

1. Generation is HMS-enriched.
2. Thread state version unchanged.
3. Every selected evidence ref remains fresh.
4. Candidate is newest successful one for reply parent.
5. Existing manual active draft still wins.

No `confirmStaleDraft` bypass for expired HMS evidence. Existing manual/legacy stale-draft confirmation remains unchanged.

- [ ] **Step 6: Run backend and UI tests**

Expected: prior candidate continuity, explicit outcomes, and hard HMS freshness guards pass.

- [ ] **Step 7: Commit if authorized**

```bash
git add apps/server-pilot/src/trpc/routes/ai.ts apps/server-pilot/src/trpc/routes/drafts.ts apps/server-pilot/src/trpc/routes/mail.ts apps/mail/lib/mail/thread-draft-view-model.ts apps/mail/components/mail/thread-draft-card.tsx apps/mail/components/mail/thread-display.tsx apps/server-pilot/tests/hms-candidate-state.test.ts apps/server-pilot/tests/draft-ai-promotion-contract.test.ts apps/server-pilot/tests/draft-stale-conflict.test.ts apps/mail/tests/thread-draft-view-model.test.ts apps/mail/tests/stale-draft-send-flow.test.ts
git commit -m "feat: expose safe HMS draft outcomes"
```

---

### Task 9: Prove fixture E2E, shadow quality, and live read rollout

**Execution routing:** Fresh E2E/eval/release expert + fresh release/security reviewer implements loopback tests, evals, and gate scripts. Orchestrator alone runs migration, deploy, shadow mode, health checks, and the final live read canary. Then dispatch one fresh whole-branch reviewer.

**Files:**
- Create: `packages/testing/playwright.hms-fixture.config.ts`
- Create: `packages/testing/e2e/hms-draft-pipeline.spec.ts`
- Create: `apps/server-pilot/src/hms/production-boundary.ts`
- Create: `apps/server-pilot/tests/hms-production-boundary.test.ts`
- Create: `apps/server-pilot/deploy/hms-read-gate.sh`
- Modify: `apps/server-pilot/src/ai/eval-runner.ts`
- Modify: `apps/server-pilot/tests/ai-eval-runner.test.ts`
- Modify: `apps/server-pilot/package.json`
- Modify: `apps/server-pilot/deploy/write-ec2-env.sh`

**Interfaces:**
- Consumes every prior task.
- Produces signed gate outputs for fixture, security, shadow, and live read-only canary.

- [ ] **Step 1: Write production-boundary tests**

Assert:

- Every registered tool effect is `read`.
- Production import graph excludes write lab, SMTP sender, POP3 credentials, generic browser/MCP, OCR.
- HMS process is only browser owner.
- Default worker cannot claim HMS lane.
- Built package and PM2 config include no mutation enable flag.

Use typed registry/import graph checks, not source-string claims as sole proof.

- [ ] **Step 2: Add dedicated fixture Playwright config**

Config must:

- Refuse any base URL not literal `127.0.0.1`.
- Start disposable DB, fake S3, fixture HMS, server, and mail UI.
- Provision fixture auth.
- Use zero retries and zero skipped tests.
- Write trace/screenshot only on failure.

- [ ] **Step 3: Add E2E journeys**

```text
reservation exact -> evidence -> candidate -> promote
reservation ambiguous -> needs clarification -> no draft
quote partial -> manual enrichment -> no candidate
PDF text -> claim -> candidate
scanned PDF -> manual required -> no candidate
unknown request -> abort -> prior candidate remains
timeout/lease loss -> context closes -> no generation
Refresh failure -> previous candidate remains
new outbound before send -> stale -> send blocked
off mode -> legacy skeleton still promotable
```

- [ ] **Step 4: Make DB prerequisite fail closed**

HMS gate sets `HMS_DB_TEST_REQUIRED=1`; test helper throws when DB unavailable. General suite may retain skip behavior.

- [ ] **Step 5: Add separate shadow evaluator**

Package script:

```json
"eval:hms-shadow": "tsx src/ai/eval-runner.ts --mode=hms-shadow --denominators=evals/hms/denominators.v1.json"
```

Metrics:

- denominator membership/version
- strict Full rate
- useful partial rate
- invented-fact count
- false-candidate count
- abstention rate
- tool latency/failure
- stale-at-review rate

Partial never scores Full. Empty/missing denominator fails.

- [ ] **Step 6: Add security-marker matrix**

Inject separate markers through email, fixture DOM, PDF, and secret-loader metadata. Inspect DB, logs, metrics, health file, Mastra storage, and persisted evidence. Raw markers must be absent or explicitly redacted.

- [ ] **Step 7: Define promotion gates**

Hard gates:

- Zero live mutation.
- 100% request-policy compliance.
- Zero invented material facts.
- Zero cross-thread/property leakage.
- Zero skipped HMS release tests.
- 100% freshness/send-guard enforcement.
- Live canary exact property/tenant.

Statistical gates activate after at least 30 eligible labelled cases:

- material-field precision >= 99%
- false-candidate rate = 0
- report candidate-production rate and abstention; do not optimize by silent abstention

- [ ] **Step 8: Run full fixture gate**

```bash
pnpm --dir apps/server-pilot run build
HMS_DB_TEST_REQUIRED=1 pnpm --dir apps/server-pilot exec vitest run \
  tests/hms-contracts.test.ts \
  tests/hms-request-policy.test.ts \
  tests/hms-runtime.test.ts \
  tests/hms-discovery.test.ts \
  tests/hms-adapter.test.ts \
  tests/hms-thread-context.test.ts \
  tests/hms-artifact.test.ts \
  tests/hms-candidate-agent.test.ts \
  tests/hms-candidate-state.test.ts \
  tests/hms-production-boundary.test.ts \
  tests/ai-workflow-run-contract.test.ts \
  tests/ai-worker-contract.test.ts \
  tests/ai-eval-runner.test.ts
pnpm --dir packages/testing exec playwright test \
  --config=playwright.hms-fixture.config.ts
pnpm --dir apps/server-pilot run eval:hms-shadow
```

Expected: no skips, no external HMS calls, no mutation, no uncited candidate.

- [ ] **Step 9: Commit fixture/eval/gate implementation if authorized**

```bash
git add packages/testing/playwright.hms-fixture.config.ts packages/testing/e2e/hms-draft-pipeline.spec.ts apps/server-pilot/src/hms/production-boundary.ts apps/server-pilot/tests/hms-production-boundary.test.ts apps/server-pilot/deploy/hms-read-gate.sh apps/server-pilot/src/ai/eval-runner.ts apps/server-pilot/tests/ai-eval-runner.test.ts apps/server-pilot/package.json apps/server-pilot/deploy/write-ec2-env.sh
git commit -m "test: gate HMS read rollout"
```

- [ ] **Step 10: After task review is clean, orchestrator deploys in off mode**

Use primary deploy wrapper with migration, confirm PM2/default triage/draft health, and keep `HMS_DRAFT_ENRICHMENT_MODE=off`. No subagent receives deploy credentials or executes remote commands.

- [ ] **Step 11: Orchestrator runs shadow and live read-only rollout**

1. Set `shadow`; run labelled corpus.
2. Run the live read canary through SSM only after fixture/security gates pass.
3. Canary performs login/property verification and approved read operations only; stop on first unknown request and capture redacted gate JSON.
4. Review metrics and request-policy violations.
5. Set `enabled` only after hard/statistical gates pass.
6. Roll back by setting `off`; legacy skeleton flow remains intact.
7. If deployment or canary exposes a code defect, resume RCA with one scoped fixer, run affected tests, commit, regenerate review package, and re-review before completion.

---

## Test Coverage Diagram

```text
CODE PATHS                                         USER/OPERATOR FLOWS
[Task 1] enqueue/claim                             [Draft appears]
  |- lane=default -> existing worker                 |- exact reservation -> candidate [E2E]
  |- lane=hms -> HMS worker                          |- ambiguous -> clarification [E2E]
  |- first claim -> deadline                         |- partial quote -> no draft [E2E]
  |- retry/reclaim -> same deadline                  |- PDF text -> candidate [E2E]
  |- stale token -> fenced                           |- scan -> manual required [E2E]
  `- abort -> cleanup                                `- Refresh keeps prior [E2E]

[Task 2] context                                  [Review/send]
  |- trigger/latest retained                         |- promote fresh [E2E]
  |- old history byte-bounded                        |- new inbound -> stale [E2E]
  |- exact refs -> opaque candidates                 |- new outbound -> stale [E2E]
  `- thread-state hash                               `- expired rate -> send blocked [E2E]

[Tasks 4-6] HMS browser                           [Operations]
  |- exact request -> continue                       |- fixture gate no skips
  |- changed value -> abort                           |- shadow metrics fixed denominator [EVAL]
  |- redirect/popup/download -> abort                 |- live canary read-only
  |- wrong property -> circuit open                  `- off rollback keeps legacy flow
  |- reservation 0/1/many
  `- inventory/rates complete/partial

[Task 7] claims/agent
  |- tool result -> typed claims
  |- partial/stale -> non-candidate
  |- selected IDs -> deterministic facts
  |- factual literal outside claim -> reject
  `- fenced transaction -> persist
```

Every branch above requires unit/integration coverage. E2E and eval labels identify non-unit gates.

## Failure Modes

- HMS navigation timeout: tested; signal closes context; operator sees retry/failed state.
- Lost lease: tested; stale owner cannot persist; operator sees previous candidate plus failed Refresh.
- Unknown request/value: tested; abort before intentional continuation; health shows blocked signature code.
- Wrong property/tenant: tested; circuit remains closed; no candidate.
- Thread changes during run: tested; final transaction fails fence; no stale candidate.
- Later outbound after generation: tested; candidate stale/suppressed; send blocked.
- Quote lacks requested room count/night/rate facts: tested; `draftReady: false`; no candidate.
- PDF scan/encryption/malformed/output cap: tested; manual-required state; no silent empty fact.
- Fixture DB/browser absent: tested by gate preflight; command fails, never skips green.
- Shadow denominator empty/drifted: tested; evaluator fails with version/membership error.
- Default worker blocked by HMS: tested; separate lane continues.
- Off mode regression: tested; legacy skeleton path unchanged.

No planned failure remains silent without test and operator-visible state.

## Performance Budget

- Default AI lane cannot wait on HMS work.
- One HMS browser process, one active HMS context, context closed after each run.
- 150 seconds total execution; 10 seconds reserved for cleanup.
- Four tool calls maximum, including failed calls.
- Thread context <= 64 KiB UTF-8.
- Attachment input <= 20 MiB; PDF <= 50 pages; extracted text <= 256 KiB.
- Reservation result cap 20; related-message cap 20.
- No artifact cache or raw attachment-text persistence.
- Index claim path by lane/state/next run/created time.

## Subagent Execution Order

`subagent-driven-development` uses one implementation subagent at a time in this shared worktree. Dependency lanes below guide order; they do not authorize parallel edits.

| Phase | Tasks | Modules | Depends on |
|---|---|---|---|
| A | Task 0 -> Task 1 -> Task 2 | evals, DB, ledger, AI context/evidence | — |
| B | Task 3 | mail artifacts, sandbox | Task 2 evidence interface |
| C | Task 4 -> Task 5 -> Task 6 | HMS contracts, policy, runtime, adapter | Tasks 1–2 |
| D | Task 7 -> Task 8 | agent, persistence, tRPC, UI | A+B+C |
| E | Task 9 | E2E, eval, deploy | D |

Execute `0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9`. Read-only Exa/official-doc research agents may run alongside an implementer only when they cannot edit files, access live HMS, or receive sensitive data. No second implementer starts until current task review is clean and ledger entry is written.

## NOT in Scope

- Live write, write-form inspection, or live write test: separate human-supervised boundary.
- Fixture create/amend/cancel adapters: later child plan after read contracts and selectors are observed.
- Wave 1B sent-email/property-form/document reads: next child plan.
- Finance, folio, ledger, deposit, tax invoice: later evidence-gated child plan.
- Group, event, guest messages/traces, room status: separate child plans.
- Property policy tool: wait for named human-owned source/version/expiry.
- OCR, image vision, DOCX, XLSX, CSV: deferred; human supplies facts.
- Payment allocation/refund/link, OTA actions, reputation publishing, CRM: external/later systems.
- Auto-send: review-first remains product behavior.
- MCP façade: no consumer.
- Generic browser, arbitrary URL, generic operation framework: unnecessary and unsafe.
- Separate worktree: user explicitly chose current branch/worktree.

## Final Verification Commands

```bash
pnpm --dir apps/server-pilot run build
pnpm --dir apps/server-pilot run test
pnpm --dir apps/mail run test
HMS_DB_TEST_REQUIRED=1 pnpm --dir apps/server-pilot exec vitest run tests/hms-*.test.ts
pnpm --dir packages/testing exec playwright test --config=playwright.hms-fixture.config.ts
pnpm --dir apps/server-pilot run eval:hms-shadow
bash apps/server-pilot/deploy/pdf-text-gate.sh
bash apps/server-pilot/deploy/hms-read-gate.sh --fixture-only
git diff --check
```

Expected: all commands pass, HMS suites report zero skips, fixture requests stay on literal loopback, and no write/MCP/OCR module enters production graph.

## Self-Review Record

### Spec coverage

- Corpus-derived scope and honest denominator reporting: Task 0 and Task 9.
- Autonomous Exa/docs research plus live read discovery: Tasks 0 and 5.
- Hard no-write guardrail: global constraints, Tasks 4–6, production boundary.
- Reservation/rate/artifact foundation: Tasks 3 and 6.
- Adaptive typed-tool agent: Task 7.
- Existing AI pipeline and UI reuse: Tasks 1, 7, 8.
- 150-second total deadline: Task 1.
- Secure credential handoff: Task 5.
- Embedded PDF text only, no OCR: Task 3.
- Freshness, human review, no auto-send: Task 8.
- Fixture/E2E/shadow/live-read gates: Task 9.
- Eventual write portfolio: roadmap, explicitly not this plan.
- Overnight autonomy, RCA, expert research, and true-blocker rules: Overnight Autonomous Execution Mandate.
- Fresh implementer/reviewer boundaries, durable ledger, task briefs, review packages, and sequential ownership: Subagent-Driven Execution Protocol plus each task's execution routing.
- Future production-real write functions remain fixture-only while all live HMS development stays read-only: Global Constraints and Live HMS/future write-function boundary.

### Placeholder scan

Plan contains no unresolved implementation placeholders or cross-task shorthand. Active denominator arrays contain exact audited thread IDs; reference-only counts cannot be used as executable eval sets.

### Type consistency

- `AiExecutorLane`, `AiRunFence`, `ThreadContext`, `LookupCandidate`, evidence unions, `ToolResult`, adapter methods, and candidate state are defined before consumers.
- `AbortSignal` flows from run budget through Mastra, browser, S3, and subprocesses.
- HMS and mail evidence are discriminated; property is never required for mail attachment evidence.

## Implementation Tasks

- [ ] **T0 (P1, human: ~1 day / agent: ~60 min)** — evidence baseline — lock corpus denominators and docs-backed autonomous discovery scope.
- [ ] **T1 (P1, human: ~1 day / agent: ~45 min)** — run ledger — add lane isolation, immutable deadline, heartbeat, and claim-token fencing.
- [ ] **T2 (P1, human: ~1 day / agent: ~45 min)** — context — build newest-first bounded context, opaque lookup candidates, typed evidence, and all-message high-water version.
- [ ] **T3 (P1, human: ~1 day / agent: ~60 min)** — artifacts — add text and embedded-PDF extraction with sandboxed manual fallback.
- [ ] **T4 (P1, human: ~1 day / agent: ~45 min)** — safety — enforce full canonical request templates and browser escape guards.
- [ ] **T5 (P1, human: ~2 days / agent: ~90 min)** — runtime — implement property-bound abort-aware browser lifecycle and orchestrator-only read discovery.
- [ ] **T6 (P1, human: ~2 days / agent: ~90 min)** — reads — implement reservation and rate/inventory observations with readiness gates.
- [ ] **T7 (P1, human: ~2 days / agent: ~90 min)** — agent — produce typed claims and deterministic factual rendering.
- [ ] **T8 (P1, human: ~1 day / agent: ~60 min)** — product — preserve candidate during Refresh and hard-block stale HMS promotion/send.
- [ ] **T9 (P1, human: ~2 days / agent: ~90 min)** — gates — add non-skipping fixture E2E, fixed-denominator eval, security matrix, and staged rollout.

## Plan State

Plan updated for overnight subagent-driven execution. No implementation, live discovery, deployment, commit, or PMS action starts until user explicitly invokes execution.

## GSTACK REVIEW REPORT

### Review target

- `2026-07-29-infor-hms-autonomous-tools.md`
- `2026-07-29-infor-hms-full-tool-portfolio-roadmap.md`

### Step 0: Scope Challenge

Scope reduced. Original 6,000-line ten-task plan mixed run infrastructure, mail artifacts, HMS reads, UI rollout, broad future research, and speculative fixture writes. Final plan keeps one deployable read-foundation lake. Later reads and writes remain evidence-gated child plans.

### Architecture Review

Eight issues resolved:

1. Write-capable autonomous navigation narrowed to exact documented read screens; all write screens removed.
2. Key-only request allowlist replaced by fixed/variable canonical value templates.
3. Arbitrary model guest search replaced by server-derived opaque candidates.
4. Retry-reset deadline replaced by one immutable 150-second budget.
5. HMS work isolated from triage through one lane/browser owner.
6. Regex evidence checks replaced by typed claims and deterministic rendering.
7. Thread freshness now includes inbound, outbound, sent revisions, and actions.
8. Fixture writes moved after read waves into separate plan.

### Code Quality Review

Over-engineering removed:

- One programmatic HMS fixture source replaces duplicate static/inline fixtures.
- Existing mail search, sanitizers, worker entrypoint, run ledger, draft view model, and card are reused.
- Exact Zod selector/request schemas replace loose records plus duplicate key lists.
- Source-string scans and one-off handoff generator are not architectural proof.
- Duplicate candidate/production write namespaces are removed from this phase.
- Unvalidated write-coverage projections are removed from execution gates.

Ponytail result: approximately 900 lines of speculative/duplicated plan machinery avoided versus reviewed plan.

### Test Review

Test diagram included. Nine gap groups folded into Tasks 1–9:

- full request-value/redirect/service-worker matrix
- absolute deadline/abort/lease cleanup
- blocked-discovery evidence
- typed evidence and HTML/text equivalence
- Refresh continuity and all-message staleness
- non-skipping fixture E2E
- artifact sandbox/error branches
- security marker source matrix
- fixed-denominator shadow evaluation

Critical silent gaps remaining after rewrite: zero.

### Performance Review

Three issues resolved:

- Long HMS runs no longer block triage/feedback.
- Newest trigger cannot be truncated from large threads.
- Browser, context, attachment, result, and tool budgets are explicit and bounded.

### Outside Voice

Codex CLI failed authentication and also selected a disallowed mini model, so no result was used. Fresh independent standard-model review found no cross-review tension and added four fixes: preserve newest context, include outbound state in freshness, enforce quote readiness, and keep `off` mode backward-compatible.

### Review Outputs

- NOT in scope: written.
- What already exists: written.
- Deferred-work ledger updates: zero; roadmap already owns deferred work.
- Failure modes: written; zero unresolved critical gaps.
- Subagent execution: ten sequential implementer/reviewer gates in one shared worktree; only read-only research may run in parallel.
- Lake score: complete option selected for every safety/test decision.
- Status: `DONE_WITH_CONCERNS` until target-tenant selectors, entitlement, and harmless read signatures are observed.
