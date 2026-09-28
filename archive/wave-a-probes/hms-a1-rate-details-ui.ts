/**
 * A1: Full UI path Front Desk → Guest Stay → Run → dblclick → Rate Details svg.
 * Harvest XHR; soft-open harvested codes. HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A1_RATE_UI_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/rate-details-ui.v1.json';

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
    sample: Record<string, string>;
  }[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().startsWith(origin)) return;
    const m = /\/web\/base\/([A-Z][A-Z0-9.]{2,40})/i.exec(req.url());
    if (!m) return;
    const params = new URLSearchParams(req.postData() ?? '');
    const sample: Record<string, string> = {};
    for (const k of [
      'CURRENT_TAB_NAME',
      'SYSTEM_FUNCTION_NAME',
      'USER_FUNCTION_NAME',
      'FUNCTION_CLASS',
      'MENU_MODULE_KEY',
      'GRID_NAME',
    ]) {
      const v = params.get(k);
      if (v != null) sample[k] = v.slice(0, 48);
    }
    net.push({
      path: m[1]!.toUpperCase(),
      tab: params.get('CURRENT_TAB_NAME'),
      keys: [...params.keys()].slice(0, 50),
      sample,
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

  // Soft-open OSRESS first (A3), then menu
  await page.evaluate(async () => {
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
  });
  await page.waitForTimeout(2_000);

  await page.evaluate(() => {
    const more = [...document.querySelectorAll('a,span,button')].find(
      (n) => (n.textContent || '').trim() === 'More',
    );
    if (more) (more as HTMLElement).click();
  });
  await page.waitForTimeout(1_200);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.x-menu-item-text, span, a')].find(
      (n) => (n.textContent || '').trim() === 'Front Desk',
    );
    if (el) {
      (el as HTMLElement).dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
      (el as HTMLElement).click();
    }
  });
  await page.waitForTimeout(1_500);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.x-menu-item-text, span, a')].find(
      (n) => (n.textContent || '').trim() === 'Guest Stay',
    );
    if (el) (el as HTMLElement).click();
  });
  await page.waitForTimeout(5_000);

  // Quick-search fill exact confirmation + Enter (dataspy scaffold)
  const filled = await page.evaluate((conf) => {
    const inputs = [
      ...document.querySelectorAll('input[type=text], input:not([type])'),
    ] as HTMLInputElement[];
    const search =
      inputs.find((i) =>
        /search|confirm|filter/i.test(
          (i.name || '') + (i.id || '') + (i.placeholder || ''),
        ),
      ) || inputs[0];
    if (!search) return { ok: false, reason: 'no_input' };
    search.focus();
    search.value = conf;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    search.dispatchEvent(new Event('change', { bubbles: true }));
    search.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    search.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }),
    );
    return { ok: true, name: search.name || search.id || 'anon' };
  }, exactConf);
  await page.waitForTimeout(2_000);

  // Also click Run
  const runClick = await page.evaluate(() => {
    const run = [...document.querySelectorAll('.x-btn-inner, button, span')].find(
      (n) => (n.textContent || '').trim() === 'Run',
    );
    if (!run) return false;
    (run as HTMLElement).click();
    return true;
  });
  await page.waitForTimeout(8_000);

  const opened = await page.evaluate((conf) => {
    const w = window as unknown as {
      Ext?: {
        ComponentQuery?: {
          query: (s: string) => Array<Record<string, unknown>>;
        };
      };
    };
    const grids = w.Ext?.ComponentQuery?.query('grid') ?? [];
    const grid =
      grids.find((g) => {
        const sid = String(
          (g.store as { storeId?: string } | undefined)?.storeId ?? '',
        );
        return /osress/i.test(sid);
      }) ?? grids[0];
    if (!grid) {
      return {
        ok: false,
        reason: 'no_grid',
        gridCount: grids.length,
        imgs: [...document.querySelectorAll('img')]
          .map((i) => i.getAttribute('src') || '')
          .filter((s) => /rate|toolbar/i.test(s))
          .slice(0, 10),
      };
    }
    const store = grid.store as {
      getCount?: () => number;
      getAt?: (i: number) => { data?: Record<string, unknown> };
      storeId?: string;
      findBy?: (
        fn: (rec: { data?: Record<string, unknown> }) => boolean,
      ) => unknown;
    };
    const count = store?.getCount?.() ?? 0;
    let rec: unknown = null;
    if (store?.findBy) {
      rec = store.findBy(
        (r) => String(r.data?.confirmationnumber || '') === conf,
      );
    }
    if (!rec && count > 0) rec = store.getAt?.(0);
    if (!rec) {
      return {
        ok: false,
        reason: 'empty',
        storeCount: count,
        storeId: store?.storeId,
      };
    }
    try {
      (
        grid.getSelectionModel as
          | (() => { select: (r: unknown) => void })
          | undefined
      )?.().select(rec);
    } catch {
      /* ignore */
    }
    try {
      (grid as { fireEvent?: (e: string, g: unknown, r: unknown) => void }).fireEvent?.(
        'itemdblclick',
        grid,
        rec,
      );
    } catch {
      /* ignore */
    }
    return { ok: true, storeCount: count, storeId: store?.storeId };
  }, exactConf);
  await page.waitForTimeout(7_000);

  const beforeRate = net.length;
  const rateClick = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img, image')];
    const hits: string[] = [];
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      const title =
        img.getAttribute('title') ||
        img.getAttribute('data-qtip') ||
        img.getAttribute('alt') ||
        '';
      if (/rate-details/i.test(src) || /rate\s*detail/i.test(title)) {
        hits.push((src || title).slice(-60));
        try {
          (img as HTMLElement).click();
          const parent = img.closest('a,button,div,span');
          if (parent) (parent as HTMLElement).click();
        } catch {
          /* ignore */
        }
      }
    }
    // Ext toolbar buttons
    const w = window as unknown as {
      Ext?: {
        ComponentQuery?: {
          query: (s: string) => Array<Record<string, unknown>>;
        };
      };
    };
    const comps = [
      ...(w.Ext?.ComponentQuery?.query('button') ?? []),
      ...(w.Ext?.ComponentQuery?.query('tool') ?? []),
      ...(w.Ext?.ComponentQuery?.query('[tooltip]') ?? []),
    ];
    for (const c of comps) {
      const tip = String(
        c.tooltip || c.qtip || c.text || c.ariaLabel || c.icon || '',
      );
      const icon = String(c.icon || c.iconCls || '');
      if (/rate.?detail/i.test(tip + icon)) {
        hits.push('ext:' + (tip || icon).slice(0, 60));
        try {
          (c as { fireEvent?: (e: string) => void }).fireEvent?.('click');
          (c as { handler?: () => void }).handler?.();
          (c as { el?: { dom?: HTMLElement } }).el?.dom?.click();
        } catch {
          /* ignore */
        }
      }
    }
    const toolbarImgs = imgs
      .map((i) => i.getAttribute('src') || '')
      .filter((s) => /toolbar/i.test(s))
      .slice(0, 30);
    return {
      hits: hits.slice(0, 20),
      toolbarImgs,
      tabTitles: (
        w.Ext?.ComponentQuery?.query('tabpanel') ?? []
      ).flatMap((p) =>
        ((p.items as { items?: Array<{ title?: string }> })?.items ?? []).map(
          (i) => String(i.title ?? ''),
        ),
      ).slice(0, 30),
    };
  });
  await page.waitForTimeout(6_000);

  const after = net.slice(beforeRate);
  const allAfterOpen = net.slice(beforeRate > 0 ? beforeRate - 5 : 0);

  // Soft-open any new paths
  const harvested = [
    ...new Set(
      after
        .concat(allAfterOpen)
        .map((n) => n.path)
        .filter((p) => !/^OSRESS(\.|$)/i.test(p) || /RATE|RDT|RINF|NIGHT|DET/i.test(p)),
    ),
  ].filter((p) => /RATE|RDT|RINF|NIGHT|DET|OSR|FOL|DEP|NRAT/i.test(p));

  const softOpens = await page.evaluate(
    async ({ paths, exact }) => {
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
      let stayId: string | null = null;
      let conf: string | null = null;
      try {
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
        const row = data[0];
        if (row) {
          stayId = row.id != null ? String(row.id) : null;
          conf =
            row.confirmationnumber != null
              ? String(row.confirmationnumber)
              : null;
        }
      } catch {
        /* ignore */
      }
      const out: Record<
        string,
        { status: number; bytes: number; keyHits: string[] }
      > = {};
      if (!conf) return out;
      for (const path of paths) {
        const name = path.split('.')[0]!;
        const tab = path.includes('.') ? path.split('.')[1]! : '';
        const body: Record<string, string> = {
          SYSTEM_FUNCTION_NAME: name,
          USER_FUNCTION_NAME: name,
          CURRENT_TAB_NAME: tab,
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
          confirmationnumber: conf,
          propertycode: 'HRCEN',
          FUNCTION_CLASS: 'WEBL',
        };
        if (stayId) {
          body.reservationstayid = stayId;
          body.id = stayId;
        }
        try {
          const r = await fetch(`/web/base/${path}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(body).toString(),
          });
          const text = await r.text();
          const keyHits = [
            ...new Set(
              [
                ...text.matchAll(
                  /"(rate[^"]*|price[^"]*|night[^"]*|inventory[^"]*|restriction[^"]*|inclusion[^"]*|tax[^"]*|fee[^"]*)"/gi,
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
    { paths: harvested.slice(0, 25), exact: exactConf },
  );

  const payload = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    filled,
    runClick,
    opened,
    rateClick,
    harvested,
    afterPosts: after.slice(0, 80),
    softOpens,
    allPaths: [...new Set(net.map((n) => n.path))].slice(0, 120),
  };

  await mkdir(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      filled,
      runClick,
      opened,
      rateClick: {
        hits: rateClick.hits,
        toolbarImgCount: rateClick.toolbarImgs.length,
        toolbarImgsSample: rateClick.toolbarImgs.slice(0, 15),
        tabTitles: rateClick.tabTitles,
      },
      harvested,
      afterPostCount: after.length,
      softOpens,
      interesting: after.filter((n) =>
        /RATE|RDT|RINF|NIGHT|DET|OSR|FOL/i.test(n.path),
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
