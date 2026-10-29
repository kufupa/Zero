import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { captureQuoteSourceProof, quoteSourceProofIsCurrent } from '../src/ai/child-occupancy.js';
import { staffQuoteInput } from '../src/ai/staff-quote-workflow.js';
import { __setDbForTests } from '../src/db/client.js';
import { mailboxTransport, mailThread, message } from '../src/db/schema/mail.js';
import { mailExtraction, workItem } from '../src/db/schema/work.js';
import { appRouter } from '../src/trpc/router.js';
import { openTestDbSession, probeTestDb, TEST_DB_AVAILABLE } from './helpers/test-db.js';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('Centurion quote party source (disposable PostgreSQL)', () => {
  it('requires the pane to see saved party edits and distinguishes a clear from a missing value', async () => {
    const holder = openTestDbSession();
    const id = randomUUID(), transportId = `party-source-${id}`, threadId = `thread-${id}`, messageId = `message-${id}`;
    const address = `${id}@example.invalid`;
    try {
      await holder.db.insert(mailboxTransport).values({ id: transportId, email: address, ownerHeaderValue: address });
      await holder.db.insert(mailThread).values({ id: threadId, transportId, threadRootId: threadId });
      await holder.db.insert(message).values({ id: messageId, transportId, threadId, direction: 'inbound',
        messageIdHeader: address, fromAddress: 'sender@example.invalid' });
      const payload = { contact: { name: null, email: null, phone: null }, agency: null, endClient: null,
        confirmationNumbers: [], missing: [], stays: [{ id: 's1', hotel: null,
          requested: { arrival: '2027-10-20', departure: '2027-10-21' }, booked: null, totalRooms: 1,
          rows: [{ id: 'g1', roomType: null, rooms: 1, adultsPerRoom: 2, childrenPerRoom: 0, childAges: [], board: null }] }] };
      const [read] = await holder.db.insert(mailExtraction).values({ messageId, extractorVersion: 'test',
        status: 'succeeded', kind: 'quote', payload }).returning({ id: mailExtraction.id });
      const [item] = await holder.db.insert(workItem).values({ transportId, threadId, sourceMessageId: messageId,
        kind: 'quote', extractionId: read!.id }).returning({ id: workItem.id });
      const scope = { transportId, threadId, messageId, propertyCode: 'HRCEN' };
      __setDbForTests({ db: holder.db, conn: null as never });
      const api = appRouter.createCaller({ auth: null as never, reqHeaders: new Headers(),
        sessionUser: { id: 'staff-1', email: 'staff@example.invalid', name: 'Staff' },
        activeTransportId: transportId, accessRole: 'owner', transportEmail: address } as never).workItems;
      const initial = await api.getByMessage({ internetMessageId: `<${address}>` });
      if (initial.status !== 'ready') throw new Error('synthetic work item was not ready');
      expect(initial.sourcePartyFields).toEqual({ company: ['missing'], endClient: ['missing'] });
      const stale = staffQuoteInput.parse({ messageId, sourceHash: 'a'.repeat(64), selectionEpoch: 1, inputRevision: 1,
        sourcePartyDigest: initial.sourcePartyDigest, sourceExtractionId: read!.id,
        groups: [{ id: 'g1', arrivalDate: '2027-10-20', departureDate: '2027-10-21', quantity: 1, adults: 2,
          childrenPerRoom: 0, childrenAges: [], board: 'room_only', sourcePreference: { roomType: null, board: null } }] });
      const originalProof = await captureQuoteSourceProof(holder.db, stale, scope);
      expect(originalProof).not.toBeNull();
      await api.recordEvent({ workItemId: item!.id, type: 'field.edit', fieldPath: 'contact.company', value: 'New Agency' });
      expect(await captureQuoteSourceProof(holder.db, stale, scope)).toBeNull();
      expect(await quoteSourceProofIsCurrent(holder.db, stale.groups, scope, originalProof)).toBe(false);
      const changed = await api.getByMessage({ internetMessageId: `<${address}>` });
      if (changed.status !== 'ready') throw new Error('synthetic changed work item was not ready');
      expect(changed.sourcePartyFields).toEqual({ company: ['value', 'New Agency'], endClient: ['missing'] });
      const current = { ...stale, sourcePartyDigest: changed.sourcePartyDigest ?? undefined };
      const proof = await captureQuoteSourceProof(holder.db, current, scope);
      expect(proof).not.toBeNull();
      await api.recordEvent({ workItemId: item!.id, type: 'field.edit', fieldPath: 'contact.phone', value: '1234' });
      expect(await quoteSourceProofIsCurrent(holder.db, current.groups, scope, proof)).toBe(true);
      await api.recordEvent({ workItemId: item!.id, type: 'field.edit', fieldPath: 'contact.endClient', value: 'New Client' });
      expect(await captureQuoteSourceProof(holder.db, current, scope)).toBeNull();
      const endClient = await api.getByMessage({ internetMessageId: `<${address}>` });
      if (endClient.status !== 'ready') throw new Error('synthetic end client was not ready');
      expect(endClient.sourcePartyFields).toEqual({ company: ['value', 'New Agency'], endClient: ['value', 'New Client'] });
      expect(await captureQuoteSourceProof(holder.db, { ...current, sourcePartyDigest: endClient.sourcePartyDigest ?? undefined }, scope)).not.toBeNull();
      await api.recordEvent({ workItemId: item!.id, type: 'field.edit', fieldPath: 'contact.company', value: null });
      const cleared = await api.getByMessage({ internetMessageId: `<${address}>` });
      if (cleared.status !== 'ready') throw new Error('synthetic cleared work item was not ready');
      expect(cleared.sourcePartyFields).toEqual({ company: ['cleared'], endClient: ['value', 'New Client'] });
      expect(await captureQuoteSourceProof(holder.db, current, scope)).toBeNull();
      expect(await captureQuoteSourceProof(holder.db, { ...current, sourcePartyDigest: cleared.sourcePartyDigest ?? undefined }, scope)).not.toBeNull();
    } finally {
      __setDbForTests(null);
      await holder.close();
    }
  }, 30000);
});
