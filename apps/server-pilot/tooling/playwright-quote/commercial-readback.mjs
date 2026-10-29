// Compare only the literals visible in an independently opened Guest Stay record.
// The caller must use a property-locked reader and the same approved request used for identityProof.
// A matching label is evidence of that label, not proof of the native agency or the nightly prices.

function text(value) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
}

function key(value) {
  return text(value).toLocaleLowerCase();
}

function sameText(expected, observed) {
  const left = key(expected);
  const right = key(observed);
  if (!left || !right) return 'unknown';
  return left === right ? 'same' : 'different';
}

function oneObservation(...values) {
  const present = values.map(text).filter(Boolean);
  return new Set(present.map(key)).size === 1 ? present[0] : '';
}

function isoDate(value) {
  const date = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? '' : date;
}

function sameIdentity(expected, lookup, identityProof) {
  const confirmation = text(expected?.confirmation);
  if (lookup?.outcome !== 'found' || identityProof?.readbackMatch !== true || !/^\d+-\d+$/.test(confirmation)
    || confirmation !== text(identityProof.confNo) || confirmation !== text(lookup.stay?.confirmation)
    || !Array.isArray(lookup.conflicts)
    || ['confirmation', 'firstName', 'lastName', 'arrival', 'departure', 'status']
      .some((field) => lookup.conflicts.includes(field))
    || !['reserved', 'confirmed'].includes(key(lookup.stay?.status))) return false;
  const namesMatch = ['firstName', 'lastName'].every((field) => {
    const value = key(expected?.[field]);
    return value && value === key(lookup.stay?.[field]);
  });
  return namesMatch && ['arrival', 'departure'].every((field) => {
    const value = isoDate(expected?.[field]);
    return value && value === isoDate(lookup.stay?.[field]);
  });
}

export function compareCommercialReadback({ expected, lookup, identityProof } = {}) {
  const result = {
    identity: 'unknown', ratePlanText: 'unknown', agencyName: 'unknown', agencyIata: 'unknown',
    agencyNativeId: 'unknown', nightlyPrices: 'unknown', complete: false,
  };
  if (!sameIdentity(expected, lookup, identityProof)) return result;
  const actual = lookup.commercial ?? {};
  const wantedAgency = expected?.bookingAgency ?? expected?.agency;
  const agencyName = typeof wantedAgency === 'string' ? wantedAgency : wantedAgency?.name;
  result.identity = 'matched';
  if (!lookup.conflicts.includes('ratePlan')) {
    result.ratePlanText = sameText(expected?.ratePlan, oneObservation(actual.ratePlan, lookup.stay?.ratePlan));
  }
  if (!lookup.conflicts.includes('bookingAgency')) {
    result.agencyName = sameText(agencyName, oneObservation(actual.agency?.name, lookup.stay?.bookingAgency));
  }
  result.agencyIata = sameText(wantedAgency?.iata, actual.agency?.iata);
  return result;
}
