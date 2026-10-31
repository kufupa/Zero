// Amend only the reservation note on one verified saved Labtest record.
import { currentLabtestRecord, snapshotLabtestRecord, cleanLabtestRecord,
  unchangedLabtestRecord, unchangedLabtestBusinessParties, matchesLabtestBody } from './labtest-record.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';
import { installLabtestSaveRouteChain } from './saved-stay-save-route-chain.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const SAVE_PATH = '/web/base/OSRESV.HDR';
const usedPages = new WeakSet();
const issue = (error) => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'AMEND_UNVERIFIED';

function matchesAmend(request, frame, expected, state, baseline) {
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
        keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1) &&
      matchesLabtestBody(body, baseline, { reservationnote: expected.newNote });
  } catch { return false; }
}

/** Requires the Record View already opened by the existing readers. Always reconcile in a fresh session. */
export async function amendLabtestNote(page, expected = {}, { timeoutMs = 20_000 } = {}) {
  if (typeof expected.newNote !== 'string' || !expected.newNote.trim() || expected.newNote.length > 200 ||
      expected.newNote === expected.note) return { outcome: 'input_gap', issue: 'NEW_NOTE_INVALID' };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { outcome: 'input_gap', issue: 'INVALID_TIMEOUT' };
  if (usedPages.has(page)) return { outcome: 'refused', issue: 'PAGE_WRITE_ALREADY_USED' };
  let armed = false, possiblyDispatched = false, dispatched = false, blockedAtDispatch = 0, blocked = 0;
  let sendRequests = 0, nativeDialog = null, response = null, authorizedRequest, scope, fence, routeChain;
  let stopReason = null;
  let signalStop;
  const stopped = new Promise((resolve) => { signalStop = resolve; });
  const stop = (issue) => {
    stopReason ||= issue;
    armed = false;
    routeChain?.disarm();
    fence?.quarantine();
    signalStop({ issue });
  };
  const bounded = async (action) => {
    const result = await Promise.race([Promise.resolve(action).then((value) => ({ value })), stopped]);
    if (result.issue) throw new Error(result.issue);
    return result.value;
  };
  const timer = setTimeout(() => stop('AMEND_TIMEOUT'), timeoutMs);
  const onDialog = (dialog) => { nativeDialog = { type: dialog.type(), message: dialog.message() }; stop('UNEXPECTED_DIALOG'); };
  page.on('dialog', onDialog);
  try {
    const recordOptions = { allowUnchangedBusinessParties: true };
    const state = await bounded(currentLabtestRecord(page, expected, recordOptions)), frame = state.frame;
    const baseline = await bounded(snapshotLabtestRecord(frame));
    if (!cleanLabtestRecord(baseline)) throw new Error('RECORD_HAS_DIRTY_FIELDS');
    if (!unchangedLabtestBusinessParties(state.partyPreimage, baseline)) {
      throw new Error('LABTEST_LINKED_PARTY_UNVERIFIED');
    }
    if (await bounded(page.locator('.x-window:visible:not(.x-menu)').count()) !== 1 ||
        await bounded(frame.locator('.x-window:visible:not(.x-menu)').count())) throw new Error('UNEXPECTED_DIALOG');
    const field = frame.locator('textarea[name="reservationnote"]:visible');
    const save = frame.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
    if (await bounded(field.count()) !== 1 || await bounded(save.count()) !== 1) throw new Error('AMEND_CONTROL_NOT_UNIQUE');
    fence = await bounded(installPageRequestFence(page, [SAVE_PATH]));
    scope = fence.open();
    const routeSetup = installLabtestSaveRouteChain(page, {
      frame,
      fence,
      scope,
      isArmed: () => armed && !nativeDialog,
      matches: (request, requestFrame) => matchesAmend(request, requestFrame, expected, state, baseline),
      onCandidate: (request) => {
        authorizedRequest = request;
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
        blocked += 1;
        try {
          if (/send|email|mail/i.test(new URL(request.url()).pathname)) sendRequests += 1;
        } catch { /* Do not expose or retry malformed request targets. */ }
      },
    }).then(async (chain) => {
      if (stopReason) {
        usedPages.add(page);
        chain.disarm();
        await chain.close();
        return null;
      }
      return chain;
    });
    routeChain = await bounded(routeSetup);
    if (!routeChain) throw new Error(stopReason || 'AMEND_TIMEOUT');
    usedPages.add(page);
    const changed = await bounded(field.evaluate((el, value) => {
      const component = globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      if (!component?.setValue || el.readOnly || el.disabled) return false;
      component.setValue(value);
      component.fireEvent?.('blur', component);
      return el.value === value;
    }, expected.newNote));
    if (!changed) throw new Error('NOTE_EDIT_UNVERIFIED');
    await bounded(field.blur());
    const after = await bounded(currentLabtestRecord(page, { ...expected, note: expected.newNote }, recordOptions));
    const changedForm = await bounded(snapshotLabtestRecord(frame));
    if (JSON.stringify(state.native) !== JSON.stringify(after.native) || state.track !== after.track ||
        JSON.stringify(state.partyPreimage) !== JSON.stringify(after.partyPreimage) ||
        !unchangedLabtestBusinessParties(state.partyPreimage, changedForm) ||
        !unchangedLabtestRecord(baseline, changedForm, { reservationnote: expected.newNote }) ||
        changedForm?.values?.reservationnote !== expected.newNote ||
        blocked || nativeDialog || await bounded(frame.locator('.x-window:visible:not(.x-menu)').count())) {
      throw new Error('AMEND_DRAFT_CHANGED');
    }
    const pending = page.waitForResponse((item) => item.request() === authorizedRequest, { timeout: timeoutMs }).catch(() => null);
    armed = true;
    await bounded(save.click({ timeout: 5_000, noWaitAfter: true }));
    response = await bounded(pending);
    armed = false;
    await bounded(page.waitForTimeout(500));
    const dialogs = await bounded(frame.locator('.x-window:visible:not(.x-menu)').allTextContents().catch(() => []));
    const blockedAfterDispatch = Math.max(0, blocked - blockedAtDispatch);
    const outcome = dispatched && response?.status() === 200 && !nativeDialog && !dialogs.length && !blockedAfterDispatch
      ? 'awaiting_readback'
      : possiblyDispatched ? 'uncertain' : 'not_dispatched';
    return { outcome, httpStatus: response?.status() || null, blockedRequests: blocked,
      blockedRequestsAfterDispatch: blockedAfterDispatch, browserSendRequests: sendRequests, nativeDialog, dialogs };
  } catch (error) {
    armed = false;
    routeChain?.disarm();
    if (possiblyDispatched) fence?.quarantine();
    return { outcome: possiblyDispatched ? 'uncertain' : 'not_dispatched', issue: issue(error),
      httpStatus: response?.status() || null, blockedRequests: blocked, browserSendRequests: sendRequests, nativeDialog };
  } finally {
    clearTimeout(timer);
    armed = false;
    routeChain?.disarm();
    scope?.close();
    await routeChain?.close();
    if (!nativeDialog && !usedPages.has(page)) page.off('dialog', onDialog);
  }
}
