// Amend only the reservation note on one verified saved Labtest record.
import { currentLabtestRecord } from './labtest-record.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const SAVE_PATH = '/web/base/OSRESV.HDR';
const usedPages = new WeakSet();
const issue = (error) => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'AMEND_UNVERIFIED';

function matchesAmend(request, frame, expected, state) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || ''), keys = [...body.keys()];
    const required = {
      SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR',
      propertycode: 'HRCEN', status: 'Reserved', firstname: 'Proof', lastname: 'Labtest', confirmationnumber: expected.confirmation,
      guestid: expected.guestId, arrivaldate: state.arrivalWire, departuredate: state.departureWire,
      roomtype: expected.roomType, rateplan: expected.ratePlan, track: state.track, reservationnote: expected.newNote,
      udfchkbox04: '0', udfchar13: '', emailaddress: '', guaranteetype: 'NGI', pagemode: 'view',
      savecctoprofile: '0', savesettlementcctoprofile: '0', ...state.native,
    };
    return request.method() === 'POST' && request.frame() === frame && url.origin === ORIGIN && url.pathname === SAVE_PATH &&
      !url.hash && [...url.searchParams].length === 1 && url.searchParams.get('pageaction') === 'SAVE' &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      Object.entries(required).every(([key, value]) => body.getAll(key).length === 1 && body.get(key) === value &&
        keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1);
  } catch { return false; }
}

/** Requires the Record View already opened by the existing readers. Always reconcile in a fresh session. */
export async function amendLabtestNote(page, expected = {}, { timeoutMs = 20_000 } = {}) {
  if (typeof expected.newNote !== 'string' || !expected.newNote.trim() || expected.newNote.length > 200 ||
      expected.newNote === expected.note) return { outcome: 'input_gap', issue: 'NEW_NOTE_INVALID' };
  if (usedPages.has(page)) return { outcome: 'refused', issue: 'PAGE_WRITE_ALREADY_USED' };
  let armed = false, dispatched = false, blocked = 0, sendRequests = 0, nativeDialog = null, response = null, authorizedRequest;
  page.on('dialog', (dialog) => { nativeDialog = { type: dialog.type(), message: dialog.message() }; });
  try {
    const state = await currentLabtestRecord(page, expected), frame = state.frame;
    if (await page.locator('.x-window:visible:not(.x-menu)').count() !== 1 ||
        await frame.locator('.x-window:visible:not(.x-menu)').count()) throw new Error('UNEXPECTED_DIALOG');
    const field = frame.locator('textarea[name="reservationnote"]:visible');
    const save = frame.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
    if (await field.count() !== 1 || await save.count() !== 1) throw new Error('AMEND_CONTROL_NOT_UNIQUE');
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
      if (armed && !nativeDialog && matchesAmend(request, frame, expected, state)) {
        armed = false;
        authorizedRequest = request;
        dispatched = true;
        return route.continue();
      }
      armed = false;
      blocked += 1;
      return route.abort();
    });
    usedPages.add(page);
    const changed = await field.evaluate((el, value) => {
      const component = globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      if (!component?.setValue || el.readOnly || el.disabled) return false;
      component.setValue(value);
      component.fireEvent?.('blur', component);
      return el.value === value;
    }, expected.newNote);
    if (!changed) throw new Error('NOTE_EDIT_UNVERIFIED');
    await field.blur();
    const after = await currentLabtestRecord(page, { ...expected, note: expected.newNote });
    if (JSON.stringify(state.native) !== JSON.stringify(after.native) || state.track !== after.track ||
        blocked || nativeDialog || await frame.locator('.x-window:visible:not(.x-menu)').count()) {
      throw new Error('AMEND_DRAFT_CHANGED');
    }
    const pending = page.waitForResponse((item) => item.request() === authorizedRequest, { timeout: timeoutMs }).catch(() => null);
    armed = true;
    await save.click({ timeout: 5_000, noWaitAfter: true });
    response = await pending;
    armed = false;
    await page.waitForTimeout(500);
    const dialogs = await frame.locator('.x-window:visible:not(.x-menu)').allTextContents().catch(() => []);
    return { outcome: dispatched && response?.status() === 200 && !nativeDialog && !dialogs.length ? 'awaiting_readback' :
      dispatched ? 'uncertain' : 'not_dispatched', httpStatus: response?.status() || null,
    blockedRequests: blocked, browserSendRequests: sendRequests, nativeDialog, dialogs };
  } catch (error) {
    armed = false;
    return { outcome: dispatched ? 'uncertain' : 'not_dispatched', issue: issue(error),
      httpStatus: response?.status() || null, blockedRequests: blocked, browserSendRequests: sendRequests, nativeDialog };
  }
}
