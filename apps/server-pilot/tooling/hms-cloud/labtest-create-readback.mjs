// Fresh, read-only evidence for a guarded Proof Labtest create attempt.
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { searchLabtestPreimage } from './labtest-preimage.mjs';
import { withSavedStayAgentSession } from './saved-stay-agent-session.mjs';

const same = (a, b) => String(a ?? '').trim().toLocaleLowerCase() === String(b ?? '').trim().toLocaleLowerCase();
const uniqueValue = (fields, name) => {
  const matches = fields.filter((field) => field.name === name);
  return matches.length === 1 ? (name === 'reservationnote' ? matches[0].rawValue ?? null : matches[0].value) : null;
};

function validExpected(stay, expected) {
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const bands = expected?.childBands, names = ['child1', 'child2', 'child3'];
  return Boolean(expected && validDate(stay?.arrival) && validDate(stay?.departure) && stay.arrival < stay.departure &&
    expected.arrival === stay.arrival && expected.departure === stay.departure && /^\d+$/.test(String(expected.guestId ?? '')) &&
    ['roomType', 'ratePlan', 'note', 'guarantee'].every((key) => typeof expected[key] === 'string' && expected[key].trim()) &&
    Number.isInteger(expected.adults) && expected.adults > 0 && Number.isInteger(expected.children) && expected.children >= 0 &&
    bands && Object.keys(bands).length === names.length && names.every((name) => Number.isInteger(bands[name]) && bands[name] >= 0) &&
    names.reduce((sum, name) => sum + bands[name], 0) === expected.children);
}

function compareRecord(fields, expected) {
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const displayDate = (iso) => `${iso.slice(8, 10)}-${months[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}`;
  const mismatches = [];
  for (const [field, name, wanted] of [
    ['arrival', 'arrivaldate', displayDate(expected.arrival)], ['departure', 'departuredate', displayDate(expected.departure)],
    ['adults', 'adults', expected.adults], ['children', 'children', expected.children],
    ['roomType', 'roomtype', expected.roomType], ['ratePlan', 'rateplan', expected.ratePlan],
    ['note', 'reservationnote', expected.note], ['guestId', 'guestid', expected.guestId], ['status', 'status', 'Reserved'],
    ['firstName', 'firstname', 'Proof'], ['lastName', 'lastname', 'Labtest'],
    ['sourceOfBusiness', 'sourceofbusinessdesc', expected.source], ['organization', 'company', expected.organization],
    ['guaranteeType', 'guaranteetype', expected.guarantee], ['cmsSend', 'udfchkbox04', false],
    ['cmsRecipient', 'udfchar13', ''], ['guestEmail', 'emailaddress', ''],
    ...Object.entries(expected.childBands || {}).map(([name, value]) => [name, name, value]),
  ]) {
    if (wanted == null) continue;
    const actual = uniqueValue(fields, name);
    if (actual == null || (['note', 'guestId', 'firstName', 'lastName', 'roomType', 'ratePlan'].includes(field) ? String(actual) !== String(wanted) : !same(actual, wanted))) {
      mismatches.push({ field, expected: wanted, actual, ...(actual == null ? { issue: 'not_visible_or_ambiguous' } : {}) });
    }
  }
  return mismatches;
}

/** Independently reopen one confirmation and compare the visible Record View. */
export async function readLabtestCreate({ confirmation, stay, expected }, { withSavedSession = withSavedStayAgentSession } = {}) {
  if (!validExpected(stay, expected)) return { issue: 'expected_record_invalid' };
  const read = await withSavedSession(({ runTool }) => runTool({ tool: 'read', confirmation,
    guestName: 'Proof Labtest', arrivalDate: stay.arrival }));
  const fields = read?.record?.details?.fields;
  return read.outcome === 'ok' && Array.isArray(fields) ? { fields, captureScope: read.record.details.captureScope,
    mismatches: compareRecord(fields, expected) } : { issue: 'readback_unverified', detail: read };
}

const readCensus = (stay) => withCenturionStay360Page((page) => searchLabtestPreimage(page, {
  arrival: stay.arrival, departure: stay.departure,
}), { headless: true });

/** A fresh census and record reads are evidence only; this never dispatches a save. */
export async function reconcileLabtestCreate({ stay, expected }, { census = readCensus, withSavedSession = withSavedStayAgentSession } = {}) {
  let result;
  try { result = await census(stay); } catch { result = { outcome: 'incomplete', issue: 'census_unverified' }; }
  const candidates = [];
  const rows = result?.outcome === 'existing_matches' && result.coverage?.complete && Array.isArray(result.sameArrival) ? result.sameArrival : [];
  for (const row of rows) {
    try { candidates.push({ confirmation: row.confirmation, readback: await readLabtestCreate({ confirmation: row.confirmation, stay, expected }, { withSavedSession }) }); }
    catch { candidates.push({ confirmation: row.confirmation, issue: 'readback_unverified' }); }
  }
  return { census: result, candidates };
}
