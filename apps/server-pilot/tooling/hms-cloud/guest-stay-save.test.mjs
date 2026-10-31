import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { installPageRequestFence } from './page-request-fence.mjs';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import {
  guestStaySaveOutcome,
  installLabtestCreateSaveRouteChain,
  matchesFullCreateBody,
  createSelectionProofTokensMatch,
  saveNewLabtestStay,
} from './guest-stay-save.mjs';

const require = createRequire(new URL('../stagehand/package.json', import.meta.url));
const { chromium } = require('playwright');
const SAVE_PATH = '/web/base/OSRESV.HDR';
const controls = {
  SYSTEM_FUNCTION_NAME: 'OSRESV',
  USER_FUNCTION_NAME: 'OSRESV',
  CURRENT_TAB_NAME: 'HDR',
};
const saveInputs = {
  preimageId: 'offline-preimage',
  arrival: '2027-12-29',
  departure: '2027-12-31',
  guestId: '1234567',
  roomType: 'STQN',
  ratePlan: 'BAR',
  guaranteeType: 'NGI',
  note: 'synthetic offline proof',
};

const chromiumBinary = [
  process.env.HMS_TEST_CHROMIUM_PATH,
  chromium.executablePath(),
  '/home/ubuntu/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  '/home/orca/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',
].find((candidate) => typeof candidate === 'string' && existsSync(candidate));

function createModelData() {
  return {
    propertycode: 'HRCEN',
    adults: 2,
    children: 1,
    childages: '8',
    child1: 0,
    child2: 1,
    child3: 0,
    sourceofbus: 'EMAIL',
    sourceofbusinessdesc: 'E-Mail',
    taid1: '77',
    ta1: 'Test Agency',
    bookingagency1iatanumber: '123456',
    company: '',
    groupname: '',
    bacontract: '',
    taid2: '',
    udfchkbox04: '0',
    udfchar13: '',
    emailaddress: '',
    guaranteecreditcardid: '',
    leaseguaranteecreditcardid: '',
    arprofileid: '',
    araccountid: '',
    sessionID: { sessionID: 'OFFLINE-SESSION' },
  };
}

function createSaveBody(formData) {
  const body = new URLSearchParams();
  for (const [key, original] of Object.entries(formData)) {
    const value = key === 'sessionID' && original && typeof original === 'object'
      ? original.sessionID
      : original;
    body.set(key, String(value ?? ''));
  }
  for (const [key, value] of Object.entries(controls)) body.set(key, value);
  return body;
}

function pageStub() {
  return {
    on() {},
    off() {},
    locator() { return { count: async () => 0 }; },
    evaluate: async () => null,
  };
}

test('matches every supplied model value and the three fixed controls', () => {
  const formData = createModelData();
  assert.equal(matchesFullCreateBody(createSaveBody(formData), formData), true);
});

test('rejects create-body drift, omissions, duplicates, extras, and unsupported values', () => {
  const formData = createModelData();

  const changedSideEffect = createSaveBody(formData);
  changedSideEffect.set('emailaddress', 'unexpected@example.invalid');
  assert.equal(matchesFullCreateBody(changedSideEffect, formData), false);

  const changedAgency = createSaveBody(formData);
  changedAgency.set('bookingagency1iatanumber', '654321');
  assert.equal(matchesFullCreateBody(changedAgency, formData), false);

  const missing = createSaveBody(formData);
  missing.delete('groupname');
  assert.equal(matchesFullCreateBody(missing, formData), false);

  const extra = createSaveBody(formData);
  extra.set('unexpected', '1');
  assert.equal(matchesFullCreateBody(extra, formData), false);

  const duplicate = createSaveBody(formData);
  duplicate.append('adults', '2');
  assert.equal(matchesFullCreateBody(duplicate, formData), false);

  const wrongControl = createSaveBody(formData);
  wrongControl.set('CURRENT_TAB_NAME', 'OTHER');
  assert.equal(matchesFullCreateBody(wrongControl, formData), false);

  const unsupported = { ...formData, unrelatedObject: { nested: true } };
  assert.equal(matchesFullCreateBody(createSaveBody(unsupported), unsupported), false);
});

test('preserves the legacy childless core-only input path', async () => {
  const result = await saveNewLabtestStay(pageStub(), saveInputs);
  assert.equal(result.outcome, 'not_dispatched');
  assert.equal(result.issue, 'LABTEST_DRAFT_UNVERIFIED');
});

test('requires field and agency selections to share the current Labtest draft token', async () => {
  const currentToken = 'draft-token-current';
  const createFields = { profileProofToken: currentToken };
  const agency = { profileProofToken: currentToken };
  assert.equal(createSelectionProofTokensMatch(createFields, agency, currentToken), true);
  assert.equal(createSelectionProofTokensMatch(createFields, agency, 'draft-token-other'), false);
  assert.equal(createSelectionProofTokensMatch(createFields, { profileProofToken: 'draft-token-other' }, currentToken), false);
  assert.equal(createSelectionProofTokensMatch(null, null, currentToken), true);

  const result = await saveNewLabtestStay(pageStub(), {
    ...saveInputs,
    createFieldProof: {
      adults: 2,
      childAgeSelection: { outcome: 'updated_unsaved', requestedChildAges: [8], actualChildAges: [8],
        ageBandCounts: { child1: 0, child2: 1, child3: 0 } },
      sourceSelection: { outcome: 'selected_unsaved', searchId: 'old-search', nativeCode: 'EMAIL',
        candidate: { nativeCode: 'EMAIL', description: 'E-Mail' },
        nativeCodeReadback: { outcome: 'unsupported', issue: 'SOURCE_CODE_NOT_EXPOSED_ON_FORM' },
        identityEvidence: 'unique_current_picker_row_and_description_readback' },
    },
  });
  assert.equal(result.outcome, 'input_gap');
  assert.equal(result.issue, 'CREATE_FIELD_PROOF_INVALID_OR_UNSUPPORTED');
});

test('keeps the context-wide save/send fence through delayed and cross-page requests', {
  skip: !chromiumBinary,
  timeout: 30_000,
}, async () => {
  let saveArrivals = 0;
  let sendArrivals = 0;
  const releaseApprovedResponses = [];
  let markApprovedReachedServer;
  let approvedArrivalTimer;
  const approvedReachedServer = new Promise((resolve) => {
    markApprovedReachedServer = () => { clearTimeout(approvedArrivalTimer); resolve(); };
  });
  const server = createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (request.method === 'POST' && pathname === '/web/base/send-email') {
      sendArrivals += 1;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end();
      return;
    }
    if (request.method === 'POST' && pathname === SAVE_PATH) {
      saveArrivals += 1;
      markApprovedReachedServer();
      releaseApprovedResponses.push(() => { if (!response.headersSent) { response.writeHead(200); response.end(); } });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>offline guard test</title>');
  });

  let browser;
  let context;
  let chain;
  let scope;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, executablePath: chromiumBinary });
    context = await browser.newContext();
    await installReadOnlyGuard(context);
    const page = await context.newPage();
    await page.goto(origin);
    const frame = page.mainFrame();
    let passedFence = 0;
    await page.route('**/*', async (route) => {
      if (new URL(route.request().url()).pathname === SAVE_PATH) passedFence += 1;
      return route.fallback();
    });

    const fence = await installPageRequestFence(page, [SAVE_PATH]);
    scope = fence.open();
    let armed = false;
    let possiblyDispatched = false;
    let dispatched = false;
    let blocked = 0;
    let blockedAfterDispatch = 0;
    chain = await installLabtestCreateSaveRouteChain(page, {
      frame,
      fence,
      scope,
      isArmed: () => armed,
      matches: (request, requestFrame) => {
        if (requestFrame !== frame || request.method() !== 'POST') return false;
        const url = new URL(request.url());
        return url.pathname === SAVE_PATH && [...url.searchParams].length === 1 &&
          url.searchParams.get('pageaction') === 'SAVE' &&
          new URLSearchParams(request.postData() || '').get('intent') === 'approved-once';
      },
      onCandidate: () => { possiblyDispatched = true; },
      onDispatch: () => {
        dispatched = true;
        armed = false;
      },
      onBlocked: () => {
        blocked += 1;
        if (dispatched) blockedAfterDispatch += 1;
      },
    });

    const post = (targetPage, intent) => targetPage.evaluate(async (postIntent) => {
      try {
        const response = await fetch('/web/base/OSRESV.HDR?pageaction=SAVE', {
          method: 'POST', body: new URLSearchParams({ intent: postIntent }),
        });
        return response.status;
      } catch { return 'blocked'; }
    }, intent);
    const send = (targetPage) => targetPage.evaluate(async () => {
      try {
        const response = await fetch('/web/base/send-email', {
          method: 'POST', body: new URLSearchParams({ intent: 'delayed-synthetic-send' }),
        });
        return response.status;
      } catch { return 'blocked'; }
    });
    assert.equal(await post(page, 'not-approved'), 'blocked');
    assert.equal(saveArrivals, 0);
    assert.equal(passedFence, 0);

    armed = true;
    const approvedResponse = post(page, 'approved-once');
    const approvedArrivalTimeout = new Promise((_, reject) => {
      approvedArrivalTimer = setTimeout(() => reject(new Error('APPROVED_REQUEST_NOT_RECEIVED')), 5000);
    });
    await Promise.race([approvedReachedServer, approvedArrivalTimeout]);
    assert.equal(dispatched, true);

    const otherPage = await context.newPage();
    await otherPage.goto(origin);
    assert.equal(await post(otherPage, 'unexpected-during-response'), 'blocked');
    assert.equal(await send(otherPage), 'blocked');
    assert.ok(blockedAfterDispatch >= 2);

    releaseApprovedResponses.forEach((release) => release());
    const httpStatus = await approvedResponse;
    assert.equal(httpStatus, 200);
    assert.equal(guestStaySaveOutcome({ dispatched: true, possiblyDispatched: true, httpStatus,
      hasConfirmation: true, nativeDialog: null, dialogs: 0, blockedAfterDispatch: 0 }), 'saved_same_form');
    assert.equal(guestStaySaveOutcome({ dispatched, possiblyDispatched, httpStatus, hasConfirmation: true,
      nativeDialog: null, dialogs: 0, blockedAfterDispatch }), 'uncertain');

    chain.disarm();
    scope.close();
    await chain.close();
    assert.equal(await send(page), 'blocked');
    assert.equal(await post(otherPage, 'delayed-save'), 'blocked');
    assert.equal(await send(otherPage), 'blocked');
    assert.equal(sendArrivals, 0);
    assert.equal(saveArrivals, 1);
    assert.equal(passedFence, 1);
    assert.ok(blocked >= 6);
  } finally {
    clearTimeout(approvedArrivalTimer);
    releaseApprovedResponses.forEach((release) => release());
    scope?.close();
    await chain?.close();
    await context?.close();
    await browser?.close();
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});
