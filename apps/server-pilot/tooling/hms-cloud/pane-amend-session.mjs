// Read and bind the complete native state before a staff-approved amendment.
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { installSavedStayReadGuard } from './saved-stay-read-guard.mjs';
import { readShallow, readRecord } from './hms-readers.mjs';
import { cleanLabtestRecord, currentLabtestRecord, snapshotLabtestRecord,
  unchangedLabtestBusinessParties } from './labtest-record.mjs';
import { savedChildOccupancy, sameChildAgeMultiset, stageSavedChildrenForComposition } from './guest-stay-amend-children.mjs';
import { createSavedChildStageRequestGate } from './saved-stay-child-request-gate.mjs';
import { createSavedRoomStageRequestGate } from './saved-stay-room-stage-gate.mjs';
import { createSavedRateStageRequestGate } from './saved-stay-rate-stage-gate.mjs';
import { stageSavedGuestFieldsForComposition } from './guest-stay-amend-contact.mjs';
import { labtestCombinedAmendPreimageBinding } from './saved-stay-combined-preimage.mjs';
import { nativeCmsSendValue, runLabtestAmendSave } from './labtest-amend-save.mjs';
import { createLabtestAmendDispatch } from './labtest-amend-dispatch.mjs';
import { nativeMoneyCents, nativeAverageCents, nativePriceDigest, parseNativePricingJson,
  readAmendNightlyQuote, readSavedStayNightlyRates } from './saved-stay-nightly-rates.mjs';
import { stageSavedAdultForComposition } from './guest-stay-amend-adults.mjs';
import { stageSavedDatesForComposition, stageSavedRoomRateForComposition } from './guest-stay-amend-date-room-rate.mjs';

const identityKeys = ['source', 'propertyCode', 'confirmation', 'reservationStayId', 'reservationId',
  'recordId', 'guestId', 'status', 'firstName', 'lastName', 'arrival', 'departure', 'roomType',
  'ratePlan', 'adults', 'children', 'childAges'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validTarget = (target) => target?.propertyCode === 'HRCEN' && target.browserSlot === 'centurion' &&
  target.origin === 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const searchHints = (selected, arrivalDate) => {
  const guestName = `${selected.firstName} ${selected.lastName}`;
  return { arrivalDate, ...(guestName.length <= 256 ? { guestName } : {}) };
};
const amendRecordOptions = { allowBlankNote: true, allowUnchangedBusinessParties: true,
  preserveUnsentRecipient: true, allowModelOnlyPrimaryPartyIds: true };
const nativeOptions = (input, record) => {
  if (input.allowRealGuest !== true) return amendRecordOptions;
  const fields = record?.details?.fields?.filter((field) => field.name === 'guaranteetype');
  const code = record?.nativePreimage?.guaranteeCode, display = fields?.length === 1 ? fields[0].value : null;
  if (!/^[A-Z0-9]{1,20}$/.test(code || '') || typeof display !== 'string' || !display.trim()) throw new Error('NATIVE_GUARANTEE_UNVERIFIED');
  return { ...amendRecordOptions, allowRealGuest: true, expectedGuarantee: { code, display } };
};

/** Values staff must review and the complete native digest must preserve. */
export function cloudAmendPreserved(state, baseline, changes = {}) {
  const party = state?.partyPreimage, cmsRecipient = state?.cmsRecipient ?? '', guestEmail = state?.guestEmail;
  const cmsMessageId = state?.cmsMessageId, cmsSend = state?.cmsSend;
  const clean = (value, max) => typeof value === 'string' && value.length <= max && !/[\p{Cc}]/u.test(value);
  if (!party || !clean(cmsRecipient, 1000) || (guestEmail !== undefined && !clean(guestEmail, 1000)) ||
      (cmsMessageId !== undefined && !clean(cmsMessageId, 1000))) return null;
  const details = {};
  for (const [key, name] of Object.entries({ bookerName: 'caller', bookerContact: 'udfchar06' })) {
    if (!Object.hasOwn(changes, key) || !Object.hasOwn(baseline?.data ?? {}, name) ||
        !Object.hasOwn(baseline?.values ?? {}, name)) continue;
    const value = String(baseline.data[name] ?? '');
    if (clean(value, 1000) && value === String(baseline.values[name] ?? '')) details[key] = value;
  }
  const link = (id, name) => {
    if (id === '' && name === '') return null;
    if (!/^\d{1,30}$/.test(id || '') || !clean(name, 300) || !name.trim()) throw new Error('PARTY_UNVERIFIED');
    return { nativeId: id, name };
  };
  try {
    const agency = link(party.taid1, party.ta1);
    const organization = link(party.companyid, party.company || party.companyname);
    return { cmsRecipient, ...(cmsMessageId === undefined ? {} : { cmsMessageId }),
      ...(typeof cmsSend === 'boolean' ? { cmsSend } : {}),
      ...(guestEmail === undefined ? {} : { guestEmail }), ...details, agency, organization };
  } catch { return null; }
}

// Install the exact-confirmation read fence before any page or login request.
// A session that skips the pre-login hook is unusable even for a rehearsal.
function guardedSession(input, guard, timeoutMs = 5 * 60_000) {
  let guardedContext = null, guardStarted = false;
  const deadline = AbortSignal.timeout(timeoutMs);
  const safeContext = (context) => context?._options?.serviceWorkers === 'block' &&
    typeof context.serviceWorkers === 'function' && context.serviceWorkers().length === 0;
  return {
    hasGuard: (context) => guardedContext === context && safeContext(context),
    options: { headless: true, blockServiceWorkers: true,
      ...(input.cloudTargetKey ? { cloudTargetKey: input.cloudTargetKey } : {}),
      signal: input.signal ? AbortSignal.any([input.signal, deadline]) : deadline,
      prepareContext: async (context) => {
        if (guardStarted || !safeContext(context)) throw new Error('BROWSER_CONTEXT_UNSAFE');
        // Claim the hook before awaiting route installation. A second context
        // must not race a still-pending guard and become the chosen session.
        guardStarted = true;
        await guard(context, { confirmation: input.confirmation });
        guardedContext = context;
      } },
  };
}

const wireDate = (value) => `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`;
const displayDate = (value) => `${value.slice(8, 10)}-${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(value.slice(5, 7)) - 1]}-${value.slice(0, 4)}`;
const validDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const isLabtest = (selected) => selected?.firstName === 'Proof' && selected?.lastName === 'Labtest';
/** The requested target is business data, independent of the native form's size. */
function amendTarget(selected, changes, { allowRealGuest = false } = {}) {
  if (!selected || !changes || typeof changes !== 'object' || Array.isArray(changes) ||
      selected.propertyCode !== 'HRCEN' || selected.status !== 'Reserved' ||
      !/^\d{6,}-\d+$/.test(selected.confirmation || '') || !/^\d+$/.test(selected.guestId || '') ||
      !/^\d+$/.test(selected.reservationStayId || '') || !/^\d+$/.test(selected.reservationId || '') ||
      !/^\d+$/.test(selected.recordId || '') || (!allowRealGuest && !isLabtest(selected))) return null;
  const target = { ...selected, arrival: changes.arrival ?? selected.arrival, departure: changes.departure ?? selected.departure,
    adults: changes.adults ?? selected.adults, children: changes.children ?? selected.children,
    childAges: changes.childAges ?? selected.childAges, roomType: changes.roomType ?? selected.roomType,
    ratePlan: changes.ratePlan ?? selected.ratePlan, firstName: changes.firstName ?? selected.firstName,
    lastName: changes.lastName ?? selected.lastName };
  if (!validDay(target.arrival) || !validDay(target.departure) || target.arrival >= target.departure ||
      !Number.isInteger(target.adults) || target.adults < 1 || target.adults > 16 ||
      !Number.isInteger(target.children) || target.children < 0 || target.children > 9 ||
      !/^[A-Z0-9]{1,12}$/.test(target.roomType || '') || !/^[A-Z0-9]{1,12}$/.test(target.ratePlan || '') ||
      !target.firstName?.trim() || !target.lastName?.trim() || !['yes', 'no'].includes(changes.retainRates) ||
      typeof changes.cmsSend !== 'boolean' || typeof changes.cmsMessageId !== 'string' || typeof changes.cmsRecipient !== 'string' ||
      (Array.isArray(target.childAges) && (target.childAges.length !== target.children ||
        target.childAges.some((age) => !Number.isInteger(age) || age < 0 || age > 17))) ||
      (!Array.isArray(target.childAges) && target.childAges !== 'unknown') ||
      (isLabtest(selected) && (selected.arrival < '2027-01-01' || target.arrival < '2027-01-01' || changes.cmsSend ||
        target.firstName !== 'Proof' || target.lastName !== 'Labtest'))) return null;
  return target;
}

function matchesAmendBusiness(snapshot, selected, changes, baseline, state) {
  const target = amendTarget(selected, changes, { allowRealGuest: state?.allowRealGuest === true });
  const data = snapshot?.data, values = snapshot?.values;
  if (!target || !data || !values || !baseline?.data || !state ||
      !unchangedLabtestBusinessParties(state.partyPreimage, snapshot,
        { allowModelOnlyPrimaryPartyIds: true, allowRealGuest: state.allowRealGuest === true })) return false;
  const required = { propertycode: 'HRCEN', status: 'Reserved', confirmationnumber: target.confirmation,
    guestid: target.guestId, reservationid: target.reservationId, reservationstayid: target.reservationStayId,
    recordid: target.recordId, firstname: target.firstName, lastname: target.lastName,
    arrivaldate: wireDate(target.arrival), departuredate: wireDate(target.departure), roomtype: target.roomType,
    rateplan: target.ratePlan, adults: String(target.adults), guaranteetype: state.expectedGuarantee?.code ?? 'NGI',
    reservationnote: String(baseline.data.reservationnote ?? '') };
  if (!Object.entries(required).every(([key, value]) => Object.hasOwn(data, key) && String(data[key] ?? '') === value)) return false;
  const displayed = { confirmationnumber: target.confirmation, guestid: target.guestId, status: 'Reserved',
    firstname: target.firstName, lastname: target.lastName, arrivaldate: displayDate(target.arrival),
    departuredate: displayDate(target.departure), roomtype: target.roomType, rateplan: target.ratePlan,
    adults: String(target.adults) };
  if (!Object.entries(displayed).every(([key, value]) => Object.hasOwn(values, key) && String(values[key] ?? '') === value)) return false;
  const contact = { emailaddress: 'guestEmail', caller: 'bookerName', udfchar06: 'bookerContact' };
  for (const [name, key] of Object.entries(contact)) {
    if (!Object.hasOwn(baseline.data, name) && !Object.hasOwn(changes, key)) continue;
    const expected = Object.hasOwn(changes, key) ? changes[key] : String(baseline.data[name] ?? '');
    if (!Object.hasOwn(data, name) || String(data[name] ?? '') !== expected ||
        (Object.hasOwn(values, name) && String(values[name] ?? '') !== expected)) return false;
  }
  const recipient = changes.cmsSend ? changes.cmsRecipient : String(baseline.data.udfchar13 ?? '');
  const message = changes.cmsSend ? changes.cmsMessageId : String(baseline.data.udfchar09 ?? '');
  const formCms = !Object.hasOwn(values, 'udfchkbox04') || values.udfchkbox04 === ''
    ? false : nativeCmsSendValue(values.udfchkbox04);
  if (snapshot.cmsSendControl !== changes.cmsSend || formCms !== changes.cmsSend ||
      String(data.udfchar13 ?? '') !== recipient ||
      (message && String(data.udfchar09 ?? '') !== message)) return false;
  const children = savedChildOccupancy(snapshot);
  if (!children.valid || children.count !== target.children) return false;
  if (Array.isArray(target.childAges)) {
    const ages = children.ages ?? (children.count === 0 ? [] : null);
    if (!sameChildAgeMultiset(ages, target.childAges)) return false;
  }
  return true;
}

/** Match the selected stay and requested business fields on the paused native Save. */
export function matchesCloudPaneAmendSave(request, frame, snapshot,
  { selected, changes, beforeNote, beforeParties, guaranteeCode = 'NGI', allowRealGuest = false, phase = 'save', baseline } = {}) {
  try {
    const original = baseline ?? snapshot, state = { partyPreimage: beforeParties, allowRealGuest,
      expectedGuarantee: { code: guaranteeCode } };
    if (!['save', 'retain', 'extend'].includes(phase) || typeof beforeNote !== 'string' ||
        String(original?.data?.reservationnote ?? '') !== beforeNote ||
        !matchesAmendBusiness(snapshot, selected, changes, original, state)) return false;
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || ''), data = snapshot.data;
    if (request.method() !== 'POST' || request.frame() !== frame || url.origin !== 'https://hmsweb.hms.eu1.inforcloudsuite.com' ||
        url.pathname !== '/web/base/OSRESV.HDR' || url.hash || url.searchParams.get('pageaction') !== 'SAVE' ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '')) return false;
    const required = { SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR',
      propertycode: 'HRCEN', confirmationnumber: selected.confirmation, guestid: selected.guestId,
      reservationid: selected.reservationId, reservationstayid: selected.reservationStayId, recordid: selected.recordId,
      status: 'Reserved' };
    for (const name of ['firstname', 'lastname', 'arrivaldate', 'departuredate', 'roomtype', 'rateplan', 'adults',
      'children', 'guaranteetype', 'reservationnote', 'emailaddress', 'udfchar13']) required[name] = String(data[name] ?? '');
    const cmsFields = [...body].filter(([name]) => name.toLowerCase() === 'udfchkbox04');
    if (cmsFields.length !== 1 || cmsFields[0][0] !== 'udfchkbox04' ||
        nativeCmsSendValue(cmsFields[0][1]) !== changes.cmsSend) return false;
    if (Object.hasOwn(changes, 'childAges')) {
      for (const name of ['childages', 'child1', 'child2', 'child3']) required[name] = String(data[name] ?? '');
    }
    for (const [key, name] of Object.entries({ bookerName: 'caller', bookerContact: 'udfchar06', cmsMessageId: 'udfchar09' })) {
      if (Object.hasOwn(changes, key) && (key !== 'cmsMessageId' || changes.cmsSend)) required[name] = String(data[name] ?? '');
    }
    if (phase === 'retain' || phase === 'extend') {
      required.confirmretainrate = changes.retainRates === 'yes' ? 'confirmed' : 'not_needed';
    }
    if (phase === 'extend') {
      if (changes.retainRates !== 'yes') return false;
      required.confirmextendoverriderate = 'confirmed';
    }
    // A stale confirmation could skip the native question and its approved choice.
    for (const key of ['confirmretainrate', 'confirmextendoverriderate']) {
      const fields = [...body].filter(([name]) => name.toLowerCase() === key);
      if (fields.length > 1 || (fields.length && fields[0][0] !== key)) return false;
      if (!Object.hasOwn(required, key) && fields.length && fields[0][1] !== '') return false;
    }
    return Object.entries(required).every(([key, value]) => {
      const fields = [...body].filter(([name]) => name.toLowerCase() === key.toLowerCase());
      return fields.length === 1 && fields[0][0] === key && fields[0][1] === value;
    });
  } catch { return false; }
}

/** Do not infer a target from the fake name: the fresh native record must match the selected stay. */
export function expectedLabtestAmendRecord(record, selected, { allowRealGuest = false } = {}) {
  const native = record?.nativePreimage, fields = record?.details?.fields;
  if (!native || !selected || !Array.isArray(fields) || native.source !== 'record_view_ext_model' ||
      native.propertyCode !== 'HRCEN' || !native.firstName?.trim() || !native.lastName?.trim() ||
      (!allowRealGuest && (native.firstName !== 'Proof' || native.lastName !== 'Labtest' || native.guaranteeCode !== 'NGI' || native.arrival < '2027-01-01')) ||
      native.status !== 'Reserved' || !/^[A-Z0-9]{1,20}$/.test(native.guaranteeCode || '') ||
      identityKeys.some((key) => !Object.hasOwn(native, key) || !Object.hasOwn(selected, key) ||
        !same(native[key], selected[key]))) return null;
  const notes = fields.filter((field) => field?.name === 'reservationnote');
  if (notes.length !== 1 || typeof notes[0].rawValue !== 'string' || notes[0].rawValue.length > 2_000) return null;
  return { confirmation: native.confirmation, guestId: native.guestId, firstName: native.firstName, lastName: native.lastName, arrival: native.arrival,
    departure: native.departure, roomType: native.roomType, ratePlan: native.ratePlan, note: notes[0].rawValue,
    adults: native.adults, childCount: native.children,
    childAges: native.childAges === 'unknown' ? null : native.childAges };
}

/** Stage the actual amendment and HMS pricing, with Save permanently disarmed. */
export async function prepareCloudPaneAmend(input, { openSession = withCenturionStay360Page,
  guard = installSavedStayReadGuard, shallow = readShallow, read = readRecord,
  current = currentLabtestRecord, snapshot = snapshotLabtestRecord, bind = labtestCombinedAmendPreimageBinding,
  quote = readAmendNightlyQuote } = {}) {
  const selected = input?.selected;
  if (!validTarget(input?.target) || !amendTarget(selected, input?.changes, { allowRealGuest: input?.allowRealGuest === true }) ||
      selected.confirmation !== input.confirmation || selected.arrival !== input.arrival) {
    return { outcome: 'refused', issue: 'AMEND_INPUT_INVALID' };
  }
  try {
    const protectedSession = guardedSession(input, guard);
    return await openSession(async (page) => {
      if (!protectedSession.hasGuard(page.context())) return { outcome: 'refused', issue: 'BROWSER_CONTEXT_UNSAFE' };
      await shallow(page, input.confirmation, searchHints(selected, input.arrival));
      const record = await read(page, input.confirmation, { nativePropertyCode: 'HRCEN' });
      const expected = expectedLabtestAmendRecord(record, selected, { allowRealGuest: input.allowRealGuest === true });
      if (!expected) return { outcome: 'refused', issue: 'APPROVED_STAY_MISMATCH' };
      const result = await runLabtestAmendSave(page, cloudPaneAmendRunOptions({ page, input: {
        ...input, signal: protectedSession.options.signal }, expected, prepareOnly: true },
      { current, snapshot, bind, quote, recordOptions: nativeOptions(input, record) }));
      if (result.issue === 'PREPARE_ONLY' && result.nativeDigest && result.approvedPrices && result.preserved) {
        return { outcome: 'prepared', nativeDigest: result.nativeDigest,
          approvedPrices: result.approvedPrices, preserved: result.preserved };
      }
      return { outcome: 'refused', issue: result.issue || 'AMEND_PREPARE_UNVERIFIED' };
    }, protectedSession.options);
  } catch {
    return { outcome: 'refused', issue: 'NATIVE_READ_UNAVAILABLE' };
  }
}

/** Synchronize only the native response's verified local form values; this performs no request. */
export async function syncAmendRecordAfterAvailability(frame, before, bounded) {
  const synced = await bounded(frame.evaluate(({ before }) => {
    const visible = (el) => (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window');
    const guests = [...document.querySelectorAll('input[name=guestid]')].filter(visible);
    const panel = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
    const record = panel?.getRecord?.(), form = panel?.getForm?.();
    if (!record?.data || typeof panel.updateRecord !== 'function' || !form?.getValues ||
        ['propertycode', 'confirmationnumber', 'guestid', 'reservationstayid', 'reservationid'].some((key) =>
          String(record.data[key] ?? '') !== String(before.data[key] ?? ''))) return false;
    panel.updateRecord(record);
    return true;
  }, { before }));
  if (!synced) throw new Error('AMEND_DRAFT_CHANGED');
}

/** Bind the native tax-read parameters without making its request or changing the draft. */
export async function nativeAmendTaxReadValues(frame, before, approvedCurrency, bounded) {
  if (typeof frame?.evaluate !== 'function' || !/^[A-Z]{3}$/.test(approvedCurrency || '')) return null;
  const result = await bounded(frame.evaluate(({ before, approvedCurrency }) => {
    const visible = el => (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window');
    const guests = [...document.querySelectorAll('input[name=guestid]')].filter(visible);
    const panel = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
    const record = panel?.getRecord?.();
    if (!record?.data || typeof panel?.getFldValue !== 'function' || typeof globalThis.EAM?.Date?.standardFormat !== 'function' ||
        ['propertycode', 'confirmationnumber', 'guestid', 'reservationstayid', 'reservationid', 'arrivaldate', 'departuredate']
          .some((key) => String(record.data[key] ?? '') !== String(before.data[key] ?? '')) ||
        record.data.propertycode !== 'HRCEN' || panel.getFldValue('currency') !== approvedCurrency) return null;
    return { reservationstayid: String(record.data.reservationstayid), propertycode: 'HRCEN',
      arrivaldate: globalThis.EAM.Date.standardFormat(panel.getFldValue('arrivaldate')),
      departuredate: globalThis.EAM.Date.standardFormat(panel.getFldValue('departuredate')), currency: approvedCurrency };
  }, { before, approvedCurrency }));
  if (!result || result.reservationstayid !== String(before.data.reservationstayid) ||
      result.arrivaldate !== `${before.data.arrivaldate} 00:00` || result.departuredate !== `${before.data.departuredate} 00:00` ||
      result.currency !== approvedCurrency || result.propertycode !== 'HRCEN') return null;
  return Object.freeze(result);
}

/** A response can arrive before Ext applies it. Wait for the native price controls, then take a full snapshot. */
export async function settleAmendAvailability(frame, response, bounded) {
  const native = response?.pageData?.values;
  if (!native || nativeMoneyCents(native.grandtotal) === null) throw new Error('AMEND_RATE_UNVERIFIED');
  await bounded(frame.waitForFunction((amount) => {
    const guests = [...document.querySelectorAll('input[name=guestid]')].filter((el) =>
      (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
    const panel = guests.length === 1 ? globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form') : null;
    const values = panel?.getForm?.()?.getValues?.();
    return Boolean(values && typeof values.grandtotal === 'string' && values.grandtotal.trim() !== '' &&
      Number(values.grandtotal.replaceAll(',', '')) === Number(amount));
  }, native.grandtotal, { timeout: 10_000 }));
}

/** Only the owning, closed browser and an independent positive read can confirm a candidate. */
export function confirmedCloudAmendResult(saved, fresh, writerSessionClosed) {
  if (saved?.outcome !== 'awaiting_readback' || saved.dispatchCallbacksDrained !== true ||
      writerSessionClosed !== true || fresh?.outcome !== 'matched' || !fresh.readback) {
    return { outcome: 'uncertain', issue: 'AMEND_READBACK_UNVERIFIED' };
  }
  return { outcome: 'amended', dispatchCallbacksDrained: true, writerSessionClosed: true,
    businessFieldsMatched: true, readback: fresh.readback };
}

/** The saved-stay control may have text instead of a tooltip; ambiguity refuses. */
export async function clickLabtestAmendAvailability(frame, bounded) {
  const text = frame.locator('.x-btn:visible').filter({ hasText: /^\s*Check Availability\s*$/i });
  const tip = frame.locator('[data-qtip="Check Availability"]:visible');
  const button = text.or(tip);
  if (await bounded(button.count()) !== 1 || !(await bounded(button.isEnabled()))) {
    throw new Error('AMEND_CONTROL_NOT_UNIQUE');
  }
  await bounded(button.click({ timeout: 5_000, noWaitAfter: true }));
}

/** Current HMS totals and the independently read rate option shown to staff. */
function observedAmendPrice(snapshot, target, quote) {
  const data = snapshot?.data ?? {}, values = snapshot?.values ?? {};
  const currency = values.grandtotalcurr || data.grandtotalcurr || values.currency || data.currency;
  const totalCents = nativeMoneyCents(values.grandtotal ?? data.grandtotal);
  const averageCents = nativeAverageCents(values.averagenightly ?? data.averagenightly);
  if (!/^[A-Z]{3}$/.test(currency || '') || totalCents === null) return null;
  const options = Array.isArray(quote?.options) ? quote.options : quote && quote.currency && Array.isArray(quote.nightly) ? [{
    roomType: target.roomType, ratePlan: target.ratePlan, currency: quote.currency,
    nightly: quote.nightly.map(({ date, quoteCents }) => ({ date, amountCents: quoteCents })),
  }] : [];
  return { version: 2, currency, totalCents, averageCents, options };
}

function assertAmendPriceFields(entries, approved) {
  for (const [name, expected, parse] of [
    ['currency', approved.currency, (value) => value],
    ['grandtotalcurr', approved.currency, (value) => value],
    ['averagenightlycurr', approved.currency, (value) => value],
    ['grandtotal', approved.totalCents, nativeMoneyCents],
    ['averagenightly', approved.averageCents, nativeAverageCents],
  ]) {
    const fields = entries.filter(([key]) => key.toLowerCase() === name);
    if (fields.length > 1 || (fields.length === 1 && fields[0][0] !== name)) throw new Error('AMEND_PRICE_UNVERIFIED');
    const raw = fields[0]?.[1];
    if (raw === null || raw === undefined || String(raw).trim() === '') continue;
    const actual = parse(raw);
    if (actual === null) throw new Error('AMEND_PRICE_UNVERIFIED');
    if (actual !== expected) throw new Error('AMEND_PRICE_CHANGED');
  }
}

/** Compare native minor-unit observations, never a calculated extension total. */
function assertApprovedAmendPrice(snapshot, target, approved, { requireAverage = true } = {}) {
  const observed = observedAmendPrice(snapshot, target, null);
  if (!observed || approved?.version !== 2 || !/^[A-Z]{3}$/.test(approved.currency || '') ||
      !/^(?:0|[1-9]\d{0,13})$/.test(approved.totalCents || '') ||
      (approved.averageCents !== null && !/^(?:0|[1-9]\d{0,13})$/.test(approved.averageCents || '')) ||
      (requireAverage && (observed.averageCents === null || approved.averageCents === null))) {
    throw new Error('AMEND_PRICE_UNVERIFIED');
  }
  if (observed.currency !== approved.currency || observed.totalCents !== approved.totalCents ||
      observed.averageCents !== approved.averageCents) throw new Error('AMEND_PRICE_CHANGED');
  assertAmendPriceFields(Object.entries(snapshot?.data ?? {}), approved);
  assertAmendPriceFields(Object.entries(snapshot?.values ?? {}), approved);
}

/** Compose one staged amendment. Preview cannot arm Save; Go uses the same business checks. */
export function cloudPaneAmendRunOptions({ page, input, expected, authorization, captureBefore = () => {}, prepareOnly = false }, {
  current = currentLabtestRecord, snapshot = snapshotLabtestRecord, bind = labtestCombinedAmendPreimageBinding,
  stageAdults = stageSavedAdultForComposition, stageDates = stageSavedDatesForComposition,
  stageChildren = stageSavedChildrenForComposition, stageOption = stageSavedRoomRateForComposition,
  stageGuest = stageSavedGuestFieldsForComposition, syncRecord = syncAmendRecordAfterAvailability,
  quote = readAmendNightlyQuote, readRates = readSavedStayNightlyRates, recordOptions = amendRecordOptions,
} = {}) {
  const readSnapshot = snapshot;
  snapshot = async (frame) => {
    const draft = await readSnapshot(frame);
    if (!draft) return draft;
    const cmsSendControl = await frame.evaluate(() => {
      const visible = (el) => Boolean((el.offsetWidth || el.offsetHeight) &&
        getComputedStyle(el).visibility !== 'hidden' && !el.closest('.x-window'));
      const guests = [...document.querySelectorAll('input[name="guestid"]')].filter(visible);
      const controls = [...document.querySelectorAll('input[name="udfchkbox04"]')].filter(visible);
      if (guests.length !== 1 || controls.length !== 1) return null;
      const panel = globalThis.Ext?.getCmp?.(guests[0].id.replace(/-inputEl$/, ''))?.up?.('form');
      const control = globalThis.Ext?.getCmp?.(controls[0].id.replace(/-inputEl$/, ''));
      if (!panel?.el?.dom?.contains(controls[0]) || control?.up?.('form') !== panel) return null;
      const value = control?.getValue?.();
      return typeof value === 'boolean' ? value : null;
    });
    return { ...draft, cmsSendControl };
  };
  input = { ...structuredClone({ ...input, signal: undefined }), signal: input?.signal };
  const selected = input?.selected, changes = input?.changes;
  const target = amendTarget(selected, changes, { allowRealGuest: input.allowRealGuest === true });
  if (!page || !expected || !validTarget(input?.target) || !target || selected.confirmation !== input.confirmation ||
      selected.arrival !== input.arrival || (!prepareOnly && (!/^[a-f0-9]{64}$/.test(input.nativeDigest || '') ||
        !authorization || !input.preserved))) throw new Error('AMEND_CHOICE_UNSUPPORTED');
  if (changes.retainRates === 'yes' && (target.departure <= selected.arrival || target.arrival >= selected.departure)) {
    throw new Error('AMEND_PRICE_UNVERIFIED');
  }
  const proposed = Object.fromEntries(['arrival', 'departure', 'adults'].filter((key) =>
    Object.hasOwn(changes, key) && changes[key] !== selected[key]).map((key) => [key, changes[key]]));
  const dateChanged = Object.hasOwn(proposed, 'arrival') || Object.hasOwn(proposed, 'departure');
  const childChanged = Object.hasOwn(changes, 'children') && (changes.children !== selected.children ||
    !same(changes.childAges, selected.childAges));
  const roomChanged = target.roomType !== selected.roomType, rateChanged = target.ratePlan !== selected.ratePlan;
  const needsAvailability = dateChanged || Object.hasOwn(proposed, 'adults') || childChanged || roomChanged || rateChanged;
  // The retained baseline is not the final price when availability changes.
  if (changes.retainRates === 'yes' && needsAvailability) throw new Error('AMEND_PRICE_UNVERIFIED');
  const allowsExtendOverrideRate = changes.retainRates === 'yes' &&
    (target.arrival < selected.arrival || target.departure > selected.departure);
  const dispatch = prepareOnly ? null : createLabtestAmendDispatch({ ...authorization,
    requiresAvailability: needsAvailability, allowsExtendOverrideRate });
  let firstSnapshot = null, questionSnapshot = null, extendSnapshot = null;
  let preparedState = null, nativeDigest = null, preserved = null, quoted = null, stopOperation = null;
  let rateScope = null, operationBounded = null;
  const rateTarget = { confirmation: selected.confirmation, nativeStayId: selected.reservationStayId,
    arrival: selected.arrival, departure: selected.departure };
  const readSavedBasis = (state, bounded, requestScope = null) => readRates(page, state, rateTarget,
    { mode: 'saved_direct', requestScope, bounded });
  const assertSavedBasis = async (prepared) => {
    if (changes.retainRates !== 'yes') return;
    if (!rateScope || !operationBounded) throw new Error('AMEND_PRICE_UNVERIFIED');
    const rates = await readSavedBasis(prepared.state, operationBounded, rateScope);
    if (!rates || rates.digest !== prepared.savedRateDigest) throw new Error('AMEND_PRICE_CHANGED');
  };
  // Keep approves the existing saved basis plus the immutable rate instruction.
  // Availability can display a different proposed total; it is not an extension quote.
  const approvalPrice = (draft, prepared) => {
    const source = changes.retainRates === 'yes' ? prepared.baseline : draft;
    const price = observedAmendPrice(source, target, quoted);
    try {
      assertApprovedAmendPrice(source, target, price, { requireAverage: changes.retainRates === 'no' });
      return price;
    } catch { return null; }
  };
  const checkPrice = (draft, prepared, request) => {
    if (changes.retainRates === 'yes') {
      assertApprovedAmendPrice(prepared.baseline, selected, input.approvedPrices, { requireAverage: false });
    } else {
      assertApprovedAmendPrice(draft, target, input.approvedPrices);
      if (request) {
        // Native Save can omit display-only prices or send them blank. The
        // fresh native snapshot is required; compare any submitted price too.
        assertAmendPriceFields([...new URLSearchParams(request.postData() || '')], input.approvedPrices);
      }
    }
  };
  const valid = (value, prepared) => matchesAmendBusiness(value, selected, changes, prepared.baseline, prepared.state);
  const saveOptions = (prepared, phase) => ({ selected, changes, beforeNote: expected.note,
    beforeParties: prepared.state.partyPreimage, guaranteeCode: prepared.state.expectedGuarantee?.code ?? 'NGI',
    allowRealGuest: input.allowRealGuest === true, baseline: prepared.baseline, phase });
  const dispatchSave = async (phase, request, proceed) => {
    const check = async () => {
      if (!preparedState) throw new Error('AMEND_DRAFT_CHANGED');
      await assertSavedBasis(preparedState);
      const latest = await snapshot(preparedState.frame);
      if (!valid(latest, preparedState) || !matchesCloudPaneAmendSave(request, preparedState.frame, latest,
        saveOptions(preparedState, phase))) throw new Error('AMEND_DRAFT_CHANGED');
      checkPrice(latest, preparedState, request);
    };
    try {
      await check();
      return await dispatch[phase](request, async () => {
        // First authorization may await a transaction. Recheck on its far side
        // while the route's deadline/one-shot continuation fence still owns Save.
        await check();
        return proceed();
      });
    } catch (error) {
      dispatch.close();
      // A refused paused request has no response to wait for. Stop the owned
      // lifecycle now; its existing possible-effect flag still retains UNKNOWN.
      stopOperation?.(/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'AMEND_UNVERIFIED');
      throw error;
    }
  };
  const availability = needsAvailability ? {
    recipient: '', guestEmail: '', cmsSend: changes.cmsSend, cmsMessageId: '', allowRealGuest: input.allowRealGuest === true,
    expected: null,
    snapshot: async (bounded, prepared) => {
      const before = await bounded(snapshot(prepared.frame));
      if (!valid(before, prepared)) throw new Error('AMEND_DRAFT_CHANGED');
      availability.recipient = String(before.data.udfchar13 ?? '');
      availability.guestEmail = String(before.data.emailaddress ?? '');
      availability.cmsMessageId = changes.cmsSend ? changes.cmsMessageId : '';
      availability.expected = { ...target, guaranteeCode: prepared.state.expectedGuarantee?.code ?? 'NGI' };
      const currency = before.values.currency || before.data.currency || before.values.grandtotalcurr || before.data.grandtotalcurr;
      prepared.taxMetadataReadValues = await nativeAmendTaxReadValues(prepared.frame, before, currency, bounded);
      return before;
    },
    click: (bounded, prepared) => clickLabtestAmendAvailability(prepared.frame, bounded),
    dispatchCandidate: (request, proceed) => prepareOnly ? proceed() : dispatch.availability(request, proceed),
    validate: async (bounded, prepared, staged, response) => {
      const body = parseNativePricingJson(await bounded(response.text()));
      if (body?.pageData?.success === false) return { ok: false, issue: 'AVAILABILITY_UNVERIFIED' };
      await settleAmendAvailability(prepared.frame, body, bounded);
      const refreshed = await bounded(snapshot(prepared.frame));
      await syncRecord(prepared.frame, refreshed, bounded);
      const after = await bounded(snapshot(prepared.frame));
      if (!valid(after, prepared)) return { ok: false, issue: 'AMEND_DRAFT_CHANGED' };
      staged.draft = after;
      staged.approvedPrices = approvalPrice(after, prepared);
      return staged.approvedPrices ? true : { ok: false, issue: 'AMEND_RATE_UNVERIFIED' };
    },
  } : undefined;
  return {
    timeoutMs: 7 * 60_000, signal: input.signal, prepareOnly, reportDispatchDrain: !prepareOnly,
    dispatchDrainTimeoutMs: 5_000, reportBlockedTargets: input.reportBlockedTargets === true,
    prepare: async (bounded) => {
      const state = await bounded(current(page, expected, recordOptions));
      const baseline = await bounded(snapshot(state.frame));
      const bound = bind(expected, state, baseline, changes);
      preserved = cloudAmendPreserved(state, baseline, changes);
      const savedRates = changes.retainRates === 'yes' ? await bounded(readSavedBasis(state, bounded)) : null;
      const savedPrice = changes.retainRates === 'yes' ? observedAmendPrice(baseline, selected, null) : null;
      if (changes.retainRates === 'yes' && (!savedRates || !/^[a-f0-9]{64}$/.test(savedRates.digest || '') ||
          !savedPrice || savedRates.currency !== savedPrice.currency || savedRates.totals?.totalCents !== savedPrice.totalCents)) {
        throw new Error('AMEND_PRICE_UNVERIFIED');
      }
      const digest = savedRates ? nativePriceDigest({ version: 1, preimageDigest: bound?.digest, savedRateDigest: savedRates.digest }) : bound?.digest;
      if (!bound?.digest || !preserved || state.native.reservationstayid !== selected.reservationStayId ||
          state.native.reservationid !== selected.reservationId || state.native.recordid !== selected.recordId ||
          (!prepareOnly && (digest !== input.nativeDigest || !same(preserved, input.preserved)))) {
        throw new Error('AMEND_PREIMAGE_CHANGED');
      }
      nativeDigest = digest;
      const save = state.frame.locator('[data-qtip="Save Record (Ctrl+S)"]:visible');
      if (await bounded(save.count()) !== 1 || await bounded(state.frame.locator('.x-window:visible:not(.x-menu)').count()) !== 0) {
        throw new Error('AMEND_CONTROL_NOT_UNIQUE');
      }
      const occupancy = savedChildOccupancy(baseline);
      const childStageGate = childChanged ? createSavedChildStageRequestGate({ frame: state.frame,
        stayId: selected.reservationStayId, adults: target.adults, priorAges: occupancy.ages,
        priorBands: occupancy.bands, nextAges: changes.childAges, deadlineAt: performance.now() + 6 * 60_000 }) : null;
      const roomStageGate = roomChanged ? createSavedRoomStageRequestGate({ frame: state.frame, selected,
        deadlineAt: performance.now() + 6 * 60_000 }) : null;
      const rateStageGate = needsAvailability ? createSavedRateStageRequestGate({ frame: state.frame, selected,
        deadlineAt: performance.now() + 6 * 60_000 }) : null;
      if (prepareOnly) {
        try { quoted = await bounded(quote(input, state)); } catch { quoted = null; }
      } else {
        if (changes.retainRates === 'yes') {
          assertApprovedAmendPrice(baseline, selected, input.approvedPrices, { requireAverage: false });
        }
        if (!input.beforeScreenshot || typeof authorization.sealBeforeEvidence !== 'function') throw new Error('AMEND_EVIDENCE_REQUIRED');
        await bounded(page.screenshot({ path: input.beforeScreenshot }));
        const evidence = await bounded(authorization.sealBeforeEvidence());
        if (!evidence || !/^[0-9a-f-]{36}$/i.test(evidence.eventId || '') || !/^[a-f0-9]{64}$/.test(evidence.sha256 || '')) {
          throw new Error('AMEND_EVIDENCE_REQUIRED');
        }
        captureBefore({ beforeNote: expected.note, beforeParties: structuredClone(state.partyPreimage),
          beforeRecipient: preserved.cmsRecipient, beforeGuestEmail: preserved.guestEmail ?? '',
          beforeGuaranteeCode: state.expectedGuarantee?.code ?? 'NGI',
          beforeSavedRates: savedRates ? structuredClone(savedRates) : null,
          beforeEvidence: { eventId: evidence.eventId, sha256: evidence.sha256 } });
      }
      preparedState = { frame: state.frame, state, baseline, save, childStageGate, roomStageGate, rateStageGate,
        savedRateDigest: savedRates?.digest ?? null, enableComposedStage: true, allowRealGuest: input.allowRealGuest === true };
      return preparedState;
    },
    stage: async (bounded, prepared, context) => {
      stopOperation = context.stop;
      let draft = prepared.baseline;
      if (Object.hasOwn(proposed, 'adults')) draft = (await bounded(stageAdults(context, expected, proposed.adults))).snapshot;
      if (dateChanged) draft = await bounded(stageDates(context, expected, proposed, draft === prepared.baseline ? null : draft));
      if (childChanged) draft = await bounded(stageChildren(context, { ...expected,
        reservationStayId: selected.reservationStayId, adults: target.adults }, changes.childAges));
      // Picker refreshes are unsaved; keep HMS mail off until the final requested
      // form is staged so an intermediate native action cannot send a message.
      if ((roomChanged || String(draft.data?.rateplan ?? selected.ratePlan) !== target.ratePlan) && prepared.state.cmsSend === true) {
        draft = await bounded(stageGuest(context, { cmsSend: false }));
      }
      if (roomChanged) draft = await bounded(stageOption(context, 'roomType', selected.roomType, target.roomType));
      const currentRate = String(draft.data?.rateplan ?? selected.ratePlan);
      if (currentRate !== target.ratePlan) {
        draft = await bounded(stageOption(context, 'ratePlan', currentRate, target.ratePlan));
      }
      const fields = Object.fromEntries(['firstName', 'lastName', 'guestEmail', 'bookerName', 'bookerContact']
        .filter((key) => Object.hasOwn(changes, key)).map((key) => [key, changes[key]]));
      fields.cmsSend = changes.cmsSend;
      if (changes.cmsSend) { fields.cmsMessageId = changes.cmsMessageId; fields.cmsRecipient = changes.cmsRecipient; }
      draft = await bounded(stageGuest(context, fields));
      draft = await bounded(snapshot(prepared.frame));
      if (!context.isActive() || !valid(draft, prepared)) throw new Error('AMEND_DRAFT_CHANGED');
      return { draft, approvedPrices: needsAvailability ? null : approvalPrice(draft, prepared) };
    },
    validate: async (_bounded, prepared, staged) => Boolean(staged?.draft && valid(staged.draft, prepared) &&
      (needsAvailability || staged.approvedPrices)),
    stageDetails: (staged) => ({ nativeDigest, preserved, approvedPrices: staged?.approvedPrices ?? null }),
    ...(availability ? { availability } : {}),
    beforeSave: async (bounded, prepared, staged, scope) => {
      rateScope = scope;
      operationBounded = bounded;
      await assertSavedBasis(prepared);
      const latest = await bounded(snapshot(prepared.frame));
      if (!valid(latest, prepared)) throw new Error('AMEND_DRAFT_CHANGED');
      await syncRecord(prepared.frame, latest, bounded);
      firstSnapshot = await bounded(snapshot(prepared.frame));
      if (!valid(firstSnapshot, prepared)) throw new Error('AMEND_DRAFT_CHANGED');
      checkPrice(firstSnapshot, prepared);
      staged.draft = firstSnapshot;
    },
    matches: (request, frame, prepared) => firstSnapshot !== null &&
      matchesCloudPaneAmendSave(request, frame, firstSnapshot, saveOptions(prepared, 'save')),
    dispatchCandidate: (request, proceed) => dispatchSave('save', request, proceed),
    ...(!prepareOnly ? { retainRate: {
      choice: changes.retainRates,
      snapshot: async (bounded, prepared) => {
        questionSnapshot = await bounded(snapshot(prepared.frame));
        if (!valid(questionSnapshot, prepared)) throw new Error('AMEND_DRAFT_CHANGED');
        checkPrice(questionSnapshot, prepared);
        return questionSnapshot;
      },
      matches: (request, frame, prepared, _staged, observed) =>
        matchesCloudPaneAmendSave(request, frame, observed, saveOptions(prepared, 'retain')),
      dispatchCandidate: (request, proceed) => dispatchSave('retain', request, proceed),
    } } : {}),
    ...(!prepareOnly && allowsExtendOverrideRate ? { extendRate: {
      snapshot: async (bounded, prepared) => {
        extendSnapshot = await bounded(snapshot(prepared.frame));
        if (!valid(extendSnapshot, prepared)) throw new Error('AMEND_DRAFT_CHANGED');
        checkPrice(extendSnapshot, prepared);
        return extendSnapshot;
      },
      matches: (request, frame, prepared, _staged, observed) =>
        matchesCloudPaneAmendSave(request, frame, observed, saveOptions(prepared, 'extend')),
      dispatchCandidate: (request, proceed) => dispatchSave('extend', request, proceed),
    } } : {}),
  };
}

/** Compatibility export: admission depends on the native handle, not process identity. */
export function bindCloudAmendWriter(_page, authorization) {
  if (typeof authorization?.authorizeFirst !== 'function') throw new Error('AMEND_AUTHORITY_INVALID');
  return authorization;
}

/** Admit a bound native stay; all effects still require the paused-request claim. */
export function admitsCloudPaneAmend(input, authorization) {
  const selected = input?.selected;
  return Boolean(validTarget(input?.target) && amendTarget(selected, input?.changes, { allowRealGuest: input.allowRealGuest === true }) &&
    selected?.source === 'record_view_ext_model' && selected.propertyCode === 'HRCEN' &&
    selected.firstName?.trim() && selected.lastName?.trim() &&
    (input.allowRealGuest === true || (selected.firstName === 'Proof' && selected.lastName === 'Labtest')) && selected.status === 'Reserved' &&
    /^\d{6,}-\d+$/.test(selected.confirmation || '') && /^\d{1,30}$/.test(selected.guestId || '') &&
    input.confirmation === selected.confirmation && input.arrival === selected.arrival &&
    /^[a-f0-9]{64}$/.test(input.nativeDigest || '') && input.approvedPrices?.version === 2 &&
    /^[A-Z]{3}$/.test(input.approvedPrices.currency || '') && /^\d+$/.test(input.approvedPrices.totalCents || '') &&
    typeof input.preserved?.cmsRecipient === 'string' &&
    typeof input.beforeScreenshot === 'string' && input.beforeScreenshot &&
    typeof input.afterScreenshot === 'string' && input.afterScreenshot &&
    /^[a-f0-9]{64}$/.test(authorization?.operationDigest || '') &&
    typeof authorization?.authorizeFirst === 'function' && typeof authorization?.sealBeforeEvidence === 'function' &&
    !input.signal?.aborted);
}

/** Staff Go's native entry point; failures after an effect retain UNKNOWN. */
export async function commitCloudPaneAmend(input, authorization) {
  if (!admitsCloudPaneAmend(input, authorization)) return { outcome: 'not_dispatched', issue: 'AMEND_INPUT_INVALID' };
  let attempted = false, before = null;
  try {
    const protectedSession = guardedSession(input, installSavedStayReadGuard, 12 * 60_000);
    const saved = await withCenturionStay360Page(async (page) => {
      if (!protectedSession.hasGuard(page.context())) throw new Error('BROWSER_CONTEXT_UNSAFE');
      await readShallow(page, input.confirmation, searchHints(input.selected, input.arrival));
      const record = await readRecord(page, input.confirmation, { nativePropertyCode: 'HRCEN' });
      const expected = expectedLabtestAmendRecord(record, input.selected, { allowRealGuest: input.allowRealGuest === true });
      if (!expected) throw new Error('APPROVED_STAY_MISMATCH');
      attempted = true;
      return runLabtestAmendSave(page, cloudPaneAmendRunOptions({ page,
        input: { ...input, signal: protectedSession.options.signal }, expected, authorization,
        captureBefore: (value) => { before = value; } }, { recordOptions: nativeOptions(input, record) }));
    }, protectedSession.options);
    if (saved.outcome !== 'awaiting_readback' || saved.dispatchCallbacksDrained !== true) return saved;
    if (!before) return { outcome: 'uncertain', issue: 'AMEND_PREIMAGE_UNVERIFIED' };
    const fresh = await readCloudPaneAmend({ ...input, ...before });
    return confirmedCloudAmendResult(saved, fresh, true);
  } catch {
    return { outcome: attempted ? 'uncertain' : 'not_dispatched', issue: 'AMEND_UNVERIFIED' };
  }
}

/** Reopen the saved stay and verify the requested business fields independently. */
export async function readCloudPaneAmend(input, { openSession = withCenturionStay360Page,
  guard = installSavedStayReadGuard, shallow = readShallow, read = readRecord,
  current = currentLabtestRecord, snapshot = snapshotLabtestRecord, readRates = readSavedStayNightlyRates } = {}) {
  const selected = input?.selected, changes = input?.changes;
  const target = amendTarget(selected, changes, { allowRealGuest: input?.allowRealGuest === true });
  if (!validTarget(input?.target) || !target || typeof input.beforeNote !== 'string' ||
      !input.beforeParties || !input.afterScreenshot) return { outcome: 'unverified' };
  try {
    const protectedSession = guardedSession(input, guard);
    return await openSession(async (page) => {
      if (!protectedSession.hasGuard(page.context())) return { outcome: 'unverified' };
      await shallow(page, target.confirmation, searchHints(target, target.arrival));
      const record = await read(page, target.confirmation, { nativePropertyCode: 'HRCEN' });
      const native = record?.nativePreimage;
      if (!native || native.confirmation !== target.confirmation || native.reservationStayId !== target.reservationStayId ||
          native.reservationId !== target.reservationId || native.guestId !== target.guestId || native.propertyCode !== 'HRCEN' ||
          native.status !== 'Reserved' || native.firstName !== target.firstName || native.lastName !== target.lastName ||
          native.arrival !== target.arrival || native.departure !== target.departure || native.roomType !== target.roomType ||
          native.ratePlan !== target.ratePlan || native.adults !== target.adults || native.children !== target.children ||
          native.guaranteeCode !== input.beforeGuaranteeCode) return { outcome: 'unverified' };
      const expected = expectedLabtestAmendRecord(record, native, { allowRealGuest: input.allowRealGuest === true });
      if (!expected || expected.note !== input.beforeNote) return { outcome: 'unverified' };
      const state = await current(page, expected, nativeOptions(input, record));
      const saved = await snapshot(state.frame), data = saved?.data;
      if (!data || !cleanLabtestRecord(saved) || !unchangedLabtestBusinessParties(input.beforeParties, saved,
          { allowModelOnlyPrimaryPartyIds: true, allowRealGuest: input.allowRealGuest === true })) return { outcome: 'unverified' };
      const occupancy = savedChildOccupancy(saved);
      const ages = occupancy.ages ?? (occupancy.count === 0 ? [] : 'unknown');
      if (!occupancy.valid || occupancy.count !== target.children ||
          (Array.isArray(target.childAges) && !sameChildAgeMultiset(ages, target.childAges))) return { outcome: 'unverified' };
      const guestEmail = String(data.emailaddress ?? ''), bookerName = String(data.caller ?? ''),
        bookerContact = String(data.udfchar06 ?? ''), cmsRecipient = String(data.udfchar13 ?? ''),
        cmsMessageId = String(data.udfchar09 ?? '');
      for (const [name, actual] of Object.entries({ guestEmail, bookerName, bookerContact })) {
        if (Object.hasOwn(changes, name) && changes[name] !== actual) return { outcome: 'unverified' };
      }
      if ((!Object.hasOwn(changes, 'guestEmail') && guestEmail !== (input.beforeGuestEmail ?? '')) ||
          state.cmsSend !== changes.cmsSend ||
          (changes.cmsSend && (cmsRecipient !== changes.cmsRecipient || cmsMessageId !== changes.cmsMessageId)) ||
          (!changes.cmsSend && cmsRecipient !== input.beforeRecipient)) return { outcome: 'unverified' };
      if (changes.retainRates === 'no') {
        assertApprovedAmendPrice(saved, target, input.approvedPrices);
      } else {
        const beforeRates = input.beforeSavedRates;
        if (!Array.isArray(beforeRates?.nightly) || !beforeRates.nightly.length) return { outcome: 'unverified' };
        const afterRates = await readRates(page, state, { confirmation: target.confirmation,
          nativeStayId: target.reservationStayId, arrival: target.arrival, departure: target.departure }, { mode: 'saved_direct' });
        if (!afterRates || afterRates.currency !== beforeRates.currency || !Array.isArray(afterRates.nightly)) return { outcome: 'unverified' };
        const afterByDate = new Map(afterRates.nightly.map((night) => [night.date, night]));
        const overlap = beforeRates.nightly.filter((night) => afterByDate.has(night.date));
        if (!overlap.length || overlap.some((night) => {
          const after = afterByDate.get(night.date);
          return night.chargeCents !== after.chargeCents || night.totalChargeCents !== after.totalChargeCents;
        })) return { outcome: 'unverified' };
      }
      await page.screenshot({ path: input.afterScreenshot });
      return { outcome: 'matched', readback: { confirmation: native.confirmation, nativeStayId: native.reservationStayId,
        arrival: native.arrival, departure: native.departure, roomType: native.roomType, ratePlan: native.ratePlan,
        adults: native.adults, children: native.children, childAges: ages, firstName: native.firstName, lastName: native.lastName,
        guestEmail, bookerName, bookerContact, cmsSend: state.cmsSend, cmsMessageId, cmsRecipient,
        price: observedAmendPrice(saved, target, null) } };
    }, protectedSession.options);
  } catch { return { outcome: 'unverified' }; }
}
