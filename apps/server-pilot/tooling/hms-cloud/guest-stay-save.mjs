// One narrowly authorized save on a verified, unsaved HRCEN Labtest draft.
import { verifiedLabtestProfileToken, isVerifiedLabtestProfileCurrent } from './guest-profile.mjs';
import { consumeLabtestPreimage } from './labtest-preimage.mjs';
import { blankPartyFields } from './labtest-party-fields.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const SAVE_PATH = '/web/base/OSRESV.HDR';
const usedPages = new WeakSet();
const clean = (value) => String(value ?? '').trim();
const safeIssue = (error) => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'SAVE_UNVERIFIED';
const CHILD_BANDS = Object.freeze(['child1', 'child2', 'child3']);

function normalizeChildSelection(selection) {
  if (!selection || !['updated_unsaved', 'unchanged_unsaved'].includes(selection.outcome) ||
      !Array.isArray(selection.requestedChildAges) || !Array.isArray(selection.actualChildAges) ||
      selection.requestedChildAges.length !== 1 || selection.actualChildAges.length !== 1 ||
      !Number.isInteger(selection.actualChildAges[0]) || selection.actualChildAges[0] < 0 || selection.actualChildAges[0] > 17 ||
      JSON.stringify(selection.requestedChildAges) !== JSON.stringify(selection.actualChildAges)) return null;
  const counts = selection.ageBandCounts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts) ||
      JSON.stringify(Object.keys(counts).sort()) !== JSON.stringify([...CHILD_BANDS].sort()) ||
      CHILD_BANDS.some((name) => !Number.isInteger(counts[name]) || counts[name] < 0) ||
      CHILD_BANDS.reduce((sum, name) => sum + counts[name], 0) !== 1) return null;
  return { age: selection.actualChildAges[0], bands: Object.fromEntries(CHILD_BANDS.map((name) => [name, counts[name]])) };
}

function normalizeSourceSelection(selection) {
  const nativeCode = clean(selection?.nativeCode);
  const description = clean(selection?.candidate?.description);
  if (selection?.outcome !== 'selected_unsaved' || !clean(selection.searchId) || !nativeCode || !description ||
      selection.candidate?.nativeCode !== nativeCode || selection.identityEvidence !== 'unique_current_picker_row_and_description_readback' ||
      selection.nativeCodeReadback?.outcome !== 'unsupported' ||
      selection.nativeCodeReadback?.issue !== 'SOURCE_CODE_NOT_EXPOSED_ON_FORM') return null;
  return { nativeCode, description };
}

function normalizeAgencySelection(selection) {
  if (!selection) return null;
  const nativeId = clean(selection.nativeId);
  const name = clean(selection.displayedAgency);
  const iataNumber = clean(selection.agencyIataNumber);
  if (selection.outcome !== 'selected_unsaved' || !clean(selection.searchId) || !nativeId || !name || !iataNumber ||
      selection.nativeIdEvidence !== 'form_change_response') return undefined;
  return { nativeId, name, iataNumber };
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
      'adults', 'children', 'child1', 'child2', 'child3', 'sourceofbusinessdesc'];
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
    const activeChildCategories = String(data.activechildcategories ?? '').trim();
    if (!exact('propertycode', 'HRCEN') || !exact('PKID', '@[EMPTY]#@[EMPTY]#HRCEN#') || !exact('status', 'New') ||
        !exact('guestid', expected.guestId) || !exact('firstname', 'Proof') || !exact('lastname', 'Labtest') ||
        ['confirmationnumber', 'reservationid', 'reservationstayid', 'recordid', 'arprofileid', 'araccountid',
          'guaranteecreditcardid', 'leaseguaranteecreditcardid'].some((name) => !exact(name, '')) ||
        !keys.includes('bookingsessionid') || keys.filter((k) => k.toLowerCase() === 'bookingsessionid').length !== 1 ||
        !String(data.bookingsessionid ?? '').trim() || value('confirmationnumber') || value('guestid') !== expected.guestId ||
        value('firstname') !== 'Proof' || value('lastname') !== 'Labtest' || value('arrivaldate') !== expected.arrivalDisplay ||
        value('departuredate') !== expected.departureDisplay || value('roomtype') !== expected.roomType ||
        value('rateplan') !== expected.ratePlan || !value('track') || value('reservationnote') !== expected.note ||
        !exact('adults', String(expected.adults)) || String(globalThis.Ext?.getCmp?.(fields.adults[0].id.replace(/-inputEl$/, ''))?.getValue?.() ?? '').trim() !== String(expected.adults) ||
        !exact('children', '1') || !exact('childages', String(expected.childAge)) || Array.isArray(data.childages) ||
        childBands.some((name) => !exact(name, String(expected.childAgeBands[name]))) ||
        !exact('activechildcategories', activeChildCategories) || !exact('updatechildcategories', 'true') ||
        !exact('sourceofbus', expected.sourceBusiness.nativeCode) || !exact('sourceofbusinessdesc', expected.sourceBusiness.description) ||
        value('adults') !== String(expected.adults) || value('children') !== '1' ||
        childBands.some((name) => value(name) !== String(expected.childAgeBands[name])) ||
        value('sourceofbusinessdesc') !== expected.sourceBusiness.description ||
        value('guaranteetype') !== 'Non-Guaranteed Individual' || cmp('guaranteetype')?.getValue?.() !== expected.guaranteeType ||
        value('udfchar13') || value('emailaddress') || typeof cmp('udfchkbox04')?.getValue !== 'function' ||
        cmp('udfchkbox04').getValue() !== false) return null;
    const blankRequired = [...form.el.dom.querySelectorAll('input,textarea,select')].filter(visible).some((el) => {
      const component = el.id && globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      return component?.allowBlank === false && !String(el.value ?? '').trim();
    });
    if (blankRequired) return null;
    return { session: String(data.bookingsessionid).trim(), track: value('track'), activeChildCategories };
  }, { origin: ORIGIN, expected, blankPartyFields, childBands: CHILD_BANDS });
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
      adults: String(expected.adults), children: '1', childages: String(expected.childAge),
      child1: String(expected.childAgeBands.child1), child2: String(expected.childAgeBands.child2),
      child3: String(expected.childAgeBands.child3), activechildcategories: expected.activeChildCategories,
      updatechildcategories: 'true', sourceofbus: expected.sourceBusiness.nativeCode,
      sourceofbusinessdesc: expected.sourceBusiness.description,
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
      profileControls.every((key) => {
        const matches = keys.filter((name) => name.toLowerCase() === key);
        return !matches.length || (matches.length === 1 && matches[0] === key && ['', '0'].includes(body.get(key)));
      });
  } catch { return false; }
}

/** The page is sealed after this action. Use a fresh guarded session for reconciliation. */
export async function saveNewLabtestStay(page, {
  preimageId, arrival, departure, guestId, roomType, ratePlan, guaranteeType, note,
  adults, childAgeSelection, sourceSelection, agencySelection,
} = {}, { timeoutMs = 20_000 } = {}) {
  const formatted = dates(arrival, departure);
  if (!formatted || !/^\d+$/.test(clean(guestId)) || !/^[A-Z0-9]{1,12}$/.test(roomType || '') ||
      !/^[A-Z0-9]{1,12}$/.test(ratePlan || '') || guaranteeType !== 'NGI' || typeof note !== 'string' || !note.trim() || note.length > 200 ||
      !preimageId) return { outcome: 'input_gap', issue: 'INVALID_LABTEST_SAVE_INPUT' };
  if (!Number.isInteger(adults) || adults < 0) return { outcome: 'input_gap', issue: 'ADULT_COUNT_REQUIRED' };
  const child = normalizeChildSelection(childAgeSelection);
  if (!child) return { outcome: 'input_gap', issue: 'SINGLE_CHILD_AGE_SELECTION_REQUIRED' };
  const source = normalizeSourceSelection(sourceSelection);
  if (!source) return { outcome: 'input_gap', issue: 'SOURCE_SELECTION_REQUIRED' };
  const agency = normalizeAgencySelection(agencySelection);
  if (agencySelection && !agency) return { outcome: 'input_gap', issue: 'AGENCY_SELECTION_UNVERIFIED' };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { outcome: 'input_gap', issue: 'INVALID_TIMEOUT' };
  if (usedPages.has(page)) return { outcome: 'refused', issue: 'PAGE_WRITE_ALREADY_USED' };
  let dispatched = false, requestSeen = false, blocked = 0, sendRequests = 0, nativeDialog = null, response = null, armed = false;
  let authorizedRequest, scope, fence, signalStop;
  const stopped = new Promise((resolve) => { signalStop = resolve; });
  const stop = (issue) => { armed = false; fence?.quarantine(); signalStop({ issue }); };
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
      adults: String(adults), childAge: child.age, childAgeBands: child.bands, sourceBusiness: source, partyValues };
    const state = await bounded(draft(page, expected));
    if (!state) throw new Error('LABTEST_DRAFT_UNVERIFIED');
    const profileToken = await bounded(verifiedLabtestProfileToken(page, { nativeId: expected.guestId, session: state.session }));
    if (!profileToken) throw new Error('LABTEST_PROFILE_PROOF_STALE');
    Object.assign(expected, state, { profileToken });
    fence = await bounded(installPageRequestFence(page, [SAVE_PATH]));
    scope = fence.open();
    if (!consumeLabtestPreimage(page, { preimageId, arrival, departure })) throw new Error('PREIMAGE_STALE_OR_MISMATCHED');
    await bounded(page.route('**/*', async (route) => {
      const request = route.request();
      let pathname = '', action = '';
      try { const url = new URL(request.url()); pathname = url.pathname; action = url.searchParams.get('pageaction') || ''; }
      catch { /* Block unparseable targets. */ }
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && pathname &&
          !/save|delete|cancel|checkin|checkout|send|email|mail|crs/i.test(pathname) &&
          !(pathname === SAVE_PATH && /^(SAVE|DELETE)$/i.test(action))) return route.fallback();
      if (/send|email|mail/i.test(pathname)) sendRequests += 1;
      if (armed && !nativeDialog && matchesSave(page, request, expected) && scope.allow(request)) {
        armed = false;
        requestSeen = true;
        authorizedRequest = request;
        // This is the only dispatch past the context read guard, and only after payload verification.
        dispatched = true;
        return route.continue();
      }
      armed = false;
      blocked += 1;
      return route.abort();
    }));
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
    const verified = requestSeen && response?.status() === 200 && snapshot.confirmation && !nativeDialog && !dialogs.length;
    return { outcome: verified ? 'saved_same_form' : dispatched ? 'uncertain' : 'not_dispatched',
      confirmation: snapshot.confirmation || null, status: snapshot.status || null, httpStatus: response?.status() || null,
      requestSeen, blockedRequests: blocked, browserSendRequests: sendRequests, nativeDialog, dialogs };
  } catch (error) {
    armed = false;
    return { outcome: dispatched ? 'uncertain' : 'not_dispatched', issue: safeIssue(error),
      requestSeen, httpStatus: response?.status() || null, blockedRequests: blocked, browserSendRequests: sendRequests, nativeDialog };
  } finally {
    clearTimeout(timer);
    scope?.close();
    if (!nativeDialog && !usedPages.has(page)) page.off('dialog', onDialog);
  }
}
