/**
 * Webmail Save reply: drafts.saveReply keeps the thread's one active draft as a revision, and drafts.savedReply
 * reads it back with its PDF for the Outlook pane's Insert saved reply.
 */
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/client.js';
import { aiDraftGeneration, mailDraft, mailDraftRevision } from '../src/db/schema/mail.js';
import { CENTURION_USER_ID, NAVA_USER_ID, TRANSPORT_EMAIL, TRANSPORT_ID } from '../src/db/seed.js';
import { configureDraftArtifactStorage } from '../src/trpc/routes/drafts.js';
import { seedInboxThread } from './helpers/seed-inbox-thread';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';

const reachable = await probeTestDb();

const THREAD_ID = 'thread-save-reply';
const MESSAGE_ID = 'msg-save-reply';
const COMPOSER_THREAD_ID = 'thread-composer-only';
const COMPOSER_MESSAGE_ID = 'msg-composer-only';
// "%PDF-1.4 saved": 14 bytes, canonical base64.
const PDF_BASE64 = 'JVBERi0xLjQgc2F2ZWQ=';
const PDF = {
  name: 'Quotation.pdf',
  type: 'application/pdf',
  size: Buffer.from(PDF_BASE64, 'base64').length,
  lastModified: 1,
  base64: PDF_BASE64,
};

function saveInput(html: string, replaceExisting = false) {
  return {
    threadId: THREAD_ID,
    replyToMessageId: MESSAGE_ID,
    to: ['guest@example.com'],
    subject: 'Re: Quote request',
    html,
    attachments: [PDF],
    replaceExisting,
  };
}

async function seedThreads(db: DB): Promise<void> {
  await seedInboxThread(db, {
    threadId: THREAD_ID,
    transportId: TRANSPORT_ID,
    transportEmail: TRANSPORT_EMAIL,
    messageId: MESSAGE_ID,
    fromAddress: 'guest@example.com',
  });
  await seedInboxThread(db, {
    threadId: COMPOSER_THREAD_ID,
    transportId: TRANSPORT_ID,
    transportEmail: TRANSPORT_EMAIL,
    messageId: COMPOSER_MESSAGE_ID,
    fromAddress: 'guest@example.com',
  });
}

/** The error a refused call throws, so the test can read its code and message. */
async function refusalOf(call: Promise<unknown>): Promise<TRPCError> {
  try {
    await call;
  } catch (error) {
    return error as TRPCError;
  }
  throw new Error('expected the call to be refused');
}

/** Local-only artifact storage, the test double for the approved S3 adapter. */
function memoryArtifactStorage() {
  const objects = new Map<string, Buffer>();
  return {
    stage: async (key: string, body: Buffer) => {
      objects.set(key, Buffer.from(body));
    },
    read: async (key: string) => objects.get(key) ?? null,
  };
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'webmail save reply (seeded, transaction-rollback)',
  () => {
    beforeEach(() => {
      configureDraftArtifactStorage(memoryArtifactStorage());
    });
    afterEach(() => {
      configureDraftArtifactStorage(null);
    });

    it(
      'saves one active draft through a revision, sanitised, and reads it back with its PDF',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedThreads(db);
          const nava = await callerFor(NAVA_USER_ID, { db, requestedTransportId: TRANSPORT_ID });

          const saved = await nava.drafts.saveReply(
            saveInput('<p>Quote for you</p><script>alert(1)</script>'),
          );

          expect(saved).toEqual({ id: expect.any(String), replaced: false });
          const drafts = await db.select().from(mailDraft).where(eq(mailDraft.threadId, THREAD_ID));
          expect(drafts).toHaveLength(1);
          expect(drafts[0]).toMatchObject({ id: saved.id, origin: 'manual', isSent: false, status: 'active' });
          expect(drafts[0]?.htmlBody).toContain('Quote for you');
          expect(drafts[0]?.htmlBody).not.toMatch(/<script/i);

          const revisions = await db
            .select()
            .from(mailDraftRevision)
            .where(eq(mailDraftRevision.draftId, saved.id));
          // A saved reply is a human revision, never labelled as AI output.
          expect(revisions.map((r) => [r.kind, r.actorUserId])).toEqual([['created', NAVA_USER_ID]]);
          expect(revisions[0]?.id).toMatch(/^saved-reply:/);

          const read = await nava.drafts.savedReply({ threadId: THREAD_ID });
          expect(read).toEqual({
            id: saved.id,
            html: drafts[0]?.htmlBody,
            attachments: [{ fileName: 'Quotation.pdf', pdfBase64: PDF_BASE64 }],
          });
        });
      },
      30000,
    );

    it(
      'an untouched saved reply is updated in place, without a replace prompt',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedThreads(db);
          const nava = await callerFor(NAVA_USER_ID, { db, requestedTransportId: TRANSPORT_ID });
          const first = await nava.drafts.saveReply(saveInput('<p>First</p>'));

          const second = await nava.drafts.saveReply(saveInput('<p>Second</p>'));

          expect(second).toEqual({ id: first.id, replaced: false });
          const drafts = await db.select().from(mailDraft).where(eq(mailDraft.threadId, THREAD_ID));
          expect(drafts.map((d) => d.id)).toEqual([first.id]);
          const revisions = await db
            .select()
            .from(mailDraftRevision)
            .where(eq(mailDraftRevision.draftId, first.id));
          expect(revisions.map((r) => r.kind).sort()).toEqual(['created', 'edited']);
          expect((await nava.drafts.savedReply({ threadId: THREAD_ID }))?.html).toContain('Second');
        });
      },
      30000,
    );

    it(
      "another person's saved reply needs the replace confirm, then is set aside for a new draft",
      async () => {
        await withSeededTestDb(async (db) => {
          await seedThreads(db);
          const nava = await callerFor(NAVA_USER_ID, { db, requestedTransportId: TRANSPORT_ID });
          const centurion = await callerFor(CENTURION_USER_ID, {
            db,
            requestedTransportId: TRANSPORT_ID,
          });
          const first = await nava.drafts.saveReply(saveInput('<p>Navaai reply</p>'));

          const refused = await refusalOf(
            centurion.drafts.saveReply(saveInput('<p>Centurion reply</p>')),
          );
          expect(refused.code).toBe('CONFLICT');
          expect(refused.message).toBe('DRAFT_REPLACE_CONFIRM_REQUIRED');

          const replaced = await centurion.drafts.saveReply(
            saveInput('<p>Centurion reply</p>', true),
          );
          expect(replaced).toEqual({ id: expect.any(String), replaced: true });
          expect(replaced.id).not.toBe(first.id);
          const [old] = await db.select().from(mailDraft).where(eq(mailDraft.id, first.id));
          expect(old).toMatchObject({ status: 'discarded' });
          expect(old?.htmlBody).toContain('Navaai reply');
          const [current] = await db.select().from(mailDraft).where(eq(mailDraft.id, replaced.id));
          expect(current).toMatchObject({ status: 'active', createdByUserId: CENTURION_USER_ID });
          expect(current?.htmlBody).toContain('Centurion reply');
        });
      },
      30000,
    );

    it(
      'a hand edit needs the replace confirm, then replaceExisting sets it aside for a new draft',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedThreads(db);
          const nava = await callerFor(NAVA_USER_ID, { db, requestedTransportId: TRANSPORT_ID });
          const first = await nava.drafts.saveReply(saveInput('<p>Saved</p>'));

          // Staff edit the draft by hand in the composer. A test transaction shares one timestamp, so the
          // edit is dated later to be the latest revision, as it is in production.
          await nava.drafts.create({
            id: first.id,
            threadId: THREAD_ID,
            replyToMessageId: MESSAGE_ID,
            to: 'guest@example.com',
            subject: 'Re: Quote request',
            message: '<p>Hand edit</p>',
            attachments: [PDF],
          });
          await db
            .update(mailDraftRevision)
            .set({ createdAt: new Date(Date.now() + 60_000) })
            .where(and(eq(mailDraftRevision.draftId, first.id), eq(mailDraftRevision.kind, 'edited')));

          const refused = await refusalOf(nava.drafts.saveReply(saveInput('<p>Overwrite</p>')));
          expect(refused.code).toBe('CONFLICT');
          expect(refused.message).toBe('DRAFT_REPLACE_CONFIRM_REQUIRED');
          const [unchanged] = await db.select().from(mailDraft).where(eq(mailDraft.id, first.id));
          expect(unchanged?.htmlBody).toContain('Hand edit');

          const replaced = await nava.drafts.saveReply(saveInput('<p>Overwrite</p>', true));
          expect(replaced).toEqual({ id: expect.any(String), replaced: true });
          const [kept] = await db.select().from(mailDraft).where(eq(mailDraft.id, first.id));
          expect(kept).toMatchObject({ status: 'discarded' });
          expect(kept?.htmlBody).toContain('Hand edit');
          expect((await nava.drafts.savedReply({ threadId: THREAD_ID }))?.html).toContain('Overwrite');
        });
      },
      30000,
    );

    it(
      'an active AI draft needs the replace confirm and keeps its origin, generation and revisions',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedThreads(db);
          const nava = await callerFor(NAVA_USER_ID, { db, requestedTransportId: TRANSPORT_ID });
          await db.insert(aiDraftGeneration).values({
            id: 'gen-save-reply',
            transportId: TRANSPORT_ID,
            threadId: THREAD_ID,
            requestedByUserId: NAVA_USER_ID,
            model: 'test-model',
            promptVersion: 'test',
          });
          await db.insert(mailDraft).values({
            id: 'draft-ai-active',
            transportId: TRANSPORT_ID,
            threadId: THREAD_ID,
            createdByUserId: NAVA_USER_ID,
            replyToMessageId: MESSAGE_ID,
            htmlBody: '<p>AI reply</p>',
            status: 'active',
            origin: 'ai',
            generationId: 'gen-save-reply',
          });
          await db.insert(mailDraftRevision).values({
            id: 'rev-ai-active',
            draftId: 'draft-ai-active',
            generationId: 'gen-save-reply',
            kind: 'ai_generated',
            htmlBody: '<p>AI reply</p>',
          });

          const refused = await refusalOf(nava.drafts.saveReply(saveInput('<p>Mine</p>')));
          expect(refused.message).toBe('DRAFT_REPLACE_CONFIRM_REQUIRED');

          const saved = await nava.drafts.saveReply(saveInput('<p>Mine</p>', true));
          expect(saved.replaced).toBe(true);
          const [ai] = await db.select().from(mailDraft).where(eq(mailDraft.id, 'draft-ai-active'));
          expect(ai).toMatchObject({ status: 'discarded', origin: 'ai', generationId: 'gen-save-reply' });
          expect(ai?.htmlBody).toBe('<p>AI reply</p>');
          const aiRevisions = await db
            .select()
            .from(mailDraftRevision)
            .where(eq(mailDraftRevision.draftId, 'draft-ai-active'));
          expect(aiRevisions.map((r) => r.kind)).toEqual(['ai_generated']);
          const [mine] = await db.select().from(mailDraft).where(eq(mailDraft.id, saved.id));
          expect(mine).toMatchObject({ status: 'active', origin: 'manual', generationId: null });
        });
      },
      30000,
    );

    it(
      'a draft typed in the composer is not a saved reply',
      async () => {
        await withSeededTestDb(async (db) => {
          await seedThreads(db);
          const nava = await callerFor(NAVA_USER_ID, { db, requestedTransportId: TRANSPORT_ID });
          await nava.drafts.create({
            threadId: COMPOSER_THREAD_ID,
            replyToMessageId: COMPOSER_MESSAGE_ID,
            to: 'guest@example.com',
            subject: 'Re: Quote request',
            message: '<p>Typed by hand</p>',
            attachments: [],
          });

          expect(await nava.drafts.savedReply({ threadId: COMPOSER_THREAD_ID })).toBeNull();
          expect(await nava.drafts.savedReply({ threadId: THREAD_ID })).toBeNull();
        });
      },
      30000,
    );
  },
);
