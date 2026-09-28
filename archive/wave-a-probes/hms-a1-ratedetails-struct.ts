/**
 * Extract ratedetails* / menu action structure from OSRESV.HDR (keys+structure only).
 * HMS_DISCOVERY_ALLOW_LIVE=1 + HMS_PROOF_EXACT_CANDIDATE_PATH.
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
    process.env.HMS_A1_RATE_STRUCT_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/ratedetails-struct.v1.json';

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
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
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

  const result = await page.evaluate(async (exact) => {
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
    if (!conf) return { ok: false };

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

    // Collect structural snippets around rate-detail tokens (no PII values)
    const snippets: string[] = [];
    const re = /ratedetails[a-z_]*/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(hdrText)) && snippets.length < 20) {
      const start = Math.max(0, m.index - 100);
      const end = Math.min(hdrText.length, m.index + 200);
      let snip = hdrText.slice(start, end);
      snip = snip
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
        .replace(/\d{6,}/g, '[n]')
        .replace(/"[A-Za-z][^"]{20,}"/g, (q) =>
          /rate|menu|detail|function|class|path|url|screen/i.test(q)
            ? q
            : '"[str]"',
        );
      snippets.push(snip);
    }

    // Find quoted tokens that look like function codes near rate
    const fnHits = [
      ...new Set(
        [
          ...hdrText.matchAll(
            /["']([A-Z]{4,8}(?:\.[A-Z0-9]{2,8})?)["']/g,
          ),
        ]
          .map((x) => x[1]!)
          .filter((s) => /RAT|RDT|RINF|NIGHT|DET|OSR|FOL|DEP|GUEST/i.test(s)),
      ),
    ].slice(0, 40);

    // actions / toolbar / menu objects
    const actionSnips: string[] = [];
    for (const key of [
      'ratedetailsmenu',
      'ratedetails',
      'actions',
      'toolbar',
      'screenflow',
      'popup',
    ]) {
      const idx = hdrText.toLowerCase().indexOf(key);
      if (idx < 0) continue;
      let snip = hdrText.slice(Math.max(0, idx - 80), idx + 300);
      snip = snip
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
        .replace(/\d{6,}/g, '[n]');
      actionSnips.push(snip);
    }

    // Try common popup open patterns: SYSTEM_FUNCTION_NAME from screenflow
    const screenflowFns = [
      ...new Set(
        [
          ...hdrText.matchAll(
            /SYSTEM_FUNCTION_NAME["']?\s*[:=]\s*["']([A-Z0-9.]+)["']/gi,
          ),
        ].map((x) => x[1]!),
      ),
    ].slice(0, 40);

    // Soft-open fnHits
    const probes: Record<
      string,
      { status: number; bytes: number; keyHits: string[] }
    > = {};
    for (const path of [...new Set([...fnHits, ...screenflowFns])].slice(
      0,
      30,
    )) {
      const name = path.split('.')[0]!;
      const tab = path.includes('.') ? path.split('.')[1]! : '';
      try {
        const r = await fetch(`/web/base/${path}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            ...base,
            SYSTEM_FUNCTION_NAME: name,
            USER_FUNCTION_NAME: name,
            CURRENT_TAB_NAME: tab,
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
            ].map((x) => x[1]!),
          ),
        ].slice(0, 30);
        probes[path] = { status: r.status, bytes: text.length, keyHits };
      } catch {
        probes[path] = { status: 0, bytes: 0, keyHits: [] };
      }
    }

    return {
      ok: true,
      hdrBytes: hdrText.length,
      snippets,
      actionSnips,
      fnHits,
      screenflowFns,
      probes,
    };
  }, exactConf);

  await mkdir(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      hdrBytes: result.hdrBytes,
      fnHits: result.fnHits,
      screenflowFns: result.screenflowFns,
      snippetCount: result.snippets?.length,
      actionSnipCount: result.actionSnips?.length,
      snippets: result.snippets?.slice(0, 8),
      actionSnips: result.actionSnips?.slice(0, 6),
      realProbes: Object.entries(result.probes || {})
        .filter(
          ([, v]) =>
            (v as { status: number; bytes: number }).status === 200 &&
            (v as { bytes: number }).bytes > 2000,
        )
        .map(([path, v]) => ({
          path,
          bytes: (v as { bytes: number }).bytes,
          keyHits: (v as { keyHits: string[] }).keyHits,
        })),
      probeSummary: Object.fromEntries(
        Object.entries(result.probes || {}).map(([k, v]) => [
          k,
          `${(v as { status: number }).status}/${(v as { bytes: number }).bytes}`,
        ]),
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
