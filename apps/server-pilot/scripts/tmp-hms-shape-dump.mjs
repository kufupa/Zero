/**
 * Live OSRESS response shape dump — counts/types/keys only, no PII values.
 * Direct Playwright + Secrets Manager (same path as prior live probes).
 */
import { createHash } from 'node:crypto';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { and, asc, eq } from 'drizzle-orm';
import { chromium } from 'playwright';
import {
  extractLookupCandidates,
  filterExactReservationCandidates,
  normalizeMessageText,
} from '../dist/ai/thread-context.js';
import { createDb } from '../dist/db/client.js';
import { message } from '../dist/db/schema/mail.js';
import { TRANSPORT_ID as CENTURION } from '../dist/db/seed.js';
import {
  extractOsressPageData,
  parseAndCorrelateGuestStayHtml,
  parseLiveOsressGridRows,
} from '../dist/hms/live-guest-stay-driver.js';
import {
  LIVE_GUEST_STAY_SEARCH_PATH,
  buildExactOsressSearchBody,
  liveNotFoundCanaryCandidate,
} from '../dist/hms/live-read-manifest.js';
import { hmsSecretSchema } from '../dist/hms/runtime.js';

function sha12(v) {
  return createHash('sha256').update(String(v)).digest('hex').slice(0, 12);
}
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
function keysOf(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? Object.keys(v).slice(0, 40)
    : [];
}

function summarizeText(text, cand) {
  const pd = extractOsressPageData(text);
  let extractFail = null;
  if (!pd && text.includes('pageData:')) {
    const idx = text.indexOf('pageData:');
    const i = text.indexOf('{', idx);
    extractFail = {
      pageDataIdx: idx,
      braceIdx: i,
      headCodes: Array.from(text.slice(Math.max(0, idx - 4), idx + 24), (c) =>
        c.charCodeAt(0),
      ),
    };
  }
  const rows = pd ? parseLiveOsressGridRows(pd) : null;
  const corr = cand ? parseAndCorrelateGuestStayHtml(text, cand) : null;
  const grid = pd && typeof pd.grid === 'object' ? pd.grid : null;
  const gr =
    grid && typeof grid.GRIDRESULT === 'object' ? grid.GRIDRESULT : null;
  const g = gr && typeof gr.GRID === 'object' ? gr.GRID : null;
  const data = g ? g.DATA : undefined;
  const meta = g && typeof g.METADATA === 'object' ? g.METADATA : null;
  let firstRowKeys = null;
  if (Array.isArray(data) && data[0] && typeof data[0] === 'object') {
    firstRowKeys = Object.keys(data[0]).slice(0, 30);
  } else if (data && typeof data === 'object' && !Array.isArray(data)) {
    const first = Object.values(data)[0];
    if (first && typeof first === 'object') {
      firstRowKeys = Object.keys(first).slice(0, 30);
    }
  }
  return {
    htmlLen: text.length,
    hasPageData: Boolean(pd),
    extractFail,
    pageDataKeys: keysOf(pd),
    hasGrid: Boolean(grid),
    gridKeys: keysOf(grid),
    gridResultType: gr && typeof gr.type === 'string' ? gr.type : null,
    gridKeysInner: keysOf(g),
    dataType: typeOf(data),
    dataLen: Array.isArray(data)
      ? data.length
      : data && typeof data === 'object'
        ? Object.keys(data).length
        : -1,
    recordsMeta: meta && meta.RECORDS != null ? String(meta.RECORDS) : null,
    recordsRe: /"RECORDS"\s*:\s*"?(\d+)"?/.exec(text)?.[1] ?? null,
    firstRowKeys,
    parsedRows: rows === null ? null : rows.length,
    parseNull: rows === null,
    correlate: corr?.outcome ?? null,
    hasGridresultStr: text.includes('GRIDRESULT'),
  };
}

async function clickText(page, wanted) {
  await page.evaluate((w) => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    let node = walker.nextNode();
    while (node) {
      if ((node.textContent || '').trim() === w && node.parentElement) {
        node.parentElement.click();
        return;
      }
      node = walker.nextNode();
    }
    throw new Error('missing ' + w);
  }, wanted);
}

const out = { ok: false };
const client = new SecretsManagerClient({
  region: process.env.AWS_REGION || 'af-south-1',
});
const res = await client.send(
  new GetSecretValueCommand({ SecretId: process.env.HMS_READ_SECRET_ARN }),
);
const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
const origin = new URL(secret.loginUrl).origin;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
});
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();

try {
  await page.goto(secret.loginUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  try {
    await page.locator('input[name=userid]').fill(secret.username, {
      timeout: 10_000,
    });
  } catch {
    await page.getByLabel('Username').fill(secret.username, { timeout: 10_000 });
  }
  try {
    await page.locator('input[name=password]').fill(secret.password);
  } catch {
    await page.getByLabel('Password').fill(secret.password);
  }
  const hotel = page.locator('#hotelid, input[name=hotelid]');
  if (await hotel.count()) await hotel.first().fill(secret.expectedPropertyCode);
  await Promise.all([
    page.waitForURL(/\/web\/base\/COMMON/i, { timeout: 60_000 }).catch(() => {}),
    page
      .getByRole('button', { name: 'Sign in' })
      .click()
      .catch(() => page.locator('input[name=password]').press('Enter')),
  ]);
  await page.waitForFunction(
    (e) => document.body?.innerText?.includes(e) === true,
    secret.expectedPropertyName,
    { timeout: 60_000 },
  );
  await page.waitForFunction(
    () =>
      document.body.innerText.split('\n').some((l) => l.trim() === 'Front Desk'),
    { timeout: 20_000 },
  );
  await clickText(page, 'Front Desk');
  await page.waitForTimeout(2500);
  await page.waitForFunction(
    () =>
      document.body.innerText.split('\n').some((l) => l.trim() === 'Guest Stay'),
    { timeout: 15_000 },
  );
  await clickText(page, 'Guest Stay');
  for (let i = 0; i < 50; i++) {
    if (/name="search"/i.test(await page.content())) break;
    await page.waitForTimeout(300);
  }

  async function post(body) {
    return page.evaluate(
      async ({ url, body }) => {
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type':
              'application/x-www-form-urlencoded; charset=UTF-8',
            'x-requested-with': 'XMLHttpRequest',
          },
          body: new URLSearchParams(body).toString(),
          credentials: 'include',
        });
        return await r.text();
      },
      { url: `${origin}${LIVE_GUEST_STAY_SEARCH_PATH}`, body },
    );
  }

  const seedCand = liveNotFoundCanaryCandidate();
  out.canary = summarizeText(
    await post(buildExactOsressSearchBody(seedCand)),
    seedCand,
  );

  const seedBody = buildExactOsressSearchBody(seedCand);
  for (const k of Object.keys(seedBody)) {
    if (
      /MADDON_FILTER_VALUE_[3-9]$|MADDON_FILTER_VALUE_10$|^externalconfirmation$/.test(
        k,
      )
    ) {
      seedBody[k] = '';
    }
  }
  seedBody.MADDON_FILTER_VALUE_1 = '-365';
  seedBody.MADDON_FILTER_VALUE_2 = '+365';
  const seedText = await post(seedBody);
  out.seed = summarizeText(seedText, null);

  const seedRows =
    parseLiveOsressGridRows(extractOsressPageData(seedText) || {}) || [];
  if (seedRows[0]?.confirmationNumber) {
    const liveCand = {
      id: 'seed',
      kind: 'confirmation',
      value: seedRows[0].confirmationNumber,
    };
    const exactText = await post(buildExactOsressSearchBody(liveCand));
    out.roundtrip = {
      seedSha12: sha12(liveCand.value.toUpperCase()),
      seedLen: liveCand.value.length,
      ...summarizeText(exactText, liveCand),
    };
  } else {
    out.roundtrip = {
      skipped: true,
      reason: 'NO_SEED_ROW',
      seedParsedRows: seedRows.length,
    };
  }

  const { db, conn } = createDb(process.env.DATABASE_URL);
  const mailAttempts = [];
  try {
    const rows = await db
      .select({
        textBody: message.textBody,
        htmlBody: message.htmlBody,
        subject: message.subject,
      })
      .from(message)
      .where(
        and(
          eq(message.transportId, CENTURION),
          eq(message.direction, 'inbound'),
        ),
      )
      .orderBy(asc(message.receivedAt), asc(message.id))
      .limit(250);
    const seen = new Set();
    const cands = [];
    for (const row of rows) {
      const text = [
        row.subject ?? '',
        normalizeMessageText({
          textBody: row.textBody,
          htmlBody: row.htmlBody,
        }),
      ].join('\n');
      const exact = filterExactReservationCandidates(
        extractLookupCandidates(text),
      );
      if (exact.length !== 1) continue;
      if (exact[0].value.length < 6) continue;
      const key = `${exact[0].kind}:${exact[0].value.toUpperCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cands.push(exact[0]);
      if (cands.length >= 5) break;
    }
    for (const cand of cands) {
      const text = await post(buildExactOsressSearchBody(cand));
      mailAttempts.push({
        kind: cand.kind,
        len: cand.value.length,
        sha12: sha12(cand.value.toUpperCase()),
        ...summarizeText(text, cand),
      });
    }
  } finally {
    await conn.end().catch(() => undefined);
  }
  out.mailAttempts = mailAttempts;
  out.ok = true;
} catch (err) {
  out.errorName = err?.name || 'Error';
  out.errorCode = err?.code || null;
  out.errorMsg = String(err?.message || err).slice(0, 240);
} finally {
  await browser.close().catch(() => undefined);
}

console.log(JSON.stringify(out));
