/**
 * Wave A6/A7/A8 soft-overlay packaging probe: Group / Event / Company harvest + opens.
 * Structure only — never body values. Requires HMS_DISCOVERY_ALLOW_LIVE=1.
 * Harvest uses BSSTRT manurefresh + MENU_MODULE_KEY sweep (A3 unlock pattern).
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

type FetchProbe = {
  path: string;
  status: number;
  bytes: number;
  hasLoginFields: boolean;
  hasErrorMarker: boolean;
  inputNames: string[];
  titleMatch: string | null;
  functionTokens: string[];
};

type HarvestPair = { label: string; fn: string };

async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(path);
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: buf.byteLength,
  };
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_A678_PROBE_OUT ?? '/tmp/hms-a678-menu-probe.wavea.json';
  const videoDir =
    process.env.HMS_A678_PROBE_VIDEO_DIR?.trim() || '/tmp/hms-a678-video';
  await mkdir(videoDir, { recursive: true, mode: 0o700 });
  const wantVideo = process.env.HMS_A678_PROBE_VIDEO !== '0';

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
    ...(wantVideo
      ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } }
      : {}),
  });
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    if (!req.url().startsWith(origin)) {
      await route.abort();
      return;
    }
    const path = new URL(req.url()).pathname;
    if (
      /(save|delete|duplicate|checkin|checkout|amend|cancel|settle|refund|send|print|export|submit)/i.test(
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
      .locator('input[name=userid], input[name=username], input[name=j_username]')
      .first()
      .fill(secret.username);
    await page.locator('input[name=password]').fill(secret.password);
    await Promise.all([
      page.waitForURL(/\/web\/base\/COMMON/i, { timeout: 60_000 }).catch(() => null),
      page.getByRole('button', { name: 'Sign in' }).click().catch(async () => {
        await page.locator('input[name=password]').press('Enter');
      }),
    ]);
    await page.waitForTimeout(4_000);

    // Warm BSSTRT before module clicks (A3/A5 lesson — avoid 813B tenant stubs).
    await page.evaluate(async () => {
      for (const path of ['/web/base/BSSTRT.HDR', '/web/base/BSSTRT']) {
        try {
          await fetch(path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: 'BSSTRT',
              USER_FUNCTION_NAME: 'BSSTRT',
              manurefresh: 'yes',
            }).toString(),
          });
        } catch {
          /* ignore */
        }
      }
    });
    await page.waitForTimeout(1_500);

    // Control open: Front Desk / OSRESS early (prove session not stubbed).
    const controlOsress = await page.evaluate(async () => {
      try {
        const r = await fetch('/web/base/OSRESS?FUNCTION_CLASS=WEBL', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            SYSTEM_FUNCTION_NAME: 'OSRESS',
            USER_FUNCTION_NAME: 'OSRESS',
            FUNCTION_CLASS: 'WEBL',
            removescreenflows: 'yes',
          }).toString(),
        });
        const text = await r.text();
        return { status: r.status, bytes: text.length, stub813: text.length === 813 };
      } catch {
        return { status: 0, bytes: 0, stub813: false };
      }
    });

    // Harvest: scripts + BSSTRT + MENU_MODULE_KEY 0..20 (group-event probe pattern).
    const harvest = await page.evaluate(async () => {
      const blobs: string[] = [];
      const moduleSweep: Array<{
        key: number;
        bytes: number;
        labelCount: number;
        interesting: string[];
        sampleLabels: string[];
      }> = [];

      for (const s of document.scripts) {
        if (s.textContent) blobs.push(s.textContent.slice(0, 400_000));
      }
      for (const path of ['/web/base/BSSTRT.HDR', '/web/base/BSSTRT']) {
        try {
          const r = await fetch(path, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: 'BSSTRT',
              USER_FUNCTION_NAME: 'BSSTRT',
              manurefresh: 'yes',
            }).toString(),
          });
          blobs.push(await r.text());
        } catch {
          /* ignore */
        }
      }
      for (let k = 0; k <= 20; k++) {
        try {
          const mr = await fetch('/web/base/BSSTRT', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: 'BSSTRT',
              USER_FUNCTION_NAME: 'BSSTRT',
              MENU_MODULE_KEY: String(k),
              manurefresh: 'yes',
              FUNCTION_CLASS: 'WEBL',
            }).toString(),
          });
          const mtext = await mr.text();
          const labels = [...mtext.matchAll(/"itemLabel"\s*:\s*"([^"]+)"/g)].map(
            (m) => m[1]!,
          );
          const interesting = labels.filter((l) =>
            /group|block|event|banquet|rooming|allot|sales|compan|account|profile/i.test(
              l,
            ),
          );
          if (interesting.length > 0 || labels.length > 0) {
            moduleSweep.push({
              key: k,
              bytes: mtext.length,
              labelCount: labels.length,
              interesting: interesting.slice(0, 40),
              sampleLabels: labels.slice(0, 20),
            });
          }
          blobs.push(mtext);
        } catch {
          /* ignore */
        }
      }

      const pairs: HarvestPair[] = [];
      const allFns = new Set<string>();
      const labels: string[] = [];
      for (const text of blobs) {
        const lab = [...text.matchAll(/"itemLabel"\s*:\s*"([^"]+)"/g)].map((x) => x[1]!);
        labels.push(...lab);
        const fns = [
          ...text.matchAll(
            /"(?:userFunction|systemFunction|USER_FUNCTION_NAME|SYSTEM_FUNCTION_NAME|functionName|funcname|FUNCNAME)"\s*:\s*"([A-Z0-9]{3,12})"/gi,
          ),
        ].map((x) => x[1]!.toUpperCase());
        for (const fn of fns) allFns.add(fn);
        for (let i = 0; i < Math.min(lab.length, fns.length); i++) {
          pairs.push({ label: lab[i]!, fn: fns[i]! });
        }
        // Chunk-local pairing (event-menu-reprove style).
        for (const chunk of text.split(/\{/g).slice(0, 8_000)) {
          const labelM = /"itemLabel"\s*:\s*"([^"]+)"/.exec(chunk);
          const fnM =
            /"(?:userFunction|systemFunction|functionName)"\s*:\s*"([A-Z0-9]{3,12})"/i.exec(
              chunk,
            );
          if (labelM && fnM) {
            pairs.push({ label: labelM[1]!, fn: fnM[1]!.toUpperCase() });
            allFns.add(fnM[1]!.toUpperCase());
          }
        }
        for (const hit of text.matchAll(
          /(Group(?:\s*Sales)?|Event|Company|Account|Allotment|Block|Banquet|Profile|Guest Stay|Front Desk)[^A-Z0-9]{0,160}\b((?:OS|PS|AR)[A-Z0-9]{3,10})\b|\b((?:OS|PS|AR)[A-Z0-9]{3,10})\b[^A-Z0-9]{0,160}(Group|Event|Company|Allotment|Block|Banquet|Profile)/gi,
        )) {
          const label = (hit[1] || hit[4] || '').trim();
          const fn = (hit[2] || hit[3] || '').trim().toUpperCase();
          if (label && fn) {
            pairs.push({ label, fn });
            allFns.add(fn);
          }
        }
        for (const m of text.matchAll(/\b((?:OS|PS|AR)[A-Z0-9]{3,10})\b/g)) {
          allFns.add(m[1]!.toUpperCase());
        }
      }

      const uniq: HarvestPair[] = [];
      const seen = new Set<string>();
      for (const p of pairs) {
        const k = `${p.label}|${p.fn}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (
          /group|event|compan|account|allot|block|banquet|profile|front desk|guest/i.test(
            p.label,
          ) ||
          /GR|EV|BLK|ALLT|ACCT|COMP|BANQ|RMNG|SUBG|BEO/i.test(p.fn)
        ) {
          uniq.push(p);
        }
      }

      return {
        labelSample: [...new Set(labels)]
          .filter((l) =>
            /group|event|compan|account|allot|block|banquet|profile/i.test(l),
          )
          .slice(0, 80),
        pairs: uniq.slice(0, 120),
        allFnSample: [...allFns].sort().slice(0, 120),
        moduleSweep: moduleSweep.slice(0, 30),
        blobBytes: blobs.reduce((n, t) => n + t.length, 0),
      };
    });

    const navProbe: string[] = [];
    navProbe.push(
      `harvest:pairs=${harvest.pairs.length}:fns=${harvest.allFnSample.length}:blobBytes=${harvest.blobBytes}:modules=${harvest.moduleSweep.length}`,
    );
    navProbe.push(
      `control:OSRESS:status=${controlOsress.status}:bytes=${controlOsress.bytes}:stub813=${controlOsress.stub813}`,
    );

    async function probeOpen(fn: string): Promise<FetchProbe> {
      return page.evaluate(async (functionName) => {
        const body = new URLSearchParams({
          SYSTEM_FUNCTION_NAME: functionName,
          USER_FUNCTION_NAME: functionName,
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          FUNCTION_CLASS: 'WEBL',
          removescreenflows: 'yes',
        });
        try {
          const res = await fetch(`/web/base/${functionName}?FUNCTION_CLASS=WEBL`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          });
          const text = await res.text();
          const names = [
            ...new Set(
              [...text.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!),
            ),
          ].slice(0, 60);
          return {
            path: `/web/base/${functionName}`,
            status: res.status,
            bytes: text.length,
            hasLoginFields:
              /name\s*=\s*["']userid["']/i.test(text) &&
              /name\s*=\s*["']password["']/i.test(text),
            hasErrorMarker:
              /not authorised|not authorized|access denied|permission|function not available|no authority/i.test(
                text,
              ),
            inputNames: names,
            titleMatch: (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] ?? null,
            functionTokens: [
              ...new Set(
                [...text.matchAll(/\b((?:OS|PS|AR)[A-Z0-9]{3,8})\b/g)].map((m) => m[1]!),
              ),
            ].slice(0, 20),
          };
        } catch {
          return {
            path: `/web/base/${functionName}`,
            status: 0,
            bytes: 0,
            hasLoginFields: false,
            hasErrorMarker: false,
            inputNames: [],
            titleMatch: null,
            functionTokens: [],
          };
        }
      }, fn);
    }

    // Open harvested + guessed codes BEFORE menu clicks (A3 lesson — post-click opens stub).
    const earlyCandidates = [
      ...new Set(
        [
          ...harvest.pairs.map((p) => p.fn),
          ...harvest.allFnSample.filter((fn) =>
            /GR|EV|BLK|ALLT|ACCT|ACBL|COMP|BANQ|RMNG|SUBG|BEO|BOOK|PROF|LEDG/i.test(fn),
          ),
          'OSGRP',
          'OSGBLK',
          'OSGRBK',
          'OSGRES',
          'OSALLT',
          'OSEVT',
          'OSEVNT',
          'OSEVRE',
          'OSBEO',
          'OSACCT',
          'OSACBL',
          'ARACCT',
          'OSCOMP',
          'PSSNEL',
          'OSRESS',
        ].filter((fn) => /^(OS|PS|AR)[A-Z0-9]{3,10}$/.test(fn)),
      ),
    ].slice(0, 30);
    const opens: Record<string, FetchProbe> = {};
    for (const fn of earlyCandidates) {
      opens[fn] = await probeOpen(fn);
    }
    navProbe.push(
      `earlyOpens:real=${
        Object.entries(opens).filter(
          ([, v]) => v.status === 200 && v.bytes > 2000 && !v.hasLoginFields,
        ).length
      }:candidates=${earlyCandidates.length}`,
    );

    for (const label of [
      'Group Sales',
      'Profiles',
      'Front Desk',
      'Events',
      'Group',
      'Company',
      'Accounts',
      'Allotment',
      'Banquet',
    ]) {
      const visible = await page
        .locator(`text=${label}`)
        .first()
        .isVisible()
        .catch(() => false);
      navProbe.push(`label:${label}:${visible ? 'visible' : 'absent'}`);
      if (visible) {
        await page
          .locator(`text=${label}`)
          .first()
          .click({ force: true, timeout: 5_000 })
          .catch(() => undefined);
        await page.waitForTimeout(1_500);
      }
    }

    // Re-harvest after module clicks (DOM may inject more scripts).
    const postClickHarvest = await page.evaluate(async () => {
      const blobs: string[] = [];
      for (const s of document.scripts) {
        if (s.textContent) blobs.push(s.textContent.slice(0, 200_000));
      }
      try {
        const r = await fetch('/web/base/BSSTRT', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            SYSTEM_FUNCTION_NAME: 'BSSTRT',
            USER_FUNCTION_NAME: 'BSSTRT',
            manurefresh: 'yes',
            FUNCTION_CLASS: 'WEBL',
          }).toString(),
        });
        blobs.push(await r.text());
      } catch {
        /* ignore */
      }
      const pairs: HarvestPair[] = [];
      const fns = new Set<string>();
      for (const text of blobs) {
        for (const chunk of text.split(/\{/g).slice(0, 8_000)) {
          const labelM = /"itemLabel"\s*:\s*"([^"]+)"/.exec(chunk);
          const fnM =
            /"(?:userFunction|systemFunction|functionName)"\s*:\s*"([A-Z0-9]{3,12})"/i.exec(
              chunk,
            );
          if (labelM && fnM) {
            pairs.push({ label: labelM[1]!, fn: fnM[1]!.toUpperCase() });
            fns.add(fnM[1]!.toUpperCase());
          }
        }
        for (const m of text.matchAll(/\b((?:OS|PS|AR)[A-Z0-9]{3,10})\b/g)) {
          fns.add(m[1]!.toUpperCase());
        }
      }
      return {
        pairs: pairs.slice(0, 80),
        fnSample: [...fns].sort().slice(0, 80),
        blobBytes: blobs.reduce((n, t) => n + t.length, 0),
      };
    });
    navProbe.push(
      `postClick:pairs=${postClickHarvest.pairs.length}:fns=${postClickHarvest.fnSample.length}:blobBytes=${postClickHarvest.blobBytes}`,
    );

    const menuLabels = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          '.x-tree-node-text, .x-menu-item-text, .x-btn-inner, a, span',
        ),
      ];
      return [
        ...new Set(
          nodes
            .map((el) => (el.textContent ?? '').trim())
            .filter((t) => t.length > 2 && t.length < 64)
            .filter((t) =>
              /group|event|compan|account|block|allot|banquet|profile|front desk|guest/i.test(
                t,
              ),
            ),
        ),
      ].slice(0, 80);
    });

    // Post-click: only probe newly harvested codes not already opened early.
    const harvestedFns = [
      ...new Set(
        [
          ...harvest.pairs.map((p) => p.fn),
          ...postClickHarvest.pairs.map((p) => p.fn),
          ...harvest.allFnSample.filter((fn) =>
            /GR|EV|BLK|ALLT|ACCT|ACBL|COMP|BANQ|RMNG|SUBG|BEO|BOOK/i.test(fn),
          ),
          ...postClickHarvest.fnSample.filter((fn) =>
            /GR|EV|BLK|ALLT|ACCT|ACBL|COMP|BANQ|RMNG|SUBG|BEO|BOOK/i.test(fn),
          ),
        ].filter((fn) => /^(OS|PS|AR)[A-Z0-9]{3,10}$/.test(fn)),
      ),
    ].slice(0, 24);
    for (const fn of harvestedFns) {
      if (!(fn in opens)) {
        opens[fn] = await probeOpen(fn);
      }
    }

    await page.waitForTimeout(1_000);
    await page.close();
    await ctx.close();

    let videoMeta: {
      hasVideo: boolean;
      sha256: string | null;
      bytes: number;
      path: string | null;
    } = { hasVideo: false, sha256: null, bytes: 0, path: null };
    if (wantVideo) {
      const files = await readdir(videoDir);
      const webms = [];
      for (const f of files) {
        if (!f.endsWith('.webm')) continue;
        const p = join(videoDir, f);
        const st = await stat(p);
        webms.push({ p, mtime: st.mtimeMs });
      }
      webms.sort((a, b) => b.mtime - a.mtime);
      if (webms[0]) {
        const dig = await sha256File(webms[0].p);
        videoMeta = {
          hasVideo: true,
          sha256: dig.sha256,
          bytes: dig.bytes,
          path: webms[0].p,
        };
      }
    }

    const payload = {
      schemaVersion: 1,
      surface: 'a678_menu_probe',
      capturedAt: new Date().toISOString(),
      originHost: new URL(origin).host,
      valuesCaptured: false,
      navProbe,
      menuLabels,
      harvest,
      postClickHarvest,
      controlOsress,
      opens,
      video: videoMeta,
    };
    await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(
      JSON.stringify({
        ok: true,
        outPath,
        menuLabelCount: menuLabels.length,
        harvestPairCount: harvest.pairs.length,
        allFnCount: harvest.allFnSample.length,
        moduleSweepCount: harvest.moduleSweep.length,
        harvestedFns,
        controlOsress,
        video: {
          hasVideo: videoMeta.hasVideo,
          sha256: videoMeta.sha256,
          bytes: videoMeta.bytes,
        },
        openSummary: Object.fromEntries(
          Object.entries(opens).map(([k, v]) => [
            k,
            {
              status: v.status,
              bytes: v.bytes,
              login: v.hasLoginFields,
              err: v.hasErrorMarker,
              inputs: v.inputNames.length,
            },
          ]),
        ),
      }) + '\n',
    );
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : 'probe_failed';
  const safe = /password|secret|cookie|arn:aws/i.test(msg)
    ? 'redacted_error'
    : msg.slice(0, 200);
  process.stderr.write(`${safe}\n`);
  process.exit(1);
});
