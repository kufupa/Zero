// One narrowly authorized save on a verified, unsaved HRCEN draft.
import { isDeepStrictEqual } from 'node:util';
import { verifiedLabtestProfileToken, isVerifiedLabtestProfileCurrent } from './guest-profile.mjs';
import { consumeLabtestPreimage } from './labtest-preimage.mjs';
import { verifiedArSelectionToken, isVerifiedArSelectionCurrent } from './lookup.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';
import { installLabtestSaveRouteChain as installLabtestCreateSaveRouteChain } from './saved-stay-save-route-chain.mjs';
import { validCreateNote } from './create-request-binding.mjs';
import { checkedChargeRateEvidence } from './guest-stay-rate-plan.mjs';
import { compareChargeRoomPricing } from './charge-room-pricing.mjs';
import { CREATE_GUARANTEES, isLabtestGuest, validCreateDates, validCreateGuest } from './cloud-create-policy.mjs';
import { getPropertyRegistration } from './property-registry.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const SAVE_PATH = '/web/base/OSRESV.HDR';
const usedPages = new WeakSet();
const clean = (value) => String(value ?? '').trim();
const safeIssue = (error) => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'SAVE_UNVERIFIED';
const draftChecks = new Set([
  'DRAFT_PROPERTY_CONTEXT', 'DRAFT_VISIBLE_FIELDS', 'DRAFT_FORM_RECORD', 'DRAFT_PARTY_FIELDS',
  'DRAFT_RESERVATION_MODEL', 'DRAFT_VISIBLE_PROFILE_FIELDS', 'DRAFT_STAY_FIELDS', 'DRAFT_GUARANTEE',
  'DRAFT_PROFILE_PRIVACY_FIELDS', 'DRAFT_FORM_MODEL_SHAPE', 'DRAFT_FORM_MODEL_KEYS',
  'DRAFT_ADULT_MODEL', 'DRAFT_CHILD_MODEL', 'DRAFT_CHILD_AGES_MODEL', 'DRAFT_CHILD_CATEGORY_MODEL',
  'DRAFT_SOURCE_BUSINESS_MODEL', 'DRAFT_ADULT_VISIBLE_VALUE', 'DRAFT_CHILD_VISIBLE_VALUE',
  'DRAFT_NOTE_SUBMIT_VALUE', 'DRAFT_CMS_MESSAGE_VALUE', 'DRAFT_REASON_FOR_STAY_VALUE', 'DRAFT_CHARGE_ROOM_VALUE', 'DRAFT_REVENUE_ZERO_NATIVE_VALUE', 'DRAFT_LIFETIME_NIGHTS_NATIVE_VALUE',
  'DRAFT_PARTY_MODEL', 'DRAFT_ORGANIZATION_MODEL', 'DRAFT_AGENCY_COMMISSION_VALUE', 'DRAFT_REQUIRED_FIELDS',
  'DRAFT_BILLING_REFERENCE_VALUE', 'DRAFT_OPEN_MODAL',
  'DRAFT_GUEST_OPT_IN', 'DRAFT_REVIEWED_CONTACT_FIELDS', 'DRAFT_MARKET_SEGMENT_VALUE',
]);
const safeDraftCheck = (value) => draftChecks.has(value) ? value : null;
const CREATE_PARTY_FIELDS = Object.freeze(['taid1', 'ta1', 'companyid', 'company']);
export function validCreateBillingReference(value) {
  return typeof value === 'string' && value.length <= 4000 && Boolean(value.trim()) &&
    ![...value].some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127);
}

// Preserve the reviewed business fields while the billing control is staged.
export function billingOnlyDraftChange(before, after, requested) {
  if (!before || !after || !validCreateBillingReference(requested)) return false;
  const business = new Set(['guestid', 'firstname', 'lastname', 'arrivaldate', 'departuredate', 'adults', 'children',
    'childages', 'roomtype', 'rateplan', 'track', 'marketsegment', 'guaranteetype', 'sourceofbus', 'sourceofbusinessdesc',
    'taid1', 'ta1', 'companyid', 'company', 'araccountid', 'araccountname',
    'arprofileid', 'reservationnote', 'emailaddress', 'caller', 'udfchar06', 'guestoptin4',
    'udfchkbox04', 'udfchar09', 'udfchar13']);
  const reviewed = (data) => Object.fromEntries(Object.entries(data || {}).filter(([key]) => business.has(key.toLowerCase()) || /^child\d+$/i.test(key)));
  if (!isDeepStrictEqual(reviewed(before.modelData), reviewed(after.modelData)) ||
      !isDeepStrictEqual(reviewed(before.formData), reviewed(after.formData)) ||
      ![before.modelData?.billingreference, requested].includes(after.modelData?.billingreference) ||
      after.formData?.billingreference !== requested || before.session !== after.session || before.arProfileId !== after.arProfileId ||
      !isDeepStrictEqual(before.partyValues, after.partyValues) || before.track !== after.track) return false;
  const otherControls = (state) => (state.visibleFields || []).filter((field) =>
    business.has(field.name?.toLowerCase()) || /^child\d+$/i.test(field.name || ''));
  const billingControls = (after.visibleFields || []).filter((field) => field.name === 'billingreference');
  return Array.isArray(before.visibleFields) && Array.isArray(after.visibleFields) &&
    billingControls.length === 1 && billingControls[0].value === requested &&
    isDeepStrictEqual(otherControls(before), otherControls(after));
}

function normalizeChildSelection(selection) {
  if (!selection || !['updated_unsaved', 'unchanged_unsaved'].includes(selection.outcome) ||
      !Array.isArray(selection.requestedChildAges) || !Array.isArray(selection.actualChildAges) ||
      !selection.requestedChildAges.every((age) => Number.isInteger(age) && age >= 0 && age <= 17) ||
      !selection.actualChildAges.every((age) => Number.isInteger(age) && age >= 0 && age <= 17) ||
      !clean(selection.profileProofToken) ||
      JSON.stringify(selection.requestedChildAges) !== JSON.stringify(selection.actualChildAges)) return null;
  const counts = selection.ageBandCounts;
  const names = counts && typeof counts === 'object' && !Array.isArray(counts) ? Object.keys(counts) : [];
  if (!counts || typeof counts !== 'object' || Array.isArray(counts) ||
      names.some((name) => !/^child[1-9]\d*$/.test(name) || !Number.isInteger(counts[name]) || counts[name] < 0) ||
      names.reduce((sum, name) => sum + counts[name], 0) !== selection.actualChildAges.length) return null;
  return { ages: [...selection.actualChildAges], bands: Object.fromEntries(names.map((name) => [name, counts[name]])),
    profileProofToken: clean(selection.profileProofToken) };
}

function normalizeAdultSelection(selection) {
  const adults = selection?.requested;
  if (!selection || !['updated_unsaved', 'unchanged_unsaved'].includes(selection.outcome) ||
      selection.field !== 'adults' || !Number.isInteger(adults) || adults < 0 ||
      clean(selection.actual?.value) !== String(adults) || !clean(selection.actual?.display) ||
      !clean(selection.profileProofToken)) return null;
  return { adults: String(adults), profileProofToken: clean(selection.profileProofToken) };
}

function normalizeSourceSelection(selection) {
  const nativeCode = clean(selection?.nativeCode);
  const description = clean(selection?.candidate?.description);
  if (selection?.outcome !== 'selected_unsaved' || !clean(selection.searchId) || !nativeCode || !description ||
      !clean(selection.profileProofToken) ||
      selection.candidate?.nativeCode !== nativeCode || selection.identityEvidence !== 'unique_current_picker_row_and_description_readback' ||
      selection.nativeCodeReadback?.outcome !== 'unsupported' ||
      selection.nativeCodeReadback?.issue !== 'SOURCE_CODE_NOT_EXPOSED_ON_FORM') return null;
  return { nativeCode, description, profileProofToken: clean(selection.profileProofToken) };
}

function normalizeCreateFieldProof(proof) {
  const allowed = ['adultSelection', 'childAgeSelection', 'sourceSelection', 'cmsMessageSelection', 'reasonSelection'];
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) ||
      Object.keys(proof).some((key) => !allowed.includes(key)) ||
      !allowed.some((key) => Object.hasOwn(proof, key))) return null;
  const adult = Object.hasOwn(proof, 'adultSelection') ? normalizeAdultSelection(proof.adultSelection) : null;
  const child = Object.hasOwn(proof, 'childAgeSelection') ? normalizeChildSelection(proof.childAgeSelection) : null;
  const source = Object.hasOwn(proof, 'sourceSelection') ? normalizeSourceSelection(proof.sourceSelection) : null;
  if ((Object.hasOwn(proof, 'adultSelection') && !adult) ||
      (Object.hasOwn(proof, 'childAgeSelection') && !child) ||
      (Object.hasOwn(proof, 'sourceSelection') && !source)) return null;
  const cms = proof.cmsMessageSelection;
  if (Object.hasOwn(proof, 'cmsMessageSelection') && (!cms || cms.outcome !== 'updated_unsaved' ||
      cms.field !== 'cmsMessageId' || typeof cms.requested !== 'string' || !cms.requested ||
      cms.actual !== cms.requested)) return null;
  const reason = proof.reasonSelection;
  if (Object.hasOwn(proof, 'reasonSelection') && (!reason ||
      !['updated_unsaved', 'unchanged_unsaved'].includes(reason.outcome) || reason.field !== 'reasonForStay' ||
      typeof reason.requested !== 'string' || !reason.requested || String(reason.actual?.value) !== reason.requested ||
      typeof reason.actual?.display !== 'string' || !reason.actual.display.trim())) return null;
  const tokens = [adult?.profileProofToken, child?.profileProofToken, source?.profileProofToken].filter(Boolean);
  if (!tokens.length || tokens.some((token) => token !== tokens[0])) return null;
  return { adults: adult?.adults ?? null, childAges: child?.ages ?? null,
    childAgeBands: child?.bands ?? null, sourceBusiness: source, cmsMessage: cms?.requested ?? null,
    reason: reason ? { value: reason.requested, display: reason.actual.display } : null,
    profileProofToken: tokens[0] };
}

function normalizeAgencySelection(selection) {
  if (!selection) return null;
  const nativeId = clean(selection.nativeId);
  const name = clean(selection.displayedAgency);
  const rawIataNumber = selection.agencyIataNumber;
  const rawReferenceType = selection.agencyReferenceNumberType;
  const referenceEvidence = selection.agencyReferenceEvidence;
  const hasPickerReferenceEvidence = Object.hasOwn(selection, 'agencyIataNumber') &&
    (rawIataNumber === null || (typeof rawIataNumber === 'string' && clean(rawIataNumber) === rawIataNumber)) &&
    Object.hasOwn(selection, 'agencyReferenceNumberType') &&
    (rawReferenceType === null || (typeof rawReferenceType === 'string' && clean(rawReferenceType) === rawReferenceType)) &&
    referenceEvidence && typeof referenceEvidence === 'object' && !Array.isArray(referenceEvidence) &&
    Object.keys(referenceEvidence).length === 2 &&
    referenceEvidence.iataNumber === 'response_grid_correlated' &&
    referenceEvidence.referenceNumberType === 'response_grid_correlated';
  if (selection.outcome !== 'selected_unsaved' || !clean(selection.searchId) || !nativeId || !name || !hasPickerReferenceEvidence ||
      !clean(selection.profileProofToken) || selection.nativeIdEvidence !== 'form_change_response' ||
      selection.selectedField?.name !== 'ta1' || clean(selection.selectedField.value) !== name) return undefined;
  return { nativeId, name, referenceNumber: rawIataNumber ?? '', referenceNumberType: rawReferenceType ?? '',
    profileProofToken: clean(selection.profileProofToken) };
}

function normalizeArSelection(selection) {
  const nativeId = clean(selection?.nativeId), name = clean(selection?.displayedArAccount);
  if (selection?.outcome !== 'selected_unsaved' || !clean(selection.searchId) || !nativeId || !name ||
      selection.nativeIdEvidence !== 'form_change_response' || selection.selectedField?.name !== 'araccountname' ||
      clean(selection.selectedField.value) !== name || clean(selection.nativeReadback?.araccountid) !== nativeId ||
      clean(selection.nativeReadback?.araccountname) !== name) return null;
  return { nativeId, name };
}

export function normalizeOrganizationSelection(selection) {
  if (!selection) return null;
  const nativeId = clean(selection.nativeId);
  const name = clean(selection.displayedOrganization);
  if (selection.outcome !== 'selected_unsaved' || !clean(selection.searchId) || !nativeId || !name ||
      !clean(selection.profileProofToken) || selection.nativeIdEvidence !== 'form_change_response' ||
      selection.selectedField?.name !== 'company' || clean(selection.selectedField.value) !== name) return undefined;
  return { nativeId, name, profileProofToken: clean(selection.profileProofToken) };
}

export function createSelectionProofTokensMatch(createFields, agency, organization, profileToken) {
  return Boolean(profileToken && [createFields, agency, organization].every((proof) =>
    !proof || proof.profileProofToken === profileToken));
}

function dates(arrival, departure, allowRealGuest = false) {
  const parse = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? d : null;
  };
  const start = parse(arrival), end = parse(departure);
  if (!start || !end || !validCreateDates(arrival, departure, allowRealGuest)) return null;
  const wire = (value) => `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`;
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const display = (d) => `${String(d.getUTCDate()).padStart(2, '0')}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
  return { arrivalWire: wire(arrival), departureWire: wire(departure), arrivalDisplay: display(start), departureDisplay: display(end) };
}

// Only native code/display pairs observed on the HRCEN selector are supported.
export function isSupportedLabtestGuarantee(value) {
  return typeof value === 'string' && Object.hasOwn(CREATE_GUARANTEES, value);
}

export function guaranteeDisplayForSave(guaranteeType, selection, requireSelection = false) {
  const display = CREATE_GUARANTEES[guaranteeType];
  if (!display) return null;
  if (guaranteeType === 'NGI' && !selection && !requireSelection) return display;
  if (!selection ||
      !['updated_unsaved', 'unchanged_unsaved'].includes(selection.outcome) ||
      selection.field !== 'guaranteeType' || selection.requested !== guaranteeType ||
      selection.actual?.value !== guaranteeType || selection.actual?.submitted !== guaranteeType ||
      selection.actual?.display !== display) return null;
  return display;
}

async function draft(page, expected) {
  return page.evaluate(({ origin, expected, partyFields, childBands }) => {
    if (location.origin !== origin ||
        /Infor HMS\s*-\s*([A-Z0-9]+)/i.exec(document.title)?.[1]?.toUpperCase() !== expected.propertyCode) return 'DRAFT_PROPERTY_CONTEXT';
    const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    if ([...document.querySelectorAll('.x-window:not(.x-menu)')].some((el) =>
      Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden'))) return 'DRAFT_OPEN_MODAL';
    const names = ['ta1', 'company', 'groupname', 'bacontract', 'confirmationnumber', 'guestid', 'firstname', 'lastname', 'arrivaldate', 'departuredate',
      'roomtype', 'rateplan', 'track', 'guaranteetype', 'reservationnote',
      'udfchkbox04', 'udfchar13', 'emailaddress',
      ...(expected.roomTypeForCharge !== undefined ? ['roomtypecharge'] : []),
      ...(expected.createFieldProof?.adults != null ? ['adults'] : []),
      ...(expected.createFieldProof?.childAges != null ? ['children'] : []),
      ...(expected.createFieldProof?.sourceBusiness ? ['sourceofbusinessdesc'] : []),
      ...(expected.createFieldProof?.cmsMessage != null ? ['udfchar09'] : []),
      ...(expected.createFieldProof?.reason ? ['reasonforstay'] : []),
      ...(expected.marketSegment ? ['marketsegment'] : []),
      ...(expected.guestOptIn !== undefined ? ['guestoptin4'] : []),
      ...(expected.booker?.name !== undefined ? ['caller'] : []),
      ...(expected.booker?.contact !== undefined ? ['udfchar06'] : []),
      ...(expected.billingPhase ? ['billingreference'] : []),
      ...(expected.nativeCommissionPercent !== undefined ? ['ta1commission'] : [])];
    const fields = Object.fromEntries(names.map((name) => [name, [...document.querySelectorAll('input,textarea,select')]
      .filter((el) => el.name === name && visible(el))]));
    if (names.some((name) => fields[name].length !== 1)) return 'DRAFT_VISIBLE_FIELDS';
    const cmp = (name) => globalThis.Ext?.getCmp?.(fields[name][0].id.replace(/-inputEl$/, ''));
    const form = cmp('guestid')?.up?.('form');
    const record = form?.getRecord?.(), data = record?.data, keys = data && Object.keys(data);
    if (!form?.el?.dom || !data || names.some((name) => !form.el.dom.contains(fields[name][0]))) return 'DRAFT_FORM_RECORD';
    if (expected.roomTypeForCharge === undefined) {
      const inputs = [...document.querySelectorAll('input,textarea,select')].filter(el =>
        el.name?.toLowerCase() === 'roomtypecharge' && visible(el));
      const modelKeys = keys.filter(key => key.toLowerCase() === 'roomtypecharge');
      if (inputs.length > 1 || inputs.some(el => el.name !== 'roomtypecharge' ||
          !form.el.dom.contains(el) || String(el.value ?? '').trim()) || modelKeys.length > 1 ||
          modelKeys.some(key => String(data[key] ?? '').trim())) return 'DRAFT_CHARGE_ROOM_VALUE';
    }
    const exact = (key, value) => Object.hasOwn(data, key) && keys.filter((k) => k.toLowerCase() === key.toLowerCase()).length === 1 &&
      String(data[key] ?? '').trim() === value;
    const value = (name) => ['reservationnote', 'billingreference'].includes(name) ? fields[name][0].value : fields[name][0].value.trim();
    const partyValues = expected.partyValues || {};
    const partyInputs = [...form.el.dom.querySelectorAll('input,textarea,select')].filter((el) =>
      visible(el) && partyFields.includes(el.name.toLowerCase()));
    const organizationName = expected.organizationSelection?.name ?? null;
    const partyValueAllowed = (name, actual) => name === 'companyname' && organizationName
      ? ['', organizationName].includes(actual) : actual === (partyValues[name] ?? '');
    if (partyFields.some((name) => {
      const actual = Object.hasOwn(data, name) ? String(data[name] ?? '').trim() : null;
      return actual === null || !partyValueAllowed(name, actual) ||
        keys.filter((key) => key.toLowerCase() === name).length !== 1 ||
        partyInputs.filter((el) => el.name.toLowerCase() === name).length > 1;
    }) ||
        partyInputs.some((el) => el.name !== el.name.toLowerCase() ||
          !partyValueAllowed(el.name.toLowerCase(), String(el.value ?? '').trim()))) return 'DRAFT_PARTY_FIELDS';
    if (!exact('propertycode', expected.propertyCode) || !exact('PKID', `@[EMPTY]#@[EMPTY]#${expected.propertyCode}#`) || !exact('status', 'New') ||
        !exact('guestid', expected.guestId) || !exact('firstname', expected.firstName) || !exact('lastname', expected.lastName) ||
        ['confirmationnumber', 'reservationid', 'reservationstayid', 'recordid'].some((name) => !exact(name, '')) ||
        (expected.arSelection && !exact('araccountid', expected.arSelection.nativeId)) ||
        (expected.arSelection ? !keys.includes('arprofileid') || keys.filter((key) => key.toLowerCase() === 'arprofileid').length !== 1 ||
          !String(data.arprofileid ?? '').trim() : false) ||
        !keys.includes('bookingsessionid') || keys.filter((k) => k.toLowerCase() === 'bookingsessionid').length !== 1 ||
        !String(data.bookingsessionid ?? '').trim()) return 'DRAFT_RESERVATION_MODEL';
    if (value('confirmationnumber') || value('guestid') !== expected.guestId ||
        value('firstname') !== expected.firstName || value('lastname') !== expected.lastName) return 'DRAFT_VISIBLE_PROFILE_FIELDS';
    if (value('arrivaldate') !== expected.arrivalDisplay || value('departuredate') !== expected.departureDisplay ||
        value('roomtype') !== expected.roomType ||
        (expected.roomTypeForCharge !== undefined && value('roomtypecharge') !== expected.roomTypeForCharge) ||
        value('rateplan') !== expected.ratePlan || !value('track') ||
        (expected.approvedTrack !== undefined && value('track') !== expected.approvedTrack) ||
        value('reservationnote') !== expected.note) return 'DRAFT_STAY_FIELDS';
    if (value('guaranteetype') !== expected.guaranteeDisplay ||
        cmp('guaranteetype')?.getValue?.() !== expected.guaranteeType ||
        (expected.requireGuaranteeSelection &&
          cmp('guaranteetype')?.getSubmitData?.()?.guaranteetype !== expected.guaranteeType)) return 'DRAFT_GUARANTEE';
    if ((expected.cmsRecipient !== undefined && value('udfchar13') !== expected.cmsRecipient) || typeof cmp('udfchkbox04')?.getValue !== 'function' ||
        cmp('udfchkbox04').getValue() !== expected.cmsSend) return 'DRAFT_PROFILE_PRIVACY_FIELDS';
    if ((expected.booker?.name !== undefined && value('caller') !== expected.booker.name) ||
        (expected.booker?.contact !== undefined && value('udfchar06') !== expected.booker.contact)) return 'DRAFT_REVIEWED_CONTACT_FIELDS';
    let guestOptInSubmitValue, guestOptInSubmitOmitted = false;
    if (expected.guestOptIn !== undefined) {
      const normalize = (value) => [true, 1, -1, '1', '-1', 'true'].includes(value) ? true :
        [false, 0, '0', 'false'].includes(value) ? false : null;
      const control = cmp('guestoptin4');
      if (typeof control?.getValue !== 'function' || typeof control.getSubmitData !== 'function' || control.up?.('form') !== form ||
          !(control.getXType?.() === 'checkboxfield' || fields.guestoptin4[0].type === 'checkbox') ||
          control.getValue() !== expected.guestOptIn || !Object.hasOwn(data, 'guestoptin4') ||
          keys.filter(key => key.toLowerCase() === 'guestoptin4').length !== 1 || normalize(data.guestoptin4) !== expected.guestOptIn) return 'DRAFT_GUEST_OPT_IN';
      const submittedData = control.getSubmitData();
      if (submittedData != null && (typeof submittedData !== 'object' || Array.isArray(submittedData))) return 'DRAFT_GUEST_OPT_IN';
      const submittedKeys = Object.keys(submittedData ?? {}).filter(key => key.toLowerCase() === 'guestoptin4');
      guestOptInSubmitOmitted = submittedKeys.length === 0;
      if (guestOptInSubmitOmitted ? expected.guestOptIn !== false :
          submittedKeys.length !== 1 || submittedKeys[0] !== 'guestoptin4' || normalize(submittedData.guestoptin4) !== expected.guestOptIn) return 'DRAFT_GUEST_OPT_IN';
      if (!guestOptInSubmitOmitted) guestOptInSubmitValue = String(submittedData.guestoptin4);
    }
    let activeChildCategories, modelData, formData;
    if (expected.strictCreateProof) {
      modelData = record.getData?.();
      const formValues = form.getForm?.()?.getValues?.();
      if (!modelData || typeof modelData !== 'object' || Array.isArray(modelData) ||
          !formValues || typeof formValues !== 'object' || Array.isArray(formValues)) return 'DRAFT_FORM_MODEL_SHAPE';
      const modelKeys = Object.keys(modelData), formValueKeys = Object.keys(formValues);
      const currentFormValue = (name) => {
        const matches = formValueKeys.filter((key) => key.toLowerCase() === name.toLowerCase());
        return matches.length === 1 ? { found: true, value: formValues[matches[0]] } : { found: false };
      };
      formData = Object.fromEntries(modelKeys.map((key) => [key, modelData[key]]));
      const copyCurrentFormValue = (name, current) => {
        const modelMatches = modelKeys.filter((key) => key.toLowerCase() === name.toLowerCase());
        if (!current.found || modelMatches.length !== 1) return false;
        formData[modelMatches[0]] = current.value;
        return true;
      };
      const override = (name, expectedValue) => {
        const current = currentFormValue(name);
        const value = String(current.value ?? '');
        return (name === 'reservationnote' ? value : value.trim()) === expectedValue && copyCurrentFormValue(name, current);
      };
      const nativeFormValue = (name) => {
        const current = currentFormValue(name), input = fields[name][0], component = cmp(name);
        const submitted = component?.getSubmitData?.();
        const submittedKeys = Object.keys(submitted || {}).filter((key) => key.toLowerCase() === name.toLowerCase());
        if (!current.found || !input || typeof component?.getValue !== 'function' || submittedKeys.length !== 1) return null;
        const value = String(current.value ?? '');
        return [input.value, component.getValue(), submitted[submittedKeys[0]]].every((item) => String(item ?? '') === value)
          ? current : null;
      };
      if (expected.nativeCommissionPercent !== undefined) {
        const name = 'ta1commission', input = fields[name][0], component = cmp(name);
        const current = currentFormValue(name), submitted = component?.getSubmitData?.();
        const submittedKeys = Object.keys(submitted || {}).filter(key => key.toLowerCase() === name);
        const number = value => value !== null && value !== undefined && String(value).trim() !== ''
          ? Number(value) : NaN;
        if (!current.found || !input || component?.up?.('form') !== form ||
            component.disabled || component.isDisabled?.() || component.readOnly || input.disabled || input.readOnly ||
            submittedKeys.length !== 1 || submittedKeys[0] !== name || typeof component.getValue !== 'function' ||
            [current.value, input.value, component.getValue(), submitted[name], data[name]].some(
              value => number(value) !== expected.nativeCommissionPercent) ||
            !copyCurrentFormValue(name, current)) return 'DRAFT_AGENCY_COMMISSION_VALUE';
      }
      if (expected.billingPhase) {
        const input = fields.billingreference[0], component = cmp('billingreference');
        const current = nativeFormValue('billingreference'), submitted = component?.getSubmitData?.();
        const maxLengths = [input.maxLength, component?.maxLength].filter((n) => Number.isFinite(n) && n >= 0);
        const errors = component?.getActiveErrors?.();
        const invalid = input.getAttribute?.('aria-invalid') === 'true' || (Array.isArray(errors) && errors.length > 0);
        if (!current || typeof current.value !== 'string' || component?.up?.('form') !== form ||
            component.getValue() !== current.value || input.value !== current.value ||
            !Object.hasOwn(submitted || {}, 'billingreference') || submitted.billingreference !== current.value ||
            component.disabled || component.isDisabled?.() || component.readOnly || input.disabled || input.readOnly ||
            maxLengths.some((n) => expected.billingReference.length > n) ||
            (invalid && (expected.billingPhase === 'after' || Boolean(current.value.trim()))) ||
            (expected.billingPhase === 'after' && current.value !== expected.billingReference) ||
            !copyCurrentFormValue('billingreference', current)) return 'DRAFT_BILLING_REFERENCE_VALUE';
      }
      // Agency selection can update native form controls without updating the model.
      // Bind only the two current commission controls, not unrelated form fields.
      if (expected.agencySelection) {
        const controls = form.getForm?.()?.getFields?.()?.items;
        if (!Array.isArray(controls)) return 'DRAFT_AGENCY_COMMISSION_VALUE';
        for (const name of ['bookingagencycommissionpricing', 'bookingagencycommissiontype']) {
          const current = currentFormValue(name);
          const matches = controls.filter((control) => control.getName?.() === name || control.name === name);
          if (!current.found || typeof current.value !== 'string' || matches.length !== 1) return 'DRAFT_AGENCY_COMMISSION_VALUE';
          const control = matches[0], submitted = control.getSubmitData?.();
          const keys = Object.keys(submitted || {}).filter((key) => key.toLowerCase() === name.toLowerCase());
          const modelMatches = modelKeys.filter((key) => key.toLowerCase() === name.toLowerCase());
          const controlValue = typeof control.getValue === 'function' ? control.getValue() : undefined;
          const emptyPricing = name === 'bookingagencycommissionpricing' && controlValue === null &&
            current.value === '' && submitted?.[name] === '' && modelMatches.length === 1 && modelData[modelMatches[0]] === '';
          if (control.up?.('form') !== form || control.disabled || control.isDisabled?.() ||
              typeof control.getValue !== 'function' || (controlValue !== current.value && !emptyPricing) ||
              keys.length !== 1 || !Object.hasOwn(submitted, name) || submitted[name] !== current.value ||
              !copyCurrentFormValue(name, current)) return 'DRAFT_AGENCY_COMMISSION_VALUE';
        }
      }
      const proof = expected.createFieldProof;
      if (expected.roomTypeForCharge !== undefined &&
          (!override('roomtypecharge', expected.roomTypeForCharge) || !nativeFormValue('roomtypecharge'))) {
        return 'DRAFT_CHARGE_ROOM_VALUE';
      }
      if (proof && proof.adults !== null && !override('adults', proof.adults)) return 'DRAFT_ADULT_MODEL';
      if (proof && proof.childAges !== null) {
        const childCount = String(proof.childAges.length);
        const ages = proof.childAges.join(',');
        const statuses = Object.keys(modelData).filter(name => /^child\d+status$/.test(name));
        const active = statuses.filter(name => modelData[name] === 'ACTIVE').map(name => name.slice(0, -6)).sort();
        if (!statuses.length || JSON.stringify(active) !== JSON.stringify([...childBands].sort())) return 'DRAFT_CHILD_CATEGORY_MODEL';
        if (!override('children', childCount) ||
            childBands.some((name) => !override(name, String(proof.childAgeBands[name])))) return 'DRAFT_CHILD_MODEL';
        if (!exact('childages', ages) || Array.isArray(data.childages)) return 'DRAFT_CHILD_AGES_MODEL';
        activeChildCategories = String(modelData.activechildcategories ?? '').trim();
        if (!exact('activechildcategories', activeChildCategories) || Number(activeChildCategories) !== childBands.length ||
            !exact('updatechildcategories', 'true')) return 'DRAFT_CHILD_CATEGORY_MODEL';
      }
      if (proof?.sourceBusiness &&
          (!exact('sourceofbus', proof.sourceBusiness.nativeCode) ||
            !exact('sourceofbusinessdesc', proof.sourceBusiness.description) ||
            value('sourceofbusinessdesc') !== proof.sourceBusiness.description)) return 'DRAFT_SOURCE_BUSINESS_MODEL';
      if (proof && proof.adults !== null && (value('adults') !== proof.adults ||
          String(cmp('adults')?.getValue?.() ?? '').trim() !== proof.adults)) return 'DRAFT_ADULT_VISIBLE_VALUE';
      if (proof && proof.childAges !== null && value('children') !== String(proof.childAges.length)) return 'DRAFT_CHILD_VISIBLE_VALUE';
      if (!override('reservationnote', expected.note) || !nativeFormValue('reservationnote')) return 'DRAFT_NOTE_SUBMIT_VALUE';
      for (const [name, requested] of [
        ...(expected.booker?.name !== undefined ? [['caller', expected.booker.name]] : []),
        ...(expected.booker?.contact !== undefined ? [['udfchar06', expected.booker.contact]] : []),
        ...(expected.cmsRecipient !== undefined ? [['udfchar13', expected.cmsRecipient]] : []),
      ]) if (!override(name, requested) || !nativeFormValue(name)) return 'DRAFT_REVIEWED_CONTACT_FIELDS';
      if (proof?.cmsMessage != null && (!override('udfchar09', proof.cmsMessage) || !nativeFormValue('udfchar09'))) return 'DRAFT_CMS_MESSAGE_VALUE';
      if (proof?.reason) {
        const component = cmp('reasonforstay');
        const submitted = component?.getSubmitData?.();
        if (value('reasonforstay') !== proof.reason.display || String(component?.getValue?.() ?? '') !== proof.reason.value ||
            String(submitted?.reasonforstay ?? '') !== proof.reason.value || !override('reasonforstay', proof.reason.value)) {
          return 'DRAFT_REASON_FOR_STAY_VALUE';
        }
      }
      if (expected.marketSegment) {
        const component = cmp('marketsegment');
        const submitted = component?.getSubmitData?.();
        if (value('marketsegment') !== expected.marketSegment.display ||
            String(component?.getValue?.() ?? '') !== expected.marketSegment.value ||
            String(submitted?.marketsegment ?? '') !== expected.marketSegment.value ||
            !override('marketsegment', expected.marketSegment.value)) return 'DRAFT_MARKET_SEGMENT_VALUE';
      }
      for (const [name, selected] of Object.entries(partyValues)) {
        if (organizationName && name === 'companyname') continue;
        if (!exact(name, selected)) return 'DRAFT_PARTY_MODEL';
      }
      if (organizationName && !['', organizationName].includes(String(data.companyname ?? '').trim())) return 'DRAFT_ORGANIZATION_MODEL';
    }
    const blankRequired = [...form.el.dom.querySelectorAll('input,textarea,select')].filter(visible).some((el) => {
      const component = el.id && globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      return component?.allowBlank === false && !String(el.value ?? '').trim() &&
        !(expected.billingPhase === 'before' && el === fields.billingreference?.[0]);
    });
    if (blankRequired) return 'DRAFT_REQUIRED_FIELDS';
    const verifiedPartyValues = { ...partyValues };
    if (expected.organizationSelection) verifiedPartyValues.companyname = String(data.companyname ?? '').trim();
    return { session: String(data.bookingsessionid).trim(), track: value('track'), guestEmail: value('emailaddress'),
      ...(expected.guestOptIn !== undefined ? { guestOptInSubmitOmitted, ...(guestOptInSubmitOmitted ? {} : { guestOptInSubmitValue }) } : {}),
      cmsRecipient: value('udfchar13'), arProfileId: String(data.arprofileid ?? '').trim(),
      arAccountId: String(data.araccountid ?? '').trim(), arAccountName: String(data.araccountname ?? '').trim(),
      ...(expected.strictCreateProof ? { ...(expected.createFieldProof?.childAges != null ? { activeChildCategories } : {}),
        ...(expected.billingPhase ? { visibleFields: [...form.el.dom.querySelectorAll('input,textarea,select')].filter(visible).map((el) => ({
          id: el.id, name: el.name, type: el.type, value: el.value, checked: el.checked, disabled: el.disabled, readOnly: el.readOnly,
        })) } : {}),
        modelData: Object.fromEntries(Object.keys(modelData).map((key) => [key, modelData[key]])),
        formData: Object.fromEntries(Object.keys(formData).map((key) => [key, formData[key]])), partyValues: verifiedPartyValues } : {}) };
  }, { origin: ORIGIN, expected, partyFields: Object.keys(expected.partyValues || {}),
    childBands: Object.keys(expected.createFieldProof?.childAgeBands ?? {}) });
}

export function guestStaySaveOutcome({
  dispatched, possiblyDispatched, httpStatus, hasConfirmation, nativeDialog, dialogs, blockedAfterDispatch,
}) {
  if (dispatched && httpStatus === 200 && hasConfirmation && !nativeDialog && dialogs === 0 && blockedAfterDispatch === 0) {
    return 'saved_same_form';
  }
  return possiblyDispatched ? 'uncertain' : 'not_dispatched';
}

function matchesGuestOptInSaveField(body, query, expected) {
  if (expected.guestOptIn === undefined) return true;
  const entries = params => [...params].filter(([key]) => key.toLowerCase() === 'guestoptin4');
  const bodyFields = entries(body), queryFields = entries(query);
  const matches = fields => fields.length === 1 && fields[0][0] === 'guestoptin4' &&
    (expected.guestOptIn === false ? ['0', 'false'].includes(fields[0][1]) :
      fields[0][1] === expected.guestOptInSubmitValue && ['1', '-1', 'true'].includes(fields[0][1]));
  if (bodyFields.length === 0 ? !(expected.guestOptIn === false && expected.guestOptInSubmitOmitted === true) : !matches(bodyFields)) return false;
  return (!queryFields.length || matches(queryFields)) &&
    (!bodyFields.length || !queryFields.length || bodyFields[0][1] === queryFields[0][1]);
}

function matchesSave(page, request, expected) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
    const proof = expected.createFieldProof;
    const childAgeFields = proof?.childAges != null ? {
      children: String(proof.childAges.length), childages: proof.childAges.join(','),
      ...Object.fromEntries(Object.entries(proof.childAgeBands).map(([name, count]) => [name, String(count)])),
      activechildcategories: expected.activeChildCategories,
      updatechildcategories: 'true',
    } : {};
    const required = {
      SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR',
      propertycode: expected.propertyCode, PKID: `@[EMPTY]#@[EMPTY]#${expected.propertyCode}#`, status: 'New',
      firstname: expected.firstName, lastname: expected.lastName,
      guestid: expected.guestId, bookingsessionid: expected.session, arrivaldate: expected.arrivalWire,
      departuredate: expected.departureWire, roomtype: expected.roomType,
      ...(expected.roomTypeForCharge !== undefined ? { roomtypecharge: expected.roomTypeForCharge } : {}),
      rateplan: expected.ratePlan, track: expected.track,
      ...(expected.marketSegment ? { marketsegment: expected.marketSegment.value } : {}),
      reservationnote: expected.note, confirmationnumber: '', reservationid: '', reservationstayid: '', recordid: '',
      udfchkbox04: expected.cmsSend ? '1' : '0', udfchar13: expected.cmsRecipient ?? '', emailaddress: expected.guestEmail,
      ...(expected.booker?.name !== undefined ? { caller: expected.booker.name } : {}),
      ...(expected.booker?.contact !== undefined ? { udfchar06: expected.booker.contact } : {}),
      ...(expected.billingReference !== undefined ? { billingreference: expected.billingReference } : {}),
      arprofileid: expected.arProfileId ?? '', araccountid: expected.arAccountId ?? '', araccountname: expected.arAccountName ?? '',
      guaranteetype: expected.guaranteeType, pagemode: 'display', savecctoprofile: '0', savesettlementcctoprofile: '0',
      ...(proof?.adults != null ? { adults: proof.adults } : {}),
      ...childAgeFields,
      ...(proof?.cmsMessage != null ? { udfchar09: proof.cmsMessage } : {}),
      ...(proof?.reason ? { reasonforstay: proof.reason.value } : {}),
      ...(proof?.sourceBusiness ? { sourceofbus: proof.sourceBusiness.nativeCode,
        sourceofbusinessdesc: proof.sourceBusiness.description } : {}),
      ...expected.partyValues,
    };
    const profileControls = ['newprofileclick', 'linkprofileflag', 'createinactiveprofileflag',
      'reqguestprofilelookup', 'linkedprofileflag'];
    const matchesRequest = validCreateDates(expected.arrival, expected.departure, expected.allowRealGuest) &&
      request.method() === 'POST' && request.frame() === page.mainFrame() && url.origin === ORIGIN &&
      url.pathname === SAVE_PATH && !url.hash && url.searchParams.getAll('pageaction').length === 1 &&
      url.searchParams.get('pageaction') === 'SAVE' &&
      ![...url.searchParams].some(([key, value]) => {
        if (key === 'pageaction') return false;
        const lower = key.toLowerCase();
        if (lower === 'pageaction' || lower === 'action') return true;
        const business = Object.entries(required).find(([name]) => name.toLowerCase() === lower);
        const queryCount = [...url.searchParams.keys()].filter(name => name.toLowerCase() === lower).length;
        return business ? queryCount !== 1 || value !== business[1] :
          body.has(key) && (body.getAll(key).length !== 1 || body.get(key) !== value);
      }) &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      matchesGuestOptInSaveField(body, url.searchParams, expected) &&
      isVerifiedLabtestProfileCurrent(page, { nativeId: expected.guestId, session: expected.session, token: expected.profileToken }) &&
      (!expected.arSelection || isVerifiedArSelectionCurrent(page, { session: expected.session, accountId: expected.arSelection.nativeId,
        profileId: expected.arProfileId, token: expected.arToken })) &&
      Object.entries(required).every(([key, value]) => body.getAll(key).length === 1 && body.get(key) === value &&
        keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1);
    if (!matchesRequest) return false;
    if (expected.nativeCommissionPercent !== undefined) {
      const commissionKeys = keys.filter(name => name.toLowerCase() === 'ta1commission');
      const raw = body.get('ta1commission');
      if (commissionKeys.length !== 1 || commissionKeys[0] !== 'ta1commission' || raw === null || !raw.trim() ||
          Number(raw) !== expected.nativeCommissionPercent) return false;
    }
    const chargeKeys = keys.filter(name => name.toLowerCase() === 'roomtypecharge');
    if (expected.roomTypeForCharge === undefined && (chargeKeys.length > 1 ||
        chargeKeys.some(name => name !== 'roomtypecharge' || clean(body.get(name))))) return false;
    if (expected.roomTypeForCharge !== undefined) {
      const priceFields = new Set(['averagerate', 'totalrate', 'averageratecurr', 'totalratecurr']);
      const fields = keys.filter(name => priceFields.has(name.toLowerCase()))
        .map(name => ({ name: name.toLowerCase(), value: body.getAll(name).length === 1 ? body.get(name) : null }));
      const pricing = compareChargeRoomPricing(fields, expected.checkedPricing);
      if (Object.values(pricing).some(value => value !== 'MATCHED')) return false;
      const occupancy = expected.checkedPricing?.occupancy;
      if (!occupancy || occupancy.adults == null || occupancy.children == null) return false;
      for (const [name, wanted] of Object.entries(occupancy)) {
        const values = [...body].filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
        if (wanted == null ? values.length > 1 || values.some(value => clean(value)) :
          values.length !== 1 || values[0] !== String(wanted)) return false;
      }
      const sources = [...body].filter(([key]) => key.toLowerCase() === 'sourceofbus').map(([, value]) => value);
      const sourceCode = expected.checkedPricing.sourceCode;
      if (sourceCode == null || sourceCode === '' ? sources.length > 1 || sources.some(value => clean(value)) :
        sources.length !== 1 || sources[0] !== String(sourceCode)) return false;
    }
    return profileControls.every((key) => {
      const matches = keys.filter((name) => name.toLowerCase() === key);
      return !matches.length || (matches.length === 1 && matches[0] === key && ['', '0'].includes(body.get(key)));
    });
  } catch { return false; }
}

function safeCreateContext(page) {
  try {
    const context = page.context();
    return context?._options?.serviceWorkers === 'block' && typeof context.serviceWorkers === 'function' &&
      context.serviceWorkers().length === 0;
  } catch { return false; }
}

// This covers route callbacks only; browser shutdown and HMS settlement need separate proof.
export async function finishLabtestCreateFence(result, routeChain, fence) {
  if (!routeChain) return result;
  let drained = false;
  try { drained = await routeChain.drain() === true; } catch { /* Keep an unknown outcome. */ }
  if (!drained) {
    try { fence?.quarantine(); } catch { /* The closed route remains disarmed. */ }
    return { ...result, outcome: 'uncertain', issue: 'SAVE_CALLBACK_DRAIN_UNCONFIRMED', dispatchCallbacksDrained: false };
  }
  return { ...result, dispatchCallbacksDrained: true };
}

/** The page is sealed after this action. Use a fresh guarded session for reconciliation. */
export async function saveNewLabtestStay(page, {
  propertyCode, preimageId, arrival, departure, guestId, roomType, roomTypeForCharge, ratePlan, guaranteeType, note, guaranteeSelection,
  createFieldProof, agencySelection, organizationSelection, arSelection, expectedArProfileId, billingReference, nativeCommissionPercent, track, marketSegment, guestOptIn, booker, cmsRecipient, cmsSend = false,
} = {}, { timeoutMs = 20_000, beforeSaveScreenshot, authorizeCandidate, dispatchCandidate,
  allowRealGuest = false, expectedGuest } = {}) {
  const guest = allowRealGuest ? expectedGuest : { firstName: 'Proof', lastName: 'Labtest' };
  if (typeof allowRealGuest !== 'boolean' || !validCreateGuest(guest) || (!allowRealGuest && !isLabtestGuest(guest)) ||
      (allowRealGuest && (typeof authorizeCandidate !== 'function' || typeof dispatchCandidate !== 'function'))) {
    return { outcome: 'input_gap', issue: 'SAVE_GUARD_CALLBACKS_INVALID' };
  }
  const formatted = dates(arrival, departure, allowRealGuest);
  if (!getPropertyRegistration(propertyCode)?.active || !formatted || !/^\d+$/.test(clean(guestId)) || !/^[A-Z0-9]{1,12}$/.test(roomType || '') ||
      (roomTypeForCharge !== undefined && !/^[A-Z0-9]{1,12}$/.test(roomTypeForCharge)) ||
      !/^[A-Z0-9]{1,12}$/.test(ratePlan || '') || !isSupportedLabtestGuarantee(guaranteeType) || !validCreateNote(note) ||
      !preimageId || (track !== undefined && (typeof track !== 'string' || !track.trim() || track !== track.trim())) ||
      (marketSegment !== undefined && (!marketSegment || typeof marketSegment !== 'object' || Array.isArray(marketSegment) ||
        !/^[A-Z0-9]{1,20}$/.test(marketSegment.value || '') || typeof marketSegment.display !== 'string' ||
        !marketSegment.display.trim() || marketSegment.display !== marketSegment.display.trim() || marketSegment.display.length > 200 ||
        /[\p{Cc}]/u.test(marketSegment.display))) ||
      (guestOptIn !== undefined && typeof guestOptIn !== 'boolean') || typeof cmsSend !== 'boolean' ||
      (cmsSend && (!allowRealGuest || isLabtestGuest(guest) || !cmsRecipient || !createFieldProof?.cmsMessageSelection)) ||
      (cmsRecipient !== undefined && (typeof cmsRecipient !== 'string' || cmsRecipient.length > 255 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cmsRecipient))) ||
      (booker !== undefined && (!booker || typeof booker !== 'object' || Array.isArray(booker) ||
        !Object.keys(booker).length || Object.keys(booker).some((key) => !['name', 'contact'].includes(key)) ||
        Object.entries(booker).some(([key, value]) => typeof value !== 'string' || !value || value !== value.trim() ||
          value.length > (key === 'name' ? 50 : 80) || [...value].some((character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))))) {
    return { outcome: 'input_gap', issue: 'INVALID_LABTEST_SAVE_INPUT' };
  }
  const requireGuaranteeSelection = allowRealGuest || guaranteeType !== 'NGI';
  const guaranteeDisplay = guaranteeDisplayForSave(guaranteeType, guaranteeSelection, requireGuaranteeSelection);
  if (!guaranteeDisplay) return { outcome: 'input_gap', issue: 'GUARANTEE_SELECTION_UNVERIFIED' };
  const createFieldProofProvided = createFieldProof !== undefined && createFieldProof !== null;
  const createFields = createFieldProofProvided ? normalizeCreateFieldProof(createFieldProof) : null;
  if (createFieldProofProvided && !createFields) return { outcome: 'input_gap', issue: 'CREATE_FIELD_PROOF_INVALID_OR_UNSUPPORTED' };
  const agencySelectionProvided = agencySelection !== undefined && agencySelection !== null;
  const agency = agencySelectionProvided ? normalizeAgencySelection(agencySelection) : null;
  if (agencySelectionProvided && !agency) return { outcome: 'input_gap', issue: 'AGENCY_SELECTION_UNVERIFIED' };
  if (nativeCommissionPercent !== undefined && (!agency || typeof nativeCommissionPercent !== 'number' ||
      !Number.isFinite(nativeCommissionPercent) || nativeCommissionPercent < 0 || nativeCommissionPercent > 100)) {
    return { outcome: 'input_gap', issue: 'AGENCY_COMMISSION_INVALID' };
  }
  const organizationSelectionProvided = organizationSelection !== undefined && organizationSelection !== null;
  const organization = organizationSelectionProvided ? normalizeOrganizationSelection(organizationSelection) : null;
  if (organizationSelectionProvided && !organization) return { outcome: 'input_gap', issue: 'ORGANIZATION_SELECTION_UNVERIFIED' };
  const arSelectionProvided = arSelection !== undefined && arSelection !== null;
  const ar = arSelectionProvided ? normalizeArSelection(arSelection) : null;
  if (arSelectionProvided && !ar) return { outcome: 'input_gap', issue: 'AR_SELECTION_UNVERIFIED' };
  if ((ar && (typeof expectedArProfileId !== 'string' || !/^\d{1,100}$/.test(expectedArProfileId))) ||
      (!ar && expectedArProfileId !== undefined)) return { outcome: 'input_gap', issue: 'AR_PROFILE_ID_REQUIRED' };
  const hasBillingReference = billingReference !== undefined;
  if (hasBillingReference && (!validCreateBillingReference(billingReference) || !ar)) {
    return { outcome: 'input_gap', issue: 'BILLING_REFERENCE_OR_AR_INVALID' };
  }
  if (beforeSaveScreenshot !== undefined && typeof beforeSaveScreenshot !== 'function') {
    return { outcome: 'input_gap', issue: 'SCREENSHOT_CALLBACK_INVALID' };
  }
  if ((authorizeCandidate !== undefined && typeof authorizeCandidate !== 'function') ||
      (dispatchCandidate !== undefined && typeof dispatchCandidate !== 'function') ||
      ((authorizeCandidate === undefined) !== (dispatchCandidate === undefined))) {
    return { outcome: 'input_gap', issue: 'SAVE_GUARD_CALLBACKS_INVALID' };
  }
  const strictCreateProof = Boolean(createFields || agency || organization || ar || authorizeCandidate || requireGuaranteeSelection || roomTypeForCharge !== undefined ||
    track !== undefined || marketSegment !== undefined || guestOptIn !== undefined || booker !== undefined || cmsRecipient !== undefined || nativeCommissionPercent !== undefined);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { outcome: 'input_gap', issue: 'INVALID_TIMEOUT' };
  if (!safeCreateContext(page)) return { outcome: 'refused', issue: 'BROWSER_CONTEXT_UNSAFE' };
  if (usedPages.has(page)) return { outcome: 'refused', issue: 'PAGE_WRITE_ALREADY_USED' };
  let dispatched = false, possiblyDispatched = false, requestSeen = false, blocked = 0, blockedAtDispatch = 0;
  let sendRequests = 0, nativeDialog = null, response = null, armed = false, stopReason = null;
  let authorizedRequest, scope, fence, routeChain, signalStop, blockedRequest, finishedResult;
  let billingAttempted = false, billingStaged = false, checkedPricing = null;
  const observedBlocked = new WeakSet();
  const stopped = new Promise((resolve) => { signalStop = resolve; });
  const stop = (issue) => {
    stopReason ||= issue;
    armed = false;
    routeChain?.disarm();
    fence?.quarantine();
    if (billingAttempted && !possiblyDispatched) {
      try { Promise.resolve(page.close({ runBeforeUnload: false })).catch(() => {}); } catch { /* Discard page. */ }
    }
    signalStop({ issue: stopReason });
  };
  const bounded = async (action) => {
    const result = await Promise.race([Promise.resolve(action).then((value) => ({ value })), stopped]);
    if (result.issue) throw new Error(result.issue);
    return result.value;
  };
  const timer = setTimeout(() => stop('SAVE_TIMEOUT'), timeoutMs);
  const onDialog = (dialog) => { nativeDialog = { type: dialog.type(), message: dialog.message() }; stop('UNEXPECTED_DIALOG'); };
  page.on('dialog', onDialog);
  try {
    if (await bounded(page.locator('.x-window:visible:not(.x-menu)').count())) throw new Error('UNEXPECTED_DIALOG');
    const partyValues = Object.fromEntries(CREATE_PARTY_FIELDS.map((name) => [name, '']));
    if (agency) Object.assign(partyValues, {
      taid1: agency.nativeId, ta1: agency.name,
    });
    if (organization) Object.assign(partyValues, { companyid: organization.nativeId, company: organization.name });
    if (ar) partyValues.araccountname = ar.name;
    else if (isLabtestGuest(guest)) partyValues.araccountname = '';
    const expected = { ...formatted, propertyCode, arrival, departure, allowRealGuest, ...guest, requireGuaranteeSelection,
      guestId: clean(guestId), roomType, roomTypeForCharge, ratePlan, guaranteeType, guaranteeDisplay, note,
      ...(track !== undefined ? { approvedTrack: track } : {}), ...(marketSegment !== undefined ? { marketSegment } : {}),
      ...(guestOptIn !== undefined ? { guestOptIn } : {}),
      ...(booker !== undefined ? { booker } : {}), ...(cmsRecipient !== undefined ? { cmsRecipient } : {}), cmsSend,
      ...(createFields ? { createFieldProof: createFields } : {}),
      ...(agency ? { agencySelection: agency } : {}), ...(organization ? { organizationSelection: organization } : {}),
      ...(nativeCommissionPercent !== undefined ? { nativeCommissionPercent } : {}),
      ...(ar ? { arSelection: ar } : {}), ...(hasBillingReference ? { billingReference, billingPhase: 'before' } : {}),
      strictCreateProof, partyValues };
    let state = await bounded(draft(page, expected));
    if (typeof state === 'string') throw Object.assign(new Error('LABTEST_DRAFT_UNVERIFIED'), { draftCheck: state });
    if (!state) throw new Error('LABTEST_DRAFT_UNVERIFIED');
    if (ar && state.arProfileId !== expectedArProfileId) throw new Error('AR_PROFILE_CHANGED');
    const profileToken = await bounded(verifiedLabtestProfileToken(page, { nativeId: expected.guestId, session: state.session }));
    if (!profileToken) throw new Error('LABTEST_PROFILE_PROOF_STALE');
    if (!createSelectionProofTokensMatch(createFields, agency, organization, profileToken)) throw new Error('CREATE_SELECTION_PROOF_STALE');
    if (roomTypeForCharge !== undefined) {
      checkedPricing = await bounded(checkedChargeRateEvidence(page,
        { roomTypeForCharge, roomType, ratePlan, arrival, departure })).catch(() => null);
      if (!checkedPricing) throw new Error('CHARGE_ROOM_PRICE_RECHECK_REQUIRED');
      if (!/^[A-Z]{3}$/.test(checkedPricing.currency || '')) throw new Error('CHARGE_ROOM_CURRENCY_UNVERIFIED');
    }
    const arToken = ar ? await bounded(verifiedArSelectionToken(page, { session: state.session, accountId: ar.nativeId,
      profileId: state.arProfileId })) : null;
    if (ar && !arToken) throw new Error('AR_SELECTION_PROOF_STALE');
    Object.assign(expected, state, { profileToken, arToken });
    if (!safeCreateContext(page)) throw new Error('BROWSER_CONTEXT_UNSAFE');
    fence = await bounded(installPageRequestFence(page, [SAVE_PATH]));
    scope = fence.open();
    if (!consumeLabtestPreimage(page, { preimageId, arrival, departure, propertyCode, ...guest })) throw new Error('PREIMAGE_STALE_OR_MISMATCHED');
    const routeSetup = installLabtestCreateSaveRouteChain(page, {
      frame: page.mainFrame(),
      fence,
      scope,
      isArmed: () => armed && !nativeDialog,
      ...(authorizeCandidate ? { authorizeCandidate, dispatchCandidate } : {}),
      matches: (request) => matchesSave(page, request, expected),
      onCandidate: (request) => {
        authorizedRequest = request;
        requestSeen = true;
        possiblyDispatched = true;
      },
      onDispatch: (request) => {
        if (request === authorizedRequest) {
          dispatched = true;
          blockedAtDispatch = blocked;
          armed = false;
        }
      },
      onBlocked: (request) => {
        if (observedBlocked.has(request)) return;
        observedBlocked.add(request);
        blocked += 1;
        if (hasBillingReference && !possiblyDispatched) stop('BILLING_UNEXPECTED_REQUEST_BLOCKED');
        try {
          if (/send|email|mail/i.test(new URL(request.url()).pathname)) sendRequests += 1;
        } catch { /* Do not expose or retry malformed request targets. */ }
      },
    }).then(async (chain) => {
      if (stopReason) {
        // A registration that completes after the deadline may not grant its
        // exception. Retain only the deny routes and prevent page reuse.
        usedPages.add(page);
        chain.disarm();
        await chain.close();
        return null;
      }
      return chain;
    });
    routeChain = await bounded(routeSetup);
    if (!routeChain) throw new Error(stopReason || 'SAVE_TIMEOUT');
    usedPages.add(page);
    if (hasBillingReference) {
      const requireCurrent = () => {
        if (stopReason) throw new Error(stopReason);
        if (!safeCreateContext(page) || !isVerifiedLabtestProfileCurrent(page, {
          nativeId: expected.guestId, session: expected.session, token: profileToken,
        }) || !isVerifiedArSelectionCurrent(page, { session: expected.session, accountId: ar.nativeId,
          profileId: state.arProfileId, token: arToken })) {
          stop('BILLING_DRAFT_PROOF_STALE'); throw new Error('BILLING_DRAFT_PROOF_STALE');
        }
      };
      const verifyRecords = async () => {
        requireCurrent();
        const currentProfile = await bounded(verifiedLabtestProfileToken(page, { nativeId: expected.guestId, session: expected.session }));
        requireCurrent();
        const currentAr = await bounded(verifiedArSelectionToken(page, { session: expected.session, accountId: ar.nativeId,
          profileId: state.arProfileId }));
        requireCurrent();
        if (currentProfile !== profileToken || currentAr !== arToken) {
          stop('BILLING_DRAFT_PROOF_STALE'); throw new Error('BILLING_DRAFT_PROOF_STALE');
        }
      };
      const before = state;
      requireCurrent();
      const control = page.locator('input[name="billingreference"]:visible, textarea[name="billingreference"]:visible');
      if (await bounded(control.count()) !== 1 || !await bounded(control.isEditable())) throw new Error('BILLING_FIELD_NOT_EDITABLE');
      requireCurrent();
      billingAttempted = true;
      await bounded(control.fill(billingReference, { timeout: 5_000 }));
      requireCurrent();
      await bounded(control.press('Tab', { timeout: 5_000 }));
      requireCurrent();
      // Retain the guarded blur observation before rechecking the billing-only
      // draft and identity proofs; input equality alone is insufficient.
      await bounded(page.waitForTimeout(1000));
      requireCurrent();
      expected.billingPhase = 'after';
      state = await bounded(draft(page, expected));
      if (typeof state === 'string') throw Object.assign(new Error('LABTEST_DRAFT_UNVERIFIED'), { draftCheck: state });
      if (!state || !billingOnlyDraftChange(before, state, billingReference)) {
        throw new Error('BILLING_DRAFT_CHANGED');
      }
      await verifyRecords();
      if (beforeSaveScreenshot) await bounded(beforeSaveScreenshot());
      requireCurrent();
      const finalState = await bounded(draft(page, expected));
      if (!finalState || typeof finalState === 'string' || !billingOnlyDraftChange(state, finalState, billingReference)) {
        throw new Error('BILLING_DRAFT_CHANGED');
      }
      await verifyRecords();
      Object.assign(expected, finalState);
      billingStaged = true;
    }
    const pending = page.waitForResponse((item) => item.request() === authorizedRequest, { timeout: timeoutMs }).catch(() => null);
    const save = page.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
    if (await bounded(save.count()) !== 1) throw new Error('SAVE_CONTROL_NOT_UNIQUE');
    if (hasBillingReference && await bounded(page.locator('.x-window:visible:not(.x-menu)').count())) {
      throw new Error('UNEXPECTED_DIALOG');
    }
    if (roomTypeForCharge !== undefined) {
      checkedPricing = await bounded(checkedChargeRateEvidence(page, { roomTypeForCharge, roomType, ratePlan, arrival, departure }));
      if (!checkedPricing) throw new Error('CHARGE_ROOM_PRICE_RECHECK_REQUIRED');
      if (!/^[A-Z]{3}$/.test(checkedPricing.currency || '')) throw new Error('CHARGE_ROOM_CURRENCY_UNVERIFIED');
      expected.checkedPricing = checkedPricing;
    }
    armed = true;
    await bounded(save.click({ timeout: 5_000, noWaitAfter: true }));
    response = await bounded(pending);
    armed = false;
    if (response?.status() === 200 && !nativeDialog) {
      // The native response can precede the server wrapper's commit. A late
      // wrapper error is uncertain, not a successful Save.
      if (!await bounded(routeChain.waitForDispatch())) throw new Error('SAVE_DISPATCH_UNCERTAIN');
      await bounded(page.waitForFunction(() => {
        const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
        const confirmations = [...document.querySelectorAll('input[name="confirmationnumber"]')].filter(visible);
        return confirmations.length === 1 && Boolean(confirmations[0].value.trim());
      }, null, { timeout: timeoutMs }).catch(() => null));
    }
    const snapshot = await bounded(page.evaluate(() => {
      const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
      const value = (name) => { const els = [...document.querySelectorAll(`input[name="${name}"]`)].filter(visible); return els.length === 1 ? els[0].value.trim() : null; };
      return { confirmation: value('confirmationnumber'), status: value('status') };
    }).catch(() => ({ confirmation: null, status: null })));
    const dialogs = await bounded(page.locator('.x-window:visible:not(.x-menu)').allTextContents().catch(() => []));
    const httpStatus = response?.status() || null;
    const blockedAfterDispatch = Math.max(0, blocked - blockedAtDispatch);
    finishedResult = { outcome: guestStaySaveOutcome({ dispatched, possiblyDispatched, httpStatus,
      hasConfirmation: Boolean(requestSeen && snapshot.confirmation), nativeDialog, dialogs: dialogs.length, blockedAfterDispatch }),
      confirmation: snapshot.confirmation || null, status: snapshot.status || null, httpStatus: response?.status() || null,
      requestSeen, blockedRequests: blocked, blockedRequestsAfterDispatch: blockedAfterDispatch,
      browserSendRequests: sendRequests, nativeDialog, dialogs, ...(ar ? { arProfileId: state.arProfileId } : {}),
      ...(checkedPricing ? { checkedPricing } : {}),
      ...(billingStaged ? { billingReferenceStaged: true } : {}),
      ...(blockedRequest ? { blockedRequest } : {}) };
  } catch (error) {
    armed = false;
    if (possiblyDispatched || billingAttempted) fence?.quarantine();
    if (billingAttempted && !possiblyDispatched && !stopReason) stop('BILLING_ACTION_UNCERTAIN');
    const draftCheck = safeDraftCheck(error?.draftCheck);
    finishedResult = { outcome: possiblyDispatched ? 'uncertain' : 'not_dispatched', issue: safeIssue(error),
      ...(draftCheck ? { draftCheck } : {}),
      requestSeen, httpStatus: response?.status() || null, blockedRequests: blocked,
      blockedRequestsAfterDispatch: Math.max(0, blocked - blockedAtDispatch),
      ...(checkedPricing ? { checkedPricing } : {}),
      browserSendRequests: sendRequests, nativeDialog, ...(blockedRequest ? { blockedRequest } : {}) };
  } finally {
    clearTimeout(timer);
    armed = false;
    routeChain?.disarm();
    scope?.close();
    finishedResult = await finishLabtestCreateFence(finishedResult, routeChain, fence);
    await routeChain?.close();
    if (!nativeDialog && !usedPages.has(page)) page.off('dialog', onDialog);
  }
  return finishedResult;
}
