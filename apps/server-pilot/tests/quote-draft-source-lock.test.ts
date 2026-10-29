import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { captureQuoteSourceProof } from '../src/ai/child-occupancy.js';
import { staffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import type { DB } from '../src/db/client.js';
import { mailboxTransport, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import { assertDraftQuoteSourcesLocked } from '../src/trpc/routes/workstation.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';
import { openTestDbSession, probeTestDb, TEST_DB_AVAILABLE } from './helpers/test-db.js';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('draft quote source lock (disposable PostgreSQL)', () => {
  it('holds the work item through commit and rejects a previously saved edit', async () => {
    const holder = openTestDbSession(), editor = openTestDbSession();
    const id = randomUUID(), transportId = `draft-lock-${id}`, threadId = `thread-${id}`, messageId = `message-${id}`;
    const address = `${id}@example.invalid`;
    try {
      await holder.db.insert(mailboxTransport).values({ id: transportId, email: address, ownerHeaderValue: address });
      await holder.db.insert(mailThread).values({ id: threadId, transportId, threadRootId: threadId });
      await holder.db.insert(message).values({ id: messageId, transportId, threadId, direction: 'inbound', fromAddress: address });
      const payload = { contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
        confirmationNumbers: [], missing: [], stays: [{ id: 's1', hotel: null,
          requested: { arrival: '2027-10-20', departure: '2027-10-21' }, booked: null, totalRooms: 1,
          rows: [{ id: 'g1', roomType: null, rooms: 1, adultsPerRoom: 2, childrenPerRoom: 0, childAges: [], board: null }] }] };
      const [read] = await holder.db.insert(mailExtraction).values({ messageId, extractorVersion: 'test',
        status: 'succeeded', kind: 'quote', payload }).returning({ id: mailExtraction.id });
      const [item] = await holder.db.insert(workItem).values({ transportId, threadId, sourceMessageId: messageId,
        kind: 'quote', extractionId: read!.id }).returning({ id: workItem.id });
      const scope = { transportId, threadId, messageId, propertyCode: 'HRCEN' };
      const input = staffQuoteInput.parse({ messageId, sourceHash: 'a'.repeat(64), selectionEpoch: 1, inputRevision: 1,
        groups: [{ id: 'g1', arrivalDate: '2027-10-20', departureDate: '2027-10-21', quantity: 1, adults: 2,
          childrenPerRoom: 0, childrenAges: [], board: 'room_only', sourcePreference: { roomType: null, board: null } }] });
      const proof = await captureQuoteSourceProof(holder.db, input, scope);
      expect(proof).not.toBeNull();
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
      } finally {
        release();
        await saving;
      }
      await editor.db.update(workItem).set({ state: { 'stays[s1].rows[g1].roomType': 'Standard Twin' } })
        .where(eq(workItem.id, item!.id));
      await expect(holder.db.transaction((tx) => assertDraftQuoteSourcesLocked(tx as unknown as DB, scope, sources)))
        .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    } finally {
      await Promise.all([holder.close(), editor.close()]);
    }
  }, 30000);
});
