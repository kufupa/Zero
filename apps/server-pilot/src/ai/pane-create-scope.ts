import { z } from 'zod';
import { mailExtractionPayloadSchema, type ExtractionRow, type ExtractionStay } from './extraction/schema.js';
import { parseFieldPath, validFieldValue, type WorkState } from './work-items.js';
import type { PaneStay } from './pane-stay-save.js';
import { matchRoomType } from './room-types.js';
import type { HistoricalOwnRow } from './pane-create-scope-origin.js';

const stableId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
export const paneCreatePartySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
  z.object({ kind: z.literal('selected'), company: z.string().max(200).nullable(), agency: z.string().max(200).nullable() }).strict(),
]);
export const paneCreateIdentitySchema = z.object({
  stayId: stableId, rowId: stableId, roomIndex: z.number().int().min(1).max(999),
}).strict();
export type PaneCreateIdentity = z.infer<typeof paneCreateIdentitySchema>;
export type PaneCreateParty = z.infer<typeof paneCreatePartySchema>;

/** Strictly project the linked extraction plus its persisted pane edits. Never guess missing occupancy. */
export function reconcilePaneCreateScope(input: {
  payload: unknown; state: WorkState; identity: PaneCreateIdentity; party: PaneCreateParty; stay: PaneStay;
  /** Server-owned evidence only: the caller must derive these from this item's durable user field events
   * and the same linked source message's extraction recorded by each event. Never accept browser claims. */
  historicalOwnRows?: ReadonlyArray<HistoricalOwnRow>;
}): boolean {
  const parsed = mailExtractionPayloadSchema.safeParse(input.payload);
  if (!parsed.success || !paneCreateIdentitySchema.safeParse(input.identity).success ||
      !paneCreatePartySchema.safeParse(input.party).success || input.party.kind !== 'none' ||
      input.stay.bookingAgency !== undefined || input.stay.organization !== undefined) return false;
  const payload = parsed.data;
  const stays = new Map<string, ExtractionStay>();
  const originallyRowless = new Set<string>();
  for (const original of payload.stays) {
    if (!stableId.safeParse(original.id).success || stays.has(original.id)) return false;
    const ids = new Set<string>();
    for (const row of original.rows) {
      if (!stableId.safeParse(row.id).success || ids.has(row.id)) return false;
      ids.add(row.id);
    }
    if (original.rows.length === 0) originallyRowless.add(original.id);
    stays.set(original.id, { ...original, rows: original.rows.map((row) => ({ ...row })) });
  }
  // A later extraction can add rows after a rowless stay's own row was edited. The prior
  // extraction and its still-persisted field event prove origin; the generated name alone does not.
  const hasHistoricalOwnRow = (stayId: string, rowId: string): boolean => {
    if (rowId !== `${stayId}_row` || !Array.isArray(input.historicalOwnRows)) return false;
    return input.historicalOwnRows.some((proof) => {
      if (!proof || !z.string().uuid().safeParse(proof.eventId).success ||
          !z.string().uuid().safeParse(proof.extractionId).success) return false;
      const path = parseFieldPath(proof.fieldPath);
      if (!path || path.stayId !== stayId || path.rowId !== rowId || path.field === 'removed' ||
          !Object.hasOwn(input.state, proof.fieldPath) || !validFieldValue(path.field, proof.value) ||
          JSON.stringify(input.state[proof.fieldPath]) !== JSON.stringify(proof.value)) return false;
      const prior = mailExtractionPayloadSchema.safeParse(proof.extraction);
      if (!prior.success) return false;
      const matches = prior.data.stays.filter((stay) => stay.id === stayId);
      return matches.length === 1 && matches[0]!.rows.length === 0;
    });
  };
  for (const [key, value] of Object.entries(input.state)) {
    if (!key.startsWith('stays[')) continue;
    const path = parseFieldPath(key);
    if (!path || !validFieldValue(path.field, value)) return false;
    // Deleted additions remain in history but cannot create an active stay or row.
    if (input.state[`stays[${path.stayId}].removed`] === true ||
        (path.rowId && input.state[`stays[${path.stayId}].rows[${path.rowId}].removed`] === true)) continue;
    let stay = stays.get(path.stayId);
    if (!stay) {
      // New stays must have an explicit add marker; orphan field paths are not proof of a request.
      if (input.state[`stays[${path.stayId}].removed`] !== null) return false;
      stay = { id: path.stayId, hotel: null, requested: { arrival: null, departure: null },
        booked: null, totalRooms: null, rows: [] };
      stays.set(path.stayId, stay);
    }
    if (path.rowId && !stay.rows.some((row) => row.id === path.rowId)) {
      const marker = `stays[${path.stayId}].rows[${path.rowId}].removed`;
      // The UI also gives an initially rowless extraction a deterministic own-row id.
      if (input.state[marker] !== null && !(originallyRowless.has(path.stayId) && path.rowId === `${path.stayId}_row`) &&
          !hasHistoricalOwnRow(path.stayId, path.rowId)) return false;
      stay.rows.push({ id: path.rowId, roomType: null, rooms: null, adultsPerRoom: null, childAges: null, board: null });
    }
  }
  // formStays also hides a rowless stay when its only projected row was removed.
  const removedRowStayIds = new Set(Object.entries(input.state).flatMap(([key, value]) => {
    const path = parseFieldPath(key);
    return path?.rowId && path.field === 'removed' && value === true ? [path.stayId] : [];
  }));
  // formStays uses one global removed-id set. A collision can hide a different stay or
  // row in the pane; never approve one that the pane could have hidden by that collision.
  const removedIds = new Set(Object.entries(input.state).flatMap(([key, value]) => {
    const path = parseFieldPath(key);
    return path?.field === 'removed' && value === true ? [path.rowId ?? path.stayId] : [];
  }));
  for (const candidate of stays.values()) {
    if (input.state[`stays[${candidate.id}].removed`] === true) continue;
    if (removedIds.has(candidate.id) || candidate.rows.some((row) =>
      input.state[`stays[${candidate.id}].rows[${row.id}].removed`] !== true && removedIds.has(row.id))) return false;
  }
  const activeStays = [...stays.values()].filter((stay) => input.state[`stays[${stay.id}].removed`] !== true &&
    (stay.rows.some((row) => input.state[`stays[${stay.id}].rows[${row.id}].removed`] !== true) ||
      (stay.rows.length === 0 && !removedRowStayIds.has(stay.id))));
  if (activeStays.length !== 1) return false;
  const stay = activeStays[0]!;
  const rows = stay.rows.filter((row) => input.state[`stays[${stay.id}].rows[${row.id}].removed`] !== true);
  if (rows.length !== 1 || stay.id !== input.identity.stayId || rows[0]!.id !== input.identity.rowId ||
      input.identity.roomIndex !== 1) return false;
  const row: ExtractionRow = rows[0]!;
  const value = (path: string, fallback: unknown): unknown => Object.hasOwn(input.state, path) ? input.state[path] : fallback;
  const stayPath = `stays[${stay.id}]`;
  const rowPath = `${stayPath}.rows[${row.id}]`;
  const roomType = value(`${rowPath}.roomType`, row.roomType);
  if (roomType !== null) {
    // Extraction may hold a human label, not a native code. Never select an ambiguous match.
    if (typeof roomType !== 'string' || !roomType.trim() ||
        matchRoomType(roomType, input.stay.propertyCode).code !== input.stay.roomType) return false;
  }
  const hasStaffCount = Object.hasOwn(input.state, `${rowPath}.count`);
  const rawCount = value(`${rowPath}.count`, row.rooms);
  const count = rawCount === null && !hasStaffCount ? stay.totalRooms : rawCount;
  // A persisted staff correction reconciles the extracted total, as in the pane projection.
  if (count !== 1 || (!hasStaffCount && stay.totalRooms !== null && stay.totalRooms !== 1)) return false;
  const arrival = value(`${stayPath}.requested.arrival`, stay.requested.arrival);
  const departure = value(`${stayPath}.requested.departure`, stay.requested.departure);
  const adults = value(`${rowPath}.adults`, row.adultsPerRoom);
  const ages = value(`${rowPath}.childAges`, row.childAges);
  const totalAdults = value(`${stayPath}.totalAdults`, stay.totalAdults ?? null);
  const totalChildren = value(`${stayPath}.totalChildren`, stay.totalChildren ?? null);
  // The pane retains matching stay-scoped and unscoped occupancy warnings until staff correct the affected row.
  // A numeric extraction alone does not confirm an explicitly questioned allocation.
  const scopedWarnings = payload.missing.filter((item) => !item.stayId || item.stayId === stay.id);
  if (scopedWarnings.some((item) => /adult|occupancy/i.test(`${item.field} ${item.question}`) &&
        !/total/i.test(item.field)) && !Object.hasOwn(input.state, `${rowPath}.adults`)) return false;
  if (scopedWarnings.some((item) => /child/i.test(`${item.field} ${item.question}`)) &&
      !Object.hasOwn(input.state, `${rowPath}.childAges`)) return false;
  if (arrival !== input.stay.arrival || departure !== input.stay.departure ||
      !Number.isInteger(adults) || adults !== input.stay.adults || !Array.isArray(ages) ||
      !ages.every((age) => Number.isInteger(age) && age >= 0 && age <= 17) ||
      JSON.stringify(ages) !== JSON.stringify(input.stay.childAges) ||
      (totalAdults !== null && totalAdults !== adults) || (totalChildren !== null && totalChildren !== ages.length)) return false;
  // Legacy empty ages alongside an unresolved child warning do not prove zero children.
  if (ages.length === 0 && totalChildren === null && !Object.hasOwn(input.state, `${rowPath}.childAges`) &&
      payload.missing.some((item) => /child/i.test(`${item.field} ${item.question}`))) return false;
  return true;
}
