/**
 * A1: after login, navigate OSRESV WEBL UI → open exact stay → click rate-details.svg.
 * Harvest XHR for Rate Details popup. HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const candPath = process.env.HMS_PROOF_EXACT_CANDIDATE_PATH;
  if (!candPath) throw new Error('HMS_PROOF_EXACT_CANDIDATE_PATH required');
  const outPath =
    process.env.HMS_A1_RATE_NAV_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/rate-details-nav.v1.json';

  const raw = JSON.parse(await readFile(candPath, 'utf8')) as {
    kind?: string;
    value?: string;
  };
  if (raw.kind !== 'confirmation' || !raw.value) {
    throw new Error('exact confirmation candidate required');
  }
  const exactConf = raw.value;

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error('secret empty');
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
  const net: {
    path: string;
    tab: string | null;
    keys: string[];
    bytes: number;
  }[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,40})/i.exec(req.url());
    if (!m) return;
    const params = new URLSearchParams(req.postData() ?? '');
    net.push({
      path: m[1]!.toUpperCase(),
      tab: params.get('CURRENT_TAB_NAME'),
      keys: [...params.keys()].slice(0, 50),
      bytes: Buffer.byteLength(req.postData() ?? ''),
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

  // Soft warm + soft OSRESS.search to get stay id, then soft HDR
  const stay = await page.evaluate(async (exact) => {
    for (const path of ['/web/base/BSSTRT.HDR', '/web/base/BSSTRT']) {
      await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'BSSTRT',
          USER_FUNCTION_NAME: 'BSSTRT',
          manurefresh: 'yes',
        }).toString(),
      }).catch(() => undefined);
    }
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
    const unused = '___NOMATCH___';
    const searchBody: Record<string, string> = {
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
    const search = await fetch('/web/base/OSRESS.search', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(searchBody).toString(),
    });
    const searchText = await search.text();
    const marker = 'pageData:';
    const idx = searchText.indexOf(marker);
    let i = idx + marker.length;
    while (i < searchText.length && /\s/.test(searchText[i]!)) i++;
    let depth = 0;
    let end = i;
    for (; end < searchText.length; end++) {
      if (searchText[end] === '{') depth++;
      else if (searchText[end] === '}') {
        depth--;
        if (depth === 0) {
          end++;
          break;
        }
      }
    }
    const pageData = JSON.parse(searchText.slice(i, end)) as Record<
      string,
      unknown
    >;
    const grid = pageData.grid as Record<string, unknown>;
    const data = (
      (grid.GRIDRESULT as Record<string, unknown>).GRID as Record<
        string,
        unknown
      >
    ).DATA as Array<Record<string, unknown>>;
    const row = data[0]!;
    return {
      conf: String(row.confirmationnumber),
      stayId: String(row.id),
    };
  }, exactConf);

  // Navigate browser to OSRESV with stay keys via form POST navigation
  await page.evaluate(
    async ({ conf, stayId }) => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/web/base/OSRESV?FUNCTION_CLASS=WEBL';
      const fields: Record<string, string> = {
        SYSTEM_FUNCTION_NAME: 'OSRESV',
        USER_FUNCTION_NAME: 'OSRESV',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: 'HDR',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
        confirmationnumber: conf,
        reservationstayid: stayId,
        id: stayId,
        propertycode: 'HRCEN',
      };
      for (const [k, v] of Object.entries(fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = k;
        input.value = v;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    },
    stay,
  );
  await page.waitForTimeout(8_000);

  const uiState = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')]
      .map((i) => ({
        src: (i.getAttribute('src') || '').slice(-80),
        title: i.getAttribute('title') || i.getAttribute('data-qtip') || '',
      }))
      .filter((x) => /toolbar|rate/i.test(x.src + x.title))
      .slice(0, 40);
    const w = window as unknown as {
      Ext?: {
        ComponentQuery?: {
          query: (s: string) => Array<Record<string, unknown>>;
        };
      };
    };
    return {
      url: location.href.slice(0, 120),
      title: document.title,
      imgCount: document.querySelectorAll('img').length,
      toolbarImgs: imgs,
      tabTitles: (w.Ext?.ComponentQuery?.query('tabpanel') ?? [])
        .flatMap((p) =>
          (
            (p.items as { items?: Array<{ title?: string }> })?.items ?? []
          ).map((i) => String(i.title ?? '')),
        )
        .slice(0, 30),
      btnCount: (w.Ext?.ComponentQuery?.query('button') ?? []).length,
    };
  });

  const mark = net.length;
  const rateClick = await page.evaluate(() => {
    const hits: string[] = [];
    for (const img of document.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      const title =
        img.getAttribute('title') ||
        img.getAttribute('data-qtip') ||
        img.getAttribute('alt') ||
        '';
      if (/rate-details/i.test(src) || /rate\s*detail/i.test(title)) {
        hits.push((src || title).slice(-70));
        try {
          (img as HTMLElement).click();
          img.closest('a,button,div,span')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true }),
          );
        } catch {
          /* ignore */
        }
      }
    }
    const w = window as unknown as {
      Ext?: {
        ComponentQuery?: {
          query: (s: string) => Array<Record<string, unknown>>;
        };
      };
    };
    for (const c of w.Ext?.ComponentQuery?.query('button') ?? []) {
      const tip = String(c.tooltip || c.qtip || c.text || c.icon || '');
      if (/rate.?detail/i.test(tip)) {
        hits.push('ext:' + tip.slice(0, 60));
        try {
          (c as { fireEvent?: (e: string) => void }).fireEvent?.('click');
          (c as { el?: { dom?: HTMLElement } }).el?.dom?.click();
        } catch {
          /* ignore */
        }
      }
    }
    return hits.slice(0, 20);
  });
  await page.waitForTimeout(6_000);

  const after = net.slice(mark);
  const harvested = [...new Set(after.map((n) => n.path))];

  // Soft-open harvested non-OSRESS paths
  const softOpens = await page.evaluate(
    async ({ paths, conf, stayId }) => {
      const out: Record<
        string,
        { status: number; bytes: number; keyHits: string[] }
      > = {};
      for (const path of paths) {
        const name = path.split('.')[0]!;
        const tab = path.includes('.') ? path.split('.')[1]! : '';
        try {
          const r = await fetch(`/web/base/${path}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: name,
              USER_FUNCTION_NAME: name,
              CURRENT_TAB_NAME: tab,
              MENU_MODULE_KEY: '0',
              removescreenflows: 'yes',
              confirmationnumber: conf,
              reservationstayid: stayId,
              id: stayId,
              propertycode: 'HRCEN',
              FUNCTION_CLASS: 'WEBL',
            }).toString(),
          });
          const text = await r.text();
          const keyHits = [
            ...new Set(
              [
                ...text.matchAll(
                  /"(rate[^"]*|price[^"]*|night[^"]*|inventory[^"]*|restriction[^"]*|inclusion[^"]*)"/gi,
                ),
              ].map((m) => m[1]!),
            ),
          ].slice(0, 40);
          out[path] = { status: r.status, bytes: text.length, keyHits };
        } catch {
          out[path] = { status: 0, bytes: 0, keyHits: [] };
        }
      }
      return out;
    },
    { paths: harvested.filter((p) => !/^LOGINDISP$/i.test(p)).slice(0, 20), ...stay },
  );

  const payload = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    stayKeys: { hasConf: true, hasStayId: Boolean(stay.stayId) },
    uiState,
    rateClick,
    harvested,
    afterPosts: after.slice(0, 40),
    softOpens,
  };

  await mkdir(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      uiState,
      rateClick,
      harvested,
      afterPostCount: after.length,
      softOpens,
      interesting: after.filter((n) =>
        /RATE|RDT|DET|OSR|NIGHT|GST|POPU/i.test(n.path),
      ),
    }) + '\n',
  );
  await browser.close();
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : 'fail';
  process.stderr.write(
    msg.replace(/arn:aws:\S+/gi, '[arn]').slice(0, 240) + '\n',
  );
  process.exit(1);
});
