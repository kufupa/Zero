# Centurion Evidence Dashboard — Phase 2 Implementation Plan

> **Prerequisite:** Phase 1 complete — [`2026-09-01-centurion-workflow-triage-implementation.md`](2026-09-01-centurion-workflow-triage-implementation.md) Task 12 Step 9 (`WORKFLOW_NAV_V6` on) + backfill audit green.

**Goal:** Replace Aug-25 Nava FTE story with **live-refresh dual-audience evidence board** (Client + Nava developer) + frequent-sender chart + **live workflow triage mix** from durable categories.

**Architecture:** Mailbox dump → `computeEvidenceDashboard` + `SOURCE_FAMILY_REGISTRY` + durable category aggregates → snapshot JSON → Nava TUI two sections. Aug-30 baseline = golden fixture for tests only.

**Tech Stack:** TypeScript, Vitest, existing `nava-fte-dashboard*.ts`, `scripts/nava`, `private-output.ts`, `connected-mailbox-markdown-dump.ts`.

**Product SoT:** [`docs/plans/2026-09-01-002-feat-centurion-workflow-triage-backfill-plan.md`](../../plans/2026-09-01-002-feat-centurion-workflow-triage-backfill-plan.md) R11, R12, U6.

**Gate:** Do not start until Phase 1 Definition of Done (triage + backfill + nav) is green.

**Threading dependency:** Daily answered/unanswered KPIs must use **conversation signal overlay** from [`2026-09-02-centurion-thread-matching-implementation.md`](2026-09-02-centurion-thread-matching-implementation.md) — not naive `thread_id` + outbound alone. See that plan Task 9 for dashboard card hook.

## Global Constraints

- Before every Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV`
- Never pilot-RDS Vitest
- Forbidden published copy: hours saved, emails saved, requiring no action, response rate, revenue, publish 1079/38.4% as external
- Chart **1,042 / 37.1% of 2,810** — internal 37 excluded
- No live click-filter pretending to archive/hide mail
- Every card: `unit`, `asOf`, `availability`, honesty caveat

## Card catalog (no numeric cap)

### Client section

| Card | Baseline | Updates |
|------|----------|---------|
| Mailbox volume | 2810 threads · 3820 msgs · 3447 in · 373 out | dump refresh |
| Daily inbound pressure | mean/median/p90 msgs/day | dump refresh |
| **Workflow triage mix** | 11 folder bars + Urgent overlay | **live from durable categories** |
| Commercial demand mix | 1444/2810 (51.4%) — not revenue | census offline → folder map Phase 2b |
| Outbound history coverage | 373 out · 359 outbound-bearing — not response rate | dump refresh |
| Inbound-only retained gap | % no outbound in export | dump refresh |
| Who/what fills the inbox? | bars sum 1042 = 37.1% | dump + registry |
| Internal property companion | 37 excluded | registry |
| Research / screening queue | ~846 pre-override — **non-KPI** | offline until gold |

### Nava developer section

| Card | Baseline | Updates |
|------|----------|---------|
| Draft-target workload | ~1393 | private aggregate |
| Unanswered needing draft | ~831 | private aggregate |
| Human-gold outbound | ~87 Centurion | post-promote recount |
| Automation screening | 161 / 485 / broad markers | offline |
| HITL / human-lock | ~1380/2810 | metrics post-backfill |
| Low-confidence / Unknown | census → live | post-backfill |
| First-response latency sample | hours.json | existing path |
| Ranked read-tool demand | top hms/mail tags | toolDemand census |
| Triage coverage / safe-abstention | unavailable placeholders | product instrumentation later |
| Historical Aug-25 board | old 2403 mix | historical footer only |

---

### Task 1: Evidence types + source-family registry

**Files:**
- Create: `apps/server-pilot/src/ops/nava-evidence-source-family.ts`
- Create: `apps/server-pilot/tests/nava-evidence-source-family.test.ts`

**Interfaces:**

```ts
export type EvidenceCardAvailability =
  | 'live_snapshot'
  | 'live_categories'
  | 'offline_census'
  | 'historical'
  | 'unavailable';

export type EvidenceCard = {
  audience: 'client' | 'nava_dev';
  title: string;
  value: string;
  unit: string;
  asOf: string;
  availability: EvidenceCardAvailability;
  caveat: string;
};
```

Registry must encode Hermes overrides: exclude internal 37; `hospitality.cloud` → finance 97.

- [ ] **Step 1: Failing test — Aug-30 fixture domains sum to 1042; internal 37 excluded; finance 97**

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/nava-evidence-source-family.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 2: Implement registry + tests PASS**

---

### Task 2: Compute dashboard snapshot

**Files:**
- Create: `apps/server-pilot/src/ops/nava-evidence-dashboard.ts`
- Create: `apps/server-pilot/tests/nava-evidence-dashboard.test.ts`

**Interfaces:**

```ts
export const EVIDENCE_BASELINE_2026_08_30 = {
  asOf: '2026-08-30T21:53:48.208Z',
  threads: 2810,
  chartExternalSystemLikeThreads: 1042,
  chartExternalSharePercent: '37.1%',
  internalPropertyExcludedThreads: 37,
} as const;

export function computeEvidenceDashboard(input: {
  dumpStats: DumpVolumeStats;
  categoryCounts: Record<WorkflowPrimarySlug, number>;
  registryVersion: string;
}): EvidenceDashboardSnapshot;
```

- [ ] **Step 1: Failing tests — baseline arithmetic; no savings strings in copy; clientCards + navaDevCards populated**

- [ ] **Step 2: Implement compute (volume from dump; triage mix from categoryCounts)**

- [ ] **Step 3: Tests PASS**

---

### Task 3: Refresh CLI + nava hook

**Files:**
- Create: `apps/server-pilot/scripts/refresh-nava-evidence-dashboard.ts`
- Modify: `scripts/nava`

- [ ] **Step 1: CLI reads private dump + optional category aggregate → writes `.private/.../evidence-dashboard-latest.json`**

- [ ] **Step 2: Hook `scripts/nava` after dump when dump newer than snapshot**

- [ ] **Step 3: Smoke — refresh on existing Aug-30 dump reproduces 1042 (ops; not Vitest on pilot RDS)**

---

### Task 4: Wire Nava view (dual sections)

**Files:**
- Modify: `apps/server-pilot/src/ops/nava-fte-dashboard.ts`
- Modify: `apps/server-pilot/src/ops/nava-fte-dashboard-view.ts`
- Modify: `apps/server-pilot/tests/nava-fte-dashboard-view.test.ts`

- [ ] **Step 1: Failing test — renders `Client` then `Nava developer` sections; historical Aug-25 demoted**

- [ ] **Step 2: `buildDashboard` prefers latest evidence snapshot; fallback labeled historical**

- [ ] **Step 3: View renders triage mix bars + frequent-sender chart copy locked:**

```ts
export const SOURCE_FAMILY_CHART_COPY = {
  title: 'Who/what fills the inbox?',
  subtitle:
    'Inbound threads from frequent external/system-like source families. Public source role plus local pattern evidence. Not a KPI.',
  userLabel: 'Frequent sender/source families',
} as const;
```

- [ ] **Step 4: Tests PASS**

---

## Definition of Done (Phase 2)

- [ ] Dual-audience board live in Nava TUI with `asOf` on every card
- [ ] Workflow triage mix from **durable categories** (not pre-backfill census)
- [ ] Frequent-sender bars sum 1042; internal 37 companion labeled
- [ ] Aug-25 mix/Luna/old families historical only
- [ ] No savings/revenue/response-rate copy
- [ ] Refresh CLI + `scripts/nava` hook documented in handoff

## Execution Handoff

Run after Phase 1: `/nava-run` on this plan.
