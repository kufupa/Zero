---
title: Infor HMS Live Reservation Shadow
type: feat
date: 2026-08-01
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Infor HMS Live Reservation Shadow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `/nava-run` with TDD + subagent-driven development. Work in current `EC2-pilot` branch/worktree. Do not create another branch or worktree. Do not commit unless user separately authorizes commits. **Autonomous overnight mandate below overrides routine checkpoints.**

**Goal:** Prove one production `hms_find_reservation` tool through the real HMS worker, Playwright, exact Guest Stay search, in-memory drafting, and strict manual shadow completion without mutating HMS or persisting business evidence.

**Architecture:** One `hms-ai-worker` owns one Chromium process and opens a fresh fail-closed browser context per claimed run. Server code derives exact opaque confirmation/external-reference candidates from the authorized thread, binds each request manifest to the selected value, calls one Mastra `createTool`, and discards HMS evidence and draft output. Only existing workflow-run lifecycle fields and fixed aggregate counters persist.

**Tech Stack:** TypeScript, Mastra `createTool`, Playwright 1.52, Zod, Drizzle/PostgreSQL, AWS Secrets Manager, Vitest, PM2.

**Execution posture:** Autonomous overnight. User will not supply `TEST_DATABASE_URL`, hotel-admin paperwork, or Bedrock/PII clarifications mid-run. Agent provisions disposable DB, stages observed role-proof, and proceeds. Pilot/production RDS for Vitest remains unconditionally forbidden — be smart: never “just use prod for tests.”

## Global Constraints

- Production HMS is read-only. Login, Guest Stay navigation, and exact search only.
- Never trigger New Record, Save, Delete, duplicate, check-in/out, document generation/send, CRS availability, or any mutation-looking action.
- Live requests require current role-proof (hotel-admin **or** operator-observed runtime attestation below) plus exact request-policy approval.
- `HMS_DRAFT_ENRICHMENT_MODE` supports only `off` and `shadow`; literal `enabled` fails startup and operations.
- `AI_DRAFTS_ENABLED=false`; no AI draft, generation, revision, email, or HMS business record may be created.
- Shadow may persist workflow lifecycle and fixed counters only. No HMS value, model output, evidence, claim/candidate ID, business-content hash, DOM, or free-form error may persist.
- Build, manifest, fingerprint, and role-proof hashes are allowed because they derive from code/attestation artifacts, not guest or email content.
- Bedrock may receive bounded authorized Centurion thread text + minimized claim IDs/kinds. User confirmed zero-data-retention / contract OK. Credentials, selectors, raw HMS DOM, unrelated rows, and raw tool values stay out of the model.
- Never run Vitest or any test runner with pilot/production `DATABASE_URL`; never set `VITEST_ALLOW_PILOT_RDS`. Past wipe: `docs/solutions/database-issues/vitest-production-pilot-db-wipe.md`. Smart default = disposable Docker DB only; if disposable DB missing, skip DB Vitest and continue DB-free + live purpose-built paths — never fall back to pilot.
- Disposable DB is agent-provisioned (see mandate). Missing disposable DB blocks DB-backed Vitest only; it never permits pilot-RDS tests. Live proof may use read-only SQL/API/purpose-built scripts against pilot.
- Live proof uses purpose-built scripts only. Subagents receive no credentials, database URLs, or live HMS access; orchestrator may use Secrets Manager / SSM under existing ops wrappers.
- Proof mail selector: **oldest** eligible Centurion inbound with exactly one confirmation/external-reference candidate (not newest).
- **Model selection (mandatory):** never use Fast variants. If choice is Fast vs normal/standard, pick normal/standard. Prefer Composer 2.5 (normal, not Fast) and Grok 4.5 (normal, not Fast) for implementation/review subagents. Highest-reasoning / max-thinking variants are allowed when available. Auto router must not silently downgrade to Fast. If only Fast slug is offered by the tool, omit model (inherit parent) or run inline on the parent non-fast model — do not select `*-fast`. Orchestrator + subagents: `/caveman ultra`.

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No “which approach?” pause. Continue until Definition of Done verified or a true blocker.

### Decision authority

- Choose best safe reversible option without asking.
- Better route to accepted goal may be taken; log what changed and why in handoff.
- Preserve requirements. Do not silently cut scope or activate deferred tools 2–10.
- **Never Fast models.** Prefer Composer 2.5 normal / Grok 4.5 normal; highest-reasoning OK. If tool only lists `composer-2.5-fast`, omit `model` or work inline on parent — do not pass a Fast slug.
- Pilot wipe prevention overrides green gates: refuse any Vitest/fixture path whose `DATABASE_URL` host contains `nava-zero-mail-pilot` or production RDS; refuse sourcing `.env.production` into tests.

### Settled user approvals (2026-08-03)

| Item | Decision |
| --- | --- |
| Bedrock + bounded mail/PII | Allowed (ZDR). Proceed. |
| Cursor/Azure LLM reading PII | Allowed for this pilot work. Still do not print PII into logs/SSM/proof files. |
| `TEST_DATABASE_URL` from user | Not required. Agent provisions disposable DB. |
| Pilot/prod RDS for Vitest | **Forbidden forever.** Autonomy cannot override. |
| Role-proof hotel paperwork | Not required overnight. Agent stages operator-observed attestation (below). |
| Proof email | Older real Centurion mail OK; selector = oldest eligible exact candidate. |
| HMS login | Already proven on EC2; reuse Secrets Manager + live probe path. |

### Disposable DB (agent-owned)

1. Prefer laptop/dev: `pnpm docker:db:up` → `TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/zerodotemail` from [`docker-compose.db.yaml`](../../docker-compose.db.yaml) / root `package.json` scripts. Migrate schema as needed. Host must not contain `nava-zero-mail-pilot`.
2. Before every Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` then export only `TEST_DATABASE_URL` / remap per gate scripts.
3. On EC2: if Docker available, start an ephemeral Postgres 16/17 container named for tests (not the pilot RDS endpoint) and set `TEST_DATABASE_URL` to that container only. If Docker unavailable, run DB-free gates only and treat DB-backed Vitest as safety-blocked—continue live purpose-built proof paths that do not use Vitest.
4. Never source `.env.production` into a Vitest process. Never point Vitest at `nava-zero-mail-pilot`.

### Role-proof (operator-observed allowed)

`/opt/nava/shared/hms-read-role-proof.v1.json` mode `0600` may be staged autonomously when all of:

- Secrets Manager HMS secret mode/requirement is read/view-only (or equivalent documented field);
- Live inventory/canary shows Guest Stay reachable and `hasNewRecord=false` (or New Record control absent);
- Request policy blocks mutation-looking paths;
- `evidenceRef` = `operator-observed-runtime-v1:<inventorySha256>`;
- `deniedActions` list matches plan Role-proof contract;
- TTL ≤30 days.

This is **not** a fake hotel-admin signature. It is an explicit operator-observed attestation. If any check fails, live canary blocks with `ROLE_PROOF_*` / `ROLE_SCOPE_INVALID`.

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) — **read-only ops / live proof only; never Vitest** |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Primary deploy | `apps/server-pilot/deploy/ops-deploy.sh` |
| Primary app bounce | `apps/server-pilot/deploy/ops-restart.sh` |
| Primary box reboot | `apps/server-pilot/deploy/ops-reboot.sh` |
| Guts | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |

**Allowed:** ops wrappers, bundle sync, deploy, migrate via `ops-deploy --migrate`, seed without `--rotate` unless required, read-only SSM, PM2 logs, health curl, Vitest against disposable DB only, live HMS read probes via purpose-built scripts.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds beyond existing HMS Secrets Manager path, Vitest against pilot/production RDS, `VITEST_ALLOW_PILOT_RDS=1`, sourcing `.env.production` into tests, live HMS writes, Fast model variants (`*-fast`, Composer 2.5 Fast, Grok Fast, etc.).

### RCA loop

FAIL → reproduce minimally → root cause (file:line) → research unfamiliar behavior → smallest correct fix → test → resume. Symptom patches and skipped gates are not completion.

### Verification loop

Implement → focused tests → broader tests/build → required deploy/runtime gates → inspect evidence → fix red → repeat.

### Done criteria (binary)

- [x] Tasks 1–5 complete with green local gates (DB-free always; disposable-DB when provisioned)
- [x] Production active tool set = only `hms_find_reservation` `1.1.0`
- [x] Live sequence emits `HMS_DEPENDENCIES_OK` → `HMS_OFF_READY` → `HMS_LIVE_NOT_FOUND_OK` → `HMS_LIVE_ROW_FINGERPRINT_OK` → `HMS_LIVE_ROW_OK` → `HMS_SHADOW_OK` / `HMS_SHADOW_VERIFIED` → `HMS_ROLLBACK_OK`
- [x] Zero policy-block delta; zero forbidden-row delta; no raw PII/HMS values in SSM/proof files
- [x] Definition of Done checklist fully ticked or true blocker documented

### True blockers

Stop only for: missing HMS Secrets Manager access; Docker unavailable **and** DB-backed gate mandatory with no disposable URL; role-observed checks fail; destructive ambiguity; safety-policy conflict; external outage. Do **not** stop to ask user for `TEST_DATABASE_URL`, Bedrock OK, or hotel-admin paperwork.

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development (+ `/nava-run`). Do not ask “which approach?”

---

## Product Contract

### Scope decision

Primary demand evidence is `docs/infor-hms/centurion-pms-tool-demand-2026-08-03.md` (623 msgs / 520 threads / 72 outbound; prior 01 Aug dump was 526/434/68). Regex scores are overlapping demand signals, not measured drafting coverage or marginal tool value. They support a roadmap, not one large implementation batch.

**Recommendation (settled):** do **not** build all ten demand-ranked tools in this plan. Finish one vertical slice only: live `hms_find_reservation` plus worker/manual-shadow proof. This is the smallest slice that completes the previously missing work:

- live adapter with real search and row parse;
- worker-owned Playwright session instead of mocks;
- real reads in shadow with no business persistence.

Without a proven Guest Stay bridge, every later tool inherits unproven browser session, request policy, shadow persistence, and EC2 ops risk.

### Corpus → tool portfolio decisions

Safety rule for every tool: implementation may *shape* future write-capable adapters, but live production PMS ops in every plan until human-supervised write review are **read-only** (login/navigate/search/open existing read screens only). Never create/amend/cancel/post/settle/refund/send/export on production PMS. Capability matrix `autonomousAllowed` and `phase` gate discovery.

| Rank (08-03) | Tool | Phase / surface | This plan? | Decision |
| --- | --- | --- | --- | --- |
| 1 | `hms_find_reservation` | `active_read` / Guest Stay | **Yes** | Only production tool. Live not-found canary already proven; exact confirmation/external-ref search + row parse + shadow. |
| 2 | `mail_read_artifact` | mail S3/PDF text (no OCR) | Defer #1 | Highest non-PMS unlock for confirmation extraction from vouchers/POPs. Not an HMS screen; separate S3/PDF risk. Activate after reservation shadow verified. |
| 3 | `hms_list_documents` | `roadmap_read` / property docs | Defer #3 | Top *outbound shape* demand (~97% outbound = confirmation/doc delivery). Surface unproven; document open/download can look mutation-adjacent. Read-metadata first after quote path. |
| 4 | `hms_company_account_read` | `roadmap_read` / Profiles·AR | Defer #5 | High overlapping score with confirmation/invoice regex; not needed until company bill-to drafts. |
| 5 | `hms_group_block_read` | `roadmap_read` / Group blocks | Defer #5 | Strong group/conference demand (~27% threads) but new HMS surface; after solo reservation path. |
| 6 | `hms_quote_stay` | `active_read` / Room Avail + Display Rates | Defer #2 | Allowed for autonomous discovery later. Two screens, `bookable:false`, never CRS Check Availability. After reservation bridge proven. |
| 7 | `hms_sent_email_audit` | `roadmap_read` / Sent Email | Defer #4 | Low raw fact count; useful for “did you send?” after docs exist. |
| 8 | `hms_read_folio` | `roadmap_read` / Folios | Defer #4 | Payment language is common in outbound wrappers; folio *balance* fact hits are rare (~2.5% threads). Still needed for deposit/refund drafts. Never post/settle. |
| 9 | `hms_event_read` | `roadmap_read` / Event | Defer #5 | With group/event cluster. |
| 10 | `hms_guest_preferences_read` | `roadmap_read` | Defer #5 | Lowest score; special-request niche. |

### Included

- Repair HMS test/config safety and the date-expired production-boundary journey.
- Required production Playwright runtime and canonical Guest Stay driver.
- One exact successful-row structural fingerprint and deterministic parser.
- Real reservation-only `CandidateToolSession`.
- HMS-lane worker with no production mock fallback.
- Strict shadow terminal writer and fixed safe failure persistence.
- Manual one-run EC2 canary, no-persistence proof, status, and rollback.

### Deferred follow-up plans, in order

Deferral SoT = portfolio table above. Ordered follow-ups:

1. Production `mail_read_artifact` + attachment-to-candidate chaining (no OCR).
2. Live `hms_quote_stay` using separate Room Availability and Display Rates observations with `bookable: false`.
3. Read-only existing-document metadata / list-fetch (`hms_list_documents`) after reservation+quote bridge stable; no generate/send.
4. Folio/deposit/payment/tax reads + `hms_sent_email_audit`.
5. Company/account, group/block/rooming-list, event, preference, message, trace, and room-status reads.
6. Bounded auto-enqueue after manual reservation shadow has stable operational evidence.
7. Fixture-only write adapters. First later write plan may implement only `reservation.create` against literal loopback fixtures. Live write exploration stays human-gated and out of autonomous overnight loops.

### Explicitly outside scope

- Live HMS writes / write-form exploration / mutating production tools.
- Activating tools 2–10 from the portfolio table in this plan; building the full ten-tool portfolio in one overnight loop.
- OCR and generic office-doc parsing; HMS `enabled` mode; persisted AI drafts/generations; auto-send; automatic shadow enqueue.
- MCP, arbitrary URL/selector tools, generic browser tools, generic operation framework.
- Analytics-script cleanup. Untracked PII indexes stay untracked and must be deleted before any later commit.

### Acceptance examples

- Given one exact confirmation in an authorized Centurion thread, manual shadow returns the correlated Guest Stay row in memory and persists only redacted run counters.
- Given no row, shadow finishes with `not_found`; no draft/generation appears.
- Given two correlated rows, lookup returns `ambiguous`, opens no detail, and persists no row values.
- Given only a surname/date candidate, production shadow returns `manual_required` before browser creation.
- Given an altered candidate value, extra request body key, popup, download, WebSocket, wrong tenant/property, or mutation-looking URL, transmission aborts and the circuit becomes unhealthy with a fixed safe code.
- Given any thrown error containing fake PII, database `lastError`, metrics, health, logs, and proof files contain only fixed enums and counters.

---

## Planning Contract

### Key technical decisions

- **KTD1 — Reservation-only first.** 08-03 demand ranks ten tools, but artifact, quote, documents, folio/company/group, and auto-enqueue each add independent S3/PDF, HMS-screen, or scheduling risk before the Guest Stay browser bridge is proven. Build order follows live ladder, not raw score rank.
- **KTD2 — Genuine least privilege.** Request interception is defense in depth, not a substitute for an independently attested read-only HMS role.
- **KTD3 — One canonical driver.** Probe and worker reuse one Guest Stay driver; no second live adapter hierarchy.
- **KTD4 — Exact runtime-bound policy.** Static bootstrap rules are code-owned. The single search rule is created per session with the selected candidate value as exact fixed body/query content.
- **KTD5 — Production capability allowlist.** Candidate orchestration activates only `hms_find_reservation`; deferred tools are not registered or callable in production shadow.
- **KTD6 — Existing model boundary retained.** Bedrock receives bounded thread text and minimized claim metadata because drafting needs the conversation. Raw HMS values remain code-owned and enter only deterministic rendering, which shadow discards.
- **KTD7 — Separate shadow writer.** Shadow never calls or imports `persistAiCandidateDraft()` on its terminal path.
- **KTD8 — Manual proof only.** No recurring/automatic enqueue exists until a later plan reviews stable manual evidence.

### Mode and lane matrix

- `default` lane: existing non-HMS workflows only; never creates HMS runtime or claims `hms` runs.
- `hms` lane + `off`: worker is absent. Generic deploy/restart/reboot must not start it.
- `hms` lane + `shadow`: started only by `ops-hms-shadow.sh start`; claims only `executorLane='hms'`.
- any lane + `enabled`: config, PM2 wrapper, and operations CLI reject with `HMS_FAIL code=MODE_ENABLED_FORBIDDEN`.

### Directional flow

```mermaid
flowchart TB
  Manual[PurposeBuiltManualStart] --> Select[ServerSideEligibleThreadSelection]
  Select --> Run[HmsLaneWorkflowRun]
  Run --> Fresh[FreshThreadStateAndExactCandidate]
  Fresh --> Runtime[SingletonBrowserFreshContext]
  Runtime --> Search[ExactGuestStaySearch]
  Search --> Parse[CorrelateZeroOneManyRows]
  Parse --> Tool[MastraFindReservationTool]
  Tool --> Plan[BoundedModelPlanInMemory]
  Plan --> Finish[StrictShadowTerminalWriter]
  Finish --> Ledger[LifecycleAndCountersOnly]
```

### Runtime states

```mermaid
stateDiagram-v2
  [*] --> Off
  Off --> Canary: operator start
  Canary --> ManualShadow: role/build/manifest/fingerprint valid
  Canary --> Blocked: any mismatch
  ManualShadow --> Verified: zero policy blocks and zero forbidden-row delta
  ManualShadow --> Blocked: policy/auth/schema/runtime failure
  Verified --> Off: operator stop
  Blocked --> Off: rollback
```

### Role-proof contract

`/opt/nava/shared/hms-read-role-proof.v1.json`, mode `0600`. Preferred source: hotel-admin review. Overnight autonomous source allowed: operator-observed runtime attestation per mandate (Secrets Manager view-only + live inventory `hasNewRecord=false` + policy denies + `evidenceRef=operator-observed-runtime-v1:<inventorySha256>`). Required fields:

```typescript
type HmsReadRoleProofV1 = {
  schemaVersion: 1;
  propertyCode: 'HRCEN';
  allowedSurfaces: ['Guest Stay'];
  deniedActions: [
    'new_record',
    'save',
    'delete',
    'duplicate',
    'check_in',
    'check_out',
    'document_generate',
    'document_send',
  ];
  issuedAt: string;
  expiresAt: string; // at most 30 days after issuedAt
  evidenceRef: string; // hotel-admin ref OR operator-observed-runtime-v1:<inventorySha256>; no credential or guest data
  evidenceSha256: string;
};
```

Worker revalidates proof before each live context, not only at enqueue. Missing, expired, wrong-property, wrong-surface, or incomplete denial evidence blocks live execution.

### Failure semantics

- Permanent: policy block, auth failure, wrong tenant/property, role-proof failure, schema drift, forbidden control, popup, download, WebSocket.
- Transient: bounded DNS/VPN reset or browser crash. One retry maximum only when immutable run deadline retains cleanup reserve.
- Business result: `not_found`, `ambiguous`, `manual_required`. No retry.
- Lease loss/shutdown: abort request, close context, and let only current fenced owner write terminal state.
- Persisted `lastError` equals a fixed `AiFailureClass`; raw `error.message` stays memory-only and is redacted before any console path.

Operator output uses only these exhaustive codes:

```typescript
type HmsOperatorFailCode =
  | 'MODE_ENABLED_FORBIDDEN'
  | 'DEPENDENCY_MISMATCH'
  | 'ROLE_PROOF_MISSING'
  | 'ROLE_PROOF_EXPIRED'
  | 'ROLE_SCOPE_INVALID'
  | 'AUTH_FAILED'
  | 'PROPERTY_MISMATCH'
  | 'POLICY_BLOCK'
  | 'SCHEMA_DRIFT'
  | 'WEBSOCKET_BLOCKED'
  | 'POPUP_BLOCKED'
  | 'DOWNLOAD_BLOCKED'
  | 'RUN_ISOLATION_BLOCKED'
  | 'BUILD_MISMATCH'
  | 'MANIFEST_MISMATCH'
  | 'FINGERPRINT_MISMATCH'
  | 'HEALTH_STALE'
  | 'FORBIDDEN_PERSISTENCE'
  | 'ROLLBACK_INCOMPLETE'
  | 'TRANSIENT_NETWORK'
  | 'UNKNOWN_SAFE';

type HmsOperatorWaitCode = 'NO_EXACT_CANDIDATE' | 'HMS_OFF';
type HmsRouteBlockCode = 'HMS_MANUAL_OPS_REQUIRED';
```

Runtime mapping is total: policy/popup/download/WebSocket become `POLICY_BLOCK`; role/auth become `AUTH_FAILED`; property becomes `PROPERTY_MISMATCH`; DOM or manifest mismatch becomes `SCHEMA_DRIFT`; bounded network/browser reset becomes `TRANSIENT_NETWORK`; deadline and lease loss retain their existing classes. Build, dependency, proof, isolation, persistence, and rollback codes stop in operations before a run starts.

---

## Review disposition

| Gate | Verdict | Applied |
| --- | --- | --- |
| `/95` on 08-03 demand | Met — reservation-only; defer tools 2–10 | Product Contract portfolio table |
| `gstack-plan-eng-review` | REVISE → amendments applied | Task 2 policy ownership; Task 3 allowlist note; Task 5 DB-free RED |
| `ponytail-review` | REVISE (light) → applied | Shrunk Task 3 Produces + outside-scope prose; keep portfolio table as deferral SoT |
| `gstack-plan-devex-review` | REVISE → applied | Task 5 Step 9 install + role-proof before canary |
| `/autonomous-plan` + Zero overlay | Merged overnight mandate | Disposable Docker DB; operator-observed role-proof; Bedrock/PII settled; oldest proof mail |
| `/95-exa-subag` disposable DB | Met — never pilot Vitest | Laptop `pnpm docker:db:up`; Testcontainers optional later; EC2 Docker ephemeral or DB-free |
| Model policy (2026-08-03) | Settled | Never Fast variants; Composer 2.5 / Grok 4.5 normal; highest-reasoning OK |

**Unresolved true blockers for planning:** none. Autonomy owns disposable Docker DB + operator-observed role-proof. Pilot RDS Vitest remains forbidden. HMS live login already proven.

**Next:** `/nava-run` / overnight autonomous execution on this plan.

## Task 1: Repair test isolation, control config, and timeless safety journeys

**Files:**

- Modify: `apps/server-pilot/deploy/hms-read-gate.sh`
- Modify: `apps/server-pilot/deploy/mail-search-gate.sh`
- Modify: `apps/server-pilot/deploy/fixture-loopback-gate.sh`
- Modify: `apps/server-pilot/deploy/wire-gate.sh`
- Modify: `apps/server-pilot/deploy/ai-gate.sh`
- Modify: `apps/server-pilot/deploy/playwright-ec2-gate.sh`
- Modify: `apps/server-pilot/deploy/playwright-real-mail-ui-gate.sh`
- Modify: `apps/server-pilot/deploy/import-hms-secret.sh`
- Modify: `apps/server-pilot/tests/helpers/test-db.ts`
- Modify: `apps/server-pilot/src/env.ts`
- Modify: `apps/server-pilot/src/hms/production-boundary.ts`
- Test: `apps/server-pilot/tests/env.test.ts`
- Test: `apps/server-pilot/tests/deploy-config.test.ts`
- Test: `apps/server-pilot/tests/hms-production-boundary.test.ts`
- Test: `apps/server-pilot/tests/ai-worker-contract.test.ts`

**Produces:**

```typescript
type HmsDraftEnrichmentMode = 'off' | 'shadow';

type HmsControlConfig = {
  mode: HmsDraftEnrichmentMode;
  healthPath: string;
};

type HmsWorkerRuntimeConfig = {
  secretArn: string;
  chromiumExecutablePath: string;
  roleProofPath: string;
  healthPath: string;
  expectedTenant: string;
  expectedPropertyCode: 'HRCEN';
  expectedTransportId: string;
  runDeadlineMs: number;
  circuitCooldownMs: number;
};

function parseHmsControlConfig(input: EnvInput): HmsControlConfig;
function requireHmsWorkerRuntimeConfig(input: EnvInput): HmsWorkerRuntimeConfig;
function runHmsDraftPipelineJourneys(now?: Date): Promise<HmsDraftJourneyResult[]>;
```

- [ ] **Step 1: Write failing shell/config safety tests.**

  Assert every test-running gate:

  - executes `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before Vitest;
  - never `source`s `.env.production`, `/home/ubuntu/.env.production`, or `.env`;
  - requires `TEST_DATABASE_URL` plus `CONFIRM_DISPOSABLE_TEST_DB=1` before DB tests;
  - maps `TEST_DATABASE_URL` to `DATABASE_URL` on the Vitest command only;
  - rejects URLs containing `nava-zero-mail-pilot`.

- [ ] **Step 2: Write failing helper tests.**

  Add a source-contract assertion in `deploy-config.test.ts` that rejects `loadTestEnvFromDotenv()`, `.env` file reads, and implicit DB setup. Do not import `ai-worker-contract.test.ts` yet: its current helper would load `.env` before the guard is fixed.

- [ ] **Step 3: Write failing mode/process tests.**

  Assert:

  - literal `enabled` is invalid;
  - default worker can parse `off` without HMS secret/browser values;
  - HMS worker in `shadow` requires secret ARN, Chromium path, role-proof path, and health path;
  - `import-hms-secret.sh` accepts only `credentialMode=view_only`.

- [ ] **Step 4: Freeze the production-boundary clock.**

  Add `now` to `runHmsDraftPipelineJourneys()`. Generate evidence `readAt`/`expiresAt` relative to that clock and prove the exact-reservation journey passes when wall time advances.

- [ ] **Step 5: Run safe RED tests from a clean shell.**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run \
  tests/env.test.ts \
  tests/deploy-config.test.ts \
  tests/hms-production-boundary.test.ts
```

Expected: static/source assertions expose production env sourcing, dotenv fallback, accepted `enabled`, coupled config, and expired evidence without importing the unsafe DB helper.

- [ ] **Step 6: Implement minimal safety changes before importing DB-backed contracts.**

  Split process-neutral controls from HMS-worker requirements. Delete `loadTestEnvFromDotenv()` and all test-env sourcing. Preserve post-test worker restoration by reading only the single non-secret `MAIL_TRANSPORT_MODE` line after tests, never by sourcing the file.

- [ ] **Step 7: Make production-boundary import scanning syntax-aware.**

  Use the repository's existing TypeScript compiler dependency and `ts.createSourceFile()` to enumerate static imports, dynamic `import()` calls, and re-exports. Do not expand the existing regex scanner. Add a rule proving HMS shadow terminal modules cannot import `src/ai/drafts.ts`.

- [ ] **Step 8: Run GREEN tests and fixture gate.**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run \
  tests/env.test.ts \
  tests/deploy-config.test.ts \
  tests/hms-production-boundary.test.ts \
  tests/ai-worker-contract.test.ts
bash apps/server-pilot/deploy/hms-read-gate.sh --fixture-only
```

Expected: all pass without loading any DB URL.

- [ ] **Step 9: Fresh review.**

  Review Task 1 for safety/correctness, then run `ponytail-review`. Fix every Critical/Important finding and rerun Step 8.

---

## Task 2: Compose required Playwright runtime and canonical Guest Stay driver

**Files:**

- Create: `apps/server-pilot/src/hms/production-runtime.ts`
- Create: `apps/server-pilot/src/hms/live-guest-stay-driver.ts`
- Modify: `apps/server-pilot/src/hms/runtime.ts`
- Modify: `apps/server-pilot/src/hms/live-read-manifest.ts`
- Modify: `apps/server-pilot/scripts/hms-live-login-probe.ts`
- Modify: `apps/server-pilot/tests/helpers/hms-fixture-server.ts`
- Test: `apps/server-pilot/tests/hms-runtime.test.ts`
- Test: `apps/server-pilot/tests/hms-live-read-manifest.test.ts`
- Test: `apps/server-pilot/tests/hms-request-policy.test.ts`
- Modify: `apps/server-pilot/package.json`
- Modify: `pnpm-lock.yaml`

**Consumes:** `HmsWorkerRuntimeConfig`, `HmsReadRoleProofV1`.

**Produces:**

```typescript
type ExactReservationCandidate =
  | { id: string; kind: 'confirmation'; value: string }
  | { id: string; kind: 'external_reference'; value: string };

type GuestStaySearchResult =
  | { outcome: 'not_found'; observations: []; capped: false }
  | { outcome: 'matched'; observations: [ReservationObservation]; capped: false }
  | {
      outcome: 'ambiguous';
      observations: ReservationObservation[];
      capped: boolean;
    };

interface LiveGuestStayDriver {
  loginAndVerifyBinding(signal: AbortSignal): Promise<void>;
  runNotFoundCanary(signal: AbortSignal): Promise<void>;
  searchExact(
    candidate: ExactReservationCandidate,
    signal: AbortSignal,
  ): Promise<GuestStaySearchResult>;
}

function createProductionHmsRuntime(
  config: HmsWorkerRuntimeConfig,
): Promise<HmsRuntime>;
```

- [ ] **Step 1: Write failing live-shaped fixture tests.**

  Fixture must expose observed Infor login field names, Guest Stay navigation, `ff_confirmationnumber`, `OSRESS.search`, property/title binding, correlated response completion, stale prior-grid rows, and no-results UI.

- [ ] **Step 2: Write failing request-policy tests.**

  Assert exact origin/method/path/resource/query/body/redirect/size. For search, construct a per-session rule whose confirmation/external-reference body value exactly equals the selected candidate. Altered value, extra key, alias/operator drift, or mutation path must block before transmission.

- [ ] **Step 3: Write failing browser guard tests.**

  Cover:

  - `BrowserContext.routeWebSocket()` installed before first navigation;
  - popup closes and terminalizes context;
  - download cancels and terminalizes context;
  - unreviewed redirect blocks;
  - abort/timeout closes context;
  - role proof revalidates before context creation;
  - one Chromium process serves sequential fresh contexts.

- [ ] **Step 4: Run RED tests.**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run \
  tests/hms-runtime.test.ts \
  tests/hms-live-read-manifest.test.ts \
  tests/hms-request-policy.test.ts
```

Expected: missing production composition, exact-value binding, and pre-connect WebSocket block fail.

- [ ] **Step 5: Add minimal page/runtime primitives.**

  Add only fill, press, response correlation, URL/title read, stable DOM evaluation, and pre-connect WebSocket rejection. Keep generic evaluate/URL input unavailable to model code.

- [ ] **Step 6: Make Playwright runtime-required.**

  Pin Playwright `1.52.0` as a runtime dependency. Production composition imports it directly and fails startup when compatible Chromium is absent. Fixture tests retain injectable browser factory; production has no mock fallback.

- [ ] **Step 7: Consolidate driver and manifest.**

  Move login, binding, Guest Stay navigation, exact search, and not-found canary from probe-only code into `LiveGuestStayDriver`. Probe and worker call the same driver and policy builders.

- [ ] **Step 8: Implement safe health/circuit behavior.**

  Health output uses fixed enums/counters, atomic mode-0600 writes, 10-second heartbeat, and 30-second stale threshold. Auth, binding, role, policy, and schema failures stay quiesced; transient browser/network failure gets one bounded retry.

- [ ] **Step 9: Run GREEN tests and build.**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run \
  tests/hms-runtime.test.ts \
  tests/hms-live-read-manifest.test.ts \
  tests/hms-request-policy.test.ts
pnpm --dir apps/server-pilot run build
```

Expected: all pass.

- [ ] **Step 10: Fresh review.**

  Review Task 2 for request-policy and lifecycle correctness, then run `ponytail-review`. Fix findings and rerun Step 9.

---

## Task 3: Fingerprint one live row and build reservation-only tool session

**Files:**

- Modify: `apps/server-pilot/src/hms/live-guest-stay-driver.ts`
- Create: `apps/server-pilot/src/hms/reservation-candidate-session.ts`
- Create: `apps/server-pilot/src/ops/hms-live-proof.ts`
- Create: `apps/server-pilot/evals/hms/live-guest-stay-row-fingerprint.v1.json`
- Modify: `apps/server-pilot/src/hms/contracts.ts`
- Modify: `apps/server-pilot/src/ai/candidate-draft-agent.ts`
- Modify: `apps/server-pilot/src/ai/drafts.ts`
- Modify: `apps/server-pilot/src/ai/thread-context.ts`
- Test: `apps/server-pilot/tests/hms-live-guest-stay.test.ts`
- Test: `apps/server-pilot/tests/hms-candidate-agent.test.ts`
- Test: `apps/server-pilot/tests/hms-thread-context.test.ts`

**Consumes:** `LiveGuestStayDriver`, `ExactReservationCandidate`.

**Produces:**

`CandidateToolId` / fixture session types may still name `hms_quote_stay` and `mail_read_artifact` for existing fixture compatibility only. This plan never registers or calls them in production shadow. `createReservationCandidateSession()` sets `activeToolIds = {'hms_find_reservation'}` only.

```typescript
type LiveGuestStayRowFingerprintV1 = {
  schemaVersion: 1;
  selectorKeys: string[];
  columnKeys: string[];
  manifestSha256: string;
  valuesCaptured: false;
};

function createCandidateTools(session: CandidateToolSession): CandidateToolsBundle;

function createReservationCandidateSession(input: {
  driver: LiveGuestStayDriver;
  candidates: ReadonlyMap<string, ExactReservationCandidate>;
  close: () => Promise<void>;
}): CandidateToolSession; // activeToolIds === {'hms_find_reservation'} only
```

- [ ] **Step 1: Write sanitizer and parser RED tests.**

  Use synthetic guest names, emails, confirmation values, and dates. Assert fingerprint output contains selector/column structure only—no result cardinality, value, text, HTML, screenshot, trace, or value-derived hash.

- [ ] **Step 2: Add parser cases.**

  Cover zero row, one exact active row, cancelled/unknown status, duplicate exact rows, unrelated rows, more than 20 rows, missing cells, stale grid, failed correlated response, and abort.

- [ ] **Step 3: Restrict production candidates and tools.**

  Add tests proving:

  - only `confirmation` and `external_reference` candidates enter live session;
  - `surname_dates` returns `manual_required` before browser creation;
  - active production tool IDs equal `['hms_find_reservation']`;
  - `hms_quote_stay` and `mail_read_artifact` are not registered/callable;
  - fatal runtime errors escape the gathering loop instead of the current blanket `catch`.

- [ ] **Step 4: Bump contracts.**

  Move `HMS_CANDIDATE_TOOLSET_VERSION` from `src/ai/drafts.ts` to `src/ai/candidate-draft-agent.ts`, set it and `hms_find_reservation` to `1.1.0`, and update contract tests. Shadow must not import `drafts.ts`; fixture bundles may still activate all three existing handlers explicitly.

- [ ] **Step 5: Run RED tests.**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run \
  tests/hms-live-guest-stay.test.ts \
  tests/hms-candidate-agent.test.ts \
  tests/hms-thread-context.test.ts
```

Expected: parser, active-tool allowlist, and fatal-error propagation tests fail.

- [ ] **Step 6: Implement compiled structural canary command.**

  Compile `src/ops/hms-live-proof.ts` into `dist/ops/hms-live-proof.js`; do not depend on dev-only `tsx`. Its `canary` action selects the **oldest** eligible Centurion exact candidate server-side, runs the not-found probe, records the sanitized row structure, verifies one exact row, and accepts no raw lookup value or thread/message ID through argv.

- [ ] **Step 7: Define guarded canary output.**

  Task 5 owns actual EC2 invocation after deploy. Exact outputs:

```text
Success sequence: HMS_LIVE_NOT_FOUND_OK, HMS_LIVE_ROW_FINGERPRINT_OK, HMS_LIVE_ROW_OK
No candidate: HMS_WAIT code=NO_EXACT_CANDIDATE
Safety stop: HMS_FAIL code=POLICY_BLOCK|AUTH_FAILED|PROPERTY_MISMATCH|ROLE_PROOF_MISSING|ROLE_PROOF_EXPIRED|ROLE_SCOPE_INVALID|SCHEMA_DRIFT|WEBSOCKET_BLOCKED|POPUP_BLOCKED|DOWNLOAD_BLOCKED|TRANSIENT_NETWORK|UNKNOWN_SAFE
```

  `HMS_WAIT` is a true external blocker for live-row proof. Do not broaden to guest-name search.

- [ ] **Step 8: Implement exact row correlation.**

  Parse synthetic fixtures based on structural fingerprint. Return only the candidate-correlated row as existing `ReservationReadData`; strip unrelated rows and open no detail on zero/many matches.

- [ ] **Step 9: Build reservation-only session.**

  Make `createCandidateTools()` validate that every active ID has its handler and register only `activeToolIds`. `createReservationCandidateSession()` sets exactly `['hms_find_reservation']`, binds opaque ID to server-owned exact candidate, and closes context in `finally`. Deferred methods remain absent from active tool map rather than live stubs.

- [ ] **Step 10: Run GREEN tests and build.**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run \
  tests/hms-live-guest-stay.test.ts \
  tests/hms-candidate-agent.test.ts \
  tests/hms-thread-context.test.ts
pnpm --dir apps/server-pilot run build
```

Expected: all pass.

- [ ] **Step 11: Fresh review.**

  Review Task 3 for correlation, PII minimization, and active-tool scope; run `ponytail-review`; rerun Step 10.

---

## Task 4: Wire real HMS worker and strict shadow terminal persistence

**Files:**

- Modify: `apps/server-pilot/src/ai/worker.ts`
- Modify: `apps/server-pilot/src/ai/run-ledger.ts`
- Modify: `apps/server-pilot/src/ai/candidate-draft-agent.ts`
- Create: `apps/server-pilot/src/ai/hms-shadow.ts`
- Modify: `apps/server-pilot/src/trpc/routes/ai.ts`
- Modify: `apps/server-pilot/src/trpc/routes/drafts.ts`
- Test: `apps/server-pilot/tests/ai-worker-contract.test.ts`
- Create: `apps/server-pilot/tests/hms-shadow.test.ts`
- Test: `apps/server-pilot/tests/ai-workflow-run-contract.test.ts`
- Test: `apps/server-pilot/tests/hms-candidate-state.test.ts`

**Consumes:** `createProductionHmsRuntime()`, `createReservationCandidateSession()`.

**Produces:**

```typescript
type CandidateSessionInput = {
  transportId: string;
  threadId: string;
  lookupCandidates: readonly LookupCandidate[];
  signal: AbortSignal;
};

type CandidateSessionFactory = (
  input: CandidateSessionInput,
) => Promise<CandidateToolSession>;

type HmsShadowMetrics = {
  outcome: 'candidate' | 'needs_clarification' | 'insufficient_evidence' | 'stale_thread';
  toolCalls: number;
  toolBudgetUsed: number;
  claimCount: number;
  failureClass?: AiFailureClass;
};

function finishHmsShadowRun(
  fence: AiRunFence,
  metrics: HmsShadowMetrics,
  db?: DB,
): Promise<boolean>;
```

- [ ] **Step 1: Write lane/mode RED tests.**

  Assert default lane never enters HMS branch, HMS lane claims only HMS runs, off mode claims none, enabled fails startup, and production HMS lane refuses a missing live session factory. Candidate-state and route queries must filter `executorLane='hms'`.

- [ ] **Step 2: Write freshness and lifecycle RED tests.**

  Recompute included thread state and exact candidate immediately before browser context. Manual eligibility is deterministic: canonical Centurion transport, inbound trigger, `spamAt IS NULL`, `trashedAt IS NULL`, exactly one confirmation/external-reference candidate, **oldest** `receivedAt` then message ID ordering, and a second freshness check immediately before context creation. Test stale thread, shutdown, lease loss, deadline, context close, runtime close-before-DB shutdown, and singleton browser reuse.

- [ ] **Step 3: Write strict persistence RED tests.**

  With disposable DB, snapshot Centurion-transport rows around every outcome. Assert zero delta for:

  - `aiDraftGeneration`;
  - `mailDraft`;
  - `mailDraftRevision`.

  Assert run metrics accept only the `HmsShadowMetrics` schema and `generationId` remains null.

  Add route tests proving `refreshHmsCandidate` returns fixed `HMS_MANUAL_OPS_REQUIRED` before any insert while shadow is active; it must not pre-create `aiDraftGeneration` or enqueue an unscoped HMS run.

- [ ] **Step 4: Write failure-leak RED tests.**

  Throw errors containing synthetic guest/address/reservation tokens. Assert database `lastError`, metrics, health, logs, and returned operator status contain fixed `AiFailureClass` only.

- [ ] **Step 5: Write model-boundary tests.**

  Assert the model gets bounded normalized thread text plus minimized status/claim IDs/kinds, but no raw HMS row, confirmation value, selector, DOM, evidence object, or unrelated match.

- [ ] **Step 6: Run RED DB-free tests.**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run \
  tests/ai-worker-contract.test.ts \
  tests/hms-candidate-agent.test.ts
```

Expected: current mock fallback, synchronous factory, blanket error swallowing, and raw failure persistence fail.

- [ ] **Step 7: Implement production worker composition.**

  Start one HMS runtime at HMS-worker boot. Require async live session factory. Pass only exact candidate IDs via `probeCandidateIds`, pass `probeAttachmentIds: []`, and close session in `finally`. Remove production fallback to `createMockCandidateSession()`.

- [ ] **Step 8: Implement HMS-specific safe failure writer.**

  Add `failHmsShadowRun()` that classifies once, logs redacted fixed context, and writes the enum as both `failureClass` and `lastError`. Preserve existing default-worker diagnostic behavior; only the HMS shadow branch uses fixed-only failure persistence.

- [ ] **Step 9: Implement strict shadow writer and disable the legacy refresh path.**

  `finishHmsShadowRun()` validates fixed counters, performs fenced lifecycle update, and leaves generation/draft tables untouched. Shadow branch must not import or call `persistAiCandidateDraft()`.

  In shadow mode, make `refreshHmsCandidate` fail before any database write with `HMS_MANUAL_OPS_REQUIRED`; Task 5's isolated compiled operations command is the only manual enqueue path.

- [ ] **Step 10: Run DB tests only with disposable DB.**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
test "${CONFIRM_DISPOSABLE_TEST_DB:-}" = "1"
test -n "${TEST_DATABASE_URL:-}"
CONFIRM_DISPOSABLE_TEST_DB=1 \
HMS_DB_TEST_REQUIRED=1 \
DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --dir apps/server-pilot exec vitest run \
  tests/ai-workflow-run-contract.test.ts \
  tests/ai-worker-contract.test.ts \
  tests/hms-shadow.test.ts \
  tests/hms-candidate-state.test.ts
unset DATABASE_URL
```

Expected: all pass; missing disposable URL fails before Vitest.

- [ ] **Step 11: Run build and fresh review.**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot run build
```

  Review Task 4 for fencing, cleanup, privacy, and forbidden persistence; run `ponytail-review`; rerun Steps 10-11.

---

## Task 5: Make manual EC2 proof, status, and rollback mechanical

**Files:**

- Modify: `apps/server-pilot/deploy/pm2.config.cjs`
- Modify: `apps/server-pilot/deploy/deploy-ec2.sh`
- Modify: `apps/server-pilot/deploy/ops-deploy.sh`
- Modify: `apps/server-pilot/deploy/ops-restart.sh`
- Modify: `apps/server-pilot/deploy/pm2-boot.sh`
- Modify: `apps/server-pilot/deploy/post-boot-smoke.sh`
- Modify: `apps/server-pilot/deploy/launch-readiness.sh`
- Modify: `apps/server-pilot/deploy/write-ec2-env.sh`
- Create: `apps/server-pilot/deploy/install-hms-browser.sh`
- Create: `apps/server-pilot/deploy/ops-hms-shadow.sh`
- Modify: `apps/server-pilot/src/ops/hms-live-proof.ts`
- Create: `docs/infor-hms/live-reservation-shadow-runbook.md`
- Modify: `apps/server-pilot/evals/hms/live-login-inventory.v1.json`
- Modify: `docs/superpowers/plans/handoff-reports/2026-07-30-infor-hms-read-foundation.md`
- Modify: `.superpowers/sdd/progress.md`
- Test: `apps/server-pilot/tests/deploy-config.test.ts`
- Test: `apps/server-pilot/tests/ai-worker-contract.test.ts`
- Test: `apps/server-pilot/tests/hms-shadow.test.ts`

**Produces:**

```typescript
type HmsReservationCanaryProofV1 = {
  schemaVersion: 1;
  buildCommit: string;
  manifestSha256: string;
  rowFingerprintSha256: string;
  dependencyRevision: 'playwright-1.52.0-chromium-1169';
  roleProofSha256: string;
  finishedAt: string;
  expiresAt: string; // at most 24 hours after finishedAt
};

type HmsReservationShadowProofV1 = {
  schemaVersion: 1;
  proofAttemptId: string; // server-generated UUID, never user input
  runId: string; // internal lifecycle ID only
  runningProcessCommit: string;
  processStartedAt: string;
  manifestSha256: string;
  rowFingerprintSha256: string;
  canaryProofSha256: string;
  dependencyRevision: 'playwright-1.52.0-chromium-1169';
  roleProofSha256: string;
  shadowVerified: true;
  forbiddenRowDelta: 0;
  policyBlockDelta: 0;
  finishedAt: string;
  expiresAt: string; // at most 24 hours after finishedAt
};
```

- [ ] **Step 1: Write deployment/lifecycle RED tests.**

  Assert:

  - generic deploy/restart/reboot keeps HMS off and starts default apps only;
  - `ops-hms-shadow.sh start` is the sole HMS starter;
  - HMS PM2 app uses `autorestart: false`;
  - permanent failure quiesces and never loops;
  - `start` refuses every pre-existing nonterminal HMS-lane run;
  - `stop` disables future start, aborts the active attempt, dead-letters its nonterminal proof runs, closes runtime, deletes HMS PM2 app, and verifies default services;
  - conditional HMS checks exist in post-boot and launch-readiness scripts.

- [ ] **Step 2: Write dependency RED tests.**

  `install-hms-browser.sh` must use canonical `/opt/nava` bootstrap, verify Playwright `1.52.0`, Chromium revision `1169`, and launch a headless smoke page. Bare `playwright install` is forbidden.

- [ ] **Step 3: Write CLI/proof RED tests.**

  CLI accepts exactly `canary`, `start`, `status`, `stop`. It accepts no raw candidate/thread/message argument. Define exits:

  - `0`: success token;
  - `3`: `HMS_WAIT` safe no-candidate/off state;
  - `10`: `HMS_FAIL code=` followed by one `HmsOperatorFailCode`;
  - `20`: `HMS_FAIL code=ROLLBACK_INCOMPLETE`.

  Status validates running process commit/start time, dependency revision, manifest/fingerprint, role-proof digest/expiry, health heartbeat, proof TTL, policy delta, and forbidden-row delta.

- [ ] **Step 4: Write proof-runner RED tests.**

  `dist/ops/hms-live-proof.js start` must:

  - refuse queued, claimed, running, or retry-wait HMS-lane rows;
  - generate a server-owned `proofAttemptId`;
  - select one deterministic eligible exact Centurion thread server-side;
  - snapshot Centurion-transport generation/draft/revision counts;
  - enqueue a newly inserted run with unique `idempotencyKey=hms-proof:<proofAttemptId>:<triggerMessageId>`, `executorLane='hms'`, and `generationId=null`;
  - start the worker with claim scope `idempotencyPrefix=hms-proof:<proofAttemptId>:`;
  - wait for that new run only;
  - record transport-wide numeric deltas and code-artifact identity.

  Test stale queued/retry/running rows, repeated `start`, old terminal idempotency rows, unrelated default-lane work, and rollback of an active proof attempt.

- [ ] **Step 5: Run RED tests.**

DB-free only:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run \
  tests/deploy-config.test.ts \
  tests/ai-worker-contract.test.ts
```

Any `hms-shadow` assertions that touch DB run only under Task 4 Step 10 / Verification disposable-DB gates (`CONFIRM_DISPOSABLE_TEST_DB=1`, `TEST_DATABASE_URL`, reject pilot hostnames). Never Vitest against pilot/production `DATABASE_URL`; never `VITEST_ALLOW_PILOT_RDS`.

Expected: missing explicit lifecycle, proof runner, and truthful status fail in the DB-free deploy/worker contract tests.

- [ ] **Step 6: Implement dependency bootstrap.**

  Emit `HMS_DEPENDENCIES_OK` only after exact package/browser revision and headless launch pass.

- [ ] **Step 7: Implement CLI state machine.**

  `ops-hms-shadow.sh` is a thin wrapper around `node apps/server-pilot/dist/ops/hms-live-proof.js <action>`.

  - `canary`: require HMS off and no nonterminal HMS run; validate role/build/dependencies; run not-found, sanitized fingerprint, and exact-row proof in one standalone runtime; write fresh canary proof; stop runtime.
  - `start`: require matching fresh canary proof; create one isolated proof attempt and scoped HMS worker; run one shadow candidate; leave worker idle with no automatic enqueue.
  - `status`: perform read-only validation of current worker, attempt, proof, health, and default services.
  - `stop`: prevent starts, signal worker, dead-letter remaining proof-attempt rows, close/delete HMS worker, verify defaults, then emit rollback success.

  Generic deploy/restart/reboot exports `NAVA_BUILD_COMMIT` into process env/health, starts default apps only, and invalidates canary/shadow proofs whenever build, dependency, manifest, fingerprint, or role-proof identity changes.

- [ ] **Step 8: Implement safe proof file.**

  Write `/opt/nava/shared/hms-reservation-canary-proof.v1.json` and `/opt/nava/shared/hms-reservation-shadow-proof.v1.json` atomically with mode `0600`. Do not store candidate, thread, message, guest, email, HMS, model, or evidence values.

- [ ] **Step 9: Deploy off, install browser, stage role proof, prove dependencies.**

Before canary:

1. Place `/opt/nava/shared/hms-read-role-proof.v1.json` mode `0600` with required fields from Role-proof contract (hotel-admin **or** operator-observed runtime attestation). `ROLE_PROOF_*` failures must print expected `roleProofPath`.
2. Run browser bootstrap, then off-status:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/install-hms-browser.sh'
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ops-hms-shadow.sh status'
```

```text
Expected: HMS_DEPENDENCIES_OK
Expected: HMS_OFF_READY
```

`install-hms-browser.sh` is a hard canary precondition (also wire into deploy/post-boot if that path exists). Confirm `AI_DRAFTS_ENABLED=false`, no HMS PM2 app, and default HTTP/mail/ingest/AI processes healthy. Ship runbook Install section before first canary, not only post-proof.

- [ ] **Step 10: Run guarded live canaries in order.**

From laptop, each action runs through the existing SSM wrapper; the remote command is purpose-built operations code, never a test runner:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ops-hms-shadow.sh canary'
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ops-hms-shadow.sh start'
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ops-hms-shadow.sh status'
```

```text
HMS_LIVE_NOT_FOUND_OK
HMS_LIVE_ROW_FINGERPRINT_OK
HMS_LIVE_ROW_OK
HMS_SHADOW_OK
```

  Stop at first `HMS_WAIT` or `HMS_FAIL`. Never broaden lookup or bypass a policy block.

- [ ] **Step 11: Verify status and rollback.**

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/ops-hms-shadow.sh stop'
```

```text
status success: HMS_SHADOW_VERIFIED
stop success: HMS_ROLLBACK_OK
```

  Confirm zero Centurion-transport generation/draft/revision delta, zero policy-block delta, no raw values in SSM output, and healthy default services after HMS worker deletion.

- [ ] **Step 12: Update durable evidence and runbook.**

  Document exact proven scope, fixed failure-code recovery commands, role/proof expiry, and deferred tool sequence. Do not describe this as an all-tools or write-capable production agent.

- [ ] **Step 13: Final reviews and fresh verification.**

  Run whole-plan correctness review, `ponytail-review`, production-boundary audit, and all Verification Contract commands from a clean shell. Fix every Critical/Important finding.

---

## Verification Contract

### DB-free gates

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm --dir apps/server-pilot exec vitest run \
  tests/env.test.ts \
  tests/deploy-config.test.ts \
  tests/hms-request-policy.test.ts \
  tests/hms-live-read-manifest.test.ts \
  tests/hms-runtime.test.ts \
  tests/hms-live-guest-stay.test.ts \
  tests/hms-thread-context.test.ts \
  tests/hms-candidate-agent.test.ts \
  tests/hms-production-boundary.test.ts \
  tests/ai-worker-contract.test.ts
pnpm --dir apps/server-pilot run build
bash apps/server-pilot/deploy/hms-read-gate.sh --fixture-only
git diff --check
```

Expected: all pass; no DB connection, production env source, or live HMS request.

### Disposable-DB gates

Run only after independently verifying `TEST_DATABASE_URL` is disposable and non-production:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
test "${CONFIRM_DISPOSABLE_TEST_DB:-}" = "1"
test -n "${TEST_DATABASE_URL:-}"
CONFIRM_DISPOSABLE_TEST_DB=1 \
HMS_DB_TEST_REQUIRED=1 \
DATABASE_URL="$TEST_DATABASE_URL" \
pnpm --dir apps/server-pilot exec vitest run \
  tests/ai-workflow-run-contract.test.ts \
  tests/ai-worker-contract.test.ts \
  tests/hms-shadow.test.ts \
  tests/hms-candidate-state.test.ts
unset DATABASE_URL
```

Expected: lifecycle writes pass; forbidden business-table deltas remain zero.

### Live read-only gates

Live proof runs only through purpose-built scripts after role proof and local gates:

```text
HMS_DEPENDENCIES_OK
HMS_OFF_READY
HMS_LIVE_NOT_FOUND_OK
HMS_LIVE_ROW_FINGERPRINT_OK
HMS_LIVE_ROW_OK
HMS_SHADOW_OK
HMS_SHADOW_VERIFIED
HMS_ROLLBACK_OK
```

Expected: exact HRCEN binding, zero policy blocks, zero mutation requests, zero forbidden-row delta, no raw values in output/artifacts, and healthy default services after rollback.

---

## Definition of Done

- [x] Task 1 restores date-independent, production-env-free safety gates.
- [x] Literal HMS `enabled` is mechanically rejected everywhere.
- [x] Current role proof (hotel-admin or operator-observed) authorizes Guest Stay read and explicitly denies listed mutations.
- [x] Production runtime requires Playwright and has no mock fallback.
- [x] Probe and worker use one canonical live Guest Stay driver and request manifest.
- [x] Search request values are exact and session-bound.
- [x] Successful-row fingerprint stores structure only with `valuesCaptured: false`.
- [x] Production active tool set contains only `hms_find_reservation` version `1.1.0`.
- [x] HMS worker owns one browser, fresh contexts, bounded retry, cleanup, and truthful health.
- [x] Fatal runtime errors are not swallowed; persisted failures are fixed enums only.
- [x] Shadow creates no `aiDraftGeneration`, `mailDraft`, or `mailDraftRevision`.
- [x] Legacy `refreshHmsCandidate` cannot create a generation or unscoped HMS run in shadow.
- [x] No HMS value, model output, evidence, candidate/claim ID, business-content hash, DOM, or free-form error persists.
- [x] One manual live reservation shadow run passes with zero policy-block and forbidden-row deltas.
- [x] Manual proof refuses pre-existing nonterminal HMS runs and claims only its server-generated attempt prefix.
- [x] Status binds running process, build, dependencies, manifest, fingerprint, role proof, health, and proof TTL.
- [x] Rollback leaves default services healthy and HMS worker absent.
- [x] Artifact, quote, document-list, folio/sent-email, group/event/company/preferences, auto-enqueue, write adapters, enabled mode, and live writes remain deferred; this plan ships only `hms_find_reservation`.
- [x] PII-bearing untracked analysis indexes remain untracked and are removed before any later commit.
- [x] No open Critical or Important correctness, safety, DevEx, or simplicity review finding remains.
