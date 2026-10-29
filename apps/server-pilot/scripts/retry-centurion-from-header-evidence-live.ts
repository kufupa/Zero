import { createHash } from 'node:crypto';
import { chmod, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { simpleParser } from 'mailparser';
import { getPostgresSslOptions } from '../src/db/ssl-config.js';
import { RealS3Storage } from '../src/storage/s3.js';

const APPROVED_INSTANCE_ID = 'i-008f737974a9ba9b3';
const MAX_HEADER_BYTES = 64 * 1024;
const FILENAME_PATTERN = '^HRCEN_Confirmation_Letter_.*[.]pdf$';
const FROM_PREFIX = 'Centurion at';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
type JsonRecord = Record<string, unknown>;
type RetryStatus = 'match' | 'no_match' | 'not_stored' | 'missing' | 'unreadable' | 'read_failed';
type RetryRecord = { messageDbId: string; status: RetryStatus; headerSha256?: string };
type MessageLocator = { messageDbId: string; rawMimeKey: string | null };

function argument(name: string): string | null {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sha256(value: Uint8Array | string): string {
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

export async function readFromHeader(
  storage: RealS3Storage,
  key: string | null,
  messageDbId: string,
): Promise<RetryRecord> {
  if (!key) return { messageDbId, status: 'not_stored' };
  try {
    const response = await storage.client.send(
      new GetObjectCommand({
        Bucket: storage.bucket,
        Key: key,
        Range: `bytes=0-${MAX_HEADER_BYTES - 1}`,
      }),
    );
    if (!response.Body) return { messageDbId, status: 'missing' };
    const bytes = Buffer.from(await response.Body.transformToByteArray());
    const crlf = bytes.indexOf('\r\n\r\n');
    const lf = bytes.indexOf('\n\n');
    const separator = crlf < 0 ? lf : lf < 0 ? crlf : Math.min(crlf, lf);
    if (separator < 0) return { messageDbId, status: 'unreadable' };
    const header = bytes.subarray(0, separator + (separator === crlf ? 4 : 2));
    const parsed = await simpleParser(header, { skipHtml: true, skipText: true });
    const displayName = parsed.from?.value?.[0]?.name ?? '';
    return {
      messageDbId,
      status: displayName.startsWith(FROM_PREFIX) ? 'match' : 'no_match',
      headerSha256: sha256(header),
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return {
      messageDbId,
      status: name === 'NoSuchKey' || name === 'NotFound' ? 'missing' : 'read_failed',
    };
  }
}

async function mapWithConcurrency<T, R>(
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

export async function privateOutputParent(privateRoot: string, resolvedOutput: string): Promise<string> {
  if (!resolvedOutput.startsWith(`${privateRoot}${path.sep}`)) throw new Error('output_path_invalid');
  const [realPrivateRoot, realOutputParent] = await Promise.all([
    realpath(privateRoot), realpath(path.dirname(resolvedOutput)),
  ]);
  if (realOutputParent !== realPrivateRoot && !realOutputParent.startsWith(`${realPrivateRoot}${path.sep}`)) {
    throw new Error('output_path_invalid');
  }
  return realOutputParent;
}

async function main(): Promise<void> {
  await attestApprovedInstance();
  const privateRoot = path.join(repoRoot, '.private');
  const databaseUrl = process.env.DATABASE_URL;
  const region = process.env.AWS_REGION;
  const bucket = process.env.S3_BUCKET;
  const sourceAttachments = argument('--source-attachments');
  const outputPath = argument('--output-file');
  if (!databaseUrl || !region || !bucket || !sourceAttachments || !outputPath) {
    throw new Error('configuration_missing');
  }
  const resolvedOutput = path.resolve(outputPath);
  const realOutputParent = await privateOutputParent(privateRoot, resolvedOutput);
  if (!(await stat(sourceAttachments)).isFile()) throw new Error('source_file_missing');

  const retryMessageIds = new Set<string>();
  for (const line of (await readFile(sourceAttachments, 'utf8')).split('\n').filter(Boolean)) {
    const row = asRecord(JSON.parse(line));
    const evidence = asRecord(row.fromHeaderEvidence);
    const parent = asRecord(row.parentMessage);
    const messageDbId = asString(parent.messageDbId);
    if (evidence.status === 'missing' && messageDbId) retryMessageIds.add(messageDbId);
  }
  const messageDbIds = [...retryMessageIds].sort();
  if (messageDbIds.length === 0) throw new Error('no_missing_header_candidates');

  const database = postgres(databaseUrl, { max: 1, ssl: getPostgresSslOptions(databaseUrl) });
  const storage = new RealS3Storage(region, bucket);
  try {
    const locators = await database.begin(async (readOnlyDatabase) => {
      await readOnlyDatabase`SET TRANSACTION READ ONLY`;
      await readOnlyDatabase`SET LOCAL statement_timeout = '30s'`;
      return await readOnlyDatabase<MessageLocator[]>`
        SELECT m.id AS "messageDbId", m.raw_mime_s3_key AS "rawMimeKey"
        FROM message AS m
        WHERE m.id::text = ANY(${messageDbIds})
          AND m.transport_id = 'transport-centurion'
          AND m.direction::text = 'outbound'
          AND EXISTS (
            SELECT 1 FROM attachment AS a
            WHERE a.message_id = m.id
              AND COALESCE(a.filename, '') ~ ${FILENAME_PATTERN}
          )
      `;
    });
    const locatorById = new Map(locators.map((row) => [row.messageDbId, row.rawMimeKey]));
    const evidence = await mapWithConcurrency(messageDbIds, 4, async (messageDbId) => {
      if (!locatorById.has(messageDbId)) return { messageDbId, status: 'read_failed' as const };
      return await readFromHeader(storage, locatorById.get(messageDbId) ?? null, messageDbId);
    });

    await chmod(realOutputParent, 0o700);
    await writeFile(
      resolvedOutput,
      `${evidence.map((row) => JSON.stringify(row)).join('\n')}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await chmod(resolvedOutput, 0o600);
    const statusCounts: Record<string, number> = {};
    for (const row of evidence) statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    process.stdout.write(`${JSON.stringify({ retryTargets: messageDbIds.length, dbRows: locators.length, statusCounts, outputFile: resolvedOutput })}\n`);
  } finally {
    await database.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'Error';
    process.stderr.write(`${JSON.stringify({ event: 'centurion_from_header_retry.failed', error: name })}\n`);
    process.exitCode = 1;
  });
}
