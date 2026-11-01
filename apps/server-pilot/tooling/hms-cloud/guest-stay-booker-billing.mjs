// Stage Booker and billing-reference text only on a verified fake new stay.
// The page remains POST-fenced until closed: this module never saves a stay.
import { setGuestStayText } from './guest-stay-form.mjs';
import { isVerifiedLabtestProfileCurrent, verifiedLabtestProfileToken } from './guest-profile.mjs';
import { isVerifiedArSelectionCurrent, verifiedArSelectionToken } from './lookup.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const FIELDS = Object.freeze({ bookerName: 'caller', bookerContact: 'udfchar06', billingReference: 'billingreference' });
const BLANK_IDS = ['reservationshareid', 'reservationstayid', 'guaranteecardprofileid',
  'guestnameinfoid', 'externalprofileid', 'guestfoliocomptempresstayid', 'gueststaycouponids',
  'additionalprofileids', 'reservationid', 'addlplayerprofileid', 'sourceprofileid', 'recordid'];
const busy = new WeakSet();
const pageFences = new WeakMap();
const clean = (value) => String(value ?? '').trim();
const safeIssue = (error) => /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || '') ? error.message : 'STAGING_FAILED';

/** Validate the whole request before any page action; absent is not the same as ''. */
export function planBookerBilling(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !['propertyCode', 'serviceWorkersBlocked', ...Object.keys(FIELDS)].includes(key))) {
    return { outcome: 'input_gap', issue: 'STAGING_INPUT_INVALID' };
  }
  if (input.propertyCode !== 'HRCEN') return { outcome: 'input_gap', issue: 'PROPERTY_UNSUPPORTED' };
  if (input.serviceWorkersBlocked !== true) return { outcome: 'input_gap', issue: 'SERVICE_WORKER_BLOCK_REQUIRED' };
  const changes = {};
  for (const [key, nativeName] of Object.entries(FIELDS)) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (typeof value !== 'string' || value.length > 4000 || [...value].some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)) {
      return { outcome: 'input_gap', issue: 'STAGING_VALUE_INVALID', field: key };
    }
    changes[key] = { nativeName, value };
  }
  if (!Object.keys(changes).length) return { outcome: 'input_gap', issue: 'STAGING_VALUE_REQUIRED' };
  return { outcome: 'planned', changes };
}

/** This page-level fence is intentionally stricter than the shared read-only guard. */
export function allowsBookerBillingRequest({ method, url }) {
  try {
    const parsed = new URL(url);
    return ['GET', 'HEAD', 'OPTIONS'].includes(String(method).toUpperCase()) &&
      !/save|delete|cancel|duplicate|checkin|checkout|send|crs/i.test(parsed.pathname) &&
      ![...parsed.searchParams].some(([key, value]) => key.toLowerCase() === 'pageaction' &&
        /^(save|delete|cancel|duplicate|checkin|checkout|send|crs|insert|update|commit|create|submit|autosave|amend|post)$/i.test(value.trim()));
  } catch { return false; }
}

async function installFence(page) {
  let state = pageFences.get(page);
  if (state) return state;
  state = { blocked: 0, uncertain: false };
  // Keep this route for the life of the page, including after an uncertain action.
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (!allowsBookerBillingRequest({ method: request.method(), url: request.url() })) {
      state.blocked += 1;
      return route.abort();
    }
    return route.fallback();
  });
  pageFences.set(page, state);
  return state;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function labDate(value) {
  const match = /^(\d{2})-([A-Z]{3})-(\d{4})$/i.exec(clean(value));
  if (!match) return null;
  const day = Number(match[1]), month = MONTHS.indexOf(match[2].toUpperCase()), year = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (year < 2027 || month < 0 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

// Capture scalar record values to identify model changes without exposing their values in the result.
async function inspectDraft(page) {
  return page.evaluate(({ origin, fields, blankIds }) => {
    if (location.origin !== origin) throw new Error('HMS_ORIGIN_MISMATCH');
    const visible = (element) => Boolean((element.offsetWidth || element.offsetHeight) &&
      getComputedStyle(element).visibility !== 'hidden' && !element.closest('.x-window'));
    const named = (name) => [...document.querySelectorAll(`input[name="${name}"],textarea[name="${name}"]`)].filter(visible);
    const one = (name) => { const found = named(name); if (found.length !== 1) throw new Error('DRAFT_FIELD_NOT_UNIQUE'); return found[0]; };
    const component = (element) => element.id && globalThis.Ext?.getCmp?.(element.id.replace(/-inputEl$/, ''));
    const confirmation = one('confirmationnumber'), agency = one('ta1'), guest = one('guestid');
    const first = one('firstname'), last = one('lastname'), arrival = one('arrivaldate'), departure = one('departuredate');
    const anchor = component(guest), form = anchor?.up?.('form');
    const basics = [confirmation, agency, guest, first, last, arrival, departure];
    if (!form?.el?.dom || basics.some((element) => !form.el.dom.contains(element) || component(element)?.up?.('form') !== form)) {
      throw new Error('DRAFT_FORM_UNVERIFIED');
    }
    const data = form.getRecord?.()?.data;
    const keys = data && Object.keys(data);
    const unique = (key) => keys && Object.hasOwn(data, key) && keys.filter((name) => name.toLowerCase() === key.toLowerCase()).length === 1;
    const value = (key) => unique(key) ? String(data[key] ?? '').trim() : null;
    const exact = (key, expected) => value(key) === expected;
    const accountKeys = keys?.filter((key) => key.toLowerCase() === 'araccountid') || [];
    if (!data || !exact('propertycode', 'HRCEN') || !exact('PKID', '@[EMPTY]#@[EMPTY]#HRCEN#') ||
        !exact('status', 'New') || !exact('confirmationnumber', '') || !unique('bookingsessionid') || !value('bookingsessionid') ||
        !unique('guestid') || !unique('arprofileid') || accountKeys.length > 1 ||
        !blankIds.every((key) => exact(key, '')) ||
        keys.some((key) => /(?:guest|profile|reservation|record|stay).*id/i.test(key) && !/^is/i.test(key) &&
          !['guestid', 'arprofileid'].includes(key) && String(data[key] ?? '').trim())) throw new Error('DRAFT_ID_UNVERIFIED');
    const guestValue = typeof anchor?.getValue === 'function' ? String(anchor.getValue() ?? '').trim() : null;
    const nameMatches = (element, key, expected) => element.value === expected &&
      typeof component(element)?.getValue === 'function' && String(component(element).getValue() ?? '') === expected &&
      (value(key) === '' || value(key) === expected);
    if (confirmation.value.trim() || guest.value.trim() !== value('guestid') || guestValue !== value('guestid') ||
        !nameMatches(first, 'firstname', 'Proof') || !nameMatches(last, 'lastname', 'Labtest')) {
      throw new Error('LABTEST_DRAFT_UNVERIFIED');
    }
    for (const element of [arrival, departure]) {
      if (typeof component(element)?.getRawValue !== 'function' || component(element).getRawValue() !== element.value) {
        throw new Error('LABTEST_DATES_UNVERIFIED');
      }
    }
    const accountId = value('araccountid') || '', profileId = value('arprofileid');
    if (Boolean(accountId) !== Boolean(profileId)) throw new Error('AR_SELECTION_UNVERIFIED');
    const windows = [...document.querySelectorAll('.x-window:not(.x-menu)')].filter((element) =>
      Boolean((element.offsetWidth || element.offsetHeight) && getComputedStyle(element).visibility !== 'hidden'));
    if (windows.length) throw new Error('UNEXPECTED_DIALOG');
    const controls = {};
    for (const [key, name] of Object.entries(fields)) {
      const found = named(name);
      if (found.length !== 1) { controls[key] = { issue: 'FIELD_NOT_UNIQUE' }; continue; }
      const element = found[0], cmp = component(element);
      if (!cmp || typeof cmp.getValue !== 'function' || typeof cmp.getSubmitData !== 'function' ||
          cmp.up?.('form') !== form || !form.el.dom.contains(element)) {
        controls[key] = { issue: 'NATIVE_CONTROL_UNVERIFIED' }; continue;
      }
      let submit;
      try { submit = cmp.getSubmitData(); } catch { controls[key] = { issue: 'NATIVE_SUBMIT_UNAVAILABLE' }; continue; }
      const submitKeys = submit && typeof submit === 'object' ? Object.keys(submit) : [];
      const errors = typeof cmp.getActiveErrors === 'function' ? cmp.getActiveErrors() : [];
      controls[key] = { dom: element.value, native: String(cmp.getValue() ?? ''),
        submit: submitKeys.filter((item) => item.toLowerCase() === name.toLowerCase()).length === 1 && Object.hasOwn(submit, name)
          && submit[name] != null ? String(submit[name]) : null,
        disabled: Boolean(element.disabled || cmp.disabled || cmp.isDisabled?.()),
        readOnly: Boolean(element.readOnly || cmp.readOnly),
        maxLength: Math.min(...[element.maxLength, cmp.maxLength].filter((length) =>
          typeof length === 'number' && Number.isFinite(length) && length >= 0), Infinity),
        invalid: element.getAttribute('aria-invalid') === 'true' || (Array.isArray(errors) && errors.length > 0) };
    }
    const scalar = {}, omitted = [];
    for (const key of keys) {
      const item = data[key];
      if (item == null || ['string', 'number', 'boolean'].includes(typeof item)) scalar[key] = item ?? null;
      else omitted.push(key);
    }
    const visibleFields = [...form.el.dom.querySelectorAll('input,textarea,select')].filter((element) =>
      visible(element) && !['hidden', 'password'].includes(element.type)).map((element) => ({
        id: element.id || null, name: element.name || null, type: element.type || element.tagName.toLowerCase(),
        value: ['checkbox', 'radio'].includes(element.type) ? element.checked : element.value,
        disabled: Boolean(element.disabled), readOnly: Boolean(element.readOnly),
      }));
    return { identity: { session: value('bookingsessionid'), guestId: value('guestid'), accountId, profileId,
      arrival: arrival.value, departure: departure.value }, controls, scalar, omitted, visibleFields };
  }, { origin: ORIGIN, fields: FIELDS, blankIds: BLANK_IDS });
}

async function verifyIdentity(page, snapshot) {
  const identity = snapshot.identity;
  const arrival = labDate(identity?.arrival), departure = labDate(identity?.departure);
  if (!arrival || !departure || arrival >= departure) throw new Error('LABTEST_DATES_UNVERIFIED');
  let guest = null, ar = null;
  if (identity.guestId) {
    const token = await verifiedLabtestProfileToken(page, { nativeId: identity.guestId, session: identity.session });
    if (!token) throw new Error('GUEST_PROFILE_UNVERIFIED');
    guest = { nativeId: identity.guestId, session: identity.session, token };
  }
  if (identity.accountId || identity.profileId) {
    const request = { session: identity.session, accountId: identity.accountId, profileId: identity.profileId };
    const token = await verifiedArSelectionToken(page, request);
    if (!token) throw new Error('AR_SELECTION_UNVERIFIED');
    ar = { ...request, token };
  }
  return { guest, ar };
}

function identityCurrent(page, proof) {
  return (!proof.guest || isVerifiedLabtestProfileCurrent(page, proof.guest)) &&
    (!proof.ar || isVerifiedArSelectionCurrent(page, proof.ar));
}

function safeName(value) { return typeof value === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(value) ? value : '<unidentified>'; }
function diffs(before, after, targetNames) {
  const identity = (field, index) => field.id || `${field.name || ''}:${index}`;
  const old = new Map(before.visibleFields.map((field, index) => [identity(field, index), field]));
  const next = new Map(after.visibleFields.map((field, index) => [identity(field, index), field]));
  const visible = [...new Set([...old.keys(), ...next.keys()])].flatMap((id) => {
    const a = old.get(id), b = next.get(id);
    if (JSON.stringify(a) === JSON.stringify(b)) return [];
    const name = a?.name === b?.name ? a?.name : null;
    return [{ name: safeName(name), requested: Boolean(name && targetNames.has(name)) }];
  });
  const model = [...new Set([...Object.keys(before.scalar), ...Object.keys(after.scalar)])].flatMap((name) => {
    if (Object.hasOwn(before.scalar, name) && Object.hasOwn(after.scalar, name) &&
        Object.is(before.scalar[name], after.scalar[name])) return [];
    return [{ name: safeName(name), requested: targetNames.has(name) }];
  });
  return { visible, model, modelCoverage: { omittedBefore: before.omitted.map(safeName), omittedAfter: after.omitted.map(safeName), nonScalarValuesCompared: false } };
}

/** Classify native, visible, identity and scalar-model readback for synthetic tests and callers. */
export function assessBookerBillingReadback(before, after, plan) {
  if (!before?.controls || !after?.controls || plan?.outcome !== 'planned') return { ok: false, issue: 'READBACK_UNAVAILABLE' };
  const targets = new Set(Object.values(plan.changes).map(({ nativeName }) => nativeName));
  const changes = diffs(before, after, targets);
  if (JSON.stringify(before.identity) !== JSON.stringify(after.identity)) return { ok: false, issue: 'DRAFT_IDENTITY_CHANGED', changes };
  if (JSON.stringify(before.omitted) !== JSON.stringify(after.omitted)) return { ok: false, issue: 'MODEL_COVERAGE_CHANGED', changes };
  for (const key of Object.keys(FIELDS)) {
    if (!Object.hasOwn(plan.changes, key) && JSON.stringify(before.controls[key]) !== JSON.stringify(after.controls[key])) {
      return { ok: false, issue: 'UNSPECIFIED_CONTROL_CHANGED', field: key, changes };
    }
  }
  for (const [key, { value, nativeName }] of Object.entries(plan.changes)) {
    const control = after.controls[key];
    if (!control || control.issue || control.invalid || control.disabled || control.readOnly ||
        control.dom !== value || control.native !== value || control.submit !== value) {
      return { ok: false, issue: 'NATIVE_READBACK_MISMATCH', field: key, changes };
    }
    if (Object.hasOwn(after.scalar, nativeName) && !Object.is(after.scalar[nativeName], before.scalar[nativeName]) &&
        after.scalar[nativeName] !== value) return { ok: false, issue: 'NATIVE_MODEL_MISMATCH', field: key, changes };
  }
  if (changes.visible.some((change) => !change.requested) || changes.model.some((change) => !change.requested)) {
    return { ok: false, issue: 'UNEXPECTED_FORM_CHANGE', changes };
  }
  return { ok: true, changes };
}

/** No save/send. This intentionally terminally POST-fences the caller's page. */
export async function stageGuestStayBookerBilling(page, input) {
  const plan = planBookerBilling(input);
  if (plan.outcome !== 'planned') return plan;
  if (!page || ['evaluate', 'route', 'locator', 'waitForTimeout', 'on', 'off'].some((key) => typeof page[key] !== 'function')) {
    return { outcome: 'input_gap', issue: 'PAGE_REQUIRED' };
  }
  if (busy.has(page)) return { outcome: 'execution_failure', issue: 'ACTION_IN_PROGRESS' };
  if (pageFences.get(page)?.uncertain) return { outcome: 'execution_failure', issue: 'PAGE_ACTION_UNCERTAIN' };
  busy.add(page);
  let attempted = false, fence, before, blockedAtStart = 0, nativeDialog = false;
  const verifiedFields = [];
  const onDialog = () => { nativeDialog = true; };
  page.on('dialog', onDialog);
  try {
    before = await inspectDraft(page);
    const proof = await verifyIdentity(page, before);
    for (const [key, { value }] of Object.entries(plan.changes)) {
      const control = before.controls[key];
      if (!control || control.issue) return { outcome: 'unsupported', issue: control?.issue || 'FIELD_UNAVAILABLE', field: key };
      if (control.disabled || control.readOnly) return { outcome: 'unsupported', issue: 'FIELD_NOT_EDITABLE', field: key };
      if (control.invalid) return { outcome: 'unsupported', issue: 'FIELD_INVALID', field: key };
      if (control.dom !== control.native || control.dom !== control.submit) return { outcome: 'unsupported', issue: 'FIELD_PREIMAGE_UNVERIFIED', field: key };
      if (Number.isInteger(control.maxLength) && control.maxLength >= 0 && value.length > control.maxLength) {
        return { outcome: 'input_gap', issue: 'FIELD_VALUE_TOO_LONG', field: key };
      }
    }
    fence = await installFence(page); blockedAtStart = fence.blocked;
    if (blockedAtStart) { fence.uncertain = true; throw new Error('PAGE_ACTION_UNCERTAIN'); }
    for (const [key, { nativeName, value }] of Object.entries(plan.changes)) {
      const current = await inspectDraft(page);
      const verified = { outcome: 'planned', changes: Object.fromEntries(verifiedFields.map((field) => [field, plan.changes[field]])) };
      const existing = assessBookerBillingReadback(before, current, verified);
      if (JSON.stringify(current.identity) !== JSON.stringify(before.identity) || !identityCurrent(page, proof) || nativeDialog ||
          fence.blocked !== blockedAtStart || !existing.ok || JSON.stringify(current.controls[key]) !== JSON.stringify(before.controls[key])) {
        fence.uncertain = true;
        return { outcome: attempted ? 'action_uncertain' : 'execution_failure', issue: 'DRAFT_CHANGED_BEFORE_ACTION',
          verifiedFields, ...(existing.changes ? { changes: existing.changes } : {}), pagePostFence: 'until_page_close' };
      }
      if (!(current.controls[key]?.dom === value && current.controls[key]?.native === value && current.controls[key]?.submit === value)) {
        attempted = true;
        if (key !== 'billingReference') {
          const result = await setGuestStayText(page, { propertyCode: input.propertyCode, field: key, value });
          if (!['updated_unsaved', 'unchanged_unsaved'].includes(result.outcome)) throw new Error(result.issue || 'TEXT_ACTION_UNCERTAIN');
        } else {
          const control = page.locator(`input[name="${nativeName}"]:visible, textarea[name="${nativeName}"]:visible`);
          if (await control.count() !== 1 || !await control.isEditable()) throw new Error('FIELD_NOT_EDITABLE');
          await control.fill(value, { timeout: 5000 });
          await control.press('Tab', { timeout: 5000 });
          await page.waitForTimeout(1000);
        }
      }
      const partial = { outcome: 'planned', changes: Object.fromEntries([...verifiedFields, key].map((field) => [field, plan.changes[field]])) };
      const assessment = assessBookerBillingReadback(before, await inspectDraft(page), partial);
      if (nativeDialog || fence.blocked !== blockedAtStart || !identityCurrent(page, proof) || !assessment.ok) {
        fence.uncertain = true;
        return { outcome: 'action_uncertain', issue: nativeDialog ? 'UNEXPECTED_DIALOG' : fence.blocked !== blockedAtStart
          ? 'UNEXPECTED_REQUEST_BLOCKED' : !identityCurrent(page, proof) ? 'DRAFT_PROOF_EXPIRED' : assessment.issue,
          verifiedFields, attemptedField: key, ...(assessment.field ? { field: assessment.field } : {}),
          ...(assessment.changes ? { changes: assessment.changes } : {}),
          blockedRequestCount: fence.blocked - blockedAtStart, pagePostFence: 'until_page_close' };
      }
      verifiedFields.push(key);
    }
    const after = await inspectDraft(page);
    const assessment = assessBookerBillingReadback(before, after, plan);
    if (nativeDialog || fence.blocked !== blockedAtStart || !identityCurrent(page, proof) || !assessment.ok) {
      fence.uncertain = true;
      return { outcome: 'action_uncertain', issue: nativeDialog ? 'UNEXPECTED_DIALOG' : fence.blocked !== blockedAtStart
        ? 'UNEXPECTED_REQUEST_BLOCKED' : !identityCurrent(page, proof) ? 'DRAFT_PROOF_EXPIRED' : assessment.issue,
        verifiedFields, ...(assessment.field ? { field: assessment.field } : {}), ...(assessment.changes ? { changes: assessment.changes } : {}),
        blockedRequestCount: fence.blocked - blockedAtStart, pagePostFence: 'until_page_close' };
    }
    return { outcome: attempted ? 'updated_unsaved' : 'unchanged_unsaved',
      fields: Object.fromEntries(Object.entries(plan.changes).map(([key, { nativeName, value }]) => [key, {
        nativeName, requested: value, visible: after.controls[key].dom, native: after.controls[key].native, submit: after.controls[key].submit,
        model: !Object.hasOwn(after.scalar, nativeName) ? 'not_exposed_as_scalar' : after.scalar[nativeName] === value
          ? 'matches' : 'unchanged_preimage',
      }])), changes: assessment.changes, pagePostFence: 'until_page_close', persistence: 'not_attempted',
      limitations: ['NON_SCALAR_MODEL_VALUES_NOT_COMPARED', 'PERSISTENCE_NOT_VERIFIED'] };
  } catch (error) {
    if (attempted && fence) fence.uncertain = true;
    let changes;
    if (attempted && before && !nativeDialog) {
      try { changes = diffs(before, await inspectDraft(page), new Set(Object.values(plan.changes).map(({ nativeName }) => nativeName))); }
      catch { /* Readback is unavailable; the caller must discard the page. */ }
    }
    return { outcome: attempted ? 'action_uncertain' : 'execution_failure', issue: nativeDialog ? 'UNEXPECTED_DIALOG' : safeIssue(error),
      verifiedFields, ...(changes ? { changes } : {}),
      ...(fence ? { pagePostFence: 'until_page_close', blockedRequestCount: fence.blocked - blockedAtStart } : {}) };
  } finally {
    page.off('dialog', onDialog);
    busy.delete(page);
  }
}
