import { createHash } from 'node:crypto';
import { z } from 'zod';

export interface TriageMessageRow {
  id: string;
  from: string;
  subject?: string;
  body: string;
  direction: 'inbound' | 'outbound';
  createdAt: Date;
  receivedAt: Date | null;
  sentAt: Date | null;
  /** Causal recipient metadata used by R23/source refinement. */
  to?: string[];
  cc?: string[];
  bcc?: string[];
  /** RFC headers are metrics-only metadata; they are not prompt content. */
  messageIdHeader?: string | null;
  inReplyTo?: string | null;
  references?: string[] | null;
}

export type TriageEventClockBasis =
  | 'source_event'
  | 'sender_timestamp_estimate'
  | 'first_known'
  | 'availability'
  | 'unknown';

export type TriageEventClock = {
  at: Date | null;
  basis: TriageEventClockBasis;
};

/** Resolve the committed source clock without treating ingestion time as a receipt. */
export function resolveTriageEventClock(row: TriageMessageRow): TriageEventClock {
  if (row.direction === 'inbound' && row.receivedAt) {
    return { at: new Date(row.receivedAt.getTime()), basis: 'sender_timestamp_estimate' };
  }
  if (row.direction === 'outbound' && row.sentAt) {
    return { at: new Date(row.sentAt.getTime()), basis: 'source_event' };
  }
  // Ingestion/creation time proves that the row exists, not when the source
  // event happened. Preserve that distinction for baseline denominators.
  if (row.receivedAt === null && row.sentAt === null) {
    return { at: null, basis: 'availability' };
  }
  if (Number.isFinite(row.createdAt.getTime())) {
    return { at: new Date(row.createdAt.getTime()), basis: 'first_known' };
  }
  return { at: null, basis: 'unknown' };
}

export interface TriageThreadSignals {
  legacyHotelsOutboundResponse?: boolean;
  reserveCloudStaffOutbound?: boolean;
  reserveCloudStaffOutboundFrom?: string;
  reserveCloudStaffOutboundRecipients?: string | readonly string[];
}

export interface TriageInput {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  messages: TriageMessageRow[];
  asOf: string;
  modelId: string;
  promptVersion: string;
  threadSignals?: TriageThreadSignals;
}

const asOfSchema = z.string().datetime({ offset: true });

function assertIsoAsOf(asOf: string): string {
  const parsed = asOfSchema.safeParse(asOf);
  if (!parsed.success) {
    throw new Error(`asOf must be an ISO-8601 datetime string: ${asOf}`);
  }
  return parsed.data;
}

function compareCausalOrder(a: TriageMessageRow, b: TriageMessageRow): number {
  const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
  if (byCreated !== 0) return byCreated;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Trusted causal window: sort by server ingestion `(createdAt, id)`,
 * include the trigger and all earlier messages; exclude later messages.
 * Sender-authored receivedAt/sentAt never control cutoff.
 */
export function buildCausalTriageMessages(
  rows: readonly TriageMessageRow[],
  triggerMessageId: string,
): TriageMessageRow[] {
  const sorted = [...rows].sort(compareCausalOrder);
  const triggerIndex = sorted.findIndex((row) => row.id === triggerMessageId);
  if (triggerIndex < 0) {
    throw new Error(`trigger message not found for causal cutoff: ${triggerMessageId}`);
  }
  return sorted.slice(0, triggerIndex + 1);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashTriagePrompt(
  systemPrompt: string,
  userPrompt = '',
  promptVersion = '',
): string {
  return sha256Hex(JSON.stringify({ systemPrompt, userPrompt, promptVersion }));
}

function canonicalAddresses(value: string | readonly string[] | undefined): string[] {
  const values = typeof value === 'string' ? value.split(/[,;]/) : (value ?? []);
  return values
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function canonicalThreadSignals(signals: TriageThreadSignals | undefined) {
  return {
    legacyHotelsOutboundResponse: signals?.legacyHotelsOutboundResponse === true,
    reserveCloudStaffOutbound: signals?.reserveCloudStaffOutbound === true,
    reserveCloudStaffOutboundFrom:
      signals?.reserveCloudStaffOutboundFrom?.trim().toLowerCase() ?? null,
    reserveCloudStaffOutboundRecipients: canonicalAddresses(
      signals?.reserveCloudStaffOutboundRecipients,
    ),
  };
}

export function hashTriageInput(input: TriageInput): string {
  assertIsoAsOf(input.asOf);
  const canonical = {
    transportId: input.transportId,
    threadId: input.threadId,
    triggerMessageId: input.triggerMessageId,
    asOf: input.asOf,
    modelId: input.modelId,
    promptVersion: input.promptVersion,
    messages: input.messages.map((m) => ({
      id: m.id,
      from: m.from,
      subject: m.subject ?? '',
      body: m.body,
      direction: m.direction,
      createdAt: m.createdAt.toISOString(),
      receivedAt: m.receivedAt ? m.receivedAt.toISOString() : null,
      sentAt: m.sentAt ? m.sentAt.toISOString() : null,
      to: canonicalAddresses(m.to),
      cc: canonicalAddresses(m.cc),
      bcc: canonicalAddresses(m.bcc),
    })),
    threadSignals: canonicalThreadSignals(input.threadSignals),
  };
  return sha256Hex(JSON.stringify(canonical));
}

export function assertTriageAsOf(asOf: string): string {
  return assertIsoAsOf(asOf);
}
