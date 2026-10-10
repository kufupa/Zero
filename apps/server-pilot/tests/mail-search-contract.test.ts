/**
 * Contract tests — listThreads/drafts.list use parseSearchQuery + SQL builder,
 * not whole-string ILIKE. Unsupported operators return BAD_REQUEST.
 */
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mailDraft } from '../src/db/schema/mail.js';
import { refreshThreadSearchVector } from '../src/mail/search/search-vector.js';
import { callerFor } from './helpers/trpc-caller';
import { seedInboxThread } from './helpers/seed-inbox-thread';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';

const reachable = await probeTestDb();
const TRANSPORT_ID = 'transport-centurion';

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'mail search contract — listThreads trust layer',
  () => {
    it('from: matches sender address, not subject ILIKE on whole query string', async () => {
      await withSeededTestDb(async (db) => {
        const matchingId = 'thread-search-from-match';
        const decoyId = 'thread-search-from-decoy';

        await seedInboxThread(db, {
          threadId: matchingId,
          transportId: TRANSPORT_ID,
          transportEmail: 'centurion@legacyhotel.com',
          subject: 'VIP transfer',
          snippet: 'Pickup at 6am',
          fromAddress: 'alice@corp.com',
        });
        await refreshThreadSearchVector(db, matchingId);

        await seedInboxThread(db, {
          threadId: decoyId,
          transportId: TRANSPORT_ID,
          transportEmail: 'centurion@legacyhotel.com',
          subject: 'from:alice@corp.com',
          snippet: 'Subject contains operator text',
          fromAddress: 'bob@corp.com',
        });
        await refreshThreadSearchVector(db, decoyId);

        const caller = await callerFor('user-navaai', { db, requestedTransportId: TRANSPORT_ID });
        const result = await caller.mail.listThreads({
          folder: 'inbox',
          q: 'from:alice@corp.com',
        });

        const ids = result.threads.map((t) => t.id);
        expect(ids).toContain(matchingId);
        expect(ids).not.toContain(decoyId);
      });
    });

    it('kind:email returns BAD_REQUEST with unsupported operator token', async () => {
      await withSeededTestDb(async (db) => {
        const caller = await callerFor('user-navaai', { db, requestedTransportId: TRANSPORT_ID });

        await expect(
          caller.mail.listThreads({ folder: 'inbox', q: 'kind:email' }),
        ).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(TRPCError);
          const trpcErr = err as TRPCError;
          expect(trpcErr.code).toBe('BAD_REQUEST');
          expect(trpcErr.message).toContain('kind:email');
          const cause = trpcErr.cause as { token?: string } | undefined;
          expect(cause?.token).toBe('kind:email');
          return true;
        });
      });
    });
  },
);

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'mail search contract — drafts.list shared parser',
  () => {
    it('subject: operator matches draft subject field only, not body ILIKE on whole query', async () => {
      await withSeededTestDb(async (db) => {
        const matchingDraftId = randomUUID();
        const decoyDraftId = randomUUID();

        await db.insert(mailDraft).values({
          id: matchingDraftId,
          transportId: TRANSPORT_ID,
          createdByUserId: 'user-navaai',
          subject: 'Hotel invoice draft',
          textBody: 'Please review',
          isSent: false,
          status: 'active',
          origin: 'manual',
        });
        await db.insert(mailDraft).values({
          id: decoyDraftId,
          transportId: TRANSPORT_ID,
          createdByUserId: 'user-navaai',
          subject: 'Billing reminder',
          textBody: 'subject:invoice appears only in body',
          isSent: false,
          status: 'active',
          origin: 'manual',
        });

        const caller = await callerFor('user-navaai', { db, requestedTransportId: TRANSPORT_ID });
        const result = await caller.drafts.list({ q: 'subject:invoice' });

        const ids = result.threads.map((d) => d.id);
        expect(ids).toContain(matchingDraftId);
        expect(ids).not.toContain(decoyDraftId);
      });
    });

    it('kind:email returns BAD_REQUEST on drafts.list', async () => {
      await withSeededTestDb(async (db) => {
        const caller = await callerFor('user-navaai', { db, requestedTransportId: TRANSPORT_ID });

        await expect(caller.drafts.list({ q: 'kind:email' })).rejects.toSatisfy(
          (err: unknown) => {
            expect(err).toBeInstanceOf(TRPCError);
            const trpcErr = err as TRPCError;
            expect(trpcErr.code).toBe('BAD_REQUEST');
            expect(trpcErr.message).toContain('kind:email');
            return true;
          },
        );
      });
    });
  },
);
