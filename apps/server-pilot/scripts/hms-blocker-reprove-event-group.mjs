/**
 * Docs-guided Event + Group blocker re-prove (2026-08-07).
 * Event: deep Group Sales expand → Events/Event Reservations hunt (labels only).
 * Group: GSGRPB.LST + grid/view config only — NO BLK/detail/rooming/save.
 * Abort-first mutations. Keys/labels only. view_only.
 *
 * Run: HMS_DISCOVERY_ALLOW_LIVE=1 node scripts/hms-blocker-reprove-event-group.mjs
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

function collectKeys(text) {
  const out = [];
  const re = /"([A-Za-z][A-Za-z0-9_]{1,48})"\s*:/g;
  let m;
  while ((m = re.exec(text))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out.sort();
}

function firstDataKeys(text) {
  const idx = text.search(/"DATA"\s*:\s*\[/i);
  if (idx < 0) return [];
  const slice = text.slice(idx, idx + 50_000);
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

function columnHints(text) {
  const cols = new Set();
  for (const re of [
    /"column(?:Id|Name|Field|dataIndex|header)"\s*:\s*"([^"]{1,64})"/gi,
    /"dataIndex"\s*:\s*"([^"]{1,64})"/gi,
    /"header"\s*:\s*"([^"]{1,64})"/gi,
    /"fieldName"\s*:\s*"([^"]{1,64})"/gi,
  ]) {
    let m;
    while ((m = re.exec(text))) cols.add(m[1]);
  }
  return [...cols].sort().slice(0, 120);
}

function pickBlockish(keys) {
  return keys.filter((k) =>
    /^(con|blk)$|contract|blocked|pickup|remaining|allot|restrict|closedto|minstay|maxstay|stopsell|cta|ctd/i.test(
      k,
    ),
  );
}

function pickEventish(keys) {
  return keys.filter((k) =>
    /event|status|start|end|layout|attendee|person|guestcount|setup|teardown|deposit|currency|total|type|reference|confirmation/i.test(
      k,
    ),
  );
}

function pickDenied(keys) {
  return keys.filter((k) =>
    /contact|firstname|lastname|email|phone|delegate|note|remark|rooming|guestname|private/i.test(
      k,
    ),
  );
}

function pickActions(text) {
  const hits = [];
  for (const a of [
    'save',
    'create',
    'change',
    'copy',
    'cancel',
    'print',
    'contacts',
    'notes',
    'generate',
    'beo',
    'proforma',
  ]) {
    if (new RegExp(`\\b${a}\\b`, 'i').test(text)) hits.push(a);
  }
  return hits;
}

async function loadSecret() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!res.SecretString) throw new Error('secret empty');
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  if (secret.credentialMode !== 'view_only') {
    throw new Error('refuse: credentialMode must be view_only');
  }
  return secret;
}

async function withSession(secret, fn) {
  const origin = new URL(secret.loginUrl).origin;
  const aborted = [];
  const posts = [];
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
      /(save|delete|settle|refund|void|print\/|export|generate|resend|finalize|email|calculate|copy|cancel|create|amend|assign|release)/i.test(
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
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    const path = new URL(req.url()).pathname;
    if (!path.startsWith('/web/base/')) return;
    const fnHint =
      /\/web\/base\/([A-Z0-9]{4,12})/i.exec(path)?.[1]?.toUpperCase() ?? null;
    posts.push({ path, fn: fnHint });
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
    await page.waitForTimeout(6_000);

    async function post(path, fields) {
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
    const controlOk =
      control.status === 200 &&
      control.text.length > 2000 &&
      /pageData/i.test(control.text);
    if (!controlOk) {
      throw new Error(
        `session_not_ready status=${control.status} bytes=${control.text.length}`,
      );
    }

    return await fn({
      page,
      post,
      origin,
      aborted,
      posts,
      controlBytes: control.text.length,
    });
  } finally {
    await browser.close();
  }
}

async function eventTrack(secret) {
  return withSession(secret, async ({ page, post, aborted, posts, controlBytes }) => {
    const before = posts.length;

    // Expand Group Sales + recursively click plus icons under that branch.
    const expandLog = await page.evaluate(`(() => {
      var log = [];
      function clickPlusNear(textExact) {
        var nodes = Array.from(document.querySelectorAll('.x-tree-node-text, span, a'));
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if ((n.textContent || '').trim() !== textExact) continue;
          var row = n.closest('.x-tree-node-el, .x-tree-node, li, div') || n;
          var plus = row.querySelector(
            '.x-tree-ec-icon, .x-tree-elbow-plus, .x-tree-elbow-end-plus, .x-tree-elbow-plus-nl'
          );
          if (plus) {
            try { plus.click(); log.push({ action: 'plus', label: textExact, ok: true }); }
            catch (e) { log.push({ action: 'plus', label: textExact, ok: false }); }
          }
          try { n.click(); log.push({ action: 'click', label: textExact, ok: true }); }
          catch (e) { log.push({ action: 'click', label: textExact, ok: false }); }
          return true;
        }
        log.push({ action: 'miss', label: textExact, ok: false });
        return false;
      }
      clickPlusNear('Group Sales');
      // Second pass: any collapsed plus under tree
      var pluses = Array.from(document.querySelectorAll(
        '.x-tree-elbow-plus, .x-tree-elbow-end-plus, .x-tree-ec-icon.x-tree-elbow-plus'
      ));
      for (var p = 0; p < pluses.length && p < 30; p++) {
        try { pluses[p].click(); log.push({ action: 'plusSweep', i: p, ok: true }); }
        catch (e) { log.push({ action: 'plusSweep', i: p, ok: false }); }
      }
      return log;
    })()`);
    await page.waitForTimeout(3_500);

    // Second expand pass after children paint.
    await page.evaluate(`(() => {
      var labels = ['Group Sales', 'Events', 'Event Reservations', 'Event Reservation'];
      for (var li = 0; li < labels.length; li++) {
        var label = labels[li];
        var nodes = Array.from(document.querySelectorAll('.x-tree-node-text, span, a'));
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if ((n.textContent || '').trim() !== label) continue;
          var row = n.closest('.x-tree-node-el, .x-tree-node, li, div') || n;
          var plus = row.querySelector(
            '.x-tree-ec-icon, .x-tree-elbow-plus, .x-tree-elbow-end-plus'
          );
          if (plus) { try { plus.click(); } catch (e) {} }
          try { n.click(); } catch (e) {}
        }
      }
      var pluses = Array.from(document.querySelectorAll(
        '.x-tree-elbow-plus, .x-tree-elbow-end-plus'
      ));
      for (var p = 0; p < pluses.length && p < 40; p++) {
        try { pluses[p].click(); } catch (e) {}
      }
    })()`);
    await page.waitForTimeout(3_500);

    const treeDump = await page.evaluate(`(() => {
      var texts = Array.from(
        document.querySelectorAll('.x-tree-node-text, .x-menu-item-text')
      )
        .map(function (el) { return (el.textContent || '').trim(); })
        .filter(function (t) { return t.length > 1 && t.length < 80; });
      var uniq = [];
      var seen = {};
      for (var i = 0; i < texts.length; i++) {
        if (seen[texts[i]]) continue;
        seen[texts[i]] = true;
        uniq.push(texts[i]);
      }
      var underGroupSales = [];
      var gsIdx = -1;
      for (var j = 0; j < uniq.length; j++) {
        if (uniq[j] === 'Group Sales') { gsIdx = j; break; }
      }
      // Approximate: labels after Group Sales until next top module-ish
      if (gsIdx >= 0) {
        for (var k = gsIdx + 1; k < uniq.length && k < gsIdx + 40; k++) {
          if (/^(Front Desk|Reservations|Accounts|Rate and Sales|Housekeeping|Configuration|Reports)$/i.test(uniq[k])) break;
          underGroupSales.push(uniq[k]);
        }
      }
      return {
        allTreeLabels: uniq.slice(0, 120),
        underGroupSales: underGroupSales,
        hasEvents: uniq.some(function (t) { return /^Events$/i.test(t); }),
        hasEventReservations: uniq.some(function (t) {
          return /^Event Reservations?$/i.test(t);
        }),
        groupSalesChildrenExact: underGroupSales.filter(function (t) {
          return /group|event|block|banquet|rooming|allot|availability|booking/i.test(t);
        }),
      };
    })()`);

    const childClicks = [];
    for (const label of [
      'Events',
      'Event Reservations',
      'Event Reservation',
      'Group Booking',
      'Group Availability',
    ]) {
      const loc = page.locator('.x-tree-node-text', { hasText: new RegExp(`^${label}$`) }).first();
      const visible = (await loc.count().catch(() => 0)) > 0;
      let clicked = false;
      if (visible) {
        await loc.click({ force: true, timeout: 8_000 }).catch(() => undefined);
        clicked = true;
        await page.waitForTimeout(2_500);
      }
      childClicks.push({ label, visible, clicked });
    }

    const menuPosts = posts.slice(before);
    const menuFns = [
      ...new Set(
        menuPosts
          .map((p) => p.fn)
          .filter((f) => f && !['COMMON', 'BSSTRT', 'OSRESS'].includes(f)),
      ),
    ].sort();

    const eventsPresent =
      treeDump.hasEvents ||
      treeDump.hasEventReservations ||
      childClicks.some(
        (c) =>
          c.visible &&
          /Event/i.test(c.label),
      );

    let eventListProbe = null;
    if (eventsPresent) {
      // Prefer fns captured from menu; also try common event codes once open.
      const probeFns = [
        ...new Set([
          ...menuFns,
          'GSEVNT',
          'OSEVNT',
          'OSEVRE',
          'PSEVNT',
          'GSEVRE',
        ]),
      ].slice(0, 12);
      const probes = [];
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
        const openKeys = collectKeys(open.text);
        const lstKeys = firstDataKeys(lst.text);
        const allKeys = [...new Set([...openKeys, ...lstKeys])];
        probes.push({
          fn,
          openStatus: open.status,
          openBytes: open.text.length,
          lstStatus: lst.status,
          lstBytes: lst.text.length,
          lstHasGrid: /GRIDRESULT/i.test(lst.text),
          pageTitle:
            /"pageTitle"\s*:\s*"([^"]{1,80})"/.exec(open.text)?.[1]?.replace(
              /\d/g,
              '#',
            ) ?? null,
          eventishKeys: pickEventish(allKeys).slice(0, 40),
          deniedKeys: pickDenied(allKeys).slice(0, 20),
          actionHints: pickActions(open.text + lst.text),
          columns: columnHints(open.text + lst.text).slice(0, 60),
        });
      }
      eventListProbe = { probes };
    }

    // Narrow EventRead: status/type/start/end/attendee/layout/deposit/currency/total
    // without contacts/notes. List-only prove only if Events surface opened.
    let eventVerdict;
    if (!eventsPresent) {
      eventVerdict = {
        code: 'BLOCKED_EVENT_READ_SURFACE_UNPROVEN',
        kind: 'external_entitlement',
        reason:
          'docs: Group Sales > Events > Event Reservations; live view_only menu lacks Events child after full expand',
      };
    } else {
      const okList = (eventListProbe?.probes || []).find(
        (p) =>
          p.lstHasGrid &&
          p.deniedKeys.length === 0 &&
          !p.actionHints.some((a) =>
            /save|create|change|copy|cancel|print|contacts|notes/i.test(a),
          ),
      );
      // Even with list, narrow contract needs many fields — flag if missing.
      const needed =
        /status|eventtype|start|end|attendee|layout|deposit|currency|total/i;
      const hasEnough =
        okList &&
        (okList.eventishKeys.filter((k) => needed.test(k)).length >= 4);
      if (hasEnough) {
        eventVerdict = {
          code: 'PROVEN_LIST_ONLY_CANDIDATE',
          kind: 'list_ok',
          fn: okList.fn,
        };
      } else {
        eventVerdict = {
          code: 'BLOCKED_EVENT_READ_SURFACE_UNPROVEN',
          kind: 'surface_open_but_list_insufficient_or_unsafe',
          reason:
            'Events menu present but list shape lacks narrow EventRead fields and/or exposes denied/action paths',
        };
      }
    }

    return {
      track: 'event',
      observedAt: new Date().toISOString(),
      controlBytes,
      expandLog,
      treeDump,
      childClicks,
      menuFns,
      menuPostPaths: menuPosts.map((p) => p.path).slice(0, 40),
      abortedMutationPaths: aborted.slice(0, 20),
      eventListProbe,
      verdict: eventVerdict,
    };
  });
}

async function groupTrack(secret) {
  return withSession(secret, async ({ post, aborted, controlBytes }) => {
    const fn = 'GSGRPB';
    const open = await post(`/web/base/${fn}`, {
      USER_FUNCTION_NAME: fn,
      SYSTEM_FUNCTION_NAME: fn,
      FUNCTION_CLASS: 'WEBL',
      CURRENT_TAB_NAME: '',
      MENU_MODULE_KEY: '0',
      removescreenflows: 'yes',
    });

    // List / search / grid-config / alternate views ONLY — never BLK/BLOCK/detail.
    const variants = [
      { suffix: '.LST', fields: { CURRENT_TAB_NAME: 'LST', COMPONENT_INFO_TYPE: 'DATA_ONLY', GRID_NAME: fn } },
      { suffix: '.search', fields: { COMPONENT_INFO_TYPE: 'DATA_ONLY', GRID_NAME: fn } },
      { suffix: '.HDR', fields: { CURRENT_TAB_NAME: 'HDR', COMPONENT_INFO_TYPE: 'DATA_ONLY' } },
      { suffix: '.CFG', fields: { COMPONENT_INFO_TYPE: 'DATA_ONLY', GRID_NAME: fn } },
      { suffix: '.GRID', fields: { COMPONENT_INFO_TYPE: 'DATA_ONLY', GRID_NAME: fn } },
      { suffix: '.gridconfig', fields: { COMPONENT_INFO_TYPE: 'DATA_ONLY', GRID_NAME: fn } },
      { suffix: '.VIEW', fields: { COMPONENT_INFO_TYPE: 'DATA_ONLY', GRID_NAME: fn } },
      { suffix: '.VWS', fields: { COMPONENT_INFO_TYPE: 'DATA_ONLY', GRID_NAME: fn } },
      { suffix: '.LSTCFG', fields: { CURRENT_TAB_NAME: 'LST', COMPONENT_INFO_TYPE: 'DATA_ONLY', GRID_NAME: fn } },
    ];

    const probes = [];
    for (const v of variants) {
      const res = await post(`/web/base/${fn}${v.suffix}`, {
        SYSTEM_FUNCTION_NAME: fn,
        USER_FUNCTION_NAME: fn,
        ...v.fields,
      });
      const dataKeys = firstDataKeys(res.text);
      const allKeys = collectKeys(res.text);
      probes.push({
        path: `${fn}${v.suffix}`,
        status: res.status,
        bytes: res.text.length,
        hasGrid: /GRIDRESULT/i.test(res.text),
        hasPageData: /pageData/i.test(res.text),
        dataKeys: dataKeys.slice(0, 80),
        blockish: pickBlockish([...new Set([...dataKeys, ...allKeys])]).slice(0, 40),
        denied: pickDenied([...new Set([...dataKeys, ...allKeys])]).slice(0, 20),
        columns: columnHints(res.text).slice(0, 80),
        // Scrub digits from title-like strings
        pageTitle:
          /"pageTitle"\s*:\s*"([^"]{1,80})"/.exec(res.text)?.[1]?.replace(
            /\d/g,
            '#',
          ) ?? null,
      });
    }

    // Also try alternate GRID_NAME values that might expose pickup columns without detail.
    const altGrids = ['GSGRPB', 'GSGRPB_LST', 'GROUPBOOKING', 'GROUPBLOCK', 'BLKLIST'];
    const altGridProbes = [];
    for (const grid of altGrids) {
      const res = await post(`/web/base/${fn}.LST`, {
        SYSTEM_FUNCTION_NAME: fn,
        USER_FUNCTION_NAME: fn,
        CURRENT_TAB_NAME: 'LST',
        COMPONENT_INFO_TYPE: 'DATA_ONLY',
        GRID_NAME: grid,
      });
      const dataKeys = firstDataKeys(res.text);
      altGridProbes.push({
        grid,
        status: res.status,
        bytes: res.text.length,
        hasGrid: /GRIDRESULT/i.test(res.text),
        dataKeys: dataKeys.slice(0, 60),
        blockish: pickBlockish(dataKeys).slice(0, 30),
        columns: columnHints(res.text).slice(0, 60),
      });
    }

    const allBlockish = [
      ...new Set(probes.flatMap((p) => p.blockish).concat(altGridProbes.flatMap((p) => p.blockish))),
    ];
    const lst = probes.find((p) => p.path === 'GSGRPB.LST');
    const hasCon = allBlockish.some((k) => /^(con|contracted|contractrooms)/i.test(k));
    const hasBlk = allBlockish.some((k) => /^(blk|blocked|blockrooms)/i.test(k));
    const hasPickup = allBlockish.some((k) => /pickup/i.test(k));
    const hasRemaining = allBlockish.some((k) => /remaining/i.test(k));
    const hasRestriction = allBlockish.some((k) =>
      /restrict|closedto|minstay|maxstay|stopsell|cta|ctd/i.test(k),
    );

    const aggregateOk = hasCon && hasBlk && hasPickup && hasRemaining;
    const verdict = aggregateOk
      ? {
          code: 'PROVEN_LIST_AGGREGATE_COUNTS',
          kind: 'list_ok',
        }
      : {
          code: 'BLOCKED_GROUP_BLOCK_AGGREGATE_COUNTS_UNPROVEN',
          kind: 'list_only_impossible_without_detail',
          reason:
            'docs: CON/BLK on Block tab after selecting booking; live GSGRPB.LST/grid/view configs lack con/blk/pickup/remaining without detail',
          hasCon,
          hasBlk,
          hasPickup,
          hasRemaining,
          hasRestriction,
          docsUrl:
            'https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428588367.html',
        };

    return {
      track: 'group',
      observedAt: new Date().toISOString(),
      controlBytes,
      openStatus: open.status,
      openBytes: open.text.length,
      openPageTitle:
        /"pageTitle"\s*:\s*"([^"]{1,80})"/.exec(open.text)?.[1]?.replace(
          /\d/g,
          '#',
        ) ?? null,
      lstDataKeys: lst?.dataKeys ?? [],
      lstColumns: lst?.columns ?? [],
      lstDenied: lst?.denied ?? [],
      probes: probes.filter((p) => p.bytes > 200 || p.hasGrid || p.hasPageData),
      altGridProbes: altGridProbes.filter((p) => p.bytes > 200 || p.hasGrid),
      allBlockish,
      abortedMutationPaths: aborted.slice(0, 20),
      safetyNote: 'never opened BLK/BLOCK/detail/rooming; mutations aborted',
      verdict,
    };
  });
}

async function main() {
  const secret = await loadSecret();
  const outPath =
    process.env.HMS_BLOCKER_REPROVE_OUT ??
    '/tmp/hms-blocker-reprove-event-group.json';

  // Parallel tracks = sequential sessions (shared secret; avoid dual login risk).
  const event = await eventTrack(secret);
  const group = await groupTrack(secret);

  const report = {
    observedAt: new Date().toISOString(),
    docs: {
      event: 'Group Sales > Events > Event Reservations (mixed R/W)',
      group: 'CON/BLK on Block tab AFTER selecting booking',
    },
    event,
    group,
    summary: {
      eventVerdict: event.verdict,
      groupVerdict: group.verdict,
      eventMenuLabels: event.treeDump?.groupSalesChildrenExact ?? [],
      groupLstBlockish: group.allBlockish ?? [],
    },
  };

  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  // Compact stdout for SSM
  console.log(
    JSON.stringify(
      {
        outPath,
        eventVerdict: event.verdict,
        groupVerdict: group.verdict,
        eventChildren: event.treeDump?.groupSalesChildrenExact ?? [],
        eventHasEvents: event.treeDump?.hasEvents ?? false,
        eventHasEventReservations: event.treeDump?.hasEventReservations ?? false,
        childClicks: event.childClicks,
        groupLstKeysSample: (group.lstDataKeys || []).slice(0, 40),
        groupBlockish: group.allBlockish,
        groupLstDenied: group.lstDenied,
        aborted: [
          ...(event.abortedMutationPaths || []),
          ...(group.abortedMutationPaths || []),
        ].slice(0, 10),
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
