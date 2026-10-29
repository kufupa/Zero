import { hasInvalidStayDates, mailExtractionPayloadSchema } from './extraction/schema.js';
import type { StaffQuoteInput } from './staff-quote-workflow.js';
import { quoteDigest, type QuoteRevision } from '../quote-proposal/quote-revision.js';
import type { DB } from '../db/client.js';
import { mailExtraction, workItem } from '../db/schema/work.js';
import { and, desc, eq } from 'drizzle-orm';
import { addDays } from './stay-date-anchoring.js';
import { formStays, parseFieldPath, storedContact } from './work-items.js';
import { getPropertyTransportIds } from '../../tooling/playwright-quote/property-registry.mjs';
import { priorKindConflict } from './work-item-source-conflict.js';
import { quoteSourcePartyDigest } from './quote-source-party.js';
import { QUOTE_HOTEL_CHANGED_MESSAGE, quotePropertyMatchesOrigin } from '../hms/hms-quote-target.js';
import { isQuoteSourceLockBusy, quoteSourceBusyError } from '../hms/quote-source-contention.js';
import { captureCurrentWitnessedRead, classifierForExtraction, withQuoteSourceSnapshot } from './workflow-classifier/source-fence.js';

type Group = Pick<StaffQuoteInput['groups'][number],
  'id' | 'arrivalDate' | 'departureDate' | 'quantity' | 'adults' | 'childrenAges' | 'childrenPerRoom'>;
type RowEvidence = { stayId: string; rowId: string; rooms: unknown; adults: unknown; count: unknown; ages: unknown };
type StayOccupancy = Pick<QuoteRevision['groups'][number],
  'arrivalDate' | 'departureDate' | 'quantity' | 'adults' | 'children' | 'childAges'>;

/**
 * Bind requested occupancy to the extraction the pane shows and its persisted staff edits.
 * An absent legacy count, a cleared value, or incomplete ages is unknown, not zero.
 */
export function childOccupancyMatchesStored(
  groups: Group[],
  payload: unknown,
  savedState: Record<string, unknown> | null | undefined,
): boolean {
  const parsed = mailExtractionPayloadSchema.safeParse(payload);
  if (!parsed.success || groups.length === 0) return false;
  const state = savedState ?? {};
  const knownStayIds = parsed.data.stays.map((stay) => stay.id);
  const rows = parsed.data.stays.flatMap((stay) => stay.rows.map((row) => ({
    stayId: stay.id,
    rowId: row.id,
    rooms: row.rooms,
    adults: row.adultsPerRoom,
    count: row.childrenPerRoom,
    ages: row.childAges,
  })));
  const stateRowPath = /^stays\[([A-Za-z0-9_-]{1,40})\]\.rows\[([A-Za-z0-9_-]{1,40})\]\.(?:count|adults|childrenPerRoom|childAges|roomType|board|removed)$/;
  // Staff-added rows do not occur in the extraction; they need explicit saved count and ages.
  const addedRows = Object.keys(state).flatMap((key): RowEvidence[] => {
    const match = stateRowPath.exec(key);
    if (!match) return [];
    const [, stayId, rowId] = match;
    if (!stayId || !rowId || rows.some((row) => row.stayId === stayId && row.rowId === rowId)) return [];
    return [{ stayId, rowId, rooms: undefined, adults: undefined, count: undefined, ages: undefined }];
  }).filter((row, index, found) => found.findIndex((item) => item.stayId === row.stayId && item.rowId === row.rowId) === index);
  const allRows: RowEvidence[] = [...rows, ...addedRows];
  const selectedRows = new Set<string>();
  const selectedStays = new Set<string>();
  const matches = groups.every((group) => {
    if (typeof group.id !== 'string' || !Array.isArray(group.childrenAges)) return false;
    // A dates-only extraction uses the stay id until the first edit creates a stable row.
    const emptyStay = parsed.data.stays.find((stay) => stay.id === group.id && stay.rows.length === 0);
    const candidates = allRows.filter((row) =>
      row.rowId === group.id || (emptyStay && row.stayId === emptyStay.id && row.rowId === `${emptyStay.id}_row`),
    );
    if (candidates.length !== 1) return false;
    const row = candidates[0]!;
    const base = `stays[${row.stayId}].rows[${row.rowId}]`;
    if (state[`stays[${row.stayId}].removed`] === true || state[`${base}.removed`] === true) return false;
    const stays = parsed.data.stays.filter((stay) => stay.id === row.stayId);
    if (stays.length > 1) return false;
    const stay = stays[0];
    const arrivalPath = `stays[${row.stayId}].requested.arrival`;
    const departurePath = `stays[${row.stayId}].requested.departure`;
    const arrival = Object.hasOwn(state, arrivalPath) ? state[arrivalPath] : stay?.requested.arrival;
    let departure = Object.hasOwn(state, departurePath) ? state[departurePath] : stay?.requested.departure;
    if (departure == null && !Object.hasOwn(state, departurePath) && typeof arrival === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(arrival) && !hasInvalidStayDates(parsed.data.missing, row.stayId, knownStayIds)) {
      const day = new Date(`${arrival}T00:00:00Z`);
      if (Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === arrival) departure = addDays(arrival, 1);
    }
    if (arrival !== group.arrivalDate || departure !== group.departureDate) return false;
    const count = Object.hasOwn(state, `${base}.childrenPerRoom`) ? state[`${base}.childrenPerRoom`] : row.count;
    const ages = Object.hasOwn(state, `${base}.childAges`) ? state[`${base}.childAges`] : row.ages;
    const roomsPath = `${base}.count`;
    const adultsPath = `${base}.adults`;
    let rooms = Object.hasOwn(state, roomsPath) ? state[roomsPath] : row.rooms;
    let adults = Object.hasOwn(state, adultsPath) ? state[adultsPath] : row.adults;
    // Mirror the pane's existing unedited defaults. A cleared field never authorizes a default.
    if (adults == null && !Object.hasOwn(state, adultsPath)) adults = 2;
    if (rooms == null && !Object.hasOwn(state, roomsPath)) {
      const activeRows = allRows.filter((candidate) => candidate.stayId === row.stayId &&
        state[`stays[${candidate.stayId}].rows[${candidate.rowId}].removed`] !== true);
      const singleRow = activeRows.length === 1;
      const previousNames = activeRows.slice(0, activeRows.indexOf(row)).reduce((total, candidate) => {
        const path = `stays[${candidate.stayId}].rows[${candidate.rowId}].count`;
        const count = Object.hasOwn(state, path) ? state[path] : candidate.rooms;
        return total + (typeof count === 'number' && count > 0 ? count : 1);
      }, 0);
      const hasGuestEvidence = row.adults != null ||
        (Object.hasOwn(state, adultsPath) && state[adultsPath] != null) ||
        (Array.isArray(ages) && ages.length > 0) ||
        (stay?.guests ?? []).filter((guest) => guest.name.trim().length > 0).length > previousNames;
      rooms = singleRow && stay?.totalRooms != null ? stay.totalRooms : hasGuestEvidence ? 1 : null;
    }
    if (rooms !== group.quantity || adults !== group.adults) return false;
    const valid = typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 6 &&
      (group.childrenPerRoom === undefined || group.childrenPerRoom === count) &&
      Array.isArray(ages) && ages.length === count &&
      ages.every((age) => typeof age === 'number' && Number.isInteger(age) && age >= 0 && age <= 17) &&
      ages.length === group.childrenAges.length && ages.every((age, index) => age === group.childrenAges[index]);
    if (valid) {
      selectedStays.add(row.stayId);
      selectedRows.add(`${row.stayId}\n${row.rowId}`);
    }
    return valid;
  });
  return matches && allRows.every((row) => !selectedStays.has(row.stayId) ||
    state[`stays[${row.stayId}].rows[${row.rowId}].removed`] === true ||
    selectedRows.has(`${row.stayId}\n${row.rowId}`));
}

/** A final document covers the active rows of this saved case, not merely one valid per-stay search. */
export function quoteDocumentMatchesStored(
  groups: Group[], payload: unknown, savedState: Record<string, unknown> | null | undefined, kind: string,
): boolean {
  const parsed = mailExtractionPayloadSchema.safeParse(payload);
  const state = savedState ?? {};
  if (!parsed.success || !childOccupancyMatchesStored(groups, payload, state)) return false;
  const action = kind === 'quote' ? 'quote_availability' : kind === 'booking' ? 'new_booking' : null;
  if (!action || parsed.data.needsAction === false || (parsed.data.action && parsed.data.action !== action)) return false;
  // The saved form's removal set uses bare ids; colliding stay/row ids must not hide an unrelated stay.
  const identities = new Map<string, string>();
  const remember = (id: string, owner: string) => {
    if (identities.has(id) && identities.get(id) !== owner) return false;
    identities.set(id, owner);
    return true;
  };
  for (const stay of parsed.data.stays) {
    if (!remember(stay.id, JSON.stringify(['stay', stay.id]))) return false;
    for (const row of stay.rows)
      if (!remember(row.id, JSON.stringify(['row', stay.id, row.id]))) return false;
  }
  for (const key of Object.keys(state)) {
    const path = parseFieldPath(key);
    if (path && (!remember(path.stayId, JSON.stringify(['stay', path.stayId])) ||
      (path.rowId !== null && !remember(path.rowId, JSON.stringify(['row', path.stayId, path.rowId]))))) return false;
  }
  const stays = formStays(parsed.data, state);
  const original = parsed.data.stays.filter((stay) => stays.some((active) => active.id === stay.id));
  // A partly assigned or mixed-action case does not prove which stays belong to this quotation.
  if (original.some((stay) => stay.action && stay.action !== action) ||
    (original.length > 1 && original.some((stay) => !stay.action))) return false;
  if (!stays.length || stays.some((stay) => !stay.rows.length)) return false;
  const rows = stays.flatMap((stay) => stay.rows.map((row) => ({
    id: row.id,
    alias: parsed.data.stays.some((source) => source.id === stay.id && !source.rows.length) &&
      row.id === `${stay.id}_row` ? stay.id : null,
  })));
  if (groups.length !== rows.length) return false;
  const used = new Set<number>();
  return groups.every((group) => {
    const matching = rows.flatMap((row, index) => row.id === group.id || row.alias === group.id ? [index] : []);
    if (matching.length !== 1 || used.has(matching[0]!)) return false;
    used.add(matching[0]!);
    return true;
  }) && used.size === rows.length;
}

export function occupancyFromRevision(revision: QuoteRevision): Group[] {
  return revision.groups.map((group) => ({
    id: group.id, arrivalDate: group.arrivalDate, departureDate: group.departureDate,
    quantity: group.quantity, adults: group.adults,
    childrenPerRoom: Number.isInteger(group.children) ? group.children : null, childrenAges: group.childAges,
  }));
}

/** Load the same extraction version and saved edits as the selected email's pane. */
async function loadChildOccupancyEvidence(
  db: DB,
  scope: QuoteSourceScope,
) {
  if (scope.lock && isCenturionQuoteScope(scope)) {
    // A pending extraction can become the newest successful read without inserting a row.
    await db.select({ id: mailExtraction.id }).from(mailExtraction)
      .where(eq(mailExtraction.messageId, scope.messageId)).orderBy(mailExtraction.id).for('share', { noWait: true });
  }
  const [latest] = await db
    .select({ id: mailExtraction.id, kind: mailExtraction.kind, payload: mailExtraction.payload })
    .from(mailExtraction)
    .where(and(eq(mailExtraction.messageId, scope.messageId), eq(mailExtraction.status, 'succeeded')))
    .orderBy(desc(mailExtraction.createdAt), desc(mailExtraction.id))
    .limit(1);
  if (!latest?.kind || !latest.payload) return null;
  // A sibling case can become conflicting while we check this one. Lock every
  // existing item for the message before checking earlier human decisions.
  if (scope.lock && isCenturionQuoteScope(scope)) {
    await db.select({ id: workItem.id }).from(workItem).where(and(
      eq(workItem.transportId, scope.transportId), eq(workItem.threadId, scope.threadId),
      eq(workItem.sourceMessageId, scope.messageId),
    )).orderBy(workItem.id).for('update', { noWait: true });
  }
  // A reclassification cannot silently discard a person's earlier work, even
  // when a caller bypasses the pane or asks for a cached quote directly.
  if (isCenturionQuoteScope(scope) && await priorKindConflict(db, { ...scope, latestKind: latest.kind })) return null;
  const itemQuery = db
    .select({ extractionId: workItem.extractionId, state: workItem.state })
    .from(workItem)
    .where(and(
      eq(workItem.transportId, scope.transportId),
      eq(workItem.threadId, scope.threadId),
      eq(workItem.sourceMessageId, scope.messageId),
      eq(workItem.kind, latest.kind),
    ))
    .limit(1);
  const [item] = await (scope.lock ? itemQuery.for('share', { noWait: true }) : itemQuery);
  // A newer read has not been adopted yet. Do not apply old corrections to that read, or keep pricing the older one.
  // The existing work-item relink decides whether edits can safely carry; once it moves, the latest evidence is used.
  // A no-item prepared quote can create a quote item at commit. A booking read needs its own booking item,
  // so holding it here avoids spending an HMS read on a result that cannot pass later source checks.
  if ((!item && scope.lock && (!scope.allowMissingWorkItem || latest.kind !== 'quote')) ||
    (item && item.extractionId !== latest.id)) return null;
  return { extractionId: latest.id, kind: latest.kind, payload: latest.payload, state: item?.state ?? {} };
}

/** The PDF contact is independent of rates and must match the saved source seen by the pane. */
export async function quoteDocumentContactIsCurrent(
  db: DB,
  scope: { transportId: string; threadId: string; messageId: string },
  seen: { name: string; email: string; phone: string } | undefined,
): Promise<boolean> {
  if (!seen) return false;
  const evidence = await loadChildOccupancyEvidence(db, scope);
  const parsed = mailExtractionPayloadSchema.safeParse(evidence?.payload);
  if (!evidence || !parsed.success) return false;
  const contact = storedContact(parsed.data, evidence.state);
  const normalized = (value: unknown, limit: number) =>
    value == null ? '' : typeof value === 'string' ? value.trim().slice(0, limit) : null;
  return seen.name === normalized(contact.name, 256) && seen.email === normalized(contact.email, 256) &&
    seen.phone === normalized(contact.phone, 128);
}

export async function childOccupancyIsCurrent(
  db: DB,
  groups: Group[],
  scope: QuoteSourceScope,
): Promise<boolean> {
  if (!isCenturionQuoteScope(scope)) return true;
  const evidence = await loadChildOccupancyEvidence(db, scope);
  return !!evidence && childOccupancyMatchesStored(groups, evidence.payload, evidence.state);
}

export const importedOfferOccupancyHold = 'The original offer cannot yet be matched to the requested rooms and child ages. Review it in HMS and run a new quote.';
export const draftQuoteOccupancyMessage = 'Refresh the email, confirm rooms, adults, the number of children per room and each age; check room type, meal plan, agency and company, then run the quote again.';
export const quoteSourcePolicyChangedMessage = 'Rate checks have changed. A fresh supported email read is needed before pricing here; otherwise quote in HMS.';
export const quoteSourceUnverifiedMessage = 'Nava cannot verify this email and its saved quote details. Refresh and confirm rooms, adults, the number of children per room and their ages, room type, meal plan, agency and company. Quote older emails or emails with attachments in HMS.';
export const quoteDocumentCoverageMessage = 'The saved request has other stays or mixed actions. Review all stays for this email, or quote in HMS.';
export const CENTURION_QUOTE_SOURCE_CHANGED = 'staff_quote_centurion_source_changed';

export function isCenturionQuoteTransport(transportId: string): boolean {
  return getPropertyTransportIds('HRCEN').includes(transportId.trim());
}

/** A known, resolved quote property overrides the mailbox; unknown metadata cannot turn a Centurion hold off. */
export function isCenturionQuoteScope(scope: { transportId: string; propertyCode?: string }): boolean {
  if (scope.propertyCode === 'HRCEN') return true;
  if (scope.propertyCode === 'HRDAV') return false;
  return isCenturionQuoteTransport(scope.transportId);
}

export const QUOTE_SOURCE_PROOF_VERSION = 5 as const;
type QuoteSourceProof = {
  version: typeof QUOTE_SOURCE_PROOF_VERSION;
  messageId: string;
  extractionId: string;
  witnessDigest: string;
  inputDigest: string;
  extractionDigest: string;
  sourceDigest: string;
  singleRowDigest: string | null;
};
type QuoteSourceScope = { transportId: string; threadId: string; messageId: string; propertyCode?: string; lock?: boolean;
  /** Only for a transaction already holding the source message FOR UPDATE, which prevents new items. */
  allowMissingWorkItem?: boolean };

/** Snapshot the saved source preferences, separately from the room/rate actually chosen by the quote. */
function quoteSourceSnapshot(groups: Group[], payload: unknown, state: Record<string, unknown>) {
  if (!childOccupancyMatchesStored(groups, payload, state)) return null;
  const parsed = mailExtractionPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const partyDigest = quoteSourcePartyDigest(parsed.data, state);
  if (!partyDigest) return null;
  const rows = new Map<string, { stayId: string; rowId: string; roomType: unknown; board: unknown }>();
  for (const stay of parsed.data.stays) for (const row of stay.rows) {
    rows.set(`${stay.id}\n${row.id}`, { stayId: stay.id, rowId: row.id, roomType: row.roomType, board: row.board });
  }
  const rowPath = /^stays\[([A-Za-z0-9_-]{1,40})\]\.rows\[([A-Za-z0-9_-]{1,40})\]\./;
  for (const path of Object.keys(state)) {
    const match = rowPath.exec(path);
    if (!match?.[1] || !match[2]) continue;
    const key = `${match[1]}\n${match[2]}`;
    if (!rows.has(key)) rows.set(key, { stayId: match[1], rowId: match[2], roomType: undefined, board: undefined });
  }
  const values: Array<{ id: string; roomType: string[]; board: string[] }> = [];
  for (const group of groups) {
    const empty = parsed.data.stays.find((stay) => stay.id === group.id && stay.rows.length === 0);
    const matches = [...rows.values()].filter((row) => row.rowId === group.id ||
      (empty && row.stayId === empty.id && row.rowId === `${empty.id}_row`));
    if (matches.length !== 1) return null;
    const row = matches[0]!;
    const base = `stays[${row.stayId}].rows[${row.rowId}]`;
    const field = (name: 'roomType' | 'board', fallback: unknown) => {
      const path = `${base}.${name}`;
      const edited = Object.hasOwn(state, path);
      const value = edited ? state[path] : fallback;
      if (value == null) return [edited ? 'cleared' : 'missing'];
      if (typeof value !== 'string' || (name === 'board' && !['room_only', 'bb', 'dbb', 'half_board'].includes(value))) return null;
      return ['value', value];
    };
    const roomType = field('roomType', row.roomType), board = field('board', row.board);
    if (!roomType || !board) return null;
    values.push({ id: group.id, roomType, board });
  }
  values.sort((a, b) => a.id.localeCompare(b.id));
  return {
    sourceDigest: quoteDigest([values, partyDigest]),
    singleRowDigest: values.length === 1 ? quoteDigest([values[0]!.roomType, values[0]!.board, partyDigest]) : null,
    partyDigest,
    preferences: values.map(({ id, roomType, board }) => ({
      id, roomType: roomType[0] === 'value' ? roomType[1]?.trim() || null : null,
      board: board[0] === 'value' ? board[1] : null,
    })),
  };
}

function parseQuoteSourceProof(value: unknown): QuoteSourceProof | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proof = value as Partial<QuoteSourceProof>;
  const hash = (item: unknown) => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
  return proof.version === QUOTE_SOURCE_PROOF_VERSION && typeof proof.messageId === 'string' && !!proof.messageId &&
    typeof proof.extractionId === 'string' && !!proof.extractionId && hash(proof.witnessDigest) &&
    hash(proof.inputDigest) && hash(proof.extractionDigest) && hash(proof.sourceDigest) &&
    (proof.singleRowDigest === null || hash(proof.singleRowDigest))
    ? proof as QuoteSourceProof : null;
}

/** The proof comes from the server's submitted input and saved source before an HMS read starts. */
async function captureQuoteSourceProofLocked(db: DB, input: StaffQuoteInput, scope: QuoteSourceScope) {
  const centurion = isCenturionQuoteScope(scope);
  // The source, all extraction rows and saved work-item state must be observed in one short transaction.
  const read = centurion && input.sourceExtractionId
    ? await captureCurrentWitnessedRead(db, scope, input.sourceExtractionId) : null;
  if (centurion && !read) return null;
  const evidence = await loadChildOccupancyEvidence(db, scope);
  const snapshot = evidence && quoteSourceSnapshot(input.groups, evidence.payload, evidence.state);
  if (!evidence || !snapshot || (centurion &&
    (input.sourcePartyDigest !== snapshot.partyDigest || input.sourceExtractionId !== evidence.extractionId)) || input.groups.some((group) => {
    const source = snapshot.preferences.find((item) => item.id === group.id);
    return !group.sourcePreference || !source || group.sourcePreference.roomType !== source.roomType ||
      group.sourcePreference.board !== source.board;
  })) return null;
  const base = { messageId: scope.messageId, inputDigest: quoteDigest(input),
    extractionDigest: quoteDigest({ kind: evidence.kind, payload: evidence.payload }),
    sourceDigest: snapshot.sourceDigest, singleRowDigest: snapshot.singleRowDigest };
  if (!read) return { ...base, version: 4 as const }; // Other properties keep their existing behavior.
  return { ...base, version: QUOTE_SOURCE_PROOF_VERSION, extractionId: read.read.id, witnessDigest: read.source.digest,
    extractionDigest: quoteDigest({ extraction: read.extractionDigest, classifier: classifierForExtraction(read.read) }) };
}

/** The proof comes from the server's submitted input and saved source before an HMS read starts. */
export async function captureQuoteSourceProof(db: DB, input: StaffQuoteInput, scope: QuoteSourceScope) {
  if (!isCenturionQuoteScope(scope)) return captureQuoteSourceProofLocked(db, input, scope);
  return withQuoteSourceSnapshot(db, (tx) => captureQuoteSourceProofLocked(tx, input, { ...scope, lock: true }));
}

/** Only used to explain a refusal; the proof parser, not this predicate, grants access. */
export function quoteSourceProofPredatesPolicy(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'version' in value &&
    (value.version === 1 || value.version === 2 || value.version === 3 || value.version === 4);
}

export function quoteSourceProofFromRun(run: { metrics?: unknown; readResult?: unknown }): unknown {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return record(record(run.metrics).staffQuoteAttestation).quoteSourceProof ?? record(run.readResult).quoteSourceProof;
}

export function quoteSourceProofMatchesInput(proof: unknown, input: StaffQuoteInput): boolean {
  return parseQuoteSourceProof(proof)?.inputDigest === quoteDigest(input);
}

export async function quoteSourceProofIsCurrent(db: DB, groups: Group[], scope: QuoteSourceScope, value: unknown,
  options?: { documentGroups?: Group[] }) {
  if (!isCenturionQuoteScope(scope)) return true;
  const proof = parseQuoteSourceProof(value);
  if (!proof || proof.messageId !== scope.messageId) return false;
  return withQuoteSourceSnapshot(db, async (locked) => {
    const read = await captureCurrentWitnessedRead(locked, scope, proof.extractionId);
    if (!read || read.source.digest !== proof.witnessDigest ||
      quoteDigest({ extraction: read.extractionDigest, classifier: classifierForExtraction(read.read) }) !== proof.extractionDigest) return false;
    const evidence = await loadChildOccupancyEvidence(locked, { ...scope, lock: true });
    return !!evidence && evidence.extractionId === proof.extractionId &&
      quoteSourceSnapshot(groups, evidence.payload, evidence.state)?.sourceDigest === proof.sourceDigest &&
      (!options?.documentGroups || quoteDocumentMatchesStored(options.documentGroups, evidence.payload, evidence.state, evidence.kind));
  });
}

/** A copied message cannot establish that the selected source was used by the extraction. */
export async function quoteSourceProofMatchesCopy(_db: DB, _groups: Group[], scope: QuoteSourceScope, _value: unknown) {
  if (!isCenturionQuoteScope(scope)) return true;
  // Identical text is not evidence that the selected message had the same extraction inputs.
  return false;
}

export async function quoteSourceProofMatchesSingleStay(
  _db: DB, _revision: { groups: StayOccupancy[] }, scope: QuoteSourceScope, _value: unknown,
) {
  if (!isCenturionQuoteScope(scope)) return true;
  return false;
}

/** A priced candidate must still match the selected email and persisted room facts at promotion and send. */
export async function draftQuoteOccupancyHold(db: DB, input: {
  transportId: string; threadId: string; messageId: string | null; triggerMessageId: string | null; result: unknown;
  quoteSourceProof?: unknown;
  lockOrigin?: boolean;
}): Promise<string | null> {
  if (!input.result || typeof input.result !== 'object') return null;
  const result = input.result as { importedOffers?: unknown; quoteRevisions?: unknown; quoteRevisionIds?: unknown; approvedOverrides?: unknown };
  if ([result.importedOffers, result.quoteRevisions, result.quoteRevisionIds, result.approvedOverrides].some((value) => value != null && !Array.isArray(value)))
    return isCenturionQuoteTransport(input.transportId) ? draftQuoteOccupancyMessage : null;
  if (Array.isArray(result.importedOffers)) {
    for (const offer of result.importedOffers) {
      if (isCenturionQuoteScope({ transportId: input.transportId, propertyCode: offer?.propertyCode }))
        return importedOfferOccupancyHold;
      if (isCenturionQuoteTransport(input.transportId) && (!input.messageId || input.messageId !== input.triggerMessageId))
        return draftQuoteOccupancyMessage;
      if (!(await quotePropertyMatchesOrigin({ db, transportId: input.transportId, threadId: input.threadId,
        messageId: input.messageId ?? undefined, propertyCode: offer?.propertyCode, lock: input.lockOrigin })))
        return QUOTE_HOTEL_CHANGED_MESSAGE;
    }
  }
  const quotes = (result.quoteRevisions ?? []) as QuoteRevision[];
  const overrides = (result.approvedOverrides ?? []) as { id: string; sourceRevision: QuoteRevision }[];
  const refs = (result.quoteRevisionIds ?? []) as unknown[];
  if (!quotes.length && !overrides.length && !refs.length) return null;
  const candidates = [...quotes, ...overrides.map((offer) => offer.sourceRevision)];
  for (const quote of candidates) {
    if (!(await quotePropertyMatchesOrigin({ db, transportId: input.transportId, threadId: input.threadId,
      messageId: input.messageId ?? undefined, propertyCode: quote?.propertyCode, lock: input.lockOrigin })))
      return QUOTE_HOTEL_CHANGED_MESSAGE;
  }
  const selectedQuotes = candidates.filter((quote) =>
    isCenturionQuoteScope({ transportId: input.transportId, propertyCode: quote?.propertyCode }));
  if ((isCenturionQuoteTransport(input.transportId) || selectedQuotes.length > 0) &&
    (!input.messageId || input.messageId !== input.triggerMessageId ||
      refs.some((id) => ![...quotes, ...overrides].some((offer) => offer?.id === id)))) return draftQuoteOccupancyMessage;
  if (!selectedQuotes.length && (quotes.length || overrides.length || !isCenturionQuoteTransport(input.transportId))) return null;
  if (!input.messageId) return draftQuoteOccupancyMessage;
  if (selectedQuotes.length && quoteSourceProofPredatesPolicy(input.quoteSourceProof)) return quoteSourcePolicyChangedMessage;
  try {
    for (const quote of selectedQuotes) {
      const groups = occupancyFromRevision(quote);
      const scope = {
        transportId: input.transportId, threadId: input.threadId, messageId: input.messageId,
        propertyCode: quote.propertyCode, lock: true,
      };
      if (!(await quoteSourceProofIsCurrent(db, groups, scope, input.quoteSourceProof))) return quoteSourceUnverifiedMessage;
      // Candidate revisions can be alternatives with separate artifacts; each must cover the whole saved case.
      if (!(await quoteSourceProofIsCurrent(db, groups, scope, input.quoteSourceProof, { documentGroups: groups })))
        return quoteDocumentCoverageMessage;
    }
  } catch (error) {
    if (isQuoteSourceLockBusy(error)) throw quoteSourceBusyError();
    return draftQuoteOccupancyMessage;
  }
  return null;
}

/** Across messages, find the pane's single unambiguous saved room row with identical occupancy. */
export function singleStayOccupancyGroup(
  revision: { groups: StayOccupancy[] },
  payload: unknown,
  state: Record<string, unknown>,
): Group | null {
  const parsed = mailExtractionPayloadSchema.safeParse(payload);
  if (!parsed.success || revision.groups.length !== 1) return null;
  const quoted = revision.groups[0]!;
  const field = (key: string, fallback: unknown) => Object.hasOwn(state, key) ? state[key] : fallback;
  const matches = formStays(parsed.data, state).filter((stay) => {
    const arrival = field(`stays[${stay.id}].requested.arrival`, stay.requested.arrival);
    const departurePath = `stays[${stay.id}].requested.departure`;
    let departure = field(departurePath, stay.requested.departure);
    if (departure == null && !Object.hasOwn(state, departurePath) && typeof arrival === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(arrival) && !hasInvalidStayDates(parsed.data.missing, stay.id, parsed.data.stays.map((item) => item.id))) {
      const day = new Date(`${arrival}T00:00:00Z`);
      if (Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === arrival) departure = addDays(arrival, 1);
    }
    return arrival === quoted.arrivalDate && departure === quoted.departureDate;
  });
  if (matches.length !== 1) return null;
  const stay = matches[0]!;
  if (stay.rows.length !== 1) return null;
  const row = stay.rows[0]!;
  const rowPath = `stays[${stay.id}].rows[${row.id}]`;
  const original = parsed.data.stays.find((item) => item.id === stay.id)?.rows.find((item) => item.id === row.id);
  const ages = field(`${rowPath}.childAges`, original?.childAges);
  if (!Array.isArray(ages) || !Array.isArray(quoted.childAges) || !Number.isInteger(quoted.children) ||
    quoted.children !== quoted.childAges.length || ages.length !== quoted.childAges.length) return null;
  const quotedAges = [...quoted.childAges].sort((a, b) => a - b);
  if ([...ages].sort((a, b) => a - b).some((age, i) => age !== quotedAges[i])) return null;
  const group = {
    id: row.id, arrivalDate: quoted.arrivalDate, departureDate: quoted.departureDate,
    quantity: quoted.quantity, adults: quoted.adults,
    childrenPerRoom: quoted.children, childrenAges: ages,
  };
  return childOccupancyMatchesStored([group], parsed.data, state) ? group : null;
}

export function singleStayOccupancyMatchesRevision(
  revision: { groups: StayOccupancy[] }, payload: unknown, state: Record<string, unknown>,
): boolean {
  return !!singleStayOccupancyGroup(revision, payload, state);
}

export async function singleStayOccupancyIsCurrent(
  db: DB,
  revision: { groups: StayOccupancy[] },
  scope: QuoteSourceScope,
): Promise<boolean> {
  if (!isCenturionQuoteScope(scope)) return true;
  const evidence = await loadChildOccupancyEvidence(db, scope);
  return !!evidence && singleStayOccupancyMatchesRevision(revision, evidence.payload, evidence.state);
}
