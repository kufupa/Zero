// Guest-master preparation and guarded creation on a dedicated HRCEN session.
import { createHash } from 'node:crypto';
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { shouldAbortReadOnlyRequest } from '../playwright-quote/hms-read-only-guard.mjs';
import { prepareGuardedContext, isGuardedPage } from './pre-navigation-context-guard.mjs';
import { guestLookupMayRequest, fulfillGuestLookupRequest } from './pane-guest-search.mjs';
import { openNewGuestStay } from './lookup.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const PROPERTY = 'HRCEN';
const clean = value => typeof value === 'string' ? value.trim() : '';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const issue = error => /^[A-Z][A-Z0-9_]{2,100}$/.test(String(error?.message || ''))
  ? error.message : error?.name === 'TimeoutError' ? 'PROFILE_UI_TIMED_OUT' : 'PROFILE_PREPARATION_FAILED';

export function profileBusinessFields(input) {
  const guest = input?.guest;
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['propertyCode', 'guest', 'confirmDuplicateName', 'expectedPreviewDigest'].includes(key)) ||
      (input.propertyCode != null && input.propertyCode !== PROPERTY) ||
      (input.confirmDuplicateName != null && typeof input.confirmDuplicateName !== 'boolean') ||
      !guest || typeof guest !== 'object' || Array.isArray(guest) ||
      Object.keys(guest).some(key => !['firstName', 'lastName', 'mobile', 'email'].includes(key))) return null;
  if (guest.email != null && typeof guest.email !== 'string') return null;
  const fields = { firstName: clean(guest.firstName), lastName: clean(guest.lastName),
    mobile: clean(guest.mobile), email: guest.email == null ? '' : clean(guest.email) };
  if (['firstName', 'lastName', 'mobile'].some(key => !fields[key]) ||
      Object.values(fields).some(value => value.length > 200 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) return null;
  return { ...fields, status: 'ACTIVE', consent: false };
}

export function profilePreviewDigest(fields, confirmDuplicateName) {
  return hash({ property: PROPERTY, fields, confirmDuplicateName: confirmDuplicateName === true });
}

function unique(params) {
  const keys = [...params.keys()].map(key => key.toLowerCase());
  return new Set(keys).size === keys.length;
}

function profileSaveMatches(request, fields, confirmed) {
  try {
    const url = new URL(request.url()), body = new URLSearchParams(request.postData() || '');
    const required = { SYSTEM_FUNCTION_NAME: 'FSGSPF', USER_FUNCTION_NAME: 'FSGSPF', CURRENT_TAB_NAME: 'HDR',
      firstname: fields.firstName, lastname: fields.lastName, mobilenumber: fields.mobile, emailaddress: fields.email,
      profilestatuscode: 'ACTIVE', profileid: '', recordid: '',
      confirmnewguestprofile: confirmed ? 'confirmed' : '', confirminactiveguestprofile: '' };
    const matches = (params, name, expected) => {
      const values = [...params].filter(([key]) => key.toLowerCase() === name.toLowerCase());
      return values.length === 1 && values[0][1] === expected;
    };
    return request.method() === 'POST' && url.origin === ORIGIN && !url.username && !url.password && !url.hash &&
      decodeURIComponent(url.pathname) === url.pathname &&
      url.pathname === '/web/base/FSGSPF.HDR' && matches(url.searchParams, 'pageaction', 'SAVE') &&
      /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '') &&
      Object.entries(required).every(([key, value]) => matches(body, key, value)) &&
      [1, 2, 3, 4].every(index => {
        const entries = [...body].filter(([key]) => key.toLowerCase() === `guestoptin${index}`);
        return entries.length === 1 && ['', '0', 'false'].includes(entries[0][1].toLowerCase());
      }) &&
      [...body].filter(([key]) => /^guestoptin\d+$/i.test(key))
        .every(([, value]) => ['', '0', 'false'].includes(value.toLowerCase()));
  } catch { return false; }
}

function parseProfileResponse(text) {
  const json = text.replace(/("(?:\\.|[^"\\])*")|([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    (match, quoted, prefix, key) => quoted || `${prefix}"${key}":`);
  return JSON.parse(json)?.pageData;
}

async function handleProfileSave(route, state) {
  const write = state.write, request = route.request();
  const confirmed = write.phase === 'confirm';
  let forwarded = false, pending;
  try {
    if (state.blocked || state.dialog || !['initial', 'confirm'].includes(write.phase) || !isGuardedPage(request.frame().page()) ||
        !profileSaveMatches(request, write.fields, confirmed)) throw new Error('PROFILE_SAVE_REQUEST_MISMATCH');
    const phase = confirmed ? 'confirm_distinct' : 'initial';
    write.lastPhase = phase;
    write.phase = 'authorizing';
    write.callbackDrained = false;
    const context = Object.freeze({ phase, previewDigest: write.previewDigest,
      confirmDuplicateName: write.confirmDuplicateName, fields: Object.freeze({ ...write.fields }) });
    if (await write.authorizeCandidate(context) !== true || state.blocked || state.dialog || write.phase !== 'authorizing') {
      throw new Error('PROFILE_SAVE_NOT_AUTHORIZED');
    }
    let used = false;
    const proceed = () => {
      if (used || state.blocked || state.dialog || write.phase !== 'authorizing' || !isGuardedPage(request.frame().page()) ||
          !profileSaveMatches(request, write.fields, confirmed)) throw new Error('PROFILE_SAVE_AUTHORITY_STALE');
      used = true;
      write.phase = 'waiting';
      write.dispatched = true;
      write.dispatchedPhases.push(phase);
      forwarded = true;
      pending = (async () => {
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30_000 });
        const text = await response.text();
        let data;
        try { data = parseProfileResponse(text); } catch { /* unknown until readback */ }
        const messages = data?.messages;
        const question = !confirmed && response.status() === 200 && data?.success === false &&
          Array.isArray(messages) && messages.length === 1 && messages[0].type === 'question' &&
          messages[0].questiontype === 'YesNo' && messages[0].handler === 'confirmNewGuestProfile' &&
          messages[0].msg === 'Profile name already exists. Continue?';
        const id = String(data?.values?.profileid ?? '').trim();
        write.response = { status: response.status(), success: response.status() === 200 && data?.success === true,
          nativeId: /^\d+$/.test(id) ? id : null, question };
        // Persist the response and any native ID before the browser receives it.
        await write.recordResponse(context, Object.freeze({ ...write.response }));
        if (write.phase !== 'closed') write.phase = question ? 'question' : 'finished';
        await route.fulfill({ response });
        return true;
      })();
      return pending;
    };
    await write.dispatchCandidate(context, proceed);
    if (!used) throw new Error('PROFILE_SAVE_NOT_DISPATCHED');
    await pending;
    write.callbackDrained = true;
  } catch (error) {
    write.issue = forwarded || write.dispatched ? 'PROFILE_SAVE_UNCERTAIN' : issue(error);
    if (write.phase !== 'closed') write.phase = 'failed';
    if (pending) await pending.catch(() => {});
    try { await route.abort('blockedbyclient'); } catch { /* A dispatched request remains uncertain. */ }
  }
}

// Only observed navigation and blank/exact-ID master reads are
// admitted. The context never permits Save, confirmation, send or card routes.
function profileCreateReadMayRequest(request, state = {}) {
  try {
    const url = new URL(request.url()), method = request.method().toUpperCase();
    const postData = request.postData() || '', body = new URLSearchParams(postData);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash ||
        decodeURIComponent(url.pathname) !== url.pathname || !unique(url.searchParams) || !unique(body) ||
        shouldAbortReadOnlyRequest({ method, url: request.url(), postData })) return false;
    const hasWrite = params => [...params].some(([key, value]) =>
      /^(?:pageaction|action|autosave)$/i.test(key) && /^(?:save|delete|cancel|duplicate|insert|update|commit|create|submit|post|amend)$/i.test(value.trim()) ||
      /^(?:confirmnewguestprofile|confirminactiveguestprofile|newprofileclick|createinactiveprofileflag|savecctoprofile|savesettlementcctoprofile)$/i.test(key) &&
        !['', '0', 'false', '-'].includes(value.trim().toLowerCase()));
    if (hasWrite(url.searchParams) || hasWrite(body)) return false;
    if (guestLookupMayRequest({ method, url: request.url(), postData,
      contentType: request.headers()['content-type'] })) return true;
    // Native form initialization needs the static vault scripts (vcei). The
    // lookup predicate admits vetted asset GETs; vault/card actions still fail.
    if (/(?:save|delete|cancel|duplicate|confirmnew|send|card|vault|upload|checkin|checkout|amend)/i.test(url.pathname)) return false;
    if (method === 'GET') {
      if (['/', '/favicon.ico'].includes(url.pathname) && !url.search) return true;
      return url.pathname === '/web/base/loadmain' && url.searchParams.get('initpath') === 'FSGSPF' &&
        url.searchParams.get('SYSTEM_FUNCTION_NAME') === 'FSGSPF' &&
        url.searchParams.get('USER_FUNCTION_NAME') === 'FSGSPF' &&
        url.searchParams.get('popup') === 'TRUE' && url.searchParams.get('CURRENT_TAB_NAME') === 'HDR' &&
        url.searchParams.get('initparams') === 'startUpView=left' && Boolean(url.searchParams.get('requestToken'));
    }
    if (method !== 'POST' || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '')) return false;
    const system = body.get('SYSTEM_FUNCTION_NAME'), user = body.get('USER_FUNCTION_NAME'), tab = body.get('CURRENT_TAB_NAME');
    if (url.pathname === '/web/base/OSRESV.HDR' && !url.search && system === 'OSRESV' && user === 'OSRESV' && tab === 'HDR' &&
        body.get('ONLY_DATA_REQUIRED') === 'true' && body.get('SCROLLROW') === 'YES' &&
        ['confirmationnumber', 'reservationstayid', 'guestid', 'guestfullname', 'account', 'firstname', 'lastname'].every(key => body.get(key) === '') &&
        ['', PROPERTY].includes(body.get('propertycode'))) return true;
    if (url.search || system !== 'FSGSPF' || user !== 'FSGSPF') return false;
    if (url.pathname === '/web/base/FSGSPF') return body.get('startUpView') === 'left' && body.get('removescreenflows') === 'yes';
    if (url.pathname === '/web/base/FSGSPF.LST') return tab === 'LST' && body.get('COMPONENT_INFO_TYPE') === 'HEAD_DATA';
    if (url.pathname !== '/web/base/FSGSPF.HDR' || tab !== 'HDR' ||
        !['guestfullname', 'externalid', 'account'].every(key => body.get(key) === '')) return false;
    const id = body.get('profileid');
    if (id === '' && body.get('removescreenflows') === 'yes') return true;
    return (id === '' || (state.masterId && id === state.masterId)) &&
      body.get('ONLY_DATA_REQUIRED') === 'true' && body.get('SCROLLROW') === 'YES';
  } catch { return false; }
}

async function guardedSession(openSession, state, operation, options) {
  const result = await openSession(async page => {
    // Keep tracking until the owned session finishes closing, including cleanup.
    page.on('dialog', () => { state.dialog = true; });
    return operation(page);
  }, options);
  if (state.blocked || state.dialog) throw new Error('PROFILE_SESSION_GUARD_TRIPPED');
  return result;
}

async function withReadSession(operation, state, { openSession = withCenturionStay360Page, signal } = {}) {
  return guardedSession(openSession, state, async page => {
    if (!isGuardedPage(page)) throw new Error('PROFILE_CONTEXT_UNSAFE');
    const valid = await page.evaluate(() => ({ origin: location.origin, title: document.title,
      property: [...document.querySelectorAll('[data-qtip="Property"]')].filter(e => e.getClientRects().length).map(e => e.textContent.trim()) }));
    if (valid.origin !== ORIGIN || !/Infor HMS\s*-\s*HRCEN/i.test(valid.title) ||
        valid.property.length !== 1 || valid.property[0] !== PROPERTY) throw new Error('PROFILE_PROPERTY_UNVERIFIED');
    await openNewGuestStay(page);
    return operation(page, state);
  }, { headless: true, blockServiceWorkers: true, signal: signal || AbortSignal.timeout(120000),
    prepareContext: async context => {
      await prepareGuardedContext(context);
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const profileSave = request.method() === 'POST' && url.origin === ORIGIN &&
          url.pathname === '/web/base/FSGSPF.HDR' && url.searchParams.get('pageaction')?.toUpperCase() === 'SAVE';
        if (state.write && profileSave) {
          const handler = handleProfileSave(route, state);
          state.write.handlers.add(handler);
          try { return await handler; } finally { state.write.handlers.delete(handler); }
        }
        if (!profileCreateReadMayRequest(request, state)) {
          // Blank Guest Stay initializes its card frame automatically. Always
          // refuse that known request without treating it as a profile action.
          const cardInit = request.method() === 'POST' && url.origin === 'https://hmsvault.hms.eu1.inforcloudsuite.com' &&
            url.pathname === '/Vault/servlets/showCardEntryHandler';
          if (request.method() !== 'GET' && !cardInit) state.blocked = true;
          return route.abort('blockedbyclient');
        }
        return fulfillGuestLookupRequest(route);
      });
    } });
}

async function openProfileFrame(page) {
  const ids = await page.evaluate(() => (globalThis.Ext?.ComponentQuery?.query('button[name=guestprofile]') || [])
    .filter(c => c.el?.dom?.getClientRects().length && !c.disabled && (c.formPanel?.tabName || c.up?.('uxform')?.tabName) === 'HDR').map(c => c.id));
  if (ids.length !== 1) throw new Error('PROFILE_CONTROL_UNAVAILABLE');
  await page.locator(`[id="${ids[0]}"]`).click({ timeout: 10000 });
  let frame;
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const frames = page.frames().filter(f => f.url().includes('/web/base/loadmain') && f.url().includes('FSGSPF'));
    if (frames.length > 1) throw new Error('PROFILE_FRAME_UNVERIFIED');
    if (frames.length === 1) { frame = frames[0]; break; }
    await page.waitForTimeout(100);
  }
  if (!frame) throw new Error('PROFILE_FRAME_UNAVAILABLE');
  await frame.waitForFunction(() => (globalThis.Ext?.ComponentQuery?.query('uxform[tabName=HDR]') || []).length === 1, null, { timeout: 15000 });
  const before = await frame.evaluate(() => {
    const form = Ext.ComponentQuery.query('uxform[tabName=HDR]')[0], screen = form?.getScreen?.();
    return { origin: location.origin, title: document.title, function: screen?.systemFunction,
      dirty: !!form?.isDirty?.(), tabDirty: !!screen?.getCurrentTab?.()?.isDirty?.() };
  });
  if (before.origin !== ORIGIN || !/Infor HMS\s*-\s*HRCEN/i.test(before.title) || before.function !== 'FSGSPF' || before.dirty || before.tabDirty) {
    throw new Error('PROFILE_CLEAN_SCREEN_UNVERIFIED');
  }
  return frame;
}

async function openNewProfile(page) {
  const frame = await openProfileFrame(page);
  const button = frame.locator('[data-qtip="New Record (Ctrl+N)"]:visible');
  if (await button.count() !== 1) throw new Error('PROFILE_NEW_CONTROL_UNAVAILABLE');
  await button.click({ timeout: 10000 });
  await frame.waitForFunction(() => {
    const forms = globalThis.Ext?.ComponentQuery?.query('uxform[tabName=HDR]') || [];
    return forms.length === 1 && forms[0].getScreen?.()?.isNewRecord === true &&
      (forms[0].query?.('[name=profileid]') || []).length === 1;
  }, null, { timeout: 15000 });
  return frame;
}

async function profileForm(frame) {
  return frame.evaluate(() => {
    const forms = globalThis.Ext?.ComponentQuery?.query('uxform[tabName=HDR]') || [];
    if (forms.length !== 1) return null;
    const form = forms[0], screen = form.getScreen?.(), fields = (form.query?.('[name]') || []).filter(c => c.isFormField);
    const names = ['profileid', 'profilestatuscode', 'lastname', 'firstname', 'mobilenumber', 'emailaddress',
      'guestoptin1', 'guestoptin2', 'guestoptin3', 'guestoptin4'];
    const values = Object.fromEntries(names.map(name => [name, fields.filter(c => c.name === name).map(c => ({
      value: c.getValue?.(), raw: c.getRawValue?.(), submit: c.getSubmitData?.(), valid: c.isValid?.(),
      readOnly: !!c.readOnly, disabled: !!c.disabled }))]));
    return { nativeNew: !!screen?.isNewRecord, dirty: !!form.isDirty?.(), values,
      required: fields.filter(c => c.allowBlank === false).map(c => ({ name: c.name, valid: c.isValid?.() })),
      dialogs: [...document.querySelectorAll('.x-window')].filter(e => e.getClientRects().length).length };
  });
}

function validProfileForm(form, fields, initial = false) {
  if (!form?.nativeNew || form.dialogs || (initial && form.dirty)) return false;
  const one = name => form.values[name]?.length === 1 ? form.values[name][0] : null;
  const id = one('profileid'), status = one('profilestatuscode');
  if (!id || id.value !== '' || !id.readOnly || !status || status.value !== 'ACTIVE' || status.raw !== 'Active') return false;
  if (['guestoptin1', 'guestoptin2', 'guestoptin3', 'guestoptin4'].some(name => one(name)?.value !== false)) return false;
  for (const [native, key] of [['lastname', 'lastName'], ['firstname', 'firstName'], ['mobilenumber', 'mobile'], ['emailaddress', 'email']]) {
    const field = one(native);
    if (!field || field.readOnly || field.disabled || (initial ? field.value !== '' : field.value !== fields[key] || field.submit?.[native] !== fields[key] || field.valid !== true)) return false;
  }
  return initial || form.required.every(field => field.valid === true);
}

// Preparation and creation share staging; only the latter supplies a save operation.
async function stageProfile(page, state, fields, input) {
  const confirmDuplicateName = input.confirmDuplicateName === true;
  const previewDigest = profilePreviewDigest(fields, confirmDuplicateName);
  if (input.expectedPreviewDigest != null && input.expectedPreviewDigest !== previewDigest) {
    return { outcome: 'review_required', issue: 'PROFILE_PREVIEW_CHANGED' };
  }
  const frame = await openNewProfile(page);
  const initial = await profileForm(frame);
  if (!validProfileForm(initial, fields, true)) throw new Error('PROFILE_NEW_DEFAULTS_UNVERIFIED');
  for (const [native, key] of [['lastname', 'lastName'], ['firstname', 'firstName'], ['mobilenumber', 'mobile'], ['emailaddress', 'email']]) {
    if (!fields[key]) continue;
    const control = frame.locator(`input[name="${native}"]:visible`);
    if (await control.count() !== 1) throw new Error('PROFILE_FIELD_UNAVAILABLE');
    await control.fill(fields[key]);
    await control.press('Tab');
  }
  const staged = await profileForm(frame);
  if (state.dialog || state.blocked || !isGuardedPage(page) || !validProfileForm(staged, fields)) {
    throw new Error('PROFILE_STAGING_UNVERIFIED');
  }
  const save = frame.locator('[data-qtip*="Save"]:visible');
  if (await save.count() !== 1 || !await save.isEnabled() || await save.evaluate(element =>
    Boolean(element.closest('.x-item-disabled,.x-btn-disabled,[aria-disabled="true"]')) ||
    globalThis.Ext?.getCmp?.(element.id)?.disabled === true)) throw new Error('PROFILE_SAVE_CONTROL_UNAVAILABLE');
  return { outcome: 'ready', save, fields, previewDigest, confirmDuplicateName,
    requiredFields: staged.required.map(field => field.name) };
}

async function runStaged(input, options, operation) {
  const fields = profileBusinessFields(input);
  if (!fields) return { outcome: 'needs_input', issue: 'GUEST_NAME_AND_MOBILE_REQUIRED' };
  const state = { blocked: false, dialog: false };
  try {
    const result = await withReadSession(async page => {
      const staged = await stageProfile(page, state, fields, input);
      return staged.outcome === 'ready' ? await operation(page, state, staged) : staged;
    }, state, options);
    if (state.write?.dispatched && (state.write.issue || state.write.handlers.size || !state.write.callbackDrained)) {
      return failureEvidence(state.write, 'PROFILE_SAVE_UNCERTAIN');
    }
    return result;
  } catch (error) {
    return state.write?.dispatched ? failureEvidence(state.write, 'PROFILE_SAVE_UNCERTAIN')
      : { outcome: 'unavailable', issue: issue(error) };
  }
}

function failureEvidence(write, error) {
  return { outcome: 'uncertain', issue: error, attemptId: write.attemptId ?? null,
    phase: write.lastPhase ?? null, dispatched: write.dispatched,
    dispatchedPhases: [...write.dispatchedPhases], nativeId: write.response?.nativeId ?? null };
}

async function waitForDispatch(write, timeout = 40000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (write.issue || write.phase === 'failed') throw new Error(write.issue || 'PROFILE_SAVE_FAILED');
    if (write.callbackDrained && ['question', 'finished'].includes(write.phase)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('PROFILE_SAVE_TIMED_OUT');
}

async function findDuplicateYes(page, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    let yes = null;
    for (const view of page.frames()) {
      const windows = view.locator('.x-window:visible').filter({ hasText: 'Profile name already exists. Continue?' });
      const count = await windows.count();
      if (count > 1) throw new Error('PROFILE_DUPLICATE_DIALOG_AMBIGUOUS');
      if (count === 1) {
        const button = windows.first().locator('a.x-btn:visible').filter({ hasText: /^Yes$/ });
        if (yes || await button.count() !== 1 || !await button.isEnabled()) throw new Error('PROFILE_DUPLICATE_DIALOG_AMBIGUOUS');
        yes = button;
      }
    }
    if (yes) return yes;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('PROFILE_DUPLICATE_DIALOG_UNVERIFIED');
}

async function savePreparedProfile(page, state, staged, commit) {
  const { save, fields, previewDigest, confirmDuplicateName } = staged;
  const write = { ...commit, fields, previewDigest, confirmDuplicateName, phase: 'initial', lastPhase: null,
    dispatched: false, dispatchedPhases: [], response: null, issue: null, callbackDrained: false, handlers: new Set() };
  state.write = write;
  try {
    await save.click({ timeout: 10000 });
    await waitForDispatch(write);
    if (write.phase === 'question' && confirmDuplicateName && !state.dialog && !state.blocked) {
      const yes = await findDuplicateYes(page);
      if (state.dialog || state.blocked || write.phase !== 'question') throw new Error('PROFILE_DUPLICATE_DIALOG_UNVERIFIED');
      write.phase = 'confirm';
      write.callbackDrained = false;
      await yes.click({ timeout: 10000 });
      await waitForDispatch(write);
    }
  } catch (error) { write.issue ??= issue(error); }
  finally { write.phase = 'closed'; }
  const evidence = { attemptId: write.attemptId ?? null, phase: write.lastPhase,
    dispatched: write.dispatched, dispatchedPhases: [...write.dispatchedPhases], nativeId: write.response?.nativeId ?? null };
  if (!write.dispatched) return { outcome: 'not_dispatched', issue: write.issue || 'PROFILE_SAVE_NOT_DISPATCHED', ...evidence };
  if (!state.dialog && !state.blocked && !write.issue && write.callbackDrained && write.response?.question && !confirmDuplicateName) {
    return { outcome: 'confirmation_required', issue: 'PROFILE_NAME_ALREADY_EXISTS', ...evidence };
  }
  if (state.dialog || state.blocked || write.issue || !write.callbackDrained || !write.response?.success || !write.response.nativeId) {
    return failureEvidence(write, write.issue || 'PROFILE_SAVE_UNVERIFIED');
  }
  return { outcome: 'awaiting_readback', ...evidence, businessFields: fields };
}

/** Stage a new profile without saving. Use the existing guest lookup separately. */
export async function prepareGuestProfile(input, options = {}) {
  return runStaged(input, options, async (_page, _state, staged) => ({
    outcome: 'ready', businessFields: staged.fields, previewDigest: staged.previewDigest,
    native: { profileId: null, requiredFields: staged.requiredFields, saveAvailable: true },
    saveContract: { status: 'authorized_caller_required' },
  }));
}

/** Trusted callbacks authorize and durably record both dispatch and response. */
export async function createGuestProfile(input, { authorizeCandidate, dispatchCandidate, recordResponse, attemptId, ...options } = {}) {
  if (!/^[a-f0-9]{64}$/.test(input?.expectedPreviewDigest || '') ||
      typeof authorizeCandidate !== 'function' || typeof dispatchCandidate !== 'function' || typeof recordResponse !== 'function') {
    return { outcome: 'not_dispatched', issue: 'PROFILE_AUTHORIZATION_REQUIRED', attemptId: attemptId ?? null, dispatched: false };
  }
  const result = await runStaged(input, options, (page, state, staged) =>
    savePreparedProfile(page, state, staged, { authorizeCandidate, dispatchCandidate, recordResponse, attemptId }));
  if (result.outcome !== 'awaiting_readback') return result;
  let readback;
  try { readback = await readGuestProfile({ nativeId: result.nativeId }, options); }
  catch { readback = null; }
  const fields = result.businessFields;
  if (!matchesProfileReadback(readback, fields, result.nativeId)) {
    return { outcome: 'uncertain', issue: 'PROFILE_READBACK_UNVERIFIED', attemptId: result.attemptId,
      phase: result.phase, dispatched: true, dispatchedPhases: result.dispatchedPhases, nativeId: result.nativeId };
  }
  return { outcome: 'created', attemptId: result.attemptId, phase: result.phase,
    dispatched: true, dispatchedPhases: result.dispatchedPhases, nativeId: result.nativeId, readback };
}

// Unknown consent never counts as off.
export function matchesProfileReadback(readback, fields, expectedNativeId) {
  return readback?.outcome === 'read' && readback.firstName === fields.firstName && readback.lastName === fields.lastName &&
    readback.mobile === fields.mobile && readback.email === fields.email && readback.status === 'ACTIVE' &&
    (expectedNativeId === undefined || readback.nativeId === expectedNativeId) &&
    Array.isArray(readback.consent) && readback.consent.length === 4 && readback.consent.every(value => value === false);
}

function profileReadInput(input) {
  const nativeId = clean(input?.nativeId);
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['nativeId', 'propertyCode'].includes(key)) ||
      (input.propertyCode != null && input.propertyCode !== PROPERTY) || !/^\d+$/.test(nativeId)) return null;
  return nativeId;
}

async function profileFieldMetadata(frame) {
  return frame.evaluate(() => (globalThis.Ext?.ComponentQuery?.query('uxform[tabName=HDR] [isFormField]') || [])
    .map(field => ({ name: field.getName?.() || field.name || '',
      label: String(field.fieldLabel || '').replace(/<[^>]+>/g, '').trim(),
      kind: field.getXType?.() || null, visibleWhenDiscovered: field.isVisible?.(true) ?? null }))
    .filter(field => field.name));
}

function profileFieldObservation(field, values) {
  if (/(?:password|credential|secret|token)/i.test(`${field.name} ${field.label}`)) {
    return { ...field, state: 'redacted', value: null, displayValue: null, rawValue: null };
  }
  const observed = Object.hasOwn(values, field.name);
  const rawValue = observed ? values[field.name] : null;
  const selected = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) && Object.hasOwn(rawValue, 'selected');
  const value = selected ? rawValue.selected : rawValue;
  let state = 'unknown';
  if (!observed) state = 'unread';
  else if (field.kind === 'checkboxfield') {
    if ([true, 1, '1', 'true'].includes(value)) state = 'true';
    else if ([false, 0, '0', 'false'].includes(value)) state = 'false';
  } else if (value === null || value === '') state = 'blank';
  else if (typeof value === 'string') state = /^(?:\*{3,}|•{3,})/.test(value.trim()) ? 'masked' : value.trim() ? 'present' : 'blank';
  else if (typeof value === 'number' || typeof value === 'boolean') state = 'present';
  const choices = selected && Array.isArray(rawValue.option) ? rawValue.option.filter(option =>
    option?.value === value && typeof option.display === 'string') : [];
  const displayValue = choices.length === 1 ? choices[0].display : null;
  return { ...field, state, value, displayValue, rawValue };
}

async function readProfileMaster(page, frame, nativeId, state, metadata) {
  state.masterId = nativeId;
  const body = new URLSearchParams({ SYSTEM_FUNCTION_NAME: 'FSGSPF', USER_FUNCTION_NAME: 'FSGSPF',
    CURRENT_TAB_NAME: 'HDR', profileid: nativeId, guestfullname: '', externalid: '', account: '',
    ONLY_DATA_REQUIRED: 'true', SCROLLROW: 'YES' }).toString();
  const response = await frame.evaluate(async data => {
    const requestToken = globalThis.EAM?.AppData?.generateRequestToken?.();
    if (typeof requestToken !== 'string' || !requestToken) throw new Error('PROFILE_MASTER_CONTEXT_UNVERIFIED');
    const result = await fetch('/web/base/FSGSPF.HDR', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
        'Request-Type': 'XMLHTTP', 'Request-Source': 'XMLHTTP', requestToken }, body: data,
      signal: AbortSignal.timeout(30_000) });
    return { status: result.status, text: await result.text() };
  }, body);
  if (state.blocked || state.dialog || !isGuardedPage(page) || response.status !== 200) throw new Error('PROFILE_MASTER_READ_UNAVAILABLE');
  const json = response.text.replace(/("(?:\\.|[^"\\])*")|([,{]\s*)([A-Za-z_$][\w$]*)\s*:/g,
    (match, quoted, prefix, key) => quoted || `${prefix}"${key}":`);
  const payload = JSON.parse(json), values = payload?.pageData?.values;
  if (payload?.success === false || payload?.pageData?.success === false || !values || typeof values !== 'object' ||
      Array.isArray(values) || String(values.profileid ?? '').trim() !== nativeId) {
    throw new Error('PROFILE_MASTER_READ_UNVERIFIED');
  }
  const status = typeof values.profilestatuscode === 'string' ? clean(values.profilestatuscode)
    : typeof values.profilestatuscode?.selected === 'string' ? clean(values.profilestatuscode.selected) : null;
  const textValue = name => typeof values[name] === 'string' ? values[name] : null;
  // A missing email is unknown, while an explicitly observed native null is blank.
  // Creation's strict validator must not accept a missing field as its blank email.
  const email = Object.hasOwn(values, 'emailaddress') && values.emailaddress === null ? '' : textValue('emailaddress');
  const fields = metadata.map(field => profileFieldObservation(field, values));
  const consent = [1, 2, 3, 4].map(index => {
    const value = values[`guestoptin${index}`];
    if ([false, 0, '0', 'false'].includes(value)) return false;
    if ([true, 1, '1', 'true'].includes(value)) return true;
    return null;
  });
  return { outcome: 'read', nativeId, propertyCode: PROPERTY, observedAt: new Date().toISOString(),
    firstName: textValue('firstname'), lastName: textValue('lastname'), mobile: textValue('mobilenumber'),
    email, status, consent,
    consentCoverage: consent.every(value => value !== null) ? 'complete' : 'incomplete', fields,
    coverage: { scope: 'native_master_values_for_discovered_header_form_fields',
      metadataSource: 'instantiated_profile_header_form', discoveredFields: metadata.length,
      missingSummaryFields: ['firstname', 'lastname', 'mobilenumber', 'emailaddress', 'profilestatuscode']
        .filter(name => !Object.hasOwn(values, name)),
      unreadFields: fields.filter(field => field.state === 'unread').map(field => field.name),
      unknownFields: fields.filter(field => field.state === 'unknown').map(field => field.name),
      unmappedNativeValueNames: Object.keys(values).filter(name => !metadata.some(field => field.name === name)) },
    evidence: 'exact_id_master_read_only_not_dispatch_attribution' };
}

/** Read multiple exact IDs sequentially on one read-only session. No identity lookup. */
export async function readGuestProfiles(inputs, { onResult, ...options } = {}) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.some(input => !profileReadInput(input)) ||
      new Set(inputs.map(profileReadInput)).size !== inputs.length ||
      (onResult !== undefined && typeof onResult !== 'function')) {
    return { outcome: 'input_gap', issue: 'UNIQUE_PROFILE_IDS_REQUIRED', profiles: [] };
  }
  const nativeIds = inputs.map(profileReadInput);
  const state = { blocked: false, masterId: null }, profiles = [];
  try {
    await withReadSession(async page => {
      const frame = await openProfileFrame(page), metadata = await profileFieldMetadata(frame);
      if (!metadata.length) throw new Error('PROFILE_FORM_METADATA_UNAVAILABLE');
      for (const nativeId of nativeIds) {
        options.signal?.throwIfAborted();
        const result = await readProfileMaster(page, frame, nativeId, state, metadata);
        profiles.push(result);
        // Checkpoints are provisional until the session guard and shutdown pass.
        await onResult?.(structuredClone(result));
      }
    }, state, options);
    return { outcome: 'read', profiles, sessionVerified: true };
  } catch (error) { return { outcome: 'unavailable', issue: issue(error), profiles, sessionVerified: false }; }
}

/** Fresh exact-ID master read. This is not evidence that any dispatch created the ID. */
export async function readGuestProfile(input, options = {}) {
  if (!profileReadInput(input)) return { outcome: 'input_gap', issue: 'PROFILE_ID_REQUIRED' };
  const result = await readGuestProfiles([input], options);
  return result.outcome === 'read' ? result.profiles[0] : { outcome: 'unavailable', issue: result.issue };
}

// Internal behavioral checks, not HMS operations.
export const profileCreateTestHooks = Object.freeze({ profileSaveMatches, profileCreateReadMayRequest, handleProfileSave,
  waitForDispatch, savePreparedProfile, guardedSession });
