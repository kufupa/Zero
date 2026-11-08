import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { withBookingLookupSession } from './booking-lookup-session.mjs';
import { withSavedStayAgentSession } from './saved-stay-agent-session.mjs';
import { readLabtestCreate, reconcileLabtestCreate } from './labtest-create-readback.mjs';
import { readCreateParties } from './create-party-readback.mjs';
import { isSupportedLabtestGuarantee, validCreateBillingReference } from './guest-stay-save.mjs';
import { digestCloudCreateRequest, validCreateNote } from './create-request-binding.mjs';
import { normalizeCreateTrack } from '../playwright-quote/create-request.mjs';
import { fillTrackBeforeGuarantee } from '../playwright-quote/create-lab-stay.mjs';
import { CREATE_GUARANTEES, createCloudTargetKey, isLabtestGuest, validCreateDates, validCreateGuest } from './cloud-create-policy.mjs';

const text = (value) => typeof value === 'string' ? value.trim() : '';
const same = (a, b) => text(String(a ?? '')).toLocaleLowerCase() === text(String(b ?? '')).toLocaleLowerCase();
const code = (value, limit) => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= limit && !/[\r\n]/.test(value);
const date = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const stop = (outcome, issue, extra = {}) => { throw Object.assign(new Error(issue), { result: { outcome, issue, ...extra } }); };
const safeIssue = (error) => /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.message || '') ? error.message : 'SESSION_FAILED';
const candidate = ({ nativeId, firstName, lastName, email, phoneNumber, city, country }) =>
  ({ nativeId, firstName, lastName, email, phoneNumber, city, country });

export const REAL_GUEST_CREATE_AUTHORIZATION_HOLD = 'trusted_staff_create_authorization_unavailable';

function validate(input, allowRealGuest = false, allowCommitOnlyBillingReference = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { outcome: 'needs_input', issue: 'invalid_input' };
  if (!['prepare', 'commit'].includes(input.mode)) return { outcome: 'needs_input', issue: 'mode_required' };
  if (input.propertyCode !== 'HRCEN') return { outcome: 'unsupported', issue: 'property_not_supported' };
  const fidelity = inspectRequest(input);
  if (Object.hasOwn(input, 'billingReference') && input.billingReference != null &&
      !validCreateBillingReference(input.billingReference)) fidelity.invalid.push('billingReference');
  if (Object.hasOwn(input, 'billingReference') && input.mode === 'prepare' && input.billingReference != null &&
      !allowCommitOnlyBillingReference) {
    fidelity.unsupported.push({ field: 'billingReference', issue: 'commit_only' });
  }
  if (input.cms?.messageId != null && !code(input.cms.messageId, 100)) fidelity.invalid.push('cms.messageId');
  if (input.cms?.recipient != null && (!code(input.cms.recipient, 255) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.cms.recipient))) fidelity.invalid.push('cms.recipient');
  if (input.booker && (Object.keys(input.booker).length === 0 ||
      (input.booker.name != null && !code(input.booker.name, 50)) ||
      (input.booker.contact != null && !code(input.booker.contact, 80)))) fidelity.invalid.push('booker');
  if (input.reasonForStay != null && !code(input.reasonForStay, 100)) fidelity.invalid.push('reasonForStay');
  if (input.cms?.send === true && (!allowRealGuest || !input.cms?.messageId || !input.cms?.recipient)) {
    fidelity.unsupported.push({ field: 'cms.send', issue: 'confirmation_details_or_real_guest_required' });
  }
  if (input.track != null && !normalizeCreateTrack(input.track)) fidelity.unsupported.push({ field: 'track', issue: 'track_not_supported' });
  if (input.guestoptin4 === true) fidelity.unsupported.push({ field: 'guestoptin4', issue: 'opt_in_not_supported' });
  if (input.guestoptin4 != null && typeof input.guestoptin4 !== 'boolean') fidelity.invalid.push('guestoptin4');
  if (input.cms?.send != null && typeof input.cms.send !== 'boolean') fidelity.invalid.push('cms.send');
  if (input.guaranteeType != null && !isSupportedLabtestGuarantee(input.guaranteeType)) {
    fidelity.unsupported.push({ field: 'guaranteeType', issue: 'guarantee_not_supported_yet' });
  }
  if (fidelity.invalid.length) return { outcome: 'needs_input', issue: 'invalid_field_type', invalidFields: fidelity.invalid, unsupportedFields: fidelity.unsupported };
  const unsupportedIssue = !fidelity.unsupported.length ? null : input.cms?.send === true ? 'confirmation_details_or_real_guest_required' :
    input.guaranteeType != null && !isSupportedLabtestGuarantee(input.guaranteeType) ? 'guarantee_not_supported_yet' : 'requested_fields_not_supported';
  if (unsupportedIssue && input.mode === 'commit') {
    return { outcome: unsupportedIssue === 'guarantee_not_supported_yet' ? 'refused' : 'unsupported',
      issue: unsupportedIssue, unsupportedFields: fidelity.unsupported };
  }
  if (input.mode === 'commit' && !allowRealGuest && input.guest?.search &&
      (!same(input.guest.search.lastName, 'Labtest') || (input.guest.search.firstName && !same(input.guest.search.firstName, 'Proof')))) {
    return { outcome: 'refused', issue: REAL_GUEST_CREATE_AUTHORIZATION_HOLD };
  }
  const stay = input.stay || {}, room = input.room || {}, guest = input.guest || {}, missing = [];
  if (room.roomTypeForCharge !== undefined && (typeof room.roomTypeForCharge !== 'string' || !/^[A-Z0-9]{1,12}$/.test(room.roomTypeForCharge))) {
    return { outcome: 'needs_input', issue: 'invalid_charge_room_category', missing: ['room.roomTypeForCharge'] };
  }
  if (stay.childCount != null && Array.isArray(stay.childAges) && stay.childCount !== stay.childAges.length) {
    return { outcome: 'needs_input', issue: 'child_count_conflict', missing: ['stay.childCount'],
      ...(fidelity.unsupported.length ? { unsupportedFields: fidelity.unsupported } : {}) };
  }
  if (guest.profileId != null && guest.search != null) return { outcome: 'needs_input', issue: 'guest_identity_conflict',
    ...(fidelity.unsupported.length ? { unsupportedFields: fidelity.unsupported } : {}) };
  if (!(guest.profileId != null && /^\d+$/.test(String(guest.profileId))) && !text(guest.search?.lastName)) missing.push('guest');
  for (const field of ['firstName', 'email']) if (guest.search?.[field] != null && !text(guest.search[field])) missing.push(`guest.search.${field}`);
  if (!date(stay.arrival)) missing.push('stay.arrival');
  if (!date(stay.departure)) missing.push('stay.departure');
  if (date(stay.arrival) && date(stay.departure) && stay.arrival >= stay.departure) missing.push('stay.dateRange');
  if (!Number.isInteger(stay.adults) || stay.adults < 1) missing.push('stay.adults');
  if (!Array.isArray(stay.childAges) || !stay.childAges.every((age) => Number.isInteger(age) && age >= 0 && age <= 17)) missing.push('stay.childAges');
  if (stay.childCount != null && (!Number.isInteger(stay.childCount) || stay.childCount < 0 ||
      (Array.isArray(stay.childAges) && stay.childCount !== stay.childAges.length))) missing.push('stay.childCount');
  if (!code(room.roomType, 200)) missing.push('room.roomType');
  if (!code(room.ratePlan, 100)) missing.push('room.ratePlan');
  if (!text(input.guaranteeType)) missing.push('guaranteeType');
  if (input.sourceOfBusiness != null && !text(input.sourceOfBusiness)) missing.push('sourceOfBusiness');
  for (const key of ['organizationName', 'agencyName', 'arAccountName']) {
    if (input.parties?.[key] != null && !text(input.parties[key])) missing.push(`parties.${key}`);
  }
  if (input.note != null && !validCreateNote(input.note)) missing.push('note');
  if (input.mode === 'commit') {
    if (input.billingReference != null) {
      if (input.parties?.arAccountId == null) missing.push('parties.arAccountId');
      if (!text(input.parties?.arAccountName) && !missing.includes('parties.arAccountName')) missing.push('parties.arAccountName');
    }
    if ([room.roomType, room.ratePlan].some((value) => value && !/^[A-Z0-9]{1,12}$/.test(value))) return { outcome: 'refused', issue: 'native_code_not_supported_yet' };
    if (date(stay.arrival) && date(stay.departure) && !validCreateDates(stay.arrival, stay.departure, allowRealGuest)) {
      return { outcome: 'refused', issue: allowRealGuest ? 'current_or_future_arrival_required' : 'labtest_arrival_required' };
    }
  }
  if (allowRealGuest && date(stay.arrival) && date(stay.departure) &&
      !validCreateDates(stay.arrival, stay.departure, true)) return { outcome: 'refused', issue: 'current_or_future_arrival_required' };
  return { missing, unsupportedFields: fidelity.unsupported, unsupportedIssue };
}

// Only these request keys are understood by this wrapper. Presence is significant:
// an explicit null is not the same request as an omitted optional field.
const requestShape = {
  '': ['mode', 'propertyCode', 'guest', 'stay', 'room', 'guaranteeType', 'sourceOfBusiness', 'reasonForStay', 'parties', 'note', 'booker', 'cms', 'billingReference', 'price', 'track', 'marketSegment', 'guestoptin4', 'confirmationRecipient'],
  guest: ['profileId', 'search'], 'guest.search': ['lastName', 'firstName', 'email'],
  stay: ['arrival', 'departure', 'adults', 'childAges', 'childCount'],
  room: ['roomType', 'ratePlan', 'roomTypeForCharge'], parties: ['agencyId', 'agencyName', 'organizationId', 'organizationName', 'arAccountId', 'arAccountName'],
  cms: ['send', 'messageId', 'recipient'], booker: ['name', 'contact'],
};
const unsupportedPaths = new Set(['price', 'marketSegment', 'confirmationRecipient']);
const optionalNoClear = new Set(['billingReference', 'sourceOfBusiness', 'reasonForStay', 'note', 'stay.childCount', 'guest.profileId', 'guest.search.firstName',
  'guest.search.email', 'parties.organizationId', 'parties.organizationName', 'parties.agencyId', 'parties.agencyName',
  'parties.arAccountId', 'parties.arAccountName', 'cms.send', 'cms.messageId', 'cms.recipient',
  'booker', 'booker.name', 'booker.contact', 'track', 'guestoptin4']);

function inspectRequest(input) {
  const unsupported = [], invalid = [];
  const addUnsupported = (field) => unsupported.push({ field, issue: 'not_settable_yet' });
  const unknown = (value, path) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) unknown(child, `${path}.${key}`);
    } else addUnsupported(path);
  };
  const visit = (object, path) => {
    for (const [key, value] of Object.entries(object)) {
      const field = path ? `${path}.${key}` : key;
      if (!requestShape[path].includes(key)) { unknown(value, field); continue; }
      if (unsupportedPaths.has(field)) addUnsupported(field);
      if (value === undefined) { invalid.push(field); continue; }
      if (value === null && optionalNoClear.has(field)) { addUnsupported(field); continue; }
      if (Object.hasOwn(requestShape, field)) {
        if (value === null) {
          if (['parties', 'cms'].includes(field)) addUnsupported(field);
          else if (!['approval', 'booker'].includes(field)) invalid.push(field);
        } else if (typeof value !== 'object' || Array.isArray(value)) invalid.push(field);
        else visit(value, field);
      }
    }
  };
  visit(input, '');
  for (const [field, value] of [
    ['sourceOfBusiness', input.sourceOfBusiness], ['reasonForStay', input.reasonForStay], ['note', input.note], ['cms.messageId', input.cms?.messageId],
    ['guest.search.lastName', input.guest?.search?.lastName], ['guest.search.firstName', input.guest?.search?.firstName],
    ['guest.search.email', input.guest?.search?.email], ...['organizationName', 'agencyName', 'arAccountName']
      .map((key) => [`parties.${key}`, input.parties?.[key]]),
  ]) if (value != null && typeof value !== 'string') invalid.push(field);
  for (const [field, value] of [['guest.profileId', input.guest?.profileId], ...['organizationId', 'agencyId', 'arAccountId']
    .map((key) => [`parties.${key}`, input.parties?.[key]])]) {
    if (value != null && !(typeof value === 'string' && /^\d+$/.test(value)) &&
        !(Number.isSafeInteger(value) && value >= 0)) invalid.push(field);
  }
  return { unsupported, invalid };
}

async function call(runTool, tool, args = {}, accepted = ['updated_unsaved', 'unchanged_unsaved', 'selected_unsaved', 'ok']) {
  const result = await runTool({ tool, ...args });
  if (!accepted.includes(result.outcome)) stop(
    ['input_gap', 'no_match', 'unsupported'].includes(result.outcome) ? 'needs_input' : 'uncertain',
    result.issue || `${tool}_failed`, { stage: tool, detail: result });
  return result;
}

async function selectGuest(runTool, guest, commit, requireExplicitGuestSelection = false, allowRealGuest = false, expectedGuest) {
  const field = guest.profileId != null ? 'profileId' : 'lastName';
  const query = field === 'profileId' ? String(guest.profileId) : guest.search.lastName;
  const found = await call(runTool, 'searchGuestProfiles', { field, query }, ['matches', 'no_match']);
  let all = found.candidates || [];
  if (found.hasMoreLoaded) {
    all = [];
    for (let offset = 0; offset < found.coverage.loaded; offset += 50) {
      const inspected = await call(runTool, 'inspectGuestProfileCandidates', { searchId: found.searchId, offset, limit: 50 }, ['current']);
      all.push(...inspected.candidates);
    }
  }
  if (guest.search?.email && !found.correlation?.verifiedFields?.includes('emailaddress')) {
    stop('needs_input', 'guest_email_unverified', { guestCandidates: all.map(candidate), guestCoverage: found.coverage, guestCorrelation: found.correlation });
  }
  const matches = all.filter((item) => field === 'profileId' ? item.nativeId === query :
    same(item.lastName, guest.search.lastName) && (!guest.search.firstName || same(item.firstName, guest.search.firstName)) &&
    (!guest.search.email || (found.correlation?.verifiedFields?.includes('emailaddress') && same(item.email, guest.search.email))));
  if (matches.length !== 1 || (field !== 'profileId' && found.coverage?.possiblyTruncated)) {
    stop('needs_input', matches.length || found.coverage?.possiblyTruncated ? 'guest_ambiguous' : 'guest_not_found',
      { guestSearchOutcome: found.outcome, guestCandidates: all.map(candidate), guestCoverage: found.coverage, guestCorrelation: found.correlation });
  }
  if (!commit && requireExplicitGuestSelection && field !== 'profileId') {
    stop('needs_input', 'guest_choice_required', {
      guestSearchOutcome: found.outcome, guestCandidates: matches.map(candidate),
      guestCoverage: found.coverage, guestCorrelation: found.correlation,
    });
  }
  const chosen = matches[0];
  if ((commit && !allowRealGuest && !isLabtestGuest(chosen)) ||
      (expectedGuest && (commit
        ? chosen.firstName !== expectedGuest.firstName || chosen.lastName !== expectedGuest.lastName
        : !same(chosen.firstName, expectedGuest.firstName) || !same(chosen.lastName, expectedGuest.lastName)))) {
    stop('refused', REAL_GUEST_CREATE_AUTHORIZATION_HOLD);
  }
  const selected = await call(runTool, 'selectGuestProfile', { searchId: found.searchId, nativeId: chosen.nativeId });
  if (selected.nativeId !== chosen.nativeId) stop('uncertain', 'requested_field_not_staged', { field: 'guest' });
  return { selected, guest: candidate(chosen) };
}

async function selectSource(runTool, requested) {
  const search = await call(runTool, 'searchGuestStaySourceBusiness', {}, ['matches', 'no_match']);
  const candidates = [];
  for (let offset = 0; offset < search.coverage.loaded; offset += 100) {
    const view = await call(runTool, 'inspectGuestStaySourceBusiness', { searchId: search.searchId, offset, limit: 100 });
    candidates.push(...view.candidates);
  }
  const matches = candidates.filter((row) => same(row.nativeCode, requested) || same(row.description, requested));
  if (search.coverage?.possiblyTruncated || matches.length !== 1) {
    stop('needs_input', 'source_not_unique', { sourceCandidates: candidates.map(({ nativeCode, description }) => ({ nativeCode, description })) });
  }
  const selected = await call(runTool, 'selectGuestStaySourceBusiness', { searchId: search.searchId, nativeCode: matches[0].nativeCode });
  if (selected.nativeCode !== matches[0].nativeCode) stop('uncertain', 'requested_field_not_staged', { field: 'sourceOfBusiness' });
  return selected;
}

async function selectOrganization(runTool, parties) {
  const byId = parties.organizationId != null;
  const search = await call(runTool, 'searchOrganization', { query: byId ? String(parties.organizationId) : parties.organizationName,
    ...(byId ? { options: { field: 'nativeId' } } : {}) }, ['matches', 'no_match']);
  const matches = (search.candidates || []).filter((row) => (!byId || String(row.nativeId) === String(parties.organizationId)) &&
    (!text(parties.organizationName) || same(row.name, parties.organizationName)));
  if (matches.length !== 1 || (!byId && search.coverage?.possiblyTruncated)) {
    stop('needs_input', 'organization_not_unique', { organizationCandidates: (search.candidates || []).map(({ nativeId, name, city, country }) => ({ nativeId, name, city, country })) });
  }
  const selected = await call(runTool, 'selectOrganization', { searchId: search.searchId, nativeId: matches[0].nativeId });
  if (String(selected.nativeId) !== String(matches[0].nativeId)) stop('uncertain', 'requested_field_not_staged', { field: 'parties.organizationId' });
  return selected;
}

// Search results are tied to this page and one current picker. Never infer a
// caller's choice from a sole match; a supplied ID is checked against this run.
async function prepareParty(runTool, kind, parties, propertyCode, output, missing) {
  const specs = {
    agency: { id: 'agencyId', name: 'agencyName', search: 'searchPrimaryBookingAgency', select: 'selectPrimaryBookingAgency', display: 'displayedAgency', form: 'ta1' },
    organization: { id: 'organizationId', name: 'organizationName', search: 'searchOrganization', select: 'selectOrganization', display: 'displayedOrganization', form: 'company' },
    arAccount: { id: 'arAccountId', name: 'arAccountName', search: 'searchArAccount', select: 'selectArAccount', display: 'displayedArAccount', form: 'araccountname' },
  };
  const spec = specs[kind], id = parties[spec.id], name = text(parties[spec.name]);
  if (id == null && !name) return null;
  if (!name && kind !== 'organization') {
    if (!missing.includes(`parties.${spec.name}`)) missing.push(`parties.${spec.name}`);
    (output.partySearches ||= {})[kind] = { outcome: 'needs_input', issue: 'name_query_required' };
    return null;
  }
  const byId = kind === 'organization' && id != null;
  const found = await call(runTool, spec.search, { query: byId ? String(id) : name,
    ...(byId ? { options: { field: 'nativeId' } } : {}) }, ['matches', 'no_match']);
  if (!found.searchId || !Array.isArray(found.candidates) || !found.coverage ||
      typeof found.coverage.possiblyTruncated !== 'boolean') {
    stop('uncertain', 'party_search_unverified', { field: `parties.${spec.name}`, detail: found });
  }
  const evidence = { outcome: found.outcome, query: found.query, criteria: found.criteria,
    coverage: found.coverage, columns: found.columns, metadata: found.metadata,
    correlation: found.correlation, candidates: found.candidates };
  (output.partySearches ||= {})[kind] = evidence;
  const matches = id == null ? [] : found.candidates.filter((row) => String(row.nativeId ?? '') === String(id));
  const nameConflict = kind === 'organization' && name && matches.length === 1 && !same(matches[0].name, name);
  if (id == null || matches.length !== 1 || !text(matches[0]?.name) || nameConflict) {
    evidence.issue = id == null ? (found.candidates.length ? 'explicit_selection_required' :
      found.coverage.possiblyTruncated ? 'results_incomplete' : 'no_matches') :
      matches.length > 1 ? 'id_ambiguous' : matches.length === 1 && !text(matches[0].name) ? 'candidate_name_unverified' :
      nameConflict ? 'id_name_conflict' : found.coverage.possiblyTruncated ? 'id_not_in_loaded_results' : 'id_not_found';
    missing.push(`parties.${spec.id}${id == null ? '' : '.selection'}`);
    await call(runTool, 'closeGuestStayPartyPicker', { propertyCode }, ['closed_unsaved']);
    return null;
  }
  const selected = await call(runTool, spec.select, { searchId: found.searchId, nativeId: matches[0].nativeId });
  if (String(selected.nativeId) !== String(matches[0].nativeId) || selected.searchId !== found.searchId ||
      selected.nativeIdEvidence !== 'form_change_response' || !same(selected[spec.display], matches[0].name) ||
      selected.selectedField?.name !== spec.form || !same(selected.selectedField.value, matches[0].name)) {
    stop('uncertain', 'requested_field_not_staged', { field: `parties.${spec.id}` });
  }
  const selectionEvidenceFields = kind === 'agency'
    ? ['agencyIataNumber', 'agencyReferenceNumberType', 'agencyReferenceEvidence']
    : kind === 'arAccount' ? ['nativeReadback'] : [];
  evidence.selection = { nativeId: selected.nativeId, name: selected[spec.display], nativeIdEvidence: selected.nativeIdEvidence,
    ...Object.fromEntries(selectionEvidenceFields.filter((key) => Object.hasOwn(selected, key)).map((key) => [key, selected[key]])) };
  output.applied[kind] = { nativeId: selected.nativeId, name: selected[spec.display] };
  output.warnings.push({ field: `parties.${spec.id}`, issue: 'id_at_selection_only_in_form' });
  return selected;
}

function formValue(fields, name) {
  const matches = (fields || []).filter((field) => field.name === name);
  return matches.length === 1 ? matches[0].value : null;
}

// This stages text only on a verified empty search. It never creates or selects
// a profile and must not make a create eligible for approval or Save.
async function stageUnresolvedGuestName(runTool, propertyCode, search, lookup) {
  const firstName = text(search?.firstName), lastName = text(search?.lastName);
  const coverage = lookup.guestCoverage;
  if (!firstName || !lastName || lookup.issue !== 'guest_not_found' ||
      lookup.guestSearchOutcome !== 'no_match' || !Array.isArray(lookup.guestCandidates) || lookup.guestCandidates.length !== 0 ||
      coverage?.loaded !== 0 || coverage.total !== 0 || coverage.serverMoreRecords !== false || coverage.possiblyTruncated !== false) return null;
  const read = async () => {
    let result;
    try { result = await runTool({ tool: 'readGuestStayForm', propertyCode }); }
    catch { stop('uncertain', 'guest_name_stage_unverified', { field: 'guest' }); }
    if (result?.outcome !== 'ok' || !Array.isArray(result.fields) ||
        !result.fields.every((field) => field && typeof field === 'object')) {
      stop('uncertain', 'guest_name_stage_unverified', { field: 'guest' });
    }
    return result.fields;
  };
  const before = await read();
  const editable = (fields, name) => {
    const found = (fields || []).filter((field) => field.name === name);
    return found.length === 1 && found[0].disabled === false && found[0].readOnly === false;
  };
  if (formValue(before, 'guestid') !== '' || formValue(before, 'firstname') !== '' || formValue(before, 'lastname') !== '' ||
      !editable(before, 'firstname') || !editable(before, 'lastname')) return null;
  const set = async (field, value) => {
    let result;
    try { result = await runTool({ tool: 'setGuestStayText', propertyCode, field, value }); }
    catch { stop('uncertain', 'guest_name_stage_unverified', { field }); }
    if (!['updated_unsaved', 'unchanged_unsaved'].includes(result?.outcome) || result.actual !== value) {
      stop('uncertain', 'guest_name_stage_unverified', { field });
    }
  };
  const verify = (fields, first, last) => {
    if (formValue(fields, 'guestid') !== '' || formValue(fields, 'firstname') !== first || formValue(fields, 'lastname') !== last) {
      stop('uncertain', 'guest_name_stage_unverified', { field: 'guest' });
    }
  };
  await set('firstName', firstName);
  verify(await read(), firstName, '');
  await set('lastName', lastName);
  verify(await read(), firstName, lastName);
  return { firstName, lastName, profileStatus: 'unverified' };
}

function draftRequestBinding(input, state, output, formFields) {
  if (!state.guest || !state.adult || !state.children || !state.guarantee ||
      formValue(formFields, 'udfchkbox04') !== (input.cms?.send === true)) return null;
  const parties = {};
  for (const [stateKey, key, displayKey] of [
    ['agency', 'agency', 'displayedAgency'], ['organization', 'organization', 'displayedOrganization'],
    ['arAccount', 'arAccount', 'displayedArAccount'],
  ]) {
    const selected = state[stateKey];
    if (selected) parties[key] = { nativeId: String(selected.nativeId), name: selected[displayKey] };
  }
  const request = {
    propertyCode: input.propertyCode,
    guest: { nativeId: String(state.guest.selected.nativeId), firstName: formValue(formFields, 'firstname'),
      lastName: formValue(formFields, 'lastname') },
    stay: { arrival: input.stay.arrival, departure: input.stay.departure, adults: Number(state.adult.actual.value),
      childAges: [...state.children.actualChildAges] },
    room: { roomType: output.applied.roomType, ratePlan: output.applied.ratePlan,
      ...(input.room.roomTypeForCharge !== undefined ? { roomTypeForCharge: output.applied.roomTypeForCharge } : {}) },
    guaranteeType: String(state.guarantee.actual.value),
    ...(state.source ? { sourceOfBusiness: { nativeCode: state.source.nativeCode, description: state.source.candidate.description } } : {}),
    ...(state.reason ? { reasonForStay: { value: String(state.reason.actual.value), display: state.reason.actual.display } } : {}),
    ...(Object.keys(parties).length ? { parties } : {}),
    ...(input.billingReference != null ? { billingReference: input.billingReference } : {}),
    ...(Object.hasOwn(output.applied, 'note') ? { note: output.applied.note } : {}),
    ...(state.cms ? { cmsMessageId: state.cms.actual } : {}),
    ...(state.cmsRecipient !== undefined ? { cmsRecipient: state.cmsRecipient } : {}),
    ...(state.booker ? { booker: state.booker } : {}),
    ...(state.track ? { track: state.track } : {}),
    ...(input.guestoptin4 === false ? { guestOptIn: false } : {}),
    sendHmsConfirmation: input.cms?.send === true
      ? { kind: 'send', recipient: state.cmsRecipient } : { kind: 'never' },
  };
  const binding = digestCloudCreateRequest(request);
  const profileId = text(String(state.arAccount?.nativeReadback?.arprofileid ?? state.arAccount?.profileId ?? ''));
  return { ...binding, ...(profileId && /^\d+$/.test(profileId) ? { arAccountProfileId: profileId } : {}) };
}

/** Prepare an unsaved draft or execute the server-authorized create. */
export async function createReservation(input, { withSession = withBookingLookupSession, withSavedSession = withSavedStayAgentSession,
  partyReadback = readCreateParties, census, authorizeCandidate, dispatchCandidate, expectedRequestDigest,
  expectedRateAvailability,
  allowCommitOnlyBillingReference = false,
  capturePrepareScreenshot = false, requireExplicitGuestSelection = false, selectTrack = fillTrackBeforeGuarantee,
  verifyLabtestMatches, allowRealGuest = false, expectedGuest, cloudTargetKey } = {}) {
  if ((authorizeCandidate !== undefined && typeof authorizeCandidate !== 'function') ||
      (dispatchCandidate !== undefined && typeof dispatchCandidate !== 'function') ||
      ((authorizeCandidate === undefined) !== (dispatchCandidate === undefined)) ||
      (verifyLabtestMatches !== undefined && (typeof verifyLabtestMatches !== 'function' || !authorizeCandidate || input?.mode !== 'commit')) ||
      (expectedRequestDigest !== undefined &&
        (input?.mode !== 'commit' || typeof expectedRequestDigest !== 'string' ||
          !/^[0-9a-f]{64}$/.test(expectedRequestDigest) || !authorizeCandidate)) ||
      (expectedRateAvailability !== undefined && (input?.mode !== 'commit' || !expectedRequestDigest ||
        !expectedRateAvailability || typeof expectedRateAvailability !== 'object' || Array.isArray(expectedRateAvailability) ||
        !['averageRate', 'totalRate', 'currency'].every(key => typeof expectedRateAvailability[key] === 'string' &&
          expectedRateAvailability[key].trim()))) ||
      typeof capturePrepareScreenshot !== 'boolean' || (capturePrepareScreenshot && input?.mode !== 'prepare') ||
      typeof allowCommitOnlyBillingReference !== 'boolean' ||
      typeof requireExplicitGuestSelection !== 'boolean' || (requireExplicitGuestSelection && input?.mode !== 'prepare') ||
      typeof allowRealGuest !== 'boolean' || (allowRealGuest && (!validCreateGuest(expectedGuest) ||
        (input?.cms?.send === true && isLabtestGuest(expectedGuest)) ||
        (input?.mode === 'commit' && (!authorizeCandidate || !expectedRequestDigest)))) ||
      (cloudTargetKey !== undefined && (typeof cloudTargetKey !== 'string' ||
        cloudTargetKey !== createCloudTargetKey(expectedGuest, input?.stay?.arrival)))) {
    return { outcome: 'refused', issue: 'SAVE_GUARD_CALLBACKS_INVALID', approvalReady: false };
  }
  const checked = validate(input, allowRealGuest, allowCommitOnlyBillingReference);
  if (checked.outcome) return { ...checked, approvalReady: false };
  const commit = input.mode === 'commit', missing = checked.missing;
  const output = { outcome: 'needs_input', approvalReady: false, applied: {}, appliedVerification: { visibleFields: false },
    warnings: [], suggestedCmsMessageId: '03', missing,
    ...(allowCommitOnlyBillingReference && input.billingReference != null ? { commitOnlyFields: ['billingReference'] } : {}),
    ...(checked.unsupportedFields.length ? { unsupportedFields: checked.unsupportedFields } : {}) };
  if (commit && missing.length) return output;
  const stay = input.stay || {}, room = input.room || {}, state = {};
  if (commit) output.screenshots = {};
  try {
    await withSession(async ({ page, runTool, labtestPreimage, createAuthority }) => {
      state.preimage = labtestPreimage;
      state.rateAvailabilityRequired = typeof createAuthority?.withM1CreateRateAvailability === 'function';
      const propertyCode = input.propertyCode;
      if (commit) {
        state.guest = await selectGuest(runTool, input.guest, true, false, allowRealGuest, expectedGuest);
        // The Labtest note must have been prepared and reviewed already.
        if (state.guest.guest.firstName === 'Proof' && state.guest.guest.lastName === 'Labtest' && input.note === undefined) {
          missing.push('note');
          return;
        }
      }
      for (const [key, field] of [['arrival', 'arrivalDate'], ['departure', 'departureDate']]) {
        if (date(stay[key])) {
          const result = await call(runTool, 'setGuestStayDate', { propertyCode, field, date: stay[key] });
          if (result.actual !== stay[key]) stop('uncertain', 'requested_field_not_staged', { field: `stay.${key}` });
          output.applied[key] = result.displayed;
        }
      }
      if (Number.isInteger(stay.adults) && stay.adults > 0) {
        state.adult = await call(runTool, 'selectGuestStayDropdown', { propertyCode, field: 'adults', value: stay.adults });
        if (!same(state.adult.actual?.value, stay.adults)) stop('uncertain', 'requested_field_not_staged', { field: 'stay.adults' });
        output.applied.adults = state.adult.actual.display;
      }
      if (Array.isArray(stay.childAges) && stay.childAges.every((age) => Number.isInteger(age) && age >= 0 && age <= 17)) {
        state.children = await call(runTool, 'setGuestStayChildAges', { propertyCode, childAges: stay.childAges });
        if (JSON.stringify(state.children.requestedChildAges) !== JSON.stringify(stay.childAges) ||
            JSON.stringify(state.children.actualChildAges) !== JSON.stringify(stay.childAges)) {
          stop('uncertain', 'requested_field_not_staged', { field: 'stay.childAges' });
        }
        output.applied.childAges = state.children.actualChildAges;
        output.warnings.push({ field: 'stay.childAges', issue: 'saved_record_exposes_age_bands_not_exact_ages' });
      }
      if (code(room.roomType, 200)) {
        const found = await call(runTool, 'searchRoomTypes', { query: room.roomType, limit: 100 }, ['matches', 'no_match', 'incomplete']);
        const inspected = await call(runTool, 'inspectRoomRateCandidate', { searchId: found.searchId, code: room.roomType }, ['match', 'ambiguous', 'not_in_loaded_results']);
        const matches = inspected.candidates || [];
        if (matches.length !== 1 || !found.coverage?.complete) stop('needs_input', 'room_type_not_unique', { roomCandidates: found.candidates, coverage: found.coverage });
        const selected = await call(runTool, 'selectRoomType', { searchId: found.searchId, code: room.roomType });
        if (selected.selectedField?.value !== room.roomType) stop('uncertain', 'requested_field_not_staged', { field: 'room.roomType' });
        output.applied.roomType = selected.selectedField.value;
      }
      state.track = input.track != null ? normalizeCreateTrack(input.track) : null;
      if (state.track && formValue((await call(runTool, 'readGuestStayForm', { propertyCode })).fields, 'track') !== state.track.display) {
        await selectTrack(page, state.track.lookupCode);
      }
      if (text(input.sourceOfBusiness)) {
        state.source = await selectSource(runTool, input.sourceOfBusiness);
        output.applied.sourceOfBusiness = state.source.selectedField.value;
        output.warnings.push({ field: 'sourceOfBusiness', issue: 'native_code_not_exposed_on_form_or_saved_record' });
      }
      if (!commit && (input.guest?.profileId != null || text(input.guest?.search?.lastName))) {
        try { state.guest = await selectGuest(runTool, input.guest, false, requireExplicitGuestSelection, allowRealGuest, expectedGuest); } catch (error) {
          if (!['guest_ambiguous', 'guest_not_found', 'guest_email_unverified', 'guest_choice_required'].includes(error.result?.issue)) throw error;
          Object.assign(output, error.result); missing.push('guest'); await call(runTool, 'closeGuestProfilePicker', {}, ['closed_unsaved']);
          state.guestNameDraft = await stageUnresolvedGuestName(runTool, propertyCode, input.guest?.search, error.result);
        }
      }
      if (commit && (input.parties?.organizationId != null || text(input.parties?.organizationName))) {
        state.organization = await selectOrganization(runTool, input.parties);
        output.applied.organization = { nativeId: state.organization.nativeId, name: state.organization.displayedOrganization };
        output.warnings.push({ field: 'parties.organizationId', issue: 'id_at_selection_only_in_form' });
      }
      // Stage a guarantee only on the verified selected guest and its dated draft.
      const verifiedDraft = state.guest && (allowRealGuest || isLabtestGuest(state.guest.guest)) &&
        validCreateDates(stay.arrival, stay.departure, allowRealGuest);
      if (isSupportedLabtestGuarantee(input.guaranteeType) && (commit || verifiedDraft)) {
        const result = await call(runTool, 'selectGuestStayDropdown', { propertyCode, field: 'guaranteeType', value: input.guaranteeType },
          ['updated_unsaved', 'unchanged_unsaved', 'selected_unsaved', 'ok', 'unsupported']);
        if (!commit && result.outcome === 'unsupported' && result.issue === 'GUARANTEE_DRAFT_UNSUPPORTED') {
          missing.push('guaranteeType.staging');
          output.warnings.push({ field: 'guaranteeType', issue: result.issue });
        } else {
          if (result.outcome === 'unsupported') stop('needs_input', result.issue || 'selectGuestStayDropdown_failed', { stage: 'selectGuestStayDropdown', detail: result });
          state.guarantee = result;
          if (state.guarantee.actual?.value !== input.guaranteeType ||
              ((allowRealGuest || input.guaranteeType !== 'NGI') &&
                (state.guarantee.actual?.submitted !== input.guaranteeType ||
                 state.guarantee.actual?.display !== CREATE_GUARANTEES[input.guaranteeType]))) {
            stop('uncertain', 'requested_field_not_staged', { field: 'guaranteeType' });
          }
          output.applied.guaranteeType = state.guarantee.actual.display;
        }
      } else if (!commit && isSupportedLabtestGuarantee(input.guaranteeType)) {
        missing.push('guaranteeType.staging');
        output.warnings.push({ field: 'guaranteeType', issue: 'requires_verified_guest_draft' });
      }
      if (input.parties) {
        for (const kind of commit ? ['agency', 'arAccount'] : ['organization', 'agency', 'arAccount']) {
          state[kind] = await prepareParty(runTool, kind, input.parties, propertyCode, output, missing);
        }
      }
      if (input.reasonForStay != null) {
        state.reason = await call(runTool, 'selectGuestStayDropdown', { propertyCode, field: 'reasonForStay', value: input.reasonForStay });
        if (String(state.reason.actual?.value) !== input.reasonForStay || !text(state.reason.actual?.display)) {
          stop('uncertain', 'requested_field_not_staged', { field: 'reasonForStay' });
        }
        output.applied.reasonForStay = state.reason.actual.display;
      }
      if (input.cms?.messageId != null) {
        const found = await call(runTool, 'listCmsMessageIds', { propertyCode });
        output.cmsSearch = { candidates: found.candidates, coverage: found.coverage };
        const matches = (found.candidates || []).filter((item) => item.code === input.cms.messageId);
        if (matches.length !== 1) {
          missing.push('cms.messageId.selection');
          await call(runTool, 'closeCmsMessageIdPicker', { propertyCode }, ['closed_unsaved']);
        } else {
          state.cms = await call(runTool, 'selectCmsMessageId', { propertyCode, searchId: found.searchId, code: input.cms.messageId });
          if (state.cms.actual !== input.cms.messageId) stop('uncertain', 'requested_field_not_staged', { field: 'cms.messageId' });
          output.applied.cmsMessageId = state.cms.actual;
        }
      }
      if (commit && missing.length) return;
      const stageCmsSend = input.cms?.send === true && Boolean(verifiedDraft) && allowRealGuest &&
        !isLabtestGuest(state.guest.guest) && state.cms?.actual === input.cms.messageId && Boolean(input.cms.recipient);
      state.cmsSend = await call(runTool, 'setCmsSendCheckbox', { propertyCode, checked: stageCmsSend });
      if (state.cmsSend.actual !== stageCmsSend) stop('uncertain', 'requested_field_not_staged', { field: 'cms.send' });
      // Only verified Labtest prepares get a synthetic note. Commit reuses its input.
      const note = input.note === undefined && !commit && verifiedDraft && isLabtestGuest(state.guest?.guest)
        ? `Proof Labtest create ${randomUUID()}` : input.note;
      if (validCreateNote(note)) {
        const result = await call(runTool, 'setGuestStayText', { propertyCode, field: 'reservationNote', value: note });
        if (result.actual !== note) stop('uncertain', 'requested_field_not_staged', { field: 'note' });
        output.applied.note = result.actual;
      }
      for (const [key, field] of [['name', 'bookerName'], ['contact', 'bookerContact']]) {
        if (input.booker?.[key] != null) {
          const result = await call(runTool, 'setGuestStayText', { propertyCode, field, value: input.booker[key] });
          if (result.actual !== input.booker[key]) stop('uncertain', 'requested_field_not_staged', { field: `booker.${key}` });
          (state.booker ||= {})[key] = result.actual;
        }
      }
      if (input.cms?.recipient != null) {
        const result = await call(runTool, 'setGuestStayText', { propertyCode, field: 'cmsRecipient', value: input.cms.recipient });
        if (result.actual !== input.cms.recipient) stop('uncertain', 'requested_field_not_staged', { field: 'cms.recipient' });
        state.cmsRecipient = result.actual;
      }
      if (room.roomTypeForCharge !== undefined) {
        const found = await call(runTool, 'searchRoomTypesForCharge', { query: room.roomTypeForCharge, limit: 100 }, ['matches', 'no_match', 'incomplete']);
        const inspected = await call(runTool, 'inspectRoomRateCandidate', { searchId: found.searchId, code: room.roomTypeForCharge }, ['match', 'ambiguous', 'not_in_loaded_results']);
        if ((inspected.candidates || []).length !== 1 || !found.coverage?.complete) {
          stop('needs_input', 'charged_room_type_not_unique', { roomCandidates: found.candidates, coverage: found.coverage });
        }
        const selected = await call(runTool, 'selectRoomTypeForCharge', { searchId: found.searchId, code: room.roomTypeForCharge });
        if (selected.selectedField?.value !== room.roomTypeForCharge) stop('uncertain', 'requested_field_not_staged', { field: 'room.roomTypeForCharge' });
        output.applied.roomTypeForCharge = selected.selectedField.value;
      }
      // Select rates only after the final guest, track and party context is staged.
      if (state.guest && code(room.ratePlan, 100) && date(stay.arrival) && date(stay.departure) && stay.arrival < stay.departure) {
        const selectRatePlan = () => call(runTool, 'selectGuestStayRatePlan', {
          code: room.ratePlan,
          ...(state.guest ? { guestProfileId: String(state.guest.selected.nativeId) } : {}),
          createDraft: {
            propertyCode,
            guest: state.guest ? { nativeId: String(state.guest.selected.nativeId),
              firstName: state.guest.guest.firstName, lastName: state.guest.guest.lastName } : null,
            adults: stay.adults,
            childCount: state.children?.actualChildAges.length,
            roomType: room.roomType,
            track: state.track ? { display: state.track.display, code: state.track.lookupCode } : null,
            guaranteeType: input.guaranteeType,
            source: state.source ? { nativeCode: state.source.nativeCode, description: state.source.candidate?.description } : null,
            cmsSend: state.cmsSend.actual, cmsMessageId: state.cms?.actual ?? null, cmsRecipient: state.cmsRecipient ?? null, note: note || '',
            parties: {
              ...(state.agency ? { agency: { nativeId: String(state.agency.nativeId), name: state.agency.displayedAgency } } : {}),
              ...(state.organization ? { organization: { nativeId: String(state.organization.nativeId),
                name: state.organization.displayedOrganization } } : {}),
            },
          },
        }, ['selected_unsaved', 'criteria_unavailable']);
        const selected = typeof createAuthority?.withM1CreateRateAvailability === 'function'
          ? await createAuthority.withM1CreateRateAvailability(selectRatePlan)
          : await selectRatePlan();
        if (selected.outcome === 'criteria_unavailable') {
          if (commit) stop('needs_input', selected.issue || 'rate_criteria_unavailable', { detail: selected });
          missing.push('room.ratePlanCriteria'); output.ratePlanIssue = selected;
        } else {
          if (selected.code !== room.ratePlan) stop('uncertain', 'requested_field_not_staged', { field: 'room.ratePlan' });
          if (state.rateAvailabilityRequired && !selected.rateAvailability) {
            stop('needs_input', 'rate_availability_unverified', { field: 'room.ratePlan' });
          }
          if (room.roomTypeForCharge !== undefined && selected.chargeRoomPricing !== 'checked') {
            stop('needs_input', 'charged_room_price_recheck_required', { field: 'room.roomTypeForCharge' });
          }
          output.applied.ratePlan = selected.code;
          if (selected.rateAvailability) output.ratePlanAvailability = selected.rateAvailability;
        }
      }
      let form;
      try { form = await call(runTool, 'readGuestStayForm', { propertyCode }); }
      catch (error) {
        if (state.guestNameDraft) stop('uncertain', 'guest_name_stage_unverified', { field: 'guest' });
        throw error;
      }
      if (state.guestNameDraft && (!Array.isArray(form.fields) || !form.fields.every((field) => field && typeof field === 'object'))) {
        stop('uncertain', 'guest_name_stage_unverified', { field: 'guest' });
      }
      for (const [key, name] of [['arrival', 'arrivaldate'], ['departure', 'departuredate'], ['adults', 'adults'],
        ['roomType', 'roomtype'], ['roomTypeForCharge', 'roomtypecharge'], ['ratePlan', 'rateplan'], ['sourceOfBusiness', 'sourceofbusinessdesc'], ['note', 'reservationnote']]) {
        if (Object.hasOwn(output.applied, key)) {
          const actual = formValue(form.fields, name), expected = output.applied[key];
          output.applied[key] = actual;
          if (['note', 'roomType', 'roomTypeForCharge', 'ratePlan'].includes(key) ? actual !== expected : !same(actual, expected)) stop('uncertain', 'draft_readback_mismatch', { field: key, actual });
        }
      }
      for (const [name, expected] of [
        ...(state.guest ? [['guestid', state.guest.selected.nativeId], ['firstname', state.guest.guest.firstName], ['lastname', state.guest.guest.lastName]] : []),
        ...(state.children ? [['children', state.children.actualChildAges.length], ...Object.entries(state.children.ageBandCounts)] : []),
        ...(state.organization ? [['company', state.organization.displayedOrganization]] : []),
        ...(state.agency ? [['ta1', state.agency.displayedAgency]] : []),
        ...(state.arAccount ? [['araccountname', state.arAccount.displayedArAccount]] : []),
        ...(state.guarantee ? [['guaranteetype', state.guarantee.actual.display]] : []),
        ...(state.cms ? [['udfchar09', state.cms.actual]] : []),
        ...(state.reason ? [['reasonforstay', state.reason.actual.display]] : []),
        ['udfchkbox04', state.cmsSend.actual],
      ]) if (!same(formValue(form.fields, name), expected)) stop('uncertain', 'draft_readback_mismatch', { field: name });
      if (expectedGuest && state.guest && (commit
        ? formValue(form.fields, 'firstname') !== expectedGuest.firstName || formValue(form.fields, 'lastname') !== expectedGuest.lastName
        : !same(formValue(form.fields, 'firstname'), expectedGuest.firstName) || !same(formValue(form.fields, 'lastname'), expectedGuest.lastName))) {
        stop('uncertain', 'draft_readback_mismatch', { field: 'guest' });
      }
      if (state.guestNameDraft) {
        if (formValue(form.fields, 'guestid') !== '' || formValue(form.fields, 'firstname') !== state.guestNameDraft.firstName ||
            formValue(form.fields, 'lastname') !== state.guestNameDraft.lastName) {
          stop('uncertain', 'guest_name_stage_unverified', { field: 'guest' });
        }
        output.guestNameDraft = state.guestNameDraft;
      }
      if (state.guest) output.applied.guest = { nativeId: state.guest.selected.nativeId, firstName: formValue(form.fields, 'firstname'),
        lastName: formValue(form.fields, 'lastname'), email: formValue(form.fields, 'emailaddress') };
      if (input.track != null) {
        if (!state.track || formValue(form.fields, 'track') !== state.track.display) {
          stop('needs_input', 'requested_track_not_staged', { field: 'track' });
        }
        output.applied.track = state.track.display;
      }
      const ratePlanReadyForBinding = Object.hasOwn(output.applied, 'ratePlan') && !missing.length &&
        !checked.unsupportedFields.length;
      if (ratePlanReadyForBinding && !text(formValue(form.fields, 'averagerate'))) {
        if (commit) stop('needs_input', 'rate_availability_unverified', { field: 'room.ratePlan' });
        missing.push('room.ratePlanAvailability');
        output.ratePlanIssue = { outcome: 'unverified', issue: 'RATE_AVAILABILITY_UNVERIFIED' };
      }
      if (input.guestoptin4 === false && formValue(form.fields, 'guestoptin4') !== false) {
        stop('uncertain', 'draft_readback_mismatch', { field: 'guestoptin4' });
      }
      for (const [field, expected] of [
        ...(state.booker?.name !== undefined ? [['caller', state.booker.name]] : []),
        ...(state.booker?.contact !== undefined ? [['udfchar06', state.booker.contact]] : []),
        ...(state.cmsRecipient !== undefined ? [['udfchar13', state.cmsRecipient]] : []),
      ]) if (formValue(form.fields, field) !== expected) stop('uncertain', 'draft_readback_mismatch', { field });
      output.appliedVerification = { visibleFields: true, ...(state.children ? { childAges: 'at_selection_only' } : {}),
        ...(state.organization ? { organizationId: 'at_selection_only' } : {}),
        ...(state.agency ? { agencyId: 'at_selection_only' } : {}), ...(state.arAccount ? { arAccountId: 'at_selection_only' } : {}) };
      if (!commit) {
        output.outcome = checked.unsupportedFields.length ? 'unsupported' : missing.length ? 'needs_input' : 'prepared';
        if (checked.unsupportedIssue) output.issue ||= checked.unsupportedIssue;
        if (output.outcome === 'prepared') {
          const binding = draftRequestBinding(input, state, output, form.fields);
          if (binding?.outcome === 'ok') {
            output.requestBinding = { request: binding.request, digest: binding.normalizedRequestDigest,
              ...(binding.arAccountProfileId ? { arAccountProfileId: binding.arAccountProfileId } : {}) };
          } else if (binding) output.requestBindingIssue = binding.issue;
          if (capturePrepareScreenshot && output.requestBinding) {
            const dir = join('/tmp', `hms-cloud-create-${randomUUID()}`);
            await mkdir(dir, { mode: 0o700 });
            await chmod(dir, 0o700);
            const path = join(dir, 'filled.png');
            await writeFile(path, await page.screenshot({ fullPage: true }), { mode: 0o600, flag: 'wx' });
            output.screenshots = { filled: path };
          }
        }
        return;
      }
      // A mounted staff flow supplies a server-owned digest from the reviewed
      // preview and native dispatch callbacks. Rebuild it from this fresh
      // form before installing the one-shot Save route: merely repeating the
      // browser input cannot prove HMS staged the approved guest and choices.
      if (expectedRequestDigest !== undefined) {
        const binding = draftRequestBinding(input, state, output, form.fields);
        if (binding?.outcome !== 'ok' || binding.normalizedRequestDigest !== expectedRequestDigest) {
          stop('refused', 'approved_request_changed');
        }
      }
      if (expectedRateAvailability !== undefined &&
          (!output.ratePlanAvailability || ['averageRate', 'totalRate', 'currency'].some(key =>
            output.ratePlanAvailability[key] !== expectedRateAvailability[key]) ||
           formValue(form.fields, 'averagerate') !== expectedRateAvailability.averageRate ||
           formValue(form.fields, 'totalrate') !== expectedRateAvailability.totalRate)) {
        stop('refused', 'approved_rate_changed');
      }
      output.applied.guaranteeType = formValue(form.fields, 'guaranteetype');
      state.dir = join('/tmp', `hms-cloud-create-${randomUUID()}`); await mkdir(state.dir, { mode: 0o700 });
      await chmod(state.dir, 0o700);
      const screenshot = async (name) => {
        const path = join(state.dir, `${name}.png`);
        await writeFile(path, await page.screenshot({ fullPage: true }), { mode: 0o600, flag: 'wx' });
        output.screenshots[name] = path;
      };
      state.screenshot = screenshot;
      if (input.billingReference == null) await screenshot('before');
      state.saveAttempted = true;
      try {
        state.save = await runTool({ tool: 'saveNewLabtestStay', preimageId: labtestPreimage.preimageId,
          arrival: stay.arrival, departure: stay.departure, guestId: state.guest.selected.nativeId,
          roomType: room.roomType, ratePlan: room.ratePlan, guaranteeType: input.guaranteeType, note,
          ...(room.roomTypeForCharge !== undefined ? { roomTypeForCharge: room.roomTypeForCharge } : {}),
          ...(state.track ? { track: state.track.display } : {}),
          ...(input.guestoptin4 === false ? { guestOptIn: false } : {}),
          ...(state.booker ? { booker: state.booker } : {}),
          ...(state.cmsRecipient !== undefined ? { cmsRecipient: state.cmsRecipient } : {}),
          cmsSend: input.cms?.send === true,
          ...(allowRealGuest || input.guaranteeType !== 'NGI' ? { guaranteeSelection: state.guarantee } : {}),
          createFieldProof: { adultSelection: state.adult, childAgeSelection: state.children,
            ...(state.source ? { sourceSelection: state.source } : {}),
            ...(state.cms ? { cmsMessageSelection: state.cms } : {}),
            ...(state.reason ? { reasonSelection: state.reason } : {}) },
          ...(state.organization ? { organizationSelection: state.organization } : {}),
          ...(state.agency ? { agencySelection: state.agency } : {}),
          ...(state.arAccount ? { arSelection: state.arAccount } : {}),
          ...(input.billingReference != null ? { billingReference: input.billingReference } : {}) });
      } catch { state.save = { outcome: 'uncertain', issue: 'SAVE_TOOL_FAILED' }; }
      if (state.save.billingReferenceStaged === true) output.applied.billingReference = input.billingReference;
      try { await screenshot('after'); } catch { state.afterScreenshotFailed = true; }
    }, { memory: null, blockServiceWorkers: true, ...(allowRealGuest ? { allowRealGuest: true, expectedGuest } : {}),
      ...(cloudTargetKey ? { cloudTargetKey } : {}),
      ...(commit ? { labtestDates: { arrival: stay.arrival, departure: stay.departure,
        ...(allowRealGuest ? expectedGuest : {}) },
      ...(verifyLabtestMatches ? { verifyLabtestMatches } : {}),
      ...(input.billingReference != null ? { beforeSaveScreenshot: () => state.screenshot('before') } : {}),
      ...(authorizeCandidate ? { authorizeCandidate, dispatchCandidate: (request, next) => dispatchCandidate(request, next, {
        preimage: state.preimage, beforeScreenshot: output.screenshots.before,
        guaranteeDisplay: state.guarantee?.actual?.display,
      }) } : {}) } : {}) });
    if (state.saveAttempted) output.writerSessionClosed = true;
  } catch (error) {
    state.sessionFailedAfterSave = Boolean(state.saveAttempted);
    Object.assign(output, error.result || (error.phase === 'labtest_preimage' ? { outcome: error.labtestPreimage?.outcome === 'existing_matches' ? 'needs_input' : 'uncertain',
      issue: 'labtest_preimage_not_clear', preimage: error.labtestPreimage } : { outcome: state.saveAttempted ? 'uncertain' : 'refused', issue: safeIssue(error) }));
  }
  if (!state.save) return output;
  output.save = state.save;
  output.confirmation = state.save.confirmation || null;
  if (['not_dispatched', 'refused', 'input_gap'].includes(state.save.outcome)) return { ...output,
    outcome: state.save.outcome === 'input_gap' ? 'needs_input' : 'refused', issue: state.save.issue || 'save_not_dispatched' };
  output.outcome = 'uncertain';
  const expected = { arrival: stay.arrival, departure: stay.departure, adults: stay.adults, children: stay.childAges.length,
    childBands: state.children.ageBandCounts, roomType: room.roomType, ratePlan: room.ratePlan, note: output.applied.note,
    ...(room.roomTypeForCharge !== undefined ? { roomTypeForCharge: room.roomTypeForCharge, checkedPricing: state.save.checkedPricing } : {}),
    guestId: state.guest.selected.nativeId, firstName: state.guest.guest.firstName, lastName: state.guest.guest.lastName,
    ...(allowRealGuest ? { allowRealGuest: true } : {}), source: state.source?.candidate.description,
    organization: state.organization?.displayedOrganization ?? '', guarantee: state.guarantee?.actual.display,
    ...(state.track ? { track: state.track.display } : {}),
    ...(input.guestoptin4 === false ? { guestOptIn: false } : {}),
    ...(state.booker ? { booker: state.booker } : {}),
    cmsSend: input.cms?.send === true,
    ...(state.cms ? { cmsMessageId: state.cms.actual } : {}),
    ...(state.cmsRecipient !== undefined ? { cmsRecipient: state.cmsRecipient } : {}),
    ...(output.applied.guest?.email !== undefined ? { guestEmail: output.applied.guest.email } : {}),
    ...(authorizeCandidate || input.guaranteeType !== 'NGI' ? { guaranteeCode: input.guaranteeType } : {}) };
  if (!output.confirmation) {
    const reconciliation = await reconcileLabtestCreate({ stay, expected }, { withSavedSession, cloudTargetKey, ...(census ? { census } : {}) });
    if (input.billingReference != null) {
      reconciliation.billingReferenceVerification = 'not_checked';
      for (const candidate of reconciliation.candidates) {
        candidate.billingAndPartyProof = { outcome: 'unverified', issue: 'FRESH_PARTY_AND_BILLING_READBACK_REQUIRED' };
      }
    }
    return { ...output, issue: 'save_requires_reconciliation', reconciliation };
  }
  try {
    output.readback = await readLabtestCreate({ confirmation: output.confirmation, stay, expected }, { withSavedSession, cloudTargetKey });
    if (!output.readback.mismatches) return { ...output, issue: 'readback_unverified' };
    if (state.reason && !same(formValue(output.readback.fields, 'reasonforstay'), state.reason.actual.display)) {
      output.readback.mismatches.push({ field: 'reasonForStay', issue: 'missing_or_mismatched' });
    }
    if (state.cms && formValue(output.readback.fields, 'udfchar09') !== state.cms.actual) {
      output.readback.mismatches.push({ field: 'cmsMessageId', issue: 'missing_or_mismatched' });
    }
    if (authorizeCandidate || state.agency || state.organization || state.arAccount) {
      output.readback.partyProof = await partyReadback({ confirmation: output.confirmation, arrival: stay.arrival,
        guestId: state.guest.selected.nativeId, firstName: state.guest.guest.firstName, lastName: state.guest.guest.lastName,
        ...(allowRealGuest ? { allowRealGuest: true } : {}),
        agency: state.agency ? { nativeId: state.agency.nativeId, name: state.agency.displayedAgency } : null,
        organization: state.organization ? { nativeId: state.organization.nativeId, name: state.organization.displayedOrganization } : null,
        arAccount: state.arAccount ? { nativeId: state.arAccount.nativeId, name: state.arAccount.displayedArAccount,
          profileId: state.save.arProfileId } : null,
        ...(input.billingReference != null ? { billingReference: input.billingReference } : {}) }, { cloudTargetKey });
    }
    const partiesVerified = !(authorizeCandidate || state.agency || state.organization || state.arAccount) ||
      output.readback.partyProof?.outcome === 'verified';
    const callbacksDrained = !authorizeCandidate || state.save.dispatchCallbacksDrained === true;
    if (state.save.outcome === 'saved_same_form' && callbacksDrained && !state.afterScreenshotFailed && !state.sessionFailedAfterSave &&
        (input.billingReference == null || (state.save.billingReferenceStaged === true && Boolean(output.screenshots.before))) &&
        partiesVerified && output.readback.mismatches.length === 0) output.outcome = 'saved';
    else output.issue = state.afterScreenshotFailed ? 'result_screenshot_failed' :
      !callbacksDrained ? 'save_callback_drain_unconfirmed' : 'save_requires_reconciliation';
  } catch { output.issue = 'readback_unverified'; }
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw);
    const search = input?.guest?.search;
    // The standalone CLI can stage a named real guest, but never authorize a real Save.
    const realPreview = input?.mode === 'prepare' && validCreateGuest(search) && !isLabtestGuest(search);
    const options = realPreview ? { allowRealGuest: true, expectedGuest: { firstName: search.firstName, lastName: search.lastName } } : {};
    process.stdout.write(`${JSON.stringify(await createReservation(input, options))}\n`);
  } catch { process.stdout.write(`${JSON.stringify({ outcome: 'needs_input', issue: 'invalid_json_or_input' })}\n`); process.exitCode = 1; }
}
