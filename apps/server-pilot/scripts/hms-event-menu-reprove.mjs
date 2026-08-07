/**
 * Event menu soft-capture re-prove — phase3/4 proven clicks + BSSTRT itemLabel harvest.
 * Labels only. Abort mutations. view_only.
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

async function main() {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('need HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'af-south-1',
  });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const secret = hmsSecretSchema.parse(JSON.parse(res.SecretString));
  if (secret.credentialMode !== 'view_only') throw new Error('not view_only');
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
      /(save|delete|settle|refund|void|print\/|export|generate|resend|finalize|email|calculate|copy|cancel|create|amend)/i.test(
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
    const fn =
      /\/web\/base\/([A-Z0-9]{4,12})/i.exec(path)?.[1]?.toUpperCase() ?? null;
    posts.push({ path, fn });
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
    if (control.text.length < 2000 || !/pageData/i.test(control.text)) {
      throw new Error(`session_not_ready bytes=${control.text.length}`);
    }

    const menuSources = [];
    for (const path of [
      '/web/base/BSSTRT',
      '/web/base/BSSTRT.HDR',
      '/web/base/COMMON',
      '/web/base/EWSWEB',
    ]) {
      const fnName = path.split('/').pop().split('.')[0];
      const r = await post(path, {
        USER_FUNCTION_NAME: fnName,
        SYSTEM_FUNCTION_NAME: fnName,
        FUNCTION_CLASS: 'WEBL',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        removescreenflows: 'yes',
      });
      const labels = [];
      const re = /"itemLabel"\s*:\s*"([^"]{1,120})"/g;
      let m;
      while ((m = re.exec(r.text))) labels.push(m[1]);
      const pairs = [];
      for (const chunk of r.text.split('{')) {
        const labelM = /"itemLabel"\s*:\s*"([^"]+)"/.exec(chunk);
        const fnM =
          /"(?:userFunction|systemFunction|functionName)"\s*:\s*"([A-Z0-9]{3,12})"/.exec(
            chunk,
          );
        if (
          labelM &&
          fnM &&
          /group|block|event|banquet|rooming|allot|sales/i.test(labelM[1])
        ) {
          pairs.push({ label: labelM[1], fn: fnM[1] });
        }
      }
      menuSources.push({
        path,
        status: r.status,
        bytes: r.text.length,
        interestingLabels: [...new Set(labels)]
          .filter((t) =>
            /group|block|event|banquet|rooming|allot|sales/i.test(t),
          )
          .slice(0, 60),
        allLabelCount: new Set(labels).size,
        groupEventPairs: pairs.slice(0, 40),
      });
    }

    const clickLog = [];
    for (const label of [
      'Group Sales',
      'Group Booking',
      'Group Availability',
      'Events',
      'Event Reservations',
      'Event Reservation',
    ]) {
      const loc = page.getByText(label, { exact: true }).first();
      const visible = await loc.isVisible().catch(() => false);
      let clicked = false;
      if (visible) {
        await loc.click({ force: true, timeout: 8_000 }).catch(() => undefined);
        clicked = true;
        await page.waitForTimeout(2_500);
      }
      clickLog.push({
        label,
        visible,
        clicked,
        method: 'getByTextExact',
      });
    }

    const expandResult = await page.evaluate(`(() => {
      var nodes = Array.from(document.querySelectorAll('.x-tree-node-text, span, a, .x-tree-node-anchor, label'));
      var ok = false;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if ((n.textContent || '').trim() !== 'Group Sales') continue;
        var row = n.closest('.x-tree-node-el, .x-tree-node, li, div') || n;
        var plus = row.querySelector('.x-tree-ec-icon, .x-tree-elbow-plus, .x-tree-elbow-end-plus');
        if (plus) { try { plus.click(); } catch (e) {} }
        try { n.click(); ok = true; } catch (e) { ok = false; }
        break;
      }
      return {
        groupSales: ok,
        nodeSample: nodes.slice(0, 8).map(function (n) {
          return (n.className || '') + ':' + (n.textContent || '').trim().slice(0, 40);
        }),
      };
    })()`);
    await page.waitForTimeout(3_000);

    for (const label of [
      'Group Booking',
      'Group Availability',
      'Events',
      'Event Reservations',
      'Event Reservation',
      'Blocks',
      'Room Blocks',
      'Banquet',
      'Function Diary',
    ]) {
      const loc = page.getByText(label, { exact: false }).first();
      const visible = await loc.isVisible().catch(() => false);
      if (visible) {
        await loc.click({ force: true, timeout: 8_000 }).catch(() => undefined);
        clickLog.push({
          label: `${label}#retry`,
          visible: true,
          clicked: true,
          method: 'getByTextLoose',
        });
        await page.waitForTimeout(2_000);
      } else {
        clickLog.push({
          label: `${label}#retry`,
          visible: false,
          clicked: false,
          method: 'getByTextLoose',
        });
      }
    }

    const bodyHarvest = await page.evaluate(`(() => {
      var text = (document.body && document.body.innerText) ? document.body.innerText : '';
      var lines = text.split(/\\n+/).map(function (l) { return l.trim(); }).filter(function (l) {
        return l.length > 1 && l.length < 80;
      });
      var uniq = [];
      var seen = {};
      for (var i = 0; i < lines.length; i++) {
        if (seen[lines[i]]) continue;
        seen[lines[i]] = 1;
        uniq.push(lines[i]);
      }
      return {
        interesting: uniq.filter(function (t) {
          return /group|block|event|banquet|rooming|allot|booking|sales|availability|diary|function/i.test(t);
        }).slice(0, 80),
        sample: uniq.slice(0, 40),
        hasEvents: uniq.some(function (t) { return /^Events$/i.test(t); }),
        hasEventReservations: uniq.some(function (t) { return /Event Reservations?/i.test(t); }),
        hasGroupBooking: uniq.some(function (t) { return /^Group Booking$/i.test(t); }),
        hasGroupAvailability: uniq.some(function (t) { return /^Group Availability$/i.test(t); }),
      };
    })()`);

    const counts = {
      gb_getByText: await page.getByText('Group Booking', { exact: true }).count(),
      ga_getByText: await page
        .getByText('Group Availability', { exact: true })
        .count(),
      events_getByText: await page.getByText('Events', { exact: true }).count(),
      er_getByText: await page
        .getByText('Event Reservations', { exact: true })
        .count(),
      er2_getByText: await page
        .getByText('Event Reservation', { exact: true })
        .count(),
      gb_tree: await page
        .locator('.x-tree-node-text', { hasText: /^Group Booking$/ })
        .count()
        .catch(() => 0),
      ga_tree: await page
        .locator('.x-tree-node-text', { hasText: /^Group Availability$/ })
        .count()
        .catch(() => 0),
      events_tree: await page
        .locator('.x-tree-node-text', { hasText: /^Events$/ })
        .count()
        .catch(() => 0),
      er_tree: await page
        .locator('.x-tree-node-text', { hasText: /Event Reservation/ })
        .count()
        .catch(() => 0),
    };

    const menuLabelsMerged = [
      ...new Set(menuSources.flatMap((s) => s.interestingLabels)),
    ];
    const eventsInMenuJson = menuLabelsMerged.some((t) => /event/i.test(t));
    const eventsInUi =
      bodyHarvest.hasEvents ||
      bodyHarvest.hasEventReservations ||
      counts.events_getByText > 0 ||
      counts.er_getByText > 0 ||
      counts.er2_getByText > 0 ||
      counts.events_tree > 0 ||
      counts.er_tree > 0 ||
      clickLog.some((c) => /Event/i.test(c.label) && c.visible);

    const groupChildrenSeen = [
      bodyHarvest.hasGroupBooking ? 'Group Booking' : null,
      bodyHarvest.hasGroupAvailability ? 'Group Availability' : null,
      ...menuLabelsMerged.filter((t) =>
        /group booking|group availability/i.test(t),
      ),
    ].filter(Boolean);

    const verdict =
      eventsInUi || eventsInMenuJson
        ? {
            code: 'EVENTS_LABEL_FOUND_NEEDS_LIST_PROBE',
            kind: 'surface_maybe_present',
            eventsInUi,
            eventsInMenuJson,
          }
        : {
            code: 'BLOCKED_EVENT_READ_SURFACE_UNPROVEN',
            kind: 'external_entitlement',
            reason:
              'docs path Group Sales > Events > Event Reservations; view_only UI+menu JSON lack Events/Event Reservation labels after soft-capture expand',
            groupChildrenSeen: [...new Set(groupChildrenSeen)],
          };

    const report = {
      observedAt: new Date().toISOString(),
      controlBytes: control.text.length,
      expandResult,
      clickLog,
      bodyHarvest,
      counts,
      menuSources: menuSources.map((s) => ({
        path: s.path,
        status: s.status,
        bytes: s.bytes,
        allLabelCount: s.allLabelCount,
        interestingLabels: s.interestingLabels,
        groupEventPairs: s.groupEventPairs,
      })),
      menuLabelsMerged,
      menuFns: [
        ...new Set(posts.map((p) => p.fn).filter(Boolean)),
      ]
        .filter((f) => !['COMMON', 'BSSTRT', 'OSRESS'].includes(f))
        .sort(),
      abortedMutationPaths: aborted.slice(0, 20),
      verdict,
    };

    const out =
      process.env.HMS_EVENT_MENU_REPROVE_OUT ||
      '/tmp/hms-event-menu-reprove.json';
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      JSON.stringify(
        {
          out,
          verdict: report.verdict,
          counts: report.counts,
          bodyInteresting: report.bodyHarvest.interesting,
          menuLabelsMerged: report.menuLabelsMerged,
          clickLog: report.clickLog,
          groupEventPairs: report.menuSources
            .flatMap((s) => s.groupEventPairs)
            .slice(0, 30),
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
