/**
 * Abort-first soft-capture for Room Type and Rate Availability (quote branch).
 * Records redacted structural signatures only — never body/query values.
 * Aborts CRS / save / delete / checkin / checkout / unknown mutation paths.
 * Orchestrator-only: requires HMS_DISCOVERY_ALLOW_LIVE=1.
 */
import { writeFile } from 'node:fs/promises';
import { chromium, type Request } from 'playwright';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { hmsSecretSchema } from '../src/hms/runtime.js';

type RedactedSig = {
  method: string;
  path: string;
  resourceType: string;
  queryKeys: string[];
  bodyKeys: string[];
  bodyBytes: number;
  contentType: string | null;
  decision: 'continue' | 'abort';
  abortReason?: string;
};

function redact(req: Request): Omit<RedactedSig, 'decision' | 'abortReason'> {
  const url = new URL(req.url());
  const headers = req.headers();
  const contentType = (headers['content-type'] ?? '').split(';', 1)[0]!.trim() || null;
  const raw = req.postData() ?? '';
  let bodyKeys: string[] = [];
  if (raw && (contentType === 'application/x-www-form-urlencoded' || !contentType)) {
    bodyKeys = [...new URLSearchParams(raw).keys()];
  } else if (raw && contentType === 'application/json') {
    try {
      bodyKeys = Object.keys(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      bodyKeys = [];
    }
  }
  return {
    method: req.method().toUpperCase(),
    path: url.pathname,
    resourceType: req.resourceType(),
    queryKeys: [...url.searchParams.keys()],
    bodyKeys,
    bodyBytes: Buffer.byteLength(raw),
    contentType,
  };
}

function shouldAbort(path: string, method: string): string | null {
  if (/\/crs\/|checkavailability|check.?availability/i.test(path)) {
    return 'crs_check_availability';
  }
  if (/(save|delete|duplicate|checkin|checkout|amend|cancel|post|settle|refund|send|print|export|submit)/i.test(path)) {
    return 'mutation_path';
  }
  if (method !== 'GET' && method !== 'POST' && method !== 'HEAD' && method !== 'OPTIONS') {
    return 'unsafe_method';
  }
  return null;
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_QUOTE_CAPTURE_OUT ??
    '/tmp/hms-quote-availability-soft-capture.json';

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

  const signatures: RedactedSig[] = [];
  const structure: Record<string, unknown> = {
    menuLabelsSeen: [] as string[],
    toolbarIconPaths: [] as string[],
    functionNames: [] as string[],
    pageTitle: null as string | null,
    hasRoomRateAvailabilityText: false,
    hasCrsText: false,
  };

  const { mkdir, access } = await import('node:fs/promises');
  const { constants: fsConstants } = await import('node:fs');
  const videoDir =
    process.env.HMS_QUOTE_CAPTURE_VIDEO_DIR?.trim() ||
    `${outPath.replace(/\.json$/i, '')}-video`;
  await mkdir(videoDir, { recursive: true, mode: 0o700 });

  let wantVideo = process.env.HMS_QUOTE_CAPTURE_VIDEO !== '0';
  if (wantVideo) {
    const ffmpegCandidates = [
      process.env.PLAYWRIGHT_FFMPEG_PATH,
      '/home/ubuntu/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux',
      '/opt/nava/playwright-browsers/ffmpeg-1011/ffmpeg-linux',
      '/usr/bin/ffmpeg',
    ].filter((p): p is string => Boolean(p && p.trim()));
    let ffmpegOk = false;
    for (const p of ffmpegCandidates) {
      try {
        await access(p, fsConstants.X_OK);
        process.env.PLAYWRIGHT_FFMPEG_PATH = p;
        ffmpegOk = true;
        break;
      } catch {
        /* try next */
      }
    }
    if (!ffmpegOk) {
      wantVideo = false;
      process.stderr.write(
        'HMS_QUOTE_CAPTURE_WARN code=FFMPEG_MISSING falling_back_no_video\n',
      );
    }
  }

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
    const url = req.url();
    if (!url.startsWith(origin)) {
      signatures.push({
        ...redact(req),
        decision: 'abort',
        abortReason: 'cross_origin',
      });
      await route.abort();
      return;
    }
    const path = new URL(url).pathname;
    const abortReason = shouldAbort(path, req.method());
    if (abortReason) {
      signatures.push({
        ...redact(req),
        decision: 'abort',
        abortReason,
      });
      await route.abort();
      return;
    }
    // Soft-allow chrome + login + availability-looking GETs; abort unknown POSTs
    // until preTransmissionEvidence exists for that exact signature.
    if (req.method() === 'POST') {
      const knownLogin =
        /\/session|\/login|j_security|Authenticate/i.test(path) ||
        (/SYSTEM_FUNCTION_NAME|USER_FUNCTION_NAME/i.test(req.postData() ?? '') &&
          /\/login|\/BSS?TRT|COMMON/i.test(path));
      // Soft-allow OSRRAV surface OPEN only. Never allow .search without
      // preTransmissionEvidence (production driver owns that path).
      // Soft-allow OSRRAV / OSR* availability surface OPEN (no .search).
      // Production driver owns exact .search binds with preTransmissionEvidence.
      const osSurfaceOpen =
        /^\/web\/base\/OS[A-Z0-9]{3,12}\/?$/i.test(path) ||
        /^\/web\/base\/OS[A-Z0-9]{3,12}\.HDR\/?$/i.test(path) ||
        (/^\/web\/base\/OS[A-Z0-9]/i.test(path) && !/\.search/i.test(path));
      const knownAvail =
        /avail|rate|OSRAT|OSRAV|OSRRAV|room.?rate|room.?type/i.test(path) ||
        /avail|rate|roomtype|rateplan/i.test(req.postData() ?? '');
      if (osSurfaceOpen) {
        signatures.push({ ...redact(req), decision: 'continue' });
        await route.continue();
        return;
      }
      if (!knownLogin && !knownAvail) {
        signatures.push({
          ...redact(req),
          decision: 'abort',
          abortReason: 'unknown_post_pending_evidence',
        });
        await route.abort();
        return;
      }
      // Still record — do not transmit availability/search POST without evidence.
      if (knownAvail && !knownLogin) {
        signatures.push({
          ...redact(req),
          decision: 'abort',
          abortReason: 'availability_post_needs_preTransmissionEvidence',
        });
        await route.abort();
        return;
      }
    }
    signatures.push({ ...redact(req), decision: 'continue' });
    await route.continue();
  });

  const page = await ctx.newPage();
  try {
    await page.goto(secret.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try {
      await page.locator('input[name=userid]').fill(secret.username);
    } catch {
      await page
        .locator('input[name=username], input[name=j_username]')
        .first()
        .fill(secret.username);
    }
    await page.locator('input[name=password]').fill(secret.password);
    await Promise.all([
      page.waitForURL(/\/web\/base\/COMMON/i, { timeout: 60_000 }).catch(() => null),
      page.getByRole('button', { name: 'Sign in' }).click().catch(async () => {
        await page.locator('input[name=password]').press('Enter');
      }),
    ]);

    await page.waitForTimeout(4_000);
    structure.pageTitle = await page.title();
    // Warm BSSTRT like menu-codes / A3 Sent Email — unwarmed OSRRAV opens returned 813B stubs.
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
    // Establish property/session chrome the way Guest Stay soft overlays do —
    // some Rate surfaces return tenant stub until a Front Desk context exists.
    await page.click('text=Front Desk', { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    const guestStayVisible = await page
      .locator('text=Guest Stay')
      .first()
      .isVisible()
      .catch(() => false);
    if (guestStayVisible) {
      await page.click('text=Guest Stay', { timeout: 8_000 }).catch(() => undefined);
      await page.waitForTimeout(3_000);
      structure.guestStayContextOpened = true;
    } else {
      // Soft-open OSRESS (Guest Stay search) if label hidden.
      const osressOpen = await page.evaluate(async () => {
        try {
          const res = await fetch('/web/base/OSRESS?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=OSRESS', {
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
          const text = await res.text();
          return {
            status: res.status,
            bytes: text.length,
            hasSearch:
              /name\s*=\s*["']confirmationnumber["']/i.test(text) ||
              /OSRESS/i.test(text),
            hasLogin:
              /name\s*=\s*["']userid["']/i.test(text) &&
              /name\s*=\s*["']password["']/i.test(text),
          };
        } catch (e) {
          return {
            status: 0,
            bytes: 0,
            hasSearch: false,
            hasLogin: false,
            error: e instanceof Error ? e.name : 'fetch_failed',
          };
        }
      });
      structure.osressOpenProbe = osressOpen;
      structure.guestStayContextOpened = Boolean(osressOpen.hasSearch);
      await page.waitForTimeout(1_500);
    }
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 8000) ?? '');
    structure.hasRoomRateAvailabilityText =
      /Room Type and Rate Availability|Room Rate Availability|Rate Availability/i.test(
        bodyText,
      );
    structure.hasCrsText = /CRS Check Availability|Check Availability/i.test(bodyText);
    const labels = bodyText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 2 && l.length < 80)
      .slice(0, 200);
    structure.menuLabelsSeen = labels.filter((l) =>
      /Front Desk|Guest Stay|Availability|Rate|Room|CRS|Reserv/i.test(l),
    );

    // Collect toolbar icon paths from DOM (structure only).
    const icons = await page.evaluate(() =>
      [...document.querySelectorAll('img[src*="toolbar"], img[src*="availability"]')].map(
        (el) => (el as HTMLImageElement).getAttribute('src') ?? '',
      ),
    );
    structure.toolbarIconPaths = icons
      .map((s) => {
        try {
          return new URL(s, origin).pathname;
        } catch {
          return s;
        }
      })
      .filter(Boolean)
      .slice(0, 80);

    // Deeper menu / toolbar probe (no search POST). Centurion chrome often nests
    // OSRRAV under Rate and Sales; toolbar SVGs are also clickable entry points.
    const navProbe: string[] = [];
    structure.navProbe = navProbe;
    for (const label of [
      'Rate and Sales',
      'Front Desk',
      'Availability',
      'AVAILABILITY SUMMARY',
      'Room Type and Rate Availability',
      'Room Rate Availability',
      'Room Type Availability',
      'Availability Summary',
    ]) {
      const visible = await page
        .locator(`text=${label}`)
        .first()
        .isVisible()
        .catch(() => false);
      navProbe.push(`label:${label}:${visible ? 'visible' : 'absent'}`);
      if (visible) {
        await page.click(`text=${label}`, { timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(1_500);
      }
    }

    // Toolbar icon clicks — structure-only (title/alt/src), never typed values.
    const iconHits = await page.evaluate(() => {
      const nodes = [
        ...document.querySelectorAll(
          'img[src*="room-rate-availability"], img[src*="room-type-availability"], img[src*="room-availability"], a[title*="Rate Availability"], a[title*="Room Type"], *[aria-label*="Rate Availability"]',
        ),
      ] as HTMLElement[];
      return nodes.slice(0, 12).map((el) => {
        const img = el as HTMLImageElement;
        return {
          tag: el.tagName,
          src: img.getAttribute?.('src') ?? null,
          title: el.getAttribute('title') ?? null,
          aria: el.getAttribute('aria-label') ?? null,
        };
      });
    });
    structure.toolbarCandidates = iconHits;
    for (const hit of iconHits) {
      const sel =
        hit.src != null
          ? `img[src="${hit.src}"]`
          : hit.title
            ? `[title="${hit.title}"]`
            : hit.aria
              ? `[aria-label="${hit.aria}"]`
              : null;
      if (!sel) continue;
      const clicked = await page
        .locator(sel)
        .first()
        .click({ timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
      navProbe.push(`icon:${sel}:${clicked ? 'clicked' : 'miss'}`);
      if (clicked) await page.waitForTimeout(2_000);
    }

    // Soft-probe OSRRAV surface OPEN via same-origin credentialed fetch (keeps
    // Playwright session). Never call .search. Structure markers only.
    const fetchProbe = await page.evaluate(async () => {
      const body = new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'OSRRAV',
        USER_FUNCTION_NAME: 'OSRRAV',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        FUNCTION_CLASS: 'WEBL',
        removescreenflows: 'yes',
      });
      try {
        const res = await fetch('/web/base/OSRRAV?FUNCTION_CLASS=WEBL', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        const text = await res.text();
        const names = [...text.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!);
        const uniq = [...new Set(names)].slice(0, 80);
        return {
          ok: res.ok,
          status: res.status,
          bytes: text.length,
          hasRoomtypes: /name\s*=\s*["']roomtypes["']/i.test(text),
          hasLoginFields: /name\s*=\s*["']userid["']/i.test(text) && /name\s*=\s*["']password["']/i.test(text),
          hasOsrravToken: /OSRRAV/i.test(text),
          hasErrorMarker:
            /not authorised|not authorized|access denied|permission|function not available|no authority/i.test(
              text,
            ),
          titleMatch: (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] ?? null,
          inputNames: uniq,
        };
      } catch (e) {
        return {
          ok: false,
          status: 0,
          bytes: 0,
          hasRoomtypes: false,
          hasLoginFields: false,
          hasOsrravToken: false,
          hasErrorMarker: false,
          titleMatch: null,
          inputNames: [],
          error: e instanceof Error ? e.name : 'fetch_failed',
        };
      }
    });
    structure.osrravFetchProbe = fetchProbe;
    navProbe.push(
      `osrravFetch:${fetchProbe.status}:roomtypes=${fetchProbe.hasRoomtypes}:login=${fetchProbe.hasLoginFields}`,
    );

    // Soft-probe OSRRAV.HDR open (production facade also hits HDR chrome).
    const hdrProbe = await page.evaluate(async () => {
      const body = new URLSearchParams({
        SYSTEM_FUNCTION_NAME: 'OSRRAV',
        USER_FUNCTION_NAME: 'OSRRAV',
        CURRENT_TAB_NAME: '',
        MENU_MODULE_KEY: '0',
        FUNCTION_CLASS: 'WEBL',
        removescreenflows: 'yes',
      });
      try {
        const res = await fetch('/web/base/OSRRAV.HDR?FUNCTION_CLASS=WEBL', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        const text = await res.text();
        const names = [...text.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!);
        return {
          ok: res.ok,
          status: res.status,
          bytes: text.length,
          hasRoomtypes: /name\s*=\s*["']roomtypes["']/i.test(text),
          hasLoginFields:
            /name\s*=\s*["']userid["']/i.test(text) &&
            /name\s*=\s*["']password["']/i.test(text),
          inputNames: [...new Set(names)].slice(0, 80),
        };
      } catch (e) {
        return {
          ok: false,
          status: 0,
          bytes: 0,
          hasRoomtypes: false,
          hasLoginFields: false,
          inputNames: [],
          error: e instanceof Error ? e.name : 'fetch_failed',
        };
      }
    });
    structure.osrravHdrFetchProbe = hdrProbe;
    navProbe.push(
      `osrravHdrFetch:${hdrProbe.status}:roomtypes=${hdrProbe.hasRoomtypes}:login=${hdrProbe.hasLoginFields}`,
    );

    // After Rate and Sales expand: harvest all short menu-like labels + OS* codes.
    await page.click('text=Rate and Sales', { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    const rateSalesHarvest = await page.evaluate(() => {
      const text = document.body?.innerText?.slice(0, 12_000) ?? '';
      const html = document.documentElement?.innerHTML?.slice(0, 80_000) ?? '';
      const labels = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 2 && l.length < 90)
        .filter((l) => /rate|avail|room|quote|plan|sales|inventory|price/i.test(l))
        .slice(0, 60);
      const functionNames = [
        ...new Set([...text.matchAll(/\b((?:OS|PS|AR)[A-Z0-9]{3,8})\b/g)].map((m) => m[1]!)),
      ].slice(0, 40);
      const hrefFns = [
        ...new Set(
          [...html.matchAll(/USER_FUNCTION_NAME[=:]["']?([A-Z0-9]{4,12})/gi)].map((m) =>
            m[1]!.toUpperCase(),
          ),
        ),
      ].slice(0, 40);
      return { labels, functionNames, hrefFns };
    });
    structure.rateSalesHarvest = rateSalesHarvest;
    navProbe.push(
      `rateSalesHarvest:labels=${rateSalesHarvest.labels.length}:fns=${rateSalesHarvest.functionNames.join(',')}`,
    );

    // Soft-open any harvested OS*RAV / OS*RAT / avail-looking codes (surface OPEN only).
    const candidateFns = [
      ...new Set([
        ...(rateSalesHarvest.functionNames as string[]),
        ...(rateSalesHarvest.hrefFns as string[]),
      ]),
    ].filter((fn) => /RAV|RAT|AVL|RATES|ROOM/i.test(fn)).slice(0, 8);
    const altOpenProbes: Record<string, unknown>[] = [];
    for (const fn of candidateFns) {
      const probe = await page.evaluate(async (functionName) => {
        const body = new URLSearchParams({
          SYSTEM_FUNCTION_NAME: functionName,
          USER_FUNCTION_NAME: functionName,
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          FUNCTION_CLASS: 'WEBL',
          removescreenflows: 'yes',
        });
        try {
          const res = await fetch(
            `/web/base/${functionName}?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=${functionName}`,
            {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: body.toString(),
            },
          );
          const text = await res.text();
          const names = [...text.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!);
          return {
            functionName,
            status: res.status,
            bytes: text.length,
            hasRoomtypes: /name\s*=\s*["']roomtypes["']/i.test(text),
            hasRateplans: /name\s*=\s*["']rateplans["']/i.test(text),
            hasLoginFields:
              /name\s*=\s*["']userid["']/i.test(text) &&
              /name\s*=\s*["']password["']/i.test(text),
            inputNames: [...new Set(names)].slice(0, 40),
          };
        } catch (e) {
          return {
            functionName,
            status: 0,
            bytes: 0,
            hasRoomtypes: false,
            hasRateplans: false,
            hasLoginFields: false,
            inputNames: [],
            error: e instanceof Error ? e.name : 'fetch_failed',
          };
        }
      }, fn);
      altOpenProbes.push(probe);
      navProbe.push(
        `altOpen:${fn}:${probe.status}:roomtypes=${probe.hasRoomtypes}:rateplans=${probe.hasRateplans}`,
      );
    }
    structure.altOpenProbes = altOpenProbes;

    // ROOM PLAN — visible sibling; may expose rate/inventory chrome without OSRRAV.
    const roomPlanVisible = await page
      .locator('text=ROOM PLAN')
      .first()
      .isVisible()
      .catch(() => false);
    if (roomPlanVisible) {
      await page.click('text=ROOM PLAN', { timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(2_500);
      const roomPlanProbe = await page.evaluate(() => {
        const text = document.body?.innerText?.slice(0, 8_000) ?? '';
        const html = document.documentElement?.innerHTML?.slice(0, 80_000) ?? '';
        const names = [...html.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!);
        return {
          title: document.title,
          hasRoomtypes: /name\s*=\s*["']roomtypes["']/i.test(html),
          hasRateplans: /name\s*=\s*["']rateplans["']/i.test(html),
          hasLogin: /name\s*=\s*["']userid["']/i.test(html),
          functionNames: [
            ...new Set([...text.matchAll(/\b((?:OS|PS|AR)[A-Z0-9]{3,8})\b/g)].map((m) => m[1]!)),
          ].slice(0, 30),
          hrefFns: [
            ...new Set(
              [...html.matchAll(/USER_FUNCTION_NAME[=:]["']?([A-Z0-9]{4,12})/gi)].map((m) =>
                m[1]!.toUpperCase(),
              ),
            ),
          ].slice(0, 40),
          inputNames: [...new Set(names)].slice(0, 60),
          labels: text
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => /rate|avail|room|plan|inventory|price/i.test(l) && l.length < 90)
            .slice(0, 40),
        };
      });
      structure.roomPlanProbe = roomPlanProbe;
      navProbe.push(
        `roomPlan:roomtypes=${roomPlanProbe.hasRoomtypes}:fns=${(roomPlanProbe.functionNames || []).join(',')}`,
      );
    }

    // BSSTRT menu harvest — structural menu keys only (no values).
    const bsstrtProbe = await page.evaluate(async () => {
      try {
        const res = await fetch('/web/base/BSSTRT?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=BSSTRT', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            SYSTEM_FUNCTION_NAME: 'BSSTRT',
            USER_FUNCTION_NAME: 'BSSTRT',
            FUNCTION_CLASS: 'WEBL',
            removescreenflows: 'yes',
          }).toString(),
        });
        const text = await res.text();
        const fns = [
          ...new Set(
            [...text.matchAll(/\b((?:OS|PS|AR)[A-Z0-9]{3,10})\b/g)].map((m) => m[1]!.toUpperCase()),
          ),
        ].slice(0, 80);
        const rateish = fns.filter((f) => /RAV|RAT|AVL|RATE|ROOM|PLAN|QUOT|AVAIL/i.test(f));
        return {
          status: res.status,
          bytes: text.length,
          functionNameCount: fns.length,
          rateishFns: rateish,
          sampleFns: fns.slice(0, 40),
        };
      } catch (e) {
        return {
          status: 0,
          bytes: 0,
          functionNameCount: 0,
          rateishFns: [],
          sampleFns: [],
          error: e instanceof Error ? e.name : 'fetch_failed',
        };
      }
    });
    structure.bsstrtProbe = bsstrtProbe;
    navProbe.push(
      `bsstrt:${bsstrtProbe.status}:fns=${bsstrtProbe.functionNameCount}:rateish=${(bsstrtProbe.rateishFns || []).join(',')}`,
    );

    // Soft-open any BSSTRT rateish functions (surface OPEN only).
    const bsstrtAlt: Record<string, unknown>[] = [];
    for (const fn of (bsstrtProbe.rateishFns || []).slice(0, 10)) {
      const probe = await page.evaluate(async (functionName) => {
        const body = new URLSearchParams({
          SYSTEM_FUNCTION_NAME: functionName,
          USER_FUNCTION_NAME: functionName,
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          FUNCTION_CLASS: 'WEBL',
          removescreenflows: 'yes',
        });
        try {
          const res = await fetch(
            `/web/base/${functionName}?FUNCTION_CLASS=WEBL&USER_FUNCTION_NAME=${functionName}`,
            {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: body.toString(),
            },
          );
          const text = await res.text();
          const names = [...text.matchAll(/\bname\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!);
          return {
            functionName,
            status: res.status,
            bytes: text.length,
            hasRoomtypes: /name\s*=\s*["']roomtypes["']/i.test(text),
            hasRateplans: /name\s*=\s*["']rateplans["']/i.test(text),
            hasLoginFields:
              /name\s*=\s*["']userid["']/i.test(text) &&
              /name\s*=\s*["']password["']/i.test(text),
            inputNames: [...new Set(names)].slice(0, 40),
          };
        } catch (e) {
          return {
            functionName,
            status: 0,
            bytes: 0,
            hasRoomtypes: false,
            hasRateplans: false,
            hasLoginFields: false,
            inputNames: [],
            error: e instanceof Error ? e.name : 'fetch_failed',
          };
        }
      }, fn);
      bsstrtAlt.push(probe);
      navProbe.push(
        `bsstrtOpen:${fn}:${probe.status}:roomtypes=${probe.hasRoomtypes}:rateplans=${probe.hasRateplans}`,
      );
    }
    structure.bsstrtAltOpenProbes = bsstrtAlt;

    // Also probe visible AVAILABILITY SUMMARY label (may be non-OSRRAV sibling).
    const availSummaryVisible = await page
      .locator('text=AVAILABILITY SUMMARY')
      .first()
      .isVisible()
      .catch(() => false);
    if (availSummaryVisible) {
      await page.click('text=AVAILABILITY SUMMARY', { timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(2_000);
      const afterSummary = await page.evaluate(() => {
        const text = document.body?.innerText?.slice(0, 4000) ?? '';
        const html = document.documentElement?.innerHTML?.slice(0, 50_000) ?? '';
        return {
          title: document.title,
          hasLogin: /name="userid"/i.test(html),
          functionNames: [
            ...new Set([...text.matchAll(/\b((?:OS|PS|AR)[A-Z0-9]{3,8})\b/g)].map((m) => m[1]!)),
          ].slice(0, 20),
          labels: text
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => /avail|rate|room|OSR|CRS|summary/i.test(l) && l.length < 80)
            .slice(0, 30),
        };
      });
      structure.availabilitySummaryProbe = afterSummary;
      navProbe.push(
        `availSummaryClick:login=${afterSummary.hasLogin}:fns=${(afterSummary.functionNames || []).join(',')}`,
      );
    }

    // Destructive form.submit open kept off — prior pass logged out the session.

    // Re-collect icons after nav (toolbar often hydrates post-menu).
    const iconsAfter = await page.evaluate(() =>
      [...document.querySelectorAll('img[src*="toolbar"], img[src*="availability"]')].map(
        (el) => (el as HTMLImageElement).getAttribute('src') ?? '',
      ),
    );
    structure.toolbarIconPaths = [
      ...new Set([
        ...(structure.toolbarIconPaths as string[]),
        ...iconsAfter
          .map((s) => {
            try {
              return new URL(s, origin).pathname;
            } catch {
              return s;
            }
          })
          .filter(Boolean),
      ]),
    ].slice(0, 80);

    const afterNav = await page.evaluate(() => document.body?.innerText?.slice(0, 8000) ?? '');
    const afterHtml = await page.content().catch(() => '');
    structure.hasRoomRateAvailabilityText =
      structure.hasRoomRateAvailabilityText ||
      /Room Type and Rate Availability|Room Rate Availability/i.test(afterNav) ||
      /name="roomtypes"|USER_FUNCTION_NAME["']?\s*[:=]\s*["']OSRRAV/i.test(afterHtml);
    structure.hasOsrravForm = /name="roomtypes"/i.test(afterHtml);
    structure.hasCrsText =
      Boolean(structure.hasCrsText) ||
      /CRS Check Availability/i.test(afterNav);
    structure.functionNames = [
      ...new Set(
        [...afterNav.matchAll(/\b((?:OS|PS|AR)[A-Z0-9]{3,8})\b/g)].map((m) => m[1]!),
      ),
    ].slice(0, 40);
    const labelsAfter = afterNav
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 2 && l.length < 80)
      .slice(0, 200);
    structure.menuLabelsSeen = [
      ...new Set([
        ...(structure.menuLabelsSeen as string[]),
        ...labelsAfter.filter((l) =>
          /Front Desk|Guest Stay|Availability|Rate|Room|CRS|Reserv|Sales/i.test(l),
        ),
      ]),
    ].slice(0, 80);

    const payload = {
      schemaVersion: 1,
      surface: 'room_type_rate_availability',
      discoveryOperationId: 'quote_availability_search',
      capturedAt: new Date().toISOString(),
      originHost: new URL(origin).host,
      structure,
      signatures: signatures.slice(0, 400),
      aborted: signatures.filter((s) => s.decision === 'abort').slice(0, 100),
      continued: signatures.filter((s) => s.decision === 'continue').slice(0, 100),
      valuesCaptured: false,
    };
    await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    // Finalize video: capture handle before close, then close page.
    const videoHandle = page.video();
    await page.close().catch(() => undefined);
    const videoPath = videoHandle ? await videoHandle.path().catch(() => null) : null;
    let videoSha256: string | null = null;
    if (videoPath) {
      const { createHash } = await import('node:crypto');
      const { readFile } = await import('node:fs/promises');
      const bytes = await readFile(videoPath);
      videoSha256 = createHash('sha256').update(bytes).digest('hex');
    }
    // stdout: counts + digests only (no PII)
    process.stdout.write(
      JSON.stringify({
        ok: true,
        outPath,
        videoDir,
        videoSha256,
        signatureCount: signatures.length,
        abortCount: signatures.filter((s) => s.decision === 'abort').length,
        hasRoomRateAvailabilityText: structure.hasRoomRateAvailabilityText,
        hasOsrravForm: Boolean(structure.hasOsrravForm),
        hasCrsText: structure.hasCrsText,
        osrravFetchStatus: Number(
          (structure.osrravFetchProbe as { status?: number } | undefined)?.status ?? 0,
        ),
        osrravFetchHasRoomtypes: Boolean(
          (structure.osrravFetchProbe as { hasRoomtypes?: boolean } | undefined)
            ?.hasRoomtypes,
        ),
        osrravFetchHasLogin: Boolean(
          (structure.osrravFetchProbe as { hasLoginFields?: boolean } | undefined)
            ?.hasLoginFields,
        ),
        osrravHdrFetchStatus: Number(
          (structure.osrravHdrFetchProbe as { status?: number } | undefined)?.status ?? 0,
        ),
        osrravHdrHasRoomtypes: Boolean(
          (structure.osrravHdrFetchProbe as { hasRoomtypes?: boolean } | undefined)
            ?.hasRoomtypes,
        ),
        altOpenCount: Array.isArray(structure.altOpenProbes)
          ? structure.altOpenProbes.length
          : 0,
        altOpenWithRoomtypes: Array.isArray(structure.altOpenProbes)
          ? structure.altOpenProbes.filter(
              (p) => (p as { hasRoomtypes?: boolean }).hasRoomtypes,
            ).length
          : 0,
        functionNameCount: (structure.functionNames as string[]).length,
        toolbarIconCount: (structure.toolbarIconPaths as string[]).length,
        navProbeCount: Array.isArray(structure.navProbe)
          ? structure.navProbe.length
          : 0,
      }) + '\n',
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : 'capture_failed';
  const safe = /password|secret|cookie|arn:aws/i.test(msg)
    ? 'redacted_error'
    : msg.slice(0, 200);
  process.stderr.write(`HMS_QUOTE_CAPTURE_FAIL ${safe}\n`);
  process.exitCode = 1;
});
