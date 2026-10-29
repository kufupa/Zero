import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as quote from './session-reuse.mjs';

const secret = {
  loginUrl: 'https://example.invalid/login',
  username: 'user',
  password: 'secret',
  expectedTenant: 'tenant',
  expectedPropertyCode: 'HRCEN',
  expectedPropertyName: 'Hotel',
};

const LOGIN_CALLERS = [
  // fetch-quote delegates context creation; both property paths are exercised in fetch-quote.test.mjs.
  'stay-lookup.mjs',
  'read-reservation-codes.mjs',
  'read-reservation-fields.mjs',
  'hms-deeplink-probe.mjs',
  'party-lookup.mjs',
  'find-batch.mjs',
  'cancel-stay.mjs',
  'create-lab-stay.mjs',
  'amend-stay.mjs',
  'attach-document.mjs',
  'cancel-lab-stay.mjs',
];

function readyDocument(bodyText = 'Hotel') {
  return {
    documentElement: { outerHTML: '', dataset: { tenant: 'tenant', propertyCode: 'HRCEN' } },
    querySelectorAll: () => [],
    body: bodyText === null ? null : { innerText: bodyText },
  };
}

function fakePage({ readyOn = 1, fills = [], formCount = 1 } = {}) {
  let reads = 0;
  const control = {
    fill: async (value) => { fills.push(value); },
    press: async () => {},
    count: async () => formCount,
    click: async () => {},
  };
  return {
    fills,
    reads: () => reads,
    goto: async () => {},
    locator: () => control,
    getByRole: () => control,
    evaluate: async (fn, arg) => {
      reads += 1;
      const body = reads >= readyOn ? readyDocument('Hotel') : readyDocument(null);
      return vm.runInNewContext(`(${fn.toString()})(arg)`, { arg, document: body, location: { href: secret.loginUrl } });
    },
  };
}

test('slotStorageStatePath is next to the profile directory, never inside it', () => {
  assert.equal(quote.slotStorageStatePath({}), null);
  assert.equal(quote.slotStorageStatePath({ HMS_SLOT_PROFILE_DIR: '' }), null);
  assert.equal(
    quote.slotStorageStatePath({ HMS_SLOT_PROFILE_DIR: '/var/lib/nava/hms-slot/hrcen/profile' }),
    '/var/lib/nava/hms-slot/hrcen/storageState.json',
  );
  const explicit = '/var/lib/nava/hms-slot/hrcen/storageState.json';
  assert.equal(
    quote.slotStorageStatePath({
      HMS_SLOT_STORAGE_STATE: explicit,
      HMS_SLOT_PROFILE_DIR: '/tmp/other/profile',
    }),
    explicit,
  );
  assert.equal(quote.slotStorageStatePath({ HMS_SLOT_STORAGE_STATE: 'relative/storageState.json' }), null);
});

test('newBorrowedContext omits storageState when the slot file is missing', async () => {
  const calls = [];
  const browser = { newContext: async (opts) => { calls.push(opts); return opts; } };
  await quote.newBorrowedContext(
    browser,
    { viewport: { width: 1280, height: 720 } },
    { HMS_SLOT_PROFILE_DIR: '/no/such/slot/profile' },
  );
  assert.equal(Object.hasOwn(calls[0], 'storageState'), false);
  assert.equal(calls[0].viewport.width, 1280);
});

test('newBorrowedContext loads a 0600 storageState file next to the profile', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hms-slot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = join(dir, 'profile');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const statePath = join(dir, 'storageState.json');
  await writeFile(statePath, JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 });
  const calls = [];
  const browser = { newContext: async (opts) => { calls.push(opts); return opts; } };
  await quote.newBorrowedContext(browser, { ignoreHTTPSErrors: true }, { HMS_SLOT_PROFILE_DIR: profile });
  assert.equal(calls[0].storageState, statePath);
});

test('newBorrowedContext ignores a group-or-world-readable storageState file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hms-slot-open-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = join(dir, 'profile');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const statePath = join(dir, 'storageState.json');
  await writeFile(statePath, JSON.stringify({ cookies: [], origins: [] }), { mode: 0o644 });
  await chmod(statePath, 0o644);
  const calls = [];
  const browser = { newContext: async (opts) => { calls.push(opts); return opts; } };
  await quote.newBorrowedContext(browser, {}, { HMS_SLOT_PROFILE_DIR: profile });
  assert.equal(Object.hasOwn(calls[0], 'storageState'), false);
});

test('login waits for a still-loading shell and does not fill a missing login form', async () => {
  const fills = [];
  const page = fakePage({ readyOn: 3, fills, formCount: 0 });
  const result = await quote.login(page, secret, {});
  assert.deepEqual(result, { reused: true });
  assert.equal(fills.length, 0);
  assert.equal(page.reads(), 3);
});

test('login still succeeds when the optional storageState save throws', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hms-slot-save-fail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = join(dir, 'profile');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const fills = [];
  const page = fakePage({ readyOn: 2, fills });
  page.context = () => ({
    storageState: async () => { throw new Error('EACCES'); },
  });
  const result = await quote.login(page, secret, { HMS_SLOT_PROFILE_DIR: profile });
  assert.deepEqual(result, { reused: false });
  assert.ok(fills.includes('user'));
});

test('login skips credential fill when the authenticated shell is already ready', async () => {
  const fills = [];
  const page = fakePage({ readyOn: 1, fills });
  page.context = () => ({ storageState: async () => { throw new Error('must not save on reuse'); } });
  const result = await quote.login(page, secret, {});
  assert.deepEqual(result, { reused: true });
  assert.equal(fills.length, 0);
  assert.equal(page.reads(), 1);
});

test('login fills then saves storageState at 0600 next to the slot profile', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hms-slot-save-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = join(dir, 'profile');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const fills = [];
  const page = fakePage({ readyOn: 2, fills });
  page.context = () => ({
    storageState: async ({ path }) => {
      await writeFile(path, JSON.stringify({ cookies: [{ name: 'sid', value: 'cookie-value' }], origins: [] }));
    },
  });
  const result = await quote.login(page, secret, { HMS_SLOT_PROFILE_DIR: profile });
  assert.deepEqual(result, { reused: false });
  assert.ok(fills.includes('user'));
  assert.ok(fills.includes('secret'));
  const statePath = join(dir, 'storageState.json');
  const mode = (await stat(statePath)).mode & 0o777;
  assert.equal(mode, 0o600);
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.cookies[0].name, 'sid');
});

test('direct playwright-quote login callers create their context via newBorrowedContext', async () => {
  for (const name of LOGIN_CALLERS) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.match(source, /newBorrowedContext\s*\(/, name);
    // The helper itself lives in session-reuse.mjs and calls browser.newContext once.
    assert.equal(source.includes('browser.newContext('), false, name);
  }
});

function closedAttachError(message = 'Target page, context or browser has been closed') {
  const error = new Error(message);
  error.name = 'TargetClosedError';
  return error;
}

function attachFakeBrowser() {
  const page = { setDefaultTimeout() {} };
  return {
    closed: false,
    async close() { this.closed = true; },
    async newContext() { return { newPage: async () => page }; },
  };
}

test('attachBorrowedSession retries connectOverCDP once after a closed-target blip', async () => {
  const sleeps = [];
  let connects = 0;
  const session = await quote.attachBorrowedSession({
    href: 'http://127.0.0.1:19223',
    env: {},
    timeoutMs: 20,
    sleep: async (ms) => { sleeps.push(ms); },
    connectOverCDP: async () => {
      connects += 1;
      if (connects === 1) throw closedAttachError();
      return attachFakeBrowser();
    },
  });
  assert.equal(connects, 2);
  assert.deepEqual(sleeps, [quote.ATTACH_RETRY_BACKOFF_MS]);
  assert.equal(session.attachAttempts, 2);
  assert.ok(session.page);
  assert.equal(session.browser.closed, false);
});

test('attachBorrowedSession closes the first CDP session before retrying a newContext failure', async () => {
  const first = attachFakeBrowser();
  let connects = 0;
  const session = await quote.attachBorrowedSession({
    href: 'http://127.0.0.1:19223',
    env: {},
    sleep: async () => {},
    connectOverCDP: async () => {
      connects += 1;
      return connects === 1 ? first : attachFakeBrowser();
    },
    newContext: async (browser) => {
      if (browser === first) throw closedAttachError('browserType.connectOverCDP: Timeout 20000ms exceeded.');
      return browser.newContext();
    },
  });
  assert.equal(first.closed, true);
  assert.equal(connects, 2);
  assert.equal(session.attachAttempts, 2);
});

test('attachBorrowedSession surfaces the second failure after one retry', async () => {
  let connects = 0;
  await assert.rejects(
    quote.attachBorrowedSession({
      href: 'http://127.0.0.1:19223',
      env: {},
      sleep: async () => {},
      connectOverCDP: async () => {
        connects += 1;
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:19223'), { name: 'Error' });
      },
    }),
    /ECONNREFUSED/,
  );
  assert.equal(connects, 2);
});

test('probe result names the fallback and never carries cookies or credentials', () => {
  const portable = quote.sessionReuseProbeResult({
    portable: true,
    firstContextReused: false,
    loginVisible: false,
    saved: true,
    firstLoginMs: 4120,
    reuseCheckMs: 380,
    stateMode: 0o600,
  });
  assert.equal(portable.fallback, 'storageState');
  assert.equal(portable.portable, true);
  assert.equal(portable.stateMode, 0o600);
  assert.equal(Object.hasOwn(portable, 'cookies'), false);
  assert.equal(Object.hasOwn(portable, 'password'), false);
  assert.equal(quote.sessionReuseProbeResult({ portable: false }).fallback, 'default_context');
});

test('session-reuse-probe is read-only and never prints secrets', async () => {
  const source = await readFile(new URL('./session-reuse-probe.mjs', import.meta.url), 'utf8');
  assert.match(source, /newBorrowedContext/);
  assert.match(source, /waitForShellOrLoginForm/);
  assert.match(source, /sessionReuseProbeResult/);
  assert.match(source, /\.close\(\)/);
  assert.doesNotMatch(source, /SecretString|cookie-value|secret\.password/);
  assert.equal(source.includes('openGuestStay'), false);
  assert.equal(source.includes('click('), false);
});

test('import still has no CLI, browser or credential side effects', () => {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./session-reuse.mjs', import.meta.url).href)}); console.log('import only');`],
    { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH } },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'import only');
  assert.equal(child.stderr, '');
});

test('login form detection matches the Infor password box by name (it renders as type=text)', async () => {
  const source = await readFile(new URL('./session-reuse.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function loginFormVisible'), source.indexOf('export async function waitForShellOrLoginForm'));
  assert.match(body, /input\[name="password"\]:visible/);
});

test('a visible Infor login form (type=text name=password) is never an authenticated shell', async () => {
  const loginDoc = {
    documentElement: { outerHTML: '', dataset: { tenant: 'tenant', propertyCode: 'HRCEN' } },
    querySelectorAll: (sel) => (sel.includes('input[name="password"]') ? [{ getClientRects: () => [1] }] : []),
    body: { innerText: 'Hotel' },
  };
  const page = {
    evaluate: async (fn, arg) => vm.runInNewContext(`(${fn.toString()})(arg)`, {
      arg, document: loginDoc, location: { href: secret.loginUrl }, getComputedStyle: () => ({ visibility: 'visible' }),
    }),
    locator: () => ({ count: async () => 1 }),
  };
  assert.equal(await quote.authenticatedShellReady(page, secret), false);
  assert.equal(await quote.findReusableAuthenticatedPage([page], secret), null);
  assert.deepEqual(await quote.waitForShellOrLoginForm(page, secret, Date.now() + 50), { ready: false, loginForm: true });
});
