// Private source resolution for Cloud document filing. No client supplies an object key or receipt.
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { attachment, message } from '../db/schema/mail.js';
import { outlookSyncArtifact, outlookSyncObservation, outlookSyncSource } from '../db/schema/outlook-sync.js';
import type { OutlookSyncStorage, SyncSealedArtifact } from '../outlook-sync/storage.js';
import type { S3Storage } from '../storage/s3.js';
import { acquirePop3VoucherSource, type Pop3FilingRecord } from './voucher-filing-pop3-source.js';
import { voucherFilingReceiptSchema } from './voucher-filing-receipt.js';
import { voucherFilingFormSchema, type VoucherFilingForm } from './voucher-filing-contract.js';

const MAX_BYTES = 10 * 1024 * 1024;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const id = z.string().min(1).max(512);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const provenanceSchema = z.object({
  version: z.literal(1), sourceId: id, observationId: id,
  artifactOrigin: z.object({ sourceId: id, observationId: id }).strict().nullable(),
  artifacts: z.array(z.unknown()).max(512), attention: z.unknown().optional(),
});
const artifactReceiptSchema = z.object({ role: id, artifactId: id, receipt: voucherFilingReceiptSchema }).strict();

export type VoucherSource = VoucherFilingForm['payload']['source'];
type SourceIdentity = Pick<VoucherSource, 'transportId' | 'messageId' | 'attachmentId'>;
export type VoucherSourceStorage = Pick<OutlookSyncStorage, 'bucket' | 'readSealedBounded'>;
export type VoucherSourceDependencies = {
  db: DB;
  storage: VoucherSourceStorage;
  /** POP3 source bucket must match the Outlook source bucket. */
  pop3Storage?: Pick<S3Storage, 'bucket' | 'getObjectBounded'>;
  signal: AbortSignal;
  /** Trusted server check for current authenticated mailbox, work item and source; never a browser callback. */
  checkAuthority: () => Promise<boolean>;
};
type Snapshot = { source: VoucherSource; receipt: SyncSealedArtifact };
type Refusal = { status: 'refused'; reason: 'source_unavailable' };
const refused = (): Refusal => ({ status: 'refused', reason: 'source_unavailable' });

/** Reconstruct only from mailbox-scoped DB rows and a uniquely accepted Outlook receipt. */
async function resolveSnapshot(input: SourceIdentity, deps: VoucherSourceDependencies): Promise<Snapshot | null> {
  if (![input.transportId, input.messageId, input.attachmentId].every((value) =>
    typeof value === 'string' && value.length > 0 && value.length <= 200)) return null;
  if (typeof deps.storage.bucket !== 'string' || !deps.storage.bucket || deps.storage.bucket.length > 255) return null;
  const rows = await deps.db.select({
    id: attachment.id, messageId: attachment.messageId, filename: attachment.filename,
    mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, sha256: attachment.sha256,
    sourceAttachmentId: attachment.sourceAttachmentId, s3Key: attachment.s3Key, isInline: attachment.isInline,
    provenance: message.sourceProvenance, direction: message.direction, historyOnly: message.historyOnly,
  }).from(attachment).innerJoin(message, eq(message.id, attachment.messageId))
    .where(and(eq(attachment.id, input.attachmentId), eq(message.id, input.messageId),
      eq(message.transportId, input.transportId))).limit(2);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (row.direction !== 'inbound' || row.historyOnly || row.isInline || row.mimeType !== 'application/pdf' ||
      !/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,149}$/.test(row.filename) || !/\.pdf$/i.test(row.filename) ||
      !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes <= 0 || row.sizeBytes > MAX_BYTES ||
      !hash.safeParse(row.sha256).success || !id.safeParse(row.sourceAttachmentId).success) return null;
  const duplicates = await deps.db.select({ id: attachment.id }).from(attachment)
    .where(and(eq(attachment.messageId, input.messageId), eq(attachment.sourceAttachmentId, row.sourceAttachmentId!))).limit(2);
  if (duplicates.length !== 1 || duplicates[0]?.id !== input.attachmentId) return null;
  const provenance = provenanceSchema.safeParse(row.provenance);
  if (!provenance.success || provenance.data.attention != null) return null;
  const p = provenance.data;
  if (p.artifactOrigin && p.artifactOrigin.sourceId !== p.sourceId) return null;
  const role = `attachment:${row.sourceAttachmentId}`;
  const candidates = p.artifacts.filter((entry) => entry && typeof entry === 'object' &&
    'role' in entry && entry.role === role);
  if (candidates.length !== 1) return null;
  const parsed = artifactReceiptSchema.safeParse(candidates[0]);
  if (!parsed.success) return null;
  const { artifactId, receipt } = parsed.data;
  const originId = p.artifactOrigin?.observationId ?? p.observationId;
  const expectedKey = `outlook-sync-originals/v1/${sha(JSON.stringify([p.sourceId, originId, artifactId]))}/${row.sha256}`;
  if (receipt.key !== expectedKey || row.s3Key !== expectedKey || receipt.bytes !== row.sizeBytes || receipt.sha256 !== row.sha256) return null;

  const [syncSource] = await deps.db.select({ id: outlookSyncSource.id }).from(outlookSyncSource)
    .where(and(eq(outlookSyncSource.id, p.sourceId), eq(outlookSyncSource.transportId, input.transportId))).limit(1);
  const [observation] = await deps.db.select({ sourceId: outlookSyncObservation.sourceId,
    sourceObservationId: outlookSyncObservation.sourceObservationId,
    canonicalMessageId: outlookSyncObservation.canonicalMessageId, ingestionState: outlookSyncObservation.ingestionState,
    artifactOrigin: outlookSyncObservation.artifactOrigin }).from(outlookSyncObservation)
    .where(eq(outlookSyncObservation.id, p.observationId)).limit(1);
  if (!syncSource || !observation || observation.sourceId !== p.sourceId ||
      observation.canonicalMessageId !== input.messageId || observation.ingestionState !== 'committed') return null;
  const observedOrigin = observation.artifactOrigin;
  if (p.artifactOrigin ? !observedOrigin || observedOrigin.sourceId !== p.artifactOrigin.sourceId ||
      observedOrigin.observationId !== p.artifactOrigin.observationId : observedOrigin != null) return null;
  if (p.artifactOrigin) {
    const [origin] = await deps.db.select({ sourceId: outlookSyncObservation.sourceId,
      sourceObservationId: outlookSyncObservation.sourceObservationId, artifactOrigin: outlookSyncObservation.artifactOrigin,
    }).from(outlookSyncObservation).where(eq(outlookSyncObservation.id, originId)).limit(1);
    if (!origin || origin.sourceId !== p.sourceId || origin.sourceObservationId !== observation.sourceObservationId ||
        origin.artifactOrigin != null) return null;
  }
  const [artifact] = await deps.db.select({ observationId: outlookSyncArtifact.observationId,
    role: outlookSyncArtifact.role, expectedBytes: outlookSyncArtifact.expectedBytes, sha256: outlookSyncArtifact.sha256,
    contentType: outlookSyncArtifact.contentType, sealedKey: outlookSyncArtifact.sealedKey,
    verifiedReceipt: outlookSyncArtifact.verifiedReceipt, acceptedAt: outlookSyncArtifact.acceptedAt,
  }).from(outlookSyncArtifact).where(eq(outlookSyncArtifact.id, artifactId)).limit(1);
  const accepted = voucherFilingReceiptSchema.safeParse(artifact?.verifiedReceipt);
  if (!artifact || !accepted.success || !artifact.acceptedAt || artifact.observationId !== originId ||
      artifact.role !== role || artifact.expectedBytes !== row.sizeBytes || artifact.sha256 !== row.sha256 ||
      artifact.contentType !== row.mimeType || artifact.sealedKey !== receipt.key ||
      JSON.stringify(accepted.data) !== JSON.stringify(receipt)) return null;

  // The approval binds the receipt and all source identity, including storage bucket, without exposing the key.
  const snapshotDigest = sha(JSON.stringify(['voucher-source/v1', deps.storage.bucket, input.transportId,
    input.messageId, input.attachmentId, row.sourceAttachmentId, row.filename, row.mimeType, row.sizeBytes,
    row.sha256, p.sourceId, p.observationId, originId, artifactId, receipt.key, receipt.eTag, receipt.versionId]));
  return { source: { transportId: input.transportId, messageId: input.messageId, attachmentId: input.attachmentId,
    filename: row.filename, mimeType: 'application/pdf', sha256: receipt.sha256, snapshotDigest }, receipt };
}

/** Read POP3 rows by the authenticated message and attachment IDs, never by a client object key. */
async function loadPop3Record(input: SourceIdentity, deps: VoucherSourceDependencies): Promise<Pop3FilingRecord | null> {
  const rows = await deps.db.select({
    transportId: message.transportId, messageId: message.id, attachmentId: attachment.id,
    ingestMailboxId: message.ingestMailboxId, pop3Uidl: message.pop3Uidl,
    direction: message.direction, historyOnly: message.historyOnly, provenance: message.sourceProvenance,
    filename: attachment.filename, mimeType: attachment.mimeType, isInline: attachment.isInline,
    sizeBytes: attachment.sizeBytes, sha256: attachment.sha256, s3Key: attachment.s3Key,
  }).from(attachment).innerJoin(message, eq(message.id, attachment.messageId))
    .where(and(eq(attachment.id, input.attachmentId), eq(message.id, input.messageId),
      eq(message.transportId, input.transportId))).limit(2);
  if (rows.length !== 1) return null;
  const { provenance, ...row } = rows[0]!;
  return { ...row, attention: provenance?.attention ?? null };
}

/** Both prepare and execution re-read exact bytes, then recheck authority and DB identity. */
async function acquire(input: SourceIdentity, deps: VoucherSourceDependencies, approved?: VoucherSource): Promise<
  { source: VoucherSource; bytes: Buffer } | null> {
  try {
    if (deps.signal.aborted || await deps.checkAuthority() !== true) return null;
    const first = await loadPop3Record(input, deps);
    if (!first) return null;
    if (first.s3Key.startsWith('attachments/')) {
      const storage = deps.pop3Storage;
      if (!storage || storage.bucket !== deps.storage.bucket) return null;
      return await acquirePop3VoucherSource(input, {
        bucket: storage.bucket, signal: deps.signal, checkAuthority: deps.checkAuthority,
        load: (identity) => loadPop3Record(identity, deps),
        readBounded: async (key, maxBytes, signal) => (await storage.getObjectBounded(key, maxBytes, signal))?.body ?? null,
      }, approved);
    }
    const snapshot = await resolveSnapshot(input, deps);
    if (!snapshot || (approved && (snapshot.source.transportId !== approved.transportId ||
        snapshot.source.messageId !== approved.messageId || snapshot.source.attachmentId !== approved.attachmentId ||
        snapshot.source.filename !== approved.filename || snapshot.source.mimeType !== approved.mimeType ||
        snapshot.source.sha256 !== approved.sha256 || snapshot.source.snapshotDigest !== approved.snapshotDigest))) return null;
    deps.signal.throwIfAborted();
    // Outlook reader checks the accepted receipt and uses IfMatch, with VersionId when present.
    // It cannot abort an in-flight request; the caller still fences lease and authority before dispatch.
    const fetched = await deps.storage.readSealedBounded(snapshot.receipt, MAX_BYTES);
    const bytes = Buffer.from(fetched);
    deps.signal.throwIfAborted();
    if (bytes.length !== snapshot.receipt.bytes || sha(bytes) !== snapshot.source.sha256 ||
        !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return null;
    if (await deps.checkAuthority() !== true) return null;
    const current = await resolveSnapshot(input, deps);
    if (!current || current.source.snapshotDigest !== snapshot.source.snapshotDigest || deps.signal.aborted ||
        await deps.checkAuthority() !== true || deps.signal.aborted) return null;
    return { source: snapshot.source, bytes };
  } catch { return null; }
}

/** The returned source must be durably included in the staff-approved form before any execution. */
export async function prepareVoucherFilingSource(input: SourceIdentity, deps: VoucherSourceDependencies): Promise<
  { status: 'ready'; source: VoucherSource } | Refusal> {
  const result = await acquire(input, deps);
  return result ? { status: 'ready', source: result.source } : refused();
}

/** Use the whole form from the consumed durable approval, never a source supplied by the pane. */
export async function readApprovedVoucherFilingSource(form: VoucherFilingForm, deps: VoucherSourceDependencies): Promise<
  { status: 'ready'; bytes: Buffer } | Refusal> {
  const parsed = voucherFilingFormSchema.safeParse(form);
  if (!parsed.success) return refused();
  const source = parsed.data.payload.source;
  const result = await acquire({ transportId: source.transportId, messageId: source.messageId,
    attachmentId: source.attachmentId }, deps, source);
  return result ? { status: 'ready', bytes: result.bytes } : refused();
}
