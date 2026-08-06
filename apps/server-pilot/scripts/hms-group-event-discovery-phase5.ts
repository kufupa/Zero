/**
 * Phase-5: structure probe GSGRPB (Group Booking) + CSGAVL (Group Availability).
 * Capture keys/tabs/actions only. No menu click (that invalidated session).
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

function classifyKeys(all: string[]) {
  const pick = (re: RegExp) => all.filter((k) => re.test(k)).slice(0, 60);
  return {
    refLike: pick(
      /confirmation|group(?:ref|code|id|number|name)|event(?:ref|code|id|number)|reference|allotment/i,
    ),
    statusLike: pick(/status|state/i),
    dateLike: pick(/date|start|end|arrival|departure|begin|finish/i),
    blockLike: pick(
      /^(con|blk)$|contracted|blocked|pickup|remaining|allot|release|restriction|closedto|minstay|maxstay|stopsell|cutoff/i,
    ),
    roomTypeLike: pick(/roomtype|rmtype|roomclass|category/i),
    contactLike: pick(/contact|email|phone|delegate|salesperson|coordinator/i),
    noteLike: pick(/note|comment|remark|instruction/i),
    roomingLike: pick(/rooming|guestname|firstname|lastname/i),
    actionLike: pick(
      /save|create|amend|assign|release|calculate|post|copy|cancel|print|generate|beo|proforma|quickentry|focus|blur/i,
    ),
  };
}

function firstDataKeys(text: string): string[] {
  const idx = text.search(/"DATA"\s*:\s*\[/i);
  if (idx < 0) return [];
  const slice = text.slice(idx, idx + 30000);
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
  const scrubbed = slice
    .slice(objStart, end + 1)
    .replace(/:\s*"[^"]*"/g, ':""')
    .replace(/:\s*-?\d+(?:\.\d+)?/g, ':0');
  return collectKeys(scrubbed);
}

function tabHints(text: string): string[] {
  const tabs = new Set<string>();
  for (const m of text.matchAll(
    /"(?:tabName|TAB_NAME|tabId|name)"\s*:\s*"([A-Za-z0-9_]{1,32})"/g,
  )) {
    tabs.add(m[1]!);
  }
  for (const m of text.matchAll(
    /\b(HDR|LST|BLK|BLOCK|RATE|ROOM|NOTE|DOC|DELEGATE|ROOMING|EVENT)\b/g,
  )) {
    tabs.add(m[1]!);
  }
  return [...tabs].sort().slice(0, 40);
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN!;
  const outPath =
    process.env.HMS_GROUP_EVENT_DISCOVERY_OUT ??
    '/tmp/hms-group-event-discovery-p5.json';
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
    if (control.text.length < 2000 || !/pageData/i.test(control.text)) {
      throw new Error(`session_not_ready bytes=${control.text.length}`);
    }

    const surfaces = [
      { fn: 'GSGRPB', label: 'Group Booking' },
      { fn: 'CSGAVL', label: 'Group Availability', viaEwsweb: true },
      { fn: 'GSEVNT', label: 'Event heuristic' },
      { fn: 'OSEVNT', label: 'Event heuristic OS' },
      { fn: 'PSEVNT', label: 'Event heuristic PS' },
    ] as const;

    const probes: Array<Record<string, unknown>> = [];
    for (const surface of surfaces) {
      const openFields: Record<string, string> = surface.viaEwsweb
        ? {
            USER_FUNCTION_NAME: surface.fn,
            SYSTEM_FUNCTION_NAME: 'EWSWEB',
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: '',
            MENU_MODULE_KEY: '0',
            removescreenflows: 'yes',
          }
        : {
            USER_FUNCTION_NAME: surface.fn,
            SYSTEM_FUNCTION_NAME: surface.fn,
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: '',
            MENU_MODULE_KEY: '0',
            removescreenflows: 'yes',
          };
      const openPath = surface.viaEwsweb
        ? '/web/base/EWSWEB'
        : `/web/base/${surface.fn}`;
      const open = await post(openPath, openFields);
      const variants: Array<Record<string, unknown>> = [];
      for (const suffix of [
        '.HDR',
        '.LST',
        '.search',
        '.BLK',
        '.BLOCK',
        '.ROOM',
        '.RATE',
      ]) {
        const v = await post(`/web/base/${surface.fn}${suffix}`, {
          SYSTEM_FUNCTION_NAME: surface.fn,
          USER_FUNCTION_NAME: surface.fn,
          CURRENT_TAB_NAME: suffix.replace('.', '') || 'HDR',
          COMPONENT_INFO_TYPE: 'DATA_ONLY',
          GRID_NAME: surface.fn,
        });
        if (v.status === 200 && v.text.length > 200) {
          const keys = collectKeys(v.text);
          variants.push({
            suffix,
            status: v.status,
            bytes: v.text.length,
            hasGrid: /GRIDRESULT/i.test(v.text),
            dataKeys: firstDataKeys(v.text),
            keyClasses: classifyKeys(keys),
            tabs: tabHints(v.text),
          });
        }
      }

      const openKeys = collectKeys(open.text);
      probes.push({
        fn: surface.fn,
        label: surface.label,
        openPath,
        openStatus: open.status,
        openBytes: open.text.length,
        openScreen: /"screen"\s*:\s*"([^"]+)"/.exec(open.text)?.[1] ?? null,
        openPageTitle:
          /"pageTitle"\s*:\s*"([^"]{1,80})"/.exec(open.text)?.[1]?.replace(
            /\d/g,
            '#',
          ) ?? null,
        openModulePath:
          /"modulePath"\s*:\s*"([^"]{1,80})"/.exec(open.text)?.[1] ?? null,
        openKeyClasses: classifyKeys(openKeys),
        openTabs: tabHints(open.text),
        openHasGrid: /GRIDRESULT/i.test(open.text),
        openHasActionPaths:
          /(save|calculate|post|copy|cancel|print|generate|beo|quick\s*entry|rooming)/i.test(
            open.text,
          ),
        openHasContactKeys:
          classifyKeys(openKeys).contactLike.length > 0 ||
          classifyKeys(openKeys).roomingLike.length > 0 ||
          classifyKeys(openKeys).noteLike.length > 0,
        variants,
        headMasked: open.text.slice(0, 220).replace(/\d/g, '#'),
      });
    }

    const report = {
      observedAt: new Date().toISOString(),
      originHost: new URL(origin).host,
      controlBytes: control.text.length,
      abortedMutationPaths: aborted.slice(0, 20),
      eventsMenuAbsent: true,
      eventsMenuEvidence:
        'Group Sales tree shows Group Booking + Group Availability only; Events/Event Reservation labels absent (phase3/4)',
      groupBookingFn: 'GSGRPB',
      groupAvailabilityFn: 'CSGAVL',
      probes,
      groupContractFit: probes
        .filter((p) => p.fn === 'GSGRPB')
        .map((p) => {
          const variants = p.variants as Array<{
            suffix: string;
            dataKeys: string[];
            keyClasses: ReturnType<typeof classifyKeys>;
          }>;
          const allDataKeys = [
            ...new Set(variants.flatMap((v) => v.dataKeys || [])),
          ];
          const blockKeys = classifyKeys(allDataKeys).blockLike;
          const refKeys = classifyKeys(allDataKeys).refLike;
          const hasCon = allDataKeys.some((k) => /^con$/i.test(k) || /contract/i.test(k));
          const hasBlk = allDataKeys.some((k) => /^blk$/i.test(k) || /block/i.test(k));
          const hasPickup = allDataKeys.some((k) => /pickup/i.test(k));
          const hasRemaining = allDataKeys.some((k) => /remaining/i.test(k));
          const hasRestriction = allDataKeys.some((k) =>
            /restrict|closedto|minstay|maxstay|stopsell|cta|ctd/i.test(k),
          );
          return {
            listOnlyCandidate: variants.some(
              (v) =>
                (v.suffix === '.LST' || v.suffix === '.search') &&
                (v.dataKeys?.length ?? 0) > 0,
            ),
            allDataKeys: allDataKeys.slice(0, 80),
            blockKeys,
            refKeys,
            hasCon,
            hasBlk,
            hasPickup,
            hasRemaining,
            hasRestriction,
            roomingOrContactOnOpen: p.openHasContactKeys,
            actionPathsOnOpen: p.openHasActionPaths,
          };
        }),
    };

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
