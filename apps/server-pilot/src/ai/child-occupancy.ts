import { hasInvalidStayDates, mailExtractionPayloadSchema } from './extraction/schema.js';
import type { StaffQuoteInput } from './staff-quote-workflow.js';
import type { QuoteRevision } from '../quote-proposal/quote-revision.js';
import type { DB } from '../db/client.js';
import { mailExtraction, workItem } from '../db/schema/work.js';
import { and, desc, eq } from 'drizzle-orm';
import { addDays } from './stay-date-anchoring.js';
import { formStays } from './work-items.js';
import { getPropertyTransportIds } from '../../tooling/playwright-quote/property-registry.mjs';

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
  scope: { transportId: string; threadId: string; messageId: string; lock?: boolean },
) {
  const [latest] = await db
    .select({ id: mailExtraction.id, kind: mailExtraction.kind, payload: mailExtraction.payload })
    .from(mailExtraction)
    .where(and(eq(mailExtraction.messageId, scope.messageId), eq(mailExtraction.status, 'succeeded')))
    .orderBy(desc(mailExtraction.createdAt))
    .limit(1);
  if (!latest?.kind || !latest.payload) return null;
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
  const [item] = await (scope.lock ? itemQuery.for('share') : itemQuery);
  // A newer read has not been adopted yet. Do not apply old corrections to that read, or keep pricing the older one.
  // The existing work-item relink decides whether edits can safely carry; once it moves, the latest evidence is used.
  if ((!item && scope.lock) || (item && item.extractionId !== latest.id)) return null;
  return { payload: latest.payload, state: item?.state ?? {} };
}

export async function childOccupancyIsCurrent(
  db: DB,
  groups: Group[],
  scope: { transportId: string; threadId: string; messageId: string; propertyCode?: string; lock?: boolean },
): Promise<boolean> {
  if (!isCenturionQuoteScope(scope)) return true;
  const evidence = await loadChildOccupancyEvidence(db, scope);
  return !!evidence && childOccupancyMatchesStored(groups, evidence.payload, evidence.state);
}

export const importedOfferOccupancyHold = 'The original offer cannot yet be matched to the requested rooms and child ages. Review it in HMS and run a new quote.';
export const draftQuoteOccupancyMessage = 'Confirm the rooms, adults, and children per room, including each child’s age, then run the quote again.';

export function isCenturionQuoteTransport(transportId: string): boolean {
  return getPropertyTransportIds('HRCEN').includes(transportId.trim());
}

/** A resolved quote property overrides the mailbox; unknown metadata cannot turn a Centurion hold off. */
export function isCenturionQuoteScope(scope: { transportId: string; propertyCode?: string }): boolean {
  if (scope.propertyCode === 'HRCEN') return true;
  if (scope.propertyCode === 'HRDAV') return false;
  return isCenturionQuoteTransport(scope.transportId);
}

/** A priced candidate must still match the selected email and persisted room facts at promotion and send. */
export async function draftQuoteOccupancyHold(db: DB, input: {
  transportId: string; threadId: string; messageId: string | null; triggerMessageId: string | null; result: unknown;
}): Promise<string | null> {
  if (!input.result || typeof input.result !== 'object') return null;
  const result = input.result as { importedOffers?: unknown; quoteRevisions?: unknown; quoteRevisionIds?: unknown; approvedOverrides?: unknown };
  if ([result.importedOffers, result.quoteRevisions, result.quoteRevisionIds, result.approvedOverrides].some((value) => value != null && !Array.isArray(value)))
    return isCenturionQuoteTransport(input.transportId) ? draftQuoteOccupancyMessage : null;
  if (Array.isArray(result.importedOffers) && result.importedOffers.some((offer) =>
    isCenturionQuoteScope({ transportId: input.transportId, propertyCode: offer?.propertyCode }))) return importedOfferOccupancyHold;
  const quotes = (result.quoteRevisions ?? []) as QuoteRevision[];
  const overrides = (result.approvedOverrides ?? []) as { id: string; sourceRevision: QuoteRevision }[];
  const refs = (result.quoteRevisionIds ?? []) as unknown[];
  if (!quotes.length && !overrides.length && !refs.length) return null;
  const selectedQuotes = [...quotes, ...overrides.map((offer) => offer.sourceRevision)].filter((quote) =>
    isCenturionQuoteScope({ transportId: input.transportId, propertyCode: quote?.propertyCode }));
  if (!selectedQuotes.length && (quotes.length || overrides.length || !isCenturionQuoteTransport(input.transportId))) return null;
  if (!input.messageId || input.messageId !== input.triggerMessageId ||
    refs.some((id) => ![...quotes, ...overrides].some((offer) => offer?.id === id))) return draftQuoteOccupancyMessage;
  try {
    for (const quote of selectedQuotes) {
      if (!(await childOccupancyIsCurrent(db, occupancyFromRevision(quote), {
        transportId: input.transportId, threadId: input.threadId, messageId: input.messageId,
        propertyCode: quote.propertyCode, lock: true,
      }))) return draftQuoteOccupancyMessage;
    }
  } catch { return draftQuoteOccupancyMessage; }
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
  scope: { transportId: string; threadId: string; messageId: string; propertyCode?: string },
): Promise<boolean> {
  if (!isCenturionQuoteScope(scope)) return true;
  const evidence = await loadChildOccupancyEvidence(db, scope);
  return !!evidence && singleStayOccupancyMatchesRevision(revision, evidence.payload, evidence.state);
}
