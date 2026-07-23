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
};

export function getUndoSendSeconds(): number {
  const n = Number(process.env.UNDO_SEND_SECONDS ?? '30');
  return Number.isFinite(n) && n >= 0 ? n : 30;
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

/** True if outbound msg already has SMTP Message-ID → skip re-send on reclaim. */
export function hasPersistedSmtpDelivery(
  messageIdHeader: string | null | undefined,
): boolean {
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

async function markQueueSent(rowId: string, db: DB, now: Date = new Date()): Promise<void> {
  await db
    .update(outboundSendQueue)
    .set({ status: 'sent', lastError: null, updatedAt: now })
    .where(eq(outboundSendQueue.id, rowId));
}

async function deliverClaimed(
  row: typeof outboundSendQueue.$inferSelect,
  db: DB,
): Promise<SmtpSendResult> {
  // Reclaim path: SMTP may already have succeeded; message row has Message-ID.
  const [existing] = await db
    .select({ messageIdHeader: message.messageIdHeader })
    .from(message)
    .where(and(eq(message.id, row.messageId), eq(message.transportId, row.transportId)))
    .limit(1);

  if (hasPersistedSmtpDelivery(existing?.messageIdHeader)) {
    await markQueueSent(row.id, db);
    return {
      messageId: existing!.messageIdHeader!,
      accepted: [],
    };
  }

  const payload = deserializeSmtpPayload(row.smtpPayload as unknown as QueuedSmtpPayload);
  const smtpResult = await getSmtpTransport().send(payload);

  const mode =
    process.env.MAIL_TRANSPORT_MODE === 'real' || process.env.MAIL_TRANSPORT_MODE === 'wire'
      ? (process.env.MAIL_TRANSPORT_MODE as 'real' | 'wire')
      : 'fixture';
  maybeEnqueueLoopback(payload, smtpResult, mode, payload.extraHeaders);

  const now = new Date();
  // Persist smtp id on message FIRST so reclaim can skip SMTP if queue mark fails.
  await db
    .update(message)
    .set({
      messageIdHeader: smtpResult.messageId,
      sentAt: now,
      receivedAt: now,
      updatedAt: now,
    })
    .where(and(eq(message.id, row.messageId), eq(message.transportId, row.transportId)));
  await markQueueSent(row.id, db, now);

  return smtpResult;
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
    // Already sent (idempotent) — load message header.
    const [existing] = await db
      .select({ status: outboundSendQueue.status })
      .from(outboundSendQueue)
      .where(
        and(
          eq(outboundSendQueue.messageId, messageId),
          eq(outboundSendQueue.transportId, transportId),
        ),
      )
      .limit(1);
    if (existing?.status === 'sent') {
      const [msg] = await db
        .select({ messageIdHeader: message.messageIdHeader })
        .from(message)
        .where(and(eq(message.id, messageId), eq(message.transportId, transportId)))
        .limit(1);
      return {
        messageId: msg?.messageIdHeader ?? messageId,
        accepted: [],
      };
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
