import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { handledRequestKeys, hasOutstandingRequests, requestCompletionKeys, setRequestHandled } from '../src/ai/reservationist-task-completion.js';
import { refreshThreadWork } from '../src/ai/work-items.js';
import { aiWorkflowRun, mailThread, message } from '../src/db/schema/mail.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import { CENTURION_USER_ID, TRANSPORT_EMAIL, TRANSPORT_ID } from '../src/db/seed.js';
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

it('does not auto-close a malformed stored task inventory', () => {
  expect(hasOutstandingRequests(undefined, 'run', {})).toBe(false);
  expect(hasOutstandingRequests({ version: 1, tasks: null }, 'run', {})).toBe(true);
  expect(hasOutstandingRequests({ version: 2, tasks: [] }, 'run', {})).toBe(true);
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

  it('keeps the older email open across a newer request and a reply until both asks are handled', async () => {
    await withSeededTestDb(async db => {
      const threadId = randomUUID(), oldMessage = randomUUID(), newerMessage = randomUUID(), reply = randomUUID(), runId = randomUUID();
      const start = Date.now() - 180_000, at = (offset: number) => new Date(start + offset);
      await db.insert(mailThread).values({id:threadId,transportId:TRANSPORT_ID,threadRootId:`<${threadId}@example.invalid>`,latestMessageAt:at(20_000)});
      await db.insert(message).values([
        {id:oldMessage,transportId:TRANSPORT_ID,threadId,direction:'inbound',fromAddress:'guest@example.invalid',toAddresses:[TRANSPORT_EMAIL],textBody:'test test',receivedAt:at(0)},
        {id:newerMessage,transportId:TRANSPORT_ID,threadId,direction:'inbound',fromAddress:'guest@example.invalid',toAddresses:[TRANSPORT_EMAIL],textBody:'Another request.',receivedAt:at(10_000)},
      ]);
      const [old] = await db.insert(workItem).values({transportId:TRANSPORT_ID,threadId,sourceMessageId:oldMessage,kind:'other'}).returning();
      await db.insert(workItem).values({transportId:TRANSPORT_ID,threadId,sourceMessageId:newerMessage,kind:'quote'});
      const state = async () => (await db.select().from(workItem).where(eq(workItem.id, old!.id)))[0]!;
      await refreshThreadWork(db, {transportId:TRANSPORT_ID,threadId});
      expect((await state()).status).toBe('dismissed');
      await db.insert(aiWorkflowRun).values({id:runId,idempotencyKey:runId,transportId:TRANSPORT_ID,threadId,
        triggerMessageId:oldMessage,runKind:'candidate_draft',modelId:'synthetic',promptVersion:'test',state:'succeeded',
        metrics:{reservationistResult:{version:1,tasks:[task('one',0),task('two',5)]}}});
      await refreshThreadWork(db, {transportId:TRANSPORT_ID,threadId});
      expect((await state()).status).toBe('needs_you');
      await db.insert(message).values({id:reply,transportId:TRANSPORT_ID,threadId,direction:'outbound',fromAddress:TRANSPORT_EMAIL,
        toAddresses:['guest@example.invalid'],textBody:'Acknowledged.',receivedAt:at(20_000),sentAt:at(20_000)});
      const input = {transportId:TRANSPORT_ID,workItemId:old!.id,userId:CENTURION_USER_ID,runId,handled:true};
      await setRequestHandled(db,{...input,taskId:'one'});
      await refreshThreadWork(db, {transportId:TRANSPORT_ID,threadId});
      expect((await state()).status).toBe('needs_you');
      await setRequestHandled(db,{...input,taskId:'two'});
      await refreshThreadWork(db, {transportId:TRANSPORT_ID,threadId});
      expect((await state()).status).toBe('done');
      await setRequestHandled(db,{...input,taskId:'two',handled:false});
      await refreshThreadWork(db, {transportId:TRANSPORT_ID,threadId});
      expect((await state()).status).toBe('needs_you');
    });
  });
});
