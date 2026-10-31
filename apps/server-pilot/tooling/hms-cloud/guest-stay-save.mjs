// One narrowly authorized save on a verified, unsaved HRCEN Labtest draft.
import { verifiedLabtestProfileToken, isVerifiedLabtestProfileCurrent } from './guest-profile.mjs';
import { consumeLabtestPreimage } from './labtest-preimage.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const SAVE_PATH = '/web/base/OSRESV.HDR';
const usedPages = new WeakSet();
const clean = (value) => String(value ?? '').trim();
const safeIssue = (error) => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'SAVE_UNVERIFIED';

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
  return page.evaluate(({ origin, expected }) => {
    if (location.origin !== origin || !/Infor HMS\s*-\s*HRCEN/i.test(document.title)) return null;
    const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const names = ['ta1', 'confirmationnumber', 'guestid', 'firstname', 'lastname', 'arrivaldate', 'departuredate',
      'roomtype', 'rateplan', 'track', 'guaranteetype', 'reservationnote', 'udfchkbox04', 'udfchar13', 'emailaddress'];
    const fields = Object.fromEntries(names.map((name) => [name, [...document.querySelectorAll('input,textarea,select')]
      .filter((el) => el.name === name && visible(el))]));
    if (names.some((name) => fields[name].length !== 1)) return null;
    const cmp = (name) => globalThis.Ext?.getCmp?.(fields[name][0].id.replace(/-inputEl$/, ''));
    const form = cmp('guestid')?.up?.('form');
    const record = form?.getRecord?.(), data = record?.data, keys = data && Object.keys(data);
    if (!form?.el?.dom || !data || names.some((name) => !form.el.dom.contains(fields[name][0]))) return null;
    const exact = (key, value) => Object.hasOwn(data, key) && keys.filter((k) => k.toLowerCase() === key.toLowerCase()).length === 1 &&
      String(data[key] ?? '').trim() === value;
    const value = (name) => fields[name][0].value.trim();
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
    const blankRequired = [...form.el.dom.querySelectorAll('input,textarea,select')].filter(visible).some((el) => {
      const component = el.id && globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      return component?.allowBlank === false && !String(el.value ?? '').trim();
    });
    if (blankRequired) return null;
    return { session: String(data.bookingsessionid).trim(), track: value('track') };
  }, { origin: ORIGIN, expected });
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
    };
    return request.method() === 'POST' && request.frame() === page.mainFrame() && url.origin === ORIGIN &&
      url.pathname === SAVE_PATH && !url.hash && [...url.searchParams].length === 1 && url.searchParams.get('pageaction') === 'SAVE' &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      isVerifiedLabtestProfileCurrent(page, { nativeId: expected.guestId, session: expected.session, token: expected.profileToken }) &&
      Object.entries(required).every(([key, value]) => body.getAll(key).length === 1 && body.get(key) === value &&
        keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1);
  } catch { return false; }
}

/** The page is sealed after this action. Use a fresh guarded session for reconciliation. */
export async function saveNewLabtestStay(page, { preimageId, arrival, departure, guestId, roomType, ratePlan, guaranteeType, note } = {},
  { timeoutMs = 20_000 } = {}) {
  const formatted = dates(arrival, departure);
  if (!formatted || !/^\d+$/.test(clean(guestId)) || !/^[A-Z0-9]{1,12}$/.test(roomType || '') ||
      !/^[A-Z0-9]{1,12}$/.test(ratePlan || '') || guaranteeType !== 'NGI' || typeof note !== 'string' || !note.trim() || note.length > 200 ||
      !preimageId) return { outcome: 'input_gap', issue: 'INVALID_LABTEST_SAVE_INPUT' };
  if (usedPages.has(page)) return { outcome: 'refused', issue: 'PAGE_WRITE_ALREADY_USED' };
  let dispatched = false, requestSeen = false, blocked = 0, sendRequests = 0, nativeDialog = null, response = null, armed = false;
  let authorizedRequest;
  const onDialog = (dialog) => { nativeDialog = { type: dialog.type(), message: dialog.message() }; };
  page.on('dialog', onDialog);
  try {
    if (await page.locator('.x-window:visible:not(.x-menu)').count()) throw new Error('UNEXPECTED_DIALOG');
    const expected = { ...formatted, guestId: clean(guestId), roomType, ratePlan, guaranteeType, note };
    const state = await draft(page, expected);
    if (!state) throw new Error('LABTEST_DRAFT_UNVERIFIED');
    const profileToken = await verifiedLabtestProfileToken(page, { nativeId: expected.guestId, session: state.session });
    if (!profileToken) throw new Error('LABTEST_PROFILE_PROOF_STALE');
    Object.assign(expected, state, { profileToken });
    if (!consumeLabtestPreimage(page, { preimageId, arrival, departure })) throw new Error('PREIMAGE_STALE_OR_MISMATCHED');
    await installPageRequestFence(page, [SAVE_PATH]);
    await page.route('**/*', async (route) => {
      const request = route.request();
      let pathname = '', action = '';
      try { const url = new URL(request.url()); pathname = url.pathname; action = url.searchParams.get('pageaction') || ''; }
      catch { /* Block unparseable targets. */ }
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && pathname &&
          !/save|delete|cancel|checkin|checkout|send|email|mail|crs/i.test(pathname) &&
          !(pathname === SAVE_PATH && /^(SAVE|DELETE)$/i.test(action))) return route.fallback();
      if (/send|email|mail/i.test(pathname)) sendRequests += 1;
      if (armed && !nativeDialog && matchesSave(page, request, expected)) {
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
    });
    usedPages.add(page);
    const pending = page.waitForResponse((item) => item.request() === authorizedRequest, { timeout: timeoutMs }).catch(() => null);
    const save = page.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
    if (await save.count() !== 1) throw new Error('SAVE_CONTROL_NOT_UNIQUE');
    armed = true;
    await save.click({ timeout: 5_000, noWaitAfter: true });
    response = await pending;
    armed = false;
    if (response?.status() === 200 && !nativeDialog) {
      await page.waitForFunction(() => {
        const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
        const confirmations = [...document.querySelectorAll('input[name="confirmationnumber"]')].filter(visible);
        return confirmations.length === 1 && Boolean(confirmations[0].value.trim());
      }, null, { timeout: timeoutMs }).catch(() => null);
    }
    const snapshot = await page.evaluate(() => {
      const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
      const value = (name) => { const els = [...document.querySelectorAll(`input[name="${name}"]`)].filter(visible); return els.length === 1 ? els[0].value.trim() : null; };
      return { confirmation: value('confirmationnumber'), status: value('status') };
    }).catch(() => ({ confirmation: null, status: null }));
    const dialogs = await page.locator('.x-window:visible:not(.x-menu)').allTextContents().catch(() => []);
    const verified = requestSeen && response?.status() === 200 && snapshot.confirmation && !nativeDialog && !dialogs.length;
    return { outcome: verified ? 'saved_same_form' : dispatched ? 'uncertain' : 'not_dispatched',
      confirmation: snapshot.confirmation || null, status: snapshot.status || null, httpStatus: response?.status() || null,
      requestSeen, blockedRequests: blocked, browserSendRequests: sendRequests, nativeDialog, dialogs };
  } catch (error) {
    armed = false;
    return { outcome: dispatched ? 'uncertain' : 'not_dispatched', issue: safeIssue(error),
      requestSeen, httpStatus: response?.status() || null, blockedRequests: blocked, browserSendRequests: sendRequests, nativeDialog };
  }
}
