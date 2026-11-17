// Read and bind the complete native state before a staff-approved amendment.
import { cloudWriterCurrent, cloudWriterIdentity, withCloudCredentialLease, withCloudWriterSession } from './cloud-session.mjs';
import { installSavedStayReadGuard } from './saved-stay-read-guard.mjs';
import { readShallow, readRecord } from './hms-readers.mjs';
import { cleanLabtestRecord, currentLabtestRecord, snapshotLabtestRecord,
  unchangedLabtestBusinessParties } from './labtest-record.mjs';
import { previewSavedChildrenForComposition, readSavedChildAgesForComposition, savedChildOccupancy, sameChildAgeMultiset, stageSavedChildrenForComposition } from './guest-stay-amend-children.mjs';
import { createSavedChildStageRequestGate } from './saved-stay-child-request-gate.mjs';
import { createSavedRoomStageRequestGate } from './saved-stay-room-stage-gate.mjs';
import { createSavedRateStageRequestGate } from './saved-stay-rate-stage-gate.mjs';
import { stageSavedGuestFieldsForComposition } from './guest-stay-amend-contact.mjs';
import { stageSavedChargeRoomForComposition } from './guest-stay-amend-charge-room.mjs';
import { listSavedTrackChoices, stageSavedTrackForComposition } from './guest-stay-amend-track.mjs';
import { stageSavedStayCommission } from './guest-stay-commission.mjs';
import { inspectSavedGuaranteeForComposition, applySavedGuaranteeOnGo } from './guest-stay-amend-guarantee.mjs';
import { createSavedGuaranteeRequestGate } from './saved-stay-guarantee-request-gate.mjs';
import { inspectSavedPartyForComposition } from './guest-stay-amend-party.mjs';
import { createSavedPartyStageRequestGate, savedPartyBeforeImage } from './saved-stay-party-request-gate.mjs';
import { labtestCombinedAmendPreimageBinding } from './saved-stay-combined-preimage.mjs';
import { nativeCmsSendValue, runLabtestAmendSave } from './labtest-amend-save.mjs';
import { createLabtestAmendDispatch } from './labtest-amend-dispatch.mjs';
import { createFirstGoCallbackAuthority, isFirstGoCallbackAuthority } from './pane-amend-callback-authority.mjs';
import { createFinalGoCallbackAuthority, isFinalGoCallbackAuthority } from './pane-amend-final-authority.mjs';
import { runCloudPaneAmendCallbacks } from './pane-amend-callback-phase.mjs';
import { nativeMoneyCents, nativeAverageCents, nativeMoneyTenThousandths, nativePriceDigest, parseNativePricingJson,
  readAmendNightlyQuote, readSavedStayNightlyRates } from './saved-stay-nightly-rates.mjs';
import { stageSavedAdultForComposition } from './guest-stay-amend-adults.mjs';
import { stageSavedDatesForComposition, stageSavedRoomRateForComposition } from './guest-stay-amend-date-room-rate.mjs';
import { getPropertyRegistration } from './property-registry.mjs';

const identityKeys = ['source', 'propertyCode', 'confirmation', 'reservationStayId', 'reservationId',
  'recordId', 'guestId', 'status', 'firstName', 'lastName', 'arrival', 'departure', 'roomType',
  'ratePlan', 'adults', 'children', 'childAges'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const safeReadCodes = new Set(['BROWSER_CONTEXT_UNSAFE', 'APPROVED_STAY_MISMATCH', 'NATIVE_GUARANTEE_UNVERIFIED',
  'AMEND_PARTY_PREIMAGE_UNVERIFIED', 'AMEND_PARTY_PREIMAGE_CHANGED', 'NATIVE_QUOTE_OCCUPANCY_UNVERIFIED',
  'PROPERTY_OR_ORIGIN_MISMATCH', 'NATIVE_QUOTE_UNVERIFIED', 'NATIVE_QUOTE_PARTY_UNVERIFIED', 'NATIVE_CATALOG_UNAVAILABLE', 'NATIVE_PRICE_READ_FAILED',
  'NATIVE_PRICE_TARGET_UNVERIFIED', 'NATIVE_NIGHTLY_PRICE_UNVERIFIED', 'AMEND_PRICE_UNVERIFIED']);
const safeReadError = (error, phase) => ({
  phase,
  errorClass: ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'DOMException', 'TimeoutError',
    'DataCloneError', 'AbortError'].includes(error?.name) ? error.name : 'Error',
  message: safeReadCodes.has(error?.message) ? error.message :
    /Timeout \d+ms exceeded/i.test(error?.message ?? '') ? 'Native read timed out' :
      error?.name === 'DataCloneError' ? 'Native read options could not be cloned' : 'Native read failed; unsafe details suppressed',
});
const portableBusinessImage = snapshot => {
  const image = savedPartyBeforeImage(snapshot);
  if (!image?.data || !image?.values) return null;
  return { data: Object.fromEntries(Object.entries(image.data).filter(([key]) => key !== 'bookingsessionid')),
    values: Object.fromEntries(Object.entries(image.values).filter(([key]) => key !== 'bookingsessionid')) };
};
const percent = value => value !== null && value !== undefined && String(value).trim() !== '' &&
  Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100 ? Number(value) : null;
const validTarget = (target, selected) => {
  const property = getPropertyRegistration(target?.propertyCode);
  return Boolean(property?.active && target.origin === property.origin && selected?.propertyCode === property.propertyCode);
};
const searchHints = (selected, arrivalDate) => {
  const guestName = `${selected.firstName} ${selected.lastName}`;
  return { arrivalDate, ...(guestName.length <= 256 ? { guestName } : {}) };
};
const amendRecordOptions = { allowBlankNote: true, allowUnchangedBusinessParties: true,
  preserveUnsentRecipient: true, allowModelOnlyPrimaryPartyIds: true };
const nativeOptions = (input, record) => {
  if (input.allowRealGuest !== true && !(input.allowChangedLabGuarantee === true && isLabtest(input.selected) &&
      input.selected.arrival >= '2027-01-01')) return amendRecordOptions;
  const fields = record?.details?.fields?.filter((field) => field.name === 'guaranteetype');
  const code = record?.nativePreimage?.guaranteeCode, display = fields?.length === 1 ? fields[0].value : null;
  if (!/^[A-Z0-9]{1,20}$/.test(code || '') || typeof display !== 'string' || !display.trim()) throw new Error('NATIVE_GUARANTEE_UNVERIFIED');
  return { ...amendRecordOptions, allowRealGuest: true, expectedGuarantee: { code, display } };
};

/** Values staff must review and the complete native digest must preserve. */
export function cloudAmendPreserved(state, baseline, changes = {}) {
  const party = state?.partyPreimage, cmsRecipient = state?.cmsRecipient ?? '', guestEmail = state?.guestEmail;
  const cmsMessageId = state?.cmsMessageId, cmsSend = state?.cmsSend;
  const clean = (value, max) => typeof value === 'string' && value.length <= max && !/[\p{Cc}]/u.test(value);
  if (!party || !clean(cmsRecipient, 1000) || (guestEmail !== undefined && !clean(guestEmail, 1000)) ||
      (cmsMessageId !== undefined && !clean(cmsMessageId, 1000))) return null;
  const details = {};
  for (const [key, name] of Object.entries({ bookerName: 'caller', bookerContact: 'udfchar06' })) {
    if (!Object.hasOwn(changes, key) || !Object.hasOwn(baseline?.data ?? {}, name) ||
        !Object.hasOwn(baseline?.values ?? {}, name)) continue;
    const value = String(baseline.data[name] ?? '');
    if (clean(value, 1000) && value === String(baseline.values[name] ?? '')) details[key] = value;
  }
  const link = (id, name) => {
    if (id === '' && name === '') return null;
    if (!/^\d{1,30}$/.test(id || '') || !clean(name, 300) || !name.trim()) throw new Error('PARTY_UNVERIFIED');
    return { nativeId: id, name };
  };
  try {
    const bookingAgency = link(party.taid1, party.ta1);
    const organization = link(party.companyid, party.company || party.companyname);
    return { cmsRecipient, ...(cmsMessageId === undefined ? {} : { cmsMessageId }),
      ...(typeof cmsSend === 'boolean' ? { cmsSend } : {}),
      ...(guestEmail === undefined ? {} : { guestEmail }), ...details, bookingAgency, organization };
  } catch { return null; }
}

// Historical hints may use only a party actually linked on this saved record.
// A missing model, submitted value or visible name is unknown, not an empty link.
export function cloudAmendNativePartyBaseline(state, snapshot) {
  const unknown = () => ({ state: 'unknown' });
  if (!cleanLabtestRecord(snapshot) || !state?.partyPreimage || !snapshot?.data || !snapshot?.values ||
      !Array.isArray(snapshot.partyControls)) return { organization: unknown(), arAccount: unknown() };
  const field = (source, key) => {
    const matches = Object.keys(source).filter(name => name.toLowerCase() === key);
    if (matches.length !== 1 || matches[0] !== key) return null;
    const value = source[key];
    return value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)
      ? String(value ?? '') : null;
  };
  const selected = (idKey, nameKeys) => {
    const id = field(snapshot.data, idKey);
    if (id === null || state.partyPreimage[idKey] !== id) return unknown();
    const names = [];
    let visibleName = false, observedName = false;
    for (const key of [idKey, ...nameKeys]) {
      const value = field(snapshot.data, key);
      const formNames = Object.keys(snapshot.values).filter(name => name.toLowerCase() === key);
      const controls = snapshot.partyControls.filter(control => typeof control?.name === 'string' && control.name.toLowerCase() === key);
      if (formNames.length > 1 || formNames.some(name => name !== key) || controls.length > 1 ||
          controls.some(control => control.name !== key || typeof control.value !== 'string')) return unknown();
      if (value !== null && state.partyPreimage[key] !== value) return unknown();
      if (formNames.length && (value === null || field(snapshot.values, key) !== value)) return unknown();
      if (controls.length && (value === null || controls[0].value !== value ||
          (key !== idKey && (!formNames.length || field(snapshot.values, key) !== controls[0].value)))) return unknown();
      if (key !== idKey && controls.length) observedName = true;
      if (key !== idKey && value?.trim()) {
        names.push(value);
        if (controls.length) visibleName = true;
      }
    }
    if (!id && !names.length) return observedName ? { state: 'blank' } : unknown();
    if (!/^[1-9]\d{0,29}$/.test(id) || !visibleName || !names.length ||
        names.some(name => name !== names[0] || name.length > 300 || /[\p{Cc}]/u.test(name))) return unknown();
    return { state: 'selected', nativeId: id, name: names[0] };
  };
  return { organization: selected('companyid', ['company', 'companyname']),
    arAccount: selected('araccountid', ['araccountname']) };
}

// Install the exact-confirmation read fence before any page or login request.
// A session that skips the pre-login hook is unusable even for a rehearsal.
function guardedSession(input, guard, timeoutMs = 5 * 60_000) {
  let guardedContext = null, guardStarted = false, ownedPage = null;
  const deadline = AbortSignal.timeout(timeoutMs);
  const safeContext = (context) => context?._options?.serviceWorkers === 'block' &&
    typeof context.serviceWorkers === 'function' && context.serviceWorkers().length === 0;
  return {
    hasGuard: (context, page) => {
      if (guardedContext !== context || !safeContext(context) || !page || page.context() !== context ||
          (ownedPage && ownedPage !== page)) return false;
      ownedPage = page;
      return true;
    },
    options: { propertyCode: input.selected.propertyCode, transportId: input.transportId,
      credentialLease: input.credentialLease, startScreen: 'OSRESS',
      cloudTargetKeys: savedTargetKeys(input.selected),
      ...(input.cloudTargetKey ? { cloudTargetKey: input.cloudTargetKey } : {}),
      signal: AbortSignal.any([input.signal, input.credentialLease?.signal, deadline].filter(Boolean)),
      prepareContext: async (context) => {
        if (guardStarted || !safeContext(context)) throw new Error('BROWSER_CONTEXT_UNSAFE');
        // Claim the hook before awaiting route installation. A second context
        // must not race a still-pending guard and become the chosen session.
        guardStarted = true;
        await guard(context, { confirmation: input.confirmation, propertyCode: input.selected.propertyCode,
          getOwnedPage: () => ownedPage, forwardToCloud: true });
        guardedContext = context;
      } },
  };
}

function savedTargetKeys(selected) {
  const property = getPropertyRegistration(selected?.propertyCode);
  if (!property?.active) throw new Error('AMEND_PROPERTY_UNSUPPORTED');
  const suffix = property.propertyCode === 'HRCEN' ? [] : [property.expectedTenant];
  if (!/^\d+-\d+$/.test(selected.confirmation || '') || !/^\d{1,100}$/.test(selected.reservationStayId || '')) {
    throw new Error('AMEND_TARGET_INVALID');
  }
  const normalize = value => value.replace(/^0+(?=\d)/, '');
  const [base, segment] = selected.confirmation.split('-');
  return [JSON.stringify([property.propertyCode, 'saved', `${normalize(base)}-${normalize(segment)}`, ...suffix]),
    JSON.stringify([property.propertyCode, 'saved_native', normalize(selected.reservationStayId), ...suffix])];
}

const wireDate = (value) => `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`;
const displayDate = (value) => `${value.slice(8, 10)}-${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(value.slice(5, 7)) - 1]}-${value.slice(0, 4)}`;
const validDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const isLabtest = (selected) => selected?.firstName === 'Proof' && selected?.lastName === 'Labtest';
/** The requested target is business data, independent of the native form's size. */
function amendTarget(selected, changes, { allowRealGuest = false } = {}) {
  if (!selected || !changes || typeof changes !== 'object' || Array.isArray(changes) ||
      !getPropertyRegistration(selected.propertyCode)?.active || selected.status !== 'Reserved' ||
      !/^\d{6,}-\d+$/.test(selected.confirmation || '') || !/^\d+$/.test(selected.guestId || '') ||
      !/^\d+$/.test(selected.reservationStayId || '') || !/^\d+$/.test(selected.reservationId || '') ||
      !/^\d+$/.test(selected.recordId || '') || (!allowRealGuest && !isLabtest(selected))) return null;
  const target = { ...selected, arrival: changes.arrival ?? selected.arrival, departure: changes.departure ?? selected.departure,
    adults: changes.adults ?? selected.adults, children: changes.children ?? selected.children,
    childAges: changes.childAges ?? selected.childAges, roomType: changes.roomType ?? selected.roomType,
    ratePlan: changes.ratePlan ?? selected.ratePlan, firstName: changes.firstName ?? selected.firstName,
    lastName: changes.lastName ?? selected.lastName };
  if (!validDay(target.arrival) || !validDay(target.departure) || target.arrival >= target.departure ||
      !Number.isInteger(target.adults) || target.adults < 1 || target.adults > 16 ||
      !Number.isInteger(target.children) || target.children < 0 || target.children > 9 ||
      !/^[A-Z0-9]{1,12}$/.test(target.roomType || '') || !/^[A-Z0-9]{1,12}$/.test(target.ratePlan || '') ||
      !target.firstName?.trim() || !target.lastName?.trim() || !['yes', 'no'].includes(changes.retainRates) ||
      typeof changes.cmsSend !== 'boolean' || typeof changes.cmsMessageId !== 'string' || typeof changes.cmsRecipient !== 'string' ||
      (Array.isArray(target.childAges) && (target.childAges.length !== target.children ||
        target.childAges.some((age) => !Number.isInteger(age) || age < 0 || age > 17))) ||
      (!Array.isArray(target.childAges) && target.childAges !== 'unknown') ||
      (isLabtest(selected) && (selected.arrival < '2027-01-01' || target.arrival < '2027-01-01' || changes.cmsSend ||
        target.firstName !== 'Proof' || target.lastName !== 'Labtest'))) return null;
  return target;
}

function matchesAmendBusiness(snapshot, selected, changes, baseline, state) {
  const target = amendTarget(selected, changes, { allowRealGuest: state?.allowRealGuest === true });
  const data = snapshot?.data, values = snapshot?.values;
  if (!target || !data || !values || !baseline?.data || !state ||
      !unchangedLabtestBusinessParties(state.partyPreimage, snapshot,
        { allowModelOnlyPrimaryPartyIds: true, allowRealGuest: state.allowRealGuest === true })) return false;
  const required = { propertycode: target.propertyCode, status: 'Reserved', confirmationnumber: target.confirmation,
    guestid: target.guestId, reservationid: target.reservationId, reservationstayid: target.reservationStayId,
    recordid: target.recordId, firstname: target.firstName, lastname: target.lastName,
    arrivaldate: wireDate(target.arrival), departuredate: wireDate(target.departure), roomtype: target.roomType,
    rateplan: target.ratePlan, adults: String(target.adults), guaranteetype: state.expectedGuarantee?.code ?? 'NGI',
    reservationnote: Object.hasOwn(changes, 'reservationNote') ? changes.reservationNote : String(baseline.data.reservationnote ?? '') };
  if (Object.hasOwn(changes, 'roomTypeForCharge') || Object.hasOwn(baseline.data, 'roomtypecharge')) {
    required.roomtypecharge = Object.hasOwn(changes, 'roomTypeForCharge')
      ? changes.roomTypeForCharge : String(baseline.data.roomtypecharge ?? '');
  }
  if (Object.hasOwn(changes, 'track') || Object.hasOwn(baseline.data, 'track')) {
    required.track = changes.track?.display ?? String(baseline.data.track ?? '');
  }
  if (!Object.entries(required).every(([key, value]) => Object.hasOwn(data, key) && String(data[key] ?? '') === value)) return false;
  const displayed = { confirmationnumber: target.confirmation, guestid: target.guestId, status: 'Reserved',
    firstname: target.firstName, lastname: target.lastName, arrivaldate: displayDate(target.arrival),
    departuredate: displayDate(target.departure), roomtype: target.roomType, rateplan: target.ratePlan,
    adults: String(target.adults) };
  displayed.reservationnote = required.reservationnote;
  if (Object.hasOwn(required, 'roomtypecharge')) displayed.roomtypecharge = required.roomtypecharge;
  if (Object.hasOwn(required, 'track')) displayed.track = required.track;
  if (!Object.entries(displayed).every(([key, value]) => Object.hasOwn(values, key) && String(values[key] ?? '') === value)) return false;
  const contact = { emailaddress: 'guestEmail', caller: 'bookerName', udfchar06: 'bookerContact', billingreference: 'billingReference' };
  for (const [name, key] of Object.entries(contact)) {
    if (!Object.hasOwn(baseline.data, name) && !Object.hasOwn(changes, key)) continue;
    const expected = Object.hasOwn(changes, key) ? changes[key] : String(baseline.data[name] ?? '');
    if (!Object.hasOwn(data, name) || String(data[name] ?? '') !== expected ||
        (Object.hasOwn(values, name) && String(values[name] ?? '') !== expected)) return false;
  }
  if (Object.hasOwn(changes, 'taCommission') && (percent(data.ta1commission) !== changes.taCommission ||
      percent(values.ta1commission) !== changes.taCommission)) return false;
  if (Object.hasOwn(changes, 'guestOptIn') && (typeof changes.guestOptIn !== 'boolean' ||
      nativeCmsSendValue(data.guestoptin4) !== changes.guestOptIn || snapshot.guestOptInControl !== changes.guestOptIn ||
      (Object.hasOwn(values, 'guestoptin4') && nativeCmsSendValue(values.guestoptin4) !== changes.guestOptIn))) return false;
  const recipient = changes.cmsRecipient, message = changes.cmsMessageId;
  const formCms = !Object.hasOwn(values, 'udfchkbox04') || values.udfchkbox04 === ''
    ? false : nativeCmsSendValue(values.udfchkbox04);
  if (snapshot.cmsSendControl !== changes.cmsSend || formCms !== changes.cmsSend ||
      String(data.udfchar13 ?? '') !== recipient ||
      String(data.udfchar09 ?? '') !== message) return false;
  const children = savedChildOccupancy(snapshot);
  if (!children.valid || children.count !== target.children) return false;
  if (Array.isArray(target.childAges)) {
    const zeroAges = children.count === 0 && children.fields.childages.model.present &&
      children.fields.childages.model.value === '' &&
      (!Object.keys(values).some(key => key.toLowerCase() === 'childages') ||
        (children.fields.childages.form.present && children.fields.childages.form.value === ''));
    const ages = zeroAges ? [] : children.ages;
    if (!sameChildAgeMultiset(ages, target.childAges) && !(ages === null &&
        sameChildAgeMultiset(state.verifiedChildAges, target.childAges))) return false;
  }
  return true;
}

/** Match the selected stay and requested business fields on the paused native Save. */
export function matchesCloudPaneAmendSave(request, frame, snapshot,
  { selected, changes, beforeNote, beforeParties, guaranteeCode = 'NGI', verifiedChildAges, allowRealGuest = false, phase = 'save', baseline } = {}) {
  try {
    const original = baseline ?? snapshot, state = { partyPreimage: beforeParties, allowRealGuest, verifiedChildAges,
      expectedGuarantee: { code: guaranteeCode } };
    if (!['save', 'retain', 'extend'].includes(phase) || typeof beforeNote !== 'string' ||
        String(original?.data?.reservationnote ?? '') !== beforeNote ||
        !matchesAmendBusiness(snapshot, selected, changes, original, state)) return false;
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || ''), data = snapshot.data;
    if (request.method() !== 'POST' || request.frame() !== frame || url.origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com' ||
        url.pathname !== '/web/base/OSRESV.HDR' || url.hash || url.searchParams.get('pageaction') !== 'SAVE' ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '')) return false;
    const required = { SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR',
      propertycode: selected.propertyCode, confirmationnumber: selected.confirmation, guestid: selected.guestId,
      reservationid: selected.reservationId, reservationstayid: selected.reservationStayId, recordid: selected.recordId,
      status: 'Reserved' };
    for (const name of ['firstname', 'lastname', 'arrivaldate', 'departuredate', 'roomtype', 'rateplan', 'adults',
      'children', 'guaranteetype', 'reservationnote', 'emailaddress', 'udfchar13']) required[name] = String(data[name] ?? '');
    const cmsFields = [...body].filter(([name]) => name.toLowerCase() === 'udfchkbox04');
    if (cmsFields.length !== 1 || cmsFields[0][0] !== 'udfchkbox04' ||
        nativeCmsSendValue(cmsFields[0][1]) !== changes.cmsSend) return false;
    if (Object.hasOwn(data, 'roomtypecharge')) required.roomtypecharge = String(data.roomtypecharge ?? '');
    if (Object.hasOwn(data, 'track')) required.track = String(data.track ?? '');
    if (Object.hasOwn(changes, 'childAges')) {
      const occupancy = savedChildOccupancy(snapshot);
      if (!occupancy.valid) return false;
      for (const name of ['childages', ...Object.keys(occupancy.bands)]) required[name] = String(data[name] ?? '');
    }
    if (Object.hasOwn(changes, 'taCommission')) {
      const fields = [...body].filter(([name]) => name.toLowerCase() === 'ta1commission');
      if (fields.length !== 1 || fields[0][0] !== 'ta1commission' || percent(fields[0][1]) !== changes.taCommission) return false;
    }
    if (Object.hasOwn(changes, 'guestOptIn')) {
      const fields = [...body].filter(([name]) => name.toLowerCase() === 'guestoptin4');
      if (fields.length !== 1 || fields[0][0] !== 'guestoptin4' || nativeCmsSendValue(fields[0][1]) !== changes.guestOptIn) return false;
    }
    for (const [key, name] of Object.entries({ bookerName: 'caller', bookerContact: 'udfchar06',
      billingReference: 'billingreference', cmsMessageId: 'udfchar09' })) {
      if (Object.hasOwn(changes, key) || (key === 'billingReference' && Object.hasOwn(data, name))) required[name] = String(data[name] ?? '');
    }
    if (phase === 'retain' || phase === 'extend') {
      required.confirmretainrate = changes.retainRates === 'yes' ? 'confirmed' : 'not_needed';
    }
    if (phase === 'extend') {
      if (changes.retainRates !== 'yes') return false;
      required.confirmextendoverriderate = 'confirmed';
    }
    // A stale confirmation could skip the native question and its approved choice.
    for (const key of ['confirmretainrate', 'confirmextendoverriderate']) {
      const fields = [...body].filter(([name]) => name.toLowerCase() === key);
      if (fields.length > 1 || (fields.length && fields[0][0] !== key)) return false;
      if (!Object.hasOwn(required, key) && fields.length && fields[0][1] !== '') return false;
    }
    return Object.entries(required).every(([key, value]) => {
      const fields = [...body].filter(([name]) => name.toLowerCase() === key.toLowerCase());
      return fields.length === 1 && fields[0][0] === key && fields[0][1] === value;
    });
  } catch { return false; }
}

/** Do not infer a target from the fake name: the fresh native record must match the selected stay. */
export function expectedLabtestAmendRecord(record, selected, { allowRealGuest = false,
  childAgePreimage = null, allowUnknownChildAges = false } = {}) {
  const native = record?.nativePreimage, fields = record?.details?.fields;
  if (!native || !selected || !Array.isArray(fields) || native.source !== 'record_view_ext_model' ||
      !getPropertyRegistration(native.propertyCode)?.active || native.propertyCode !== selected.propertyCode || !native.firstName?.trim() || !native.lastName?.trim() ||
      (!allowRealGuest && (native.firstName !== 'Proof' || native.lastName !== 'Labtest' || native.guaranteeCode !== 'NGI' || native.arrival < '2027-01-01')) ||
      native.status !== 'Reserved' || !/^[A-Z0-9]{1,20}$/.test(native.guaranteeCode || '') ||
      identityKeys.some((key) => !Object.hasOwn(native, key) || !Object.hasOwn(selected, key) ||
        (!same(native[key], selected[key]) && !(key === 'childAges' && (
          Array.isArray(native.childAges) && sameChildAgeMultiset(native.childAges, selected.childAges) ||
          native.childAges === 'unknown' && Array.isArray(selected.childAges) &&
            (allowUnknownChildAges || sameChildAgeMultiset(childAgePreimage, selected.childAges))))))) return null;
  const notes = fields.filter((field) => field?.name === 'reservationnote');
  if (notes.length !== 1 || typeof notes[0].rawValue !== 'string' || notes[0].rawValue.length > 2_000) return null;
  return { propertyCode: native.propertyCode, confirmation: native.confirmation, guestId: native.guestId, firstName: native.firstName, lastName: native.lastName, arrival: native.arrival,
    departure: native.departure, roomType: native.roomType, ratePlan: native.ratePlan, note: notes[0].rawValue,
    adults: native.adults, childCount: native.children,
    childAges: native.childAges === 'unknown' ? null : native.childAges };
}

/** Stage the actual amendment and HMS pricing, with Save permanently disarmed. */
export async function prepareCloudPaneAmend(input, dependencies = {}) {
  const { openSession = withCloudWriterSession,
  guard = installSavedStayReadGuard, shallow = readShallow, read = readRecord,
  current = currentLabtestRecord, snapshot = snapshotLabtestRecord, bind = labtestCombinedAmendPreimageBinding,
  quote = readAmendNightlyQuote } = dependencies;
  const selected = input?.selected;
  if (!validTarget(input?.target, input?.selected) || !amendTarget(selected, input?.changes, { allowRealGuest: input?.allowRealGuest === true }) ||
      selected.confirmation !== input.confirmation || selected.arrival !== input.arrival) {
    return { outcome: 'refused', issue: 'AMEND_INPUT_INVALID' };
  }
  let phase = 'credential_lease';
  try {
    if (!input.credentialLease && openSession === withCloudWriterSession) {
      return await withCloudCredentialLease(selected.propertyCode, credentialLease =>
        prepareCloudPaneAmend({ ...input, credentialLease }, dependencies), { signal: input.signal, readOnly: true });
    }
    let stageQuote = quote;
    if (input.changes.retainRates !== 'yes' && openSession === withCloudWriterSession && quote === readAmendNightlyQuote) {
      phase = 'party_preimage';
      const preliminary = guardedSession(input, guard);
      const partyPreimage = await openSession(async page => {
        if (!preliminary.hasGuard(page.context(), page)) throw new Error('BROWSER_CONTEXT_UNSAFE');
        await shallow(page, input.confirmation, searchHints(selected, input.arrival));
        const record = await read(page, input.confirmation, { nativePropertyCode: selected.propertyCode });
        const expected = expectedLabtestAmendRecord(record, selected, { allowRealGuest: input.allowRealGuest === true,
          childAgePreimage: input.childAgePreimage });
        if (!expected) throw new Error('APPROVED_STAY_MISMATCH');
        const state = await current(page, expected, nativeOptions(input, record));
        if (!state?.partyPreimage) throw new Error('AMEND_PARTY_PREIMAGE_UNVERIFIED');
        return structuredClone(state.partyPreimage);
      }, { ...preliminary.options, staging: true });
      const quoteInput = Array.isArray(input.childAgePreimage)
        ? { ...input, selected: { ...selected, childAges: input.childAgePreimage } } : input;
      phase = 'nightly_quote';
      const observedQuote = await quote(quoteInput, { partyPreimage });
      stageQuote = async (_input, state) => {
        if (!same(state?.partyPreimage, partyPreimage)) throw new Error('AMEND_PARTY_PREIMAGE_CHANGED');
        return observedQuote;
      };
    }
    phase = 'native_prepare';
    const protectedSession = guardedSession(input, guard);
    return await openSession(async (page) => {
      if (!protectedSession.hasGuard(page.context(), page)) return { outcome: 'refused', issue: 'BROWSER_CONTEXT_UNSAFE' };
      await shallow(page, input.confirmation, searchHints(selected, input.arrival));
      const record = await read(page, input.confirmation, { nativePropertyCode: input.selected.propertyCode });
      const expected = expectedLabtestAmendRecord(record, selected, { allowRealGuest: input.allowRealGuest === true,
        childAgePreimage: input.childAgePreimage });
      if (!expected) return { outcome: 'refused', issue: 'APPROVED_STAY_MISMATCH' };
      const result = await runLabtestAmendSave(page, cloudPaneAmendRunOptions({ page, input: {
        ...input, signal: protectedSession.options.signal }, expected, prepareOnly: true },
      { current, snapshot, bind, quote: stageQuote, recordOptions: nativeOptions(input, record) }));
      if (result.issue === 'PREPARE_ONLY' && result.nativeDigest && result.approvedPrices && result.preserved) {
        return { outcome: 'prepared', nativeDigest: result.nativeDigest,
          approvedPrices: result.approvedPrices, preserved: result.preserved,
          ...(input.captureMealPlan ? { applied: result.applied } : {}),
          recoveryBaseline: result.recoveryBaseline, nativePartyBaseline: result.nativePartyBaseline,
          ...(input.captureBusinessImage ? { sourceBusinessImage: result.sourceBusinessImage } : {}) };
      }
      return { outcome: 'refused', issue: result.issue || 'AMEND_PREPARE_UNVERIFIED' };
    }, { ...protectedSession.options, staging: true });
  } catch (error) {
    return { outcome: 'refused', issue: 'NATIVE_READ_UNAVAILABLE', diagnostic: safeReadError(error, phase) };
  }
}

/** Resolve unknown saved ages in a separate, read-only native session. */
export async function readCloudSavedChildAges(input, { openSession = withCloudWriterSession,
  guard = installSavedStayReadGuard, shallow = readShallow, read = readRecord,
  current = currentLabtestRecord, snapshot = snapshotLabtestRecord } = {}) {
  const selected = input?.selected;
  if (!validTarget(input?.target, input?.selected) || !selected || selected.confirmation !== input.confirmation ||
      selected.arrival !== input.arrival || !amendTarget(selected, { retainRates: 'no', cmsSend: false, cmsMessageId: '', cmsRecipient: '' },
        { allowRealGuest: input.allowRealGuest === true })) return { outcome: 'refused', issue: 'AMEND_INPUT_INVALID' };
  try {
    const protectedSession = guardedSession(input, guard);
    return await openSession(async page => {
      if (!protectedSession.hasGuard(page.context(), page)) return { outcome: 'refused', issue: 'BROWSER_CONTEXT_UNSAFE' };
      await shallow(page, input.confirmation, searchHints(selected, input.arrival));
      const record = await read(page, input.confirmation, { nativePropertyCode: input.selected.propertyCode });
      const expected = expectedLabtestAmendRecord(record, selected, {
        allowRealGuest: input.allowRealGuest === true,
        allowUnknownChildAges: true,
      });
      if (!expected) return { outcome: 'refused', issue: 'APPROVED_STAY_MISMATCH' };
      const result = await runLabtestAmendSave(page, {
        timeoutMs: 120_000, signal: protectedSession.options.signal, prepareOnly: true,
        prepare: async bounded => {
          const state = await bounded(current(page, expected, nativeOptions(input, record)));
          const baseline = await bounded(snapshot(state.frame)), occupancy = savedChildOccupancy(baseline);
          const raw = occupancy.fields?.childages?.model;
          const save = state.frame.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
          if (!baseline || !occupancy.valid || !raw?.present || (occupancy.ages === null && raw.value !== '') ||
              await bounded(save.count()) !== 1) throw new Error('CHILD_PREIMAGE_UNVERIFIED');
          return { frame: state.frame, save, baseline, enableComposedStage: true, allowRealGuest: input.allowRealGuest === true,
            expected: { ...expected, reservationStayId: selected.reservationStayId, expectedGuarantee: state.expectedGuarantee },
            childStageGate: createSavedChildStageRequestGate({ propertyCode: selected.propertyCode, frame: state.frame, stayId: selected.reservationStayId,
              adults: expected.adults, priorAges: occupancy.ages, priorBands: occupancy.bands,
              readAges: occupancy.ages ?? [], readOnly: true, deadlineAt: performance.now() + 120_000 }) };
        },
        stage: async (bounded, prepared, context) => bounded(readSavedChildAgesForComposition(context, prepared.expected)),
        validate: async (_bounded, _prepared, staged) => Array.isArray(staged?.ages) && staged.ages.length === expected.childCount,
        matches: () => false,
        stageDetails: staged => ({ ages: staged?.ages, bands: staged?.bands }),
      });
      return result.issue === 'PREPARE_ONLY' && result.blockedRequests === 0 && Array.isArray(result.ages) &&
          (!Array.isArray(selected.childAges) || sameChildAgeMultiset(result.ages, selected.childAges))
        ? { outcome: 'ok', ages: result.ages, bands: result.bands }
        : { outcome: 'refused', issue: result.issue === 'PREPARE_ONLY' ? 'SAVED_AGES_UNVERIFIED' :
          result.issue || 'SAVED_AGES_UNVERIFIED' };
    }, { ...protectedSession.options, staging: true });
  } catch { return { outcome: 'refused', issue: 'SAVED_AGES_UNVERIFIED' }; }
}

/** Preview requested child ages in the native editor, then Cancel without Apply. */
export async function previewCloudPaneAmendChildren(input, { openSession = withCloudWriterSession,
  guard = installSavedStayReadGuard, shallow = readShallow, read = readRecord,
  current = currentLabtestRecord, snapshot = snapshotLabtestRecord } = {}) {
  const selected = input?.selected, beforeAges = input?.beforeChildAges, ages = input?.childAges;
  if (!validTarget(input?.target, input?.selected) || !selected || selected.confirmation !== input.confirmation ||
      selected.arrival !== input.arrival || !Array.isArray(beforeAges) || beforeAges.length !== selected.children ||
      !Array.isArray(ages) || ages.length > 9 || [...beforeAges, ...ages].some(age => !Number.isInteger(age) || age < 0 || age > 17)) {
    return { outcome: 'refused', issue: 'CHILD_INPUT_INVALID' };
  }
  try {
    const protectedSession = guardedSession(input, guard);
    return await openSession(async page => {
      if (!protectedSession.hasGuard(page.context(), page)) return { outcome: 'refused', issue: 'BROWSER_CONTEXT_UNSAFE' };
      await shallow(page, input.confirmation, searchHints(selected, input.arrival));
      const record = await read(page, input.confirmation, { nativePropertyCode: input.selected.propertyCode });
      const expected = expectedLabtestAmendRecord(record, selected, { allowRealGuest: input.allowRealGuest === true,
        childAgePreimage: beforeAges });
      if (!expected) return { outcome: 'refused', issue: 'APPROVED_STAY_MISMATCH' };
      const result = await runLabtestAmendSave(page, {
        timeoutMs: 120_000, signal: protectedSession.options.signal, prepareOnly: true,
        prepare: async bounded => {
          const state = await bounded(current(page, expected, nativeOptions(input, record)));
          const baseline = await bounded(snapshot(state.frame)), occupancy = savedChildOccupancy(baseline);
          const raw = occupancy.fields?.childages?.model;
          const save = state.frame.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
          if (!baseline || !occupancy.valid || !raw?.present || (occupancy.ages === null && raw.value !== '') ||
              (occupancy.ages !== null && !sameChildAgeMultiset(occupancy.ages, beforeAges)) ||
              await bounded(save.count()) !== 1) throw new Error('CHILD_PREIMAGE_UNVERIFIED');
          return { frame: state.frame, save, baseline, enableComposedStage: true, allowRealGuest: input.allowRealGuest === true,
            expected: { ...expected, childAges: beforeAges, reservationStayId: selected.reservationStayId,
              expectedGuarantee: state.expectedGuarantee },
            childStageGate: createSavedChildStageRequestGate({ propertyCode: selected.propertyCode, frame: state.frame, stayId: selected.reservationStayId,
              adults: expected.adults, priorAges: beforeAges, priorBands: occupancy.bands,
              readAges: occupancy.ages ?? [], readOnly: true, deadlineAt: performance.now() + 110_000 }) };
        },
        stage: async (bounded, prepared, context) => bounded(previewSavedChildrenForComposition(context, prepared.expected, ages)),
        validate: async (_bounded, _prepared, staged) => sameChildAgeMultiset(staged?.requested?.childAges, ages) &&
          sameChildAgeMultiset(staged?.before?.ages, beforeAges),
        matches: () => false,
        stageDetails: staged => ({ preview: staged }),
      });
      return result.issue === 'PREPARE_ONLY' && result.blockedRequests === 0 && result.preview
        ? { outcome: 'ok', ...result.preview }
        : { outcome: 'refused', issue: result.issue || 'CHILD_PREVIEW_UNVERIFIED' };
    }, { ...protectedSession.options, staging: true });
  } catch { return { outcome: 'refused', issue: 'CHILD_PREVIEW_UNVERIFIED' }; }
}

/** Search selected-stay party pickers without dispatching a selection callback or Save. */
export async function inspectCloudPaneAmendParties(input, { openSession = withCloudWriterSession,
  guard = installSavedStayReadGuard, shallow = readShallow, read = readRecord,
  current = currentLabtestRecord, snapshot = snapshotLabtestRecord } = {}) {
  const selected = input?.selected, queries = input?.queries;
  if (!validTarget(input?.target, input?.selected) || !selected || selected.confirmation !== input.confirmation ||
      selected.arrival !== input.arrival || !Array.isArray(queries) || !queries.length || queries.length > 3 ||
      queries.some(item => !item || !['organization', 'bookingAgency', 'arAccount'].includes(item.kind) ||
        typeof item.query !== 'string' || !item.query.trim() || item.query !== item.query.trim() ||
        item.query.length > 200 || /[\p{Cc}]/u.test(item.query)) ||
      new Set(queries.map(item => item.kind)).size !== queries.length) return { outcome: 'refused', issue: 'PARTY_INPUT_INVALID' };
  try {
    const protectedSession = guardedSession(input, guard);
    return await openSession(async page => {
      if (!protectedSession.hasGuard(page.context(), page)) return { outcome: 'refused', issue: 'BROWSER_CONTEXT_UNSAFE' };
      await shallow(page, input.confirmation, searchHints(selected, input.arrival));
      const record = await read(page, input.confirmation, { nativePropertyCode: input.selected.propertyCode });
      const expected = expectedLabtestAmendRecord(record, selected, {
        allowRealGuest: input.allowRealGuest === true,
        allowUnknownChildAges: true,
      });
      if (!expected) return { outcome: 'refused', issue: 'APPROVED_STAY_MISMATCH' };
      const result = await runLabtestAmendSave(page, {
        timeoutMs: 180_000, signal: protectedSession.options.signal, prepareOnly: true, partyStageActive: () => true,
        prepare: async bounded => {
          const state = await bounded(current(page, expected, nativeOptions(input, record)));
          const baseline = await bounded(snapshot(state.frame));
          const save = state.frame.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
          if (!baseline || !cleanLabtestRecord(baseline) || await bounded(save.count()) !== 1) {
            throw new Error('PARTY_PREIMAGE_UNVERIFIED');
          }
          return { frame: state.frame, save, baseline, enableComposedStage: true, allowRealGuest: input.allowRealGuest === true,
            partyStageGate: createSavedPartyStageRequestGate({ frame: state.frame, selected,
              deadlineAt: performance.now() + 170_000 }) };
        },
        stage: async (bounded, _prepared, context) => {
          const observations = [];
          for (const query of queries) observations.push(await bounded(inspectSavedPartyForComposition(context, query)));
          return observations;
        },
        validate: async (_bounded, _prepared, staged) => Array.isArray(staged) && staged.length === queries.length,
        matches: () => false,
        stageDetails: staged => ({ observations: staged }),
      });
      return result.issue === 'PREPARE_ONLY' && result.blockedRequests === 0 && Array.isArray(result.observations)
        ? { outcome: 'ok', observations: result.observations }
        : { outcome: 'refused', issue: result.issue || 'PARTY_READ_UNVERIFIED' };
    }, { ...protectedSession.options, staging: true });
  } catch { return { outcome: 'refused', issue: 'PARTY_READ_UNVERIFIED' }; }
}

/** Read the selected reservation's Track choices with Save permanently disarmed. */
export async function listCloudPaneAmendTrackChoices(input, { openSession = withCloudWriterSession,
  guard = installSavedStayReadGuard, shallow = readShallow, read = readRecord,
  current = currentLabtestRecord, snapshot = snapshotLabtestRecord } = {}) {
  const selected = input?.selected;
  if (!validTarget(input?.target, input?.selected) || !selected || selected.confirmation !== input.confirmation ||
      selected.arrival !== input.arrival || !amendTarget(selected, { retainRates: 'no', cmsSend: false, cmsMessageId: '', cmsRecipient: '' },
        { allowRealGuest: input.allowRealGuest === true })) {
    return { outcome: 'refused', issue: 'AMEND_INPUT_INVALID' };
  }
  try {
    const protectedSession = guardedSession(input, guard);
    return await openSession(async page => {
      if (!protectedSession.hasGuard(page.context(), page)) return { outcome: 'refused', issue: 'BROWSER_CONTEXT_UNSAFE' };
      await shallow(page, input.confirmation, searchHints(selected, input.arrival));
      const record = await read(page, input.confirmation, { nativePropertyCode: input.selected.propertyCode });
      const expected = expectedLabtestAmendRecord(record, selected, {
        allowRealGuest: input.allowRealGuest === true,
        allowUnknownChildAges: true,
      });
      if (!expected) return { outcome: 'refused', issue: 'APPROVED_STAY_MISMATCH' };
      const result = await runLabtestAmendSave(page, {
        timeoutMs: 120_000, signal: protectedSession.options.signal, prepareOnly: true,
        prepare: async bounded => {
          const state = await bounded(current(page, expected, nativeOptions(input, record)));
          const baseline = await bounded(snapshot(state.frame));
          const save = state.frame.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
          if (!baseline || await bounded(save.count()) !== 1 ||
              await bounded(state.frame.locator('.x-window:visible:not(.x-menu)').count()) !== 0) throw new Error('AMEND_CONTROL_NOT_UNIQUE');
          return { frame: state.frame, save, baseline, enableComposedStage: true, allowRealGuest: input.allowRealGuest === true,
            rateStageGate: createSavedRateStageRequestGate({ frame: state.frame, selected, deadlineAt: performance.now() + 120_000 }) };
        },
        stage: async (bounded, _prepared, context) => bounded(listSavedTrackChoices(context)),
        validate: async (_bounded, _prepared, staged) => staged?.coverage?.complete === true &&
          staged.coverage.nativeResponseCorrelated === true && Array.isArray(staged.candidates),
        matches: () => false,
        stageDetails: staged => ({ candidates: staged?.candidates, coverage: staged?.coverage }),
      });
      return result.issue === 'PREPARE_ONLY' && result.coverage?.complete === true && result.blockedRequests === 0
        ? { outcome: 'ok', candidates: result.candidates, coverage: result.coverage }
        : { outcome: 'refused', issue: result.issue || 'TRACK_CHOICES_UNVERIFIED' };
    }, { ...protectedSession.options, staging: true });
  } catch { return { outcome: 'refused', issue: 'TRACK_CHOICES_UNVERIFIED' }; }
}

/** Synchronize only the native response's verified local form values; this performs no request. */
export async function syncAmendRecordAfterAvailability(frame, before, bounded) {
  const synced = await bounded(frame.evaluate(({ before }) => {
    const visible = (el) => (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window');
    const guests = [...document.querySelectorAll('input[name=guestid]')].filter(visible);
    const panel = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
    const record = panel?.getRecord?.(), form = panel?.getForm?.();
    if (!record?.data || typeof panel.updateRecord !== 'function' || !form?.getValues ||
        ['propertycode', 'confirmationnumber', 'guestid', 'reservationstayid', 'reservationid'].some((key) =>
          String(record.data[key] ?? '') !== String(before.data[key] ?? ''))) return false;
    panel.updateRecord(record);
    return true;
  }, { before }));
  if (!synced) throw new Error('AMEND_DRAFT_CHANGED');
}

/** Bind the native tax-read parameters without making its request or changing the draft. */
export async function nativeAmendTaxReadValues(frame, before, approvedCurrency, bounded) {
  if (typeof frame?.evaluate !== 'function' || !/^[A-Z]{3}$/.test(approvedCurrency || '')) return null;
  const result = await bounded(frame.evaluate(({ before, approvedCurrency }) => {
    const visible = el => (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window');
    const guests = [...document.querySelectorAll('input[name=guestid]')].filter(visible);
    const panel = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
    const record = panel?.getRecord?.();
    if (!record?.data || typeof panel?.getFldValue !== 'function' || typeof globalThis.EAM?.Date?.standardFormat !== 'function' ||
        ['propertycode', 'confirmationnumber', 'guestid', 'reservationstayid', 'reservationid', 'arrivaldate', 'departuredate']
          .some((key) => String(record.data[key] ?? '') !== String(before.data[key] ?? '')) ||
        record.data.propertycode !== before.data.propertycode || panel.getFldValue('currency') !== approvedCurrency) return null;
    return { reservationstayid: String(record.data.reservationstayid), propertycode: String(record.data.propertycode),
      arrivaldate: globalThis.EAM.Date.standardFormat(panel.getFldValue('arrivaldate')),
      departuredate: globalThis.EAM.Date.standardFormat(panel.getFldValue('departuredate')), currency: approvedCurrency };
  }, { before, approvedCurrency }));
  if (!result || result.reservationstayid !== String(before.data.reservationstayid) ||
      result.arrivaldate !== `${before.data.arrivaldate} 00:00` || result.departuredate !== `${before.data.departuredate} 00:00` ||
      result.currency !== approvedCurrency || result.propertycode !== before.data.propertycode ||
      !getPropertyRegistration(result.propertycode)?.active) return null;
  return Object.freeze(result);
}

/** A response can arrive before Ext applies it. Wait for the native price controls, then take a full snapshot. */
export async function settleAmendAvailability(frame, response, bounded) {
  const native = response?.pageData?.values;
  if (!native || nativeMoneyCents(native.grandtotal) === null) throw new Error('AMEND_RATE_UNVERIFIED');
  await bounded(frame.waitForFunction((amount) => {
    const guests = [...document.querySelectorAll('input[name=guestid]')].filter((el) =>
      (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const panel = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
    const values = panel?.getForm?.()?.getValues?.();
    return Boolean(values && typeof values.grandtotal === 'string' && values.grandtotal.trim() !== '' &&
      Number(values.grandtotal.replaceAll(',', '')) === Number(amount));
  }, native.grandtotal, { timeout: 10_000 }));
}

/** Only the owning, closed browser and an independent positive read can confirm a candidate. */
export function confirmedCloudAmendResult(saved, fresh, writerSessionClosed) {
  if (saved?.outcome !== 'awaiting_readback' || saved.dispatchCallbacksDrained !== true ||
      writerSessionClosed !== true || fresh?.outcome !== 'matched' || !fresh.readback) {
    return { outcome: 'uncertain', issue: 'AMEND_READBACK_UNVERIFIED' };
  }
  return { outcome: 'amended', dispatchCallbacksDrained: true, writerSessionClosed: true,
    businessFieldsMatched: true, readback: fresh.readback };
}

/** The saved-stay control may have text instead of a tooltip; ambiguity refuses. */
export async function clickLabtestAmendAvailability(frame, bounded) {
  const text = frame.locator('.x-btn:visible').filter({ hasText: /^\s*Check Availability\s*$/i });
  const tip = frame.locator('[data-qtip="Check Availability"]:visible');
  const button = text.or(tip);
  if (await bounded(button.count()) !== 1 || !(await bounded(button.isEnabled()))) {
    throw new Error('AMEND_CONTROL_NOT_UNIQUE');
  }
  await bounded(button.click({ timeout: 5_000, noWaitAfter: true }));
}

const nativePriceComponents = ['grandtotal', 'averagenightly', 'averagerate', 'totalrate', 'totalratewithtax',
  'enhancedexptotal', 'guesttotal', 'guesttax', 'guesttotalwithtax', 'tax', 'totalresortfee', 'ratetax'];

/** Current HMS totals and the independently read rate option shown to staff. */
function observedAmendPrice(snapshot, target, quote, { includeComponents = false } = {}) {
  const data = snapshot?.data ?? {}, values = snapshot?.values ?? {};
  const currency = values.grandtotalcurr || data.grandtotalcurr || values.currency || data.currency;
  const totalCents = nativeMoneyCents(values.grandtotal ?? data.grandtotal);
  const averageCents = nativeAverageCents(values.averagenightly ?? data.averagenightly);
  if (!/^[A-Z]{3}$/.test(currency || '') || totalCents === null) return null;
  const options = Array.isArray(quote?.options) ? quote.options : quote && quote.currency && Array.isArray(quote.nightly) ? [{
    roomType: target.roomType, ratePlan: target.ratePlan, currency: quote.currency,
    nightly: quote.nightly.map(({ date, quoteCents }) => ({ date, amountCents: quoteCents })),
  }] : [];
  const components = {};
  if (includeComponents) for (const name of nativePriceComponents) {
    const seen = [data, values].filter(source => Object.hasOwn(source, name) && String(source[name] ?? '').trim() !== '')
      .map(source => nativeMoneyTenThousandths(source[name]));
    if (seen.some(value => value === null) || (seen.length > 1 && seen.some(value => value !== seen[0]))) return null;
    if (seen.length) components[name] = seen[0];
  }
  return { version: 2, currency, totalCents, averageCents, options, ...(includeComponents ? { componentsTenThousandths: components } : {}) };
}

function observedAmendMealPlan(snapshot) {
  const data = snapshot?.data, values = snapshot?.values;
  if (!data || !values || typeof data !== 'object' || typeof values !== 'object') return null;
  const modelKeys = Object.keys(data).filter(name => name.toLowerCase() === 'mealplan');
  const formKeys = Object.keys(values).filter(name => name.toLowerCase() === 'mealplan');
  // Exact mealplan only: missing, case-variants, or duplicates stay unknown.
  if (modelKeys.length !== 1 || formKeys.length !== 1 || modelKeys[0] !== 'mealplan' || formKeys[0] !== 'mealplan' ||
      !Object.hasOwn(data, 'mealplan') || !Object.hasOwn(values, 'mealplan')) return null;
  const model = data.mealplan, form = values.mealplan;
  if (typeof model !== 'string' || model !== form || model.length > 120 || /[\p{Cc}]/u.test(model)) return null;
  // Explicit blank is observed only when both native sides are exactly "".
  if (model === '') return model;
  return model.trim() ? model : null;
}

function assertAmendPriceFields(entries, approved) {
  for (const [name, expected, parse] of [
    ['currency', approved.currency, (value) => value],
    ['grandtotalcurr', approved.currency, (value) => value],
    ['averagenightlycurr', approved.currency, (value) => value],
    ['grandtotal', approved.totalCents, nativeMoneyCents],
    ['averagenightly', approved.averageCents, nativeAverageCents],
  ]) {
    const fields = entries.filter(([key]) => key.toLowerCase() === name);
    if (fields.length > 1 || (fields.length === 1 && fields[0][0] !== name)) throw new Error('AMEND_PRICE_UNVERIFIED');
    const raw = fields[0]?.[1];
    if (raw === null || raw === undefined || String(raw).trim() === '') continue;
    const actual = parse(raw);
    if (actual === null) throw new Error('AMEND_PRICE_UNVERIFIED');
    if (actual !== expected) throw new Error('AMEND_PRICE_CHANGED');
  }
}

/** Compare native minor-unit observations, never a calculated extension total. */
function assertApprovedAmendPrice(snapshot, target, approved, { requireAverage = true } = {}) {
  const observed = observedAmendPrice(snapshot, target, null, { includeComponents: Boolean(approved?.componentsTenThousandths) });
  if (!observed || approved?.version !== 2 || !/^[A-Z]{3}$/.test(approved.currency || '') ||
      !/^(?:0|[1-9]\d{0,13})$/.test(approved.totalCents || '') ||
      (approved.averageCents !== null && !/^(?:0|[1-9]\d{0,13})$/.test(approved.averageCents || '')) ||
      (requireAverage && (observed.averageCents === null || approved.averageCents === null))) {
    throw new Error('AMEND_PRICE_UNVERIFIED');
  }
  if (observed.currency !== approved.currency || observed.totalCents !== approved.totalCents ||
      observed.averageCents !== approved.averageCents || (approved.componentsTenThousandths &&
        (nativePriceDigest(observed.componentsTenThousandths) !== nativePriceDigest(approved.componentsTenThousandths) ||
          Object.keys(approved.componentsTenThousandths).some(name => !nativePriceComponents.includes(name))))) throw new Error('AMEND_PRICE_CHANGED');
  assertAmendPriceFields(Object.entries(snapshot?.data ?? {}), approved);
  assertAmendPriceFields(Object.entries(snapshot?.values ?? {}), approved);
}

/** Compose one staged amendment. Preview cannot arm Save; Go uses the same business checks. */
export function cloudPaneAmendRunOptions({ page, input, expected, authorization, captureBefore = () => {}, prepareOnly = false,
  callbackAuthority = null, authorizeCallbackSave = null, registerFinalChecks = () => {}, onCallbackTask = () => {} }, {
  current = currentLabtestRecord, snapshot = snapshotLabtestRecord, bind = labtestCombinedAmendPreimageBinding,
  stageAdults = stageSavedAdultForComposition, stageDates = stageSavedDatesForComposition,
  stageChildren = stageSavedChildrenForComposition, stageOption = stageSavedRoomRateForComposition,
  stageGuest = stageSavedGuestFieldsForComposition, stageCharge = stageSavedChargeRoomForComposition,
  syncRecord = syncAmendRecordAfterAvailability,
  quote = readAmendNightlyQuote, readRates = readSavedStayNightlyRates, recordOptions = amendRecordOptions,
} = {}) {
  const readSnapshot = snapshot;
  snapshot = async (frame) => {
    const draft = await readSnapshot(frame);
    if (!draft) return draft;
    const cmsSendControl = await frame.evaluate(() => {
      const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) &&
        getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
      const guests = [...document.querySelectorAll('input[name="guestid"]')].filter(visible);
      const controls = [...document.querySelectorAll('input[name="udfchkbox04"]')].filter(visible);
      if (guests.length !== 1 || controls.length !== 1) return null;
      const panel = globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form');
      const control = globalThis.Ext?.getCmp?.(controls[0].id.replace(/-inputEl$/, ''));
      if (!panel?.el?.dom?.contains(controls[0]) || control?.up?.('form') !== panel) return null;
      const value = control?.getValue?.();
      return typeof value === 'boolean' ? value : null;
    });
    let guestOptInControl = null;
    if (input.captureGuestOptInBaseline) guestOptInControl = await frame.evaluate(() => {
      const controls = [...document.querySelectorAll('input[name=guestoptin4]')].filter(el =>
        (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
      if (controls.length !== 1) return null;
      const value = globalThis.Ext?.getCmp?.(controls[0].id.replace(/-inputEl$/, ''))?.getValue?.();
      return typeof value === 'boolean' ? value : null;
    });
    return { ...draft, cmsSendControl, ...(input.captureGuestOptInBaseline ? { guestOptInControl } : {}) };
  };
  const { signal, credentialLease, ...businessInput } = input ?? {};
  input = { ...structuredClone(businessInput), signal, credentialLease };
  const selected = input?.selected, changes = input?.changes;
  const nativeReal = input.allowRealGuest === true || (input.allowChangedLabGuarantee === true &&
    isLabtest(selected) && selected.arrival >= '2027-01-01');
  const callbackReviewOnly = isFirstGoCallbackAuthority(callbackAuthority);
  const callbackFinal = isFinalGoCallbackAuthority(callbackAuthority);
  const callbackMode = callbackReviewOnly || callbackFinal;
  const bindingChanges = callbackMode ? input?.callbackBindingChanges : changes;
  if (callbackMode && (!input?.callbackPlan || !bindingChanges || prepareOnly ||
      !callbackAuthority.matchesPlan(input.callbackPlan))) throw new Error('CALLBACK_PLAN_UNVERIFIED');
  if (callbackFinal && typeof authorizeCallbackSave !== 'function') throw new Error('CALLBACK_SAVE_AUTHORITY_REQUIRED');
  if (input?.childAgePreimage !== undefined && (!Array.isArray(input.childAgePreimage) ||
      input.childAgePreimage.length !== selected?.children || input.childAgePreimage.some(age => !Number.isInteger(age) || age < 0 || age > 17))) {
    throw new Error('CHILD_PREIMAGE_INVALID');
  }
  const target = amendTarget(selected, changes, { allowRealGuest: input.allowRealGuest === true });
  if ((input.guaranteeChoiceCode !== undefined &&
      (typeof input.guaranteeChoiceCode !== 'string' || !/^[A-Z0-9]{1,20}$/.test(input.guaranteeChoiceCode) ||
        (input.discoveryOnly !== true && input.guaranteeChoiceCode !== changes?.guaranteeType))) ||
      (Object.hasOwn(changes ?? {}, 'guaranteeType') && input.guaranteeChoiceCode !== changes.guaranteeType)) {
    throw new Error('GUARANTEE_CHOICE_UNVERIFIED');
  }
  if (!page || !expected || !validTarget(input?.target, input?.selected) || !target || selected.confirmation !== input.confirmation ||
      selected.arrival !== input.arrival || (!prepareOnly && (!/^[a-f0-9]{64}$/.test(input.nativeDigest || '') ||
        !authorization || !input.preserved))) throw new Error('AMEND_CHOICE_UNSUPPORTED');
  if (changes.retainRates === 'yes' && (target.departure <= selected.arrival || target.arrival >= selected.departure)) {
    throw new Error('AMEND_PRICE_UNVERIFIED');
  }
  const proposed = Object.fromEntries(['arrival', 'departure', 'adults'].filter((key) =>
    Object.hasOwn(changes, key) && changes[key] !== selected[key]).map((key) => [key, changes[key]]));
  const dateChanged = Object.hasOwn(proposed, 'arrival') || Object.hasOwn(proposed, 'departure');
  const childChanged = Object.hasOwn(changes, 'children') && (changes.children !== selected.children ||
    !sameChildAgeMultiset(changes.childAges, input.childAgePreimage ?? selected.childAges));
  // The native child validation callback may persist before Save. Keep it fenced
  // until explicit Go authorization and partial-effect recovery cover that callback.
  if (childChanged && !callbackMode) throw new Error('CHILD_AGE_GO_AUTHORIZATION_REQUIRED');
  const roomChanged = target.roomType !== selected.roomType, rateChanged = target.ratePlan !== selected.ratePlan;
  const chargeChanged = Object.hasOwn(changes, 'roomTypeForCharge'), trackChanged = Object.hasOwn(changes, 'track');
  const needsAvailability = callbackMode || dateChanged || Object.hasOwn(proposed, 'adults') || childChanged || roomChanged || rateChanged || chargeChanged;
  // The retained baseline is not the final price when availability changes.
  if (changes.retainRates === 'yes' && needsAvailability) throw new Error('AMEND_PRICE_UNVERIFIED');
  const allowsExtendOverrideRate = changes.retainRates === 'yes' &&
    (target.arrival < selected.arrival || target.departure > selected.departure);
  let dispatch = null;
  let firstSnapshot = null, questionSnapshot = null, extendSnapshot = null;
  let preparedState = null, nativeDigest = null, preserved = null, quoted = null, stopOperation = null;
  let rateScope = null, operationBounded = null, callbackEffects = null;
  const rateTarget = { propertyCode: selected.propertyCode, confirmation: selected.confirmation, nativeStayId: selected.reservationStayId,
    arrival: selected.arrival, departure: selected.departure };
  const readSavedBasis = (state, bounded, requestScope = null) => readRates(page, state, rateTarget,
    { mode: 'saved_direct', requestScope, bounded });
  const assertSavedBasis = async (prepared) => {
    if (changes.retainRates !== 'yes') return;
    if (!rateScope || !operationBounded) throw new Error('AMEND_PRICE_UNVERIFIED');
    const rates = await readSavedBasis(prepared.state, operationBounded, rateScope);
    if (!rates || rates.digest !== prepared.savedRateDigest) throw new Error('AMEND_PRICE_CHANGED');
  };
  // Keep approves the existing saved basis plus the immutable rate instruction.
  // Availability can display a different proposed total; it is not an extension quote.
  const approvalPrice = (draft, prepared) => {
    const source = changes.retainRates === 'yes' ? prepared.baseline : draft;
    const price = observedAmendPrice(source, target, quoted, { includeComponents: input.capturePriceComponents === true });
    try {
      assertApprovedAmendPrice(source, target, price, { requireAverage: changes.retainRates === 'no' });
      return price;
    } catch { return null; }
  };
  const checkPrice = (draft, prepared, request) => {
    if (changes.retainRates === 'yes') {
      assertApprovedAmendPrice(prepared.baseline, selected, input.approvedPrices, { requireAverage: false });
    } else {
      assertApprovedAmendPrice(draft, target, input.approvedPrices);
      if (request) {
        // Native Save can omit display-only prices or send them blank. The
        // fresh native snapshot is required; compare any submitted price too.
        assertAmendPriceFields([...new URLSearchParams(request.postData() || '')], input.approvedPrices);
      }
    }
  };
  const checkMealPlan = (draft, request) => {
    if (!input.captureMealPlan || prepareOnly) return;
    if (typeof input.approvedMealPlan !== 'string' || observedAmendMealPlan(draft) !== input.approvedMealPlan) {
      throw new Error('AMEND_MEAL_PLAN_CHANGED');
    }
    if (request) {
      const entries = [...new URLSearchParams(request.postData() || '')].filter(([name]) => name.toLowerCase() === 'mealplan');
      if (entries.length > 1 || (entries.length === 1 &&
          (entries[0][0] !== 'mealplan' || entries[0][1] !== input.approvedMealPlan))) throw new Error('AMEND_MEAL_PLAN_CHANGED');
    }
  };
  const effectiveCmsChanges = (prepared) => input.discoveryOnly === true ? { ...changes,
    cmsMessageId: String(prepared.baseline.data.udfchar09 ?? ''), cmsRecipient: String(prepared.baseline.data.udfchar13 ?? '') } : changes;
  const valid = (value, prepared) => matchesAmendBusiness(value, selected, effectiveCmsChanges(prepared), prepared.baseline, prepared.state) &&
    (input.expectedFinalCommission === undefined || (typeof input.expectedFinalCommission === 'number' &&
      Number.isFinite(input.expectedFinalCommission) && input.expectedFinalCommission >= 0 && input.expectedFinalCommission <= 100 &&
      percent(value.data?.ta1commission) === input.expectedFinalCommission &&
      percent(value.values?.ta1commission) === input.expectedFinalCommission));
  const saveOptions = (prepared, phase) => ({ selected, changes, beforeNote: expected.note,
    beforeParties: prepared.state.partyPreimage, guaranteeCode: prepared.state.expectedGuarantee?.code ?? 'NGI',
    verifiedChildAges: prepared.state.verifiedChildAges,
    allowRealGuest: nativeReal, baseline: prepared.baseline, phase });
  const dispatchSave = async (phase, request, proceed) => {
    const check = async () => {
      if (!preparedState) throw new Error('AMEND_DRAFT_CHANGED');
      await assertSavedBasis(preparedState);
      const latest = await snapshot(preparedState.frame);
      if (!valid(latest, preparedState) || !matchesCloudPaneAmendSave(request, preparedState.frame, latest,
        saveOptions(preparedState, phase))) throw new Error('AMEND_DRAFT_CHANGED');
      checkPrice(latest, preparedState, request);
      checkMealPlan(latest, request);
    };
    try {
      await check();
      return await dispatch[phase](request, async () => {
        // First authorization may await a transaction. Recheck on its far side
        // while the route's deadline/one-shot continuation fence still owns Save.
        await check();
        return proceed();
      });
    } catch (error) {
      dispatch.close();
      // A refused paused request has no response to wait for. Stop the owned
      // lifecycle now; its existing possible-effect flag still retains UNKNOWN.
      stopOperation?.(/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'AMEND_UNVERIFIED');
      throw error;
    }
  };
  if (callbackFinal) registerFinalChecks({
    verifyFinal: (latest, prepared) => {
      if (!valid(latest, prepared)) return false;
      try { checkPrice(latest, prepared); checkMealPlan(latest); return true; } catch { return false; }
    },
    verifyDispatch: async (phase, request) => {
      if (!preparedState) return false;
      await assertSavedBasis(preparedState);
      const latest = await snapshot(preparedState.frame);
      if (!valid(latest, preparedState) || !matchesCloudPaneAmendSave(request, preparedState.frame, latest,
        saveOptions(preparedState, phase))) return false;
      checkPrice(latest, preparedState, request);
      checkMealPlan(latest, request);
      return true;
    },
  });
  const availability = needsAvailability ? {
    recipient: '', guestEmail: '', cmsSend: changes.cmsSend, cmsMessageId: '', allowRealGuest: nativeReal,
    expected: null,
    snapshot: async (bounded, prepared) => {
      const before = await bounded(snapshot(prepared.frame));
      if (!valid(before, prepared)) throw new Error('AMEND_DRAFT_CHANGED');
      availability.recipient = String(before.data.udfchar13 ?? '');
      availability.guestEmail = String(before.data.emailaddress ?? '');
      availability.cmsMessageId = changes.cmsSend ? changes.cmsMessageId : '';
      availability.expected = { ...target, guaranteeCode: prepared.state.expectedGuarantee?.code ?? 'NGI' };
      const currency = before.values.currency || before.data.currency || before.values.grandtotalcurr || before.data.grandtotalcurr;
      prepared.taxMetadataReadValues = await nativeAmendTaxReadValues(prepared.frame, before, currency, bounded);
      return before;
    },
    click: (bounded, prepared) => clickLabtestAmendAvailability(prepared.frame, bounded),
    dispatchCandidate: callbackMode ? callbackAuthority.dispatchAvailability :
      (request, proceed) => prepareOnly ? proceed() : dispatch.availability(request, proceed),
    validate: async (bounded, prepared, staged, response) => {
      const body = parseNativePricingJson(await bounded(response.text()));
      if (body?.pageData?.success === false) return { ok: false, issue: 'AVAILABILITY_UNVERIFIED' };
      await settleAmendAvailability(prepared.frame, body, bounded);
      const refreshed = await bounded(snapshot(prepared.frame));
      await syncRecord(prepared.frame, refreshed, bounded);
      const after = await bounded(snapshot(prepared.frame));
      if (!valid(after, prepared)) return { ok: false, issue: 'AMEND_DRAFT_CHANGED' };
      checkMealPlan(after);
      staged.draft = after;
      staged.approvedPrices = approvalPrice(after, prepared);
      if (callbackReviewOnly && staged.approvedPrices) {
        if (!callbackAuthority.complete() || typeof input.afterScreenshot !== 'string') return { ok: false, issue: 'CALLBACK_REPRICE_UNVERIFIED' };
        await bounded(page.screenshot({ path: input.afterScreenshot }));
      }
      return staged.approvedPrices ? true : { ok: false, issue: 'AMEND_RATE_UNVERIFIED' };
    },
  } : undefined;
  return {
    timeoutMs: 7 * 60_000, signal: input.signal, prepareOnly, callbackReviewOnly,
    ...(callbackMode ? { callbackAuthority, dispatchChildCandidate: callbackAuthority.dispatchChildren,
      partyStageActive: () => true } : {}), reportDispatchDrain: !prepareOnly,
    dispatchDrainTimeoutMs: 5_000, reportBlockedTargets: input.reportBlockedTargets === true,
    prepare: async (bounded) => {
      const state = await bounded(current(page, expected, recordOptions));
      if (Array.isArray(input.childAgePreimage)) state.verifiedChildAges = [...input.childAgePreimage];
      const baseline = await bounded(snapshot(state.frame));
      if (input.captureMealPlan && !prepareOnly && (typeof input.approvedBeforeMealPlan !== 'string' ||
          observedAmendMealPlan(baseline) !== input.approvedBeforeMealPlan)) throw new Error('AMEND_MEAL_PREIMAGE_CHANGED');
      if (callbackFinal && (!input.approvedBusinessImage || !portableBusinessImage(baseline) ||
          nativePriceDigest(portableBusinessImage(baseline)) !== nativePriceDigest(input.approvedBusinessImage))) {
        throw new Error('AMEND_CALLBACK_PREIMAGE_CHANGED');
      }
      const bound = bind(expected, state, baseline, bindingChanges);
      preserved = cloudAmendPreserved(state, baseline, bindingChanges);
      const savedRates = changes.retainRates === 'yes' ? await bounded(readSavedBasis(state, bounded)) : null;
      const savedPrice = changes.retainRates === 'yes' ? observedAmendPrice(baseline, selected, null) : null;
      if (changes.retainRates === 'yes' && (!savedRates || !/^[a-f0-9]{64}$/.test(savedRates.digest || '') ||
          !savedPrice || savedRates.currency !== savedPrice.currency || savedRates.totals?.totalCents !== savedPrice.totalCents)) {
        throw new Error('AMEND_PRICE_UNVERIFIED');
      }
      const digest = savedRates ? nativePriceDigest({ version: 1, preimageDigest: bound?.digest, savedRateDigest: savedRates.digest }) : bound?.digest;
      if (!bound?.digest || !preserved || state.native.reservationstayid !== selected.reservationStayId ||
          state.native.reservationid !== selected.reservationId || state.native.recordid !== selected.recordId ||
          // JSONB can reorder object keys; compare every preserved value canonically.
          (!prepareOnly && (digest !== input.nativeDigest || nativePriceDigest(preserved) !== nativePriceDigest(input.preserved)))) {
        throw new Error('AMEND_PREIMAGE_CHANGED');
      }
      nativeDigest = digest;
      const save = state.frame.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
      if (await bounded(save.count()) !== 1 || await bounded(state.frame.locator('.x-window:visible:not(.x-menu)').count()) !== 0) {
        throw new Error('AMEND_CONTROL_NOT_UNIQUE');
      }
      const beforeGuarantee = state.expectedGuarantee ?? { code: 'NGI', display: 'Non-Guaranteed Individual' };
      const guaranteeChanged = typeof changes.guaranteeType === 'string' && changes.guaranteeType !== beforeGuarantee.code;
      if (!prepareOnly && !callbackMode) dispatch = createLabtestAmendDispatch({ ...authorization,
        requiresAvailability: needsAvailability, requiresGuarantee: guaranteeChanged, allowsExtendOverrideRate });
      const guaranteeStageGate = !prepareOnly && (callbackMode ? Boolean(input.callbackPlan.guarantee) : guaranteeChanged)
        ? createSavedGuaranteeRequestGate({ frame: state.frame, isActive: () => !input.signal?.aborted,
          deadlineAt: performance.now() + 6 * 60_000 }) : null;
      const occupancy = savedChildOccupancy(baseline);
      const childStageGate = childChanged ? createSavedChildStageRequestGate({ propertyCode: selected.propertyCode, frame: state.frame,
        stayId: selected.reservationStayId, adults: callbackMode ? selected.adults : target.adults,
        priorAges: callbackMode ? input.childAgePreimage : occupancy.ages,
        readAges: occupancy.ages ?? [], priorBands: occupancy.bands, nextAges: changes.childAges,
        deadlineAt: performance.now() + 6 * 60_000 }) : null;
      const partyStageGate = callbackMode && input.callbackPlan.parties.length ? createSavedPartyStageRequestGate({
        frame: state.frame, selected, deadlineAt: performance.now() + 6 * 60_000 }) : null;
      const roomStageGate = roomChanged ? createSavedRoomStageRequestGate({ frame: state.frame, selected,
        deadlineAt: performance.now() + 6 * 60_000 }) : null;
      const rateStageGate = needsAvailability || trackChanged ? createSavedRateStageRequestGate({ frame: state.frame, selected,
        deadlineAt: performance.now() + 6 * 60_000 }) : null;
      const guaranteePrice = input.guaranteeChoiceCode ? observedAmendPrice(baseline, selected, null,
        { includeComponents: input.capturePriceComponents === true }) : null;
      if (input.guaranteeChoiceCode) {
        if (!guaranteePrice) throw new Error('AMEND_PRICE_UNVERIFIED');
        assertApprovedAmendPrice(baseline, selected, guaranteePrice, { requireAverage: false });
        if (!prepareOnly && !callbackMode) assertApprovedAmendPrice(baseline, selected, input.approvedBeforeGuaranteePrice, { requireAverage: false });
      }
      const recoveryBaseline = { beforeNote: expected.note, beforeParties: structuredClone(state.partyPreimage),
        ...(input.captureMealPlan ? { beforeMealPlan: observedAmendMealPlan(baseline) } : {}),
        beforeRecipient: preserved.cmsRecipient,
        beforeGuestEmail: preserved.guestEmail !== undefined ? preserved.guestEmail :
          typeof baseline?.data?.emailaddress === 'string' && typeof baseline?.values?.emailaddress === 'string' &&
            baseline.data.emailaddress === baseline.values.emailaddress ? baseline.data.emailaddress : null,
        beforeBookerName: typeof baseline?.data?.caller === 'string' && typeof baseline?.values?.caller === 'string' &&
          baseline.data.caller === baseline.values.caller ? baseline.data.caller : null,
        beforeBookerContact: typeof baseline?.data?.udfchar06 === 'string' && typeof baseline?.values?.udfchar06 === 'string' &&
          baseline.data.udfchar06 === baseline.values.udfchar06 ? baseline.data.udfchar06 : null,
        beforeBillingReference: typeof baseline?.data?.billingreference === 'string' &&
          baseline.data.billingreference === baseline?.values?.billingreference ? baseline.data.billingreference : null,
        beforeTrack: typeof baseline?.data?.track === 'string' && baseline.data.track === baseline?.values?.track ? baseline.data.track : null,
        ...(Array.isArray(input.childAgePreimage) ? { beforeChildAges: [...input.childAgePreimage] } : {}),
        ...(input.captureGuestOptInBaseline ? { beforeGuestOptIn:
          nativeCmsSendValue(baseline?.data?.guestoptin4) === baseline.guestOptInControl ? baseline.guestOptInControl : null } : {}),
        ...(input.captureCommissionBaseline ? { beforeCommission:
          percent(baseline?.data?.ta1commission) !== null && percent(baseline?.data?.ta1commission) === percent(baseline?.values?.ta1commission)
            ? percent(baseline.data.ta1commission) : null } : {}),
        beforeRoomTypeForCharge: typeof baseline?.data?.roomtypecharge === 'string' &&
          baseline.data.roomtypecharge === baseline?.values?.roomtypecharge ? baseline.data.roomtypecharge : null,
        beforeGuaranteeCode: beforeGuarantee.code,
        ...(input.guaranteeChoiceCode ? { beforeGuaranteeDisplay: beforeGuarantee.display, beforeGuaranteePrice: guaranteePrice } : {}),
        beforeSavedRates: savedRates ? structuredClone(savedRates) : null };
      if (input.captureGuestOptInBaseline && typeof recoveryBaseline.beforeGuestOptIn !== 'boolean') {
        throw new Error('GUEST_OPT_IN_PREIMAGE_UNVERIFIED');
      }
      const agencyPending = callbackMode && input.callbackPlan.parties.some(party => party.kind === 'bookingAgency');
      if (input.captureCommissionBaseline && !agencyPending && (recoveryBaseline.beforeCommission === null ||
          !/^\d{1,30}$/.test(state.partyPreimage?.taid1 || '') || !state.partyPreimage?.ta1?.trim())) {
        throw new Error('COMMISSION_AGENCY_OR_PREIMAGE_UNVERIFIED');
      }
      if (Object.hasOwn(changes, 'billingReference') && !(callbackMode &&
          input.callbackPlan.parties.some(party => party.kind === 'arAccount'))) {
        const party = state.partyPreimage;
        if (typeof recoveryBaseline.beforeBillingReference !== 'string' ||
            (changes.billingReference && (!party.araccountname?.trim() ||
              ![party.araccountid, party.arprofileid].some((id) => /^\d{1,30}$/.test(id || ''))))) {
          throw new Error('BILLING_REFERENCE_REQUIRES_VERIFIED_AR');
        }
      }
      if (prepareOnly && changes.retainRates !== 'yes') {
        try { quoted = await bounded(quote(Array.isArray(input.childAgePreimage)
          ? { ...input, selected: { ...input.selected, childAges: input.childAgePreimage } } : input, state)); } catch { quoted = null; }
      } else if (!prepareOnly) {
        if (changes.retainRates === 'yes') {
          assertApprovedAmendPrice(baseline, selected, input.approvedPrices, { requireAverage: false });
        }
        if (!input.beforeScreenshot || typeof authorization.sealBeforeEvidence !== 'function') throw new Error('AMEND_EVIDENCE_REQUIRED');
        await bounded(page.screenshot({ path: input.beforeScreenshot }));
        const evidence = await bounded(authorization.sealBeforeEvidence());
        if (!evidence || !/^[0-9a-f-]{36}$/i.test(evidence.eventId || '') || !/^[a-f0-9]{64}$/.test(evidence.sha256 || '')) {
          throw new Error('AMEND_EVIDENCE_REQUIRED');
        }
      captureBefore({ beforeNote: expected.note, beforeParties: structuredClone(state.partyPreimage),
          ...(input.captureMealPlan ? { beforeMealPlan: recoveryBaseline.beforeMealPlan } : {}),
          beforeRecipient: recoveryBaseline.beforeRecipient,
          beforeGuestEmail: recoveryBaseline.beforeGuestEmail,
          beforeBookerName: recoveryBaseline.beforeBookerName,
          beforeBookerContact: recoveryBaseline.beforeBookerContact,
          beforeBillingReference: recoveryBaseline.beforeBillingReference,
          beforeTrack: recoveryBaseline.beforeTrack,
          ...(Array.isArray(input.childAgePreimage) ? { beforeChildAges: recoveryBaseline.beforeChildAges } : {}),
          ...(input.captureCommissionBaseline ? { beforeCommission: recoveryBaseline.beforeCommission } : {}),
          ...(input.captureGuestOptInBaseline ? { beforeGuestOptIn: recoveryBaseline.beforeGuestOptIn } : {}),
          beforeRoomTypeForCharge: recoveryBaseline.beforeRoomTypeForCharge,
          beforeGuaranteeCode: recoveryBaseline.beforeGuaranteeCode,
          beforeSavedRates: savedRates ? structuredClone(savedRates) : null,
          beforeEvidence: { eventId: evidence.eventId, sha256: evidence.sha256 } });
      }
      if (callbackMode) assertApprovedAmendPrice(baseline, selected, input.approvedBeforeCallbackPrice, { requireAverage: false });
      preparedState = { frame: state.frame, state, baseline, save, childStageGate, roomStageGate, rateStageGate, guaranteeStageGate, partyStageGate,
        nativePartyBaseline: prepareOnly ? cloudAmendNativePartyBaseline(state, baseline) : null,
        savedRateDigest: savedRates?.digest ?? null, recoveryBaseline,
        enableComposedStage: true, allowRealGuest: nativeReal };
      return preparedState;
    },
    stage: async (bounded, prepared, context) => {
      stopOperation = context.stop;
      let draft = prepared.baseline;
      if (callbackMode) {
        const task = runCloudPaneAmendCallbacks({ context, ...input.callbackPlan }, callbackAuthority);
        onCallbackTask(task);
        const applied = await bounded(task);
        callbackEffects = applied.effects;
        if (applied.outcome !== 'applied' || !applied.snapshot ||
            (applied.partialEffect !== 'possible' && !(callbackFinal && applied.partialEffect === 'none'))) {
          throw new Error(applied.issue || 'CALLBACK_PHASE_UNVERIFIED');
        }
        draft = applied.snapshot;
        const updatedParties = Object.fromEntries(Object.keys(prepared.state.partyPreimage).map(key =>
          [key, String(Object.hasOwn(draft.data, key) ? draft.data[key] ?? '' : draft.values?.[key] ?? '')]));
        if (!unchangedLabtestBusinessParties(updatedParties, draft,
          { allowModelOnlyPrimaryPartyIds: true, allowRealGuest: nativeReal })) {
          throw new Error('CALLBACK_PARTY_READBACK_UNVERIFIED');
        }
        prepared.state.partyPreimage = updatedParties;
        if (input.captureCommissionBaseline && input.callbackPlan.parties.some(party => party.kind === 'bookingAgency')) {
          const observed = percent(draft.data?.ta1commission);
          if (observed === null || observed !== percent(draft.values?.ta1commission)) throw new Error('COMMISSION_PREIMAGE_UNVERIFIED');
          prepared.recoveryBaseline.beforeCommission = observed;
        }
        if (input.callbackPlan.guarantee) prepared.state.expectedGuarantee = {
          code: input.callbackPlan.guarantee.code, display: input.callbackPlan.guarantee.display };
        if (input.callbackPlan.children) prepared.state.verifiedChildAges = [...input.callbackPlan.children.nextAges];
      }
      if (input.guaranteeChoiceCode && !callbackMode) {
        const observation = await bounded(inspectSavedGuaranteeForComposition(context));
        const matches = observation.candidates.filter(item => item.code === input.guaranteeChoiceCode);
        const before = prepared.state.expectedGuarantee ?? { code: 'NGI', display: 'Non-Guaranteed Individual' };
        if (!observation.enabled || !observation.coverage?.complete || matches.length !== 1 ||
            observation.before.code !== before.code || observation.before.display !== before.display ||
            (!prepareOnly && (before.display !== input.approvedBeforeGuaranteeDisplay ||
              matches[0].label !== input.approvedGuaranteeDisplay))) throw new Error('GUARANTEE_CHOICE_UNVERIFIED');
        prepared.recoveryBaseline.requestedGuaranteeDisplay = matches[0].label;
        if (!prepareOnly && changes.guaranteeType !== before.code) {
          const result = await bounded(applySavedGuaranteeOnGo(context, {
            expected: { propertyCode: selected.propertyCode, confirmation: selected.confirmation, guestId: selected.guestId,
              reservationStayId: selected.reservationStayId, reservationId: selected.reservationId,
              recordId: selected.recordId, firstName: selected.firstName, lastName: selected.lastName,
              arrival: selected.arrival, departure: selected.departure,
              guaranteeCode: before.code, guaranteeDisplay: before.display },
            code: changes.guaranteeType, display: matches[0].label,
          }, { authorizeCandidate: async () => true,
            dispatchCandidate: (request, proceed) => dispatch.guarantee(request, proceed) }));
          if (result.outcome !== 'applied' || !result.snapshot) throw new Error(result.issue || 'GUARANTEE_RESULT_UNVERIFIED');
          Object.assign(context.baseline, structuredClone(result.snapshot));
          prepared.state.expectedGuarantee = { code: changes.guaranteeType, display: matches[0].label };
          draft = result.snapshot;
        }
      }
      if (Object.hasOwn(proposed, 'adults')) draft = (await bounded(stageAdults(context, expected, proposed.adults))).snapshot;
      if (dateChanged) draft = await bounded(stageDates(context, expected, proposed, draft === prepared.baseline ? null : draft));
      if (childChanged && !callbackMode) draft = await bounded(stageChildren(context, { ...expected,
        reservationStayId: selected.reservationStayId, adults: target.adults }, changes.childAges));
      // Picker refreshes are unsaved; keep HMS mail off until the final requested
      // form is staged so an intermediate native action cannot send a message.
      if ((roomChanged || chargeChanged || trackChanged || String(draft.data?.rateplan ?? selected.ratePlan) !== target.ratePlan) && prepared.state.cmsSend === true) {
        draft = await bounded(stageGuest(context, { cmsSend: false }));
      }
      if (roomChanged) {
        draft = await bounded(stageOption(context, 'roomType', selected.roomType, target.roomType));
        prepared.roomStageGate.close();
      }
      if (chargeChanged) draft = await bounded(stageCharge(context, changes.roomTypeForCharge));
      if (trackChanged) draft = await bounded(stageSavedTrackForComposition(context, changes.track));
      const currentRate = String(draft.data?.rateplan ?? selected.ratePlan);
      if (currentRate !== target.ratePlan) {
        draft = await bounded(stageOption(context, 'ratePlan', currentRate, target.ratePlan));
      }
      const fields = Object.fromEntries(['firstName', 'lastName', 'guestEmail', 'bookerName', 'bookerContact', 'reservationNote', 'billingReference']
        .filter((key) => Object.hasOwn(changes, key)).map((key) => [key, changes[key]]));
      fields.cmsSend = changes.cmsSend;
      if (Object.hasOwn(changes, 'guestOptIn')) fields.guestOptIn = changes.guestOptIn;
      if (input.discoveryOnly !== true) {
        if (changes.cmsMessageId !== String(prepared.baseline.data.udfchar09 ?? '')) fields.cmsMessageId = changes.cmsMessageId;
        if (changes.cmsRecipient !== String(prepared.baseline.data.udfchar13 ?? '')) fields.cmsRecipient = changes.cmsRecipient;
      }
      draft = await bounded(stageGuest(context, fields));
      if (Object.hasOwn(changes, 'taCommission')) {
        draft = await bounded(stageSavedStayCommission(context, { expectedAgencyId: prepared.state.partyPreimage.taid1,
          percent: changes.taCommission }));
      }
      draft = await bounded(snapshot(prepared.frame));
      if (!context.isActive() || !valid(draft, prepared)) throw new Error('AMEND_DRAFT_CHANGED');
      if (!needsAvailability) checkMealPlan(draft);
      return { draft, approvedPrices: needsAvailability ? null : approvalPrice(draft, prepared) };
    },
    validate: async (_bounded, prepared, staged) => Boolean(staged?.draft && valid(staged.draft, prepared) &&
      (needsAvailability || staged.approvedPrices)),
    stageDetails: (staged) => ({ nativeDigest, preserved, approvedPrices: staged?.approvedPrices ?? null,
      ...(input.captureMealPlan ? { applied: { mealPlan: observedAmendMealPlan(staged?.draft) } } : {}),
      ...(callbackMode ? { callbackEffects } : {}),
      ...(callbackFinal ? { finalParties: preparedState?.state?.partyPreimage ?? null,
        finalBeforeCommission: preparedState?.recoveryBaseline?.beforeCommission ?? null } : {}),
      ...(prepareOnly && input.captureBusinessImage ? { sourceBusinessImage: portableBusinessImage(preparedState?.baseline) } : {}),
      ...(prepareOnly ? { recoveryBaseline: preparedState?.recoveryBaseline ?? null,
        nativePartyBaseline: preparedState?.nativePartyBaseline ?? null } : {}) }),
    ...(availability ? { availability } : {}),
    beforeSave: async (bounded, prepared, staged, scope) => {
      rateScope = scope;
      operationBounded = bounded;
      await assertSavedBasis(prepared);
      const latest = await bounded(snapshot(prepared.frame));
      if (!valid(latest, prepared)) throw new Error('AMEND_DRAFT_CHANGED');
      await syncRecord(prepared.frame, latest, bounded);
      firstSnapshot = await bounded(snapshot(prepared.frame));
      if (!valid(firstSnapshot, prepared)) throw new Error('AMEND_DRAFT_CHANGED');
      checkPrice(firstSnapshot, prepared);
      checkMealPlan(firstSnapshot);
      if (callbackFinal) authorizeCallbackSave(firstSnapshot, prepared);
      staged.draft = firstSnapshot;
    },
    matches: (request, frame, prepared) => firstSnapshot !== null &&
      matchesCloudPaneAmendSave(request, frame, firstSnapshot, saveOptions(prepared, 'save')),
    dispatchCandidate: callbackFinal ? callbackAuthority.dispatchSave : (request, proceed) => dispatchSave('save', request, proceed),
    ...(!prepareOnly && !callbackReviewOnly ? { retainRate: {
      choice: changes.retainRates,
      snapshot: async (bounded, prepared) => {
        questionSnapshot = await bounded(snapshot(prepared.frame));
        if (!valid(questionSnapshot, prepared)) throw new Error('AMEND_DRAFT_CHANGED');
        checkPrice(questionSnapshot, prepared);
        checkMealPlan(questionSnapshot);
        return questionSnapshot;
      },
      matches: (request, frame, prepared, _staged, observed) =>
        matchesCloudPaneAmendSave(request, frame, observed, saveOptions(prepared, 'retain')),
      dispatchCandidate: callbackFinal ? callbackAuthority.dispatchRetain : (request, proceed) => dispatchSave('retain', request, proceed),
    } } : {}),
    ...(!prepareOnly && !callbackReviewOnly && allowsExtendOverrideRate ? { extendRate: {
      snapshot: async (bounded, prepared) => {
        extendSnapshot = await bounded(snapshot(prepared.frame));
        if (!valid(extendSnapshot, prepared)) throw new Error('AMEND_DRAFT_CHANGED');
        checkPrice(extendSnapshot, prepared);
        checkMealPlan(extendSnapshot);
        return extendSnapshot;
      },
      matches: (request, frame, prepared, _staged, observed) =>
        matchesCloudPaneAmendSave(request, frame, observed, saveOptions(prepared, 'extend')),
      dispatchCandidate: (request, proceed) => dispatchSave('extend', request, proceed),
    } } : {}),
  };
}

/** Bind the durable claim and every continuation to the owned Cloud writer. */
export function bindCloudAmendWriter(page, authorization) {
  const writer = cloudWriterIdentity(page);
  if (typeof authorization?.authorizeFirst !== 'function' || !writer || !cloudWriterCurrent(writer)) {
    throw new Error('AMEND_AUTHORITY_INVALID');
  }
  const current = () => cloudWriterCurrent(writer) && (authorization.isEnabled?.() ?? true);
  return Object.freeze({ ...authorization, isEnabled: current,
    authorizeFirst: async step => {
      if (!current()) throw new Error('AMEND_WRITER_NOT_CURRENT');
      const result = await authorization.authorizeFirst({ ...step, writer: structuredClone(writer) });
      if (!current()) throw new Error('AMEND_WRITER_NOT_CURRENT');
      return result;
    } });
}

/** Admit a bound native stay; all effects still require the paused-request claim. */
export function admitsCloudPaneAmend(input, authorization) {
  const selected = input?.selected;
  return Boolean(input?.discoveryOnly !== true && validTarget(input?.target, input?.selected) && amendTarget(selected, input?.changes, { allowRealGuest: input.allowRealGuest === true }) &&
    selected?.source === 'record_view_ext_model' && getPropertyRegistration(selected.propertyCode)?.active &&
    selected.firstName?.trim() && selected.lastName?.trim() &&
    (input.allowRealGuest === true || (selected.firstName === 'Proof' && selected.lastName === 'Labtest')) && selected.status === 'Reserved' &&
    /^\d{6,}-\d+$/.test(selected.confirmation || '') && /^\d{1,30}$/.test(selected.guestId || '') &&
    input.confirmation === selected.confirmation && input.arrival === selected.arrival &&
    /^[a-f0-9]{64}$/.test(input.nativeDigest || '') && input.approvedPrices?.version === 2 &&
    /^[A-Z]{3}$/.test(input.approvedPrices.currency || '') && /^\d+$/.test(input.approvedPrices.totalCents || '') &&
    typeof input.preserved?.cmsRecipient === 'string' &&
    typeof input.beforeScreenshot === 'string' && input.beforeScreenshot &&
    typeof input.afterScreenshot === 'string' && input.afterScreenshot &&
    /^[a-f0-9]{64}$/.test(authorization?.operationDigest || '') &&
    typeof authorization?.authorizeFirst === 'function' && typeof authorization?.sealBeforeEvidence === 'function' &&
    !input.signal?.aborted);
}

/** First Go applies only bound callbacks, reprices, and leaves Save permanently disarmed. */
export async function reviewCloudPaneAmendCallbacks(input, authorization) {
  if (!admitsCloudPaneAmend(input, authorization) || !input.callbackPlan || !input.callbackBindingChanges ||
      !/^[a-f0-9]{64}$/.test(input.sourceDigest || '') || !/^[a-f0-9]{64}$/.test(input.targetDigest || '') ||
      !/^[a-f0-9]{64}$/.test(input.callbackPlanDigest || '') || !input.approvedBeforeCallbackPrice) {
    return { outcome: 'not_dispatched', issue: 'CALLBACK_INPUT_INVALID' };
  }
  const phases = [...(input.callbackPlan.guarantee ? ['guarantee'] : []),
    ...(input.callbackPlan.parties ?? []).map(item => item.kind), ...(input.callbackPlan.children ? ['children'] : []), 'availability'];
  let authority, boundAuthorization, callbackTask = null, callbackOutcome = null, before = null, attempted = false;
  const drainTask = async () => {
    if (!callbackTask) return true;
    let timer;
    return Promise.race([Promise.resolve(callbackTask).then(value => { callbackOutcome = value; return true; }, () => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]).finally(() => clearTimeout(timer));
  };
  try {
    authority = createFirstGoCallbackAuthority({ operationDigest: authorization.operationDigest,
      sourceDigest: input.sourceDigest, targetDigest: input.targetDigest, plan: input.callbackPlan,
      approvedPlanDigest: input.callbackPlanDigest, phases,
      authorizeFirst: step => boundAuthorization.authorizeFirst(step),
      isEnabled: () => Boolean(boundAuthorization?.isEnabled()) });
    const protectedSession = guardedSession(input, installSavedStayReadGuard, 12 * 60_000);
    const staged = await withCloudWriterSession(async page => {
      if (!protectedSession.hasGuard(page.context(), page)) throw new Error('BROWSER_CONTEXT_UNSAFE');
      boundAuthorization = bindCloudAmendWriter(page, authorization);
      await readShallow(page, input.confirmation, searchHints(input.selected, input.arrival));
      const record = await readRecord(page, input.confirmation, { nativePropertyCode: input.selected.propertyCode });
      const approvedLab = input.allowChangedLabGuarantee === true && isLabtest(input.selected) && input.selected.arrival >= '2027-01-01';
      const expected = expectedLabtestAmendRecord(record, input.selected, { allowRealGuest: input.allowRealGuest === true || approvedLab,
        childAgePreimage: input.childAgePreimage });
      if (!expected) throw new Error('APPROVED_STAY_MISMATCH');
      attempted = true;
      return runLabtestAmendSave(page, cloudPaneAmendRunOptions({ page,
        input: { ...input, signal: protectedSession.options.signal }, expected, authorization, callbackAuthority: authority,
        captureBefore: value => { before = value; }, onCallbackTask: task => { callbackTask = task; } },
      { recordOptions: nativeOptions(input, record) }));
    }, protectedSession.options);
    const callbackDrained = await drainTask();
    if (!callbackDrained || staged.dispatchCallbacksDrained !== true || staged.outcome !== 'callback_review_ready' ||
        !authority.complete() || !before || !staged.approvedPrices || !Array.isArray(staged.callbackEffects)) {
      return { outcome: authority.possiblyPersisted() ? 'uncertain' : 'not_dispatched',
        issue: !callbackDrained ? 'CALLBACK_TASK_UNDRAINED' : staged.issue || 'CALLBACK_REPRICE_UNVERIFIED',
        callbackEffects: staged.callbackEffects ?? callbackOutcome?.effects, callbackTaskDrained: callbackDrained };
    }
    return { outcome: 'callback_review_ready', approvedPrices: staged.approvedPrices,
      ...(input.captureMealPlan ? { applied: staged.applied } : {}),
      callbackEffects: staged.callbackEffects, before, writerSessionClosed: true,
      dispatchCallbacksDrained: true, callbackTaskDrained: true };
  } catch {
    const callbackDrained = await drainTask();
    return { outcome: authority?.possiblyPersisted() || attempted ? 'uncertain' : 'not_dispatched',
      issue: callbackDrained ? 'CALLBACK_REPRICE_UNVERIFIED' : 'CALLBACK_TASK_UNDRAINED',
      callbackEffects: callbackOutcome?.effects, callbackTaskDrained: callbackDrained };
  } finally { authority?.close(); }
}

/** A fresh second Go may replay only missing callbacks and Save the reviewed price. */
export async function commitCloudPaneAmendReviewed(input, authorization) {
  if (!admitsCloudPaneAmend(input, authorization) || !input.callbackPlan || !input.callbackBindingChanges ||
      !/^[a-f0-9]{64}$/.test(input.sourceDigest || '') || !/^[a-f0-9]{64}$/.test(input.targetDigest || '') ||
      !/^[a-f0-9]{64}$/.test(input.callbackPlanDigest || '') || !/^[a-f0-9]{64}$/.test(input.reviewDigest || '') ||
      !input.approvedBeforeCallbackPrice || input.changes?.retainRates !== 'no') {
    return { outcome: 'not_dispatched', issue: 'CALLBACK_FINAL_INPUT_INVALID' };
  }
  if (!input.credentialLease) {
    let began = false;
    try { return await withCloudCredentialLease(input.selected.propertyCode, credentialLease => {
      began = true;
      return commitCloudPaneAmendReviewed({ ...input, credentialLease }, authorization);
    }, { signal: input.signal }); }
    catch { return { outcome: began ? 'uncertain' : 'not_dispatched', issue: 'CALLBACK_FINAL_UNVERIFIED' }; }
  }
  const phases = [...(input.callbackPlan.guarantee ? ['guarantee'] : []),
    ...(input.callbackPlan.parties ?? []).map(item => item.kind), ...(input.callbackPlan.children ? ['children'] : []),
    'availability', 'save', 'retain'];
  let issued, boundAuthorization, callbackTask = null, callbackOutcome = null, checks = null, before = null, attempted = false;
  const drainTask = async () => {
    if (!callbackTask) return true;
    let timer;
    return Promise.race([Promise.resolve(callbackTask).then(value => { callbackOutcome = value; return true; }, () => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]).finally(() => clearTimeout(timer));
  };
  try {
    issued = createFinalGoCallbackAuthority({ operationDigest: authorization.operationDigest,
      sourceDigest: input.sourceDigest, targetDigest: input.targetDigest, reviewDigest: input.reviewDigest,
      plan: input.callbackPlan, approvedPlanDigest: input.callbackPlanDigest, phases,
      authorizeFirst: step => boundAuthorization.authorizeFirst(step),
      isEnabled: () => Boolean(boundAuthorization?.isEnabled()),
      verifyFinal: (...args) => checks?.verifyFinal(...args) === true,
      verifyDispatch: (...args) => checks?.verifyDispatch(...args) ?? false });
    const protectedSession = guardedSession(input, installSavedStayReadGuard, 12 * 60_000);
    const saved = await withCloudWriterSession(async page => {
      if (!protectedSession.hasGuard(page.context(), page)) throw new Error('BROWSER_CONTEXT_UNSAFE');
      boundAuthorization = bindCloudAmendWriter(page, authorization);
      await readShallow(page, input.confirmation, searchHints(input.selected, input.arrival));
      const record = await readRecord(page, input.confirmation, { nativePropertyCode: input.selected.propertyCode });
      const approvedLab = input.allowChangedLabGuarantee === true && isLabtest(input.selected) && input.selected.arrival >= '2027-01-01';
      const expected = expectedLabtestAmendRecord(record, input.selected, { allowRealGuest: input.allowRealGuest === true || approvedLab,
        childAgePreimage: input.childAgePreimage });
      if (!expected) throw new Error('APPROVED_STAY_MISMATCH');
      attempted = true;
      return runLabtestAmendSave(page, cloudPaneAmendRunOptions({ page,
        input: { ...input, signal: protectedSession.options.signal }, expected, authorization,
        callbackAuthority: issued.authority, authorizeCallbackSave: issued.authorizeSave,
        registerFinalChecks: value => { checks = value; }, captureBefore: value => { before = value; },
        onCallbackTask: task => { callbackTask = task; } }, { recordOptions: nativeOptions(input, record) }));
    }, protectedSession.options);
    const callbackDrained = await drainTask();
    if (!callbackDrained || saved.dispatchCallbacksDrained !== true || saved.outcome !== 'awaiting_readback' ||
        !issued.authority.complete() || !before || !saved.finalParties) {
      return { outcome: issued.authority.possiblyPersisted() || attempted ? 'uncertain' : 'not_dispatched',
        issue: !callbackDrained ? 'CALLBACK_TASK_UNDRAINED' : saved.issue || 'CALLBACK_FINAL_UNVERIFIED',
        callbackEffects: saved.callbackEffects ?? callbackOutcome?.effects, callbackTaskDrained: callbackDrained };
    }
    const fresh = await readCloudPaneAmend({ ...input, ...before, beforeParties: saved.finalParties,
      ...(typeof saved.finalBeforeCommission === 'number' ? { beforeCommission: saved.finalBeforeCommission } : {}) });
    return confirmedCloudAmendResult(saved, fresh, true);
  } catch {
    const callbackDrained = await drainTask();
    return { outcome: issued?.authority.possiblyPersisted() || attempted ? 'uncertain' : 'not_dispatched',
      issue: callbackDrained ? 'CALLBACK_FINAL_UNVERIFIED' : 'CALLBACK_TASK_UNDRAINED',
      callbackEffects: callbackOutcome?.effects, callbackTaskDrained: callbackDrained };
  } finally { issued?.authority.close(); }
}

/** Independently reopen the selected stay after callbacks; only approved effects may be present. */
export async function readCloudCallbackReviewState(input) {
  const selected = input?.selected, plan = input?.callbackPlan, before = input?.before;
  if (!validTarget(input?.target, input?.selected) || !selected || !plan || !before?.beforeParties ||
      typeof before.beforeNote !== 'string' || !Array.isArray(input.callbackEffects)) return { outcome: 'unverified' };
  // This independent read may observe a changed guarantee on the approved Lab
  // guest; it does not grant the writer permission to operate on a real guest.
  if (input.allowRealGuest !== true && (selected.firstName !== 'Proof' || selected.lastName !== 'Labtest' ||
      selected.arrival < '2027-01-01')) return { outcome: 'unverified' };
  if (!input.credentialLease) {
    try { return await withCloudCredentialLease(selected.propertyCode, credentialLease =>
      readCloudCallbackReviewState({ ...input, credentialLease }), { signal: input.signal }); }
    catch { return { outcome: 'unverified' }; }
  }
  const readInput = { ...input, allowRealGuest: true };
  try {
    const protectedSession = guardedSession(input, installSavedStayReadGuard);
    const result = await withCloudWriterSession(async page => {
      if (!protectedSession.hasGuard(page.context(), page)) return null;
      await readShallow(page, selected.confirmation, searchHints(selected, selected.arrival));
      const record = await readRecord(page, selected.confirmation, { nativePropertyCode: input.selected.propertyCode });
      const native = record?.nativePreimage;
      if (!native || ['source', 'propertyCode', 'confirmation', 'reservationStayId', 'reservationId', 'recordId',
        'guestId', 'status', 'firstName', 'lastName', 'arrival', 'departure', 'roomType', 'ratePlan', 'adults']
        .some(key => native[key] !== selected[key])) return null;
      const guarantee = nativeOptions(readInput, record).expectedGuarantee;
      const requestedGuarantee = plan.guarantee;
      if (!guarantee || (requestedGuarantee ? ![requestedGuarantee.before.code, requestedGuarantee.code].includes(guarantee.code) ||
          (guarantee.code === requestedGuarantee.code && guarantee.display !== requestedGuarantee.display) ||
          (guarantee.code === requestedGuarantee.before.code && guarantee.display !== requestedGuarantee.before.display)
        : guarantee.code !== plan.expected.expectedGuarantee.code || guarantee.display !== plan.expected.expectedGuarantee.display)) return null;
      const expected = expectedLabtestAmendRecord(record, native, { allowRealGuest: true });
      if (!expected || expected.note !== before.beforeNote) return null;
      const state = await currentLabtestRecord(page, expected, nativeOptions(readInput, record));
      const snapshot = await snapshotLabtestRecord(state.frame), image = savedPartyBeforeImage(snapshot);
      const agencyDefault = plan.parties.some(item => item.kind === 'bookingAgency' && item.expectedEffects);
      if (!snapshot || !cleanLabtestRecord(snapshot) || !image ||
          !unchangedLabtestBusinessParties(state.partyPreimage, snapshot,
            { allowModelOnlyPrimaryPartyIds: true, allowRealGuest: true }) ||
          (typeof input.preserved?.cmsSend === 'boolean' && state.cmsSend !== input.preserved.cmsSend) ||
          (typeof input.preserved?.cmsMessageId === 'string' && state.cmsMessageId !== input.preserved.cmsMessageId) ||
          (!agencyDefault && typeof before.beforeCommission === 'number' && percent(snapshot.data?.ta1commission) !== before.beforeCommission) ||
          (typeof before.beforeGuestOptIn === 'boolean' && nativeCmsSendValue(snapshot.data?.guestoptin4) !== before.beforeGuestOptIn)) return null;
      const savedMealPlan = observedAmendMealPlan(snapshot);
      if (input.captureMealPlan && (typeof before.beforeMealPlan !== 'string' || savedMealPlan !== before.beforeMealPlan)) return null;
      const permitted = new Set();
      for (const item of plan.parties) {
        if (item.kind === 'organization') ['companyid', 'company'].forEach(name => permitted.add(name));
        if (item.kind === 'bookingAgency') ['taid1', 'ta1'].forEach(name => permitted.add(name));
        if (item.kind === 'arAccount') ['araccountid', 'araccountname', 'arprofileid'].forEach(name => permitted.add(name));
      }
      for (const [key, value] of Object.entries(before.beforeParties)) {
        if (!permitted.has(key) && state.partyPreimage[key] !== value) return null;
      }
      const effects = [];
      if (requestedGuarantee) effects.push({ field: 'guaranteeType', requested: requestedGuarantee.code,
        persistence: guarantee.code === requestedGuarantee.code ? 'confirmed' : 'not_observed' });
      const mapping = { organization: ['companyid', 'company'], bookingAgency: ['taid1', 'ta1'],
        arAccount: ['araccountid', 'araccountname'] };
      for (const item of plan.parties) {
        const [idField, nameField] = mapping[item.kind] ?? [];
        if (!idField || !nameField) return null;
        const id = state.partyPreimage[idField], name = state.partyPreimage[nameField];
        const confirmed = id === item.nativeId && name === item.name;
        const unchanged = id === before.beforeParties[idField] && name === before.beforeParties[nameField];
        if (!confirmed && !unchanged) return null;
        if (item.kind === 'arAccount') {
          const effect = input.callbackEffects.find(entry => entry?.kind === 'arAccount');
          const expectedProfile = effect?.after?.data?.arprofileid;
          const value = expectedProfile?.present ? String(expectedProfile.value ?? '') : null;
          if (confirmed && (!value || state.partyPreimage.arprofileid !== value)) return null;
          if (!confirmed && state.partyPreimage.arprofileid !== before.beforeParties.arprofileid) return null;
        }
        if (item.kind === 'bookingAgency' && item.expectedEffects) {
          if (confirmed) {
            const actual = percent(snapshot.data?.ta1commission), final = percent(input.changes?.taCommission);
            if (actual === null || actual !== percent(snapshot.values?.ta1commission) ||
                (actual !== Number(item.expectedEffects.ta1commission) && (final === null || actual !== final))) return null;
          } else if (!plan.beforeImage || ['data', 'values'].some(part => !plan.beforeImage[part] ||
            !Object.hasOwn(plan.beforeImage[part], 'ta1commission') ||
            !same(plan.beforeImage[part].ta1commission, image[part]?.ta1commission))) return null;
        }
        effects.push({ field: item.kind, requested: { nativeId: item.nativeId, name: item.name },
          persistence: confirmed ? 'confirmed' : 'not_observed' });
      }
      const exempt = new Set([...permitted, ...nativePriceComponents,
        ...(plan.guarantee ? ['guaranteetype'] : []),
        ...(plan.children ? ['children', 'childages', ...new Set(['data', 'values'].flatMap(part =>
          [...Object.keys(plan.beforeImage?.[part] ?? {}), ...Object.keys(image?.[part] ?? {})].filter(key => /^child\d+$/i.test(key))))] : []),
        ...(plan.parties.some(item => item.kind === 'bookingAgency' && item.expectedEffects) ? ['ta1commission'] : []),
        'bookingsessionid']);
      if (plan.beforeImage) for (const part of ['data', 'values']) {
        for (const [key, value] of Object.entries(plan.beforeImage[part] ?? {})) {
          if (!exempt.has(key) && !same(value, image[part]?.[key])) return null;
        }
      }
      for (const [name, key] of Object.entries({ emailaddress: 'beforeGuestEmail', caller: 'beforeBookerName',
        udfchar06: 'beforeBookerContact', billingreference: 'beforeBillingReference', track: 'beforeTrack',
        roomtypecharge: 'beforeRoomTypeForCharge', udfchar13: 'beforeRecipient' })) {
        if (typeof before[key] === 'string' && String(snapshot.data?.[name] ?? '') !== before[key]) return null;
      }
      const price = observedAmendPrice(snapshot, native, null, { includeComponents: true });
      if (!price) return null;
      const partyImage = portableBusinessImage(snapshot);
      return { native, effects, price, partyPreimage: state.partyPreimage, partyImage, guarantee, savedMealPlan };
    }, protectedSession.options);
    if (!result) return { outcome: 'unverified' };
    const child = await readCloudSavedChildAges({ ...readInput, selected: result.native, arrival: result.native.arrival });
    if (child.outcome !== 'ok' || !Array.isArray(child.ages)) return { outcome: 'unverified' };
    if (plan.children) {
      const confirmed = sameChildAgeMultiset(child.ages, plan.children.nextAges);
      const unchanged = sameChildAgeMultiset(child.ages, plan.children.beforeAges);
      if (!confirmed && !unchanged) return { outcome: 'unverified' };
      result.effects.push({ field: 'childAges', requested: plan.children.nextAges,
        persistence: confirmed ? 'confirmed' : 'not_observed' });
    } else if (!sameChildAgeMultiset(child.ages, plan.expected.childAges)) return { outcome: 'unverified' };
    return { outcome: 'matched', confirmation: selected.confirmation, nativeStayId: selected.reservationStayId,
      callbackState: { effects: result.effects }, native: result.native, childAges: child.ages,
      partyPreimage: result.partyPreimage, partyImage: result.partyImage, guarantee: result.guarantee, savedPrice: result.price,
      ...(input.captureMealPlan ? { savedMealPlan: result.savedMealPlan } : {}) };
  } catch { return { outcome: 'unverified' }; }
}

/** Staff Go's native entry point; failures after an effect retain UNKNOWN. */
export async function commitCloudPaneAmend(input, authorization) {
  if (!admitsCloudPaneAmend(input, authorization)) return { outcome: 'not_dispatched', issue: 'AMEND_INPUT_INVALID' };
  if (!input.credentialLease) {
    let began = false;
    try { return await withCloudCredentialLease(input.selected.propertyCode, credentialLease => {
      began = true;
      return commitCloudPaneAmend({ ...input, credentialLease }, authorization);
    }, { signal: input.signal }); }
    catch { return { outcome: began ? 'uncertain' : 'not_dispatched', issue: 'AMEND_UNVERIFIED' }; }
  }
  let attempted = false, before = null;
  try {
    const protectedSession = guardedSession(input, installSavedStayReadGuard, 12 * 60_000);
    const saved = await withCloudWriterSession(async (page) => {
      if (!protectedSession.hasGuard(page.context(), page)) throw new Error('BROWSER_CONTEXT_UNSAFE');
      await readShallow(page, input.confirmation, searchHints(input.selected, input.arrival));
      const record = await readRecord(page, input.confirmation, { nativePropertyCode: input.selected.propertyCode });
      const expected = expectedLabtestAmendRecord(record, input.selected, { allowRealGuest: input.allowRealGuest === true,
        childAgePreimage: input.childAgePreimage });
      if (!expected) throw new Error('APPROVED_STAY_MISMATCH');
      attempted = true;
      return runLabtestAmendSave(page, cloudPaneAmendRunOptions({ page,
        input: { ...input, signal: protectedSession.options.signal }, expected,
        authorization: bindCloudAmendWriter(page, authorization),
        captureBefore: (value) => { before = value; } }, { recordOptions: nativeOptions(input, record) }));
    }, protectedSession.options);
    if (saved.outcome !== 'awaiting_readback' || saved.dispatchCallbacksDrained !== true) return saved;
    if (!before) return { outcome: 'uncertain', issue: 'AMEND_PREIMAGE_UNVERIFIED' };
    const fresh = await readCloudPaneAmend({ ...input, ...before });
    return confirmedCloudAmendResult(saved, fresh, true);
  } catch {
    return { outcome: attempted ? 'uncertain' : 'not_dispatched', issue: 'AMEND_UNVERIFIED' };
  }
}

/** Reopen the saved stay and verify the requested business fields independently. */
export async function readCloudPaneAmend(input, dependencies = {}) {
  const { openSession = withCloudWriterSession,
  guard = installSavedStayReadGuard, shallow = readShallow, read = readRecord,
  current = currentLabtestRecord, snapshot = snapshotLabtestRecord, readRates = readSavedStayNightlyRates } = dependencies;
  const selected = input?.selected, changes = input?.changes;
  const target = amendTarget(selected, changes, { allowRealGuest: input?.allowRealGuest === true });
  if (!validTarget(input?.target, input?.selected) || !target || typeof input.beforeNote !== 'string' ||
      !input.beforeParties || !input.afterScreenshot) return { outcome: 'unverified' };
  let savedNative = null;
  try {
    if (!input.credentialLease && openSession === withCloudWriterSession) {
      return await withCloudCredentialLease(selected.propertyCode, credentialLease =>
        readCloudPaneAmend({ ...input, credentialLease }, dependencies), { signal: input.signal, readOnly: true });
    }
    const protectedSession = guardedSession(input, guard);
    const result = await openSession(async (page) => {
      if (!protectedSession.hasGuard(page.context(), page)) return { outcome: 'unverified' };
      await shallow(page, target.confirmation, searchHints(target, target.arrival));
      const record = await read(page, target.confirmation, { nativePropertyCode: input.selected.propertyCode });
      const native = record?.nativePreimage;
      if (!native || native.confirmation !== target.confirmation || native.reservationStayId !== target.reservationStayId ||
          native.reservationId !== target.reservationId || native.guestId !== target.guestId || native.propertyCode !== target.propertyCode ||
          native.status !== 'Reserved' || native.firstName !== target.firstName || native.lastName !== target.lastName ||
          native.arrival !== target.arrival || native.departure !== target.departure || native.roomType !== target.roomType ||
          native.ratePlan !== target.ratePlan || native.adults !== target.adults || native.children !== target.children ||
          native.guaranteeCode !== (changes.guaranteeType ?? input.beforeGuaranteeCode)) return { outcome: 'unverified' };
      const approvedLab = input.allowChangedLabGuarantee === true && isLabtest(selected) && selected.arrival >= '2027-01-01';
      const expected = expectedLabtestAmendRecord(record, native, { allowRealGuest: input.allowRealGuest === true || approvedLab });
      if (!expected || expected.note !== (changes.reservationNote ?? input.beforeNote)) return { outcome: 'unverified' };
      savedNative = native;
      const state = await current(page, expected, nativeOptions(input, record));
      const saved = await snapshot(state.frame), data = saved?.data;
      if (!data || !cleanLabtestRecord(saved) || !unchangedLabtestBusinessParties(input.beforeParties, saved,
          { allowModelOnlyPrimaryPartyIds: true, allowRealGuest: input.allowRealGuest === true || approvedLab })) return { outcome: 'unverified' };
      const mealPlan = observedAmendMealPlan(saved);
      if (input.captureMealPlan && (typeof input.approvedMealPlan !== 'string' || mealPlan !== input.approvedMealPlan)) {
        return { outcome: 'unverified' };
      }
      const occupancy = savedChildOccupancy(saved);
      const ages = occupancy.ages ?? 'unknown';
      if (!occupancy.valid || occupancy.count !== target.children ||
          (ages !== 'unknown' && Array.isArray(target.childAges) && !sameChildAgeMultiset(ages, target.childAges))) {
        return { outcome: 'unverified' };
      }
      const chargeRoom = Object.hasOwn(changes, 'roomTypeForCharge') ? changes.roomTypeForCharge : input.beforeRoomTypeForCharge;
      if (typeof chargeRoom === 'string' && (!Object.hasOwn(data, 'roomtypecharge') ||
          !Object.hasOwn(saved.values ?? {}, 'roomtypecharge') || String(data.roomtypecharge ?? '') !== chargeRoom ||
          String(saved.values.roomtypecharge ?? '') !== chargeRoom)) return { outcome: 'unverified' };
      const guestEmail = String(data.emailaddress ?? ''), bookerName = String(data.caller ?? ''),
        bookerContact = String(data.udfchar06 ?? ''), cmsRecipient = String(data.udfchar13 ?? ''),
        cmsMessageId = String(data.udfchar09 ?? '');
      const billingReference = Object.hasOwn(data, 'billingreference') && Object.hasOwn(saved.values ?? {}, 'billingreference') &&
        String(data.billingreference ?? '') === String(saved.values.billingreference ?? '') ? String(data.billingreference ?? '') : null;
      if ((Object.hasOwn(changes, 'billingReference') || typeof input.beforeBillingReference === 'string') &&
          billingReference !== (changes.billingReference ?? input.beforeBillingReference)) return { outcome: 'unverified' };
      if (Object.hasOwn(changes, 'guestOptIn')) {
        const actual = await state.frame.evaluate(() => {
          const controls = [...document.querySelectorAll('input[name=guestoptin4]')].filter(el =>
            (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
          return controls.length === 1 ? globalThis.Ext?.getCmp?.(controls[0].id.replace(/-inputEl$/, ''))?.getValue?.() : null;
        });
        if (typeof input.beforeGuestOptIn !== 'boolean' || nativeCmsSendValue(data.guestoptin4) !== changes.guestOptIn || actual !== changes.guestOptIn) {
          return { outcome: 'unverified' };
        }
      }
      const commission = percent(data.ta1commission);
      if (Object.hasOwn(changes, 'taCommission') && (commission !== changes.taCommission ||
          percent(saved.values?.ta1commission) !== changes.taCommission || typeof input.beforeCommission !== 'number')) {
        return { outcome: 'unverified' };
      }
      if (input.expectedFinalCommission !== undefined && (typeof input.expectedFinalCommission !== 'number' ||
          !Number.isFinite(input.expectedFinalCommission) || input.expectedFinalCommission < 0 || input.expectedFinalCommission > 100 ||
          commission !== input.expectedFinalCommission || percent(saved.values?.ta1commission) !== input.expectedFinalCommission)) {
        return { outcome: 'unverified' };
      }
      const track = Object.hasOwn(data, 'track') && Object.hasOwn(saved.values ?? {}, 'track') &&
        String(data.track ?? '') === String(saved.values.track ?? '') ? String(data.track ?? '') : null;
      if ((changes.track || typeof input.beforeTrack === 'string') && track !== (changes.track?.display ?? input.beforeTrack)) {
        return { outcome: 'unverified' };
      }
      for (const [name, actual] of Object.entries({ guestEmail, bookerName, bookerContact })) {
        if (Object.hasOwn(changes, name) && changes[name] !== actual) return { outcome: 'unverified' };
      }
      if ((!Object.hasOwn(changes, 'guestEmail') &&
          (typeof input.beforeGuestEmail !== 'string' || guestEmail !== input.beforeGuestEmail)) ||
          (!Object.hasOwn(changes, 'bookerName') &&
            (typeof input.beforeBookerName !== 'string' || bookerName !== input.beforeBookerName)) ||
          (!Object.hasOwn(changes, 'bookerContact') &&
            (typeof input.beforeBookerContact !== 'string' || bookerContact !== input.beforeBookerContact)) ||
          state.cmsSend !== changes.cmsSend ||
          cmsRecipient !== changes.cmsRecipient || cmsMessageId !== changes.cmsMessageId) return { outcome: 'unverified' };
      if (changes.retainRates === 'no') {
        assertApprovedAmendPrice(saved, target, input.approvedPrices);
      } else {
        const beforeRates = input.beforeSavedRates;
        if (!Array.isArray(beforeRates?.nightly) || !beforeRates.nightly.length) return { outcome: 'unverified' };
        const afterRates = await readRates(page, state, { propertyCode: selected.propertyCode, confirmation: target.confirmation,
          nativeStayId: target.reservationStayId, arrival: target.arrival, departure: target.departure }, { mode: 'saved_direct' });
        if (!afterRates || afterRates.currency !== beforeRates.currency || !Array.isArray(afterRates.nightly)) return { outcome: 'unverified' };
        const afterByDate = new Map(afterRates.nightly.map((night) => [night.date, night]));
        const overlap = beforeRates.nightly.filter((night) => afterByDate.has(night.date));
        if (!overlap.length || overlap.some((night) => {
          const after = afterByDate.get(night.date);
          return night.chargeCents !== after.chargeCents || night.totalChargeCents !== after.totalChargeCents;
        })) return { outcome: 'unverified' };
      }
      await page.screenshot({ path: input.afterScreenshot });
      return { outcome: 'matched', readback: { confirmation: native.confirmation, nativeStayId: native.reservationStayId,
        arrival: native.arrival, departure: native.departure, roomType: native.roomType, ratePlan: native.ratePlan,
        adults: native.adults, children: native.children, childAges: ages, firstName: native.firstName, lastName: native.lastName,
        guestEmail, bookerName, bookerContact, reservationNote: expected.note, guaranteeType: native.guaranteeCode,
        ...(input.captureMealPlan ? { mealPlan } : {}),
        ...(billingReference === null ? {} : { billingReference }),
        ...(track === null ? {} : { track }),
        ...(Object.hasOwn(changes, 'taCommission') || input.expectedFinalCommission !== undefined ? { taCommission: commission } : {}),
        ...(Object.hasOwn(changes, 'guestOptIn') ? { guestOptIn: changes.guestOptIn } : {}),
        ...(typeof chargeRoom === 'string' ? { roomTypeForCharge: chargeRoom } : {}),
        cmsSend: state.cmsSend, cmsMessageId, cmsRecipient,
        price: observedAmendPrice(saved, target, null, { includeComponents: input.capturePriceComponents === true }) } };
    }, { ...protectedSession.options, staging: true });
    if (result.outcome === 'matched' && (Array.isArray(input.beforeChildAges) || result.readback.childAges === 'unknown')) {
      const expectedAges = Array.isArray(changes.childAges) ? changes.childAges :
        Array.isArray(input.beforeChildAges) ? input.beforeChildAges : target.childAges;
      if (!Array.isArray(expectedAges)) return { outcome: 'unverified' };
      const childRead = await readCloudSavedChildAges({ ...input, allowRealGuest: input.allowRealGuest === true ||
        (input.allowChangedLabGuarantee === true && isLabtest(selected) && selected.arrival >= '2027-01-01'), selected: savedNative,
        confirmation: savedNative.confirmation, arrival: savedNative.arrival });
      if (childRead.outcome !== 'ok' || !sameChildAgeMultiset(childRead.ages, expectedAges)) return { outcome: 'unverified' };
      result.readback.childAges = childRead.ages;
    }
    return result;
  } catch { return { outcome: 'unverified' }; }
}
