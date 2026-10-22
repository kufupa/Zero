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

const PROOF_FORBIDDEN_FIELDS = [
  'profileId', 'arAccount', 'billingReference', 'agency', 'bookingAgency', 'organization',
  'reservationNote', 'bookerName', 'bookerEmail',
];

export function proofModeRefusal({ request, paneCommit, env = process.env }) {
  if (!paneCommit) return 'proof_requires_pane_commit';
  if (env.RESERVATIONIST_PANE_SAVE !== 'lab') return 'proof_requires_lab_flag';
  if (PROOF_FORBIDDEN_FIELDS.some((field) => Object.hasOwn(request ?? {}, field))) {
    return 'proof_party_or_billing_fields_forbidden';
  }
  if (request?.firstName !== 'Proof' || request?.lastName !== 'Labtest') return 'proof_guest_required';
  if (!realIsoDate(request.arrival) || !realIsoDate(request.departure)
    || request.arrival < '2027-01-01' || request.departure < '2027-01-01') {
    return 'proof_dates_2027_required';
  }
  if (request.departure <= request.arrival) return 'proof_departure_after_arrival';
  return null;
}

export function proofPreSaveSearchRefusal(existingRows) {
  return Array.isArray(existingRows) ? null : 'proof_pre_save_search_unavailable';
}

export function saveClickMayHaveFired(error) {
  return !/^control_missing:/.test(String(error?.message || error));
}

export function paneCommitOutcome(proof) {
  return proof?.readbackMatch === true ? 'committed' : 'committed_unverified';
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

function possibleGuestRows(rows, expected) {
  return (Array.isArray(rows) ? rows : []).filter((stay) =>
    ['firstName', 'lastName', 'arrival', 'departure'].every((field) => {
      const actual = comparable(stay?.[field]);
      return !actual || actual === comparable(expected?.[field]);
    }));
}

function activeStay(stay) {
  return ['reserved', 'confirmed'].includes(comparable(stay?.status));
}

export async function reconcileCreateSave({
  save, expected, existingRows, readByConfirmation, searchByGuestDates,
}) {
  const result = { confNo: null, readbackMatch: null, mismatches: [], screenshot: null, unknownOutcome: null };
  let confNo = save?.confirmed === true ? String(save.confirmationNumber ?? '').trim() : '';
  if (confNo) result.confNo = confNo;

  if (!Array.isArray(existingRows)) return { ...result, unknownOutcome: 'unresolved' };
  const possibleExistingRows = possibleGuestRows(existingRows, expected);
  if (possibleExistingRows.some((stay) => !String(stay?.confirmation ?? '').trim())) {
    return { ...result, unknownOutcome: 'unresolved' };
  }
  const existingConfirmations = new Set(
    possibleExistingRows.map((stay) => String(stay.confirmation).trim()),
  );

  if (!confNo) {
    let search;
    try {
      search = await searchByGuestDates(expected);
    } catch {
      return { ...result, unknownOutcome: 'unresolved' };
    }
    result.screenshot = search?.screenshot ?? null;
    if (search?.outcome === 'not_found') return { ...result, unknownOutcome: 'not_found' };
    if (search?.outcome !== 'ok' || !Array.isArray(search.rows)) {
      return { ...result, unknownOutcome: 'unresolved' };
    }
    const possibleMatches = possibleGuestRows(search.rows, expected);
    if (possibleMatches.length === 0) return { ...result, unknownOutcome: 'not_found' };
    if (possibleMatches.some((stay) => !String(stay?.confirmation ?? '').trim())) {
      return { ...result, unknownOutcome: 'unresolved' };
    }
    const newMatches = possibleMatches.filter((stay) =>
      !existingConfirmations.has(String(stay.confirmation).trim()));
    if (newMatches.length !== 1
      || exactGuestRows(newMatches, expected).length !== 1
      || !activeStay(newMatches[0])) {
      return { ...result, unknownOutcome: 'unresolved' };
    }
    confNo = String(newMatches[0].confirmation).trim();
    result.unknownOutcome = 'found';
  }

  if (existingConfirmations.has(confNo)) return { ...result, unknownOutcome: 'unresolved' };
  let readback;
  try {
    readback = await readByConfirmation(confNo);
  } catch {
    return {
      ...result,
      unknownOutcome: 'unresolved',
      mismatches: [mismatch('reservation', 'found active confirmation', 'readback_error')],
    };
  }
  result.screenshot = readback?.screenshot ?? result.screenshot;
  if (readback?.outcome !== 'found' || !readback.stay) {
    return {
      ...result,
      unknownOutcome: 'unresolved',
      mismatches: [
        mismatch('reservation', 'found active confirmation', readback?.outcome ?? 'unavailable'),
      ],
    };
  }
  if (!activeStay(readback.stay)) {
    return {
      ...result,
      unknownOutcome: 'unresolved',
      mismatches: [mismatch('status', 'Reserved or Confirmed', readback.stay.status)],
    };
  }
  result.confNo = confNo;
  return { ...result, ...compareCreatedStay(expected, readback.stay) };
}
