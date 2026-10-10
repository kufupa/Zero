import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { workEvent, workItem, WORK_EVENT_TYPES, type WorkEventType } from '../db/schema/work.js';
import type { RowPrice } from '../quote-proposal/quote-lines.js';
import type { QuoteRevision } from '../quote-proposal/quote-revision.js';

/**
 * Appends one work_event, the authoritative HITL record (KTD2). The column has no CHECK, so the type is validated here.
 * The actor is the session user. U4's recordEvent can reuse this for field edits.
 */
export async function appendWorkEvent(
  db: DB,
  event: {
    workItemId: string;
    type: WorkEventType;
    actorUserId: string;
    fieldPath?: string;
    aiValue?: unknown;
    value?: unknown;
    aiSource?: string;
  },
): Promise<void> {
  if (!(WORK_EVENT_TYPES as readonly string[]).includes(event.type)) throw new Error('work_event_type');
  await db.insert(workEvent).values({
    workItemId: event.workItemId,
    actorKind: 'user',
    actorUserId: event.actorUserId,
    type: event.type,
    fieldPath: event.fieldPath ?? null,
    aiValue: event.aiValue ?? null,
    value: event.value ?? null,
    aiSource: event.aiSource ?? null,
  });
}

/**
 * The quote's work item for this inbound mail: one per (thread, kind, source message). U4 creates it. Until a row exists
 * this returns null, and no rate event is written.
 */
export async function quoteWorkItemIdFor(
  db: DB,
  scope: { transportId: string; threadId: string; messageId: string },
): Promise<string | null> {
  const [row] = await db
    .select({ id: workItem.id })
    .from(workItem)
    .where(
      and(
        eq(workItem.transportId, scope.transportId),
        eq(workItem.threadId, scope.threadId),
        eq(workItem.kind, 'quote'),
        eq(workItem.sourceMessageId, scope.messageId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * One rate event per priced row. The AI value is the HMS rate the row was quoted at; the value is the price charged. An
 * override keeps its code and note inside value, because work_event has no payload column.
 */
export async function recordRateEvents(
  db: DB,
  args: {
    workItemId: string;
    actorUserId: string;
    workflowRunId: string;
    revision: QuoteRevision;
    rowPrices: readonly RowPrice[];
  },
): Promise<void> {
  for (const price of args.rowPrices) {
    const group = args.revision.groups.find((row) => row.id === price.groupId);
    if (!group) throw new Error('row_price_scope');
    await appendWorkEvent(db, {
      workItemId: args.workItemId,
      type: price.source === 'saved' ? 'rate.saved' : price.source === 'one_off' ? 'rate.one_off' : 'rate.override',
      actorUserId: args.actorUserId,
      fieldPath: `quote.rows[${price.groupId}].rate`,
      aiValue: { rateCode: group.rateCode, nightlyMinor: group.nightly.map((night) => night.amountMinor) },
      value:
        price.source === 'saved'
          ? { source: price.source, customRateId: price.customRateId, name: price.name, amountMinor: price.amountMinor }
          : price.source === 'override'
            ? { source: price.source, rateCode: price.rateCode, amountMinor: price.amountMinor, note: price.note }
            : { source: price.source, amountMinor: price.amountMinor },
      aiSource: args.workflowRunId,
    });
  }
}

/** The work item a staff check on this mail is recorded on: its quote item, else its other item. Null when it has none. */
export async function workItemIdForMessage(
  db: DB,
  scope: { transportId: string; threadId: string; messageId: string },
): Promise<string | null> {
  const rows = await db
    .select({ id: workItem.id, kind: workItem.kind })
    .from(workItem)
    .where(
      and(
        eq(workItem.transportId, scope.transportId),
        eq(workItem.threadId, scope.threadId),
        eq(workItem.sourceMessageId, scope.messageId),
      ),
    )
    .orderBy(workItem.createdAt);
  return (rows.find((row) => row.kind === 'quote') ?? rows[0])?.id ?? null;
}

/**
 * Staff ticked (or unticked) that they checked in HMS that a run's room types can be booked together. HMS gave no
 * building for them, so it does not prove it. Append-only: the latest event for the run and revision is the state.
 */
export async function recordJointRoomsCheck(
  db: DB,
  args: { workItemId: string; actorUserId: string; workflowRunId: string; revisionRef: string; checked: boolean },
): Promise<void> {
  // clock_timestamp, not the transaction's now(): a tick and an untick in one transaction must still order.
  await db.insert(workEvent).values({
    workItemId: args.workItemId,
    at: sql`clock_timestamp()`,
    actorKind: 'user',
    actorUserId: args.actorUserId,
    type: args.checked ? 'joint_rooms.checked' : 'joint_rooms.unchecked',
    fieldPath: 'quote.jointRooms',
    value: { workflowRunId: args.workflowRunId, revisionRef: args.revisionRef },
    aiSource: args.workflowRunId,
  });
}

/** Whether the latest joint-rooms event for this run and revision, on this mail's work items, is a tick. */
export async function jointRoomsChecked(
  db: DB,
  scope: { transportId: string; threadId: string; messageId: string; workflowRunId: string; revisionRef: string },
): Promise<boolean> {
  const [row] = await db
    .select({ type: workEvent.type })
    .from(workEvent)
    .innerJoin(workItem, eq(workEvent.workItemId, workItem.id))
    .where(
      and(
        eq(workItem.transportId, scope.transportId),
        eq(workItem.threadId, scope.threadId),
        eq(workItem.sourceMessageId, scope.messageId),
        inArray(workEvent.type, ['joint_rooms.checked', 'joint_rooms.unchecked']),
        sql`${workEvent.value}->>'workflowRunId' = ${scope.workflowRunId}`,
        sql`${workEvent.value}->>'revisionRef' = ${scope.revisionRef}`,
      ),
    )
    .orderBy(desc(workEvent.at), desc(workEvent.id))
    .limit(1);
  return row?.type === 'joint_rooms.checked';
}
