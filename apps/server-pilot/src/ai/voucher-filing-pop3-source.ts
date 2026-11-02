import { createHash } from 'node:crypto';
import { MAX_VOUCHER_FILING_BYTES, readAndHashVoucherBytes } from './voucher-filing-bytes.js';

/** Trusted fields loaded from the server's mailbox-scoped message/attachment join. */
export type Pop3FilingRecord = {
  transportId: string;
  messageId: string;
  attachmentId: string;
  ingestMailboxId: string | null;
  pop3Uidl: string | null;
  direction: string;
  historyOnly: boolean;
  attention: unknown;
  filename: string;
  mimeType: string;
  isInline: boolean;
  sizeBytes: number;
  sha256: string | null;
  s3Key: string;
};
type Identity = Pick<Pop3FilingRecord, 'transportId' | 'messageId' | 'attachmentId'>;
export type Pop3FilingSource = Identity & {
  filename: string;
  mimeType: 'application/pdf';
  sha256: string;
  snapshotDigest: string;
};
export type Pop3FilingDependencies = {
  bucket: string;
  signal: AbortSignal;
  /** Must return exactly one joined row, scoped by all three identity values. */
  load: (identity: Identity) => Promise<Pop3FilingRecord | null>;
  /** Must enforce the provided byte limit while streaming. */
  readBounded: (key: string, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array | null>;
  /** Server-side authenticated mailbox and work-item check, never a client callback. */
  checkAuthority: () => Promise<boolean>;
};

function safePdfFilename(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 150 &&
    /\.pdf$/i.test(value) && !value.includes('/') && !value.includes('\\') &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function snapshot(identity: Identity, row: Pop3FilingRecord | null, bucket: string, contentSha256: string): Pop3FilingSource | null {
  if (!row || !bucket || bucket.length > 255 ||
      ![identity.transportId, identity.messageId, identity.attachmentId].every((v) => typeof v === 'string' && v.length > 0 && v.length <= 200) ||
      row.transportId !== identity.transportId || row.messageId !== identity.messageId || row.attachmentId !== identity.attachmentId ||
      !row.ingestMailboxId || !row.pop3Uidl || row.direction !== 'inbound' || row.historyOnly || row.attention != null ||
      row.isInline || row.mimeType !== 'application/pdf' ||
      !safePdfFilename(row.filename) ||
      !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes <= 0 || row.sizeBytes > MAX_VOUCHER_FILING_BYTES ||
      (row.sha256 !== null && !/^[a-f0-9]{64}$/.test(row.sha256)) || !/^[a-f0-9]{64}$/.test(contentSha256) ||
      (row.sha256 !== null && row.sha256 !== contentSha256) || !row.s3Key.startsWith('attachments/')) return null;
  // Canonical reconciliation may attach POP3 bytes whose key contains the
  // original ingest message ID rather than the canonical message ID.
  const snapshotDigest = createHash('sha256').update(JSON.stringify([
    'voucher-pop3-source/v1', bucket, row.transportId, row.messageId, row.attachmentId,
    row.ingestMailboxId, row.pop3Uidl, row.filename, row.mimeType, row.sizeBytes, row.sha256, row.s3Key, contentSha256,
  ])).digest('hex');
  return { ...identity, filename: row.filename, mimeType: 'application/pdf', sha256: contentSha256, snapshotDigest };
}

/** Read and revalidate identity, authority and exact bytes at prepare and dispatch. */
export async function acquirePop3VoucherSource(
  identity: Identity,
  deps: Pop3FilingDependencies,
  approved?: Pop3FilingSource,
): Promise<{ source: Pop3FilingSource; bytes: Buffer } | null> {
  try {
    if (deps.signal.aborted || await deps.checkAuthority() !== true) return null;
    const row = await deps.load(identity);
    if (!row) return null;
    // Before approval, legacy POP3 rows may have no ingest digest. Bind the
    // bounded current bytes at prepare; later reads must match that digest.
    const candidateHash = row.sha256 ?? approved?.sha256 ?? '0'.repeat(64);
    const candidate = snapshot(identity, row, deps.bucket, candidateHash);
    if (!candidate || (approved && (approved.transportId !== candidate.transportId ||
        approved.messageId !== candidate.messageId || approved.attachmentId !== candidate.attachmentId ||
        approved.filename !== candidate.filename || approved.mimeType !== candidate.mimeType ||
        approved.sha256 !== candidate.sha256 || approved.snapshotDigest !== candidate.snapshotDigest))) return null;
    const fetched = await readAndHashVoucherBytes({ expectedBytes: row.sizeBytes,
      expectedSha256: row.sha256 ?? approved?.sha256 ?? null, signal: deps.signal,
      readBounded: (maxBytes, signal) => deps.readBounded(row.s3Key, maxBytes, signal) });
    if (!fetched || await deps.checkAuthority() !== true || deps.signal.aborted) return null;
    const source = snapshot(identity, row, deps.bucket, fetched.sha256);
    const current = snapshot(identity, await deps.load(identity), deps.bucket, fetched.sha256);
    if (!source || !current || current.snapshotDigest !== source.snapshotDigest || deps.signal.aborted ||
        await deps.checkAuthority() !== true || deps.signal.aborted) return null;
    const bytes = fetched.bytes;
    return { source, bytes };
  } catch {
    return null;
  }
}
