import { batchManifestSchema } from './hms-batch-manifest.js';
import { paneCreatePartySchema, projectPaneCreateScope, type PaneCreateParty } from './pane-create-scope.js';
import type { HistoricalOwnRow } from './pane-create-scope-origin.js';
import { matchRoomType } from './room-types.js';
import type { WorkState } from './work-items.js';

export type BatchScopeResult = { status: 'ready' } | { status: 'held'; reason:
  'invalid_manifest' | 'party_unverified' | 'source_unverified' | 'source_room_changed' | 'occupancy_unverified' };

/**
 * Reconcile every selected, ordered child against the same server-owned source projection.
 * The caller must separately bind manifest, source revision and historical proof through dispatch.
 * Non-selected rows may remain, but can never supply identity or approval for a child.
 */
export function reconcilePaneBatchCreateScope(input: {
  manifest: unknown; payload: unknown; state: WorkState; party: PaneCreateParty;
  historicalOwnRows?: ReadonlyArray<HistoricalOwnRow>;
}): BatchScopeResult {
  const manifest = batchManifestSchema.safeParse(input.manifest);
  if (!manifest.success) return { status: 'held', reason: 'invalid_manifest' };
  if (!paneCreatePartySchema.safeParse(input.party).success || input.party.kind !== 'none' ||
      manifest.data.rooms.some((room) => room.agency !== null || room.organization !== null)) {
    return { status: 'held', reason: 'party_unverified' };
  }
  const projection = projectPaneCreateScope(input);
  if (!projection) return { status: 'held', reason: 'source_unverified' };
  const value = (path: string, fallback: unknown): unknown => Object.hasOwn(input.state, path) ? input.state[path] : fallback;
  const touched = new Set<string>();
  for (const room of manifest.data.rooms) {
    const stay = projection.stays.get(room.identity.stayId);
    if (!stay || input.state[`stays[${room.identity.stayId}].removed`] === true) {
      return { status: 'held', reason: 'source_room_changed' };
    }
    const rows = stay.rows.filter((item) => input.state[`stays[${stay.id}].rows[${item.id}].removed`] !== true);
    const row = rows.find((item) => item.id === room.identity.rowId);
    if (!row) return { status: 'held', reason: 'source_room_changed' };
    const stayPath = `stays[${stay.id}]`, rowPath = `${stayPath}.rows[${row.id}]`;
    const countPath = `${rowPath}.count`;
    const rawCount = value(countPath, row.rooms);
    const count = rawCount === null && rows.length === 1 && !Object.hasOwn(input.state, countPath) ? stay.totalRooms : rawCount;
    if (!Number.isInteger(count) || (count as number) < 1 || room.identity.roomIndex > (count as number)) {
      return { status: 'held', reason: 'source_room_changed' };
    }
    const roomType = value(`${rowPath}.roomType`, row.roomType);
    if (typeof roomType !== 'string' || !roomType.trim() ||
        matchRoomType(roomType, manifest.data.propertyCode).code !== room.roomType) {
      return { status: 'held', reason: 'source_room_changed' };
    }
    const adults = value(`${rowPath}.adults`, row.adultsPerRoom), ages = value(`${rowPath}.childAges`, row.childAges);
    const totalChildren = value(`${stayPath}.totalChildren`, stay.totalChildren ?? null);
    const scopedWarnings = projection.payload.missing.filter((item) => !item.stayId || item.stayId === stay.id);
    if ((scopedWarnings.some((item) => /adult|occupancy/i.test(`${item.field} ${item.question}`) &&
          !/total/i.test(item.field)) && !Object.hasOwn(input.state, `${rowPath}.adults`)) ||
        (scopedWarnings.some((item) => /child/i.test(`${item.field} ${item.question}`)) &&
          !Object.hasOwn(input.state, `${rowPath}.childAges`))) return { status: 'held', reason: 'occupancy_unverified' };
    if (value(`${stayPath}.requested.arrival`, stay.requested.arrival) !== room.stay.arrival ||
        value(`${stayPath}.requested.departure`, stay.requested.departure) !== room.stay.departure ||
        !Number.isInteger(adults) || adults !== room.stay.adults || !Array.isArray(ages) ||
        !ages.every((age) => Number.isInteger(age) && age >= 0 && age <= 17) ||
        JSON.stringify(ages) !== JSON.stringify(room.stay.childAges) ||
        (ages.length === 0 && totalChildren === null && !Object.hasOwn(input.state, `${rowPath}.childAges`) &&
         scopedWarnings.some((item) => /child/i.test(`${item.field} ${item.question}`)))) {
      return { status: 'held', reason: 'occupancy_unverified' };
    }
    touched.add(stay.id);
  }
  // A stated stay-wide total describes every active row, not just the selected subset.
  for (const stayId of touched) {
    const stay = projection.stays.get(stayId)!;
    const rows = stay.rows.filter((row) => input.state[`stays[${stay.id}].rows[${row.id}].removed`] !== true);
    const stayPath = `stays[${stay.id}]`;
    const totalAdults = value(`${stayPath}.totalAdults`, stay.totalAdults ?? null);
    const totalChildren = value(`${stayPath}.totalChildren`, stay.totalChildren ?? null);
    const compositionEdited = stay.rows.some((row) =>
      Object.hasOwn(input.state, `${stayPath}.rows[${row.id}].count`) ||
      Object.hasOwn(input.state, `${stayPath}.rows[${row.id}].removed`));
    const needsRoomTotal = stay.totalRooms !== null && !compositionEdited;
    if (totalAdults === null && totalChildren === null && !needsRoomTotal) continue;
    let rooms = 0, adults = 0, children = 0;
    for (const row of rows) {
      const rowPath = `${stayPath}.rows[${row.id}]`, countPath = `${rowPath}.count`;
      const rawCount = value(countPath, row.rooms);
      const count = rawCount === null && rows.length === 1 && !Object.hasOwn(input.state, countPath) ? stay.totalRooms : rawCount;
      const adultCount = value(`${rowPath}.adults`, row.adultsPerRoom), ages = value(`${rowPath}.childAges`, row.childAges);
      if (!Number.isInteger(count) || (count as number) < 1 ||
          (totalAdults !== null && (!Number.isInteger(adultCount) || (adultCount as number) < 1)) ||
          (totalChildren !== null && (!Array.isArray(ages) || !ages.every((age) => Number.isInteger(age) && age >= 0 && age <= 17)))) {
        return { status: 'held', reason: 'occupancy_unverified' };
      }
      rooms += count as number;
      if (totalAdults !== null) adults += (count as number) * (adultCount as number);
      if (totalChildren !== null) children += (count as number) * (ages as number[]).length;
    }
    if ((needsRoomTotal && rooms !== stay.totalRooms) || (totalAdults !== null && adults !== totalAdults) ||
        (totalChildren !== null && children !== totalChildren)) return { status: 'held', reason: 'occupancy_unverified' };
  }
  return { status: 'ready' };
}
