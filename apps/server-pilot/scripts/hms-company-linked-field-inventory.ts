/**
 * Re-inventory reservation-linked company/agency/billing field NAMES only.
 * Exact OSRESS.search abort-first → Guest Stay / Stay 360 SOB keys.
 * Never opens OSACCT, booking-agency profile, profile search, or save.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';
import { buildExactOsressSearchBody } from '../src/hms/live-read-manifest.js';

const NEEDED = ['billingmode', 'paymentterms', 'contractstatus'] as const;

const COMPANYISH =
  /compan|agenc|organiz|bill|term|contract|channel|market|source|sob|guarantor|direct.?bill|arbill/i;

function collectKeys(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g)) {
    out.add(m[1]!);
  }
  for (const m of text.matchAll(
    /\bname\s*[:=]\s*["']([A-Za-z][A-Za-z0-9_]{1,48})["']/gi,
  )) {
    out.add(m[1]!);
  }
  return [...out].sort();
}

function companyishKeys(keys: string[]): string[] {
  return keys.filter((k) => COMPANYISH.test(k));
}

function neededHits(keys: string[]): Record<(typeof NEEDED)[number], boolean> {
  const lower = new Set(keys.map((k) => k.toLowerCase()));
  return {
    billingmode: lower.has('billingmode'),
    paymentterms:
      lower.has('paymentterms') ||
      lower.has('paymentterm') ||
      lower.has('paymenttermclass'),
    contractstatus: lower.has('contractstatus'),
  };
}

/** First DATA row confirmation token — used in-memory only; never written. */
function extractFirstConfirmation(text: string): string | null {
  const patterns = [
    /"confirmationnumber"\s*:\s*"([^"]{4,64})"/i,
    /confirmationnumber["']?\s*[:=]\s*["']([^"']{4,64})["']/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1] && m[1] !== '___NOMATCH___') return m[1];
  }
  return null;
}

function fieldPresence(text: string, names: string[]) {
  return names.map((name) => {
    const re = new RegExp(`["']?${name}["']?`, 'i');
    const present = re.test(text);
    let readOnly: boolean | null = null;
    if (present) {
      const snipRe = new RegExp(`["']?${name}["']?[^\\n]{0,350}`, 'i');
      const snip = text.match(snipRe)?.[0] ?? '';
      readOnly =
        /readOnly["'\s:=]+true/i.test(snip) ||
        /"readonly"\s*:\s*true/i.test(snip);
    }
    return { field: name, present, readOnly };
  });
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN!;
  const outPath =
    process.env.HMS_COMPANY_INVENTORY_OUT ??
    '/tmp/hms-company-linked-field-inventory.json';
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
    const path = new URL(req.url()).pathname;
    // Abort mutate + company/agency profile edit surfaces
    if (
      req.method() === 'POST' &&
      /(save|delete|settle|refund|void|print\/|export|generate|resend|finalize|postpayment|transfer|OSACCT|OSBAGN|OSPRFL|profile\.search)/i.test(
        path,
      )
    ) {
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
    await page.waitForTimeout(3_000);

    async function post(path: string, fields: Record<string, string>) {
      // Same-origin fetch inside page → session cookies (page.request often 149B empty).
      return page.evaluate(
        async ({ path: p, fields: f }) => {
          const r = await fetch(p, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(f).toString(),
            credentials: 'same-origin',
          });
          const text = await r.text();
          return { status: r.status, bytes: text.length, text };
        },
        { path, fields },
      );
    }

    const osressOpen = await post(
      '/web/base/OSRESS?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESS',
      {
        USER_FUNCTION_NAME: 'OSRESS',
        SYSTEM_FUNCTION_NAME: 'OSRESS',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      },
    );

    // Seed via reviewed dataspy chrome + empty confirmation BEGINS (= date-window wildcard).
    // Confirmation value kept in memory only — never written to report.
    const seedBody = buildExactOsressSearchBody({
      id: 'company-inventory-seed',
      kind: 'confirmation',
      value: 'SEED',
    });
    seedBody.MADDON_FILTER_VALUE_3 = '';
    seedBody.MADDON_FILTER_VALUE_4 = '';
    seedBody.MADDON_FILTER_VALUE_5 = '';
    seedBody.MADDON_FILTER_VALUE_6 = '';
    seedBody.MADDON_FILTER_VALUE_7 = '';
    seedBody.MADDON_FILTER_VALUE_8 = '';
    seedBody.MADDON_FILTER_VALUE_9 = '';
    seedBody.MADDON_FILTER_VALUE_10 = '';
    seedBody.externalconfirmation = '';
    const seedSearch = await post('/web/base/OSRESS.search', seedBody);
    const conf = extractFirstConfirmation(seedSearch.text);
    if (!conf) {
      const report = {
        verdict: 'BLOCKED_COMPANY_READ_SURFACE_UNPROVEN',
        reason: 'no_confirmation_seed_for_exact_find',
        seedStatus: seedSearch.status,
        seedBytes: seedSearch.bytes,
        seedHasGrid: /GRIDRESULT/i.test(seedSearch.text),
        seedCompanyish: companyishKeys(collectKeys(seedSearch.text)),
        seedKeySample: collectKeys(seedSearch.text).slice(0, 40),
        osressOpenBytes: osressOpen.bytes,
        osressOpenCompanyish: companyishKeys(collectKeys(osressOpen.text)),
        needed: NEEDED,
        foundNeeded: neededHits(collectKeys(osressOpen.text)),
        folioUnaffected: true,
      };
      await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const exactBody = buildExactOsressSearchBody({
      id: 'company-inventory',
      kind: 'confirmation',
      value: conf,
    });
    const exact = await post('/web/base/OSRESS.search', exactBody);

    // Stay 360 candidates — tile/read surfaces only (no profile open).
    const stay360Paths = [
      '/web/base/OSRESS',
      '/web/base/OSSTAY',
      '/web/base/STAY360',
      '/web/base/OSRESS.STAY360',
      '/web/base/OSRESS.SOB',
      '/web/base/OSRESS.HDR',
      '/web/base/OSRESS.GST',
    ];
    const stay360: Array<Record<string, unknown>> = [];
    for (const path of stay360Paths) {
      const r = await post(path, {
        SYSTEM_FUNCTION_NAME: path.includes('OSSTAY')
          ? 'OSSTAY'
          : path.includes('STAY360')
            ? 'STAY360'
            : 'OSRESS',
        USER_FUNCTION_NAME: path.includes('OSSTAY')
          ? 'OSSTAY'
          : path.includes('STAY360')
            ? 'STAY360'
            : 'OSRESS',
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: path.includes('SOB')
          ? 'SOB'
          : path.includes('HDR')
            ? 'HDR'
            : path.includes('GST')
              ? 'GST'
              : '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      });
      const keys = collectKeys(r.text);
      stay360.push({
        path,
        status: r.status,
        bytes: r.bytes,
        companyish: companyishKeys(keys),
        neededHits: neededHits(keys),
      });
    }

    const probeNames = [
      'company',
      'companyname',
      'organization',
      'organizationname',
      'bookingagency',
      'bookingagencyname',
      'bookingagency2name',
      'channel',
      'channelname',
      'marketsegment',
      'source',
      'sourceofbusiness',
      'billingmode',
      'paymentterms',
      'paymentterm',
      'contractstatus',
      'directbill',
      'guarantor',
      'group',
      'groupname',
    ];

    const osressKeys = collectKeys(osressOpen.text);
    const exactKeys = collectKeys(exact.text);
    const allCompanyish = [
      ...new Set([
        ...companyishKeys(osressKeys),
        ...companyishKeys(exactKeys),
        ...stay360.flatMap((s) => (s.companyish as string[]) ?? []),
      ]),
    ].sort();

    const foundNeeded = neededHits([
      ...osressKeys,
      ...exactKeys,
      ...stay360.flatMap((s) => (s.companyish as string[]) ?? []),
    ]);
    const trioPresent =
      foundNeeded.billingmode &&
      foundNeeded.paymentterms &&
      foundNeeded.contractstatus;

    const report = {
      observedAt: new Date().toISOString(),
      method: 'exact_osress_search_then_stay360_candidates',
      exactSearchStatus: exact.status,
      exactSearchBytes: exact.bytes,
      exactHadConfirmationSeed: true,
      // never echo confirmation value
      confirmationSeeded: true,
      osressOpenCompanyish: companyishKeys(osressKeys),
      exactSearchCompanyish: companyishKeys(exactKeys),
      osressFieldPresence: fieldPresence(osressOpen.text, probeNames),
      exactFieldPresence: fieldPresence(exact.text, probeNames),
      stay360,
      allCompanyishFieldNames: allCompanyish,
      needed: [...NEEDED],
      foundNeeded,
      trioPresentOnSafeLinkedSurface: trioPresent,
      openedOsacct: false,
      openedAgencyProfile: false,
      openedProfileSearch: false,
      saved: false,
      verdict: trioPresent
        ? 'PROMOTE_CANDIDATE'
        : 'BLOCKED_COMPANY_READ_SURFACE_UNPROVEN',
      folioUnaffected: true,
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
