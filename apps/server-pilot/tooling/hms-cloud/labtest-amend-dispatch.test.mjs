import test from 'node:test';
import assert from 'node:assert/strict';
import { amendNativeRequestDigest, createLabtestAmendDispatch } from './labtest-amend-dispatch.mjs';

const ORIGIN = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const HOLD = '11111111-1111-4111-8111-111111111111';
const OWNER = 'b'.repeat(64);
const OPERATION = 'a'.repeat(64);
const handle = () => ({ holdId:HOLD, ownerToken:OWNER });
const request = (phase, overrides = {}) => {
  const state = { body: Buffer.from('confirmationnumber=12345678-1&guestid=123&udfchkbox04=0'), ...overrides };
  return { state, method: () => state.method ?? 'POST',
    url: () => state.url ?? `${ORIGIN}${phase === 'availability'
      ? '/web/base/OSRESV.HDR.getcheckavailability' : '/web/base/OSRESV.HDR?pageaction=SAVE'}`,
    headers: () => ({ 'content-type': state.contentType ?? 'application/x-www-form-urlencoded; charset=UTF-8' }),
    postDataBuffer: () => state.body };
};

test('the private digest binds the phase, target, content type and all native body bytes', () => {
  const initial = request('save'), digest = amendNativeRequestDigest(initial, 'save');
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, amendNativeRequestDigest(initial, 'retain'));
  assert.notEqual(digest, amendNativeRequestDigest(request('save', { body: Buffer.from('different') }), 'save'));
  for (const invalid of [
    request('save', { url: 'https://attacker.invalid/web/base/OSRESV.HDR?pageaction=SAVE' }),
    request('save', { url: `${ORIGIN}/web/base/OSRESV.HDR?pageaction=SAVE&extra=1` }),
    request('save', { method: 'GET' }), request('save', { contentType: 'application/json' }),
    request('save', { body: Buffer.alloc(0) }), request('save', { body: Buffer.alloc(2 * 1024 * 1024 + 1) }),
  ]) assert.equal(amendNativeRequestDigest(invalid, 'save'), null);
  assert.equal(amendNativeRequestDigest(request('availability'), 'save'), null);
});

test('a confirmed first hold precedes ordered one-shot availability, Save and retain', async () => {
  const events = [], begin = async (input) => { events.push(['commit', input]); return handle(); };
  const gate = createLabtestAmendDispatch({ operationDigest: OPERATION, requiresAvailability: true, authorizeFirst: begin });
  const availability = request('availability'), save = request('save'), retain = request('retain');
  await gate.availability(availability, async () => { events.push('availability'); });
  await gate.save(save, async () => { events.push('save'); });
  await gate.retain(retain, async () => { events.push('retain'); });
  assert.deepEqual(events, [['commit', { operationDigest: OPERATION, phase: 'amend.availability',
    requestDigest: amendNativeRequestDigest(availability, 'availability') }], 'availability',
  'save', 'retain']);
  assert.equal(gate.holdId(), HOLD);
  await assert.rejects(gate.retain(retain, async () => {}), /AMEND_DISPATCH_NOT_AUTHORIZED/);
});

test('a rejected or ambiguous first commit never continues any request', async () => {
  for (const authorizeFirst of [
    async () => ({ status: 'refused' }), async () => ({ holdId: 'bad', ownerToken:OWNER }),
    async () => { throw new Error('lost commit response'); },
  ]) {
    let continuations = 0;
    const gate = createLabtestAmendDispatch({ operationDigest: OPERATION, requiresAvailability: true, authorizeFirst });
    await assert.rejects(gate.availability(request('availability'), async () => { continuations += 1; }));
    await assert.rejects(gate.save(request('save'), async () => { continuations += 1; }));
    assert.equal(continuations, 0);
  }
});

test('a concurrent candidate, changed request or closed gate cannot continue after commit', async () => {
  for (const scenario of ['concurrent', 'changed', 'closed']) {
    let finish, started;
    const entered = new Promise((resolve) => { started = resolve; });
    const authorizeFirst = async () => { started(); return new Promise((resolve) => { finish = resolve; }); };
    const gate = createLabtestAmendDispatch({ operationDigest: OPERATION, requiresAvailability: true, authorizeFirst });
    const native = request('availability');
    let continuations = 0;
    const first = gate.availability(native, async () => { continuations += 1; });
    await entered;
    if (scenario === 'concurrent') await assert.rejects(gate.availability(native, async () => { continuations += 1; }));
    if (scenario === 'changed') native.state.body = Buffer.from('different');
    if (scenario === 'closed') gate.close();
    finish(handle());
    await assert.rejects(first);
    assert.equal(continuations, 0);
    assert.equal(gate.holdId(), HOLD);
  }
});

test('a failed continuation or out-of-order step prevents all later requests', async () => {
  for (const first of ['save-first', 'native-error']) {
    let calls = 0;
    const gate = createLabtestAmendDispatch({ operationDigest: OPERATION, requiresAvailability: true,
      authorizeFirst: async () => { calls += 1; return handle(); } });
    if (first === 'save-first') await assert.rejects(gate.save(request('save'), async () => {}));
    else await assert.rejects(gate.availability(request('availability'), async () => { throw new Error('browser closed'); }));
    await assert.rejects(gate.save(request('save'), async () => {}));
    assert.equal(calls, first === 'save-first' ? 0 : 1);
  }
});

test('a Save-only operation also consumes exactly one confirmed hold', async () => {
  let commits = 0, continued = 0;
  const gate = createLabtestAmendDispatch({ operationDigest: OPERATION, requiresAvailability: false,
    authorizeFirst: async ({ phase }) => { assert.equal(phase, 'amend.save'); commits += 1; return handle(); } });
  await gate.save(request('save'), async () => { continued += 1; });
  await gate.retain(request('retain'), async () => { continued += 1; });
  assert.equal(commits, 1);
  assert.equal(continued, 2);
});

test('a failed native continuation stops later phases while retaining the existing hold', async () => {
  let continued = 0;
  const gate = createLabtestAmendDispatch({ operationDigest:OPERATION, requiresAvailability:true,
    authorizeFirst:async () => handle() });
  await gate.availability(request('availability'), async () => { continued += 1; });
  await assert.rejects(gate.save(request('save'), async () => { throw new Error('native response lost'); }));
  await assert.rejects(gate.retain(request('retain'), async () => { continued += 1; }));
  assert.equal(continued, 1);
  assert.equal(gate.holdId(), HOLD);
});
