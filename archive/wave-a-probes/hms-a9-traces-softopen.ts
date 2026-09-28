/**
 * A9: OSRESS.search (dataspy 1941) → reservation keys → soft-open
 * OSRESV/OSRESS .HDR/.TRC/.NTE (A8 BPF pattern). HMS_DISCOVERY_ALLOW_LIVE=1.
 *
 * Optional: HMS_PROOF_EXACT_CANDIDATE_PATH JSON {kind,value} for exact confirm.
 * Without it: date-window search with empty OR wildcards (full window grid).
 */
import { createHash } from 'node:crypto';
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
  const outDir =
    process.env.HMS_A9_DIR ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a9-payload';

  let exactValue: string | null = null;
  const candPath = process.env.HMS_PROOF_EXACT_CANDIDATE_PATH;
  if (candPath) {
    const raw = JSON.parse(await readFile(candPath, 'utf8')) as {
      kind?: string;
      value?: string;
    };
    if (raw.kind === 'confirmation' && typeof raw.value === 'string' && raw.value) {
      exactValue = raw.value;
    }
  }

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

  const result = await page.evaluate(async (exactConf) => {
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

    // Dataspy 1941 chrome — empty BEGINS slots = wildcards over date window.
    // Exact confirm: pin confirmation slot only.
    const confVal = exactConf || '';
    const unused = exactConf ? '___NOMATCH___' : '';
    const body: Record<string, string> = {
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
      MADDON_FILTER_VALUE_3: confVal,
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
      body: new URLSearchParams(body).toString(),
    });
    const searchText = await search.text();

    let row: Record<string, unknown> | null = null;
    let lstKeys: string[] = [];
    let rowCount = 0;
    try {
      const marker = 'pageData:';
      const idx = searchText.indexOf(marker);
      let pageData: Record<string, unknown> | null = null;
      if (idx >= 0) {
        let i = idx + marker.length;
        while (i < searchText.length && /\s/.test(searchText[i]!)) i++;
        if (searchText[i] === '{') {
          let depth = 0;
          let end = i;
          for (; end < searchText.length; end++) {
            const c = searchText[end]!;
            if (c === '{') depth++;
            else if (c === '}') {
              depth--;
              if (depth === 0) {
                end++;
                break;
              }
            }
          }
          pageData = JSON.parse(searchText.slice(i, end));
        }
      }
      if (!pageData) {
        const m = searchText.match(/"pageData"\s*:\s*(\{[\s\S]*?\})\s*[,}]/);
        if (m?.[1]) pageData = JSON.parse(m[1]);
      }
      const grid = pageData?.grid as Record<string, unknown> | undefined;
      const gridResult = grid?.GRIDRESULT as Record<string, unknown> | undefined;
      const inner = gridResult?.GRID as Record<string, unknown> | undefined;
      const data = inner?.DATA;
      if (Array.isArray(data)) {
        rowCount = data.length;
        row =
          (data.find(
            (r) =>
              r &&
              typeof r === 'object' &&
              (r as Record<string, unknown>).confirmationnumber,
          ) as Record<string, unknown> | undefined) ??
          (data[0] as Record<string, unknown> | null);
        if (row) lstKeys = Object.keys(row).slice(0, 80);
      }
    } catch {
      row = null;
    }

    if (!row) {
      return {
        ok: false,
        searchBytes: searchText.length,
        searchStatus: search.status,
        rowCount,
        lstKeys,
        probes: {} as Record<string, unknown>,
        searchHead: searchText
          .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
          .replace(/\d{6,}/g, '[n]')
          .slice(0, 300),
      };
    }

    const picked: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v == null || v === '') continue;
      if (
        /confirm|gueststay|reserv|accountid|^id$|propertycode|guestnumber|folio/i.test(
          k,
        )
      ) {
        picked[k] = String(v);
      }
    }
    // Canonical aliases used by detail HDR open
    if (row.confirmationnumber != null) {
      picked.confirmationnumber = String(row.confirmationnumber);
    }
    if (row.id != null) picked.reservationstayid = String(row.id);
    if (row.reservationstayid != null) {
      picked.reservationstayid = String(row.reservationstayid);
    }
    picked.propertycode = String(row.propertycode ?? 'HRCEN');

    const probes: Record<
      string,
      { status: number; bytes: number; keyHits: string[]; head: string }
    > = {};

    const paths = [
      'OSRESV.HDR',
      'OSRESS.HDR',
      'OSRESV.TRC',
      'OSRESS.TRC',
      'OSRESV.NTE',
      'OSRESS.NTE',
      'OSRESV.NOTE',
      'OSRESS.NOTE',
      'OSRESV.ALT',
      'OSRESS.ALT',
      'OSRESV.LOC',
      'OSRESS.LOC',
    ];

    for (const path of paths) {
      const name = path.split('.')[0]!;
      const tab = path.split('.')[1]!;
      const postBody: Record<string, string> = {
        SYSTEM_FUNCTION_NAME: name,
        USER_FUNCTION_NAME: name === 'OSRESS' ? 'OSRESV' : name,
        CURRENT_TAB_NAME: tab,
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
        propertycode: picked.propertycode || 'HRCEN',
      };
      for (const [k, v] of Object.entries(picked)) {
        postBody[k] = v;
      }
      try {
        const r = await fetch(`/web/base/${path}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(postBody).toString(),
        });
        const text = await r.text();
        const keyHits = [
          ...new Set(
            [
              ...text.matchAll(
                /"(trace[^"]*|note[^"]*|alert[^"]*|locator[^"]*|reservationnote[^"]*|tracestatus[^"]*|duedate[^"]*|delivery[^"]*|author[^"]*|method[^"]*|message[^"]*|definedtrace[^"]*)"/gi,
              ),
            ].map((m) => m[1]!),
          ),
        ].slice(0, 60);
        probes[path] = {
          status: r.status,
          bytes: text.length,
          keyHits,
          head: text
            .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
            .replace(/\d{6,}/g, '[n]')
            .slice(0, 220),
        };
      } catch {
        probes[path] = { status: 0, bytes: 0, keyHits: [], head: '' };
      }
    }

    return {
      ok: true,
      searchBytes: searchText.length,
      searchStatus: search.status,
      rowCount,
      lstKeys,
      pickedKeys: Object.keys(picked).sort(),
      probes,
    };
  }, exactValue);

  const realProbes = Object.entries(result.probes || {})
    .filter(
      ([, v]) =>
        (v as { status: number; bytes: number }).status === 200 &&
        (v as { bytes: number }).bytes > 2000,
    )
    .map(([path, v]) => ({
      path,
      bytes: (v as { bytes: number }).bytes,
      keyHits: (v as { keyHits: string[] }).keyHits,
      head: (v as { head: string }).head,
    }));

  const tracesFound = realProbes.some(
    (p) =>
      /TRC|TRACE|ALT|LOC/i.test(p.path) &&
      p.keyHits.some((k) => /trace|alert|locator/i.test(k)),
  );
  const notesFound = realProbes.some(
    (p) =>
      /NTE|NOTE/i.test(p.path) &&
      p.keyHits.some((k) => /note/i.test(k)),
  );

  const compare = {
    schemaVersion: 'compare.v1',
    toolId: 'hms_read_notes_traces',
    capturedAt: new Date().toISOString(),
    exactCandidateUsed: Boolean(exactValue),
    searchBytes: result.searchBytes,
    searchStatus: result.searchStatus,
    rowCount: result.rowCount,
    lstKeys: result.lstKeys,
    pickedKeys: result.pickedKeys ?? [],
    realProbes,
    tracesFound,
    notesFound,
    allRequiredPass: tracesFound && notesFound,
    verdict: tracesFound
      ? notesFound
        ? 'PASS_NOTES_AND_TRACES'
        : 'PARTIAL_TRACES_ONLY'
      : notesFound
        ? 'PARTIAL_NOTES_ONLY'
        : result.ok
          ? 'SURFACE_UNPROVEN_TRACES'
          : 'BLOCKED_SEARCH_EMPTY',
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(
    `${outDir}/traces-softopen.compare.v1.json`,
    `${JSON.stringify(compare, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      ok: true,
      outDir,
      searchBytes: result.searchBytes,
      rowCount: result.rowCount,
      lstKeys: result.lstKeys,
      pickedKeys: result.pickedKeys,
      probeSummary: Object.fromEntries(
        Object.entries(result.probes || {}).map(([k, v]) => [
          k,
          `${(v as { status: number }).status}/${(v as { bytes: number }).bytes}/keys=${(v as { keyHits: string[] }).keyHits.length}`,
        ]),
      ),
      realProbes: realProbes.map((p) => ({
        path: p.path,
        bytes: p.bytes,
        keyHits: p.keyHits.slice(0, 20),
      })),
      tracesFound,
      notesFound,
      verdict: compare.verdict,
      searchSha256: createHash('sha256')
        .update(String(result.searchBytes))
        .digest('hex')
        .slice(0, 16),
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
