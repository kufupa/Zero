import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { attachment, message } from '../db/schema/mail.js';
import { attachmentEvidenceUnknown, effectiveOptionalMissing } from '../mail/ingest/attachment-evidence.js';
import { MESSAGE_ARRIVED_AT } from './message-arrival-time.js';
import { orderThreadContext } from './quote-workflow-synced-selection.js';

type WorkTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

const EVIDENCE_FIELDS = { id: message.id, threadId: message.threadId, transportId: message.transportId,
  direction: message.direction, subject: message.subject, textBody: message.textBody,
  receivedAt: message.receivedAt, sentAt: message.sentAt, createdAt: message.createdAt,
  arrivedAt: MESSAGE_ARRIVED_AT, provenance: message.sourceProvenance };

type MissingEntry = { role: string; fileName: string | null };
export type ReservationArrivalEvidence = {
  hash: string;
  missing: MissingEntry[];
  missingCurrent: MissingEntry[];
  attachmentEvidenceUnknown: boolean;
};

function evidenceDigest(
  prior: ReturnType<typeof orderThreadContext>,
  sortedAttachments: string[],
  sortedMissing: string[],
  contextAttachmentEvidenceUnknown: boolean,
): string {
  return createHash('sha256').update(JSON.stringify([
    'reservation-arrival-evidence/2',
    prior,
    sortedAttachments,
    sortedMissing,
    ...(contextAttachmentEvidenceUnknown ? ['attachment-evidence-unknown'] : []),
  ])).digest('hex');
}

/** Bind the same causal thread evidence used by prefill, without loading attachment bytes. */
export async function reservationArrivalEvidence(db: WorkTx, messageId: string): Promise<ReservationArrivalEvidence> {
  const [source] = await db.select(EVIDENCE_FIELDS).from(message)
    .where(eq(message.id, messageId)).limit(1);
  const thread = source ? await db.select(EVIDENCE_FIELDS).from(message)
    .where(and(eq(message.transportId, source.transportId), eq(message.threadId, source.threadId))) : [];
  const prior = source ? orderThreadContext(source, thread) : [];
  const admitted = new Set([messageId, ...prior.flatMap((row) => row.messageId ? [row.messageId] : [])]);
  const attachments = await db.select({ messageId: attachment.messageId, sourceId: attachment.sourceAttachmentId, name: attachment.filename,
    mimeType: attachment.mimeType, bytes: attachment.sizeBytes, sha256: attachment.sha256,
    contentId: attachment.contentId, inline: attachment.isInline }).from(attachment)
    .where(inArray(attachment.messageId, [...admitted]));
  const admittedThreadRows = thread.filter((row) => admitted.has(row.id));
  const missingWithParent = admittedThreadRows.flatMap((row) =>
    effectiveOptionalMissing(row.provenance)
      .map((item): { messageId: string; role: string; fileName: string | null } =>
        ({ messageId: row.id, ...item })));
  const contextAttachmentEvidenceUnknown = admittedThreadRows.some((row) => attachmentEvidenceUnknown(row.provenance));
  const missing = missingWithParent.map(({ role, fileName }) => ({ role, fileName }));
  const missingCurrent = missingWithParent.filter((row) => row.messageId === messageId)
    .map(({ role, fileName }) => ({ role, fileName }));
  const sortedAttachments = attachments.map((row) => JSON.stringify(row)).sort();
  const sortedMissing = missingWithParent.map((row) => JSON.stringify(row)).sort();
  return {
    hash: evidenceDigest(prior, sortedAttachments, sortedMissing, contextAttachmentEvidenceUnknown),
    missing,
    missingCurrent,
    attachmentEvidenceUnknown: contextAttachmentEvidenceUnknown,
  };
}

/**
 * The same per-message evidence as reservationArrivalEvidence, computed for a whole page in three
 * batched reads (candidate sources, their threads, all admitted attachments) so a list does not pay
 * three queries per row. Each digest uses identical inputs and serialization as the single reader.
 */
export async function reservationArrivalEvidenceBatch(db: WorkTx, messageIds: readonly string[]): Promise<Map<string, ReservationArrivalEvidence>> {
  const ids = [...new Set(messageIds)];
  const results = new Map<string, ReservationArrivalEvidence>();
  if (ids.length === 0) return results;
  const sources = await db.select(EVIDENCE_FIELDS).from(message)
    .where(inArray(message.id, ids));
  const threadIdsByTransport = new Map<string, Set<string>>();
  for (const source of sources) {
    const set = threadIdsByTransport.get(source.transportId) ?? new Set<string>();
    set.add(source.threadId);
    threadIdsByTransport.set(source.transportId, set);
  }
  const threadRows: typeof sources = [];
  for (const [transportId, threadIds] of threadIdsByTransport) {
    threadRows.push(...await db.select(EVIDENCE_FIELDS).from(message)
      .where(and(eq(message.transportId, transportId), inArray(message.threadId, [...threadIds]))));
  }
  const byThread = new Map<string, typeof sources>();
  for (const row of threadRows) {
    const key = `${row.transportId}/${row.threadId}`;
    const list = byThread.get(key) ?? [];
    list.push(row);
    byThread.set(key, list);
  }
  const priors = new Map<string, ReturnType<typeof orderThreadContext>>();
  const admittedBySource = new Map<string, Set<string>>();
  const admittedAll = new Set<string>();
  for (const source of sources) {
    const prior = orderThreadContext(source, byThread.get(`${source.transportId}/${source.threadId}`) ?? []);
    priors.set(source.id, prior);
    const admitted = new Set([source.id, ...prior.flatMap((row) => row.messageId ? [row.messageId] : [])]);
    admittedBySource.set(source.id, admitted);
    for (const id of admitted) admittedAll.add(id);
  }
  const attachments = admittedAll.size === 0 ? [] : await db.select({ messageId: attachment.messageId,
    sourceId: attachment.sourceAttachmentId, name: attachment.filename, mimeType: attachment.mimeType,
    bytes: attachment.sizeBytes, sha256: attachment.sha256, contentId: attachment.contentId,
    inline: attachment.isInline }).from(attachment)
    .where(inArray(attachment.messageId, [...admittedAll]));
  for (const source of sources) {
    const prior = priors.get(source.id)!;
    const admitted = admittedBySource.get(source.id)!;
    const thread = byThread.get(`${source.transportId}/${source.threadId}`) ?? [];
    const admittedThreadRows = thread.filter((row) => admitted.has(row.id));
    const missingWithParent = admittedThreadRows.flatMap((row) =>
      effectiveOptionalMissing(row.provenance)
        .map((item): { messageId: string; role: string; fileName: string | null } =>
          ({ messageId: row.id, ...item })));
    const contextAttachmentEvidenceUnknown = admittedThreadRows.some((row) => attachmentEvidenceUnknown(row.provenance));
    const missing = missingWithParent.map(({ role, fileName }) => ({ role, fileName }));
    const missingCurrent = missingWithParent.filter((row) => row.messageId === source.id)
      .map(({ role, fileName }) => ({ role, fileName }));
    const sortedAttachments = attachments.filter((row) => admitted.has(row.messageId))
      .map((row) => JSON.stringify(row)).sort();
    const sortedMissing = missingWithParent.map((row) => JSON.stringify(row)).sort();
    results.set(source.id, {
      hash: evidenceDigest(prior, sortedAttachments, sortedMissing, contextAttachmentEvidenceUnknown),
      missing,
      missingCurrent,
      attachmentEvidenceUnknown: contextAttachmentEvidenceUnknown,
    });
  }
  return results;
}
