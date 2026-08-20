/**
 * Charset/overlap: mail exact tokens vs live confs in ±365 grid.
 * Hashes/counts only.
 */
import { createHash } from 'node:crypto';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { and, asc, desc, eq } from 'drizzle-orm';
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
function charset(v) {
  if (/^[0-9]+$/.test(v)) return 'digits';
  if (/^[A-Z]+$/.test(v)) return 'alpha';
  if (/^[A-Z0-9]+$/.test(v)) return 'alnum';
  if (/^[A-Z0-9-]+$/.test(v)) return 'alnum_dash';
  return 'other';
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
const mailMeta = [];
let outboundCorpus = '';
let inboundCorpus = '';
try {
  const inbound = await db
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
  for (const row of inbound) {
    const text = [
      row.subject ?? '',
      normalizeMessageText({
        textBody: row.textBody,
        htmlBody: row.htmlBody,
      }),
    ].join('\n');
    inboundCorpus += `\n${text.toUpperCase()}`;
    const exact = filterExactReservationCandidates(
      extractLookupCandidates(text),
    );
    if (exact.length !== 1 || exact[0].value.length < 6) continue;
    const v = exact[0].value.toUpperCase();
    const k = `${exact[0].kind}:${v}`;
    if (seen.has(k)) continue;
    seen.add(k);
    mailMeta.push({
      kind: exact[0].kind,
      len: v.length,
      cs: charset(v),
      sha12: sha12(v),
    });
  }
  const outbound = await db
    .select({
      textBody: message.textBody,
      htmlBody: message.htmlBody,
      subject: message.subject,
    })
    .from(message)
    .where(
      and(
        eq(message.transportId, CENTURION),
        eq(message.direction, 'outbound'),
      ),
    )
    .orderBy(desc(message.receivedAt))
    .limit(400);
  for (const row of outbound) {
    outboundCorpus += `\n${row.subject ?? ''}\n${normalizeMessageText({
      textBody: row.textBody,
      htmlBody: row.htmlBody,
    }).toUpperCase()}`;
  }
} finally {
  await conn.end().catch(() => undefined);
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
const out = { ok: false };
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

  const seedBody = buildExactOsressSearchBody(liveNotFoundCanaryCandidate());
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
  const liveRows =
    parseLiveOsressGridRows(extractOsressPageData(seedText) || {}) || [];
  const liveConf = liveRows
    .map((r) => (r.confirmationNumber || '').toUpperCase())
    .filter(Boolean);
  let inIn = 0;
  let inOut = 0;
  for (const c of liveConf) {
    if (inboundCorpus.includes(c)) inIn++;
    if (outboundCorpus.includes(c)) inOut++;
  }

  const seed = liveConf[0];
  let rt = null;
  if (seed) {
    const text = await post(
      buildExactOsressSearchBody({ id: 's', kind: 'confirmation', value: seed }),
    );
    const rows = parseLiveOsressGridRows(extractOsressPageData(text) || {}) || [];
    const corr = parseAndCorrelateGuestStayHtml(text, {
      id: 's',
      kind: 'confirmation',
      value: seed,
    });
    rt = {
      seedLen: seed.length,
      seedCs: charset(seed),
      seedSha12: sha12(seed),
      records: /"RECORDS"\s*:\s*"?(\d+)"?/.exec(text)?.[1] ?? null,
      parsed: rows.length,
      outcome: corr.outcome,
      uniqueConf: new Set(rows.map((r) => r.confirmationNumber)).size,
    };
  }

  out.ok = true;
  out.mailMeta = mailMeta;
  out.mailCs = mailMeta.reduce((a, m) => {
    a[m.cs] = (a[m.cs] || 0) + 1;
    return a;
  }, {});
  out.liveConfCount = liveConf.length;
  out.liveCs = liveConf.reduce((a, c) => {
    const k = charset(c);
    a[k] = (a[k] || 0) + 1;
    return a;
  }, {});
  out.liveInInbound = inIn;
  out.liveInOutbound = inOut;
  out.roundtrip = rt;
} catch (err) {
  out.errorMsg = String(err?.message || err).slice(0, 240);
} finally {
  await browser.close().catch(() => undefined);
}
console.log(JSON.stringify(out));
