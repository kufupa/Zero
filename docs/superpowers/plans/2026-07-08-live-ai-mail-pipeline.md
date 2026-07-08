# Live AI Mail Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and ship the production-shaped AI mail loop: Mailpit ingest -> Bedrock triage -> gated durable categories -> Bedrock skeleton candidate draft -> browser-visible Inbox/category/thread proof.

**Architecture:** Keep model work in Mastra workflows and product writes in `ai-worker`. Use `ai_workflow_run` as the durable queue and idempotency ledger. Keep live Bedrock gates opt-in; daily evals stay fake and deterministic.

**Tech Stack:** TypeScript, Vitest, Playwright, Drizzle/Postgres, Mastra workflows, AWS Bedrock Converse, Mailpit, PM2.

## Global Constraints

- No autonomous sending. `ai-worker` must not import SMTP/POP3 send-capable modules or receive SMTP/POP3 secrets.
- One primary triage category only: `internal`, `individual`, `group`, `travel-agents`, or `spam`.
- `urgent` is optional overlay, not a primary category.
- Inbox visibility must not depend on AI success.
- Existing spam state must not be cleared by a non-spam AI result unless the implementation can prove AI created that spam state. V1 does not track that provenance, so non-spam triage leaves existing `spamAt` untouched.
- Recipient and subject fields for candidate drafts are code-derived from the trigger message, never model-generated.
- `AI_WRITE_GATE_ENABLED` and `AI_DRAFTS_ENABLED` default false.
- `NODE_ENV=test` always uses `FakeModelAdapter`.
- Live Bedrock gates are opt-in and must not become daily deploy gates.
- Local validation remains mandatory even when Bedrock structured output is enabled.
- Run completion updates must be claim-fenced: a stale original worker must not mark success after a reclaimed worker takes ownership.
- Every task below starts with failing tests and ends with a runnable verification command.

---

## File Structure

**Create**
- `apps/server-pilot/src/ai/categories.ts` — single source of truth for AI-managed category slugs, seed rows, and replacement behavior.
- `apps/server-pilot/src/ai/workflows/candidate-draft.ts` — Mastra workflow that calls `ModelAdapter` and returns validated skeleton draft fields.
- `apps/server-pilot/tests/ai-candidate-draft-contract.test.ts` — candidate draft workflow and persistence contract.
- `packages/testing/e2e/ai-mail-pipeline.spec.ts` — browser-visible live proof.
- `apps/server-pilot/deploy/ai-mail-pipeline-live-gate.sh` — opt-in EC2 gate composing Mailpit, worker, ai-worker, Bedrock, and Playwright.

**Modify**
- `apps/server-pilot/src/env.ts` — parse `AI_WRITE_GATE_ENABLED`, `AI_DRAFTS_ENABLED`, optional stale run timeout.
- `apps/server-pilot/deploy/pm2.config.cjs` — pass AI gates to `ai-worker` without mail secrets.
- `apps/server-pilot/src/db/seed.ts` — seed AI-managed categories idempotently.
- `apps/server-pilot/src/ai/triage.ts` — preserve non-AI category rows and expose durable write semantics.
- `apps/server-pilot/src/ai/workflows/mail-triage.ts` — return validated `output`, metrics, and trace id.
- `apps/server-pilot/src/ai/mastra.ts` — register `candidateDraft` workflow.
- `apps/server-pilot/src/ai/worker.ts` — apply durable triage, enqueue candidate draft, execute draft workflow, and mark runs atomically/idempotently.
- `apps/server-pilot/src/ai/run-ledger.ts` — add transaction-aware, claim-fenced mark helpers plus stale run reclaim.
- `apps/server-pilot/src/ai/bedrock/bedrock.ts` — add structured-output request shape only if installed SDK supports it.
- `apps/mail/app/(routes)/mail/[folder]/page.tsx` — validate routes against live categories as well as labels.
- `apps/mail/components/mail/thread-display.tsx` — add stable selector to AI draft card.
- `packages/testing/e2e/helpers/mail-inbox.ts` — add helpers for live category route and AI draft assertions.
- `apps/server-pilot/src/ai/eval-runner.ts` — add draft skeleton and failure no-mutation eval cases.
- `docs/server-pilot-ai.md` — document flags, gate order, rollback, and failure diagnosis.

---

## Start Here If You Have Zero Context

Read this section before touching code. The rest of the plan assumes these facts.

### Product Goal

We are proving a production-shaped AI mail pipeline for a hotel mailbox:

```text
Mailpit SMTP fixture
  -> POP3 ingest worker
  -> Postgres thread/message rows
  -> ai_workflow_run: inbound_triage
  -> ai-worker runs Mastra mail-triage workflow
  -> Bedrock/FakeModelAdapter returns strict triage JSON
  -> worker optionally writes category rows
  -> worker optionally enqueues ai_workflow_run: candidate_draft
  -> ai-worker runs Mastra candidate-draft workflow
  -> Bedrock/FakeModelAdapter returns skeleton draft body JSON
  -> worker persists mail_draft status=candidate origin=ai
  -> browser shows thread in Inbox, category route, and AI draft card
```

This is not a feature for sending mail. It is a proof that real ingest, real LLM calls, durable triage, draft generation, and UI visibility all connect.

### Vocabulary

- **Transport:** one mailbox identity, stored in `mailbox_transport`. Pilot transport is usually `transport-centurion`.
- **Thread:** `mail_thread` row. Inbox visibility comes from folder filters on this row plus messages.
- **Message:** `message` row. Ingest creates inbound messages.
- **AI run:** `ai_workflow_run` row. This is the durable queue for `inbound_triage`, `candidate_draft`, and `feedback_extraction`.
- **Shadow triage:** model classification stored only in AI run metrics. No product state changes.
- **Durable triage:** category/spam state written to `mail_thread` and `mail_thread_category`.
- **Candidate draft:** `mail_draft.status='candidate'` and `origin='ai'`. It is read-only until promoted by existing draft code.
- **Primary category:** one of `internal`, `individual`, `group`, `travel-agents`, or `spam`.
- **Overlay category:** `urgent`. It can exist alongside one primary category.

### Current Code Map

Use these existing surfaces. Do not build parallel versions.

```text
apps/server-pilot/src/mail/ingest/store.ts
  persistInboundMessage(...)
    already stores inbound mail and enqueues inbound_triage.

apps/server-pilot/src/ai/run-ledger.ts
  enqueueAiRun(...)
    already inserts AI runs with idempotencyKey.
  claimNextAiRun(...)
    currently claims queued/retry_wait only.
  markAiRunSucceeded/Retry/DeadLetter(...)
    currently update by id only; this plan makes them claim-fenced.

apps/server-pilot/src/ai/worker.ts
  executeAiRun(runId)
    currently runs inbound_triage and marks success.
    currently hardcodes candidate_draft text.

apps/server-pilot/src/ai/workflows/mail-triage.ts
  mailTriageWorkflow
    currently calls createModelAdapter(), validates model JSON, returns shadow metrics.

apps/server-pilot/src/ai/triage.ts
  validateTriageOutput(...)
  applyShadowTriageResult(...)
  applyDurableTriageResult(...)
    currently deletes all thread categories; must change to AI-managed-only.

apps/server-pilot/src/ai/drafts.ts
  persistAiCandidateDraft(...)
    already creates ai_draft_generation, mail_draft, mail_draft_revision.

apps/server-pilot/src/ai/bedrock/
  adapter.ts, fake.ts, bedrock.ts, factory.ts
    model abstraction. NODE_ENV=test must stay fake.

apps/server-pilot/src/db/schema/mail.ts
  mailCategory, mailThreadCategory, mailThread, message, aiWorkflowRun,
  aiDraftGeneration, mailDraft, mailDraftRevision already exist.
  No schema migration should be needed for this plan.

apps/server-pilot/src/trpc/routes/mail.ts
  mail.listThreads already supports filters.categoryIds.
  mail.get already returns active + candidate drafts in drafts array.

apps/server-pilot/src/trpc/routes/drafts.ts
  existing candidate promotion logic already promotes newest AI candidate when no active draft exists.

apps/mail/lib/mail/route-filter.ts
  resolveMailRouteFilter(folder, categoryBySlug)
    already maps category slugs to folder='inbox' + filters.categoryIds.

apps/mail/hooks/use-categories.ts
  useCategorySettings()
    already fetches live categories but does not expose loading/settled state.

apps/mail/app/(routes)/mail/[folder]/page.tsx
  currently validates unknown routes against labels only.

apps/mail/components/mail/thread-display.tsx
  already renders AI candidate cards with draftBadge="AI draft".
```

### Existing Test Conventions

Use Vitest for `apps/server-pilot`:

```bash
pnpm --dir apps/server-pilot test tests/<file>.test.ts --reporter=dot
```

Use Playwright from `packages/testing`:

```bash
pnpm --dir packages/testing exec playwright test <spec>.ts --reporter=line
```

DB tests are allowed to skip locally. They run only when `DATABASE_URL` exists and the DB is reachable:

```ts
const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('...', () => {
  it('...', async () => {
    await withSeededTestDb(async (db) => {
      // seeded pilot data exists inside rollback transaction
    });
  });
});
```

Use these helpers:

```ts
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
  withTestDb,
} from './helpers/test-db.js';

import { callerFor } from './helpers/trpc-caller.js';
```

Important: `withSeededTestDb` runs `seedAll(db)` inside a transaction and always rolls back. Safe for RDS-backed contract tests.

### Minimal Env Test Fixture

If adding multiple env tests, define this helper in `apps/server-pilot/tests/env.test.ts` to avoid copy-paste drift:

```ts
function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    PORT: '8788',
    DATABASE_URL: 'postgres://zero:secret@host:5432/zero',
    BETTER_AUTH_URL: 'https://nava.legacy.local',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    AWS_REGION: 'af-south-1',
    S3_BUCKET: 'nava-mail-artifacts-test',
    POP3_POLL_INTERVAL_MS: '30000',
    POP3_MAX_MESSAGES_PER_CYCLE: '500',
    ...overrides,
  };
}
```

### Safe Implementation Order

Do not parallelize the first three tasks. They share types and execution contracts.

```text
1. Task 1: env + category source of truth
2. Task 2: triage workflow output contract
3. Task 3: worker durable commit + claim fencing
4. Task 4 and Task 5 can run after Task 3, but coordinate `worker.ts`
5. Task 6 live gate after Tasks 3-5
6. Task 7 evals after Task 4 schemas exist
7. Task 8 docs last
```

### Hard Rules For The Implementer

- Do not let the LLM choose `toAddresses`, `ccAddresses`, `bccAddresses`, or `subject`.
- Do not clear `mailThread.spamAt` on a non-spam AI result unless this branch also adds provenance proving AI set it.
- Do not update `ai_workflow_run` terminal state without checking `claimOwner` and expected state.
- Do not add SMTP/POP3 env keys to `ai-worker`.
- Do not make live Bedrock part of default daily gates.
- Do not add a DB migration unless you can prove existing schema cannot express the needed state.
- Do not add hosted observability envs; `parseEnv` rejects those when AI is enabled.
- Do not silently ignore missing AI category rows. Throw or mark run retry/dead-letter with metrics.

### Quick Smoke Commands Before You Start

These should run or skip cleanly before implementation:

```bash
pnpm --dir apps/server-pilot test tests/env.test.ts --reporter=dot
pnpm --dir apps/server-pilot test tests/ai-triage-contract.test.ts --reporter=dot
pnpm --dir apps/server-pilot test tests/bedrock-adapter-contract.test.ts --reporter=dot
```

If DB is unreachable, DB-backed suites should skip. That is OK locally. EC2/RDS gate must run them.

---

## Task 1: AI Gates And Category Ownership

**Files:**
- Create: `apps/server-pilot/src/ai/categories.ts`
- Modify: `apps/server-pilot/src/env.ts`
- Modify: `apps/server-pilot/deploy/pm2.config.cjs`
- Modify: `apps/server-pilot/src/db/seed.ts`
- Test: `apps/server-pilot/tests/env.test.ts`
- Test: `apps/server-pilot/tests/seed-contract.test.ts`
- Test: `apps/server-pilot/tests/ai-triage-contract.test.ts`

**Interfaces:**
- Produces: `AI_MANAGED_CATEGORY_SLUGS`, `AI_PRIMARY_CATEGORY_SLUGS`, `AI_OVERLAY_CATEGORY_SLUGS`, `isAiManagedCategorySlug(slug: string): boolean`.
- Produces env fields: `AI_WRITE_GATE_ENABLED: boolean`, `AI_DRAFTS_ENABLED: boolean`, `AI_STALE_RUN_TIMEOUT_MS: number`.
- Consumed by Tasks 2, 3, 4, 7.

- [ ] **Step 1: Write failing env tests**

Add tests asserting these exact parse results:

```ts
expect(parseEnv(baseEnv()).AI_WRITE_GATE_ENABLED).toBe(false);
expect(parseEnv(baseEnv()).AI_DRAFTS_ENABLED).toBe(false);
expect(parseEnv({ ...baseEnv(), AI_WRITE_GATE_ENABLED: '1', AI_DRAFTS_ENABLED: 'true' })).toMatchObject({
  AI_WRITE_GATE_ENABLED: true,
  AI_DRAFTS_ENABLED: true,
});
expect(() => parseEnv({ ...baseEnv(), AI_WRITE_GATE_ENABLED: 'yes' })).toThrow(/AI_WRITE_GATE_ENABLED/);
```

- [ ] **Step 2: Run env test and confirm failure**

Run: `pnpm --dir apps/server-pilot test tests/env.test.ts --reporter=dot`

Expected: FAIL because parsed env lacks new fields.

- [ ] **Step 3: Add category ownership module**

Create `apps/server-pilot/src/ai/categories.ts`:

```ts
export const AI_PRIMARY_CATEGORY_SLUGS = [
  'internal',
  'individual',
  'group',
  'travel-agents',
] as const;

export const AI_OVERLAY_CATEGORY_SLUGS = ['urgent'] as const;

export const AI_MANAGED_CATEGORY_SLUGS = [
  ...AI_PRIMARY_CATEGORY_SLUGS,
  ...AI_OVERLAY_CATEGORY_SLUGS,
] as const;

export type AiPrimaryCategorySlug = (typeof AI_PRIMARY_CATEGORY_SLUGS)[number];
export type AiOverlayCategorySlug = (typeof AI_OVERLAY_CATEGORY_SLUGS)[number];
export type AiManagedCategorySlug = (typeof AI_MANAGED_CATEGORY_SLUGS)[number];

const AI_MANAGED_CATEGORY_SET = new Set<string>(AI_MANAGED_CATEGORY_SLUGS);

export function isAiManagedCategorySlug(slug: string): slug is AiManagedCategorySlug {
  return AI_MANAGED_CATEGORY_SET.has(slug);
}

export const AI_MANAGED_CATEGORY_SEED_ROWS: Array<{
  slug: AiManagedCategorySlug;
  name: string;
  sortOrder: number;
  color: string;
}> = [
  { slug: 'internal', name: 'Internal', sortOrder: 100, color: '#64748b' },
  { slug: 'individual', name: 'Individual', sortOrder: 110, color: '#2563eb' },
  { slug: 'group', name: 'Group Bookings', sortOrder: 120, color: '#7c3aed' },
  { slug: 'travel-agents', name: 'Travel Agents', sortOrder: 130, color: '#0891b2' },
  { slug: 'urgent', name: 'Urgent', sortOrder: 10, color: '#dc2626' },
];
```

- [ ] **Step 4: Parse env gates**

Update `MailEnv` and `parseEnv()` so defaults are false:

```ts
AI_WRITE_GATE_ENABLED: boolean;
AI_DRAFTS_ENABLED: boolean;
AI_STALE_RUN_TIMEOUT_MS: number;
```

Use `toBool()` when present:

```ts
env.AI_WRITE_GATE_ENABLED = input.AI_WRITE_GATE_ENABLED
  ? toBool('AI_WRITE_GATE_ENABLED', input.AI_WRITE_GATE_ENABLED)
  : false;
env.AI_DRAFTS_ENABLED = input.AI_DRAFTS_ENABLED
  ? toBool('AI_DRAFTS_ENABLED', input.AI_DRAFTS_ENABLED)
  : false;
env.AI_STALE_RUN_TIMEOUT_MS = input.AI_STALE_RUN_TIMEOUT_MS
  ? toInt('AI_STALE_RUN_TIMEOUT_MS', input.AI_STALE_RUN_TIMEOUT_MS)
  : 15 * 60_000;
```

- [ ] **Step 5: Seed categories idempotently**

In `seedAll`, seed every active transport visible during the seed run. This prevents live transports from silently missing category rows.

```ts
const activeTransportRows = await db
  .select({ id: mailboxTransport.id })
  .from(mailboxTransport)
  .where(eq(mailboxTransport.isActive, true));

for (const transport of activeTransportRows) {
  await seedAiManagedCategories(db, transport.id);
}
```

Implement:

```ts
async function seedAiManagedCategories(db: DB, transportId: string) {
  for (const row of AI_MANAGED_CATEGORY_SEED_ROWS) {
    await db
      .insert(mailCategory)
      .values({
        id: `category-${transportId}-${row.slug}`,
        transportId,
        slug: row.slug,
        name: row.name,
        color: row.color,
        sortOrder: row.sortOrder,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [mailCategory.transportId, mailCategory.slug],
        set: {
          name: row.name,
          color: row.color,
          sortOrder: row.sortOrder,
          isActive: true,
          updatedAt: new Date(),
        },
      });
  }
}
```

- [ ] **Step 6: Keep ai-worker no-send**

Update `pm2.config.cjs` to pass only:

```js
AI_ENABLED: process.env.AI_ENABLED ?? 'true',
AI_WRITE_GATE_ENABLED: process.env.AI_WRITE_GATE_ENABLED ?? 'false',
AI_DRAFTS_ENABLED: process.env.AI_DRAFTS_ENABLED ?? 'false',
AI_MODEL_ID: process.env.AI_MODEL_ID ?? 'amazon.nova-lite-v1:0',
BEDROCK_REGION: process.env.BEDROCK_REGION ?? 'us-east-1',
```

Do not add `SMTP_*` or `POP3_*` to `ai-worker`.

- [ ] **Step 7: Run task tests**

Run:

```bash
pnpm --dir apps/server-pilot test tests/env.test.ts tests/seed-contract.test.ts tests/ai-triage-contract.test.ts --reporter=dot
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server-pilot/src/ai/categories.ts apps/server-pilot/src/env.ts apps/server-pilot/deploy/pm2.config.cjs apps/server-pilot/src/db/seed.ts apps/server-pilot/tests/env.test.ts apps/server-pilot/tests/seed-contract.test.ts apps/server-pilot/tests/ai-triage-contract.test.ts
git commit -m "feat: add ai mail pipeline gates and categories"
```

---

## Task 2: Triage Workflow Output Contract

**Files:**
- Modify: `apps/server-pilot/src/ai/triage.ts`
- Modify: `apps/server-pilot/src/ai/workflows/mail-triage.ts`
- Modify: `apps/server-pilot/src/ai/bedrock/bedrock.ts`
- Test: `apps/server-pilot/tests/ai-triage-contract.test.ts`
- Test: `apps/server-pilot/tests/bedrock-adapter-contract.test.ts`
- Test: `apps/server-pilot/tests/ai-security-contract.test.ts`

**Interfaces:**
- Consumes: `AI_PRIMARY_CATEGORY_SLUGS` from Task 1.
- Produces workflow result shape:

```ts
{
  output: TriageOutput;
  shadow: { category: string; urgent: boolean; confidence: number; rationale: string };
  metrics: Record<string, unknown>;
  traceId: string;
}
```

- [ ] **Step 1: Write failing workflow contract test**

Assert `mailTriageWorkflow` returns `result.result.output.category`, not only `shadow.category`.

```ts
expect(result.status).toBe('success');
expect(result.result?.output).toMatchObject({
  category: 'group',
  urgent: expect.any(Boolean),
  confidence: expect.any(Number),
});
expect(result.result?.metrics).toMatchObject({ shadow: true });
```

- [ ] **Step 2: Run contract test and confirm failure**

Run: `pnpm --dir apps/server-pilot test tests/ai-triage-contract.test.ts --reporter=dot`

Expected: FAIL because workflow result lacks `output`.

- [ ] **Step 3: Update triage category constants**

In `triage.ts`, import `AI_PRIMARY_CATEGORY_SLUGS` and define:

```ts
export const TRIAGE_CATEGORIES = [...AI_PRIMARY_CATEGORY_SLUGS, 'spam'] as const;
```

- [ ] **Step 4: Update `mail-triage` output schema**

There are two similarly named schemas: `apps/server-pilot/src/ai/triage.ts` exports shared triage output validation, and `apps/server-pilot/src/ai/workflows/mail-triage.ts` defines workflow output. Edit the workflow-level schema in `mail-triage.ts`. Rename it to `mailTriageWorkflowOutputSchema` so the worker output contract is unambiguous.

Add `output` to the workflow-level schema:

```ts
output: z.object({
  category: z.enum(TRIAGE_CATEGORIES),
  urgent: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  policyFlags: z.array(z.string()),
}),
```

Return the validated `output` from `classifyStep`. The worker must read `result.result.output`; tests should fail if Mastra strips this field.

- [ ] **Step 5: Bedrock structured output contract**

If `ConverseCommandInput` accepts `outputConfig`, use:

```ts
commandInput.outputConfig = {
  textFormat: {
    type: 'json_schema',
    structure: {
      jsonSchema: {
        schema: JSON.stringify(input.responseSchema),
        name: input.schemaName ?? 'mail_ai_output',
        description: 'Structured output for server-pilot mail AI',
      },
    },
  },
} as ConverseCommandInput['outputConfig'];
```

If SDK types do not expose `outputConfig`, keep current `additionalModelRequestFields` fallback and add test coverage documenting why.

- [ ] **Step 6: Keep local validation mandatory**

Do not remove `parseModelJson()`, `validateStructuredJsonOutput()`, or Zod `validateTriageOutput()`.

- [ ] **Step 7: Run task tests**

Run:

```bash
pnpm --dir apps/server-pilot test tests/ai-triage-contract.test.ts tests/bedrock-adapter-contract.test.ts tests/ai-security-contract.test.ts --reporter=dot
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server-pilot/src/ai/triage.ts apps/server-pilot/src/ai/workflows/mail-triage.ts apps/server-pilot/src/ai/bedrock/bedrock.ts apps/server-pilot/tests/ai-triage-contract.test.ts apps/server-pilot/tests/bedrock-adapter-contract.test.ts apps/server-pilot/tests/ai-security-contract.test.ts
git commit -m "feat: return validated ai triage output"
```

---

## Task 3: Durable Triage Commit And Draft Enqueue

**Files:**
- Modify: `apps/server-pilot/src/ai/triage.ts`
- Modify: `apps/server-pilot/src/ai/run-ledger.ts`
- Modify: `apps/server-pilot/src/ai/worker.ts`
- Test: `apps/server-pilot/tests/ai-worker-contract.test.ts`
- Test: `apps/server-pilot/tests/ai-enqueue-contract.test.ts`
- Test: `apps/server-pilot/tests/ai-workflow-run-contract.test.ts`

**Interfaces:**
- Consumes: Task 1 gates and Task 2 workflow result.
- Produces: triage success can atomically write categories, enqueue draft, and mark run succeeded.
- Produces fenced ledger helpers: mark/retry/dead-letter calls only affect rows still owned by the executing worker.

- [ ] **Step 1: Write failing preservation test**

Seed thread with a custom category plus `group`. Durable triage to `individual` must remove only AI-managed category rows and keep custom row.

```ts
expect(categorySlugsAfter).toEqual(expect.arrayContaining(['custom-vip', 'individual']));
expect(categorySlugsAfter).not.toContain('group');
```

- [ ] **Step 2: Write failing worker commit tests**

Add cases:
- shadow mode: no category rows and no `candidate_draft`.
- write+draft mode: category row plus one `candidate_draft`.
- retry same triage: still one `candidate_draft`.
- spam: `spamAt` set and zero `candidate_draft`.
- already-spam thread plus non-spam AI output: `spamAt` stays set and no draft is enqueued.
- stale reclaim: original owner cannot mark success after another owner reclaims the row.

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
pnpm --dir apps/server-pilot test tests/ai-triage-contract.test.ts tests/ai-worker-contract.test.ts tests/ai-enqueue-contract.test.ts --reporter=dot
```

Expected: FAIL because worker does not apply durable writes or enqueue drafts.

- [ ] **Step 4: Preserve non-AI categories**

Update `applyDurableTriageResult` to delete only category memberships whose joined category slug is AI-managed.

Implementation shape:

```ts
const aiManagedRows = await db
  .select({ categoryId: mailCategory.id })
  .from(mailCategory)
  .where(and(eq(mailCategory.transportId, transportId), inArray(mailCategory.slug, AI_MANAGED_CATEGORY_SLUGS)));

const aiManagedIds = aiManagedRows.map((row) => row.categoryId);
if (aiManagedIds.length > 0) {
  await db.delete(mailThreadCategory).where(
    and(
      eq(mailThreadCategory.threadId, threadId),
      eq(mailThreadCategory.transportId, transportId),
      inArray(mailThreadCategory.categoryId, aiManagedIds),
    ),
  );
}
```

For `spam`, also remove AI-managed memberships and set `spamAt`.

For non-spam, do not blindly clear `spamAt`. V1 lacks provenance for who set spam state, so clearing it can un-spam ingest-spam threads and leave SPAM labels behind. Keep existing spam state unless this task adds explicit AI spam provenance.

If the primary category slug is missing, fail loudly instead of silently dropping the category:

```ts
if (output.category !== 'spam' && !bySlug.get(output.category)) {
  throw new Error(`AI category missing for transport ${transportId}: ${output.category}`);
}
```

- [ ] **Step 5: Add transaction-aware, claim-fenced ledger helpers**

Change mark helpers to accept optional DB handle:

```ts
export async function markAiRunSucceeded(input: MarkAiRunSucceededInput, db: DB = getDb()) { ... }
export async function markAiRunRetry(input: MarkAiRunRetryInput, db: DB = getDb()) { ... }
export async function markAiRunDeadLetter(input: MarkAiRunDeadLetterInput, db: DB = getDb()) { ... }
```

Extend mark inputs:

```ts
claimOwner: string;
expectedStates: AiWorkflowRunState[];
```

Every terminal update must include owner/state fencing:

```ts
where(
  and(
    eq(aiWorkflowRun.id, input.runId),
    eq(aiWorkflowRun.claimOwner, input.claimOwner),
    inArray(aiWorkflowRun.state, input.expectedStates),
  ),
)
```

If no row is updated, return `null`; worker must not report success for that run.

- [ ] **Step 6: Apply triage side effects in one commit**

In `executeAiRun`, after workflow success:

```ts
const env = parseEnv(process.env as Record<string, string | undefined>);
const output = validateTriageOutput(result.result.output);

await db.transaction(async (tx) => {
  await applyDurableTriageResult({
    db: tx as unknown as DB,
    transportId: run.transportId,
    threadId: run.threadId,
    output,
    writeGateEnabled: env.AI_WRITE_GATE_ENABLED,
  });

  const [threadBeforeDraft] = await tx
    .select({ spamAt: mailThread.spamAt })
    .from(mailThread)
    .where(and(eq(mailThread.id, run.threadId), eq(mailThread.transportId, run.transportId)))
    .limit(1);

  let draftRunId: string | undefined;
  if (env.AI_DRAFTS_ENABLED && output.category !== 'spam' && !threadBeforeDraft?.spamAt) {
    const draftRun = await enqueueAiRun({
      transportId: run.transportId,
      threadId: run.threadId,
      triggerMessageId: run.triggerMessageId,
      runKind: 'candidate_draft',
      idempotencyKey: `candidate-draft:${run.triggerMessageId}`,
      modelId: run.modelId,
      promptVersion: 'draft-v1',
      promptHash: run.promptHash ?? undefined,
    }, tx as unknown as DB);
    draftRunId = draftRun.id;
  }

  await markAiRunSucceeded({
    runId,
    claimOwner: run.claimOwner ?? AI_WORKER_OWNER,
    expectedStates: ['running'],
    mastraTraceId: result.result?.traceId,
    metrics: { ...result.result?.metrics, durableWrite: env.AI_WRITE_GATE_ENABLED, draftRunId },
  }, tx as unknown as DB);
});
```

- [ ] **Step 7: Reclaim stale claimed/running rows without double execution**

In `claimNextAiRun`, include stale `claimed` and `running` rows when `updatedAt <= now - AI_STALE_RUN_TIMEOUT_MS`. Reclaim must update `claimOwner` to the new owner and state to `claimed` in the same locked transaction.

Do not count reclaim as a model failure attempt. Add `metrics.reclaimCount` or equivalent; preserve `attempts` for real execution failures.

If implementation chooses a lease heartbeat instead, heartbeat must refresh `updatedAt` during long Bedrock calls and tests must prove an active owner is not reclaimed.

- [ ] **Step 8: Run task tests**

Run:

```bash
pnpm --dir apps/server-pilot test tests/ai-triage-contract.test.ts tests/ai-worker-contract.test.ts tests/ai-enqueue-contract.test.ts tests/ai-workflow-run-contract.test.ts --reporter=dot
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server-pilot/src/ai/triage.ts apps/server-pilot/src/ai/run-ledger.ts apps/server-pilot/src/ai/worker.ts apps/server-pilot/tests/ai-worker-contract.test.ts apps/server-pilot/tests/ai-enqueue-contract.test.ts apps/server-pilot/tests/ai-workflow-run-contract.test.ts
git commit -m "feat: apply durable ai triage and enqueue drafts"
```

---

## Task 4: Bedrock Candidate Draft Workflow

**Files:**
- Create: `apps/server-pilot/src/ai/workflows/candidate-draft.ts`
- Modify: `apps/server-pilot/src/ai/mastra.ts`
- Modify: `apps/server-pilot/src/ai/worker.ts`
- Modify: `apps/server-pilot/src/ai/drafts.ts`
- Test: `apps/server-pilot/tests/ai-candidate-draft-contract.test.ts`
- Test: `apps/server-pilot/tests/ai-worker-contract.test.ts`
- Test: `apps/server-pilot/tests/draft-ai-promotion-contract.test.ts`

**Interfaces:**
- Consumes: `candidate_draft` run from Task 3.
- Produces workflow result:

```ts
{
  draftBody: {
    textBody: string;
    htmlBody: string;
  };
  metrics: Record<string, unknown>;
  traceId: string;
}
```

- [ ] **Step 1: Write failing draft workflow tests**

Assert:
- fake adapter output includes greeting derived from inbound sender.
- text body contains bracketed placeholder like `[Write response here]`.
- `toAddresses` and `subject` are code-derived from trigger message, not model output.
- unusable sender address skips draft cleanly with metrics, not retry/dead-letter.
- persistence creates one `mail_draft.status='candidate'`.
- persistence creates one `mail_draft_revision.kind='ai_generated'`.
- malformed output retries/dead-letters and creates no draft.

- [ ] **Step 2: Run test and confirm failure**

Run: `pnpm --dir apps/server-pilot test tests/ai-candidate-draft-contract.test.ts --reporter=dot`

Expected: FAIL because workflow file does not exist.

- [ ] **Step 3: Create candidate draft workflow**

Workflow must:
- load trigger `message`
- parse and derive `toAddresses` from inbound `fromAddress`
- preserve `Re:` subject behavior in code
- call `createModelAdapter().invoke()`
- validate strict schema

Model output schema:

```ts
const candidateDraftOutputSchema = z.object({
  textBody: z.string().min(1).refine((value) => value.includes('[') && value.includes(']')),
  htmlBody: z.string().min(1),
});
```

Recipient and subject derivation:

```ts
function deriveReplyToAddress(fromAddress: string): string | null {
  const match = fromAddress.match(/<([^>]+)>/);
  const candidate = (match?.[1] ?? fromAddress).trim();
  return z.string().email().safeParse(candidate).success ? candidate : null;
}

function deriveReplySubject(subject: string | null | undefined): string {
  const trimmed = subject?.trim() || 'Your inquiry';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}
```

If `deriveReplyToAddress()` returns null, mark the `candidate_draft` run succeeded with metrics `{ skipped: true, reason: 'missing_reply_to_address' }` and do not create a draft.

Prompt contract:

```ts
const systemPrompt = [
  'Generate a hotel staff candidate reply skeleton.',
  'Do not answer the guest request.',
  'Use this exact structure: Hi {sender name}, then [human writes response here], then Best, {staff name}.',
  'Return JSON only.',
].join('\n');
```

- [ ] **Step 4: Register workflow in Mastra**

In `mastra.ts`:

```ts
import { candidateDraftWorkflow } from './workflows/candidate-draft.js';

workflows: {
  mailTriage: mailTriageWorkflow,
  candidateDraft: candidateDraftWorkflow,
}
```

- [ ] **Step 5: Replace hardcoded worker draft path**

In `executeAiRun` candidate draft branch:
- run `candidateDraft` workflow
- persist returned fields through `persistAiCandidateDraft`
- mark success with `generationId`, `draftId`, `modelId`, token metrics

- [ ] **Step 6: Make draft persistence fully idempotent**

Ensure retry with existing `aiDraftGeneration` and existing `mailDraft` returns existing draft and does not insert a second revision.

- [ ] **Step 7: Run task tests**

Run:

```bash
pnpm --dir apps/server-pilot test tests/ai-candidate-draft-contract.test.ts tests/ai-worker-contract.test.ts tests/draft-ai-promotion-contract.test.ts --reporter=dot
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server-pilot/src/ai/workflows/candidate-draft.ts apps/server-pilot/src/ai/mastra.ts apps/server-pilot/src/ai/worker.ts apps/server-pilot/src/ai/drafts.ts apps/server-pilot/tests/ai-candidate-draft-contract.test.ts apps/server-pilot/tests/ai-worker-contract.test.ts apps/server-pilot/tests/draft-ai-promotion-contract.test.ts
git commit -m "feat: generate ai candidate draft workflow"
```

---

## Task 5: Frontend Category Route And AI Draft Proof

**Files:**
- Modify: `apps/mail/hooks/use-categories.ts`
- Modify: `apps/mail/app/(routes)/mail/[folder]/page.tsx`
- Modify: `apps/mail/components/mail/thread-display.tsx`
- Modify: `packages/testing/e2e/helpers/mail-inbox.ts`
- Test: `apps/server-pilot/tests/mail-category-filter.test.ts`
- Test: `packages/testing/e2e/ai-mail-pipeline.spec.ts`

**Interfaces:**
- Consumes: live category rows from `categories.list` plus category query readiness.
- Produces: stable selectors:
  - `[data-ai-draft-card]`
  - `[data-ai-draft-id="<draft id>"]`

- [ ] **Step 1: Write route validation test plan**

Add unit/contract assertions:
- `/mail/group` resolves to `folder: 'inbox'` with group category id.
- categorized thread appears in Inbox and category route.
- unknown route still redirects to Inbox.

- [ ] **Step 2: Expose live category readiness**

Change `useCategorySettings()` to return loading metadata, or add a companion hook if that keeps the diff smaller:

```ts
export function useCategorySettingsQueryState() {
  const categories = useCategorySettings();
  const demoMode = isFrontendOnlyDemo();
  const trpc = useTRPC();
  const liveCategoriesQuery = useQuery(
    trpc.categories.list.queryOptions(undefined, {
      enabled: !demoMode,
      staleTime: 60_000,
    }),
  );
  return {
    categories,
    isLoadingLiveCategories: !demoMode && liveCategoriesQuery.isLoading,
    hasSettledLiveCategories: demoMode || liveCategoriesQuery.isFetched || liveCategoriesQuery.isError,
  };
}
```

Prefer refactoring `useCategorySettings()` to avoid duplicating query setup if React Query key reuse is unclear.

- [ ] **Step 3: Add category route validation**

In `page.tsx`, use category readiness and treat `category.slug === normalizedFolder` as valid.

Concrete behavior:

```ts
const { categories, hasSettledLiveCategories } = useCategorySettingsQueryState();
const categoryExists = categories.some((category) => category.slug === normalizedFolder);
const labelExists = checkLabelExists(userLabels);
setIsLabelValid(categoryExists || labelExists);
```

Wait until `hasSettledLiveCategories` is true and labels are done loading before redirecting.

- [ ] **Step 4: Add AI draft selectors**

In `ThreadDisplay`, wrap candidate draft card:

```tsx
<div data-ai-draft-card data-ai-draft-id={candidateVm.id}>
  <ThreadDraftCard ... draftBadge="AI draft" isReadOnly />
</div>
```

- [ ] **Step 5: Add Playwright helpers**

In `helpers/mail-inbox.ts`, add:

```ts
export async function expectThreadVisibleInFolder(page: Page, folder: string, subject: string) {
  await page.goto(`/mail/${folder}`);
  await dismissMailOnboarding(page);
  await expect(page.getByText(subject)).toBeVisible({ timeout: 30_000 });
}

export async function expectAiDraftCardVisible(page: Page) {
  await expect(page.locator('[data-ai-draft-card]').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('AI draft').first()).toBeVisible();
}
```

- [ ] **Step 6: Run task tests**

Run:

```bash
pnpm --dir apps/server-pilot test tests/mail-category-filter.test.ts --reporter=dot
pnpm --dir packages/testing exec playwright test ai-mail-pipeline.spec.ts --reporter=line
```

Expected: unit tests PASS; Playwright may require live gate env and should be marked opt-in if local backend is absent.

- [ ] **Step 7: Commit**

```bash
git add apps/mail/hooks/use-categories.ts apps/mail/app/\(routes\)/mail/\[folder\]/page.tsx apps/mail/components/mail/thread-display.tsx packages/testing/e2e/helpers/mail-inbox.ts apps/server-pilot/tests/mail-category-filter.test.ts packages/testing/e2e/ai-mail-pipeline.spec.ts
git commit -m "feat: expose ai category routes and draft proof"
```

---

## Task 6: Live Mailpit To Browser Gate

**Files:**
- Create: `apps/server-pilot/deploy/ai-mail-pipeline-live-gate.sh`
- Modify: `apps/server-pilot/deploy/playwright-ec2-gate.sh`
- Modify: `packages/testing/e2e/ai-mail-pipeline.spec.ts`
- Modify: `apps/server-pilot/tests/helpers/mailpit.ts`

**Interfaces:**
- Consumes: backend health URL, Mailpit HTTP URL, PM2 app names, Playwright session env.
- Produces: pass/fail summary with `threadId`, `triageRunId`, `draftRunId`, `categorySlug`, `draftId`.

- [ ] **Step 1: Write Playwright spec**

`ai-mail-pipeline.spec.ts` must:
- skip unless `BEDROCK_PIPELINE_LIVE_TEST=1`
- read `AI_PIPELINE_FIXTURE_SUBJECT`
- assert Inbox route
- assert category route
- open thread
- assert AI draft card

- [ ] **Step 2: Create gate script**

Gate script structure:

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
cd "$REPO_ROOT"

export BEDROCK_PIPELINE_LIVE_TEST=1
export AI_ENABLED=true
export AI_WRITE_GATE_ENABLED=true
export AI_DRAFTS_ENABLED=true
export MAIL_TRANSPORT_MODE=wire
export ZERO_DEMO_FRONTEND_ONLY=0
export VITE_FRONTEND_ONLY=0
export AI_PIPELINE_FIXTURE_SUBJECT="AI Pipeline Live Gate $(date -u +%Y%m%dT%H%M%SZ)"

apps/server-pilot/deploy/bedrock-live-gate.sh
apps/server-pilot/deploy/wire-gate.sh

# inject deterministic email through Mailpit SMTP
# run worker until inbound_triage succeeds
# run ai-worker until candidate_draft succeeds
# run Playwright live spec
```

- [ ] **Step 3: Add DB wait predicates**

Use `tsx` inline script or small helper to wait for:
- message with fixture subject exists
- `ai_workflow_run.runKind='inbound_triage'` is `succeeded`
- category membership exists when full gate
- `candidate_draft` is `succeeded`
- `mail_draft.status='candidate'` exists

- [ ] **Step 4: Ensure frontend starts live**

In `playwright-ec2-gate.sh`, allow:

```bash
ZERO_DEMO_FRONTEND_ONLY="${ZERO_DEMO_FRONTEND_ONLY:-1}"
VITE_FRONTEND_ONLY="${VITE_FRONTEND_ONLY:-1}"
```

The live gate sets both to `0`.

- [ ] **Step 5: Run shadow and full gates**

Shadow:

```bash
AI_WRITE_GATE_ENABLED=false AI_DRAFTS_ENABLED=false apps/server-pilot/deploy/ai-mail-pipeline-live-gate.sh
```

Full:

```bash
AI_WRITE_GATE_ENABLED=true AI_DRAFTS_ENABLED=true apps/server-pilot/deploy/ai-mail-pipeline-live-gate.sh
```

Expected: full gate prints one PASS line with ids.

- [ ] **Step 6: Commit**

```bash
git add apps/server-pilot/deploy/ai-mail-pipeline-live-gate.sh apps/server-pilot/deploy/playwright-ec2-gate.sh packages/testing/e2e/ai-mail-pipeline.spec.ts apps/server-pilot/tests/helpers/mailpit.ts
git commit -m "test: add live ai mail pipeline gate"
```

---

## Task 7: Evals And Failure Audits

**Files:**
- Modify: `apps/server-pilot/src/ai/eval-runner.ts`
- Modify: `apps/server-pilot/tests/fixtures/ai-spike/centurion-demo.json`
- Modify: `apps/server-pilot/tests/ai-eval-runner.test.ts`
- Test: `apps/server-pilot/tests/ai-eval-runner.test.ts`

**Interfaces:**
- Consumes: triage and candidate draft schema from Tasks 2 and 4.
- Produces eval cases for category accuracy, urgent overlay, spam draft suppression, skeleton draft schema, and failure no-mutation.

- [ ] **Step 1: Write failing eval tests**

Add assertions:

```ts
expect(report.metrics.totalCases).toBeGreaterThanOrEqual(8);
expect(report.failures.find((failure) => failure.id.includes('draft-skeleton'))).toBeUndefined();
expect(report.failures.find((failure) => failure.id.includes('failure-no-mutation'))).toBeUndefined();
```

- [ ] **Step 2: Add fixture cases**

Add fixtures:
- `group-urgent`: expected `group`, urgent true.
- `travel-agent-normal`: expected `travel-agents`, urgent false.
- `spam-suppresses-draft`: expected `spam`, draft false.
- `draft-skeleton`: expected bracketed body and signoff.
- `failure-no-mutation`: malformed model output must not write category/draft rows.

- [ ] **Step 3: Extend eval report**

Add metrics:

```ts
draftSchemaCases: number;
draftSchemaPassed: number;
failureSafetyCases: number;
failureSafetyPassed: number;
```

- [ ] **Step 4: Run eval tests**

Run:

```bash
pnpm --dir apps/server-pilot test tests/ai-eval-runner.test.ts --reporter=dot
pnpm eval:ci
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/ai/eval-runner.ts apps/server-pilot/tests/fixtures/ai-spike/centurion-demo.json apps/server-pilot/tests/ai-eval-runner.test.ts
git commit -m "test: add ai mail pipeline eval cases"
```

---

## Task 8: Runbook And Final Verification

**Files:**
- Modify: `docs/server-pilot-ai.md`
- Modify: `CONCEPTS.md`
- Test: referenced commands below.

**Interfaces:**
- Consumes: final script names and env flags from Tasks 1-7.
- Produces: operator runbook for proof, rollback, and diagnosis.

- [ ] **Step 1: Update runbook flag matrix**

Document:

```text
AI_ENABLED=true                  enables model adapter selection
AI_WRITE_GATE_ENABLED=false      default, shadow-only, no product writes
AI_DRAFTS_ENABLED=false          default, no candidate drafts
BEDROCK_PIPELINE_LIVE_TEST=1     opt-in live E2E proof only
```

- [ ] **Step 2: Add gate order**

Document:

```text
1. pnpm --dir apps/server-pilot test tests/ai-*.test.ts --reporter=dot
2. pnpm eval:ci
3. apps/server-pilot/deploy/bedrock-live-gate.sh
4. apps/server-pilot/deploy/wire-gate.sh
5. apps/server-pilot/deploy/ai-mail-pipeline-live-gate.sh
```

- [ ] **Step 3: Add rollback**

Document:

```text
AI_WRITE_GATE_ENABLED=false
AI_DRAFTS_ENABLED=false
pm2 restart ai-worker --update-env
```

Existing Inbox mail remains visible. Existing AI category memberships and candidate drafts are not deleted automatically; clean by `ai_workflow_run` id only if a helper script exists.

- [ ] **Step 4: Add failure lookup**

Document SQL snippets for:
- latest failed AI runs
- trace by message id
- candidate drafts by generation id
- category memberships by thread id

- [ ] **Step 5: Final verification**

Run:

```bash
pnpm --dir apps/server-pilot test --reporter=dot
pnpm --dir apps/server-pilot build
pnpm --dir packages/testing exec playwright test ai-mail-pipeline.spec.ts --reporter=line
```

Live EC2:

```bash
apps/server-pilot/deploy/ai-mail-pipeline-live-gate.sh
```

- [ ] **Step 6: Commit**

```bash
git add docs/server-pilot-ai.md CONCEPTS.md
git commit -m "docs: document live ai mail pipeline operations"
```

---

## Appendix A: Copy-Paste Test Recipes

These snippets are intentionally verbose. Use them as starting points when implementing tasks.

### A1. Seeded DB Pattern

Use this for tests that need pilot users, transports, categories, threads, or tRPC callers:

```ts
const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('feature contract', () => {
  it('does the thing', async () => {
    await withSeededTestDb(async (db) => {
      const caller = await callerFor('user-manager', { db });
      const result = await caller.mail.listThreads({ folder: 'inbox' });
      expect(result.threads.length).toBeGreaterThanOrEqual(0);
    });
  });
});
```

Use `user-manager` for owner-level Centurion mailbox access. Use `user-centurion-worker` when testing worker-authored drafts.

### A2. Durable Triage Preserves Custom Category

Add this style of test to `apps/server-pilot/tests/ai-triage-contract.test.ts`:

```ts
it('replaces only AI-managed categories and preserves custom category membership', async () => {
  await withSeededTestDb(async (db) => {
    const customCategoryId = randomUUID();
    const groupCategory = await db
      .select()
      .from(mailCategory)
      .where(and(eq(mailCategory.transportId, TRANSPORT_ID), eq(mailCategory.slug, 'group')))
      .limit(1);
    const individualCategory = await db
      .select()
      .from(mailCategory)
      .where(and(eq(mailCategory.transportId, TRANSPORT_ID), eq(mailCategory.slug, 'individual')))
      .limit(1);

    expect(groupCategory[0]).toBeDefined();
    expect(individualCategory[0]).toBeDefined();

    const threadId = randomUUID();
    await db.insert(mailCategory).values({
      id: customCategoryId,
      transportId: TRANSPORT_ID,
      slug: `custom-vip-${customCategoryId.slice(0, 8)}`,
      name: 'Custom VIP',
      sortOrder: 900,
    });
    await db.insert(mailThread).values({
      id: threadId,
      transportId: TRANSPORT_ID,
      threadRootId: `<${threadId}@example.com>`,
      subject: 'Group quote',
      snippet: 'Need 20 rooms',
      latestMessageAt: new Date(),
    });
    await db.insert(mailThreadCategory).values([
      { threadId, transportId: TRANSPORT_ID, categoryId: customCategoryId },
      { threadId, transportId: TRANSPORT_ID, categoryId: groupCategory[0]!.id },
    ]);

    await applyDurableTriageResult({
      db,
      transportId: TRANSPORT_ID,
      threadId,
      writeGateEnabled: true,
      output: {
        category: 'individual',
        urgent: false,
        confidence: 0.92,
        rationale: 'single guest inquiry',
        policyFlags: [],
      },
    });

    const rows = await db
      .select({ slug: mailCategory.slug })
      .from(mailThreadCategory)
      .innerJoin(mailCategory, eq(mailCategory.id, mailThreadCategory.categoryId))
      .where(eq(mailThreadCategory.threadId, threadId));

    const slugs = rows.map((row) => row.slug);
    expect(slugs).toContain(`custom-vip-${customCategoryId.slice(0, 8)}`);
    expect(slugs).toContain('individual');
    expect(slugs).not.toContain('group');
  });
});
```

### A3. Worker Does Not Draft For Existing Spam

Task 3 should include a test with this assertion shape:

```ts
it('does not enqueue candidate draft when thread already has spamAt', async () => {
  await withSeededTestDb(async (db) => {
    const threadId = randomUUID();
    const messageId = randomUUID();
    await db.insert(mailThread).values({
      id: threadId,
      transportId: TRANSPORT_ID,
      threadRootId: `<${threadId}@example.com>`,
      subject: 'Suspicious mail',
      snippet: 'Already spam',
      spamAt: new Date(),
      latestMessageAt: new Date(),
    });
    await db.insert(message).values({
      id: messageId,
      transportId: TRANSPORT_ID,
      threadId,
      direction: 'inbound',
      fromAddress: 'guest@example.com',
      toAddresses: ['centurion@legacyhotel.com'],
      subject: 'Suspicious mail',
      textBody: 'Actually maybe a booking',
      receivedAt: new Date(),
    });

    const run = await enqueueAiRun({
      transportId: TRANSPORT_ID,
      threadId,
      triggerMessageId: messageId,
      runKind: 'inbound_triage',
      idempotencyKey: `triage-existing-spam:${messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'triage-v1',
    }, db);

    process.env.AI_WRITE_GATE_ENABLED = 'true';
    process.env.AI_DRAFTS_ENABLED = 'true';
    const result = await executeAiRun(run.id);
    expect(result.state).toBe('succeeded');

    const [thread] = await db.select().from(mailThread).where(eq(mailThread.id, threadId));
    expect(thread?.spamAt).not.toBeNull();

    const draftRuns = await db
      .select()
      .from(aiWorkflowRun)
      .where(eq(aiWorkflowRun.idempotencyKey, `candidate-draft:${messageId}`));
    expect(draftRuns).toHaveLength(0);
  });
});
```

If this test flakes because `FakeModelAdapter` does not classify this content as non-spam, set up the workflow/model fake the same way existing tests fake adapter behavior. Do not weaken the assertion that existing `spamAt` remains.

### A4. Claim Fencing Test

Core idea: owner A starts, owner B reclaims, owner A tries to mark success and must update zero rows.

```ts
it('prevents original owner from marking success after stale reclaim', async () => {
  await withSeededTestDb(async (db) => {
    const run = await enqueueAiRun(makeInboundRunInput(), db);
    await db
      .update(aiWorkflowRun)
      .set({
        state: 'running',
        claimOwner: 'owner-a',
        updatedAt: new Date(Date.now() - 60 * 60_000),
      })
      .where(eq(aiWorkflowRun.id, run.id));

    const reclaimed = await claimNextAiRun({
      ownerId: 'owner-b',
      staleRunTimeoutMs: 15 * 60_000,
      db,
    });
    expect(reclaimed?.id).toBe(run.id);
    expect(reclaimed?.claimOwner).toBe('owner-b');

    const staleWrite = await markAiRunSucceeded({
      runId: run.id,
      claimOwner: 'owner-a',
      expectedStates: ['running'],
      metrics: { stale: true },
    }, db);
    expect(staleWrite).toBeNull();

    const [row] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
    expect(row?.claimOwner).toBe('owner-b');
    expect(row?.state).toBe('claimed');
  });
});
```

If current `claimNextAiRun` does not accept `db` or `staleRunTimeoutMs`, Task 3 should add those optional parameters. Keep default behavior unchanged for production callers.

### A5. Candidate Draft Skips Bad Sender

Add this to `apps/server-pilot/tests/ai-candidate-draft-contract.test.ts`:

```ts
it('skips candidate draft when inbound sender cannot be parsed', async () => {
  await withSeededTestDb(async (db) => {
    const threadId = randomUUID();
    const messageId = randomUUID();
    await db.insert(mailThread).values({
      id: threadId,
      transportId: TRANSPORT_ID,
      threadRootId: `<${threadId}@example.com>`,
      subject: 'No sender',
      snippet: 'No sender',
      latestMessageAt: new Date(),
    });
    await db.insert(message).values({
      id: messageId,
      transportId: TRANSPORT_ID,
      threadId,
      direction: 'inbound',
      fromAddress: '',
      toAddresses: ['centurion@legacyhotel.com'],
      subject: 'No sender',
      textBody: 'Please reply',
      receivedAt: new Date(),
    });

    const run = await enqueueAiRun({
      transportId: TRANSPORT_ID,
      threadId,
      triggerMessageId: messageId,
      runKind: 'candidate_draft',
      idempotencyKey: `candidate-draft:${messageId}`,
      modelId: 'amazon.nova-lite-v1:0',
      promptVersion: 'draft-v1',
    }, db);

    const result = await executeAiRun(run.id);
    expect(result.state).toBe('succeeded');

    const drafts = await db.select().from(mailDraft).where(eq(mailDraft.threadId, threadId));
    expect(drafts).toHaveLength(0);

    const [updatedRun] = await db.select().from(aiWorkflowRun).where(eq(aiWorkflowRun.id, run.id));
    expect(updatedRun?.metrics).toMatchObject({
      skipped: true,
      reason: 'missing_reply_to_address',
    });
  });
});
```

### A6. Candidate Draft Persists Code-Derived Recipient And Subject

Assert the model cannot alter recipient/subject:

```ts
expect(draft.toAddresses).toEqual(['guest@example.com']);
expect(draft.subject).toBe('Re: Group booking');
expect(draft.textBody).toContain('[');
expect(draft.textBody).toContain(']');
```

The test fixture should set inbound `fromAddress` to `Guest Person <guest@example.com>` and subject to `Group booking`.

### A7. UI Category Loading Race Test

For `apps/mail/app/(routes)/mail/[folder]/page.tsx`, the bug is redirecting before live categories load. The test can be unit-level or Playwright-level. Required behavior:

```text
Given route /mail/group
And categories query is still loading
Then page does not redirect to /mail/inbox yet
When categories resolve with slug=group
Then page renders MailLayout as valid route
```

If no test harness exists for this React route, cover it in Playwright by slowing categories response or by asserting live gate can navigate `/mail/group` directly without being redirected.

### A8. Live Gate DB Wait Predicate Shape

Use a TSX helper or inline script from `ai-mail-pipeline-live-gate.sh`. Required checks:

```ts
const subject = process.env.AI_PIPELINE_FIXTURE_SUBJECT!;
const deadline = Date.now() + 120_000;

while (Date.now() < deadline) {
  const rows = await db
    .select({
      threadId: mailThread.id,
      messageId: message.id,
    })
    .from(message)
    .innerJoin(mailThread, eq(mailThread.id, message.threadId))
    .where(eq(message.subject, subject))
    .limit(1);

  if (rows[0]) {
    const runs = await db
      .select()
      .from(aiWorkflowRun)
      .where(eq(aiWorkflowRun.threadId, rows[0].threadId));
    const triage = runs.find((run) => run.runKind === 'inbound_triage');
    const draft = runs.find((run) => run.runKind === 'candidate_draft');
    if (triage?.state === 'succeeded' && draft?.state === 'succeeded') {
      console.log(JSON.stringify({ threadId: rows[0].threadId, triageRunId: triage.id, draftRunId: draft.id }));
      process.exit(0);
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));
}

throw new Error(`AI pipeline wait timed out for subject ${subject}`);
```

Shadow gate variant should require only message + triage success and assert no draft run.

### A9. Common Compile Errors And Fixes

- **`Property AI_WRITE_GATE_ENABLED does not exist on MailEnv`:** update `MailEnv` interface and `parseEnv` return object in `apps/server-pilot/src/env.ts`.
- **`Property output does not exist on result.result`:** update `mailTriageWorkflowOutputSchema` in `apps/server-pilot/src/ai/workflows/mail-triage.ts`, not only shared triage schema.
- **`db.transaction is not a function` in tests:** you passed a narrowed mock DB. Use `withSeededTestDb` or pass real transaction-scoped DB.
- **Duplicate draft revisions:** `persistAiCandidateDraft` idempotency is incomplete. Return existing draft before inserting `mailDraftRevision`.
- **Category route still redirects:** category query readiness is not wired; do not use fallback demo categories as proof live categories settled.
- **Bedrock outputConfig type error:** keep `additionalModelRequestFields` fallback and document via test. Do not block product flow on SDK type drift.

---

## Parallel Worktree Strategy

```text
Lane A: Task 1
  Shared modules: env, seed, categories
  Must merge before Tasks 2 and 3.

Lane B: Task 2
  Shared modules: triage workflow, Bedrock adapter
  Starts after Task 1 category interface exists.

Lane C: Task 3
  Shared modules: triage, worker, ledger
  Starts after Task 2 output contract merges.

Lane D: Task 4
  Shared modules: Mastra, worker, drafts
  Starts after Task 3 enqueue contract merges.

Lane E: Task 5
  Shared modules: apps/mail, Playwright helpers
  Can run after Task 1 seeds category slugs.

Lane F: Task 6
  Shared modules: deploy scripts, Playwright live spec
  Starts after Tasks 3-5 merge.

Lane G: Task 7 -> Task 8
  Shared modules: eval runner, docs
  Can run after Tasks 2 and 4 define final schemas.
```

Execution: run Task 1 first. Then Task 2. Then Task 3. After Task 3, run Task 4 and Task 5 in parallel only if worker file ownership is coordinated. Then run Task 6. Task 7 can run after Task 4 schema lands; Task 8 runs last.

## Final Gate Checklist

- [ ] Unit contracts pass: `pnpm --dir apps/server-pilot test --reporter=dot`
- [ ] Server-pilot builds: `pnpm --dir apps/server-pilot build`
- [ ] Fake eval gate passes: `pnpm eval:ci`
- [ ] Bedrock live gate passes on EC2.
- [ ] Wire gate passes on EC2.
- [ ] Full AI pipeline live gate passes on EC2.
- [ ] Browser shows ingested thread in Inbox.
- [ ] Browser shows same thread in category route.
- [ ] Browser shows AI draft card in thread view.
- [ ] Rollback flags documented and tested by restart.

## Execution Choice

Plan complete and saved to `docs/superpowers/plans/2026-07-08-live-ai-mail-pipeline.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.
