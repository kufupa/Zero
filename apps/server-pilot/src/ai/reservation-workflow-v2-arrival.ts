import { and, eq, isNull } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { mailboxTransport, mailThread, message } from '../db/schema/mail.js';
import { resolvePropertyTransport } from '../../tooling/hms-cloud/property-registry.mjs';
import { classifyMailSource } from './mail-source.js';
import { preStaySourceText } from './existing-stay-information.js';
import { MESSAGE_ARRIVED_AT } from './message-arrival-time.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { enqueueAiRun, NOT_APPLICABLE_MODEL_ID } from './run-ledger.js';
import { reservationArrivalEvidence } from './reservation-workflow-v2-evidence.js';

export const RESERVATION_ARRIVAL_VERSION = 'reservation-prefill/1';
export const reservationArrivalEnabled = (propertyCode = 'HRCEN') =>
  process.env.RESERVATION_V2_ARRIVAL_PREFILL === 'on' && (propertyCode === 'HRCEN' ||
    (propertyCode === 'HRDAV' && process.env.RESERVATION_V2_ARRIVAL_PREFILL_HRDAV === 'on'));

/** Called with the admission transaction, or with an authenticated pane's current source. */
export async function enqueueReservationArrival(db: DB, input: {
  transportId: string; messageId: string; priority?: number; requestedByPane?: boolean;
}) {
  if (!reservationArrivalEnabled()) return null;
  const property = resolvePropertyTransport(input.transportId);
  if (property.kind !== 'property' || !reservationArrivalEnabled(property.property.propertyCode)) return null;
  const [row] = await db.select({ id: message.id, threadId: message.threadId, subject: message.subject,
    textBody: message.textBody, htmlBody: message.htmlBody, fromAddress: message.fromAddress,
    sourceProvenance: message.sourceProvenance, arrivedAt: MESSAGE_ARRIVED_AT, mailboxAddress: mailboxTransport.email,
  }).from(message)
    .innerJoin(mailThread, and(eq(mailThread.id, message.threadId), eq(mailThread.transportId, message.transportId)))
    .innerJoin(mailboxTransport, eq(mailboxTransport.id, message.transportId))
    .where(and(eq(message.transportId, input.transportId), eq(message.id, input.messageId),
      eq(message.direction, 'inbound'), eq(message.historyOnly, false), eq(mailThread.historyOnly, false),
      isNull(mailThread.trashedAt), isNull(mailThread.spamAt))).limit(1);
  if (!row || row.sourceProvenance?.attention != null || !row.arrivedAt) return null;
  const body = preStaySourceText(row.textBody, row.htmlBody);
  // A staff-selected message may be attachment-only; admission still waits for a body.
  if (!body.trim() && !input.requestedByPane) return null;
  if (classifyMailSource({ fromAddress: row.fromAddress, subject: row.subject, bodyText: body }).kind !== 'direct') return null;
  // FortiMail's quarantine digest is an internal wrapper, not the quarantined
  // sender's request. Do not spend a model call on its contents.
  if (/@fortimail-[a-z0-9-]+\.[a-z0-9.-]+\s*>?$/i.test(row.fromAddress.trim()) &&
      /^quarantine\s+summary\b/i.test(row.subject?.trim() ?? '')) return null;
  // A routine internal function sheet is an operations handover, not a client request.
  if (/@legacyhotels\.(?:co\.za|com)\s*>?$/i.test(row.fromAddress.trim()) &&
      /^(?:re:\s*|fw(?:d)?:\s*)*(?:new\s+|updated\s+)?function\s+sheet\b/i.test(row.subject?.trim() ?? '')) return null;
  const sourceHash = staffQuoteSourceHash(row);
  const evidence = await reservationArrivalEvidence(db, row.id);
  return enqueueAiRun({ transportId: input.transportId, threadId: row.threadId, triggerMessageId: row.id,
    runKind: 'reservation_prefill', idempotencyKey: `reservation-prefill:${input.transportId}:${row.id}:${sourceHash}:${evidence.hash}`,
    modelId: NOT_APPLICABLE_MODEL_ID, promptVersion: RESERVATION_ARRIVAL_VERSION,
    priority: input.priority ?? 0, metrics: { sourceHash, evidenceHash: evidence.hash, arrivedAt: row.arrivedAt.toISOString(), phase: 'queued' } }, db);
}
