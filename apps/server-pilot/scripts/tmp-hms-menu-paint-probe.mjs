/**
 * Ephemeral live menu paint probe — no PII. Delete after canary green.
 */
import { requireHmsWorkerRuntimeConfig } from '../dist/env.js';
import { createProductionHmsRuntime } from '../dist/hms/production-runtime.js';
import { HmsRuntimeError } from '../dist/hms/runtime.js';

const cfg = requireHmsWorkerRuntimeConfig({
  ...process.env,
  HMS_DRAFT_ENRICHMENT_MODE: 'shadow',
  HMS_RUN_DEADLINE_MS: process.env.HMS_RUN_DEADLINE_MS || '120000',
});
const runtime = await createProductionHmsRuntime(cfg);
const signal = AbortSignal.timeout(Number(cfg.runDeadlineMs) || 120_000);
await runtime.start(signal);
const session = await runtime.openReadSession({
  transportId: cfg.expectedTransportId,
  signal,
  allowUnstarted: true,
});
const page = session.page;
const out = { steps: [] };
const push = (o) => out.steps.push(o);

try {
  const html = await page.content();
  push({
    t: 'post_login',
    url: page.url().replace(/[?#].*$/, ''),
    htmlHasFrontDesk: /Front Desk/i.test(html),
    htmlHasGuestStay: /Guest Stay/i.test(html),
  });

  for (let i = 0; i < 20; i += 1) {
    const painted = await page.evaluateStableDom(() => {
      const text = globalThis.document?.body?.innerText || '';
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      return {
        hasFD: lines.includes('Front Desk'),
        hasGS: lines.includes('Guest Stay'),
        sample: lines
          .filter((l) => /front|guest|desk|stay|reserv/i.test(l))
          .slice(0, 20),
      };
    });
    push({ t: 'paint', i, ...painted });
    if (painted.hasFD) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  try {
    await page.click('text=Front Desk');
    push({ t: 'fd_click_ok' });
  } catch (e) {
    push({ t: 'fd_click_err', msg: String(e.message || e).slice(0, 100) });
  }
  await new Promise((r) => setTimeout(r, 1500));

  const afterFd = await page.evaluateStableDom(() => {
    const text = globalThis.document?.body?.innerText || '';
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      hasGS: lines.includes('Guest Stay'),
      sample: lines
        .filter((l) => /guest|stay|reserv|front|desk/i.test(l))
        .slice(0, 30),
    };
  });
  push({ t: 'after_fd', ...afterFd });

  try {
    await page.click('text=Guest Stay');
    push({ t: 'gs_click_ok' });
  } catch (e) {
    push({ t: 'gs_click_err', msg: String(e.message || e).slice(0, 100) });
  }
  await new Promise((r) => setTimeout(r, 4000));

  const afterGs = await page.evaluateStableDom(() => {
    const doc = globalThis.document;
    const hasSearch = Boolean(
      doc?.querySelector?.(
        'input[name="search"], input[name="ff_confirmationnumber"]',
      ),
    );
    const text = doc?.body?.innerText || '';
    return {
      hasSearch,
      path: globalThis.location?.pathname,
      sample: text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /search|confirm|guest|stay|reserv/i.test(l))
        .slice(0, 25),
      ext: typeof globalThis.Ext,
      inforKeys: Object.keys(globalThis)
        .filter((k) => /infor|hms|OSRES|Ext/i.test(k))
        .slice(0, 30),
    };
  });
  push({ t: 'after_gs', ...afterGs });
} catch (e) {
  out.err =
    e instanceof HmsRuntimeError
      ? { code: e.code, msg: e.message.slice(0, 120) }
      : { msg: String(e).slice(0, 120) };
} finally {
  await session.close().catch(() => undefined);
  await runtime.close().catch(() => undefined);
}

console.log(JSON.stringify(out, null, 2));
