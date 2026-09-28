/**
 * Probe rate_gst / ratedetails action soft-open variants after HDR.
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
    process.env.HMS_A1_RATE_GST_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/rate-gst-probes.v1.json';

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

  const probes = await page.evaluate(async (exact) => {
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
    const stayId = String(row.id);
    const conf = String(row.confirmationnumber);
    const base: Record<string, string> = {
      confirmationnumber: conf,
      reservationstayid: stayId,
      id: stayId,
      propertycode: 'HRCEN',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
    };
    await fetch('/web/base/OSRESV.HDR', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...base, CURRENT_TAB_NAME: 'HDR' }).toString(),
    });

    const tries: Array<{ path: string; body: Record<string, string>; tag: string }> =
      [
        {
          path: 'OSRESV',
          tag: 'ratedetailsmenu=rate_gst',
          body: { ...base, CURRENT_TAB_NAME: 'HDR', ratedetailsmenu: 'rate_gst' },
        },
        {
          path: 'OSRESV',
          tag: 'ratedetails=rate_gst',
          body: { ...base, CURRENT_TAB_NAME: 'HDR', ratedetails: 'rate_gst' },
        },
        {
          path: 'OSRESV',
          tag: 'action=ratedetails',
          body: { ...base, CURRENT_TAB_NAME: 'HDR', action: 'ratedetails' },
        },
        {
          path: 'OSRESV',
          tag: 'action=rate_gst',
          body: { ...base, CURRENT_TAB_NAME: 'HDR', action: 'rate_gst' },
        },
        {
          path: 'OSRESV',
          tag: 'MENU_ACTION=rate_gst',
          body: { ...base, CURRENT_TAB_NAME: 'HDR', MENU_ACTION: 'rate_gst' },
        },
        {
          path: 'OSRESV.rate_gst',
          tag: 'path.rate_gst',
          body: { ...base, CURRENT_TAB_NAME: 'rate_gst' },
        },
        {
          path: 'OSRESV.RATE_GST',
          tag: 'path.RATE_GST',
          body: { ...base, CURRENT_TAB_NAME: 'RATE_GST' },
        },
        {
          path: 'OSRGST',
          tag: 'fn.OSRGST',
          body: {
            ...base,
            SYSTEM_FUNCTION_NAME: 'OSRGST',
            USER_FUNCTION_NAME: 'OSRGST',
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: '',
          },
        },
        {
          path: 'OSGSRT',
          tag: 'fn.OSGSRT',
          body: {
            ...base,
            SYSTEM_FUNCTION_NAME: 'OSGSRT',
            USER_FUNCTION_NAME: 'OSGSRT',
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: '',
          },
        },
        {
          path: 'OSRDTL',
          tag: 'fn.OSRDTL',
          body: {
            ...base,
            SYSTEM_FUNCTION_NAME: 'OSRDTL',
            USER_FUNCTION_NAME: 'OSRDTL',
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: '',
          },
        },
        {
          path: 'OSRDET',
          tag: 'fn.OSRDET',
          body: {
            ...base,
            SYSTEM_FUNCTION_NAME: 'OSRDET',
            USER_FUNCTION_NAME: 'OSRDET',
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: '',
          },
        },
        {
          path: 'OSNRAT',
          tag: 'fn.OSNRAT',
          body: {
            ...base,
            SYSTEM_FUNCTION_NAME: 'OSNRAT',
            USER_FUNCTION_NAME: 'OSNRAT',
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: '',
          },
        },
        {
          path: 'OSRATE',
          tag: 'fn.OSRATE',
          body: {
            ...base,
            SYSTEM_FUNCTION_NAME: 'OSRATE',
            USER_FUNCTION_NAME: 'OSRATE',
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: '',
          },
        },
        {
          path: 'OSRESV',
          tag: 'pageaction=ratedetailsmenu',
          body: {
            ...base,
            CURRENT_TAB_NAME: 'HDR',
            pageaction: 'ratedetailsmenu',
            pageactionvalue: 'rate_gst',
          },
        },
        {
          path: 'OSRESV',
          tag: 'TRIGGER_FIELD=ratedetailsmenu',
          body: {
            ...base,
            CURRENT_TAB_NAME: 'HDR',
            TRIGGER_FIELD: 'ratedetailsmenu',
            TRIGGER_VALUE: 'rate_gst',
          },
        },
      ];

    const probes: Record<
      string,
      { status: number; bytes: number; keyHits: string[]; head: string }
    > = {};
    for (const t of tries) {
      const r = await fetch(`/web/base/${t.path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(t.body).toString(),
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
      ].slice(0, 25);
      probes[`${t.path}|${t.tag}`] = {
        status: r.status,
        bytes: text.length,
        keyHits,
        head: text
          .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
          .replace(/\d{6,}/g, '[n]')
          .slice(0, 160),
      };
    }
    return probes;
  }, exactConf);

  await mkdir(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(outPath, `${JSON.stringify({ probes }, null, 2)}\n`, {
    mode: 0o600,
  });
  const real = Object.entries(probes).filter(
    ([, v]) => v.status === 200 && v.bytes > 5000 && v.keyHits.length > 5,
  );
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      real: real.map(([k, v]) => ({
        key: k,
        bytes: v.bytes,
        keyHits: v.keyHits,
      })),
      summary: Object.fromEntries(
        Object.entries(probes).map(([k, v]) => [
          k,
          `${v.status}/${v.bytes}/keys=${v.keyHits.length}`,
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
