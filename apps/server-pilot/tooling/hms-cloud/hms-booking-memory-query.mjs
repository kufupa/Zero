import { createHash } from 'node:crypto';
import { HINT_LABELS, PARTY_FIELDS, SOURCES, combinationKey, emailsIn, text, verifiedConfirmations } from './hms-booking-memory-common.mjs';

const ROLES = new Set(['outbound-recipient', 'outbound-sender', 'inbound-sender']);
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const nameKey = value => text(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const bounded = (value, fallback, max) => Number.isFinite(value)
  ? Math.max(1, Math.min(max, Math.floor(value))) : fallback;

function normalizeQuery(input, options) {
  if (typeof input === 'string') {
    const value = text(input);
    input = value.includes('@') ? { email: value }
      : /^[\w.-]+\.[A-Za-z]{2,}$/.test(value) ? { domain: value } : { name: value };
  }
  if (!input || typeof input !== 'object') throw new TypeError('Query must be a string or query object.');
  const keys = ['email', 'domain', 'name'].filter(key => text(input[key]));
  if (keys.length !== 1) throw new TypeError('Provide exactly one email, domain, or name.');
  const type = keys[0];
  if (input.role != null && options.role != null && input.role !== options.role) throw new TypeError('Conflicting query roles.');
  const roleDefaulted = type !== 'name' && input.role == null && options.role == null;
  const role = input.role ?? options.role ?? (roleDefaulted ? 'outbound-recipient' : null);
  if (type !== 'name' && !ROLES.has(role)) throw new TypeError('Invalid address role.');
  if (type === 'name' && role !== null) throw new TypeError('Address roles apply only to email and domain queries.');
  const value = text(input[type]);
  if (type === 'email') {
    const addresses = emailsIn(value);
    if (addresses.length !== 1) throw new TypeError('Email query must contain exactly one address.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addresses[0])) throw new TypeError('Invalid email address.');
    return { type, role, roleDefaulted, normalized: addresses[0] };
  }
  if (type === 'domain') {
    const domain = value.toLowerCase().replace(/^@/, '');
    if (!DOMAIN.test(domain)) throw new TypeError('Domain query must be an exact domain name.');
    return { type, role, roleDefaulted, normalized: domain };
  }
  const name = nameKey(value);
  if (!name) throw new TypeError('Name query must contain searchable characters.');
  return { type, role, roleDefaulted, normalized: name };
}

function pmsEvidence(observation, outcome) {
  const { confirmationNumber, observationId, snapshotId, snapshotDate, sourceOfBusiness, sourceType, provenance } = observation;
  const { outcomeSource, fieldSources, conflictingFields, fieldConflicts } = outcome;
  return { confirmationNumber, observationId, snapshotId, snapshotDate, sourceOfBusiness: sourceOfBusiness || null,
    sourceType: sourceType || null, provenance: provenance || null, outcomeSource, fieldSources, conflictingFields,
    fieldConflicts: fieldConflicts || null };
}

function boundedEvidence(record, limit, stringLimit = Infinity) {
  const truncations = {};
  const stringTruncations = {};
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      if (value.length > limit) truncations[path] = value.length;
      return value.slice(0, limit).map((item, index) => visit(item, `${path}[${index}]`));
    }
    if (typeof value === 'string' && value.length > stringLimit) {
      stringTruncations[path] = value.length;
      return value.slice(0, stringLimit);
    }
    return value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, path ? `${path}.${key}` : key)]))
      : value;
  };
  const result = visit(record, '');
  return { ...result, truncated: Object.keys(truncations).length > 0 || Object.keys(stringTruncations).length > 0,
    nestedEvidenceTruncations: truncations, ...(Number.isFinite(stringLimit) ? { nestedStringTruncations: stringTruncations } : {}) };
}

const uncertainLink = item => item.linkMethod === 'confirmation-number-candidate'
  || item.linkProvenance?.ambiguousAttachment || item.linkProvenance?.labeledConfirmationMatch !== true
  || item.linkProvenance?.subjectHasOtherConfirmation;

function historicalHintResults(observations, matchedKeys, anchoredKeys, byAddress, queryType, countsBySource,
  limit, evidenceLimit, includeEvidence, hasNativeAnchor) {
  const matched = observations.filter(observation => matchedKeys.has(observation.confirmationKey));
  const count = filter => new Set(matched.filter(filter).map(item => item.confirmationKey)).size;
  const status = item => item.historicalIdentity?.nativeConfirmation;
  const eligible = matched.filter(item => anchoredKeys.has(item.confirmationKey)
    && status(item) === 'matched' && item.historicalHints);
  const identityCoverage = {
    countingUnit: 'distinct_observed_confirmations',
    lookupCompletenessScope: 'reader_reported_searched_range',
    unverifiedMatchConfirmationCount: [...matchedKeys].filter(key => !anchoredKeys.has(key)).length,
    nativeConfirmationMatchedCount: count(item => status(item) === 'matched'),
    nativeConfirmationMismatchCount: count(item => status(item) === 'mismatch'),
    nativeConfirmationMissingCount: count(item => status(item) === 'missing'),
    nativeConfirmationUnverifiedViewCount: count(item => status(item) === 'unverified_view'),
    historicalCoverageUnknownCount: count(item => !anchoredKeys.has(item.confirmationKey) || !item.historicalHints
      || !['matched', 'mismatch', 'missing', 'unverified_view'].includes(status(item))),
    multipleMatchSelectionConfirmationCount: count(item => item.historicalIdentity?.selectionMultiplicity === 'multiple'),
    completeLookupConfirmationCount: count(item => item.historicalIdentity?.lookupResultsComplete === true),
    incompleteLookupConfirmationCount: count(item => item.historicalIdentity?.lookupResultsComplete === false),
    unknownLookupCompletenessConfirmationCount: count(item =>
      typeof item.historicalIdentity?.lookupResultsComplete !== 'boolean'),
    suppliedVerifiedStayIdConfirmationCount: count(item => Boolean(text(item.provenance?.verifiedStayId))),
  };
  const result = { identityCoverage };
  for (const field of Object.values(HINT_LABELS)) {
    const groups = new Map();
    const valuesByConfirmation = new Map();
    const recorded = new Set();
    const blank = new Set();
    const missing = new Set();
    const unavailable = new Set();
    const unknown = new Set(matched.filter(item => !anchoredKeys.has(item.confirmationKey)
      || status(item) !== 'matched' || !item.historicalHints)
      .map(item => item.confirmationKey));
    const missingSources = { recordView: new Set(), stay360: new Set() };
    const unavailableSources = { recordView: new Set(), stay360: new Set() };
    const unknownSources = { recordView: new Set(), stay360: new Set() };
    for (const observation of matched) {
      const fields = observation.historicalHints?.[field];
      const incompleteSources = Array.isArray(fields?.incompleteSources) ? fields.incompleteSources : [];
      for (const source of Object.keys(unknownSources)) {
        if (!Array.isArray(fields?.[source]) || incompleteSources.includes(source)) {
          unknownSources[source].add(observation.confirmationKey);
        }
      }
    }
    for (const observation of eligible) {
      const confirmation = observation.confirmationKey;
      const fields = observation.historicalHints[field];
      const arrays = Object.keys(missingSources).map(source => [source,
        Array.isArray(fields?.[source]) ? fields[source] : null]);
      const incompleteSources = Array.isArray(fields?.incompleteSources) ? fields.incompleteSources : [];
      for (const [source, values] of arrays) {
        if (values === null || incompleteSources.includes(source)) {
          unknown.add(confirmation);
        }
      }
      if (arrays.every(([source, values]) => values && !values.length && !incompleteSources.includes(source))) {
        missing.add(confirmation);
      }
      const inObservation = new Map();
      for (const [source, values] of arrays) {
        if (!values) continue;
        if (!values.length && !incompleteSources.includes(source)) missingSources[source].add(confirmation);
        for (const value of values) {
          if (typeof value !== 'string' && typeof value !== 'number') {
            unavailable.add(confirmation);
            unavailableSources[source].add(confirmation);
            continue;
          }
          const normalized = text(value);
          const key = normalized.normalize('NFKC').toLowerCase();
          const item = inObservation.get(key) || { value: normalized, sources: new Set() };
          item.sources.add(source);
          inObservation.set(key, item);
        }
      }
      for (const [key, item] of inObservation) {
        recorded.add(confirmation);
        if (!item.value) blank.add(confirmation);
        const seen = valuesByConfirmation.get(confirmation) || new Set();
        seen.add(key);
        valuesByConfirmation.set(confirmation, seen);
        const group = groups.get(key) || { value: item.value, confirmations: new Set(), entries: [], sources: new Set() };
        group.confirmations.add(confirmation);
        group.entries.push(observation);
        for (const source of item.sources) group.sources.add(source);
        groups.set(key, group);
      }
    }
    const sorted = [...groups.entries()].sort(([keyA, a], [keyB, b]) =>
      b.confirmations.size - a.confirmations.size || keyA.localeCompare(keyB));
    const values = sorted.slice(0, limit).map(([, group]) => {
      const item = {
        value: group.value.slice(0, 256), valueTruncated: group.value.length > 256,
        confirmationCount: group.confirmations.size,
        pmsObservationCount: new Set(group.entries.map(entry => entry.observationId)).size,
        sourceOfBusinessCounts: countsBySource(group.entries.map(observation => ({ observation }))),
        fieldSources: [...group.sources],
      };
      if (item.valueTruncated) {
        item.valueLength = group.value.length;
        item.valueSha256 = createHash('sha256').update(group.value).digest('hex');
      }
      if (queryType !== 'name') item.uncertainLinkConfirmationCount = [...group.confirmations].filter(key =>
        (byAddress.get(key) || []).some(link => uncertainLink(link) || !hasNativeAnchor(link))).length;
      if (includeEvidence) {
        const records = [...group.confirmations].sort().slice(0, evidenceLimit).map(key => {
          const pms = group.entries.filter(entry => entry.confirmationKey === key);
          const addresses = (byAddress.get(key) || []).map(({ confirmationKey: _confirmationKey, ...address }) => ({
            ...address, linkedPmsSnapshotIds: Array.from(address.linkedPmsSnapshotIds || []), matchedQuery: true,
          }));
          return boundedEvidence({
            confirmationNumber: pms[0]?.confirmationNumber || null,
            pmsObservations: pms.map(({ observationId, snapshotId, snapshotDate, sourceOfBusiness, sourceType,
              provenance, historicalIdentity, historicalHints }) => ({
              observationId, snapshotId, snapshotDate, sourceOfBusiness, sourceType, provenance,
              historicalIdentity, fieldValues: historicalHints[field],
            })),
            addressSources: addresses,
          }, evidenceLimit, 256);
        });
        item.evidence = { confirmationRecords: records, totalConfirmationRecords: group.confirmations.size,
          truncated: group.confirmations.size > evidenceLimit || records.some(record => record.truncated) };
      }
      return item;
    });
    result[field] = {
      coverage: {
        recordedConfirmationCount: recorded.size, blankConfirmationCount: blank.size,
        missingConfirmationCount: missing.size, unavailableConfirmationCount: unavailable.size,
        unknownFieldConfirmationCount: unknown.size,
        conflictingConfirmationCount: [...valuesByConfirmation.values()].filter(seen => seen.size > 1).length,
        missingFieldSourceCounts: Object.fromEntries(Object.entries(missingSources).map(([key, set]) => [key, set.size])),
        unavailableFieldSourceCounts: Object.fromEntries(Object.entries(unavailableSources).map(([key, set]) => [key, set.size])),
        unknownFieldSourceCounts: Object.fromEntries(Object.entries(unknownSources).map(([key, set]) => [key, set.size])),
      },
      valueCount: sorted.length, values, valuesTruncated: sorted.length > limit,
    };
  }
  return result;
}

function choiceStatus({ combination, entries }) {
  if (PARTY_FIELDS.some(field => text(combination[field]))) return 'has_recorded_choice';
  if (PARTY_FIELDS.every(field => combination[field] === '')) return 'all_party_fields_observed_blank';
  return entries.some(item => item.outcome.conflictingFields?.length)
    ? 'conflicting_observations' : 'no_recorded_choice_observed';
}

/** Query names, or exact addresses/domains with one historical address role. */
export function queryHmsBookingMemory(memory, queryInput, options = {}) {
  if (!memory || !Array.isArray(memory.observations) || !Array.isArray(memory.addressEvidence)) {
    throw new TypeError('memory must come from buildHmsBookingMemory or loadHmsBookingMemory.');
  }
  verifiedConfirmations(memory.observations);
  const query = normalizeQuery(queryInput, options);
  const sources = [options.sourceOfBusiness ?? SOURCES].flat().map(value => text(value).toLowerCase());
  if (!sources.length || sources.some(value => !SOURCES.some(source => source.toLowerCase() === value))) {
    throw new TypeError('Invalid source of business filter.');
  }
  const sourceOf = observation => text(observation.sourceOfBusiness || memory.sourceOfBusinessFilter).toLowerCase();
  const observations = memory.observations.filter(observation => sources.includes(sourceOf(observation)));
  const countsBySource = entries => Object.fromEntries(SOURCES.map(source => [source,
    new Set(entries.filter(item => sourceOf(item.observation) === source.toLowerCase())
      .map(item => item.observation.confirmationKey)).size,
  ]));
  const limit = bounded(options.limit, 25, 200);
  const evidenceLimit = bounded(options.evidenceLimit, 20, 100);
  const conflictLimit = bounded(options.conflictLimit, 25, 200);
  const includeEvidence = options.includeEvidence === true || options.includeDetail === true;
  const matches = query.type === 'name' ? [] : memory.addressEvidence.filter(item => (
    item.role === query.role && (query.type === 'email'
      ? item.address === query.normalized : item.domain === query.normalized)
  ));
  const byAddress = Map.groupBy(matches, item => item.confirmationKey);
  const groups = new Map();
  for (const observation of observations) {
    if (query.type !== 'name' && !byAddress.has(observation.confirmationKey)) continue;
    for (const outcome of observation.outcomes) {
      const fields = query.type === 'name' ? PARTY_FIELDS.filter(field => (outcome.combination[field] == null
        ? [...(outcome.fieldConflicts?.recordView?.[field] || []), ...(outcome.fieldConflicts?.stay360?.[field] || [])]
        : [outcome.combination[field]]).some(value => nameKey(value).includes(query.normalized))) : [];
      if (query.type === 'name' && !fields.length) continue;
      const key = combinationKey(outcome.combination);
      const group = groups.get(key) || { combination: outcome.combination, confirmations: new Set(), entries: [], fields: new Set() };
      group.confirmations.add(observation.confirmationKey);
      group.entries.push({ observation, outcome });
      for (const field of fields) group.fields.add(field);
      groups.set(key, group);
    }
  }
  const sorted = [...groups.values()].sort((a, b) => b.confirmations.size - a.confirmations.size
    || combinationKey(a.combination).localeCompare(combinationKey(b.combination)));
  const candidates = sorted.slice(0, limit).map(group => {
    const candidate = {
      combination: group.combination, choiceStatus: choiceStatus(group),
      conflictingFields: [...new Set(group.entries.flatMap(item => item.outcome.conflictingFields || []))],
      support: {
        confirmationCount: group.confirmations.size,
        pmsObservationCount: new Set(group.entries.map(item => item.observation.observationId)).size,
        sourceOfBusinessCounts: countsBySource(group.entries),
      },
    };
    if (query.type === 'name') candidate.matchedFields = [...group.fields];
    else {
      const addresses = matches.filter(item => group.confirmations.has(item.confirmationKey));
      const count = role => new Set(addresses.filter(item => item.role === role).map(item => item.confirmationKey)).size;
      const records = filter => new Set(addresses.filter(filter).map(item => item.recordId)).size;
      candidate.addressSupport = {
        confirmationCount: new Set(addresses.map(item => item.confirmationKey)).size,
        outboundSenderConfirmationCount: count('outbound-sender'),
        outboundRecipientConfirmationCount: count('outbound-recipient'),
        inboundSenderConfirmationCount: count('inbound-sender'),
        outboundSenderPdfRecordCount: records(item => item.role === 'outbound-sender'),
        outboundRecipientPdfRecordCount: records(item => item.role === 'outbound-recipient'),
        inboundSenderMessageRecordCount: records(item => item.role === 'inbound-sender'),
        uncertainLinkRecordCount: records(uncertainLink),
      };
    }
    if (includeEvidence) {
      const records = [...group.confirmations].sort().slice(0, evidenceLimit).map(key => {
        const pms = group.entries.filter(item => item.observation.confirmationKey === key)
          .map(item => pmsEvidence(item.observation, item.outcome));
        const addresses = (byAddress.get(key) || []).map(({ confirmationKey: _confirmationKey, ...item }) => ({
          ...item, linkedPmsSnapshotIds: Array.from(item.linkedPmsSnapshotIds || []), matchedQuery: true,
        }));
        return boundedEvidence({
          confirmationNumber: pms[0]?.confirmationNumber || null,
          pmsObservations: pms, addressSources: addresses,
          outboundSources: addresses.filter(item => item.direction === 'outbound'),
        }, evidenceLimit);
      });
      candidate.evidence = {
        confirmationRecords: records, totalConfirmationRecords: group.confirmations.size,
        truncated: group.confirmations.size > evidenceLimit || records.some(record => record.truncated),
      };
    }
    return candidate;
  });
  const matchedKeys = new Set([...groups.values()].flatMap(group => [...group.confirmations]));
  const entries = observations.filter(observation => matchedKeys.has(observation.confirmationKey))
    .flatMap(observation => observation.outcomes.map(outcome => ({ observation, outcome })));
  const allOutcomes = new Map([...Map.groupBy(entries, item => item.observation.confirmationKey)]
    .map(([key, items]) => [key, Map.groupBy(items, item => combinationKey(item.outcome.combination))]));
  const conflicted = [...allOutcomes].filter(([, outcomes]) => {
    const items = [...outcomes.values()].flat();
    return items.some(item => item.outcome.conflictingFields?.length) || PARTY_FIELDS.some(field =>
      new Set(items.map(item => item.outcome.combination[field]).filter(value => value != null)
        .map(value => combinationKey({ [field]: value }))).size > 1);
  });
  const conflicts = conflicted.slice(0, conflictLimit).map(([confirmation, outcomes]) => {
    const variants = [...outcomes].map(([key, entries]) => ({
      combination: entries[0].outcome.combination, confirmationCount: 1,
      pmsObservationCount: new Set(entries.map(item => item.observation.observationId)).size,
      matchedQuery: groups.get(key)?.confirmations.has(confirmation) || false,
    }));
    const detail = { outcomeCount: variants.length, outcomes: variants.slice(0, limit), outcomesTruncated: variants.length > limit };
    if (includeEvidence) {
      const entries = [...outcomes.values()].flat();
      detail.evidence = boundedEvidence({
        confirmationNumber: entries[0]?.observation.confirmationNumber || null,
        pmsObservations: entries.map(item => pmsEvidence(item.observation, item.outcome)),
      }, evidenceLimit);
    }
    return detail;
  });
  const withChoice = new Set(sorted.flatMap(group => group.entries.filter(({ outcome }) =>
    PARTY_FIELDS.some(field => text(outcome.combination[field])) || outcome.conflictingFields?.length)
    .map(item => item.observation.confirmationKey)));
  const allBlank = new Set(sorted.filter(group => choiceStatus(group) === 'all_party_fields_observed_blank')
    .flatMap(group => [...group.confirmations]));
  const unresolvedConfirmationCount = [...allOutcomes.values()].filter(outcomes =>
    [...outcomes.values()].flat().every(({ outcome }) => !outcome.conflictingFields?.length
      && PARTY_FIELDS.every(field => outcome.combination[field] == null))).length;
  const sourceOfBusinessCounts = countsBySource([...groups.values()].flatMap(group => group.entries));
  const nativeMatchedPairs = new Set(memory.observations.filter(item => item.historicalIdentity?.nativeConfirmation === 'matched')
    .map(item => JSON.stringify([item.confirmationKey, item.observationId])));
  const hasNativeAnchor = item => (item.linkedPmsObservationIds || []).some(id =>
    nativeMatchedPairs.has(JSON.stringify([item.confirmationKey, id])));
  const anchoredKeys = query.type === 'name'
    ? new Set([...groups.values()].flatMap(group => group.entries.filter(item =>
      item.observation.historicalIdentity?.nativeConfirmation === 'matched').map(item => item.observation.confirmationKey)))
    : new Set(matches.filter(hasNativeAnchor).map(item => item.confirmationKey));
  const historicalHints = historicalHintResults(observations, matchedKeys, anchoredKeys, byAddress, query.type, countsBySource,
    bounded(options.hintLimit, 25, 200), evidenceLimit, includeEvidence, hasNativeAnchor);
  return {
    propertyCode: memory.propertyCode, sourceOfBusinessFilter: SOURCES.filter(source => sources.includes(source.toLowerCase())),
    sourceOfBusinessCounts,
    queryType: query.type, role: query.role, roleDefaulted: query.roleDefaulted,
    snapshots: memory.snapshots, linkage: memory.linkage,
    matchedConfirmationCount: matchedKeys.size, unresolvedConfirmationCount,
    noRecordedPartyChoiceConfirmationCount: matchedKeys.size - withChoice.size,
    allBlankObservationConfirmationCount: allBlank.size, candidateCount: sorted.length, candidates,
    candidatesTruncated: sorted.length > limit, conflictConfirmationCount: conflicted.length,
    conflicts, conflictsTruncated: conflicted.length > conflictLimit, historicalHints,
  };
}
