import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { mailThread, message } from '../../db/schema/mail.js';
import { MESSAGE_ARRIVED_AT } from '../../ai/message-arrival-time.js';
import { staffQuoteSourceHash } from '../../ai/staff-quote-workflow.js';
import {
  reservationWorkflowV2ItemInputSchema,
  reservationWorkflowV2EditInputSchema,
  reservationWorkflowV2ReviewInputSchema,
} from '../../ai/reservation-workflow-v2-contract.js';
import {
  getReservationWorkflowV2Draft,
  editReservationWorkflowV2Draft,
  reviewReservationWorkflowV2Draft,
  moveReservationWorkflowV2History,
} from '../../ai/reservation-workflow-v2-state.js';
import { resolvePropertyTransport } from '../../../tooling/playwright-quote/property-registry.mjs';
import { guardCenturionHmsMailboxOrigin } from '../../hms/mailbox-hms-origin-bind.js';
import { paneSourceSelectionCondition, paneSourceSelectionSchema } from '../../mail/pane-source-selection.js';
import { mailboxProcedure, router } from '../trpc.js';

function context(userId: string, transportId: string) {
  const resolved = resolvePropertyTransport(transportId);
  if (resolved.kind !== 'property' || resolved.property.propertyCode !== 'HRCEN') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Reservation tools are not available for this mailbox yet.' });
  }
  return { db: getDb(), userId, transportId, propertyCode: resolved.property.propertyCode };
}

const sourceInput = z.object({
  internetMessageId: z.string().min(1).max(998).optional(),
  selection: paneSourceSelectionSchema,
}).strict();

/** Source, state and tools share the authenticated mailbox; clients cannot select another hotel. */
export const reservationWorkflowV2Router = router({
  resolveSource: mailboxProcedure.input(sourceInput).query(async ({ input, ctx }) => {
    const scoped = context(ctx.sessionUser.id, ctx.activeTransportId);
    const rows = await scoped.db.select({
      id: message.id, threadId: message.threadId, internetMessageId: message.messageIdHeader,
      subject: message.subject, textBody: message.textBody, htmlBody: message.htmlBody,
      sourceProvenance: message.sourceProvenance, arrivedAt: MESSAGE_ARRIVED_AT,
    }).from(message).innerJoin(mailThread, and(eq(mailThread.id, message.threadId),
      eq(mailThread.transportId, message.transportId)))
      .where(and(eq(message.transportId, scoped.transportId), eq(message.direction, 'inbound'),
        eq(message.historyOnly, false), eq(mailThread.historyOnly, false),
        isNull(mailThread.trashedAt), isNull(mailThread.spamAt),
        paneSourceSelectionCondition(input.selection),
        input.internetMessageId ? eq(message.messageIdHeader, input.internetMessageId.trim()) : undefined))
      .limit(2);
    const selected = rows.length === 1 ? rows[0] : null;
    if (!selected || selected.sourceProvenance?.attention != null || !selected.arrivedAt) {
      return { status: 'source_unavailable' as const };
    }
    const origin = await guardCenturionHmsMailboxOrigin({ transportId: scoped.transportId,
      threadId: selected.threadId, messageId: selected.id });
    if (!origin.ok) return { status: 'wrong_property' as const, message: origin.message };
    return { status: 'ok' as const, propertyCode: scoped.propertyCode,
      internetMessageId: selected.internetMessageId,
      source: { threadId: selected.threadId, messageId: selected.id,
        sourceHash: staffQuoteSourceHash(selected), arrivedAt: selected.arrivedAt.toISOString() } };
  }),
  get: mailboxProcedure.input(reservationWorkflowV2ItemInputSchema).query(({ input, ctx }) =>
    getReservationWorkflowV2Draft(context(ctx.sessionUser.id, ctx.activeTransportId), input)),
  edit: mailboxProcedure.input(reservationWorkflowV2EditInputSchema).mutation(({ input, ctx }) =>
    editReservationWorkflowV2Draft(context(ctx.sessionUser.id, ctx.activeTransportId), input)),
  review: mailboxProcedure.input(reservationWorkflowV2ReviewInputSchema).mutation(({ input, ctx }) =>
    reviewReservationWorkflowV2Draft(context(ctx.sessionUser.id, ctx.activeTransportId), input)),
  undo: mailboxProcedure.input(reservationWorkflowV2ItemInputSchema).mutation(({ input, ctx }) =>
    moveReservationWorkflowV2History(context(ctx.sessionUser.id, ctx.activeTransportId), { ...input, direction: 'undo' })),
  redo: mailboxProcedure.input(reservationWorkflowV2ItemInputSchema).mutation(({ input, ctx }) =>
    moveReservationWorkflowV2History(context(ctx.sessionUser.id, ctx.activeTransportId), { ...input, direction: 'redo' })),
});
