/**
 * Deep menu + module hunt for Group Booking / Event Reservation surfaces.
 * Structure-only. Run with: node scripts/hms-group-event-menu-probe.mjs
 * Requires HMS_DISCOVERY_ALLOW_LIVE=1.
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
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_GROUP_EVENT_DISCOVERY_OUT ??
    '/tmp/hms-group-event-menu.json';

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
      /(save|delete|settle|refund|post|transfer|void|print\/|export|generate|resend|finalize|email|calculate|copy|cancel)/i.test(
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
    await page.waitForTimeout(5_000);

    for (const label of ['Group Sales', 'Events', 'Front Desk']) {
      await page
        .getByText(label, { exact: true })
        .first()
        .click({ force: true, timeout: 8_000 })
        .catch(() => undefined);
      await page.waitForTimeout(2_000);
    }

    // String form — never pass TS-transformed closures into Playwright.
    const report = await page.evaluate(`(async () => {
      var paths = [
        '/web/base/BSSTRT',
        '/web/base/BSSTRT.HDR',
        '/web/base/BSSTRT.LST',
        '/web/base/COMMON',
      ];
      var pathMeta = [];
      var allLabels = {};
      var allFns = {};
      var groupEventPairs = [];
      var groupEventLabels = [];
      var fnNearGroup = [];

      var harvest = function (text, src) {
        var reLabel = /"itemLabel"\\s*:\\s*"([^"]{1,120})"/g;
        var m;
        while ((m = reLabel.exec(text))) {
          allLabels[m[1]] = true;
          if (/group|block|event|banquet|rooming|allot|sales/i.test(m[1])) {
            if (groupEventLabels.indexOf(m[1]) === -1) groupEventLabels.push(m[1]);
          }
        }
        var reFn =
          /"(?:userFunction|systemFunction|USER_FUNCTION_NAME|SYSTEM_FUNCTION_NAME|functionName|funcname|FUNCNAME)"\\s*:\\s*"([A-Z0-9]{3,12})"/g;
        while ((m = reFn.exec(text))) {
          allFns[m[1]] = true;
        }
        var reNear =
          /(?:Group Booking|Event Reservation|Room Block|Subgroup|Roomin(?:g)? List|Group Sales|Events)[\\s\\S]{0,400}?([A-Z]{2}[A-Z0-9]{2,10})/gi;
        while ((m = reNear.exec(text))) {
          fnNearGroup.push(m[0].slice(0, 40) + '=>' + m[1]);
        }
        var chunks = text.split('{');
        for (var i = 0; i < chunks.length; i++) {
          var chunk = chunks[i];
          var labelM = /"itemLabel"\\s*:\\s*"([^"]+)"/.exec(chunk);
          var fnM =
            /"(?:userFunction|systemFunction|functionName)"\\s*:\\s*"([A-Z0-9]{3,12})"/.exec(
              chunk,
            );
          if (
            labelM &&
            fnM &&
            /group|block|event|banquet|rooming|allot/i.test(labelM[1])
          ) {
            groupEventPairs.push({
              label: labelM[1],
              fn: fnM[1],
              src: src,
            });
          }
        }
      };

      for (var pi = 0; pi < paths.length; pi++) {
        var path = paths[pi];
        try {
          var fnName = path.split('/').pop().split('.')[0];
          var r = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: fnName,
              USER_FUNCTION_NAME: fnName,
              manurefresh: 'yes',
              FUNCTION_CLASS: 'WEBL',
              MENU_MODULE_KEY: '0',
              removescreenflows: 'yes',
            }).toString(),
            credentials: 'same-origin',
          });
          var text = await r.text();
          var sampleFn = [];
          var reEcho = /\\b((?:PS|OS|AR|BS|GS)[A-Z0-9]{3,10})\\b/g;
          var em;
          while ((em = reEcho.exec(text))) {
            if (sampleFn.indexOf(em[1]) === -1) sampleFn.push(em[1]);
          }
          pathMeta.push({
            path: path,
            status: r.status,
            bytes: text.length,
            hasItemLabel: /itemLabel/.test(text),
            hasGroupWord: /group|event|block/i.test(text),
            sampleFn: sampleFn.slice(0, 30),
          });
          harvest(text, path);
        } catch (e) {
          pathMeta.push({
            path: path,
            err: e && e.message ? e.message : 'err',
          });
        }
      }

      var moduleSweep = [];
      for (var k = 0; k <= 20; k++) {
        try {
          var mr = await fetch('/web/base/BSSTRT', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: 'BSSTRT',
              USER_FUNCTION_NAME: 'BSSTRT',
              MENU_MODULE_KEY: String(k),
              manurefresh: 'yes',
              FUNCTION_CLASS: 'WEBL',
            }).toString(),
            credentials: 'same-origin',
          });
          var mtext = await mr.text();
          var labels = [];
          var lm;
          var reL = /"itemLabel"\\s*:\\s*"([^"]+)"/g;
          while ((lm = reL.exec(mtext))) labels.push(lm[1]);
          var interesting = labels.filter(function (l) {
            return /group|block|event|banquet|rooming|allot|sales/i.test(l);
          });
          if (interesting.length > 0 || /group|event/i.test(mtext)) {
            moduleSweep.push({
              key: k,
              bytes: mtext.length,
              interesting: interesting,
              labelCount: labels.length,
              sampleLabels: labels.slice(0, 20),
            });
            harvest(mtext, 'BSSTRT:module:' + k);
          }
        } catch (e) {}
      }

      var domLabels = [];
      var nodes = document.querySelectorAll(
        'span, a, div, li, td, button, .x-tree-node-text, .x-menu-item-text',
      );
      for (var ni = 0; ni < nodes.length; ni++) {
        var t = (nodes[ni].textContent || '').trim();
        if (
          t.length > 2 &&
          t.length < 80 &&
          /group|event|block|banquet|rooming|allot|sales/i.test(t) &&
          domLabels.indexOf(t) === -1
        ) {
          domLabels.push(t);
        }
      }

      var osress = {};
      try {
        var or = await fetch('/web/base/OSRESS', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            USER_FUNCTION_NAME: 'OSRESS',
            SYSTEM_FUNCTION_NAME: 'OSRESS',
            FUNCTION_CLASS: 'WEBL',
            CURRENT_TAB_NAME: '',
            MENU_MODULE_KEY: '0',
            removescreenflows: 'yes',
          }).toString(),
          credentials: 'same-origin',
        });
        var otext = await or.text();
        osress = {
          status: or.status,
          bytes: otext.length,
          hasPageData: /pageData|GRIDRESULT|field/.test(otext),
          headMasked: otext.slice(0, 200).replace(/\\d/g, '#'),
        };
      } catch (e) {
        osress = { err: e && e.message ? e.message : 'err' };
      }

      var allLabelKeys = Object.keys(allLabels).sort();
      var allFnKeys = Object.keys(allFns).sort();
      return {
        pathMeta: pathMeta,
        moduleSweep: moduleSweep,
        groupEventLabels: groupEventLabels.slice(0, 40),
        groupEventPairs: groupEventPairs.slice(0, 40),
        fnNearGroup: fnNearGroup.slice(0, 40),
        allLabelCount: allLabelKeys.length,
        allFnCount: allFnKeys.length,
        allFnSample: allFnKeys.slice(0, 100),
        labelSample: allLabelKeys.slice(0, 100),
        domLabels: domLabels.slice(0, 60),
        osress: osress,
      };
    })()`);

    const openFns = [
      ...new Set([
        ...report.groupEventPairs.map((p) => p.fn),
        ...report.allFnSample.filter((f) =>
          /GR|EV|BLK|BOOK|BANQ|RMNG|ALLT|SUBG/i.test(f),
        ),
        'OSGRBK',
        'OSGRES',
        'OSGRP',
        'OSGBLK',
        'OSEVNT',
        'OSEVRE',
        'OSEVT',
        'OSBEO',
        'PSSNEL',
        'OSRESS',
        'OSLEDG',
      ]),
    ].slice(0, 50);

    const opens = [];
    for (const fn of openFns) {
      const result = await page.evaluate(
        `(async (functionName) => {
        try {
          var r = await fetch('/web/base/' + functionName, {
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
          var text = await r.text();
          var titles = [];
          var titleRes = [
            /Group Booking/gi,
            /Event Reservation/gi,
            /Room Block/gi,
            /Subgroup/gi,
            /Roomin(?:g)? List/gi,
            /Sent Email/gi,
            /Guest Stay/gi,
            /Deposit Ledger/gi,
          ];
          for (var ti = 0; ti < titleRes.length; ti++) {
            titleRes[ti].lastIndex = 0;
            var tm = titleRes[ti].exec(text);
            if (tm) titles.push(tm[0]);
          }
          var keys = [];
          var kre = /"([A-Za-z][A-Za-z0-9_]{1,48})"\\s*:/g;
          var km;
          while ((km = kre.exec(text))) {
            if (keys.indexOf(km[1]) === -1) keys.push(km[1]);
          }
          var pick = function (re) {
            return keys.filter(function (k) { return re.test(k); }).slice(0, 40);
          };
          var lst = { status: null, bytes: 0, keys: [], hasGrid: false };
          try {
            var lr = await fetch('/web/base/' + functionName + '.LST', {
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
            var lt = await lr.text();
            var lkeys = [];
            var lkre = /"([A-Za-z][A-Za-z0-9_]{1,48})"\\s*:/g;
            var lkm;
            while ((lkm = lkre.exec(lt))) {
              if (lkeys.indexOf(lkm[1]) === -1) lkeys.push(lkm[1]);
            }
            lst = {
              status: lr.status,
              bytes: lt.length,
              keys: lkeys.slice(0, 60),
              hasGrid: /GRIDRESULT|"DATA"\\s*:/.test(lt),
            };
          } catch (e) {}
          var search = { status: null, bytes: 0, keys: [], hasGrid: false };
          try {
            var sr = await fetch('/web/base/' + functionName + '.search', {
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
            var st = await sr.text();
            var skeys = [];
            var skre = /"([A-Za-z][A-Za-z0-9_]{1,48})"\\s*:/g;
            var skm;
            while ((skm = skre.exec(st))) {
              if (skeys.indexOf(skm[1]) === -1) skeys.push(skm[1]);
            }
            search = {
              status: sr.status,
              bytes: st.length,
              keys: skeys.slice(0, 60),
              hasGrid: /GRIDRESULT|"DATA"\\s*:/.test(st),
            };
          } catch (e) {}
          return {
            status: r.status,
            bytes: text.length,
            titles: titles,
            keyClasses: {
              refLike: pick(/confirmation|group(?:ref|code|id|number)|event(?:ref|code|id|number)|reference/i),
              statusLike: pick(/status|state/i),
              blockLike: pick(/con|blk|block|pickup|remaining|allot|restriction/i),
              eventLike: pick(/eventtype|layout|attendee|person|setup|teardown|deposit|currency|total/i),
              contactLike: pick(/contact|email|phone|delegate/i),
              noteLike: pick(/note|comment|remark/i),
              roomingLike: pick(/rooming|guestname|firstname|lastname/i),
              actionLike: pick(/save|calculate|post|copy|cancel|print|generate|beo/i),
            },
            hasGrid: /GRIDRESULT|"DATA"\\s*:/.test(text),
            lst: lst,
            search: search,
            headMasked: text.slice(0, 160).replace(/\\d/g, '#'),
          };
        } catch (e) {
          return { err: e && e.message ? e.message : 'err' };
        }
      })`,
        fn,
      );
      opens.push({ fn, ...result });
    }

    const final = {
      observedAt: new Date().toISOString(),
      originHost: new URL(origin).host,
      ...report,
      opens: opens.filter(
        (o) =>
          o.fn === 'OSRESS' ||
          o.fn === 'PSSNEL' ||
          o.fn === 'OSLEDG' ||
          (o.bytes && o.bytes > 400) ||
          (o.titles && o.titles.length) ||
          (o.lst && o.lst.hasGrid) ||
          (o.search && o.search.hasGrid),
      ),
    };
    await writeFile(outPath, `${JSON.stringify(final, null, 2)}\n`);
    console.log(JSON.stringify(final, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
