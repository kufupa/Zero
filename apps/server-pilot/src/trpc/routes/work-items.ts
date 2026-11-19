import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { parseNeedsYouSince } from '../../env.js';
import { getDb } from '../../db/client.js';
import { mailThread, message } from '../../db/schema/mail.js';
import { MAIL_KINDS, mailExtraction, workEvent, workItem, WORK_ITEM_STATUSES } from '../../db/schema/work.js';
import { failedReadRetryStatus, refreshSelectedAmendExtraction, retryInboundTranslation, retrySelectedFailedRead } from '../../ai/extraction/inbound-run.js';
import {
  acceptUneditedFields,
  dismissWorkItem,
  ensureWorkItem,
  listWorkItems,
  loadPaneRevisionCursor,
  openStoredWork,
  recordFieldEvent,
  redoWorkItemRevision,
  resetWorkSection,
  storedTranslation,
  storedWorkFor,
  startManualCreate,
  undoWorkItemRevision,
} from '../../ai/work-items.js';
import {
  PANE_ACTION_BATCH_MAX,
  PANE_ACTION_BLOCKS,
  PANE_ACTION_FIELDS,
  PANE_ACTION_KINDS,
  PANE_ACTION_STANDARD_TYPES,
  maskStaffNote,
  recordPaneActions,
} from '../../ai/work-events.js';
import { PANE_ERROR_CLASSES, PANE_ERROR_CODES, RESERVATION_WORKFLOW_V2_ERROR_PROCEDURES } from '../../ai/pane-error-vocabulary.js';
import type { MailKind } from '../../ai/extraction/schema.js';
import { recordFinalQuoteOutcome } from '../../ai/quote-outcomes.js';
import {
  dismissFollowUpDraft,
  followUpForMessage,
  followUpWire,
  useFollowUpDraft,
} from '../../ai/quote-followup.js';
import { mailboxProcedure, router } from '../trpc.js';
import { paneSourceSelectionSchema } from '../../mail/pane-source-selection.js';
import { acknowledgeVoucherReview, selectedVoucherReview } from '../../ai/voucher-pending.js';

const internetMessageId = z.string().min(1).max(998);
const followUpDraftId = z.string().min(1).max(200);
const voucherReviewSource = z.object({ threadId: z.string().min(1).max(200), messageId: z.string().min(1).max(200),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const voucherReviewInput = z.object({ workItemId: z.string().uuid(), source: voucherReviewSource }).strict();
const adminReviewInput = z
  .object({
    sourceMessageId: z.string().min(1).max(998),
    extractionId: z.string().uuid(),
    decision: z.enum(['right', 'edited', 'wrong']),
    note: z.string().max(2000).optional(),
  })
  .strict();

// Pane action telemetry accepts bounded allowlisted values only; field and approval events never reach this route.
const paneStandardActionEvent = z
  .object({
    type: z.enum(PANE_ACTION_STANDARD_TYPES),
    ms: z.number().int().min(0).max(86_400_000).optional(),
    surface: z.enum(['outlook', 'web']).optional(),
    kind: z.enum(PANE_ACTION_KINDS).optional(),
    block: z.enum(PANE_ACTION_BLOCKS).optional(),
    field: z.enum(PANE_ACTION_FIELDS).optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.type === 'copy.contact' && event.field === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['field'], message: 'Field is required for contact copy.' });
    }
    if (event.type !== 'copy.contact' && event.field !== undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['field'], message: 'Field is only for contact copy.' });
    }
  });
const paneErrorActionEvent = z.object({
  type: z.literal('pane.error'),
  procedure: z.enum(RESERVATION_WORKFLOW_V2_ERROR_PROCEDURES),
  actionId: z.string().uuid(),
  errorClass: z.enum(PANE_ERROR_CLASSES),
  errorCode: z.enum(PANE_ERROR_CODES).optional(),
  metadataParseFailed: z.boolean(),
  surface: z.enum(['outlook', 'web']).optional(),
  sourceMessageId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).optional(),
  requestId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/).optional(),
  allocationId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
const paneActionEvent = z.union([paneStandardActionEvent, paneErrorActionEvent]);

const quoteOutcomeInput = z.object({
  sourceMessageId: z.string().min(1).max(998), replyHtml: z.string().max(400_000), insertedAt: z.string().datetime(),
  replyKind: z.enum(['quote', 'decline', 'missing_details', 'other']),
  preparedVersions: z.array(z.object({ workflowRunId: z.string().min(1).max(200), revisionRef: z.string().min(1).max(200) }).strict()).max(32),
  attachments: z.array(z.object({ fileName: z.string().min(1).max(255), mimeType: z.string().min(1).max(128),
    sizeBytes: z.number().int().min(0).max(32 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(64),
}).strict();

// Field edits and accept/reject only. approve and review have their own procedures (U25, U18), so they are not here.
const fieldEventInput = z
  .object({
    workItemId: z.string().uuid(),
    type: z.enum(['field.edit', 'field.accept', 'field.reject']),
    fieldPath: z.string().min(1).max(200),
    source: z.object({
      threadId: z.string().min(1).max(200), messageId: z.string().min(1).max(200),
      sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().optional(),
    expectedSeq: z.number().int().nonnegative().safe().optional(),
    expectedExtractionId: z.string().uuid().nullable().optional(),
    value: z
      .union([
        z.string().max(2000),
        z.number(),
        z.null(),
        z.boolean(),
        z.array(z.number().int().min(0).max(17)).max(9),
        z.array(z.string().min(1).max(200)).max(40),
        z.object({ confirmation: z.string().max(200), arrival: z.string().max(10) }).strict(),
        z.object({ mode: z.enum(['self', 'client', 'custom']), address: z.string().max(255) }).strict(),
        z.object({ nativeId: z.string().max(40), firstName: z.string().max(100), lastName: z.string().max(100) }).strict(),
        z.object({ nativeId: z.string().max(40), name: z.string().max(200), code: z.string().max(80).optional() }).strict(),
        z.object({ amountMinor: z.number().int().nonnegative().safe(), currency: z.string().length(3),
          reason: z.string().max(1000).nullable(), offerId: z.string().max(200) }).strict(),
      ])
      .optional(),
    msSinceOpen: z.number().int().min(0).max(86_400_000).optional(),
  })
  .strict();

export const workItemsRouter = router({
  voucherReview: mailboxProcedure.input(voucherReviewInput).query(async ({ input, ctx }) => {
    const result = await selectedVoucherReview(getDb(), { ...input, transportId: ctx.activeTransportId });
    if (!result) throw new TRPCError({ code: 'CONFLICT', message: 'This email changed. Reopen it to review the document.' });
    return result;
  }),
  acknowledgeVoucher: mailboxProcedure.input(voucherReviewInput.extend({ attachmentId: z.string().min(1).max(200),
    key: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).mutation(async ({ input, ctx }) => {
    const saved = await acknowledgeVoucherReview(getDb(), { ...input, transportId: ctx.activeTransportId, userId: ctx.sessionUser.id });
    if (!saved) throw new TRPCError({ code: 'CONFLICT', message: 'This document changed. Reopen the email and try again.' });
    return { status: 'recorded' as const };
  }),
  getByMessage: mailboxProcedure
    .input(z.object({ internetMessageId, selection: paneSourceSelectionSchema.optional() }).strict())
    .query(({ input, ctx }) =>
      storedWorkFor(getDb(), {
        transportId: ctx.activeTransportId,
        internetMessageId: input.internetMessageId,
        selection: input.selection,
      }),
    ),
  retryFailedRead: mailboxProcedure.input(z.object({ internetMessageId, selection: paneSourceSelectionSchema,
    extractionId: z.string().uuid(), extractorVersion: z.string().min(1).max(200),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/), source: voucherReviewSource }).strict())
    .mutation(({ input, ctx }) => retrySelectedFailedRead(getDb(), {
      ...input, transportId: ctx.activeTransportId, actorId: ctx.sessionUser.id,
    })),
  startManualCreate: mailboxProcedure.input(z.object({ internetMessageId, selection: paneSourceSelectionSchema,
    extractionId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), source: voucherReviewSource }).strict())
    .mutation(({ input, ctx }) => startManualCreate(getDb(), { ...input, transportId: ctx.activeTransportId,
      actorId: ctx.sessionUser.id })),
  failedReadRetryStatus: mailboxProcedure.input(z.object({ internetMessageId, selection: paneSourceSelectionSchema,
    extractionId: z.string().uuid(), runId: z.string().uuid() }).strict())
    .query(({ input, ctx }) => failedReadRetryStatus(getDb(), { ...input, transportId: ctx.activeTransportId })),
  /** Queue the current extractor for precisely the selected inbound Amendment, if it is stale. */
  refreshAmendExtraction: mailboxProcedure
    .input(z.object({
      workItemId: z.string().uuid(),
      source: z.object({ threadId: z.string().min(1).max(200), messageId: z.string().min(1).max(200),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    }).strict())
    .mutation(({ input, ctx }) => refreshSelectedAmendExtraction(getDb(), {
      ...input, transportId: ctx.activeTransportId,
    })),
  /**
   * Makes the work item for a stored read that has none yet, and returns the same view as getByMessage. The pane calls
   * it once, when getByMessage came back ready with a null workItemId, so getByMessage itself never writes.
   */
  open: mailboxProcedure
    .input(z.object({ internetMessageId, selection: paneSourceSelectionSchema.optional() }).strict())
    .mutation(({ input, ctx }) =>
      openStoredWork(getDb(), {
        transportId: ctx.activeTransportId,
        internetMessageId: input.internetMessageId,
        selection: input.selection,
      }),
    ),
  list: mailboxProcedure
    .input(
      z
        .object({
          statuses: z.array(z.enum(WORK_ITEM_STATUSES)).min(1).max(4).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict(),
    )
    .query(({ input, ctx }) => {
      const receivedSince = parseNeedsYouSince(process.env.NEEDS_YOU_SINCE);
      return listWorkItems(getDb(), {
        transportId: ctx.activeTransportId,
        statuses: input.statuses ?? ['needs_you', 'review'],
        limit: input.limit ?? 50,
        ...(receivedSince ? { receivedSince } : {}),
      });
    }),
  recordEvent: mailboxProcedure.input(fieldEventInput).mutation(async ({ input, ctx }) => {
    const result = await recordFieldEvent(getDb(), {
      transportId: ctx.activeTransportId,
      workItemId: input.workItemId,
      userId: ctx.sessionUser.id,
      type: input.type,
      fieldPath: input.fieldPath,
      value: input.value,
      msSinceOpen: input.msSinceOpen,
      source: input.source,
      expectedSeq: input.expectedSeq,
      expectedExtractionId: input.expectedExtractionId,
    });
    if (result.status === 'not_found') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Work item not found.' });
    }
    if (result.status === 'invalid_path') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown field path.' });
    }
    if (result.status === 'invalid_value') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Value does not fit this field.' });
    }
    if (result.status === 'stale_source' || result.status === 'stale_revision') {
      throw new TRPCError({ code: 'CONFLICT', message: 'This email or draft changed. Reload before saving this field.' });
    }
    return {
      aiValue: result.aiValue,
      value: result.value,
      previousSeq: result.previousSeq,
      seq: result.seq,
      revision: result.revision,
      revisionHead: result.revisionHead,
      workItemExtractionId: result.workItemExtractionId,
    };
  }),
  /** Owner/developer review of exactly the succeeded extraction shown by the workflow console. */
  adminReview: mailboxProcedure.input(adminReviewInput).mutation(async ({ input, ctx }) => {
    // Owner console only: hotel staff with member access must not change review counts.
    if (ctx.accessRole === 'member') throw new TRPCError({ code: 'FORBIDDEN', message: 'Owner access required' });
    const db = getDb();
    const [source] = await db
      .select({
        threadId: message.threadId,
        kind: mailExtraction.kind,
        action: sql<string | null>`to_jsonb(${mailExtraction})->>'action'`,
      })
      .from(message)
      .innerJoin(
        mailThread,
        and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, ctx.activeTransportId)),
      )
      .innerJoin(
        mailExtraction,
        and(
          eq(mailExtraction.messageId, message.id),
          eq(mailExtraction.id, input.extractionId),
          eq(mailExtraction.status, 'succeeded'),
        ),
      )
      .where(
        and(
          eq(message.id, input.sourceMessageId),
          eq(message.transportId, ctx.activeTransportId),
          eq(message.direction, 'inbound'),
          isNull(mailThread.trashedAt),
        ),
      )
      .limit(1);
    if (!source) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workflow email not found.' });

    const [latest] = await db
      .select({ id: mailExtraction.id })
      .from(mailExtraction)
      .where(and(eq(mailExtraction.messageId, input.sourceMessageId), eq(mailExtraction.status, 'succeeded')))
      .orderBy(desc(mailExtraction.createdAt), desc(mailExtraction.id))
      .limit(1);
    if (latest?.id !== input.extractionId) {
      throw new TRPCError({ code: 'CONFLICT', message: 'The extraction changed. Reload before reviewing.' });
    }

    const kind = MAIL_KINDS.includes(source.kind as MailKind) ? (source.kind as MailKind) : 'other';
    const item = await ensureWorkItem(db, {
      transportId: ctx.activeTransportId,
      threadId: source.threadId,
      messageId: input.sourceMessageId,
      kind,
      extractionId: input.extractionId,
    });
    const note = maskStaffNote(input.note?.trim() ?? '').trim();
    const value = { decision: input.decision, ...(note ? { note } : {}) };
    const [event] = await db
      .insert(workEvent)
      .values({
        workItemId: item.id,
        actorKind: 'user',
        actorUserId: ctx.sessionUser.id,
        type: 'admin_review',
        value,
        evidence: {
          sourceMessageId: input.sourceMessageId,
          extractionId: input.extractionId,
          kind,
          action: source.action,
        },
      })
      .returning({ id: workEvent.id, at: workEvent.at });
    return {
      workItemId: item.id,
      eventId: event!.id,
      decision: input.decision,
      reviewedAt: event!.at.toISOString(),
    };
  }),
  /** One batch of pane actions from the Nava pane (B1), fire-and-forget. Refused when the item is in another transport. */
  recordActions: mailboxProcedure
    .input(
      z
        .object({
          workItemId: z.string().uuid(),
          events: z.array(paneActionEvent).min(1).max(PANE_ACTION_BATCH_MAX),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await recordPaneActions(getDb(), {
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
        userId: ctx.sessionUser.id,
        events: input.events,
      });
      if (result === 'not_found') throw new TRPCError({ code: 'NOT_FOUND', message: 'Work item not found.' });
      return { recorded: input.events.length };
    }),
  /** Exact inserted reply/PDF identity; reply body remains private in work_event. */
  recordQuoteOutcome: mailboxProcedure.input(quoteOutcomeInput).mutation(async ({ input, ctx }) => {
    if (input.replyKind !== 'quote' || !input.attachments.some((file) => file.mimeType === 'application/pdf' && file.sizeBytes > 0) ||
      !input.preparedVersions.length) return { recorded: false };
    const db = getDb();
    const [item] = await db.select({ id: workItem.id }).from(workItem)
      .innerJoin(workEvent, and(eq(workEvent.workItemId, workItem.id), eq(workEvent.type, 'quote.prepared')))
      .where(and(eq(workItem.transportId, ctx.activeTransportId), eq(workItem.sourceMessageId, input.sourceMessageId)))
      .orderBy(desc(workEvent.at), desc(workEvent.id)).limit(1);
    if (!item) throw new TRPCError({ code: 'NOT_FOUND', message: 'Work item not found.' });
    const recorded = await recordFinalQuoteOutcome(db, { workItemId: item.id, sourceMessageId: input.sourceMessageId,
      userId: ctx.sessionUser.id, preparedVersions: input.preparedVersions,
      output: { replyHtml: input.replyHtml, insertedAt: input.insertedAt, attachments: input.attachments },
    });
    return { recorded };
  }),
  /**
   * The fields the pane showed when a person proceeded with the read (B2). The server skips any field she edited and any
   * with no AI value, so a repeat call adds nothing. Accepted fields log the AI value.
   */
  acceptFields: mailboxProcedure
    .input(
      z
        .object({
          workItemId: z.string().uuid(),
          fieldPaths: z.array(z.string().min(1).max(200)).min(1).max(200),
        })
        .strict(),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await acceptUneditedFields(getDb(), {
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
        userId: ctx.sessionUser.id,
        fieldPaths: input.fieldPaths,
      });
      if (result.status === 'not_found') throw new TRPCError({ code: 'NOT_FOUND', message: 'Work item not found.' });
      return { accepted: result.accepted };
    }),
  /** Translates the read again (U16 Retry). Returns the translation the pane shows, or why it could not run. */
  retryTranslation: mailboxProcedure
    .input(z.object({ workItemId: z.string().uuid() }).strict())
    .mutation(async ({ input, ctx }) => {
      const result = await retryInboundTranslation({
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
      });
      if (result.status === 'not_found') {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Work item not found.' });
      }
      if (result.status !== 'done') return { status: result.status, translation: null };
      return { status: 'done' as const, translation: storedTranslation(result.translation) };
    }),
  dismiss: mailboxProcedure
    .input(z.object({ workItemId: z.string().uuid(), expectedActor: z.object({
      userId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200),
    }).strict().optional() }).strict())
    .mutation(async ({ input, ctx }) => {
      if (input.expectedActor && (ctx.sessionUser.id !== input.expectedActor.userId ||
          ctx.sessionUser.sessionId !== input.expectedActor.sessionId)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'The signed-in session changed.' });
      }
      const result = await dismissWorkItem(getDb(), {
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
        userId: ctx.sessionUser.id,
      });
      if (!result) throw new TRPCError({ code: 'NOT_FOUND', message: 'Work item not found.' });
      return result;
    }),
  // The quote follow-up suggestion on this mail's thread (R10). Null when there is none.
  followUpByMessage: mailboxProcedure
    .input(z.object({ internetMessageId }).strict())
    .query(async ({ input, ctx }) => {
      const found = await followUpForMessage(getDb(), {
        transportId: ctx.activeTransportId,
        internetMessageId: input.internetMessageId,
      });
      return found;
    }),
  // Makes the suggestion the thread's reply draft. replaceActive discards the draft already holding that slot.
  useFollowUp: mailboxProcedure
    .input(z.object({ draftId: followUpDraftId, replaceActive: z.boolean().optional() }).strict())
    .mutation(async ({ input, ctx }) => {
      const result = await useFollowUpDraft(getDb(), {
        transportId: ctx.activeTransportId,
        userId: ctx.sessionUser.id,
        draftId: input.draftId,
        replaceActive: input.replaceActive === true,
      });
      if (result.status === 'not_found') {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'FOLLOW_UP_NOT_FOUND' });
      }
      if (result.status === 'active_exists') {
        throw new TRPCError({ code: 'CONFLICT', message: 'ACTIVE_DRAFT_EXISTS' });
      }
      return followUpWire('in_reply', result.draft);
    }),
  dismissFollowUp: mailboxProcedure
    .input(z.object({ draftId: followUpDraftId }).strict())
    .mutation(async ({ input, ctx }) => {
      const result = await dismissFollowUpDraft(getDb(), {
        transportId: ctx.activeTransportId,
        userId: ctx.sessionUser.id,
        draftId: input.draftId,
      });
      if (result === 'not_found') {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'FOLLOW_UP_NOT_FOUND' });
      }
      return { status: 'dismissed' as const };
    }),
  revisionCursor: mailboxProcedure
    .input(z.object({ workItemId: z.string().uuid() }).strict())
    .query(async ({ input, ctx }) => {
      const cursor = await loadPaneRevisionCursor(getDb(), {
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
      });
      if (!cursor) throw new TRPCError({ code: 'NOT_FOUND', message: 'Work item not found.' });
      return cursor;
    }),
  undoRevision: mailboxProcedure
    .input(
      z.object({
        workItemId: z.string().uuid(),
        expectedSeq: z.number().int().min(0),
        expectedExtractionId: z.string().uuid().nullable().optional(),
      }).strict(),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await undoWorkItemRevision(getDb(), {
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
        userId: ctx.sessionUser.id,
        expectedSeq: input.expectedSeq,
        expectedExtractionId: input.expectedExtractionId,
      });
      return historyMoveResult(result);
    }),
  redoRevision: mailboxProcedure
    .input(
      z.object({
        workItemId: z.string().uuid(),
        expectedSeq: z.number().int().min(0),
        expectedExtractionId: z.string().uuid().nullable().optional(),
      }).strict(),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await redoWorkItemRevision(getDb(), {
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
        userId: ctx.sessionUser.id,
        expectedSeq: input.expectedSeq,
        expectedExtractionId: input.expectedExtractionId,
      });
      return historyMoveResult(result);
    }),
  resetSection: mailboxProcedure
    .input(
      z
        .object({
          workItemId: z.string().uuid(),
          section: z.discriminatedUnion('type', [
            z.object({ type: z.literal('contact') }).strict(),
            z.object({ type: z.literal('stay'), stayId: z.string().min(1).max(40) }).strict(),
          ]),
          expectedSeq: z.number().int().nonnegative().safe().optional(),
          expectedExtractionId: z.string().uuid().nullable().optional(),
        })
        .strict().refine((value) => (value.expectedSeq === undefined) === (value.expectedExtractionId === undefined),
          { message: 'Expected sequence and extraction must be supplied together.' }),
    )
    .mutation(async ({ input, ctx }) => {
      const result = await resetWorkSection(getDb(), {
        transportId: ctx.activeTransportId,
        workItemId: input.workItemId,
        userId: ctx.sessionUser.id,
        section: input.section,
        expectedSeq: input.expectedSeq,
        expectedExtractionId: input.expectedExtractionId,
      });
      if (result.status === 'not_found') throw new TRPCError({ code: 'NOT_FOUND', message: 'Work item not found.' });
      if (result.status === 'invalid_section') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown section.' });
      if (result.status === 'invalid_cursor') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Incomplete cursor.' });
      if (result.status === 'stale') throw new TRPCError({ code: 'CONFLICT', message: 'This work item changed. Reload before resetting.' });
      return { reset: result.reset, ...(input.expectedSeq !== undefined ? { revision: result.revision,
        revisionHead: result.revisionHead, seq: result.seq, extractionId: result.extractionId } : {}) };
    }),
});

function historyMoveResult(
  result: Awaited<ReturnType<typeof undoWorkItemRevision>>,
): { revision: number; revisionHead: number; seq: number } {
  if (result.status === 'not_found') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Work item not found.' });
  }
  if (result.status === 'stale') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This work item changed. Reload, then undo or redo.',
    });
  }
  if (result.status === 'history_stale') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The mail reading changed. Reload, then undo or redo.',
      cause: { code: 'history_stale' },
    });
  }
  if (result.status === 'at_boundary') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Nothing left to undo or redo.' });
  }
  return { revision: result.revision, revisionHead: result.revisionHead, seq: result.seq };
}
