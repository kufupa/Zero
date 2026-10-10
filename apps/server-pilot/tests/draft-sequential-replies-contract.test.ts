import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mailDraft, mailThread, message } from '../src/db/schema/mail.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('sequential reply drafts', () => {
  it('keeps sent draft as history and exposes later active draft in same thread', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const firstInboundId = randomUUID();
      const firstOutboundId = randomUUID();
      const secondInboundId = randomUUID();
      const sentDraftId = randomUUID();
      const activeDraftId = randomUUID();

      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Second guest reply',
        latestMessageAt: new Date('2026-07-06T10:10:00Z'),
      });
      await db.insert(message).values([
        {
          id: firstInboundId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Booking',
          textBody: 'First guest question',
          receivedAt: new Date('2026-07-06T10:00:00Z'),
        },
        {
          id: firstOutboundId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'outbound',
          fromAddress: 'nava@example.com',
          toAddresses: ['guest@example.com'],
          subject: 'Re: Booking',
          textBody: 'First sent reply',
          sentAt: new Date('2026-07-06T10:05:00Z'),
        },
        {
          id: secondInboundId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Re: Booking',
          textBody: 'Second guest question',
          receivedAt: new Date('2026-07-06T10:10:00Z'),
        },
      ]);
      await db.insert(mailDraft).values([
        {
          id: sentDraftId,
          transportId: TRANSPORT_ID,
          threadId,
          createdByUserId: 'user-navaai',
          status: 'sent',
          origin: 'manual',
          replyToMessageId: firstInboundId,
          sentMessageId: firstOutboundId,
          isSent: true,
          toAddresses: ['guest@example.com'],
          subject: 'Re: Booking',
          textBody: 'First sent reply',
        },
        {
          id: activeDraftId,
          transportId: TRANSPORT_ID,
          threadId,
          createdByUserId: 'user-navaai',
          status: 'active',
          origin: 'manual',
          replyToMessageId: secondInboundId,
          isSent: false,
          toAddresses: ['guest@example.com'],
          subject: 'Re: Booking',
          textBody: 'Second active draft',
        },
      ]);

      const { mail } = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      const thread = await mail.get({ id: threadId });
      expect(thread.drafts.map((draft) => draft.id)).toEqual([activeDraftId]);
      expect(thread.drafts[0]).toMatchObject({
        status: 'active',
        replyToMessageId: secondInboundId,
        isStale: false,
      });
    });
  });
});
