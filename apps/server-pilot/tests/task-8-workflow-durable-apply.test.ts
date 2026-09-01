import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  AI_MANAGED_CATEGORY_SEED_ROWS,
  AI_MANAGED_CATEGORY_SLUGS,
  AI_PRIMARY_CATEGORY_SLUGS,
  AI_WORKFLOW_PRIMARY_SLUGS,
} from '../src/ai/categories.js';
import {
  applyDurableTriageResult,
  type WorkflowTriageOutput,
} from '../src/ai/triage.js';
import { mailCategory, mailThread, mailThreadCategory } from '../src/db/schema/mail.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';

const reachable = await probeTestDb();

const workflowOutput = (
  overrides: Partial<WorkflowTriageOutput> = {},
): WorkflowTriageOutput => ({
  primaryFolder: 'money-billing',
  priority: 'P3',
  urgent: false,
  overlays: {},
  isSpam: false,
  suggestedTools: [],
  sourceScope: 'external',
  automationState: 'candidate',
  humanAction: 'payment_or_finance',
  confidence: 0.9,
  rationale: 'workflow durable apply contract',
  policyFlags: [],
  abstainReason: null,
  ...overrides,
});

describe('Task 8 workflow category seed contract', () => {
  it('seeds all workflow primaries and urgent while retaining legacy rows', () => {
    const expected = [
      ...AI_PRIMARY_CATEGORY_SLUGS,
      ...AI_WORKFLOW_PRIMARY_SLUGS.filter(
        (slug) => !(AI_PRIMARY_CATEGORY_SLUGS as readonly string[]).includes(slug),
      ),
      'urgent',
    ];
    const seeded = AI_MANAGED_CATEGORY_SEED_ROWS.map((row) => row.slug);

    expect(new Set(seeded)).toEqual(new Set(expected));
    expect(new Set(AI_MANAGED_CATEGORY_SLUGS)).toEqual(new Set(expected));
  });

  it('keeps durable writes fail-closed when workflow triage gate is disabled', async () => {
    const result = await applyDurableTriageResult({
      db: {} as never,
      transportId: TRANSPORT_ID,
      threadId: 'thread-without-db-access',
      writeGateEnabled: false,
      output: workflowOutput(),
    });

    expect(result.applyMode).toBe('skipped');
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('Task 8 workflow durable apply', () => {
  it('applies workflow primary fully when unsettled, then urgency-only when settled', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Payment inquiry',
        snippet: 'Payment confirmation',
        latestMessageAt: new Date(),
        spamAt: null,
      });

      const first = await applyDurableTriageResult({
        db,
        transportId: TRANSPORT_ID,
        threadId,
        writeGateEnabled: true,
        output: workflowOutput(),
      });
      expect(first.applyMode).toBe('full');

      const firstRows = await db
        .select({ slug: mailCategory.slug })
        .from(mailThreadCategory)
        .innerJoin(mailCategory, eq(mailCategory.id, mailThreadCategory.categoryId))
        .where(eq(mailThreadCategory.threadId, threadId));
      expect(firstRows.map((row) => row.slug)).toContain('money-billing');

      const second = await applyDurableTriageResult({
        db,
        transportId: TRANSPORT_ID,
        threadId,
        writeGateEnabled: true,
        output: workflowOutput({ primaryFolder: 'bookings', urgent: true }),
      });
      expect(second.applyMode).toBe('urgency_only');

      const secondRows = await db
        .select({ slug: mailCategory.slug })
        .from(mailThreadCategory)
        .innerJoin(mailCategory, eq(mailCategory.id, mailThreadCategory.categoryId))
        .where(
          and(
            eq(mailThreadCategory.threadId, threadId),
            eq(mailThreadCategory.transportId, TRANSPORT_ID),
          ),
        );
      expect(secondRows.map((row) => row.slug)).toContain('money-billing');
      expect(secondRows.map((row) => row.slug)).toContain('urgent');
      expect(secondRows.map((row) => row.slug)).not.toContain('bookings');
    });
  });

  it('uses legacy category join when durable workflow flag is off', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking inquiry',
        snippet: 'Need a room',
        latestMessageAt: new Date(),
        spamAt: null,
      });

      const result = await applyDurableTriageResult({
        db,
        transportId: TRANSPORT_ID,
        threadId,
        writeGateEnabled: true,
        workflowTriageEnabled: false,
        output: workflowOutput({ primaryFolder: 'bookings' }),
      });
      expect(result.applyMode).toBe('full');

      const rows = await db
        .select({ slug: mailCategory.slug })
        .from(mailThreadCategory)
        .innerJoin(mailCategory, eq(mailCategory.id, mailThreadCategory.categoryId))
        .where(eq(mailThreadCategory.threadId, threadId));
      expect(rows.map((row) => row.slug)).toContain('new-bookings');
      expect(rows.map((row) => row.slug)).not.toContain('bookings');
    });
  });
});
