import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { installSavedStayReadGuard, savedStayReadMayRequest } from './saved-stay-read-guard.mjs';

const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const post = (path, body) => ({ method: 'POST', url: `${origin}${path}`, postData: body,
  contentType: 'application/x-www-form-urlencoded; charset=UTF-8' });
const login = 'SYSTEM_FUNCTION_NAME=LOGIN&USER_FUNCTION_NAME=LOGIN&userid=x&password=x&csrftckt=x&' +
  'resetpassword=&tenant=THECENTURION_PRD';
const menu = 'SYSTEM_FUNCTION_NAME=BSSTRT&USER_FUNCTION_NAME=BSSTRT&menu_module_key=&removescreenflows=';
const header = 'SYSTEM_FUNCTION_NAME=BSSTRT&USER_FUNCTION_NAME=BSSTRT&manurefresh=';
const stayMenu = 'SYSTEM_FUNCTION_NAME=OSRESS&USER_FUNCTION_NAME=OSRESS&CURRENT_TAB_NAME=&' +
  'function_class=WEBL&menu_module_key=&removescreenflows=';
const exactSearch = 'SYSTEM_FUNCTION_NAME=OSRESS&USER_FUNCTION_NAME=OSRESS&CURRENT_TAB_NAME=LST&' +
  'component_info_type=&dataspy_id=&externalconfirmation=&grid_id=&grid_name=OSRESS&maddon_filter_value_1=x';

test('exact reader allows only observed login, menu and static reads', () => {
  for (const request of [
    post('/web/base/login', login), post('/web/base/BSSTRT', menu), post('/web/base/BSSTRT.HDR', header),
    post('/web/base/OSRESS?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESS', stayMenu),
    post('/web/base/OSRESS.search', exactSearch),
    { method: 'GET', url: `${origin}/web/base/logindisp?tenant=THECENTURION_PRD` },
    { method: 'GET', url: `${origin}/web/base/COMMON?req_key=observed` },
    { method: 'GET', url: `${origin}/web/resources/shared/shell.js` },
  ]) assert.equal(savedStayReadMayRequest(request), true);
});

test('exact reader rejects other search, save, uploads, origins and malformed login', () => {
  for (const request of [
    post('/web/base/login', login.replace('THECENTURION_PRD', 'OTHER')),
    post('/web/base/login', `${login}&pageaction=SAVE`),
    post('/web/base/BSSTRT.HDR?pageaction=SAVE', header),
    post('/web/base/OSRESS?FUNCTION_CLASS=SAVE&USER_FUNCTION_NAME=OSRESS', stayMenu),
    post('/web/base/OSRESS?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESS', stayMenu.replace('function_class=WEBL', 'function_class=SAVE')),
    post('/web/base/OSRESS.search', exactSearch.replace('grid_name=OSRESS', 'grid_name=OTHER')),
    post('/web/base/OSRESS.search', `${exactSearch}&pageaction=SAVE`),
    post('/web/base/OSRESS.search', exactSearch.replace('USER_FUNCTION_NAME=OSRESS', 'USER_FUNCTION_NAME=OSRESV')),
    post('/web/base/OSRESS.search', 'SYSTEM_FUNCTION_NAME=OSRESS&USER_FUNCTION_NAME=OSRESV'),
    post('/web/base/OSRESV.HDR', 'SYSTEM_FUNCTION_NAME=OSRESV&USER_FUNCTION_NAME=OSRESV'),
    post('/web/base/BSUPLD.upload', header),
    { ...post('/web/base/login', login), url: 'https://other.invalid/web/base/login' },
    { method: 'GET', url: 'https://other.invalid/web/resources/shared/shell.js' },
    { method: 'GET', url: `${origin}/web/base/logindisp?tenant=OTHER` },
    { method: 'GET', url: `${origin}/web/base/unreviewed` },
    { method: 'HEAD', url: `${origin}/web/base/logindisp?tenant=THECENTURION_PRD` },
  ]) assert.equal(savedStayReadMayRequest(request), false);
});

test('Stay 360 detail lookup is bound to the selected confirmation and a single field', () => {
  const path = '/web/jsp/7iosress_getstaydata.jsp';
  const selected = { confirmation: '123-1' };
  assert.equal(savedStayReadMayRequest(post(path, 'confirmationnumber=123-1'), selected), true);
  assert.equal(savedStayReadMayRequest(post(path, 'confirmationnumber=999-1'), selected), false);
  assert.equal(savedStayReadMayRequest(post(path, 'confirmationnumber=123-1&action=SAVE'), selected), false);
  assert.equal(savedStayReadMayRequest(post(path, 'confirmationnumber=123-1&CONFIRMATIONNUMBER=123-1'), selected), false);
  assert.equal(savedStayReadMayRequest({ ...post(path, 'confirmationnumber=123-1'),
    url: 'https://other.invalid/web/jsp/7iosress_getstaydata.jsp' }, selected), false);
  assert.equal(savedStayReadMayRequest(post(path, 'confirmationnumber=123-1')), false);
});

test('record navigation is confined to the selected confirmation and observed view', () => {
  const query = new URLSearchParams({ current_tab_name: 'HDR', fromlogin: 'yes', hyperlinksource: 'F',
    includeinitparams: 'true', initpath: 'OSRESV', menu_module_key: '-1', popup: 'TRUE',
    system_function_name: 'OSRESV', uitheme: 'inforhms', user_function_name: 'OSRESV',
    requesttoken: 'abc%2B12&browserTabID=1',
    initparams: 'startUpView=right&autoTracePopupSkipConfNum=123-1' });
  const request = (params, host = origin) => ({ method: 'GET', url: `${host}/web/base/loadmain?${params}` });
  const selected = { confirmation: '123-1' };
  assert.equal(savedStayReadMayRequest(request(query), selected), true);
  for (const [key, value] of [
    ['current_tab_name', 'SAVE'], ['initpath', 'BSUPLD'], ['requesttoken', 'abc/123'],
    ['requesttoken', 'abc&browserTabID=1&action=SAVE'], ['requesttoken', 'abc%ZZ&browserTabID=1'],
    ['initparams', 'startUpView=left&autoTracePopupSkipConfNum=123-1'],
    ['initparams', 'startUpView=right&autoTracePopupSkipConfNum=999-1'],
    ['initparams', 'startUpView=right&autoTracePopupSkipConfNum=123-1&action=SAVE'],
  ]) {
    const changed = new URLSearchParams(query); changed.set(key, value);
    assert.equal(savedStayReadMayRequest(request(changed), selected), false);
  }
  const duplicate = new URLSearchParams(query); duplicate.append('CURRENT_TAB_NAME', 'HDR');
  assert.equal(savedStayReadMayRequest(request(duplicate), selected), false);
  assert.equal(savedStayReadMayRequest(request(query, 'https://other.invalid'), selected), false);
  assert.equal(savedStayReadMayRequest(request(query)), false);
});

test('record view POST is confined to the selected confirmation and observed fields', () => {
  const body = new URLSearchParams({ SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV',
    startUpView: 'right', autoTracePopupSkipConfNum: '123-1', menu_module_key: '0', removescreenflows: 'yes' });
  const selected = { confirmation: '123-1' };
  assert.equal(savedStayReadMayRequest(post('/web/base/OSRESV', body.toString()), selected), true);
  for (const [key, value] of [['autoTracePopupSkipConfNum', '999-1'], ['startUpView', 'other'],
    ['menu_module_key', '1'], ['removescreenflows', 'no'], ['SYSTEM_FUNCTION_NAME', 'BSUPLD']]) {
    const changed = new URLSearchParams(body); changed.set(key, value);
    assert.equal(savedStayReadMayRequest(post('/web/base/OSRESV', changed.toString()), selected), false);
  }
  body.append('pageaction', 'SAVE');
  assert.equal(savedStayReadMayRequest(post('/web/base/OSRESV', body.toString()), selected), false);
});

test('record list POST searches only the selected confirmation using the observed fields', () => {
  const body = new URLSearchParams({ component_info_type: 'HEAD_DATA', dataspy_id: '', addons_required: 'true',
    filterfields: 'confirmationnumber', filteroperator: '=', filtervalue: '123-1', run_ds: 'false',
    addon_sort_element_alias_name: 'primaryguest', addon_sort_element_type: 'DESC', rememberdsandqf: 'false',
    SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'LST',
    menu_module_key: '0', removescreenflows: 'yes' });
  const selected = { confirmation: '123-1' };
  assert.equal(savedStayReadMayRequest(post('/web/base/OSRESV.LST', body.toString()), selected), true);
  for (const [key, value] of [['filtervalue', '999-1'], ['filterfields', 'lastname'],
    ['filteroperator', '!='], ['component_info_type', 'SAVE'], ['run_ds', 'true']]) {
    const changed = new URLSearchParams(body); changed.set(key, value);
    assert.equal(savedStayReadMayRequest(post('/web/base/OSRESV.LST', changed.toString()), selected), false);
  }
  body.append('pageaction', 'SAVE');
  assert.equal(savedStayReadMayRequest(post('/web/base/OSRESV.LST', body.toString()), selected), false);
});

test('record header POST is bound to the selected HRCEN confirmation and native identifiers', () => {
  const body = new URLSearchParams({ SYSTEM_FUNCTION_NAME: 'OSRESV', USER_FUNCTION_NAME: 'OSRESV', CURRENT_TAB_NAME: 'HDR',
    confirmationnumber: '123-1', reservationstayid: '456', propertycode: 'HRCEN', guestfullname: 'Proof Labtest',
    account: '789', guestid: '789', hoteldate: '2026-11-03', lastname: 'Labtest', firstname: 'Proof',
    twitterid: '-', facebookid: '-', tripadvisorid: '-', bookingdotcomid: '-', room: '' });
  const selected = { confirmation: '123-1' };
  assert.equal(savedStayReadMayRequest(post('/web/base/OSRESV.HDR', body.toString()), selected), true);
  // The reviewed native detail-open manifest records both the 17-field and
  // 19-field forms. Accept the latter only with the known shell values.
  const withChrome = new URLSearchParams(body);
  withChrome.set('MENU_MODULE_KEY', '0');
  withChrome.set('removescreenflows', 'yes');
  assert.equal(savedStayReadMayRequest(post('/web/base/OSRESV.HDR', withChrome.toString()), selected), true);
  for (const [key, value] of [['MENU_MODULE_KEY', '1'], ['removescreenflows', 'no'],
    ['MENU_MODULE_KEY', 'SAVE'], ['removescreenflows', '']]) {
    const changed = new URLSearchParams(withChrome); changed.set(key, value);
    assert.equal(savedStayReadMayRequest(post('/web/base/OSRESV.HDR', changed.toString()), selected), false);
  }
  const partial = new URLSearchParams(withChrome); partial.delete('removescreenflows');
  assert.equal(savedStayReadMayRequest(post('/web/base/OSRESV.HDR', partial.toString()), selected), false);
  const repeated = new URLSearchParams(withChrome); repeated.append('menu_module_key', '0');
  assert.equal(savedStayReadMayRequest(post('/web/base/OSRESV.HDR', repeated.toString()), selected), false);
  for (const [key, value] of [['confirmationnumber', '999-1'], ['propertycode', 'HRDAV'],
    ['reservationstayid', '456&action=SAVE'], ['guestid', ''], ['CURRENT_TAB_NAME', 'SAVE']]) {
    const changed = new URLSearchParams(body); changed.set(key, value);
    assert.equal(savedStayReadMayRequest(post('/web/base/OSRESV.HDR', changed.toString()), selected), false);
  }
  body.append('pageaction', 'SAVE');
  assert.equal(savedStayReadMayRequest(post('/web/base/OSRESV.HDR', body.toString()), selected), false);
});

test('later generic reader guards cannot bypass the earlier strict fence', { timeout: 30000 }, async () => {
  let hits = 0;
  const server = createServer((_req, res) => { hits++; res.writeHead(200); res.end('unexpected'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const require = createRequire(new URL('../stagehand/package.json', import.meta.url));
    browser = await require('playwright').chromium.launch({ headless: true,
      executablePath: process.env.HMS_TEST_CHROMIUM_PATH || undefined });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await installSavedStayReadGuard(context, { confirmation: '123-1' });
    await installReadOnlyGuard(context);
    await installReadOnlyGuard(context);
    const page = await context.newPage();
    await assert.rejects(page.goto(`http://127.0.0.1:${server.address().port}/unreviewed`));
    assert.equal(hits, 0);
    await context.close();
  } finally {
    try { await browser?.close(); }
    finally { await new Promise((resolve) => server.close(resolve)); }
  }
});
