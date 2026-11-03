import { batchManifestSchema } from './hms-batch-manifest.js';
import { paneCreateIdentitySchema, paneCreatePartySchema, projectPaneCreateScope,
  type PaneCreateIdentity, type PaneCreateParty } from './pane-create-scope.js';
import type { HistoricalOwnRow } from './pane-create-scope-origin.js';
import { matchRoomType } from './room-types.js';
import type { WorkState } from './work-items.js';

export type BatchScopeResult = { status: 'ready' } | { status: 'held'; reason:
  'invalid_manifest' | 'party_unverified' | 'source_unverified' | 'source_room_changed' | 'occupancy_unverified' };

type Projection = NonNullable<ReturnType<typeof projectPaneCreateScope>>;
type ProjectedStay = Projection['stays'] extends Map<string, infer Stay> ? Stay : never;
type ProjectedRow = ProjectedStay['rows'][number];

/** A stay total is not a remaining row's count after other source rows were removed. */
function rowCount(projection: Projection, state: WorkState, stay: ProjectedStay, row: ProjectedRow, activeRows: ProjectedRow[]): unknown {
  const countPath = `stays[${stay.id}].rows[${row.id}].count`;
  const raw = Object.hasOwn(state, countPath) ? state[countPath] : row.rooms;
  if (raw !== null || Object.hasOwn(state, countPath) || activeRows.length !== 1) return raw;
  const source = projection.payload.stays.find((item) => item.id === stay.id);
  const soleSourceRow = source?.rows.length === 1 && source.rows[0]?.id === row.id;
  const removedRow = Object.entries(state).some(([path, value]) => value === true &&
    path.startsWith(`stays[${stay.id}].rows[`) && path.endsWith('].removed'));
  const ownRowOfRowlessSource = source?.rows.length === 0 && row.id === `${stay.id}_row` &&
    stay.rows.length === 1 && !removedRow;
  return !removedRow && (soleSourceRow || ownRowOfRowlessSource) ? stay.totalRooms : null;
}

function activeRow(projection: Projection, state: WorkState, identity: PaneCreateIdentity) {
  const stay = projection.stays.get(identity.stayId);
  if (!stay || state[`stays[${identity.stayId}].removed`] === true) return null;
  const rows = stay.rows.filter((row) => state[`stays[${stay.id}].rows[${row.id}].removed`] !== true);
  const row = rows.find((item) => item.id === identity.rowId);
  if (!row) return null;
  const count = rowCount(projection, state, stay, row, rows);
  return Number.isInteger(count) && (count as number) >= 1 && identity.roomIndex <= (count as number) ? { stay, row } : null;
}

/**
 * Check a selected child against a server-loaded extraction and locked item state.
 * Historical rows must come from the durable same-message origin loader. This is
 * not authentication, source-digest validation, a choice, approval or dispatch authority.
 */
export function isActivePaneBatchChild(input: {
  payload: unknown; state: WorkState; identity: unknown; historicalOwnRows?: ReadonlyArray<HistoricalOwnRow>;
}): boolean {
  const identity = paneCreateIdentitySchema.safeParse(input.identity);
  if (!identity.success) return false;
  const projection = projectPaneCreateScope(input);
  return projection !== null && activeRow(projection, input.state, identity.data) !== null;
}

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
    const active = activeRow(projection, input.state, room.identity);
    if (!active) return { status: 'held', reason: 'source_room_changed' };
    const { stay, row } = active;
    const stayPath = `stays[${stay.id}]`, rowPath = `${stayPath}.rows[${row.id}]`;
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
    // Only an actual change to a known source count, an added row, or a
    // removed source row supersedes the extracted room total. A null/no-op
    // marker, or resolving an unknown count, does not change that total.
    const sourceStay = projection.payload.stays.find((item) => item.id === stay.id);
    const compositionEdited = stay.rows.some((row) => {
      const rowPath = `${stayPath}.rows[${row.id}]`;
      const sourceRow = sourceStay?.rows.find((item) => item.id === row.id);
      const removed = input.state[`${rowPath}.removed`] === true;
      if (removed) return Boolean(sourceRow);
      if (!sourceRow) return true;
      const originalCount = sourceRow.rooms === null && sourceStay?.rows.length === 1
        ? sourceStay.totalRooms : sourceRow.rooms;
      const countPath = `${rowPath}.count`;
      return typeof originalCount === 'number' && Object.hasOwn(input.state, countPath) &&
        input.state[countPath] !== originalCount;
    });
    const needsRoomTotal = stay.totalRooms !== null && !compositionEdited;
    // Every active row must have a known count, even with unknown totals.
    let rooms = 0, adults = 0, children = 0;
    for (const row of rows) {
      const rowPath = `${stayPath}.rows[${row.id}]`;
      const count = rowCount(projection, input.state, stay, row, rows);
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
