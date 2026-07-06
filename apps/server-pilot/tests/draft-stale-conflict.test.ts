import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  mailDraft,
  mailDraftRevision,
  mailThread,
  message,
} from '../src/db/schema/mail.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('stale draft conflict', () => {
  it('rejects stale draft send until caller confirms, then writes sent revision', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const newerMessageId = randomUUID();
      const draftId = randomUUID();

      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'New reply',
        latestMessageAt: new Date('2026-07-06T10:05:00Z'),
      });
      await db.insert(message).values([
        {
          id: parentMessageId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Booking',
          textBody: 'First message',
          receivedAt: new Date('2026-07-06T10:00:00Z'),
        },
        {
          id: newerMessageId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Booking',
          textBody: 'New reply',
          receivedAt: new Date('2026-07-06T10:05:00Z'),
        },
      ]);
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-manager',
        status: 'active',
        origin: 'manual',
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Old draft',
        htmlBody: '<p>Old draft</p>',
      });

      const { mail } = await callerFor('user-manager', { db });
      await expect(
        mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: '<p>Old draft</p>',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'STALE_DRAFT' });

      await expect(
        mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: '<p>Old draft</p>',
          confirmStaleDraft: true,
        }),
      ).resolves.toMatchObject({ sent: true });

      const revisions = await db.select().from(mailDraftRevision);
      expect(revisions.some((revision) => revision.kind === 'sent')).toBe(true);
    });
  });
});
