import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  applyDurableTriageResult,
  applyShadowTriageResult,
  validateTriageOutput,
} from '../src/ai/triage.js';
import { createMastraRuntime } from '../src/ai/mastra.js';
import { mailCategory, mailThread, mailThreadCategory } from '../src/db/schema/mail.js';
import { mailboxTransport } from '../src/db/schema/mail.js';
import { getDb } from '../src/db/client.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { TRANSPORT_ID } from '../src/db/seed.js';

const reachable = await probeTestDb();

describe('AI triage contract', () => {
  it('accepts hotel vocabulary categories', () => {
    for (const category of [
      'internal',
      'individual',
      'group',
      'travel-agents',
      'spam',
    ] as const) {
      expect(validateTriageOutput({
        category,
        urgent: false,
        confidence: 0.9,
        rationale: 'fixture',
      }).category).toBe(category);
    }
  });

  it('rejects invalid category or malformed JSON', () => {
    expect(() =>
      validateTriageOutput({
        category: 'marketing',
        urgent: false,
        confidence: 0.9,
        rationale: 'bad',
      }),
    ).toThrow();
    expect(() => validateTriageOutput({ foo: 'bar' })).toThrow();
  });

  it('records shadow metrics without mutating durable state', async () => {
    const shadow = applyShadowTriageResult({
      threadId: 'thread-1',
      transportId: 'transport-1',
      output: {
        category: 'group',
        urgent: true,
        confidence: 0.8,
        rationale: 'group quote language',
        policyFlags: [],
      },
      metrics: {},
    });
    expect(shadow.metrics).toMatchObject({
      shadow: true,
      category: 'group',
      urgent: true,
    });
  });

  it('mailTriageWorkflow returns validated output field', async () => {
    const mastra = createMastraRuntime(':memory:');
    const workflow = mastra.getWorkflow('mailTriage');
    const workflowRun = await workflow.createRun();
    const result = await workflowRun.start({
      inputData: {
        transportId: 'transport-centurion',
        threadId: 'thread-1',
        triggerMessageId: 'msg-1',
        subject: 'Group quote',
        body: 'Need 20 rooms for a group booking',
      },
    });
    expect(result.status).toBe('success');
    expect(result.result?.output).toMatchObject({
      category: 'group',
      urgent: expect.any(Boolean),
      confidence: expect.any(Number),
    });
    expect(result.result?.metrics).toMatchObject({ shadow: true });
  });
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('AI durable triage contract', () => {
  it('writes category membership and spam state only when write gate is enabled', async () => {
    const db = getDb();
    const transportId = randomUUID();
    const threadId = randomUUID();

    await db.insert(mailboxTransport).values({
      id: transportId,
      email: `nava-${transportId.slice(0, 8)}@example.com`,
      ownerHeaderValue: `nava-${transportId.slice(0, 8)}@example.com`,
    });
    await db.insert(mailThread).values({
      id: threadId,
      transportId,
      threadRootId: `<root-${threadId}@example.com>`,
      subject: 'Group quote',
      snippet: 'Need 20 rooms',
      latestMessageAt: new Date(),
    });
    const groupCategoryId = randomUUID();
    const urgentCategoryId = randomUUID();
    await db.insert(mailCategory).values([
      {
        id: groupCategoryId,
        transportId,
        slug: 'group',
        name: 'Group',
        sortOrder: 1,
      },
      {
        id: urgentCategoryId,
        transportId,
        slug: 'urgent',
        name: 'Urgent',
        sortOrder: 2,
      },
    ]);

    await applyDurableTriageResult({
      db,
      transportId,
      threadId,
      writeGateEnabled: false,
      output: {
        category: 'group',
        urgent: true,
        confidence: 0.9,
        rationale: 'shadow only',
        policyFlags: [],
      },
    });

    let memberships = await db
      .select()
      .from(mailThreadCategory)
      .where(eq(mailThreadCategory.threadId, threadId));
    expect(memberships).toHaveLength(0);

    await applyDurableTriageResult({
      db,
      transportId,
      threadId,
      writeGateEnabled: true,
      output: {
        category: 'group',
        urgent: true,
        confidence: 0.9,
        rationale: 'durable write',
        policyFlags: [],
      },
    });

    memberships = await db
      .select()
      .from(mailThreadCategory)
      .where(eq(mailThreadCategory.threadId, threadId));
    expect(memberships.map((row) => row.categoryId).sort()).toEqual(
      [groupCategoryId, urgentCategoryId].sort(),
    );

    await applyDurableTriageResult({
      db,
      transportId,
      threadId,
      writeGateEnabled: true,
      output: {
        category: 'spam',
        urgent: false,
        confidence: 0.99,
        rationale: 'sales spam',
        policyFlags: [],
      },
    });

    const [thread] = await db.select().from(mailThread).where(eq(mailThread.id, threadId));
    expect(thread?.spamAt).not.toBeNull();
  });

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
});
