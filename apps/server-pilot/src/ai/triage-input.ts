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
}

export interface TriageInput {
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  messages: TriageMessageRow[];
  asOf: string;
  modelId: string;
  promptVersion: string;
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

export function hashTriagePrompt(systemPrompt: string): string {
  return sha256Hex(systemPrompt);
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
    })),
  };
  return sha256Hex(JSON.stringify(canonical));
}

export function assertTriageAsOf(asOf: string): string {
  return assertIsoAsOf(asOf);
}
