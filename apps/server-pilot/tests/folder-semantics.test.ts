import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { mailThread, message } from '../src/db/schema/mail.js';
import { buildMailFolderConditions } from '../src/mail/folder-semantics.js';
import { TRANSPORT_ID, TRANSPORT_EMAIL } from '../src/db/seed.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';
import { seedInboxThread } from './helpers/seed-inbox-thread.js';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('folder-semantics dual membership (R3)', () => {
  it(
    'mixed inbound+outbound thread appears in both inbox and sent',
    async () => {
      await withSeededTestDb(async (db) => {
        const threadId = `th-r3-mixed-${Date.now()}`;
        const inboundId = `msg-r3-in-${Date.now()}`;
        const outboundId = `msg-r3-out-${Date.now()}`;
        const now = new Date();

        await seedInboxThread(db, {
          threadId,
          transportId: TRANSPORT_ID,
          transportEmail: TRANSPORT_EMAIL,
          subject: 'R3 mixed thread',
          messageId: inboundId,
          fromAddress: 'guest@example.com',
          isRead: false,
        });

        await db.insert(message).values({
          id: outboundId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'outbound',
          fromAddress: TRANSPORT_EMAIL,
          toAddresses: ['guest@example.com'],
          ccAddresses: [],
          bccAddresses: [],
          subject: 'R3 mixed thread',
          textBody: 'hotel reply',
          ownerHeaderValue: null,
          messageIdHeader: `${outboundId}@legacyhotels.co.za`,
          references: [],
          isRead: true,
          isStarred: false,
          receivedAt: now,
          sentAt: now,
        });

        const inboxConds = buildMailFolderConditions(db, TRANSPORT_ID, 'inbox');
        const sentConds = buildMailFolderConditions(db, TRANSPORT_ID, 'sent');

        const inboxHits = await db
          .select({ id: mailThread.id })
          .from(mailThread)
          .where(and(...inboxConds, eq(mailThread.id, threadId)));
        const sentHits = await db
          .select({ id: mailThread.id })
          .from(mailThread)
          .where(and(...sentConds, eq(mailThread.id, threadId)));

        expect(inboxHits.map((r) => r.id)).toContain(threadId);
        expect(sentHits.map((r) => r.id)).toContain(threadId);
      });
    },
    30000,
  );
});
