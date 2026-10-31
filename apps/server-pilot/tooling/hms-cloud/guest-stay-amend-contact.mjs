// Amend only the booking contact text on one verified saved Labtest record.
import {
  blankLabtestParties,
  cleanLabtestRecord,
  currentLabtestRecord,
  matchesLabtestBody,
  snapshotLabtestRecord,
  unchangedLabtestRecord,
} from './labtest-record.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';
import { installLabtestSaveRouteChain as installLabtestContactSaveRouteChain } from './saved-stay-save-route-chain.mjs';
export { installLabtestContactSaveRouteChain };

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const SAVE_PATH = '/web/base/OSRESV.HDR';
const CONTACT_FIELDS = Object.freeze({
  bookerName: Object.freeze({ name: 'caller', label: 'Booker Name' }),
  bookerContact: Object.freeze({ name: 'udfchar06', label: 'Booker Contact' }),
});
const usedPages = new WeakSet();

const issue = (error) => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '')
  ? error.message
  : 'AMEND_UNVERIFIED';

function uniqueSnapshotField(snapshot, name) {
  const read = (source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source) || !Object.hasOwn(source, name)) return null;
    const keys = Object.keys(source);
    if (keys.filter((key) => key.toLowerCase() === name.toLowerCase()).length !== 1) return null;
    return String(source[name] ?? '');
  };
  const value = read(snapshot?.values);
  const data = read(snapshot?.data);
  return value !== null && data !== null && value === data ? value : null;
}

function matchesAmend(request, frame, expected, state, baseline, field, value) {
  try {
    if (!Object.hasOwn(CONTACT_FIELDS, field)) return false;
    const spec = CONTACT_FIELDS[field];
    const url = new URL(request.url());
    const body = new URLSearchParams(request.postData() || '');
    const keys = [...body.keys()];
    const required = {
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: 'HDR',
      propertycode: 'HRCEN',
      status: 'Reserved',
      firstname: 'Proof',
      lastname: 'Labtest',
      confirmationnumber: expected.confirmation,
      guestid: expected.guestId,
      arrivaldate: state.arrivalWire,
      departuredate: state.departureWire,
      roomtype: expected.roomType,
      rateplan: expected.ratePlan,
      track: state.track,
      reservationnote: expected.note,
      udfchkbox04: '0',
      udfchar13: '',
      emailaddress: '',
      guaranteetype: 'NGI',
      pagemode: 'view',
      savecctoprofile: '0',
      savesettlementcctoprofile: '0',
      ...state.native,
      [spec.name]: value,
    };
    return request.method() === 'POST' && request.frame() === frame && url.origin === ORIGIN &&
      url.pathname === SAVE_PATH && !url.hash && [...url.searchParams].length === 1 &&
      url.searchParams.get('pageaction') === 'SAVE' &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      Object.entries(required).every(([key, wanted]) => body.getAll(key).length === 1 && body.get(key) === wanted &&
        keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1) &&
      matchesLabtestBody(body, baseline, { [spec.name]: value });
  } catch {
    return false;
  }
}

/** Exact saved-record contact request matcher, exported for the offline guard tests. */
export function matchesLabtestContactAmendRequest(request, frame, expected, state, baseline, field, value) {
  return typeof value === 'string' && matchesAmend(request, frame, expected, state, baseline, field, value);
}

/** A 200 is only awaiting fresh readback when no unexpected request was blocked after dispatch. */
export function contactAmendOutcome({
  dispatched, possiblyDispatched, httpStatus, nativeDialog, dialogs, blockedAfterDispatch,
}) {
  if (dispatched && httpStatus === 200 && !nativeDialog && dialogs === 0 && blockedAfterDispatch === 0) {
    return 'awaiting_readback';
  }
  return possiblyDispatched ? 'uncertain' : 'not_dispatched';
}

/** Accept the staged form value before Ext synchronizes the loaded record model. */
export function matchesLabtestContactAmendDraft(before, after, field, value) {
  if (!Object.hasOwn(CONTACT_FIELDS, field) || typeof value !== 'string') return false;
  const fieldName = CONTACT_FIELDS[field].name;
  return after?.values?.[fieldName] === value &&
    unchangedLabtestRecord(before, after, { [fieldName]: value });
}

async function editableContactField(frame, snapshot, spec, value) {
  const field = frame.locator(`input[name="${spec.name}"]:visible,textarea[name="${spec.name}"]:visible`);
  if (await field.count() !== 1) throw new Error('AMEND_CONTROL_NOT_UNIQUE');
  const state = await field.evaluate((element) => {
    const component = globalThis.Ext?.getCmp?.(element.id.replace(/-inputEl$/, ''));
    const guestInput = document.querySelector('input[name="guestid"]');
    const guestComponent = guestInput?.id
      ? globalThis.Ext?.getCmp?.(guestInput.id.replace(/-inputEl$/, ''))
      : null;
    const form = guestComponent?.up?.('form');
    const componentForm = component?.up?.('form');
    const disabled = element.disabled || (typeof component?.isDisabled === 'function'
      ? component.isDisabled()
      : component?.disabled === true);
    const readOnly = element.readOnly || component?.readOnly === true;
    return {
      inSavedForm: Boolean(form?.el?.dom && form === componentForm && form.el.dom.contains(element)),
      hasComponent: Boolean(component && typeof component.setValue === 'function' && typeof component.getValue === 'function'),
      disabled: Boolean(disabled),
      readOnly: Boolean(readOnly),
      domValue: String(element.value ?? ''),
      componentValue: component && typeof component.getValue === 'function'
        ? String(component.getValue() ?? '')
        : null,
      maxLength: Number(element.maxLength),
    };
  });
  const original = uniqueSnapshotField(snapshot, spec.name);
  if (!state.inSavedForm || !state.hasComponent || original === null ||
      state.domValue !== original || state.componentValue !== original) {
    throw new Error('CONTACT_FIELD_PREIMAGE_UNVERIFIED');
  }
  if (state.disabled || state.readOnly) throw new Error('CONTACT_FIELD_UNSUPPORTED');
  if (Number.isInteger(state.maxLength) && state.maxLength >= 0 && value.length > state.maxLength) {
    throw new Error('CONTACT_VALUE_TOO_LONG');
  }
  return { field, original };
}

/** Requires a fresh Record View. A successful response still requires a fresh-session readback. */
export async function amendLabtestContact(page, expected = {}, {
  field: fieldKey,
  value,
  timeoutMs = 20_000,
} = {}) {
  if (!Object.hasOwn(CONTACT_FIELDS, fieldKey)) return { outcome: 'input_gap', issue: 'CONTACT_FIELD_UNSUPPORTED' };
  const spec = CONTACT_FIELDS[fieldKey];
  const nextValue = typeof value === 'string' ? value.trim() : '';
  if (!nextValue || nextValue.length > 200) return { outcome: 'input_gap', issue: 'CONTACT_VALUE_INVALID' };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { outcome: 'input_gap', issue: 'INVALID_TIMEOUT' };
  if (usedPages.has(page)) return { outcome: 'refused', issue: 'PAGE_WRITE_ALREADY_USED' };

  let armed = false;
  let possiblyDispatched = false;
  let dispatched = false;
  let blockedAtDispatch = 0;
  let blocked = 0;
  let sendRequests = 0;
  let nativeDialog = null;
  let response = null;
  let authorizedRequest = null;
  let stopReason = null;
  let scope;
  let fence;
  let routeChain;
  let signalStop;
  const stopped = new Promise((resolve) => { signalStop = resolve; });
  const stop = (reason) => {
    stopReason ||= reason;
    armed = false;
    routeChain?.disarm();
    fence?.quarantine();
    signalStop({ reason });
  };
  const bounded = async (action) => {
    const result = await Promise.race([
      Promise.resolve(action).then((resultValue) => ({ resultValue })),
      stopped,
    ]);
    if (result.reason) throw new Error(result.reason);
    return result.resultValue;
  };
  const timer = setTimeout(() => stop('AMEND_TIMEOUT'), timeoutMs);
  const onDialog = (dialog) => {
    nativeDialog = { type: dialog.type() };
    stop('UNEXPECTED_DIALOG');
  };
  page.on('dialog', onDialog);

  try {
    const state = await bounded(currentLabtestRecord(page, expected));
    const frame = state.frame;
    const baseline = await bounded(snapshotLabtestRecord(frame));
    if (!cleanLabtestRecord(baseline)) throw new Error('RECORD_HAS_DIRTY_FIELDS');
    if (!blankLabtestParties(baseline)) throw new Error('LABTEST_LINKED_PARTY_UNVERIFIED');
    if (await bounded(page.locator('.x-window:visible:not(.x-menu)').count()) !== 1 ||
        await bounded(frame.locator('.x-window:visible:not(.x-menu)').count())) {
      throw new Error('UNEXPECTED_DIALOG');
    }

    const { field: control, original } = await bounded(editableContactField(frame, baseline, spec, nextValue));
    if (original === nextValue) return { outcome: 'unchanged', field: fieldKey };
    const save = frame.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
    if (await bounded(save.count()) !== 1) throw new Error('AMEND_CONTROL_NOT_UNIQUE');

    fence = await bounded(installPageRequestFence(page, [SAVE_PATH]));
    scope = fence.open();
    const routeSetup = installLabtestContactSaveRouteChain(page, {
      frame,
      fence,
      scope,
      isArmed: () => armed && !nativeDialog,
      matches: (request, requestFrame) => matchesLabtestContactAmendRequest(
        request, requestFrame, expected, state, baseline, fieldKey, nextValue,
      ),
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
        // A registration that completes after the deadline may not grant its
        // exception. Retain only the page-local deny route and prevent reuse.
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

    const changed = await bounded(control.evaluate((element, newValue) => {
      const component = globalThis.Ext?.getCmp?.(element.id.replace(/-inputEl$/, ''));
      if (!component?.setValue || element.readOnly || element.disabled) return false;
      component.setValue(newValue);
      component.fireEvent?.('blur', component);
      return element.value === newValue && String(component.getValue() ?? '') === newValue;
    }, nextValue));
    if (!changed) throw new Error('CONTACT_EDIT_UNVERIFIED');
    await bounded(control.blur());

    const after = await bounded(currentLabtestRecord(page, expected));
    const changedForm = await bounded(snapshotLabtestRecord(frame));
    // Ext's form values may update before its loaded record.data; the save
    // request matcher below is the authoritative full-record check.
    if (JSON.stringify(state.native) !== JSON.stringify(after.native) || state.track !== after.track ||
        !blankLabtestParties(changedForm) ||
        !matchesLabtestContactAmendDraft(baseline, changedForm, fieldKey, nextValue) ||
        blocked || nativeDialog || await bounded(frame.locator('.x-window:visible:not(.x-menu)').count())) {
      throw new Error('AMEND_DRAFT_CHANGED');
    }

    const pending = page.waitForResponse((item) => item.request() === authorizedRequest, { timeout: timeoutMs })
      .catch(() => null);
    armed = true;
    await bounded(save.click({ timeout: 5_000, noWaitAfter: true }));
    response = await bounded(pending);
    armed = false;
    await bounded(page.waitForTimeout(500));
    const dialogs = await bounded(frame.locator('.x-window:visible:not(.x-menu)').count());
    const httpStatus = response?.status() || null;
    const blockedAfterDispatch = Math.max(0, blocked - blockedAtDispatch);
    return {
      outcome: contactAmendOutcome({
        dispatched, possiblyDispatched, httpStatus, nativeDialog, dialogs, blockedAfterDispatch,
      }),
      field: fieldKey,
      httpStatus,
      blockedRequests: blocked,
      blockedRequestsAfterDispatch: blockedAfterDispatch,
      browserSendRequests: sendRequests,
      nativeDialog,
    };
  } catch (error) {
    armed = false;
    routeChain?.disarm();
    if (possiblyDispatched) fence?.quarantine();
    return {
      outcome: possiblyDispatched ? 'uncertain' : 'not_dispatched',
      issue: issue(error),
      field: fieldKey,
      httpStatus: response?.status() || null,
      blockedRequests: blocked,
      browserSendRequests: sendRequests,
      nativeDialog,
    };
  } finally {
    clearTimeout(timer);
    armed = false;
    routeChain?.disarm();
    scope?.close();
    await routeChain?.close();
    if (!nativeDialog && !usedPages.has(page)) page.off('dialog', onDialog);
  }
}
