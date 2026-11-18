import { createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { sql } from './db.js';
import { staffAttachmentsChecked, type StaffStage } from './attachment-gate.js';
import { maxFilingPdfBytes, parseFilingRequest, type ToolContext } from '../tools/filing/index.js';
import type { ProposalDraft } from './schema.js';

const identifier = z.string().min(1).max(256).regex(/^[^\p{Cc}]+$/u);
const sourcePdf = z.object({
  id: identifier,
  name: z.string().max(150).regex(/^[^"\\/\p{Cc}]+\.pdf$/iu).refine(name => name === name.replace(/\s+/g, ' ').trim()),
  mime_type: z.literal('application/pdf'),
  size: z.number().int().min(6).max(maxFilingPdfBytes),
});
const sourceMessage = z.object({ id: identifier, direction: z.literal('inbound'), attachments: z.array(z.unknown()) });
const filingDetails = z.object({ message_id: z.unknown(), attachment_id: z.unknown(), description: z.unknown() });
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
    attachments: z.array(z.unknown()),
  }),
});

function selectedPdfs(attachments: unknown[]) {
  const choices = new Map<string, z.infer<typeof sourcePdf> | null>();
  for (const item of attachments) {
    const parsed = sourcePdf.safeParse(item);
    if (parsed.success) choices.set(parsed.data.id, choices.has(parsed.data.id) ? null : parsed.data);
  }
  return [...choices.values()].filter(choice => choice !== null);
}

export function withFilingSourceFields(draft: ProposalDraft, selectedMessagePayload: unknown): ProposalDraft {
  if (draft.workflow !== 'filing' || draft.disposition !== 'propose' || draft.actions.length !== 1) return draft;
  const source = sourceMessage.safeParse(selectedMessagePayload);
  if (!source.success) return draft;
  const [action] = draft.actions;
  const provided = filingDetails.safeParse(action.details);
  const details: z.infer<typeof filingDetails> = provided.success ? provided.data : {};
  const wrongMessage = details.message_id != null && details.message_id !== source.data.id;
  const choices = selectedPdfs(source.data.attachments);
  const file = wrongMessage ? undefined : details.attachment_id == null && choices.length === 1
    ? choices[0] : choices.find(option => option.id === details.attachment_id);
  const description = typeof details.description === 'string' && details.description.trim() === details.description &&
    details.description.length > 0 && details.description.length <= 200 && !/\p{Cc}/u.test(details.description)
    ? details.description : null;
  const fallback = action.type === 'voucher_submission' ? 'Booking voucher'
    : action.type === 'payment_proof_submission' ? 'Proof of payment' : 'Reservation document';
  const fieldSpecs = draft.field_specs.filter(spec => !/^\/?actions\/0\/details(?:\/|$)/.test(spec.path));
  const evidence = [{ message_id: source.data.id, attachment_id: file?.id ?? null, quote: null }];
  const options = choices.map(item => ({ value: item.id, label: item.name, meaning: null }));
  return {
    ...draft,
    ...(wrongMessage ? { disposition: 'staff_review', reason: 'Check the PDF on the selected email.' }
      : !choices.length ? { disposition: 'needs_info', missing: [...draft.missing, 'PDF on the selected email'] } : {}),
    actions: [{ ...action, details: { message_id: source.data.id, attachment_id: file?.id ?? null, description: description ?? fallback } }],
    field_specs: [...fieldSpecs,
      { path: '/actions/0/details/attachment_id', label: 'PDF attachment', provenance: file ? 'default' : 'unknown',
        editable: true, required: true, error: null, control: 'select', options, evidence },
      { path: '/actions/0/details/description', label: 'Description', provenance: description ? 'ai' : 'default',
        editable: true, required: true, error: null, control: 'text', options: [], evidence }],
  };
}

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

export function createFilingPorts({ sessionId, staffStage, staffGo }: {
  sessionId: string; staffStage?: StaffStage; staffGo?: { executionId: string };
}, input?: unknown):
  Pick<ToolContext, 'authorizeTarget' | 'resolveAttachment'> {
  async function current(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!staffStage) return null;
    const stage = staffStage;
    return sql.begin('isolation level repeatable read read only', async tx => {
      const [row] = await tx`SELECT p.current, p.stage->'native_result' AS prepared,
          CASE WHEN p.phase='saving' THEN p.execution->'go'->>'actor' ELSE p.stage->>'actor' END AS actor,
          t.mailbox_id, t.source_thread_id, t.selected_message_id, t.property_code, m.payload
        FROM nava_agent.proposal p
        JOIN nava_agent.agent_session s ON s.id=p.session_id AND s.thread_id=p.thread_id
        JOIN nava_agent.mail_thread t ON t.id=p.thread_id
        JOIN nava_agent.mail_message m ON m.thread_id=t.id AND m.source_message_id=t.selected_message_id
        WHERE p.id=${stage.proposalId} AND p.session_id=${sessionId} AND p.revision=${stage.revision}
          AND p.workflow='filing' AND (
            (p.phase='staging' AND p.stage->>'state'='queued') OR
            (p.phase='saving' AND p.stage->>'state'='prepared' AND p.execution->'go'->>'executionId'=${staffGo?.executionId ?? null}
              AND p.execution->'go'->>'revision'=${String(stage.revision)}))
          AND p.stage->>'job_id'=${stage.jobId} AND p.stage->>'revision'=${String(stage.revision)}
          AND t.source='outlook' AND t.mode='live' AND t.selection_key LIKE 'prepare:%' AND s.mode='live'
          AND s.worker_id=${stage.workerId} AND s.lease_epoch=${stage.epoch}::bigint AND s.lease_until>clock_timestamp()`;
      const scope = jobScope.safeParse(row);
      if (!scope.success || !await staffAttachmentsChecked(tx, stage.proposalId, stage.revision)) return null;
      signal.throwIfAborted();
      const { property_code, selected_message_id } = scope.data;
      const [booking] = scope.data.current.bookings;
      const [action] = scope.data.current.actions;
      const nestedProperty = booking.fields.property_code;
      if ((booking.property_code != null && booking.property_code !== property_code) ||
          (nestedProperty != null && nestedProperty !== property_code)) return null;
      const { property_code: _nested, ...fields } = booking.fields;
      const durableInput = { workflow: 'filing', booking: { ...booking, fields, property_code }, action };
      if (input !== undefined) {
        if (typeof input !== 'object' || input === null || !('workflow' in input) || !('booking' in input) || !('action' in input) ||
            !isDeepStrictEqual({ workflow: input.workflow, booking: input.booking, action: input.action }, durableInput)) return null;
        if (staffGo && ('prepared' in input) && !isDeepStrictEqual(input.prepared, row.prepared?.native ?? row.prepared)) return null;
      }
      const request = parseFilingRequest(durableInput);
      if (!request || request.ref.messageId !== selected_message_id) return null;
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
      const file = selectedPdfs(scope.payload.attachments).find(item => item.id === ref.attachmentId);
      if (!file) return null;

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
