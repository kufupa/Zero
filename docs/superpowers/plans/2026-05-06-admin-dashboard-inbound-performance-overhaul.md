# Admin dashboard performance and reservation split overhaul implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the admin dashboard KPI set with operationally meaningful metrics (median response time, past-week draft-creation time) and add a connected inbound reservation section split into Individual bookings, Group bookings, and Travel agents with chain/booking/draft/revenue depth.

**Architecture:** Keep inbox filtering and selection model unchanged in `AdminDashboardPage`, then introduce one dedicated admin-dashboard metrics utility layer for deterministic calculation from backend/demo payloads. Keep UI components mostly presentational and derive all values from memoized, pure selectors.

**Tech Stack:** React 19, TypeScript, Recharts, Vitest, Tailwind utility classes, existing `@zero/mail` project layout.

---

## Zero-context engineer primer

- **Repo root:** `C:/Users/gamin/Desktop/projs/emails hotels uis/zero`
- **Package:** `@zero/mail` (folder `apps/mail`)
- **Current page:** `apps/mail/app/(routes)/settings/admin-dashboard/page.tsx`
- **Current data contract:** `apps/mail/lib/admin-dashboard/types.ts`, `apps/mail/lib/admin-dashboard/demo-data.ts`
- **Tests:** `pnpm --filter=@zero/mail exec vitest run ...` (see task steps). Vitest includes only `tests/**/*.test.ts` in this package (`apps/mail/vitest.config.ts`).
- **Lint/Type check checkpoint:** `pnpm --filter=@zero/mail run lint`
- **Runtime context:** Multi-inbox filter exists via `selectedInboxes`; all new metric calculations must only use `filteredEmails` from selected inbox IDs to keep current dashboard behavior.

## File structure (create / modify)

| File | Responsibility |
|-|-|
| `apps/mail/lib/admin-dashboard/types.ts` | Extend `EmailAddressSeriesItem` and add admin-dashboard metric types for response-time samples, draft-time samples, and inbound split metrics. |
| `apps/mail/lib/admin-dashboard/demo-data.ts` | Add seeded metric data matching the new schema for all inbox rows. |
| `apps/mail/lib/admin-dashboard/metrics.ts` | Pure computation layer: median, average, split aggregation, rate/revenue helpers, currency/percentage formatting helpers. |
| `apps/mail/tests/admin-dashboard/metrics.test.ts` | Unit tests for median, averages, split aggregation, draft/booking percentages, total-revenue sum. |
| `apps/mail/components/admin-dashboard/inbound-reservations-card.tsx` | Presentational components: split cards with colors, chain-size + draft/booked percentages + revenue details. |
| `apps/mail/app/(routes)/settings/admin-dashboard/page.tsx` | Wire selectors + compute metrics for selected inboxes; replace KPI row with median/draft cards; add inbound split section and grand total revenue line. |

## Terminology (to avoid confusion)

- **Response metric**: `Median response time` shown as a value in minutes, no trend arrows.
- **Draft metric**: `Average draft creation time` for the **past week** comment (display hint), no `+/-` trend treatment.
- **Reservation splits**: Exactly these labels: `Individual bookings`, `Group bookings`, `Travel agents`.
- **In-scope draft logic**: "Drafted %" is `% drafted emails / total inbound emails` for each split from the provided split payload; urgent/human-requires-review buckets are out-of-band and should already be encoded in the split counts.

---

### Task 1: Extend admin-dashboard types for new inbound/performance fields

**Files:**
- Modify: `apps/mail/lib/admin-dashboard/types.ts`

- [ ] **Step 1: Add split and performance payload types**

```ts
export type ReservationSplitType = 'individual' | 'group' | 'travelAgents';

export type InboundReservationSplit = {
  type: ReservationSplitType;
  inboundEmails: number;
  averageChainSize: number;
  draftedEmails: number;
  bookedEmails: number;
  totalRevenue: number;
};

export type EmailPerformanceProfile = {
  responseTimeMinutes: number[];
  draftCreationMinutes: number[];
};
```

- [ ] **Step 2: Extend `EmailAddressSeriesItem` with new fields**

```ts
export type EmailAddressSeriesItem = {
  emailAddress: string;
  hotelName: string;
  sent: number;
  automated: number;
  approvals: number;
  qualityScore: number;
  performance: EmailPerformanceProfile;
  reservationSplits: InboundReservationSplit[];
};
```

- [ ] **Step 3: Add derived type for aggregated split cards**

```ts
export type InboundReservationSplitAggregate = {
  type: ReservationSplitType;
  inboundEmails: number;
  averageChainSize: number;
  draftedPercent: number;
  bookedPercent: number;
  totalRevenue: number;
};
```

- [ ] **Step 4: Run lint for touched file**

Run: `pnpm --filter=@zero/mail run lint`

Expected: no pre-existing lint failure introduced by these type changes.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/admin-dashboard/types.ts
git commit -m "feat(admin-dashboard): expand types for response and reservation split metrics"
```

---

### Task 2: Update demo payload to include response, draft, and inbound split data

**Files:**
- Modify: `apps/mail/lib/admin-dashboard/demo-data.ts`

- [ ] **Step 1: Add per-hotel performance samples for median response and draft timing**

```ts
{
  emailAddress: 'the-leonardo@legacyhotels.co.za',
  hotelName: 'The Leonardo',
  sent: 214,
  automated: 196,
  approvals: 189,
  qualityScore: 94,
  performance: {
    responseTimeMinutes: [22, 26, 24, 31, 18, 27],
    draftCreationMinutes: [36, 42, 39, 44, 38],
  },
  reservationSplits: [
    { type: 'individual', inboundEmails: 41, averageChainSize: 1.8, draftedEmails: 33, bookedEmails: 34, totalRevenue: 28400 },
    { type: 'group', inboundEmails: 8, averageChainSize: 3.1, draftedEmails: 3, bookedEmails: 6, totalRevenue: 19600 },
    { type: 'travelAgents', inboundEmails: 5, averageChainSize: 2.4, draftedEmails: 2, bookedEmails: 4, totalRevenue: 9200 },
  ],
},
```

- [ ] **Step 1b: Add equivalent `performance` and `reservationSplits` to all existing inbox records**

Apply the same schema to each object in `emails`:

```ts
{
  emailAddress: 'davinci@legacyhotels.co.za',
  hotelName: 'Davinci Hotel & Suites',
  sent: 168,
  automated: 142,
  approvals: 132,
  qualityScore: 91,
  performance: {
    responseTimeMinutes: [31, 29, 33, 28, 35],
    draftCreationMinutes: [52, 49, 58, 54],
  },
  reservationSplits: [
    { type: 'individual', inboundEmails: 35, averageChainSize: 1.6, draftedEmails: 27, bookedEmails: 29, totalRevenue: 20600 },
    { type: 'group', inboundEmails: 11, averageChainSize: 2.9, draftedEmails: 4, bookedEmails: 7, totalRevenue: 27800 },
    { type: 'travelAgents', inboundEmails: 2, averageChainSize: 2.2, draftedEmails: 1, bookedEmails: 1, totalRevenue: 7400 },
  ],
},
```

- [ ] **Step 2: Add a smoke typecheck by importing types from this file**

Run: `pnpm --filter=@zero/mail run lint`

Expected: no TypeScript/lint errors in `demo-data.ts` due to new required fields.

- [ ] **Step 3: Commit**

```bash
git add apps/mail/lib/admin-dashboard/demo-data.ts
git commit -m "feat(admin-dashboard): seed demo data for response and reservation metrics"
```

---

### Task 3: Add pure metrics utilities for median/average/revenue aggregation

**Files:**
- Create: `apps/mail/lib/admin-dashboard/metrics.ts`
- Create: `apps/mail/tests/admin-dashboard/metrics.test.ts`

- [ ] **Step 1: Write failing tests first**

```ts
import { describe, expect, it } from 'vitest';
import type { EmailAddressSeriesItem } from '@/lib/admin-dashboard/types';
import {
  computeAverageDraftCreationTime,
  computeMedianResponseTime,
  computeReservationSplitAggregates,
  computeTotalReservationRevenue,
  median,
} from '@/lib/admin-dashboard/metrics';

const baseHotel: Omit<EmailAddressSeriesItem, 'emailAddress' | 'hotelName' | 'sent' | 'automated' | 'approvals' | 'qualityScore'> = {
  performance: {
    responseTimeMinutes: [20, 30, 40, 50],
    draftCreationMinutes: [10, 20, 30],
  },
  reservationSplits: [
    { type: 'individual', inboundEmails: 10, averageChainSize: 1.5, draftedEmails: 6, bookedEmails: 8, totalRevenue: 2000 },
    { type: 'group', inboundEmails: 4, averageChainSize: 3, draftedEmails: 1, bookedEmails: 3, totalRevenue: 4000 },
    { type: 'travelAgents', inboundEmails: 6, averageChainSize: 2.2, draftedEmails: 2, bookedEmails: 5, totalRevenue: 3000 },
  ],
};

function hotel(overrides: Partial<EmailAddressSeriesItem> = {}): EmailAddressSeriesItem {
  return {
    emailAddress: 'hotel@legacy.com',
    hotelName: 'Test Hotel',
    sent: 10,
    automated: 8,
    approvals: 7,
    qualityScore: 92,
    ...baseHotel,
    ...overrides,
  };
}

describe('metrics math', () => {
  it('computes median with sorted odd/even lengths', () => {
    expect(median([2, 1, 3, 4, 5])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('computes median response time across selected hotels', () => {
    const sample = [
      hotel({
        emailAddress: 'a@legacy.com',
        performance: { responseTimeMinutes: [20, 30], draftCreationMinutes: [15] },
      }),
      hotel({
        emailAddress: 'b@legacy.com',
        performance: { responseTimeMinutes: [10, 40], draftCreationMinutes: [10, 20] },
      }),
    ];
    expect(computeMedianResponseTime(sample)).toBe(25);
  });

  it('computes average draft creation time for past week dataset', () => {
    const sample = [
      hotel({
        emailAddress: 'a@legacy.com',
        performance: { responseTimeMinutes: [20], draftCreationMinutes: [10, 20] },
      }),
      hotel({
        emailAddress: 'b@legacy.com',
        performance: { responseTimeMinutes: [10], draftCreationMinutes: [20, 30] },
      }),
    ];
    expect(computeAverageDraftCreationTime(sample)).toBe(20);
  });

  it('aggregates inbound split by sum, weighted chain, rates, and revenue', () => {
    const aggregates = computeReservationSplitAggregates([baseHotel as EmailAddressSeriesItem]);
    const individual = aggregates.find((item) => item.type === 'individual');
    expect(individual).toMatchObject({
      inboundEmails: 10,
      averageChainSize: 1.5,
      draftedPercent: 60,
      bookedPercent: 80,
      totalRevenue: 2000,
    });

    expect(computeTotalReservationRevenue(aggregates)).toBe(9000);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `pnpm --filter=@zero/mail exec vitest run tests/admin-dashboard/metrics.test.ts`

Expected: FAIL from missing module `apps/mail/lib/admin-dashboard/metrics.ts` and missing exports.

- [ ] **Step 3: Implement `apps/mail/lib/admin-dashboard/metrics.ts`**

```ts
import type { EmailAddressSeriesItem, InboundReservationSplitAggregate, ReservationSplitType } from '@/lib/admin-dashboard/types';

export const RESERVATION_SPLIT_ORDER: ReservationSplitType[] = ['individual', 'group', 'travelAgents'];

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function computeMedianResponseTime(items: EmailAddressSeriesItem[]): number {
  const samples = items.flatMap((item) => item.performance.responseTimeMinutes);
  return median(samples);
}

export function computeAverageDraftCreationTime(items: EmailAddressSeriesItem[]): number {
  const samples = items.flatMap((item) => item.performance.draftCreationMinutes);
  if (samples.length === 0) {
    return 0;
  }
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

export function computeReservationSplitAggregates(
  items: EmailAddressSeriesItem[],
): InboundReservationSplitAggregate[] {
  const accumulators = new Map<
    ReservationSplitType,
    {
      inboundEmails: number;
      totalChainWeight: number;
      draftedEmails: number;
      bookedEmails: number;
      totalRevenue: number;
    }
  >(
    RESERVATION_SPLIT_ORDER.map((splitType) => [
      splitType,
      { inboundEmails: 0, totalChainWeight: 0, draftedEmails: 0, bookedEmails: 0, totalRevenue: 0 },
    ]),
  );

  for (const item of items) {
    for (const split of item.reservationSplits) {
      const bucket = accumulators.get(split.type)!;
      bucket.inboundEmails += split.inboundEmails;
      bucket.totalChainWeight += split.averageChainSize * split.inboundEmails;
      bucket.draftedEmails += split.draftedEmails;
      bucket.bookedEmails += split.bookedEmails;
      bucket.totalRevenue += split.totalRevenue;
    }
  }

  return RESERVATION_SPLIT_ORDER.map((splitType) => {
    const bucket = accumulators.get(splitType)!;
    const chainSize = bucket.inboundEmails > 0 ? bucket.totalChainWeight / bucket.inboundEmails : 0;
    const draftedPercent = bucket.inboundEmails > 0 ? (bucket.draftedEmails / bucket.inboundEmails) * 100 : 0;
    const bookedPercent = bucket.inboundEmails > 0 ? (bucket.bookedEmails / bucket.inboundEmails) * 100 : 0;

    return {
      type: splitType,
      inboundEmails: bucket.inboundEmails,
      averageChainSize: Math.round(chainSize * 10) / 10,
      draftedPercent: Math.round(draftedPercent * 10) / 10,
      bookedPercent: Math.round(bookedPercent * 10) / 10,
      totalRevenue: bucket.totalRevenue,
    };
  });
}

export function computeTotalReservationRevenue(aggregates: InboundReservationSplitAggregate[]): number {
  return aggregates.reduce((total, split) => total + split.totalRevenue, 0);
}
```

- [ ] **Step 4: Run unit test and verify expected pass**

Run: `pnpm --filter=@zero/mail exec vitest run tests/admin-dashboard/metrics.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/lib/admin-dashboard/metrics.ts apps/mail/tests/admin-dashboard/metrics.test.ts
git commit -m "feat(admin-dashboard): add pure metric aggregation helpers"
```

---

### Task 4: Add inbound reservation split UI card component

**Files:**
- Create: `apps/mail/components/admin-dashboard/inbound-reservations-card.tsx`

- [ ] **Step 1: Add split card presentational component and split styling map**

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { InboundReservationSplitAggregate } from '@/lib/admin-dashboard/types';

const SPLIT_STYLE: Record<
  InboundReservationSplitAggregate['type'],
  { border: string; label: string; text: string; bar: string }
> = {
  individual: {
    border: 'border-sky-300 dark:border-sky-500/40',
    label: 'text-sky-800 dark:text-sky-200',
    text: 'text-sky-700 dark:text-sky-200',
    bar: 'bg-sky-500',
  },
  group: {
    border: 'border-amber-300 dark:border-amber-500/40',
    label: 'text-amber-800 dark:text-amber-200',
    text: 'text-amber-700 dark:text-amber-200',
    bar: 'bg-amber-500',
  },
  travelAgents: {
    border: 'border-violet-300 dark:border-violet-500/40',
    label: 'text-violet-800 dark:text-violet-200',
    text: 'text-violet-700 dark:text-violet-200',
    bar: 'bg-violet-500',
  },
};

function formatPounds(value: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(value);
}

type ReservationSplitCardProps = {
  split: InboundReservationSplitAggregate;
  title: string;
};

export function ReservationSplitCard({ split, title }: ReservationSplitCardProps) {
  const style = SPLIT_STYLE[split.type];

  return (
    <Card className={`border ${style.border}`}>
      <CardHeader>
        <CardTitle className={`text-sm font-medium ${style.label}`}>{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{split.inboundEmails} inbound reservation emails</p>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className={`flex justify-between ${style.text}`}>
          <span>Avg chain size</span>
          <span className="font-medium">{split.averageChainSize.toFixed(1)}</span>
        </div>
        <div className={`flex justify-between ${style.text}`}>
          <span>Drafted</span>
          <span className="font-medium">{split.draftedPercent}%</span>
        </div>
        <div className={`flex justify-between ${style.text}`}>
          <span>Booked</span>
          <span className="font-medium">{split.bookedPercent}%</span>
        </div>
        <div className={`flex justify-between ${style.text}`}>
          <span>Total</span>
          <span className="font-medium">{formatPounds(split.totalRevenue)}</span>
        </div>
        <div className="mt-3 h-1.5 w-full rounded bg-muted">
          <div className={`h-full rounded ${style.bar}`} style={{ width: `${split.bookedPercent}%` }} />
        </div>
      </CardContent>
    </Card>
  );
}

export { formatPounds };
```

- [ ] **Step 2: Run lint for new component**

Run: `pnpm --filter=@zero/mail run lint`

Expected: PASS for component file.

- [ ] **Step 3: Commit**

```bash
git add apps/mail/components/admin-dashboard/inbound-reservations-card.tsx
git commit -m "feat(admin-dashboard): add colored inbound reservation split card component"
```

---

### Task 5: Refactor `AdminDashboardPage` to show requested metric set and connected reservation section

**Files:**
- Modify: `apps/mail/app/(routes)/settings/admin-dashboard/page.tsx`

- [ ] **Step 1: Replace current KPI source and imports**

Read and apply:

```ts
import { useMemo, useState, useEffect } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  computeAverageDraftCreationTime,
  computeMedianResponseTime,
  computeReservationSplitAggregates,
  computeTotalReservationRevenue,
} from '@/lib/admin-dashboard/metrics';
import { ReservationSplitCard, formatPounds } from '@/components/admin-dashboard/inbound-reservations-card';
import type { InboundReservationSplitAggregate } from '@/lib/admin-dashboard/types';

const SPLIT_LABELS: Record<InboundReservationSplitAggregate['type'], string> = {
  individual: 'Individual bookings',
  group: 'Group bookings',
  travelAgents: 'Travel agents',
};
```

Keep existing selection handlers and dropdown logic unchanged.

- [ ] **Step 2: Add focused memo selectors for requested metrics**

```ts
const medianResponseMinutes = useMemo(() => computeMedianResponseTime(filteredEmails), [filteredEmails]);
const averageDraftMinutes = useMemo(() => computeAverageDraftCreationTime(filteredEmails), [filteredEmails]);
const reservationSplitAggregates = useMemo(() => computeReservationSplitAggregates(filteredEmails), [filteredEmails]);
const totalInboundRevenue = useMemo(
  () => computeTotalReservationRevenue(reservationSplitAggregates),
  [reservationSplitAggregates],
);
```

- [ ] **Step 3: Replace KPI block with new cards**

```tsx
<div className="grid gap-4 xl:grid-cols-3">
  <KpiBlock
    label="Median response time"
    value={`${medianResponseMinutes.toFixed(1)}m`}
    subtitle="Median across selected inboxes"
  />
  <KpiBlock
    label="Average draft creation time"
    value={`${averageDraftMinutes.toFixed(1)}m`}
    subtitle="Past week"
  />
  <KpiBlock
    label="Inbound reservation emails"
    value={reservationSplitAggregates.reduce((acc, split) => acc + split.inboundEmails, 0).toString()}
    subtitle="Past 7 days (split by type below)"
  />
</div>
```

- [ ] **Step 4: Refactor `KpiBlock` to support no trend mode**

```ts
function KpiBlock({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-muted-foreground text-xs uppercase tracking-wide">{label}</p>
        <p className="mt-1 text-2xl font-semibold">{value}</p>
        <p className="mt-2 text-xs text-muted-foreground">{subtitle}</p>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Insert inbound split panel under main cards**

```tsx
<Card className="mt-6">
  <CardHeader>
    <CardTitle className="text-sm">Inbound reservation emails</CardTitle>
    <p className="text-xs text-muted-foreground">
      Split by reservation type. Draft and booking rates are split-level percentages.
    </p>
  </CardHeader>
  <CardContent className="space-y-4">
    <div className="grid gap-3 md:grid-cols-3">
      {reservationSplitAggregates.map((split) => (
        <ReservationSplitCard
          key={split.type}
          split={split}
          title={SPLIT_LABELS[split.type]}
        />
      ))}
    </div>
    <div className="flex items-center justify-between rounded-md border p-3">
      <p className="text-sm font-medium">Total revenue from reservation emails</p>
      <p className="text-lg font-semibold">{formatPounds(totalInboundRevenue)}</p>
    </div>
  </CardContent>
</Card>
```

- [ ] **Step 6: Use chart tooltip theme helpers from existing pattern**

Keep existing `tooltipStyle` objects and continue passing them to existing `Tooltip` components to avoid regressions and preserve readable labels.

- [ ] **Step 7: Run lint for `page.tsx`**

Run: `pnpm --filter=@zero/mail run lint`

Expected: no lint or type issues in dashboard page.

- [ ] **Step 8: Run targeted Vitest file and fix regressions**

Run: `pnpm --filter=@zero/mail exec vitest run tests/admin-dashboard/metrics.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add "apps/mail/app/(routes)/settings/admin-dashboard/page.tsx" apps/mail/components/admin-dashboard/inbound-reservations-card.tsx apps/mail/lib/admin-dashboard/metrics.ts
git commit -m "feat(admin-dashboard): show median response, draft time, and inbound split revenue cards"
```

---

### Task 6: Polish labels and verify final visual behavior

**Files:**
- Modify: `apps/mail/app/(routes)/settings/admin-dashboard/page.tsx`
- Modify: `docs/superpowers/plans/2026-05-06-admin-dashboard-inbound-performance-overhaul.md` (final notes only)

- [ ] **Step 1: Adjust card copy**

Set exact strings:

- `Median response time`
- `Average draft creation time`
- caption for second card: `Past week`
- split titles:
  - `Individual bookings`
  - `Group bookings`
  - `Travel agents`

- [ ] **Step 2: Add one visual pass**

Run a local screenshot-check flow:

1. Select single inbox → confirm median/average values reflect that inbox.
2. Select all inboxes → confirm totals and percentages roll up.
3. Toggle a non-default subset (2+ inboxes) → verify all three split cards remain readable and update.
4. Confirm total revenue line equals sum of three split revenues exactly.

- [ ] **Step 3: Add note and keep dark mode contrast**

Ensure `formatPounds` uses `en-GB` currency with `maximumFractionDigits: 0`; if locale formatting overflows cards, switch to compact style (`notation: 'compact'`) at the component level.

- [ ] **Step 4: Run full package checks**

Run:

```bash
pnpm --filter=@zero/mail run lint
pnpm --filter=@zero/mail run test:demo
```

Expected: PASS across touched package files.

- [ ] **Step 5: Commit**

```bash
git add apps/mail/app/'(routes)'/settings/admin-dashboard/page.tsx apps/mail/lib/admin-dashboard/metrics.ts apps/mail/tests/admin-dashboard/metrics.test.ts apps/mail/lib/admin-dashboard/types.ts apps/mail/lib/admin-dashboard/demo-data.ts apps/mail/components/admin-dashboard/inbound-reservations-card.tsx
git commit -m "feat(admin-dashboard): complete inbound reservation split + KPI overhaul"
```

---

## Self-review

### Requirement coverage

1. Median response time metric
   - Covered in Task 3 (`computeMedianResponseTime`) and Task 5 KPI card.
2. Average time for draft creation, past week note, no trend symbols
   - Covered in Task 3 (`computeAverageDraftCreationTime`) and Task 5 KPI card + subtitle.
3. Inbound reservation emails split into 3 buckets (individual/group/travel agents)
   - Covered in `InboundReservationSplit`, `computeReservationSplitAggregates`, and `ReservationSplitCard` components.
4. Average chain size per split (e.g. 2.5)
   - Covered via weighted `averageChainSize` in `computeReservationSplitAggregates` and card render.
5. % drafted and % booked per split
   - Covered via `draftedPercent` and `bookedPercent`.
6. Total revenue per split and final total as sum of 3
   - Covered via `totalRevenue` and `computeTotalReservationRevenue`.
7. Visual clarity + connected split presentation
   - Covered by Task 4 component styling, Task 5 panel composition.

### Placeholder scan

None. Every code step includes explicit snippets and exact files/commands.

### Type consistency

- `ReservationSplitType` and aggregate types defined once in `types.ts`.
- All usage points (`metrics.ts`, `demo-data.ts`, `page.tsx`, component) import from shared types; no duplicated enums.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-06-admin-dashboard-inbound-performance-overhaul.md`. Two execution options:

1. Subagent-Driven (recommended) — dispatch one subagent per task with review checkpoints. **Required sub-skill:** superpowers:subagent-driven-development.

2. Inline Execution — implement tasks in this session using superpowers:executing-plans with batch checkpoints.

Which approach?
