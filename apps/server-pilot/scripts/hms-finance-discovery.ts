/**
 * Abort-first Folio / Deposit Ledger / reservation-linked company discovery.
 * Structure-only output — never balances, card numbers, names, account IDs.
 * Requires HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

type FnProbe = {
  fn: string;
  openStatus: number | null;
  openBytes: number;
  openTitleHints: string[];
  openFnEchoes: string[];
  openFieldKeySample: string[];
  openHasGrid: boolean;
  openHasBalanceKey: boolean;
  openHasCardKey: boolean;
  openHasPostAction: boolean;
  hdrStatus: number | null;
  hdrBytes: number;
  hdrFieldKeySample: string[];
  hdrHasGrid: boolean;
  hdrHasBalanceKey: boolean;
  hdrHasDepositKey: boolean;
  error?: string;
};

function structureKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(/"([A-Za-z][A-Za-z0-9_]{1,40})"\s*:/g)) {
    keys.add(m[1]!);
  }
  for (const m of text.matchAll(
    /\bname\s*[:=]\s*["']([A-Za-z][A-Za-z0-9_]{1,40})["']/gi,
  )) {
    keys.add(m[1]!);
  }
  return [...keys].sort().slice(0, 80);
}

function titleHints(text: string): string[] {
  const hits = new Set<string>();
  for (const re of [
    /Folio Selection/gi,
    /Folio\b/gi,
    /Deposit Ledger/gi,
    /Property Ledger/gi,
    /Advance Deposit/gi,
    /Company/gi,
    /Agency/gi,
    /Guest Stay/gi,
    /Account\b/gi,
  ]) {
    for (const m of text.matchAll(re)) hits.add(m[0]!.replace(/\s+/g, ' '));
  }
  return [...hits].slice(0, 20);
}

function fnEchoes(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/\b((?:PS|OS|AR|BS)[A-Z0-9]{3,10})\b/g)].map(
        (m) => m[1]!,
      ),
    ),
  ].slice(0, 30);
}

function hasKey(keys: string[], re: RegExp): boolean {
  return keys.some((k) => re.test(k));
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_FINANCE_DISCOVERY_OUT ?? '/tmp/hms-finance-discovery.json';

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error('secret empty');
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  if (secret.credentialMode !== 'view_only') {
    throw new Error('refuse: credentialMode must be view_only');
  }
  const origin = new URL(secret.loginUrl).origin;

  const aborted: Array<{ path: string; reason: string }> = [];
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
      aborted.push({ path: new URL(req.url()).pathname, reason: 'cross_origin' });
      await route.abort();
      return;
    }
    const path = new URL(req.url()).pathname;
    if (
      req.method() === 'POST' &&
      /(save|delete|settle|refund|post|transfer|void|print\/|export|generate|resend|finalize|email)/i.test(
        path,
      )
    ) {
      aborted.push({ path, reason: 'mutation_or_delivery_path' });
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

    // Menu label ↔ function pairs (structure only)
    const menu = await page.evaluate(async () => {
      const blobs: string[] = [];
      for (const path of ['/web/base/BSSTRT.HDR', '/web/base/BSSTRT']) {
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
          blobs.push(await r.text());
        } catch {
          /* ignore */
        }
      }
      const pairs: Array<{ label: string; fn: string }> = [];
      const interestingLabels: string[] = [];
      for (const text of blobs) {
        for (const m of text.matchAll(/"itemLabel"\s*:\s*"([^"]+)"/g)) {
          const label = m[1]!;
          if (
            /folio|deposit|ledger|property|company|agency|account|bill|profile|organization/i.test(
              label,
            )
          ) {
            interestingLabels.push(label);
          }
        }
        for (const hit of text.matchAll(
          /(Folio Selection|Folio|Deposit Ledger|Property Ledger|Advance Deposit|Company|Agency|Guest Stay|Account)[^A-Z0-9]{0,160}\b((?:PS|OS|AR)[A-Z0-9]{3,10})\b|\b((?:PS|OS|AR)[A-Z0-9]{3,10})\b[^A-Z0-9]{0,160}(Folio Selection|Folio|Deposit Ledger|Property Ledger|Advance Deposit|Company|Agency)/gi,
        )) {
          const label = (hit[1] || hit[4] || '').trim();
          const fn = (hit[2] || hit[3] || '').trim();
          if (label && fn) pairs.push({ label, fn });
        }
      }
      const uniq: Array<{ label: string; fn: string }> = [];
      const seen = new Set<string>();
      for (const p of pairs) {
        const k = `${p.label}|${p.fn}`;
        if (seen.has(k)) continue;
        seen.add(k);
        uniq.push(p);
      }
      return {
        interestingLabels: [...new Set(interestingLabels)].slice(0, 80),
        pairs: uniq.slice(0, 80),
      };
    });

    // Candidate function codes — menu hits + known guesses from Task 15 + docs.
    const guessFns = [
      'OSPTAX', // previously opened Folio Selection
      'OSFOL',
      'OSFOLI',
      'OSPFOL',
      'PSFOL',
      'PSFOLI',
      'OSDEP',
      'OSDEPL',
      'OSLED',
      'OSPLED',
      'PSPLG',
      'OSPLG',
      'OSPROP',
      'ARLED',
      'ARDEP',
      'OSCOM',
      'OSCOMP',
      'ARCOM',
      'PSCOM',
      'OSPROF',
      'ARPROF',
      'OSACCT',
      'OSACT',
    ];
    const menuFns = menu.pairs.map((p) => p.fn.toUpperCase());
    const candidates = [...new Set([...menuFns, ...guessFns])].slice(0, 40);

    const probes: FnProbe[] = [];
    for (const fn of candidates) {
      const probe: FnProbe = {
        fn,
        openStatus: null,
        openBytes: 0,
        openTitleHints: [],
        openFnEchoes: [],
        openFieldKeySample: [],
        openHasGrid: false,
        openHasBalanceKey: false,
        openHasCardKey: false,
        openHasPostAction: false,
        hdrStatus: null,
        hdrBytes: 0,
        hdrFieldKeySample: [],
        hdrHasGrid: false,
        hdrHasBalanceKey: false,
        hdrHasDepositKey: false,
      };
      try {
        const open = await page.evaluate(async (functionName) => {
          const r = await fetch(`/web/base/${functionName}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              USER_FUNCTION_NAME: functionName,
              SYSTEM_FUNCTION_NAME: functionName,
              FUNCTION_CLASS: 'WEBL',
              CURRENT_TAB_NAME: '',
              MENU_MODULE_KEY: '0',
              removescreenflows: 'yes',
            }).toString(),
            credentials: 'same-origin',
          });
          const text = await r.text();
          return { status: r.status, text };
        }, fn);
        probe.openStatus = open.status;
        probe.openBytes = open.text.length;
        probe.openTitleHints = titleHints(open.text);
        probe.openFnEchoes = fnEchoes(open.text);
        probe.openFieldKeySample = structureKeys(open.text);
        probe.openHasGrid = /GRIDRESULT|GRID_NAME/i.test(open.text);
        probe.openHasBalanceKey = hasKey(
          probe.openFieldKeySample,
          /balance|total|amount|currency/i,
        );
        probe.openHasCardKey = hasKey(
          probe.openFieldKeySample,
          /card|vcc|pan|cvv|paymentcredential/i,
        );
        probe.openHasPostAction =
          /post\s*payment|folio\s*settlement|transfer\s*record|advance\s*deposit/i.test(
            open.text,
          );

        const hdr = await page.evaluate(async (functionName) => {
          const r = await fetch(`/web/base/${functionName}.HDR`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: functionName,
              USER_FUNCTION_NAME: functionName,
              CURRENT_TAB_NAME: 'HDR',
            }).toString(),
            credentials: 'same-origin',
          });
          const text = await r.text();
          return { status: r.status, text };
        }, fn);
        probe.hdrStatus = hdr.status;
        probe.hdrBytes = hdr.text.length;
        probe.hdrFieldKeySample = structureKeys(hdr.text);
        probe.hdrHasGrid = /GRIDRESULT|GRID_NAME/i.test(hdr.text);
        probe.hdrHasBalanceKey = hasKey(
          probe.hdrFieldKeySample,
          /balance|total|amount|currency/i,
        );
        probe.hdrHasDepositKey = hasKey(
          probe.hdrFieldKeySample,
          /deposit|due|paid|refund|forfeit|transfer/i,
        );
      } catch (err) {
        probe.error = err instanceof Error ? err.message.slice(0, 120) : 'err';
      }
      probes.push(probe);
    }

    // Click Front Desk tree labels for Folio / Deposit / Property Ledger (structure).
    const clickLabels = [
      'Front Desk',
      'Folio',
      'Folio Selection',
      'Property Ledger',
      'Deposit Ledger',
      'Account',
      'Company',
      'Agency',
    ];
    const clickResults: Array<{ label: string; visible: boolean }> = [];
    for (const label of clickLabels) {
      const loc = page.getByText(label, { exact: true }).first();
      const visible = await loc.isVisible().catch(() => false);
      clickResults.push({ label, visible });
      if (visible) {
        await loc.click({ force: true, timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(1_500);
      }
    }

    const report = {
      surface: 'finance_discovery',
      originHost: new URL(origin).host,
      menu,
      clickResults,
      probes: probes.map((p) => ({
        ...p,
        // Cap key samples further in summary path
        openFieldKeySample: p.openFieldKeySample.slice(0, 40),
        hdrFieldKeySample: p.hdrFieldKeySample.slice(0, 40),
      })),
      interestingProbes: probes
        .filter(
          (p) =>
            p.openStatus === 200 ||
            p.hdrStatus === 200 ||
            p.openTitleHints.length > 0 ||
            p.openHasBalanceKey ||
            p.hdrHasBalanceKey ||
            p.hdrHasDepositKey,
        )
        .map((p) => ({
          fn: p.fn,
          openStatus: p.openStatus,
          hdrStatus: p.hdrStatus,
          openTitleHints: p.openTitleHints,
          openHasGrid: p.openHasGrid,
          openHasBalanceKey: p.openHasBalanceKey,
          openHasCardKey: p.openHasCardKey,
          openHasPostAction: p.openHasPostAction,
          hdrHasGrid: p.hdrHasGrid,
          hdrHasBalanceKey: p.hdrHasBalanceKey,
          hdrHasDepositKey: p.hdrHasDepositKey,
          openKeyHits: p.openFieldKeySample.filter((k) =>
            /balance|deposit|currency|total|amount|folio|due|paid|refund|forfeit|transfer|company|agency|billing|term|contract/i.test(
              k,
            ),
          ),
          hdrKeyHits: p.hdrFieldKeySample.filter((k) =>
            /balance|deposit|currency|total|amount|folio|due|paid|refund|forfeit|transfer|company|agency|billing|term|contract/i.test(
              k,
            ),
          ),
        })),
      abortedCount: aborted.length,
      abortedSample: aborted.slice(0, 20),
    };

    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    // Safe stdout: counts + interesting fn codes only
    console.log(
      JSON.stringify(
        {
          outPath,
          interestingLabelCount: menu.interestingLabels.length,
          pairCount: menu.pairs.length,
          interestingProbeCount: report.interestingProbes.length,
          interestingProbes: report.interestingProbes.map((p) => ({
            fn: p.fn,
            openStatus: p.openStatus,
            hdrStatus: p.hdrStatus,
            openTitleHints: p.openTitleHints,
            openHasBalanceKey: p.openHasBalanceKey,
            hdrHasBalanceKey: p.hdrHasBalanceKey,
            hdrHasDepositKey: p.hdrHasDepositKey,
            openHasPostAction: p.openHasPostAction,
            openKeyHits: p.openKeyHits,
            hdrKeyHits: p.hdrKeyHits,
          })),
          menuPairs: menu.pairs.slice(0, 30),
          interestingLabels: menu.interestingLabels.slice(0, 40),
          clickResults,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
