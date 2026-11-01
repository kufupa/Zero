import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { handledRequestKeys, requestCompletionKeys, setRequestHandled } from '../src/ai/reservationist-task-completion.js';
import { aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import { CENTURION_USER_ID, TRANSPORT_ID } from '../src/db/seed.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';

const task = (id: string, start: number) => ({ id, kind: 'question', requestSource: {
  attachmentId: 'message:one', sourceHash: 'a'.repeat(64), page: 1, start, end: start + 4, quote: 'test',
} });

it('carries staff completion only across an unchanged, unique source span', () => {
  const before = requestCompletionKeys({ version: 1, tasks: [task('one', 0), task('two', 5)] }, 'run-a');
  const rerun = requestCompletionKeys({ version: 1, tasks: [task('renamed', 0), task('other', 9)] }, 'run-b');
  expect(before.get('one')).toBe(rerun.get('renamed'));
  expect(before.get('two')).not.toBe(rerun.get('other'));
  const ambiguous = requestCompletionKeys({ version: 1, tasks: [task('one', 0), task('two', 0)] }, 'run-a');
  expect(ambiguous.get('one')).not.toBe(ambiguous.get('two'));
  expect(ambiguous.get('one')).not.toBe(requestCompletionKeys({ version: 1, tasks: [task('one', 0), task('two', 0)] }, 'run-b').get('one'));
});

const reachable = await probeTestDb();
describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('staff request completion', () => {
  it('persists one acknowledgement, survives a rerun and refuses a stale or other-mailbox update', async () => {
    await withSeededTestDb(async db => {
      const threadId = randomUUID(), messageId = randomUUID(), runId = randomUUID(), nextRunId = randomUUID();
      const now = new Date();
      await db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID, threadRootId: `<${threadId}@example.invalid>`, latestMessageAt: now });
      await db.insert(message).values({ id: messageId, transportId: TRANSPORT_ID, threadId, direction: 'inbound', fromAddress: 'guest@example.invalid', toAddresses: [], textBody: 'test test', receivedAt: now });
      const [item] = await db.insert(workItem).values({ transportId: TRANSPORT_ID, threadId, sourceMessageId: messageId, kind: 'other' }).returning();
      const result = { version: 1, tasks: [task('one', 0), task('two', 5)] };
      const run = { transportId: TRANSPORT_ID, threadId, triggerMessageId: messageId, runKind: 'candidate_draft' as const,
        modelId: 'synthetic', promptVersion: 'test', state: 'succeeded' as const, metrics: { reservationistResult: result } };
      await db.insert(aiWorkflowRun).values({ ...run, id: runId, idempotencyKey: runId, createdAt: new Date(now.getTime() - 1000) });
      const input = { transportId: TRANSPORT_ID, workItemId: item!.id, userId: CENTURION_USER_ID, runId, taskId: 'one', handled: true };
      expect(await setRequestHandled(db, input)).toBe('recorded');
      const [saved] = await db.select().from(workItem).where(eq(workItem.id, item!.id));
      const keys = requestCompletionKeys(result, runId);
      expect(handledRequestKeys(saved!.state)).toEqual(new Set([keys.get('one')]));
      expect(saved!.status).toBe('needs_you');
      expect(await db.select().from(workEvent).where(eq(workEvent.workItemId, item!.id))).toHaveLength(1);
      const nextResult = { version: 1, tasks: [task('renamed', 0), task('two', 5)] };
      await db.insert(aiWorkflowRun).values({ ...run, id: nextRunId, idempotencyKey: nextRunId, createdAt: now, metrics: { reservationistResult: nextResult } });
      expect(handledRequestKeys(saved!.state).has(requestCompletionKeys(nextResult, nextRunId).get('renamed')!)).toBe(true);
      expect(await setRequestHandled(db, { ...input, handled: false })).toBe('stale');
      expect(await setRequestHandled(db, { ...input, runId: nextRunId, taskId: 'renamed', handled: false })).toBe('recorded');
      expect(await setRequestHandled(db, { ...input, transportId: 'different-mailbox' })).toBe('not_found');
    });
  });
});
