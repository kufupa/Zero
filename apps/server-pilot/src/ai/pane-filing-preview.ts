import { and, eq } from 'drizzle-orm';
import { getDb, type DB } from '../db/client.js';
import { mailboxAccess, mailboxTransport, message } from '../db/schema/mail.js';
import { workItem } from '../db/schema/work.js';
import { assertHmsReadOriginAllowed, CENTURION_HMS_READ_TARGET } from '../hms/hms-read-target.js';
import { readPanePop3Attachment } from '../mail/artifacts/pane-pop3-attachment.js';
import { getS3Storage, type S3Storage } from '../storage/s3.js';
import { findStay } from './pane-stay-lookup.js';
import { paneStayPropertyLock } from './pane-stay-save.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';

type PreviewInput = {
  transportId: string;
  actorUserId: string;
  workItemId: string;
  sourceMessageId: string;
  attachmentId: string;
  confirmation: string;
  arrival: string;
  lastName: string;
  db?: DB;
  s3?: S3Storage;
};

type PreviewResult =
  | { status: 'ready'; confirmation: string; arrival: string; documentName: string }
  | { status: 'refused'; reason: string };

/** Recheck the selected message, work item and current mailbox access around the remote reads. */
async function currentSourceThread(db: DB, input: PreviewInput): Promise<string | null> {
  const rows = await db.select({ itemThread: workItem.threadId, messageThread: message.threadId,
    itemMessage: workItem.sourceMessageId, messageId: message.id, transportId: workItem.transportId,
    actorUserId: mailboxAccess.userId, active: mailboxTransport.isActive, status: workItem.status }).from(workItem)
    .innerJoin(message, and(eq(message.id, workItem.sourceMessageId), eq(message.transportId, input.transportId)))
    .innerJoin(mailboxTransport, eq(mailboxTransport.id, workItem.transportId))
    .innerJoin(mailboxAccess, and(eq(mailboxAccess.transportId, mailboxTransport.id),
      eq(mailboxAccess.userId, input.actorUserId)))
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId),
      eq(message.id, input.sourceMessageId), eq(mailboxTransport.isActive, true))).limit(2);
  const row = rows.length === 1 ? rows[0] : null;
  return row && row.itemThread && row.itemThread === row.messageThread && row.active &&
    row.itemMessage === input.sourceMessageId && row.messageId === input.sourceMessageId &&
    row.transportId === input.transportId && row.actorUserId === input.actorUserId &&
    row.status !== 'done' && row.status !== 'dismissed' ? row.itemThread : null;
}

/**
 * Read-only staff preview: verify the selected POP3 PDF and a fresh exact HMS
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
  const threadId = await currentSourceThread(db, input);
  if (!threadId) return { status: 'refused', reason: 'source_unavailable' };
  const checkAuthority = async () => (await currentSourceThread(db, input)) === threadId;
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
  const document = await readPanePop3Attachment({ ...sourceInput, signal: AbortSignal.timeout(60_000) });
  if (!document) return { status: 'refused', reason: 'source_unavailable' };
  if (!await originAllowed()) return { status: 'refused', reason: 'property_unavailable' };

  const found = await findStay({ confirmation: input.confirmation, arrival: input.arrival }, {
    target: resolved.target, lock: () => paneStayPropertyLock(resolved.target),
  });
  const normalizeName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  if (found.outcome !== 'found' || !found.stay || found.arrivalMismatch ||
      found.stay.confirmation !== input.confirmation || found.stay.arrival !== input.arrival ||
      !found.stay.lastName || normalizeName(found.stay.lastName) !== normalizeName(input.lastName)) {
    return { status: 'refused', reason: 'booking_unavailable' };
  }

  if (!await originAllowed()) return { status: 'refused', reason: 'property_unavailable' };
  const freshDocument = await readPanePop3Attachment({ ...sourceInput, expected: document.source,
    signal: AbortSignal.timeout(60_000) });
  if (!freshDocument) return { status: 'refused', reason: 'source_changed' };
  return { status: 'ready', confirmation: input.confirmation, arrival: input.arrival,
    documentName: freshDocument.source.filename };
}
