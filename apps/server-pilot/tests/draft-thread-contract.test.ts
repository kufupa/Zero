import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  aiDraftGeneration,
  aiWorkflowRun,
  attachment,
  mailDraft,
  mailThread,
  message,
} from '../src/db/schema/mail.js';
import { workItem } from '../src/db/schema/work.js';
import { TRANSPORT_ID } from '../src/db/seed.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { callerFor } from './helpers/trpc-caller';
import {
  configureInboundAttachmentIdentityReader,
  reservationistBookingSuggestionSourcesAreCurrent,
} from '../src/trpc/routes/drafts.js';
import type { ReservationistDraftSource } from '../src/ai/reservationist-draft-source.js';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('thread draft contract', () => {
  it('rechecks trigger attachments, including uncited content, without reading earlier messages', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID(), triggerMessageId = randomUUID(), priorMessageId = randomUUID();
      const citedId = randomUUID(), uncitedId = randomUUID(), metadataId = randomUUID(), priorId = randomUUID();
      const body = 'Please book one room for two adults from 2026-12-03 to 2026-12-05.';
      const bodyHash = createHash('sha256').update(body).digest('hex');
      const hashes = new Map([[citedId, 'a'.repeat(64)], [uncitedId, 'b'.repeat(64)]]);
      await db.insert(mailThread).values({
        id: threadId, transportId: TRANSPORT_ID, threadRootId: `<${threadId}@example.com>`,
        subject: 'Booking', latestMessageAt: new Date('2026-07-06T10:00:00Z'),
      });
      await db.insert(message).values([
        { id: triggerMessageId, transportId: TRANSPORT_ID, threadId, direction: 'inbound' as const,
          fromAddress: 'guest@example.com', toAddresses: ['nava@example.com'], textBody: body,
          receivedAt: new Date('2026-07-06T10:00:00Z') },
        { id: priorMessageId, transportId: TRANSPORT_ID, threadId, direction: 'inbound' as const,
          fromAddress: 'guest@example.com', toAddresses: ['nava@example.com'], textBody: 'Earlier note',
          receivedAt: new Date('2026-07-05T10:00:00Z') },
      ]);
      await db.insert(attachment).values([
        { id: citedId, messageId: triggerMessageId, filename: 'rooming.pdf', mimeType: 'application/pdf',
          sizeBytes: 12, s3Key: `attachments/${triggerMessageId}/cited.pdf` },
        { id: uncitedId, messageId: triggerMessageId, filename: 'terms.pdf', mimeType: 'application/pdf',
          sizeBytes: 16, s3Key: `attachments/${triggerMessageId}/uncited.pdf` },
        { id: metadataId, messageId: triggerMessageId, filename: 'unread.bin', mimeType: 'application/octet-stream',
          sizeBytes: 8, s3Key: `attachments/${triggerMessageId}/unread.bin` },
        { id: priorId, messageId: priorMessageId, filename: 'earlier.pdf', mimeType: 'application/pdf',
          sizeBytes: 9, s3Key: `attachments/${priorMessageId}/earlier.pdf` },
      ]);
      const descriptor = (id: string, messageId: string, s3Key: string, sizeBytes: number, sourceHash?: string) => ({
        attachmentId: id, messageId, s3Key,
        mimeType: id === metadataId ? 'application/octet-stream' : 'application/pdf',
        sizeBytes, inline: false, ...(sourceHash ? { sourceHash } : {}),
        ...(id === metadataId ? { sourceIdentity: 'metadata_only' as const, contentId: null } : {}),
      });
      const source = { attachments: [
        descriptor(citedId, triggerMessageId, `attachments/${triggerMessageId}/cited.pdf`, 12, hashes.get(citedId)),
        descriptor(uncitedId, triggerMessageId, `attachments/${triggerMessageId}/uncited.pdf`, 16,
          hashes.get(uncitedId)),
        descriptor(metadataId, triggerMessageId, `attachments/${triggerMessageId}/unread.bin`, 8),
        descriptor(priorId, priorMessageId, `attachments/${priorMessageId}/earlier.pdf`, 9, 'c'.repeat(64)),
      ] } as unknown as ReservationistDraftSource;
      const result = { tasks: [{ kind: 'new_booking',
        requestSource: { attachmentId: `message:${triggerMessageId}`, sourceHash: bodyHash },
        bookingSuggestion: { version: 1, facts: {
          dates: [{ source: { sourceRef: citedId, sourceHash: hashes.get(citedId) } }],
          rooms: [], guests: [], boards: [], parties: [],
        } },
      }] };
      const input = {
        result, triggerMessageId, messageSourceHash: bodyHash, source, transportId: TRANSPORT_ID, threadId,
      };
      const reads: string[] = [];
      configureInboundAttachmentIdentityReader(async ({ attachmentId }) => {
        reads.push(attachmentId);
        return { sha256: hashes.get(attachmentId) ?? '' };
      });
      try {
        expect(await reservationistBookingSuggestionSourcesAreCurrent(db, input)).toBe(true);
        expect(reads).toEqual([citedId, uncitedId]);
        reads.length = 0;
        configureInboundAttachmentIdentityReader(async ({ attachmentId }) => ({
          sha256: attachmentId === citedId ? 'd'.repeat(64) : hashes.get(attachmentId) ?? '',
        }));
        expect(await reservationistBookingSuggestionSourcesAreCurrent(db, input)).toBe(false);
        reads.length = 0;
        configureInboundAttachmentIdentityReader(async ({ attachmentId }) => ({
          sha256: attachmentId === uncitedId ? 'd'.repeat(64) : hashes.get(attachmentId) ?? '',
        }));
        expect(await reservationistBookingSuggestionSourcesAreCurrent(db, input)).toBe(false);
        reads.length = 0;
        await db.insert(attachment).values({ id: randomUUID(), messageId: triggerMessageId, filename: 'new.pdf',
          mimeType: 'application/pdf', sizeBytes: 4,
          s3Key: `attachments/${triggerMessageId}/new.pdf` });
        expect(await reservationistBookingSuggestionSourcesAreCurrent(db, input)).toBe(false);
        expect(reads).toHaveLength(0);
      } finally {
        configureInboundAttachmentIdentityReader(null);
      }
    });
  });

  it('chooses the latest analysis for the selected email even when an older draft was edited later', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID(), parentMessageId = randomUUID(), otherMessageId = randomUUID();
      const oldGeneration = randomUUID(), newGeneration = randomUUID();
      const oldRun = randomUUID(), newRun = randomUUID(), fileId = randomUUID(), newDraft = randomUUID();
      const voucherQuote = 'Please review the attached hotel voucher for our booking.';
      const voucherHash = createHash('sha256').update(voucherQuote).digest('hex');
      const voucherReviewId = `voucher:message:${parentMessageId}:${voucherHash}:0:${voucherQuote.length}`;
      await db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID,
        threadRootId: `<${threadId}@example.com>`, subject: 'Booking', latestMessageAt: new Date('2026-07-06T10:00:00Z') });
      await db.insert(message).values([
        {id:parentMessageId,transportId:TRANSPORT_ID,threadId,direction:'inbound' as const,fromAddress:'guest@example.com',toAddresses:['nava@example.com'],textBody:voucherQuote,receivedAt:new Date('2026-07-06T10:00:00Z')},
        {id:otherMessageId,transportId:TRANSPORT_ID,threadId,direction:'inbound' as const,fromAddress:'guest@example.com',toAddresses:['nava@example.com'],textBody:'Need help',receivedAt:new Date('2026-07-06T10:00:00Z')},
      ]);
      await db.insert(attachment).values({id:fileId,messageId:parentMessageId,filename:'document.pdf',mimeType:'application/pdf',sizeBytes:10,s3Key:'synthetic',sha256:'a'.repeat(64)});
      await db.insert(aiDraftGeneration).values([oldGeneration, newGeneration].map(id => ({
        id, transportId: TRANSPORT_ID, threadId, requestedByUserId: 'user-navaai',
        contextMessageIds: [parentMessageId], model: 'test', promptVersion: 'test',
      })));
      await db.insert(mailDraft).values([
        { id: randomUUID(), transportId: TRANSPORT_ID, threadId, createdByUserId: 'user-navaai',
          status: 'active', origin: 'ai', replyToMessageId: parentMessageId, generationId: oldGeneration,
          toAddresses: ['guest@example.com'], updatedAt: new Date('2026-07-06T11:00:00Z') },
        { id: newDraft, transportId: TRANSPORT_ID, threadId, createdByUserId: 'user-navaai',
          status: 'candidate', origin: 'ai', replyToMessageId: parentMessageId, generationId: newGeneration,
          toAddresses: ['guest@example.com'], updatedAt: new Date('2026-07-06T10:20:00Z') },
      ]);
      await db.insert(aiWorkflowRun).values([
        { id: oldRun, idempotencyKey: randomUUID(), transportId: TRANSPORT_ID, threadId,
          triggerMessageId: parentMessageId, generationId: oldGeneration, runKind: 'candidate_draft',
          modelId: 'test', promptVersion: 'test', state: 'succeeded', createdAt: new Date('2026-07-06T10:00:00Z'),
          metrics: { reservationistResult: { version: 1, readiness: 'needs_clarification', tasks: [{ id: 'old', kind: 'change' }] } } },
        { id: newRun, idempotencyKey: randomUUID(), transportId: TRANSPORT_ID, threadId,
          triggerMessageId: parentMessageId, generationId: newGeneration, runKind: 'candidate_draft',
          modelId: 'test', promptVersion: 'test', state: 'succeeded', createdAt: new Date('2026-07-06T10:10:00Z'),
          metrics: { reservationistResult: { version: 1, readiness: 'needs_clarification', tasks: [{ id: 'new', kind: 'question' }],
            sourceRecoveries:[
              {kind:'attachment_manual',disclosure:'staff_only',sourceKind:'attachment',sourceRef:fileId,sourceHash:'a'.repeat(64),messageId:parentMessageId,reason:'no_embedded_text'},
              {kind:'voucher_review',reason:'voucher_request_needs_staff_review',disclosure:'staff_only',sourceKind:'message',sourceRef:`message:${parentMessageId}`,sourceHash:voucherHash,messageId:parentMessageId,page:1,start:0,end:voucherQuote.length,quote:voucherQuote},
            ] }, reservationistDraftSource:{messages:[{id:parentMessageId,sourceHash:voucherHash}] } } },
      ]);
      const { drafts } = await callerFor('user-navaai', { db, requestedTransportId: TRANSPORT_ID });
      expect(await drafts.reviewForMessage({ threadId, messageId: parentMessageId })).toMatchObject({
        replyToMessageId: parentMessageId, reviewSummary: { tasks: [{ label: 'Answer question' }] },
      });
      await db.update(mailDraft).set({isSent:true}).where(eq(mailDraft.id,newDraft));
      expect(await drafts.reviewForMessage({ threadId, messageId: parentMessageId })).toMatchObject({
        reviewSummary: { tasks: [{id:'new',label:'Answer question'}] },
      });
      expect(await drafts.reviewForMessage({ threadId, messageId: otherMessageId })).toBeNull();
      // A newer no-action analysis produces no draft; do not resurrect the older review.
      const noActionGeneration = randomUUID();
      await db.insert(aiDraftGeneration).values({ id: noActionGeneration, transportId: TRANSPORT_ID, threadId,
        requestedByUserId: 'user-navaai', contextMessageIds: [parentMessageId], model: 'test', promptVersion: 'test' });
      await db.insert(aiWorkflowRun).values({ id: randomUUID(), idempotencyKey: randomUUID(), transportId: TRANSPORT_ID,
        threadId, triggerMessageId: parentMessageId, generationId: noActionGeneration, runKind: 'candidate_draft',
        modelId: 'test', promptVersion: 'test', state: 'succeeded', createdAt: new Date('2026-07-06T10:30:00Z') });
      expect(await drafts.reviewForMessage({ threadId, messageId: parentMessageId })).toBeNull();
      // A later no-action run must not hide earlier requests on an actual staff work item.
      const [item] = await db.insert(workItem).values({ transportId: TRANSPORT_ID, threadId,
        sourceMessageId: parentMessageId, kind: 'other' }).returning();
      const input = { threadId, messageId: parentMessageId, workItemId: item!.id };
      expect((await drafts.reviewForMessage(input))?.reviewSummary?.staffActions).toMatchObject([
        {kind:'business_document_failure',filename:'document.pdf'},
        {kind:'voucher_review',id:voucherReviewId,sourceRef:`message:${parentMessageId}`,sourceHash:voucherHash,text:voucherQuote,runId:newRun,handled:false},
      ]);
      expect((await drafts.reviewForMessage(input))?.reviewSummary?.tasks).toMatchObject([
        { id: 'new', runId: newRun, label: 'Earlier request', handled: false },
        { id: 'old', runId: oldRun, label: 'Earlier request', handled: false },
      ]);
      await drafts.setRequestHandled({ workItemId: item!.id, runId: newRun, taskId: 'new', handled: true });
      expect((await drafts.reviewForMessage(input))?.reviewSummary?.tasks).toMatchObject([
        { id: 'new', runId: newRun, handled: true }, { id: 'old', runId: oldRun, handled: false },
      ]);
      // A new classification creates another work item for the same email.
      const [reclassified] = await db.insert(workItem).values({ transportId: TRANSPORT_ID, threadId,
        sourceMessageId: parentMessageId, kind: 'quote' }).returning();
      const current = { ...input, workItemId: reclassified!.id };
      expect((await drafts.reviewForMessage(current))?.reviewSummary?.tasks).toMatchObject([
        { id: 'new', runId: newRun, handled: true }, { id: 'old', runId: oldRun, handled: false },
      ]);
      await drafts.setRequestHandled({ workItemId: reclassified!.id, runId: newRun, taskId: 'new', handled: false });
      expect((await drafts.reviewForMessage(current))?.reviewSummary?.tasks).toMatchObject([
        { id: 'new', runId: newRun, handled: false }, { id: 'old', runId: oldRun, handled: false },
      ]);
      const laterRun = (minutes: number, attachments: unknown[], messages: unknown[] = []) => ({ id: randomUUID(), idempotencyKey: randomUUID(),
        transportId: TRANSPORT_ID, threadId, triggerMessageId: parentMessageId, runKind: 'candidate_draft' as const,
        modelId: 'test', promptVersion: 'test', state: 'succeeded' as const, createdAt: new Date(`2026-07-06T10:${minutes}:00Z`),
        metrics: { reservationistResult: {version:1,readiness:'no_action',tasks:[]}, reservationistDraftSource: {attachments,messages} } });
      await db.insert(aiWorkflowRun).values(laterRun(40, [], [{id:parentMessageId,sourceHash:voucherHash}]));
      expect((await drafts.reviewForMessage(current))?.reviewSummary?.staffActions).toMatchObject([
        {kind:'business_document_failure',filename:'document.pdf'},
        {kind:'voucher_review',sourceRef:`message:${parentMessageId}`,sourceHash:voucherHash,text:voucherQuote,runId:newRun,handled:false},
      ]);
      await db.insert(aiWorkflowRun).values(laterRun(50, [{attachmentId:fileId,sourceHash:'a'.repeat(64)}], [{id:parentMessageId,sourceHash:voucherHash}]));
      expect((await drafts.reviewForMessage(current))?.reviewSummary?.staffActions).toMatchObject([
        {kind:'voucher_review',sourceRef:`message:${parentMessageId}`,sourceHash:voucherHash,text:voucherQuote,runId:newRun,handled:false},
      ]);
      await drafts.setVoucherReviewHandled({workItemId:reclassified!.id,runId:newRun,reviewItemId:voucherReviewId,handled:true});
      const voucherRereadId = randomUUID();
      await db.insert(aiWorkflowRun).values({id:voucherRereadId,idempotencyKey:voucherRereadId,transportId:TRANSPORT_ID,threadId,
        triggerMessageId:parentMessageId,runKind:'candidate_draft',modelId:'test',promptVersion:'test',state:'succeeded',
        createdAt:new Date('2026-07-06T10:55:00Z'),metrics:{reservationistResult:{version:1,readiness:'needs_clarification',tasks:[],
          sourceRecoveries:[{kind:'voucher_review',reason:'voucher_request_needs_staff_review',disclosure:'staff_only',sourceKind:'message',
            sourceRef:`message:${parentMessageId}`,sourceHash:voucherHash,messageId:parentMessageId,page:1,start:0,end:voucherQuote.length,quote:voucherQuote}]},
          reservationistDraftSource:{messages:[{id:parentMessageId,sourceHash:voucherHash}]}}});
      expect((await drafts.reviewForMessage(current))?.reviewSummary?.staffActions).toMatchObject([
        {kind:'voucher_review',id:voucherReviewId,runId:voucherRereadId,handled:true},
      ]);
      const laterNoActionId = randomUUID();
      await db.insert(aiWorkflowRun).values({id:laterNoActionId,idempotencyKey:laterNoActionId,transportId:TRANSPORT_ID,threadId,
        triggerMessageId:parentMessageId,runKind:'candidate_draft',modelId:'test',promptVersion:'test',state:'succeeded',
        createdAt:new Date('2026-07-06T11:00:00Z'),metrics:{reservationistResult:{version:1,readiness:'no_action',tasks:[]},
          reservationistDraftSource:{messages:[{id:parentMessageId,sourceHash:voucherHash}]}}});
      const afterNoAction = (await drafts.reviewForMessage(current))?.reviewSummary?.staffActions ?? [];
      expect(afterNoAction).toContainEqual(expect.objectContaining({kind:'voucher_review',id:voucherReviewId,runId:voucherRereadId,handled:true}));
      expect(afterNoAction.filter(action => action.kind === 'voucher_review')).toHaveLength(1);
      expect(afterNoAction.some(action => action.kind === 'business_document_failure')).toBe(false);
    });
  });

  it('returns plural visible drafts from mail.get without adding drafts to messages', async () => {
    await withSeededTestDb(async (db) => {
      const threadId = randomUUID();
      const parentMessageId = randomUUID();
      const activeDraftId = randomUUID();
      const candidateDraftId = randomUUID();
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
        model: 'gpt-5.5',
        promptVersion: 'hotel-reply-v1',
      });
      await db.insert(mailDraft).values([
        {
          id: activeDraftId,
          transportId: TRANSPORT_ID,
          threadId,
          createdByUserId: 'user-navaai',
          status: 'active',
          origin: 'manual',
          replyToMessageId: parentMessageId,
          toAddresses: ['guest@example.com'],
          subject: 'Re: Booking',
          textBody: 'Human draft',
          // Pin order: drafts.list sorts by updatedAt desc, then id (random here).
          updatedAt: new Date('2026-07-06T10:05:00Z'),
        },
        {
          id: candidateDraftId,
          transportId: TRANSPORT_ID,
          threadId,
          createdByUserId: 'user-navaai',
          status: 'candidate',
          origin: 'ai',
          replyToMessageId: parentMessageId,
          generationId,
          toAddresses: ['guest@example.com'],
          subject: 'Re: Booking',
          textBody: 'AI candidate',
          updatedAt: new Date('2026-07-06T10:00:00Z'),
        },
      ]);

      const { mail, drafts } = await callerFor('user-navaai', {
        db,
        requestedTransportId: TRANSPORT_ID,
      });
      const thread = await mail.get({ id: threadId });
      expect(thread.messages).toHaveLength(1);
      expect(thread.messages.some((m) => m.isDraft)).toBe(false);
      expect(thread.drafts.map((draft) => draft.id)).toEqual([activeDraftId, candidateDraftId]);
      expect(thread.drafts[0]).toMatchObject({
        status: 'active',
        origin: 'manual',
        replyToMessageId: parentMessageId,
        isStale: false,
      });

      const listed = await drafts.list({ threadId, limit: 10 });
      expect(listed.threads.map((draft) => draft.id)).toEqual([activeDraftId, candidateDraftId]);

      const inbox = await mail.listThreads({ folder: 'inbox', limit: 50 });
      const row = inbox.threads.find((t) => t.id === threadId);
      expect(row?.hasDraft).toBe(true);
      expect(row?.draftCount).toBe(2);
    });
  });
});
