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
import {
  cleanupPartialParseFailureAttachments,
  claimIngestUidl,
  hasPendingCandidateAttachmentCleanup,
  persistInboundMessage,
  releaseIngestUidlClaim,
} from './store.js';
import { completeFanoutAfterPrimary } from './fanout.js';
import { simpleParser, type AddressObject, type EmailAddress } from 'mailparser';
import { mailIngestQuarantine, mailboxTransport, message } from '../../db/schema/mail.js';
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
  /** Owner mailbox emails; skip rows whose resolved owners include none of these. */
  mailboxes?: readonly string[];
}

export interface PromoteQuarantineCounts {
  scanned: number;
  stored: number;
  duplicate: number;
  quarantined: number;
  errors: number;
  skipped?: number;
  skippedMailboxFilter?: number;
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
  const mailboxFilter = uniqueNormalizedMailboxes(opts.mailboxes);
  // Limit applies to matching rows after the mailbox filter, so SQL cannot
  // cap the scan when a filter is set.
  const rows = await listMissingOwnerHeaderQuarantine(
    opts.db,
    mailboxFilter.length > 0 ? undefined : opts.limit,
    reasons,
  );

  const result: PromoteQuarantineResult = {
    scanned: 0,
    stored: 0,
    duplicate: 0,
    quarantined: 0,
    errors: 0,
    skipped: 0,
    skippedMailboxFilter: 0,
    errorIds: [],
    dryRunIds: [],
  };

  let matching = 0;
  for (const row of rows) {
    if (mailboxFilter.length > 0 && opts.limit !== undefined && matching >= opts.limit) {
      break;
    }
    const outcome = await promoteOneQuarantineRow(row, {
      db: opts.db,
      storage,
      dryRun: opts.dryRun ?? false,
      mailboxes: mailboxFilter,
    });
    result.scanned += 1;

    switch (outcome.kind) {
      case 'skipped_mailbox_filter':
        result.skippedMailboxFilter = (result.skippedMailboxFilter ?? 0) + 1;
        break;
      case 'dry-run':
        matching += 1;
        result.dryRunIds.push(row.id);
        break;
      case 'skipped':
        matching += 1;
        result.skipped = (result.skipped ?? 0) + 1;
        break;
      case 'stored':
        matching += 1;
        result.stored += 1;
        break;
      case 'duplicate':
        matching += 1;
        result.duplicate += 1;
        break;
      case 'quarantined':
        matching += 1;
        result.quarantined += 1;
        break;
      case 'error':
        matching += 1;
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
  | { kind: 'skipped_mailbox_filter' }
  | { kind: 'stored' }
  | { kind: 'duplicate' }
  | { kind: 'quarantined' }
  | { kind: 'error'; message: string };

async function promoteOneQuarantineRow(
  row: PromoteQuarantineRow,
  opts: { db: DB; storage: S3Storage; dryRun: boolean; mailboxes: readonly string[] },
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
  let claimToken: string | null = null;

  try {
    const object = await storage.getObject(row.rawMimeS3Key);
    if (!object) {
      return { kind: 'error', message: `missing s3 object ${row.rawMimeS3Key}` };
    }

    // Dry-run and duplicate checks must not stream attachments to S3. The
    // convenience parser only inspects headers here; promotion parses again
    // through the streaming parser so existing attachment cleanup remains.
    const headerSignals = await parsePromotionSignals(object.body);
    const penny = isPromotableReserveCloudStaff(headerSignals);
    if (opts.mailboxes.length > 0) {
      const owners = await resolveOwnerTransports(db, headerSignals, penny);
      if (!ownerTransportsIncludeMailbox(owners, opts.mailboxes)) {
        return { kind: 'skipped_mailbox_filter' };
      }
    }
    if (penny) {
      if (opts.dryRun) {
        return { kind: 'dry-run' };
      }

      const existing = await findExistingMessageAnyDirection(db, meta);
      if (existing) {
        await db.delete(mailIngestQuarantine).where(eq(mailIngestQuarantine.id, row.id));
        return { kind: 'duplicate' };
      }
    } else if (opts.dryRun) {
      return { kind: 'dry-run' };
    }

    if (await hasPendingCandidateAttachmentCleanup(db, meta)) {
      return { kind: 'error', message: 'candidate_attachment_cleanup_pending' };
    }
    try {
      claimToken = await claimIngestUidl(db, meta);
    } catch {
      return { kind: 'error', message: 'ingest_uidl_claim_pending' };
    }
    if (!claimToken) {
      return { kind: 'error', message: 'ingest_uidl_claim_pending' };
    }
    const heldClaimToken = claimToken;
    if (await hasPendingCandidateAttachmentCleanup(db, meta)) {
      return { kind: 'error', message: 'candidate_attachment_cleanup_pending' };
    }

    parsed = await parseRawMessage(object.body, {
      messageId,
      storage,
    });

    if (penny) {
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
            activeIngestUidlClaimToken: heldClaimToken,
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
          activeIngestUidlClaimToken: heldClaimToken,
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
        activeIngestUidlClaimToken: heldClaimToken,
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
          ...(claimToken ? { activeIngestUidlClaimToken: claimToken } : {}),
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
  } finally {
    if (claimToken) {
      await releaseIngestUidlClaim(db, meta, claimToken).catch(() => undefined);
    }
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
  mailboxes: string[];
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
  const mailboxes: string[] = [];

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
    if (arg === '--mailbox') {
      const next = argv[i + 1];
      mailboxes.push(parseMailboxFlag(next));
      i += 1;
      continue;
    }
    if (arg.startsWith('--mailbox=')) {
      mailboxes.push(parseMailboxFlag(arg.slice('--mailbox='.length)));
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

  return { dryRun, apply, limit, reason, mailboxes };
}

function parsePromoteReason(value: string): PromoteReason {
  if (!PROMOTE_REASON_SET.has(value)) {
    throw new Error('--reason requires missing_owner_header or multi_transport');
  }
  return value as PromoteReason;
}

function parseMailboxFlag(value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error('--mailbox requires an email address');
  }
  const mailbox = normalizePromotionAddress(value);
  if (!mailbox) {
    throw new Error('--mailbox requires an email address');
  }
  return mailbox;
}

function uniqueNormalizedMailboxes(mailboxes: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (mailboxes ?? []).map(normalizePromotionAddress).filter((value) => value.length > 0),
    ),
  ];
}

type OwnerTransport = { email: string; sendFromConfig: unknown };

async function resolveOwnerTransports(
  db: DB,
  signals: PromoteReserveCloudStaffSignals,
  penny: boolean,
): Promise<OwnerTransport[]> {
  if (penny) {
    const rows = await db
      .select({
        email: mailboxTransport.email,
        sendFromConfig: mailboxTransport.sendFromConfig,
      })
      .from(mailboxTransport)
      .where(
        and(eq(mailboxTransport.id, CENTURION_TRANSPORT_ID), eq(mailboxTransport.isActive, true)),
      )
      .limit(1);
    return rows;
  }

  const rows = await db
    .select({
      email: mailboxTransport.email,
      sendFromConfig: mailboxTransport.sendFromConfig,
    })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.isActive, true));

  const addresses = [
    signals.fromAddress,
    ...(signals.toAddresses ?? []),
    ...(signals.ccAddresses ?? []),
    ...(signals.bccAddresses ?? []),
  ]
    .map(normalizePromotionAddress)
    .filter(Boolean);

  const owners = new Map<string, OwnerTransport>();
  for (const address of addresses) {
    const matching = rows.filter((row) =>
      transportIdentities(row.email, row.sendFromConfig).has(address),
    );
    if (matching.length !== 1) continue;
    const owner = matching[0]!;
    owners.set(owner.email, owner);
  }
  return [...owners.values()];
}

function ownerTransportsIncludeMailbox(
  owners: readonly OwnerTransport[],
  mailboxes: readonly string[],
): boolean {
  const wanted = new Set(mailboxes.map(normalizePromotionAddress).filter(Boolean));
  for (const owner of owners) {
    const identities = transportIdentities(owner.email, owner.sendFromConfig);
    for (const mailbox of wanted) {
      if (identities.has(mailbox)) return true;
    }
  }
  return false;
}

function transportIdentities(email: string, sendFromConfig: unknown): Set<string> {
  const identities = new Set<string>();
  const normalizedEmail = normalizePromotionAddress(email);
  if (normalizedEmail) identities.add(normalizedEmail);
  if (!sendFromConfig || typeof sendFromConfig !== 'object') return identities;
  const aliases = (sendFromConfig as { aliases?: unknown }).aliases;
  if (!Array.isArray(aliases)) return identities;
  for (const alias of aliases) {
    if (typeof alias !== 'string') continue;
    const normalized = normalizePromotionAddress(alias);
    if (normalized) identities.add(normalized);
  }
  return identities;
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
  if (result.skippedMailboxFilter !== undefined) {
    parts.push(`skipped_mailbox_filter=${result.skippedMailboxFilter}`);
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
