/**
 * Phase-6: GSGRPB.BLK / RTY / related tabs — con/blk/pickup/remaining keys only.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

function collectKeys(text: string): string[] {
  const out: string[] = [];
  const re = /"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out.sort();
}

function firstDataKeys(text: string): string[] {
  const idx = text.search(/"DATA"\s*:\s*\[/i);
  if (idx < 0) return [];
  const slice = text.slice(idx, idx + 40000);
  const objStart = slice.indexOf('{');
  if (objStart < 0) return [];
  let depth = 0;
  let end = -1;
  for (let i = objStart; i < slice.length; i++) {
    if (slice[i] === '{') depth++;
    if (slice[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  return collectKeys(
    slice
      .slice(objStart, end + 1)
      .replace(/:\s*"[^"]*"/g, ':""')
      .replace(/:\s*-?\d+(?:\.\d+)?/g, ':0'),
  );
}

function pickRelevant(keys: string[]) {
  const pick = (re: RegExp) => keys.filter((k) => re.test(k));
  return {
    con: pick(/^(con|contracted|contractrooms|contractedrooms)$/i),
    blk: pick(/^(blk|blocked|blockrooms|blockedrooms|blockcount)$/i),
    pickup: pick(/pickup/i),
    remaining: pick(/remaining|avail/i),
    restriction: pick(
      /restrict|closedto|cta|ctd|minstay|maxstay|stopsell|staythrough/i,
    ),
    roomType: pick(/roomtype|rmtype|roomclass/i),
    date: pick(/^(date|blockdate|staydate|hoteldate)$/i),
    denied: pick(
      /contact|firstname|lastname|email|phone|delegate|note|rooming|guestname/i,
    ),
    action: pick(
      /save|create|amend|assign|release|calculate|post|copy|cancel|print|focus|quickentry/i,
    ),
  };
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN!;
  const outPath =
    process.env.HMS_GROUP_EVENT_DISCOVERY_OUT ??
    '/tmp/hms-group-event-discovery-p6.json';
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString!));
  if (secret.credentialMode !== 'view_only') throw new Error('not view_only');
  const origin = new URL(secret.loginUrl).origin;

  const aborted: string[] = [];
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
      /(save|delete|settle|refund|void|print\/|export|generate|resend|finalize)/i.test(
        path,
      )
    ) {
      aborted.push(path);
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
    await page.waitForTimeout(6_000);

    async function post(path: string, fields: Record<string, string>) {
      const response = await page.request.post(`${origin}${path}`, {
        form: fields,
        timeout: 60_000,
      });
      return { status: response.status(), text: await response.text() };
    }

    const control = await post('/web/base/OSRESS', {
      USER_FUNCTION_NAME: 'OSRESS',
      SYSTEM_FUNCTION_NAME: 'OSRESS',
      FUNCTION_CLASS: 'WEBL',
      CURRENT_TAB_NAME: '',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
    });
    if (control.text.length < 2000) {
      throw new Error(`session_not_ready bytes=${control.text.length}`);
    }

    // Open GSGRPB shell first.
    const open = await post('/web/base/GSGRPB', {
      USER_FUNCTION_NAME: 'GSGRPB',
      SYSTEM_FUNCTION_NAME: 'GSGRPB',
      FUNCTION_CLASS: 'WEBL',
      CURRENT_TAB_NAME: '',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
    });

    const paths = [
      '/web/base/GSGRPB.BLK',
      '/web/base/GSGRPB.BLOCK',
      '/web/base/GSGRPB.RTY',
      '/web/base/GSGRPB.RRT',
      '/web/base/GSGRPB.GBD',
      '/web/base/GSGRPB.GAT',
      '/web/base/GSGRPB.HDR',
      '/web/base/GSGRPB.LST',
      // subgroup / room block guesses under group sales
      '/web/base/GSGRPB.BLK.LST',
      '/web/base/GSGRPB.BLK.search',
      '/web/base/GSSUBG',
      '/web/base/GSSUBG.LST',
      '/web/base/GSBLOK',
      '/web/base/GSBLOK.LST',
      '/web/base/GSBLK',
      '/web/base/GSBLK.LST',
      '/web/base/GSGBLK',
      '/web/base/GSGBLK.LST',
    ];

    const probes: Array<Record<string, unknown>> = [];
    for (const path of paths) {
      const fn = path.split('/')[3]!.split('.')[0]!;
      const tab = path.includes('.')
        ? path.split('.').slice(1).join('.')
        : '';
      const r = await post(path, {
        SYSTEM_FUNCTION_NAME: fn,
        USER_FUNCTION_NAME: fn,
        CURRENT_TAB_NAME: tab.split('.')[0] || '',
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_NAME: fn,
      });
      const keys = collectKeys(r.text);
      const dataKeys = firstDataKeys(r.text);
      probes.push({
        path,
        status: r.status,
        bytes: r.text.length,
        hasGrid: /GRIDRESULT/i.test(r.text),
        hasPageData: /pageData/i.test(r.text),
        screen: /"screen"\s*:\s*"([^"]+)"/.exec(r.text)?.[1] ?? null,
        modulePath:
          /"modulePath"\s*:\s*"([^"]{1,80})"/.exec(r.text)?.[1] ?? null,
        allKeyRelevant: pickRelevant(keys),
        dataKeyRelevant: pickRelevant(dataKeys),
        dataKeysSample: dataKeys.slice(0, 80),
        keySample: keys
          .filter((k) =>
            /con|blk|block|pickup|remain|restrict|roomtype|date|allot|status|group/i.test(
              k,
            ),
          )
          .slice(0, 80),
      });
    }

    // Also try BLK as CURRENT_TAB_NAME on base open path.
    const blkTab = await post('/web/base/GSGRPB', {
      USER_FUNCTION_NAME: 'GSGRPB',
      SYSTEM_FUNCTION_NAME: 'GSGRPB',
      FUNCTION_CLASS: 'WEBL',
      CURRENT_TAB_NAME: 'BLK',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
    });

    const report = {
      observedAt: new Date().toISOString(),
      openBytes: open.text.length,
      openTabs: [
        ...open.text.matchAll(
          /"(?:tabName|name)"\s*:\s*"([A-Za-z0-9_]{2,12})"/g,
        ),
      ]
        .map((m) => m[1]!)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 40),
      blkTabBytes: blkTab.text.length,
      blkTabRelevant: pickRelevant(collectKeys(blkTab.text)),
      abortedMutationPaths: aborted.slice(0, 20),
      probes: probes.filter(
        (p) =>
          (typeof p.bytes === 'number' && p.bytes > 300) ||
          p.hasGrid ||
          p.hasPageData,
      ),
      contractVerdict: {
        listHasExactRef: true, // groupbookingreferencenumber on LST (phase5)
        listHasStatusDates: true,
        listHasConBlkPickupRemaining: false, // phase5 LST lacked these
        blkTabHasCounts: null as boolean | null,
        detailRequiredForCounts: null as boolean | null,
        unsafeContactOnList: true, // contactfirstname/lastname on LST
        unsafeActionsOnHdr: true,
        eventSurface: 'absent',
      },
    };

    // Fill verdict from probes
    const blkProbe = report.probes.find(
      (p) =>
        String(p.path).includes('.BLK') ||
        (p.dataKeyRelevant as { con: string[] })?.con?.length > 0 ||
        (p.dataKeyRelevant as { pickup: string[] })?.pickup?.length > 0,
    );
    if (blkProbe) {
      const rel = blkProbe.dataKeyRelevant as ReturnType<typeof pickRelevant>;
      report.contractVerdict.blkTabHasCounts =
        rel.con.length + rel.blk.length + rel.pickup.length + rel.remaining.length >
        0;
      report.contractVerdict.detailRequiredForCounts =
        !report.contractVerdict.blkTabHasCounts;
    } else {
      report.contractVerdict.blkTabHasCounts = false;
      report.contractVerdict.detailRequiredForCounts = true;
    }

    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
