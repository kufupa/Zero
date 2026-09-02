# Centurion Workflow Triage And Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live 4-primary + urgent category model with locked workflow folders, P0–P5 triage, read-only tool tags, evidence KPIs, and the source-family volume chart — shadow-only, no mailbox mutation.

**Architecture:** Keep `mail_thread_category` as one primary workflow slug plus optional `urgent` overlay. Persist P0–P5, source/automation overlays, and suggested READ_TOOLS on the triage payload / shadow ledger. Do not add HMS writes. Do not retag production. Dashboard chart is a labeled 2026-08-30 snapshot, not live RDS.

**Tech Stack:** TypeScript, Zod, Vitest, existing Mastra mail-triage workflow, existing `READ_TOOLS`, React mail sidebar, Nava FTE / admin dashboard snapshot module.

**Grounded plan:** `docs/plans/2026-08-31-002-feat-centurion-workflow-triage-plan.md`

**Tool source (do not use 2026-08-03/04 Infor demand docs):** `docs/infor-hms/connected-mailbox-corpus-analysis-2026-08-25.md`

## Global Constraints

- `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV` before every Vitest/tsc/eslint run on this VPS.
- Never source `.env.production`. Never set `VITEST_ALLOW_PILOT_RDS=1`.
- Database tests use disposable non-production DB only (`TEST_DATABASE_URL` + `CONFIRM_DISPOSABLE_TEST_DB=1`).
- No production VPS/S3/mailbox query, mutation, deploy, migrate, commit, or push unless the user later authorizes a separate execution step.
- No auto-close, suppress, send, or archive by source family.
- No fake response-rate, revenue, or hours-saved copy.
- Internal domains `mail.legacyhotels.com` and `branding.legacyhotels.co.za` never route to `automated-channel`.
- Chart external total is 1,042 threads = 37.1% of 2,810. Do not republish 1,079 / 38.4%.
- Suggested tools are existing read IDs only. No `reservation_create` / folio post / CRS Check Availability.
- Do not fabricate PDF, image, amount, OCR, or attachment counts.
- Raw PII stays out of Git, stdout, and this plan. Examples are generalized.

---

## File map

- Create: `apps/server-pilot/src/ai/workflow-triage-contract.ts`
- Create: `apps/server-pilot/src/ai/suggested-tools.ts`
- Create: `apps/server-pilot/tests/suggested-tools.test.ts`
- Create: `apps/server-pilot/src/ops/nava-evidence-dashboard-2026-08-30.ts`
- Create: `apps/server-pilot/tests/nava-evidence-dashboard-2026-08-30.test.ts`
- Modify: `apps/server-pilot/src/ai/categories.ts`
- Modify: `apps/server-pilot/src/ai/triage.ts`
- Modify: `apps/server-pilot/src/ai/workflows/mail-triage.ts`
- Modify: `apps/server-pilot/src/ai/candidate-draft-agent.ts` (read suggested tools; do not add write tools)
- Modify: `apps/server-pilot/tests/ai-triage-contract.test.ts`
- Modify: `apps/server-pilot/tests/ai-triage-refine.test.ts`
- Modify: `apps/mail/lib/mail/hotel-folder-presentation.ts`
- Modify: `apps/mail/lib/demo/folder-map.ts`
- Modify: `apps/mail/config/navigation.ts`
- Modify: `apps/mail/tests/hotel-folder-presentation.test.ts`
- Modify: `apps/server-pilot/src/ops/nava-fte-dashboard.ts` (label 2026-08-25 freeze as historical)
- Modify: `apps/server-pilot/src/ops/nava-fte-dashboard-view.ts`

---

### Task 1: Workflow slug contract

**Files:**
- Modify: `apps/server-pilot/src/ai/categories.ts`
- Modify: `apps/mail/lib/mail/hotel-folder-presentation.ts`
- Modify: `apps/mail/lib/demo/folder-map.ts`
- Modify: `apps/mail/config/navigation.ts`
- Test: `apps/mail/tests/hotel-folder-presentation.test.ts`
- Test: `apps/server-pilot/tests/ai-triage-contract.test.ts`

**Interfaces:**
- Consumes: current `AI_PRIMARY_CATEGORY_SLUGS` / `HOTEL_PRIMARY_CATEGORY_SLUGS`
- Produces:
  - `AI_WORKFLOW_PRIMARY_SLUGS`: `bookings | groups-events | manage-stay | confirm-reconcile | money-billing | documents-delivery | exceptions-recovery | guest-experience | internal-partner | automated-channel | unknown-review`
  - `AI_OVERLAY_CATEGORY_SLUGS`: `urgent` only
  - `LEGACY_PRIMARY_CATEGORY_SLUGS`: `at-risk | new-bookings | groups-events | ops` (dual-read)
  - `AI_PRIMARY_CATEGORY_SLUGS` becomes the workflow set once Task 4 prompt/schema switch; until then export both with explicit names so old tests compile one task at a time

Locked titles:

| slug | title | subtitle |
|---|---|---|
| bookings | Bookings | New bookings + quotes |
| groups-events | Groups & Events | 10+ rooms / events |
| manage-stay | Manage Existing Stay | Amendments and servicing |
| confirm-reconcile | Confirm & Reconcile | Confirmations are not PMS completion |
| money-billing | Money & Billing | Payments, refunds, settlement |
| documents-delivery | Documents & Delivery | Confirmations, PDFs, failed delivery |
| exceptions-recovery | Exceptions & Recovery | Bounces, failures, mismatches |
| guest-experience | Guest Experience | Complaints and actioned feedback |
| internal-partner | Internal & Partner Ops | Staff, vendor, property coordination |
| automated-channel | Automated / Channel | Clean routine system traffic only |
| unknown-review | Unknown / Needs Review | Conflicting or unresolved evidence |
| urgent | Urgent | Cross-folder imminent harm |

- [ ] **Step 1: Write the failing presentation test**

Add to `apps/mail/tests/hotel-folder-presentation.test.ts`:

```ts
it('workflow folders are the managed primaries and urgent stays overlay', () => {
  expect(isHotelManagedCategorySlug('bookings')).toBe(true);
  expect(isHotelManagedCategorySlug('automated-channel')).toBe(true);
  expect(isHotelManagedCategorySlug('unknown-review')).toBe(true);
  expect(isHotelManagedCategorySlug('urgent')).toBe(true);
  expect(isHotelPrimaryCategorySlug('urgent')).toBe(false);
  expect(isHotelManagedCategorySlug('spam')).toBe(false);
  expect(getHotelFolderPresentation('bookings')).toEqual({
    title: 'Bookings',
    subtitle: 'New bookings + quotes',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/mail exec vitest run tests/hotel-folder-presentation.test.ts
```

Expected: FAIL — `bookings` is not a managed slug.

- [ ] **Step 3: Write minimal slug + presentation implementation**

Update `categories.ts`, `folder-map.ts`, `hotel-folder-presentation.ts`, and `navigation.ts` `HOTEL_PRIMARY_NAV_ORDER` to the eleven workflow slugs with `urgent` sorted separately as overlay. Keep legacy slug helpers for dual-read. Do not delete old seed rows yet.

- [ ] **Step 4: Run test to verify it passes**

Same command as Step 2. Expected: new test PASS. Existing tests that still assert `new-bookings` as managed may fail; keep `new-bookings` in a `LEGACY` set so current tests pass until Task 4, **or** update those assertions in this task if the managed-primary set has fully switched. Prefer: `isHotelManagedCategorySlug` true for both workflow slugs and legacy slugs during dual-read; `isHotelWorkflowPrimarySlug` true only for the eleven.

- [ ] **Step 5: Commit**

```bash
git add apps/server-pilot/src/ai/categories.ts apps/mail/lib/mail/hotel-folder-presentation.ts apps/mail/lib/demo/folder-map.ts apps/mail/config/navigation.ts apps/mail/tests/hotel-folder-presentation.test.ts
git commit -m "feat(mail): add workflow folder slug contract"
```

Only commit if the user asked to commit. Otherwise stop after tests pass.

---

### Task 2: Structured triage schema

**Files:**
- Create: `apps/server-pilot/src/ai/workflow-triage-contract.ts`
- Modify: `apps/server-pilot/src/ai/triage.ts`
- Test: `apps/server-pilot/tests/ai-triage-contract.test.ts`

**Interfaces:**
- Consumes: U1 slugs, `READ_TOOL_IDS` from `apps/server-pilot/src/hms/read-tools.ts`
- Produces:

```ts
export const WORKFLOW_PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'] as const;
export const HUMAN_ACTIONS = [
  'none',
  'monitor',
  'verify_state',
  'answer_or_quote',
  'create_or_reconcile',
  'amend_or_cancel',
  'payment_or_finance',
  'document_or_delivery',
  'security_or_incident',
  'other',
] as const;
export const TRIAGE_OVERLAYS = [
  'urgent',
  'booking',
  'quote',
  'payment',
  'guest_impact',
  'deadline',
  'review_required',
  'historical_outbound_evidence',
] as const;

export const workflowTriageOutputSchema = z.object({
  primaryFolder: z.enum(AI_WORKFLOW_PRIMARY_SLUGS),
  priority: z.enum(WORKFLOW_PRIORITIES),
  urgent: z.boolean().default(false),
  overlays: z.array(z.enum(TRIAGE_OVERLAYS)).default([]),
  sourceScope: z.enum(['external', 'internal_property']).default('external'),
  sourceFamily: z.string().min(1).optional(),
  automationState: z
    .enum(['excluded_internal', 'unknown', 'candidate', 'routine_candidate', 'exception_candidate'])
    .default('unknown'),
  suggestedTools: z.array(z.enum(READ_TOOL_IDS)).default([]),
  humanAction: z.enum(HUMAN_ACTIONS),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
  policyFlags: z.array(z.string()).default([]),
  abstainReason: z.string().nullable().default(null),
});
```

`validateTriageOutput` must parse this shape. Keep a `toLegacyCategory()` helper that maps workflow folder → old slug only for unread dual-read callers, never the other way for new writes.

- [ ] **Step 1: Write the failing contract test**

```ts
it('accepts workflow triage payload with quote overlay and hms_quote_stay', () => {
  const parsed = validateTriageOutput({
    primaryFolder: 'bookings',
    priority: 'P3',
    urgent: false,
    overlays: ['quote'],
    sourceScope: 'external',
    automationState: 'unknown',
    suggestedTools: ['hms_quote_stay'],
    humanAction: 'answer_or_quote',
    confidence: 0.7,
    rationale: 'quote request needs availability read',
    policyFlags: [],
    abstainReason: null,
  });
  expect(parsed.primaryFolder).toBe('bookings');
  expect(parsed.overlays).toContain('quote');
  expect(parsed.suggestedTools).toEqual(['hms_quote_stay']);
});

it('rejects unknown suggested tool ids', () => {
  expect(() =>
    validateTriageOutput({
      primaryFolder: 'bookings',
      priority: 'P1',
      humanAction: 'create_or_reconcile',
      confidence: 0.5,
      rationale: 'x',
      suggestedTools: ['reservation_create'],
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/ai-triage-contract.test.ts
```

Expected: FAIL — `validateTriageOutput` still requires `category`.

- [ ] **Step 3: Write minimal schema implementation**

Add `workflow-triage-contract.ts`. Point `triageOutputSchema` at the new schema **or** union old+new during this task then require new in Task 4. Prefer a discriminated union so old refine tests still compile until Task 3 updates them.

- [ ] **Step 4: Run test to verify it passes**

Same command. Expected: new tests PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): add workflow triage output schema"
```

Only if user asked to commit.

---

### Task 3: Exception-first refine + internal-domain override

**Files:**
- Modify: `apps/server-pilot/src/ai/triage.ts`
- Test: `apps/server-pilot/tests/ai-triage-refine.test.ts`

**Interfaces:**
- Consumes: `workflowTriageOutputSchema`, never-spam allowlist
- Produces: refined payload that cannot place internal property mail in `automated-channel`

Load-bearing inversion: current tests demote routine reservation-system updates and even “no action required” cancellations to `ops`. That contradicts the locked design. Update those tests. Automated-looking cancellation/payment/failure stays in an action folder. `automated-channel` only after no request, no failure, no mismatch, no payment, no deadline, no guest impact.

Internal never-spam branch today maps `mail.legacyhotels.com` → `ops`. Change to `exceptions-recovery` with `sourceScope: 'internal_property'` and `automationState: 'excluded_internal'`.

- [ ] **Step 1: Write failing refine tests**

Replace/extend `modelOutput` helper to emit workflow payloads. Add:

```ts
it('never routes internal property delivery failure to automated-channel', () => {
  const refined = refineTriageOutput(
    {
      from: 'mailer-daemon@mail.legacyhotels.com',
      subject: 'Delivery Status Notification',
      body: 'Delivery failed for branding message',
    },
    {
      primaryFolder: 'automated-channel',
      priority: 'P4',
      urgent: false,
      overlays: [],
      sourceScope: 'external',
      automationState: 'routine_candidate',
      suggestedTools: [],
      humanAction: 'monitor',
      confidence: 0.9,
      rationale: 'system looking',
      policyFlags: [],
      abstainReason: null,
    },
  );
  expect(refined.primaryFolder).toBe('exceptions-recovery');
  expect(refined.sourceScope).toBe('internal_property');
  expect(refined.automationState).toBe('excluded_internal');
  expect(refined.primaryFolder).not.toBe('automated-channel');
});

it('keeps finance-ops payment notices in money-billing', () => {
  const refined = refineTriageOutput(
    {
      from: 'notices@hospitality.cloud',
      subject: 'Hotel booking payment',
      body: 'Booking payment notification',
    },
    {
      primaryFolder: 'automated-channel',
      priority: 'P4',
      urgent: false,
      overlays: [],
      sourceScope: 'external',
      automationState: 'routine_candidate',
      suggestedTools: [],
      humanAction: 'monitor',
      confidence: 0.8,
      rationale: 'templated',
      policyFlags: [],
      abstainReason: null,
    },
  );
  expect(refined.primaryFolder).toBe('money-billing');
  expect(refined.overlays).toContain('payment');
  expect(refined.automationState).toBe('candidate');
});

it('does not demote channel cancellation language to automated-channel', () => {
  const refined = refineTriageOutput(
    {
      from: 'notifications@reservations.example.test',
      subject: 'Reservation update',
      body: 'Channel manager cancels booking. No action is required.',
    },
    {
      primaryFolder: 'manage-stay',
      priority: 'P1',
      urgent: false,
      overlays: ['booking'],
      sourceScope: 'external',
      automationState: 'exception_candidate',
      suggestedTools: ['hms_find_reservation'],
      humanAction: 'amend_or_cancel',
      confidence: 0.8,
      rationale: 'cancellation',
      policyFlags: [],
      abstainReason: null,
    },
  );
  expect(refined.primaryFolder).not.toBe('automated-channel');
  expect(['manage-stay', 'exceptions-recovery']).toContain(refined.primaryFolder);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/ai-triage-refine.test.ts
```

Expected: FAIL on internal/finance/cancellation cases. Existing `ops` demotion tests also fail once helper types change — delete or rewrite them in this task. Do not keep “cancellation → nonurgent ops” as desired behavior.

- [ ] **Step 3: Write minimal refine implementation**

Order: P0/P1 exception markers → internal_property exclusion → finance-ops promotion → unknown abstain → only then routine `automated-channel`. Never use model `confidence` as a write gate.

- [ ] **Step 4: Run test to verify it passes**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(ai): exception-first refine and internal-domain exclusion"
```

Only if user asked to commit.

---

### Task 4: Prompt + shadow workflow (durable writes off)

**Files:**
- Modify: `apps/server-pilot/src/ai/workflows/mail-triage.ts`
- Modify: `apps/server-pilot/src/ai/triage.ts`
- Test: `apps/server-pilot/tests/ai-triage-contract.test.ts`

**Interfaces:**
- Consumes: new schema, refine
- Produces: `applyShadowTriageResult` stores full workflow payload; `applyDurableTriageResult` does not write new workflow slugs unless `WORKFLOW_TRIAGE_DURABLE=1` (default unset)

- [ ] **Step 1: Write failing prompt test**

Update the existing system-prompt test in `ai-triage-contract.test.ts`:

```ts
it('system prompt teaches workflow folders and P0-P5, not ops as the work queue', () => {
  const p = buildSystemPrompt();
  expect(p).toContain('bookings');
  expect(p).toContain('confirm-reconcile');
  expect(p).toContain('automated-channel');
  expect(p).toMatch(/P0|immediate intervention/i);
  expect(p).toMatch(/What must a human do/i);
  expect(p).toMatch(/quote/i);
  expect(p).toMatch(/internal_property|internal property/i);
  expect(p).not.toMatch(/irrelevant automation/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/ai-triage-contract.test.ts
```

Expected: FAIL — prompt still teaches `new-bookings` / `ops` as primaries.

- [ ] **Step 3: Rewrite `buildSystemPrompt` and shadow apply**

Prompt rules in order: current-message intent; human agency; P0–P5; one primary folder; overlays; suggested read tools; abstain on conflict. Explicit: confirmation ≠ PMS completion; automated-looking ≠ no action; internal domains ≠ automated-channel.

`applyShadowTriageResult` must clone/store `primaryFolder`, `priority`, `overlays`, `suggestedTools`. Durable path default: do not insert workflow category memberships.

- [ ] **Step 4: Run test to verify it passes**

Same command. Expected: PASS. Skip DB cases unless `TEST_DB_AVAILABLE`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): shadow workflow triage prompt and payload"
```

Only if user asked to commit.

---

### Task 5: Deterministic suggested-tool planner

**Files:**
- Create: `apps/server-pilot/src/ai/suggested-tools.ts`
- Create: `apps/server-pilot/tests/suggested-tools.test.ts`
- Modify: `apps/server-pilot/src/ai/candidate-draft-agent.ts` only to intersect planner output with `DEFAULT_CANDIDATE_ACTIVE_TOOL_IDS` / session active tools

**Interfaces:**
- Consumes: workflow triage fields
- Produces:

```ts
export function suggestReadTools(input: {
  primaryFolder: AiWorkflowPrimarySlug;
  overlays: readonly TriageOverlay[];
  humanAction: HumanAction;
  automationState: AutomationState;
}): ReadToolId[]
```

Rules:
- `quote` overlay or `answer_or_quote` → `hms_quote_stay`
- `booking` overlay or `create_or_reconcile` / `verify_state` → `hms_find_reservation`
- both quote and booking → both tools, find first
- `payment_or_finance` or `money-billing` → `hms_read_folio` then `hms_find_reservation`
- `documents-delivery` or `document_or_delivery` → `hms_list_documents`, `hms_sent_email_audit`, `mail_read_artifact`
- `groups-events` → `hms_group_block_read`, `hms_quote_stay`
- `automated-channel` / `unknown-review` / `internal-partner` with no exception overlay → `[]`
- never return ids outside `READ_TOOL_IDS`

- [ ] **Step 1: Write the failing planner test**

```ts
import { describe, expect, it } from 'vitest';
import { suggestReadTools } from '../src/ai/suggested-tools.js';

describe('suggestReadTools', () => {
  it('tags quote work with hms_quote_stay only', () => {
    expect(
      suggestReadTools({
        primaryFolder: 'bookings',
        overlays: ['quote'],
        humanAction: 'answer_or_quote',
        automationState: 'unknown',
      }),
    ).toEqual(['hms_quote_stay']);
  });

  it('tags booking reconcile with hms_find_reservation', () => {
    expect(
      suggestReadTools({
        primaryFolder: 'confirm-reconcile',
        overlays: ['booking'],
        humanAction: 'verify_state',
        automationState: 'exception_candidate',
      }),
    ).toEqual(['hms_find_reservation']);
  });

  it('returns no tools for clean automated-channel', () => {
    expect(
      suggestReadTools({
        primaryFolder: 'automated-channel',
        overlays: [],
        humanAction: 'monitor',
        automationState: 'routine_candidate',
      }),
    ).toEqual([]);
  });

  it('never suggests write tools', () => {
    const tools = suggestReadTools({
      primaryFolder: 'bookings',
      overlays: ['booking', 'quote'],
      humanAction: 'create_or_reconcile',
      automationState: 'unknown',
    });
    expect(tools).not.toContain('reservation_create');
    expect(tools[0]).toBe('hms_find_reservation');
    expect(tools).toContain('hms_quote_stay');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/suggested-tools.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal planner**

Pure function, no I/O. Optional: `refineTriageOutput` may fill empty `suggestedTools` from this planner. Draft agent may filter to active tools; inactive roadmap tools stay tags only.

- [ ] **Step 4: Run test to verify it passes**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): suggest read tools from workflow folder and overlays"
```

Only if user asked to commit.

---

### Task 6: Sidebar, pills, Urgent queue

**Files:**
- Modify: `apps/mail/config/navigation.ts`
- Modify: `apps/mail/lib/mail/hotel-folder-presentation.ts`
- Modify: `apps/mail/lib/mail/route-filter.ts` if folder predicates list primaries
- Test: `apps/mail/tests/hotel-folder-presentation.test.ts`

**Interfaces:**
- Consumes: workflow slugs + presentation
- Produces: Folders nav section with eleven primaries; Urgent first as overlay with existing red stripe; spam/bin/inbox unchanged

Gate nav with a capability/flag defaulting to **off** so live 4-folder UI does not flip until shadow quality exists. When flag off, nav still uses legacy slugs. When flag on, nav uses workflow slugs.

- [ ] **Step 1: Write failing nav test**

```ts
it('workflow nav lists Bookings before Groups and keeps Urgent overlay stripe', () => {
  const items = buildLiveCategoryNavItems([
    { slug: 'bookings', name: 'Bookings', sortOrder: 110 },
    { slug: 'groups-events', name: 'Groups & Events', sortOrder: 120 },
    { slug: 'urgent', name: 'Urgent', sortOrder: 10 },
  ]);
  expect(items.map((i) => i.id)).toEqual(['urgent', 'bookings', 'groups-events']);
  expect(items[0]?.className).toContain('after:bg-red-500');
  expect(items.find((i) => i.id === 'bookings')?.title).toBe('Bookings');
});
```

If `buildLiveCategoryNavItems` currently sorts only by `sortOrder`, set seed sortOrder so urgent=10 and bookings < groups. Do not put `automated-channel` above Exceptions.

- [ ] **Step 2: Run test to verify it fails**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/mail exec vitest run tests/hotel-folder-presentation.test.ts
```

Expected: FAIL until titles/order exist.

- [ ] **Step 3: Minimal nav/presentation implementation**

Reuse `getHotelFolderNavTheme`. New pastel tokens may copy existing Centurion palettes; do not invent a second theme system. Unknown folder should look like review, not spam.

- [ ] **Step 4: Run test to verify it passes**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(mail): workflow folder sidebar and urgent overlay"
```

Only if user asked to commit.

---

### Task 7: Evidence KPIs + source-family chart snapshot

**Files:**
- Create: `apps/server-pilot/src/ops/nava-evidence-dashboard-2026-08-30.ts`
- Create: `apps/server-pilot/tests/nava-evidence-dashboard-2026-08-30.test.ts`
- Modify: `apps/server-pilot/src/ops/nava-fte-dashboard.ts` to label `NAVA_FROZEN_*` as `asOf: 2026-08-25` historical, not the current user-facing mix
- Modify: `apps/server-pilot/src/ops/nava-fte-dashboard-view.ts` copy so chart title/subtitle match the lock

**Interfaces:**
- Produces frozen snapshot (do not compute from RDS):

```ts
export const EVIDENCE_KPI_2026_08_30 = {
  asOf: '2026-08-30T21:53:48.208Z',
  threads: 2810,
  messages: 3820,
  inboundMessages: 3447,
  outboundMessages: 373,
  outboundBearingThreads: 359,
  commercialWorkThreads: 1444,
  chartExternalSystemLikeThreads: 1042,
  chartExternalSharePercent: '37.1%',
  internalPropertyExcludedThreads: 37,
} as const;

export const SOURCE_FAMILY_BARS_2026_08_30 = [
  { family: 'Channel / travel / hospitality platforms', threads: 573 },
  { family: 'Security / mail gateway', threads: 129 },
  { family: 'Guest-feedback automation', threads: 126 },
  { family: 'Transactional mail infrastructure', threads: 98 },
  { family: 'Finance notifications / finance ops', threads: 97 },
  { family: 'Unresolved external/system-like', threads: 5 },
  { family: 'Marketing / newsletter automation', threads: 14 },
] as const;

export const SOURCE_FAMILY_CHART_COPY = {
  title: 'Who/what fills the inbox?',
  subtitle:
    'Inbound threads from frequent external/system-like source families. Public source role plus local pattern evidence. Not a KPI.',
  userLabel: 'Frequent sender/source families',
} as const;
```

Forbidden strings in view copy: `Emails saved`, `Emails requiring no action`, `Hours saved`.

- [ ] **Step 1: Write failing arithmetic test**

```ts
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_KPI_2026_08_30,
  SOURCE_FAMILY_BARS_2026_08_30,
  SOURCE_FAMILY_CHART_COPY,
} from '../src/ops/nava-evidence-dashboard-2026-08-30.js';

describe('2026-08-30 evidence dashboard snapshot', () => {
  it('bars sum to 1042 and 37.1% of 2810', () => {
    const sum = SOURCE_FAMILY_BARS_2026_08_30.reduce((n, row) => n + row.threads, 0);
    expect(sum).toBe(1042);
    expect(sum).toBe(EVIDENCE_KPI_2026_08_30.chartExternalSystemLikeThreads);
    expect(sum / EVIDENCE_KPI_2026_08_30.threads).toBeCloseTo(0.371, 3);
    expect(EVIDENCE_KPI_2026_08_30.chartExternalSharePercent).toBe('37.1%');
  });

  it('excludes internal property 37 from external total', () => {
    expect(EVIDENCE_KPI_2026_08_30.internalPropertyExcludedThreads).toBe(37);
    expect(1042 + 37).toBe(1079);
  });

  it('does not claim savings', () => {
    const blob = JSON.stringify(SOURCE_FAMILY_CHART_COPY);
    expect(blob).not.toMatch(/hours saved|emails saved|no action/i);
    expect(SOURCE_FAMILY_CHART_COPY.title).toBe('Who/what fills the inbox?');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/nava-evidence-dashboard-2026-08-30.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write snapshot module + view copy**

Channel 573 split stays in comments/tooltips only: SynXis 230, TravelIT 66, WebBeds 19, Other OTA 113, Profitroom/eRevMax 90, TBO/NexCT 55. Finance 97 = 72 + 25 hospitality.cloud. Optional companion bar for internal 37 must be labeled internal, not Automated / Channel.

- [ ] **Step 4: Run test to verify it passes**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ops): add 2026-08-30 evidence KPIs and source-family chart snapshot"
```

Only if user asked to commit.

---

### Task 8: Dual-read seed compatibility (no production retag)

**Files:**
- Modify: category seed path used by `AI_MANAGED_CATEGORY_SEED_ROWS` in `apps/server-pilot/src/ai/categories.ts`
- Test: `apps/server-pilot/tests/ai-triage-contract.test.ts` or a new `tests/workflow-category-seed.test.ts`

**Interfaces:**
- Consumes: workflow + legacy slug sets
- Produces: seed rows for both; durable writer still default-off

Do **not** UPDATE existing `mail_thread_category` rows. Do **not** change `spam_at` transitions (`docs/solutions/architecture-patterns/folder-first-spam-at-folder-matrix.md`).

- [ ] **Step 1: Write failing seed-row test**

```ts
it('seeds workflow primaries without dropping legacy rows', () => {
  const slugs = AI_MANAGED_CATEGORY_SEED_ROWS.map((row) => row.slug);
  expect(slugs).toContain('bookings');
  expect(slugs).toContain('unknown-review');
  expect(slugs).toContain('urgent');
  expect(slugs).toContain('new-bookings'); // dual-read leftover
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/ai-triage-contract.test.ts
```

Expected: FAIL until seed rows include `bookings`.

- [ ] **Step 3: Add seed rows**

Append workflow rows with sortOrder matching sidebar. Keep legacy rows. Feature flag for nav/durable writes remains off.

- [ ] **Step 4: Run targeted tests**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/ai-triage-contract.test.ts tests/ai-triage-refine.test.ts tests/suggested-tools.test.ts tests/nava-evidence-dashboard-2026-08-30.test.ts
pnpm --filter @zero/mail exec vitest run tests/hotel-folder-presentation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): seed workflow folders beside legacy categories"
```

Only if user asked to commit.

---

## Self-review

**Spec coverage:**
- Workflow folders R1 → Tasks 1, 6, 8
- Urgent overlay R2 → Tasks 1, 6
- P0–P5 R3 → Tasks 2, 4
- Automated-looking ≠ no-action R4 → Task 3
- Internal exclusion R5 → Task 3
- hospitality.cloud finance-ops R6 → Task 3
- Unknown abstain R7 → Tasks 2, 3
- Quote vs booking R8/R13 → Tasks 2, 5
- Groups 10+ R9 → Task 1 copy
- Confirmation ≠ completion R10 → Task 4 prompt
- KPIs + chart R11/R12 → Task 7
- Shadow before durable R14 → Task 4
- Human override / no auto-close R15 → Task 4 durable-off
- Spam matrix R16 → Task 8 non-touch of `spam_at`

**Placeholder scan:** none intended. HMS writes, gold review, live RDS chart, production retag, outbound backfill are deferred, not TBDs inside tasks.

**Type consistency:** `primaryFolder` / `AI_WORKFLOW_PRIMARY_SLUGS` / `suggestReadTools` / `READ_TOOL_IDS` / `urgent` overlay slug are the shared names. Do not reintroduce `category` as the product field after Task 2.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-31-centurion-workflow-triage-and-tools.md`. Companion grounded plan: `docs/plans/2026-08-31-002-feat-centurion-workflow-triage-plan.md`.

Canonical next step: `/nava-run`. Do not implement in this planning pass.

Two execution options after the user asks to implement:

1. Subagent-Driven (recommended) — fresh subagent per task, review between tasks
2. Inline Execution — execute tasks in session using executing-plans
