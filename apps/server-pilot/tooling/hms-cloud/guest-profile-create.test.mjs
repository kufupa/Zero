import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { prepareGuardedContext } from './pre-navigation-context-guard.mjs';
import { matchesProfileReadback, profileBusinessFields, profileCreateTestHooks as hooks } from './guest-profile-create.mjs';

const fields = profileBusinessFields({ guest: { firstName: 'Proof', lastName: 'Labtest', mobile: '+27000000001' } });

test('email without a type defaults to Primary so native Save is not rejected', () => {
  assert.equal(fields.emailTypeCode, undefined);
  const withEmail = profileBusinessFields({
    guest: { firstName: 'Proof', lastName: 'Labtest', mobile: '+27000000001', email: 'proof@example.invalid' },
  });
  assert.equal(withEmail?.emailTypeCode, 'PRIM');
  const explicit = profileBusinessFields({
    guest: { firstName: 'Proof', lastName: 'Labtest', mobile: '+27000000001', email: 'proof@example.invalid',
      emailTypeCode: 'HOME' },
  });
  assert.equal(explicit?.emailTypeCode, 'HOME');
});

test('guest review digests ignore JSON key order after storage round-trips', async () => {
  const { profileReviewDigest, matchesProfileReview } = await import('./guest-profile-create.mjs');
  const fields = profileBusinessFields({
    guest: { firstName: 'Proof', lastName: 'Labtest', mobile: '+27000000001', email: 'proof@example.invalid' },
  });
  const review = {
    version: 2, propertyCode: 'HRCEN', fields, confirmDuplicateName: true,
    effective: { title: { code: '', label: '' }, phoneNumber: '',
      phoneType: { code: '', label: '' }, emailType: { code: 'PRIM', label: 'Primary' } },
  };
  const reordered = JSON.parse(JSON.stringify(review, (key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).reverse().map(name => [name, value[name]]));
  }));
  assert.equal(profileReviewDigest(review), profileReviewDigest(reordered));
  assert.equal(matchesProfileReview(reordered, fields, true), true);
});

function request(changes = {}, confirmed = false) {
  const body = new URLSearchParams({ SYSTEM_FUNCTION_NAME: 'FSGSPF', USER_FUNCTION_NAME: 'FSGSPF', CURRENT_TAB_NAME: 'HDR',
    firstname: fields.firstName, lastname: fields.lastName, mobilenumber: fields.mobile, emailaddress: '',
    profilestatuscode: 'ACTIVE', profileid: '', recordid: '', confirmnewguestprofile: confirmed ? 'confirmed' : '',
    confirminactiveguestprofile: '', guestoptin1: '0', guestoptin2: '0', guestoptin3: '0', guestoptin4: '0', extra: 'allowed' });
  for (const [key, value] of Object.entries(changes)) value === null ? body.delete(key) : body.set(key, value);
  return { method: () => 'POST', url: () => 'https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/FSGSPF.HDR?pageaction=SAVE',
    postData: () => body.toString(), headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }) };
}

test('native Save fence binds supported fields and consent while allowing unrelated HMS drift', () => {
  assert.equal(hooks.profileSaveMatches(request(), fields, false), true);
  assert.equal(hooks.profileCreateReadMayRequest(request()), false); // Prepare's read-only fence never permits Save.
  for (const changes of [{ firstname: 'Other' }, { emailaddress: 'other@example.test' }, { guestoptin1: '1' },
    { guestoptin2: null }, { confirmnewguestprofile: 'confirmed' }, { profileid: '123' }]) {
    assert.equal(hooks.profileSaveMatches(request(changes), fields, false), false);
  }
  const duplicate = request();
  const post = duplicate.postData(); duplicate.postData = () => post + '&FIRSTNAME=Other';
  assert.equal(hooks.profileSaveMatches(duplicate, fields, false), false);
  assert.equal(hooks.profileSaveMatches(request({}, true), fields, true), true);
});

test('created readback requires explicitly blank email and all four consent values off', () => {
  const readback = { outcome: 'read', nativeId: '123', firstName: fields.firstName, lastName: fields.lastName, mobile: fields.mobile,
    email: '', status: 'ACTIVE', consent: [false, false, false, false] };
  assert.equal(matchesProfileReadback(readback, fields), true);
  assert.equal(matchesProfileReadback(readback, fields, '123'), true);
  assert.equal(matchesProfileReadback(readback, fields, '456'), false);
  for (const changed of [{ email: null }, { email: 'other@example.test' }, { consent: [false, null, false, false] },
    { consent: [false, false, false, true] }, { consent: [false, false, false] }]) {
    assert.equal(matchesProfileReadback({ ...readback, ...changed }, fields), false);
  }
});

async function guardedPage() {
  const pages = [];
  const context = { _options: { serviceWorkers: 'block' }, serviceWorkers: () => [], pages: () => pages,
    routeWebSocket: async () => {} };
  await prepareGuardedContext(context);
  const page = { context: () => context }; pages.push(page);
  return page;
}

test('a guard failure during session shutdown prevents a successful result', async () => {
  for (const flag of ['blocked', 'dialog']) {
    const page = new EventEmitter(), state = { blocked: false, dialog: false };
    const openSession = async operation => {
      const result = await operation(page);
      if (flag === 'dialog') page.emit('dialog');
      else state.blocked = true;
      return result;
    };
    await assert.rejects(hooks.guardedSession(openSession, state, async () => ({ outcome: 'created' }), {}),
      /PROFILE_SESSION_GUARD_TRIPPED/, flag);
  }
});

test('only the recognized duplicate prompt can dispatch a reviewed confirmation', async () => {
  for (const scenario of ['declined', 'approved', 'unexpected']) {
    const page = await guardedPage(), state = { blocked: false, dialog: false }, records = [];
    let yesClicks = 0, fetches = 0;
    const question = { type: 'question', questiontype: 'YesNo', handler: 'confirmNewGuestProfile',
      msg: scenario === 'unexpected' ? 'A different question' : 'Profile name already exists. Continue?' };
    const route = (confirmed, data) => {
      const req = request({}, confirmed); req.frame = () => ({ page: () => page });
      return { request: () => req, fetch: async () => { fetches++; return { status: () => 200,
        text: async () => JSON.stringify({ pageData: data }) }; }, fulfill: async () => {}, abort: async () => {} };
    };
    const initial = route(false, { success: false, messages: [question] });
    const confirmed = route(true, { success: true, values: { profileid: '123' } });
    const yes = { count: async () => 1, isEnabled: async () => true, click: async () => {
      yesClicks++; await hooks.handleProfileSave(confirmed, state);
    } };
    const windows = { count: async () => 1, first: () => ({ locator: () => ({ filter: () => yes }) }) };
    page.frames = () => [{ locator: () => ({ filter: () => windows }) }];
    const save = { click: async () => hooks.handleProfileSave(initial, state) };
    const staged = { save, fields, previewDigest: 'digest', confirmDuplicateName: scenario !== 'declined' };
    const result = await hooks.savePreparedProfile(page, state, staged, { attemptId: scenario,
      authorizeCandidate: async () => true, dispatchCandidate: async (_context, proceed) => proceed(),
      recordResponse: async (context, response) => records.push({ phase: context.phase, ...response }) });
    if (scenario === 'approved') {
      assert.equal(result.outcome, 'awaiting_readback');
      assert.equal(result.nativeId, '123');
      assert.deepEqual(result.dispatchedPhases, ['initial', 'confirm_distinct']);
      assert.equal(yesClicks, 1);
      assert.equal(fetches, 2);
      assert.deepEqual(records.map(record => record.phase), ['initial', 'confirm_distinct']);
    } else {
      assert.equal(result.outcome, scenario === 'declined' ? 'confirmation_required' : 'uncertain');
      assert.equal(yesClicks, 0);
      assert.equal(fetches, 1);
      assert.deepEqual(result.dispatchedPhases, ['initial']);
    }
  }
});

test('delayed response persists its ID before browser fulfillment and completion', async () => {
  const page = await guardedPage(), events = [];
  const req = request(); req.frame = () => ({ page: () => page });
  const route = { request: () => req, fetch: async () => {
    await new Promise(resolve => setTimeout(resolve, 1700));
    events.push('fetched');
    return { status: () => 200, text: async () => '{"pageData":{"success":true,"values":{"profileid":"123"}}}' };
  }, fulfill: async () => events.push('fulfilled'), abort: async () => events.push('aborted') };
  const write = { fields, previewDigest: 'digest', confirmDuplicateName: false, phase: 'initial', dispatched: false,
    dispatchedPhases: [], callbackDrained: false, authorizeCandidate: async () => true,
    dispatchCandidate: async (_context, proceed) => proceed(),
    recordResponse: async (_context, response) => { assert.equal(response.nativeId, '123'); events.push('recorded'); } };
  const handler = hooks.handleProfileSave(route, { write });
  await hooks.waitForDispatch(write, 3000);
  await handler;
  assert.deepEqual(events, ['fetched', 'recorded', 'fulfilled']);
  assert.equal(write.dispatched, true);
});

test('late authorization cannot dispatch after the operation closes', async () => {
  const page = await guardedPage();
  const req = request(); req.frame = () => ({ page: () => page });
  let resolveAuthorization, fetches = 0;
  const route = { request: () => req, fetch: async () => { fetches++; }, abort: async () => {} };
  const write = { fields, previewDigest: 'digest', confirmDuplicateName: false, phase: 'initial', dispatched: false,
    dispatchedPhases: [], authorizeCandidate: () => new Promise(resolve => { resolveAuthorization = resolve; }),
    dispatchCandidate: async (_context, proceed) => proceed(), recordResponse: async () => {} };
  const handler = hooks.handleProfileSave(route, { write });
  await assert.rejects(hooks.waitForDispatch(write, 20), /PROFILE_SAVE_TIMED_OUT/);
  write.phase = 'closed'; resolveAuthorization(true);
  await handler;
  assert.equal(fetches, 0);
  assert.equal(write.dispatched, false);
});

test('a blocked request or unexpected dialog during authorization prevents Save', async () => {
  for (const flag of ['blocked', 'dialog']) {
    for (const moment of ['authorize', 'before_proceed']) {
      const page = await guardedPage();
      const req = request(); req.frame = () => ({ page: () => page });
      let fetches = 0;
      const route = { request: () => req, fetch: async () => { fetches++; }, abort: async () => {} };
      const state = { blocked: false, dialog: false };
      const write = { fields, previewDigest: 'digest', confirmDuplicateName: false, phase: 'initial', dispatched: false,
        dispatchedPhases: [], authorizeCandidate: async () => { if (moment === 'authorize') state[flag] = true; return true; },
        dispatchCandidate: async (_context, proceed) => { if (moment === 'before_proceed') state[flag] = true; return proceed(); },
        recordResponse: async () => {} };
      state.write = write;
      await hooks.handleProfileSave(route, state);
      assert.equal(fetches, 0, `${flag} at ${moment}`);
      assert.equal(write.dispatched, false);
    }
  }
});

test('response persistence failure retains the known ID and does not fulfill the browser', async () => {
  const page = await guardedPage(), events = [];
  const req = request(); req.frame = () => ({ page: () => page });
  const route = { request: () => req, fetch: async () => ({ status: () => 200,
    text: async () => '{"pageData":{"success":true,"values":{"profileid":"123"}}}' }),
  fulfill: async () => events.push('fulfilled'), abort: async () => events.push('aborted') };
  const write = { fields, previewDigest: 'digest', confirmDuplicateName: false, phase: 'initial', dispatched: false,
    dispatchedPhases: [], authorizeCandidate: async () => true,
    dispatchCandidate: async (_context, proceed) => proceed(), recordResponse: async () => { throw new Error('DISK_FAILED'); } };
  await hooks.handleProfileSave(route, { write });
  assert.equal(write.dispatched, true);
  assert.equal(write.response.nativeId, '123');
  assert.equal(write.issue, 'PROFILE_SAVE_UNCERTAIN');
  assert.deepEqual(events, ['aborted']);
});
