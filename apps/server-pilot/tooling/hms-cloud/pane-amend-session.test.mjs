import test from 'node:test';
import assert from 'node:assert/strict';
import { blankSavedPartyFields } from './labtest-party-fields.mjs';
import { runLabtestAmendSave } from './labtest-amend-save.mjs';
import { expectedLabtestAmendRecord, matchesCloudPaneAmendSave, prepareCloudPaneAmend, readCloudPaneAmend,
  cloudPaneAmendRunOptions, commitCloudPaneAmend, normalizeAmendDraftAfterAvailability, validAdultAmendDraft,
  confirmedCloudAmendResult, bindCloudAmendWriter } from './pane-amend-session.mjs';
import { oneNightRetainPrices } from './labtest-amend-retain-proof.mjs';

function fixture() {
  const selected = { source:'record_view_ext_model', propertyCode:'HRCEN', confirmation:'12345678-1',
    reservationStayId:'30', reservationId:'20', recordId:'40', guestId:'123', status:'Reserved',
    firstName:'Proof', lastName:'Labtest', arrival:'2027-10-12', departure:'2027-10-13',
    roomType:'STQN', ratePlan:'BAR', adults:1, children:1, childAges:[8] };
  const native = { PKID:'10', bookingsessionid:'100', reservationid:'20', reservationstayid:'30', recordid:'40' };
  const parties = Object.fromEntries(blankSavedPartyFields.map((name) => [name, '']));
  const data = { ...parties, ...native, propertycode:'HRCEN', status:'Reserved', firstname:'Proof', lastname:'Labtest',
    confirmationnumber:selected.confirmation, guestid:selected.guestId, arrivaldate:'10/12/2027', departuredate:'10/13/2027',
    roomtype:'STQN', rateplan:'BAR', reservationnote:'', adults:'1', children:'1', child1:'0', child2:'1', child3:'0',
    childages:'8', guaranteetype:'NGI', udfchkbox04:'0', udfchar13:'', emailaddress:'',
    sessionID:{sessionID:'abc'}, extId:'11', unrelated:'unchanged' };
  const values = { confirmationnumber:selected.confirmation, guestid:selected.guestId, status:'Reserved',
    firstname:'Proof', lastname:'Labtest', arrivaldate:'12-OCT-2027', departuredate:'13-OCT-2027',
    roomtype:'STQN', rateplan:'BAR', reservationnote:'', guaranteetype:'NGI', udfchar13:'', emailaddress:'',
    adults:'1', children:'1', child1:'0', child2:'1', child3:'0', childages:'8' };
  const baseline = { data, values, partyControls:[], partyInputsBlank:true, formDirty:false,
    recordDirty:false, dirtyFields:[], modifiedFields:[] };
  const state = { frame:{}, native, partyPreimage:parties };
  const record = { nativePreimage:{ ...selected, guaranteeCode:'NGI' },
    details:{ fields:[{ name:'reservationnote', rawValue:'' }] } };
  const input = { selected, confirmation:selected.confirmation, arrival:selected.arrival,
    target:{ propertyCode:'HRCEN', browserSlot:'centurion', origin:'https://hmsweb.hms.eu1.inforcloudsuite.com' },
    changes:{ adults:2, ratePlan:'BAR', retainRates:'yes' } };
  const events = [], context = { _options:{ serviceWorkers:'block' }, serviceWorkers:() => [] };
  const deps = {
    openSession: async (operation, options) => { assert.equal(options.blockServiceWorkers, true);
      await options.prepareContext(context); events.push('login');
      return operation({ context:() => context, screenshot:async () => { events.push('screenshot'); } }); },
    guard: async (target, options) => { assert.equal(target, context);
      assert.equal(options.confirmation, selected.confirmation); events.push('guard'); },
    shallow: async () => { events.push('shallow'); }, read: async () => { events.push('record'); return record; },
    current: async (_page, _expected, options) => {
      assert.deepEqual(options, { allowBlankNote:true });
      return state;
    }, snapshot: async () => baseline,
  };
  return { selected, record, input, baseline, state, context, deps, events };
}

function addPrices(snapshot) {
  for (const key of ['averagenightly', 'averagerate', 'grandtotal', 'totalrate', 'totalratewithtax', 'guesttotal', 'tax', 'guesttax']) {
    snapshot.data[key] = snapshot.values[key] = '100.00';
    snapshot.data[`${key}curr`] = snapshot.values[`${key}curr`] = 'ZAR';
  }
}

test('one-night retain approval binds price evidence and compares it on the independent read', async () => {
  const f = fixture();
  f.input.changes = { adults:2, ratePlan:'BAR', retainRates:'yes' };
  assert.deepEqual(await prepareCloudPaneAmend(f.input, f.deps), { outcome:'refused', issue:'RETAIN_PRICE_UNVERIFIED' });
  addPrices(f.baseline);
  const prepared = await prepareCloudPaneAmend(f.input, f.deps);
  assert.equal(prepared.outcome, 'prepared');
  assert.equal(prepared.approvedPrices.fields.averagenightly.data.cents, '10000');
  f.input.approvedPrices = prepared.approvedPrices;
  f.input.beforeNote = ''; f.input.beforeParties = f.state.partyPreimage; f.input.afterScreenshot = '/private/after.png';
  f.record.nativePreimage.adults = 2;
  f.baseline.data.adults = f.baseline.values.adults = '2';
  const samePrice = await readCloudPaneAmend(f.input, f.deps);
  assert.equal(samePrice.outcome, 'matched');
  assert.equal(samePrice.retainedPriceMatched, true);
  assert.deepEqual(samePrice.observedRetainedPrices, f.input.approvedPrices);
  f.baseline.data.grandtotal = f.baseline.values.grandtotal = '110.00';
  const changedPrice = await readCloudPaneAmend(f.input, f.deps);
  assert.equal(changedPrice.outcome, 'unverified'); // A correct guest and dates cannot hide a price mismatch.
  assert.equal(changedPrice.retainedPriceMatched, false);
});

test('the fenced amend refuses if the approved one-night price changed before staging', async () => {
  const f = fixture();
  f.input.signal = new AbortController().signal;
  f.input.changes = { adults:2, ratePlan:'BAR', retainRates:'yes' };
  addPrices(f.baseline);
  const prepared = await prepareCloudPaneAmend(f.input, f.deps);
  f.input.nativeDigest = prepared.nativeDigest;
  f.input.approvedPrices = prepared.approvedPrices;
  f.input.beforeScreenshot = '/private/before.png';
  f.baseline.data.grandtotal = f.baseline.values.grandtotal = '110.00';
  const expected = expectedLabtestAmendRecord(f.record, f.selected);
  const page = { locator:() => ({ count:async () => 1 }), screenshot:async () => { f.events.push('before'); } };
  const options = cloudPaneAmendRunOptions({ page, input:f.input, expected,
    authorization:{ operationDigest:'a'.repeat(64), authorizeFirst:async () => { f.events.push('claim'); },
      sealBeforeEvidence:async () => { f.events.push('sealed'); } } }, {
    current:async () => f.state, snapshot:async () => f.baseline, bind:() => ({ digest:f.input.nativeDigest }),
  });
  assert.equal(options.signal, f.input.signal);
  assert.equal(options.timeoutMs, 7 * 60_000);
  await assert.rejects(options.prepare(async (promise) => promise), /AMEND_PRICE_CHANGED/);
  assert.equal(f.events.some((event) => ['before', 'sealed', 'claim'].includes(event)), false);
});

test('requires the complete selected native identity, unique raw note and NGI fake stay', () => {
  const f = fixture();
  assert.equal(expectedLabtestAmendRecord(f.record, f.selected)?.guestId, f.selected.guestId);
  for (const edit of [
    (v) => { v.record.nativePreimage.lastName = 'Guest'; },
    (v) => { v.record.nativePreimage.guaranteeCode = 'GTDAGT'; },
    (v) => { v.record.nativePreimage.recordId = 'different'; },
    (v) => { delete v.selected.reservationStayId; },
    (v) => { v.record.nativePreimage.childAges = [9]; },
    (v) => { v.record.details.fields.push({ name:'reservationnote', rawValue:'' }); },
    (v) => { delete v.record.details.fields[0].rawValue; },
  ]) { const v = fixture(); edit(v); assert.equal(expectedLabtestAmendRecord(v.record, v.selected), null); }
});

test('binds the full fresh native state and explicit choice without exposing the model', async () => {
  const f = fixture(); addPrices(f.baseline);
  const first = await prepareCloudPaneAmend(f.input, f.deps);
  assert.deepEqual(f.events, ['guard', 'login', 'shallow', 'record']);
  assert.deepEqual(Object.keys(first).sort(), ['approvedPrices', 'nativeDigest', 'outcome']);
  assert.equal(first.outcome, 'prepared'); assert.match(first.nativeDigest, /^[a-f0-9]{64}$/);
  f.baseline.data.bookingsessionid = f.state.native.bookingsessionid = 'new session';
  f.baseline.data.sessionID = { sessionID:'new session' }; f.baseline.data.extId = 'other';
  assert.deepEqual(await prepareCloudPaneAmend(f.input, f.deps), first);
  f.baseline.data.unrelated = 'different';
  assert.notEqual((await prepareCloudPaneAmend(f.input, f.deps)).nativeDigest, first.nativeDigest);
  f.baseline.data.unrelated = 'unchanged'; f.input.changes.retainRates = 'no';
  assert.equal((await prepareCloudPaneAmend(f.input, f.deps)).outcome, 'refused');
});

test('refuses an unsafe context, wrong target, changed record or send-enabled native form', async () => {
  for (const edit of [
    (v) => { v.context._options.serviceWorkers = 'allow'; },
    (v) => { v.input.target.propertyCode = 'HRDAV'; },
    (v) => { v.record.nativePreimage.confirmation = '87654321-1'; },
    (v) => { v.baseline.data.udfchkbox04 = '1'; },
    (v) => { v.baseline.values.emailaddress = 'recipient@example.invalid'; },
    (v) => { v.baseline.formDirty = true; },
  ]) { const v = fixture(); addPrices(v.baseline); edit(v);
    const result = await prepareCloudPaneAmend(v.input, v.deps);
    assert.equal(result.outcome, 'refused'); assert.notEqual(result.issue, 'RETAIN_PRICE_UNVERIFIED'); }
});

test('pre-login confirmation guard is mandatory and bound to the operation context', async () => {
  for (const mode of ['skipped', 'different-context', 'guard-failed']) {
    const f = fixture();
    if (mode === 'guard-failed') f.deps.guard = async () => { throw new Error('GUARD_FAILED'); };
    f.deps.openSession = async (operation, options) => {
      if (mode !== 'skipped') await options.prepareContext(f.context);
      const context = mode === 'different-context' ? { ...f.context } : f.context;
      return operation({ context:() => context });
    };
    assert.equal((await prepareCloudPaneAmend(f.input, f.deps)).outcome, 'refused');
    assert.equal(f.events.includes('shallow'), false);
  }
});

test('a second context cannot race the first pre-login guard', async () => {
  const f = fixture();
  addPrices(f.baseline);
  let release, entered;
  const pending = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.deps.guard = async () => { entered(); await pending; };
  f.deps.openSession = async (operation, options) => {
    const first = options.prepareContext(f.context);
    await started;
    await assert.rejects(options.prepareContext({ ...f.context }), /BROWSER_CONTEXT_UNSAFE/);
    release();
    await first;
    return operation({ context:() => f.context });
  };
  assert.equal((await prepareCloudPaneAmend(f.input, f.deps)).outcome, 'prepared');
});

test('unsupported date, child, rate and retain choices refuse before opening a browser', async () => {
  for (const changes of [
    { adults:2, departure:'2027-10-14', ratePlan:'BAR', retainRates:'yes' },
    { children:2, childAges:[8, 5], ratePlan:'BAR', retainRates:'yes' },
    { adults:2, ratePlan:'OTHER', retainRates:'yes' },
    { adults:2, ratePlan:'BAR', retainRates:'no' },
    { adults:1, ratePlan:'BAR', retainRates:'yes' },
  ]) {
    const f = fixture(); addPrices(f.baseline); f.input.changes = changes;
    assert.equal((await prepareCloudPaneAmend(f.input, f.deps)).outcome, 'refused');
    assert.deepEqual(f.events, []);
  }
});

function saveCandidate({ choice = 'yes', phase = 'save' } = {}) {
  const f = fixture();
  f.input.changes = { adults:2, ratePlan:'BAR', retainRates:choice };
  Object.assign(f.baseline.data, { adults:'2', confirmretainrate:'prompt' });
  Object.assign(f.baseline.values, { adults:'2' });
  const nativeData = Object.fromEntries(Object.entries(f.baseline.data).filter(([key]) => key !== 'extId')
    .map(([key, value]) => [key, key === 'sessionID' ? value.sessionID : String(value ?? '')]));
  const body = new URLSearchParams({ ...nativeData, SYSTEM_FUNCTION_NAME:'OSRESV',
    USER_FUNCTION_NAME:'OSRESV', CURRENT_TAB_NAME:'HDR' });
  if (phase === 'retain') body.set('confirmretainrate', choice === 'yes' ? 'confirmed' : 'not_needed');
  const request = { url:() => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/OSRESV.HDR?pageaction=SAVE',
    method:() => 'POST', frame:() => f.state.frame,
    headers:() => ({ 'content-type':'application/x-www-form-urlencoded; charset=UTF-8' }), postData:() => body.toString() };
  const input = { selected:f.selected, changes:f.input.changes, beforeNote:'', beforeParties:f.state.partyPreimage, phase };
  return { ...f, body, request, input };
}

test('a paused Save must match the entire approved Labtest model and visible rate', () => {
  const f = saveCandidate();
  assert.equal(matchesCloudPaneAmendSave(f.request, f.state.frame, f.baseline, f.input), true);
  for (const edit of [
    (v) => { v.body.set('adults', '3'); },
    (v) => { v.body.append('Adults', '2'); },
    (v) => { v.body.append('other', 'unexpected'); },
    (v) => { v.baseline.data.guestid = '999'; v.body.set('guestid', '999'); },
    (v) => { v.baseline.data.reservationstayid = '999'; v.body.set('reservationstayid', '999'); },
    (v) => { v.baseline.data.udfchkbox04 = '1'; v.body.set('udfchkbox04', '1'); },
    (v) => { v.baseline.data.emailaddress = 'guest@example.invalid'; v.body.set('emailaddress', 'guest@example.invalid'); },
    (v) => { v.baseline.data.rateplan = 'CORP'; v.body.set('rateplan', 'CORP'); },
    (v) => { v.baseline.values.rateplan = 'CORP'; },
    (v) => { v.baseline.data.departuredate = '10/15/2027'; v.body.set('departuredate', '10/15/2027'); },
    (v) => { v.baseline.data.companyid = '7'; v.body.set('companyid', '7'); },
    (v) => { v.baseline.data.confirmretainrate = 'confirmed'; v.body.set('confirmretainrate', 'confirmed'); },
    (v) => { v.input.selected.propertyCode = 'HRDAV'; },
  ]) { const v = saveCandidate(); edit(v); assert.equal(matchesCloudPaneAmendSave(v.request, v.state.frame, v.baseline, v.input), false); }
});

test('a retain continuation must carry the approved Yes value', () => {
  const f = saveCandidate({ phase:'retain' });
  assert.equal(matchesCloudPaneAmendSave(f.request, f.state.frame, f.baseline, f.input), true);
  f.body.set('confirmretainrate', 'not_needed');
  assert.equal(matchesCloudPaneAmendSave(f.request, f.state.frame, f.baseline, f.input), false);
  const unsupported = saveCandidate({ choice:'no', phase:'retain' });
  assert.equal(matchesCloudPaneAmendSave(unsupported.request, unsupported.state.frame, unsupported.baseline, unsupported.input), false);
  const missing = saveCandidate({ phase:'retain' });
  delete missing.baseline.data.confirmretainrate;
  missing.body.delete('confirmretainrate');
  assert.equal(matchesCloudPaneAmendSave(missing.request, missing.state.frame, missing.baseline, missing.input), false);
});

test('the real commit refuses before a browser, claim or rate hold while rate proof is missing', async () => {
  const f = fixture(), calls = [];
  const authorization = { operationDigest:'a'.repeat(64),
    authorizeFirst: async () => { calls.push('claim'); }, authorizeContinuation: async () => { calls.push('continue'); } };
  assert.deepEqual(await commitCloudPaneAmend(f.input, authorization),
    { outcome:'not_dispatched', issue:'AMEND_RATE_UNVERIFIED' });
  assert.deepEqual(calls, []);
  assert.deepEqual(f.events, []);
});

test('the first dispatch uses the writer identity captured from the owned session', async () => {
  const page = {}, identity = { host:'a'.repeat(64), browser:{ pid:42, started:'123' } };
  let received;
  const approval = { operationDigest:'b'.repeat(64), authorizeFirst:async (input) => { received = input; } };
  const bound = bindCloudAmendWriter(page, approval, (candidate) => { assert.equal(candidate, page); return identity; });
  identity.browser.pid = 99;
  await bound.authorizeFirst({ phase:'amend.availability', writer:{ forged:true } });
  assert.deepEqual(received, { phase:'amend.availability', writer:{ host:'a'.repeat(64), browser:{ pid:42, started:'123' } } });
  assert.throws(() => bindCloudAmendWriter(page, approval, () => null), /AMEND_WRITER_UNVERIFIED/);
  assert.throws(() => bindCloudAmendWriter(page, {}, () => identity), /AMEND_WRITER_UNVERIFIED/);
});

test('availability can only restore observed staged effects to reviewed baseline values', () => {
  const baseline = { data:{ enablecheckavailability:'0', adults:'1', grandtotal:'100', emailaddress:'' },
    values:{ adults:'1', grandtotal:'100.00', emailaddress:'' }, partyControls:[{ name:'agency', value:'' }],
    partyInputsBlank:true, dirtyFields:[], modifiedFields:[], formDirty:false, recordDirty:false };
  const staged = structuredClone(baseline);
  Object.assign(staged.data, { enablecheckavailability:'-1', adults:'2', grandtotal:'' });
  Object.assign(staged.values, { adults:'2', grandtotal:'' });
  staged.dirtyFields = ['adults', 'grandtotal']; staged.modifiedFields = ['adults', 'enablecheckavailability', 'grandtotal'];
  staged.formDirty = staged.recordDirty = true;
  assert.equal(validAdultAmendDraft(baseline, staged, { adults:1 }, { adults:2 }), true);
  const after = structuredClone(staged);
  Object.assign(after.data, { enablecheckavailability:'0', grandtotal:'100' });
  after.values.grandtotal = '100.00';
  assert.deepEqual(normalizeAmendDraftAfterAvailability(baseline, staged, after), staged);
  assert.equal(validAdultAmendDraft(baseline,
    normalizeAmendDraftAfterAvailability(baseline, staged, after), { adults:1 }, { adults:2 }), true);
  for (const mutate of [
    (v) => { v.data.emailaddress = 'unexpected'; },
    (v) => { v.values.adults = '3'; },
    (v) => { v.values.grandtotal = '101.00'; },
    (v) => { v.partyControls[0].value = 'changed'; },
    (v) => { v.dirtyFields.push('rateplan'); },
    (v) => { delete v.data.adults; },
    (v) => { v.extra = 'unexpected'; },
    (v) => { v.data.enablecheckavailability = '1'; },
  ]) {
    const changed = structuredClone(after); mutate(changed);
    assert.equal(normalizeAmendDraftAfterAvailability(baseline, staged, changed), null);
  }
  assert.equal(normalizeAmendDraftAfterAvailability(baseline, staged, null), null);
});

test('a candidate succeeds only after drained callbacks, closed writer and a matching priced fresh read', () => {
  const saved = { outcome:'awaiting_readback', dispatchCallbacksDrained:true };
  const fresh = { outcome:'matched', retainedPriceMatched:true, readback:{ confirmation:'12345678-1' } };
  assert.deepEqual(confirmedCloudAmendResult(saved, fresh, true), { outcome:'amended',
    dispatchCallbacksDrained:true, writerSessionClosed:true, retainedPriceMatched:true, readback:fresh.readback });
  for (const [write, read, closed] of [
    [{ ...saved, outcome:'uncertain' }, fresh, true],
    [{ ...saved, dispatchCallbacksDrained:false }, fresh, true],
    [saved, fresh, false],
    [saved, { ...fresh, outcome:'unverified' }, true],
    [saved, { ...fresh, retainedPriceMatched:false }, true],
    [saved, { ...fresh, readback:null }, true],
  ]) assert.deepEqual(confirmedCloudAmendResult(write, read, closed),
    { outcome:'uncertain', issue:'AMEND_READBACK_UNVERIFIED' });
});

test('native run options bind the full staged form and never promote an unproved reprice', async () => {
  const f = fixture();
  f.input.changes = { adults:2, ratePlan:'BAR', retainRates:'yes' };
  addPrices(f.baseline);
  f.input.beforeScreenshot = '/private/before.png';
  const initial = await prepareCloudPaneAmend(f.input, f.deps);
  f.input.nativeDigest = initial.nativeDigest; f.input.approvedPrices = initial.approvedPrices;
  const expected = expectedLabtestAmendRecord(f.record, f.selected), draft = { staged:true };
  f.state.frame.locator = (selector) => ({ count:async () => selector.startsWith('[data-qtip') ? 1 : 0 });
  const page = { locator:() => ({ count:async () => 1 }), screenshot:async () => { f.events.push('before'); } };
  let snapshotCount = 0, captured = null;
  const synthetic = cloudPaneAmendRunOptions({ page, input:f.input, expected,
    authorization:{ operationDigest:'a'.repeat(64), authorizeFirst:async () => { throw new Error('must not claim'); },
      authorizeContinuation:async () => { throw new Error('must not continue'); },
      sealBeforeEvidence:async () => { f.events.push('sealed'); return {
        eventId:'00000000-0000-4000-8000-000000000001', sha256:'b'.repeat(64),
      }; } },
    captureBefore:(value) => { captured = value; } }, {
    current:async () => f.state, snapshot:async () => ++snapshotCount === 1 ? f.baseline : draft,
    bind:() => ({ digest:f.input.nativeDigest }), stageAdults:async () => ({ snapshot:draft }),
    verifyDraft:(_before, after) => after === draft,
  });
  assert.equal(typeof synthetic.availability.dispatchCandidate, 'function');
  const bounded = async (promise) => promise;
  const prepared = await synthetic.prepare(bounded);
  assert.equal(captured.beforeNote, '');
  assert.deepEqual(captured.beforeEvidence, { eventId:'00000000-0000-4000-8000-000000000001', sha256:'b'.repeat(64) });
  assert.deepEqual(f.events.slice(-2), ['before', 'sealed']);
  const staged = await synthetic.stage(bounded, prepared, { isActive:() => true });
  assert.equal(await synthetic.validate(bounded, prepared, staged), true);
  assert.equal(await synthetic.availability.snapshot(bounded, prepared), draft);
  const rate = await synthetic.availability.validate(bounded, prepared, staged,
    { json:async () => ({ pageData:{ success:true } }) });
  assert.deepEqual(rate, { ok:false, issue:'AMEND_RATE_UNVERIFIED' });
  assert.equal(synthetic.matches({}, f.state.frame, prepared), false);
  assert.equal(synthetic.reportDispatchDrain, true);
});

test('an absent, failed or ambiguous before-evidence seal cannot reach availability or Save', async () => {
  const makeRun = async (sealBeforeEvidence) => {
    const f = fixture();
    f.input.changes = { adults:2, ratePlan:'BAR', retainRates:'yes' };
    addPrices(f.baseline);
    f.input.beforeScreenshot = '/private/before.png';
    const initial = await prepareCloudPaneAmend(f.input, f.deps);
    f.input.nativeDigest = initial.nativeDigest; f.input.approvedPrices = initial.approvedPrices;
    f.events.length = 0;
    f.state.frame.locator = (selector) => ({ count:async () => selector.startsWith('[data-qtip') ? 1 : 0 });
    const page = { on:() => {}, off:() => {}, route:async () => { f.events.push('route'); },
      locator:() => ({ count:async () => 1 }), screenshot:async () => { f.events.push('before'); } };
    const options = cloudPaneAmendRunOptions({ page, input:f.input,
      expected:expectedLabtestAmendRecord(f.record, f.selected),
      authorization:{ operationDigest:'a'.repeat(64), sealBeforeEvidence,
        authorizeFirst:async () => { f.events.push('claim'); }, authorizeContinuation:async () => { f.events.push('continue'); } } }, {
      current:async () => f.state, snapshot:async () => f.baseline, bind:() => ({ digest:f.input.nativeDigest }),
    });
    options.timeoutMs = 100;
    options.stage = async () => { f.events.push('stage'); throw new Error('UNEXPECTED_STAGE'); };
    return { f, page, options };
  };

  for (const seal of [undefined, async () => { throw new Error('SEAL_FAILED'); },
    async () => null, async () => ({ eventId:'not-an-event', sha256:'b'.repeat(64) })]) {
    const { f, page, options } = await makeRun(seal);
    const result = await runLabtestAmendSave(page, options);
    assert.equal(result.outcome, 'not_dispatched');
    assert.equal(f.events.some((event) => ['route', 'stage', 'claim', 'continue'].includes(event)), false);
  }

  let release, started;
  const pending = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  const { f, page, options } = await makeRun(async () => { started(); return pending; });
  options.timeoutMs = 25;
  const run = runLabtestAmendSave(page, options);
  await entered;
  assert.deepEqual(f.events, ['before']);
  const result = await run;
  assert.equal(result.outcome, 'not_dispatched');
  assert.equal(result.issue, 'AMEND_TIMEOUT');
  release({ eventId:'00000000-0000-4000-8000-000000000001', sha256:'b'.repeat(64) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.events, ['before']);
});

test('fresh readback matches the adult change, retained price and a screenshot', async () => {
  const saved = () => {
    const f = fixture();
    addPrices(f.baseline);
    f.input.approvedPrices = oneNightRetainPrices(f.baseline);
    f.record.nativePreimage.adults = 2;
    f.baseline.data.adults = f.baseline.values.adults = '2';
    f.input.beforeNote = ''; f.input.beforeParties = f.state.partyPreimage; f.input.afterScreenshot = '/private/after.png';
    return f;
  };
  const f = saved();
  const result = await readCloudPaneAmend(f.input, f.deps);
  assert.equal(result.outcome, 'matched');
  assert.deepEqual(result.readback, { confirmation:'12345678-1', arrival:'2027-10-12', departure:'2027-10-13', adults:2,
    children:1, childAges:[8], ratePlan:'BAR' });
  assert.deepEqual(f.events, ['guard', 'login', 'shallow', 'record', 'screenshot']);
  for (const edit of [
    (v) => { v.record.nativePreimage.children = 2; },
    (v) => { v.record.nativePreimage.ratePlan = 'OTHER'; },
    (v) => { v.record.nativePreimage.guestId = '999'; },
    (v) => { v.record.details.fields[0].rawValue = 'changed'; },
    (v) => { v.baseline.data.companyid = 'unexpected'; },
    (v) => { v.baseline.recordDirty = true; },
    (v) => { v.input.afterScreenshot = ''; },
    (v) => { v.deps.openSession = async (operation, options) => { await options.prepareContext(v.context);
      return operation({ context:() => v.context, screenshot:async () => { throw new Error('disk unavailable'); } }); }; },
  ]) { const v = saved(); edit(v); assert.equal((await readCloudPaneAmend(v.input, v.deps)).outcome, 'unverified'); }
});
