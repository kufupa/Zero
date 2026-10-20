/**
 * Rehydrate wiped message rows from S3 `raw-mime/{ingestMailboxId}/*.eml`.
 *
 * Requires `INGEST_REQUIRE_OWNER_HEADER=false`. Skips keys already in
 * quarantine. Existing message keys re-run persist (duplicate) plus mailbox
 * copies so a failed copy can retry. Default skips AI enqueue.
 */
import {
  candidateMessageIdForPop3Uidl,
  parseRawMessage,
  uploadedAttachmentsFromParseFailure,
  type ParsedInboundMessage,
} from './parse-message.js';
import {
  ListObjectsV2Command,
  S3Client,
  type ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';
import { cleanupPartialParseFailureAttachments, persistInboundMessage } from './store.js';
import { completeFanoutAfterPrimary } from './fanout.js';
import { mailIngestQuarantine } from '../../db/schema/mail.js';
import { getS3Storage, type S3Storage } from '../../storage/s3.js';
import { ingestRequireOwnerHeader } from '../../env.js';
import type { DB } from '../../db/client.js';

const DEFAULT_PREFIX = 'raw-mime/ingest-nava-legacy/';

export interface RawMimeObjectRef {
  key: string;
  ingestMailboxId: string;
  /** Filename stem — sanitized UIDL used when original UIDL unknown. */
  pop3Uidl: string;
}

export interface RehydrateOptions {
  db: DB;
  storage?: S3Storage;
  /** S3 key prefix (trailing slash optional). Default: ingest-nava-legacy. */
  prefix?: string;
  limit?: number;
  dryRun?: boolean;
  /** When true, enqueue inbound_triage on store. Default false. */
  triage?: boolean;
  /** Override list (tests). */
  keys?: RawMimeObjectRef[];
}

export interface RehydrateCounts {
  scanned: number;
  skippedExisting: number;
  skippedQuarantine: number;
  stored: number;
  duplicate: number;
  quarantined: number;
  errors: number;
}

export interface RehydrateResult extends RehydrateCounts {
  errorKeys: string[];
  dryRunKeys: string[];
}

export class RehydrateEnvError extends Error {
  constructor() {
    super('INGEST_REQUIRE_OWNER_HEADER must be false to rehydrate raw MIME into mailbox rows');
    this.name = 'RehydrateEnvError';
  }
}

export function assertRehydrateEnv(input: Record<string, string | undefined> = process.env): void {
  if (ingestRequireOwnerHeader(input)) {
    throw new RehydrateEnvError();
  }
}

/** Parse `raw-mime/{ingestMailboxId}/{uidl}.eml` → ref, or null. */
export function parseRawMimeKey(key: string): RawMimeObjectRef | null {
  const match = /^raw-mime\/([^/]+)\/(.+)\.eml$/i.exec(key);
  if (!match) return null;
  const ingestMailboxId = match[1]!;
  const pop3Uidl = match[2]!;
  if (!ingestMailboxId || !pop3Uidl) return null;
  return { key, ingestMailboxId, pop3Uidl };
}

export async function listRawMimeKeys(opts: {
  prefix?: string;
  region?: string;
  bucket?: string;
}): Promise<RawMimeObjectRef[]> {
  const prefix = normalizePrefix(opts.prefix ?? DEFAULT_PREFIX);
  const region = opts.region ?? process.env.AWS_REGION;
  const bucket = opts.bucket ?? process.env.S3_BUCKET;
  if (!region || !bucket) {
    throw new Error('AWS_REGION and S3_BUCKET required to list raw-mime keys');
  }

  const client = new S3Client({ region });
  const refs: RawMimeObjectRef[] = [];
  let token: string | undefined;

  do {
    const page: ListObjectsV2CommandOutput = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const obj of page.Contents ?? []) {
      if (!obj.Key || !obj.Key.endsWith('.eml')) continue;
      const parsed = parseRawMimeKey(obj.Key);
      if (parsed) refs.push(parsed);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  return refs.sort((a, b) => a.key.localeCompare(b.key));
}

export async function rehydrateRawMimeFromS3(opts: RehydrateOptions): Promise<RehydrateResult> {
  assertRehydrateEnv();

  const storage = opts.storage ?? getS3Storage();
  const allKeys =
    opts.keys ??
    (await listRawMimeKeys({
      prefix: opts.prefix ?? DEFAULT_PREFIX,
    }));
  const keys = opts.limit !== undefined ? allKeys.slice(0, opts.limit) : allKeys;

  const processedKeys = new Set<string>();
  const quarantineKeys = await loadQuarantineKeys(opts.db);

  const result: RehydrateResult = {
    scanned: keys.length,
    skippedExisting: 0,
    skippedQuarantine: 0,
    stored: 0,
    duplicate: 0,
    quarantined: 0,
    errors: 0,
    errorKeys: [],
    dryRunKeys: [],
  };

  for (const ref of keys) {
    if (processedKeys.has(ref.key)) {
      result.skippedExisting += 1;
      continue;
    }
    if (quarantineKeys.has(ref.key)) {
      result.skippedQuarantine += 1;
      continue;
    }

    if (opts.dryRun) {
      result.dryRunKeys.push(ref.key);
      continue;
    }

    const outcome = await rehydrateOne(ref, {
      db: opts.db,
      storage,
      triage: opts.triage === true,
    });

    switch (outcome.kind) {
      case 'stored':
        result.stored += 1;
        processedKeys.add(ref.key);
        break;
      case 'duplicate':
        result.duplicate += 1;
        processedKeys.add(ref.key);
        break;
      case 'quarantined':
        result.quarantined += 1;
        quarantineKeys.add(ref.key);
        break;
      case 'error':
        result.errors += 1;
        result.errorKeys.push(ref.key);
        break;
    }
  }

  return result;
}

async function loadQuarantineKeys(db: DB): Promise<Set<string>> {
  const rows = await db
    .select({ key: mailIngestQuarantine.rawMimeS3Key })
    .from(mailIngestQuarantine);
  return new Set(rows.map((row) => row.key));
}

type OneOutcome =
  | { kind: 'stored' }
  | { kind: 'duplicate' }
  | { kind: 'quarantined' }
  | { kind: 'error'; message: string };

async function rehydrateOne(
  ref: RawMimeObjectRef,
  opts: { db: DB; storage: S3Storage; triage: boolean },
): Promise<OneOutcome> {
  const { db, storage } = opts;
  const messageId = candidateMessageIdForPop3Uidl(ref.ingestMailboxId, ref.pop3Uidl);
  let parsed: ParsedInboundMessage | undefined;
  try {
    const object = await storage.getObject(ref.key);
    if (!object) {
      return { kind: 'error', message: `missing s3 object ${ref.key}` };
    }

    parsed = await parseRawMessage(object.body, {
      messageId,
      storage,
    });

    const persistMeta = {
      ingestMailboxId: ref.ingestMailboxId,
      pop3Uidl: ref.pop3Uidl,
      messageId,
      rawMimeS3Key: ref.key,
    };
    const persistResult = await persistInboundMessage(parsed, object.body, persistMeta, {
      db,
      storage,
      skipAiEnqueue: !opts.triage,
    });

    if (
      persistResult.kind === 'stored' ||
      persistResult.kind === 'duplicate' ||
      persistResult.kind === 'reconciled'
    ) {
      const copiesOk = await completeFanoutAfterPrimary({
        db,
        storage,
        raw: object.body,
        meta: persistMeta,
        persistResult,
        skipAiEnqueue: !opts.triage,
      });
      if (!copiesOk) {
        return { kind: 'error', message: 'fanout_copy_pending' };
      }
      return persistResult.kind === 'duplicate' ? { kind: 'duplicate' } : { kind: 'stored' };
    }
    return { kind: 'quarantined' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const uploadedAttachments = [
      ...new Map(
        [...(parsed?.attachments ?? []), ...uploadedAttachmentsFromParseFailure(err)].map(
          (attachment) => [attachment.s3Key, attachment],
        ),
      ).values(),
    ];
    if (uploadedAttachments.length > 0) {
      try {
        await cleanupPartialParseFailureAttachments({
          db,
          storage,
          attachments: uploadedAttachments,
          meta: {
            ingestMailboxId: ref.ingestMailboxId,
            pop3Uidl: ref.pop3Uidl,
            messageId,
            rawMimeS3Key: ref.key,
          },
        });
      } catch (cleanupError) {
        const cleanupMessage =
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        return {
          kind: 'error',
          message: `${message}; candidate attachment cleanup registration failed: ${cleanupMessage}`,
        };
      }
    }
    return { kind: 'error', message };
  }
}

function normalizePrefix(prefix: string): string {
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

export interface RehydrateCliArgs {
  dryRun: boolean;
  triage: boolean;
  limit?: number;
  prefix?: string;
}

export function parseRehydrateCliArgs(argv: string[]): RehydrateCliArgs {
  let dryRun = false;
  let triage = false;
  let limit: number | undefined;
  let prefix: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--triage') {
      triage = true;
      continue;
    }
    if (arg === '--limit') {
      const next = argv[i + 1];
      if (!next || Number.isNaN(Number(next))) {
        throw new Error('--limit requires a positive integer');
      }
      limit = Number(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const value = arg.slice('--limit='.length);
      if (!value || Number.isNaN(Number(value))) {
        throw new Error('--limit requires a positive integer');
      }
      limit = Number(value);
      continue;
    }
    if (arg === '--prefix') {
      const next = argv[i + 1];
      if (!next) throw new Error('--prefix requires a value');
      prefix = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--prefix=')) {
      prefix = arg.slice('--prefix='.length);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit requires a positive integer');
  }

  return { dryRun, triage, limit, prefix };
}

export function formatRehydrateSummary(result: RehydrateResult): string {
  const parts = [
    `scanned=${result.scanned}`,
    `skipped_existing=${result.skippedExisting}`,
    `skipped_quarantine=${result.skippedQuarantine}`,
    `stored=${result.stored}`,
    `duplicate=${result.duplicate}`,
    `quarantined=${result.quarantined}`,
    `errors=${result.errors}`,
  ];
  if (result.dryRunKeys.length > 0) {
    parts.push(`dry_run_count=${result.dryRunKeys.length}`);
  }
  if (result.errorKeys.length > 0) {
    parts.push(`error_keys=${result.errorKeys.slice(0, 10).join(',')}`);
  }
  return parts.join(' ');
}
