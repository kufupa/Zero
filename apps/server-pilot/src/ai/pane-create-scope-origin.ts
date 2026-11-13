import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { mailExtraction, workEvent, workItem } from '../db/schema/work.js';
import { paneCreateIdentitySchema, type PaneCreateIdentity } from './pane-create-scope.js';
import { hydrateStoredFieldPath } from './stored-work-state.js';

export type HistoricalOwnRow = { eventId: string; extractionId: string; fieldPath: string; value: unknown; extraction: unknown };
type WorkTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];
type OriginRow = {
  workItemId: string; transportId: string; sourceMessageId: string | null;
  eventId: string; eventWorkItemId: string; actorKind: string; eventType: string; fieldPath: string | null;
  value: unknown; aiSource: string | null; evidence: unknown;
  extractionId: string; extractionMessageId: string; extractorVersion: string; extractionStatus: string;
  extraction: unknown;
};

/** Validate the durable event's recorded extraction and its after-state, not browser-supplied origin. */
export function paneOwnRowsFromEvents(input: {
  workItemId: string; transportId: string; identity: PaneCreateIdentity; rows: OriginRow[];
}): HistoricalOwnRow[] {
  if (!paneCreateIdentitySchema.safeParse(input.identity).success || input.identity.roomIndex !== 1 ||
      input.identity.rowId !== `${input.identity.stayId}_row`) return [];
  const prefix = `stays[${input.identity.stayId}].rows[${input.identity.rowId}].`;
  const fields = new Set(['count', 'adults', 'roomType', 'childAges', 'board', 'mealPlan'].map((field) => prefix + field));
  return input.rows.flatMap((row) => {
    if (!row.eventId || !row.extractionId || row.workItemId !== input.workItemId || row.eventWorkItemId !== input.workItemId ||
        row.transportId !== input.transportId || !row.sourceMessageId || row.sourceMessageId !== row.extractionMessageId ||
        row.actorKind !== 'user' || !['field.edit', 'field.reject'].includes(row.eventType) ||
        !row.fieldPath || !fields.has(row.fieldPath) || row.extractionStatus !== 'succeeded' ||
        !row.aiSource || row.aiSource !== row.extractorVersion || !row.evidence || typeof row.evidence !== 'object' ||
        Array.isArray(row.evidence)) return [];
    const evidence = row.evidence as Record<string, unknown>;
    const paneState = evidence.paneState;
    if (evidence.extractionId !== row.extractionId || !Number.isSafeInteger(evidence.paneSeq) ||
        (evidence.paneSeq as number) < 1 || !paneState || typeof paneState !== 'object' || Array.isArray(paneState) ||
        !Object.hasOwn(paneState, row.fieldPath) ||
        JSON.stringify((paneState as Record<string, unknown>)[row.fieldPath]) !== JSON.stringify(row.value)) return [];
    return [{ eventId: row.eventId, extractionId: row.extractionId, fieldPath: hydrateStoredFieldPath(row.fieldPath),
      value: row.value, extraction: row.extraction }];
  });
}

/**
 * Call with the work-item row already locked and the item's transport/source authorized. A consumer must bind
 * these historical extractions at approval and revalidate or lock them through native dispatch; this read alone
 * is not write authority. Old events without an extraction-id revision are deliberately not guessed.
 */
export async function loadPaneOwnRowOrigins(tx: WorkTx, input: {
  workItemId: string; transportId: string; identity: PaneCreateIdentity;
}): Promise<HistoricalOwnRow[]> {
  if (!paneCreateIdentitySchema.safeParse(input.identity).success || input.identity.roomIndex !== 1 ||
      input.identity.rowId !== `${input.identity.stayId}_row`) return [];
  const prefix = `stays[${input.identity.stayId}].rows[${input.identity.rowId}].`;
  const paths = ['count', 'adults', 'roomType', 'childAges', 'board', 'mealPlan'].map((field) => prefix + field);
  const rows = await tx.select({
    workItemId: workItem.id, transportId: workItem.transportId, sourceMessageId: workItem.sourceMessageId,
    eventId: workEvent.id, eventWorkItemId: workEvent.workItemId, actorKind: workEvent.actorKind, eventType: workEvent.type,
    fieldPath: workEvent.fieldPath, value: workEvent.value, aiSource: workEvent.aiSource, evidence: workEvent.evidence,
    extractionId: mailExtraction.id, extractionMessageId: mailExtraction.messageId,
    extractorVersion: mailExtraction.extractorVersion, extractionStatus: mailExtraction.status, extraction: mailExtraction.payload,
  }).from(workItem)
    .innerJoin(workEvent, eq(workEvent.workItemId, workItem.id))
    .innerJoin(mailExtraction, and(eq(mailExtraction.messageId, workItem.sourceMessageId),
      sql`${mailExtraction.id}::text = ${workEvent.evidence}->>'extractionId'`,
      eq(mailExtraction.extractorVersion, workEvent.aiSource)))
    .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId),
      eq(workEvent.actorKind, 'user'), inArray(workEvent.type, ['field.edit', 'field.reject']),
      inArray(workEvent.fieldPath, paths), eq(mailExtraction.status, 'succeeded')));
  return paneOwnRowsFromEvents({ ...input, rows });
}
