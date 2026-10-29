import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { captureQuoteSourceProof } from '../src/ai/child-occupancy.js';
import { captureCenturionExtractionSource, CENTURION_SOURCE_WITNESS_VERSION } from '../src/ai/extraction/centurion-source-witness.js';
import { quoteSourcePartyDigest } from '../src/ai/quote-source-party.js';
import { staffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { aiDraftGeneration, aiWorkflowRun, mailboxTransport, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import { assertDraftQuoteSourcesLocked } from '../src/trpc/routes/workstation.js';
import { appRouter } from '../src/trpc/router.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';
import { openTestDbSession, probeTestDb, TEST_DB_AVAILABLE } from './helpers/test-db.js';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('draft quote source lock (disposable PostgreSQL)', () => {
  it('lets a pricing writer finish when a draft encounters its already-locked generation', async () => {
    const saver = openTestDbSession(), writer = openTestDbSession();
    const id = randomUUID(), transportId = `draft-lock-${id}`, threadId = `thread-${id}`, messageId = `message-${id}`;
    const generationId = `generation-${id}`, runId = `run-${id}`, address = `${id}@example.invalid`;
    let releaseWriter: (() => void) | undefined;
    let writing: Promise<unknown> | undefined;
    try {
      await saver.db.insert(mailboxTransport).values({ id: transportId, email: address, ownerHeaderValue: address });
      await saver.db.insert(mailThread).values({ id: threadId, transportId, threadRootId: threadId });
      await saver.db.insert(message).values({ id: messageId, transportId, threadId, direction: 'inbound',
        messageIdHeader: address, fromAddress: 'sender@example.invalid' });
      await saver.db.insert(aiDraftGeneration).values({ id: generationId, transportId, threadId,
        requestedByUserId: 'staff-1', model: 'staff-approved-native', promptVersion: 'test' });
      let writerReady!: () => void, writerFailed!: (reason: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => { writerReady = resolve; writerFailed = reject; });
      const released = new Promise<void>((resolve) => { releaseWriter = resolve; });
      let finishQuote = false;
      writing = writer.db.transaction(async (tx) => {
        try {
          // This is the first lock taken by staff-quote-run.persistRun before inserting the workflow run.
          await tx.update(aiDraftGeneration).set({ status: 'succeeded' }).where(eq(aiDraftGeneration.id, generationId));
          writerReady();
          await released;
          if (finishQuote) await tx.insert(aiWorkflowRun).values({ id: runId, transportId, threadId,
            triggerMessageId: messageId, runKind: 'candidate_draft', idempotencyKey: runId,
            modelId: 'staff-approved-native', promptVersion: 'test', generationId, state: 'succeeded' });
        } catch (error) { writerFailed(error); throw error; }
      });
      await ready;
      const saving = saver.db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '4s'`);
        await assertDraftQuoteSourcesLocked(tx as unknown as DB, { transportId, threadId, messageId }, []);
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        saving.then(() => ({ kind: 'saved' as const }), (error: unknown) => ({ kind: 'busy' as const, error })),
        new Promise<{ kind: 'waited' }>((resolve) => { timer = setTimeout(() => resolve({ kind: 'waited' }), 1500); }),
      ]);
      if (timer) clearTimeout(timer);
      finishQuote = outcome.kind === 'busy';
      releaseWriter?.();
      await writing;
      writing = undefined;
      await saving.catch(() => undefined);
      expect(outcome.kind).toBe('busy');
      if (outcome.kind === 'busy') {
        const error = outcome.error as { code?: string; cause?: { code?: string } };
        expect([error.code, error.cause?.code]).toContain('55P03');
      }
      expect(await saver.db.select({ id: aiWorkflowRun.id }).from(aiWorkflowRun).where(eq(aiWorkflowRun.id, runId)))
        .toEqual([{ id: runId }]);
    } finally {
      releaseWriter?.();
      if (writing) await writing.catch(() => undefined);
      await Promise.all([saver.close(), writer.close()]);
    }
  }, 30000);

  it('holds the work item through commit and rejects a previously saved edit', async () => {
    const { withIngestionDb } = await import('./helpers/ingestion-db.js');
    const { default: postgres } = await import('postgres');
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { getPostgresSslOptions } = await import('../src/db/ssl-config.js');
    const schema = await import('../src/db/schema/index.js');
    await withIngestionDb(async ({ db, url }) => {
      const parsed = new URL(url);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
      const editorConnection = postgres(url, { max: 1, connect_timeout: 5,
        ssl: local || parsed.searchParams.get('sslmode') === 'disable' ? false : getPostgresSslOptions(),
        onnotice: () => undefined });
      const holder = { db }, editor = { db: drizzle(editorConnection, { schema }) };
      const id = randomUUID(), transportId = 'transport-centurion', threadId = `thread-${id}`, messageId = `message-${id}`;
      const address = `${id}@example.invalid`;
      try {
        await holder.db.insert(mailboxTransport).values({ id: transportId, email: 'centurion@legacyhotels.co.za',
          ownerHeaderValue: 'centurion@legacyhotels.co.za' }).onConflictDoNothing();
        await holder.db.insert(mailThread).values({ id: threadId, transportId, threadRootId: threadId });
        await holder.db.insert(message).values({ id: messageId, transportId, threadId, direction: 'inbound',
          messageIdHeader: address, fromAddress: 'sender@example.invalid', subject: 'Synthetic quote',
          textBody: 'Please quote one room for two adults and no children.' });
        const payload = { contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
          confirmationNumbers: [], missing: [], stays: [{ id: 's1', hotel: null,
            requested: { arrival: '2027-10-20', departure: '2027-10-21' }, booked: null, totalRooms: 1,
            rows: [{ id: 'g1', roomType: null, rooms: 1, adultsPerRoom: 2, childrenPerRoom: 0, childAges: [], board: null }] }] };
        const source = await holder.db.transaction((tx) => captureCenturionExtractionSource(tx as unknown as DB,
          { transportId, threadId, messageId }, 'test', process.env));
        expect(source.status).toBe('captured');
        if (source.status !== 'captured') throw new Error('synthetic quote source is not witnessed');
        const [read] = await holder.db.insert(mailExtraction).values({ messageId, extractorVersion: 'test',
          status: 'succeeded', kind: 'quote', payload, usage: { sourceWitness: {
            version: CENTURION_SOURCE_WITNESS_VERSION, status: 'captured', digest: source.digest,
          } } }).returning({ id: mailExtraction.id });
        const [item] = await holder.db.insert(workItem).values({ transportId, threadId, sourceMessageId: messageId,
          kind: 'quote', extractionId: read!.id }).returning({ id: workItem.id });
        const scope = { transportId, threadId, messageId, propertyCode: 'HRCEN' };
        __setDbForTests({ db: holder.db, conn: null as never });
        const api = appRouter.createCaller({ auth: null as never, reqHeaders: new Headers(),
          sessionUser: { id: 'staff-1', email: 'staff@example.invalid', name: 'Staff' },
          activeTransportId: transportId, accessRole: 'owner', transportEmail: 'centurion@legacyhotels.co.za' } as never).workItems;
        const pane = await api.getByMessage({ internetMessageId: `<${address}>` });
        if (pane.status !== 'ready') throw new Error('synthetic work item was not ready');
        const stale = staffQuoteInput.parse({ messageId, sourceHash: 'a'.repeat(64), selectionEpoch: 1, inputRevision: 1,
          sourcePartyDigest: quoteSourcePartyDigest(payload, {}), sourceExtractionId: read!.id,
          groups: [{ id: 'g1', arrivalDate: '2027-10-20', departureDate: '2027-10-21', quantity: 1, adults: 2,
            childrenPerRoom: 0, childrenAges: [], board: 'room_only', sourcePreference: { roomType: null, board: null } }] });
        expect(pane.sourcePartyDigest).toBe(stale.sourcePartyDigest);
        expect(pane.sourcePartyFields).toEqual({ company: ['missing'], endClient: ['missing'] });
        await api.recordEvent({ workItemId: item!.id, type: 'field.edit', fieldPath: 'contact.company', value: 'New Agency' });
        expect(await captureQuoteSourceProof(holder.db, stale, scope)).toBeNull();
        const refreshed = await api.getByMessage({ internetMessageId: `<${address}>` });
        if (refreshed.status !== 'ready') throw new Error('synthetic refreshed work item was not ready');
        expect(refreshed.sourcePartyDigest).not.toBe(stale.sourcePartyDigest);
        expect(refreshed.sourcePartyFields).toEqual({ company: ['value', 'New Agency'], endClient: ['missing'] });
        const input = { ...stale, sourcePartyDigest: refreshed.sourcePartyDigest ?? undefined };
        const proof = await captureQuoteSourceProof(holder.db, input, scope);
        expect(proof).not.toBeNull();
        await api.recordEvent({ workItemId: item!.id, type: 'field.edit', fieldPath: 'contact.company', value: null });
        const cleared = await api.getByMessage({ internetMessageId: `<${address}>` });
        if (cleared.status !== 'ready') throw new Error('synthetic cleared work item was not ready');
        expect(cleared.sourcePartyFields).toEqual({ company: ['cleared'], endClient: ['missing'] });
        expect(await captureQuoteSourceProof(holder.db, input, scope)).toBeNull();
        expect(await captureQuoteSourceProof(holder.db, { ...input, sourcePartyDigest: cleared.sourcePartyDigest ?? undefined }, scope)).not.toBeNull();
        await api.recordEvent({ workItemId: item!.id, type: 'field.edit', fieldPath: 'contact.company', value: 'New Agency' });
        const revision = await syntheticRevision(['600.00'], 'Room Only R', 'SKNG', undefined, '2027-10-20', 'auth-1',
          { id: 'g1', quantity: 1, adults: 2, children: 0, childAges: [] }, 'HRCEN');
        const sources = [{ revision, proof }];
        let locked!: () => void, fail!: (reason: unknown) => void, release!: () => void;
        const ready = new Promise<void>((resolve, reject) => { locked = resolve; fail = reject; });
        const done = new Promise<void>((resolve) => { release = resolve; });
        const saving = holder.db.transaction(async (tx) => {
          try {
            await assertDraftQuoteSourcesLocked(tx as unknown as DB, scope, sources);
            locked();
            await done;
          } catch (error) { fail(error); throw error; }
        });
        try {
          await ready;
          const error = await editor.db.execute(sql`select id from ${workItem} where id = ${item!.id} for update nowait`)
            .then(() => null, (reason: unknown) => reason as { code?: string; cause?: { code?: string } });
          expect([error?.code, error?.cause?.code]).toContain('55P03');
          const extractionUpdate = await editor.db.execute(sql`select id from ${mailExtraction} where id = ${read!.id} for update nowait`)
            .then(() => null, (reason: unknown) => reason as { code?: string; cause?: { code?: string } });
          expect([extractionUpdate?.code, extractionUpdate?.cause?.code]).toContain('55P03');
          const insertRead = await editor.db.transaction(async (tx) => {
            await tx.execute(sql`set local lock_timeout = '250ms'`);
            await tx.insert(mailExtraction).values({ messageId, extractorVersion: 'concurrent',
              status: 'succeeded', kind: 'quote', payload });
          }).then(() => null, (reason: unknown) => reason as { code?: string; cause?: { code?: string } });
          expect([insertRead?.code, insertRead?.cause?.code]).toContain('55P03');
          const insertApproval = await editor.db.transaction(async (tx) => {
            await tx.execute(sql`set local lock_timeout = '250ms'`);
            await tx.insert(aiDraftGeneration).values({ id: `new-${id}`, transportId, threadId,
              requestedByUserId: 'staff-1', model: 'staff-approved-native', promptVersion: 'test' });
          }).then(() => null, (reason: unknown) => reason as { code?: string; cause?: { code?: string } });
          expect([insertApproval?.code, insertApproval?.cause?.code]).toContain('55P03');
        } finally {
          release();
          await saving;
        }
        await editor.db.update(workItem).set({ state: { 'stays[s1].rows[g1].roomType': 'Standard Twin' } })
          .where(eq(workItem.id, item!.id));
        await expect(holder.db.transaction((tx) => assertDraftQuoteSourcesLocked(tx as unknown as DB, scope, sources)))
          .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        await editor.db.update(workItem).set({ state: { 'contact.company': 'New Agency' } }).where(eq(workItem.id, item!.id));
        await expect(holder.db.transaction((tx) => assertDraftQuoteSourcesLocked(tx as unknown as DB, scope, sources)))
          .resolves.toBeUndefined();
        await editor.db.insert(mailExtraction).values({ messageId, extractorVersion: 'newer',
          status: 'succeeded', kind: 'quote', payload, createdAt: new Date(Date.now() + 1000) });
        await expect(holder.db.transaction((tx) => assertDraftQuoteSourcesLocked(tx as unknown as DB, scope, sources)))
          .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      } finally {
        __setDbForTests(null);
        await editorConnection.end();
      }
    }, { seed: false });
  }, 120000);
});
