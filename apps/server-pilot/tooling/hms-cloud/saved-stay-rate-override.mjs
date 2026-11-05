// Saved-stay, single inclusive night only. Wizard Submit writes immediately;
// its pre-Submit grid and totals still describe the saved stay, not the override.
import { createHash } from 'node:crypto';
import { cleanLabtestRecord, snapshotLabtestRecord } from './labtest-record.mjs';
import { nativeMoneyCents, nativePriceDigest, readSavedStayNightlyRates } from './saved-stay-nightly-rates.mjs';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { installPageRequestFence } from './page-request-fence.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const OPEN_PATH = '/web/base/OSSTWZ';
const INSTRUCTION_PATH = '/web/base/OSSTWZ.RateInstructionChange';
const UPDATE_PATH = '/web/base/OSSTWZ.UpdateStayWizard';
const preparedStages = new WeakMap();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isDigits = (s) => typeof s === 'string' && /^\d{1,100}$/.test(s);
const wireDate = (date) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
const dateTime = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
};

function checkedRates(rates, target) {
  if (!rates || rates.version !== 1 || rates.propertyCode !== 'HRCEN' ||
      rates.nativeStayId !== target.nativeStayId || !/^[A-Z]{3}$/.test(rates.currency || '') ||
      !Array.isArray(rates.nightly) || !rates.totals || typeof rates.digest !== 'string') return false;
  const { digest, ...body } = rates;
  const start = dateTime(target.arrival), end = dateTime(target.departure);
  if (start === null || end === null || end <= start || (end - start) / 86400000 !== rates.nightly.length ||
      rates.nightly.some((row, index) => dateTime(row?.date) !== start + index * 86400000) ||
      nativePriceDigest(body) !== digest) return false;
  const cents = (value) => typeof value === 'string' && /^(?:0|[1-9]\d{0,13})$/.test(value);
  if (!rates.nightly.every((row) => row && cents(row.chargeCents) && cents(row.totalChargeCents) &&
      typeof row.roomTypeName === 'string' && !!row.roomTypeName &&
      typeof row.ratePlanName === 'string' && !!row.ratePlanName)) return false;
  const { subtotalCents, taxCents, feeCents, totalCents } = rates.totals;
  if (![subtotalCents, taxCents, feeCents, totalCents].every(cents)) return false;
  return rates.nightly.reduce((sum, row) => sum + BigInt(row.totalChargeCents), 0n) === BigInt(subtotalCents) &&
    BigInt(subtotalCents) + BigInt(taxCents) + BigInt(feeCents) === BigInt(totalCents);
}

/** Current saved rates are authoritative for the preimage only; no proposed total is known. */
export function reviewSavedStayRateOverride(target, change, rates) {
  const start = dateTime(target?.arrival), end = dateTime(target?.departure), night = dateTime(change?.startDate);
  if (target?.propertyCode !== 'HRCEN' || !/^\d+-\d+$/.test(target.confirmation || '') ||
      !isDigits(target.guestId) || !isDigits(target.nativeStayId) || start === null || end === null ||
      ![target.firstName, target.lastName].every(name => typeof name === 'string' && name.trim() &&
        name === name.trim() && name.length <= 256 && !/\p{Cc}/u.test(name)) ||
      night === null || night < start || night >= end || change?.startDate !== change?.endDate ||
      typeof change.amountCents !== 'string' || !/^[1-9]\d{0,13}$/.test(change.amountCents) ||
      !/^[A-Z0-9]{1,20}$/.test(change.reason || '') || !checkedRates(rates, target) ||
      change.currency !== rates.currency) throw new Error('RATE_OVERRIDE_REVIEW_INVALID');
  if (rates.nightly.find(row => row.date === change.startDate)?.chargeCents === change.amountCents) {
    throw new Error('RATE_OVERRIDE_AMOUNT_UNCHANGED');
  }
  const reviewed = {
    target: { propertyCode: 'HRCEN', confirmation: target.confirmation, guestId: target.guestId,
      nativeStayId: target.nativeStayId, firstName: target.firstName, lastName: target.lastName,
      arrival: target.arrival, departure: target.departure },
    change: { startDate: change.startDate, endDate: change.endDate, amountCents: change.amountCents,
      currency: change.currency, reason: change.reason },
    savedRates: structuredClone(rates), proposedTotals: null,
  };
  return { ...reviewed, digest: nativePriceDigest(reviewed) };
}

function validReview(review) {
  try {
    if (!review || typeof review !== 'object') return false;
    const checked = reviewSavedStayRateOverride(review.target, review.change, review.savedRates);
    return nativePriceDigest(checked) === nativePriceDigest(review);
  } catch { return false; }
}

export const isSavedStayRateOverrideReview = (review) => validReview(review);

/** Caller must first bind state with the exact fresh saved-record reader. */
export async function readSavedStayRateOverrideBaseline(page, state, target, change) {
  if (!state?.frame || !target || dateTime(target.arrival) === null || dateTime(target.departure) === null) {
    throw new Error('RATE_OVERRIDE_TARGET_UNVERIFIED:input');
  }
  const before = await snapshotLabtestRecord(state?.frame), data = before?.data;
  if (!cleanLabtestRecord(before) || !data) throw new Error('RATE_OVERRIDE_TARGET_UNVERIFIED:clean_record');
  const expected = { propertycode: 'HRCEN', status: 'Reserved', confirmationnumber: target.confirmation,
    guestid: target.guestId, reservationstayid: target.nativeStayId, firstname: target.firstName,
    lastname: target.lastName, arrivaldate: wireDate(target.arrival), departuredate: wireDate(target.departure) };
  for (const [field, value] of Object.entries(expected)) {
    if (value === undefined || !Object.hasOwn(data, field) ||
        Object.keys(data).filter(key => key.toLowerCase() === field).length !== 1 || String(data[field]) !== value) {
      throw new Error(`RATE_OVERRIDE_TARGET_UNVERIFIED:${field}`);
    }
  }
  const rates = await readSavedStayNightlyRates(page, state, target);
  if (!same(before, await snapshotLabtestRecord(state.frame))) throw new Error('RATE_OVERRIDE_TARGET_CHANGED');
  return reviewSavedStayRateOverride(target, change, rates);
}

function requestFields(request, frame, path) {
  try {
    const url = new URL(request.url());
    if (request.frame() !== frame || request.method() !== 'POST' || url.origin !== ORIGIN ||
        url.pathname !== path || url.search || url.hash || url.username || url.password ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '')) return null;
    const body = new Map();
    for (const [key, value] of new URLSearchParams(request.postData() || '')) {
      const name = key.toLowerCase(), values = body.get(name) || [];
      values.push(value); body.set(name, values);
    }
    return name => body.get(name)?.length === 1 ? body.get(name)[0] : null;
  } catch { return null; }
}

async function readWizard(frame) {
  return frame.evaluate(() => {
    const windows = globalThis.Ext?.ComponentQuery?.query('window').filter(w => w.isVisible?.()) || [];
    if (windows.length !== 1 || !/Stay Wizard/i.test(String(windows[0].title || ''))) return null;
    const form = windows[0].down('form');
    if (!form?.getFldValues) return null;
    const fields = form.getFldValues(['propertycode','reservationstayid','pmsconfirmationnumber','guestid',
      'startdate','enddate','availabilityinstr','rateinstr','rateamount','ratecurr','ratereason',
      'room','roomtype','rateplan','ratepkgcharges','taxes','fees','total',
      'userrateoverrideneeded','userrateoverridemsg','openfieldlevelsecauthpopup']);
    for (const name of ['startdate','enddate']) {
      const date = fields[name];
      if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
      fields[name] = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    }
    return fields;
  });
}

const unrequestedAuthorization = fields => ['userrateoverrideneeded','userrateoverridemsg','openfieldlevelsecauthpopup']
  .every(key => Object.hasOwn(fields || {}, key) && fields[key] === '');
function matchesWizard(fields, review) {
  const { target, change } = review;
  return fields && fields.propertycode === target.propertyCode && String(fields.reservationstayid) === target.nativeStayId &&
    fields.pmsconfirmationnumber === target.confirmation && String(fields.guestid) === target.guestId &&
    fields.startdate === change.startDate && fields.enddate === change.endDate && fields.availabilityinstr === 'AVAIL' &&
    fields.rateinstr === 'OVER' && fields.ratecurr === change.currency && fields.ratereason === change.reason &&
    nativeMoneyCents(fields.rateamount) === change.amountCents &&
    ['room','roomtype','rateplan'].every(key => fields[key] === '') && unrequestedAuthorization(fields);
}

async function openWizardOptions(frame, popup, name) {
  const input = popup.locator(`input[name=${name}]:visible`);
  if (await input.count() !== 1) throw new Error(`RATE_OVERRIDE_CONTROL_UNVERIFIED:${name}`);
  const option = await input.evaluate(el => {
    const field = globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
    const triggers = [...(field?.getEl?.()?.dom?.querySelectorAll('.x-form-trigger') || [])]
      .filter(el => (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden');
    return triggers.length === 1 ? triggers[0].id : null;
  });
  if (!option) throw new Error(`RATE_OVERRIDE_OPTION_UNVERIFIED:${name}`);
  await frame.locator(`[id=${JSON.stringify(option)}]`).click({timeout:5000});
  await frame.waitForFunction(({ id }) => {
    const field = globalThis.Ext?.getCmp?.(id.replace(/-inputEl$/, ''));
    const store = field?.getStore?.();
    const rows = store?.getRange?.();
    const loaded = (typeof store?.isLoaded === 'function' && store.isLoaded() === true) || store?.loaded === true ||
      store?.loadCount > 0 || (Array.isArray(rows) && rows.length > 0);
    return loaded && store?.isLoading?.() !== true && store?.loading !== true;
  }, { id: await input.getAttribute('id') }, { timeout: 10000 });
  return input;
}

async function chooseWizardValue(frame, popup, name, value) {
  const input = await openWizardOptions(frame, popup, name);
  const label = await input.evaluate((el, value) => {
    const field = globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
    const rows = field?.getStore?.()?.getRange?.().filter(row => String(row.get(field.valueField)) === value) || [];
    return rows.length === 1 ? String(rows[0].get(field.displayField)) : null;
  }, value);
  if (!label) throw new Error(`RATE_OVERRIDE_OPTION_UNVERIFIED:${name}`);
  const choices = frame.locator('.x-boundlist:visible .x-boundlist-item');
  const labels = await choices.allTextContents(), matching = labels.map((text, index) => text.trim() === label.trim() ? index : -1).filter(index => index >= 0);
  if (matching.length !== 1) throw new Error(`RATE_OVERRIDE_OPTION_UNVERIFIED:${name}`);
  await choices.nth(matching[0]).click({timeout:5000});
}

// Both discovery and staging pass through the same request fence. Submit is
// blocked throughout this helper, including while the dropdown is loading.
async function withRateOverrideWizard(page, state, target, change, operation, expectedSnapshot = null) {
  const frame = state?.frame, context = page.context();
  const fence = await installPageRequestFence(page, [OPEN_PATH, INSTRUCTION_PATH, UPDATE_PATH]);
  await installReadOnlyGuard(context);
  if (!frame) throw new Error('RATE_OVERRIDE_TARGET_UNVERIFIED:frame');
  const before = await snapshotLabtestRecord(frame);
  if (!cleanLabtestRecord(before)) throw new Error('RATE_OVERRIDE_TARGET_UNVERIFIED:clean_record');
  if (expectedSnapshot && !same(before, expectedSnapshot)) throw new Error('RATE_OVERRIDE_TARGET_CHANGED');
  const scope = fence.open(), candidates = new WeakSet();
  let active = true, armed = null;
  const contextRoute = async route => {
    const request = route.request();
    if (!candidates.delete(request)) return route.fallback();
    if (!active || fence.isQuarantined() || !requestFields(request, frame, new URL(request.url()).pathname)) return route.abort();
    // Only the two matched read/stage requests may cross the strict saved-record read guard.
    return route.continue();
  };
  const pageRoute = async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (![OPEN_PATH, INSTRUCTION_PATH, UPDATE_PATH].some(p => p.toLowerCase() === path.toLowerCase())) return route.fallback();
    const field = requestFields(request, frame, path);
    const expected = { system_function_name:'OSSTWZ',user_function_name:'OSSTWZ',propertycode:'HRCEN',
      reservationstayid:target.nativeStayId,pmsconfirmationnumber:target.confirmation,guestid:target.guestId,
      ...(path === INSTRUCTION_PATH ? { startdate:wireDate(change.startDate),enddate:wireDate(change.endDate),
        availabilityinstr:'AVAIL',rateinstr:'OVER',ratecurr:change.currency,room:'',roomtype:'',rateplan:'',
        rateamount:'',ratereason:'',userrateoverrideneeded:'',userrateoverridemsg:'',openfieldlevelsecauthpopup:'' } : {}) };
    if (!active || path === UPDATE_PATH || path !== armed || !field ||
        !Object.entries(expected).every(([key,value]) => field(key) === value)) {
      fence.quarantine(); return route.abort();
    }
    armed = null; candidates.add(request);
    return scope.allow(request) ? route.fallback() : route.abort();
  };
  try {
    await context.route('**/*', contextRoute); await page.route('**/*', pageRoute);
    const unchanged = async () => {
      if (fence.isQuarantined() || !same(before, await snapshotLabtestRecord(frame))) throw new Error('RATE_OVERRIDE_TARGET_CHANGED');
    };
    await unchanged();
    const button = frame.locator('[data-qtip="Stay Wizard"]:visible');
    if (await button.count() !== 1 || await frame.locator('.x-window:visible:not(.x-menu)').count()) throw new Error('RATE_OVERRIDE_CONTROL_UNVERIFIED:wizard');
    const opened = page.waitForResponse(r => r.request().frame() === frame && new URL(r.url()).pathname === OPEN_PATH, {timeout:20000});
    void opened.catch(() => {}); armed = OPEN_PATH;
    await button.click({timeout:5000,noWaitAfter:true});
    if ((await opened).status() !== 200) throw new Error('RATE_OVERRIDE_OPEN_FAILED');
    const popup = frame.locator('.x-window:visible:not(.x-menu)').filter({hasText:/Stay Wizard/});
    await popup.waitFor({state:'visible',timeout:10000});
    const initial = await readWizard(frame);
    if (!initial || initial.rateinstr !== 'REQUOT' || !unrequestedAuthorization(initial)) throw new Error('RATE_OVERRIDE_AUTHORIZATION_UNVERIFIED');
    const datesSet = await frame.evaluate(({startDate,endDate}) => {
      const windows = globalThis.Ext.ComponentQuery.query('window').filter(w => w.isVisible?.() && /Stay Wizard/i.test(String(w.title || '')));
      const form = windows.length === 1 ? windows[0].down('form') : null;
      if (!form?.setFldValue) return false;
      const local = date => { const [year,month,day] = date.split('-').map(Number); return new Date(year,month-1,day); };
      form.setFldValue('startdate',local(startDate)); form.setFldValue('enddate',local(endDate)); return true;
    }, change);
    if (!datesSet) throw new Error('RATE_OVERRIDE_DATES_UNVERIFIED');
    await unchanged(); armed = INSTRUCTION_PATH;
    const instruction = page.waitForResponse(r => r.request().frame() === frame && new URL(r.url()).pathname === INSTRUCTION_PATH, {timeout:15000});
    void instruction.catch(() => {});
    await chooseWizardValue(frame,popup,'rateinstr','OVER');
    if ((await instruction).status() !== 200) throw new Error('RATE_OVERRIDE_INSTRUCTION_FAILED');
    return await operation({ frame, popup, unchanged });
  } catch (error) { fence.quarantine(); throw error; }
  finally {
    active = false; scope.close();
    await page.unroute('**/*',pageRoute); await context.unroute('**/*',contextRoute);
  }
}

/** Read current native reason codes without permitting a wizard Submit. */
export async function listSavedStayRateOverrideReasons(page, state, target) {
  const rates = await readSavedStayNightlyRates(page, state, target);
  const change = { startDate: target.arrival, endDate: target.arrival, currency: rates.currency };
  return withRateOverrideWizard(page, state, target, change, async ({ frame, popup, unchanged }) => {
    const input = await openWizardOptions(frame, popup, 'ratereason');
    const options = await input.evaluate(el => {
      const field = globalThis.Ext?.getCmp?.(el.id.replace(/-inputEl$/, ''));
      const store = field?.getStore?.(), rows = store?.getRange?.();
      if (!Array.isArray(rows) || !field?.valueField || !field?.displayField ||
          store?.isLoading?.() === true || store?.loading === true) return null;
      return rows.map(row => ({ code: String(row.get(field.valueField) ?? ''),
        description: String(row.get(field.displayField) ?? '') }));
    });
    if (!options || options.some(option => !option.code || !option.description) ||
        new Set(options.map(option => option.code)).size !== options.length) {
      throw new Error('RATE_OVERRIDE_REASONS_UNVERIFIED');
    }
    await unchanged();
    return { options, coverage: { loaded: options.length, total: null, complete: null },
      observedAt: new Date().toISOString() };
  });
}

/** Stage only. Caller owns the browser, staff approval, native Submit and uncertain-write reconciliation. */
export async function prepareSavedStayRateOverride(page, state, target, change, { reviewed = null } = {}) {
  target = structuredClone(target); change = structuredClone(change);
  const before = await snapshotLabtestRecord(state?.frame);
  const review = await readSavedStayRateOverrideBaseline(page, state, target, change);
  if (reviewed && (!validReview(reviewed) || reviewed.digest !== review.digest)) throw new Error('RATE_OVERRIDE_REVIEW_CHANGED');
  return withRateOverrideWizard(page, state, target, change, async ({ frame, popup, unchanged }) => {
    const amount = popup.locator('input[name=rateamount]:visible');
    if (await amount.count() !== 1 || !await amount.isEditable()) throw new Error('RATE_OVERRIDE_AMOUNT_UNAVAILABLE');
    const cents = BigInt(change.amountCents);
    await amount.fill(`${cents/100n}.${String(cents%100n).padStart(2,'0')}`); await amount.press('Tab');
    await chooseWizardValue(frame,popup,'ratereason',change.reason);
    const fields = await readWizard(frame);
    if (!matchesWizard(fields,review)) throw new Error('RATE_OVERRIDE_DRAFT_UNVERIFIED');
    await unchanged();
    const savedTotalsMatch = [['ratepkgcharges','subtotalCents'],['taxes','taxCents'],['fees','feeCents'],['total','totalCents']]
      .every(([field,total]) => nativeMoneyCents(fields[field]) === review.savedRates.totals[total]);
    const stage = { status:'STAGED_UNSAVED', frame, review,
      nativePreview:{fields,proposedTotals:null,totalsSource:savedTotalsMatch ? 'saved_stay' : 'unverified_pre_submit'},
      commitBoundary:{path:UPDATE_PATH,action:'Submit',writesSavedStay:true},
      pausedGate:createPausedRateOverrideGate({frame,review}),
      async revalidate() { await unchanged(); if (!matchesWizard(await readWizard(frame),review)) throw new Error('RATE_OVERRIDE_STAGE_CHANGED'); } };
    preparedStages.set(stage, { frame, digest: nativePriceDigest(review), revalidate: stage.revalidate });
    return stage;
  }, before);
}

/** Reject fabricated stages and mutations of a previously reviewed stage. */
export function isPreparedSavedStayRateOverride(stage, frame) {
  const proof = preparedStages.get(stage);
  return !!proof && stage.frame === frame && proof.frame === frame && stage.revalidate === proof.revalidate &&
    validReview(stage.review) && nativePriceDigest(stage.review) === proof.digest;
}

/** A fresh browser/state is required; price or target drift rejects the reviewed override before staging. */
export async function restageSavedStayRateOverride(page, state, review) {
  if (!validReview(review)) throw new Error('RATE_OVERRIDE_REVIEW_INVALID');
  return prepareSavedStayRateOverride(page,state,review.target,review.change,{reviewed:review});
}

/** Match business fields only; additional native fields and grid rows may drift. */
export function matchesSavedStayRateOverrideRequest(request, frame, review) {
  try {
    if (!validReview(review) || !frame || request.frame() !== frame || request.method() !== 'POST') return false;
    const url = new URL(request.url());
    if (url.origin !== ORIGIN || url.pathname !== UPDATE_PATH || url.search || url.hash || url.username || url.password ||
        !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] || '')) return false;
    const body = new URLSearchParams(request.postData() || ''), byName = new Map();
    for (const [key, value] of body) {
      const name = key.toLowerCase();
      const values = byName.get(name) || []; values.push(value); byName.set(name, values);
    }
    const one = (name) => { const values = byName.get(name); return values?.length === 1 ? values[0] : null; };
    const { target, change } = review;
    const expected = { propertycode: 'HRCEN', reservationstayid: target.nativeStayId,
      pmsconfirmationnumber: target.confirmation, guestid: target.guestId,
      startdate: wireDate(change.startDate), enddate: wireDate(change.endDate), availabilityinstr: 'AVAIL',
      rateinstr: 'OVER', ratecurr: change.currency, ratereason: change.reason,
      room: '', roomtype: '', rateplan: '', user_function_name: 'OSSTWZ', system_function_name: 'OSSTWZ',
      userrateoverrideneeded: '', userrateoverridemsg: '', openfieldlevelsecauthpopup: '' };
    if (!Object.entries(expected).every(([key, value]) => one(key) === value) ||
        nativeMoneyCents(one('rateamount')) !== change.amountCents) return false;
    // Do not silently approve native confirmation prompts on a later request.
    return [...byName].every(([key, values]) => !/^confirm(?!ation)/i.test(key) ||
      (values.length === 1 && ['', 'prompt'].includes(values[0].toLowerCase())));
  } catch { return false; }
}

/**
 * Called inside an already paused Playwright route. This only inspects once;
 * it never continues or authorizes the request. The ledger owner must keep
 * the lifetime fence, revalidate the form, and handle prompts and uncertainty.
 */
export function createPausedRateOverrideGate({ frame, review } = {}) {
  if (!frame || !validReview(review)) throw new Error('RATE_OVERRIDE_GATE_INVALID');
  const bound = structuredClone(review);
  let active = true;
  return Object.freeze({
    inspect(request) {
      if (!active) return null;
      active = false;
      if (!matchesSavedStayRateOverrideRequest(request, frame, bound)) return null;
      return Object.freeze({ state: 'PAUSED', reviewDigest: bound.digest,
        requestDigest: createHash('sha256').update(request.postData() || '').digest('hex') });
    },
    close() { active = false; },
  });
}

/** Compare native dated values only; proof of dispatch and other fields remains separate. */
export function compareSavedStayRateOverrideReadback(review, fresh) {
  try {
    if (!validReview(review) || !checkedRates(fresh, review.target) || fresh.currency !== review.change.currency) {
      return { nightly: 'UNKNOWN', reason: 'READBACK_UNVERIFIED' };
    }
    const oldRows = review.savedRates.nightly, rows = fresh.nightly;
    const index = oldRows.findIndex((row) => row.date === review.change.startDate);
    if (index < 0 || oldRows[index].chargeCents === review.change.amountCents ||
        rows[index].chargeCents !== review.change.amountCents ||
        rows[index].totalChargeCents !== review.change.amountCents ||
        rows[index].roomTypeName !== oldRows[index].roomTypeName || rows[index].ratePlanName !== oldRows[index].ratePlanName ||
        rows.some((row, i) => i !== index && !same(row, oldRows[i]))) {
      return { nightly: 'UNKNOWN', reason: 'NIGHTLY_VALUES_UNVERIFIED' };
    }
    return { nightly: 'MATCHED', nativeTotals: structuredClone(fresh.totals),
      dispatch: 'UNKNOWN', reasonReadback: 'UNKNOWN', otherStayFields: 'UNKNOWN' };
  } catch { return { nightly: 'UNKNOWN', reason: 'READBACK_UNVERIFIED' }; }
}
