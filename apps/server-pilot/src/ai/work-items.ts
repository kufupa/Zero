import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { message } from '../db/schema/mail.js';
import { mailExtraction, workEvent, workItem } from '../db/schema/work.js';
import type { AttachmentRead } from './extraction/extract.js';
import type { ExtractionStay, MailExtractionPayload, MailKind } from './extraction/schema.js';
import {
  canonicalInternetMessageId,
  documentFailureItems,
  questionItems,
} from './quote-workflow-analyse-selection.js';
import { amendmentFromAnalysis, mapLlmDecision, validIsoDate } from './quote-workflow-llm.js';
import type { LunaAnalysis } from './reservationist-decision.js';

/**
 * Work items for the Nava pane (U4). One work item is one person's job on one mail. Its `state` holds only the field
 * paths a person has touched, so a re-extraction never overwrites a person's value: every other value reads through
 * from the latest succeeded extraction. Paths use the extraction's stable ids (`stays[s_x].requested.arrival`,
 * `stays[s_x].rows[r_y].count`), so deleting one stay never shifts another stay's AI value. A path on an id the
 * extraction does not have is a stay or row the person added, and `stays[s_x].removed` / `...rows[r_y].removed`
 * (true) is one she deleted. Both come back on reopen.
 */

export const ROW_FIELDS = ['count', 'adults', 'roomType', 'childAges', 'board'] as const;
export type RowField = (typeof ROW_FIELDS)[number];
export type FieldPath =
  | { stayId: string; rowId: null; field: 'arrival' | 'departure' | 'removed' }
  | { stayId: string; rowId: string; field: RowField | 'removed' };
export type WorkState = Record<string, unknown>;

const ID = '[A-Za-z0-9_-]{1,40}';
const PATH = new RegExp(
  `^stays\\[(${ID})\\]\\.(?:requested\\.(arrival|departure)|(removed)|rows\\[(${ID})\\]\\.(${ROW_FIELDS.join('|')}|removed))$`,
);
/** Row field to the extraction's key. The path names the form's word, the payload the model's. */
const ROW_KEYS = {
  count: 'rooms',
  adults: 'adultsPerRoom',
  roomType: 'roomType',
  childAges: 'childAges',
  board: 'board',
} as const;
const BOARDS = new Set(['room_only', 'bb', 'dbb']);

export function parseFieldPath(path: string): FieldPath | null {
  const match = PATH.exec(path);
  if (!match) return null;
  const [, stayId = '', dateField, stayRemoved, rowId, rowField] = match;
  if (dateField) return { stayId, rowId: null, field: dateField as 'arrival' | 'departure' };
  if (stayRemoved) return { stayId, rowId: null, field: 'removed' };
  return { stayId, rowId: rowId ?? '', field: rowField as RowField | 'removed' };
}

function isInt(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Whether a person's value fits the field. Null is always allowed (cleared). */
export function validFieldValue(field: FieldPath['field'], value: unknown): boolean {
  if (value === null) return true;
  switch (field) {
    case 'arrival':
    case 'departure':
      return typeof value === 'string' && validIsoDate(value) !== undefined;
    case 'count':
      return isInt(value, 1, 999);
    case 'adults':
      return isInt(value, 1, 9);
    case 'roomType':
      return typeof value === 'string' && value.length > 0 && value.length <= 120;
    case 'childAges':
      return Array.isArray(value) && value.length <= 9 && value.every((age) => isInt(age, 0, 17));
    case 'board':
      return typeof value === 'string' && BOARDS.has(value);
    case 'removed':
      return value === true;
  }
}

/**
 * The extraction's value at a path, found by stable id. Null when the read has no such id (a user-made stay or row).
 * The extraction never removes, so `removed` on a stay or row it has reads false.
 */
export function aiValueAt(payload: MailExtractionPayload | null | undefined, path: string): unknown {
  const parsed = parseFieldPath(path);
  const stay = parsed ? payload?.stays.find((item) => item.id === parsed.stayId) : undefined;
  if (!parsed || !stay) return null;
  if (parsed.rowId === null) return parsed.field === 'removed' ? false : stay.requested[parsed.field];
  const row = stay.rows.find((item) => item.id === parsed.rowId);
  if (!row) return null;
  return parsed.field === 'removed' ? false : row[ROW_KEYS[parsed.field]];
}

type FormStay = Pick<ExtractionStay, 'id' | 'requested' | 'rows'>;

/**
 * The stays and rows the form shows: the extraction's, then any the person added (ids only in `state`), less any she
 * removed. Added ones start empty; their values come from `state` like every other field.
 */
export function formStays(payload: MailExtractionPayload, state: WorkState): FormStay[] {
  const stays: FormStay[] = payload.stays.map((stay) => ({ ...stay, rows: [...stay.rows] }));
  const removed = new Set<string>();
  for (const key of Object.keys(state)) {
    const path = parseFieldPath(key);
    if (!path) continue;
    let stay = stays.find((item) => item.id === path.stayId);
    if (!stay) {
      stay = { id: path.stayId, requested: { arrival: null, departure: null }, rows: [] };
      stays.push(stay);
    }
    if (path.rowId !== null && !stay.rows.some((row) => row.id === path.rowId)) {
      stay.rows.push({ id: path.rowId, roomType: null, rooms: null, adultsPerRoom: null, childAges: [], board: null });
    }
    if (path.field === 'removed' && state[key] === true) removed.add(path.rowId ?? path.stayId);
  }
  return stays.flatMap((stay) => {
    if (removed.has(stay.id)) return [];
    const rows = stay.rows.filter((row) => !removed.has(row.id));
    // A stay whose every row she removed is gone too.
    return stay.rows.length > 0 && rows.length === 0 ? [] : [{ ...stay, rows }];
  });
}

const WORKFLOW_BY_KIND: Partial<Record<MailKind, LunaAnalysis['workflow']>> = {
  quote: 'quote',
  booking: 'create_booking',
  amendment: 'amend',
  cancellation: 'cancel',
};

const FAILURE_COPY: Record<string, string> = {
  timeout: 'Nava ran out of time reading this email.',
  invalid_output: 'Nava read this email but could not use the result.',
  not_found: 'Nava could not load this email to read it.',
  no_message_id: 'This email has no Message-ID, so Nava cannot read it.',
};

export type StoredRead = {
  kind: MailKind;
  payload: MailExtractionPayload;
  attachments: AttachmentRead[] | null;
};
/** Where one pane group's values live: its stay, and its row when it has one. */
export type GroupRef = { stayId: string; rowId: string | null };

/**
 * The pane's analysis for a stored read, built by the same mapping a live Luna read uses (mapLlmDecision, the
 * amendment fields, the review items). No model call. A value a person set in `state` wins over the extraction.
 * A group's id is its row id, or its stay id for a stay with dates and no rows.
 */
export function storedAnalysis(read: StoredRead, state: WorkState) {
  const { kind, payload } = read;
  const pick = <T>(path: string, fallback: T): T =>
    Object.hasOwn(state, path) ? (state[path] as T) : fallback;
  const failures = documentFailureItems(
    (read.attachments ?? [])
      .filter((item) => item.status === 'not_read')
      .map((item) => ({
        id: item.id,
        filename: item.filename,
        mimeType: item.mimeType,
        byteSize: item.byteSize,
        bytesPresent: false,
        readFailure: item.reason,
      })),
    'text',
  );
  const flags: LunaAnalysis['flags'] = [];
  if (failures.length) flags.push('attachment_unread');
  const stays = formStays(payload, state);
  if (stays.length > 1) flags.push('multi_date');
  if (kind === 'amendment' || kind === 'cancellation') flags.push('amendment_or_cancel');

  const order: Array<GroupRef & { groupId: string }> = [];
  const groups: LunaAnalysis['groups'] = [];
  for (const stay of stays) {
    const dates = {
      arrival: pick(`stays[${stay.id}].requested.arrival`, stay.requested.arrival),
      departure: pick(`stays[${stay.id}].requested.departure`, stay.requested.departure),
    };
    if (stay.rows.length === 0) {
      order.push({ groupId: stay.id, stayId: stay.id, rowId: null });
      groups.push({
        ...dates,
        rooms: null,
        adultsPerRoom: null,
        childAges: [],
        board: null,
        roomPreference: null,
        guestNames: [],
      });
      continue;
    }
    for (const row of stay.rows) {
      const at = (field: RowField) => `stays[${stay.id}].rows[${row.id}].${field}`;
      order.push({ groupId: row.id, stayId: stay.id, rowId: row.id });
      groups.push({
        ...dates,
        rooms: pick(at('count'), row.rooms),
        adultsPerRoom: pick(at('adults'), row.adultsPerRoom),
        childAges: pick<number[] | null>(at('childAges'), row.childAges) ?? [],
        board: pick(at('board'), row.board),
        roomPreference: pick(at('roomType'), row.roomType),
        guestNames: [],
      });
    }
  }
  const booked = payload.stays[0]?.booked;
  const requested = payload.stays[0]?.requested;
  const luna: LunaAnalysis = {
    workflow: WORKFLOW_BY_KIND[kind] ?? 'other',
    flags,
    groups,
    party: {
      kind: payload.agency ? 'agency' : payload.endClient ? 'organization' : null,
      name: payload.agency ?? payload.endClient,
      reference: null,
    },
    rateClaims: [],
    missing: payload.missing,
    evidence: [],
    tasks: [],
    confirmationNumber: payload.confirmationNumbers[0] ?? null,
    guestLastName: null,
    arrival: validIsoDate(booked?.arrival ?? requested?.arrival ?? null) ?? null,
    departure: validIsoDate(booked?.departure ?? requested?.departure ?? null) ?? null,
    requestedChange: null,
  };
  const mapped = mapLlmDecision(luna);
  mapped.groups.forEach((group, index) => {
    const slot = order[index];
    if (!slot) return;
    group.id = slot.groupId;
    const stayPath = `stays[${slot.stayId}].requested`;
    const corrected: Array<[string, string]> = [
      ['arrivalDate', `${stayPath}.arrival`],
      ['departureDate', `${stayPath}.departure`],
    ];
    if (slot.rowId) {
      const rowPath = `stays[${slot.stayId}].rows[${slot.rowId}]`;
      corrected.push(
        ['quantity', `${rowPath}.count`],
        ['adults', `${rowPath}.adults`],
        ['board', `${rowPath}.board`],
      );
    }
    for (const [key, path] of corrected) {
      if (Object.hasOwn(state, path)) group.fields[key] = 'staff_corrected';
    }
  });
  const refs: Record<string, GroupRef> = Object.fromEntries(
    order.map((slot) => [slot.groupId, { stayId: slot.stayId, rowId: slot.rowId }]),
  );
  return {
    analysis: {
      intent: mapped.intent,
      // Each group names its stay, so the pane groups rows by the read's stays and logs edits to the stay's id.
      groups: mapped.groups.map((group, index) => ({ ...group, stayId: order[index]?.stayId })),
      secondaryAsks: mapped.secondaryAsks,
      alternatives: mapped.alternatives,
      reviewItems: [...failures, ...questionItems(mapped.missing)],
      source: 'luna' as const,
      aiUnavailable: false as const,
      luna,
      amendment: amendmentFromAnalysis(luna),
    },
    refs,
  };
}

export type StoredAnalysis = ReturnType<typeof storedAnalysis>['analysis'];

export type WorkItemRef = { id: string; status: string; state: WorkState };

/**
 * Upserts the work item for (thread, kind, source message) and points it at this extraction. Only the extraction link
 * moves. `state` is never written here, so a person's values survive a re-read.
 */
export async function ensureWorkItem(
  db: DB,
  input: {
    transportId: string;
    threadId: string;
    messageId: string;
    kind: MailKind;
    extractionId: string;
    /** Only the insert uses it. An existing item keeps its status. */
    status?: 'needs_you' | 'done';
  },
): Promise<WorkItemRef> {
  await db
    .insert(workItem)
    .values({
      transportId: input.transportId,
      threadId: input.threadId,
      sourceMessageId: input.messageId,
      kind: input.kind,
      extractionId: input.extractionId,
      ...(input.status ? { status: input.status } : {}),
    })
    .onConflictDoNothing({ target: [workItem.threadId, workItem.kind, workItem.sourceMessageId] });
  const [row] = await db
    .select({
      id: workItem.id,
      status: workItem.status,
      state: workItem.state,
      extractionId: workItem.extractionId,
    })
    .from(workItem)
    .where(
      and(
        eq(workItem.threadId, input.threadId),
        eq(workItem.kind, input.kind),
        eq(workItem.sourceMessageId, input.messageId),
      ),
    )
    .limit(1);
  if (!row) throw new Error('work item missing after upsert');
  if (row.extractionId !== input.extractionId) {
    await db
      .update(workItem)
      .set({ extractionId: input.extractionId, updatedAt: new Date() })
      .where(eq(workItem.id, row.id));
  }
  return { id: row.id, status: row.status, state: row.state };
}

async function latestSucceededRead(db: DB, messageId: string) {
  const [row] = await db
    .select()
    .from(mailExtraction)
    .where(and(eq(mailExtraction.messageId, messageId), eq(mailExtraction.status, 'succeeded')))
    .orderBy(desc(mailExtraction.createdAt))
    .limit(1);
  if (!row?.kind || !row.payload) return null;
  return {
    id: row.id,
    kind: row.kind as MailKind,
    payload: row.payload as MailExtractionPayload,
    attachments: row.attachments as AttachmentRead[] | null,
  };
}

/**
 * Points the message's work item at its latest succeeded read. A message with no succeeded read has none. A thread
 * with a staff reply after this message is already answered, so a new item starts done, not needs_you.
 */
export async function ensureWorkItemForMessage(
  db: DB,
  input: { transportId: string; messageId: string },
): Promise<WorkItemRef | null> {
  const [msg] = await db
    .select({ threadId: message.threadId, createdAt: message.createdAt })
    .from(message)
    .where(and(eq(message.id, input.messageId), eq(message.transportId, input.transportId)))
    .limit(1);
  const latest = await latestSucceededRead(db, input.messageId);
  if (!msg || !latest) return null;
  const [reply] = await db
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.threadId, msg.threadId),
        eq(message.transportId, input.transportId),
        eq(message.direction, 'outbound'),
        gt(message.createdAt, msg.createdAt),
      ),
    )
    .limit(1);
  return ensureWorkItem(db, {
    transportId: input.transportId,
    threadId: msg.threadId,
    messageId: input.messageId,
    kind: latest.kind,
    extractionId: latest.id,
    status: reply ? 'done' : undefined,
  });
}

export type StoredWork =
  | { status: 'none' }
  | { status: 'failed'; reason: string }
  | {
      status: 'ready';
      workItemId: string;
      workItemStatus: string;
      extractionId: string;
      refs: Record<string, GroupRef>;
      analysis: StoredAnalysis;
    };

async function failureFor(db: DB, messageId: string): Promise<StoredWork> {
  const [latest] = await db
    .select({ status: mailExtraction.status, usage: mailExtraction.usage })
    .from(mailExtraction)
    .where(eq(mailExtraction.messageId, messageId))
    .orderBy(desc(mailExtraction.createdAt))
    .limit(1);
  if (!latest || latest.status !== 'failed') return { status: 'none' };
  const code = latest.usage?.failureReason;
  const copy =
    typeof code === 'string' && Object.hasOwn(FAILURE_COPY, code) ? FAILURE_COPY[code] : undefined;
  return { status: 'failed', reason: copy ?? 'Nava could not read this email.' };
}

/**
 * What the pane shows for one mail: the latest succeeded read with its work item, the latest failed read as a reason,
 * or nothing (the pane then reads the mail live). Makes no model call.
 */
export async function storedWorkFor(
  db: DB,
  input: { transportId: string; internetMessageId: string },
): Promise<StoredWork> {
  const internetMessageId = canonicalInternetMessageId(input.internetMessageId);
  if (!internetMessageId) return { status: 'none' };
  const found = await db
    .select({ id: message.id, threadId: message.threadId })
    .from(message)
    .where(and(eq(message.transportId, input.transportId), eq(message.messageIdHeader, internetMessageId)))
    .limit(2);
  const msg = found[0];
  if (!msg || found.length !== 1) return { status: 'none' };
  const latest = await latestSucceededRead(db, msg.id);
  if (!latest) return failureFor(db, msg.id);
  const item = await ensureWorkItem(db, {
    transportId: input.transportId,
    threadId: msg.threadId,
    messageId: msg.id,
    kind: latest.kind,
    extractionId: latest.id,
  });
  const stored = storedAnalysis(latest, item.state);
  return {
    status: 'ready',
    workItemId: item.id,
    workItemStatus: item.status,
    extractionId: latest.id,
    refs: stored.refs,
    analysis: stored.analysis,
  };
}

export type FieldEventResult =
  | { status: 'not_found' }
  | { status: 'invalid_path' }
  | { status: 'invalid_value' }
  | { status: 'recorded'; aiValue: unknown; value: unknown };

/**
 * Appends one field event and sets that field in the work item's state, in one transaction. ai_value is read from the
 * item's extraction by stable id. Accept stores the AI value. Edit and reject store the person's value (null clears).
 * An item in another transport reads as not found, the same as a missing one.
 */
export async function recordFieldEvent(
  db: DB,
  input: {
    transportId: string;
    workItemId: string;
    userId: string;
    type: 'field.edit' | 'field.accept' | 'field.reject';
    fieldPath: string;
    value?: unknown;
    msSinceOpen?: number;
  },
): Promise<FieldEventResult> {
  const path = parseFieldPath(input.fieldPath);
  if (!path) return { status: 'invalid_path' };
  const personValue = input.value ?? null;
  if (input.type !== 'field.accept' && !validFieldValue(path.field, personValue)) {
    return { status: 'invalid_value' };
  }
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ extractionId: workItem.extractionId, state: workItem.state })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) return { status: 'not_found' as const };
    const [read] = item.extractionId
      ? await tx
          .select({ payload: mailExtraction.payload, version: mailExtraction.extractorVersion })
          .from(mailExtraction)
          .where(eq(mailExtraction.id, item.extractionId))
          .limit(1)
      : [];
    const aiValue = aiValueAt(
      read?.payload as MailExtractionPayload | null | undefined,
      input.fieldPath,
    );
    const value = input.type === 'field.accept' ? aiValue : personValue;
    await tx.insert(workEvent).values({
      workItemId: input.workItemId,
      actorKind: 'user',
      actorUserId: input.userId,
      type: input.type,
      fieldPath: input.fieldPath,
      aiValue,
      value,
      aiSource: read?.version ?? null,
      msSinceOpen: input.msSinceOpen ?? null,
    });
    await tx
      .update(workItem)
      .set({ state: { ...item.state, [input.fieldPath]: value }, updatedAt: new Date() })
      .where(eq(workItem.id, input.workItemId));
    return { status: 'recorded' as const, aiValue, value };
  });
}

/** Dismisses an open item and logs the change. Only needs_you and review items dismiss. Null when not in transport. */
export async function dismissWorkItem(
  db: DB,
  input: { transportId: string; workItemId: string; userId: string },
): Promise<{ status: string } | null> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ status: workItem.status })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) return null;
    if (item.status !== 'needs_you' && item.status !== 'review') return { status: item.status };
    await tx
      .update(workItem)
      .set({ status: 'dismissed', updatedAt: new Date() })
      .where(eq(workItem.id, input.workItemId));
    await tx.insert(workEvent).values({
      workItemId: input.workItemId,
      actorKind: 'user',
      actorUserId: input.userId,
      type: 'status.changed',
      value: { from: item.status, to: 'dismissed' },
    });
    return { status: 'dismissed' };
  });
}

/** Work items in this transport with the given statuses, most recently changed first. */
export async function listWorkItems(
  db: DB,
  input: { transportId: string; statuses: readonly string[]; limit: number },
) {
  if (input.statuses.length === 0) return [];
  return db
    .select({
      id: workItem.id,
      kind: workItem.kind,
      status: workItem.status,
      threadId: workItem.threadId,
      sourceMessageId: workItem.sourceMessageId,
      updatedAt: workItem.updatedAt,
      subject: message.subject,
      receivedAt: message.receivedAt,
    })
    .from(workItem)
    .leftJoin(message, eq(message.id, workItem.sourceMessageId))
    .where(
      and(eq(workItem.transportId, input.transportId), inArray(workItem.status, [...input.statuses])),
    )
    .orderBy(desc(workItem.updatedAt))
    .limit(input.limit);
}
