/**
 * Soft-probe ratedetails FIELD (optional) — ratedetailsmenu is hidden on HDR.
 * Also try Ext paint: soft OSRESS → inject search → dblclick → click rate-details img.
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

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const candPath = process.env.HMS_PROOF_EXACT_CANDIDATE_PATH;
  if (!candPath) throw new Error('HMS_PROOF_EXACT_CANDIDATE_PATH required');
  const outPath =
    process.env.HMS_A1_RATE_FIELD_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/rate-details-field.v1.json';

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
    if (req.method() !== 'POST' || !req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,40})/i.exec(req.url());
    if (!m) return;
    const params = new URLSearchParams(req.postData() ?? '');
    net.push({
      path: m[1].toUpperCase(),
      tab: params.get('CURRENT_TAB_NAME'),
      user: params.get('USER_FUNCTION_NAME'),
      sys: params.get('SYSTEM_FUNCTION_NAME'),
      cls: params.get('FUNCTION_CLASS'),
      keys: [...params.keys()].slice(0, 40),
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
  await page.waitForTimeout(5_000);

  const soft = await page.evaluate(async (exact) => {
    const scrubLocal = (s) =>
      s
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
        .replace(/\b\d{7,}\b/g, '[n]');
    const post = async (path, body) => {
      const r = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
      return { status: r.status, text: await r.text() };
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
    const unused = '___NOMATCH___';
    const searchBody = {
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
    };
    const search = await post('/web/base/OSRESS.search', searchBody);
    const marker = 'pageData:';
    const idx = search.text.indexOf(marker);
    let i = idx + marker.length;
    while (i < search.text.length && /\s/.test(search.text[i])) i++;
    let depth = 0;
    let end = i;
    for (; end < search.text.length; end++) {
      if (search.text[end] === '{') depth++;
      else if (search.text[end] === '}') {
        depth--;
        if (depth === 0) {
          end++;
          break;
        }
      }
    }
    const pageData = JSON.parse(search.text.slice(i, end));
    const row = pageData.grid.GRIDRESULT.GRID.DATA[0];
    const stayId = String(row.id);
    const conf = String(row.confirmationnumber);
    const base = {
      confirmationnumber: conf,
      reservationstayid: stayId,
      id: stayId,
      propertycode: 'HRCEN',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
    };
    await post('/web/base/OSRESV.HDR', { ...base, CURRENT_TAB_NAME: 'HDR' });

    const tries = [
      {
        tag: 'TRIGGER ratedetails empty',
        path: '/web/base/OSRESV.HDR',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          TRIGGER_FIELD: 'ratedetails',
          TRIGGER_VALUE: '',
        },
      },
      {
        tag: 'TRIGGER ratedetails 1',
        path: '/web/base/OSRESV.HDR',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          TRIGGER_FIELD: 'ratedetails',
          TRIGGER_VALUE: '1',
        },
      },
      {
        tag: 'pageaction=ratedetails',
        path: '/web/base/OSRESV',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
          pageaction: 'ratedetails',
        },
      },
      {
        tag: 'ACTION_NAME=ratedetails',
        path: '/web/base/OSRESV',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
          ACTION_NAME: 'ratedetails',
        },
      },
      {
        tag: 'selectedaction=ratedetails',
        path: '/web/base/OSRESV',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
          selectedaction: 'ratedetails',
        },
      },
      {
        tag: 'ratedetails=1 on HDR',
        path: '/web/base/OSRESV.HDR',
        body: { ...base, CURRENT_TAB_NAME: 'HDR', ratedetails: '1' },
      },
      {
        tag: 'USER=ratedetails WEBL child',
        path: '/web/base/OSRESV?FUNCTION_CLASS=WEBL',
        body: {
          ...base,
          SYSTEM_FUNCTION_NAME: 'OSRESV',
          USER_FUNCTION_NAME: 'ratedetails',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
        },
      },
      {
        tag: 'POPU ratedetails child',
        path: '/web/base/OSRESV?FUNCTION_CLASS=POPU',
        body: {
          ...base,
          SYSTEM_FUNCTION_NAME: 'OSRESV',
          USER_FUNCTION_NAME: 'ratedetails',
          FUNCTION_CLASS: 'POPU',
          CURRENT_TAB_NAME: '',
        },
      },
      {
        tag: 'OSRESV.ratedetails',
        path: '/web/base/OSRESV.ratedetails',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
        },
      },
      {
        tag: 'screenflow=ratedetails',
        path: '/web/base/OSRESV',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
          screenflow: 'ratedetails',
          removescreenflows: 'no',
        },
      },
    ];
    const probes = {};
    for (const t of tries) {
      const r = await post(t.path, t.body);
      const cp = /"classPath"\s*:\s*"([^"]+)"/.exec(r.text)?.[1] ?? null;
      const msg = /"msg"\s*:\s*"([^"]{0,160})"/.exec(r.text)?.[1] ?? null;
      const keyHits = [
        ...new Set(
          [
            ...r.text.matchAll(
              /"(rate[^"\n]{0,40}|price[^"\n]{0,40}|night[^"\n]{0,40}|inventory[^"\n]{0,40}|restriction[^"\n]{0,40}|inclusion[^"\n]{0,40}|schedule[^"\n]{0,40}|date[^"\n]{0,20})"/gi,
            ),
          ].map((x) => x[1]),
        ),
      ].slice(0, 25);
      probes[t.tag] = {
        status: r.status,
        bytes: r.text.length,
        classPath: cp,
        msg: msg ? scrubLocal(msg) : null,
        keyHits,
      };
    }
    return { stayIdLen: stayId.length, confLen: conf.length, probes };
  }, exactConf);

  // Ext paint attempt: navigate OSRESS document, soft-fill via evaluate, look for grid
  await page.evaluate(async () => {
    await fetch('/web/base/OSRESS?FUNCTION_CLASS=WEBL', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'OSRESS',
        USER_FUNCTION_NAME: 'OSRESS',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      }).toString(),
    });
  });
  // Form-nav into OSRESS WEBL so Ext shell loads
  await page.goto(`${origin}/web/base/OSRESS?FUNCTION_CLASS=WEBL`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForTimeout(8_000);
  const uiBefore = await page.evaluate(() => ({
    url: location.href,
    imgCount: document.querySelectorAll('img').length,
    gridCount: document.querySelectorAll('.x-grid3-row, .x-grid-row').length,
    toolbar: [...document.querySelectorAll('img')]
      .map((i) => i.getAttribute('src') || '')
      .filter((s) => /rate|detail|toolbar/i.test(s))
      .slice(0, 20),
  }));

  // Soft search while on OSRESS page (may refresh Ext store)
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
  await page.waitForTimeout(3_000);

  // Try dblclick first grid row if any
  const gridClick = await page.evaluate(() => {
    const row = document.querySelector('.x-grid3-row, .x-grid-row, tr.x-grid3-row');
    if (!row) return { ok: false, reason: 'no_grid' };
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return { ok: true };
  });
  await page.waitForTimeout(5_000);

  const uiAfter = await page.evaluate(() => ({
    url: location.href,
    imgCount: document.querySelectorAll('img').length,
    gridCount: document.querySelectorAll('.x-grid3-row, .x-grid-row').length,
    toolbar: [...document.querySelectorAll('img')]
      .map((i) => ({
        src: (i.getAttribute('src') || '').slice(-60),
        title: i.getAttribute('title') || i.getAttribute('data-qtip') || '',
      }))
      .filter((x) => /rate|detail|toolbar/i.test(x.src + x.title))
      .slice(0, 30),
  }));

  const rateClick = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')];
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      const title = img.getAttribute('title') || img.getAttribute('data-qtip') || '';
      if (/rate-details/i.test(src) || /rate\s*detail/i.test(title)) {
        img.click();
        const p = img.closest('a,button,div,span');
        if (p) p.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { ok: true, src: src.slice(-80), title };
      }
    }
    return { ok: false, imgCount: imgs.length };
  });
  await page.waitForTimeout(5_000);

  const afterPosts = net.slice(-30);
  const out = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    soft,
    uiBefore,
    gridClick,
    uiAfter,
    rateClick,
    afterPosts,
    harvested: [...new Set(net.map((n) => n.path))],
  };
  await mkdir(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      probeSummary: Object.fromEntries(
        Object.entries(soft.probes).map(([k, v]) => [
          k,
          `${v.status}/${v.bytes}/cp=${v.classPath}/msg=${v.msg}/keys=${v.keyHits.length}`,
        ]),
      ),
      uiBefore,
      gridClick,
      uiAfter: { imgCount: uiAfter.imgCount, gridCount: uiAfter.gridCount, toolbar: uiAfter.toolbar },
      rateClick,
      harvestedTail: afterPosts.slice(-10),
    }) + '\n',
  );
  await browser.close();
}

main().catch((e) => {
  process.stderr.write(scrub(e instanceof Error ? e.message : 'fail').slice(0, 240) + '\n');
  process.exit(1);
});
