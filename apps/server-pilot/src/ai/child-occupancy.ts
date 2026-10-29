import { mailExtractionPayloadSchema } from './extraction/schema.js';
import type { StaffQuoteInput } from './staff-quote-workflow.js';
import type { QuoteRevision } from '../quote-proposal/quote-revision.js';
import type { DB } from '../db/client.js';
import { mailExtraction, workItem } from '../db/schema/work.js';
import { and, desc, eq } from 'drizzle-orm';
import { addDays } from './stay-date-anchoring.js';

type Group = Pick<StaffQuoteInput['groups'][number],
  'id' | 'arrivalDate' | 'departureDate' | 'childrenAges' | 'childrenPerRoom'>;
type RowEvidence = { stayId: string; rowId: string; count: unknown; ages: unknown };
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
  const rows = parsed.data.stays.flatMap((stay) => stay.rows.map((row) => ({
    stayId: stay.id,
    rowId: row.id,
    count: row.childrenPerRoom,
    ages: row.childAges,
  })));
  const countPath = /^stays\[([A-Za-z0-9_-]{1,40})\]\.rows\[([A-Za-z0-9_-]{1,40})\]\.childrenPerRoom$/;
  // Staff-added rows do not occur in the extraction; they need explicit saved count and ages.
  const addedRows = Object.keys(state).flatMap((key): RowEvidence[] => {
    const match = countPath.exec(key);
    if (!match) return [];
    const [, stayId, rowId] = match;
    if (!stayId || !rowId || rows.some((row) => row.stayId === stayId && row.rowId === rowId)) return [];
    return [{ stayId, rowId, count: undefined, ages: undefined }];
  });
  const allRows: RowEvidence[] = [...rows, ...addedRows];
  return groups.every((group) => {
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
      /^\d{4}-\d{2}-\d{2}$/.test(arrival) && !parsed.data.missing.some((item) => item.field === 'stayDates')) {
      const day = new Date(`${arrival}T00:00:00Z`);
      if (Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === arrival) departure = addDays(arrival, 1);
    }
    if (arrival !== group.arrivalDate || departure !== group.departureDate) return false;
    const count = Object.hasOwn(state, `${base}.childrenPerRoom`) ? state[`${base}.childrenPerRoom`] : row.count;
    const ages = Object.hasOwn(state, `${base}.childAges`) ? state[`${base}.childAges`] : row.ages;
    return typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 6 &&
      (group.childrenPerRoom === undefined || group.childrenPerRoom === count) &&
      Array.isArray(ages) && ages.length === count &&
      ages.every((age) => typeof age === 'number' && Number.isInteger(age) && age >= 0 && age <= 17) &&
      ages.length === group.childrenAges.length && ages.every((age, index) => age === group.childrenAges[index]);
  });
}

export function occupancyFromRevision(revision: QuoteRevision): Group[] {
  return revision.groups.map((group) => ({
    id: group.id, arrivalDate: group.arrivalDate, departureDate: group.departureDate,
    childrenPerRoom: Number.isInteger(group.children) ? group.children : null, childrenAges: group.childAges,
  }));
}

/** Load the same extraction version and saved edits as the selected email's pane. */
async function loadChildOccupancyEvidence(
  db: DB,
  scope: { transportId: string; threadId: string; messageId: string },
) {
  const [latest] = await db
    .select({ id: mailExtraction.id, kind: mailExtraction.kind, payload: mailExtraction.payload })
    .from(mailExtraction)
    .where(and(eq(mailExtraction.messageId, scope.messageId), eq(mailExtraction.status, 'succeeded')))
    .orderBy(desc(mailExtraction.createdAt))
    .limit(1);
  if (!latest?.kind || !latest.payload) return null;
  const [item] = await db
    .select({ extractionId: workItem.extractionId, state: workItem.state })
    .from(workItem)
    .where(and(
      eq(workItem.transportId, scope.transportId),
      eq(workItem.threadId, scope.threadId),
      eq(workItem.sourceMessageId, scope.messageId),
      eq(workItem.kind, latest.kind),
    ))
    .limit(1);
  let payload = latest.payload;
  if (item?.extractionId && item.extractionId !== latest.id) {
    const [pinned] = await db
      .select({ payload: mailExtraction.payload })
      .from(mailExtraction)
      .where(and(
        eq(mailExtraction.id, item.extractionId),
        eq(mailExtraction.messageId, scope.messageId),
        eq(mailExtraction.status, 'succeeded'),
      ))
      .limit(1);
    if (pinned?.payload) payload = pinned.payload;
  }
  return { payload, state: item?.state ?? {} };
}

export async function childOccupancyIsCurrent(
  db: DB,
  groups: Group[],
  scope: { transportId: string; threadId: string; messageId: string },
): Promise<boolean> {
  const evidence = await loadChildOccupancyEvidence(db, scope);
  return !!evidence && childOccupancyMatchesStored(groups, evidence.payload, evidence.state);
}

/** Across messages, admit only a single unambiguous saved room row with identical occupancy. */
export function singleStayOccupancyMatchesRevision(
  revision: { groups: StayOccupancy[] },
  payload: unknown,
  state: Record<string, unknown>,
): boolean {
  const parsed = mailExtractionPayloadSchema.safeParse(payload);
  if (!parsed.success || revision.groups.length !== 1) return false;
  const quoted = revision.groups[0]!;
  const field = (key: string, fallback: unknown) => Object.hasOwn(state, key) ? state[key] : fallback;
  const matches = parsed.data.stays.filter((stay) =>
    state[`stays[${stay.id}].removed`] !== true &&
    field(`stays[${stay.id}].requested.arrival`, stay.requested.arrival) === quoted.arrivalDate &&
    field(`stays[${stay.id}].requested.departure`, stay.requested.departure) === quoted.departureDate,
  );
  if (matches.length !== 1) return false;
  const stay = matches[0]!;
  if (stay.rows.length !== 1) return false;
  const row = stay.rows[0]!;
  const rowPath = `stays[${stay.id}].rows[${row.id}]`;
  const rowKeys = /^stays\[([A-Za-z0-9_-]{1,40})\]\.rows\[([A-Za-z0-9_-]{1,40})\]\./;
  const activeRows = new Set([row.id]);
  for (const key of Object.keys(state)) {
    const match = rowKeys.exec(key);
    if (match?.[1] === stay.id && match[2] && state[`stays[${stay.id}].rows[${match[2]}].removed`] !== true)
      activeRows.add(match[2]);
  }
  if (activeRows.size !== 1 || state[`${rowPath}.removed`] === true ||
    field(`${rowPath}.count`, row.rooms ?? stay.totalRooms) !== quoted.quantity ||
    field(`${rowPath}.adults`, row.adultsPerRoom) !== quoted.adults) return false;
  const ages = field(`${rowPath}.childAges`, row.childAges);
  if (!Array.isArray(ages) || !Array.isArray(quoted.childAges) || !Number.isInteger(quoted.children) ||
    quoted.children !== quoted.childAges.length || ages.length !== quoted.childAges.length) return false;
  const quotedAges = [...quoted.childAges].sort((a, b) => a - b);
  if ([...ages].sort((a, b) => a - b).some((age, i) => age !== quotedAges[i])) return false;
  return childOccupancyMatchesStored([{
    id: row.id, arrivalDate: quoted.arrivalDate, departureDate: quoted.departureDate,
    childrenPerRoom: quoted.children, childrenAges: ages,
  }], parsed.data, state);
}

export async function singleStayOccupancyIsCurrent(
  db: DB,
  revision: { groups: StayOccupancy[] },
  scope: { transportId: string; threadId: string; messageId: string },
): Promise<boolean> {
  const evidence = await loadChildOccupancyEvidence(db, scope);
  return !!evidence && singleStayOccupancyMatchesRevision(revision, evidence.payload, evidence.state);
}
