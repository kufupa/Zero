/**
 * Map a ReservationistDecision (+ recorded tool names) onto same-move GoldOperation rows.
 * Offline replay only. No HMS. No mail bodies in the emitted ops.
 */
import type { ReservationistDecision } from './reservationist-decision.js';
import type { GoldOperation } from './same-move-ops.js';

/** Copied from gold-pair-join goldOp — that helper is not exported. */
const OPERATION_TOOL: Record<string, string | null> = {
  create: 'hms_create_reservation',
  cancel: 'hms_cancel_reservation',
  amend: 'hms_amend_reservation',
  quote: 'hms_quote_stay',
  post_payment: 'hms_post_payment',
  document: 'hms_generate_invoice',
  attachment: 'hms_attach_guest_stay_document',
  read: 'hms_read_reservation',
  refund: 'hms_refund_payment',
  none: null,
  unknown: null,
  partner: null,
  channel: null,
};

const WORKFLOW_OPERATION: Record<ReservationistDecision['workflow'], string> = {
  quote: 'quote',
  create: 'create',
  amend: 'amend',
  cancel: 'cancel',
  skip: 'none',
  spam: 'none',
  other: 'unknown',
};

function goldOp(operation: string, unknownReason: string | null = null): GoldOperation {
  return {
    operation,
    needLevel: operation === 'none' || operation === 'unknown' ? 'not_needed' : 'required',
    requiredFields: [],
    candidateTool: OPERATION_TOOL[operation] ?? null,
    unknownReason,
  };
}

export function decisionToOperations(
  decision: ReservationistDecision,
  toolCalls: { toolName: string }[],
): GoldOperation[] {
  const mapped = WORKFLOW_OPERATION[decision.workflow];
  const operation = mapped ?? 'unknown';
  const unknownReason = operation === 'unknown' ? 'other' : null;
  const ops: GoldOperation[] = [goldOp(operation, unknownReason)];
  const calledParty = toolCalls.some((call) => call.toolName === 'party_lookup');
  if (calledParty && !ops.some((row) => row.operation === 'read')) {
    ops.push(goldOp('read'));
  }
  const seen = new Set<string>();
  return ops.filter((row) => {
    if (seen.has(row.operation)) return false;
    seen.add(row.operation);
    return true;
  });
}

export type SnapshotMail = {
  id: string;
  direction: string;
  from_address: string;
  to_addresses?: unknown;
  cc_addresses?: unknown;
  subject: string;
  sent_at?: string | null;
  received_at: string | null;
  body: string;
  body_is_html?: boolean;
  attachments?: { filename: string }[];
};

export type SnapshotRow = {
  pair_id?: string;
  mailbox?: string;
  thread_id?: string;
  inbound: SnapshotMail;
  context?: SnapshotMail[];
  outbound?: unknown;
};

export type AgentCaseMessage = {
  id: string;
  direction: string;
  eventAt: string | null;
  from: string;
  subject: string;
  text: string;
};

export type AgentCase = {
  trigger: AgentCaseMessage;
  context: AgentCaseMessage[];
};

const MAX_MESSAGE_CHARS = 20_000;

/** HTML → plain text for body_is_html rows. Shared with party-v2-offline-score. */
export function corpusTextBody(message: { body?: unknown; body_is_html?: unknown }): string {
  const body = typeof message.body === 'string' ? message.body : '';
  if (message.body_is_html !== true) return body;
  return body
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<\s*br\s*\/?>/giu, '\n')
    .replace(/<\/(?:p|div|li|tr|table|blockquote|h[1-6]|section)\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;|&#160;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/[ \t]+\n/gu, '\n');
}

function snapshotMailToCaseMessage(mail: SnapshotMail): AgentCaseMessage {
  return {
    id: mail.id,
    direction: mail.direction,
    eventAt: mail.received_at,
    from: mail.from_address,
    subject: mail.subject,
    text: corpusTextBody(mail),
  };
}

/** Context (older) + inbound. Outbound is the answer key and is ignored. */
export function snapshotRowToAgentCase(row: SnapshotRow): AgentCase {
  return {
    trigger: snapshotMailToCaseMessage(row.inbound),
    context: (row.context ?? []).map(snapshotMailToCaseMessage),
  };
}

export function emailBlock(m: AgentCaseMessage): string {
  return `<email direction="${m.direction}" at="${m.eventAt}" from="${m.from}" subject="${m.subject}">
${m.text.slice(0, MAX_MESSAGE_CHARS)}
</email>`;
}

/** Same shape the existing --target agent path feeds createReservationistAgent. */
export function agentThreadPrompt(row: AgentCase): string {
  return `Thread messages oldest first. Handle the LAST message (asOf ${row.trigger.eventAt}); earlier ones are context.

${[...row.context, row.trigger].map(emailBlock).join('\n\n')}`;
}
