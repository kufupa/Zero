import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  applyDurableTriageResult,
  applyShadowTriageResult,
  validateTriageOutput,
} from '../src/ai/triage.js';
import { mailCategory, mailThread, mailThreadCategory } from '../src/db/schema/mail.js';
import { mailboxTransport } from '../src/db/schema/mail.js';
import { getDb } from '../src/db/client.js';
import { TEST_DB_AVAILABLE, probeTestDb } from './helpers/test-db.js';

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
});
