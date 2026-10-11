import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, notExists, notInArray, or, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiWorkflowRun, mailboxTransport, mailThread, message } from '../db/schema/mail.js';
import { sqlList } from '../db/schema/hitl.js';
import { mailExtraction, TELEMETRY_EVENT_TYPES, workEvent, workItem } from '../db/schema/work.js';
import type { AttachmentRead } from './extraction/extract.js';
import type { ExtractionRow, ExtractionStay, MailExtractionPayload, MailKind } from './extraction/schema.js';
import {
  canonicalInternetMessageId,
  documentFailureItems,
  questionItems,
} from './quote-workflow-analyse-selection.js';
import { amendmentFromAnalysis, mapLlmDecision, validIsoDate } from './quote-workflow-llm.js';
import { normalizeEmailAddress, PUBLIC_MAIL_DOMAINS } from './never-spam.js';
import { isNoReplyAddress } from '../mail/conversation-signals.js';
import type { LunaAnalysis } from './reservationist-decision.js';

/**
 * Work items for the Nava pane (U4). One work item is one person's job on one mail. Its `state` holds only the field
 * paths a person has touched, so a re-extraction never overwrites a person's value: every other value reads through
 * from the latest succeeded extraction. Paths use the extraction's stable ids (`stays[s_x].requested.arrival`,
 * `stays[s_x].rows[r_y].count`), so deleting one stay never shifts another stay's AI value. A path on an id the
 * extraction does not have is a stay or row the person added, and `stays[s_x].removed` / `...rows[r_y].removed`
 * (true) is one she deleted. Both come back on reopen.
 *
 * The contact block (U16) uses `contact.name`, `contact.company`, `contact.endClient`, `contact.email` and
 * `contact.phone`. `contact.company` reads the extraction's agency. The other fields read their extraction values.
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

/**
 * The contact block's fields (U16). Paths are `contact.<field>`. `company` is the sender's organisation, which the
 * extraction calls the agency, so its AI value is `agency`.
 */
export const CONTACT_FIELDS = ['name', 'company', 'endClient', 'email', 'phone'] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];
export type StoredContact = Record<ContactField, string | null>;
const CONTACT_PATH = new RegExp(`^contact\\.(${CONTACT_FIELDS.join('|')})$`);

export function contactFieldOf(path: string): ContactField | null {
  const match = CONTACT_PATH.exec(path);
  return match ? (match[1] as ContactField) : null;
}

function contactAiValue(payload: MailExtractionPayload | null | undefined, field: ContactField): string | null {
  if (!payload) return null;
  switch (field) {
    case 'name':
      return payload.contact.name;
    case 'company':
      return payload.agency;
    case 'endClient':
      return payload.endClient;
    case 'email':
      return payload.contact.email;
    case 'phone':
      return payload.contact.phone;
  }
}

/** A contact value is text up to the extraction's cap, or null to clear it. */
function validContactValue(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length <= 200);
}

/** The contact block's values: her value where she has set one, else the read's. */
export function storedContact(payload: MailExtractionPayload, state: WorkState): StoredContact {
  const valueOf = (field: ContactField): string | null => {
    const key = `contact.${field}`;
    return Object.hasOwn(state, key) ? (state[key] as string | null) : contactAiValue(payload, field);
  };
  return {
    name: valueOf('name'),
    company: valueOf('company'),
    endClient: valueOf('endClient'),
    email: valueOf('email'),
    phone: valueOf('phone'),
  };
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
  const contact = contactFieldOf(path);
  if (contact) return contactAiValue(payload, contact);
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
    // The booking as it stands comes from the booked dates only. A missing booked date stays null: the requested
    // stay never stands in for it, so the HMS lookup cannot match on the wrong day (AE2).
    arrival: validIsoDate(booked?.arrival ?? null) ?? null,
    departure: validIsoDate(booked?.departure ?? null) ?? null,
    requestedArrival: validIsoDate(requested?.arrival ?? null) ?? null,
    requestedDeparture: validIsoDate(requested?.departure ?? null) ?? null,
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
      // "Not stated yet" saves null. Mapping fills a null board with the default, so her cleared choice is put back.
      if (Object.hasOwn(state, `${rowPath}.board`) && state[`${rowPath}.board`] === null) group.board = 'unknown';
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

type WorkTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export type WorkItemRef = { id: string; status: string; state: WorkState; extractionId: string | null };

function sameDates(a: { arrival: string | null; departure: string | null }, b: typeof a): boolean {
  return a.arrival === b.arrival && a.departure === b.departure;
}

/**
 * Whether an entry keeps its meaning under the same id in the next read. Ids come from positions, so a read that drops
 * or reorders entries gives an id to another entry. An entry whose own value is now under another id, or whose id now
 * holds another old entry's value, has moved. Same id with a re-read value (a corrected date) is the same entry.
 */
function sameSlot<T extends { id: string }>(id: string, before: T[], after: T[], same: (a: T, b: T) => boolean): boolean {
  const was = before.find((item) => item.id === id);
  if (!was) return true; // a stay or row she added: its id is hers, not a position
  const now = after.find((item) => item.id === id);
  if (!now) return false;
  if (same(was, now)) return true;
  if (after.some((item) => item.id !== id && same(item, was))) return false;
  return !before.some((item) => item.id !== id && same(item, now));
}

/** Two rows of one type can differ only in occupancy or board, so a row is matched on every value the read gives it. */
function sameRow(a: ExtractionRow, b: ExtractionRow): boolean {
  return (
    a.roomType === b.roomType &&
    a.rooms === b.rooms &&
    a.adultsPerRoom === b.adultsPerRoom &&
    a.board === b.board &&
    a.childAges.join(',') === b.childAges.join(',')
  );
}

/**
 * Whether her saved stay and row values still land on the same stays and rows in the next read. When a read drops or
 * reorders entries they would land on another stay, so the work item stays on the read she corrected.
 */
export function correctionsCarryTo(
  before: MailExtractionPayload,
  after: MailExtractionPayload,
  state: WorkState,
): boolean {
  for (const key of Object.keys(state)) {
    const path = parseFieldPath(key);
    if (!path) continue;
    if (!sameSlot(path.stayId, before.stays, after.stays, (a, b) => sameDates(a.requested, b.requested))) return false;
    if (path.rowId === null) continue;
    const rowsBefore = before.stays.find((stay) => stay.id === path.stayId)?.rows ?? [];
    const rowsAfter = after.stays.find((stay) => stay.id === path.stayId)?.rows ?? [];
    if (!sameSlot(path.rowId, rowsBefore, rowsAfter, sameRow)) return false;
  }
  return true;
}

/**
 * Whether the item moves from its read to `nextId`. Never to an older read (a slow caller can hold an old one), and
 * never when her saved values would land on other stays or rows in the next read.
 */
async function shouldRelink(db: WorkTx, fromId: string | null, nextId: string, state: WorkState): Promise<boolean> {
  if (!fromId) return true;
  const reads = await db
    .select({ id: mailExtraction.id, createdAt: mailExtraction.createdAt, payload: mailExtraction.payload })
    .from(mailExtraction)
    .where(inArray(mailExtraction.id, [fromId, nextId]));
  const from = reads.find((read) => read.id === fromId);
  const next = reads.find((read) => read.id === nextId);
  if (!next) return false;
  if (!from) return true;
  if (next.createdAt < from.createdAt) return false;
  if (!from.payload || !next.payload) return true;
  return correctionsCarryTo(from.payload as MailExtractionPayload, next.payload as MailExtractionPayload, state);
}

/**
 * Upserts the work item for (thread, kind, source message) and points it at this extraction when it is newer and her
 * saved values still fit it (see shouldRelink). Only the extraction link moves. `state` is never written here, so a
 * person's values survive a re-read. Returns the read the item is on.
 */
export async function ensureWorkItem(
  db: DB,
  input: {
    transportId: string;
    threadId: string;
    messageId: string;
    kind: MailKind;
    extractionId: string;
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
    })
    .onConflictDoNothing({ target: [workItem.threadId, workItem.kind, workItem.sourceMessageId] });
  const select = (tx: WorkTx) =>
    tx
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
  const [current] = await select(db);
  if (!current) throw new Error('work item missing after upsert');
  if (current.extractionId === input.extractionId) return current;
  // The row lock holds off a field save (recordFieldEvent locks the same row) between the check and the move, so a
  // value she saves meanwhile is never carried onto a read it was not checked against.
  return db.transaction(async (tx) => {
    const [row] = await select(tx).for('update');
    if (!row) throw new Error('work item missing after upsert');
    if (row.extractionId === input.extractionId) return row;
    if (!(await shouldRelink(tx, row.extractionId, input.extractionId, row.state))) return row;
    await tx
      .update(workItem)
      .set({ extractionId: input.extractionId, updatedAt: new Date() })
      .where(eq(workItem.id, row.id));
    return { ...row, extractionId: input.extractionId };
  });
}

/**
 * An outbound message sent after `at`. A Nava send has no sentAt until delivery is confirmed, so a queued or failed send
 * is not a reply. Imported Outlook history keeps its sent time in receivedAt when sentAt is missing.
 */
export function outboundSentAfter(at: Date) {
  return or(
    gt(message.sentAt, at),
    and(isNull(message.sentAt), eq(message.historyOnly, true), gt(message.receivedAt, at)),
  );
}

/**
 * Outlook sync created the row: persistOutlookHistory stamps canonicalContentVersion on every row it inserts, and never
 * on a row POP3 created. POP3 matching an imported row later adds a pop3Uidl but keeps its dates and provenance, so
 * receivedAt stays Outlook's delivery time.
 */
export const OUTLOOK_SYNCED = sql<boolean>`(${message.sourceProvenance}->>'canonicalContentVersion') is not null`;

/**
 * When an inbound message reached the mailbox. POP3 stores the sender's Date header in receivedAt, which can be hours
 * before (or, with a wrong clock, after) delivery, so a row POP3 created arrived when Nava fetched it. Outlook sync
 * stores Outlook's delivery time in receivedAt, which holds for history imported long after and for an imported row
 * POP3 matched later (its createdAt is the import time). With neither, the stored time.
 */
export function messageArrivedAt(m: {
  receivedAt: Date | null;
  createdAt: Date;
  pop3Uidl: string | null;
  outlookSynced: boolean;
}): Date {
  return m.pop3Uidl === null || m.outlookSynced ? (m.receivedAt ?? m.createdAt) : m.createdAt;
}

/** SQL twin of messageArrivedAt, for a `message` row. */
export const MESSAGE_ARRIVED_AT = sql`case when ${message.pop3Uidl} is null or ${OUTLOOK_SYNCED} then coalesce(${message.receivedAt}, ${message.createdAt}) else ${message.createdAt} end`;

/** The message's latest succeeded read, or the one with `id` when given. */
async function succeededRead(db: DB, messageId: string, id?: string) {
  const [row] = await db
    .select()
    .from(mailExtraction)
    .where(
      and(
        eq(mailExtraction.messageId, messageId),
        eq(mailExtraction.status, 'succeeded'),
        id ? eq(mailExtraction.id, id) : undefined,
      ),
    )
    .orderBy(desc(mailExtraction.createdAt))
    .limit(1);
  if (!row?.kind || !row.payload) return null;
  return {
    id: row.id,
    createdAt: row.createdAt,
    kind: row.kind as MailKind,
    payload: row.payload as MailExtractionPayload,
    attachments: row.attachments as AttachmentRead[] | null,
    language: row.language,
    translation: row.translation,
  };
}

/**
 * Points the message's work item at its latest succeeded read. A message with no succeeded read has none, and spam
 * never gets one (nobody has work to do on it). A thread with a staff reply sent after this message arrived is already
 * answered, so a new item starts done, not needs_you. Both sides use mail event times (see messageArrivedAt), not
 * import order.
 */
export async function ensureWorkItemForMessage(
  db: DB,
  input: { transportId: string; messageId: string },
): Promise<WorkItemRef | null> {
  const [msg] = await db
    .select({
      threadId: message.threadId,
      receivedAt: message.receivedAt,
      createdAt: message.createdAt,
      pop3Uidl: message.pop3Uidl,
      outlookSynced: OUTLOOK_SYNCED,
    })
    .from(message)
    .where(and(eq(message.id, input.messageId), eq(message.transportId, input.transportId)))
    .limit(1);
  const latest = await succeededRead(db, input.messageId);
  if (!msg || !latest || latest.kind === 'spam') return null;
  const item = await ensureWorkItem(db, {
    transportId: input.transportId,
    threadId: msg.threadId,
    messageId: input.messageId,
    kind: latest.kind,
    extractionId: latest.id,
  });
  const current =
    item.status === 'dismissed'
      ? await restoreSupersededItem(db, { workItemId: item.id, status: 'needs_you', latestId: latest.id })
      : item;
  await dismissSupersededItems(db, {
    transportId: input.transportId,
    threadId: msg.threadId,
    messageId: input.messageId,
    latest,
  });
  // A reply already on the thread closes the item here, and a newer request supersedes it (see refreshThreadWork).
  if (msg.threadId) await refreshThreadWork(db, { transportId: input.transportId, threadId: msg.threadId });
  const [fresh] = await db
    .select({ id: workItem.id, status: workItem.status, state: workItem.state, extractionId: workItem.extractionId })
    .from(workItem)
    .where(eq(workItem.id, current.id))
    .limit(1);
  return fresh ?? current;
}

/** The reason on a system dismissal of an item a kind-changing re-read replaced. */
const SUPERSEDED_READ = 'superseded_read';
/** The reason on a system dismissal of an older item a newer needs-you item on the same thread superseded (C3). */
const SUPERSEDED_BY_THREAD = 'superseded_by_thread';
/** The reasons on the thread's system status changes (refreshThreadWork). */
const HOTEL_REPLIED = 'hotel_replied';
const NEW_INBOUND = 'new_inbound';
const STAFF_SENT_OTHER = 'staff_sent_other';

/**
 * A later read can come back to a kind an earlier re-read moved away from (quote, other, quote). The item for that kind
 * was dismissed as superseded, so it is put back, with a system event, unless its last status change was someone's
 * own: a person's dismissal stands. An item the thread collapse dismissed (superseded_by_thread) comes back the same way;
 * refreshThreadWork dismisses it again straight away while a newer needs-you item is still on the thread.
 */
async function restoreSupersededItem(
  db: DB,
  input: { workItemId: string; status: 'needs_you' | 'done'; latestId: string },
): Promise<WorkItemRef> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: workItem.id, status: workItem.status, state: workItem.state, extractionId: workItem.extractionId })
      .from(workItem)
      .where(eq(workItem.id, input.workItemId))
      .limit(1)
      .for('update');
    if (!row) throw new Error('work item missing');
    if (row.status !== 'dismissed') return row;
    const [last] = await tx
      .select({ actorKind: workEvent.actorKind, value: workEvent.value })
      .from(workEvent)
      .where(and(eq(workEvent.workItemId, row.id), eq(workEvent.type, 'status.changed')))
      .orderBy(desc(workEvent.at), desc(workEvent.id))
      .limit(1);
    const reason = (last?.value as { reason?: unknown } | null | undefined)?.reason;
    const superseded =
      last?.actorKind === 'system' && (reason === SUPERSEDED_READ || reason === SUPERSEDED_BY_THREAD);
    if (!superseded) return row;
    await tx
      .update(workItem)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(workItem.id, row.id));
    await tx.insert(workEvent).values({
      workItemId: row.id,
      actorKind: 'system',
      type: 'status.changed',
      value: { from: 'dismissed', to: input.status, reason: 'kind_returned', extractionId: input.latestId },
    });
    return { ...row, status: input.status };
  });
}

/**
 * A newer read that changes the kind gets its own work item, so the item made from the older read would stay in Needs
 * you beside it. That older item is dismissed, with a system event, only while nobody has touched it: still needs_you,
 * no saved values, no decision from a person (TELEMETRY_EVENT_TYPES do not count), and on a read older than the latest.
 * Anything else is left as it is.
 */
async function dismissSupersededItems(
  db: DB,
  input: {
    transportId: string;
    threadId: string;
    messageId: string;
    latest: { id: string; kind: MailKind; createdAt: Date };
  },
): Promise<void> {
  const staleItems = (tx: WorkTx) =>
    tx
      .select({ id: workItem.id })
      .from(workItem)
      .innerJoin(mailExtraction, eq(mailExtraction.id, workItem.extractionId))
      .where(
        and(
          eq(workItem.transportId, input.transportId),
          eq(workItem.threadId, input.threadId),
          eq(workItem.sourceMessageId, input.messageId),
          ne(workItem.kind, input.latest.kind),
          eq(workItem.status, 'needs_you'),
          sql`${workItem.state} = '{}'::jsonb`,
          lt(mailExtraction.createdAt, input.latest.createdAt),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(workEvent)
              .where(
                and(
                  eq(workEvent.workItemId, workItem.id),
                  eq(workEvent.actorKind, 'user'),
                  notInArray(workEvent.type, [...TELEMETRY_EVENT_TYPES]),
                ),
              ),
          ),
        ),
      );
  // Most calls find nothing, so the lock is only taken when there is something to dismiss.
  if (!(await staleItems(db)).length) return;
  await db.transaction(async (tx) => {
    // The row lock holds off a field save (recordFieldEvent locks the same row) between this check and the update.
    const stale = await staleItems(tx).for('update', { of: workItem });
    if (!stale.length) return;
    const ids = stale.map((row) => row.id);
    await tx
      .update(workItem)
      .set({ status: 'dismissed', updatedAt: new Date() })
      .where(inArray(workItem.id, ids));
    await tx.insert(workEvent).values(
      ids.map((workItemId) => ({
        workItemId,
        actorKind: 'system' as const,
        type: 'status.changed' as const,
        value: { from: 'needs_you', to: 'dismissed', reason: SUPERSEDED_READ, extractionId: input.latest.id },
      })),
    );
  });
}

/** One mail on a thread, with the fields the thread rules read. */
type ThreadMail = {
  id: string;
  direction: 'inbound' | 'outbound';
  fromAddress: string;
  receivedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  historyOnly: boolean;
  pop3Uidl: string | null;
  outlookSynced: boolean;
};

/** When an inbound mail reached the mailbox, by the rule every work item order uses (messageArrivedAt). */
function arrivedAt(m: ThreadMail): number {
  return messageArrivedAt(m).getTime();
}

/**
 * When a hotel mail left, counted as outboundSentAfter counts it: its sent time, or a history row's received time. A
 * queued or failed Nava send has neither, so it is not a reply.
 */
function leftAt(m: ThreadMail): number | null {
  const at = m.sentAt ?? (m.historyOnly ? m.receivedAt : null);
  return at ? at.getTime() : null;
}

/**
 * From the mailbox's own address, or from its domain when that domain is the hotel's. On a public provider (gmail.com,
 * outlook.com, ...) the domain is shared by every sender, so only the exact mailbox address counts there.
 * ponytail: aliases are not checked.
 */
function isStaffSender(fromAddress: string, mailboxEmail: string): boolean {
  const from = normalizeEmailAddress(fromAddress);
  const mailbox = normalizeEmailAddress(mailboxEmail);
  if (!from.includes('@') || !mailbox.includes('@')) return false;
  if (from === mailbox) return true;
  const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);
  const domain = domainOf(mailbox);
  return !PUBLIC_MAIL_DOMAINS.has(domain) && domainOf(from) === domain;
}

/**
 * One status change the thread's work makes. `repoint` moves the reply link of an item a reply already closed to the
 * hotel's latest answer, and changes no status.
 */
export type ThreadWorkChange =
  | { workItemId: string; kind: MailKind; to: 'done'; reason: typeof HOTEL_REPLIED; sentAt: Date; sentMessageId: string }
  | { workItemId: string; kind: MailKind; to: 'done'; reason: typeof STAFF_SENT_OTHER }
  | { workItemId: string; kind: MailKind; to: 'needs_you'; reason: typeof NEW_INBOUND; previousSentMessageId: string | null }
  | { workItemId: string; kind: MailKind; to: 'dismissed'; reason: typeof SUPERSEDED_BY_THREAD; supersededBy: string }
  | { workItemId: string; kind: MailKind; repoint: { sentAt: Date; sentMessageId: string } };

/**
 * The status changes the thread's work needs, read from its mail and items. A change only touches an untouched item: no
 * decision from a person (TELEMETRY_EVENT_TYPES do not count) and no saved values. Rules, on the source mail's time
 * (arrivedAt):
 * - Reply link (C2): a needs-you item is done (hotel_replied, sent_at and sent_message_id set) when the hotel's latest
 *   mail after it is later than the guest's latest mail after it. The hotel's mail is an outbound one, or an inbound one
 *   from the mailbox's own address or domain (a copy of its reply, counted by when it left). A guest mail is any other
 *   inbound one, counted by when it arrived, so an own-domain copy never reopens an item. A done item a later guest mail
 *   reopens goes back to needs-you (new_inbound), and its reply link moves to the hotel's next answer. A done item with
 *   no reply link (closed before the link existed) gets the same treatment, with the hotel's latest answer as its link.
 *   A person's close stays.
 * - Same-thread collapse (C3): an older needs-you item is dismissed (superseded_by_thread) when a newer needs-you item of
 *   any kind but other is on the thread. A newer "other" mail never supersedes a request.
 * - Staff-sent other: an "other" mail from the mailbox's own address or domain gets no needs-you (done, staff_sent_other).
 * Makes no writes. Items of kind spam are left out.
 */
export async function planThreadWork(
  db: WorkTx,
  input: { transportId: string; threadId: string },
  opts: { lock?: boolean } = {},
): Promise<ThreadWorkChange[]> {
  // The item rows are locked before the mail is read (when asked), so the mail matches the items the plan changes. A live
  // admission that reopens an item waits on this lock, and the mail it committed is in the read below.
  const itemQuery = db
    .select({
      id: workItem.id,
      kind: workItem.kind,
      status: workItem.status,
      sourceMessageId: workItem.sourceMessageId,
      sentAt: workItem.sentAt,
      sentMessageId: workItem.sentMessageId,
      state: workItem.state,
      // Written with explicit table names: drizzle leaves the columns of a select-list subquery unqualified, and then
      // "id" binds to the subquery's own table and the check is always false.
      touched: sql<boolean>`exists (select 1 from ${workEvent} as we where we.work_item_id = ${workItem}.id and we.actor_kind = 'user' and we.type not in (${sqlList(TELEMETRY_EVENT_TYPES)}))`,
    })
    .from(workItem)
    .where(
      and(
        eq(workItem.transportId, input.transportId),
        eq(workItem.threadId, input.threadId),
        inArray(workItem.status, ['needs_you', 'done']),
        ne(workItem.kind, 'spam'),
      ),
    );
  const items = await (opts.lock ? itemQuery.for('update', { of: workItem }) : itemQuery);
  const [mailbox] = await db
    .select({ email: mailboxTransport.email })
    .from(mailboxTransport)
    .where(eq(mailboxTransport.id, input.transportId))
    .limit(1);
  const mail: ThreadMail[] = await db
    .select({
      id: message.id,
      direction: message.direction,
      fromAddress: message.fromAddress,
      receivedAt: message.receivedAt,
      sentAt: message.sentAt,
      createdAt: message.createdAt,
      historyOnly: message.historyOnly,
      pop3Uidl: message.pop3Uidl,
      outlookSynced: OUTLOOK_SYNCED,
    })
    .from(message)
    .where(and(eq(message.transportId, input.transportId), eq(message.threadId, input.threadId)));

  const byId = new Map(mail.map((m) => [m.id, m]));
  // The hotel's own mail lands as inbound too (a sent-item copy or a CC), so it is the hotel's answer, not a guest's.
  const mailboxEmail = mailbox?.email ?? '';
  const ownMail = (m: ThreadMail) => isStaffSender(m.fromAddress, mailboxEmail);
  const guest = mail.flatMap((m) => (m.direction === 'inbound' && !ownMail(m) ? [{ m, at: arrivedAt(m) }] : []));
  const hotel = mail.flatMap((m) => {
    const at = m.direction === 'outbound' || ownMail(m) ? leftAt(m) : null;
    return at === null ? [] : [{ m, at }];
  });
  // A tie (a copy has the reply's sent time) goes to the outbound row, then the lower id, so a rerun never moves a link.
  const later = <T extends { at: number; m: ThreadMail }>(a: T, b: T) =>
    a.at !== b.at ? a.at > b.at : a.m.direction !== b.m.direction ? a.m.direction === 'outbound' : a.m.id < b.m.id;
  const latest = <T extends { at: number; m: ThreadMail }>(rows: T[]) =>
    rows.reduce<T | undefined>((best, row) => (!best || later(row, best) ? row : best), undefined);
  const changes: ThreadWorkChange[] = [];
  // The items that are needs-you once these changes land. Only untouched ones can be superseded.
  const open: Array<{ id: string; kind: MailKind; at: number; untouched: boolean }> = [];
  for (const item of items) {
    const source = item.sourceMessageId ? byId.get(item.sourceMessageId) : undefined;
    if (!source) continue;
    const kind = item.kind as MailKind;
    const at = arrivedAt(source);
    const untouched = !item.touched && Object.keys(item.state ?? {}).length === 0;
    if (!untouched) {
      if (item.status === 'needs_you') open.push({ id: item.id, kind, at, untouched: false });
      continue;
    }
    const lastGuest = latest(guest.filter((x) => x.at > at));
    const lastHotel = latest(hotel.filter((x) => x.at > at));
    // ponytail: any hotel mail after the request counts as its answer, an acknowledgement included. No content check.
    const answered = lastHotel !== undefined && (lastGuest === undefined || lastHotel.at > lastGuest.at);
    const staffOther = kind === 'other' && ownMail(source);
    if (item.status === 'needs_you') {
      if (staffOther) {
        changes.push({ workItemId: item.id, kind, to: 'done', reason: STAFF_SENT_OTHER });
      } else if (lastHotel && answered) {
        changes.push({
          workItemId: item.id,
          kind,
          to: 'done',
          reason: HOTEL_REPLIED,
          sentAt: new Date(lastHotel.at),
          sentMessageId: lastHotel.m.id,
        });
      } else {
        open.push({ id: item.id, kind, at, untouched: true });
      }
    } else if (!staffOther) {
      // Closed by a hotel reply: reopened by a later guest mail, or re-pointed at the hotel's latest answer. A done row the
      // rules closed before the reply link existed has no link, so the hotel's latest answer stands in for it (the
      // backfill links it). Only a row a person touched is left alone, as above.
      const linkedAt = item.sentAt ? item.sentAt.getTime() : lastHotel?.at;
      if (lastGuest && linkedAt !== undefined && lastGuest.at > linkedAt && !answered) {
        changes.push({
          workItemId: item.id,
          kind,
          to: 'needs_you',
          reason: NEW_INBOUND,
          previousSentMessageId: item.sentMessageId,
        });
        open.push({ id: item.id, kind, at, untouched: true });
      } else if (lastHotel && answered && lastHotel.m.id !== item.sentMessageId) {
        changes.push({
          workItemId: item.id,
          kind,
          repoint: { sentAt: new Date(lastHotel.at), sentMessageId: lastHotel.m.id },
        });
      }
    }
  }
  for (const older of open.filter((x) => x.untouched)) {
    const newer = open.find((x) => x.id !== older.id && x.at > older.at && x.kind !== 'other');
    if (newer) {
      changes.push({
        workItemId: older.id,
        kind: older.kind,
        to: 'dismissed',
        reason: SUPERSEDED_BY_THREAD,
        supersededBy: newer.id,
      });
    }
  }
  return changes;
}

async function applyThreadWorkChange(tx: WorkTx, change: ThreadWorkChange): Promise<void> {
  const now = new Date();
  // A changed reply link clears the quote follow-up clock: the sweep (quote-followup) starts it again from the new link.
  if ('repoint' in change) {
    await tx
      .update(workItem)
      .set({
        sentAt: change.repoint.sentAt,
        sentMessageId: change.repoint.sentMessageId,
        followUpDueAt: null,
        updatedAt: now,
      })
      .where(eq(workItem.id, change.workItemId));
    // The quote clock keys on a recorded hotel_replied close (CLOSED_BY_HOTEL_REPLY). A done item closed before the reply
    // link existed has none, so its link records one, as the other close does. A link that moves on a close already
    // recorded needs no second event.
    const [recorded] = await tx
      .select({ id: workEvent.id })
      .from(workEvent)
      .where(
        and(
          eq(workEvent.workItemId, change.workItemId),
          eq(workEvent.type, 'status.changed'),
          sql`${workEvent.value}->>'reason' = ${HOTEL_REPLIED}`,
        ),
      )
      .limit(1);
    if (!recorded) {
      await tx.insert(workEvent).values({
        workItemId: change.workItemId,
        actorKind: 'system',
        type: 'status.changed',
        value: { from: 'done', to: 'done', reason: HOTEL_REPLIED, sentMessageId: change.repoint.sentMessageId },
      });
    }
    return;
  }
  const from = change.to === 'needs_you' ? 'done' : 'needs_you';
  const link =
    change.to === 'done' && change.reason === HOTEL_REPLIED
      ? { sentAt: change.sentAt, sentMessageId: change.sentMessageId, followUpDueAt: null }
      : change.to === 'needs_you'
        ? { sentAt: null, sentMessageId: null, followUpDueAt: null }
        : {};
  await tx
    .update(workItem)
    .set({ status: change.to, ...link, updatedAt: now })
    .where(eq(workItem.id, change.workItemId));
  const detail =
    change.to === 'needs_you'
      ? { sentMessageId: change.previousSentMessageId }
      : change.to === 'dismissed'
        ? { supersededBy: change.supersededBy }
        : change.to === 'done' && change.reason === HOTEL_REPLIED
          ? { sentMessageId: change.sentMessageId }
          : {};
  await tx.insert(workEvent).values({
    workItemId: change.workItemId,
    actorKind: 'system',
    type: 'status.changed',
    value: { from, to: change.to, reason: change.reason, ...detail },
  });
}

/**
 * Applies planThreadWork for one thread: the reply link (C2), the same-thread collapse (C3) and the staff-sent other rule.
 * The plan is read again under the item row locks, the same lock a field save or a dismissal takes, so nothing a person
 * touched after the first read is changed. Takes the lock only when there is something to change. Returns the changes made.
 */
export async function refreshThreadWork(
  db: DB,
  input: { transportId: string; threadId: string },
): Promise<ThreadWorkChange[]> {
  if (!(await planThreadWork(db, input)).length) return [];
  return db.transaction(async (tx) => {
    const changes = await planThreadWork(tx, input, { lock: true });
    for (const change of changes) await applyThreadWorkChange(tx, change);
    return changes;
  });
}

/** What the pane shows of a stored translation (U16). A translation that is neither succeeded nor failed reads as none. */
export type StoredTranslation =
  | { status: 'succeeded'; segments: Array<{ clean: string; literal: string }>; truncated: boolean }
  | { status: 'failed' }
  | null;

export function storedTranslation(raw: unknown): StoredTranslation {
  const stored = raw as { status?: unknown; segments?: unknown; truncated?: unknown } | null;
  if (stored?.status === 'failed') return { status: 'failed' };
  if (stored?.status !== 'succeeded' || !Array.isArray(stored.segments)) return null;
  const segments = stored.segments.flatMap((item: { clean?: unknown; literal?: unknown } | null) =>
    typeof item?.clean === 'string' && typeof item.literal === 'string'
      ? [{ clean: item.clean, literal: item.literal }]
      : [],
  );
  return { status: 'succeeded', segments, truncated: stored.truncated === true };
}

export type StoredWork =
  | { status: 'none' }
  | { status: 'failed'; reason: string }
  | {
      status: 'ready';
      /** Null when the read has no work item yet. The pane then opens one (openStoredWork) before it logs edits. */
      workItemId: string | null;
      workItemStatus: string | null;
      extractionId: string;
      refs: Record<string, GroupRef>;
      /** noReplySender: the sender is an automated mailbox, so the pane shows no reply controls (as the live read). */
      analysis: StoredAnalysis & { noReplySender: boolean };
      contact: StoredContact;
      /** The read's source language (ISO 639-1), or null when unclear. */
      language: string | null;
      translation: StoredTranslation;
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

/** The one message in this transport with this Message-ID, or null (none, or not unique). */
async function messageFor(db: DB, input: { transportId: string; internetMessageId: string }) {
  const internetMessageId = canonicalInternetMessageId(input.internetMessageId);
  if (!internetMessageId) return null;
  const found = await db
    .select({ id: message.id, threadId: message.threadId, fromAddress: message.fromAddress })
    .from(message)
    .where(and(eq(message.transportId, input.transportId), eq(message.messageIdHeader, internetMessageId)))
    .limit(2);
  return found.length === 1 ? found[0]! : null;
}

type ReadyRead = NonNullable<Awaited<ReturnType<typeof succeededRead>>>;

/** The pane's ready view of a read with her saved values. The item can stay on an earlier read (see ensureWorkItem). */
async function readyView(
  db: DB,
  msg: { id: string; fromAddress: string | null },
  latest: ReadyRead,
  item: Pick<WorkItemRef, 'id' | 'status' | 'state' | 'extractionId'> | null,
): Promise<StoredWork> {
  const messageId = msg.id;
  const read =
    item?.extractionId && item.extractionId !== latest.id
      ? ((await succeededRead(db, messageId, item.extractionId)) ?? latest)
      : latest;
  const state = item?.state ?? {};
  const stored = storedAnalysis(read, state);
  return {
    status: 'ready',
    workItemId: item?.id ?? null,
    workItemStatus: item?.status ?? null,
    extractionId: read.id,
    refs: stored.refs,
    // As the live read does (quote-workflow route): a do-not-reply sender gets no reply controls.
    analysis: { ...stored.analysis, noReplySender: isNoReplyAddress(msg.fromAddress) },
    contact: storedContact(read.payload, state),
    language: read.language,
    translation: storedTranslation(read.translation),
  };
}

/**
 * What the pane shows for one mail: the latest succeeded read with its work item, the latest failed read as a reason,
 * or nothing (the pane then reads the mail live). A read only: no model call, and no row is written. The inbound run
 * makes the work item when it stores the read; a read without one comes back with a null workItemId.
 */
export async function storedWorkFor(
  db: DB,
  input: { transportId: string; internetMessageId: string },
): Promise<StoredWork> {
  const msg = await messageFor(db, input);
  if (!msg) return { status: 'none' };
  const latest = await succeededRead(db, msg.id);
  if (!latest) return failureFor(db, msg.id);
  const [item] = await db
    .select({ id: workItem.id, status: workItem.status, state: workItem.state, extractionId: workItem.extractionId })
    .from(workItem)
    .where(
      and(
        eq(workItem.transportId, input.transportId),
        eq(workItem.threadId, msg.threadId),
        eq(workItem.kind, latest.kind),
        eq(workItem.sourceMessageId, msg.id),
      ),
    )
    .limit(1);
  return readyView(db, msg, latest, item ?? null);
}

/**
 * The same view, after making sure the read has its work item and points it at the latest read it can (ensureWorkItem).
 * The pane calls this once, only when storedWorkFor found a read with no work item, so her edits have an item to land on.
 */
export async function openStoredWork(
  db: DB,
  input: { transportId: string; internetMessageId: string },
): Promise<StoredWork> {
  const msg = await messageFor(db, input);
  if (!msg) return { status: 'none' };
  const latest = await succeededRead(db, msg.id);
  if (!latest) return failureFor(db, msg.id);
  const item = await ensureWorkItem(db, {
    transportId: input.transportId,
    threadId: msg.threadId,
    messageId: msg.id,
    kind: latest.kind,
    extractionId: latest.id,
  });
  return readyView(db, msg, latest, item);
}

export type FieldEventResult =
  | { status: 'not_found' }
  | { status: 'invalid_path' }
  | { status: 'invalid_value' }
  | { status: 'recorded'; aiValue: unknown; value: unknown };

/**
 * Appends one field event and updates that field in the work item's state, in one transaction. ai_value is read from the
 * item's extraction by stable id. Edit and reject store the person's value in state (null clears). Accept stores the AI
 * value in the event only: it removes any person value on the path, so the field reads as the extraction again and is
 * never shown as a staff correction. An item in another transport reads as not found, the same as a missing one.
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
  const contact = contactFieldOf(input.fieldPath);
  const path = contact ? null : parseFieldPath(input.fieldPath);
  if (!contact && !path) return { status: 'invalid_path' };
  const personValue = input.value ?? null;
  const fits = contact ? validContactValue(personValue) : path !== null && validFieldValue(path.field, personValue);
  if (input.type !== 'field.accept' && !fits) return { status: 'invalid_value' };
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
    // state holds only a person's values. An accept clears the path, so the AI value shows as the extraction.
    const state = { ...item.state };
    if (input.type === 'field.accept') delete state[input.fieldPath];
    else state[input.fieldPath] = value;
    await tx.update(workItem).set({ state, updatedAt: new Date() }).where(eq(workItem.id, input.workItemId));
    return { status: 'recorded' as const, aiValue, value };
  });
}

/**
 * Logs field.accept for each extraction field a person proceeded with and never edited (v5 B2). A path that already has
 * an edit, reject or accept is skipped, as is one the extraction has no value for. The accepted value is the AI value.
 * It is an event only, never a state value (see recordFieldEvent), so an accepted field is not shown as a staff
 * correction when the read is reopened. Paths outside the item's extraction shape are ignored.
 */
export async function acceptUneditedFields(
  db: DB,
  input: { transportId: string; workItemId: string; userId: string; fieldPaths: string[] },
): Promise<{ status: 'not_found' } | { status: 'recorded'; accepted: number }> {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ extractionId: workItem.extractionId })
      .from(workItem)
      .where(and(eq(workItem.id, input.workItemId), eq(workItem.transportId, input.transportId)))
      .limit(1)
      .for('update');
    if (!item) return { status: 'not_found' as const };
    const paths = [...new Set(input.fieldPaths)].filter(
      (path) => !path.endsWith('.removed') && (contactFieldOf(path) !== null || parseFieldPath(path) !== null),
    );
    if (!paths.length) return { status: 'recorded' as const, accepted: 0 };
    const seen = await tx
      .select({ path: workEvent.fieldPath })
      .from(workEvent)
      .where(
        and(
          eq(workEvent.workItemId, input.workItemId),
          inArray(workEvent.type, ['field.edit', 'field.reject', 'field.accept']),
          inArray(workEvent.fieldPath, paths),
        ),
      );
    const touched = new Set(seen.map((row) => row.path));
    const [read] = item.extractionId
      ? await tx
          .select({ payload: mailExtraction.payload, version: mailExtraction.extractorVersion })
          .from(mailExtraction)
          .where(eq(mailExtraction.id, item.extractionId))
          .limit(1)
      : [];
    const accepts = paths
      .filter((path) => !touched.has(path))
      .map((path) => ({
        path,
        aiValue: aiValueAt(read?.payload as MailExtractionPayload | null | undefined, path),
      }))
      .filter((accept) => accept.aiValue !== null && accept.aiValue !== undefined);
    if (!accepts.length) return { status: 'recorded' as const, accepted: 0 };
    await tx.insert(workEvent).values(
      accepts.map((accept) => ({
        workItemId: input.workItemId,
        actorKind: 'user',
        actorUserId: input.userId,
        type: 'field.accept' as const,
        fieldPath: accept.path,
        aiValue: accept.aiValue,
        value: accept.aiValue,
        aiSource: read?.version ?? null,
      })),
    );
    return { status: 'recorded' as const, accepted: accepts.length };
  });
}

/**
 * The work item the pane edits for this mail (the kind of its latest read), or null when it has none yet. Notes find
 * their item here and never open one.
 */
export async function workItemIdForMail(
  db: DB,
  input: { transportId: string; internetMessageId: string },
): Promise<string | null> {
  const msg = await messageFor(db, input);
  if (!msg) return null;
  const latest = await succeededRead(db, msg.id);
  if (!latest) return null;
  const [item] = await db
    .select({ id: workItem.id })
    .from(workItem)
    .where(
      and(
        eq(workItem.transportId, input.transportId),
        eq(workItem.threadId, msg.threadId),
        eq(workItem.kind, latest.kind),
        eq(workItem.sourceMessageId, msg.id),
      ),
    )
    .limit(1);
  return item?.id ?? null;
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

/** The chips on a Needs-you row (KTD14), in list order: the list sorts by this index, then by age. */
export const NEEDS_YOU_CHIPS = ['needs_you', 'review', 'queued', 'in_hms'] as const;
export type NeedsYouChip = (typeof NEEDS_YOU_CHIPS)[number];

/**
 * Work items in this transport with the given statuses, the Needs-you list. Spam, trashed and deleted threads are left
 * out. Queued and In HMS come from the item's latest run on the HMS lane only (KTD14), so a follow-up or extraction run
 * never moves the chip. Otherwise a review item shows Review, and anything else needs her. Rows sort by chip in
 * NEEDS_YOU_CHIPS order, then the oldest mail first.
 */
export async function listWorkItems(
  db: DB,
  input: { transportId: string; statuses: readonly string[]; limit: number },
) {
  if (input.statuses.length === 0) return [];
  const hmsRunState = sql`(select ${aiWorkflowRun.state} from ${aiWorkflowRun} where ${aiWorkflowRun.workItemId} = ${workItem.id} and ${aiWorkflowRun.executorLane} = 'hms' order by ${aiWorkflowRun.createdAt} desc limit 1)`;
  const chipRank = sql<number>`case ${hmsRunState} when 'claimed' then 3 when 'running' then 3 when 'queued' then 2 when 'retry_wait' then 2 else case when ${workItem.status} = 'review' then 1 else 0 end end`
    .mapWith(Number)
    .as('chip_rank');
  const rows = await db
    .select({
      id: workItem.id,
      kind: workItem.kind,
      status: workItem.status,
      threadId: workItem.threadId,
      sourceMessageId: workItem.sourceMessageId,
      updatedAt: workItem.updatedAt,
      sender: message.fromAddress,
      subject: message.subject,
      receivedAt: message.receivedAt,
      chipRank,
    })
    .from(workItem)
    .innerJoin(mailThread, eq(mailThread.id, workItem.threadId))
    .leftJoin(message, eq(message.id, workItem.sourceMessageId))
    .where(
      and(
        eq(workItem.transportId, input.transportId),
        inArray(workItem.status, [...input.statuses]),
        ne(workItem.kind, 'spam'),
        isNull(mailThread.spamAt),
        isNull(mailThread.trashedAt),
      ),
    )
    .orderBy(
      sql`chip_rank`,
      asc(sql`coalesce(${message.receivedAt}, ${workItem.createdAt})`),
      asc(workItem.id),
    )
    .limit(input.limit);
  return rows.map(({ chipRank: rank, ...row }) => ({
    ...row,
    chip: NEEDS_YOU_CHIPS[rank] ?? 'needs_you',
  }));
}
