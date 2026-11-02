// Read-only availability preparation for a proposed saved-stay amendment.
import { readQuote } from './quote-read.mjs';

const stayFields = ['propertyCode', 'arrival', 'departure', 'roomType', 'ratePlan'];
const changeFields = ['arrival', 'departure', 'roomType', 'ratePlan'];
const parties = ['group', 'organization', 'bookingAgency'];
const object = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const only = (value, fields) => object(value) && Object.keys(value).every((key) => fields.includes(key));
const code = (value) => typeof value === 'string' && /^[A-Z0-9]{1,12}$/.test(value);
const day = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const validStay = (stay) => only(stay, stayFields) && code(stay.propertyCode) &&
  day(stay.arrival) && day(stay.departure) && stay.arrival < stay.departure &&
  code(stay.roomType) && code(stay.ratePlan);
const gap = (issue) => ({ outcome: 'input_gap', issue });

/** Build explicit criteria only. The caller must independently verify the saved-stay inputs. */
export function prepareStayAmendmentAvailability(input) {
  if (!only(input, ['existing', 'change', 'occupancy', 'partyContext', 'roomQuantity'])) return gap('AMEND_INPUT_INVALID');
  if (!validStay(input.existing)) return gap('EXISTING_STAY_REQUIRED');
  if (!only(input.change, changeFields) || !Object.keys(input.change).length) return gap('AMEND_CHANGE_REQUIRED');
  const proposed = { ...input.existing, ...input.change };
  if (!validStay(proposed)) return gap('AMEND_CHANGE_INVALID');
  const changedFields = changeFields.filter((name) => proposed[name] !== input.existing[name]);
  if (!changedFields.length) return gap('AMEND_CHANGE_UNCHANGED');
  const occupancy = input.occupancy;
  if (!only(occupancy, ['adults', 'childAges']) || !Number.isSafeInteger(occupancy.adults) || occupancy.adults < 1 ||
      !Array.isArray(occupancy.childAges) || occupancy.childAges.some((age) => !Number.isSafeInteger(age) || age < 0 || age > 99)) {
    return gap('OCCUPANCY_REQUIRED');
  }
  if (!Number.isSafeInteger(input.roomQuantity) || input.roomQuantity < 1) return gap('ROOM_QUANTITY_REQUIRED');
  if (!only(input.partyContext, parties) || parties.some((name) => !Object.hasOwn(input.partyContext, name)) ||
      parties.some((name) => input.partyContext[name] !== null && (typeof input.partyContext[name] !== 'string' ||
        !input.partyContext[name].trim() || /[\r\n]/.test(input.partyContext[name])))) return gap('PARTY_CONTEXT_REQUIRED');
  const partyContext = Object.fromEntries(parties.filter((name) => input.partyContext[name] !== null)
    .map((name) => [name, input.partyContext[name].trim()]));
  return {
    outcome: 'prepared', changedFields, proposed,
    criteria: { propertyCode: proposed.propertyCode, arrivalDate: proposed.arrival, departureDate: proposed.departure,
      adults: occupancy.adults, childAges: [...occupancy.childAges], roomTypes: [proposed.roomType],
      ratePlans: [proposed.ratePlan], partyContext },
    roomQuantity: input.roomQuantity,
    savedPreimage: 'caller_supplied_unverified', saveEligible: false,
    pricing: { repricing: 'not_verified', tax: 'unknown', inventory: 'not_verified', quote: 'not_produced' },
  };
}

/** Search Hotel Availability on a separate read-only page; never stage or save the stay. */
export async function readStayAmendmentAvailability(page, input, options = {}) {
  const prepared = prepareStayAmendmentAvailability(input);
  if (prepared.outcome !== 'prepared') return prepared;
  if (!only(options, ['snapshotPath']) || typeof options.snapshotPath !== 'string' || !options.snapshotPath.trim()) {
    return gap('PRIVATE_SNAPSHOT_PATH_REQUIRED');
  }
  const result = await readQuote(page, { criteria: prepared.criteria, roomQuantity: prepared.roomQuantity,
    snapshotPath: options.snapshotPath, view: { nightLimit: 31 } });
  return { outcome: result.outcome, ...(result.issue ? { issue: result.issue } : {}), prepared,
    ...(result.snapshotPath ? { snapshotPath: result.snapshotPath } : {}),
    ...(result.view ? { availability: result.view } : {}),
    saveEligible: false, savedPreimage: 'caller_supplied_unverified',
    pricing: { repricing: 'not_verified', tax: 'unknown', inventory: 'not_verified', quote: 'not_produced' } };
}
