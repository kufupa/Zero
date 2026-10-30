import { PARTY_FIELDS, SOURCES, combinationKey, emailsIn, text } from './hms-booking-memory-common.mjs';

const ROLES = new Set(['outbound-recipient', 'outbound-sender', 'inbound-sender']);
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
    if (addresses.length !== 1 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addresses[0])) {
      throw new TypeError('Email query must contain exactly one address.');
    }
    return { type, role, roleDefaulted, normalized: addresses[0] };
  }
  if (type === 'domain') {
    const domain = value.toLowerCase().replace(/^@/, '');
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(domain)) {
      throw new TypeError('Domain query must be an exact domain name.');
    }
    return { type, role, roleDefaulted, normalized: domain };
  }
  const name = nameKey(value);
  if (!name) throw new TypeError('Name query must contain searchable characters.');
  return { type, role, roleDefaulted, normalized: name };
}

function pmsEvidence(observation, outcome) {
  return {
    confirmationNumber: observation.confirmationNumber, observationId: observation.observationId,
    snapshotId: observation.snapshotId, snapshotDate: observation.snapshotDate,
    sourceOfBusiness: observation.sourceOfBusiness || null, sourceType: observation.sourceType || null,
    provenance: observation.provenance || null, outcomeSource: outcome.outcomeSource,
    fieldSources: outcome.fieldSources, conflictingFields: outcome.conflictingFields,
    fieldConflicts: outcome.fieldConflicts || null,
  };
}

function boundedEvidence(record, limit) {
  const truncations = {};
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      if (value.length > limit) truncations[path] = value.length;
      return value.slice(0, limit).map((item, index) => visit(item, `${path}[${index}]`));
    }
    return value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, path ? `${path}.${key}` : key)]))
      : value;
  };
  const result = visit(record, '');
  return { ...result, truncated: Object.keys(truncations).length > 0, nestedEvidenceTruncations: truncations };
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
      const fields = query.type === 'name' ? PARTY_FIELDS.filter(field => [
        outcome.combination[field], ...(outcome.fieldConflicts?.recordView?.[field] || []),
        ...(outcome.fieldConflicts?.stay360?.[field] || []),
      ].some(value => nameKey(value).includes(query.normalized))) : [];
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
        uncertainLinkRecordCount: records(item => item.linkProvenance?.ambiguousAttachment
          || item.linkProvenance?.labeledConfirmationMatch !== true
          || item.linkProvenance?.subjectHasOtherConfirmation),
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
  const conflicted = [...allOutcomes].filter(([, outcomes]) => outcomes.size > 1
    || [...outcomes.values()].flat().some(item => item.outcome.conflictingFields?.length));
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
  const withChoice = new Set(sorted.filter(group => ['has_recorded_choice', 'conflicting_observations']
    .includes(choiceStatus(group))).flatMap(group => [...group.confirmations]));
  const allBlank = new Set(sorted.filter(group => choiceStatus(group) === 'all_party_fields_observed_blank')
    .flatMap(group => [...group.confirmations]));
  const unresolvedConfirmationCount = [...allOutcomes.values()].filter(outcomes =>
    [...outcomes.values()].flat().every(({ outcome }) => !outcome.conflictingFields?.length
      && PARTY_FIELDS.every(field => outcome.combination[field] == null))).length;
  const sourceOfBusinessCounts = countsBySource([...groups.values()].flatMap(group => group.entries));
  return {
    propertyCode: memory.propertyCode, sourceOfBusinessFilter: SOURCES.filter(source => sources.includes(source.toLowerCase())),
    sourceOfBusinessCounts,
    queryType: query.type, role: query.role, roleDefaulted: query.roleDefaulted,
    snapshots: memory.snapshots, linkage: memory.linkage,
    matchedConfirmationCount: matchedKeys.size, unresolvedConfirmationCount,
    noRecordedPartyChoiceConfirmationCount: matchedKeys.size - withChoice.size,
    allBlankObservationConfirmationCount: allBlank.size, candidateCount: sorted.length, candidates,
    candidatesTruncated: sorted.length > limit, conflictConfirmationCount: conflicted.length,
    conflicts, conflictsTruncated: conflicted.length > conflictLimit,
  };
}
