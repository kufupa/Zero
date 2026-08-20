/**
 * Prove Centurion n° mail tokens hit live OSRESS (hashes/counts only).
 */
import { createHash } from 'node:crypto';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { asc, eq } from 'drizzle-orm';
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
} from '../dist/hms/live-read-manifest.js';
import { hmsSecretSchema } from '../dist/hms/runtime.js';

function sha12(v) {
  return createHash('sha256').update(String(v)).digest('hex').slice(0, 12);
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

const { db, conn } = createDb(process.env.DATABASE_URL);
const cands = [];
try {
  const rows = await db
    .select({
      textBody: message.textBody,
      htmlBody: message.htmlBody,
      subject: message.subject,
      direction: message.direction,
    })
    .from(message)
    .where(eq(message.transportId, CENTURION))
    .orderBy(asc(message.receivedAt), asc(message.id))
    .limit(5000);
  const seen = new Set();
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
    const c = exact[0];
    if (!/^\d{6,14}-\d{1,4}$/.test(c.value)) continue;
    const key = `${c.kind}:${c.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cands.push({ ...c, direction: row.direction });
    if (cands.length >= 8) break;
  }
} finally {
  await conn.end().catch(() => undefined);
}

const out = {
  ok: false,
  nDegCandCount: cands.length,
  attempts: [],
  firstMatch: null,
};

if (cands.length === 0) {
  console.log(JSON.stringify({ ...out, reason: 'NO_NDEG_CANDIDATE' }));
  process.exit(0);
}

const client = new SecretsManagerClient({
  region: process.env.AWS_REGION || 'af-south-1',
});
const secret = hmsSecretSchema.parse(
  JSON.parse(
    (
      await client.send(
        new GetSecretValueCommand({ SecretId: process.env.HMS_READ_SECRET_ARN }),
      )
    ).SecretString,
  ),
);
const origin = new URL(secret.loginUrl).origin;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
});
const page = await (
  await browser.newContext({ ignoreHTTPSErrors: true })
).newPage();

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
  await page.waitForTimeout(2000);
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

  for (const cand of cands) {
    const text = await post(buildExactOsressSearchBody(cand));
    const rows = parseLiveOsressGridRows(extractOsressPageData(text) || {});
    const corr = parseAndCorrelateGuestStayHtml(text, cand);
    const attempt = {
      dir: cand.direction,
      len: cand.value.length,
      sha12: sha12(cand.value.toUpperCase()),
      records: /"RECORDS"\s*:\s*"?(\d+)"?/.exec(text)?.[1] ?? null,
      parsed: rows?.length ?? null,
      outcome: corr.outcome,
      htmlLen: text.length,
    };
    out.attempts.push(attempt);
    if (corr.outcome === 'matched' && !out.firstMatch) {
      out.firstMatch = attempt;
      break;
    }
  }
  out.ok = true;
  out.outcomes = out.attempts.reduce((a, x) => {
    a[x.outcome] = (a[x.outcome] || 0) + 1;
    return a;
  }, {});
} catch (err) {
  out.errorMsg = String(err?.message || err).slice(0, 240);
} finally {
  await browser.close().catch(() => undefined);
}

console.log(JSON.stringify(out));
