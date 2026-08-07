/**
 * Capture OSLEDG.DLD POST body keys (values scrubbed) after UI row activate.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';

const hmsSecretSchema = z
  .object({
    loginUrl: z.string().url(),
    username: z.string().min(1),
    password: z.string().min(1),
    credentialMode: z.enum(['view_only', 'write_capable']),
  })
  .passthrough();

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_DEPOSIT_REPROVE_OUT ??
    '/tmp/hms-deposit-dld-capture.json';

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  if (secret.credentialMode !== 'view_only') throw new Error('not view_only');
  const origin = new URL(secret.loginUrl).origin;

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.HMS_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const ctx = await browser.newContext({
    acceptDownloads: false,
    serviceWorkers: 'block',
    ignoreHTTPSErrors: true,
  });
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    if (!req.url().startsWith(origin)) {
      await route.abort();
      return;
    }
    const path = new URL(req.url()).pathname;
    if (
      req.method() === 'POST' &&
      /(save|delete|settle|refund|void|print\/|export|generate|resend|finalize|email)/i.test(
        path,
      )
    ) {
      await route.abort();
      return;
    }
    await route.continue();
  });

  const dldReqs = [];
  const page = await ctx.newPage();
  page.on('request', (req) => {
    try {
      const url = req.url();
      if (!url.startsWith(origin)) return;
      const path = new URL(url).pathname;
      if (!/OSLEDG\.DLD/i.test(path)) return;
      const post = req.postData() || '';
      const params = new URLSearchParams(post);
      const keys = [...params.keys()].sort();
      // scrub: keep key presence + value LENGTH only
      const scrubbed = {};
      for (const k of keys) {
        const v = params.get(k) || '';
        scrubbed[k] = { len: v.length, empty: v.length === 0 };
      }
      dldReqs.push({
        method: req.method(),
        path,
        bodyKeys: keys,
        scrubbed,
      });
    } catch {
      /* ignore */
    }
  });

  try {
    await page.goto(secret.loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page
      .locator('input[name=userid], input[name=username]')
      .first()
      .fill(secret.username);
    await page.locator('input[name=password]').fill(secret.password);
    await Promise.all([
      page.waitForURL(/COMMON/i, { timeout: 60_000 }).catch(() => null),
      page.getByRole('button', { name: 'Sign in' }).click().catch(async () => {
        await page.locator('input[name=password]').press('Enter');
      }),
    ]);
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const html = await page.content();
      const title = await page.title();
      if (/"tenantid"\s*:/i.test(html) && /Infor HMS/i.test(title)) break;
      await page.waitForTimeout(400);
    }

    for (const label of ['Front Desk', 'Property Ledger', 'Deposit Ledger']) {
      await page.evaluate((wanted) => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        let n;
        while ((n = walker.nextNode())) {
          if ((n.textContent || '').replace(/\s+/g, ' ').trim() === wanted) {
            n.parentElement?.click();
            return;
          }
        }
      }, label);
      await page.waitForTimeout(2_500);
    }
    await page.waitForTimeout(2_000);

    await page.evaluate(() => {
      const row =
        document.querySelector('.x-grid3-row') ||
        document.querySelector('.x-grid-row');
      if (!row) return;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    await page.waitForTimeout(5_000);

    // Try programmatic DLD with common tab body (no select)
    const bare = await page.evaluate(async () => {
      const r = await fetch('/web/base/OSLEDG.DLD', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          SYSTEM_FUNCTION_NAME: 'OSLEDG',
          USER_FUNCTION_NAME: 'OSLEDG',
          CURRENT_TAB_NAME: 'DLD',
        }).toString(),
        credentials: 'same-origin',
      });
      const text = await r.text();
      const hasConf = /"confirmationnumber"\s*:/i.test(text);
      const hasCard = /"paymentcardnumber"\s*:/i.test(text);
      const hasGrid = /GRIDRESULT/i.test(text);
      return {
        status: r.status,
        bytes: text.length,
        hasConf,
        hasCard,
        hasGrid,
      };
    });

    const report = {
      ok: true,
      dldRequestCount: dldReqs.length,
      dldReqs,
      bareDld: bare,
    };
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
