// One narrowly authorized save on a verified, unsaved HRCEN Labtest draft.
import { createHash } from 'node:crypto';
import { verifiedLabtestProfileToken, isVerifiedLabtestProfileCurrent } from './guest-profile.mjs';
import { consumeLabtestPreimage } from './labtest-preimage.mjs';
import { blankPartyFields } from './labtest-party-fields.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';
import { shouldAbortReadOnlyRequest } from '../playwright-quote/hms-read-only-guard.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const SAVE_PATH = '/web/base/OSRESV.HDR';
const DANGEROUS_PATH = /save|delete|cancel|checkin|checkout|send|email|mail|crs/i;
const SAFE_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
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

function normalizeChildSelection(selection) {
  if (!selection || !['updated_unsaved', 'unchanged_unsaved'].includes(selection.outcome) ||
      !Array.isArray(selection.requestedChildAges) || !Array.isArray(selection.actualChildAges) ||
      selection.requestedChildAges.length !== 1 || selection.actualChildAges.length !== 1 ||
      !Number.isInteger(selection.actualChildAges[0]) || selection.actualChildAges[0] < 0 || selection.actualChildAges[0] > 17 ||
      !clean(selection.profileProofToken) ||
      JSON.stringify(selection.requestedChildAges) !== JSON.stringify(selection.actualChildAges)) return null;
  const counts = selection.ageBandCounts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts) ||
      JSON.stringify(Object.keys(counts).sort()) !== JSON.stringify([...CHILD_BANDS].sort()) ||
      CHILD_BANDS.some((name) => !Number.isInteger(counts[name]) || counts[name] < 0) ||
      CHILD_BANDS.reduce((sum, name) => sum + counts[name], 0) !== 1) return null;
  return { age: selection.actualChildAges[0], bands: Object.fromEntries(CHILD_BANDS.map((name) => [name, counts[name]])),
    profileProofToken: clean(selection.profileProofToken) };
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
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || !Number.isInteger(proof.adults) || proof.adults < 0) return null;
  const child = normalizeChildSelection(proof.childAgeSelection);
  const source = normalizeSourceSelection(proof.sourceSelection);
  if (!child || !source || child.profileProofToken !== source.profileProofToken) return null;
  return { adults: String(proof.adults), childAge: child.age, childAgeBands: child.bands, sourceBusiness: source,
    profileProofToken: child.profileProofToken };
}

function normalizeAgencySelection(selection) {
  if (!selection) return null;
  const nativeId = clean(selection.nativeId);
  const name = clean(selection.displayedAgency);
  const iataNumber = clean(selection.agencyIataNumber);
  if (selection.outcome !== 'selected_unsaved' || !clean(selection.searchId) || !nativeId || !name || !iataNumber ||
      !clean(selection.profileProofToken) || selection.nativeIdEvidence !== 'form_change_response') return undefined;
  return { nativeId, name, iataNumber, profileProofToken: clean(selection.profileProofToken) };
}

export function createSelectionProofTokensMatch(createFields, agency, profileToken) {
  return Boolean(profileToken && (!createFields || createFields.profileProofToken === profileToken) &&
    (!agency || agency.profileProofToken === profileToken));
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
      'roomtype', 'rateplan', 'track', 'guaranteetype', 'reservationnote', 'udfchkbox04', 'udfchar13', 'emailaddress',
      ...(expected.createFieldProof ? ['adults', 'children', 'child1', 'child2', 'child3', 'sourceofbusinessdesc'] : [])];
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
    if (blankPartyFields.some((name) => !exact(name, partyValues[name] ?? '') ||
        partyInputs.filter((el) => el.name.toLowerCase() === name).length > 1) ||
        partyInputs.some((el) => el.name !== el.name.toLowerCase() ||
          String(el.value ?? '').trim() !== (partyValues[el.name.toLowerCase()] ?? ''))) return null;
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
    let activeChildCategories, submittedData;
    if (expected.createFieldProof) {
      const proof = expected.createFieldProof;
      submittedData = record.getData?.();
      if (!submittedData || typeof submittedData !== 'object' || Array.isArray(submittedData)) return null;
      activeChildCategories = String(data.activechildcategories ?? '').trim();
      if (!exact('adults', proof.adults) || String(globalThis.Ext?.getCmp?.(fields.adults[0].id.replace(/-inputEl$/, ''))?.getValue?.() ?? '').trim() !== proof.adults ||
          !exact('children', '1') || !exact('childages', String(proof.childAge)) || Array.isArray(data.childages) ||
          childBands.some((name) => !exact(name, String(proof.childAgeBands[name]))) ||
          !exact('activechildcategories', activeChildCategories) || !exact('updatechildcategories', 'true') ||
          !exact('sourceofbus', proof.sourceBusiness.nativeCode) || !exact('sourceofbusinessdesc', proof.sourceBusiness.description) ||
          value('adults') !== proof.adults || value('children') !== '1' ||
          childBands.some((name) => value(name) !== String(proof.childAgeBands[name])) ||
          value('sourceofbusinessdesc') !== proof.sourceBusiness.description) return null;
    }
    const blankRequired = [...form.el.dom.querySelectorAll('input,textarea,select')].filter(visible).some((el) => {
      const component = el.id && globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      return component?.allowBlank === false && !String(el.value ?? '').trim();
    });
    if (blankRequired) return null;
    return { session: String(data.bookingsessionid).trim(), track: value('track'),
      ...(expected.createFieldProof ? { activeChildCategories,
        formData: Object.fromEntries(Object.keys(submittedData).map((key) => [key, submittedData[key]])) } : {}) };
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
      return body.getAll(key).length === 1 && body.get(key) === String(value ?? '');
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
    const required = {
      SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR',
      propertycode: 'HRCEN', PKID: '@[EMPTY]#@[EMPTY]#HRCEN#', status: 'New', firstname: 'Proof', lastname: 'Labtest',
      guestid: expected.guestId, bookingsessionid: expected.session, arrivaldate: expected.arrivalWire,
      departuredate: expected.departureWire, roomtype: expected.roomType, rateplan: expected.ratePlan, track: expected.track,
      reservationnote: expected.note, confirmationnumber: '', reservationid: '', reservationstayid: '', recordid: '',
      udfchkbox04: '0', udfchar13: '', emailaddress: '', guaranteecreditcardid: '', leaseguaranteecreditcardid: '',
      arprofileid: '', araccountid: '', guaranteetype: expected.guaranteeType, pagemode: 'display', savecctoprofile: '0', savesettlementcctoprofile: '0',
      ...(expected.createFieldProof ? {
        adults: expected.createFieldProof.adults, children: '1', childages: String(expected.createFieldProof.childAge),
        child1: String(expected.createFieldProof.childAgeBands.child1), child2: String(expected.createFieldProof.childAgeBands.child2),
        child3: String(expected.createFieldProof.childAgeBands.child3), activechildcategories: expected.activeChildCategories,
        updatechildcategories: 'true', sourceofbus: expected.createFieldProof.sourceBusiness.nativeCode,
        sourceofbusinessdesc: expected.createFieldProof.sourceBusiness.description,
      } : {}),
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
      (!expected.createFieldProof || matchesFullCreateBody(body, expected.formData)) &&
      profileControls.every((key) => {
        const matches = keys.filter((name) => name.toLowerCase() === key);
        return !matches.length || (matches.length === 1 && matches[0] === key && ['', '0'].includes(body.get(key)));
      });
  } catch { return false; }
}

/** Keep the one allowed create request behind the page fence and deny context writes for its lifetime. */
export async function installLabtestCreateSaveRouteChain(page, {
  frame, fence, scope, isArmed, matches, onCandidate, onDispatch, onBlocked,
} = {}) {
  if (!page || typeof page.route !== 'function' || typeof page.context !== 'function' || !frame ||
      typeof fence?.isQuarantined !== 'function' || typeof scope?.allow !== 'function' ||
      typeof isArmed !== 'function' || typeof matches !== 'function') throw new Error('SAVE_ROUTE_CHAIN_INPUT_INVALID');
  const context = page.context();
  if (typeof context?.route !== 'function') throw new Error('SAVE_ROUTE_CHAIN_INPUT_INVALID');
  let active = true, candidateRequest = null, continuedRequest = null;
  const observeBlocked = (request) => {
    try { onBlocked?.(request); } catch { /* Diagnostics cannot weaken the route decision. */ }
  };
  const isSameFrame = (request) => {
    try { return request.frame() === frame; } catch { return false; }
  };
  const denyUnapprovedContextRequest = async (route, request) => {
    const method = String(request.method() || '').toUpperCase();
    let sendEmailPath = false;
    try { sendEmailPath = /send|email|mail/i.test(new URL(request.url()).pathname); }
    catch { /* Invalid write targets are still rejected by the method check below. */ }
    let sharedGuardWouldBlock = false;
    try {
      sharedGuardWouldBlock = shouldAbortReadOnlyRequest({
        method, url: request.url(), postData: request.postData?.(),
      });
    } catch { /* Diagnostics cannot weaken the route decision. */ }
    if (!SAFE_READ_METHODS.has(method) || sendEmailPath || sharedGuardWouldBlock) {
      observeBlocked(request);
      return route.abort();
    }
    return route.fallback();
  };
  const contextRoute = async (route) => {
    const request = route.request();
    if (active && candidateRequest === request && continuedRequest !== request && isSameFrame(request) &&
        isArmed() && !fence.isQuarantined()) {
      // The page fence has consumed this exact request; never authorize it twice.
      continuedRequest = request;
      try { onDispatch?.(request); } catch { /* Preserve the exact-request decision. */ }
      return route.continue();
    }
    return denyUnapprovedContextRequest(route, request);
  };
  const pageRoute = async (route) => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); }
    catch {
      observeBlocked(request);
      return route.abort();
    }
    const method = String(request.method() || '').toUpperCase();
    if (SAFE_READ_METHODS.has(method) && url.pathname.toLowerCase() === SAVE_PATH.toLowerCase()) {
      observeBlocked(request);
      return route.fallback();
    }
    if (SAFE_READ_METHODS.has(method) && url.pathname && !DANGEROUS_PATH.test(url.pathname)) return route.fallback();
    if (url.pathname === SAVE_PATH) {
      if (active && candidateRequest === null && isArmed() && !fence.isQuarantined() && isSameFrame(request) && matches(request, frame)) {
        let allowed = false;
        try { allowed = scope.allow(request); } catch { /* The lifetime fence stays fail-closed. */ }
        if (allowed) {
          candidateRequest = request;
          try { onCandidate?.(request); } catch { /* Do not bypass the page and context fences. */ }
        } else observeBlocked(request);
      } else observeBlocked(request);
      return route.fallback();
    }
    observeBlocked(request);
    return route.abort();
  };

  let contextInstalled = false, pageInstalled = false;
  try {
    // Install after the shared context read guard so only the exact candidate may continue.
    await context.route('**/*', contextRoute);
    contextInstalled = true;
    await page.route('**/*', pageRoute);
    pageInstalled = true;
  } catch (error) {
    active = false;
    if (pageInstalled) await page.unroute('**/*', pageRoute).catch(() => {});
    if (contextInstalled) await context.unroute('**/*', contextRoute).catch(() => {});
    throw error;
  }
  return {
    candidate: () => candidateRequest,
    continued: () => continuedRequest,
    disarm: () => { active = false; },
    async close() {
      active = false;
      // Keep both deny routes for the context lifetime; only one exact candidate was eligible.
    },
  };
}

/** The page is sealed after this action. Use a fresh guarded session for reconciliation. */
export async function saveNewLabtestStay(page, {
  preimageId, arrival, departure, guestId, roomType, ratePlan, guaranteeType, note,
  createFieldProof, agencySelection,
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
  if (agency && !createFields) return { outcome: 'input_gap', issue: 'AGENCY_REQUIRES_CREATE_FIELD_PROOF' };
  if (agency && agency.profileProofToken !== createFields.profileProofToken) {
    return { outcome: 'input_gap', issue: 'AGENCY_SELECTION_PROOF_MISMATCH' };
  }
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
    const partyValues = agency ? {
      taid1: agency.nativeId, ta1: agency.name, bookingagency1iatanumber: agency.iataNumber,
    } : {};
    const expected = { ...formatted, guestId: clean(guestId), roomType, ratePlan, guaranteeType, note,
      ...(createFields ? { createFieldProof: createFields } : {}), partyValues };
    const state = await bounded(draft(page, expected));
    if (!state) throw new Error('LABTEST_DRAFT_UNVERIFIED');
    if (createFields && !matchesCreateModelFieldSchema(state.formData)) throw new Error('CREATE_FORM_FIELD_SCHEMA_CHANGED');
    const profileToken = await bounded(verifiedLabtestProfileToken(page, { nativeId: expected.guestId, session: state.session }));
    if (!profileToken) throw new Error('LABTEST_PROFILE_PROOF_STALE');
    if (!createSelectionProofTokensMatch(createFields, agency, profileToken)) throw new Error('CREATE_SELECTION_PROOF_STALE');
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
