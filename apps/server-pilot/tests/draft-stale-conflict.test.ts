import {
  aiDraftGeneration,
  mailDraft,
  mailDraftRevision,
  mailThread,
  message,
  outboundSendQueue,
} from '../src/db/schema/mail.js';
import {
  __forceSendAtPastForTests,
  __setOutboundAttemptFenceHookForTests,
  flushDue,
} from '../src/mail/send/outbound-queue.js';
import { __setSmtpTransportForTests, type SmtpTransport } from '../src/mail/send/smtp.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db';
import * as draftApprovalModule from '../src/ai/draft-approval.js';
import { loadLiveThreadStateVersion } from '../src/ai/drafts.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callerFor } from './helpers/trpc-caller';
import { TRANSPORT_ID } from '../src/db/seed.js';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

const reachable = await probeTestDb();

const previousUndoSendSeconds = process.env.UNDO_SEND_SECONDS;
const previousSelfBcc = process.env.MAIL_SELF_BCC;

afterEach(() => {
  vi.restoreAllMocks();
  __setOutboundAttemptFenceHookForTests(null);
  __setSmtpTransportForTests(null);
  if (previousUndoSendSeconds === undefined) delete process.env.UNDO_SEND_SECONDS;
  else process.env.UNDO_SEND_SECONDS = previousUndoSendSeconds;
  if (previousSelfBcc === undefined) delete process.env.MAIL_SELF_BCC;
  else process.env.MAIL_SELF_BCC = previousSelfBcc;
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('stale draft conflict', () => {
  it('rejects stale draft send until caller confirms, then writes sent revision', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '0';
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
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'manual',
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Old draft',
        htmlBody: '<p>Old draft</p>',
      });

      const { mail } = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
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

  it('never allows stale HMS AI send override via confirmStaleDraft', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const draftId = randomUUID();
      const generationId = randomUUID();

      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date('2026-07-06T10:00:00Z'),
      });
      await db.insert(message).values({
        id: parentMessageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Booking',
        textBody: 'Need help',
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      });
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'test',
        promptVersion: 'draft-v1',
        outcome: 'candidate',
        threadStateVersion: 'not-the-live-version',
        evidence: [
          {
            kind: 'hms',
            id: 'ev-1',
            toolId: 'hms_quote_stay',
            toolVersion: '1',
            propertyCode: 'CEN',
            observedAt: '2026-07-06T10:00:00.000Z',
            expiresAt: '2099-01-01T00:00:00.000Z',
            claimKeys: ['rate'],
            sourceHash: 'b'.repeat(64),
          },
        ],
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'HMS draft',
        htmlBody: '<p>HMS draft</p>',
      });

      const { mail } = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      await expect(
        mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: '<p>HMS draft</p>',
          confirmStaleDraft: true,
        }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'STALE_AI_DRAFT',
      });
    });
  });

  it('off-mode skeleton AI send never bypasses approval with confirmStaleDraft', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const newerMessageId = randomUUID();
      const draftId = randomUUID();
      const generationId = randomUUID();

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
          textBody: 'First',
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
          textBody: 'Newer',
          receivedAt: new Date('2026-07-06T10:05:00Z'),
        },
      ]);
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'test',
        promptVersion: 'draft-v1',
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Skeleton',
        htmlBody: '<p>Skeleton</p>',
      });

      const { mail } = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      await expect(
        mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: '<p>Skeleton</p>',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_REQUIRED' });

      await expect(
        mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: '<p>Skeleton</p>',
          confirmStaleDraft: true,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_REQUIRED' });
    });
  });

  it('requires explicit approval and rechecks it at the real queue transmission boundary', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '0';
      process.env.MAIL_SELF_BCC = 'false';
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const draftId = randomUUID();
      const generationId = randomUUID();
      const body = '<p>Approved guest reply</p>';
      const evidence = {
        kind: 'hms' as const,
        id: `evidence-${generationId}`,
        toolId: 'hms_quote_stay',
        toolVersion: '1',
        propertyCode: 'HRCEN',
        observedAt: '2026-07-06T10:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        claimKeys: ['rate'],
        sourceHash: 'a'.repeat(64),
        scopeVerified: true,
      };

      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date('2026-07-06T10:00:00Z'),
      });
      await db.insert(message).values({
        id: parentMessageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Booking',
        textBody: 'Need help',
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      });
      const threadStateVersion = await loadLiveThreadStateVersion(db, {
        transportId: TRANSPORT_ID,
        threadId,
      });
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'approved-local-test',
        promptVersion: 'draft-v1',
        status: 'succeeded',
        outcome: 'candidate',
        threadStateVersion,
        evidence: [evidence],
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
      });
      const revisionId = randomUUID();
      await db.insert(mailDraftRevision).values({
        id: revisionId,
        draftId,
        generationId,
        actorUserId: 'user-navaai',
        kind: 'ai_generated',
        toAddresses: ['guest@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
        attachments: [],
      });

      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      await expect(
        caller.mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: body,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_REQUIRED' });

      const approval = await caller.drafts.approve({
        draftId,
        subject: 'Re: Booking',
        html: body,
        text: '',
        to: ['guest@example.com'],
        cc: [],
        bcc: [],
        attachments: [],
      });
      const smtpSend = vi.fn<SmtpTransport['send']>().mockResolvedValue({
        messageId: 'approved@zero.test',
        accepted: ['guest@example.com'],
        rejected: [],
      });
      __setSmtpTransportForTests({ kind: 'fake', send: smtpSend });

      const result = await caller.mail.send({
        threadId,
        draftId,
        to: ['guest@example.com'],
        subject: 'Re: Booking',
        message: body,
        draftApproval: approval,
      });
      expect(result).toMatchObject({ sent: true, delivery: 'full' });
      expect(smtpSend).toHaveBeenCalledTimes(1);

      const [queue] = await db
        .select()
        .from(outboundSendQueue)
        .where(
          and(
            eq(outboundSendQueue.messageId, result.messageId),
            eq(outboundSendQueue.transportId, TRANSPORT_ID),
          ),
        )
        .limit(1);
      expect(queue?.status).toBe('sent');
      expect(queue?.smtpPayload).toMatchObject({ draftApproval: approval });
    });
  }, 30000);

  it('rejects an approval mutation interleaved after validation and before enqueue', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '30';
      process.env.MAIL_SELF_BCC = 'false';
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const draftId = randomUUID();
      const generationId = randomUUID();
      const revisionId = randomUUID();
      const body = '<p>Interleaving approval</p>';
      const evidence = {
        kind: 'hms' as const,
        id: `evidence-${generationId}`,
        toolId: 'hms_quote_stay',
        toolVersion: '1',
        propertyCode: 'HRCEN',
        observedAt: '2026-07-06T10:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        claimKeys: ['rate'],
        sourceHash: 'd'.repeat(64),
        scopeVerified: true,
      };

      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date('2026-07-06T10:00:00Z'),
      });
      await db.insert(message).values({
        id: parentMessageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Booking',
        textBody: 'Need help',
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      });
      const threadStateVersion = await loadLiveThreadStateVersion(db, {
        transportId: TRANSPORT_ID,
        threadId,
      });
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'approved-local-test',
        promptVersion: 'draft-v1',
        status: 'succeeded',
        outcome: 'candidate',
        threadStateVersion,
        evidence: [evidence],
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
      });
      await db.insert(mailDraftRevision).values({
        id: revisionId,
        draftId,
        generationId,
        actorUserId: 'user-navaai',
        kind: 'ai_generated',
        toAddresses: ['guest@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
        attachments: [],
      });

      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      const approval = await caller.drafts.approve({
        draftId,
        subject: 'Re: Booking',
        html: body,
        text: '',
        to: ['guest@example.com'],
        cc: [],
        bcc: [],
        attachments: [],
      });

      const originalAssert = draftApprovalModule.assertDraftApprovalCurrent;
      vi.spyOn(draftApprovalModule, 'assertDraftApprovalCurrent').mockImplementation(
        async (input) => {
          const result = await originalAssert(input);
          // Deterministically mutate the reviewed revision after the final
          // pre-enqueue read. The production caller must linearize/reject.
          await db
            .update(mailDraft)
            .set({ updatedAt: new Date(Date.now() + 1_000) })
            .where(and(eq(mailDraft.id, draftId), eq(mailDraft.transportId, TRANSPORT_ID)));
          await db.insert(mailDraftRevision).values({
            id: randomUUID(),
            draftId,
            generationId,
            actorUserId: 'user-navaai',
            kind: 'edited',
            toAddresses: ['guest@example.com'],
            ccAddresses: [],
            bccAddresses: [],
            subject: 'Re: Booking (edited)',
            textBody: 'Edited after review',
            htmlBody: '<p>Edited after review</p>',
            attachments: [],
          });
          return result;
        },
      );

      await expect(
        caller.mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: body,
          draftApproval: approval,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });

      const queued = await db
        .select({ id: outboundSendQueue.id })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.transportId, TRANSPORT_ID));
      expect(queued).toHaveLength(0);
    });
  }, 30000);

  it('orders post-claim draft, thread, and evidence mutations after fake transport', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '30';
      process.env.MAIL_SELF_BCC = 'false';
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const draftId = randomUUID();
      const generationId = randomUUID();
      const revisionId = randomUUID();
      const body = '<p>Attempt-fence approval</p>';
      const evidence = {
        kind: 'hms' as const,
        id: `evidence-${generationId}`,
        toolId: 'hms_quote_stay',
        toolVersion: '1',
        propertyCode: 'HRCEN',
        observedAt: '2026-07-06T10:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        claimKeys: ['rate'],
        sourceHash: 'e'.repeat(64),
        scopeVerified: true,
      };

      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date('2026-07-06T10:00:00Z'),
      });
      await db.insert(message).values({
        id: parentMessageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Booking',
        textBody: 'Need help',
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      });
      const threadStateVersion = await loadLiveThreadStateVersion(db, {
        transportId: TRANSPORT_ID,
        threadId,
      });
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'approved-local-test',
        promptVersion: 'draft-v1',
        status: 'succeeded',
        outcome: 'candidate',
        threadStateVersion,
        evidence: [evidence],
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
      });
      await db.insert(mailDraftRevision).values({
        id: revisionId,
        draftId,
        generationId,
        actorUserId: 'user-navaai',
        kind: 'ai_generated',
        toAddresses: ['guest@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
        attachments: [],
      });

      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      const approval = await caller.drafts.approve({
        draftId,
        subject: 'Re: Booking',
        html: body,
        text: '',
        to: ['guest@example.com'],
        cc: [],
        bcc: [],
        attachments: [],
      });
      const smtpSend = vi.fn<SmtpTransport['send']>().mockResolvedValue({
        messageId: 'attempt-fence@zero.test',
        accepted: ['guest@example.com'],
        rejected: [],
      });
      __setSmtpTransportForTests({ kind: 'fake', send: smtpSend });
      const queuedResult = await caller.mail.send({
        threadId,
        draftId,
        to: ['guest@example.com'],
        subject: 'Re: Booking',
        message: body,
        draftApproval: approval,
      });
      expect(queuedResult).toMatchObject({ queued: true });
      await __forceSendAtPastForTests(queuedResult.messageId, TRANSPORT_ID, db);

      const postClaimMessageId = randomUUID();
      __setOutboundAttemptFenceHookForTests(async ({ db: fencedDb }) => {
        // The queue claim is already durable.  A real editor caller cannot
        // rewrite the claimed/sent draft; concurrent thread/evidence writes
        // are ordered after this send attempt and affect the next approval.
        await expect(
          caller.drafts.update({
            id: draftId,
            subject: 'Re: Booking (edited)',
            content: 'Edited after attempt claim',
            html: '<p>Edited after attempt claim</p>',
          }),
        ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_SEND_CLAIMED' });
        await fencedDb.insert(message).values({
          id: postClaimMessageId,
          transportId: TRANSPORT_ID,
          threadId,
          direction: 'inbound',
          fromAddress: 'guest@example.com',
          toAddresses: ['nava@example.com'],
          subject: 'Post-claim update',
          textBody: 'This arrives after the send claim.',
          receivedAt: new Date('2026-07-06T10:01:00Z'),
        });
        await fencedDb
          .update(aiDraftGeneration)
          .set({ evidence: [{ ...evidence, sourceHash: 'f'.repeat(64) }] })
          .where(eq(aiDraftGeneration.id, generationId));
      });

      await expect(flushDue({ db })).resolves.toEqual({ flushed: 1 });
      expect(smtpSend).toHaveBeenCalledTimes(1);
      const [queue] = await db
        .select({ status: outboundSendQueue.status })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.messageId, queuedResult.messageId));
      expect(queue?.status).toBe('sent');
      const [postClaimMessage] = await db
        .select({ id: message.id })
        .from(message)
        .where(eq(message.id, postClaimMessageId));
      expect(postClaimMessage?.id).toBe(postClaimMessageId);
    });
  }, 30000);

  it('keeps AI-bound Send anyway blocked after approval when the thread changes', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const draftId = randomUUID();
      const generationId = randomUUID();
      const body = '<p>Review me</p>';
      const evidence = {
        kind: 'hms' as const,
        id: `evidence-${generationId}`,
        toolId: 'hms_quote_stay',
        toolVersion: '1',
        propertyCode: 'HRCEN',
        observedAt: '2026-07-06T10:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        claimKeys: ['rate'],
        sourceHash: 'b'.repeat(64),
        scopeVerified: true,
      };
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date('2026-07-06T10:00:00Z'),
      });
      await db.insert(message).values({
        id: parentMessageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Booking',
        textBody: 'Need help',
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      });
      const threadStateVersion = await loadLiveThreadStateVersion(db, {
        transportId: TRANSPORT_ID,
        threadId,
      });
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'approved-local-test',
        promptVersion: 'draft-v1',
        status: 'succeeded',
        outcome: 'candidate',
        threadStateVersion,
        evidence: [evidence],
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
      });
      await db.insert(mailDraftRevision).values({
        id: randomUUID(),
        draftId,
        generationId,
        actorUserId: 'user-navaai',
        kind: 'ai_generated',
        toAddresses: ['guest@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
        attachments: [],
      });
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      const approval = await caller.drafts.approve({
        draftId,
        subject: 'Re: Booking',
        html: body,
        text: '',
        to: ['guest@example.com'],
        attachments: [],
      });
      await db.insert(message).values({
        id: randomUUID(),
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Updated booking',
        textBody: 'A newer answer arrived',
        receivedAt: new Date('2026-07-06T10:05:00Z'),
      });

      await expect(
        caller.mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: body,
          draftApproval: approval,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });

      await expect(
        caller.mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: body,
          draftApproval: approval,
          confirmStaleDraft: true,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });
    });
  }, 30000);

  it('cancels a confirmed-zero queue retry when approval becomes stale before transmission', async () => {
    await withSeededTestDb(async (db) => {
      process.env.UNDO_SEND_SECONDS = '0';
      process.env.MAIL_SELF_BCC = 'false';
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const draftId = randomUUID();
      const generationId = randomUUID();
      const body = '<p>Zero acceptance</p>';
      const evidence = {
        kind: 'hms' as const,
        id: `evidence-${generationId}`,
        toolId: 'hms_quote_stay',
        toolVersion: '1',
        propertyCode: 'HRCEN',
        observedAt: '2026-07-06T10:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
        claimKeys: ['rate'],
        sourceHash: 'c'.repeat(64),
        scopeVerified: true,
      };
      await db.insert(mailThread).values({
        id: threadId,
        transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking',
        snippet: 'Need help',
        latestMessageAt: new Date('2026-07-06T10:00:00Z'),
      });
      await db.insert(message).values({
        id: parentMessageId,
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Booking',
        textBody: 'Need help',
        receivedAt: new Date('2026-07-06T10:00:00Z'),
      });
      const threadStateVersion = await loadLiveThreadStateVersion(db, {
        transportId: TRANSPORT_ID,
        threadId,
      });
      await db.insert(aiDraftGeneration).values({
        id: generationId,
        transportId: TRANSPORT_ID,
        threadId,
        requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId],
        model: 'approved-local-test',
        promptVersion: 'draft-v1',
        status: 'succeeded',
        outcome: 'candidate',
        threadStateVersion,
        evidence: [evidence],
      });
      await db.insert(mailDraft).values({
        id: draftId,
        transportId: TRANSPORT_ID,
        threadId,
        createdByUserId: 'user-navaai',
        status: 'active',
        origin: 'ai',
        generationId,
        replyToMessageId: parentMessageId,
        toAddresses: ['guest@example.com'],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
      });
      await db.insert(mailDraftRevision).values({
        id: randomUUID(),
        draftId,
        generationId,
        actorUserId: 'user-navaai',
        kind: 'ai_generated',
        toAddresses: ['guest@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Re: Booking',
        textBody: 'Candidate',
        htmlBody: body,
        attachments: [],
      });
      const caller = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      const approval = await caller.drafts.approve({
        draftId,
        subject: 'Re: Booking',
        html: body,
        text: '',
        to: ['guest@example.com'],
        attachments: [],
      });
      const send = vi.fn<SmtpTransport['send']>().mockResolvedValue({
        messageId: 'zero@zero.test',
        accepted: [],
        rejected: ['guest@example.com'],
      });
      __setSmtpTransportForTests({ kind: 'fake', send });
      await expect(
        caller.mail.send({
          threadId,
          draftId,
          to: ['guest@example.com'],
          subject: 'Re: Booking',
          message: body,
          draftApproval: approval,
        }),
      ).rejects.toThrow('SMTP accepted no recipients');
      const [queue] = await db
        .select()
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.transportId, TRANSPORT_ID))
        .limit(1);
      expect(queue?.status).toBe('sending');
      await db.insert(message).values({
        id: randomUUID(),
        transportId: TRANSPORT_ID,
        threadId,
        direction: 'inbound',
        fromAddress: 'guest@example.com',
        toAddresses: ['nava@example.com'],
        subject: 'Updated booking',
        textBody: 'Updated',
        receivedAt: new Date('2026-07-06T10:05:00Z'),
      });
      await db
        .update(outboundSendQueue)
        .set({ claimedAt: new Date(Date.now() - 5 * 60 * 1000 - 1) })
        .where(eq(outboundSendQueue.id, queue!.id));
      await expect(flushDue({ db })).resolves.toEqual({ flushed: 0 });
      const [cancelled] = await db
        .select()
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.id, queue!.id))
        .limit(1);
      expect(cancelled).toBeUndefined();
      const [orphanedMessage] = await db
        .select({ id: message.id })
        .from(message)
        .where(and(eq(message.id, queue!.messageId), eq(message.transportId, TRANSPORT_ID)))
        .limit(1);
      expect(orphanedMessage).toBeUndefined();
      const [reopenedDraft] = await db
        .select({ isSent: mailDraft.isSent, status: mailDraft.status })
        .from(mailDraft)
        .where(and(eq(mailDraft.id, draftId), eq(mailDraft.transportId, TRANSPORT_ID)))
        .limit(1);
      expect(reopenedDraft).toMatchObject({ isSent: false, status: 'active' });
      expect(send).toHaveBeenCalledTimes(1);
    });
  }, 30000);
});
