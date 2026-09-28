/**
 * A1: stay on COMMON after login. Soft-open OSRESS first, then More→Front Desk→Guest Stay.
 * Never page.goto OSRESS (that bounced to logindisp). Harvest Rate Details XHR.
 * HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../dist/hms/runtime.js';

function scrub(s) {
  return s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/\b\d{7,}\b/g, '[n]');
}

async function clickText(page, labels, extraSel = '') {
  const sels = extraSel
    ? extraSel.split(',')
    : ['.x-menu-item-text', 'a', 'span', 'button', '.x-btn-inner'];
  return page.evaluate(
    ({ labels, sels }) => {
      const nodes = [...document.querySelectorAll(sels.join(','))];
      for (const want of labels) {
        const el = nodes.find((n) => (n.textContent || '').trim() === want);
        if (el) {
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { ok: true, clicked: want };
        }
      }
      return {
        ok: false,
        sample: nodes
          .map((n) => (n.textContent || '').trim())
          .filter((t) => t && t.length < 40)
          .slice(0, 25),
      };
    },
    { labels, sels },
  );
}

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const candPath = process.env.HMS_PROOF_EXACT_CANDIDATE_PATH;
  if (!candPath) throw new Error('HMS_PROOF_EXACT_CANDIDATE_PATH required');
  const outPath =
    process.env.HMS_A1_RATE_EXT_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/rate-details-ext-menu.v1.json';

  const raw = JSON.parse(await readFile(candPath, 'utf8'));
  if (raw.kind !== 'confirmation' || !raw.value) throw new Error('bad candidate');
  const exactConf = raw.value;

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  const origin = new URL(secret.loginUrl).origin;

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 1000 },
  });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (!u.startsWith(origin)) return route.abort();
    if (
      /(save|delete|submit|checkin|checkout|amend|cancel|newrecord|complete)/i.test(
        new URL(u).pathname,
      )
    ) {
      return route.abort();
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  const net = [];
  page.on('request', (req) => {
    if (!req.url().startsWith(origin)) return;
    const u = new URL(req.url());
    if (!u.pathname.startsWith('/web/base/')) return;
    const params = new URLSearchParams(req.postData() ?? '');
    net.push({
      method: req.method(),
      path: u.pathname.replace('/web/base/', '').toUpperCase(),
      tab: params.get('CURRENT_TAB_NAME'),
      user: params.get('USER_FUNCTION_NAME'),
      sys: params.get('SYSTEM_FUNCTION_NAME'),
      cls: params.get('FUNCTION_CLASS'),
      keys: [...params.keys()].slice(0, 30),
    });
  });

  await page.goto(secret.loginUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page
    .locator('input[name=userid], input[name=username], input[name=j_username]')
    .first()
    .fill(secret.username);
  await page.locator('input[name=password]').fill(secret.password);
  await Promise.all([
    page.waitForURL(/COMMON/i, { timeout: 60_000 }).catch(() => null),
    page.getByRole('button', { name: 'Sign in' }).click().catch(async () => {
      await page.locator('input[name=password]').press('Enter');
    }),
  ]);
  await page.waitForTimeout(6_000);

  // Soft warm + OSRESS BEFORE menu (A3 unlock). Stay on COMMON — no goto.
  await page.evaluate(async () => {
    const post = async (path, body) => {
      await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
    };
    for (const path of ['/web/base/BSSTRT.HDR', '/web/base/BSSTRT']) {
      await post(path, {
        SYSTEM_FUNCTION_NAME: 'BSSTRT',
        USER_FUNCTION_NAME: 'BSSTRT',
        manurefresh: 'yes',
      }).catch(() => undefined);
    }
    await post('/web/base/OSRESS?FUNCTION_CLASS=WEBL', {
      SYSTEM_FUNCTION_NAME: 'OSRESS',
      USER_FUNCTION_NAME: 'OSRESS',
      FUNCTION_CLASS: 'WEBL',
      CURRENT_TAB_NAME: '',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
    });
  });
  await page.waitForTimeout(2_000);

  const more = await clickText(page, ['More']);
  await page.waitForTimeout(1_200);
  const fd = await clickText(page, ['Front Desk']);
  await page.waitForTimeout(1_800);
  const gs = await clickText(page, ['Guest Stay']);
  await page.waitForTimeout(8_000);

  const uiAfterMenu = await page.evaluate(() => ({
    url: location.href.slice(-80),
    imgCount: document.querySelectorAll('img').length,
    gridCount: document.querySelectorAll('.x-grid3-row, .x-grid-row').length,
    toolbar: [...document.querySelectorAll('img')]
      .map((i) => (i.getAttribute('src') || '').split('/').pop())
      .filter((s) => /rate|detail|toolbar|svg/i.test(s || ''))
      .slice(0, 20),
    inputs: document.querySelectorAll('input').length,
  }));

  // Fill confirmation via visible Ext search if present
  const filled = await page.evaluate((conf) => {
    const inputs = [...document.querySelectorAll('input')].filter(
      (i) => i.offsetParent !== null && i.type !== 'hidden' && i.type !== 'password',
    );
    const search =
      inputs.find((i) =>
        /confirm|search|filter/i.test((i.name || '') + (i.id || '') + (i.placeholder || '')),
      ) || inputs[0];
    if (!search) return { ok: false, visibleInputs: inputs.length };
    search.focus();
    search.value = conf;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    search.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, name: search.name || search.id || 'anon', visibleInputs: inputs.length };
  }, exactConf);
  await page.waitForTimeout(500);

  const runClick = await clickText(page, ['Run', 'Search']);
  await page.waitForTimeout(6_000);

  // Soft search as fallback while Ext shell is Guest Stay
  await page.evaluate(async (exact) => {
    const unused = '___NOMATCH___';
    await fetch('/web/base/OSRESS.search', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_ID: '1775',
        GRID_NAME: 'OSRESS',
        DATASPY_ID: '1941',
        SYSTEM_FUNCTION_NAME: 'OSRESS',
        USER_FUNCTION_NAME: 'OSRESV',
        CURRENT_TAB_NAME: 'LST',
        MADDON_FILTER_ALIAS_NAME_1: 'departuredate',
        MADDON_FILTER_OPERATOR_1: '>=',
        MADDON_FILTER_JOINER_1: 'AND',
        MADDON_FILTER_SEQNUM_1: '1',
        MADDON_FILTER_VALUE_1: '-365',
        MADDON_FILTER_ALIAS_NAME_2: 'arrivaldate',
        MADDON_FILTER_OPERATOR_2: '<=',
        MADDON_FILTER_JOINER_2: 'AND',
        MADDON_FILTER_SEQNUM_2: '2',
        MADDON_FILTER_VALUE_2: '+365',
        MADDON_FILTER_ALIAS_NAME_3: 'confirmationnumber',
        MADDON_FILTER_OPERATOR_3: 'BEGINS',
        MADDON_FILTER_JOINER_3: 'OR',
        MADDON_FILTER_SEQNUM_3: '3',
        MADDON_FILTER_VALUE_3: exact,
        MADDON_LPAREN_3: 'true',
        MADDON_FILTER_ALIAS_NAME_4: 'room',
        MADDON_FILTER_OPERATOR_4: '=',
        MADDON_FILTER_JOINER_4: 'OR',
        MADDON_FILTER_SEQNUM_4: '4',
        MADDON_FILTER_VALUE_4: unused,
        MADDON_FILTER_ALIAS_NAME_5: 'lastname_filter',
        MADDON_FILTER_OPERATOR_5: 'BEGINS',
        MADDON_FILTER_JOINER_5: 'OR',
        MADDON_FILTER_SEQNUM_5: '5',
        MADDON_FILTER_VALUE_5: unused,
        MADDON_LPAREN_5: 'false',
        MADDON_FILTER_ALIAS_NAME_6: 'secondlastname',
        MADDON_FILTER_OPERATOR_6: 'BEGINS',
        MADDON_FILTER_JOINER_6: 'OR',
        MADDON_FILTER_SEQNUM_6: '6',
        MADDON_FILTER_VALUE_6: unused,
        MADDON_RPAREN_6: 'false',
        MADDON_FILTER_ALIAS_NAME_7: 'alternatelastname',
        MADDON_FILTER_OPERATOR_7: 'BEGINS',
        MADDON_FILTER_JOINER_7: 'OR',
        MADDON_FILTER_SEQNUM_7: '7',
        MADDON_FILTER_VALUE_7: unused,
        MADDON_FILTER_ALIAS_NAME_8: 'aliaslastname',
        MADDON_FILTER_OPERATOR_8: 'BEGINS',
        MADDON_FILTER_JOINER_8: 'OR',
        MADDON_FILTER_SEQNUM_8: '8',
        MADDON_FILTER_VALUE_8: unused,
        MADDON_FILTER_ALIAS_NAME_9: 'loyaltynumber',
        MADDON_FILTER_OPERATOR_9: 'BEGINS',
        MADDON_FILTER_JOINER_9: 'OR',
        MADDON_FILTER_SEQNUM_9: '9',
        MADDON_FILTER_VALUE_9: unused,
        MADDON_FILTER_ALIAS_NAME_10: 'externalconfirmation',
        MADDON_FILTER_OPERATOR_10: 'BEGINS',
        MADDON_FILTER_JOINER_10: 'OR',
        MADDON_FILTER_SEQNUM_10: '10',
        MADDON_FILTER_VALUE_10: unused,
        MADDON_RPAREN_10: 'true',
        externalconfirmation: unused,
      }).toString(),
    });
  }, exactConf);
  await page.waitForTimeout(4_000);

  const gridState = await page.evaluate(() => {
    const rows = document.querySelectorAll('.x-grid3-row, .x-grid-row, tr.x-grid3-row');
    const w = window;
    const extCount = w.Ext?.ComponentQuery?.query?.('grid')?.length ?? 0;
    return { rowCount: rows.length, extGridCount: extCount, imgCount: document.querySelectorAll('img').length };
  });

  const dbl = await page.evaluate(() => {
    const row = document.querySelector('.x-grid3-row, .x-grid-row, tr.x-grid3-row');
    if (!row) return { ok: false };
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return { ok: true };
  });
  await page.waitForTimeout(6_000);

  const afterOpen = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')].map((i) => ({
      src: (i.getAttribute('src') || '').split('/').pop(),
      title: i.getAttribute('title') || i.getAttribute('data-qtip') || '',
    }));
    return {
      url: location.href.slice(-90),
      imgCount: imgs.length,
      rateImgs: imgs.filter((x) => /rate|detail/i.test((x.src || '') + (x.title || ''))).slice(0, 15),
      qtipHits: [...document.querySelectorAll('[data-qtip], [title]')]
        .map((n) => n.getAttribute('data-qtip') || n.getAttribute('title') || '')
        .filter((t) => /rate/i.test(t))
        .slice(0, 10),
    };
  });

  const netBeforeRate = net.length;
  const rateClick = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')];
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      const title = img.getAttribute('title') || img.getAttribute('data-qtip') || '';
      if (/rate-details/i.test(src) || /rate\s*detail/i.test(title)) {
        img.click();
        img.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const p = img.closest('a,button,div,span,td');
        if (p) p.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: true, via: 'img', src: src.split('/').pop(), title };
      }
    }
    const byQtip = [...document.querySelectorAll('[data-qtip], [title]')].find((n) =>
      /rate\s*detail/i.test(n.getAttribute('data-qtip') || n.getAttribute('title') || ''),
    );
    if (byQtip) {
      byQtip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return { ok: true, via: 'qtip' };
    }
    return { ok: false, imgCount: imgs.length };
  });
  await page.waitForTimeout(6_000);

  const afterRate = await page.evaluate(() => ({
    url: location.href.slice(-90),
    imgCount: document.querySelectorAll('img').length,
    winCount: document.querySelectorAll('.x-window, .x-window-dlg').length,
    bodySnippet: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
  }));

  const harvested = [...new Set(net.map((n) => `${n.method}:${n.path}`))];
  const afterPosts = net.slice(netBeforeRate);

  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    more,
    fd,
    gs,
    uiAfterMenu,
    filled,
    runClick,
    gridState,
    dbl,
    afterOpen,
    rateClick,
    afterRate,
    harvested,
    afterPosts,
  };
  await mkdir(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      more: more.ok,
      fd: fd.ok,
      gs: gs.ok,
      uiAfterMenu,
      filled,
      gridState,
      dbl,
      afterOpen: { imgCount: afterOpen.imgCount, rateImgs: afterOpen.rateImgs, qtipHits: afterOpen.qtipHits },
      rateClick,
      afterRate: { winCount: afterRate.winCount, imgCount: afterRate.imgCount },
      harvestedTail: afterPosts.slice(0, 20),
      harvestedPaths: harvested.slice(-25),
    }) + '\n',
  );
  await browser.close();
}

main().catch((e) => {
  process.stderr.write(scrub(e instanceof Error ? e.message : 'fail').slice(0, 240) + '\n');
  process.exit(1);
});
