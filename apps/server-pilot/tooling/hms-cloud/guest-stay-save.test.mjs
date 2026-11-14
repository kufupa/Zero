import assert from 'node:assert/strict';
import test from 'node:test';
import {
  guestStaySaveOutcome,
  createSelectionProofTokensMatch,
  validCreateBillingReference, billingOnlyDraftChange,
  finishLabtestCreateFence, saveNewLabtestStay,
} from './guest-stay-save.mjs';

const saveInputs = {
  propertyCode: 'HRCEN',
  preimageId: 'offline-preimage',
  arrival: '2027-12-29',
  departure: '2027-12-31',
  guestId: '1234567',
  roomType: 'STQN',
  ratePlan: 'BAR',
  guaranteeType: 'NGI',
  note: 'synthetic offline proof',
};

test('Create cannot report success or no dispatch when route callback drain is unconfirmed', async () => {
  for (const outcome of ['saved_same_form', 'not_dispatched']) {
    for (const drain of [async () => false, async () => { throw new Error('drain failed'); }]) {
      let quarantined = false;
      const result = await finishLabtestCreateFence({ outcome, confirmation: 'synthetic' }, { drain },
        { quarantine: () => { quarantined = true; } });
      assert.equal(result.outcome, 'uncertain');
      assert.equal(result.issue, 'SAVE_CALLBACK_DRAIN_UNCONFIRMED');
      assert.equal(result.dispatchCallbacksDrained, false);
      assert.equal(quarantined, true);
    }
  }
});

test('Create records callback drain separately from its original save outcome', async () => {
  const result = await finishLabtestCreateFence({ outcome: 'saved_same_form' }, { drain: async () => true }, {});
  assert.deepEqual(result, { outcome: 'saved_same_form', dispatchCallbacksDrained: true });
  assert.deepEqual(await finishLabtestCreateFence({ outcome: 'not_dispatched' }, null, {}), { outcome: 'not_dispatched' });
});

function pageStub(evaluateResult = null) {
  return {
    on() {},
    off() {},
    context() { return { _options: { serviceWorkers: 'block' }, serviceWorkers: () => [] }; },
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

test('agent guarantee requires matching selector evidence and a current strict draft', async () => {
  const selection = { outcome: 'updated_unsaved', field: 'guaranteeType', requested: 'GTDAGT',
    actual: { value: 'GTDAGT', submitted: 'GTDAGT', display: 'Guaranteed By Agent' } };
  for (const invalid of [undefined, { ...selection, requested: 'NGI' },
    { ...selection, actual: { ...selection.actual, submitted: 'NGI' } },
    { ...selection, actual: { ...selection.actual, display: '' } }]) {
    const result = await saveNewLabtestStay(pageStub(), { ...saveInputs, guaranteeType: 'GTDAGT', guaranteeSelection: invalid });
    assert.equal(result.outcome, 'input_gap');
    assert.equal(result.issue, 'GUARANTEE_SELECTION_UNVERIFIED');
  }
  let expected;
  const page = pageStub();
  page.evaluate = async (_fn, args) => { expected = args.expected; return 'DRAFT_GUARANTEE'; };
  const result = await saveNewLabtestStay(page, { ...saveInputs, guaranteeType: 'GTDAGT', guaranteeSelection: selection });
  assert.equal(result.outcome, 'not_dispatched');
  assert.equal(result.issue, 'LABTEST_DRAFT_UNVERIFIED');
  assert.equal(expected.guaranteeType, 'GTDAGT');
  assert.equal(expected.guaranteeDisplay, 'Guaranteed By Agent');
  assert.equal(expected.strictCreateProof, true);
  const unsupported = await saveNewLabtestStay(pageStub(), { ...saveInputs, guaranteeType: 'CC' });
  assert.equal(unsupported.issue, 'INVALID_LABTEST_SAVE_INPUT');
});

test('reviewed contact and opt-in values are required by the strict Labtest draft', async () => {
  let expected;
  const page = pageStub();
  page.evaluate = async (_fn, args) => { expected = args.expected; return 'DRAFT_REVIEWED_CONTACT_FIELDS'; };
  const request = { ...saveInputs, track: 'Best Available', guestOptIn: false,
    booker: { name: 'Booker', contact: 'booker@example.test' }, cmsRecipient: 'client@example.test' };
  const result = await saveNewLabtestStay(page, request);
  assert.equal(result.outcome, 'not_dispatched');
  assert.equal(result.draftCheck, 'DRAFT_REVIEWED_CONTACT_FIELDS');
  assert.equal(expected.strictCreateProof, true);
  assert.equal(expected.approvedTrack, request.track);
  assert.equal(expected.guestOptIn, false);
  assert.deepEqual(expected.booker, request.booker);
  assert.equal(expected.cmsRecipient, request.cmsRecipient);
  await saveNewLabtestStay(page, { ...request, guestOptIn: true });
  assert.equal(expected.guestOptIn, true);
  const invalid = await saveNewLabtestStay(pageStub(), { ...request, guestOptIn: 'yes' });
  assert.equal(invalid.issue, 'INVALID_LABTEST_SAVE_INPUT');
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


test('requires A/R selection response identity and current draft verification', async () => {
  const arSelection = { outcome: 'selected_unsaved', searchId: 'ar-search', nativeId: '75',
    displayedArAccount: 'Test Account', nativeIdEvidence: 'form_change_response',
    selectedField: { name: 'araccountname', value: 'Test Account' },
    nativeReadback: { araccountid: '75', araccountname: 'Test Account' } };
  const pending = await saveNewLabtestStay(pageStub(), { ...saveInputs, arSelection, expectedArProfileId: '501' });
  assert.equal(pending.issue, 'LABTEST_DRAFT_UNVERIFIED');
  for (const bad of [{ ...arSelection, nativeReadback: { araccountid: 'other', araccountname: 'Test Account' } },
    { ...arSelection, nativeIdEvidence: 'unknown' }, { ...arSelection, searchId: '' }]) {
    const result = await saveNewLabStayForTest(bad);
    assert.equal(result.issue, 'AR_SELECTION_UNVERIFIED');
  }
  async function saveNewLabStayForTest(selection) { return saveNewLabtestStay(pageStub(), { ...saveInputs, arSelection: selection, expectedArProfileId: '501' }); }
});

test('CMS code proof must match selected native value and another current selection', async () => {
  const cms = { outcome: 'updated_unsaved', field: 'cmsMessageId', requested: '03', actual: '03' };
  const good = await saveNewLabtestStay(pageStub(), { ...saveInputs,
    createFieldProof: { adultSelection: adultSelection(2), cmsMessageSelection: cms } });
  assert.equal(good.issue, 'LABTEST_DRAFT_UNVERIFIED');
  for (const proof of [{ cmsMessageSelection: cms }, { adultSelection: adultSelection(2), cmsMessageSelection: { ...cms, actual: '01' } }]) {
    const result = await saveNewLabtestStay(pageStub(), { ...saveInputs, createFieldProof: proof });
    assert.equal(result.issue, 'CREATE_FIELD_PROOF_INVALID_OR_UNSUPPORTED');
  }
});


test('reason for stay proof binds the selected code and display', async () => {
  const reason = { outcome: 'updated_unsaved', field: 'reasonForStay', requested: 'BUS', actual: { value: 'BUS', display: 'Business' } };
  const good = await saveNewLabtestStay(pageStub(), { ...saveInputs,
    createFieldProof: { adultSelection: adultSelection(2), reasonSelection: reason } });
  assert.equal(good.issue, 'LABTEST_DRAFT_UNVERIFIED');
  const bad = await saveNewLabtestStay(pageStub(), { ...saveInputs,
    createFieldProof: { adultSelection: adultSelection(2), reasonSelection: { ...reason, actual: { value: 'OTHER', display: 'Business' } } } });
  assert.equal(bad.issue, 'CREATE_FIELD_PROOF_INVALID_OR_UNSUPPORTED');
});

// Run the actual browser-side draft callback against a small synthetic Ext form.
function nativeCreateDraftPage() {
  const blanks = ['taid1', 'companyid', 'groupid', 'groupcompanyid', 'grouptaid', 'groupta2id', 'groupta3id',
    'bookingagency2id', 'bookingagency3id', 'bookingagencycontractid', 'ta1', 'company', 'companyname', 'groupname',
    'araccountname', 'bacontract', 'bookingagency2name', 'bookingagency3name', 'bookingagency1iatanumber',
    'bookingagency2iatanumber', 'bookingagency3iatanumber'];
  const visible = { ta1: '', company: '', groupname: '', bacontract: '', confirmationnumber: '', guestid: '1234567',
    firstname: 'Proof', lastname: 'Labtest', arrivaldate: '29-DEC-2027', departuredate: '31-DEC-2027', roomtype: 'STQN',
    roomtypecharge: '', rateplan: 'BAR', track: 'Best Available', guaranteetype: 'Non-Guaranteed Individual', reservationnote: saveInputs.note,
    revenuevalue: '0', nightsvalue: '5', udfchkbox04: '', udfchar13: '', emailaddress: '', adults: '2',
    udfchar09: '03', reasonforstay: 'Business', araccountname: 'Test Account',
    bookingagencycommissionpricing: 'FLAT', bookingagencycommissiontype: 'PERCNT', billingreference: '' };
  const data = { ...Object.fromEntries(blanks.map((key) => [key, ''])), ...visible, propertycode: 'HRCEN',
    PKID: '@[EMPTY]#@[EMPTY]#HRCEN#', status: 'New', reservationid: '', reservationstayid: '', recordid: '',
    guaranteecreditcardid: '', leaseguaranteecreditcardid: '', araccountid: '75', arprofileid: '501',
    bookingsessionid: 'synthetic-session', guaranteetype: 'NGI', reasonforstay: 'BUS',
    bookingagencycommissionpricing: '', bookingagencycommissiontype: '' };
  const values = { ...data, bookingagencycommissionpricing: 'FLAT', bookingagencycommissiontype: 'PERCNT' }, elements = Object.entries(visible).map(([name, value]) => ({ name, value,
    id: `${name}-inputEl`, offsetWidth: 1, offsetHeight: 1, readOnly: ['revenuevalue', 'nightsvalue'].includes(name),
    closest: () => null }));
  const root = { contains: (element) => elements.includes(element), querySelectorAll: () => elements };
  const form = { el: { dom: root }, getRecord: () => ({ data, getData: () => ({ ...data }) }),
    getForm: () => ({ getValues: () => ({ ...values }), getFields: () => ({ items: Object.values(components) }) }) };
  const components = Object.fromEntries(elements.map((element) => [element.name, {
    up: () => form, getName: () => element.name,
    getValue: () => element.name === 'udfchkbox04' ? false : values[element.name],
    getSubmitData: () => ({ [element.name]: values[element.name] }),
    getFieldLabel: () => element.name === 'nightsvalue' ? 'Lifetime Nights' : '',
  }]));
  const windows = [];
  const env = { location: { origin: 'https://hmsweb.hms.eu1.inforcloudsuite.com' },
    document: { title: 'Infor HMS - HRCEN', querySelectorAll: (selector) => selector === '.x-window:not(.x-menu)' ? windows : elements },
    getComputedStyle: () => ({ visibility: 'visible' }), Ext: { getCmp: (name) => components[name] } };
  const page = { data, values, elements, components, windows, on() {}, off() {},
    context: () => ({ _options: { serviceWorkers: 'block' }, serviceWorkers: () => [] }),
    locator: () => ({ count: async () => 0 }),
    async evaluate(fn, arg) {
      const previous = Object.fromEntries(Object.keys(env).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
      try {
        for (const [key, value] of Object.entries(env)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        const result = await fn(arg); page.lastDraft = result; page.lastDraftFunction = fn; page.lastDraftArguments = arg; return result;
      } finally {
        for (const key of Object.keys(env)) {
          if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
          else delete globalThis[key];
        }
      }
    } };
  return page;
}

test('native create draft tolerates unrelated HMS field drift but checks guest and room', async () => {
  const makePage = () => {
    const page = nativeCreateDraftPage();
    page.data.araccountid = ''; page.data.arprofileid = ''; page.data.araccountname = '';
    page.values.araccountid = ''; page.values.arprofileid = ''; page.values.araccountname = '';
    page.elements.find((element) => element.name === 'araccountname').value = '';
    return page;
  };
  const run = (page) => saveNewLabtestStay(page, saveInputs, {
    authorizeCandidate: async () => false,
    dispatchCandidate: async () => { throw new Error('unexpected dispatch'); },
  });
  for (const page of [makePage(), makePage()]) {
    page.data.newNativeField = 'HMS default';
    delete page.data.nightsvalue;
    assert.equal((await run(page)).issue, 'LABTEST_PROFILE_PROOF_STALE');
  }
  const wrongGuest = makePage(); wrongGuest.data.guestid = '7654321';
  assert.equal((await run(wrongGuest)).draftCheck, 'DRAFT_RESERVATION_MODEL');
  const wrongRoom = makePage(); wrongRoom.elements.find((field) => field.name === 'roomtype').value = 'OTHER';
  assert.equal((await run(wrongRoom)).draftCheck, 'DRAFT_STAY_FIELDS');
});

test('native draft checks agent guarantee display, native value and submitted value', async () => {
  const selection = { outcome: 'updated_unsaved', field: 'guaranteeType', requested: 'GTDAGT',
    actual: { value: 'GTDAGT', submitted: 'GTDAGT', display: 'Guaranteed By Agent' } };
  const makePage = () => {
    const page = nativeCreateDraftPage();
    page.data.araccountid = ''; page.data.arprofileid = ''; page.data.araccountname = '';
    page.values.araccountid = ''; page.values.arprofileid = ''; page.values.araccountname = '';
    page.elements.find((element) => element.name === 'araccountname').value = '';
    page.data.guaranteetype = 'GTDAGT'; page.values.guaranteetype = 'GTDAGT';
    page.elements.find((element) => element.name === 'guaranteetype').value = 'Guaranteed By Agent';
    return page;
  };
  const run = (page) => saveNewLabtestStay(page, { ...saveInputs, guaranteeType: 'GTDAGT', guaranteeSelection: selection });
  // The fixture has no verified profile token; no Save may dispatch.
  const valid = await run(makePage());
  assert.equal(valid.outcome, 'not_dispatched');
  assert.equal(valid.issue, 'LABTEST_PROFILE_PROOF_STALE');
  const wrongDisplay = makePage();
  wrongDisplay.elements.find((element) => element.name === 'guaranteetype').value = 'Non-Guaranteed Individual';
  const wrongValue = makePage(); wrongValue.components.guaranteetype.getValue = () => 'NGI';
  const wrongSubmit = makePage(); wrongSubmit.components.guaranteetype.getSubmitData = () => ({ guaranteetype: 'NGI' });
  for (const page of [wrongDisplay, wrongValue, wrongSubmit]) {
    const result = await run(page);
    assert.equal(result.outcome, 'not_dispatched');
    assert.equal(result.draftCheck, 'DRAFT_GUARANTEE');
  }
});

test('native draft binds A/R, CMS and reason controls before any save route', async () => {
  const arSelection = { outcome: 'selected_unsaved', searchId: 'ar-search', nativeId: '75', displayedArAccount: 'Test Account',
    nativeIdEvidence: 'form_change_response', selectedField: { name: 'araccountname', value: 'Test Account' },
    nativeReadback: { araccountid: '75', araccountname: 'Test Account' } };
  const createFieldProof = { adultSelection: adultSelection(2),
    cmsMessageSelection: { outcome: 'updated_unsaved', field: 'cmsMessageId', requested: '03', actual: '03' },
    reasonSelection: { outcome: 'updated_unsaved', field: 'reasonForStay', requested: 'BUS', actual: { value: 'BUS', display: 'Business' } } };
  const run = (page) => saveNewLabtestStay(page, { ...saveInputs, arSelection, expectedArProfileId: '501', createFieldProof });
  // A valid draft reaches the independent profile proof guard.
  assert.equal((await run(nativeCreateDraftPage())).issue, 'LABTEST_PROFILE_PROOF_STALE');
  const changedProfile = nativeCreateDraftPage(); changedProfile.data.arprofileid = '502'; changedProfile.values.arprofileid = '502';
  assert.equal((await run(changedProfile)).issue, 'AR_PROFILE_CHANGED');
  const wrongAccount = nativeCreateDraftPage(); wrongAccount.data.araccountid = '76';
  assert.equal((await run(wrongAccount)).draftCheck, 'DRAFT_RESERVATION_MODEL');
  const wrongProfile = nativeCreateDraftPage(); wrongProfile.data.arprofileid = '';
  assert.equal((await run(wrongProfile)).draftCheck, 'DRAFT_RESERVATION_MODEL');
  const wrongCms = nativeCreateDraftPage(); wrongCms.components.udfchar09.getSubmitData = () => ({ udfchar09: '01' });
  assert.equal((await run(wrongCms)).draftCheck, 'DRAFT_CMS_MESSAGE_VALUE');
  const wrongReason = nativeCreateDraftPage(); wrongReason.components.reasonforstay.getSubmitData = () => ({ reasonforstay: 'OTHER' });
  assert.equal((await run(wrongReason)).draftCheck, 'DRAFT_REASON_FOR_STAY_VALUE');
});


test('save refuses a context that does not block service workers', async () => {
  for (const context of [null, { _options: {}, serviceWorkers: () => [] },
    { _options: { serviceWorkers: 'block' }, serviceWorkers: () => [{}] }]) {
    const page = pageStub();
    page.context = () => context;
    const result = await saveNewLabtestStay(page, saveInputs);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.issue, 'BROWSER_CONTEXT_UNSAFE');
  }
});


test('agency commission defaults are bound from unique native submit controls', async () => {
  const makePage = () => {
    const page = nativeCreateDraftPage();
    page.data.taid1 = '77'; page.data.ta1 = 'Test Agency'; page.data.bookingagency1iatanumber = '123456';
    page.values.ta1 = 'Test Agency';
    page.elements.find((element) => element.name === 'ta1').value = 'Test Agency';
    return page;
  };
  const arSelection = { outcome: 'selected_unsaved', searchId: 'ar-search', nativeId: '75', displayedArAccount: 'Test Account',
    nativeIdEvidence: 'form_change_response', selectedField: { name: 'araccountname', value: 'Test Account' },
    nativeReadback: { araccountid: '75', araccountname: 'Test Account' } };
  const run = (page) => saveNewLabtestStay(page, { ...saveInputs, agencySelection: agencySelection(), arSelection, expectedArProfileId: '501',
    createFieldProof: { adultSelection: adultSelection(2) } });
  const valid = makePage();
  assert.equal((await run(valid)).issue, 'LABTEST_PROFILE_PROOF_STALE');
  assert.equal(valid.lastDraft.formData.bookingagencycommissionpricing, 'FLAT');
  assert.equal(valid.lastDraft.formData.bookingagencycommissiontype, 'PERCNT');
  const badSubmit = makePage();
  badSubmit.components.bookingagencycommissiontype.getSubmitData = () => ({ bookingagencycommissiontype: 'OTHER' });
  assert.equal((await run(badSubmit)).draftCheck, 'DRAFT_AGENCY_COMMISSION_VALUE');
  const badControl = makePage();
  badControl.components.bookingagencycommissionpricing.getValue = () => 'OTHER';
  assert.equal((await run(badControl)).draftCheck, 'DRAFT_AGENCY_COMMISSION_VALUE');
  const duplicate = makePage();
  duplicate.components.extraCommission = { ...duplicate.components.bookingagencycommissiontype };
  assert.equal((await run(duplicate)).draftCheck, 'DRAFT_AGENCY_COMMISSION_VALUE');
  const missing = makePage(); delete missing.components.bookingagencycommissionpricing;
  assert.equal((await run(missing)).draftCheck, 'DRAFT_AGENCY_COMMISSION_VALUE');
});


test('billing input requires explicit nonblank text and current A/R selection', async () => {
  for (const value of [null, '', '   ', 'X\nY', 0, 'x'.repeat(4001)]) {
    assert.equal(validCreateBillingReference(value), false);
    assert.equal((await saveNewLabtestStay(pageStub(), { ...saveInputs, billingReference: value })).issue, 'BILLING_REFERENCE_OR_AR_INVALID');
  }
  assert.equal(validCreateBillingReference('  PO 123  '), true);
  assert.equal((await saveNewLabtestStay(pageStub(), { ...saveInputs, billingReference: 'PO' })).issue, 'BILLING_REFERENCE_OR_AR_INVALID');
});

test('billing draft exempts only its own blank required control and verifies native submit data', async () => {
  const arSelection = { outcome: 'selected_unsaved', searchId: 'ar-search', nativeId: '75', displayedArAccount: 'Test Account',
    nativeIdEvidence: 'form_change_response', selectedField: { name: 'araccountname', value: 'Test Account' },
    nativeReadback: { araccountid: '75', araccountname: 'Test Account' } };
  const run = (page) => saveNewLabtestStay(page, { ...saveInputs, arSelection, expectedArProfileId: '501', billingReference: ' PO 123 ',
    createFieldProof: { adultSelection: adultSelection(2) } });
  const page = nativeCreateDraftPage();
  page.components.billingreference.allowBlank = false;
  assert.equal((await run(page)).issue, 'LABTEST_PROFILE_PROOF_STALE');
  const before = page.lastDraft, fn = page.lastDraftFunction, args = page.lastDraftArguments;
  page.values.billingreference = ' PO 123 ';
  page.elements.find((field) => field.name === 'billingreference').value = ' PO 123 ';
  const after = await page.evaluate(fn, { ...args, expected: { ...args.expected, billingPhase: 'after' } });
  assert.equal(after.formData.billingreference, ' PO 123 ');
  assert.equal(billingOnlyDraftChange(before, after, ' PO 123 '), true);
  const changed = structuredClone(after); changed.modelData.roomtype = 'OTHER';
  assert.equal(billingOnlyDraftChange(before, changed, ' PO 123 '), false);
  const wrongSubmit = nativeCreateDraftPage();
  wrongSubmit.components.billingreference.getSubmitData = () => ({ billingreference: 'unexpected' });
  assert.equal((await run(wrongSubmit)).draftCheck, 'DRAFT_BILLING_REFERENCE_VALUE');
  const otherBlank = nativeCreateDraftPage(); otherBlank.components.billingreference.allowBlank = false;
  otherBlank.components.bacontract.allowBlank = false;
  assert.equal((await run(otherBlank)).draftCheck, 'DRAFT_REQUIRED_FIELDS');
  const duplicate = nativeCreateDraftPage();
  duplicate.elements.push({ ...duplicate.elements.find((field) => field.name === 'billingreference') });
  assert.equal((await run(duplicate)).draftCheck, 'DRAFT_VISIBLE_FIELDS');
  const readonly = nativeCreateDraftPage(); readonly.components.billingreference.readOnly = true;
  assert.equal((await run(readonly)).draftCheck, 'DRAFT_BILLING_REFERENCE_VALUE');
  const modal = nativeCreateDraftPage(); modal.windows.push({ offsetWidth: 1, offsetHeight: 1 });
  assert.equal((await run(modal)).draftCheck, 'DRAFT_OPEN_MODAL');
  const missingNative = nativeCreateDraftPage(); missingNative.components.billingreference.getValue = () => undefined;
  assert.equal((await run(missingNative)).draftCheck, 'DRAFT_BILLING_REFERENCE_VALUE');
  const invalid = nativeCreateDraftPage(); invalid.values.billingreference = 'invalid';
  invalid.elements.find((field) => field.name === 'billingreference').value = 'invalid';
  invalid.components.billingreference.getActiveErrors = () => ['invalid'];
  assert.equal((await run(invalid)).draftCheck, 'DRAFT_BILLING_REFERENCE_VALUE');
});

test('billing snapshot preserves reviewed values while tolerating unrelated HMS field drift', () => {
  const before = { session: 's', arProfileId: 'p', track: 'x', partyValues: { araccountname: 'A' },
    modelData: { billingreference: '', roomtype: 'A', nested: { value: 1 } },
    formData: { billingreference: '', roomtype: 'A' },
    visibleFields: [{ name: 'billingreference', value: '' }, { name: 'roomtype', value: 'A' }] };
  const after = structuredClone(before); after.formData.billingreference = ' ref '; after.visibleFields[0].value = ' ref ';
  assert.equal(billingOnlyDraftChange(before, after, ' ref '), true);
  for (const mutate of [
    (s) => { s.formData.roomtype = 'B'; },
    (s) => { s.visibleFields[1].value = 'B'; }, (s) => { s.arProfileId = 'other'; },
    (s) => { s.modelData.billingreference = 'different'; }, (s) => { s.formData.billingreference = 'ref'; },
  ]) { const changed = structuredClone(after); mutate(changed); assert.equal(billingOnlyDraftChange(before, changed, ' ref '), false); }
  const nativeDrift = structuredClone(after); nativeDrift.modelData.nested.value = 2;
  assert.equal(billingOnlyDraftChange(before, nativeDrift, ' ref '), true);
});

test('native save refuses unpaired or nonfunction server guards before any browser work', async () => {
  const callback = async () => true;
  for (const guards of [{ authorizeCandidate: callback }, { dispatchCandidate: callback },
    { authorizeCandidate: true, dispatchCandidate: callback }, { authorizeCandidate: callback, dispatchCandidate: null }]) {
    assert.equal((await saveNewLabtestStay(pageStub(), saveInputs, guards)).issue, 'SAVE_GUARD_CALLBACKS_INVALID');
  }
});
