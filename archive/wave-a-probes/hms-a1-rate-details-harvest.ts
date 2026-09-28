/**
 * A1: Guest Stay detail → click Rate Details action → harvest XHR codes.
 * Soft-open harvested paths with reservation keys. HMS_DISCOVERY_ALLOW_LIVE=1.
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
    process.env.HMS_A1_RATE_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/rate-details-harvest.v1.json';

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
      'COMPONENT_INFO_TYPE',
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
  await page.waitForTimeout(4_000);

  // Soft open detail via search + HDR (reliable)
  const soft = await page.evaluate(async (exact) => {
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
    if (!conf) return { ok: false, searchBytes: searchText.length };
    const base: Record<string, string> = {
      confirmationnumber: conf,
      propertycode: 'HRCEN',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
      CURRENT_TAB_NAME: 'HDR',
    };
    if (stayId) {
      base.reservationstayid = stayId;
      base.id = stayId;
    }
    const hdr = await fetch('/web/base/OSRESV.HDR', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(base).toString(),
    });
    const hdrText = await hdr.text();
    // Inject HDR HTML into DOM so action buttons exist if returned as form
    try {
      const div = document.createElement('div');
      div.id = 'nava-hdr-inject';
      div.innerHTML = hdrText.slice(0, 200000);
      document.body.appendChild(div);
    } catch {
      /* ignore */
    }
    return {
      ok: true,
      hdrBytes: hdrText.length,
      hasStayId: Boolean(stayId),
      confLen: conf.length,
    };
  }, exactConf);
  await page.waitForTimeout(1_000);

  const mark = net.length;

  // Click anything that looks like Rate Details (toolbar / title / aria)
  const clickRate = await page.evaluate(() => {
    const labels = [
      'Rate Details',
      'Rate details',
      'Rate Detail',
      'View Rate Details',
    ];
    const nodes = [
      ...document.querySelectorAll(
        'a,button,span,div,img,[title],[data-qtip],[aria-label]',
      ),
    ];
    const hits: string[] = [];
    for (const n of nodes) {
      const t = (
        (n.textContent || '') +
        ' ' +
        (n.getAttribute('title') || '') +
        ' ' +
        (n.getAttribute('data-qtip') || '') +
        ' ' +
        (n.getAttribute('aria-label') || '')
      )
        .replace(/\s+/g, ' ')
        .trim();
      if (/rate\s*detail/i.test(t)) {
        hits.push(t.slice(0, 80));
        try {
          (n as HTMLElement).click();
        } catch {
          /* ignore */
        }
      }
    }
    // Ext button query by tooltip
    const w = window as unknown as {
      Ext?: {
        ComponentQuery?: {
          query: (s: string) => Array<Record<string, unknown>>;
        };
      };
    };
    const btns = w.Ext?.ComponentQuery?.query('button') ?? [];
    for (const b of btns) {
      const tip = String(
        b.tooltip || b.qtip || b.text || b.ariaLabel || '',
      );
      if (/rate\s*detail/i.test(tip)) {
        hits.push('ext:' + tip.slice(0, 60));
        try {
          (b as { fireEvent?: (e: string) => void }).fireEvent?.('click');
          (b as { handler?: () => void }).handler?.();
        } catch {
          /* ignore */
        }
      }
    }
    return { hits: hits.slice(0, 20), btnCount: btns.length };
  });
  await page.waitForTimeout(5_000);

  const after = net.slice(mark);

  // Soft-open any newly harvested unique paths with stay keys
  const harvestedPaths = [
    ...new Set(
      after
        .map((n) => n.path)
        .filter((p) => /RATE|RDET|RDTL|RDT|OSR|FOL|DEP/i.test(p)),
    ),
  ];

  const softOpens = await page.evaluate(
    async ({ paths, exact }) => {
      // re-resolve stay id quickly
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
      const out: Record<string, { status: number; bytes: number; keyHits: string[] }> =
        {};
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
    { paths: harvestedPaths.slice(0, 20), exact: exactConf },
  );

  const payload = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    soft,
    clickRate,
    harvestedPaths,
    afterPosts: after.slice(0, 60),
    softOpens,
    allPaths: [...new Set(net.map((n) => n.path))].slice(0, 100),
  };

  await mkdir(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      soft,
      clickRate,
      harvestedPaths,
      afterPostCount: after.length,
      softOpens,
      interesting: after.filter((n) =>
        /RATE|RDET|RDTL|RDT|DEP|FOL|OSR/i.test(n.path),
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
