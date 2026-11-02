import { z } from 'zod';
import { mailExtractionPayloadSchema, type ExtractionRow, type ExtractionStay } from './extraction/schema.js';
import { parseFieldPath, validFieldValue, type WorkState } from './work-items.js';
import type { PaneStay } from './pane-stay-save.js';
import { matchRoomType } from './room-types.js';

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
      if (input.state[marker] !== null && !(originallyRowless.has(path.stayId) && path.rowId === `${path.stayId}_row`)) return false;
      stay.rows.push({ id: path.rowId, roomType: null, rooms: null, adultsPerRoom: null, childAges: null, board: null });
    }
  }
  const activeStays = [...stays.values()].filter((stay) => input.state[`stays[${stay.id}].removed`] !== true);
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
