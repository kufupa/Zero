/**
 * A9 deepen: exact candidate → OSRESV.HDR + OSRESV.TRC dumps;
 * probe Notes tab aliases; emit compare.v1 with claimKeys (no PII values).
 * HMS_DISCOVERY_ALLOW_LIVE=1. Requires HMS_PROOF_EXACT_CANDIDATE_PATH.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

function redact(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/\d{6,}/g, '[n]');
}

function extractQuotedKeys(text: string, re: RegExp): string[] {
  return [...new Set([...text.matchAll(re)].map((m) => m[1]!))].sort();
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const candPath = process.env.HMS_PROOF_EXACT_CANDIDATE_PATH;
  if (!candPath) throw new Error('HMS_PROOF_EXACT_CANDIDATE_PATH required');
  const outDir =
    process.env.HMS_A9_DIR ??
    '/home/ubuntu/repos/zero/.private/wave-a-20260912/a9-payload';

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
      /* fall through */
    }

    if (!conf) {
      return {
        ok: false,
        searchBytes: searchText.length,
        reason: 'no_row',
      };
    }

    const base: Record<string, string> = {
      confirmationnumber: conf,
      propertycode: 'HRCEN',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
      SYSTEM_FUNCTION_NAME: 'OSRESV',
      USER_FUNCTION_NAME: 'OSRESV',
    };
    if (stayId) {
      base.reservationstayid = stayId;
      base.id = stayId;
    }

    // Inline fetches only — no named fns inside evaluate (tsx __name).
    const targets = [
      { path: 'OSRESV.HDR', tab: 'HDR', extra: {} as Record<string, string> },
      { path: 'OSRESV.TRC', tab: 'TRC', extra: {} as Record<string, string> },
      {
        path: 'OSRESV.TRC',
        tab: 'TRC',
        extra: {
          COMPONENT_INFO_TYPE: 'DATA_ONLY',
          GRID_NAME: 'OSRESV',
        } as Record<string, string>,
        tag: 'trcLst',
      },
      ...[
        'NTE',
        'NOTE',
        'NOT',
        'NOTES',
        'GNT',
        'GSTN',
        'RSVN',
        'NTS',
        'GNOTE',
        'RENOTES',
        'RESNOTE',
      ].map((tab) => ({
        path: 'OSRESV.' + tab,
        tab,
        extra: {} as Record<string, string>,
        tag: 'note',
      })),
    ];

    const opened: Record<
      string,
      { status: number; bytes: number; text: string }
    > = {};
    for (const t of targets) {
      const r = await fetch(`/web/base/${t.path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...base,
          CURRENT_TAB_NAME: t.tab,
          ...t.extra,
        }).toString(),
      });
      const text = await r.text();
      const key =
        (t as { tag?: string }).tag === 'trcLst'
          ? 'trcLst'
          : (t as { tag?: string }).tag === 'note'
            ? t.path
            : t.path;
      opened[key] = { status: r.status, bytes: text.length, text };
    }

    const hdr = opened['OSRESV.HDR']!;
    const trc = opened['OSRESV.TRC']!;
    const trcLst = opened['trcLst']!;
    const noteProbes: Record<string, { status: number; bytes: number }> = {};
    for (const [k, v] of Object.entries(opened)) {
      if (k === 'OSRESV.HDR' || k === 'OSRESV.TRC' || k === 'trcLst') continue;
      noteProbes[k] = { status: v.status, bytes: v.bytes };
    }

    return {
      ok: true,
      searchBytes: searchText.length,
      hasStayId: Boolean(stayId),
      hdr: { status: hdr.status, bytes: hdr.bytes, text: hdr.text },
      trc: { status: trc.status, bytes: trc.bytes, text: trc.text },
      trcLst: {
        status: trcLst.status,
        bytes: trcLst.bytes,
        text: trcLst.text.slice(0, 8000),
      },
      noteProbes,
    };
  }, exactConf);

  if (!result.ok || !result.hdr || !result.trc) {
    await mkdir(outDir, { recursive: true });
    await writeFile(
      `${outDir}/traces-deepen.compare.v1.json`,
      JSON.stringify({ ok: false, result }, null, 2) + '\n',
      { mode: 0o600 },
    );
    process.stdout.write(JSON.stringify({ ok: false, result }) + '\n');
    await browser.close();
    return;
  }

  const hdrText = result.hdr.text;
  const trcText = result.trc.text;

  const noteKeys = extractQuotedKeys(
    hdrText,
    /"(reservationnote|cancellationnote|guestnote|privatenote|note[^"]{0,40})"/gi,
  );
  const traceKeys = extractQuotedKeys(
    trcText,
    /"(trace[^"]*|alert[^"]*|locator[^"]*|definedtrace[^"]*|delivery[^"]*|duedate[^"]*|tracestatus[^"]*|tracetype[^"]*|tracedetails[^"]*)"/gi,
  );

  // Presence flags only — never export note/trace body values
  const reservationnotePresent = /"reservationnote"\s*:/i.test(hdrText);
  const reservationnoteFilled = /"reservationnote"\s*:\s*"(?!")[^"]+/i.test(
    hdrText,
  );
  const tracesSurfaceOpen =
    result.trc.status === 200 &&
    result.trc.bytes > 2000 &&
    traceKeys.length > 0;

  const noteTabHits = Object.entries(result.noteProbes || {})
    .filter(
      ([k, v]) =>
        !k.endsWith('.text') &&
        !k.endsWith('.head') &&
        (v as { status: number; bytes: number }).status === 200 &&
        (v as { bytes: number }).bytes > 2000,
    )
    .map(([k, v]) => ({
      path: k,
      bytes: (v as { bytes: number }).bytes,
    }));

  const compare = {
    schemaVersion: 'compare.v1',
    toolId: 'hms_read_notes_traces',
    capturedAt: new Date().toISOString(),
    unlock: 'BSSTRT → OSRESS open → OSRESS.search → OSRESV.HDR + OSRESV.TRC',
    sections: {
      notes: {
        status: reservationnotePresent ? 'available' : 'unavailable',
        claimKeys: noteKeys.slice(0, 40),
        reservationnotePresent,
        reservationnoteFilled,
        source: 'OSRESV.HDR',
        hdrBytes: result.hdr.bytes,
        noteTabHits,
      },
      traces: {
        status: tracesSurfaceOpen ? 'available' : 'SURFACE_UNPROVEN',
        claimKeys: traceKeys.slice(0, 60),
        source: 'OSRESV.TRC',
        trcBytes: result.trc.bytes,
        trcStatus: result.trc.status,
        trcLstBytes: result.trcLst?.bytes ?? 0,
      },
    },
    allRequiredPass: reservationnotePresent && tracesSurfaceOpen,
    verdict:
      reservationnotePresent && tracesSurfaceOpen
        ? 'PASS_NOTES_AND_TRACES_PAYLOAD'
        : tracesSurfaceOpen
          ? 'PARTIAL_TRACES_NOTES_KEY_MISS'
          : 'SURFACE_UNPROVEN',
    noteProbeSummary: Object.fromEntries(
      Object.entries(result.noteProbes || {})
        .filter(([k]) => !k.endsWith('.text'))
        .map(([k, v]) => [
          k,
          `${(v as { status: number }).status}/${(v as { bytes: number }).bytes}`,
        ]),
    ),
    digests: {
      hdrSha256: createHash('sha256').update(hdrText).digest('hex'),
      trcSha256: createHash('sha256').update(trcText).digest('hex'),
    },
    heads: {
      hdr: redact(hdrText).slice(0, 200),
      trc: redact(trcText).slice(0, 200),
    },
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(
    `${outDir}/compare.v1.json`,
    `${JSON.stringify(compare, null, 2)}\n`,
    { mode: 0o600 },
  );
  // Full sanitized key inventories (no values)
  await writeFile(
    `${outDir}/osresv-trc.keys.v1.json`,
    `${JSON.stringify({ keys: traceKeys, bytes: result.trc.bytes }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    `${outDir}/osresv-hdr-note.keys.v1.json`,
    `${JSON.stringify(
      {
        keys: noteKeys,
        reservationnotePresent,
        reservationnoteFilled,
        bytes: result.hdr.bytes,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  process.stdout.write(
    JSON.stringify({
      ok: true,
      outDir,
      verdict: compare.verdict,
      allRequiredPass: compare.allRequiredPass,
      notes: compare.sections.notes,
      traces: {
        status: compare.sections.traces.status,
        claimKeyCount: compare.sections.traces.claimKeys.length,
        claimKeysSample: compare.sections.traces.claimKeys.slice(0, 25),
        trcBytes: compare.sections.traces.trcBytes,
      },
      noteProbeSummary: compare.noteProbeSummary,
      noteTabHits,
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
