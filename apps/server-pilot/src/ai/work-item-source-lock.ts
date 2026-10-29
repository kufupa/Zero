import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { message } from '../db/schema/mail.js';
import { mailExtraction, workItem } from '../db/schema/work.js';
import { resolvePropertyTransport } from '../../tooling/playwright-quote/property-registry.mjs';
import { mailExtractionPayloadSchema } from './extraction/schema.js';

type WorkTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export function centurionSourceFence(transportId: string): boolean {
  const property = resolvePropertyTransport(transportId);
  return property.kind === 'property' && property.property.propertyCode === 'HRCEN';
}

/** Drizzle may wrap a PostgreSQL lock timeout or deadlock in a cause. */
export function isWorkItemSourceBusy(error: unknown): boolean {
  let value = error;
  for (let depth = 0; depth < 8 && value && typeof value === 'object'; depth++) {
    const current = value as { code?: unknown; cause?: unknown };
    if (current.code === '55P03' || current.code === '40P01') return true;
    value = current.cause;
  }
  return false;
}

/** Lock the source before reading it or inserting an extraction, in the same order as edit fences. */
export async function lockMessageSource(
  tx: WorkTx,
  input: { transportId: string; messageId: string },
): Promise<boolean> {
  // Other mail paths can take locks in a different order; prefer a retry to an indefinite wait.
  await tx.execute(sql`set local lock_timeout = '250ms'`);
  const [source] = await tx.select({ id: message.id }).from(message)
    .where(and(eq(message.id, input.messageId), eq(message.transportId, input.transportId)))
    .limit(1).for('update');
  if (!source) return false;
  // The message lock blocks new extraction FKs; these locks also block updates to existing reads.
  await tx.select({ id: mailExtraction.id }).from(mailExtraction)
    .where(eq(mailExtraction.messageId, source.id)).orderBy(asc(mailExtraction.id)).for('update');
  return true;
}

/**
 * Fence a Centurion edit (or an explicit recovery edit at another property) against newer reads.
 * The message lock blocks new extraction FKs, existing extraction locks block status/payload updates,
 * and the work-item lock protects the pinned read and saved state. Keep this order for relinking too.
 */
export async function lockWorkItemSource(
  tx: WorkTx,
  input: { transportId: string; workItemId: string; recovery?: boolean },
): Promise<'ok' | 'held' | 'not_found'> {
  if (!centurionSourceFence(input.transportId) && !input.recovery) return 'ok';
  const [before] = await tx.select({ sourceMessageId: workItem.sourceMessageId }).from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId))).limit(1);
  if (!before) return 'not_found';
  if (!before.sourceMessageId) return 'held';
  if (!await lockMessageSource(tx, { transportId: input.transportId, messageId: before.sourceMessageId })) return 'held';
  const [item] = await tx.select({ sourceMessageId: workItem.sourceMessageId, extractionId: workItem.extractionId,
    kind: workItem.kind, status: workItem.status }).from(workItem)
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
    .limit(1).for('update');
  if (!item) return 'not_found';
  if (item.sourceMessageId !== before.sourceMessageId || !item.extractionId ||
    (item.status !== 'needs_you' && item.status !== 'review')) return 'held';
  const [latest] = await tx.select({ id: mailExtraction.id, kind: mailExtraction.kind, payload: mailExtraction.payload })
    .from(mailExtraction).where(and(eq(mailExtraction.messageId, before.sourceMessageId), eq(mailExtraction.status, 'succeeded')))
    .orderBy(desc(mailExtraction.createdAt), desc(mailExtraction.id)).limit(1);
  return latest && latest.id === item.extractionId && latest.kind === item.kind &&
    mailExtractionPayloadSchema.safeParse(latest.payload).success ? 'ok' : 'held';
}
