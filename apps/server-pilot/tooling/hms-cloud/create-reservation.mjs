import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { withBookingLookupSession } from './booking-lookup-session.mjs';
import { withSavedStayAgentSession } from './saved-stay-agent-session.mjs';
import { readLabtestCreate, reconcileLabtestCreate } from './labtest-create-readback.mjs';

const text = (value) => typeof value === 'string' ? value.trim() : '';
const same = (a, b) => text(String(a ?? '')).toLocaleLowerCase() === text(String(b ?? '')).toLocaleLowerCase();
const code = (value, limit) => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= limit && !/[\r\n]/.test(value);
const date = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const stop = (outcome, issue, extra = {}) => { throw Object.assign(new Error(issue), { result: { outcome, issue, ...extra } }); };
const safeIssue = (error) => /^[A-Z][A-Z0-9_]{2,100}$/.test(error?.message || '') ? error.message : 'SESSION_FAILED';
const candidate = ({ nativeId, firstName, lastName, email, phoneNumber, city, country }) =>
  ({ nativeId, firstName, lastName, email, phoneNumber, city, country });

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { outcome: 'needs_input', issue: 'invalid_input' };
  if (!['prepare', 'commit'].includes(input.mode)) return { outcome: 'needs_input', issue: 'mode_required' };
  if (input.propertyCode !== 'HRCEN') return { outcome: 'unsupported', issue: 'property_not_supported' };
  if (input.cms?.send === true && input.mode === 'commit') return { outcome: 'unsupported', issue: 'sending_not_supported' };
  if (input.cms?.send != null && typeof input.cms.send !== 'boolean') return { outcome: 'needs_input', issue: 'cms_send_invalid' };
  if (input.mode === 'commit' && input.guaranteeType != null && input.guaranteeType !== 'NGI') {
    return { outcome: 'refused', issue: 'guarantee_not_supported_yet' };
  }
  if (input.mode === 'commit' && input.guest?.search &&
      (!same(input.guest.search.lastName, 'Labtest') || (input.guest.search.firstName && !same(input.guest.search.firstName, 'Proof')))) {
    return { outcome: 'refused', issue: 'real_guest_write_disabled' };
  }
  const stay = input.stay || {}, room = input.room || {}, guest = input.guest || {}, missing = [];
  if (guest.profileId != null && guest.search != null) return { outcome: 'needs_input', issue: 'guest_identity_conflict' };
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
  if (input.note != null && (typeof input.note !== 'string' || !input.note.trim() || input.note.length > 200)) missing.push('note');
  if (input.mode === 'commit') {
    if ([room.roomType, room.ratePlan].some((value) => value && !/^[A-Z0-9]{1,12}$/.test(value))) return { outcome: 'refused', issue: 'native_code_not_supported_yet' };
    if (!text(input.approval?.by) || !text(input.approval?.at) || Number.isNaN(Date.parse(input.approval.at))) missing.push('approval');
    if (date(stay.arrival) && stay.arrival < '2027-01-01') return { outcome: 'refused', issue: 'labtest_arrival_required' };
  }
  return { missing };
}

function warnings(input) {
  const result = [];
  for (const [field, value] of [
    ['parties.agencyId', input.parties?.agencyId], ['parties.arAccountId', input.parties?.arAccountId],
    ['booker', input.booker], ['cms.messageId', input.cms?.messageId], ['cms.recipient', input.cms?.recipient],
    ['billingReference', input.billingReference], ['price', input.price], ['track', input.track],
    ['marketSegment', input.marketSegment], ['guestoptin4', input.guestoptin4],
    ['confirmationRecipient', input.confirmationRecipient],
    ...(input.mode === 'prepare' && input.cms?.send != null ? [['cms.send', input.cms.send]] : []),
    ...(input.mode === 'prepare' ? [['guaranteeType', input.guaranteeType]] : []),
  ]) if (value !== undefined && value !== null) result.push({ field, issue: 'not_settable_yet' });
  for (const [object, prefix, allowed] of [
    [input, '', ['mode', 'propertyCode', 'guest', 'stay', 'room', 'guaranteeType', 'sourceOfBusiness', 'parties', 'note', 'booker', 'cms', 'billingReference', 'price', 'approval', 'track', 'marketSegment', 'guestoptin4', 'confirmationRecipient']],
    [input.parties, 'parties.', ['agencyId', 'organizationId', 'organizationName', 'arAccountId']],
    [input.cms, 'cms.', ['send', 'messageId', 'recipient']],
    [input.guest, 'guest.', ['profileId', 'search']], [input.guest?.search, 'guest.search.', ['lastName', 'firstName', 'email']],
    [input.stay, 'stay.', ['arrival', 'departure', 'adults', 'childAges', 'childCount']], [input.room, 'room.', ['roomType', 'ratePlan']],
  ]) for (const key of Object.keys(object || {})) {
    if (!allowed.includes(key)) result.push({ field: `${prefix}${key}`, issue: 'not_settable_yet' });
  }
  for (const key of ['messageId', 'recipient']) if (input.cms && Object.hasOwn(input.cms, key) && input.cms[key] === null) {
    result.push({ field: `cms.${key}`, issue: 'not_settable_yet' });
  }
  return result;
}

async function call(runTool, tool, args = {}, accepted = ['updated_unsaved', 'unchanged_unsaved', 'selected_unsaved', 'ok']) {
  const result = await runTool({ tool, ...args });
  if (!accepted.includes(result.outcome)) stop(
    ['input_gap', 'no_match', 'unsupported'].includes(result.outcome) ? 'needs_input' : 'uncertain',
    result.issue || `${tool}_failed`, { stage: tool, detail: result });
  return result;
}

async function selectGuest(runTool, guest, commit) {
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
      { guestCandidates: all.map(candidate), guestCoverage: found.coverage, guestCorrelation: found.correlation });
  }
  const chosen = matches[0];
  if (commit && (chosen.firstName !== 'Proof' || chosen.lastName !== 'Labtest')) stop('refused', 'real_guest_write_disabled');
  const selected = await call(runTool, 'selectGuestProfile', { searchId: found.searchId, nativeId: chosen.nativeId });
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
  return call(runTool, 'selectGuestStaySourceBusiness', { searchId: search.searchId, nativeCode: matches[0].nativeCode });
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
  return call(runTool, 'selectOrganization', { searchId: search.searchId, nativeId: matches[0].nativeId });
}

function formValue(fields, name) {
  const matches = (fields || []).filter((field) => field.name === name);
  return matches.length === 1 ? matches[0].value : null;
}

/** Prepare a new draft, or save one verified Proof Labtest stay and read it in a fresh session. */
export async function createReservation(input, { withSession = withBookingLookupSession, withSavedSession = withSavedStayAgentSession, census } = {}) {
  const checked = validate(input);
  if (checked.outcome) return checked;
  const commit = input.mode === 'commit', missing = checked.missing;
  const output = { outcome: 'needs_input', applied: {}, appliedVerification: { visibleFields: false }, warnings: warnings(input), suggestedCmsMessageId: '03', missing };
  if (commit && missing.length) return output;
  const stay = input.stay || {}, room = input.room || {}, state = {};
  if (commit) output.screenshots = {};
  try {
    await withSession(async ({ page, runTool, labtestPreimage }) => {
      const propertyCode = input.propertyCode;
      if (commit) {
        state.guest = await selectGuest(runTool, input.guest, true);
      }
      for (const [key, field] of [['arrival', 'arrivalDate'], ['departure', 'departureDate']]) {
        if (date(stay[key])) {
          const result = await call(runTool, 'setGuestStayDate', { propertyCode, field, date: stay[key] });
          output.applied[key] = result.displayed;
        }
      }
      if (Number.isInteger(stay.adults) && stay.adults > 0) {
        state.adult = await call(runTool, 'selectGuestStayDropdown', { propertyCode, field: 'adults', value: stay.adults });
        output.applied.adults = state.adult.actual.display;
      }
      if (Array.isArray(stay.childAges) && stay.childAges.every((age) => Number.isInteger(age) && age >= 0 && age <= 17)) {
        state.children = await call(runTool, 'setGuestStayChildAges', { propertyCode, childAges: stay.childAges });
        output.applied.childAges = state.children.actualChildAges;
      }
      if (code(room.roomType, 200)) {
        const found = await call(runTool, 'searchRoomTypes', { query: room.roomType, limit: 100 }, ['matches', 'no_match', 'incomplete']);
        const inspected = await call(runTool, 'inspectRoomRateCandidate', { searchId: found.searchId, code: room.roomType }, ['match', 'ambiguous', 'not_in_loaded_results']);
        const matches = inspected.candidates || [];
        if (matches.length !== 1 || !found.coverage?.complete) stop('needs_input', 'room_type_not_unique', { roomCandidates: found.candidates, coverage: found.coverage });
        const selected = await call(runTool, 'selectRoomType', { searchId: found.searchId, code: room.roomType });
        output.applied.roomType = selected.selectedField.value;
      }
      if (code(room.ratePlan, 100) && date(stay.arrival) && date(stay.departure) && stay.arrival < stay.departure) {
        const selected = await call(runTool, 'selectGuestStayRatePlan', { code: room.ratePlan, ...(commit ? { guestProfileId: state.guest.selected.nativeId } : {}) }, ['selected_unsaved', 'criteria_unavailable']);
        if (selected.outcome === 'criteria_unavailable') {
          if (commit) stop('needs_input', selected.issue || 'rate_criteria_unavailable', { detail: selected });
          missing.push('room.ratePlanCriteria'); output.ratePlanIssue = selected;
        } else output.applied.ratePlan = selected.code;
      }
      if (text(input.sourceOfBusiness)) {
        state.source = await selectSource(runTool, input.sourceOfBusiness);
        output.applied.sourceOfBusiness = state.source.selectedField.value;
      }
      if (!commit && (input.guest?.profileId != null || text(input.guest?.search?.lastName))) {
        state.guest = await selectGuest(runTool, input.guest, false);
      }
      if (input.parties?.organizationId != null || text(input.parties?.organizationName)) {
        state.organization = await selectOrganization(runTool, input.parties);
        output.applied.organization = { nativeId: state.organization.nativeId, name: state.organization.displayedOrganization };
      }
      if (commit) state.guarantee = await call(runTool, 'selectGuestStayDropdown', { propertyCode, field: 'guaranteeType', value: input.guaranteeType });
      if (commit) await call(runTool, 'setCmsSendCheckbox', { propertyCode, checked: false });
      const note = input.note ?? (commit ? `Proof Labtest create ${randomUUID()}` : null);
      if (note != null && typeof note === 'string' && note.trim() && note.length <= 200) {
        const result = await call(runTool, 'setGuestStayText', { propertyCode, field: 'reservationNote', value: note });
        output.applied.note = result.actual;
      }
      const form = await call(runTool, 'readGuestStayForm', { propertyCode });
      for (const [key, name] of [['arrival', 'arrivaldate'], ['departure', 'departuredate'], ['adults', 'adults'],
        ['roomType', 'roomtype'], ['ratePlan', 'rateplan'], ['sourceOfBusiness', 'sourceofbusinessdesc'], ['note', 'reservationnote']]) {
        if (Object.hasOwn(output.applied, key)) {
          const actual = formValue(form.fields, name), expected = output.applied[key];
          output.applied[key] = actual;
          if (['note', 'roomType', 'ratePlan'].includes(key) ? actual !== expected : !same(actual, expected)) stop('uncertain', 'draft_readback_mismatch', { field: key, actual });
        }
      }
      for (const [name, expected] of [
        ...(state.guest ? [['guestid', state.guest.selected.nativeId], ['firstname', state.guest.guest.firstName], ['lastname', state.guest.guest.lastName]] : []),
        ...(state.children ? [['children', state.children.actualChildAges.length], ...Object.entries(state.children.ageBandCounts)] : []),
        ...(state.organization ? [['company', state.organization.displayedOrganization]] : []),
        ...(commit ? [['guaranteetype', state.guarantee.actual.display], ['udfchkbox04', false]] : []),
      ]) if (!same(formValue(form.fields, name), expected)) stop('uncertain', 'draft_readback_mismatch', { field: name });
      if (state.guest) output.applied.guest = { nativeId: state.guest.selected.nativeId, firstName: formValue(form.fields, 'firstname'),
        lastName: formValue(form.fields, 'lastname'), email: formValue(form.fields, 'emailaddress') };
      output.appliedVerification = { visibleFields: true, ...(state.children ? { childAges: 'at_selection_only' } : {}), ...(state.organization ? { organizationId: 'at_selection_only' } : {}) };
      if (!commit) { output.outcome = missing.length ? 'needs_input' : 'prepared'; return; }
      output.applied.guaranteeType = formValue(form.fields, 'guaranteetype');
      state.dir = join('/tmp', `hms-cloud-create-${randomUUID()}`); await mkdir(state.dir, { mode: 0o700 });
      await chmod(state.dir, 0o700);
      const screenshot = async (name) => {
        const path = join(state.dir, `${name}.png`);
        await writeFile(path, await page.screenshot({ fullPage: true }), { mode: 0o600, flag: 'wx' });
        output.screenshots[name] = path;
      };
      await screenshot('before');
      state.saveAttempted = true;
      try {
        state.save = await runTool({ tool: 'saveNewLabtestStay', preimageId: labtestPreimage.preimageId,
          arrival: stay.arrival, departure: stay.departure, guestId: state.guest.selected.nativeId,
          roomType: room.roomType, ratePlan: room.ratePlan, guaranteeType: input.guaranteeType, note,
          createFieldProof: { adultSelection: state.adult, childAgeSelection: state.children,
            ...(state.source ? { sourceSelection: state.source } : {}) },
          ...(state.organization ? { organizationSelection: state.organization } : {}) });
      } catch { state.save = { outcome: 'uncertain', issue: 'SAVE_TOOL_FAILED' }; }
      try { await screenshot('after'); } catch { state.afterScreenshotFailed = true; }
      if (state.organization && state.save.outcome === 'saved_same_form') {
        state.organizationReadback = await runTool({ tool: 'readSavedLabtestRecord', confirmation: state.save.confirmation });
      }
    }, { memory: null, ...(commit ? { labtestDates: { arrival: stay.arrival, departure: stay.departure } } : {}) });
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
    guestId: state.guest.selected.nativeId, source: state.source?.candidate.description,
    organization: state.organization?.displayedOrganization ?? '', guarantee: state.guarantee?.actual.display };
  if (!output.confirmation) return { ...output, issue: 'save_requires_reconciliation',
    reconciliation: await reconcileLabtestCreate({ stay, expected }, { withSavedSession, ...(census ? { census } : {}) }) };
  try {
    output.readback = await readLabtestCreate({ confirmation: output.confirmation, stay, expected }, { withSavedSession });
    if (!output.readback.mismatches) return { ...output, issue: 'readback_unverified' };
    if (state.organization) output.readback.organizationProof = state.organizationReadback;
    if (state.save.outcome === 'saved_same_form' && !state.afterScreenshotFailed && !state.sessionFailedAfterSave &&
        (!state.organization || state.organizationReadback?.outcome === 'read_back_verified') &&
        output.readback.mismatches.length === 0) output.outcome = 'saved';
    else output.issue = state.afterScreenshotFailed ? 'result_screenshot_failed' : 'save_requires_reconciliation';
    output.warnings.push({ field: 'stay.childAges', issue: 'saved_record_exposes_age_bands_not_exact_ages' });
  } catch { output.issue = 'readback_unverified'; }
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    process.stdout.write(`${JSON.stringify(await createReservation(JSON.parse(raw)))}\n`);
  } catch { process.stdout.write(`${JSON.stringify({ outcome: 'needs_input', issue: 'invalid_json_or_input' })}\n`); process.exitCode = 1; }
}
