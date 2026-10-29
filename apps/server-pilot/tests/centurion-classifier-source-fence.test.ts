import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { attachment, mailboxTransport, message } from '../src/db/schema/mail.js';
import { mailExtraction } from '../src/db/schema/work.js';
import { __resetInboundExtractionCapForTests, EXTRACTION_VERSION, runInboundExtraction } from '../src/ai/extraction/inbound-run.js';
import { classifierForExtraction } from '../src/ai/workflow-classifier/source-fence.js';
import { storedWorkFor } from '../src/ai/work-items.js';
import { storeWorkflowClassifierForInbound } from '../src/ai/worker.js';
import { AE1_OUTPUT, fakeModel } from './fixtures/inbound-extraction.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';

const storage = vi.hoisted(() => vi.fn(() => { throw new Error('test storage unavailable'); }));
vi.mock('../src/storage/s3.js', async (original) => ({
  ...(await original<typeof import('../src/storage/s3.js')>()), getS3Storage: storage,
}));

const transportId = 'transport-centurion';
const env = { INBOUND_EXTRACTION: 'on' } as NodeJS.ProcessEnv;
const body = 'Please quote two rooms for 12 to 15 October 2027.';
const result = { workflow: 'billing', confidence: 'high' } as const;

beforeEach(() => { __resetInboundExtractionCapForTests(); storage.mockClear(); });
afterEach(() => __setDbForTests(null));

async function seed(db: DB, name: string, transport = transportId) {
  const threadId = `classifier-${name}`, messageId = `classifier-mail-${name}`, priorId = `classifier-prior-${name}`;
  await seedInboxThread(db, {
    threadId, messageId, transportId: transport,
    transportEmail: transport === transportId ? 'centurion@legacyhotels.co.za' : 'davinci@example.invalid',
    fromAddress: 'guest@example.invalid', subject: 'Room request', textBody: body,
  });
  await db.update(message).set({ receivedAt: new Date('2026-10-29T08:00:00Z') }).where(eq(message.id, messageId));
  await db.insert(message).values({
    id: priorId, threadId, transportId: transport, direction: 'outbound',
    fromAddress: 'staff@example.invalid', subject: 'Earlier', textBody: 'Previous details',
    receivedAt: new Date('2026-10-28T08:00:00Z'), createdAt: new Date('2026-10-28T08:00:00Z'),
  });
  return { threadId, messageId, priorId };
}

async function read(db: DB, messageId: string, transport = transportId) {
  const outcome = await runInboundExtraction({ transportId: transport, triggerMessageId: messageId,
    promptVersion: EXTRACTION_VERSION }, { db, env, adapter: fakeModel(() => AE1_OUTPUT).adapter });
  expect(outcome).toBe('stored');
  const [row] = await db.select().from(mailExtraction).where(eq(mailExtraction.messageId, messageId));
  if (!row) throw new Error('read fixture missing');
  return row;
}

describe('Centurion classifier source fence', () => {
  it('binds the actual classifier input and suppresses it when the source or bound result changes', () =>
    withIngestionDb(async ({ db, sql }) => {
      __setDbForTests({ db, conn: sql });
      const scope = await seed(db, 'success');
      const original = await read(db, scope.messageId);
      expect(original.usage?.sourceWitness).toMatchObject({ status: 'captured' });
      const classify = vi.fn(async (input: { subject: string; attachmentNames: string[]; bodyHead: string }) => {
        expect(input).toEqual({ subject: 'Room request', attachmentNames: [], bodyHead: body });
        // A real write inside the model callback proves the source transaction has ended.
        await db.update(message).set({ isRead: true }).where(eq(message.id, scope.messageId));
        return result;
      });
      await storeWorkflowClassifierForInbound(db, scope.messageId, classify);
      expect(classify).toHaveBeenCalledOnce();
      const [bound] = await db.select().from(mailExtraction).where(eq(mailExtraction.id, original.id));
      if (!bound) throw new Error('bound read missing');
      expect(classifierForExtraction(bound)).toEqual(result);
      const witness = bound.usage?.sourceWitness as { digest?: string } | undefined;
      expect(witness?.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(bound.usage?.classifierSourceProof).toMatchObject({ version: 1, extractionId: bound.id,
        sourceDigest: witness?.digest });
      expect(JSON.stringify(bound.usage?.classifierSourceProof)).not.toContain(body);
      expect(storage).not.toHaveBeenCalled();
      const lookup = { transportId, internetMessageId: `${scope.threadId}@example.com` };
      expect(await storedWorkFor(db, lookup)).toMatchObject({ status: 'ready', analysis: { luna: { workflow: 'send_document' } } });

      await db.update(message).set({ textBody: 'Please cancel instead.' }).where(eq(message.id, scope.messageId));
      expect(await storedWorkFor(db, lookup)).toMatchObject({ status: 'ready', analysis: { luna: { workflow: 'quote' } } });
      await db.update(message).set({ textBody: body }).where(eq(message.id, scope.messageId));
      expect(await storedWorkFor(db, lookup)).toMatchObject({ status: 'ready', analysis: { luna: { workflow: 'send_document' } } });

      await db.update(mailExtraction).set({ usage: { ...bound.usage, classifier: { workflow: 'cancel', confidence: 'high' } } })
        .where(eq(mailExtraction.id, bound.id));
      expect(await storedWorkFor(db, lookup)).toMatchObject({ status: 'ready', analysis: { luna: { workflow: 'quote' } } });
      await db.update(mailExtraction).set({ usage: bound.usage, payload: { ...bound.payload, agency: 'Changed agency' } })
        .where(eq(mailExtraction.id, bound.id));
      expect(await storedWorkFor(db, lookup)).toMatchObject({ status: 'ready', analysis: { luna: { workflow: 'quote' } } });
      await db.update(mailExtraction).set({ payload: bound.payload, usage: { ...bound.usage,
        sourceWitness: { version: 1, status: 'unproven', reason: 'translation_retry' } } }).where(eq(mailExtraction.id, bound.id));
      expect(await storedWorkFor(db, lookup)).toMatchObject({ status: 'ready', analysis: { luna: { workflow: 'quote' } } });
    }));

  it('does not invoke the classifier when mail changed after extraction, and repairs an unbound result only on a current source', () =>
    withIngestionDb(async ({ db, sql }) => {
      __setDbForTests({ db, conn: sql });
      const scope = await seed(db, 'before-classifier');
      const original = await read(db, scope.messageId);
      await db.update(mailExtraction).set({ usage: { ...original.usage, classifier: result } })
        .where(eq(mailExtraction.id, original.id));
      await db.update(message).set({ textBody: 'A different request' }).where(eq(message.id, scope.messageId));
      const classify = vi.fn(async () => result);
      await storeWorkflowClassifierForInbound(db, scope.messageId, classify);
      expect(classify).not.toHaveBeenCalled();
      const lookup = { transportId, internetMessageId: `${scope.threadId}@example.com` };
      expect(await storedWorkFor(db, lookup)).toMatchObject({ status: 'ready', analysis: { luna: { workflow: 'quote' } } });

      await db.update(message).set({ textBody: body }).where(eq(message.id, scope.messageId));
      await storeWorkflowClassifierForInbound(db, scope.messageId, classify);
      expect(classify).toHaveBeenCalledOnce();
      expect(await storedWorkFor(db, lookup)).toMatchObject({ status: 'ready', analysis: { luna: { workflow: 'send_document' } } });
    }));

  it('discards a classifier if the source, origin, attachment, extraction, or latest read changes during the model call', () =>
    withIngestionDb(async ({ db, sql }) => {
      __setDbForTests({ db, conn: sql });
      const scenarios: Array<{ name: string; change: (scope: Awaited<ReturnType<typeof seed>>,
        original: typeof mailExtraction.$inferSelect) => Promise<unknown> }> = [
        { name: 'body', change: (scope) => db.update(message).set({ textBody: 'Changed' }).where(eq(message.id, scope.messageId)) },
        { name: 'thread', change: (scope) => db.update(message).set({ textBody: 'Changed earlier details' }).where(eq(message.id, scope.priorId)) },
        { name: 'attachment', change: (scope) => db.insert(attachment).values({
          id: `new-${scope.messageId}`, messageId: scope.messageId, filename: 'request.pdf', mimeType: 'application/pdf',
          sizeBytes: 100, s3Key: `attachments/${scope.messageId}/request.pdf`, isInline: false,
        }) },
        { name: 'origin', change: (scope) => db.update(message).set({ toAddresses: ['davinci@legacyhotels.co.za'] })
          .where(eq(message.id, scope.messageId)) },
        { name: 'extraction', change: (_, original) => db.update(mailExtraction)
          .set({ payload: { ...original.payload, agency: 'Different agency' } }).where(eq(mailExtraction.id, original.id)) },
        { name: 'witness', change: (_, original) => db.update(mailExtraction)
          .set({ usage: { ...original.usage, sourceWitness: { version: 1, status: 'unproven', reason: 'translation_retry' } } })
          .where(eq(mailExtraction.id, original.id)) },
        { name: 'latest', change: (scope, original) => db.insert(mailExtraction).values({
          messageId: scope.messageId, extractorVersion: 'different-read', status: 'succeeded', kind: original.kind,
          payload: original.payload, createdAt: new Date('2030-01-01T00:00:00Z'),
        }) },
      ];
      for (const scenario of scenarios) {
        const scope = await seed(db, scenario.name);
        const original = await read(db, scope.messageId);
        const classify = vi.fn(async () => { await scenario.change(scope, original); return result; });
        await storeWorkflowClassifierForInbound(db, scope.messageId, classify);
        expect(classify, scenario.name).toHaveBeenCalledOnce();
        const [after] = await db.select().from(mailExtraction).where(eq(mailExtraction.id, original.id));
        expect(after?.usage?.classifier, scenario.name).toBeUndefined();
        expect(after?.usage?.classifierSourceProof, scenario.name).toBeUndefined();
      }
      expect(storage).not.toHaveBeenCalled();
    }));

  it('keeps unsupported and legacy/HRDAV classifier behavior while fencing a legacy-to-captured race', () =>
    withIngestionDb(async ({ db, sql }) => {
      __setDbForTests({ db, conn: sql });
      const unsupported = await seed(db, 'unsupported');
      await db.insert(attachment).values({
        id: 'unsupported-pdf', messageId: unsupported.messageId, filename: 'request.pdf', mimeType: 'application/pdf',
        sizeBytes: 100, s3Key: `attachments/${unsupported.messageId}/request.pdf`, isInline: false,
      });
      const unproven = await read(db, unsupported.messageId);
      expect(unproven.usage?.sourceWitness).toMatchObject({ status: 'unproven', reason: 'attachments' });
      const unprovenClassify = vi.fn(async () => result);
      await storeWorkflowClassifierForInbound(db, unsupported.messageId, unprovenClassify);
      const [unprovenAfter] = await db.select().from(mailExtraction).where(eq(mailExtraction.id, unproven.id));
      expect(unprovenClassify).toHaveBeenCalledOnce();
      expect(unprovenAfter?.usage?.classifier).toEqual(result);
      expect(unprovenAfter?.usage?.classifierSourceProof).toBeUndefined();

      await db.insert(mailboxTransport).values({ id: 'transport-davinci', email: 'davinci@example.invalid',
        ownerHeaderValue: 'davinci@example.invalid', mailboxType: 'personal' });
      const dav = await seed(db, 'davinci', 'transport-davinci');
      const davRead = await read(db, dav.messageId, 'transport-davinci');
      expect(davRead.usage?.sourceWitness).toBeUndefined();
      await storeWorkflowClassifierForInbound(db, dav.messageId, async () => result);
      const [davAfter] = await db.select().from(mailExtraction).where(eq(mailExtraction.id, davRead.id));
      expect(davAfter && classifierForExtraction(davAfter)).toEqual(result);

      const legacy = await seed(db, 'legacy-race');
      const legacyRead = await read(db, legacy.messageId);
      const legacyUsage = { ...legacyRead.usage };
      delete legacyUsage.sourceWitness;
      await db.update(mailExtraction).set({ usage: legacyUsage }).where(eq(mailExtraction.id, legacyRead.id));
      await storeWorkflowClassifierForInbound(db, legacy.messageId, async () => {
        await db.update(mailExtraction).set({ usage: { ...legacyUsage,
          sourceWitness: { version: 1, status: 'captured', digest: 'a'.repeat(64) } } })
          .where(eq(mailExtraction.id, legacyRead.id));
        return result;
      });
      const [transitioned] = await db.select().from(mailExtraction).where(eq(mailExtraction.id, legacyRead.id));
      expect(transitioned?.usage?.classifier).toBeUndefined();
    }));
});
