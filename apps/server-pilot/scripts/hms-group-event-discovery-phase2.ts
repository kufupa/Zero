/**
 * Abort-first Group Booking + Event Reservation discovery (Task 17).
 * Mirrors finance-discovery-phase2 pattern (tsx-safe page.evaluate).
 * Structure-only — never refs, contacts, notes, rooming-list identity.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

function keys(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g)) {
    out.add(m[1]!);
  }
  return [...out].sort();
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
    roomingLike: pick(/rooming|guestname|firstname|lastname|delegate/i),
    actionLike: pick(
      /save|create|amend|assign|release|calculate|post|copy|cancel|print|generate|beo|proforma|quickentry|focus|blur/i,
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
    /Pro[\s-]?Forma/gi,
    /Guest Stay/gi,
    /Sent Email/gi,
    /Deposit Ledger/gi,
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
    '/tmp/hms-group-event-discovery-p2.json';
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString!));
  if (secret.credentialMode !== 'view_only') throw new Error('not view_only');
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
      await route.abort();
      return;
    }
    const path = new URL(req.url()).pathname;
    // Match finance discovery: abort mutation path segments only.
    if (
      req.method() === 'POST' &&
      /(save|delete|settle|refund|void|print\/|export|generate|resend|finalize)/i.test(
        path,
      )
    ) {
      aborted.push({ path, reason: 'mutation_path' });
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

    // Expand Group Sales / Events tree (labels only).
    const clickLabels = [
      'Group Sales',
      'Group Booking',
      'Events',
      'Event Reservations',
      'Event Reservation',
      'Room Blocks',
      'Subgroup Room Blocks',
      'Rooming List',
    ];
    const clickResults: Array<{ label: string; visible: boolean }> = [];
    for (const label of clickLabels) {
      const loc = page.getByText(label, { exact: true }).first();
      const visible = await loc.isVisible().catch(() => false);
      clickResults.push({ label, visible });
      if (visible) {
        await loc.click({ force: true, timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(2_000);
      }
    }

    const tree = await page.evaluate(() => {
      const texts = [
        ...document.querySelectorAll(
          '.x-tree-node-text, .x-grid3-cell-inner, .x-menu-item-text, .x-btn-inner, span, a',
        ),
      ]
        .map((el) => (el.textContent || '').trim())
        .filter((t) => t.length > 1 && t.length < 80);
      const uniq = [...new Set(texts)];
      return {
        totalUniq: uniq.length,
        interesting: uniq
          .filter((t) =>
            /group|block|event|banquet|rooming|allot|sales|booking/i.test(t),
          )
          .slice(0, 80),
        sample: uniq.slice(0, 40),
      };
    });

    // Capture network function names while expanding tree further.
    const seenFns = new Set<string>();
    page.on('request', (req) => {
      const m = /\/web\/base\/([A-Z0-9]{4,12})(?:\.|$|\?)/i.exec(
        new URL(req.url()).pathname,
      );
      if (m) seenFns.add(m[1]!.toUpperCase());
    });

    // Force-expand tree nodes under Group Sales if present.
    await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          '.x-tree-node-el, .x-tree-elbow-plus, .x-tree-ec-icon',
        ),
      ];
      for (const n of nodes.slice(0, 40)) {
        try {
          (n as HTMLElement).click();
        } catch {
          /* ignore */
        }
      }
    });
    await page.waitForTimeout(3_000);

    const deepFns = [
      ...seenFns,
      // Heuristic group/event codes
      'OSGRBK',
      'OSGRES',
      'OSGRP',
      'OSGROU',
      'OSGBLK',
      'OSBLOCK',
      'OSBLOK',
      'OSRBLK',
      'OSRMST',
      'OSRMNG',
      'OSSUBG',
      'OSALLT',
      'OSBOOK',
      'PSGRBK',
      'PSGRES',
      'PSGRP',
      'PSGBLK',
      'OSEVNT',
      'OSEVENT',
      'OSEVRE',
      'OSEVRS',
      'OSEVR',
      'OSEVT',
      'OSBANQ',
      'OSBEO',
      'OSEVLS',
      'PSEVNT',
      'PSEVENT',
      'PSEVRE',
      'GSGRBK',
      'GSEVNT',
      'OSGDET',
      'OSGBLK',
      'OSGBOK',
      'OSEDET',
      'OSEBOK',
      'OSCATR',
      'OSMEET',
      'OSFUNC',
      // Controls
      'OSRESS',
      'OSLEDG',
      'PSSNEL',
    ];

    const deep: Array<Record<string, unknown>> = [];
    for (const fn of [...new Set(deepFns)].slice(0, 60)) {
      const open = await page.evaluate(async (functionName) => {
        try {
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
          return { status: r.status, text: await r.text() };
        } catch {
          return {
            status: null,
            text: '',
            err: e instanceof Error ? e.message : 'err',
          };
        }
      }, fn);

      const lst = await page.evaluate(async (functionName) => {
        try {
          const r = await fetch(`/web/base/${functionName}.LST`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: functionName,
              USER_FUNCTION_NAME: functionName,
              CURRENT_TAB_NAME: 'LST',
              COMPONENT_INFO_TYPE: 'DATA_ONLY',
              GRID_NAME: functionName,
            }).toString(),
            credentials: 'same-origin',
          });
          return { status: r.status, text: await r.text() };
        } catch {
          return { status: null, text: '' };
        }
      }, fn);

      const search = await page.evaluate(async (functionName) => {
        try {
          const r = await fetch(`/web/base/${functionName}.search`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: functionName,
              USER_FUNCTION_NAME: functionName,
              COMPONENT_INFO_TYPE: 'DATA_ONLY',
              GRID_NAME: functionName,
            }).toString(),
            credentials: 'same-origin',
          });
          return { status: r.status, text: await r.text() };
        } catch {
          return { status: null, text: '' };
        }
      }, fn);

      const openKeys = keys(open.text);
      const lstKeys = keys(lst.text);
      const searchKeys = keys(search.text);
      deep.push({
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
        lstStatus: lst.status,
        lstBytes: lst.text.length,
        lstKeyClasses: classifyKeys(lstKeys),
        lstHasGrid: /GRIDRESULT|"DATA"\s*:/.test(lst.text),
        searchStatus: search.status,
        searchBytes: search.text.length,
        searchKeyClasses: classifyKeys(searchKeys),
        searchHasGrid: /GRIDRESULT|"DATA"\s*:/.test(search.text),
      });
    }

    const report = {
      observedAt: new Date().toISOString(),
      originHost: new URL(origin).host,
      clickResults,
      tree,
      networkFnsSeen: [...seenFns].sort(),
      abortedCount: aborted.length,
      abortedSample: aborted.slice(0, 20),
      deep: deep.filter(
        (p) =>
          p.fn === 'OSRESS' ||
          p.fn === 'OSLEDG' ||
          p.fn === 'PSSNEL' ||
          (typeof p.openBytes === 'number' && p.openBytes > 400) ||
          (p.openTitles as string[]).length > 0 ||
          p.lstHasGrid ||
          p.searchHasGrid,
      ),
      groupSurfaceCandidates: deep
        .filter(
          (p) =>
            (p.openTitles as string[]).some((t) =>
              /group|block|allot|rooming/i.test(t),
            ) ||
            (p.openKeyClasses as { blockLike: string[] }).blockLike.length >
              2 ||
            (p.lstKeyClasses as { blockLike: string[] }).blockLike.length > 2,
        )
        .map((p) => p.fn),
      eventSurfaceCandidates: deep
        .filter(
          (p) =>
            (p.openTitles as string[]).some((t) => /event|banquet/i.test(t)) ||
            (p.openKeyClasses as { eventLike: string[] }).eventLike.length >
              2 ||
            (p.lstKeyClasses as { eventLike: string[] }).eventLike.length > 2,
        )
        .map((p) => p.fn),
    };

    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          outPath,
          clickResults,
          treeInteresting: tree.interesting,
          networkFnsSeen: report.networkFnsSeen,
          deepHitCount: report.deep.length,
          groupSurfaceCandidates: report.groupSurfaceCandidates,
          eventSurfaceCandidates: report.eventSurfaceCandidates,
          deepSummary: report.deep.map((p) => ({
            fn: p.fn,
            openStatus: p.openStatus,
            openBytes: p.openBytes,
            openTitles: p.openTitles,
            openKeyClasses: p.openKeyClasses,
            lstHasGrid: p.lstHasGrid,
            lstKeyClasses: p.lstKeyClasses,
            searchHasGrid: p.searchHasGrid,
            searchKeyClasses: p.searchKeyClasses,
            openHasActionPaths: p.openHasActionPaths,
          })),
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
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
