/**
 * Abort-first Group Booking + Event Reservation discovery (Task 17).
 * Structure-only: labels, function codes, field key names, action path hits.
 * Never dumps group/event refs, contact names, notes, rooming-list identity.
 * Requires HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

function collectKeys(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g)) {
    out.add(m[1]!);
  }
  return [...out].sort();
}

function titleHints(text: string): string[] {
  const hits = new Set<string>();
  for (const re of [
    /Group Booking/gi,
    /Subgroup Room Blocks?/gi,
    /Room Blocks?/gi,
    /Rooming List/gi,
    /Event Reservation/gi,
    /Event List/gi,
    /Banquet Event/gi,
    /\bBEO\b/gi,
    /Pro[\s-]?Forma/gi,
    /Group Sales/gi,
  ]) {
    for (const m of text.matchAll(re)) hits.add(m[0]!.replace(/\s+/g, ' '));
  }
  return [...hits].slice(0, 30);
}

function classifyKeys(all: string[]) {
  const pick = (re: RegExp) => all.filter((k) => re.test(k)).slice(0, 50);
  return {
    refLike: pick(
      /confirmation|group(?:ref|code|id|number)|event(?:ref|code|id|number)|reference/i,
    ),
    statusLike: pick(/status|state|flag/i),
    dateLike: pick(/date|start|end|arrival|departure|begin|finish/i),
    blockLike: pick(
      /\bcon\b|contract|blk|block|pickup|remaining|allot|release|restriction|cta|ctd|mins?tay|maxstay|stopsell/i,
    ),
    roomTypeLike: pick(/roomtype|rmtype|roomclass|category/i),
    eventLike: pick(
      /eventtype|layout|attendee|person|guestcount|setup|teardown|deposit|currency|total|amount/i,
    ),
    contactLike: pick(/contact|email|phone|delegate|salesperson|coordinator/i),
    noteLike: pick(/note|comment|remark|instruction/i),
    roomingLike: pick(/rooming|guestname|firstname|lastname|delegate/i),
    actionLike: pick(
      /save|create|amend|assign|release|calculate|post|copy|cancel|print|email|generate|beo|proforma|quickentry|focus|input|change|blur/i,
    ),
  };
}

function gridColumnHints(text: string): string[] {
  const cols = new Set<string>();
  for (const m of text.matchAll(
    /"(?:name|dataIndex|alias|ALIAS_NAME|columnId)"\s*:\s*"([A-Za-z][A-Za-z0-9_]{1,48})"/g,
  )) {
    cols.add(m[1]!);
  }
  for (const m of text.matchAll(
    /"DATA"\s*:\s*\[\s*\{([^}]{0,4000})\}/g,
  )) {
    for (const k of m[1]!.matchAll(/"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g)) {
      cols.add(k[1]!);
    }
  }
  return [...cols].sort().slice(0, 80);
}

function fnEchoes(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/\b((?:PS|OS|AR|BS|GS)[A-Z0-9]{3,10})\b/g)].map(
        (m) => m[1]!,
      ),
    ),
  ].slice(0, 40);
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_GROUP_EVENT_DISCOVERY_OUT ??
    '/tmp/hms-group-event-discovery.json';

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
      aborted.push({
        path: new URL(req.url()).pathname,
        reason: 'cross_origin',
      });
      await route.abort();
      return;
    }
    const path = new URL(req.url()).pathname;
    if (
      req.method() === 'POST' &&
      /(save|delete|settle|refund|post|transfer|void|print\/|export|generate|resend|finalize|email|calculate|copy|cancel|assign|release|create|amend|beo|proforma|pro-forma)/i.test(
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

    // Menu soft-capture: label ↔ function pairs mentioning group/event.
    const menu = await page.evaluate(async () => {
      const pairs: Array<{ label: string; fn: string }> = [];
      const labelHits: string[] = [];
      const blobs: string[] = [];
      for (const s of document.scripts) {
        if (s.textContent) blobs.push(s.textContent.slice(0, 500_000));
      }
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
      for (const text of blobs) {
        for (const m of text.matchAll(/"itemLabel"\s*:\s*"([^"]+)"/g)) {
          const label = m[1]!;
          if (
            /group|block|event|banquet|rooming|allot/i.test(label) &&
            !labelHits.includes(label)
          ) {
            labelHits.push(label);
          }
        }
        // Pair nearby function codes with labels when co-located.
        const chunks = text.split(/\{/).slice(0, 20_000);
        for (const chunk of chunks) {
          const label = /"itemLabel"\s*:\s*"([^"]+)"/.exec(chunk)?.[1];
          const fn =
            /"(?:userFunction|systemFunction|functionName)"\s*:\s*"([A-Z0-9]{4,12})"/.exec(
              chunk,
            )?.[1];
          if (
            label &&
            fn &&
            /group|block|event|banquet|rooming|allot/i.test(label)
          ) {
            pairs.push({ label, fn });
          }
        }
      }
      return {
        labelHits: labelHits.slice(0, 60),
        pairs: pairs.slice(0, 80),
      };
    });

    const candidateFns = [
      ...new Set([
        ...menu.pairs.map((p) => p.fn),
        // Heuristic Infor HMS group/event codes
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
        'PSGRBK',
        'PSGRES',
        'PSGRP',
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
        'OSRESS', // control known-good
      ]),
    ];

    const probes: Array<Record<string, unknown>> = [];
    for (const fn of candidateFns) {
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

      const variants: Array<{
        suffix: string;
        status: number | null;
        bytes: number;
        keys: string[];
        gridCols: string[];
        titles: string[];
        hasGrid: boolean;
      }> = [];

      for (const suffix of ['.HDR', '.LST', '.search', '.BLK', '.BLOCK']) {
        const v = await page.evaluate(
          async ({ functionName, suffix: s }) => {
            try {
              const r = await fetch(`/web/base/${functionName}${s}`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                  SYSTEM_FUNCTION_NAME: functionName,
                  USER_FUNCTION_NAME: functionName,
                  CURRENT_TAB_NAME: s.replace('.', '') || 'HDR',
                  COMPONENT_INFO_TYPE: 'DATA_ONLY',
                  GRID_NAME: functionName,
                }).toString(),
                credentials: 'same-origin',
              });
              return { status: r.status, text: await r.text() };
            } catch {
              return { status: null, text: '' };
            }
          },
          { functionName: fn, suffix },
        );
        const keys = collectKeys(v.text);
        variants.push({
          suffix,
          status: v.status,
          bytes: v.text.length,
          keys: keys.slice(0, 60),
          gridCols: gridColumnHints(v.text),
          titles: titleHints(v.text),
          hasGrid: /GRIDRESULT|"DATA"\s*:/.test(v.text),
        });
      }

      const openKeys = collectKeys(open.text);
      probes.push({
        fn,
        openStatus: open.status,
        openBytes: open.text.length,
        openTitles: titleHints(open.text),
        openFnEchoes: fnEchoes(open.text),
        openKeyClasses: classifyKeys(openKeys),
        openGridCols: gridColumnHints(open.text),
        openHasGrid: /GRIDRESULT|"DATA"\s*:/.test(open.text),
        openHasActionPaths: /(save|calculate|post|copy|cancel|print|generate)/i.test(
          open.text,
        ),
        variants: variants.filter(
          (x) =>
            (x.status != null && x.status < 400 && x.bytes > 200) ||
            x.hasGrid ||
            x.titles.length > 0,
        ),
      });
    }

    // Soft-capture: click menu items that match Group/Event if present (no detail dblclick).
    const softClicks = await page.evaluate(async () => {
      const out: Array<{ label: string; clicked: boolean; note: string }> = [];
      const wanted =
        /Group Booking|Event Reservation|Subgroup Room Block|Room Block/i;
      const nodes = Array.from(
        document.querySelectorAll('span, a, div, li, td'),
      ).filter((el) => wanted.test(el.textContent ?? ''));
      for (const el of nodes.slice(0, 8)) {
        const label = (el.textContent ?? '').trim().slice(0, 80);
        try {
          (el as HTMLElement).click();
          out.push({ label, clicked: true, note: 'menu_click' });
        } catch {
          out.push({ label, clicked: false, note: 'click_failed' });
        }
      }
      return out;
    });
    await page.waitForTimeout(2_000);

    const afterClickKeys = collectKeys(await page.content());

    const report = {
      observedAt: new Date().toISOString(),
      originHost: new URL(origin).host,
      abortedCount: aborted.length,
      abortedSample: aborted.slice(0, 20),
      menu,
      softClicks: softClicks.map((c) => ({
        labelClass: /event/i.test(c.label)
          ? 'event_like'
          : /group|block/i.test(c.label)
            ? 'group_like'
            : 'other',
        clicked: c.clicked,
        note: c.note,
      })),
      afterClickKeyClasses: classifyKeys(afterClickKeys),
      probes: probes
        .filter(
          (p) =>
            p.fn === 'OSRESS' ||
            (typeof p.openBytes === 'number' && p.openBytes > 500) ||
            (Array.isArray(p.variants) && p.variants.length > 0) ||
            (Array.isArray(p.openTitles) && p.openTitles.length > 0),
        )
        .map((p) => ({
          ...p,
          // Drop empty openKeyClasses noise for failed opens
          interesting:
            (p.openTitles as string[]).length > 0 ||
            Object.values(p.openKeyClasses as Record<string, string[]>).some(
              (arr) => arr.length > 0,
            ) ||
            (p.variants as unknown[]).length > 0,
        })),
      verdictHints: {
        groupSurfaceCandidates: probes
          .filter(
            (p) =>
              (p.openTitles as string[]).some((t) =>
                /group|block|allot/i.test(t),
              ) ||
              (p.openKeyClasses as { blockLike: string[] }).blockLike.length >
                0,
          )
          .map((p) => p.fn),
        eventSurfaceCandidates: probes
          .filter(
            (p) =>
              (p.openTitles as string[]).some((t) => /event|banquet/i.test(t)) ||
              (p.openKeyClasses as { eventLike: string[] }).eventLike.length > 0,
          )
          .map((p) => p.fn),
      },
    };

    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          outPath,
          menuLabelCount: menu.labelHits.length,
          menuPairCount: menu.pairs.length,
          probeHits: report.probes.length,
          groupSurfaceCandidates: report.verdictHints.groupSurfaceCandidates,
          eventSurfaceCandidates: report.verdictHints.eventSurfaceCandidates,
          abortedMutationPaths: aborted.filter((a) => a.reason === 'mutation_path')
            .length,
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
