/**
 * Phase-4: click Group Booking / Group Availability; capture POST paths + open shape.
 * Structure only.
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
  const pick = (re: RegExp) => all.filter((k) => re.test(k)).slice(0, 50);
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
    contactLike: pick(/contact|email|phone|delegate|salesperson|coordinator/i),
    noteLike: pick(/note|comment|remark|instruction/i),
    roomingLike: pick(/rooming|guestname|firstname|lastname/i),
    actionLike: pick(
      /save|create|amend|assign|release|calculate|post|copy|cancel|print|generate|beo|proforma|quickentry|focus|blur/i,
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
    '/tmp/hms-group-event-discovery-p4.json';
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString!));
  if (secret.credentialMode !== 'view_only') throw new Error('not view_only');
  const origin = new URL(secret.loginUrl).origin;

  const posts: Array<{
    path: string;
    method: string;
    bodyKeys: string[];
    fnHints: string[];
  }> = [];

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
      await route.abort();
      return;
    }
    await route.continue();
  });

  const page = await ctx.newPage();
  const onReq = (req: Request) => {
    const url = req.url();
    if (!url.startsWith(origin)) return;
    const path = new URL(url).pathname;
    if (!path.startsWith('/web/base/')) return;
    const body = req.postData() ?? '';
    const bodyKeys = [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]{0,40})=/g)].map(
      (m) => m[1]!,
    );
    const fnHints = [
      ...new Set(
        [
          ...path.matchAll(/\/web\/base\/([A-Z0-9]{4,12})/gi),
          ...body.matchAll(
            /(?:USER_FUNCTION_NAME|SYSTEM_FUNCTION_NAME)=([A-Z0-9]{4,12})/gi,
          ),
        ].map((m) => m[1]!.toUpperCase()),
      ),
    ];
    posts.push({
      path,
      method: req.method(),
      bodyKeys: [...new Set(bodyKeys)].slice(0, 40),
      fnHints,
    });
  };
  page.on('request', onReq);

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

    // Expand Group Sales via DOM click (viewport-safe; no nested fns — tsx __name).
    const expandResult = await page.evaluate(`(() => {
      var nodes = Array.from(document.querySelectorAll('.x-tree-node-text, span, a'));
      var ok = false;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if ((n.textContent || '').trim() !== 'Group Sales') continue;
        var row = n.closest('.x-tree-node-el, .x-tree-node, li, div') || n;
        var plus = row.querySelector('.x-tree-ec-icon, .x-tree-elbow-plus, .x-tree-elbow-end-plus');
        if (plus) { try { plus.click(); } catch {} }
        try { n.click(); ok = true; } catch { ok = false; }
        break;
      }
      return { groupSales: ok };
    })()`);
    await page.waitForTimeout(3_000);

    const mark = posts.length;
    const navClicks = await page.evaluate(`(() => {
      var labels = ['Group Booking', 'Group Availability', 'Events', 'Event Reservations', 'Event Reservation'];
      var out = [];
      for (var li = 0; li < labels.length; li++) {
        var label = labels[li];
        var nodes = Array.from(document.querySelectorAll('.x-tree-node-text, span, a'));
        var found = false;
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if ((n.textContent || '').trim() !== label) continue;
          found = true;
          try { n.click(); out.push({ label: label, ok: true }); }
          catch { out.push({ label: label, ok: false }); }
          break;
        }
        if (!found) out.push({ label: label, ok: false });
      }
      return out;
    })()`);
    await page.waitForTimeout(5_000);

    // Count tree nodes for report.
    const gbCount = await page
      .locator('.x-tree-node-text', { hasText: /^Group Booking$/ })
      .count();
    const gaCount = await page
      .locator('.x-tree-node-text', { hasText: /^Group Availability$/ })
      .count();

    const afterNavPosts = posts.slice(mark);
    const fnsFromNav = [
      ...new Set(afterNavPosts.flatMap((p) => p.fnHints)),
    ].filter((f) => !['COMMON', 'BSSTRT', 'OSRESS'].includes(f));

    // Probe every fn seen during nav + page title scan.
    const pageText = await page.evaluate(
      () => document.body?.innerText?.slice(0, 6000) ?? '',
    );
    const pageFnEchoes = [
      ...new Set(
        [...pageText.matchAll(/\b((?:PS|OS|GS|AR)[A-Z0-9]{3,8})\b/g)].map(
          (m) => m[1]!,
        ),
      ),
    ];

    const probeFns = [...new Set([...fnsFromNav, ...pageFnEchoes])].slice(
      0,
      25,
    );
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
      probes.push({
        fn,
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
        openHasGrid: /GRIDRESULT/i.test(open.text),
        openHasActionPaths:
          /(save|calculate|post|copy|cancel|print|generate|beo|quick\s*entry)/i.test(
            open.text,
          ),
        lstStatus: lst.status,
        lstBytes: lst.text.length,
        lstHasGrid: /GRIDRESULT/i.test(lst.text),
        lstKeyClasses: classifyKeys(collectKeys(lst.text)),
        searchStatus: search.status,
        searchBytes: search.text.length,
        searchHasGrid: /GRIDRESULT/i.test(search.text),
        searchKeyClasses: classifyKeys(collectKeys(search.text)),
      });
    }

    // Direct heuristic opens if nav found nothing.
    if (probeFns.length === 0) {
      for (const fn of [
        'OSGRBK',
        'OSGRES',
        'GSGRBK',
        'PSGRBK',
        'OSGBLK',
        'OSBOOK',
      ]) {
        const open = await post(`/web/base/${fn}`, {
          USER_FUNCTION_NAME: fn,
          SYSTEM_FUNCTION_NAME: fn,
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        });
        probes.push({
          fn,
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
          openKeyClasses: classifyKeys(collectKeys(open.text)),
          openHasGrid: /GRIDRESULT/i.test(open.text),
          openHasActionPaths:
            /(save|calculate|post|copy|cancel|print|generate|beo)/i.test(
              open.text,
            ),
          headMasked: open.text.slice(0, 200).replace(/\d/g, '#'),
        });
      }
    }

    const treeLabels = await page.evaluate(`(() => {
      var nodes = Array.from(document.querySelectorAll('.x-tree-node-text'));
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        var t = (nodes[i].textContent || '').trim();
        if (t.length > 1 && t.length < 80 && out.indexOf(t) === -1) out.push(t);
      }
      return out.slice(0, 60);
    })()`);

    const report = {
      observedAt: new Date().toISOString(),
      originHost: new URL(origin).host,
      controlBytes: control.text.length,
      expandResult,
      navClicks,
      gbCount,
      gaCount,
      treeLabels,
      eventsInTree: treeLabels.some((t) => /event/i.test(t)),
      afterNavPosts: afterNavPosts.slice(0, 60),
      fnsFromNav,
      pageFnEchoes,
      probes,
      groupSurfaceCandidates: probes
        .filter(
          (p) =>
            /group|block|allot|booking/i.test(
              `${p.openPageTitle ?? ''} ${p.openModulePath ?? ''} ${p.openScreen ?? ''}`,
            ) ||
            (p.openKeyClasses as { blockLike: string[] })?.blockLike?.length >
              1,
        )
        .map((p) => p.fn),
      eventSurfaceCandidates: probes
        .filter((p) =>
          /event|banquet/i.test(
            `${p.openPageTitle ?? ''} ${p.openModulePath ?? ''} ${p.openScreen ?? ''}`,
          ),
        )
        .map((p) => p.fn),
    };

    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
  } finally {
    page.off('request', onReq);
    await browser.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
