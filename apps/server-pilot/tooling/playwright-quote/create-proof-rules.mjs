function comparable(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function guestName(stay) {
  return [stay?.firstName, stay?.lastName].map((part) => String(part ?? '').trim()).filter(Boolean).join(' ');
}

function mismatch(field, expected, actual) {
  return { field, expected: expected ?? null, actual: actual ?? null };
}

function realIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function proofModeRefusal({ request, paneCommit, env = process.env }) {
  if (!paneCommit) return 'proof_requires_pane_commit';
  if (env.RESERVATIONIST_PANE_SAVE !== 'lab') return 'proof_requires_lab_flag';
  if (request?.firstName !== 'Proof' || request?.lastName !== 'Labtest') return 'proof_guest_required';
  if (!realIsoDate(request.arrival) || !realIsoDate(request.departure)
    || request.arrival < '2027-01-01' || request.departure < '2027-01-01') {
    return 'proof_dates_2027_required';
  }
  if (request.departure <= request.arrival) return 'proof_departure_after_arrival';
  return null;
}

export function saveClickMayHaveFired(error) {
  return !/^control_missing:/.test(String(error?.message || error));
}

export function compareCreatedStay(expected, actual) {
  const mismatches = [];
  for (const field of ['arrival', 'departure', 'roomType']) {
    if (!comparable(expected?.[field]) || comparable(expected[field]) !== comparable(actual?.[field])) {
      mismatches.push(mismatch(field, expected?.[field], actual?.[field]));
    }
  }
  const expectedName = guestName(expected);
  const actualName = guestName(actual);
  if (!comparable(expectedName) || comparable(expectedName) !== comparable(actualName)) {
    mismatches.push(mismatch('guestName', expectedName, actualName));
  }
  return { readbackMatch: mismatches.length === 0, mismatches };
}

function exactGuestRows(rows, expected) {
  return (Array.isArray(rows) ? rows : []).filter((stay) =>
    comparable(stay?.firstName) === comparable(expected?.firstName)
      && comparable(stay?.lastName) === comparable(expected?.lastName)
      && comparable(stay?.arrival) === comparable(expected?.arrival)
      && comparable(stay?.departure) === comparable(expected?.departure));
}

export async function reconcileCreateSave({ save, expected, readByConfirmation, searchByGuestDates }) {
  const result = { confNo: null, readbackMatch: null, mismatches: [], screenshot: null, unknownOutcome: null };
  let confNo = save?.confirmed === true ? String(save.confirmationNumber ?? '').trim() : '';

  if (!confNo) {
    let search;
    try {
      search = await searchByGuestDates(expected);
    } catch {
      return { ...result, unknownOutcome: 'unresolved' };
    }
    result.screenshot = search?.screenshot ?? null;
    if (search?.outcome === 'not_found') return { ...result, unknownOutcome: 'not_found' };
    if (search?.outcome !== 'ok') return { ...result, unknownOutcome: 'unresolved' };
    const matches = exactGuestRows(search.matches, expected);
    if (matches.length === 0) return { ...result, unknownOutcome: 'not_found' };
    if (matches.length !== 1 || !String(matches[0]?.confirmation ?? '').trim()) {
      return { ...result, unknownOutcome: 'unresolved' };
    }
    confNo = String(matches[0].confirmation).trim();
    result.unknownOutcome = 'found';
  }

  result.confNo = confNo;
  let readback;
  try {
    readback = await readByConfirmation(confNo);
  } catch {
    result.readbackMatch = false;
    result.mismatches = [mismatch('reservation', 'found by confirmation', 'readback_error')];
    return result;
  }
  result.screenshot = readback?.screenshot ?? result.screenshot;
  if (readback?.outcome !== 'found' || !readback.stay) {
    result.readbackMatch = false;
    result.mismatches = [mismatch('reservation', 'found by confirmation', readback?.outcome ?? 'unavailable')];
    return result;
  }
  return { ...result, ...compareCreatedStay(expected, readback.stay) };
}
