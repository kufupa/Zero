import { createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { sql } from './db.js';
import { staffAttachmentsChecked, type StaffStage } from './attachment-gate.js';
import { maxFilingPdfBytes, parseFilingRequest, type ToolContext } from '../tools/filing/index.js';

const identifier = z.string().min(1).max(256).regex(/^[^\p{Cc}]+$/u);
const jobScope = z.object({
  actor: identifier,
  mailbox_id: identifier,
  source_thread_id: identifier,
  selected_message_id: identifier,
  property_code: z.literal('HRCEN'),
  current: z.object({ disposition: z.literal('propose'), bookings: z.tuple([z.object({
    property_code: z.string().nullish(), fields: z.record(z.unknown()),
  }).passthrough()]), actions: z.tuple([z.unknown()]) }),
  payload: z.object({
    direction: z.literal('inbound'),
    subject: z.string(),
    body_text: z.string(),
    attachments: z.array(z.object({ id: identifier, name: z.string(), mime_type: z.string(), size: z.number().int() })),
  }),
});

function filingSource() {
  const secret = process.env.NAVA_STAFF_JWT_SECRET;
  const value = process.env.NAVA_FILING_SOURCE_URL;
  if (!secret || Buffer.byteLength(secret) < 32 || !value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/api/nava/v1/internal/filing-pdf') return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) return null;
    return { url, secret };
  } catch {
    return null;
  }
}

export const filingPortsAvailable = () => filingSource() !== null;

async function readPdf(response: Response, expectedSize: number): Promise<Buffer | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  try {
    if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/pdf') return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return size === expectedSize ? Buffer.concat(chunks, size) : null;
      size += chunk.value.byteLength;
      if (size > expectedSize) return null;
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createFilingPorts({ sessionId, staffStage }: { sessionId: string; staffStage?: StaffStage }, input?: unknown):
  Pick<ToolContext, 'authorizeTarget' | 'resolveAttachment'> {
  async function current(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!staffStage) return null;
    const stage = staffStage;
    return sql.begin('isolation level repeatable read read only', async tx => {
      const [row] = await tx`SELECT p.current, p.stage->>'actor' AS actor,
          t.mailbox_id, t.source_thread_id, t.selected_message_id, t.property_code, m.payload
        FROM nava_agent.proposal p
        JOIN nava_agent.agent_session s ON s.id=p.session_id AND s.thread_id=p.thread_id
        JOIN nava_agent.mail_thread t ON t.id=p.thread_id
        JOIN nava_agent.mail_message m ON m.thread_id=t.id AND m.source_message_id=t.selected_message_id
        WHERE p.id=${stage.proposalId} AND p.session_id=${sessionId} AND p.revision=${stage.revision}
          AND p.workflow='filing' AND p.phase='staging' AND p.stage->>'state'='queued'
          AND p.stage->>'job_id'=${stage.jobId} AND p.stage->>'revision'=${String(stage.revision)}
          AND t.source='outlook' AND t.mode='live' AND t.selection_key LIKE 'prepare:%' AND s.mode='live'
          AND s.worker_id=${stage.workerId} AND s.lease_epoch=${stage.epoch}::bigint AND s.lease_until>clock_timestamp()`;
      const scope = jobScope.safeParse(row);
      if (!scope.success || !await staffAttachmentsChecked(tx, stage.proposalId, stage.revision)) return null;
      signal.throwIfAborted();
      const { payload, property_code, selected_message_id } = scope.data;
      const [booking] = scope.data.current.bookings;
      const [action] = scope.data.current.actions;
      const nestedProperty = booking.fields.property_code;
      if ((booking.property_code != null && booking.property_code !== property_code) ||
          (nestedProperty != null && nestedProperty !== property_code)) return null;
      const durableInput = { workflow: 'filing', booking: { ...booking, property_code }, action };
      if (input !== undefined && !isDeepStrictEqual(input, durableInput)) return null;
      const request = parseFilingRequest(durableInput);
      if (!request || request.ref.messageId !== selected_message_id) return null;

      // This adapter handles the simple case: the selected inbound binds the exact stay.
      const currentBody = payload.body_text.split(/^(?:\s*>|On .+ wrote:\s*$|\s*-{2,}\s*(?:Original Message|Forwarded message)|\s*From:\s)/im, 1)[0];
      const confirmations = new Set(`${payload.subject}\n${currentBody}`.match(/(?<![\w-])\d{5,95}-\d{1,4}(?![\w-])/g));
      if (confirmations.size !== 1 || !confirmations.has(request.confirmation)) return null;
      return { scope: scope.data, request };
    });
  }

  let attachmentReadStarted = false;
  return {
    authorizeTarget: async (target, { signal }) => {
      if (target.sessionId !== sessionId) return false;
      const bound = await current(signal);
      return !!bound && bound.request.bookingId === target.bookingId && bound.request.propertyCode === target.propertyCode &&
        bound.request.reservationId === target.reservationId && bound.request.confirmation === target.confirmation;
    },
    resolveAttachment: async (ref, { signal }) => {
      const source = filingSource();
      if (!source || ref.sessionId !== sessionId || attachmentReadStarted) return null;
      attachmentReadStarted = true;
      const bound = await current(signal);
      if (!bound || bound.request.ref.messageId !== ref.messageId || bound.request.ref.attachmentId !== ref.attachmentId) return null;
      const { scope } = bound;
      const choices = scope.payload.attachments.filter(item => item.id === ref.attachmentId);
      const [file] = choices;
      if (choices.length !== 1 || !file || file.mime_type !== 'application/pdf' || !/\.pdf$/i.test(file.name) ||
          file.size <= 5 || file.size > maxFilingPdfBytes) return null;

      signal.throwIfAborted();
      const body = JSON.stringify({ actor: scope.actor, mailbox_id: scope.mailbox_id, source_thread_id: scope.source_thread_id,
        message_id: ref.messageId, attachment_id: ref.attachmentId, exp: Math.floor(Date.now() / 1000) + 45 });
      const signature = createHmac('sha256', source.secret).update('nava-filing-pdf-v1\n').update(body).digest('hex');
      const response = await fetch(source.url, {
        method: 'POST', redirect: 'error', signal, body,
        headers: { 'content-type': 'application/json', 'x-nava-filing-signature': signature },
      });
      const bytes = await readPdf(response, file.size);
      signal.throwIfAborted();
      return bytes ? { ...ref, bytes, name: file.name, mimeType: file.mime_type } : null;
    },
  };
}
