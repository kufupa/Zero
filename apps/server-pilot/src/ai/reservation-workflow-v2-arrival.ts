import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiWorkflowRun, attachment, mailboxTransport, mailThread, message } from '../db/schema/mail.js';
import { fileAttachmentPresence } from '../mail/ingest/attachment-evidence.js';
import { resolvePropertyTransport } from '../../tooling/hms-cloud/property-registry.mjs';
import { canonicalSourceBodyText, classifyMailSource } from './mail-source.js';
import { selfSentPreStayCandidate } from './existing-stay-information.js';
import { MESSAGE_ARRIVED_AT } from './message-arrival-time.js';
import { staffQuoteSourceHash } from './staff-quote-workflow.js';
import { enqueueAiRun, NOT_APPLICABLE_MODEL_ID } from './run-ledger.js';
import { reservationArrivalEvidence } from './reservation-workflow-v2-evidence.js';

export const RESERVATION_ARRIVAL_VERSION = 'reservation-prefill/1';
// Admission enqueues at 1; staff-requested work must be claimed first.
const PANE_REQUEST_PRIORITY = 2;
export const reservationArrivalEnabled = () => process.env.RESERVATION_V2_ARRIVAL_PREFILL === 'on';

/** Called with the admission transaction, or with an authenticated pane's current source. */
export async function enqueueReservationArrival(db: DB, input: {
  transportId: string; messageId: string; priority?: number; requestedByPane?: boolean;
}) {
  if (!reservationArrivalEnabled()) return null;
  const property = resolvePropertyTransport(input.transportId);
  if (property.kind !== 'property' || !['HRCEN', 'HRDAV'].includes(property.property.propertyCode)) return null;
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
  const body = canonicalSourceBodyText({ textBody: row.textBody, htmlBody: row.htmlBody });
  // A staff-selected message may be attachment-only; admission still waits for a body.
  if (!body.trim() && !input.requestedByPane) return null;
  const [fileAttachment] = await db.select({ id: attachment.id }).from(attachment)
    .where(and(eq(attachment.messageId, row.id), eq(attachment.isInline, false))).limit(1);
  // Source classification shares the canonical body and notice gates with
  // ingest, admission and the pane, including routine automated notices. The
  // same self-prestay exemption admission and the pane apply keeps a real
  // self-sent pre-stay mail eligible for prefill.
  if (classifyMailSource({ fromAddress: row.fromAddress, subject: row.subject, bodyText: body,
    hasAttachments: fileAttachmentPresence(fileAttachment != null, row.sourceProvenance) }).kind !== 'direct' &&
    !selfSentPreStayCandidate({ fromAddress: row.fromAddress, mailboxAddress: row.mailboxAddress,
      subject: row.subject, bodyText: body })) return null;
  const sourceHash = staffQuoteSourceHash(row);
  const evidence = await reservationArrivalEvidence(db, row.id);
  const priority = input.requestedByPane ? PANE_REQUEST_PRIORITY : input.priority ?? 0;
  const job = await enqueueAiRun({ transportId: input.transportId, threadId: row.threadId, triggerMessageId: row.id,
    runKind: 'reservation_prefill', idempotencyKey: `reservation-prefill:${input.transportId}:${row.id}:${sourceHash}:${evidence.hash}`,
    modelId: NOT_APPLICABLE_MODEL_ID, promptVersion: RESERVATION_ARRIVAL_VERSION,
    priority, metrics: { sourceHash, evidenceHash: evidence.hash, arrivedAt: row.arrivedAt.toISOString(), phase: 'queued' } }, db);
  if (!input.requestedByPane) return job;
  return await promoteReservationArrival(db, { transportId: input.transportId, jobRunId: job.id }) ?? job;
}

/** Moves a waiting prefill job ahead of admission work when staff open its email. Never inserts or restarts a job. */
export async function promoteReservationArrival(db: DB, input: { transportId: string; jobRunId: string }) {
  const [promoted] = await db.update(aiWorkflowRun).set({ priority: PANE_REQUEST_PRIORITY, updatedAt: new Date() })
    .where(and(eq(aiWorkflowRun.id, input.jobRunId), eq(aiWorkflowRun.transportId, input.transportId),
      eq(aiWorkflowRun.runKind, 'reservation_prefill'), inArray(aiWorkflowRun.state, ['queued', 'retry_wait']),
      lt(aiWorkflowRun.priority, PANE_REQUEST_PRIORITY))).returning();
  return promoted ?? null;
}
