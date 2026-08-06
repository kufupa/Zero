/**
 * Phase-3: soft-capture Group Sales menu → function codes, then structure probes.
 * Uses page.request (proven). Keys/titles only.
 */
import { writeFile } from 'node:fs/promises';
import { chromium, type Request } from 'playwright';
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
  const pick = (re: RegExp) => all.filter((k) => re.test(k)).slice(0, 40);
  return {
    refLike: pick(
      /confirmation|group(?:ref|code|id|number)|event(?:ref|code|id|number)|reference|allotment/i,
    ),
    statusLike: pick(/status|state/i),
    dateLike: pick(/date|start|end|arrival|departure|begin|finish/i),
    blockLike: pick(
      /^(con|blk)$|contracted|blocked|pickup|remaining|allot|release|restriction|closedto|minstay|maxstay|stopsell/i,
    ),
    roomTypeLike: pick(/roomtype|rmtype|roomclass|category/i),
    eventLike: pick(
      /eventtype|layout|attendee|persons?|guestcount|setup|teardown|deposit|currency|total|amount/i,
    ),
    contactLike: pick(/contact|email|phone|delegate|salesperson|coordinator/i),
    noteLike: pick(/note|comment|remark|instruction/i),
    roomingLike: pick(/rooming|guestname|firstname|lastname/i),
    actionLike: pick(
      /save|create|amend|assign|release|calculate|post|copy|cancel|print|generate|beo|proforma|quickentry/i,
    ),
  };
}

function titleHints(text: string): string[] {
  const hits = new Set<string>();
  for (const re of [
    /Group Booking/gi,
    /Subgroup Room Blocks?/gi,
    /Room Blocks?/gi,
    /Rooming List/gi,
    /Event Reservation/gi,
    /Banquet Event/gi,
    /\bBEO\b/gi,
    /Guest Stay/gi,
    /Sent Email/gi,
  ]) {
    for (const m of text.matchAll(re)) hits.add(m[0]!.replace(/\s+/g, ' '));
  }
  return [...hits].slice(0, 25);
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN!;
  const outPath =
    process.env.HMS_GROUP_EVENT_DISCOVERY_OUT ??
    '/tmp/hms-group-event-discovery-p3.json';
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString!));
  if (secret.credentialMode !== 'view_only') throw new Error('not view_only');
  const origin = new URL(secret.loginUrl).origin;

  const aborted: string[] = [];
  const continuedPosts: Array<{ path: string; fn: string | null }> = [];

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

  const onRequest = (req: Request) => {
    if (req.method() !== 'POST') return;
    const path = new URL(req.url()).pathname;
    if (!path.startsWith('/web/base/')) return;
    const fn = /\/web\/base\/([A-Z0-9]{4,12})/i.exec(path)?.[1]?.toUpperCase() ?? null;
    continuedPosts.push({ path, fn });
  };
  page.on('request', onRequest);

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

    // Control: must get real OSRESS pageData before continuing.
    const control = await post('/web/base/OSRESS', {
      USER_FUNCTION_NAME: 'OSRESS',
      SYSTEM_FUNCTION_NAME: 'OSRESS',
      FUNCTION_CLASS: 'WEBL',
      CURRENT_TAB_NAME: '',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
    });
    const controlOk =
      control.status === 200 &&
      control.text.length > 2000 &&
      /pageData/i.test(control.text);
    if (!controlOk) {
      throw new Error(
        `session_not_ready controlBytes=${control.text.length} status=${control.status}`,
      );
    }

    // Soft-capture: click Group Sales + expanders; record POSTs.
    const beforePosts = continuedPosts.length;
    const clickLog: Array<{ label: string; visible: boolean; clicked: boolean }> =
      [];
    for (const label of [
      'Group Sales',
      'Group Booking',
      'Events',
      'Event Reservations',
      'Event Reservation',
      'Blocks',
      'Room Blocks',
      'Subgroup Room Blocks',
      'Rooming List',
    ]) {
      const loc = page.getByText(label, { exact: true }).first();
      const visible = await loc.isVisible().catch(() => false);
      let clicked = false;
      if (visible) {
        await loc.click({ force: true, timeout: 8_000 }).catch(() => undefined);
        clicked = true;
        await page.waitForTimeout(2_500);
      }
      clickLog.push({ label, visible, clicked });
    }

    // Click tree expanders near Group Sales.
    await page.evaluate(() => {
      const texts = [...document.querySelectorAll('.x-tree-node-text, span')];
      for (const t of texts) {
        if (!/Group Sales|Events/i.test(t.textContent || '')) continue;
        const row = t.closest('.x-tree-node-el, .x-tree-node, li, div');
        if (!row) continue;
        const plus = row.querySelector(
          '.x-tree-ec-icon, .x-tree-elbow-plus, .x-tree-elbow-end-plus, img',
        );
        if (plus) {
          try {
            (plus as HTMLElement).click();
          } catch {
            /* ignore */
          }
        }
        try {
          (t as HTMLElement).click();
        } catch {
          /* ignore */
        }
      }
    });
    await page.waitForTimeout(3_000);

    // Retry child labels after expand.
    for (const label of [
      'Group Booking',
      'Events',
      'Event Reservations',
      'Event Reservation',
      'Room Blocks',
      'Subgroup Room Blocks',
      'Rooming List',
      'Blocks',
      'Allotments',
    ]) {
      const loc = page.getByText(label, { exact: false }).first();
      const visible = await loc.isVisible().catch(() => false);
      if (visible) {
        await loc.click({ force: true, timeout: 8_000 }).catch(() => undefined);
        clickLog.push({ label: `${label}#retry`, visible, clicked: true });
        await page.waitForTimeout(2_500);
      } else {
        clickLog.push({ label: `${label}#retry`, visible, clicked: false });
      }
    }

    const treeAfter = await page.evaluate(() => {
      const texts = [
        ...document.querySelectorAll(
          '.x-tree-node-text, .x-menu-item-text, .x-btn-inner, span, a',
        ),
      ]
        .map((el) => (el.textContent || '').trim())
        .filter((t) => t.length > 1 && t.length < 80);
      const uniq = [...new Set(texts)];
      return {
        interesting: uniq
          .filter((t) =>
            /group|block|event|banquet|rooming|allot|booking|sales/i.test(t),
          )
          .slice(0, 80),
        sample: uniq.slice(0, 50),
      };
    });

    const menuPosts = continuedPosts.slice(beforePosts);
    const menuFns = [
      ...new Set(
        menuPosts
          .map((p) => p.fn)
          .filter((f): f is string => !!f && !['COMMON', 'BSSTRT'].includes(f)),
      ),
    ].sort();

    // Probe menu-derived fns + small heuristic set (not the full noisy list).
    const probeFns = [
      ...new Set([
        ...menuFns,
        'OSGRBK',
        'OSGRES',
        'OSEVNT',
        'OSEVRE',
        'OSGBLK',
        'GSGRBK',
        'GSEVNT',
        'PSGRBK',
        'PSEVNT',
      ]),
    ].slice(0, 30);

    const probes: Array<Record<string, unknown>> = [];
    for (const fn of probeFns) {
      const open = await post(`/web/base/${fn}`, {
        USER_FUNCTION_NAME: fn,
        SYSTEM_FUNCTION_NAME: fn,
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      });
      const lst = await post(`/web/base/${fn}.LST`, {
        SYSTEM_FUNCTION_NAME: fn,
        USER_FUNCTION_NAME: fn,
        CURRENT_TAB_NAME: 'LST',
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_NAME: fn,
      });
      const search = await post(`/web/base/${fn}.search`, {
        SYSTEM_FUNCTION_NAME: fn,
        USER_FUNCTION_NAME: fn,
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_NAME: fn,
      });
      const openKeys = collectKeys(open.text);
      const lstKeys = collectKeys(lst.text);
      const searchKeys = collectKeys(search.text);
      probes.push({
        fn,
        openStatus: open.status,
        openBytes: open.text.length,
        openTitles: titleHints(open.text),
        openKeyClasses: classifyKeys(openKeys),
        openHasGrid: /GRIDRESULT|"DATA"\s*:/.test(open.text),
        openHasActionPaths:
          /(save|calculate|post|copy|cancel|print|generate|beo)/i.test(
            open.text,
          ),
        openScreen: /"screen"\s*:\s*"([^"]+)"/.exec(open.text)?.[1] ?? null,
        openPageTitle:
          /"pageTitle"\s*:\s*"([^"]{1,80})"/.exec(open.text)?.[1]?.replace(
            /\d/g,
            '#',
          ) ?? null,
        lstStatus: lst.status,
        lstBytes: lst.text.length,
        lstHasGrid: /GRIDRESULT/i.test(lst.text),
        lstKeyClasses: classifyKeys(lstKeys),
        searchStatus: search.status,
        searchBytes: search.text.length,
        searchHasGrid: /GRIDRESULT/i.test(search.text),
        searchKeyClasses: classifyKeys(searchKeys),
      });
    }

    const report = {
      observedAt: new Date().toISOString(),
      originHost: new URL(origin).host,
      controlOk,
      controlBytes: control.text.length,
      clickLog,
      treeAfter,
      menuFns,
      menuPostPaths: menuPosts.map((p) => p.path).slice(0, 80),
      abortedMutationPaths: aborted.slice(0, 20),
      probes: probes.filter(
        (p) =>
          (typeof p.openBytes === 'number' && p.openBytes > 400) ||
          (p.openTitles as string[]).length > 0 ||
          p.lstHasGrid ||
          p.searchHasGrid,
      ),
      groupSurfaceCandidates: probes
        .filter(
          (p) =>
            (p.openTitles as string[]).some((t) =>
              /group|block|allot|rooming/i.test(t),
            ) ||
            /group|block/i.test(String(p.openPageTitle ?? '')) ||
            (p.openKeyClasses as { blockLike: string[] }).blockLike.length > 1,
        )
        .map((p) => p.fn),
      eventSurfaceCandidates: probes
        .filter(
          (p) =>
            (p.openTitles as string[]).some((t) => /event|banquet/i.test(t)) ||
            /event/i.test(String(p.openPageTitle ?? '')) ||
            (p.openKeyClasses as { eventLike: string[] }).eventLike.length > 1,
        )
        .map((p) => p.fn),
    };

    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
  } finally {
    page.off('request', onRequest);
    await browser.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
