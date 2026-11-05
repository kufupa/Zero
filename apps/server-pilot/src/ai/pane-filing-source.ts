import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { attachment, mailThread, message } from '../db/schema/mail.js';
import { outlookSyncArtifact, outlookSyncObservation, outlookSyncSource } from '../db/schema/outlook-sync.js';
import { workItem } from '../db/schema/work.js';
import { isDaVinciMailboxOrigin } from '../hms/mailbox-hms-origin-bind.js';
import { lockCanonicalMailbox } from '../mail/ingest/canonical-identity.js';
import { canonicalMessageId } from '../mail/ingest/message-id.js';
import { panePop3AttachmentCandidate, readPanePop3Attachment } from '../mail/artifacts/pane-pop3-attachment.js';
import { OutlookSyncStorage } from '../outlook-sync/storage.js';
import { getS3Storage, type S3Storage } from '../storage/s3.js';
import { heartbeatAiRun, type AiRunFence } from './run-ledger.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { readVoucherDiscoverySource, resolveOutlookVoucherSnapshot } from './voucher-filing-source.js';

export type BoundFilingForm = {
  action: 'attach_document'; confirmation: string; arrival: string; lastName: string;
  sourceMessageId: string; sourceInternetMessageId: string; attachmentId: string; documentName: string;
  pdfSha256: string; sourceSnapshotDigest: string; sourceThreadId?: string; sourceHash?: string;
  documentCode?: string; filingStateDigest?: string;
};
type Scope = { transportId: string; workItemId: string; form: BoundFilingForm };
type WorkTransaction = Parameters<Parameters<DB['transaction']>[0]>[0];
type Item = typeof workItem.$inferSelect;
type PaneSource = { transportId: string; messageId: string; attachmentId: string;
  filename: string; sha256: string; snapshotDigest: string };

/** Preserve POP3's existing digest; sealed Outlook bytes use their accepted receipt digest. */
export async function readPaneFilingAttachment(input: {
  db: DB; s3: S3Storage; transportId: string; messageId: string; attachmentId: string;
  signal: AbortSignal; checkAuthority: () => Promise<boolean>; expected?: PaneSource;
}): Promise<{ source: PaneSource; bytes: Buffer } | null> {
  const pop3 = await readPanePop3Attachment(input);
  if (pop3) return pop3;
  try {
    const storage = new OutlookSyncStorage({ bucket: input.s3.bucket });
    return await readVoucherDiscoverySource(input, { db: input.db, storage, signal: input.signal,
      checkAuthority: input.checkAuthority }, input.expected ? { ...input.expected, mimeType: 'application/pdf' } : undefined);
  } catch { return null; }
}

function matchesForm(item: Item | undefined, form: BoundFilingForm): item is Item {
  return Boolean(item && !['done', 'dismissed'].includes(item.status) && item.sourceMessageId === form.sourceMessageId &&
    Object.entries(form).every(([key, value]) => item.state[key] === value));
}

/** Read and revalidate the exact selected PDF before staging the one native upload. */
export async function readBoundFilingSource(input: Scope & { db: DB; fence?: AiRunFence }): Promise<Buffer | null> {
  const { db, form } = input;
  const source = { transportId: input.transportId, messageId: form.sourceMessageId, attachmentId: form.attachmentId,
    filename: form.documentName, sha256: form.pdfSha256, snapshotDigest: form.sourceSnapshotDigest };
  const checkAuthority = async () => {
    const [item] = await db.select().from(workItem).where(and(eq(workItem.id, input.workItemId),
      eq(workItem.transportId, input.transportId))).limit(1);
    return matchesForm(item, form) && (!input.fence || await heartbeatAiRun(input.fence, db));
  };
  const read = await readPaneFilingAttachment({ ...source, db, s3: getS3Storage(),
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
  if (!mail || !selectedId || selectedId !== form.sourceInternetMessageId || mail.messageIdHeader !== selectedId) return null;
  const hasExactSource = form.sourceThreadId !== undefined || form.sourceHash !== undefined;
  if (hasExactSource && (!form.sourceThreadId || !form.sourceHash || !/^[a-f0-9]{64}$/.test(form.sourceHash) ||
      form.sourceThreadId !== reference.threadId || mail.threadId !== form.sourceThreadId ||
      mail.direction !== 'inbound' || staffQuoteSourceHash(mail) !== form.sourceHash)) return null;
  const matching = await tx.select({ id: message.id }).from(message).where(and(eq(message.transportId, transportId),
    eq(message.messageIdHeader, selectedId), hasExactSource ? eq(message.id, form.sourceMessageId) : undefined,
    form.sourceThreadId ? eq(message.threadId, form.sourceThreadId) : undefined)).limit(2).for('share');
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
  const bucket = getS3Storage().bucket;
  if (file.s3Key?.startsWith('outlook-sync-originals/')) {
    // Sync writers lock source before changing observations or artifacts. Lock it before
    // resolving again so the receipt and latest artifact cannot change during claim.
    const owners = await tx.select({ id: outlookSyncObservation.sourceId }).from(outlookSyncArtifact)
      .innerJoin(outlookSyncObservation, eq(outlookSyncObservation.id, outlookSyncArtifact.observationId))
      .where(eq(outlookSyncArtifact.sealedKey, file.s3Key)).limit(2);
    if (owners.length !== 1) return null;
    const [owner] = await tx.select({ id: outlookSyncSource.id }).from(outlookSyncSource).where(and(
      eq(outlookSyncSource.id, owners[0]!.id), eq(outlookSyncSource.transportId, transportId))).limit(1).for('share');
    if (!owner) return null;
    const snapshot = await resolveOutlookVoucherSnapshot({ transportId, messageId: form.sourceMessageId,
      attachmentId: form.attachmentId }, { db: tx as unknown as DB, storage: { bucket } });
    return snapshot && snapshot.source.filename === form.documentName && snapshot.source.sha256 === form.pdfSha256 &&
      snapshot.source.snapshotDigest === form.sourceSnapshotDigest ? item : null;
  }
  const candidate = await panePop3AttachmentCandidate({ db: tx as unknown as DB, bucket,
    transportId, messageId: form.sourceMessageId, attachmentId: form.attachmentId });
  if (!candidate || candidate.filename !== form.documentName || (candidate.sha256 && candidate.sha256 !== form.pdfSha256)) return null;
  const digest = createHash('sha256').update(`${candidate.fingerprint}:${form.pdfSha256}`).digest('hex');
  return digest === form.sourceSnapshotDigest ? item : null;
}
