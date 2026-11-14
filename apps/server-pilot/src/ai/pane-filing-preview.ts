import { and, eq } from 'drizzle-orm';
import { getDb, type DB } from '../db/client.js';
import { mailThread, mailboxAccess, mailboxTransport, message } from '../db/schema/mail.js';
import { workItem } from '../db/schema/work.js';
import { assertHmsReadOriginAllowed, CENTURION_HMS_READ_TARGET } from '../hms/hms-read-target.js';
import { getS3Storage, type S3Storage } from '../storage/s3.js';
import { readPaneFilingAttachment } from './pane-filing-source.js';
import { findStay } from './pane-stay-lookup.js';
import { paneStayPropertyLock } from './pane-stay-save.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';

export type PreviewInput = {
  transportId: string;
  actorUserId: string;
  workItemId: string;
  sourceMessageId: string;
  attachmentId: string;
  confirmation: string;
  arrival: string;
  lastName: string;
  documentSource?: { sha256: string; snapshotDigest: string };
  db?: DB;
  s3?: S3Storage;
};

type PreviewResult =
  | { status: 'ready'; confirmation: string; arrival: string; documentName: string;
      documentSource: { sha256: string; snapshotDigest: string }; revisionSeq: number }
  | { status: 'refused'; reason: string };

/** Recheck the selected message, work item and current mailbox access around the remote reads. */
async function currentFilingSource(db: DB, input: PreviewInput): Promise<{ threadId: string; revisionSeq: number } | null> {
  const rows = await db.select({ itemThread: workItem.threadId, messageThread: message.threadId,
    itemMessage: workItem.sourceMessageId, messageId: message.id, transportId: workItem.transportId,
    actorUserId: mailboxAccess.userId, active: mailboxTransport.isActive, status: workItem.status,
    direction: message.direction, messageHistoryOnly: message.historyOnly,
    threadHistoryOnly: mailThread.historyOnly, threadTrashedAt: mailThread.trashedAt,
    revisionSeq: workItem.revisionSeq }).from(workItem)
    .innerJoin(message, and(eq(message.id, workItem.sourceMessageId), eq(message.transportId, input.transportId)))
    .innerJoin(mailThread, and(eq(mailThread.id, workItem.threadId), eq(mailThread.transportId, input.transportId)))
    .innerJoin(mailboxTransport, eq(mailboxTransport.id, workItem.transportId))
    .innerJoin(mailboxAccess, and(eq(mailboxAccess.transportId, mailboxTransport.id),
      eq(mailboxAccess.userId, input.actorUserId)))
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId),
      eq(message.id, input.sourceMessageId), eq(mailboxTransport.isActive, true))).limit(2);
  const row = rows.length === 1 ? rows[0] : null;
  return row && row.itemThread && row.itemThread === row.messageThread && row.active &&
    row.itemMessage === input.sourceMessageId && row.messageId === input.sourceMessageId &&
    row.transportId === input.transportId && row.actorUserId === input.actorUserId && row.direction === 'inbound' &&
    !row.messageHistoryOnly && !row.threadHistoryOnly && row.threadTrashedAt === null &&
    row.status !== 'done' && row.status !== 'dismissed' && Number.isSafeInteger(row.revisionSeq) && row.revisionSeq >= 0
    ? { threadId: row.itemThread, revisionSeq: row.revisionSeq } : null;
}

export async function currentFilingSourceThread(db: DB, input: PreviewInput): Promise<string | null> {
  return (await currentFilingSource(db, input))?.threadId ?? null;
}

/**
 * Read-only staff preview: verify the selected PDF and a fresh exact HMS
 * record, then revalidate the source. It creates no approval, run or write.
 */
export async function previewFiling(input: PreviewInput): Promise<PreviewResult> {
  const resolved = paneStayHmsTargetForTransport(input.transportId);
  const expected = CENTURION_HMS_READ_TARGET;
  if (!resolved.ok || resolved.target.propertyCode !== expected.propertyCode ||
      resolved.target.origin !== expected.origin || resolved.target.secretId !== expected.secretId ||
      resolved.target.browserSlot !== expected.browserSlot ||
      resolved.target.installationEnvName !== expected.installationEnvName) {
    return { status: 'refused', reason: 'property_unavailable' };
  }
  const db = input.db ?? getDb();
  const current = await currentFilingSource(db, input);
  if (!current) return { status: 'refused', reason: 'source_unavailable' };
  const { threadId, revisionSeq } = current;
  const checkAuthority = async () => {
    const next = await currentFilingSource(db, input);
    return next?.threadId === threadId && next.revisionSeq === revisionSeq;
  };
  const originAllowed = async () => {
    try {
      const target = await assertHmsReadOriginAllowed({ transportId: input.transportId, threadId, messageId: input.sourceMessageId });
      return target.propertyCode === expected.propertyCode && target.origin === expected.origin &&
        target.secretId === expected.secretId && target.browserSlot === expected.browserSlot &&
        target.installationEnvName === expected.installationEnvName;
    } catch { return false; }
  };
  const sourceInput = { db, s3: input.s3 ?? getS3Storage(), transportId: input.transportId,
    messageId: input.sourceMessageId, attachmentId: input.attachmentId, checkAuthority };
  const document = await readPaneFilingAttachment({ ...sourceInput, signal: AbortSignal.timeout(60_000) });
  if (!document) return { status: 'refused', reason: 'source_unavailable' };
  if (input.documentSource && (document.source.sha256 !== input.documentSource.sha256 ||
      document.source.snapshotDigest !== input.documentSource.snapshotDigest)) {
    return { status: 'refused', reason: 'source_changed' };
  }
  if (!await originAllowed()) return { status: 'refused', reason: 'property_unavailable' };

  const found = await findStay({ confirmation: input.confirmation, arrival: input.arrival }, {
    target: resolved.target, transportId: input.transportId, lock: () => paneStayPropertyLock(resolved.target),
  });
  const normalizeName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  if (found.outcome !== 'found' || !found.stay || found.arrivalMismatch ||
      found.stay.confirmation !== input.confirmation || found.stay.arrival !== input.arrival ||
      !found.stay.lastName || normalizeName(found.stay.lastName) !== normalizeName(input.lastName)) {
    return { status: 'refused', reason: 'booking_unavailable' };
  }

  if (!await originAllowed()) return { status: 'refused', reason: 'property_unavailable' };
  const freshDocument = await readPaneFilingAttachment({ ...sourceInput, expected: document.source,
    signal: AbortSignal.timeout(60_000) });
  if (!freshDocument) return { status: 'refused', reason: 'source_changed' };
  return { status: 'ready', confirmation: input.confirmation, arrival: input.arrival,
    documentName: freshDocument.source.filename,
    documentSource: { sha256: freshDocument.source.sha256, snapshotDigest: freshDocument.source.snapshotDigest }, revisionSeq };
}
