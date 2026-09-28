/**
 * A6 payload: BSSTRT → GSGRPB open → GSGRPB.LST → parse rows (parser inlined).
 * HMS_DISCOVERY_ALLOW_LIVE=1. Sanitized refs/status/dates only.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

type GroupStatus = 'inquiry' | 'tentative' | 'definite' | 'cancelled' | 'closed';
type GroupBlockListRow = {
  groupRef: string;
  status: GroupStatus | null;
  startDate: string | null;
  endDate: string | null;
};

function parseHmsDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const dmy = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(value);
  if (dmy) {
    const months: Record<string, string> = {
      JAN: '01',
      FEB: '02',
      MAR: '03',
      APR: '04',
      MAY: '05',
      JUN: '06',
      JUL: '07',
      AUG: '08',
      SEP: '09',
      OCT: '10',
      NOV: '11',
      DEC: '12',
    };
    const month = months[dmy[2]!.toUpperCase()];
    if (month) return `${dmy[3]}-${month}-${dmy[1]}`;
  }
  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (mdy) {
    return `${mdy[3]}-${mdy[1]!.padStart(2, '0')}-${mdy[2]!.padStart(2, '0')}`;
  }
  return null;
}

function parseGroupStatus(raw: unknown): GroupStatus | null {
  if (typeof raw !== 'string') return null;
  switch (
    raw
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '')
  ) {
    case 'prospect':
    case 'inquiry':
      return 'inquiry';
    case 'tentative':
      return 'tentative';
    case 'definite':
      return 'definite';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'closed':
      return 'closed';
    default:
      return null;
  }
}

function balancedObject(text: string, from: number): Record<string, unknown> | null {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let quote = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function sourceRoot(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* mixed */
  }
  for (const marker of ['pageData:', '"pageData":', "'pageData':"]) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) continue;
    const root = balancedObject(text, markerIndex + marker.length);
    if (root) return root;
  }
  return null;
}

function rowValue(row: Record<string, unknown>, keys: readonly string[]): unknown {
  const lower = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of keys) {
    const value = lower.get(key);
    if (value !== undefined && value !== null) {
      if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
        return (value as { value?: unknown }).value;
      }
      return value;
    }
  }
  return null;
}

function objectValue(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = Object.entries(value).find(([candidate]) => candidate.toLowerCase() === key);
  return entry && entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1])
    ? (entry[1] as Record<string, unknown>)
    : null;
}

function reviewedDataRows(root: Record<string, unknown>): Record<string, unknown>[] | null {
  const pageData = objectValue(root, 'pagedata') ?? root;
  const grid = objectValue(pageData, 'grid');
  const gridResult = grid ? objectValue(grid, 'gridresult') : null;
  const resultGrid = gridResult ? objectValue(gridResult, 'grid') : null;
  if (!resultGrid) return null;
  const dataEntry = Object.entries(resultGrid).find(([key]) => key.toLowerCase() === 'data');
  if (!dataEntry || !Array.isArray(dataEntry[1])) return null;
  return dataEntry[1].filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === 'object' && !Array.isArray(item)),
  );
}

function parseGroupBlockListTransport(text: string): {
  envelopeRecognized: boolean;
  rows: GroupBlockListRow[];
} {
  const root = sourceRoot(text);
  const envelopeRows = root ? reviewedDataRows(root) : null;
  const rows = envelopeRows
    ? envelopeRows.flatMap((row) => {
        const rawRef = rowValue(row, ['groupbookingreferencenumber']);
        if (typeof rawRef !== 'string' || rawRef.trim() === '') return [];
        return [
          {
            groupRef: rawRef.trim().toUpperCase(),
            status: parseGroupStatus(rowValue(row, ['status'])),
            startDate: parseHmsDate(rowValue(row, ['startdate'])),
            endDate: parseHmsDate(rowValue(row, ['enddate'])),
          },
        ];
      })
    : [];
  return { envelopeRecognized: envelopeRows !== null, rows };
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') throw new Error('refused');
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outDir = process.env.HMS_A6_PAYLOAD_OUT || '/tmp/wave-a-a6-payload';
  await mkdir(outDir, { recursive: true, mode: 0o700 });

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
    if (/(save|delete|submit|checkin|checkout|amend|cancel|newrecord)/i.test(new URL(u).pathname)) {
      return route.abort();
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  try {
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

    const lstText = await page.evaluate(async () => {
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
      await fetch('/web/base/GSGRPB?FUNCTION_CLASS=WEBL', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'GSGRPB',
          USER_FUNCTION_NAME: 'GSGRPB',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        }).toString(),
      });
      const lst = await fetch('/web/base/GSGRPB.LST', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'GSGRPB',
          USER_FUNCTION_NAME: 'GSGRPB',
          CURRENT_TAB_NAME: 'LST',
          COMPONENT_INFO_TYPE: 'DATA_ONLY',
          GRID_NAME: 'GSGRPB',
        }).toString(),
      });
      return await lst.text();
    });

    const parsed = parseGroupBlockListTransport(lstText);
    const sha = createHash('sha256').update(lstText).digest('hex');
    const dataKeys =
      parsed.envelopeRecognized && parsed.rows.length === 0
        ? (() => {
            const root = sourceRoot(lstText);
            const rows = root ? reviewedDataRows(root) : null;
            return rows?.[0] ? Object.keys(rows[0]).sort() : [];
          })()
        : [];

    const compare = {
      schemaVersion: 1,
      toolId: 'hms_read_group_block',
      finishedAt: new Date().toISOString(),
      verdict:
        parsed.envelopeRecognized && parsed.rows.length > 0
          ? 'PASS_GROUP_LIST_PAYLOAD'
          : parsed.envelopeRecognized
            ? 'PARTIAL_GROUP_ENVELOPE_EMPTY_OR_KEY_MISS'
            : 'BLOCKED_GROUP_ENVELOPE',
      allRequiredPass: parsed.envelopeRecognized && parsed.rows.length > 0,
      liveEvidence: {
        lstBytes: lstText.length,
        lstSha256: sha,
        envelopeRecognized: parsed.envelopeRecognized,
        rowCount: parsed.rows.length,
        dataKeysWhenEmpty: dataKeys,
        sampleRows: parsed.rows.slice(0, 5),
      },
      rca: {
        unlock: 'BSSTRT → GSGRPB open → GSGRPB.LST DATA_ONLY',
      },
    };

    await writeFile(join(outDir, 'compare.v1.json'), `${JSON.stringify(compare, null, 2)}\n`, {
      mode: 0o600,
    });
    process.stdout.write(JSON.stringify({ ok: true, outDir, ...compare.liveEvidence, verdict: compare.verdict, allRequiredPass: compare.allRequiredPass }) + '\n');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : 'fail';
  process.stderr.write(
    (/password|secret|arn:aws/i.test(msg) ? 'redacted' : msg.slice(0, 200)) + '\n',
  );
  process.exit(1);
});
