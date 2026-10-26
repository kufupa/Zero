import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  enqueueQuotePdfJob,
  executeQuotePdfJob,
  quotePdfIdempotencyKey,
  quotePdfResultOf,
  readQuotePdfJob,
} from '../src/ai/quote-pdf-jobs.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { workItem } from '../src/db/schema/work.js';
import { DAVINCI_TRANSPORT_EMAIL, DAVINCI_TRANSPORT_ID } from '../src/db/seed.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';
import { probeTestDb, TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';

const reachable = await probeTestDb();

async function seedQuotePdfMail(db: DB) {
  const threadId = randomUUID();
  const messageId = randomUUID();
  await seedInboxThread(db, {
    threadId,
    transportId: DAVINCI_TRANSPORT_ID,
    transportEmail: DAVINCI_TRANSPORT_EMAIL,
    messageId,
    subject: 'Rooms request',
    textBody: 'Please quote two rooms.',
  });
  const [item] = await db
    .insert(workItem)
    .values({
      transportId: DAVINCI_TRANSPORT_ID,
      threadId,
      sourceMessageId: messageId,
      kind: 'quote',
      status: 'needs_you',
    })
    .returning({ id: workItem.id });
  if (!item) throw new Error('work item missing');
  return { threadId, messageId, workItemId: item.id };
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('quote PDF durable jobs (disposable DB)', () => {
  it('duplicate key returns one persisted result across worker restart', async () => {
    await withSeededTestDb(async (db) => {
      __setDbForTests({ db, conn: null as never });
      try {
        const { threadId, messageId, workItemId } = await seedQuotePdfMail(db);
        const revisionId = randomUUID();
        const artifact = {
          kind: 'quote_pdf' as const,
          revisionId,
          pdfHash: 'ab'.repeat(32),
          fileName: 'Quote - Agency 12-14 Oct.pdf',
          totalMinor: 240_000,
          pdfBase64: Buffer.from('%PDF-1.4 job').toString('base64'),
        };
        const generate = vi.fn(async () => artifact);
        const input = {
          transportId: DAVINCI_TRANSPORT_ID,
          threadId,
          triggerMessageId: messageId,
          workItemId,
          revisionId,
          propertyCode: 'HRDAV',
          db,
        };

        const first = await enqueueQuotePdfJob(input);
        expect(first.created).toBe(true);
        expect(first.run.idempotencyKey).toBe(quotePdfIdempotencyKey(workItemId, revisionId));
        expect(await executeQuotePdfJob({ run: first.run, generate, db })).toBe('succeeded');
        expect(generate).toHaveBeenCalledTimes(1);

        // Restarted worker sees the same row, not a second generation.
        expect(await executeQuotePdfJob({ run: first.run, generate, db })).toBe('succeeded');
        const duplicate = await enqueueQuotePdfJob(input);
        expect(duplicate.created).toBe(false);
        expect(duplicate.run.id).toBe(first.run.id);
        expect(quotePdfResultOf(duplicate.run)).toEqual(artifact);
        expect(
          await readQuotePdfJob({
            transportId: DAVINCI_TRANSPORT_ID,
            workItemId,
            revisionId,
            db,
          }),
        ).toMatchObject({ runId: first.run.id, state: 'succeeded', result: artifact });
        expect(generate).toHaveBeenCalledTimes(1);
      } finally {
        __setDbForTests(null);
      }
    });
  });
});
