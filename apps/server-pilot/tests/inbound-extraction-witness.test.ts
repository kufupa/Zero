import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import { attachment, mailboxTransport, message } from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import { buildInboundPrompt } from '../src/ai/extraction/extract.js';
import { captureCenturionExtractionSource } from '../src/ai/extraction/centurion-source-witness.js';
import { __resetInboundExtractionCapForTests, EXTRACTION_VERSION, retryInboundTranslation, runInboundExtraction } from '../src/ai/extraction/inbound-run.js';
import { TRANSLATE_RULES } from '../src/ai/extraction/translate.js';
import { loadSyncedQuoteSelectionFromMailbox } from '../src/ai/quote-workflow-synced-selection.js';
import { shouldRetryAiFailure } from '../src/ai/run-ledger.js';
import { AE1_OUTPUT, AE2_OUTPUT, echoTranslation, fakeModel } from './fixtures/inbound-extraction.js';
import { withIngestionDb } from './helpers/ingestion-db.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';

const storage = vi.hoisted(() => vi.fn(() => { throw new Error('test storage unavailable'); }));
vi.mock('../src/storage/s3.js', async (original) => ({
  ...(await original<typeof import('../src/storage/s3.js')>()), getS3Storage: storage,
}));

const transportId = 'transport-centurion';
const env = { INBOUND_EXTRACTION: 'on' } as NodeJS.ProcessEnv;
const body = 'Please quote two rooms for 12 to 15 October 2027, one adult per room.';

beforeEach(() => { __resetInboundExtractionCapForTests(); storage.mockClear(); });
afterEach(() => __setDbForTests(null));

async function seed(db: DB, name: string, transport = transportId) {
  const threadId = `witness-${name}`, messageId = `mail-${name}`, priorId = `prior-${name}`;
  await seedInboxThread(db, {
    threadId, messageId, transportId: transport,
    transportEmail: transport === transportId ? 'centurion@legacyhotels.co.za' : 'davinci@example.invalid',
    fromAddress: 'guest@example.invalid', subject: 'Accommodation enquiry', textBody: body,
  });
  await db.update(message).set({ receivedAt: new Date('2026-10-29T08:00:00Z') }).where(eq(message.id, messageId));
  await db.insert(message).values({
    id: priorId, threadId, transportId: transport, direction: 'outbound',
    fromAddress: 'staff@example.invalid', subject: 'Earlier correspondence', textBody: 'Earlier room details',
    receivedAt: new Date('2026-10-28T08:00:00Z'), createdAt: new Date('2026-10-28T08:00:00Z'),
  });
  return { threadId, messageId, priorId };
}

function run(db: DB, messageId: string, adapter: ReturnType<typeof fakeModel>['adapter'], transport = transportId) {
  return runInboundExtraction({ transportId: transport, triggerMessageId: messageId, promptVersion: EXTRACTION_VERSION },
    { db, env, adapter });
}

async function noReadOrWork(db: DB, messageId: string) {
  expect(await db.select().from(mailExtraction).where(eq(mailExtraction.messageId, messageId))).toHaveLength(0);
  expect(await db.select().from(workItem).where(eq(workItem.sourceMessageId, messageId))).toHaveLength(0);
}

describe('Centurion extraction input witness', () => {
  it('witnesses exactly the actual prompt without storage calls or raw mail in the receipt', () =>
    withIngestionDb(async ({ db }) => {
      const scope = await seed(db, 'same-input');
      await db.insert(attachment).values({
        id: 'inline-logo', messageId: scope.messageId, filename: 'logo.png', mimeType: 'image/png',
        sizeBytes: 100, s3Key: `attachments/${scope.messageId}/logo.png`, isInline: true,
      });
      const regular = await loadSyncedQuoteSelectionFromMailbox({
        transportId, messageId: scope.messageId, db, includeThreadState: true, trackVisionImages: true,
      });
      storage.mockClear();
      const source = await db.transaction((tx) => captureCenturionExtractionSource(tx as unknown as DB,
        { transportId, ...scope }, EXTRACTION_VERSION, env));
      expect(source.status).toBe('captured');
      if (source.status !== 'captured' || !regular) throw new Error('source fixture unavailable');
      expect(source.selection).toEqual(regular);
      const prompt = buildInboundPrompt(source.selection, source.from, source.mailbox,
        { env, propertyCode: source.propertyCode });
      const model = fakeModel(() => AE1_OUTPUT);
      expect(await run(db, scope.messageId, model.adapter)).toBe('stored');
      expect(model.calls).toHaveLength(1);
      expect(model.calls[0]).toMatchObject({ userPrompt: prompt.user, systemPrompt: prompt.system, images: [] });
      expect(model.calls[0]!.userPrompt).toContain('Earlier room details');
      expect(storage).not.toHaveBeenCalled();
      const [read] = await db.select().from(mailExtraction).where(eq(mailExtraction.messageId, scope.messageId));
      const witness = (read?.usage as Record<string, unknown>)?.sourceWitness;
      expect(witness).toEqual({ version: 1, status: 'captured', digest: source.digest });
      expect(JSON.stringify(witness)).not.toContain(body);
      expect(JSON.stringify(witness)).not.toContain('guest@example.invalid');
      expect(JSON.stringify(witness)).not.toContain('centurion@legacyhotels.co.za');
    }));

  it('discards a witnessed read if mail, prior thread, attachment, or origin changes during the model call', () =>
    withIngestionDb(async ({ db }) => {
      const scenarios: Array<{ name: string; failModel?: boolean;
        change: (scope: Awaited<ReturnType<typeof seed>>) => Promise<unknown> }> = [
        { name: 'body', change: (scope) => db.update(message).set({ textBody: 'Changed request' }).where(eq(message.id, scope.messageId)) },
        { name: 'thread', change: (scope) => db.update(message).set({ textBody: 'Changed earlier details' }).where(eq(message.id, scope.priorId)) },
        { name: 'attachment', change: (scope) => db.insert(attachment).values({
          id: `new-part-${scope.messageId}`, messageId: scope.messageId, filename: 'request.pdf', mimeType: 'application/pdf',
          sizeBytes: 100, s3Key: `attachments/${scope.messageId}/request.pdf`, isInline: false,
        }) },
        { name: 'origin', change: (scope) => db.update(message).set({ toAddresses: ['davinci@legacyhotels.co.za'] })
          .where(eq(message.id, scope.messageId)) },
        { name: 'failed-model', failModel: true,
          change: (scope) => db.update(message).set({ textBody: 'Changed before model failure' }).where(eq(message.id, scope.messageId)) },
        { name: 'mailbox', change: () => db.update(mailboxTransport).set({ email: 'other@example.invalid' })
          .where(eq(mailboxTransport.id, transportId)) },
      ];
      for (const scenario of scenarios) {
        const scope = await seed(db, scenario.name);
        const model = fakeModel(async () => {
          await scenario.change(scope);
          if (scenario.failModel) throw new Error('synthetic model failure');
          return AE1_OUTPUT;
        });
        await expect(run(db, scope.messageId, model.adapter)).rejects.toMatchObject({ failureClass: 'SOURCE_CHANGED' });
        await noReadOrWork(db, scope.messageId);
      }
      expect(storage).not.toHaveBeenCalled();
      const fence = { runId: 'run', claimOwner: 'owner', claimToken: 'token', deadlineAt: new Date(Date.now() + 60_000) };
      expect(shouldRetryAiFailure({ failureClass: 'SOURCE_CHANGED', fence, attempts: 0 })).toBe(true);
      expect(shouldRetryAiFailure({ failureClass: 'SOURCE_CHANGED', fence, attempts: 1 })).toBe(false);
    }));

  it('locks the source rows and FK inserts only for the short snapshot transaction', () =>
    withIngestionDb(async ({ db, url }) => {
      const scope = await seed(db, 'locks');
      const outside = await seed(db, 'outside-locks');
      await db.insert(attachment).values({
        id: 'inline-lock', messageId: scope.messageId, filename: 'logo.png', mimeType: 'image/png',
        sizeBytes: 100, s3Key: `attachments/${scope.messageId}/logo.png`, isInline: true,
      });
      const parsed = new URL(url);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
      const writer = postgres(url, { max: 1, connect_timeout: 5,
        ssl: local || parsed.searchParams.get('sslmode') === 'disable' ? false : getPostgresSslOptions(),
        onnotice: () => undefined });
      try {
        await db.transaction(async (tx) => {
          const source = await captureCenturionExtractionSource(tx as unknown as DB, { transportId, ...scope }, EXTRACTION_VERSION, env);
          expect(source.status).toBe('captured');
          const blocked = async (write: (sql: typeof writer) => Promise<unknown>) => {
            await expect(writer.begin(async (transaction) => {
              await transaction`set local lock_timeout = '100ms'`;
              await write(transaction as unknown as typeof writer);
            })).rejects.toMatchObject({ code: '55P03' });
          };
          await blocked((sql) => sql`update message set text_body = 'changed' where id = ${scope.priorId}`);
          await blocked((sql) => sql`update attachment set is_inline = false where id = 'inline-lock'`);
          await blocked((sql) => sql`insert into attachment (id, message_id, filename, mime_type, size_bytes, s3_key)
            values ('new-locked-attachment', ${scope.messageId}, 'new.pdf', 'application/pdf', 1, 'fake')`);
          await blocked((sql) => sql`insert into message (id, transport_id, thread_id, direction, from_address)
            values ('new-locked-message', ${transportId}, ${scope.threadId}, 'inbound', 'guest@example.invalid')`);
          await blocked((sql) => sql`update message set thread_id = ${scope.threadId} where id = ${outside.messageId}`);
          await blocked((sql) => sql`update mailbox_transport set email = 'other@example.invalid' where id = ${transportId}`);
        });
        await writer`update message set text_body = 'after snapshot' where id = ${scope.priorId}`;
        expect(storage).not.toHaveBeenCalled();
      } finally {
        await writer.end();
      }
    }));

  it('keeps attachment reads working without claiming a witness, and leaves HRDAV unchanged', () =>
    withIngestionDb(async ({ db, sql }) => {
      __setDbForTests({ db, conn: sql });
      const scope = await seed(db, 'document');
      await db.insert(attachment).values({
        id: 'request-document', messageId: scope.messageId, filename: 'request.pdf', mimeType: 'application/pdf',
        sizeBytes: 25_000, s3Key: `attachments/${scope.messageId}/request.pdf`, isInline: false,
      });
      const model = fakeModel(() => AE1_OUTPUT);
      expect(await run(db, scope.messageId, model.adapter)).toBe('stored');
      expect(model.calls[0]?.userPrompt).toContain('request.pdf');
      expect(storage).toHaveBeenCalled();
      const [read] = await db.select().from(mailExtraction).where(eq(mailExtraction.messageId, scope.messageId));
      expect((read?.usage as Record<string, unknown>)?.sourceWitness)
        .toEqual({ version: 1, status: 'unproven', reason: 'attachments' });

      await db.insert(mailboxTransport).values({ id: 'transport-davinci', email: 'davinci@example.invalid',
        ownerHeaderValue: 'davinci@example.invalid', mailboxType: 'personal' });
      const dav = await seed(db, 'davinci', 'transport-davinci');
      expect(await run(db, dav.messageId, fakeModel(() => AE1_OUTPUT).adapter, 'transport-davinci')).toBe('stored');
      const [other] = await db.select().from(mailExtraction).where(and(eq(mailExtraction.messageId, dav.messageId),
        eq(mailExtraction.extractorVersion, EXTRACTION_VERSION)));
      expect((other?.usage as Record<string, unknown>)?.sourceWitness).toBeUndefined();
    }));

  it('invalidates a captured witness when a translation retry reads a changed body', () =>
    withIngestionDb(async ({ db, sql }) => {
      __setDbForTests({ db, conn: sql });
      await db.insert(mailboxTransport).values({ id: 'transport-davinci', email: 'davinci@example.invalid',
        ownerHeaderValue: 'davinci@example.invalid', mailboxType: 'personal' });
      const cases = [
        { name: 'translated', transport: transportId, attachment: false },
        { name: 'translated-attachment', transport: transportId, attachment: true },
        { name: 'translated-davinci', transport: 'transport-davinci', attachment: false },
      ];
      for (const scenario of cases) {
        const scope = await seed(db, scenario.name, scenario.transport);
        await db.update(message).set({ textBody: 'Bonjour, je souhaite une chambre.' }).where(eq(message.id, scope.messageId));
        if (scenario.attachment) await db.insert(attachment).values({
          id: `part-${scope.messageId}`, messageId: scope.messageId, filename: 'request.pdf', mimeType: 'application/pdf',
          sizeBytes: 25_000, s3Key: `attachments/${scope.messageId}/request.pdf`, isInline: false,
        });
        const original = fakeModel((input) => input.systemPrompt === TRANSLATE_RULES ? { segments: [] } : AE2_OUTPUT);
        expect(await run(db, scope.messageId, original.adapter, scenario.transport)).toBe('stored');
        const [before] = await db.select().from(mailExtraction).where(eq(mailExtraction.messageId, scope.messageId));
        const [item] = await db.select().from(workItem).where(eq(workItem.sourceMessageId, scope.messageId));
        if (!before || !item) throw new Error('translation retry fixture unavailable');
        expect(before.translation).toMatchObject({ status: 'failed' });
        if (!scenario.attachment && scenario.transport === transportId) {
          expect(before.usage?.sourceWitness).toMatchObject({ version: 1, status: 'captured' });
        } else if (scenario.attachment) {
          expect(before.usage?.sourceWitness).toEqual({ version: 1, status: 'unproven', reason: 'attachments' });
        } else {
          expect(before.usage?.sourceWitness).toBeUndefined();
        }

        const changed = 'Bonjour, la demande est maintenant pour deux chambres.';
        await db.update(message).set({ textBody: changed }).where(eq(message.id, scope.messageId));
        const retry = fakeModel(echoTranslation);
        expect(await retryInboundTranslation({ transportId: scenario.transport, workItemId: item.id },
          { db, env, adapter: retry.adapter })).toMatchObject({ status: 'done', translation: { status: 'succeeded' } });
        expect(retry.calls[0]?.userPrompt).toContain(changed);
        const [after] = await db.select().from(mailExtraction).where(eq(mailExtraction.id, before.id));
        expect(after?.payload).toEqual(before.payload);
        expect(after?.usage?.sourceWitness).toEqual(
          !scenario.attachment && scenario.transport === transportId
            ? { version: 1, status: 'unproven', reason: 'translation_retry' }
            : before.usage?.sourceWitness,
        );
      }
    }));
});
