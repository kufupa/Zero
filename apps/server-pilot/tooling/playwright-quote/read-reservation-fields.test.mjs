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

test('navigate opens a collapsed app menu before waiting for Front Desk', async () => {
  const clicks = [];
  let html = '<div>Home</div>';
  function makeLocator(sel, extra = {}) {
    return {
      filter({ hasText }) {
        return makeLocator(sel, { ...extra, hasText: String(hasText) });
      },
      async count() {
        if (sel.includes('x-tree-node-text')) return html.includes(extra.hasText?.replace(/[\^$/]/g, '') ?? '') ? 1 : 0;
        return 1;
      },
      async click() {
        clicks.push({ sel, hasText: extra.hasText || null });
        if (sel.includes('app-menu-trigger')) html = '<div>Front Desk</div>';
        else if (String(extra.hasText).includes('Front Desk')) html = '<div>Front Desk</div>\n<div>Guest Stay</div>';
        else if (String(extra.hasText).includes('Guest Stay')) html = '<input name="search">';
      },
    };
  }
  const page = {
    content: async () => html,
    evaluate: async (_fn, label) =>
      html.replace(/<[^>]+>/g, '\n').split('\n').some((line) => line.trim() === label),
    locator: (sel) => makeLocator(sel),
  };
  const result = await reader.navigateGuestStay(page, {
    frontDeskMs: 40,
    guestStayMs: 200,
    searchPaintMs: 200,
    pollMs: 10,
  });
  assert.equal(result.navigated, 'menu');
  assert.equal(clicks[0].sel.includes('app-menu-trigger'), true);
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

test('pickFields reads HRDAV child, CMS and surname fields while ignoring unknown keys', () => {
  const hdr = JSON.stringify({
    child1: 0,
    child2: 1,
    child3: 1,
    udfchar09: '03',
    udfchar13: 'booker@example.test',
    udfchar06: 'x',
    udfchkbox04: true,
    guestoptin4: 'Y',
    emailaddress: 'booker@example.test',
    lastname: 'Smith',
    shouldNotRead: 'unknown',
  });
  const fields = reader.pickFields(hdr);
  for (const key of ['child1', 'child2', 'child3', 'udfchar09', 'udfchar13', 'udfchar06', 'udfchkbox04', 'guestoptin4', 'emailaddress', 'lastname']) {
    assert.ok(key in fields, `${key} should be included in the explicit allowlist`);
  }
  assert.equal('shouldNotRead' in fields, false);
});

test('fetch read requires the returned header to identify the selected confirmation', async () => {
  const confirmation = '12345678-1';
  const search = JSON.stringify({ pageData: { grid: { GRIDRESULT: { GRID: { DATA: [
    { confirmationnumber: confirmation, id: '123' },
  ] } } } } });
  const commercial = {
    rateplan: 'BAR', averagerate: '1250.00', averageratecurr: 'ZAR', grandtotal: '2500.00', grandtotalcurr: 'ZAR',
  };
  const page = (header) => ({
    evaluate: async (_fn, { url }) => url.endsWith('/OSRESS.search') ? search : JSON.stringify(header),
  });
  const unconfirmed = await reader.readOne(page(commercial), 'https://hms.example.test', confirmation, 'HRCEN');
  assert.equal(unconfirmed.outcome, 'identity_unconfirmed');
  assert.equal('fields' in unconfirmed, false);
  const mismatch = await reader.readOne(page({ ...commercial, confirmationnumber: '87654321-1' }),
    'https://hms.example.test', confirmation, 'HRCEN');
  assert.equal(mismatch.outcome, 'identity_mismatch');
  assert.equal('fields' in mismatch, false);
  const read = await reader.readOne(page({ ...commercial, confirmationnumber: confirmation }),
    'https://hms.example.test', confirmation, 'HRCEN');
  assert.equal(read.outcome, 'read');
  assert.equal(read.fields.grandtotal, '2500.00');
  assert.equal(read.fields.grandtotalcurr, 'ZAR');

  const skipped = reader.resumeSkipped([
    JSON.stringify({ conf: reader.SEP15_POSITIVE_CONTROL, outcome: 'identity_unconfirmed' }),
    JSON.stringify({ conf: confirmation, outcome: 'not_found' }),
  ].join('\n'));
  assert.equal(skipped.has(confirmation), false);
});

test('navigate names a signed-out login page instead of a missing Front Desk', async () => {
  const page = {
    content: async () => '<input name="password" type="text">',
    evaluate: async () => false,
    click: async () => {},
    locator: (sel) => ({
      filter: () => ({ count: async () => 0, click: async () => {} }),
      count: async () => (sel.includes('name="password"') ? 1 : 0),
      click: async () => {},
    }),
  };
  await assert.rejects(
    () => reader.navigateGuestStay(page, { frontDeskMs: 20, guestStayMs: 20, searchPaintMs: 20, pollMs: 5 }),
    /GUEST_STAY_NAV_LOGIN_PAGE/,
  );
});

test('HRDAV reads through the screen; HRCEN keeps the fetch path and its positive control', () => {
  assert.equal(reader.readMode('HRDAV'), 'ui');
  assert.equal(reader.readMode('HRCEN'), 'fetch');
  assert.equal(reader.POSITIVE_CONTROLS.HRCEN, '59898948-1');
  assert.equal(reader.POSITIVE_CONTROLS.HRDAV, undefined);
  assert.deepEqual(reader.queueConfirmations(['AAA-1', '59898948-1'], null), ['AAA-1', '59898948-1']);
  assert.deepEqual(reader.queueConfirmations(['AAA-1']), ['59898948-1', 'AAA-1']);
});

test('input rows accept plain confirmations or {conf, arrival, lastName}; bad arrival dropped, dupes once', () => {
  assert.deepEqual(reader.inputItems([
    '11111111-1',
    { conf: ' 22222222-1 ', arrival: '2027-12-20', lastName: ' Labtest ' },
    { conf: '33333333-1', arrival: '20-DEC-2027' },
    { conf: '11111111-1', arrival: '2027-01-01' },
    { arrival: '2027-12-20' },
    42,
  ]), [
    { conf: '11111111-1', arrival: null, lastName: null },
    { conf: '22222222-1', arrival: '2027-12-20', lastName: 'Labtest' },
    { conf: '33333333-1', arrival: null, lastName: null },
  ]);
});

function fakeInput(attrs) {
  return {
    type: attrs.type ?? 'text',
    value: attrs.value ?? '',
    getAttribute: (key) => attrs[key] ?? null,
    getClientRects: () => (attrs.hidden ? [] : [{}]),
    closest: (sel) => (attrs.checkedWrap && /x-form-cb-checked/.test(sel) ? {} : null),
  };
}

test('visible field values: hidden controls omitted, blanks keyed but valueless, Ext checkboxes as true/false', () => {
  const byName = {
    confirmationnumber: [fakeInput({ value: 'secret-hidden', hidden: true }), fakeInput({ value: ' 73165771-1 ' })],
    lastname: [fakeInput({ value: 'Labtest' })],
    company: [fakeInput({ value: '  ' })],
    udfchkbox04: [fakeInput({ type: 'button', role: 'checkbox' })],
    guestoptin4: [fakeInput({ type: 'button', role: 'checkbox', checkedWrap: true })],
    reservationnote: [fakeInput({ value: 'line one\n line two' })],
  };
  const doc = { querySelectorAll: (sel) => byName[/name="([^"]+)"/.exec(sel)[1]] ?? [] };
  const { fields, keys } = reader.visibleFieldValues(
    ['confirmationnumber', 'lastname', 'company', 'udfchkbox04', 'guestoptin4', 'reservationnote', 'roomtype'],
    doc,
  );
  assert.deepEqual(fields, {
    confirmationnumber: '73165771-1',
    lastname: 'Labtest',
    udfchkbox04: 'false',
    guestoptin4: 'true',
    reservationnote: 'line one line two',
  });
  assert.deepEqual(keys, ['confirmationnumber', 'lastname', 'company', 'udfchkbox04', 'guestoptin4', 'reservationnote']);
});

function uiPage(fields) {
  return { evaluate: async () => ({ fields, keys: Object.keys(fields) }) };
}

test('UI read passes the arrival hint to find and returns the readOne row shape', async () => {
  const calls = [];
  const find = async (ctx, opts) => {
    calls.push({ args: ctx.args, opts });
    return { outcome: 'found', findMethod: 'quick' };
  };
  const fields = {
    confirmationnumber: '73165771-1', lastname: 'Labtest', roomtype: 'STWN', adults: '2', arrivaldate: '20-DEC-2027',
    guaranteetype: 'Guaranteed By Agent', ta1: 'Agency X',
  };
  const row = await reader.readOneUi(
    uiPage(fields), { conf: '73165771-1', arrival: '2027-12-20', lastName: null }, find, async () => true,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.mode, 'find');
  assert.equal(calls[0].args.confirmation, '73165771-1');
  assert.equal(calls[0].args.arrival, '2027-12-20');
  assert.equal(calls[0].opts.captureScreenshots, false);
  assert.equal(row.outcome, 'read');
  assert.equal(row.rowCount, 1);
  assert.deepEqual(row.fields, fields);
  assert.equal(row.bookingState.guaranteeType, 'Guaranteed By Agent');
  assert.equal(row.bookingState.agency, 'Agency X');
  assert.equal(row.bookingState.company, null);
  assert.equal(row.envelope.type, 'ui_form');
  assert.equal(JSON.stringify(row.envelope).includes('Labtest'), false);
  const stdout = JSON.stringify(reader.stdoutPayload({ phase: 'search', ...row }));
  assert.equal(stdout.includes('73165771-1'), false);
  assert.equal(stdout.includes('Labtest'), false);
});

test('UI read refuses a record showing another confirmation', async () => {
  const row = await reader.readOneUi(
    uiPage({ confirmationnumber: '99999999-1', lastname: 'Other', roomtype: 'STWN', adults: '2' }),
    { conf: '73165771-1' },
    async () => ({ outcome: 'found' }),
    async () => true,
  );
  assert.equal(row.outcome, 'identity_mismatch');
  assert.equal('fields' in row, false);
});

test('UI read keeps observed commercial facts and aggregate controls only for the found confirmation', async () => {
  const values = {
    confirmationnumber: '73165771-1', lastname: 'Labtest', rateplan: 'BAR',
    averagerate: '1250.00', averageratecurr: 'ZAR', totalrate: '2500.00', totalratecurr: 'ZAR',
    grandtotal: '2500.00', grandtotalcurr: 'ZAR', bookingagency1iatanumber: '12345678',
  };
  const doc = {
    querySelectorAll(selector) {
      const name = /name="([^"]+)"/.exec(selector)?.[1];
      return Object.hasOwn(values, name) ? [fakeInput({ value: values[name] })] : [];
    },
  };
  const page = { evaluate: async (fn, names) => fn(names, doc) };
  const commercial = { agency: { name: 'Agency X', iata: '12345678' }, ratePlan: 'BAR' };
  const find = async () => ({
    outcome: 'found', stay: { confirmation: '73165771-1' }, commercial, conflicts: ['ratePlan'],
  });
  const row = await reader.readOneUi(page, { conf: '73165771-1' }, find, async () => true);
  assert.equal(row.outcome, 'read');
  assert.deepEqual(row.commercial, commercial);
  assert.deepEqual(row.commercialConflicts, ['ratePlan']);
  for (const name of ['averageratecurr', 'totalrate', 'totalratecurr', 'grandtotal', 'grandtotalcurr']) {
    assert.equal(row.fields[name], values[name]);
  }
  assert.equal('bookingagency1iatanumber' in row.fields, false);
  const stdout = JSON.stringify(reader.stdoutPayload(row));
  assert.equal(stdout.includes('Agency X'), false);
  assert.equal(stdout.includes('12345678'), false);

  const mismatch = await reader.readOneUi(page, { conf: '73165771-1' },
    async () => ({ outcome: 'found', stay: { confirmation: '99999999-1' }, commercial }), async () => true);
  assert.equal(mismatch.outcome, 'identity_mismatch');
  assert.equal('commercial' in mismatch, false);
  assert.equal('fields' in mismatch, false);

  const noBoundStay = await reader.readOneUi(page, { conf: '73165771-1' },
    async () => ({ outcome: 'found', commercial }), async () => true);
  assert.equal('commercial' in noBoundStay, false);
});

test('UI read retries a miss or a thrown find once after settling; ambiguous and mismatch are not retried', async () => {
  let settles = 0;
  const settle = async () => {
    settles += 1;
    return true;
  };
  const page = uiPage({ confirmationnumber: '1-1', lastname: 'Labtest', roomtype: 'STWN', adults: '2' });
  const script = (outcomes) => {
    let i = 0;
    return async () => {
      const next = outcomes[i++];
      if (next instanceof Error) throw next;
      return next;
    };
  };
  const retried = await reader.readOneUi(
    page, { conf: '1-1' }, script([new Error('DATE_PICKER_NOT_OPEN'), { outcome: 'found' }]), settle,
  );
  assert.equal(retried.outcome, 'read');
  assert.equal(settles, 2);
  const missed = await reader.readOneUi(
    page, { conf: '1-1' }, script([{ outcome: 'not_found' }, { outcome: 'not_found' }]), settle,
  );
  assert.equal(missed.outcome, 'not_found');
  assert.equal(missed.arrivalHint, null);
  settles = 0;
  const ambiguous = await reader.readOneUi(page, { conf: '1-1' }, script([{ outcome: 'ambiguous' }]), settle);
  assert.equal(ambiguous.outcome, 'ambiguous');
  const mismatch = await reader.readOneUi(
    page, { conf: '1-1' }, script([{ outcome: 'ambiguous', reason: 'confirmation_mismatch' }]), settle,
  );
  assert.equal(mismatch.outcome, 'identity_mismatch');
  assert.equal(settles, 2);
  await assert.rejects(
    () => reader.readOneUi(page, { conf: '1-1' }, script([new Error('X'), new Error('QUICK_ROW_UNPARSED')]), settle),
    /QUICK_ROW_UNPARSED/,
  );
  await assert.rejects(
    () => reader.readOneUi(page, { conf: '1-1' }, script([new Error('AMBIGUOUS_QUICK_ROW')]), settle),
    /AMBIGUOUS_QUICK_ROW/,
  );
});

test('settleScreen waits out a visible load mask', async () => {
  let checks = 0;
  const page = { evaluate: async () => ++checks < 3, waitForTimeout: async () => {} };
  assert.equal(await reader.settleScreen(page, { timeoutMs: 1000, pollMs: 1 }), true);
  assert.equal(checks, 3);
  const stuck = { evaluate: async () => true, waitForTimeout: async () => {} };
  assert.equal(await reader.settleScreen(stuck, { timeoutMs: 5, pollMs: 1 }), false);
});

test('UI path source: no OSRESS shell on HRDAV, read-only guard kept, never Save, explicit exit', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  const ui = source.slice(source.indexOf('export async function readOneUi'), source.indexOf('async function main()'));
  assert.ok(ui.length > 0);
  assert.equal(/openOsressShell|OSRESS\.search|OSRESV\.HDR|\bpost\(/.test(ui), false);
  assert.equal(/Save|dblclick|\.fill\(|press\(/.test(ui), false);
  const mainBody = source.slice(source.indexOf('async function main()'));
  assert.match(mainBody, /mode === 'ui'[\s\S]*openGuestStayScreen\(page\)[\s\S]*else[\s\S]*navigateGuestStay/);
  assert.match(mainBody, /readOneUi\(page/);
  assert.match(mainBody, /process\.exit\(process\.exitCode \?\? 0\)/);
  assert.match(source, /save\|delete\|cancel\|duplicate\|checkin\|checkout\|crs/i);
});
