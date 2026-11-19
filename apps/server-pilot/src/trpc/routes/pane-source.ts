import { TRPCError } from '@trpc/server';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { attachment, mailThread, message } from '../../db/schema/mail.js';
import { outlookSyncObservation, outlookSyncSource } from '../../db/schema/outlook-sync.js';
import { MESSAGE_ARRIVED_AT } from '../../ai/message-arrival-time.js';
import { staffQuoteSourceHash } from '../../ai/staff-quote-workflow.js';
import { propertySwitchSchema, resolvePropertyScope, type PropertyCode } from '../../hms/property-registry.js';
import { guardCenturionHmsMailboxOrigin } from '../../hms/mailbox-hms-origin-bind.js';
import { paneSourceMatchesContentHash, paneSourceContentHashSchema, paneSourceSelectionCondition, paneSourceSelectionSchema } from '../../mail/pane-source-selection.js';
import { canonicalMessageId } from '../../mail/ingest/message-id.js';
import { logPaneSourceResolution } from '../../mail/pane-source-diagnostics.js';
import { mailboxProcedure, router } from '../trpc.js';

const sourceInput = z.object({
  internetMessageId: z.string().min(1).max(998).optional(),
  contentHash: paneSourceContentHashSchema.optional(),
  selection: paneSourceSelectionSchema,
  propertySwitch: propertySwitchSchema.optional(),
}).strict();

/** Resolves the staff-selected email to its stored inbound message (rewrite pane quote drafts). */
export const paneSourceRouter = router({
  resolveSource: mailboxProcedure.input(sourceInput).query(async ({ input, ctx }) => {
    let propertyCode: PropertyCode;
    try {
      propertyCode = resolvePropertyScope({ transportId: ctx.activeTransportId, propertySwitch: input.propertySwitch }).propertyCode;
    } catch {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Reservation tools are not available for this property and mailbox.' });
    }
    const db = getDb(), userId = ctx.sessionUser.id, transportId = ctx.activeTransportId;
    const internetMessageId = canonicalMessageId(input.internetMessageId);
    const diagnostic = { userId, sessionId: ctx.sessionUser.sessionId,
      transportId, selection: input.selection, internetMessageId: input.internetMessageId };
    const rows = await db.select({
      id: message.id, threadId: message.threadId, internetMessageId: message.messageIdHeader,
      subject: message.subject, fromAddress: message.fromAddress, textBody: message.textBody, htmlBody: message.htmlBody,
      sourceProvenance: message.sourceProvenance, arrivedAt: MESSAGE_ARRIVED_AT,
      nativeLinked: sql<boolean>`${paneSourceSelectionCondition(input.selection)}`,
    }).from(message).innerJoin(mailThread, and(eq(mailThread.id, message.threadId),
      eq(mailThread.transportId, message.transportId)))
      .where(and(eq(message.transportId, transportId), eq(message.direction, 'inbound'),
        isNull(mailThread.trashedAt), isNull(mailThread.spamAt),
        paneSourceSelectionCondition(input.selection, { userId, internetMessageId: input.internetMessageId, contentHash: input.contentHash }),
        input.internetMessageId !== undefined ? eq(message.messageIdHeader, internetMessageId ?? '') : undefined))
      .limit(2);
    const selected = rows.length === 1 ? rows[0] : null;
    if (selected && input.selection.kind === 'outlook' && input.contentHash && !paneSourceMatchesContentHash(selected, input.contentHash)) {
      logPaneSourceResolution({ ...diagnostic, matches: 1, result: 'content_mismatch' });
      return { status: 'source_unavailable' as const, reason: 'content_mismatch' as const };
    }
    if (!selected && rows.length === 0 && input.selection.kind === 'outlook') {
      const selection = input.selection;
      const observations = await db.select({ state: outlookSyncObservation.ingestionState,
        errorCode: outlookSyncObservation.errorCode })
        .from(outlookSyncObservation).innerJoin(outlookSyncSource,
          eq(outlookSyncSource.id, outlookSyncObservation.sourceId))
        .where(and(eq(outlookSyncSource.transportId, transportId),
          eq(outlookSyncSource.userId, userId), eq(outlookSyncSource.storeId, selection.storeId),
          sql`${outlookSyncObservation.evidence} #>> '{locator,entryId}' = ${selection.entryId}`,
          selection.folderEntryId !== undefined
            ? sql`${outlookSyncObservation.evidence} #>> '{locator,folderEntryId}' = ${selection.folderEntryId}` : undefined))
        .orderBy(sql`${outlookSyncObservation.semanticVersion} desc`).limit(1);
      const observation = observations[0];
      if (observation?.state === 'attention') {
        const reason = observation.errorCode === 'AMBIGUOUS_IDENTITY' ? 'ambiguous' as const : 'attention' as const;
        logPaneSourceResolution({ ...diagnostic, matches: 0, result: reason });
        return { status: 'source_unavailable' as const, reason };
      }
    }
    if (!selected || selected.sourceProvenance?.attention != null || !selected.arrivedAt) {
      const reason = rows.length > 1 || selected?.sourceProvenance?.attention === 'AMBIGUOUS_IDENTITY' ? 'ambiguous' as const : !selected ? 'not_found' as const
        : selected.sourceProvenance?.attention != null ? 'attention' as const : 'missing_arrival' as const;
      logPaneSourceResolution({ ...diagnostic, matches: rows.length, result: reason });
      return { status: 'source_unavailable' as const, reason };
    }
    const origin = propertyCode === 'HRCEN' ? await guardCenturionHmsMailboxOrigin({ transportId,
      threadId: selected.threadId, messageId: selected.id }) : { ok: true as const };
    if (!origin.ok) {
      logPaneSourceResolution({ ...diagnostic, matches: 1, result: 'wrong_property' });
      return { status: 'wrong_property' as const, message: origin.message };
    }
    const attachments = await db.select({ id: attachment.id, filename: attachment.filename,
      mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, isInline: attachment.isInline })
      .from(attachment).where(eq(attachment.messageId, selected.id)).limit(50);
    logPaneSourceResolution({ ...diagnostic, matches: 1, result: 'ready',
      matchedBy: input.selection.kind === 'web' ? 'web' : selected.nativeLinked ? 'native' : 'mailbox-copy' });
    return { status: 'ok' as const, propertyCode,
      internetMessageId: selected.internetMessageId,
      sourceSubject: selected.subject ?? '', sourceSender: selected.fromAddress,
      attachments,
      source: { propertyId: propertyCode, threadId: selected.threadId, messageId: selected.id,
        sourceHash: staffQuoteSourceHash(selected), arrivedAt: selected.arrivedAt.toISOString() } };
  }),
});
