/**
 * Outbound undo/schedule queue (`UNDO_SEND_SECONDS`).
 *
 * Claim: pending + sendAt<=now, or stale `sending` with claimedAt older than
 * RECLAIM_SENDING_AFTER_MS (5 min) → reclaimable after crash mid-SMTP.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gt, lte, or } from 'drizzle-orm';
import { getDb, type DB } from '../../db/client.js';
import { message, outboundSendQueue } from '../../db/schema/mail.js';
import { maybeEnqueueLoopback } from '../fixture-loopback.js';
import {
  getSmtpTransport,
  type OutboundMailPayload,
  type SmtpSendResult,
} from './smtp.js';

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
  deliveryOutcome?: SmtpSendResult;
};

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

export function attachSmtpDeliveryOutcome(
  raw: QueuedSmtpPayload,
  outcome: SmtpSendResult,
): QueuedSmtpPayload {
  return {
    ...raw,
    deliveryOutcome: {
      messageId: outcome.messageId,
      accepted: [...outcome.accepted],
      rejected: [...outcome.rejected],
    },
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function readSmtpDeliveryOutcome(
  raw: QueuedSmtpPayload | Record<string, unknown>,
): SmtpSendResult | null {
  const outcome = (raw as { deliveryOutcome?: unknown }).deliveryOutcome;
  if (outcome === undefined) return null;
  if (
    !outcome ||
    typeof outcome !== 'object' ||
    typeof (outcome as { messageId?: unknown }).messageId !== 'string' ||
    !isStringArray((outcome as { accepted?: unknown }).accepted) ||
    !isStringArray((outcome as { rejected?: unknown }).rejected)
  ) {
    throw new Error('SMTP_DELIVERY_OUTCOME_INVALID');
  }
  const valid = outcome as SmtpSendResult;
  return {
    messageId: valid.messageId,
    accepted: [...valid.accepted],
    rejected: [...valid.rejected],
  };
}

/** Pure claim eligibility — used by unit tests + claimDue. */
export function isOutboundClaimable(
  row: { status: string; sendAt: Date; claimedAt: Date | null },
  now: Date = new Date(),
  reclaimAfterMs: number = RECLAIM_SENDING_AFTER_MS,
): boolean {
  if (row.status === 'pending' && row.sendAt.getTime() <= now.getTime()) return true;
  if (
    row.status === 'sending' &&
    row.claimedAt != null &&
    now.getTime() - row.claimedAt.getTime() >= reclaimAfterMs
  ) {
    return true;
  }
  return false;
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

async function claimDue(
  db: DB,
  opts: { limit: number; messageId?: string; transportId?: string },
): Promise<(typeof outboundSendQueue.$inferSelect)[]> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - RECLAIM_SENDING_AFTER_MS);

  return db.transaction(async (tx) => {
    const conditions = [
      or(
        and(eq(outboundSendQueue.status, 'pending'), lte(outboundSendQueue.sendAt, now)),
        and(
          eq(outboundSendQueue.status, 'sending'),
          lte(outboundSendQueue.claimedAt, staleBefore),
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

    const claimed: (typeof outboundSendQueue.$inferSelect)[] = [];
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
              ),
            ),
          ),
        )
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

async function markQueueSent(
  rowId: string,
  db: DB,
  opts: { now?: Date; lastError?: string | null } = {},
): Promise<void> {
  await db
    .update(outboundSendQueue)
    .set({
      status: 'sent',
      lastError: opts.lastError ?? null,
      updatedAt: opts.now ?? new Date(),
    })
    .where(eq(outboundSendQueue.id, rowId));
}

function normalizedRecipient(address: string): string {
  return address.trim().toLowerCase();
}

function isFullAcceptance(
  payload: OutboundMailPayload,
  result: SmtpSendResult,
): boolean {
  if (result.rejected.length > 0) return false;
  const requested = new Set(
    [...payload.to, ...payload.cc, ...payload.bcc].map(normalizedRecipient),
  );
  const accepted = new Set(result.accepted.map(normalizedRecipient));
  return requested.size > 0 && [...requested].every((address) => accepted.has(address));
}

function partialRejectionWarning(result: SmtpSendResult): string {
  return JSON.stringify({
    code: 'PARTIAL_REJECTION',
    messageId: result.messageId,
    accepted: result.accepted,
    rejected: result.rejected,
  });
}

type AfterSmtpOutcomePersist = () => void | Promise<void>;
let afterSmtpOutcomePersistForTests: AfterSmtpOutcomePersist | undefined;

export function __setAfterSmtpOutcomePersistForTests(
  hook: AfterSmtpOutcomePersist | undefined,
): void {
  afterSmtpOutcomePersistForTests = hook;
}

async function persistSmtpDeliveryOutcome(
  row: typeof outboundSendQueue.$inferSelect,
  outcome: SmtpSendResult,
  db: DB,
): Promise<void> {
  const current = row.smtpPayload as unknown as QueuedSmtpPayload;
  const persisted = attachSmtpDeliveryOutcome(current, outcome);
  const [updated] = await db
    .update(outboundSendQueue)
    .set({
      smtpPayload: persisted as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(outboundSendQueue.id, row.id),
        eq(outboundSendQueue.status, 'sending'),
      ),
    )
    .returning({ id: outboundSendQueue.id });
  if (!updated) {
    throw new Error('SMTP_DELIVERY_OUTCOME_PERSIST_FAILED');
  }
}

async function finalizeSmtpDelivery(
  row: typeof outboundSendQueue.$inferSelect,
  payload: OutboundMailPayload,
  outcome: SmtpSendResult,
  db: DB,
): Promise<SmtpSendResult> {
  const now = new Date();
  await db
    .update(message)
    .set({
      messageIdHeader: outcome.messageId,
      sentAt: now,
      receivedAt: now,
      updatedAt: now,
    })
    .where(and(eq(message.id, row.messageId), eq(message.transportId, row.transportId)));
  await markQueueSent(row.id, db, {
    now,
    lastError: isFullAcceptance(payload, outcome)
      ? null
      : partialRejectionWarning(outcome),
  });
  return outcome;
}

async function deliverClaimed(
  row: typeof outboundSendQueue.$inferSelect,
  db: DB,
): Promise<SmtpSendResult> {
  const queuedPayload = row.smtpPayload as unknown as QueuedSmtpPayload;
  const payload = deserializeSmtpPayload(queuedPayload);
  const persistedOutcome = readSmtpDeliveryOutcome(queuedPayload);
  const [existing] = await db
    .select({ messageIdHeader: message.messageIdHeader })
    .from(message)
    .where(and(eq(message.id, row.messageId), eq(message.transportId, row.transportId)))
    .limit(1);

  if (persistedOutcome) {
    if (
      existing?.messageIdHeader &&
      existing.messageIdHeader !== persistedOutcome.messageId
    ) {
      throw new Error('SMTP_DELIVERY_MESSAGE_ID_MISMATCH');
    }
    return finalizeSmtpDelivery(row, payload, persistedOutcome, db);
  }

  if (existing?.messageIdHeader) {
    throw new Error('SMTP_DELIVERY_OUTCOME_MISSING');
  }

  // Uncertain-delivery window: SMTP can accept before outcome persistence.
  // A crash here leaves no durable recipient evidence, so stale reclaim may resend.
  const smtpResult = await getSmtpTransport().send(payload);
  if (smtpResult.accepted.length === 0) {
    throw new Error('SMTP_ZERO_ACCEPTED');
  }

  const mode =
    process.env.MAIL_TRANSPORT_MODE === 'real' || process.env.MAIL_TRANSPORT_MODE === 'wire'
      ? (process.env.MAIL_TRANSPORT_MODE as 'real' | 'wire')
      : 'fixture';
  maybeEnqueueLoopback(payload, smtpResult, mode, payload.extraHeaders);

  // After this write commits, every reclaim finalizes from exact evidence; no re-send.
  await persistSmtpDeliveryOutcome(row, smtpResult, db);
  await afterSmtpOutcomePersistForTests?.();
  return finalizeSmtpDelivery(row, payload, smtpResult, db);
}

async function markFlushError(
  rowId: string,
  err: unknown,
  db: DB,
): Promise<void> {
  const now = new Date();
  const lastError = err instanceof Error ? err.message : String(err);
  // Leave status=sending so reclaim can retry after RECLAIM_SENDING_AFTER_MS.
  await db
    .update(outboundSendQueue)
    .set({ lastError, updatedAt: now })
    .where(eq(outboundSendQueue.id, rowId));
}

export async function flushDue(opts?: {
  limit?: number;
  db?: DB;
}): Promise<{ flushed: number }> {
  const db = opts?.db ?? getDb();
  const limit = opts?.limit ?? 20;
  const claimed = await claimDue(db, { limit });
  let flushed = 0;
  for (const row of claimed) {
    try {
      await deliverClaimed(row, db);
      flushed += 1;
    } catch (err) {
      await markFlushError(row.id, err, db);
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
): Promise<SmtpSendResult> {
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
    // Already sent (idempotent) — return exact durable SMTP evidence.
    const [existing] = await db
      .select({
        id: outboundSendQueue.id,
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
      const outcome = readSmtpDeliveryOutcome(
        existing.smtpPayload as unknown as QueuedSmtpPayload,
      );
      if (!outcome) {
        throw new Error('SMTP_DELIVERY_OUTCOME_MISSING');
      }
      const [msg] = await db
        .select({ messageIdHeader: message.messageIdHeader })
        .from(message)
        .where(and(eq(message.id, messageId), eq(message.transportId, transportId)))
        .limit(1);
      if (msg?.messageIdHeader !== outcome.messageId) {
        throw new Error('SMTP_DELIVERY_MESSAGE_ID_MISMATCH');
      }
      const payload = deserializeSmtpPayload(
        existing.smtpPayload as unknown as QueuedSmtpPayload,
      );
      await markQueueSent(existing.id, db, {
        lastError: isFullAcceptance(payload, outcome)
          ? null
          : partialRejectionWarning(outcome),
      });
      return outcome;
    }
    throw new Error(`outbound flushOne: nothing to claim for ${messageId}`);
  }

  try {
    return await deliverClaimed(claimed[0]!, db);
  } catch (err) {
    await markFlushError(claimed[0]!.id, err, db);
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
