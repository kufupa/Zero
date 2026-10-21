/**
 * One-shot promote `missing_owner_header` / `multi_transport` quarantine rows
 * into normal storage.
 *
 * Requires `INGEST_REQUIRE_OWNER_HEADER=false` in process env. Fetches raw MIME
 * from S3, parses, persists. The Penny ReserveCloud staff path keeps the
 * Centurion override, forced outbound, and in-transaction quarantine delete.
 * Every other row uses normal routing plus mailbox copies (`skipAiEnqueue`)
 * and deletes quarantine only after the primary and every copy succeed.
 */
import {
  candidateMessageIdForPop3Uidl,
  parseRawMessage,
  uploadedAttachmentsFromParseFailure,
  type ParsedInboundMessage,
} from './parse-message.js';
import { cleanupPartialParseFailureAttachments, persistInboundMessage } from './store.js';
import { completeFanoutAfterPrimary } from './fanout.js';
import { simpleParser, type AddressObject, type EmailAddress } from 'mailparser';
import { mailIngestQuarantine, message } from '../../db/schema/mail.js';
import { getS3Storage, type S3Storage } from '../../storage/s3.js';
import { ingestRequireOwnerHeader } from '../../env.js';
import type { DB } from '../../db/client.js';
import { and, asc, eq, inArray } from 'drizzle-orm';

export const PROMOTE_REASONS = ['missing_owner_header', 'multi_transport'] as const;
export type PromoteReason = (typeof PROMOTE_REASONS)[number];
const PROMOTE_REASON_SET: ReadonlySet<string> = new Set(PROMOTE_REASONS);
const RESERVE_CLOUD_PENNY_EMAIL = 'pmbobo@eu.mail.reservecloud.com';
const LEGACY_PENNY_EMAIL = 'pmbobo@legacyhotels.co.za';
export const CENTURION_TRANSPORT_ID = 'transport-centurion';
/** Explicit ingest mailbox ownership; never promote another mailbox into Centurion. */
export const CENTURION_INGEST_MAILBOX_IDS = ['ingest-nava-legacy'] as const;

export function isCenturionIngestMailboxId(ingestMailboxId: string): boolean {
  return (CENTURION_INGEST_MAILBOX_IDS as readonly string[]).includes(ingestMailboxId);
}

export interface PromoteQuarantineRow {
  id: string;
  ingestMailboxId: string;
  pop3Uidl: string;
  rawMimeS3Key: string;
}

export interface PromoteQuarantineOptions {
  db: DB;
  storage?: S3Storage;
  limit?: number;
  dryRun?: boolean;
  reason?: PromoteReason;
}

export interface PromoteQuarantineCounts {
  scanned: number;
  stored: number;
  duplicate: number;
  quarantined: number;
  errors: number;
  skipped?: number;
}

export interface PromoteQuarantineResult extends PromoteQuarantineCounts {
  errorIds: string[];
  dryRunIds: string[];
}

export class PromoteEnvError extends Error {
  constructor() {
    super('INGEST_REQUIRE_OWNER_HEADER must be false to promote quarantine rows');
    this.name = 'PromoteEnvError';
  }
}

export function assertPromoteEnv(input: Record<string, string | undefined> = process.env): void {
  if (ingestRequireOwnerHeader(input)) {
    throw new PromoteEnvError();
  }
}

export interface PromoteReserveCloudStaffSignals {
  fromAddress?: string | null;
  toAddresses?: readonly string[] | null;
  ccAddresses?: readonly string[] | null;
  bccAddresses?: readonly string[] | null;
}

/**
 * Narrow promotion predicate. Exact sender + at least one non-Legacy recipient
 * is required; empty and Penny-Legacy-only recipient sets fail closed.
 */
export function isPromotableReserveCloudStaff(parsed: PromoteReserveCloudStaffSignals): boolean {
  if (normalizePromotionAddress(parsed.fromAddress) !== RESERVE_CLOUD_PENNY_EMAIL) {
    return false;
  }

  const recipients = [
    ...(parsed.toAddresses ?? []),
    ...(parsed.ccAddresses ?? []),
    ...(parsed.bccAddresses ?? []),
  ]
    .map(normalizePromotionAddress)
    .filter(Boolean);
  return recipients.some((address) => address !== LEGACY_PENNY_EMAIL);
}

export async function listMissingOwnerHeaderQuarantine(
  db: DB,
  limit?: number,
  reasons: readonly PromoteReason[] = PROMOTE_REASONS,
): Promise<PromoteQuarantineRow[]> {
  const query = db
    .select({
      id: mailIngestQuarantine.id,
      ingestMailboxId: mailIngestQuarantine.ingestMailboxId,
      pop3Uidl: mailIngestQuarantine.pop3Uidl,
      rawMimeS3Key: mailIngestQuarantine.rawMimeS3Key,
    })
    .from(mailIngestQuarantine)
    .where(
      and(
        inArray(mailIngestQuarantine.reason, [...reasons]),
        inArray(mailIngestQuarantine.ingestMailboxId, [...CENTURION_INGEST_MAILBOX_IDS]),
      ),
    )
    .orderBy(asc(mailIngestQuarantine.createdAt));

  if (limit !== undefined) {
    return query.limit(limit);
  }
  return query;
}

export async function promoteMissingOwnerHeaderQuarantine(
  opts: PromoteQuarantineOptions,
): Promise<PromoteQuarantineResult> {
  assertPromoteEnv();

  const storage = opts.storage ?? getS3Storage();
  const reasons: readonly PromoteReason[] = opts.reason ? [opts.reason] : PROMOTE_REASONS;
  const rows = await listMissingOwnerHeaderQuarantine(opts.db, opts.limit, reasons);

  const result: PromoteQuarantineResult = {
    scanned: rows.length,
    stored: 0,
    duplicate: 0,
    quarantined: 0,
    errors: 0,
    skipped: 0,
    errorIds: [],
    dryRunIds: [],
  };

  for (const row of rows) {
    const outcome = await promoteOneQuarantineRow(row, {
      db: opts.db,
      storage,
      dryRun: opts.dryRun ?? false,
    });

    switch (outcome.kind) {
      case 'dry-run':
        result.dryRunIds.push(row.id);
        break;
      case 'skipped':
        result.skipped = (result.skipped ?? 0) + 1;
        break;
      case 'stored':
        result.stored += 1;
        break;
      case 'duplicate':
        result.duplicate += 1;
        break;
      case 'quarantined':
        result.quarantined += 1;
        break;
      case 'error':
        result.errors += 1;
        result.errorIds.push(row.id);
        break;
    }
  }

  return result;
}

type PromoteOneOutcome =
  | { kind: 'dry-run' }
  | { kind: 'skipped' }
  | { kind: 'stored' }
  | { kind: 'duplicate' }
  | { kind: 'quarantined' }
  | { kind: 'error'; message: string };

async function promoteOneQuarantineRow(
  row: PromoteQuarantineRow,
  opts: { db: DB; storage: S3Storage; dryRun: boolean },
): Promise<PromoteOneOutcome> {
  const { db, storage } = opts;
  if (!isCenturionIngestMailboxId(row.ingestMailboxId)) {
    return { kind: 'skipped' };
  }
  const meta = {
    ingestMailboxId: row.ingestMailboxId,
    pop3Uidl: row.pop3Uidl,
  };
  const messageId = candidateMessageIdForPop3Uidl(row.ingestMailboxId, row.pop3Uidl);
  let parsed: ParsedInboundMessage | undefined;

  try {
    const object = await storage.getObject(row.rawMimeS3Key);
    if (!object) {
      return { kind: 'error', message: `missing s3 object ${row.rawMimeS3Key}` };
    }

    // Dry-run and duplicate checks must not stream attachments to S3. The
    // convenience parser only inspects headers here; promotion parses again
    // through the streaming parser so existing attachment cleanup remains.
    const headerSignals = await parsePromotionSignals(object.body);
    if (isPromotableReserveCloudStaff(headerSignals)) {
      if (opts.dryRun) {
        return { kind: 'dry-run' };
      }

      const existing = await findExistingMessageAnyDirection(db, meta);
      if (existing) {
        await db.delete(mailIngestQuarantine).where(eq(mailIngestQuarantine.id, row.id));
        return { kind: 'duplicate' };
      }

      parsed = await parseRawMessage(object.body, {
        messageId,
        storage,
      });

      // Re-check parser output before persistence. This keeps the exact sender
      // and recipient gate attached to the bytes being promoted.
      if (!isPromotableReserveCloudStaff(parsed)) {
        if (parsed.attachments.length > 0) {
          await cleanupPartialParseFailureAttachments({
            db,
            storage,
            attachments: parsed.attachments,
            meta: {
              ...meta,
              messageId,
              rawMimeS3Key: row.rawMimeS3Key,
            },
          });
        }
        return { kind: 'skipped' };
      }

      const persistResult = await persistInboundMessage(
        parsed,
        object.body,
        {
          ...meta,
          messageId,
          rawMimeS3Key: row.rawMimeS3Key,
        },
        {
          db,
          storage,
          promoteQuarantineId: row.id,
          transportOverride: CENTURION_TRANSPORT_ID,
          directionOverride: 'outbound',
        },
      );

      if (persistResult.kind === 'stored') {
        return { kind: 'stored' };
      }
      if (persistResult.kind === 'duplicate') {
        await db.delete(mailIngestQuarantine).where(eq(mailIngestQuarantine.id, row.id));
        return { kind: 'duplicate' };
      }
      return { kind: 'quarantined' };
    }

    if (opts.dryRun) {
      return { kind: 'dry-run' };
    }

    parsed = await parseRawMessage(object.body, {
      messageId,
      storage,
    });

    const persistResult = await persistInboundMessage(
      parsed,
      object.body,
      {
        ...meta,
        messageId,
        rawMimeS3Key: row.rawMimeS3Key,
      },
      {
        db,
        storage,
        deferQuarantineDelete: true,
        skipAiEnqueue: true,
      },
    );

    if (persistResult.kind === 'quarantined') {
      return { kind: 'quarantined' };
    }
    if (
      persistResult.kind !== 'stored' &&
      persistResult.kind !== 'duplicate' &&
      persistResult.kind !== 'reconciled'
    ) {
      return { kind: 'error', message: persistResult.kind };
    }

    const copiesOk = await completeFanoutAfterPrimary({
      db,
      storage,
      raw: object.body,
      meta: {
        ...meta,
        messageId,
        rawMimeS3Key: persistResult.rawMimeS3Key,
      },
      persistResult,
      skipAiEnqueue: true,
    });
    if (!copiesOk) {
      return { kind: 'error', message: 'fanout_copy_failed' };
    }

    await db.delete(mailIngestQuarantine).where(eq(mailIngestQuarantine.id, row.id));
    return persistResult.kind === 'duplicate' ? { kind: 'duplicate' } : { kind: 'stored' };
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
            ...meta,
            messageId,
            rawMimeS3Key: row.rawMimeS3Key,
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

async function findExistingMessageAnyDirection(
  db: DB,
  meta: Pick<PromoteQuarantineRow, 'ingestMailboxId' | 'pop3Uidl'>,
): Promise<{ id: string; transportId: string } | undefined> {
  const rows = await db
    .select({ id: message.id, transportId: message.transportId })
    .from(message)
    .where(
      and(eq(message.ingestMailboxId, meta.ingestMailboxId), eq(message.pop3Uidl, meta.pop3Uidl)),
    )
    .limit(1);
  return rows[0];
}

export interface PromoteCliArgs {
  dryRun: boolean;
  apply: boolean;
  limit?: number;
  reason?: PromoteReason;
}

/** Script default: dry-run unless `--apply`. Recover keeps using `dryRun` only. */
export function promoteCliIsDryRun(cli: PromoteCliArgs): boolean {
  return !cli.apply;
}

export function parsePromoteCliArgs(argv: string[]): PromoteCliArgs {
  let dryRun = false;
  let apply = false;
  let limit: number | undefined;
  let reason: PromoteReason | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--apply') {
      apply = true;
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
    if (arg === '--reason') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--reason requires missing_owner_header or multi_transport');
      }
      reason = parsePromoteReason(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--reason=')) {
      reason = parsePromoteReason(arg.slice('--reason='.length));
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (apply && dryRun) {
    throw new Error('--apply and --dry-run cannot be combined');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit requires a positive integer');
  }

  return { dryRun, apply, limit, reason };
}

function parsePromoteReason(value: string): PromoteReason {
  if (!PROMOTE_REASON_SET.has(value)) {
    throw new Error('--reason requires missing_owner_header or multi_transport');
  }
  return value as PromoteReason;
}

export function formatPromoteSummary(result: PromoteQuarantineResult): string {
  const parts = [
    `scanned=${result.scanned}`,
    `stored=${result.stored}`,
    `duplicate=${result.duplicate}`,
    `quarantined=${result.quarantined}`,
    `errors=${result.errors}`,
  ];
  if (result.skipped !== undefined) {
    parts.push(`skipped=${result.skipped}`);
  }
  if (result.dryRunIds.length > 0) {
    parts.push(`dry_run_ids=${result.dryRunIds.join(',')}`);
  }
  if (result.errorIds.length > 0) {
    parts.push(`error_ids=${result.errorIds.join(',')}`);
  }
  return parts.join(' ');
}

function normalizePromotionAddress(raw: string | null | undefined): string {
  const value = (raw ?? '').trim().toLowerCase();
  return value.match(/<([^>]+)>/)?.[1]?.trim() ?? value;
}

async function parsePromotionSignals(raw: Buffer): Promise<PromoteReserveCloudStaffSignals> {
  const parsed = await simpleParser(raw, { skipHtmlToText: true });
  return {
    fromAddress: parsed.from?.value[0]?.address ?? null,
    toAddresses: addressValues(parsed.to),
    ccAddresses: addressValues(parsed.cc),
    bccAddresses: addressValues(parsed.bcc),
  };
}

function addressValues(value: AddressObject | AddressObject[] | undefined): string[] {
  const objects = value ? (Array.isArray(value) ? value : [value]) : [];
  return objects.flatMap((object) => object.value.flatMap(flattenEmailAddress));
}

function flattenEmailAddress(value: EmailAddress): string[] {
  if (value.address) return [value.address];
  return value.group?.flatMap(flattenEmailAddress) ?? [];
}
