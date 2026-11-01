import { createHash } from 'node:crypto';
import { buildHmsBookingMemory } from './hms-booking-memory.mjs';
import { text } from './hms-booking-memory-common.mjs';

const LABELS = {
  profileId: 'profile id', firstName: 'first name', lastName: 'last name',
  email: 'e-mail address', mobileNumber: 'mobile number', phoneNumber: 'phone number',
};
const FIELDS = Object.keys(LABELS);
const SEARCH_FIELDS = ['profileId', 'firstName', 'lastName', 'email'];
const normalize = value => text(value).normalize('NFKC').toLowerCase();
const validEmail = value => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value);
const limitValue = (value, fallback, max) => {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError('Invalid result limit.');
  return value;
};

function fieldObservation(fields, label) {
  if (!Array.isArray(fields)) return { state: 'unknown', values: [] };
  const found = fields.filter(field => text(field?.label).replace(/:$/, '').trim().toLowerCase() === label);
  if (!found.length) return { state: 'missing', values: [] };
  const valid = found.filter(field => typeof field.value === 'string' || typeof field.value === 'number');
  const values = [...new Set(valid.map(field => text(field.value)))];
  return {
    state: found.length !== valid.length ? 'unavailable'
      : new Set(values.map(normalize)).size > 1 ? 'conflicting' : values[0] ? 'recorded' : 'blank',
    values,
  };
}

/** Extract private guest observations using the existing booking memory's property and source rules. */
export function buildHmsGuestMemory({ propertyCode, pmsSnapshot, pmsSnapshots = [], pmsSourceFiles = [] } = {}) {
  const snapshots = [...pmsSnapshots, ...(pmsSnapshot ? [pmsSnapshot] : [])];
  const booking = buildHmsBookingMemory({ propertyCode, pmsSnapshots: snapshots, pmsSourceFiles });
  const observations = booking.observations.map(observation => {
    const snapshotIndex = Number(observation.snapshotId.slice(4)) - 1;
    const resultIndex = Number(observation.observationId.slice(observation.snapshotId.length + 1)) - 1;
    const result = snapshots[snapshotIndex].results[resultIndex];
    const snapshot = booking.snapshots[snapshotIndex];
    const fields = Object.fromEntries(FIELDS.map(field => [field,
      fieldObservation(result?.recordView?.details?.fields, LABELS[field])]));
    // Include the original result in a content fingerprint, not in the returned memory.
    const fingerprint = createHash('sha256').update(JSON.stringify([
      booking.propertyCode, snapshot.startedAt, snapshot.updatedAt, snapshot.sourceType, result,
    ])).digest('hex');
    return {
      observationId: observation.observationId, fingerprint, confirmationKey: observation.confirmationKey,
      confirmationNumber: observation.confirmationNumber, sourceOfBusiness: observation.sourceOfBusiness,
      snapshot: { ...snapshot }, provenance: observation.provenance,
      historicalIdentity: observation.historicalIdentity, fields,
    };
  });
  return {
    schemaVersion: 1, propertyCode: booking.propertyCode, sourceOfBusinessFilter: booking.sourceOfBusinessFilter,
    snapshots: booking.snapshots, linkage: booking.linkage, observations,
  };
}

/** Return historical candidates, never a profile selection or proof of current identity. */
export function queryHmsGuestMemory(memory, { propertyCode, ...input } = {}, options = {}) {
  if (!memory || !Array.isArray(memory.observations) || !text(memory.propertyCode)) {
    throw new TypeError('memory must come from buildHmsGuestMemory.');
  }
  if (!text(propertyCode) || text(propertyCode).toUpperCase() !== memory.propertyCode) {
    throw new TypeError('An exact matching propertyCode is required.');
  }
  if (Object.keys(input).some(key => !SEARCH_FIELDS.includes(key))) throw new TypeError('Unknown guest query field.');
  if (Object.values(input).some(value => value != null && typeof value !== 'string' && typeof value !== 'number')) {
    throw new TypeError('Guest query values must be strings or numbers.');
  }
  const query = Object.fromEntries(SEARCH_FIELDS.map(field => [field, normalize(input[field])]));
  const missing = [];
  if (!query.profileId && !query.email && !(query.firstName && query.lastName)) {
    if (!query.firstName) missing.push('firstName');
    if (!query.lastName) missing.push('lastName');
  }
  const base = {
    propertyCode: memory.propertyCode, sourceOfBusinessFilter: memory.sourceOfBusinessFilter,
    limitations: ['historical_only', 'not_identity_proof', 'not_current_hms_lookup', 'not_a_selection'],
  };
  if (missing.length) return { ...base, outcome: 'input_gap', missing, alternatives: ['email', 'profileId'], candidates: [] };
  if ((query.profileId && !/^\d+$/.test(query.profileId)) || (query.email && !validEmail(query.email))) {
    return { ...base, outcome: 'input_gap', issue: 'invalid_guest_criterion', candidates: [] };
  }
  const limit = limitValue(options.limit, 25, 100);
  const evidenceLimit = limitValue(options.evidenceLimit, 10, 50);
  const eligible = memory.observations.filter(item => item.historicalIdentity?.nativeConfirmation === 'matched'
    && item.fields?.profileId?.state === 'recorded' && /^\d+$/.test(item.fields.profileId.values[0]));
  const coverage = {
    countingUnit: 'pms_observations', input: memory.linkage, snapshots: memory.snapshots,
    observations: memory.observations.length, identityEligibleObservations: eligible.length,
    excludedIdentityObservations: memory.observations.length - eligible.length,
    identityStatusCounts: Object.fromEntries(['matched', 'mismatch', 'missing', 'unverified_view'].map(status => [status,
      memory.observations.filter(item => item.historicalIdentity?.nativeConfirmation === status).length])),
    unknownIdentityStatusObservations: memory.observations.filter(item =>
      !['matched', 'mismatch', 'missing', 'unverified_view'].includes(item.historicalIdentity?.nativeConfirmation)).length,
    profileIdStates: Object.fromEntries(['recorded', 'blank', 'missing', 'unavailable', 'unknown', 'conflicting'].map(state => [state,
      memory.observations.filter(item => item.fields?.profileId?.state === state).length])),
    nonnumericProfileIdObservations: memory.observations.filter(item => item.fields?.profileId?.state === 'recorded'
      && !/^\d+$/.test(item.fields.profileId.values[0])).length,
    fieldStates: Object.fromEntries(FIELDS.map(field => [field, Object.fromEntries(
      ['recorded', 'blank', 'missing', 'unavailable', 'unknown', 'conflicting'].map(state => [state,
        eligible.filter(item => item.fields[field]?.state === state).length]))])),
  };
  const matches = eligible.filter(item => SEARCH_FIELDS.every(field => !query[field]
    || item.fields[field].values.some(value => normalize(value) === query[field])));
  const uncertainMatch = item => SEARCH_FIELDS.some(field => query[field] && item.fields[field].state !== 'recorded');
  const matchedIds = new Set(matches.map(item => item.fields.profileId.values[0]));
  const groups = Map.groupBy(eligible.filter(item => matchedIds.has(item.fields.profileId.values[0])),
    item => item.fields.profileId.values[0]);
  const matchedObservationIds = new Set(matches.map(item => item.observationId));
  const candidates = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([profileId, entries]) => {
    const matched = entries.filter(item => matchedObservationIds.has(item.observationId));
    const values = Object.fromEntries(FIELDS.filter(field => field !== 'profileId').map(field => [field,
      [...new Set(entries.flatMap(item => item.fields[field].values).filter(Boolean))]]));
    const evidence = entries.slice(0, evidenceLimit).map(item => ({
      observationId: item.observationId, fingerprint: item.fingerprint, confirmationNumber: item.confirmationNumber,
      sourceOfBusiness: item.sourceOfBusiness, snapshot: item.snapshot, provenance: item.provenance,
      historicalIdentity: item.historicalIdentity, fields: item.fields,
      fieldSource: 'recordView.details.fields', matchedQuery: matchedObservationIds.has(item.observationId),
      uncertainMatch: matchedObservationIds.has(item.observationId) && uncertainMatch(item),
    }));
    return {
      profileId, values,
      fieldStates: Object.fromEntries(FIELDS.map(field => [field, Object.fromEntries(
        ['recorded', 'blank', 'missing', 'unavailable', 'unknown', 'conflicting'].map(state => [state,
          entries.filter(item => item.fields[field].state === state).length]))])),
      sourceOfBusinessCounts: Object.fromEntries(memory.sourceOfBusinessFilter.map(source => [source,
        new Set(entries.filter(item => normalize(item.sourceOfBusiness) === normalize(source))
          .map(item => item.confirmationKey)).size])),
      conflictingFields: Object.keys(values).filter(field => new Set(values[field].map(normalize)).size > 1
        || entries.some(item => item.fields[field].state === 'conflicting')),
      support: { matchedObservationCount: matched.length,
        matchedObservationsWithUncertainCriteriaCount: matched.filter(uncertainMatch).length, observationCount: entries.length,
        matchedConfirmationCount: new Set(matched.map(item => item.confirmationKey)).size,
        confirmationCount: new Set(entries.map(item => item.confirmationKey)).size },
      evidence, evidenceTruncated: entries.length > evidenceLimit,
    };
  });
  return { ...base, outcome: candidates.length ? 'candidates' : 'no_match', coverage,
    candidateCount: groups.size, candidates, candidatesTruncated: groups.size > limit };
}
