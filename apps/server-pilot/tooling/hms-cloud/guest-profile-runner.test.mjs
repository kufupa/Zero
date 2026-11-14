import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { profileBusinessFields, profilePreviewDigest, profileReviewDigest } from './guest-profile-create.mjs';
import { createGuestProfileRunner } from './guest-profile-runner.mjs';

const business = { propertyCode: 'HRCEN', guest: { firstName: 'Proof', lastName: 'Labtest', mobile: '+27000000999' }, confirmDuplicateName: true };
const fields = profileBusinessFields(business);
const input = { ...business, expectedPreviewDigest: profilePreviewDigest(fields, true), attemptId: 'attempt-one' };
const readback = { outcome: 'read', propertyCode: 'HRCEN', nativeId: '123', firstName: 'Proof', lastName: 'Labtest', mobile: fields.mobile,
  email: '', status: 'ACTIVE', consent: [false, false, false, false], consentCoverage: 'complete' };
async function fixture(t, createImpl, verifyNoCreate) {
  const parent = join(homedir(), '.nava-hms-runtime');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(parent, 'profile-runner-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let saves = 0, quiesced = true;
  const dependencies = { prepareGuestProfile: async () => ({ outcome: 'ready' }),
    writerCurrent: () => true, writerQuiesced: () => quiesced,
    readGuestProfile: async () => readback,
    createGuestProfile: async (request, options) => {
      const context = { propertyCode: 'HRCEN', writer: {}, phase: 'initial', previewDigest: request.expectedPreviewDigest,
        confirmDuplicateName: request.confirmDuplicateName === true, fields: profileBusinessFields(request) };
      assert.equal(await options.authorizeCandidate(context), true);
      return createImpl({ options, context, dir, dispatch: async (response, phase = 'initial') => {
        const current = { ...context, phase };
        return options.dispatchCandidate(current, async () => { saves++; await options.recordResponse(current, response); });
      } });
    } };
  const runner = () => createGuestProfileRunner({ runtimeDir: dir, dependencies, verifyNoCreate,
    sessionOptions: { propertyCode: 'HRCEN', transportId: 'transport-centurion' },
    authorizeStaffWrite: async () => true, dispatchStaffWrite: async (_context, proceed) => proceed() });
  return { dir, runner, saves: () => saves, setQuiesced: value => { quiesced = value; } };
}
const success = { status: 200, success: true, nativeId: '123', question: false };
const created = { outcome: 'created', attemptId: input.attemptId, phase: 'initial', dispatched: true, nativeId: '123', readback };

test('concurrent and restarted calls cannot dispatch twice; completed result replays', async t => {
  let release, claimed;
  const onClaimed = new Promise(resolve => { claimed = resolve; });
  const ready = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async ({ dispatch }) => { await dispatch(success); claimed(); await ready; return created; });
  const pending = f.runner().createGuestProfile(input);
  await onClaimed;
  assert.equal((await f.runner().createGuestProfile(input)).outcome, 'reconciliation_required');
  assert.equal((await f.runner().createGuestProfile({ ...input, attemptId: 'new-attempt' })).issue, 'PROFILE_INTENT_HELD');
  release();
  assert.equal((await pending).outcome, 'created');
  assert.equal((await f.runner().createGuestProfile(input)).outcome, 'created');
  assert.equal(f.saves(), 1);

  const largeReadback = { ...readback, fields: [{ rawValue: 'x'.repeat(70_000) }] };
  const large = await fixture(t, async ({ dispatch }) => {
    await dispatch(success);
    return { ...created, readback: largeReadback };
  });
  assert.equal((await large.runner().createGuestProfile(input)).outcome, 'created');
  assert.deepEqual((await large.runner().createGuestProfile(input)).readback, largeReadback);
  assert.equal(large.saves(), 1);

  const oversized = await fixture(t, async ({ dispatch }) => {
    await dispatch(success);
    return { ...created, readback: { ...readback, fields: [{ rawValue: 'x'.repeat(5 * 1024 * 1024) }] } };
  });
  const held = await oversized.runner().createGuestProfile(input);
  assert.equal(held.outcome, 'reconciliation_required');
  assert.equal(held.nativeId, '123');
  assert.equal((await oversized.runner().readGuestProfile({ propertyCode: 'HRCEN', nativeId: '123', attemptId: input.attemptId })).reconciliation.outcome, 'created');
  assert.equal(oversized.saves(), 1);
});

test('known returned ID survives uncertainty and reconciles without another Save', async t => {
  const f = await fixture(t, async ({ dispatch }) => { await dispatch(success); return { outcome: 'uncertain', issue: 'READ_FAILED', attemptId: input.attemptId }; });
  const result = await f.runner().createGuestProfile(input);
  assert.equal(result.nativeId, '123');
  f.setQuiesced(false);
  assert.equal((await f.runner().readGuestProfile({ propertyCode: 'HRCEN', nativeId: '123', attemptId: input.attemptId })).issue, 'PROFILE_WRITER_NOT_QUIESCED');
  assert.equal((await f.runner().createGuestProfile(input)).outcome, 'reconciliation_required');
  f.setQuiesced(true);
  const fresh = await f.runner().readGuestProfile({ propertyCode: 'HRCEN', nativeId: '123', attemptId: input.attemptId });
  assert.equal(fresh.reconciliation.outcome, 'created');
  assert.equal((await f.runner().createGuestProfile(input)).outcome, 'created');
  assert.equal(f.saves(), 1);

  const interrupted = await fixture(t, async ({ dispatch }) => {
    await dispatch(success);
    return { outcome: 'uncertain', issue: 'READ_FAILED', attemptId: input.attemptId };
  });
  await interrupted.runner().createGuestProfile(input);
  const attemptKey = createHash('sha256').update(JSON.stringify(input.attemptId)).digest('hex');
  await writeFile(join(interrupted.dir, `attempt-${attemptKey}-reconcile-claim.json`),
    JSON.stringify({ version: 1, attemptKey }) + '\n', { flag: 'wx', mode: 0o600 });
  const resumed = await interrupted.runner().readGuestProfile({ propertyCode: 'HRCEN', nativeId: '123', attemptId: input.attemptId });
  assert.equal(resumed.reconciliation.outcome, 'created');
  assert.equal(interrupted.saves(), 1);
});

test('extended review authorize ignores JSONB key order between claim and live prepare', async t => {
  const guest = { firstName: 'Proof', lastName: 'Labtest', mobile: '+27000000999',
    email: 'proof-order@example.invalid', emailTypeCode: 'PRIM' };
  const orderedFields = profileBusinessFields({ guest, confirmDuplicateName: true });
  const review = {
    version: 2, propertyCode: 'HRCEN', fields: orderedFields, confirmDuplicateName: true,
    effective: { title: { code: '', label: '' }, phoneNumber: '',
      phoneType: { code: '', label: '' }, emailType: { code: 'PRIM', label: 'Primary' } },
  };
  const reordered = JSON.parse(JSON.stringify(review, (key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).reverse().map(name => [name, value[name]]));
  }));
  assert.notEqual(JSON.stringify(review), JSON.stringify(reordered));
  const parent = join(homedir(), '.nava-hms-runtime');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(parent, 'profile-runner-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let authorized = false;
  const runner = createGuestProfileRunner({
    runtimeDir: dir, sessionOptions: { propertyCode: 'HRCEN', transportId: 'transport-centurion' },
    authorizeStaffWrite: async () => true, dispatchStaffWrite: async (_context, proceed) => proceed(),
    dependencies: {
      writerCurrent: () => true, writerQuiesced: () => true,
      createGuestProfile: async (request, options) => {
        const liveFields = profileBusinessFields(request);
        // Live prepare often rebuilds fields/review with different key order than the claim.
        const context = { propertyCode: 'HRCEN', writer: {}, phase: 'initial', previewDigest: request.expectedPreviewDigest,
          confirmDuplicateName: true, fields: liveFields, review };
        authorized = await options.authorizeCandidate(context) === true;
        assert.equal(authorized, true);
        await options.dispatchCandidate(context, async () => {
          await options.recordResponse(context, { status: 200, success: true, nativeId: '999', question: false });
        });
        return { outcome: 'created', attemptId: request.attemptId, phase: 'initial', dispatched: true, nativeId: '999' };
      },
    },
  });
  const result = await runner.createGuestProfile({
    propertyCode: 'HRCEN', guest, confirmDuplicateName: true,
    expectedPreviewDigest: profileReviewDigest(reordered), expectedReview: reordered, attemptId: 'order-attempt',
  });
  assert.equal(authorized, true);
  assert.notEqual(result.issue, 'PROFILE_SAVE_NOT_AUTHORIZED');
  assert.ok(['created', 'reconciliation_required'].includes(result.outcome), result.issue ?? result.outcome);
});test('a changed approval, real guest, or caller-provided authority cannot dispatch', async t => {
  const f = await fixture(t, async ({ dispatch }) => { await dispatch(success); return created; });
  await f.runner().createGuestProfile(input);
  const changed = { ...input, guest: { ...business.guest, mobile: '+27000000998' } };
  changed.expectedPreviewDigest = profilePreviewDigest(profileBusinessFields({ guest: changed.guest, confirmDuplicateName: true }), true);
  assert.equal((await f.runner().createGuestProfile(changed)).issue, 'PROFILE_ATTEMPT_CHANGED');
  const withoutAuthority = createGuestProfileRunner({ runtimeDir: f.dir, sessionOptions: { propertyCode: 'HRCEN' } });
  assert.equal((await withoutAuthority.createGuestProfile({ ...input, attemptId: 'real', guest: { ...business.guest, firstName: 'Real' } })).issue, 'PROFILE_LABTEST_ONLY');
  assert.equal((await f.runner().createGuestProfile({ ...input, attemptId: 'authority', authorized: true })).issue, 'PROFILE_ATTEMPT_INPUT_INVALID');
  assert.equal(f.saves(), 1);
});

test('unresolved intent also holds when the duplicate decision or attempt ID changes', async t => {
  const f = await fixture(t, async ({ dispatch }) => { await dispatch({ status: 200, success: false, nativeId: null, question: true });
    return { outcome: 'confirmation_required', attemptId: input.attemptId, issue: 'PROFILE_NAME_ALREADY_EXISTS', dispatched: true }; });
  await f.runner().createGuestProfile(input);
  const later = { ...input, confirmDuplicateName: false, attemptId: 'different' };
  later.expectedPreviewDigest = profilePreviewDigest(profileBusinessFields({ guest: later.guest, confirmDuplicateName: false }), false);
  assert.equal((await f.runner().createGuestProfile(later)).issue, 'PROFILE_INTENT_HELD');
  assert.equal(f.saves(), 1);
});

test('malformed journal and unavailable persistence fail closed', async t => {
  const f = await fixture(t, async ({ dispatch }) => { await dispatch(success); return created; });
  await f.runner().createGuestProfile(input);
  const claim = (await readdir(f.dir)).find(name => name.endsWith('-claim.json') && name.startsWith('attempt-'));
  await writeFile(join(f.dir, claim), '{bad');
  assert.equal((await f.runner().createGuestProfile(input)).issue, 'PROFILE_JOURNAL_CORRUPT');
  const unavailable = createGuestProfileRunner({ runtimeDir: '/dev/null/profile-journal', dependencies: {},
    sessionOptions: { propertyCode: 'HRCEN' }, authorizeStaffWrite: async () => true, dispatchStaffWrite: async (_context, proceed) => proceed() });
  assert.equal((await unavailable.createGuestProfile({ ...input, attemptId: 'unavailable' })).issue, 'PROFILE_JOURNAL_UNAVAILABLE');
  assert.equal(f.saves(), 1);
});

test('a reviewed no-create resolution can advance an intent once', async t => {
  let reviewed = 0;
  const f = await fixture(t, async ({ options, context, dispatch }) => {
    await dispatch({ status: 200, success: false, nativeId: null, question: true });
    if (!context.confirmDuplicateName) return { outcome: 'confirmation_required', attemptId: options.attemptId,
      issue: 'PROFILE_NAME_ALREADY_EXISTS', dispatched: true };
    await dispatch(success, 'confirm_distinct');
    return { ...created, attemptId: options.attemptId, phase: 'confirm_distinct' };
  }, async proof => {
    reviewed++;
    assert.equal(proof.attemptId, 'declined');
    assert.equal(proof.result.outcome, 'confirmation_required');
    return { outcome: 'no_create', evidenceDigest: 'a'.repeat(64) };
  });
  const declined = { ...input, attemptId: 'declined', confirmDuplicateName: false };
  declined.expectedPreviewDigest = profilePreviewDigest(fields, false);
  assert.equal((await f.runner().createGuestProfile(declined)).outcome, 'confirmation_required');
  const allowed = { ...input, attemptId: 'reviewed-next', retryOfAttemptId: 'declined' };
  assert.equal((await f.runner().createGuestProfile(allowed)).outcome, 'created');
  assert.equal((await f.runner().createGuestProfile(allowed)).outcome, 'created');
  assert.equal((await f.runner().createGuestProfile({ ...allowed, attemptId: 'third' })).issue, 'PROFILE_INTENT_HELD');
  assert.equal(reviewed, 1);
  assert.equal(f.saves(), 3); // Refused initial, then reviewed initial and confirmation.
});

test('a claimed retry cannot create a new intent when its prior attempt is absent', async t => {
  const f = await fixture(t, async ({ dispatch }) => { await dispatch(success); return created; },
    async () => ({ outcome: 'no_create', evidenceDigest: 'a'.repeat(64) }));
  const result = await f.runner().createGuestProfile({ ...input, retryOfAttemptId: 'missing-attempt' });
  assert.equal(result.issue, 'PROFILE_INTENT_HELD');
  assert.equal(f.saves(), 0);
});

test('failed pre-dispatch journal write prevents the request', async t => {
  const f = await fixture(t, async ({ dispatch, dir }) => {
    await chmod(dir, 0o500);
    try { await dispatch(success); }
    finally { await chmod(dir, 0o700); }
    return created;
  });
  const result = await f.runner().createGuestProfile(input);
  assert.equal(result.outcome, 'uncertain');
  assert.equal(f.saves(), 0);
  assert.equal((await f.runner().createGuestProfile(input)).outcome, 'reconciliation_required');
});

test('a failed response record retains an observed ID for later manual reconciliation', async t => {
  let reviewed = 0;
  const f = await fixture(t, async ({ options, context, dir }) => options.dispatchCandidate(context, async () => {
    await chmod(dir, 0o500);
    try { await options.recordResponse(context, success); }
    finally { await chmod(dir, 0o700); }
  }), async () => { reviewed++; return { outcome: 'no_create', evidenceDigest: 'a'.repeat(64) }; });
  const result = await f.runner().createGuestProfile(input);
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.nativeId, '123');
  const replay = await f.runner().createGuestProfile(input);
  assert.equal(replay.outcome, 'reconciliation_required');
  assert.equal(replay.nativeId, '123');
  assert.equal((await f.runner().readGuestProfile({ propertyCode: 'HRCEN', nativeId: '123', attemptId: input.attemptId })).outcome, 'reconciliation_required');
  assert.equal((await f.runner().createGuestProfile({ ...input, attemptId: 'next', retryOfAttemptId: input.attemptId })).issue, 'PROFILE_INTENT_HELD');
  assert.equal(reviewed, 0);
});

test('a corrupt final record retains the ID from an intact response without enabling recovery', async t => {
  const f = await fixture(t, async ({ dispatch }) => { await dispatch(success); return created; });
  await f.runner().createGuestProfile(input);
  const resultFile = (await readdir(f.dir)).find(name => name.endsWith('-result.json'));
  await writeFile(join(f.dir, resultFile), '{bad');
  const replay = await f.runner().createGuestProfile(input);
  assert.equal(replay.issue, 'PROFILE_JOURNAL_CORRUPT');
  assert.equal(replay.nativeId, '123');
  assert.equal(replay.dispatched, true);
  const read = await f.runner().readGuestProfile({ propertyCode: 'HRCEN', nativeId: '123', attemptId: input.attemptId });
  assert.equal(read.outcome, 'reconciliation_required');
  assert.equal(read.nativeId, '123');
  assert.equal(f.saves(), 1);
});

test('a new process holds a dispatch after the writer exits without a result', async t => {
  const f = await fixture(t, async () => { throw new Error('MUST_NOT_DISPATCH'); });
  const runnerUrl = new URL('./guest-profile-runner.mjs', import.meta.url).href;
  const code = `import { createGuestProfileRunner } from ${JSON.stringify(runnerUrl)};
    const input = ${JSON.stringify(input)}, fields = ${JSON.stringify(fields)};
    const runner = createGuestProfileRunner({ runtimeDir: process.argv[1], sessionOptions: { propertyCode: 'HRCEN' },
      authorizeStaffWrite: async () => true, dispatchStaffWrite: async (_context, proceed) => proceed(), dependencies: {
      writerCurrent: () => true,
      createGuestProfile: async (request, options) => {
        const context = { propertyCode: 'HRCEN', writer: {}, phase: 'initial', previewDigest: request.expectedPreviewDigest, confirmDuplicateName: true, fields };
        if (!await options.authorizeCandidate(context)) process.exit(2);
        await options.dispatchCandidate(context, async () => options.recordResponse(context, ${JSON.stringify(success)}));
        process.exit(0);
      }
    }});
    await runner.createGuestProfile(input); process.exit(3);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(exit, 0, stderr);
  const held = await f.runner().createGuestProfile(input);
  assert.equal(held.outcome, 'reconciliation_required');
  assert.equal(held.nativeId, '123');
  assert.equal(f.saves(), 0);
});
