/**
 * Extract Front Desk menu function codes from BSSTRT / module payloads.
 * Structure labels + function codes only.
 */
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN!;
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString!));
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
    await route.continue();
  });
  const page = await ctx.newPage();
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
    await page.waitForTimeout(4_000);

    // Pull start-center / menu payloads and extract label↔function pairs.
    const menu = await page.evaluate(async () => {
      const texts: string[] = [];
      const pairs: Array<{ label: string; fn: string }> = [];
      const blobs: string[] = [];
      for (const s of document.scripts) {
        if (s.textContent) blobs.push(s.textContent.slice(0, 500_000));
      }
      for (const path of [
        '/web/base/BSSTRT.HDR',
        '/web/base/BSSTRT',
      ]) {
        try {
          const r = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: 'BSSTRT',
              USER_FUNCTION_NAME: 'BSSTRT',
              manurefresh: 'yes',
            }).toString(),
            credentials: 'same-origin',
          });
          const t = await r.text();
          blobs.push(t);
          texts.push(`__path:${path}:bytes:${t.length}`);
        } catch {
          /* ignore */
        }
      }
      for (const text of blobs) {
        const labels = [...text.matchAll(/"itemLabel"\s*:\s*"([^"]+)"/g)].map(
          (x) => x[1]!,
        );
        for (const l of labels) texts.push(l);
        const fns = [
          ...text.matchAll(
            /"(?:userFunction|systemFunction|USER_FUNCTION_NAME|SYSTEM_FUNCTION_NAME|functionName)"\s*:\s*"([A-Z0-9]{4,12})"/g,
          ),
        ].map((x) => x[1]!);
        for (let i = 0; i < Math.min(labels.length, fns.length); i++) {
          pairs.push({ label: labels[i]!, fn: fns[i]! });
        }
        for (const hit of text.matchAll(
          /(Sent Email|Tax Invoice|Guest Stay|Folio|Deposit Ledger|Room Type and Rate Availability)[^A-Z0-9]{0,120}\b((?:PS|OS|AR)[A-Z0-9]{3,10})\b|\b((?:PS|OS|AR)[A-Z0-9]{3,10})\b[^A-Z0-9]{0,120}(Sent Email|Tax Invoice|Guest Stay|Folio)/gi,
        )) {
          const label = (hit[1] || hit[4] || '').trim();
          const fn = (hit[2] || hit[3] || '').trim();
          if (label && fn) pairs.push({ label, fn });
        }
      }
      const interestingLabels = [...new Set(texts)]
        .filter((t) =>
          /email|invoice|tax|folio|guest|sent|deposit|ledger|availability|room/i.test(
            t,
          ),
        )
        .slice(0, 100);
      const uniqPairs: Array<{ label: string; fn: string }> = [];
      const seen = new Set<string>();
      for (const p of pairs) {
        const k = `${p.label}|${p.fn}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (
          /email|invoice|tax|folio|guest|sent|deposit|ledger|availability|room|Front Desk/i.test(
            p.label,
          ) ||
          /PSSNEL|TAX|INV|FOLIO|RESS|RAV/i.test(p.fn)
        ) {
          uniqPairs.push(p);
        }
      }
      return {
        interestingLabels: interestingLabels.slice(0, 80),
        pairs: uniqPairs.slice(0, 80),
      };
    });

    // PSSNEL.HDR field inventory + toolbar action names (structure)
    const hdrMeta = await page.evaluate(async () => {
      const body = new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'PSSNEL',
        USER_FUNCTION_NAME: 'PSSNEL',
        CURRENT_TAB_NAME: 'HDR',
      });
      const r = await fetch('/web/base/PSSNEL.HDR', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'same-origin',
      });
      const text = await r.text();
      const fieldNames = [
        ...text.matchAll(/"name"\s*:\s*"([a-zA-Z0-9_]{2,48})"/g),
      ]
        .map((m) => m[1]!)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 120);
      const toolbar = [
        ...text.matchAll(/"label"\s*:\s*"([^"]{1,60})"/g),
      ]
        .map((m) => m[1]!)
        .filter((v, i, a) => a.indexOf(v) === i)
        .filter((l) =>
          /print|email|send|resend|export|generate|open|attach|search|new|delete|save/i.test(
            l,
          ),
        )
        .slice(0, 40);
      const gridCols = [
        ...text.matchAll(/"name"\s*:\s*"(emailtype|account|accountname|subject|emailaddress|attachment|userid|reportcode|error|emaildate|property|reportparameterlist)"/gi),
      ].map((m) => m[1]!.toLowerCase());
      return {
        bytes: text.length,
        fieldNames,
        toolbar,
        gridCols: [...new Set(gridCols)],
      };
    });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ menu, hdrMeta }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
