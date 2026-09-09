/**
 * Outbound undo/schedule queue (`UNDO_SEND_SECONDS`).
 *
 * Claim: pending + sendAt<=now, or stale `sending` before SMTP begins / after
 * exact SMTP outcome persists. A started SMTP attempt without an outcome is
 * intentionally not retried automatically because standard SMTP is not
 * provider-idempotent.
 */
import { getSmtpTransport, type OutboundMailPayload, type SmtpSendResult } from './smtp.js';
import { persistMailBaselineProjection } from '../../metrics/mail-baseline-projection.js';
import { MAIL_BASELINE_INTERPRETATION_VERSION } from '../../metrics/mail-baseline.js';
import { extractMailBaselineEvidence } from '../../ai/mail-baseline-extraction.js';
import { and, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { message, outboundSendQueue } from '../../db/schema/mail.js';
import { mailBaselineGenerationKey } from '../../ai/run-ledger.js';
import { maybeEnqueueLoopback } from '../fixture-loopback.js';
import { getDb, type DB } from '../../db/client.js';
import { randomUUID } from 'node:crypto';

/** Stale `sending` rows older than this are reclaimable. */
export const RECLAIM_SENDING_AFTER_MS = 5 * 60 * 1000;

export type QueuedSmtpAttachment = {
  filename: string;
  contentBase64: string;
  contentType?: string;
};

/** JSON-safe snapshot stored in `smtp_payload` (attachments as base64). */
export type QueuedSmtpPayload = {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  inReplyTo?: string | null;
  references?: string[];
  extraHeaders?: Record<string, string>;
  attachments?: QueuedSmtpAttachment[];
  deliveryOutcome?: SmtpDeliveryOutcome;
};

/** Exact SMTP evidence retained after SMTP accepts at least one recipient. */
export type SmtpDeliveryOutcome = {
  messageId: string;
  accepted: string[];
  rejected: string[];
};

export type SmtpDeliveryStatus = 'full' | 'partial';

export type LegacyHeaderOnlyDelivery = {
  messageId: string;
  deliveryEvidence: 'legacy-header-only';
};

export type OutboundDeliveryResult = SmtpSendResult | LegacyHeaderOnlyDelivery;

type QueueRow = typeof outboundSendQueue.$inferSelect;
type ClaimedQueueRow = QueueRow & { claimedAt: Date };

class OutboundClaimLostError extends Error {
  constructor() {
    super('outbound queue claim lost');
    this.name = 'OutboundClaimLostError';
  }
}

export class OutboundDeliveryUncertainError extends Error {
  constructor() {
    super('SMTP delivery outcome is unknown');
    this.name = 'OutboundDeliveryUncertainError';
  }
}

export function getUndoSendSeconds(): number {
  const n = Number(process.env.UNDO_SEND_SECONDS ?? '20');
  return Number.isFinite(n) && n >= 0 ? n : 20;
}

export function serializeSmtpPayload(payload: OutboundMailPayload): QueuedSmtpPayload {
  return {
    from: payload.from,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    inReplyTo: payload.inReplyTo,
    references: payload.references,
    extraHeaders: payload.extraHeaders,
    attachments: payload.attachments?.map((a) => ({
      filename: a.filename,
      contentBase64: Buffer.isBuffer(a.content)
        ? a.content.toString('base64')
        : Buffer.from(String(a.content)).toString('base64'),
      contentType: a.contentType,
    })),
  };
}

export function deserializeSmtpPayload(raw: QueuedSmtpPayload): OutboundMailPayload {
  return {
    from: raw.from,
    to: raw.to,
    cc: raw.cc,
    bcc: raw.bcc,
    subject: raw.subject,
    html: raw.html,
    text: raw.text,
    inReplyTo: raw.inReplyTo,
    references: raw.references,
    extraHeaders: raw.extraHeaders,
    attachments: raw.attachments?.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.contentBase64, 'base64'),
      contentType: a.contentType,
    })),
  };
}

function requireRecord(raw: unknown, error: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(error);
  }
  return raw as Record<string, unknown>;
}

function cloneDeliveryOutcome(outcome: SmtpDeliveryOutcome): SmtpSendResult {
  return {
    messageId: outcome.messageId,
    accepted: [...outcome.accepted],
    rejected: [...outcome.rejected],
  };
}

export function parsePersistedDeliveryOutcome(rawPayload: unknown): SmtpDeliveryOutcome | null {
  const payload = requireRecord(rawPayload, 'outbound SMTP payload malformed');
  if (!Object.hasOwn(payload, 'deliveryOutcome')) return null;

  const outcome = requireRecord(payload.deliveryOutcome, 'outbound delivery outcome malformed');
  if (
    typeof outcome.messageId !== 'string' ||
    outcome.messageId.length === 0 ||
    !Array.isArray(outcome.accepted) ||
    outcome.accepted.length === 0 ||
    !Array.isArray(outcome.rejected) ||
    !outcome.accepted.every((recipient) => typeof recipient === 'string') ||
    !outcome.rejected.every((recipient) => typeof recipient === 'string')
  ) {
    throw new Error('outbound delivery outcome malformed');
  }

  return {
    messageId: outcome.messageId,
    accepted: [...outcome.accepted],
    rejected: [...outcome.rejected],
  };
}

function validateSmtpOutcome(result: SmtpSendResult): SmtpDeliveryOutcome {
  if (
    typeof result.messageId !== 'string' ||
    result.messageId.length === 0 ||
    !Array.isArray(result.accepted) ||
    !Array.isArray(result.rejected) ||
    !result.accepted.every((recipient) => typeof recipient === 'string') ||
    !result.rejected.every((recipient) => typeof recipient === 'string')
  ) {
    throw new Error('SMTP result malformed');
  }

  return {
    messageId: result.messageId,
    accepted: [...result.accepted],
    rejected: [...result.rejected],
  };
}

function missingRequestedRecipientCount(
  payload: OutboundMailPayload,
  outcome: SmtpDeliveryOutcome,
): number {
  const requested = new Set(
    [...payload.to, ...payload.cc, ...payload.bcc].map((recipient) =>
      recipient.trim().toLowerCase(),
    ),
  );
  const accepted = new Set(outcome.accepted.map((recipient) => recipient.trim().toLowerCase()));
  const missingCount = [...requested].filter((recipient) => !accepted.has(recipient)).length;
  return missingCount;
}

export function getSmtpDeliveryStatus(
  payload: OutboundMailPayload,
  outcome: SmtpDeliveryOutcome,
): SmtpDeliveryStatus {
  return outcome.rejected.length > 0 || missingRequestedRecipientCount(payload, outcome) > 0
    ? 'partial'
    : 'full';
}

function partialDeliveryWarning(
  payload: OutboundMailPayload,
  outcome: SmtpDeliveryOutcome,
): string | null {
  const missingRecipients = missingRequestedRecipientCount(payload, outcome);
  if (getSmtpDeliveryStatus(payload, outcome) === 'full') return null;
  return JSON.stringify({
    code: 'PARTIAL_REJECTION',
    acceptedCount: outcome.accepted.length,
    rejectedCount: outcome.rejected.length,
    missingRequestedRecipientCount: missingRecipients,
  });
}

/** Pure claim eligibility — used by unit tests + claimDue. */
export function isOutboundClaimable(
  row: {
    status: string;
    sendAt: Date;
    claimedAt: Date | null;
    smtpAttemptedAt?: Date | null;
    smtpOutcomePersistedAt?: Date | null;
  },
  now: Date = new Date(),
  reclaimAfterMs: number = RECLAIM_SENDING_AFTER_MS,
): boolean {
  if (row.status === 'pending' && row.sendAt.getTime() <= now.getTime()) return true;
  if (
    row.status === 'sending' &&
    row.claimedAt != null &&
    now.getTime() - row.claimedAt.getTime() >= reclaimAfterMs &&
    (!row.smtpAttemptedAt || Boolean(row.smtpOutcomePersistedAt))
  ) {
    return true;
  }
  return false;
}

/** True if outbound message already has an SMTP Message-ID. */
export function hasPersistedSmtpDelivery(messageIdHeader: string | null | undefined): boolean {
  return Boolean(messageIdHeader);
}

export async function enqueueOutbound(args: {
  transportId: string;
  messageId: string;
  sendAt: Date;
  smtpPayload: OutboundMailPayload;
  db?: DB;
}): Promise<void> {
  const db = args.db ?? getDb();
  const now = new Date();
  const queued = serializeSmtpPayload(args.smtpPayload);

  await db.insert(outboundSendQueue).values({
    id: randomUUID(),
    transportId: args.transportId,
    messageId: args.messageId,
    sendAt: args.sendAt,
    status: 'pending',
    smtpPayload: queued as unknown as Record<string, unknown>,
    attempts: 0,
    lastError: null,
    claimedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Cancel pending row if still pending and now < sendAt.
 * @returns true if cancelled.
 */
export async function cancelOutbound(
  messageId: string,
  transportId: string,
  db: DB = getDb(),
): Promise<boolean> {
  const now = new Date();
  const [updated] = await db
    .update(outboundSendQueue)
    .set({ status: 'cancelled', updatedAt: now })
    .where(
      and(
        eq(outboundSendQueue.messageId, messageId),
        eq(outboundSendQueue.transportId, transportId),
        eq(outboundSendQueue.status, 'pending'),
        gt(outboundSendQueue.sendAt, now),
      ),
    )
    .returning({ id: outboundSendQueue.id });
  return Boolean(updated);
}

function claimFence(row: ClaimedQueueRow) {
  return and(
    eq(outboundSendQueue.id, row.id),
    eq(outboundSendQueue.status, 'sending'),
    eq(outboundSendQueue.attempts, row.attempts),
  );
}

async function claimDue(
  db: DB,
  opts: { limit: number; messageId?: string; transportId?: string },
): Promise<ClaimedQueueRow[]> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - RECLAIM_SENDING_AFTER_MS);

  return db.transaction(async (tx) => {
    const conditions = [
      or(
        and(eq(outboundSendQueue.status, 'pending'), lte(outboundSendQueue.sendAt, now)),
        and(
          eq(outboundSendQueue.status, 'sending'),
          lte(outboundSendQueue.claimedAt, staleBefore),
          or(
            isNull(outboundSendQueue.smtpAttemptedAt),
            isNotNull(outboundSendQueue.smtpOutcomePersistedAt),
          ),
        ),
      ),
    ];
    if (opts.messageId) {
      conditions.push(eq(outboundSendQueue.messageId, opts.messageId));
    }
    if (opts.transportId) {
      conditions.push(eq(outboundSendQueue.transportId, opts.transportId));
    }

    const candidates = await tx
      .select()
      .from(outboundSendQueue)
      .where(and(...conditions))
      .orderBy(outboundSendQueue.sendAt)
      .limit(opts.limit)
      .for('update', { skipLocked: true });

    const claimed: ClaimedQueueRow[] = [];
    for (const row of candidates) {
      const [updated] = await tx
        .update(outboundSendQueue)
        .set({
          status: 'sending',
          claimedAt: now,
          attempts: row.attempts + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(outboundSendQueue.id, row.id),
            or(
              and(eq(outboundSendQueue.status, 'pending'), lte(outboundSendQueue.sendAt, now)),
              and(
                eq(outboundSendQueue.status, 'sending'),
                lte(outboundSendQueue.claimedAt, staleBefore),
                or(
                  isNull(outboundSendQueue.smtpAttemptedAt),
                  isNotNull(outboundSendQueue.smtpOutcomePersistedAt),
                ),
              ),
            ),
          ),
        )
        .returning();
      if (updated?.claimedAt) claimed.push(updated as ClaimedQueueRow);
    }
    return claimed;
  });
}

async function renewClaimLease(row: ClaimedQueueRow, db: DB): Promise<boolean> {
  const now = new Date();
  const [renewed] = await db
    .update(outboundSendQueue)
    .set({ claimedAt: now, updatedAt: now })
    .where(claimFence(row))
    .returning({ id: outboundSendQueue.id });
  return Boolean(renewed);
}

async function markSmtpAttemptStarted(row: ClaimedQueueRow, db: DB): Promise<boolean> {
  const now = new Date();
  const [marked] = await db
    .update(outboundSendQueue)
    .set({ smtpAttemptedAt: now, updatedAt: now })
    .where(and(claimFence(row), isNull(outboundSendQueue.smtpAttemptedAt)))
    .returning({ id: outboundSendQueue.id });
  return Boolean(marked);
}

async function clearSmtpAttemptStarted(row: ClaimedQueueRow, db: DB): Promise<boolean> {
  const now = new Date();
  const [cleared] = await db
    .update(outboundSendQueue)
    .set({ smtpAttemptedAt: null, updatedAt: now })
    .where(and(claimFence(row), isNotNull(outboundSendQueue.smtpAttemptedAt)))
    .returning({ id: outboundSendQueue.id });
  return Boolean(cleared);
}

function startClaimLeaseRenewal(
  row: ClaimedQueueRow,
  db: DB,
): {
  stop: () => Promise<boolean>;
} {
  let stopped = false;
  let lost = false;
  let pending = Promise.resolve();
  const renew = async () => {
    if (stopped || lost) return;
    try {
      if (!(await renewClaimLease(row, db))) lost = true;
    } catch {
      lost = true;
    }
  };
  const tick = async () => {
    pending = pending.then(renew);
    await pending;
  };
  const timer = setInterval(tick, Math.max(1, Math.floor(RECLAIM_SENDING_AFTER_MS / 3)));

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
      return !lost;
    },
  };
}

async function persistDeliveryOutcome(
  row: ClaimedQueueRow,
  outcome: SmtpDeliveryOutcome,
  db: DB,
  observedAt = new Date(),
): Promise<Date> {
  const payload = requireRecord(row.smtpPayload, 'outbound SMTP payload malformed');
  const [updated] = await db
    .update(outboundSendQueue)
    .set({
      smtpPayload: {
        ...payload,
        deliveryOutcome: cloneDeliveryOutcome(outcome),
      },
      smtpOutcomePersistedAt: observedAt,
      updatedAt: observedAt,
    })
    .where(
      and(
        eq(outboundSendQueue.messageId, row.messageId),
        eq(outboundSendQueue.transportId, row.transportId),
        claimFence(row),
      ),
    )
    .returning({ id: outboundSendQueue.id });
  if (!updated) {
    throw new OutboundClaimLostError();
  }
  return observedAt;
}

async function finalizePersistedDelivery(
  row: ClaimedQueueRow,
  payload: OutboundMailPayload,
  outcome: SmtpDeliveryOutcome,
  db: DB,
  acceptedObservedAt?: Date,
): Promise<SmtpSendResult> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .select({ id: outboundSendQueue.id })
      .from(outboundSendQueue)
      .where(claimFence(row))
      .limit(1)
      .for('update');
    if (!claimed) throw new OutboundClaimLostError();

    const [existing] = await tx
      .select({ threadId: message.threadId, messageIdHeader: message.messageIdHeader })
      .from(message)
      .where(and(eq(message.id, row.messageId), eq(message.transportId, row.transportId)))
      .limit(1)
      .for('update');
    if (!existing) {
      throw new Error('outbound message missing for claimed queue row');
    }
    if (
      hasPersistedSmtpDelivery(existing.messageIdHeader) &&
      existing.messageIdHeader !== outcome.messageId
    ) {
      throw new Error('outbound delivery outcome message ID mismatch');
    }

    // Keep native acceptance time distinct from this finalization transaction.
    // Recovery passes the original persisted observation time so a crash or
    // late queue finalization cannot invent a later answer event.
    const now = acceptedObservedAt ?? new Date();
    if (existing.messageIdHeader === outcome.messageId) {
      await tx
        .update(message)
        .set({ sentAt: now, receivedAt: now, updatedAt: now })
        .where(and(eq(message.id, row.messageId), eq(message.transportId, row.transportId)));
    } else {
      const [updated] = await tx
        .update(message)
        .set({
          messageIdHeader: outcome.messageId,
          sentAt: now,
          receivedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(message.id, row.messageId),
            eq(message.transportId, row.transportId),
            or(isNull(message.messageIdHeader), eq(message.messageIdHeader, '')),
          ),
        )
        .returning({ id: message.id });
      if (!updated) {
        throw new Error('outbound delivery outcome message ID mismatch');
      }
    }

    const [marked] = await tx
      .update(outboundSendQueue)
      .set({
        status: 'sent',
        lastError: partialDeliveryWarning(payload, outcome),
        updatedAt: now,
      })
      .where(claimFence(row))
      .returning({ id: outboundSendQueue.id });
    if (!marked) throw new OutboundClaimLostError();

    // Native recipient acceptance is the only Nava queue evidence that may
    // close an ask. Persist the compact semantic fact in the same transaction
    // as the durable sent state; queued/legacy recovery never invents this.
    const extraction = extractMailBaselineEvidence({
      sourceVintage: now.toISOString(),
      observationCutoff: now,
      interpretationVersion: MAIL_BASELINE_INTERPRETATION_VERSION,
      message: {
        id: row.messageId,
        transportId: row.transportId,
        threadId: existing.threadId,
        direction: 'outbound',
        fromAddress: payload.from,
        toAddresses: payload.to,
        ccAddresses: payload.cc,
        bccAddresses: payload.bcc,
        subject: payload.subject,
        textBody: payload.text,
        receivedAt: now,
        sentAt: now,
        createdAt: now,
        messageIdHeader: outcome.messageId,
        inReplyTo: payload.inReplyTo,
        references: payload.references,
        sendEvidence: {
          status: getSmtpDeliveryStatus(payload, outcome) === 'partial' ? 'partial' : 'accepted',
          acceptedAt: now.toISOString(),
          acceptedRecipients: outcome.accepted,
          rejectedRecipients: outcome.rejected,
        },
        source: 'mail_event',
        sourceBasis: 'source_event',
      },
    });
    const generationId = mailBaselineGenerationKey({
      transportId: row.transportId,
      threadId: existing.threadId,
      sourceMessageId: row.messageId,
      sourceVintage: `queue:${row.id}`,
      interpretationVersion: extraction.interpretationVersion,
    });
    await persistMailBaselineProjection(tx as unknown as DB, {
      transportId: row.transportId,
      threadId: existing.threadId,
      generationId,
      sourceVintage: extraction.sourceVintage,
      interpretationVersion: extraction.interpretationVersion,
      observationCutoff: now,
      evidence: extraction.evidence,
    });
    return cloneDeliveryOutcome(outcome);
  });
}

async function finalizeLegacyHeaderOnlyDelivery(
  row: ClaimedQueueRow,
  db: DB,
): Promise<LegacyHeaderOnlyDelivery> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .select({ id: outboundSendQueue.id })
      .from(outboundSendQueue)
      .where(claimFence(row))
      .limit(1)
      .for('update');
    if (!claimed) throw new OutboundClaimLostError();

    const [existing] = await tx
      .select({ messageIdHeader: message.messageIdHeader })
      .from(message)
      .where(and(eq(message.id, row.messageId), eq(message.transportId, row.transportId)))
      .limit(1)
      .for('update');
    if (!existing?.messageIdHeader) {
      throw new Error('outbound message missing SMTP ID for legacy queue recovery');
    }

    const now = new Date();
    await tx
      .update(message)
      .set({ sentAt: now, receivedAt: now, updatedAt: now })
      .where(and(eq(message.id, row.messageId), eq(message.transportId, row.transportId)));
    const [marked] = await tx
      .update(outboundSendQueue)
      .set({
        status: 'sent',
        lastError: JSON.stringify({ code: 'LEGACY_HEADER_ONLY_DELIVERY' }),
        updatedAt: now,
      })
      .where(claimFence(row))
      .returning({ id: outboundSendQueue.id });
    if (!marked) throw new OutboundClaimLostError();
    return {
      messageId: existing.messageIdHeader,
      deliveryEvidence: 'legacy-header-only',
    };
  });
}

async function deliverClaimed(row: ClaimedQueueRow, db: DB): Promise<OutboundDeliveryResult> {
  const persistedOutcome = parsePersistedDeliveryOutcome(row.smtpPayload);
  const payload = deserializeSmtpPayload(row.smtpPayload as unknown as QueuedSmtpPayload);
  const [existing] = await db
    .select({ messageIdHeader: message.messageIdHeader })
    .from(message)
    .where(and(eq(message.id, row.messageId), eq(message.transportId, row.transportId)))
    .limit(1);
  if (!existing) {
    throw new Error('outbound message missing for claimed queue row');
  }

  if (!(await renewClaimLease(row, db))) throw new OutboundClaimLostError();
  if (persistedOutcome) {
    // A persisted SMTP result without its original observation clock cannot
    // prove when acceptance occurred. Leave it uncertain rather than using
    // late queue finalization time as a fabricated answer event.
    if (!row.smtpOutcomePersistedAt) throw new OutboundDeliveryUncertainError();
    return finalizePersistedDelivery(
      row,
      payload,
      persistedOutcome,
      db,
      row.smtpOutcomePersistedAt,
    );
  }
  if (hasPersistedSmtpDelivery(existing.messageIdHeader)) {
    return finalizeLegacyHeaderOnlyDelivery(row, db);
  }

  const smtpTransport = getSmtpTransport();
  if (!(await markSmtpAttemptStarted(row, db))) throw new OutboundClaimLostError();
  const leaseRenewal = startClaimLeaseRenewal(row, db);
  let rawSmtpResult: SmtpSendResult | undefined;
  try {
    rawSmtpResult = await smtpTransport.send(payload);
  } catch {
    await leaseRenewal.stop();
    throw new OutboundDeliveryUncertainError();
  }
  const leaseOwned = await leaseRenewal.stop();
  if (!leaseOwned) throw new OutboundDeliveryUncertainError();
  if (!(await renewClaimLease(row, db))) throw new OutboundDeliveryUncertainError();

  let smtpResult: SmtpDeliveryOutcome;
  try {
    smtpResult = validateSmtpOutcome(rawSmtpResult!);
  } catch {
    throw new OutboundDeliveryUncertainError();
  }
  if (smtpResult.accepted.length === 0) {
    if (!(await clearSmtpAttemptStarted(row, db))) throw new OutboundClaimLostError();
    throw new Error('SMTP accepted no recipients');
  }

  let finalized: SmtpSendResult;
  try {
    const acceptedObservedAt = await persistDeliveryOutcome(row, smtpResult, db);
    finalized = await finalizePersistedDelivery(row, payload, smtpResult, db, acceptedObservedAt);
  } catch {
    throw new OutboundDeliveryUncertainError();
  }

  const mode =
    process.env.MAIL_TRANSPORT_MODE === 'real' || process.env.MAIL_TRANSPORT_MODE === 'wire'
      ? (process.env.MAIL_TRANSPORT_MODE as 'real' | 'wire')
      : 'fixture';
  maybeEnqueueLoopback(payload, finalized, mode, payload.extraHeaders);
  return finalized;
}

async function markFlushError(row: ClaimedQueueRow, err: unknown, db: DB): Promise<boolean> {
  const now = new Date();
  const lastError =
    err instanceof OutboundDeliveryUncertainError
      ? JSON.stringify({ code: 'SMTP_DELIVERY_OUTCOME_UNKNOWN' })
      : err instanceof Error
        ? err.message
        : String(err);
  // Leave status=sending so reclaim can retry after RECLAIM_SENDING_AFTER_MS.
  const [updated] = await db
    .update(outboundSendQueue)
    .set({ lastError, updatedAt: now })
    .where(claimFence(row))
    .returning({ id: outboundSendQueue.id });
  return Boolean(updated);
}

export async function flushDue(opts?: { limit?: number; db?: DB }): Promise<{ flushed: number }> {
  const db = opts?.db ?? getDb();
  const limit = opts?.limit ?? 20;
  let flushed = 0;
  for (let index = 0; index < limit; index += 1) {
    const [row] = await claimDue(db, { limit: 1 });
    if (!row) break;
    try {
      await deliverClaimed(row, db);
      flushed += 1;
    } catch (err) {
      if (err instanceof OutboundClaimLostError) continue;
      await markFlushError(row, err, db);
      console.error(
        'outbound-queue: flushDue failed',
        row.messageId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { flushed };
}

export async function flushOne(
  messageId: string,
  transportId: string,
  db: DB = getDb(),
): Promise<OutboundDeliveryResult> {
  // Force due: bump sendAt into the past if still pending (sync undo=0 path).
  const now = new Date();
  await db
    .update(outboundSendQueue)
    .set({ sendAt: now, updatedAt: now })
    .where(
      and(
        eq(outboundSendQueue.messageId, messageId),
        eq(outboundSendQueue.transportId, transportId),
        eq(outboundSendQueue.status, 'pending'),
      ),
    );

  const claimed = await claimDue(db, { limit: 1, messageId, transportId });
  if (claimed.length === 0) {
    // Already sent (idempotent) — return durable exact delivery evidence.
    const [existing] = await db
      .select({
        status: outboundSendQueue.status,
        smtpPayload: outboundSendQueue.smtpPayload,
      })
      .from(outboundSendQueue)
      .where(
        and(
          eq(outboundSendQueue.messageId, messageId),
          eq(outboundSendQueue.transportId, transportId),
        ),
      )
      .limit(1);
    if (existing?.status === 'sent') {
      const outcome = parsePersistedDeliveryOutcome(existing.smtpPayload);
      const [msg] = await db
        .select({ messageIdHeader: message.messageIdHeader })
        .from(message)
        .where(and(eq(message.id, messageId), eq(message.transportId, transportId)))
        .limit(1);
      if (!outcome) {
        if (!msg?.messageIdHeader) {
          throw new Error('outbound sent queue lacks persisted delivery outcome');
        }
        return {
          messageId: msg.messageIdHeader,
          deliveryEvidence: 'legacy-header-only',
        };
      }
      if (!msg || msg.messageIdHeader !== outcome.messageId) {
        throw new Error('outbound sent queue delivery outcome message ID mismatch');
      }
      return cloneDeliveryOutcome(outcome);
    }
    throw new Error(`outbound flushOne: nothing to claim for ${messageId}`);
  }

  try {
    return await deliverClaimed(claimed[0]!, db);
  } catch (err) {
    await markFlushError(claimed[0]!, err, db);
    throw err;
  }
}

/** Test helper: force sendAt into the past for a pending row. */
export async function __forceSendAtPastForTests(
  messageId: string,
  transportId: string,
  db: DB = getDb(),
): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  await db
    .update(outboundSendQueue)
    .set({ sendAt: past, updatedAt: new Date() })
    .where(
      and(
        eq(outboundSendQueue.messageId, messageId),
        eq(outboundSendQueue.transportId, transportId),
        eq(outboundSendQueue.status, 'pending'),
      ),
    );
}
