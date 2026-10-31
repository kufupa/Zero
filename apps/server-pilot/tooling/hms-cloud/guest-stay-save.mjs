// One narrowly authorized save on a verified, unsaved HRCEN Labtest draft.
import { createHash } from 'node:crypto';
import { verifiedLabtestProfileToken, isVerifiedLabtestProfileCurrent } from './guest-profile.mjs';
import { consumeLabtestPreimage } from './labtest-preimage.mjs';
import { blankPartyFields } from './labtest-party-fields.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';
import { installLabtestSaveRouteChain as installLabtestCreateSaveRouteChain } from './saved-stay-save-route-chain.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const SAVE_PATH = '/web/base/OSRESV.HDR';
const usedPages = new WeakSet();
const clean = (value) => String(value ?? '').trim();
const safeIssue = (error) => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'SAVE_UNVERIFIED';
const CHILD_BANDS = Object.freeze(['child1', 'child2', 'child3']);
// Exact body/model equality does not classify newly added fields or their write effects.
const CREATE_MODEL_FIELD_COUNT = 985;
// SHA-256 of the captured 988-key request's field set, excluding its three
// fixed controls.
const CREATE_MODEL_FIELD_KEYS_SHA256 = '03a9432f20d5b59c1cc7daee4e519639b82b978d1e78b2de110964a98828292e';

function matchesCreateModelFieldSchema(formData) {
  if (!formData || typeof formData !== 'object' || Array.isArray(formData)) return false;
  const keys = Object.keys(formData).sort();
  return keys.length === CREATE_MODEL_FIELD_COUNT &&
    createHash('sha256').update(keys.join('\n')).digest('hex') === CREATE_MODEL_FIELD_KEYS_SHA256;
}

function numericZero(value) {
  const text = String(value ?? '').trim();
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) && Number(text) === 0;
}

function normalizeChildSelection(selection) {
  if (!selection || !['updated_unsaved', 'unchanged_unsaved'].includes(selection.outcome) ||
      !Array.isArray(selection.requestedChildAges) || !Array.isArray(selection.actualChildAges) ||
      !selection.requestedChildAges.every((age) => Number.isInteger(age) && age >= 0 && age <= 17) ||
      !selection.actualChildAges.every((age) => Number.isInteger(age) && age >= 0 && age <= 17) ||
      !clean(selection.profileProofToken) ||
      JSON.stringify(selection.requestedChildAges) !== JSON.stringify(selection.actualChildAges)) return null;
  const counts = selection.ageBandCounts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts) ||
      JSON.stringify(Object.keys(counts).sort()) !== JSON.stringify([...CHILD_BANDS].sort()) ||
      CHILD_BANDS.some((name) => !Number.isInteger(counts[name]) || counts[name] < 0) ||
      CHILD_BANDS.reduce((sum, name) => sum + counts[name], 0) !== selection.actualChildAges.length) return null;
  return { ages: [...selection.actualChildAges], bands: Object.fromEntries(CHILD_BANDS.map((name) => [name, counts[name]])),
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
  const allowed = ['adultSelection', 'childAgeSelection', 'sourceSelection'];
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) ||
      Object.keys(proof).some((key) => !allowed.includes(key)) ||
      !allowed.some((key) => Object.hasOwn(proof, key))) return null;
  const adult = Object.hasOwn(proof, 'adultSelection') ? normalizeAdultSelection(proof.adultSelection) : null;
  const child = Object.hasOwn(proof, 'childAgeSelection') ? normalizeChildSelection(proof.childAgeSelection) : null;
  const source = Object.hasOwn(proof, 'sourceSelection') ? normalizeSourceSelection(proof.sourceSelection) : null;
  if ((Object.hasOwn(proof, 'adultSelection') && !adult) ||
      (Object.hasOwn(proof, 'childAgeSelection') && !child) ||
      (Object.hasOwn(proof, 'sourceSelection') && !source)) return null;
  const tokens = [adult?.profileProofToken, child?.profileProofToken, source?.profileProofToken].filter(Boolean);
  if (!tokens.length || tokens.some((token) => token !== tokens[0])) return null;
  return { adults: adult?.adults ?? null, childAges: child?.ages ?? null,
    childAgeBands: child?.bands ?? null, sourceBusiness: source,
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

function normalizeOrganizationSelection(selection) {
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

function dates(arrival, departure) {
  const parse = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? d : null;
  };
  const start = parse(arrival), end = parse(departure);
  if (!start || !end || arrival < '2027-01-01' || arrival >= departure) return null;
  const wire = (value) => `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`;
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const display = (d) => `${String(d.getUTCDate()).padStart(2, '0')}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
  return { arrivalWire: wire(arrival), departureWire: wire(departure), arrivalDisplay: display(start), departureDisplay: display(end) };
}

async function draft(page, expected) {
  return page.evaluate(({ origin, expected, blankPartyFields, childBands }) => {
    if (location.origin !== origin || !/Infor HMS\s*-\s*HRCEN/i.test(document.title)) return null;
    const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const names = ['ta1', 'company', 'groupname', 'bacontract', 'confirmationnumber', 'guestid', 'firstname', 'lastname', 'arrivaldate', 'departuredate',
      'roomtype', 'rateplan', 'track', 'guaranteetype', 'reservationnote',
      ...(expected.strictCreateProof ? ['revenuevalue', 'nightsvalue'] : []), 'udfchkbox04', 'udfchar13', 'emailaddress',
      ...(expected.createFieldProof?.adults != null ? ['adults'] : []),
      ...(expected.createFieldProof?.childAges != null ? ['children', ...childBands] : []),
      ...(expected.createFieldProof?.sourceBusiness ? ['sourceofbusinessdesc'] : [])];
    const fields = Object.fromEntries(names.map((name) => [name, [...document.querySelectorAll('input,textarea,select')]
      .filter((el) => el.name === name && visible(el))]));
    if (names.some((name) => fields[name].length !== 1)) return null;
    const cmp = (name) => globalThis.Ext?.getCmp?.(fields[name][0].id.replace(/-inputEl$/, ''));
    const form = cmp('guestid')?.up?.('form');
    const record = form?.getRecord?.(), data = record?.data, keys = data && Object.keys(data);
    if (!form?.el?.dom || !data || names.some((name) => !form.el.dom.contains(fields[name][0]))) return null;
    const exact = (key, value) => Object.hasOwn(data, key) && keys.filter((k) => k.toLowerCase() === key.toLowerCase()).length === 1 &&
      String(data[key] ?? '').trim() === value;
    const value = (name) => name === 'reservationnote' ? fields[name][0].value : fields[name][0].value.trim();
    const partyValues = expected.partyValues || {};
    const partyInputs = [...form.el.dom.querySelectorAll('input,textarea,select')].filter((el) =>
      visible(el) && blankPartyFields.includes(el.name.toLowerCase()));
    const organizationName = expected.organizationSelection?.name ?? null;
    const partyValueAllowed = (name, actual) => name === 'companyname' && organizationName
      ? ['', organizationName].includes(actual) : actual === (partyValues[name] ?? '');
    if (blankPartyFields.some((name) => {
      const actual = Object.hasOwn(data, name) ? String(data[name] ?? '').trim() : null;
      return actual === null || !partyValueAllowed(name, actual) ||
        keys.filter((key) => key.toLowerCase() === name).length !== 1 ||
        partyInputs.filter((el) => el.name.toLowerCase() === name).length > 1;
    }) ||
        partyInputs.some((el) => el.name !== el.name.toLowerCase() ||
          !partyValueAllowed(el.name.toLowerCase(), String(el.value ?? '').trim()))) return null;
    if (!exact('propertycode', 'HRCEN') || !exact('PKID', '@[EMPTY]#@[EMPTY]#HRCEN#') || !exact('status', 'New') ||
        !exact('guestid', expected.guestId) || !exact('firstname', 'Proof') || !exact('lastname', 'Labtest') ||
        ['confirmationnumber', 'reservationid', 'reservationstayid', 'recordid', 'arprofileid', 'araccountid',
          'guaranteecreditcardid', 'leaseguaranteecreditcardid'].some((name) => !exact(name, '')) ||
        !keys.includes('bookingsessionid') || keys.filter((k) => k.toLowerCase() === 'bookingsessionid').length !== 1 ||
        !String(data.bookingsessionid ?? '').trim() || value('confirmationnumber') || value('guestid') !== expected.guestId ||
        value('firstname') !== 'Proof' || value('lastname') !== 'Labtest' || value('arrivaldate') !== expected.arrivalDisplay ||
        value('departuredate') !== expected.departureDisplay || value('roomtype') !== expected.roomType ||
        value('rateplan') !== expected.ratePlan || !value('track') || value('reservationnote') !== expected.note ||
        value('guaranteetype') !== 'Non-Guaranteed Individual' || cmp('guaranteetype')?.getValue?.() !== expected.guaranteeType ||
        value('udfchar13') || value('emailaddress') || typeof cmp('udfchkbox04')?.getValue !== 'function' ||
        cmp('udfchkbox04').getValue() !== false) return null;
    let activeChildCategories, modelData, formData;
    if (expected.strictCreateProof) {
      modelData = record.getData?.();
      const formValues = form.getForm?.()?.getValues?.();
      if (!modelData || typeof modelData !== 'object' || Array.isArray(modelData) ||
          !formValues || typeof formValues !== 'object' || Array.isArray(formValues)) return null;
      const modelKeys = Object.keys(modelData), formValueKeys = Object.keys(formValues);
      if (formValueKeys.some((key) => !modelKeys.includes(key)) ||
          formValueKeys.some((key) => formValueKeys.filter((candidate) => candidate.toLowerCase() === key.toLowerCase()).length !== 1)) return null;
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
      const proof = expected.createFieldProof;
      if (proof && proof.adults !== null && !override('adults', proof.adults)) return null;
      if (proof && proof.childAges !== null) {
        const childCount = String(proof.childAges.length);
        const ages = proof.childAges.join(',');
        if (!override('children', childCount) ||
            childBands.some((name) => !override(name, String(proof.childAgeBands[name])))) return null;
        if (!exact('childages', ages) || Array.isArray(data.childages)) return null;
        activeChildCategories = String(modelData.activechildcategories ?? '').trim();
        if (!exact('activechildcategories', activeChildCategories) || !exact('updatechildcategories', 'true')) return null;
      }
      if (proof?.sourceBusiness &&
          (!exact('sourceofbus', proof.sourceBusiness.nativeCode) ||
            !exact('sourceofbusinessdesc', proof.sourceBusiness.description) ||
            value('sourceofbusinessdesc') !== proof.sourceBusiness.description)) return null;
      if (proof && proof.adults !== null && (value('adults') !== proof.adults ||
          String(cmp('adults')?.getValue?.() ?? '').trim() !== proof.adults)) return null;
      if (proof && proof.childAges !== null && (value('children') !== String(proof.childAges.length) ||
          childBands.some((name) => value(name) !== String(proof.childAgeBands[name])))) return null;
      if (proof?.sourceBusiness && value('sourceofbusinessdesc') !== proof.sourceBusiness.description) return null;
      if (!override('reservationnote', expected.note) || !nativeFormValue('reservationnote')) return null;
      const modelNumber = (name) => {
        const matches = modelKeys.filter((key) => key.toLowerCase() === name.toLowerCase());
        if (matches.length !== 1) return null;
        const value = String(modelData[matches[0]] ?? '').trim();
        return /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? Number(value) : null;
      };
      const formNumber = (current) => {
        if (!current) return null;
        const value = String(current.value ?? '').trim();
        return /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? Number(value) : null;
      };
      const revenueValue = nativeFormValue('revenuevalue');
      const revenueModel = modelNumber('revenuevalue'), revenueForm = formNumber(revenueValue);
      if (!revenueValue || !fields.revenuevalue[0].readOnly || revenueModel !== 0 || revenueForm !== revenueModel ||
          !copyCurrentFormValue('revenuevalue', revenueValue)) return null;
      // This is the selected guest's read-only Lifetime Nights field, not this stay's duration.
      // The exact arrival/departure inputs and POST fields below establish the stay dates.
      const lifetimeNights = nativeFormValue('nightsvalue');
      const lifetimeModel = modelNumber('nightsvalue'), lifetimeForm = formNumber(lifetimeNights);
      const lifetimeLabel = fields.nightsvalue[0].closest('.x-form-item, .x-field')?.querySelector('label')?.innerText ??
        cmp('nightsvalue')?.getFieldLabel?.() ?? '';
      if (!lifetimeNights || !fields.nightsvalue[0].readOnly ||
          String(lifetimeLabel).replace(/\s*:\s*$/, '').trim().toLowerCase() !== 'lifetime nights' ||
          !Number.isSafeInteger(lifetimeModel) || lifetimeModel < 0 || lifetimeForm !== lifetimeModel ||
          !copyCurrentFormValue('nightsvalue', lifetimeNights)) return null;
      for (const [name, selected] of Object.entries(partyValues)) {
        if (organizationName && name === 'companyname') continue;
        if (!exact(name, selected)) return null;
      }
      if (organizationName && !['', organizationName].includes(String(data.companyname ?? '').trim())) return null;
    }
    const blankRequired = [...form.el.dom.querySelectorAll('input,textarea,select')].filter(visible).some((el) => {
      const component = el.id && globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      return component?.allowBlank === false && !String(el.value ?? '').trim();
    });
    if (blankRequired) return null;
    const verifiedPartyValues = { ...partyValues };
    if (expected.organizationSelection) verifiedPartyValues.companyname = String(data.companyname ?? '').trim();
    return { session: String(data.bookingsessionid).trim(), track: value('track'),
      ...(expected.strictCreateProof ? { ...(expected.createFieldProof?.childAges != null ? { activeChildCategories } : {}),
        modelData: Object.fromEntries(Object.keys(modelData).map((key) => [key, modelData[key]])),
        formData: Object.fromEntries(Object.keys(formData).map((key) => [key, formData[key]])), partyValues: verifiedPartyValues } : {}) };
  }, { origin: ORIGIN, expected, blankPartyFields, childBands: CHILD_BANDS });
}

export function matchesFullCreateBody(body, formData) {
  if (!formData || typeof formData !== 'object' || Array.isArray(formData)) return false;
  const fields = Object.keys(formData);
  const controls = { SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR' };
  const expectedKeys = [...fields, ...Object.keys(controls)], expected = new Set(expectedKeys), keys = [...body.keys()];
  if (expected.size !== expectedKeys.length || keys.length !== expected.size || new Set(keys).size !== keys.length ||
      keys.some((key) => !expected.has(key))) return false;
  return Object.entries(controls).every(([key, value]) => body.getAll(key).length === 1 && body.get(key) === value) &&
    fields.every((key) => {
      let value = formData[key];
      if (key === 'sessionID' && value && typeof value === 'object' && Object.keys(value).length === 1 &&
          typeof value.sessionID === 'string') value = value.sessionID;
      else if (value != null && !['string', 'number', 'boolean'].includes(typeof value)) return false;
      return body.getAll(key).length === 1 && (key === 'revenuevalue'
        ? numericZero(value) && numericZero(body.get(key))
        : body.get(key) === String(value ?? ''));
    });
}

export function guestStaySaveOutcome({
  dispatched, possiblyDispatched, httpStatus, hasConfirmation, nativeDialog, dialogs, blockedAfterDispatch,
}) {
  if (dispatched && httpStatus === 200 && hasConfirmation && !nativeDialog && dialogs === 0 && blockedAfterDispatch === 0) {
    return 'saved_same_form';
  }
  return possiblyDispatched ? 'uncertain' : 'not_dispatched';
}

function matchesSave(page, request, expected) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
    const proof = expected.createFieldProof;
    const childAgeFields = proof?.childAges != null ? {
      children: String(proof.childAges.length), childages: proof.childAges.join(','),
      child1: String(proof.childAgeBands.child1), child2: String(proof.childAgeBands.child2),
      child3: String(proof.childAgeBands.child3), activechildcategories: expected.activeChildCategories,
      updatechildcategories: 'true',
    } : {};
    const required = {
      SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR',
      propertycode: 'HRCEN', PKID: '@[EMPTY]#@[EMPTY]#HRCEN#', status: 'New', firstname: 'Proof', lastname: 'Labtest',
      guestid: expected.guestId, bookingsessionid: expected.session, arrivaldate: expected.arrivalWire,
      departuredate: expected.departureWire, roomtype: expected.roomType, rateplan: expected.ratePlan, track: expected.track,
      reservationnote: expected.note, confirmationnumber: '', reservationid: '', reservationstayid: '', recordid: '',
      udfchkbox04: '0', udfchar13: '', emailaddress: '', guaranteecreditcardid: '', leaseguaranteecreditcardid: '',
      arprofileid: '', araccountid: '', guaranteetype: expected.guaranteeType, pagemode: 'display', savecctoprofile: '0', savesettlementcctoprofile: '0',
      ...(proof?.adults != null ? { adults: proof.adults } : {}),
      ...childAgeFields,
      ...(proof?.sourceBusiness ? { sourceofbus: proof.sourceBusiness.nativeCode,
        sourceofbusinessdesc: proof.sourceBusiness.description } : {}),
      ...Object.fromEntries(blankPartyFields.map((name) => [name, expected.partyValues[name] ?? ''])),
    };
    const profileControls = ['newprofileclick', 'linkprofileflag', 'createinactiveprofileflag',
      'reqguestprofilelookup', 'linkedprofileflag'];
    return request.method() === 'POST' && request.frame() === page.mainFrame() && url.origin === ORIGIN &&
      url.pathname === SAVE_PATH && !url.hash && [...url.searchParams].length === 1 && url.searchParams.get('pageaction') === 'SAVE' &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      isVerifiedLabtestProfileCurrent(page, { nativeId: expected.guestId, session: expected.session, token: expected.profileToken }) &&
      Object.entries(required).every(([key, value]) => body.getAll(key).length === 1 && body.get(key) === value &&
        keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1) &&
      (!expected.strictCreateProof || matchesFullCreateBody(body, expected.formData)) &&
      profileControls.every((key) => {
        const matches = keys.filter((name) => name.toLowerCase() === key);
        return !matches.length || (matches.length === 1 && matches[0] === key && ['', '0'].includes(body.get(key)));
      });
  } catch { return false; }
}

/** The page is sealed after this action. Use a fresh guarded session for reconciliation. */
export async function saveNewLabtestStay(page, {
  preimageId, arrival, departure, guestId, roomType, ratePlan, guaranteeType, note,
  createFieldProof, agencySelection, organizationSelection,
} = {}, { timeoutMs = 20_000 } = {}) {
  const formatted = dates(arrival, departure);
  if (!formatted || !/^\d+$/.test(clean(guestId)) || !/^[A-Z0-9]{1,12}$/.test(roomType || '') ||
      !/^[A-Z0-9]{1,12}$/.test(ratePlan || '') || guaranteeType !== 'NGI' || typeof note !== 'string' || !note.trim() || note.length > 200 ||
      !preimageId) return { outcome: 'input_gap', issue: 'INVALID_LABTEST_SAVE_INPUT' };
  const createFieldProofProvided = createFieldProof !== undefined && createFieldProof !== null;
  const createFields = createFieldProofProvided ? normalizeCreateFieldProof(createFieldProof) : null;
  if (createFieldProofProvided && !createFields) return { outcome: 'input_gap', issue: 'CREATE_FIELD_PROOF_INVALID_OR_UNSUPPORTED' };
  const agencySelectionProvided = agencySelection !== undefined && agencySelection !== null;
  const agency = agencySelectionProvided ? normalizeAgencySelection(agencySelection) : null;
  if (agencySelectionProvided && !agency) return { outcome: 'input_gap', issue: 'AGENCY_SELECTION_UNVERIFIED' };
  const organizationSelectionProvided = organizationSelection !== undefined && organizationSelection !== null;
  const organization = organizationSelectionProvided ? normalizeOrganizationSelection(organizationSelection) : null;
  if (organizationSelectionProvided && !organization) return { outcome: 'input_gap', issue: 'ORGANIZATION_SELECTION_UNVERIFIED' };
  const strictCreateProof = Boolean(createFields || agency || organization);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { outcome: 'input_gap', issue: 'INVALID_TIMEOUT' };
  if (usedPages.has(page)) return { outcome: 'refused', issue: 'PAGE_WRITE_ALREADY_USED' };
  let dispatched = false, possiblyDispatched = false, requestSeen = false, blocked = 0, blockedAtDispatch = 0;
  let sendRequests = 0, nativeDialog = null, response = null, armed = false, stopReason = null;
  let authorizedRequest, scope, fence, routeChain, signalStop;
  const observedBlocked = new WeakSet();
  const stopped = new Promise((resolve) => { signalStop = resolve; });
  const stop = (issue) => {
    stopReason ||= issue;
    armed = false;
    routeChain?.disarm();
    fence?.quarantine();
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
    const partyValues = Object.fromEntries(blankPartyFields.map((name) => [name, '']));
    if (agency) Object.assign(partyValues, {
      taid1: agency.nativeId, ta1: agency.name, bookingagency1iatanumber: agency.referenceNumber,
    });
    if (organization) Object.assign(partyValues, { companyid: organization.nativeId, company: organization.name });
    const expected = { ...formatted, guestId: clean(guestId), roomType, ratePlan, guaranteeType, note,
      ...(createFields ? { createFieldProof: createFields } : {}),
      ...(agency ? { agencySelection: agency } : {}), ...(organization ? { organizationSelection: organization } : {}),
      strictCreateProof, partyValues };
    const state = await bounded(draft(page, expected));
    if (!state) throw new Error('LABTEST_DRAFT_UNVERIFIED');
    if (strictCreateProof && !matchesCreateModelFieldSchema(state.modelData)) throw new Error('CREATE_FORM_FIELD_SCHEMA_CHANGED');
    const profileToken = await bounded(verifiedLabtestProfileToken(page, { nativeId: expected.guestId, session: state.session }));
    if (!profileToken) throw new Error('LABTEST_PROFILE_PROOF_STALE');
    if (!createSelectionProofTokensMatch(createFields, agency, organization, profileToken)) throw new Error('CREATE_SELECTION_PROOF_STALE');
    Object.assign(expected, state, { profileToken });
    fence = await bounded(installPageRequestFence(page, [SAVE_PATH]));
    scope = fence.open();
    if (!consumeLabtestPreimage(page, { preimageId, arrival, departure })) throw new Error('PREIMAGE_STALE_OR_MISMATCHED');
    const routeSetup = installLabtestCreateSaveRouteChain(page, {
      frame: page.mainFrame(),
      fence,
      scope,
      isArmed: () => armed && !nativeDialog,
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
    const pending = page.waitForResponse((item) => item.request() === authorizedRequest, { timeout: timeoutMs }).catch(() => null);
    const save = page.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
    if (await bounded(save.count()) !== 1) throw new Error('SAVE_CONTROL_NOT_UNIQUE');
    armed = true;
    await bounded(save.click({ timeout: 5_000, noWaitAfter: true }));
    response = await bounded(pending);
    armed = false;
    if (response?.status() === 200 && !nativeDialog) {
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
    return { outcome: guestStaySaveOutcome({ dispatched, possiblyDispatched, httpStatus,
      hasConfirmation: Boolean(requestSeen && snapshot.confirmation), nativeDialog, dialogs: dialogs.length, blockedAfterDispatch }),
      confirmation: snapshot.confirmation || null, status: snapshot.status || null, httpStatus: response?.status() || null,
      requestSeen, blockedRequests: blocked, blockedRequestsAfterDispatch: blockedAfterDispatch,
      browserSendRequests: sendRequests, nativeDialog, dialogs };
  } catch (error) {
    armed = false;
    if (possiblyDispatched) fence?.quarantine();
    return { outcome: possiblyDispatched ? 'uncertain' : 'not_dispatched', issue: safeIssue(error),
      requestSeen, httpStatus: response?.status() || null, blockedRequests: blocked,
      blockedRequestsAfterDispatch: Math.max(0, blocked - blockedAtDispatch),
      browserSendRequests: sendRequests, nativeDialog };
  } finally {
    clearTimeout(timer);
    armed = false;
    routeChain?.disarm();
    scope?.close();
    await routeChain?.close();
    if (!nativeDialog && !usedPages.has(page)) page.off('dialog', onDialog);
  }
}
