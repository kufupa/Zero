import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { HINT_LABELS, PARTY_FIELDS, SOURCES, combinationKey, confirmationKey, emailsIn, text, verifiedConfirmations } from './hms-booking-memory-common.mjs';

export { queryHmsBookingMemory } from './hms-booking-memory-query.mjs';

const LABELS = {
  'primary booking agency': 'bookingAgency',
  'booking agency': 'bookingAgency',
  'booking agency contract': 'bookingAgencyContract',
  organization: 'organization',
  'a/r account': 'arAccount',
};
const labelOf = field => text(field?.label).replace(/:$/, '').trim().toLowerCase();
const RESERVATION_NOTE_LABEL = 'reservation note / billing instructions';

function historicalHintFields(result) {
  const recordFields = result?.recordView?.details?.fields;
  const cards = result?.stay360?.details?.cards;
  const sources = {
    recordView: Array.isArray(recordFields) ? recordFields : null,
    stay360: Array.isArray(cards) ? cards.flatMap(card => Array.isArray(card?.fields) ? card.fields : []) : null,
  };
  const incompleteSources = Array.isArray(cards) && cards.some(card => !Array.isArray(card?.fields)) ? ['stay360'] : [];
  return Object.fromEntries(Object.entries(HINT_LABELS).map(([label, key]) => [key,
    { ...Object.fromEntries(Object.entries(sources).map(([source, fields]) => [source,
      fields && fields.filter(field => labelOf(field) === label).map(field =>
        typeof field?.value === 'string' || typeof field?.value === 'number' ? field.value : null),
    ])), incompleteSources },
  ]));
}

function historicalNoteFields(result) {
  const recordFields = result?.recordView?.details?.fields;
  const cards = result?.stay360?.details?.cards;
  const sources = {
    recordView: Array.isArray(recordFields) ? recordFields : null,
    stay360: Array.isArray(cards) ? cards.flatMap(card => Array.isArray(card?.fields) ? card.fields : []) : null,
  };
  const incompleteSources = Array.isArray(cards) && cards.some(card => !Array.isArray(card?.fields))
    ? ['stay360'] : [];
  return {
    ...Object.fromEntries(Object.entries(sources).map(([source, fields]) => [source,
      fields && fields.filter(field => labelOf(field) === RESERVATION_NOTE_LABEL).map(field =>
        typeof field?.value === 'string' ? field.value
          : typeof field?.value === 'number' ? String(field.value) : null),
    ])),
    incompleteSources,
  };
}

function historicalIdentity(result, key) {
  const record = result?.recordView?.details;
  const stay = result?.stay360;
  const [recordConfirmation, headerConfirmation, echoedConfirmation] = [record?.confirmationInRecord,
    stay?.details?.confirmationInHeader, stay?.confirmation].map(confirmationKey);
  const mismatch = [recordConfirmation, headerConfirmation, echoedConfirmation].some(value => value && value !== key);
  const nativeConfirmation = mismatch ? 'mismatch' : !recordConfirmation || !headerConfirmation ? 'missing'
    : record?.activeTab !== 'Record View' || stay?.ok !== true ? 'unverified_view' : 'matched';
  const selectionEvidence = text(stay?.matchSelection) || null;
  return {
    nativeConfirmation, selectionEvidence,
    selectionMultiplicity: selectionEvidence ? 'multiple' : 'not_reported',
    lookupResultsComplete: typeof stay?.searchResults?.complete === 'boolean' ? stay.searchResults.complete : null,
    searchedDateRange: stay?.searchedDateRange || null,
  };
}

function readFields(fields, path) {
  const found = Object.fromEntries(PARTY_FIELDS.map(field => [field, []]));
  for (const field of Array.isArray(fields) ? fields : []) {
    const key = LABELS[labelOf(field)];
    if (!key || (typeof field.value !== 'string' && typeof field.value !== 'number')) continue;
    const value = text(field.value);
    if (!found[key].some(item => combinationKey({ [key]: item }) === combinationKey({ [key]: value }))) found[key].push(value);
  }
  return {
    values: Object.fromEntries(PARTY_FIELDS.map(key => [key, found[key].length === 1 ? found[key][0] : null])),
    sources: Object.fromEntries(PARTY_FIELDS.map(key => [key, found[key].length ? path : null])),
    conflicts: Object.fromEntries(PARTY_FIELDS.filter(key => found[key].length > 1).map(key => [key, found[key]])),
  };
}

function outcomeVariants(result) {
  const record = readFields(result?.recordView?.details?.fields, 'recordView.details.fields');
  const cardList = result?.stay360?.details?.cards;
  const cards = readFields(Array.isArray(cardList)
    ? cardList.flatMap(card => Array.isArray(card?.fields) ? card.fields : []) : [],
    'stay360.details.cards[].fields');
  const conflicts = new Set([...Object.keys(record.conflicts), ...Object.keys(cards.conflicts)]);
  for (const field of PARTY_FIELDS) {
    if (record.sources[field] && cards.sources[field]
      && combinationKey({ [field]: record.values[field] }) !== combinationKey({ [field]: cards.values[field] })) {
      conflicts.add(field);
    }
  }
  const variant = (first, second, outcomeSource) => ({
    combination: Object.fromEntries(PARTY_FIELDS.map(field => [
      field, first.sources[field] ? first.values[field] : conflicts.size ? null : second.values[field],
    ])),
    fieldSources: Object.fromEntries(PARTY_FIELDS.map(field => [
      field, first.sources[field] || (conflicts.size ? null : second.sources[field]),
    ])),
    outcomeSource,
    conflictingFields: [...conflicts],
    fieldConflicts: { recordView: record.conflicts, stay360: cards.conflicts },
  });
  const primary = variant(record, cards, conflicts.size ? 'recordView' : 'recordView-with-stay360-fallback');
  const alternate = variant(cards, record, conflicts.size ? 'stay360' : 'stay360-with-recordView-fallback');
  if (!Object.values(record.sources).some(Boolean)) return [alternate];
  return !Object.values(cards.sources).some(Boolean) || combinationKey(primary.combination) === combinationKey(alternate.combination)
    ? [primary] : [primary, alternate];
}

function messageRecord(record, index) {
  const message = record?.parentMessage || {};
  const [direction, otherDirection] = [message.direction, record?.qualification?.direction]
    .map(value => text(value).toLowerCase()).filter(Boolean);
  if (!['inbound', 'outbound'].includes(direction) || (otherDirection && otherDirection !== direction)) return null;
  const addresses = [];
  const add = (value, role, fieldPath) => addresses.push(
    ...emailsIn(value).map(address => ({ address, role, fieldPath })));
  add(message.storedFromAddress, direction + '-sender', 'parentMessage.storedFromAddress');
  if (direction === 'outbound') {
    for (const field of ['to', 'cc', 'bcc']) {
      for (const value of [message[field]].flat()) add(value, 'outbound-recipient', 'parentMessage.' + field);
    }
  }
  const extraction = record?.pdfExtraction || {};
  const numbersIn = value => (text(value).match(/(?<!\d)\d{6,10}-\d{1,2}(?!\d)/g) || []).map(confirmationKey);
  const cleaned = (extraction.confirmationNumberCandidates || []).map(item => confirmationKey(item?.value));
  const candidates = [...cleaned, ...(extraction.extractedFields?.confirmationNumber || []).map(item => {
    const numbers = numbersIn(item?.value);
    return numbers.length === 1 && cleaned.includes(numbers[0]) ? numbers[0] : confirmationKey(item?.value);
  })].filter(Boolean);
  return {
    recordId: text(record?.recordId) || 'message-record-' + (index + 1),
    attachmentId: text(record?.source?.attachmentId) || null,
    sourceSnapshotId: text(record?.source?.snapshotId) || null,
    messageDbId: text(message.messageDbId) || null,
    sentAt: text(message.sentAt) || null,
    direction, addresses, candidates: [...new Set(candidates)],
    filenameCandidates: numbersIn(record?.attachment?.filename),
    subjectCandidates: numbersIn(message.subject),
    candidateOnly: typeof record?.candidateOnly === 'boolean' ? record.candidateOnly : null,
  };
}

/** Build one private memory per property. Inputs must already be partitioned by property. */
export function buildHmsBookingMemory({
  propertyCode, pmsSnapshot, pmsSnapshots = [], outboundPdfRecords = [], messageRecords = [],
  pmsSourceFiles = [], outboundSourceFiles = [],
} = {}) {
  const scope = text(propertyCode).toUpperCase();
  if (!scope) throw new TypeError('propertyCode is required; build one memory per property.');
  const snapshots = [...pmsSnapshots, ...(pmsSnapshot ? [pmsSnapshot] : [])];
  const rawMessages = [...outboundPdfRecords, ...messageRecords];
  for (const item of [...snapshots, ...snapshots.flatMap(snapshot => snapshot?.results || []), ...rawMessages]) {
    if (text(item?.propertyCode) && text(item.propertyCode).toUpperCase() !== scope) {
      throw new TypeError('Inputs span multiple properties; build one memory per property.');
    }
  }
  const snapshotMetadata = snapshots.map((snapshot, index) => ({
    snapshotId: 'pms-' + (index + 1),
    snapshotDate: text(snapshot?.startedAt || snapshot?.updatedAt).slice(0, 10) || null,
    startedAt: text(snapshot?.startedAt) || null,
    updatedAt: text(snapshot?.updatedAt) || null,
    sourceType: text(snapshot?.sourceType) || 'PMS snapshot',
    sourceFile: pmsSourceFiles[index] ? basename(pmsSourceFiles[index]) : null,
    propertyCode: scope,
    resultCount: Array.isArray(snapshot?.results) ? snapshot.results.length : 0,
    succeededCount: Number.isFinite(snapshot?.succeeded) ? snapshot.succeeded : null,
    failedCount: Number.isFinite(snapshot?.failed) ? snapshot.failed : null,
  }));
  const observations = [];
  const exclusions = {
    failedPmsResultCount: 0, excludedOtherSourcePmsResultCount: 0, excludedUnknownSourcePmsResultCount: 0,
    excludedAmbiguousSourcePmsResultCount: 0, excludedMissingConfirmationPmsResultCount: 0,
  };
  for (const [index, snapshot] of snapshots.entries()) {
    const metadata = snapshotMetadata[index];
    for (const [resultIndex, result] of (snapshot?.results || []).entries()) {
      if (!result || result.ok === false) { exclusions.failedPmsResultCount++; continue; }
      const recordFields = result?.recordView?.details?.fields;
      const values = (Array.isArray(recordFields) ? recordFields : [])
        .filter(field => labelOf(field) === 'source of business').map(field => text(field.value)).filter(Boolean);
      const distinct = [...new Set(values.map(value => value.toLowerCase()))];
      if (!distinct.length) { exclusions.excludedUnknownSourcePmsResultCount++; continue; }
      if (distinct.length > 1) { exclusions.excludedAmbiguousSourcePmsResultCount++; continue; }
      if (!SOURCES.some(source => source.toLowerCase() === distinct[0])) { exclusions.excludedOtherSourcePmsResultCount++; continue; }
      const confirmationNumber = text(result.confirmation);
      const key = confirmationKey(result.confirmation);
      if (!key) { exclusions.excludedMissingConfirmationPmsResultCount++; continue; }
      const pdf = result.sourcePdfEvidence || {};
      observations.push({
        confirmationKey: key, confirmationNumber, sourceOfBusiness: values[0],
        observationId: metadata.snapshotId + '-' + (resultIndex + 1),
        snapshotId: metadata.snapshotId, snapshotDate: metadata.snapshotDate,
        sourceType: metadata.sourceType, provenance: result.provenance || null,
        historicalIdentity: historicalIdentity(result, key), historicalHints: historicalHintFields(result),
        historicalNoteFields: historicalNoteFields(result),
        outcomes: outcomeVariants(result),
        pdfAttachmentIds: [...new Set((pdf.pdfAttachmentIds || []).map(text).filter(Boolean))],
        pdfProvenance: Object.fromEntries(['pdfRecordCount', 'labeledPdfCount',
          'filenameAndSubjectMatchPdfCount', 'conflictingSubjectPdfCount']
          .filter(field => Number.isFinite(pdf[field])).map(field => [field, pdf[field]])),
      });
    }
  }
  const byConfirmation = verifiedConfirmations(observations);
  const parsedMessages = rawMessages.map(messageRecord).filter(Boolean);
  const messageGroups = Map.groupBy(parsedMessages, message => message.recordId);
  const messages = [...messageGroups.values()].map(copies => {
    const sourceSnapshotIds = [...new Set(copies.map(copy => copy.sourceSnapshotId).filter(Boolean))];
    const contents = copies.map(({ sourceSnapshotId: _sourceSnapshotId, ...content }) => JSON.stringify(content));
    if (new Set(contents).size > 1) throw new TypeError('A message record ID has conflicting contents.');
    return { ...copies[0], sourceSnapshotIds };
  });
  const byAttachment = Map.groupBy(messages.filter(message => message.attachmentId), message => message.attachmentId);
  const edges = new Map();
  const addLink = (observation, message, method) => {
    const key = JSON.stringify([observation.confirmationKey, message.recordId]);
    const edge = edges.get(key) || { confirmationKey: observation.confirmationKey, message, method, observations: [] };
    edge.observations.push(observation);
    edges.set(key, edge);
  };
  for (const observation of observations) {
    for (const attachment of observation.pdfAttachmentIds) {
      for (const message of byAttachment.get(attachment) || []) addLink(observation, message, 'attachment-id');
    }
  }
  const directRecordIds = new Set([...edges.values()].map(edge => edge.message.recordId));
  for (const message of messages) {
    if (directRecordIds.has(message.recordId) || message.candidates.length !== 1) continue;
    for (const observation of byConfirmation.get(message.candidates[0]) || []) {
      addLink(observation, message, 'confirmation-number-candidate');
    }
  }
  const addressEvidence = [];
  const attachments = Map.groupBy(observations.flatMap(({ pdfAttachmentIds, confirmationKey }) =>
    pdfAttachmentIds.map(attachmentId => ({ attachmentId, confirmationKey }))), item => item.attachmentId);
  for (const edge of edges.values()) {
    const { message, confirmationKey: key } = edge;
    const match = candidates => candidates.length ? candidates.includes(key) : null;
    const linkProvenance = {
      method: edge.method, candidateOnly: message.candidateOnly,
      labeledConfirmationMatch: match(message.candidates), filenameConfirmationMatch: match(message.filenameCandidates),
      subjectConfirmationMatch: match(message.subjectCandidates),
      ambiguousAttachment: (byAttachment.get(message.attachmentId)?.length || 0) > 1
        || (attachments.get(message.attachmentId) || []).some(item => item.confirmationKey !== key),
      subjectHasOtherConfirmation: message.subjectCandidates.length
        ? message.subjectCandidates.some(candidate => candidate !== key) : null,
      upstreamPmsEvidence: edge.observations.map(observation => observation.pdfProvenance).filter(Boolean),
    };
    for (const address of message.addresses) {
      addressEvidence.push({
        confirmationKey: key, ...address, direction: message.direction,
        domain: address.address.split('@')[1].replace(/^\.+|\.+$/g, ''),
        recordId: message.recordId, attachmentId: message.attachmentId,
        sourceSnapshotId: message.sourceSnapshotId, sourceSnapshotIds: message.sourceSnapshotIds,
        messageDbId: message.messageDbId, sentAt: message.sentAt, linkMethod: edge.method, linkProvenance,
        linkedPmsSnapshotIds: [...new Set(edge.observations.map(observation => observation.snapshotId))],
        linkedPmsObservationIds: [...new Set(edge.observations.map(observation => observation.observationId))],
      });
    }
  }
  const outbound = messages.filter(message => message.direction === 'outbound');
  const linkedOutbound = new Set([...edges.values()].filter(edge => edge.message.direction === 'outbound')
    .map(edge => edge.message.recordId));
  return {
    schemaVersion: 3, propertyCode: scope, sourceOfBusinessFilter: [...SOURCES], snapshots: snapshotMetadata,
    observations, addressEvidence,
    linkage: {
      pmsResultCount: snapshotMetadata.reduce((sum, item) => sum + item.resultCount, 0),
      ...exclusions, excludedNonEmailPmsResultCount: exclusions.excludedOtherSourcePmsResultCount,
      pmsSourceCounts: Object.fromEntries(SOURCES.map(source => [source,
        observations.filter(item => item.sourceOfBusiness.toLowerCase() === source.toLowerCase()).length])),
      pmsObservationCount: observations.length, pmsConfirmationCount: byConfirmation.size,
      outboundPdfRecordCount: outbound.length,
      linkedOutboundPdfRecordCount: linkedOutbound.size, unlinkedOutboundPdfRecordCount: outbound.length - linkedOutbound.size,
      directAttachmentLinkCount: [...edges.values()].filter(edge => edge.method === 'attachment-id').length,
      confirmationCandidateLinkCount: [...edges.values()].filter(edge => edge.method === 'confirmation-number-candidate').length,
      ambiguousAttachmentIdCount: [...attachments].filter(([id, items]) => (byAttachment.get(id)?.length || 0) > 1
        || new Set(items.map(item => item.confirmationKey)).size > 1).length,
      outboundAddressEvidenceCount: addressEvidence.filter(item => item.direction === 'outbound').length,
      inboundMessageRecordCount: messages.length - outbound.length,
      duplicateMessageRecordCount: parsedMessages.length - messages.length,
      ignoredUnrecognizedDirectionRecordCount: rawMessages.length - parsedMessages.length,
      pmsSourceFiles: pmsSourceFiles.map(path => basename(path)),
      outboundSourceFiles: outboundSourceFiles.map(path => basename(path)),
    },
  };
}

async function readSource(path, jsonl) {
  const content = await readFile(path, 'utf8');
  try {
    return jsonl ? content.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line))
      : JSON.parse(content);
  } catch {
    throw new Error('Invalid ' + (jsonl ? 'JSONL' : 'JSON') + ' in ' + basename(path));
  }
}

/** Load private source files once, then reuse or JSON-serialize the returned memory. */
export async function loadHmsBookingMemory({
  propertyCode, pmsPath, outboundPdfPath,
  pmsPaths = pmsPath ? [pmsPath] : [], outboundPdfPaths = outboundPdfPath ? [outboundPdfPath] : [],
} = {}) {
  if (!pmsPaths.length) throw new TypeError('Provide at least one pmsPath.');
  const [pmsSnapshots, outbound] = await Promise.all([
    Promise.all(pmsPaths.map(path => readSource(path, false))),
    Promise.all(outboundPdfPaths.map(path => readSource(path, true))),
  ]);
  return buildHmsBookingMemory({
    propertyCode, pmsSnapshots, outboundPdfRecords: outbound.flat(),
    pmsSourceFiles: pmsPaths, outboundSourceFiles: outboundPdfPaths,
  });
}
