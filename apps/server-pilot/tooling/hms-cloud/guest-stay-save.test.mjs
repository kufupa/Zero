import assert from 'node:assert/strict';
import test from 'node:test';
import {
  guestStaySaveOutcome,
  matchesFullCreateBody,
  createSelectionProofTokensMatch,
  saveNewLabtestStay,
} from './guest-stay-save.mjs';

const controls = {
  SYSTEM_FUNCTION_NAME: 'OSRESV',
  USER_FUNCTION_NAME: 'OSRESV',
  CURRENT_TAB_NAME: 'HDR',
};
const saveInputs = {
  preimageId: 'offline-preimage',
  arrival: '2027-12-29',
  departure: '2027-12-31',
  guestId: '1234567',
  roomType: 'STQN',
  ratePlan: 'BAR',
  guaranteeType: 'NGI',
  note: 'synthetic offline proof',
};

function createModelData() {
  return {
    propertycode: 'HRCEN',
    adults: 2,
    children: 1,
    childages: '8',
    child1: 0,
    child2: 1,
    child3: 0,
    sourceofbus: 'EMAIL',
    sourceofbusinessdesc: 'E-Mail',
    taid1: '77',
    ta1: 'Test Agency',
    bookingagency1iatanumber: '123456',
    company: '',
    groupname: '',
    bacontract: '',
    taid2: '',
    udfchkbox04: '0',
    udfchar13: '',
    emailaddress: '',
    guaranteecreditcardid: '',
    leaseguaranteecreditcardid: '',
    arprofileid: '',
    araccountid: '',
    sessionID: { sessionID: 'OFFLINE-SESSION' },
  };
}

function createSaveBody(formData) {
  const body = new URLSearchParams();
  for (const [key, original] of Object.entries(formData)) {
    const value = key === 'sessionID' && original && typeof original === 'object'
      ? original.sessionID
      : original;
    body.set(key, String(value ?? ''));
  }
  for (const [key, value] of Object.entries(controls)) body.set(key, value);
  return body;
}

function pageStub(evaluateResult = null) {
  return {
    on() {},
    off() {},
    locator() { return { count: async () => 0 }; },
    evaluate: async () => evaluateResult,
  };
}

function adultSelection(adults, token = 'current-draft-token') {
  return { outcome: 'updated_unsaved', field: 'adults', requested: adults,
    actual: { value: adults, display: String(adults) }, profileProofToken: token };
}

function childAgeSelection(ages, token = 'current-draft-token') {
  const ageBandCounts = { child1: 0, child2: 0, child3: 0 };
  for (const age of ages) ageBandCounts[age < 3 ? 'child1' : age <= 12 ? 'child2' : 'child3'] += 1;
  return { outcome: 'updated_unsaved', requestedChildAges: ages, actualChildAges: ages,
    ageBandCounts, profileProofToken: token };
}

function sourceSelection(token = 'current-draft-token') {
  return { outcome: 'selected_unsaved', searchId: 'current-source-search', nativeCode: 'EMAIL',
    candidate: { nativeCode: 'EMAIL', description: 'E-Mail' },
    nativeCodeReadback: { outcome: 'unsupported', issue: 'SOURCE_CODE_NOT_EXPOSED_ON_FORM' },
    identityEvidence: 'unique_current_picker_row_and_description_readback', profileProofToken: token };
}

function agencySelection(token = 'current-draft-token') {
  return { outcome: 'selected_unsaved', searchId: 'current-agency-search', nativeId: '77',
    displayedAgency: 'Test Agency', agencyIataNumber: '123456', agencyReferenceNumberType: 'IATA', nativeIdEvidence: 'form_change_response',
    agencyReferenceEvidence: { iataNumber: 'response_grid_correlated', referenceNumberType: 'response_grid_correlated' },
    selectedField: { label: 'Primary Booking Agency', name: 'ta1', value: 'Test Agency' },
    profileProofToken: token };
}

function organizationSelection(token = 'current-draft-token') {
  return { outcome: 'selected_unsaved', searchId: 'current-organization-search', nativeId: '88',
    displayedOrganization: 'Test Organization', nativeIdEvidence: 'form_change_response',
    selectedField: { label: 'Organization', name: 'company', value: 'Test Organization' },
    profileProofToken: token };
}

test('matches every supplied model value and the three fixed controls', () => {
  const formData = createModelData();
  assert.equal(matchesFullCreateBody(createSaveBody(formData), formData), true);
});

test('rejects create-body drift, omissions, duplicates, extras, and unsupported values', () => {
  const formData = createModelData();

  const changedSideEffect = createSaveBody(formData);
  changedSideEffect.set('emailaddress', 'unexpected@example.invalid');
  assert.equal(matchesFullCreateBody(changedSideEffect, formData), false);

  const changedAgency = createSaveBody(formData);
  changedAgency.set('bookingagency1iatanumber', '654321');
  assert.equal(matchesFullCreateBody(changedAgency, formData), false);

  const noIataFormData = { ...formData, bookingagency1iatanumber: '' };
  assert.equal(matchesFullCreateBody(createSaveBody(noIataFormData), noIataFormData), true);

  const missing = createSaveBody(formData);
  missing.delete('groupname');
  assert.equal(matchesFullCreateBody(missing, formData), false);

  const extra = createSaveBody(formData);
  extra.set('unexpected', '1');
  assert.equal(matchesFullCreateBody(extra, formData), false);

  const duplicate = createSaveBody(formData);
  duplicate.append('adults', '2');
  assert.equal(matchesFullCreateBody(duplicate, formData), false);

  const wrongControl = createSaveBody(formData);
  wrongControl.set('CURRENT_TAB_NAME', 'OTHER');
  assert.equal(matchesFullCreateBody(wrongControl, formData), false);

  const unsupported = { ...formData, unrelatedObject: { nested: true } };
  assert.equal(matchesFullCreateBody(createSaveBody(unsupported), unsupported), false);
});

test('diagnoses a rejected body with bounded safe field names only', () => {
  const formData = { ...createModelData(), reservationnote: 'original synthetic note' };
  const body = createSaveBody(formData);
  const unsafeField = 'guest email@example.invalid';
  const longField = 'x'.repeat(65);
  body.set('reservationnote', 'different synthetic value');
  body.delete('sourceofbusinessdesc');
  body.set('unlistedfield', 'unreported value');
  body.set(unsafeField, 'private fake value');
  body.set(longField, 'private fake value');
  body.append('adults', '3');
  body.set('SYSTEM_FUNCTION_NAME', 'WRONG');
  let diagnostic;

  assert.equal(matchesFullCreateBody(body, formData, (value) => { diagnostic = value; }), false);
  assert.deepEqual(diagnostic.fields, [
    'SYSTEM_FUNCTION_NAME', 'adults', 'reservationnote', 'sourceofbusinessdesc', 'unlistedfield',
  ]);
  assert.equal(diagnostic.unsafeNameCount, 2);
  assert.equal(JSON.stringify(diagnostic).includes(unsafeField), false);
  assert.equal(JSON.stringify(diagnostic).includes(longField), false);
  assert.equal(JSON.stringify(diagnostic).includes('different synthetic value'), false);
  assert.equal(JSON.stringify(diagnostic).includes('private fake value'), false);
});

test('matches exact zero, one and multiple-child form payloads', () => {
  for (const [adults, ages] of [[1, []], [2, [8]], [3, [0, 12, 17]]]) {
    const bands = { child1: 0, child2: 0, child3: 0 };
    for (const age of ages) bands[age < 3 ? 'child1' : age <= 12 ? 'child2' : 'child3'] += 1;
    const formData = { ...createModelData(), adults, children: ages.length, childages: ages.join(','), ...bands };
    const body = createSaveBody(formData);
    assert.equal(matchesFullCreateBody(body, formData), true);
    body.set('children', String(ages.length + 1));
    assert.equal(matchesFullCreateBody(body, formData), false);
  }
});

test('matches numeric-zero revenue encoding and keeps lifetime nights separate from stay length', () => {
  const modelData = { ...createModelData(), arrivaldate: '12/11/2027', departuredate: '12/13/2027',
    reservationnote: 'Synthetic note', revenuevalue: '0', nightsvalue: '5' };
  const formData = { ...modelData, revenuevalue: '0.000' };
  const body = createSaveBody(formData);
  body.set('revenuevalue', '0');

  const parseDate = (value) => {
    const [month, day, year] = value.split('/').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  assert.equal((parseDate(body.get('departuredate')) - parseDate(body.get('arrivaldate'))) / 86_400_000, 2);
  assert.equal(matchesFullCreateBody(body, modelData), true);
  assert.equal(matchesFullCreateBody(body, formData), true);
  body.set('nightsvalue', '2');
  assert.equal(matchesFullCreateBody(body, formData), false);
  body.set('nightsvalue', '5');
  body.set('revenuevalue', '1');
  assert.equal(matchesFullCreateBody(body, formData), false);
  body.set('revenuevalue', '');
  assert.equal(matchesFullCreateBody(body, formData), false);
  body.set('revenuevalue', '0');
  body.append('revenuevalue', '0.000');
  assert.equal(matchesFullCreateBody(body, formData), false);
});

test('preserves padded synthetic reservation notes exactly', () => {
  const formData = { ...createModelData(), reservationnote: ' Synthetic note ' };
  const body = createSaveBody(formData);
  assert.equal(matchesFullCreateBody(body, formData), true);
  body.set('reservationnote', formData.reservationnote.trim());
  assert.equal(matchesFullCreateBody(body, formData), false);
});

test('preserves the legacy childless core-only input path', async () => {
  const result = await saveNewLabtestStay(pageStub(), saveInputs);
  assert.equal(result.outcome, 'not_dispatched');
  assert.equal(result.issue, 'LABTEST_DRAFT_UNVERIFIED');
});

test('reports only a fixed, value-free draft-check code', async () => {
  const strictInputs = { ...saveInputs, createFieldProof: { adultSelection: adultSelection(2) } };
  const result = await saveNewLabtestStay(pageStub('DRAFT_REVENUE_ZERO_NATIVE_VALUE'), strictInputs);
  assert.equal(result.outcome, 'not_dispatched');
  assert.equal(result.issue, 'LABTEST_DRAFT_UNVERIFIED');
  assert.equal(result.draftCheck, 'DRAFT_REVENUE_ZERO_NATIVE_VALUE');
  assert.equal(result.requestSeen, false);

  const unlisted = await saveNewLabtestStay(pageStub('DRAFT_1234567'), strictInputs);
  assert.equal(unlisted.issue, 'LABTEST_DRAFT_UNVERIFIED');
  assert.equal(unlisted.draftCheck, undefined);
});

test('requires every optional selection to share the current Labtest draft token', async () => {
  const currentToken = 'draft-token-current';
  const createFields = { profileProofToken: currentToken };
  const agency = { profileProofToken: currentToken };
  const organization = { profileProofToken: currentToken };
  assert.equal(createSelectionProofTokensMatch(createFields, agency, organization, currentToken), true);
  assert.equal(createSelectionProofTokensMatch(createFields, agency, organization, 'draft-token-other'), false);
  assert.equal(createSelectionProofTokensMatch(createFields, { profileProofToken: 'draft-token-other' }, null, currentToken), false);
  assert.equal(createSelectionProofTokensMatch(null, null, null, currentToken), true);

  const result = await saveNewLabtestStay(pageStub(), {
    ...saveInputs,
    createFieldProof: {
      adultSelection: adultSelection(2),
      childAgeSelection: childAgeSelection([8]),
      sourceSelection: sourceSelection(),
    },
  });
  assert.equal(result.outcome, 'not_dispatched');
  assert.equal(result.issue, 'LABTEST_DRAFT_UNVERIFIED');
});

test('accepts independent adult, zero/one/many child, source, agency and organization selections', async () => {
  const cases = [
    { createFieldProof: { adultSelection: adultSelection(2) } },
    { createFieldProof: { childAgeSelection: childAgeSelection([]) } },
    { createFieldProof: { childAgeSelection: childAgeSelection([8]) } },
    { createFieldProof: { childAgeSelection: childAgeSelection([0, 12, 17]) } },
    { createFieldProof: { sourceSelection: sourceSelection() } },
    { createFieldProof: { adultSelection: adultSelection(2), sourceSelection: sourceSelection() } },
    { agencySelection: agencySelection() },
    { agencySelection: { ...agencySelection(), agencyIataNumber: null, agencyReferenceNumberType: null } },
    { organizationSelection: organizationSelection() },
    { agencySelection: agencySelection(), organizationSelection: organizationSelection() },
    { createFieldProof: { childAgeSelection: childAgeSelection([8]) }, agencySelection: agencySelection() },
    { createFieldProof: { adultSelection: adultSelection(2) }, organizationSelection: organizationSelection() },
  ];
  for (const optional of cases) {
    const result = await saveNewLabtestStay(pageStub(), { ...saveInputs, ...optional });
    assert.equal(result.outcome, 'not_dispatched');
    assert.equal(result.issue, 'LABTEST_DRAFT_UNVERIFIED');
  }
});

test('rejects unsupported create selections without a current identity or exact fields', async () => {
  const missingToken = await saveNewLabtestStay(pageStub(), {
    ...saveInputs, createFieldProof: { adultSelection: adultSelection(2, '') },
  });
  assert.equal(missingToken.issue, 'CREATE_FIELD_PROOF_INVALID_OR_UNSUPPORTED');

  const badBands = childAgeSelection([8, 12]);
  badBands.ageBandCounts.child2 = 1;
  const invalidChildren = await saveNewLabtestStay(pageStub(), {
    ...saveInputs, createFieldProof: { childAgeSelection: badBands },
  });
  assert.equal(invalidChildren.issue, 'CREATE_FIELD_PROOF_INVALID_OR_UNSUPPORTED');

  const agencyWithoutIataEvidence = agencySelection();
  delete agencyWithoutIataEvidence.agencyIataNumber;
  const missingIataEvidence = await saveNewLabtestStay(pageStub(), {
    ...saveInputs, agencySelection: agencyWithoutIataEvidence,
  });
  assert.equal(missingIataEvidence.issue, 'AGENCY_SELECTION_UNVERIFIED');

  const agencyWithoutCorrelatedBlankEvidence = agencySelection();
  agencyWithoutCorrelatedBlankEvidence.agencyIataNumber = null;
  agencyWithoutCorrelatedBlankEvidence.agencyReferenceNumberType = null;
  delete agencyWithoutCorrelatedBlankEvidence.agencyReferenceEvidence;
  const missingPickerEvidence = await saveNewLabtestStay(pageStub(), {
    ...saveInputs, agencySelection: agencyWithoutCorrelatedBlankEvidence,
  });
  assert.equal(missingPickerEvidence.issue, 'AGENCY_SELECTION_UNVERIFIED');

  const pickerProvenNoIata = await saveNewLabtestStay(pageStub(), {
    ...saveInputs, agencySelection: { ...agencySelection(), agencyIataNumber: null, agencyReferenceNumberType: null },
  });
  assert.equal(pickerProvenNoIata.issue, 'LABTEST_DRAFT_UNVERIFIED');

  const wrongOrganizationField = await saveNewLabtestStay(pageStub(), {
    ...saveInputs, organizationSelection: { ...organizationSelection(), selectedField: { name: 'ta1', value: 'Test Organization' } },
  });
  assert.equal(wrongOrganizationField.issue, 'ORGANIZATION_SELECTION_UNVERIFIED');
});

test('reports only a confirmed, unblocked request as saved', () => {
  const outcome = (overrides = {}) => guestStaySaveOutcome({
    dispatched: false, possiblyDispatched: false, httpStatus: null, hasConfirmation: false,
    nativeDialog: null, dialogs: 0, blockedAfterDispatch: 0, ...overrides,
  });
  assert.equal(outcome({ dispatched: true, possiblyDispatched: true, httpStatus: 200, hasConfirmation: true }), 'saved_same_form');
  assert.equal(outcome({ dispatched: true, possiblyDispatched: true, httpStatus: 200, hasConfirmation: true,
    blockedAfterDispatch: 1 }), 'uncertain');
  assert.equal(outcome({ possiblyDispatched: true }), 'uncertain');
  assert.equal(outcome(), 'not_dispatched');
});
