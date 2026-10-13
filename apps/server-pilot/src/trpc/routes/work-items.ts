import { TRPCError } from '@trpc/server';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { parseNeedsYouSince } from '../../env.js';
import { getDb } from '../../db/client.js';
import { mailThread, message } from '../../db/schema/mail.js';
import { MAIL_KINDS, mailExtraction, workEvent, WORK_ITEM_STATUSES } from '../../db/schema/work.js';
import { retryInboundTranslation } from '../../ai/extraction/inbound-run.js';
import {
  acceptUneditedFields,
  dismissWorkItem,
  ensureWorkItem,
  listWorkItems,
  openStoredWork,
  recordFieldEvent,
  storedTranslation,
  storedWorkFor,
} from '../../ai/work-items.js';
import {
  PANE_ACTION_BATCH_MAX,
  PANE_ACTION_BLOCKS,
  PANE_ACTION_FIELDS,
  PANE_ACTION_KINDS,
  PANE_ACTION_TYPES,
  maskStaffNote,
  recordPaneActions,
} from '../../ai/work-events.js';
import type { MailKind } from '../../ai/extraction/schema.js';
import {
  dismissFollowUpDraft,
  followUpForMessage,
  followUpWire,
  useFollowUpDraft,
} from '../../ai/quote-followup.js';
import { mailboxProcedure, router } from '../trpc.js';

const internetMessageId = z.string().min(1).max(998);
const followUpDraftId = z.string().min(1).max(200);
const adminReviewInput = z
  .object({
    sourceMessageId: z.string().min(1).max(998),
    extractionId: z.string().uuid(),
    decision: z.enum(['right', 'edited', 'wrong']),
    note: z.string().max(2000).optional(),
  })
  .strict();

// Pane action telemetry (B1): small enums and numbers only, and the type list is the allowlist. Field and approval
// events never reach this route.
const paneActionEvent = z
  .object({
    type: z.enum(PANE_ACTION_TYPES),
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

// Field edits and accept/reject only. approve and review have their own procedures (U25, U18), so they are not here.
const fieldEventInput = z
  .object({
    workItemId: z.string().uuid(),
    type: z.enum(['field.edit', 'field.accept', 'field.reject']),
    fieldPath: z.string().min(1).max(200),
    value: z
      .union([
        z.string().max(200),
        z.number(),
        z.null(),
        z.literal(true),
        z.array(z.number().int().min(0).max(17)).max(9),
      ])
      .optional(),
    msSinceOpen: z.number().int().min(0).max(86_400_000).optional(),
  })
  .strict();

export const workItemsRouter = router({
  getByMessage: mailboxProcedure
    .input(z.object({ internetMessageId }).strict())
    .query(({ input, ctx }) =>
      storedWorkFor(getDb(), {
        transportId: ctx.activeTransportId,
        internetMessageId: input.internetMessageId,
      }),
    ),
  /**
   * Makes the work item for a stored read that has none yet, and returns the same view as getByMessage. The pane calls
   * it once, when getByMessage came back ready with a null workItemId, so getByMessage itself never writes.
   */
  open: mailboxProcedure
    .input(z.object({ internetMessageId }).strict())
    .mutation(({ input, ctx }) =>
      openStoredWork(getDb(), {
        transportId: ctx.activeTransportId,
        internetMessageId: input.internetMessageId,
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
    return { aiValue: result.aiValue, value: result.value };
  }),
  /** Owner/developer review of exactly the succeeded extraction shown by the workflow console. */
  adminReview: mailboxProcedure.input(adminReviewInput).mutation(async ({ input, ctx }) => {
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
    .input(z.object({ workItemId: z.string().uuid() }).strict())
    .mutation(async ({ input, ctx }) => {
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
});
