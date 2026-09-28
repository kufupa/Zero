/**
 * Mine OSRESV.HDR for Rate Details action wiring; soft-probe harvested open shapes.
 * HMS_DISCOVERY_ALLOW_LIVE=1 + HMS_PROOF_EXACT_CANDIDATE_PATH.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

function scrub(s: string): string {
  return s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/\b\d{7,}\b/g, '[n]');
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const candPath = process.env.HMS_PROOF_EXACT_CANDIDATE_PATH;
  if (!candPath) throw new Error('HMS_PROOF_EXACT_CANDIDATE_PATH required');
  const outPath =
    process.env.HMS_A1_RATE_MINE_OUT ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a1-payload/rate-action-mine.v1.json';

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

  const out = await page.evaluate(async (exact) => {
    const scrubLocal = (s: string) =>
      s
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
        .replace(/\b\d{7,}\b/g, '[n]');
    const post = async (path: string, body: Record<string, string>) => {
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
    const search = await post('/web/base/OSRESS.search', searchBody);
    const marker = 'pageData:';
    const idx = search.text.indexOf(marker);
    let i = idx + marker.length;
    while (i < search.text.length && /\s/.test(search.text[i]!)) i++;
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
    const pageData = JSON.parse(search.text.slice(i, end)) as Record<
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
    const hdr = await post('/web/base/OSRESV.HDR', {
      ...base,
      CURRENT_TAB_NAME: 'HDR',
    });
    const text = hdr.text;
    const windows: string[] = [];
    const re = /rate[_]?gst|ratedetailsmenu|ratedetails|Rate Details|rate-details/gi;
    let m: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((m = re.exec(text))) {
      const start = Math.max(0, m.index - 200);
      const end2 = Math.min(text.length, m.index + 260);
      const snip = scrubLocal(text.slice(start, end2)).replace(/\s+/g, ' ');
      if (!seen.has(snip)) {
        seen.add(snip);
        windows.push(snip);
      }
      if (windows.length >= 50) break;
    }
    const menuIdx = text.indexOf('"ratedetailsmenu"');
    const menuBlock =
      menuIdx >= 0
        ? scrubLocal(text.slice(menuIdx, menuIdx + 800)).replace(/\s+/g, ' ')
        : null;
    const actionsIdx = text.search(/"actions"\s*:/);
    const actionsBlock =
      actionsIdx >= 0
        ? scrubLocal(text.slice(actionsIdx, actionsIdx + 1200)).replace(
            /\s+/g,
            ' ',
          )
        : null;
    const fnHits = [
      ...new Set(
        [...text.matchAll(/\b(OS[A-Z0-9]{3,10}|rate_[a-z0-9]{2,12})\b/g)].map(
          (x) => x[1]!,
        ),
      ),
    ]
      .filter((x) => /rate|OSR|OSG|OSN|OST|OSF/i.test(x))
      .slice(0, 80);

    const tries: Array<{
      tag: string;
      path: string;
      body: Record<string, string>;
    }> = [
      {
        tag: 'ACTION_NAME=rate_gst',
        path: '/web/base/OSRESV',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
          ACTION_NAME: 'rate_gst',
        },
      },
      {
        tag: 'actionname=rate_gst',
        path: '/web/base/OSRESV',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
          actionname: 'rate_gst',
        },
      },
      {
        tag: 'selectedaction=rate_gst',
        path: '/web/base/OSRESV',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
          selectedaction: 'rate_gst',
        },
      },
      {
        tag: 'USER=rate_gst POPU child',
        path: '/web/base/OSRESV?FUNCTION_CLASS=POPU',
        body: {
          ...base,
          SYSTEM_FUNCTION_NAME: 'OSRESV',
          USER_FUNCTION_NAME: 'rate_gst',
          FUNCTION_CLASS: 'POPU',
          CURRENT_TAB_NAME: '',
        },
      },
      {
        tag: 'USER=ratedetails POPU',
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
        tag: 'screenflow=rate_gst',
        path: '/web/base/OSRESV',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
          screenflow: 'rate_gst',
          removescreenflows: 'no',
        },
      },
      {
        tag: 'additionalfunction=rate_gst',
        path: '/web/base/OSRESV',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
          additionalfunction: 'rate_gst',
        },
      },
      {
        tag: 'callfunction=rate_gst',
        path: '/web/base/OSRESV',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
          callfunction: 'rate_gst',
        },
      },
      {
        tag: 'popupfunction=rate_gst',
        path: '/web/base/OSRESV',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
          popupfunction: 'rate_gst',
        },
      },
      {
        tag: 'OSRESV.ratedetailsmenu',
        path: '/web/base/OSRESV.ratedetailsmenu',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
          ratedetailsmenu: 'rate_gst',
        },
      },
      {
        tag: 'HDR ratedetailsmenu DATA_ONLY',
        path: '/web/base/OSRESV.HDR',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          ratedetailsmenu: 'rate_gst',
          COMPONENT_INFO_TYPE: 'DATA_ONLY',
        },
      },
      {
        tag: 'pageaction ratedetailsmenu POPU',
        path: '/web/base/OSRESV?FUNCTION_CLASS=POPU',
        body: {
          ...base,
          SYSTEM_FUNCTION_NAME: 'OSRESV',
          USER_FUNCTION_NAME: 'OSRESV',
          FUNCTION_CLASS: 'POPU',
          CURRENT_TAB_NAME: '',
          pageaction: 'ratedetailsmenu',
          pageactionvalue: 'rate_gst',
        },
      },
      {
        tag: 'menukey ratedetailsmenu',
        path: '/web/base/OSRESV',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          FUNCTION_CLASS: 'WEBL',
          MENU_MODULE_KEY: 'ratedetailsmenu',
          ratedetailsmenu: 'rate_gst',
        },
      },
      {
        tag: 'trigger ratedetails=rate_gst',
        path: '/web/base/OSRESV.HDR',
        body: {
          ...base,
          CURRENT_TAB_NAME: 'HDR',
          TRIGGER_FIELD: 'ratedetails',
          TRIGGER_VALUE: 'rate_gst',
        },
      },
    ];

    const probes: Record<
      string,
      {
        status: number;
        bytes: number;
        classPath: string | null;
        msg: string | null;
        keyHits: string[];
      }
    > = {};
    for (const t of tries) {
      const r = await post(t.path, t.body);
      const cp =
        /"classPath"\s*:\s*"([^"]+)"/.exec(r.text)?.[1] ?? null;
      const msgRaw = /"msg"\s*:\s*"([^"]{0,160})"/.exec(r.text)?.[1] ?? null;
      const keyHits = [
        ...new Set(
          [
            ...r.text.matchAll(
              /"(rate[^"\n]{0,40}|price[^"\n]{0,40}|night[^"\n]{0,40}|inventory[^"\n]{0,40}|restriction[^"\n]{0,40}|inclusion[^"\n]{0,40}|schedule[^"\n]{0,40})"/gi,
            ),
          ].map((x) => x[1]!),
        ),
      ].slice(0, 20);
      probes[t.tag] = {
        status: r.status,
        bytes: r.text.length,
        classPath: cp,
        msg: msgRaw ? scrubLocal(msgRaw) : null,
        keyHits,
      };
    }
    return {
      hdrBytes: text.length,
      windows,
      menuBlock,
      actionsBlock,
      fnHits,
      probes,
      stayOk: Boolean(stayId && conf),
    };
  }, exactConf);

  await mkdir(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outPath,
      hdrBytes: out.hdrBytes,
      windowCount: out.windows.length,
      fnHits: out.fnHits,
      menuBlock: out.menuBlock?.slice(0, 400),
      probeSummary: Object.fromEntries(
        Object.entries(out.probes).map(([k, v]) => [
          k,
          `${v.status}/${v.bytes}/cp=${v.classPath}/msg=${v.msg}/keys=${v.keyHits.length}`,
        ]),
      ),
    }) + '\n',
  );
  await browser.close();
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : 'fail';
  process.stderr.write(
    scrub(msg).replace(/arn:aws:\S+/gi, '[arn]').slice(0, 240) + '\n',
  );
  process.exit(1);
});
