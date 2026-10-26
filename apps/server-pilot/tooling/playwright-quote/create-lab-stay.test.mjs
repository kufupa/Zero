import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTrackReadyForGuarantee, loadCreateRequest, matchTrackRow, parseOutDir, parseShop, parseStopBefore, parseTrackLookupText, refuseRateRowClick, shopResult, shopRowsFromTexts, stayActions } from './create-request.mjs';
import { blankRequiredCreateFields, createLabtestRefusal, createRoomTypeMismatch, parseCreateProperty } from './create-lab-stay.mjs';
import { profileFor } from './property-profile.mjs';

function requiredRequest(extra = {}) {
  return {
    arrival: '2026-09-22',
    departure: '2026-09-23',
    adults: 1,
    sourceOfBusiness: 'Walk in',
    roomType: 'STQN',
    ratePlan: 'OPEN-CODE',
    track: 'BAR',
    firstName: 'Pat',
    lastName: 'Lee',
    guaranteeType: 'Awaiting Voucher',
    ...extra,
  };
}

async function withRequest(data, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'create-request-'));
  const path = join(dir, 'request.json');
  await writeFile(path, JSON.stringify(data));
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('offline create request test does not opt into pilot RDS', () => {
  assert.notEqual(process.env.VITEST_ALLOW_PILOT_RDS, '1');
  assert.equal(/nava-zero-mail-pilot/i.test(process.env.DATABASE_URL || ''), false);
});

test('adults 0 fails before any browser work', async () => {
  const loaded = await withRequest(requiredRequest({ adults: 0 }), (path) => loadCreateRequest(['--property', 'HRCEN', '--request', path]));
  assert.equal(loaded.ok, false);
  assert.notEqual(loaded.exitCode, 0);
  assert.match(loaded.error, /adults/);
});

test('valid required request passes', async () => {
  const request = requiredRequest();
  const loaded = await withRequest(request, (path) => loadCreateRequest(['--property', 'HRCEN', '--request', path]));
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.exitCode, 0);
  assert.deepEqual(loaded.request, request);
});

test('optional agency, organization, arAccount, billingReference, profileId pass', async () => {
  const request = requiredRequest({
    agency: 'ACME',
    organization: 'ACME Hotels',
    arAccount: 'AR1',
    billingReference: 'PO-1',
    profileId: 42,
  });
  const loaded = await withRequest(request, (path) => loadCreateRequest(['--property', 'HRCEN', '--request', path]));
  assert.equal(loaded.ok, true, loaded.error);
  assert.deepEqual(loaded.request, request);
});

test('guest nativeId normalizes to profileId before browser fill', async () => {
  const loaded = await withRequest(requiredRequest({
    profileId: { nativeId: '55', kind: 'guest' },
  }), (path) => loadCreateRequest(['--property', 'HRCEN', '--request', path]));
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.request.profileId, 55);
  const wrongKind = await withRequest(requiredRequest({
    profileId: { nativeId: '49', kind: 'organization' },
  }), (path) => loadCreateRequest(['--property', 'HRCEN', '--request', path]));
  assert.equal(wrongKind.ok, false);
  assert.match(wrongKind.error, /profileId/);
});

test('nativeId on name lookup fields is refused, never typed as text', async () => {
  for (const field of ['agency', 'organization', 'arAccount']) {
    const loaded = await withRequest(requiredRequest({ [field]: { nativeId: '49', kind: 'organization' } }), (path) => loadCreateRequest(['--property', 'HRCEN', '--request', path]));
    assert.equal(loaded.ok, false, `${field} must not accept nativeId`);
    assert.notEqual(loaded.exitCode, 0);
    assert.match(loaded.error, new RegExp(field));
  }
});

test('missing guaranteeType fails', async () => {
  const request = requiredRequest();
  delete request.guaranteeType;
  const loaded = await withRequest(request, (path) => loadCreateRequest(['--property', 'HRCEN', '--request', path]));
  assert.equal(loaded.ok, false);
  assert.notEqual(loaded.exitCode, 0);
  assert.match(loaded.error, /guaranteeType/);
});

test('boardBasis fails', async () => {
  const loaded = await withRequest(requiredRequest({ boardBasis: 'breakfast' }), (path) => loadCreateRequest(['--property', 'HRCEN', '--request', path]));
  assert.equal(loaded.ok, false);
  assert.notEqual(loaded.exitCode, 0);
  assert.match(loaded.error, /boardBasis/);
});

test('guestName fails', async () => {
  const loaded = await withRequest(requiredRequest({ guestName: 'Pat Lee' }), (path) => loadCreateRequest(['--property', 'HRCEN', '--request', path]));
  assert.equal(loaded.ok, false);
  assert.notEqual(loaded.exitCode, 0);
  assert.match(loaded.error, /guestName/);
});

test('room and track descriptions normalize to codes', async () => {
  const loaded = await withRequest(requiredRequest({
    roomType: 'Standard Queen',
    track: 'Best Available',
  }), (path) => loadCreateRequest(['--property', 'HRCEN', '--request', path]));
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.request.roomType, 'STQN');
  assert.equal(loaded.request.track, 'BAR');
});

test('--out takes one absolute directory; absent means the shared proof directory', () => {
  assert.deepEqual(parseOutDir(['--request', 'r.json']), { ok: true, exitCode: 0, outDir: null });
  assert.deepEqual(parseOutDir(['--out', '/tmp/pane-stay-run']), { ok: true, exitCode: 0, outDir: '/tmp/pane-stay-run' });
  assert.equal(parseOutDir(['--out', 'relative/dir']).ok, false);
  assert.equal(parseOutDir(['--out']).ok, false);
  assert.equal(parseOutDir(['--out', '--pane-commit']).ok, false);
});

test('--stop-before availability fills stay fields only', () => {
  const parsed = parseStopBefore(['--request', 'x.json', '--stop-before', 'availability']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.stopBefore, 'availability');
  const actions = stayActions(parsed.stopBefore);
  assert.deepEqual(actions, ['arrival', 'departure', 'adults', 'sourceOfBusiness', 'roomType', 'ratePlan', 'track', 'guaranteeType', 'filled.png']);
  assert.equal(actions.includes('firstName'), false);
  assert.equal(actions.includes('checkAvailability'), false);
  assert.equal(actions.includes('save'), false);
});

test('--stop-before save previews availability and does not Save Record', () => {
  const parsed = parseStopBefore(['--request', 'x.json', '--stop-before', 'save']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.stopBefore, 'save');
  const actions = stayActions(parsed.stopBefore);
  assert.equal(actions.includes('firstName'), true);
  assert.equal(actions.includes('lastName'), true);
  assert.equal(actions.includes('checkAvailability'), true);
  assert.equal(actions.includes('availability.png'), true);
  assert.equal(actions.includes('save'), false);
});

test('--pane-commit saves without holding a preview session', () => {
  const parsed = parseStopBefore(['--request', 'x.json', '--pane-commit']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.stopBefore, null);
  assert.equal(parsed.paneCommit, true);
  const actions = stayActions(null);
  assert.equal(actions.includes('save'), true);
});

test('missing --request fails before any browser work', async () => {
  const loaded = await loadCreateRequest([]);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.exitCode, 2);
  assert.match(loaded.error, /--request/);
  assert.equal(loaded.request, undefined);
});

test('create-lab-stay validates before browser and keeps shot names', async () => {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const loadCall = source.indexOf('await loadCreateRequest');
  const browserCall = source.indexOf('connectOverCDP');
  assert.ok(loadCall !== -1 && browserCall !== -1 && loadCall < browserCall);
  assert.match(source, /before\.png/);
  assert.match(source, /filled\.png/);
  assert.match(source, /availability\.png/);
  assert.match(source, /saved\.png/);
  assert.match(source, /Enter Child Ages/);
  assert.match(source, /refuseRateRowClick/);
  assert.match(source, /\^Search\$/);
  assert.match(source, /x-tool-close/);
  const shopReturn = source.indexOf("result.outcome = 'shop'");
  const checkAvail = source.indexOf("clickTip(page, '^Check Availability$'");
  const saveStop = source.indexOf("stop.stopBefore === 'save'");
  const saveClick = source.indexOf("clickTip(page, '^Save'");
  const paneCommit = source.indexOf('stop.paneCommit');
  const cancelClick = source.indexOf("clickTip(page, 'Cancel')");
  assert.ok(shopReturn !== -1 && saveClick !== -1 && shopReturn < saveClick);
  assert.ok(checkAvail !== -1 && saveStop !== -1 && checkAvail < saveStop && saveStop < saveClick);
  assert.ok(paneCommit !== -1 && cancelClick !== -1 && paneCommit < cancelClick);
  assert.match(source, /outcome = 'previewed'/);
  assert.match(source, /paneCommitOutcome\(proof\)/);
  assert.equal(source.includes('x-tree-expander'), false);
  assert.equal(source.includes('const LAB'), false);
  assert.equal(source.includes('Nava'), false);
  assert.equal(source.includes('Labcancel'), false);
  assert.match(source, /fillNamed\(page, 'track', description\)/);
  assert.match(source, /fillTrackBeforeGuarantee\(page, stay\.track\)/);
  assert.match(source, /ancestor::\*\[contains\(@class,"x-form-item"\) or contains\(@class,"x-field"\)\]\[1\]/);
  assert.match(source, /track_valid/);
});

test('proof mode is guarded before browser work and wires read-only reconciliation', async () => {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const proofGuard = source.indexOf('proofModeRefusal({');
  const createDir = source.indexOf('await mkdir(dir');
  const browserCall = source.indexOf('connectOverCDP');
  assert.ok(proofGuard !== -1 && proofGuard < createDir && createDir < browserCall);
  assert.match(source, /argv\.includes\('--proof'\)/);
  assert.match(source, /PROPERTY_HRCEN_REQUIRED/);
  assert.match(source, /installReadOnlyGuard/);
  assert.match(source, /await import\('\.\/stay-lookup\.mjs'\)/);
  assert.doesNotMatch(source, /import \{ findOnOpenGuestStay, searchGuestOnOpenGuestStay \} from '\.\/stay-lookup\.mjs'/);
  assert.match(source, /findOnOpenGuestStay/);
  assert.match(source, /searchGuestOnOpenGuestStay/);
  assert.match(source, /reconcileCreateSave/);
  assert.match(source, /saveClickMayHaveFired\(error\)/);
  assert.match(source, /save_click_unconfirmed/);
  assert.match(source, /result\.saved = proof\.confNo \? true : null/);
  for (const field of ['confNo', 'readbackMatch', 'mismatches', 'screenshot']) {
    assert.match(source, new RegExp(`${field}:`));
  }
});

test('childAges passes and --shop returns BAR rows without a row click', async () => {
  assert.equal(parseShop(['--request', 'x.json', '--shop']), true);
  assert.equal(parseShop(['--request', 'x.json']), false);
  const loaded = await withRequest(requiredRequest({ childAges: [5] }), (path) => loadCreateRequest(['--property', 'HRCEN', '--request', path, '--shop']));
  assert.equal(loaded.ok, true, loaded.error);
  assert.deepEqual(loaded.request.childAges, [5]);
  const rejected = await withRequest(requiredRequest({ childAges: [100] }), (path) => loadCreateRequest(['--property', 'HRCEN', '--request', path]));
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /childAges/);
  const shop = shopResult([], ['STQN', 'BAR Best Available Rate', 'Current Rates']);
  assert.equal(shop.salesStrategy, 'BAR');
  assert.equal(shop.rowClicked, false);
  assert.deepEqual(shop.rows, [{ roomType: 'STQN', code: 'BAR', name: 'Best Available Rate' }]);
  assert.deepEqual(shopRowsFromTexts(['HRCEN: The Centurion Hotel 160']), []);
  assert.throws(() => refuseRateRowClick(), /RATE_ROW_CLICK_REFUSED/);
});

test('create CLI exits after cleanup and both output streams have flushed', async () => {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const cleanup = source.indexOf('await context.close().catch(() => {});');
  const launcher = source.indexOf('main().then(', cleanup);
  const flushHelper = source.indexOf('async function flushOutput()', cleanup);
  assert.ok(cleanup !== -1 && launcher > cleanup);
  assert.ok(flushHelper > cleanup && flushHelper < launcher);
  assert.match(source, /process\.stdout\.write\('', resolveOutput\)/);
  assert.match(source, /process\.stderr\.write\('', resolveError\)/);
  const completion = source.slice(launcher);
  const stdoutFlush = completion.indexOf('await flushOutput()');
  const successExit = completion.indexOf('process.exit(process.exitCode ?? 0)');
  const errorHandler = completion.indexOf('(error) => {');
  const stderrWrite = completion.indexOf('process.stderr.write(', errorHandler);
  const stderrFlush = completion.indexOf('await flushOutput()', errorHandler);
  const errorExit = completion.indexOf('process.exit(2)', errorHandler);
  assert.ok(stdoutFlush !== -1 && successExit > stdoutFlush);
  assert.ok(errorHandler !== -1);
  assert.ok(stderrWrite > errorHandler);
  assert.ok(stderrFlush > stderrWrite);
  assert.ok(errorExit > stderrFlush);
});

test('proof mode refuses Save when the pre-save guest search is unavailable', async () => {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const preSaveSearch = source.indexOf('const existingRows = verifySave');
  const refusal = source.indexOf('proofPreSaveSearchRefusal(existingRows)');
  const saveClick = source.indexOf("await clickTip(page, '^Save')");
  assert.ok(preSaveSearch !== -1 && refusal > preSaveSearch && saveClick > refusal);
  assert.match(source, /result\.refusalReason = preSaveRefusal/);
  assert.match(source, /result\.clickedSave = false/);
});

test('readExistingGuestRows stays fail-closed and logs the swallowed error', async () => {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function readExistingGuestRows');
  const end = source.indexOf('async function findStayByConfirmation');
  assert.ok(start !== -1 && end > start);
  const fn = source.slice(start, end);
  assert.match(fn, /catch \(error\)/);
  assert.match(fn, /pre_save_search_error/);
  assert.match(fn, /preSaveSearchError/);
  assert.match(fn, /slice\(0,\s*300\)/);
  const catchBlock = fn.slice(fn.indexOf('catch (error)'));
  assert.match(catchBlock, /^catch \(error\) \{[\s\S]*return null;\s*\}\s*\}\s*$/);
  assert.equal(/return\s*\[/.test(catchBlock), false);
  assert.equal(fn.includes('clickTip(page, \'^Save\')'), false);
});

test('proof mode captures parsed search rows before Save', async () => {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const baseline = source.indexOf('const existingRows = verifySave');
  const saveClick = source.indexOf("await clickTip(page, '^Save')");
  assert.ok(baseline !== -1 && saveClick > baseline);
  assert.match(source, /return \{\s*outcome: found\.outcome,\s*rows: found\.rows,/);
  assert.match(source, /Array\.isArray\(search\.rows\) \? search\.rows : null/);
  assert.match(source, /existingRows\s*,/);
});

test('JS dialogs are dismissed and a vanished dialog does not crash', async () => {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const writePage = source.lastIndexOf('const page = await context.newPage()');
  const dialogOn = source.indexOf("page.on('dialog'", writePage);
  assert.ok(writePage !== -1);
  assert.ok(dialogOn > writePage, 'write page must install a dialog listener');
  const handler = source.slice(dialogOn, dialogOn + 220);
  assert.match(handler, /dismiss\(\)\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
  assert.doesNotMatch(handler, /\.accept\(/);
  assert.doesNotMatch(source, /dialog\.accept\(/);
});

test('HRCEN property check runs on every write, not only proof', async () => {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const secret = source.indexOf('const secret = await readSecret()');
  const propertyCheck = source.indexOf('secret.expectedPropertyCode !== propertyCode');
  const browserCall = source.indexOf('connectOverCDP');
  assert.ok(secret !== -1 && propertyCheck > secret && propertyCheck < browserCall);
  assert.equal(source.includes('proofMode && secret.expectedPropertyCode'), false);
  assert.match(source, /PROPERTY_HRCEN_REQUIRED/);
  assert.match(source, /PROPERTY_HRDAV_REQUIRED/);
  assert.equal(source.includes('PROOF_PROPERTY_HRCEN_REQUIRED'), false);
});

test('--property defaults to HRCEN, accepts HRDAV, refuses unknown', () => {
  assert.deepEqual(parseCreateProperty([]), { ok: true, propertyCode: 'HRCEN' });
  assert.deepEqual(parseCreateProperty(['--property', 'HRDAV']), { ok: true, propertyCode: 'HRDAV' });
  assert.deepEqual(parseCreateProperty(['--property', 'OTHER']), {
    ok: false,
    exitCode: 2,
    error: 'PROPERTY_UNKNOWN',
  });
});

test('HRDAV profile accepts STKNG/JNRSUI and refuses Centurion SUITE/STQN', () => {
  const hrdav = profileFor('HRDAV');
  assert.equal(createRoomTypeMismatch(hrdav, 'STKNG'), null);
  assert.equal(createRoomTypeMismatch(hrdav, 'JNRSUI'), null);
  assert.equal(createRoomTypeMismatch(hrdav, 'STQN'), 'ROOM_TYPE_PROPERTY_MISMATCH');
  assert.equal(createRoomTypeMismatch(hrdav, 'SUITE'), 'ROOM_TYPE_PROPERTY_MISMATCH');
  assert.equal(createRoomTypeMismatch(profileFor('HRCEN'), 'STQN'), null);
});

test('HRDAV create with a blank reservation note is refused before Save; HRCEN allows it', () => {
  const filled = {
    arrivaldate: '01-JAN-2027',
    departuredate: '02-JAN-2027',
    adults: '1',
    sourceofbusinessdesc: 'Walk in',
    roomtype: 'STKNG',
    rateplan: 'BAR',
    track: 'BAR',
    firstname: 'Proof',
    lastname: 'Labtest',
    guaranteetype: 'Non-Guaranteed Individual',
  };
  assert.deepEqual(blankRequiredCreateFields(profileFor('HRDAV'), filled), ['reservationnote']);
  assert.deepEqual(blankRequiredCreateFields(profileFor('HRDAV'), { ...filled, reservationnote: '   ' }), ['reservationnote']);
  assert.deepEqual(blankRequiredCreateFields(profileFor('HRDAV'), { ...filled, reservationnote: 'late arrival' }), []);
  assert.deepEqual(blankRequiredCreateFields(profileFor('HRCEN'), { ...filled, reservationnote: '' }), []);
});

test('HRDAV Labtest guard is lab-only', () => {
  assert.equal(
    createLabtestRefusal('HRDAV', { lastName: 'Guest', arrival: '2027-09-14' }, { HMS_DAVINCI_CREATE: 'lab' }),
    'pane_save_labtest_required',
  );
  assert.equal(
    createLabtestRefusal('HRDAV', { lastName: 'Labtest', arrival: '2026-12-31' }, { HMS_DAVINCI_CREATE: 'lab' }),
    'pane_save_arrival_2027_required',
  );
  assert.equal(
    createLabtestRefusal('HRDAV', { lastName: 'Guest', arrival: '2026-11-12' }, { HMS_DAVINCI_CREATE: 'on' }),
    null,
  );
});

test('pane-commit uses the proof snapshot and reconcile, and never labels a mismatch committed', async () => {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const verify = source.indexOf('const verifySave = proofMode || stop.paneCommit');
  const existing = source.indexOf('const existingRows = verifySave');
  const readback = source.indexOf('runProofReadback');
  const paneOutcome = source.indexOf('paneCommitOutcome(proof)');
  const saveClick = source.indexOf("await clickTip(page, '^Save')");
  assert.ok(verify !== -1 && existing > verify && existing < saveClick);
  assert.ok(readback !== -1 && paneOutcome > readback);
  assert.equal(source.includes("result.outcome = 'committed'"), false);
});

test('Track picker selects Best Available and stores BAR', () => {
  const rows = [
    parseTrackLookupText('COR Corporate Rate'),
    parseTrackLookupText('BAR Best Available'),
  ];
  const byDescription = matchTrackRow(rows, 'Best Available');
  assert.equal(byDescription.description, 'Best Available');
  assert.equal(byDescription.code, 'BAR');
  const byCode = matchTrackRow(rows, 'BAR');
  assert.equal(byCode.description, 'Best Available');
  assert.equal(byCode.code, 'BAR');
});

test('red track validation fails before guarantee opens', () => {
  let guaranteeOpened = false;
  assert.throws(
    () => {
      assertTrackReadyForGuarantee({
        validation: { invalid: true, messages: ['Invalid value'] },
        averageRate: '1250.00',
      });
      guaranteeOpened = true;
    },
    /track_invalid:Invalid value/,
  );
  assert.equal(guaranteeOpened, false);
  assert.doesNotThrow(() =>
    assertTrackReadyForGuarantee({ validation: { invalid: false, messages: [] } }),
  );
});

const LAB_STAY = { lastName: 'Labtest', arrival: '2027-06-01' };
const ALLOWED_BOX = 'There are no rooms or openings for this process.';

async function loadExtMessageBoxRules() {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('// --- ext-message-box-rules ---');
  const end = source.indexOf('// --- end-ext-message-box-rules ---');
  assert.ok(start !== -1 && end > start, 'create-lab-stay.mjs must export the ext message-box rules block');
  return import(`data:text/javascript,${encodeURIComponent(source.slice(start, end))}`);
}

test('ext message-box allowlist equals the informational text and refuses money words', async () => {
  const { classifyExtMessageBox, extMessageBoxAction } = await loadExtMessageBoxRules();
  assert.equal(classifyExtMessageBox(`  ${ALLOWED_BOX}  `), 'allow');
  assert.equal(extMessageBoxAction(ALLOWED_BOX, LAB_STAY), 'ok');
  assert.equal(extMessageBoxAction(ALLOWED_BOX, { lastName: 'Smith', arrival: '2027-06-01' }), 'unknown');
  assert.equal(extMessageBoxAction(ALLOWED_BOX, { lastName: 'Labtest', arrival: '2026-06-01' }), 'unknown');
  for (const word of ['penalty', 'CHARGE', 'Cancel', 'deposit', 'no-show', 'payment']) {
    assert.equal(classifyExtMessageBox(`Please confirm ${word} to continue.`), 'refuse');
    assert.equal(extMessageBoxAction(`Please confirm ${word} to continue.`, LAB_STAY), 'refuse');
  }
  assert.equal(classifyExtMessageBox('Session timed out.'), 'unknown');
  assert.equal(extMessageBoxAction('Session timed out.', LAB_STAY), 'unknown');
  assert.equal(classifyExtMessageBox(''), 'unknown');
});

test('ext message-box handler is Labtest-only, never accepts JS dialogs, never clicks Save for the box', async () => {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const checkAvail = source.indexOf("clickTip(page, '^Check Availability$'");
  const handleBox = source.indexOf('handleVisibleExtMessageBox(', checkAvail);
  const saveClick = source.indexOf("clickTip(page, '^Save'");
  assert.ok(checkAvail !== -1 && handleBox > checkAvail && saveClick > handleBox);
  assert.match(source, /data-testid=["']message-box["']/);
  assert.match(source, /x-message-box/);
  assert.match(source, /There are no rooms or openings for this process\./);
  assert.match(source, /penalty\|charge\|cancel\|deposit\|no-show\|payment/);
  assert.doesNotMatch(source, /dialog\.accept\(/);
  const okClick = source.indexOf('hasText: /^OK$/');
  assert.ok(okClick !== -1 && okClick < saveClick);
  assert.match(source, /shot\(page, dir, 'failure\.png'\)/);
});

test('after Save, allowlisted Ext box continues waitForSaveConfirmation and proof; money/unknown abort', async () => {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const saveClick = source.indexOf("clickTip(page, '^Save'");
  assert.ok(saveClick !== -1);
  const afterSave = source.slice(saveClick);
  const wait = afterSave.indexOf('waitForSaveConfirmation(');
  const extraWait = afterSave.indexOf('waitWhileStillProcessing(');
  const proof = afterSave.indexOf('runProofReadback');
  assert.ok(wait !== -1 && extraWait > wait && proof > extraWait);
  const waitBlock = afterSave.slice(wait, wait + 900);
  assert.match(waitBlock, /handleVisibleExtMessageBox/);
  assert.match(waitBlock, /readSaveSnapshot/);
  const abortGuard = afterSave.indexOf('messageBoxAbort');
  const abortExit = afterSave.indexOf('process.exitCode = 2', abortGuard);
  assert.ok(abortGuard !== -1 && abortExit > abortGuard);
  assert.equal([...afterSave.matchAll(/clickTip\(page, '\^Save'/g)].length, 1);
});

async function loadReadbackRules() {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('// --- create-readback-rules ---');
  const end = source.indexOf('// --- end-create-readback-rules ---');
  assert.ok(start !== -1 && end > start, 'create-lab-stay.mjs must export the create-readback-rules block');
  return import(`data:text/javascript,${encodeURIComponent(source.slice(start, end))}`);
}

const READBACK_EXPECTED = {
  firstName: 'Proof',
  lastName: 'Labtest',
  arrival: '2027-12-08',
  departure: '2027-12-09',
  roomType: 'STQN',
  adults: 1,
};

test('readback compare normalizes last name, ISO dates, room code, and adults', async () => {
  const rules = await loadReadbackRules();
  assert.equal(rules.isoStayDate('08-DEC-2027'), '2027-12-08');
  assert.equal(rules.isoStayDate('2027-12-08'), '2027-12-08');
  assert.equal(rules.normalizeRoomTypeCode('stqn Standard Queen'), 'STQN');
  assert.deepEqual(rules.compareReadbackStay(READBACK_EXPECTED, {
    firstName: 'PROOF',
    lastName: 'LABTEST',
    arrival: '08-DEC-2027',
    departure: '09-Dec-2027',
    roomType: 'STQN Standard Queen',
    adults: '1',
  }), { readbackMatch: true, mismatches: [], unknownOutcome: null });
});

test('readback compare never matches a cancelled or inactive stay', async () => {
  const rules = await loadReadbackRules();
  const reserved = { ...READBACK_EXPECTED, status: 'Reserved', confirmation: '66865808-1' };
  const cancelled = { ...READBACK_EXPECTED, status: 'Cancelled', confirmation: '66865808-1' };
  const matched = rules.mergeReadbackCompare(
    { confNo: '66865808-1', readbackMatch: null, mismatches: [], unknownOutcome: 'unresolved' },
    READBACK_EXPECTED,
    reserved,
  );
  assert.equal(matched.readbackMatch, true);
  const rejected = rules.mergeReadbackCompare(
    { confNo: '66865808-1', readbackMatch: null, mismatches: [], unknownOutcome: 'unresolved' },
    READBACK_EXPECTED,
    cancelled,
  );
  assert.equal(rejected.readbackMatch, null);
  assert.equal(rejected.unknownOutcome, 'unresolved');
});

test('inactive, wrong-conf, and error readback cannot stay committed', async () => {
  const rules = await loadReadbackRules();
  const alreadyMatched = {
    confNo: '66865808-1',
    readbackMatch: true,
    mismatches: [],
    unknownOutcome: null,
  };
  const expected = READBACK_EXPECTED;
  const cases = [
    ['missing lastStay', null],
    ['cancelled', { ...expected, status: 'Cancelled', confirmation: '66865808-1' }],
    ['wrong conf', { ...expected, status: 'Reserved', confirmation: '999-1' }],
    ['missing conf', { ...expected, status: 'Reserved' }],
  ];
  for (const [label, lastStay] of cases) {
    const merged = rules.mergeReadbackCompare(alreadyMatched, expected, lastStay);
    assert.equal(merged.readbackMatch, null, label);
    assert.equal(merged.unknownOutcome, 'unresolved', label);
    const { paneCommitOutcome } = await import('./create-proof-rules.mjs');
    assert.equal(paneCommitOutcome(merged), 'committed_unverified', label);
  }
});

test('readback compare reports field mismatches and stays unknown when a compared field is missing', async () => {
  const rules = await loadReadbackRules();
  assert.deepEqual(rules.compareReadbackStay(READBACK_EXPECTED, {
    firstName: 'Ada',
    lastName: 'Other',
    arrival: '2027-12-10',
    departure: '2027-12-11',
    roomType: 'STWN',
    adults: 2,
  }), {
    readbackMatch: false,
    mismatches: [
      { field: 'firstName', expected: 'Proof', actual: 'Ada' },
      { field: 'lastName', expected: 'Labtest', actual: 'Other' },
      { field: 'arrival', expected: '2027-12-08', actual: '2027-12-10' },
      { field: 'departure', expected: '2027-12-09', actual: '2027-12-11' },
      { field: 'roomType', expected: 'STQN', actual: 'STWN' },
      { field: 'adults', expected: 1, actual: 2 },
    ],
    unknownOutcome: null,
  });
  assert.deepEqual(rules.compareReadbackStay(READBACK_EXPECTED, {
    firstName: 'Proof',
    lastName: 'Labtest',
    arrival: '2027-12-08',
    departure: '2027-12-09',
    roomType: 'STQN',
  }), { readbackMatch: null, mismatches: [], unknownOutcome: 'unresolved' });
  assert.equal(rules.compareReadbackStay(READBACK_EXPECTED, null).readbackMatch, null);
});

test('still_processing polls until the mask is gone or the 60s bound', async () => {
  const rules = await loadReadbackRules();
  assert.equal(rules.READBACK_WAIT_MS, 60_000);
  assert.equal(rules.saveStillProcessingDecision({
    reason: 'still_processing', maskVisible: true, confirmationNumber: '', elapsedMs: 0,
  }), 'poll');
  assert.equal(rules.saveStillProcessingDecision({
    reason: 'still_processing', maskVisible: true, confirmationNumber: '66865808-1', elapsedMs: 59_000,
  }), 'poll');
  assert.equal(rules.saveStillProcessingDecision({
    reason: 'still_processing', maskVisible: true, confirmationNumber: '', elapsedMs: 60_000,
  }), 'stop');
  assert.equal(rules.saveStillProcessingDecision({
    maskVisible: false, confirmationNumber: '66865808-1', elapsedMs: 1_000,
  }), 'stop');
});

test('still_processing wait reads the form with fakes and never retries Save', async () => {
  const rules = await loadReadbackRules();
  const frames = [
    { maskVisible: true, confirmationNumber: '', status: 'New' },
    { maskVisible: true, confirmationNumber: '66865808-1', status: 'New' },
    { maskVisible: false, confirmationNumber: '66865808-1', status: 'Reserved' },
  ];
  let clock = 0;
  let reads = 0;
  const save = await rules.waitWhileStillProcessing({
    reason: 'still_processing',
    timeoutMs: 60_000,
    pollMs: 5_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    read: async () => frames[Math.min(reads++, frames.length - 1)],
  });
  assert.deepEqual(save, {
    confirmed: true,
    confirmationNumber: '66865808-1',
    status: 'Reserved',
    reason: null,
  });
  assert.equal(reads, 3);
  assert.equal(clock, 10_000);

  let lateClock = 0;
  const timedOut = await rules.waitWhileStillProcessing({
    reason: 'still_processing',
    timeoutMs: 60_000,
    pollMs: 5_000,
    now: () => lateClock,
    sleep: async (ms) => { lateClock += ms; },
    read: async () => ({ maskVisible: true, confirmationNumber: '', status: 'New' }),
  });
  assert.equal(timedOut.confirmed, false);
  assert.equal(timedOut.reason, 'still_processing');
  assert.equal(lateClock, 60_000);

  let maskedClock = 0;
  const masked = await rules.waitWhileStillProcessing({
    reason: 'still_processing',
    confirmationNumber: '66865808-1',
    timeoutMs: 60_000,
    pollMs: 5_000,
    now: () => maskedClock,
    sleep: async (ms) => { maskedClock += ms; },
    read: async () => ({ maskVisible: true, confirmationNumber: '66865808-1', status: 'New' }),
  });
  assert.equal(masked.confirmed, false);
  assert.equal(rules.reconcileSaveInput(masked).confirmed, false);
  assert.equal(maskedClock, 60_000);
});

test('confirmation find passes expected arrival so HMS can move the 60-day window', async () => {
  const rules = await loadReadbackRules();
  assert.deepEqual(rules.confirmationFindLookupArgs({
    lastName: 'Labtest',
    arrival: '2027-12-08',
    departure: '2027-12-09',
  }, '66865808-1'), {
    mode: 'find',
    confirmation: '66865808-1',
    arrival: '2027-12-08',
    departure: '2027-12-09',
    lastName: 'Labtest',
    debugHtml: false,
  });
  assert.equal(rules.confirmationFindLookupArgs({ lastName: 'Labtest' }, '66865808-1').arrival, null);
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  const fn = source.slice(
    source.indexOf('async function findStayByConfirmation'),
    source.indexOf('async function runProofReadback'),
  );
  assert.match(fn, /confirmationFindLookupArgs\(stay, confirmation\)/);
  assert.equal(fn.includes('arrival: null'), false);
});

test('readback finds by confirmation when known, else guest last name + arrival, and polls not-found', async () => {
  const rules = await loadReadbackRules();
  assert.deepEqual(rules.readbackSearchPlan({ confirmed: true, confirmationNumber: ' 82126330-1 ' }), {
    by: 'confirmation', confirmation: '82126330-1',
  });
  assert.deepEqual(rules.readbackSearchPlan({ confirmationNumber: '', confirmed: false }), { by: 'guest' });
  assert.deepEqual(rules.readbackSearchPlan({
    confirmed: false, confirmationNumber: '66865808-1', reason: 'still_processing',
  }), { by: 'guest' });
  assert.equal(rules.reconcileSaveInput({
    confirmed: false, confirmationNumber: '66865808-1', reason: 'still_processing',
  }).confirmed, false);
  assert.deepEqual(rules.reconcileSaveInput({
    confirmed: true, confirmationNumber: '66865808-1',
  }), { confirmed: true, confirmationNumber: '66865808-1' });
  const calls = [];
  let clock = 0;
  const found = await rules.pollReadbackLookup(async () => {
    calls.push(calls.length);
    return calls.length < 3
      ? { outcome: 'not_found', stay: null }
      : { outcome: 'found', stay: { ...READBACK_EXPECTED, confirmation: '66865808-1' } };
  }, {
    timeoutMs: 60_000,
    pollMs: 5_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    isReady: (result) => rules.confirmationLookupReady(result, '66865808-1'),
  });
  assert.equal(found.outcome, 'found');
  assert.equal(calls.length, 3);
  assert.equal(rules.guestLookupReady({ outcome: 'ok', rows: [{ confirmation: '1' }] }), true);
  assert.equal(rules.guestLookupReady({ outcome: 'ok', rows: [] }), false);
  assert.equal(rules.newGuestRowReady({
    outcome: 'ok', rows: [{ confirmation: '61143613-1' }],
  }, [{ confirmation: '61143613-1' }]), false);
  assert.equal(rules.newGuestRowReady({
    outcome: 'ok', rows: [{ confirmation: '66865808-1' }],
  }, [{ confirmation: '61143613-1' }]), true);
});

test('readback is found only for the searched confirmation, not an already-open form', async () => {
  const rules = await loadReadbackRules();
  const openForm = {
    ...READBACK_EXPECTED,
    firstName: 'Ada',
    confirmation: '66865808-1',
    status: 'Reserved',
  };
  assert.equal(rules.confirmationLookupReady({ outcome: 'found', stay: openForm }, '82126330-1'), false);
  assert.equal(rules.confirmationLookupReady({ outcome: 'not_found', stay: openForm }, '66865808-1'), false);
  assert.equal(rules.dropUnsearchedStay({ outcome: 'not_found', stay: openForm }, '66865808-1').stay, null);
  assert.equal(rules.dropUnsearchedStay({ outcome: 'found', stay: openForm }, '82126330-1').stay, null);
  const compared = rules.compareReadbackStay(READBACK_EXPECTED, openForm);
  assert.equal(compared.readbackMatch, false);
  assert.equal(compared.mismatches[0].field, 'firstName');
  const merged = rules.mergeReadbackCompare({
    confNo: '66865808-1', readbackMatch: true, mismatches: [], unknownOutcome: null,
  }, READBACK_EXPECTED, openForm);
  assert.equal(merged.readbackMatch, false);
  const { paneCommitOutcome } = await import('./create-proof-rules.mjs');
  assert.equal(paneCommitOutcome(merged), 'committed_unverified');
  assert.equal(rules.confirmationLookupReady({
    outcome: 'found', stay: { ...READBACK_EXPECTED, confirmation: '66865808-1' },
  }, '66865808-1'), true);
});

test('pane-commit readback uses normalized compare and known confirmation, never a second Save', async () => {
  const source = await readFile(new URL('./create-lab-stay.mjs', import.meta.url), 'utf8');
  assert.match(source, /compareReadbackStay\(/);
  assert.match(source, /readbackSearchPlan\(/);
  assert.match(source, /reconcileSaveInput\(/);
  assert.match(source, /pollReadbackLookup\(/);
  assert.match(source, /knownConfirmation\(/);
  const saveClicks = [...source.matchAll(/clickTip\(page, '\^Save'/g)];
  assert.equal(saveClicks.length, 1);
});
