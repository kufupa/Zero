import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { attachment, message } from '../../db/schema/mail.js';
import type { S3Storage } from '../../storage/s3.js';
import { readAuthorizedArtifactBytes, type AttachmentLocator } from './read-artifact.js';

export const PANE_ATTACH_MAX_BYTES = 10 * 1024 * 1024;
type Identity = { transportId: string; messageId: string; attachmentId: string };
type Source = Identity & { filename: string; sha256: string; snapshotDigest: string };
type Candidate = { locator: AttachmentLocator; filename: string; fingerprint: string; sha256: string | null };

/** Read the exact database identity without network I/O; caller supplies any required locks. */
export async function panePop3AttachmentCandidate(input: Identity & { db: DB; bucket: string }): Promise<Candidate | null> {
  const rows = await input.db.select({
    transportId: message.transportId, messageId: message.id, threadId: message.threadId, attachmentId: attachment.id,
    mailboxId: message.ingestMailboxId, uidl: message.pop3Uidl, direction: message.direction,
    messageIdHeader: message.messageIdHeader,
    historyOnly: message.historyOnly, provenance: message.sourceProvenance,
    subject: message.subject, textBody: message.textBody, htmlBody: message.htmlBody,
    fromAddress: message.fromAddress, toAddresses: message.toAddresses, ccAddresses: message.ccAddresses,
    filename: attachment.filename, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256, s3Key: attachment.s3Key, isInline: attachment.isInline,
  }).from(attachment).innerJoin(message, eq(message.id, attachment.messageId)).where(and(
    eq(attachment.id, input.attachmentId), eq(message.id, input.messageId), eq(message.transportId, input.transportId),
  )).limit(2);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const key = /^attachments\/([^/]+)\/([^/]+)$/.exec(row.s3Key);
  if (row.transportId !== input.transportId || row.messageId !== input.messageId || row.attachmentId !== input.attachmentId ||
      !key || key.slice(1).some((part) => part === '.' || part === '..' || /[\\\p{Cc}]/u.test(part)) ||
      !row.mailboxId || !row.uidl || row.direction !== 'inbound' || row.historyOnly || row.isInline ||
      row.provenance?.attention != null || row.filename.length > 150 || /["\\/\p{Cc}]/u.test(row.filename) ||
      Buffer.from(row.filename, 'utf8').toString('utf8') !== row.filename || !/\.pdf$/i.test(row.filename) ||
      !['application/pdf', 'application/x-pdf', 'application/octet-stream'].includes(
        row.mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '') ||
      !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes <= 0 || row.sizeBytes > PANE_ATTACH_MAX_BYTES ||
      (row.sha256 !== null && !/^[a-f0-9]{64}$/.test(row.sha256))) return null;
  // Reconciled POP3 attachments can retain their ingest message ID in the
  // object key. The scoped joined row, mailbox and UIDL authorize that key;
  // the message shown to staff remains input.messageId in the digest.
  const locator: AttachmentLocator = { s3Key: row.s3Key, messageId: key[1]!, mimeType: row.mimeType,
    sizeBytes: row.sizeBytes, sha256: row.sha256 };
  const fingerprint = createHash('sha256').update(JSON.stringify([input.bucket, row.transportId, row.messageId, row.messageIdHeader,
    row.threadId, row.subject, row.textBody, row.htmlBody, row.fromAddress, row.toAddresses, row.ccAddresses,
    row.attachmentId, row.mailboxId, row.uidl, row.filename, row.mimeType, row.sizeBytes, row.sha256, row.s3Key])).digest('hex');
  return { locator, filename: row.filename, fingerprint, sha256: row.sha256 };
}

/** Only scoped inbound POP3 records are admitted; Outlook requires a separate sealed-receipt verifier. */
export async function readPanePop3Attachment(input: Identity & {
  db: DB; s3: S3Storage; signal: AbortSignal; checkAuthority: () => Promise<boolean>; expected?: Source;
}): Promise<{ source: Source; bytes: Buffer; locator: AttachmentLocator } | null> {
  const load = () => panePop3AttachmentCandidate({ db: input.db, bucket: input.s3.bucket,
    transportId: input.transportId, messageId: input.messageId, attachmentId: input.attachmentId });
  try {
    if (input.signal.aborted || !(await input.checkAuthority())) return null;
    const candidate = await load();
    if (!candidate) return null;
    const current = async () => {
      const next = await load();
      return !!next && next.fingerprint === candidate.fingerprint && await input.checkAuthority();
    };
    const stored = await readAuthorizedArtifactBytes({
      attachmentId: input.attachmentId, authorizedAttachmentIds: new Set([input.attachmentId]),
      s3: input.s3, signal: input.signal, expectedLocator: candidate.locator,
      ...(input.expected ? { expectedSha256: input.expected.sha256 } : {}),
      resolveLocator: async () => (await load())?.locator ?? null, revalidate: current,
    });
    if (!stored || (candidate.sha256 && candidate.sha256 !== stored.sha256) ||
        !stored.body.subarray(0, 5).equals(Buffer.from('%PDF-')) || !(await current()) || input.signal.aborted) return null;
    const snapshotDigest = createHash('sha256').update(`${candidate.fingerprint}:${stored.sha256}`).digest('hex');
    const source: Source = { transportId: input.transportId, messageId: input.messageId, attachmentId: input.attachmentId,
      filename: candidate.filename, sha256: stored.sha256, snapshotDigest };
    if (input.expected && (source.transportId !== input.expected.transportId || source.messageId !== input.expected.messageId ||
        source.attachmentId !== input.expected.attachmentId || source.filename !== input.expected.filename ||
        source.sha256 !== input.expected.sha256 || source.snapshotDigest !== input.expected.snapshotDigest)) return null;
    return { source, bytes: stored.body, locator: candidate.locator };
  } catch { return null; }
}
