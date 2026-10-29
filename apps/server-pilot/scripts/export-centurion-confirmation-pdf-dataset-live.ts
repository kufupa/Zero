import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { simpleParser } from 'mailparser';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import { RealS3Storage } from '../src/storage/s3.js';

const APPROVED_INSTANCE_ID = 'i-008f737974a9ba9b3';
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const FILENAME_PATTERN = '^HRCEN_Confirmation_Letter_.*[.]pdf$';
const FROM_PREFIX = 'Centurion at';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

type Candidate = {
  attachmentId: string;
  messageDbId: string;
  filename: string;
  mimeType: string;
  byteSize: string | number;
  s3Key: string;
  threadId: string | null;
  messageIdHeader: string | null;
  storedFromAddress: string | null;
  toAddresses: unknown;
  ccAddresses: unknown;
  bccAddresses: unknown;
  subject: string | null;
  sentAt: string | Date | null;
  receivedAt: string | Date | null;
  createdAt: string | Date | null;
  inReplyTo: string | null;
  references: unknown;
  rawMimeKey: string | null;
};

type SenderEvidence = {
  status: 'match' | 'no_match' | 'not_stored' | 'missing' | 'unreadable' | 'read_failed';
  headerSha256?: string;
};

function argument(name: string): string | null {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function attestApprovedInstance(): Promise<void> {
  const tokenResponse = await fetch('http://169.254.169.254/latest/api/token', {
    method: 'PUT',
    headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
    signal: AbortSignal.timeout(3000),
  });
  if (!tokenResponse.ok) throw new Error('instance_attestation_failed');
  const token = await tokenResponse.text();
  const instanceResponse = await fetch('http://169.254.169.254/latest/meta-data/instance-id', {
    headers: { 'X-aws-ec2-metadata-token': token },
    signal: AbortSignal.timeout(3000),
  });
  if (!instanceResponse.ok || (await instanceResponse.text()) !== APPROVED_INSTANCE_ID) {
    throw new Error('instance_attestation_failed');
  }
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = items.length;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await operation(items[index]!);
      }
    }),
  );
  return results;
}

export async function readFromHeader(
  storage: RealS3Storage,
  key: string | null,
): Promise<SenderEvidence> {
  if (!key) return { status: 'not_stored' };
  try {
    const response = await storage.client.send(
      new GetObjectCommand({
        Bucket: storage.bucket,
        Key: key,
        Range: `bytes=0-${MAX_HEADER_BYTES - 1}`,
      }),
    );
    if (!response.Body) return { status: 'missing' };
    const bytes = Buffer.from(await response.Body.transformToByteArray());
    const crlf = bytes.indexOf('\r\n\r\n');
    const lf = bytes.indexOf('\n\n');
    const separator = crlf < 0 ? lf : lf < 0 ? crlf : Math.min(crlf, lf);
    if (separator < 0) return { status: 'unreadable' };
    const header = bytes.subarray(0, separator + (separator === crlf ? 4 : 2));
    const parsed = await simpleParser(header, { skipHtml: true, skipText: true });
    const sender = parsed.from?.value?.[0];
    if (!sender?.address) return { status: 'unreadable', headerSha256: sha256(header) };
    const displayName = sender.name ?? '';
    return {
      status: displayName.startsWith(FROM_PREFIX) ? 'match' : 'no_match',
      headerSha256: sha256(header),
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return { status: name === 'NoSuchKey' || name === 'NotFound' ? 'missing' : 'read_failed' };
  }
}

export async function savePdfBytes(pdfPath: string, bytes: Buffer): Promise<void> {
  await writeFile(pdfPath, bytes, { mode: 0o600, flag: 'wx' });
  await chmod(pdfPath, 0o600);
}

async function main(): Promise<void> {
  await attestApprovedInstance();
  const databaseUrl = process.env.DATABASE_URL;
  const region = process.env.AWS_REGION;
  const bucket = process.env.S3_BUCKET;
  const sourceSnapshot = argument('--source-snapshot');
  if (!databaseUrl || !region || !bucket || !sourceSnapshot) {
    throw new Error('configuration_missing');
  }

  const sourceCorpus = path.join(sourceSnapshot, 'corpus.jsonl');
  const sourceManifest = path.join(sourceSnapshot, 'manifest.json');
  if (!(await stat(sourceCorpus)).isFile() || !(await stat(sourceManifest)).isFile()) {
    throw new Error('source_snapshot_missing');
  }

  const outputDir = path.join(
    repoRoot,
    '.private',
    'connected-mailbox-corpus',
    `halloween-confirmation-pdfs-${randomUUID()}`,
  );
  const pdfDir = path.join(outputDir, 'pdfs');
  await mkdir(pdfDir, { recursive: true, mode: 0o700 });
  await chmod(outputDir, 0o700);
  await chmod(pdfDir, 0o700);
  await copyFile(sourceCorpus, path.join(outputDir, 'corpus.jsonl'));
  await copyFile(sourceManifest, path.join(outputDir, 'source-manifest.json'));
  await chmod(path.join(outputDir, 'corpus.jsonl'), 0o600);
  await chmod(path.join(outputDir, 'source-manifest.json'), 0o600);

  const sql = postgres(databaseUrl, {
    max: 1,
    ssl: getPostgresSslOptions(databaseUrl),
  });
  const storage = new RealS3Storage(region, bucket);
  try {
    const candidates = await sql<Candidate[]>`
      SELECT
        a.id AS "attachmentId",
        a.message_id AS "messageDbId",
        a.filename,
        a.mime_type AS "mimeType",
        a.size_bytes::text AS "byteSize",
        a.s3_key AS "s3Key",
        m.thread_id AS "threadId",
        m.message_id_header AS "messageIdHeader",
        m.from_address AS "storedFromAddress",
        m.to_addresses AS "toAddresses",
        m.cc_addresses AS "ccAddresses",
        m.bcc_addresses AS "bccAddresses",
        m.subject,
        m.sent_at AS "sentAt",
        m.received_at AS "receivedAt",
        m.created_at AS "createdAt",
        m.in_reply_to AS "inReplyTo",
        m."references" AS "references",
        m.raw_mime_s3_key AS "rawMimeKey"
      FROM attachment AS a
      INNER JOIN message AS m ON m.id = a.message_id
      WHERE m.transport_id = 'transport-centurion'
        AND m.direction::text = 'outbound'
        AND a.filename ~ ${FILENAME_PATTERN}
      ORDER BY a.message_id, a.id
    `;

    const messageRows = new Map<string, Candidate>();
    for (const candidate of candidates) {
      if (!messageRows.has(candidate.messageDbId)) messageRows.set(candidate.messageDbId, candidate);
    }
    const senderEvidenceRows = await mapConcurrent(
      [...messageRows.values()],
      8,
      async (candidate) => [candidate.messageDbId, await readFromHeader(storage, candidate.rawMimeKey)] as const,
    );
    const senderEvidence = new Map(senderEvidenceRows);

    const records = await mapConcurrent(candidates, 8, async (candidate) => {
      const parsedByteSize = Number(candidate.byteSize);
      const safeId = candidate.attachmentId.replace(/[^A-Za-z0-9._-]/g, '_');
      const relativePath = `pdfs/${safeId}.pdf`;
      const evidence = senderEvidence.get(candidate.messageDbId) ?? { status: 'read_failed' as const };
      const parentMessage = {
        messageDbId: candidate.messageDbId,
        threadId: candidate.threadId,
        messageIdHeader: candidate.messageIdHeader,
        storedFromAddress: candidate.storedFromAddress,
        toAddresses: candidate.toAddresses,
        ccAddresses: candidate.ccAddresses,
        bccAddresses: candidate.bccAddresses,
        subject: candidate.subject,
        sentAt: candidate.sentAt,
        receivedAt: candidate.receivedAt,
        createdAt: candidate.createdAt,
        inReplyTo: candidate.inReplyTo,
        references: candidate.references,
      };
      if (!Number.isSafeInteger(parsedByteSize) || parsedByteSize < 0) {
        return {
          schemaVersion: 1,
          selection: { transportId: 'transport-centurion', direction: 'outbound', filenamePattern: FILENAME_PATTERN },
          attachment: { attachmentId: candidate.attachmentId, filename: candidate.filename, mimeType: candidate.mimeType, byteSize: null, s3Key: candidate.s3Key },
          parentMessage,
          fromHeaderEvidence: evidence,
          file: { status: 'malformed_size', path: relativePath },
        };
      }
      let object: Awaited<ReturnType<RealS3Storage['getObjectBounded']>>;
      try {
        object = await storage.getObjectBounded(candidate.s3Key, MAX_PDF_BYTES);
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        return {
          schemaVersion: 1,
          selection: { transportId: 'transport-centurion', direction: 'outbound', filenamePattern: FILENAME_PATTERN },
          attachment: { attachmentId: candidate.attachmentId, filename: candidate.filename, mimeType: candidate.mimeType, byteSize: parsedByteSize, s3Key: candidate.s3Key },
          parentMessage,
          fromHeaderEvidence: evidence,
          file: { status: name === 'S3ObjectTooLargeError' ? 'too_large' : 'read_failed', path: relativePath },
        };
      }
      if (!object) {
        return {
          schemaVersion: 1,
          selection: { transportId: 'transport-centurion', direction: 'outbound', filenamePattern: FILENAME_PATTERN },
          attachment: { attachmentId: candidate.attachmentId, filename: candidate.filename, mimeType: candidate.mimeType, byteSize: parsedByteSize, s3Key: candidate.s3Key },
          parentMessage,
          fromHeaderEvidence: evidence,
          file: { status: 'missing', path: relativePath },
        };
      }
      const digest = sha256(object.body);
      const pdfMagicValid = object.body.subarray(0, 5).toString('ascii') === '%PDF-';
      await savePdfBytes(path.join(outputDir, relativePath), object.body);
      return {
        schemaVersion: 1,
        selection: { transportId: 'transport-centurion', direction: 'outbound', filenamePattern: FILENAME_PATTERN },
        attachment: { attachmentId: candidate.attachmentId, filename: candidate.filename, mimeType: candidate.mimeType, byteSize: parsedByteSize, s3Key: candidate.s3Key },
        parentMessage,
        fromHeaderEvidence: evidence,
        file: { status: 'available', path: relativePath, bytes: object.body.byteLength, sha256: digest, pdfMagicValid, sizeMatchesMetadata: object.body.byteLength === parsedByteSize },
      };
    });

    const recordsJsonl = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    await writeFile(path.join(outputDir, 'attachments.jsonl'), recordsJsonl, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(path.join(outputDir, 'attachments.jsonl'), 0o600);
    const fromCounts: Record<string, number> = {};
    const fileCounts: Record<string, number> = {};
    let storedPdfBytes = 0;
    for (const record of records) {
      const fromStatus = record.fromHeaderEvidence.status;
      fromCounts[fromStatus] = (fromCounts[fromStatus] ?? 0) + 1;
      const fileStatus = record.file.status;
      fileCounts[fileStatus] = (fileCounts[fileStatus] ?? 0) + 1;
      if ('bytes' in record.file && typeof record.file.bytes === 'number') storedPdfBytes += record.file.bytes;
    }
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceSnapshot: path.basename(sourceSnapshot),
      sourceCorpusSha256: sha256(await readFile(sourceCorpus)),
      selection: {
        transportId: 'transport-centurion',
        direction: 'outbound',
        filenameRegex: FILENAME_PATTERN,
        fromHeaderPrefix: FROM_PREFIX,
        fromHeaderPrefixAppliedAsEvidence: true,
        dateFilter: null,
      },
      candidatePdfRecordCount: records.length,
      uniqueParentMessageCount: messageRows.size,
      fromHeaderEvidenceCounts: fromCounts,
      fileStatusCounts: fileCounts,
      storedPdfBytes,
      corpusBytes: (await stat(path.join(outputDir, 'corpus.jsonl'))).size,
    };
    await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(path.join(outputDir, 'manifest.json'), 0o600);
    process.stdout.write(`${JSON.stringify({ outputDir, candidatePdfRecordCount: records.length, uniqueParentMessageCount: messageRows.size, fromHeaderEvidenceCounts: fromCounts, fileStatusCounts: fileCounts, storedPdfBytes, corpusBytes: manifest.corpusBytes })}\n`);
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'Error';
    process.stderr.write(`${JSON.stringify({ event: 'centurion_confirmation_pdf_export.failed', error: name })}\n`);
    process.exitCode = 1;
  });
}
