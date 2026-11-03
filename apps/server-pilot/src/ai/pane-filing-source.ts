import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { attachment, mailThread, message } from '../db/schema/mail.js';
import { workItem } from '../db/schema/work.js';
import { isDaVinciMailboxOrigin } from '../hms/mailbox-hms-origin-bind.js';
import { lockCanonicalMailbox } from '../mail/ingest/canonical-identity.js';
import { canonicalMessageId } from '../mail/ingest/message-id.js';
import { panePop3AttachmentCandidate, readPanePop3Attachment } from '../mail/artifacts/pane-pop3-attachment.js';
import { getS3Storage } from '../storage/s3.js';
import { heartbeatAiRun, type AiRunFence } from './run-ledger.js';

export type BoundFilingForm = {
  action: 'attach_document'; confirmation: string; arrival: string; lastName: string;
  sourceMessageId: string; sourceInternetMessageId: string; attachmentId: string; documentName: string;
  pdfSha256: string; sourceSnapshotDigest: string;
};
type Scope = { transportId: string; workItemId: string; form: BoundFilingForm };
type WorkTransaction = Parameters<Parameters<DB['transaction']>[0]>[0];
type Item = typeof workItem.$inferSelect;

function matchesForm(item: Item | undefined, form: BoundFilingForm): item is Item {
  return Boolean(item && !['done', 'dismissed'].includes(item.status) && item.sourceMessageId === form.sourceMessageId &&
    Object.entries(form).every(([key, value]) => item.state[key] === value));
}

/** Read and revalidate the exact POP3 PDF before staging the one native upload. */
export async function readBoundFilingSource(input: Scope & { db: DB; fence?: AiRunFence }): Promise<Buffer | null> {
  const { db, form } = input;
  const source = { transportId: input.transportId, messageId: form.sourceMessageId, attachmentId: form.attachmentId,
    filename: form.documentName, sha256: form.pdfSha256, snapshotDigest: form.sourceSnapshotDigest };
  const checkAuthority = async () => {
    const [item] = await db.select().from(workItem).where(and(eq(workItem.id, input.workItemId),
      eq(workItem.transportId, input.transportId))).limit(1);
    return matchesForm(item, form) && (!input.fence || await heartbeatAiRun(input.fence, db));
  };
  const read = await readPanePop3Attachment({ ...source, db, s3: getS3Storage(),
    signal: AbortSignal.timeout(60_000), checkAuthority, expected: source });
  return read?.bytes ?? null;
}

/** Lock and recheck the source snapshot in the final durable dispatch-claim transaction. */
export async function lockBoundFilingSource(tx: WorkTransaction, input: Scope & { allowUnbound?: boolean }): Promise<Item | null> {
  const { transportId, workItemId, form } = input;
  await lockCanonicalMailbox(tx as unknown as DB, transportId);
  const [reference] = await tx.select({ threadId: message.threadId }).from(message).where(and(
    eq(message.id, form.sourceMessageId), eq(message.transportId, transportId))).limit(1);
  if (!reference) return null;
  const [thread] = await tx.select({ id: mailThread.id, historyOnly: mailThread.historyOnly, trashedAt: mailThread.trashedAt })
    .from(mailThread).where(and(eq(mailThread.id, reference.threadId), eq(mailThread.transportId, transportId))).limit(1).for('share');
  if (!thread || thread.historyOnly || thread.trashedAt !== null) return null;
  const [mail] = await tx.select().from(message).where(and(eq(message.id, form.sourceMessageId),
    eq(message.transportId, transportId))).limit(1).for('no key update');
  const selectedId = canonicalMessageId(form.sourceInternetMessageId);
  if (!selectedId || selectedId !== form.sourceInternetMessageId || mail?.messageIdHeader !== selectedId) return null;
  const matching = await tx.select({ id: message.id }).from(message).where(and(eq(message.transportId, transportId),
    eq(message.messageIdHeader, selectedId))).limit(2).for('share');
  if (matching.length !== 1 || matching[0]?.id !== form.sourceMessageId) return null;
  const origins = await tx.select({ id: message.id, direction: message.direction, fromAddress: message.fromAddress,
    ownerHeaderValue: message.ownerHeaderValue, toAddresses: message.toAddresses, ccAddresses: message.ccAddresses })
    .from(message).where(and(eq(message.transportId, transportId), eq(message.threadId, thread.id))).for('share');
  if (origins.some((row) => (row.id === form.sourceMessageId || row.direction === 'inbound') && isDaVinciMailboxOrigin(row))) return null;
  const [file] = await tx.select().from(attachment).where(and(eq(attachment.id, form.attachmentId),
    eq(attachment.messageId, form.sourceMessageId))).limit(1).for('update');
  const [item] = await tx.select().from(workItem).where(and(eq(workItem.id, workItemId),
    eq(workItem.transportId, transportId))).limit(1).for('no key update');
  if (!mail || !file || !item || item.sourceMessageId !== form.sourceMessageId ||
      ['done', 'dismissed'].includes(item.status) || (!input.allowUnbound && !matchesForm(item, form)) ||
      mail.threadId !== thread.id || mail.threadId !== item.threadId) return null;
  const candidate = await panePop3AttachmentCandidate({ db: tx as unknown as DB, bucket: getS3Storage().bucket,
    transportId, messageId: form.sourceMessageId, attachmentId: form.attachmentId });
  if (!candidate || candidate.filename !== form.documentName || (candidate.sha256 && candidate.sha256 !== form.pdfSha256)) return null;
  const digest = createHash('sha256').update(`${candidate.fingerprint}:${form.pdfSha256}`).digest('hex');
  return digest === form.sourceSnapshotDigest ? item : null;
}
