import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as reader from './read-reservation-fields.mjs';

const sourceUrl = new URL('./read-reservation-fields.mjs', import.meta.url);

test('import has no CLI, browser or credential side effects', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(sourceUrl.href)}); console.log('import only');`,
    ],
    { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH } },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'import only');
  assert.equal(child.stderr, '');
});

test('unused OR slots use ___NOMATCH___ not empty or __NAVA_UNUSED__', () => {
  assert.equal(reader.OSRESS_OR_UNUSED_TOKEN, '___NOMATCH___');
  const body = reader.searchBody('59898948-1');
  assert.equal(body.MADDON_FILTER_VALUE_3, '59898948-1');
  for (const n of [4, 5, 6, 7, 8, 9, 10]) {
    assert.equal(body[`MADDON_FILTER_VALUE_${n}`], '___NOMATCH___');
    assert.notEqual(body[`MADDON_FILTER_VALUE_${n}`], '');
  }
  assert.equal(body.externalconfirmation, '___NOMATCH___');
  assert.equal(JSON.stringify(body).includes('__NAVA_UNUSED__'), false);
});

test('Sep-15 positive control is queued first and never resume-skipped', () => {
  assert.equal(reader.SEP15_POSITIVE_CONTROL, '59898948-1');
  assert.deepEqual(reader.queueConfirmations(['AAA-1', 'BBB-2']), [
    '59898948-1',
    'AAA-1',
    'BBB-2',
  ]);
  assert.deepEqual(reader.queueConfirmations(['AAA-1', '59898948-1']), [
    '59898948-1',
    'AAA-1',
  ]);
  const skipped = reader.resumeSkipped(
    [
      JSON.stringify({ conf: '59898948-1', outcome: 'not_found' }),
      JSON.stringify({ conf: 'AAA-1', outcome: 'not_found' }),
      JSON.stringify({ conf: 'BBB-2', outcome: 'read' }),
    ].join('\n'),
  );
  assert.equal(skipped.has('59898948-1'), false);
  assert.equal(skipped.has('AAA-1'), false);
  assert.equal(skipped.has('BBB-2'), true);
});

test('not_found is only resumable after a green positive control', () => {
  const afterGreen = reader.resumeSkipped(
    [
      JSON.stringify({ conf: '59898948-1', outcome: 'read', role: 'positive_control' }),
      JSON.stringify({ conf: 'AAA-1', outcome: 'not_found' }),
    ].join('\n'),
  );
  assert.equal(afterGreen.has('59898948-1'), false);
  assert.equal(afterGreen.has('AAA-1'), true);
});

test('envelope shape logs types and keys never values', () => {
  const shape = reader.envelopeShape({
    fromCome: true,
    grid: {
      GRIDRESULT: {
        GRID: {
          DATA: [{ confirmationnumber: '59898948-1', lastname: 'SECRET-PII', firstname: 'DO-NOT-LOG' }],
        },
      },
    },
    messages: null,
  });
  const json = JSON.stringify(shape);
  assert.equal(json.includes('SECRET-PII'), false);
  assert.equal(json.includes('DO-NOT-LOG'), false);
  assert.equal(json.includes('59898948-1'), false);
  assert.equal(shape.type, 'object');
  assert.ok(shape.keys.includes('grid'));
  assert.equal(shape.fields.grid.fields.GRIDRESULT.fields.GRID.fields.DATA.type, 'array');
  assert.equal(shape.fields.grid.fields.GRIDRESULT.fields.GRID.fields.DATA.length, 1);
  assert.equal(shape.fields.messages.type, 'null');
});

test('stdout payload refuses confirmation numbers and field values', () => {
  const payload = reader.stdoutPayload({
    phase: 'search',
    outcome: 'read',
    rowCount: 1,
    envelope: reader.envelopeShape({ GRIDRESULT: { GRID: { DATA: [{ lastname: 'PII' }] } } }),
    positiveControl: true,
  });
  const json = JSON.stringify(payload);
  assert.equal(payload.phase, 'search');
  assert.equal(payload.positiveControl, true);
  assert.equal(json.includes('PII'), false);
  assert.equal(json.includes('59898948-1'), false);
  assert.equal('conf' in payload, false);
  assert.equal('fields' in payload, false);
  assert.equal('grid' in payload, false);
});

test('hasSearch matches Guest Stay search chrome not a random page', () => {
  assert.equal(reader.hasSearch('<input name="search">'), true);
  assert.equal(reader.hasSearch('<input name="ff_confirmationnumber">'), true);
  assert.equal(reader.hasSearch('<table data-testid="results">'), true);
  assert.equal(reader.hasSearch('<div>Front Desk</div>'), false);
});

test('navigate uses visible Ext tree labels after app-menu-trigger', async () => {
  const clicks = [];
  let html = '<div>Front Desk</div>';
  let menuOpen = false;
  function makeLocator(sel, extra = {}) {
    return {
      filter({ hasText }) {
        return makeLocator(sel, { ...extra, hasText: String(hasText) });
      },
      async count() {
        if (sel.includes('app-menu-trigger')) return 1;
        if (sel.includes('x-tree-node-text') && String(extra.hasText).includes('Front Desk')) {
          return menuOpen ? 1 : 0;
        }
        return 1;
      },
      async click() {
        clicks.push({ sel, hasText: extra.hasText || null });
        if (sel.includes('app-menu-trigger')) {
          menuOpen = true;
          return;
        }
        if (String(extra.hasText).includes('Front Desk')) {
          html = '<div>Front Desk</div>\n<div>Guest Stay</div>';
        }
        if (String(extra.hasText).includes('Guest Stay')) html = '<input name="search">';
      },
    };
  }
  const page = {
    content: async () => html,
    evaluate: async (_fn, label) =>
      html
        .replace(/<[^>]+>/g, '\n')
        .split('\n')
        .some((line) => line.trim() === label),
    locator: (sel) => makeLocator(sel),
    click: async () => {
      throw new Error('generic text= click should not run when locator exists');
    },
  };
  const result = await reader.navigateGuestStay(page, {
    frontDeskMs: 200,
    guestStayMs: 200,
    searchPaintMs: 200,
    pollMs: 10,
  });
  assert.equal(result.navigated, 'menu');
  assert.equal(clicks[0].sel.includes('app-menu-trigger'), true);
  assert.equal(
    clicks.some((c) => c.sel.includes('x-tree-node-text') && String(c.hasText).includes('Front Desk')),
    true,
  );
  assert.equal(
    clicks.some((c) => c.sel.includes('x-tree-node-text') && String(c.hasText).includes('Guest Stay')),
    true,
  );
});

test('navigate retries Front Desk click with force when overlay intercepts', async () => {
  const clicks = [];
  let html = '<div>Front Desk</div>';
  const page = {
    content: async () => html,
    evaluate: async (fn, label) => {
      if (typeof fn === 'function' && fn.length === 0) return false;
      return html
        .replace(/<[^>]+>/g, '\n')
        .split('\n')
        .some((line) => line.trim() === label);
    },
    click: async (sel, options = {}) => {
      clicks.push({ sel, force: Boolean(options.force) });
      if (sel === 'text=Front Desk' && !options.force) {
        throw new Error('page.click: Timeout 30000ms exceeded.');
      }
      if (sel === 'text=Front Desk' && options.force) {
        html = '<div>Front Desk</div>\n<div>Guest Stay</div>';
      }
      if (sel === 'text=Guest Stay') html = '<input name="search">';
    },
  };
  const result = await reader.navigateGuestStay(page, {
    frontDeskMs: 200,
    guestStayMs: 200,
    searchPaintMs: 200,
    pollMs: 10,
  });
  assert.equal(result.navigated, 'menu');
  assert.equal(clicks[0].sel, 'text=Front Desk');
  assert.equal(clicks[0].force, false);
  assert.equal(
    clicks.some((c) => c.sel === 'text=Front Desk' && c.force),
    true,
  );
  assert.equal(
    clicks.some((c) => c.sel === 'text=Guest Stay'),
    true,
  );
});

test('navigate clicks Front Desk then Guest Stay and waits for search input', async () => {
  const clicks = [];
  let html = '<div>Front Desk</div>';
  const page = {
    content: async () => html,
    evaluate: async (_fn, label) =>
      html
        .replace(/<[^>]+>/g, '\n')
        .split('\n')
        .some((line) => line.trim() === label),
    click: async (sel) => {
      clicks.push(sel);
      if (sel === 'text=Front Desk') html = '<div>Front Desk</div>\n<div>Guest Stay</div>';
      if (sel === 'text=Guest Stay') html = '<input name="search">';
    },
  };
  const result = await reader.navigateGuestStay(page, {
    frontDeskMs: 200,
    guestStayMs: 200,
    searchPaintMs: 200,
    pollMs: 10,
  });
  assert.equal(result.navigated, 'menu');
  assert.deepEqual(clicks, ['text=Front Desk', 'text=Guest Stay']);
});

test('navigate opens OSRESS shell over XHR when menu search never paints', async () => {
  const urls = [];
  const page = {
    content: async () => '<div>Front Desk</div>\n<div>Guest Stay</div>',
    evaluate: async (fn, arg) => {
      if (arg && typeof arg === 'object' && arg.url) {
        urls.push(arg.url);
        return '<input name="search">';
      }
      return arg === 'Front Desk' || arg === 'Guest Stay';
    },
    click: async () => {},
  };
  const result = await reader.navigateGuestStay(page, {
    frontDeskMs: 40,
    guestStayMs: 40,
    searchPaintMs: 40,
    pollMs: 10,
    origin: 'https://hms.example',
  });
  assert.equal(result.navigated, 'osress_open');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/web\/base\/OSRESS\?FUNCTION_CLASS=WEBL/);
});

test('navigate does not POST OSRESS and fails closed when search never paints', async () => {
  const posts = [];
  const page = {
    content: async () => '<div>Front Desk</div>\n<div>Guest Stay</div>',
    evaluate: async (_fn, label) => label === 'Front Desk' || label === 'Guest Stay',
    click: async () => {},
    post: async (...args) => {
      posts.push(args);
    },
  };
  await assert.rejects(
    () =>
      reader.navigateGuestStay(page, {
        frontDeskMs: 40,
        guestStayMs: 40,
        searchPaintMs: 40,
        pollMs: 10,
      }),
    /GUEST_STAY_NAV_NO_SEARCH/,
  );
  assert.deepEqual(posts, []);
});

test('borrowed CDP is 127.0.0.1 only', () => {
  assert.equal(
    reader.assertBorrowedCdp({
      HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:9222',
      HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed',
    }).hostname,
    '127.0.0.1',
  );
  assert.throws(
    () =>
      reader.assertBorrowedCdp({
        HMS_STAGEHAND_CDP_URL: 'http://10.0.0.8:9222',
        HMS_STAGEHAND_BROWSER_OWNERSHIP: 'borrowed',
      }),
    /PRIVATE_CDP_REQUIRED/,
  );
  assert.throws(
    () =>
      reader.assertBorrowedCdp({
        HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:9222',
        HMS_STAGEHAND_BROWSER_OWNERSHIP: 'owned',
      }),
    /BORROWED_REQUIRED/,
  );
});

test('booking-state returns guarantee, deposit, A/R, agency, company from DOM when present', () => {
  const html = [
    '<input name="guaranteetype" value="Non-Guaranteed Individual">',
    '<input name="depositreceived" value="0.00">',
    '<input name="araccountname" value="AR-SYNTH">',
    '<input name="ta1" value="AG-SYNTH">',
    '<input name="company" value="ORG-SYNTH">',
  ].join('');
  assert.deepEqual(reader.bookingStateFields(html), {
    guaranteeType: 'Non-Guaranteed Individual',
    depositReceived: '0.00',
    arAccount: 'AR-SYNTH',
    agency: 'AG-SYNTH',
    company: 'ORG-SYNTH',
  });
});

test('booking-state returns null when DOM fields are absent and never guesses payment', () => {
  const absent = reader.bookingStateFields('<input name="status" value="Reserved">');
  assert.deepEqual(absent, {
    guaranteeType: null,
    depositReceived: null,
    arAccount: null,
    agency: null,
    company: null,
  });
  assert.equal(absent.depositReceived, null);
  assert.equal(JSON.stringify(absent).includes('unpaid'), false);
  assert.equal(JSON.stringify(absent).includes('paid'), false);
});

test('booking-state from HDR JSON uses allow-listed keys and stays fail-closed', () => {
  const present = reader.bookingStateFields(JSON.stringify({
    confirmationnumber: '00000000-1',
    guaranteetype: 'Walk in',
    depositreceived: '0',
    araccountname: 'AR-SYNTH',
    ta1: 'AG-SYNTH',
    company: 'ORG-SYNTH',
  }));
  assert.deepEqual(present, {
    guaranteeType: 'Walk in',
    depositReceived: '0',
    arAccount: 'AR-SYNTH',
    agency: 'AG-SYNTH',
    company: 'ORG-SYNTH',
  });
  const missing = reader.bookingStateFields(JSON.stringify({
    confirmationnumber: '00000000-1',
    status: 'Reserved',
  }));
  assert.equal(missing.guaranteeType, null);
  assert.equal(missing.depositReceived, null);
  assert.equal(missing.arAccount, null);
  assert.equal(missing.agency, null);
  assert.equal(missing.company, null);
});

test('stdout payload still omits bookingState values', () => {
  const payload = reader.stdoutPayload({
    phase: 'search',
    outcome: 'read',
    rowCount: 1,
    bookingState: { guaranteeType: 'Walk in', depositReceived: '0' },
    envelope: reader.envelopeShape({ GRIDRESULT: { GRID: { DATA: [{ lastname: 'PII' }] } } }),
    positiveControl: true,
  });
  const json = JSON.stringify(payload);
  assert.equal('bookingState' in payload, false);
  assert.equal(json.includes('Walk in'), false);
  assert.equal(json.includes('PII'), false);
});

test('source stays read-only: Guest Stay menu nav, no save/cancel/checkin, no mail UI', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  assert.match(source, /text=\$\{label\}/);
  assert.match(source, /'Front Desk'/);
  assert.match(source, /'Guest Stay'/);
  assert.match(source, /___NOMATCH___/);
  assert.equal(source.includes('__NAVA_UNUSED__'), false);
  assert.match(source, /59898948-1/);
  assert.match(source, /PRIVATE_CDP_REQUIRED/);
  assert.match(source, /BORROWED_REQUIRED/);
  assert.match(source, /save\|delete\|cancel\|duplicate\|checkin\|checkout\|crs/i);
  assert.equal(/outlook-pane|mail UI|\/mail\//i.test(source), false);
  const nav = source.indexOf('navigateGuestStay');
  const search = source.indexOf("'/web/base/OSRESS.search'");
  assert.ok(nav !== -1 && search !== -1 && nav < search);
  assert.match(source, /OSRESS\?FUNCTION_CLASS=WEBL/);
});
