import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { DB } from '../db/client.js';
import { workEvent, workItem, WORK_EVENT_TYPES, type WorkEventType } from '../db/schema/work.js';
import type { RowPrice } from '../quote-proposal/quote-lines.js';
import type { QuoteRevision } from '../quote-proposal/quote-revision.js';
import { maskCardNumbers } from './card-mask.js';

/** Pane action telemetry (v5 B1). The batch route accepts only these types, so no approval or field event comes through it. */
export const PANE_ACTION_TYPES = [
  'pane.opened',
  'copy.hms_line',
  'copy.confirmation',
  'reply.inserted',
  'reply.saved',
  'pdf.created',
  'excel.downloaded',
  'hms.lookup.started',
  'hms.lookup.finished',
  'item.dismissed',
] as const;
export type PaneActionType = (typeof PANE_ACTION_TYPES)[number];
export const PANE_ACTION_KINDS = ['selected', 'all', 'saved', 'option', 'combined', 'comment', 'booking'] as const;
export const PANE_ACTION_BLOCKS = ['notes'] as const;
export const PANE_ACTION_BATCH_MAX = 50;

export type PaneActionEvent = {
  type: PaneActionType;
  ms?: number;
  surface?: 'outlook' | 'web';
  kind?: (typeof PANE_ACTION_KINDS)[number];
  block?: (typeof PANE_ACTION_BLOCKS)[number];
};

/**
 * Appends a batch of pane actions to one work item, as the session user. Null when the item is not in this transport,
 * the same answer as a missing item. Each value holds only the enum or number the action carries; no mail text.
 */
export async function recordPaneActions(
  db: DB,
  input: { transportId: string; workItemId: string; userId: string; events: PaneActionEvent[] },
): Promise<'not_found' | 'recorded'> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ id: workItem.id })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1);
    if (!item) return 'not_found' as const;
    const rows = input.events.map(({ type, ...value }) => {
      if (!(PANE_ACTION_TYPES as readonly string[]).includes(type)) throw new Error('work_event_type');
      return {
        workItemId: input.workItemId,
        actorKind: 'user',
        actorUserId: input.userId,
        type,
        value: Object.keys(value).length ? value : null,
      };
    });
    await tx.insert(workEvent).values(rows);
    return 'recorded' as const;
  });
}

/** The longest staff note kept as a work event. Longer text is cut after masking. */
export const STAFF_NOTE_MAX = 2000;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/**
 * A run of 7 or more digits, such as 0825551234. It is masked before the spaced form below, so a number written without
 * spaces never joins the date after it in a bracket.
 */
const PHONE_DIGITS = /\+?\d{7,}/g;
/** A phone number written with spaces, brackets, dashes or dots. Masked when it holds 9 or more digits, so dates stay. */
const PHONE_IN_TEXT = /\+?\d[\d\s().-]{6,}\d/g;

/**
 * Masks card numbers and security codes (maskCardNumbers), then emails and phone numbers, then caps the length. The
 * phone rules err toward masking: a spaced run that a date has joined to is masked whole, and so is an oversized one.
 */
export function maskStaffNote(text: string): string {
  return maskCardNumbers(text)
    .replace(EMAIL_IN_TEXT, '[email]')
    .replace(PHONE_DIGITS, '[phone]')
    .replace(PHONE_IN_TEXT, (match) => (match.replace(/\D/g, '').length >= 9 ? '[phone]' : match))
    .slice(0, STAFF_NOTE_MAX);
}

/**
 * Keeps the staff's "Tell Nava" text on the work item as a masked note.staff event. The same masked text is kept once per
 * item, so a re-read with the same note adds no second row. The check and the insert share one transaction under the
 * item's row lock, so calls that overlap cannot both see no note and both insert it.
 */
export async function recordStaffNote(
  db: DB,
  input: { workItemId: string; userId: string; note: string },
): Promise<void> {
  const text = maskStaffNote(input.note.trim());
  if (!text) return;
  const payloadHash = createHash('sha256').update(text).digest('hex');
  await db.transaction(async (tx) => {
    await tx.select({ id: workItem.id }).from(workItem).where(eq(workItem.id, input.workItemId)).for('update');
    const [seen] = await tx
      .select({ id: workEvent.id })
      .from(workEvent)
      .where(
        and(
          eq(workEvent.workItemId, input.workItemId),
          eq(workEvent.type, 'note.staff'),
          eq(workEvent.payloadHash, payloadHash),
        ),
      )
      .limit(1);
    if (seen) return;
    await tx.insert(workEvent).values({
      workItemId: input.workItemId,
      actorKind: 'user',
      actorUserId: input.userId,
      type: 'note.staff',
      value: { text },
      payloadHash,
    });
  });
}

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
