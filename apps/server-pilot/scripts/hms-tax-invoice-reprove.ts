/**
 * Tax Invoice re-prove (2026-08-07): menu-first, abort-first soft-capture.
 *
 * Order:
 *  1) Exact Front Desk > Tax Invoice menu click (no fn-code guesses first)
 *  2) Only if list path fails: Stay 360 tax tile from a find-opened stay
 * Print / Email / Resend / Generate always aborted.
 * Redacted structural signatures only — no PII / row values.
 *
 * Requires: HMS_DISCOVERY_ALLOW_LIVE=1, HMS_READ_SECRET_ARN, view_only secret.
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
  /** Structure-only: USER/SYSTEM function names from form body (codes, not values). */
  functionNames?: string[];
};

function redact(req: Request): Omit<RedactedSig, 'decision' | 'abortReason'> {
  const url = new URL(req.url());
  const headers = req.headers();
  const contentType =
    (headers['content-type'] ?? '').split(';', 1)[0]!.trim() || null;
  const raw = req.postData() ?? '';
  let bodyKeys: string[] = [];
  const functionNames: string[] = [];
  if (raw && (contentType === 'application/x-www-form-urlencoded' || !contentType)) {
    const params = new URLSearchParams(raw);
    bodyKeys = [...params.keys()];
    for (const k of ['USER_FUNCTION_NAME', 'SYSTEM_FUNCTION_NAME', 'GRID_NAME']) {
      const v = params.get(k);
      if (v && /^[A-Z0-9_.]{3,20}$/.test(v)) functionNames.push(v);
    }
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
    functionNames: functionNames.length ? functionNames : undefined,
  };
}

function shouldAbort(path: string, method: string): string | null {
  if (
    /(save|delete|duplicate|checkin|checkout|amend|cancel|post|settle|refund|send|resend|print|export|generate|submit|email|finalize|void)/i.test(
      path,
    )
  ) {
    return 'mutation_or_delivery_path';
  }
  if (method !== 'GET' && method !== 'POST' && method !== 'HEAD' && method !== 'OPTIONS') {
    return 'unsafe_method';
  }
  return null;
}

function isShellOrLoginPost(path: string, body: string): boolean {
  return (
    /\/session|\/login|j_security|Authenticate|BSSTRT|COMMON/i.test(path) ||
    /SYSTEM_FUNCTION_NAME|USER_FUNCTION_NAME/i.test(body)
  );
}

/** Unknown surface search/list — abort until preTransmissionEvidence exists. */
function isUnknownSurfaceSearch(path: string, body: string): boolean {
  if (/\.search$/i.test(path) && !/OSRESS\.search$/i.test(path)) return true;
  if (/GRIDRESULT|ONLY_DATA_REQUIRED|pageaction=search/i.test(body)) {
    // Allow proven OSRESS.search for Stay 360 fallback find-open only.
    if (/OSRESS/i.test(path) || /SYSTEM_FUNCTION_NAME=OSRESS/i.test(body)) {
      return false;
    }
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  if (process.env.HMS_DISCOVERY_ALLOW_LIVE !== '1') {
    throw new Error('refused: set HMS_DISCOVERY_ALLOW_LIVE=1');
  }
  const arn = process.env.HMS_READ_SECRET_ARN;
  if (!arn) throw new Error('HMS_READ_SECRET_ARN required');
  const outPath =
    process.env.HMS_TAX_INVOICE_REPROVE_OUT ??
    '/tmp/hms-tax-invoice-reprove.json';

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
    if (req.method() === 'POST') {
      const body = req.postData() ?? '';
      if (isUnknownSurfaceSearch(path, body)) {
        signatures.push({
          ...redact(req),
          decision: 'abort',
          abortReason: 'tax_invoice_search_needs_preTransmissionEvidence',
        });
        await route.abort();
        return;
      }
      if (!isShellOrLoginPost(path, body) && !/OSRESS/i.test(path)) {
        // Still record; allow shell-like WEBL opens from menu click so we can
        // observe the proven function code. Deny only if path looks like delivery.
        const looksDelivery =
          /(print|email|resend|generate|export|send)/i.test(path) ||
          /(print|email|resend|generate|export)/i.test(body);
        if (looksDelivery) {
          signatures.push({
            ...redact(req),
            decision: 'abort',
            abortReason: 'delivery_action_denied',
          });
          await route.abort();
          return;
        }
      }
    }
    signatures.push({ ...redact(req), decision: 'continue' });
    await route.continue();
  });

  const page = await ctx.newPage();
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    discoveryOperationId: 'tax_invoice_list',
    capturedAt: new Date().toISOString(),
    originHost: new URL(origin).host,
    menuPathAttempted: 'Front Desk > Tax Invoice',
    frontDeskListPath: null as null | Record<string, unknown>,
    stay360Fallback: null as null | Record<string, unknown>,
    verdict: 'pending',
    blockerCode: null as string | null,
  };

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

    // --- Menu harvest from BSSTRT (structure: labels + fn pairs) ---
    const menuHarvest = await page.evaluate(async () => {
      const blobs: string[] = [];
      for (const path of ['/web/base/BSSTRT', '/web/base/BSSTRT.HDR', '/web/base/BSSTRT.LST']) {
        try {
          const r = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: 'BSSTRT',
              USER_FUNCTION_NAME: 'BSSTRT',
              manurefresh: 'yes',
              FUNCTION_CLASS: 'WEBL',
              MENU_MODULE_KEY: '0',
              removescreenflows: 'yes',
            }).toString(),
            credentials: 'same-origin',
          });
          blobs.push(await r.text());
        } catch {
          /* ignore */
        }
      }
      const allLabels: string[] = [];
      const pairs: Array<{ label: string; fn: string }> = [];
      const frontDeskChildren: string[] = [];
      for (const text of blobs) {
        const labels = [...text.matchAll(/"itemLabel"\s*:\s*"([^"]+)"/g)].map(
          (x) => x[1]!,
        );
        for (const l of labels) allLabels.push(l);
        // Near-label fn extraction for Tax Invoice / Front Desk
        for (const hit of text.matchAll(
          /(Tax\s*Invoice|Sent Email|Guest Stay|Folio|Deposit Ledger|Property Ledger|Stay\s*360)[^A-Z0-9]{0,160}\b((?:PS|OS|AR|GS)[A-Z0-9]{3,10})\b|\b((?:PS|OS|AR|GS)[A-Z0-9]{3,10})\b[^A-Z0-9]{0,160}(Tax\s*Invoice|Sent Email|Guest Stay|Folio)/gi,
        )) {
          const label = (hit[1] || hit[4] || '').replace(/\s+/g, ' ').trim();
          const fn = (hit[2] || hit[3] || '').trim();
          if (label && fn) pairs.push({ label, fn });
        }
        // Chunk-based itemLabel + functionName pairs
        for (const chunk of text.split('{')) {
          const labelM = /"itemLabel"\s*:\s*"([^"]+)"/.exec(chunk);
          const fnM =
            /"(?:userFunction|systemFunction|functionName)"\s*:\s*"([A-Z0-9]{3,12})"/.exec(
              chunk,
            );
          if (labelM && fnM) {
            pairs.push({ label: labelM[1]!, fn: fnM[1]! });
          }
        }
      }
      const uniqLabels = [...new Set(allLabels)];
      const interesting = uniqLabels
        .filter((t) =>
          /tax|invoice|email|sent|folio|guest|deposit|ledger|stay|front\s*desk|print/i.test(
            t,
          ),
        )
        .slice(0, 100);
      // Approximate Front Desk children: labels that appear after Front Desk in list
      const fdIdx = uniqLabels.findIndex((l) => /^Front Desk$/i.test(l));
      if (fdIdx >= 0) {
        for (let i = fdIdx + 1; i < Math.min(fdIdx + 40, uniqLabels.length); i++) {
          const l = uniqLabels[i]!;
          if (/^(Group Sales|Administration|Reports|Accounts Receivable|Cashiering)$/i.test(l)) {
            break;
          }
          frontDeskChildren.push(l);
        }
      }
      const taxPairs = pairs.filter((p) => /tax\s*invoice/i.test(p.label));
      const seen = new Set<string>();
      const uniqPairs: Array<{ label: string; fn: string }> = [];
      for (const p of [...taxPairs, ...pairs]) {
        const k = `${p.label}|${p.fn}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (
          /tax|invoice|email|sent|folio|guest|deposit|stay|front/i.test(p.label) ||
          /TAX|INV|SNEL|RESS|FOLIO|DEP/i.test(p.fn)
        ) {
          uniqPairs.push(p);
        }
      }
      return {
        interestingLabels: interesting,
        frontDeskChildren: frontDeskChildren.slice(0, 40),
        taxInvoiceInLabels: uniqLabels.some((l) => /^Tax\s*Invoice$/i.test(l)),
        taxInvoiceSubstring: uniqLabels.some((l) => /Tax\s*Invoice/i.test(l)),
        taxInvoicePairs: taxPairs.slice(0, 10),
        pairs: uniqPairs.slice(0, 60),
      };
    });

    // --- DOM: expand Front Desk, enumerate children, exact Tax Invoice click ---
    await page
      .getByText('Front Desk', { exact: true })
      .first()
      .click({ force: true, timeout: 10_000 })
      .catch(() => undefined);
    await page.waitForTimeout(2_500);

    // Force tree expander on Front Desk node
    await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.x-tree-node')];
      for (const n of nodes) {
        const text = (n.textContent || '').trim();
        if (/Front Desk/i.test(text)) {
          const ec = n.querySelector(
            '.x-tree-ec-icon, .x-tree-elbow-plus, .x-tree-elbow-end-plus, img.x-tree-ec-icon',
          ) as HTMLElement | null;
          ec?.click();
        }
      }
    });
    await page.waitForTimeout(2_000);

    const treeBeforeClick = await page.evaluate(() => {
      const texts = [
        ...document.querySelectorAll(
          '.x-tree-node-text, .x-menu-item-text, .x-btn-inner, span, a',
        ),
      ]
        .map((el) => (el.textContent || '').trim())
        .filter((t) => t.length > 1 && t.length < 80);
      const uniq = [...new Set(texts)];
      return {
        taxInvoiceExactVisible: uniq.some((t) => /^Tax Invoice$/i.test(t)),
        taxInvoiceAnyVisible: uniq.some((t) => /Tax\s*Invoice/i.test(t)),
        allTreeLabels: uniq.slice(0, 120),
        frontDeskChildrenDom: uniq
          .filter((t) =>
            /tax|invoice|email|sent|folio|guest|deposit|ledger|stay|availability|room|rate|plan|summary/i.test(
              t,
            ),
          )
          .slice(0, 80),
        totalUniq: uniq.length,
      };
    });

    // MENU_MODULE_KEY sweep — structural labels only (role entitlement evidence)
    const moduleSweep = await page.evaluate(async () => {
      const found: Array<{
        moduleKey: number;
        status: number;
        bytes: number;
        hasTaxInvoice: boolean;
        taxishLabels: string[];
        sampleLabels: string[];
      }> = [];
      for (let k = 0; k <= 12; k++) {
        try {
          const r = await fetch('/web/base/BSSTRT', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              SYSTEM_FUNCTION_NAME: 'BSSTRT',
              USER_FUNCTION_NAME: 'BSSTRT',
              FUNCTION_CLASS: 'WEBL',
              MENU_MODULE_KEY: String(k),
              removescreenflows: 'yes',
              manurefresh: 'yes',
            }).toString(),
            credentials: 'same-origin',
          });
          const text = await r.text();
          const labels = [
            ...new Set(
              [...text.matchAll(/"itemLabel"\s*:\s*"([^"]+)"/g)].map(
                (m) => m[1]!,
              ),
            ),
          ];
          // Also plain-text menu strings
          const plain = [
            ...new Set(
              [
                ...text.matchAll(
                  /(Tax\s*Invoice|Sent Email|Guest Stay|Folio|Deposit Ledger|Stay\s*360|Room Plan|Availability)/gi,
                ),
              ].map((m) => m[1]!.replace(/\s+/g, ' ')),
            ),
          ];
          found.push({
            moduleKey: k,
            status: r.status,
            bytes: text.length,
            hasTaxInvoice:
              labels.some((l) => /Tax\s*Invoice/i.test(l)) ||
              /Tax\s*Invoice/i.test(text),
            taxishLabels: [...labels, ...plain]
              .filter((l) => /tax|invoice|email|sent|folio|guest|deposit|stay/i.test(l))
              .slice(0, 30),
            sampleLabels: labels.slice(0, 20),
          });
        } catch {
          found.push({
            moduleKey: k,
            status: 0,
            bytes: 0,
            hasTaxInvoice: false,
            taxishLabels: [],
            sampleLabels: [],
          });
        }
      }
      return found;
    });
    (report as Record<string, unknown>).moduleSweep = moduleSweep;

    const sigBeforeTaxClick = signatures.length;
    let taxInvoiceClicked = false;
    if (treeBeforeClick.taxInvoiceExactVisible || treeBeforeClick.taxInvoiceAnyVisible) {
      const clicked = await page
        .getByText('Tax Invoice', { exact: true })
        .first()
        .click({ force: true, timeout: 10_000 })
        .then(() => true)
        .catch(async () => {
          await page
            .locator('text=Tax Invoice')
            .first()
            .click({ force: true, timeout: 5_000 })
            .catch(() => undefined);
          return true;
        });
      taxInvoiceClicked = Boolean(clicked);
      await page.waitForTimeout(4_000);
    }

    const afterTaxClick = await page.evaluate(() => {
      const body = document.body?.innerText?.slice(0, 8000) ?? '';
      return {
        hasTaxInvoiceLabel: /Tax\s*Invoice/i.test(body),
        hasPrintAction: /\bPrint\b/i.test(body),
        hasEmailAction: /\bE-?mail\b/i.test(body),
        hasResendAction: /\bResend\b/i.test(body),
        hasGenerateAction: /\bGenerate\b/i.test(body),
        hasGuestStayTaxInvoicing: /Guest Stay Tax Invoic/i.test(body),
        title: document.title || null,
        interestingLines: body
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 2 && l.length < 80)
          .filter((l) =>
            /tax|invoice|print|email|resend|folio|guest|front desk|sent/i.test(l),
          )
          .slice(0, 40),
      };
    });

    const postsAfterTaxClick = signatures
      .slice(sigBeforeTaxClick)
      .filter((s) => s.method === 'POST')
      .map((s) => ({
        path: s.path,
        decision: s.decision,
        abortReason: s.abortReason,
        functionNames: s.functionNames,
        bodyKeys: s.bodyKeys.slice(0, 30),
      }));

    const observedFnsFromMenu = [
      ...new Set(
        postsAfterTaxClick
          .flatMap((p) => p.functionNames ?? [])
          .concat(
            postsAfterTaxClick
              .map((p) => p.path.split('/').pop()?.split('.')[0] ?? '')
              .filter((f) => /^[A-Z]{2}[A-Z0-9]{2,10}$/.test(f)),
          ),
      ),
    ].filter((f) => f && f !== 'BSSTRT' && f !== 'COMMON' && f !== 'login');

    const listPathProven =
      taxInvoiceClicked &&
      (menuHarvest.taxInvoiceInLabels ||
        treeBeforeClick.taxInvoiceExactVisible ||
        afterTaxClick.hasTaxInvoiceLabel) &&
      observedFnsFromMenu.length > 0;

    report.frontDeskListPath = {
      menuHarvest,
      treeBeforeClick,
      taxInvoiceClicked,
      afterTaxClick,
      postsAfterTaxClick: postsAfterTaxClick.slice(0, 40),
      observedFunctionCodes: observedFnsFromMenu,
      listPathProven,
      deniedActionsPresent: {
        print: afterTaxClick.hasPrintAction,
        email: afterTaxClick.hasEmailAction,
        resend: afterTaxClick.hasResendAction,
        generate: afterTaxClick.hasGenerateAction,
      },
      note: 'Print/Email/Resend/Generate remain denied even if UI shows them',
    };

    // --- Stay 360 fallback ONLY if Front Desk list path failed ---
    // Menu label "STAY 360" ≠ Stay 360 chrome on find-opened stay.
    // Always find-open a Guest Stay row first, then look for Tax Invoice tile.
    if (!listPathProven) {
      const stay360: Record<string, unknown> = {
        attempted: true,
        reason: 'front_desk_tax_invoice_list_unproven',
      };
      const sigBeforeStay = signatures.length;

      // Prefer Guest Stay menu; fall back to OSRESS open.
      const guestStayClicked = await page
        .getByText('Guest Stay', { exact: true })
        .first()
        .click({ force: true, timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      stay360.guestStayClicked = guestStayClicked;
      await page.waitForTimeout(3_000);

      const osressOpen = await page.evaluate(async () => {
        const body = new URLSearchParams({
          USER_FUNCTION_NAME: 'OSRESS',
          SYSTEM_FUNCTION_NAME: 'OSRESS',
          FUNCTION_CLASS: 'WEBL',
          CURRENT_TAB_NAME: '',
          MENU_MODULE_KEY: '0',
          removescreenflows: 'yes',
        });
        const r = await fetch('/web/base/OSRESS', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          credentials: 'same-origin',
        });
        const text = await r.text();
        return {
          status: r.status,
          bytes: text.length,
          hasTaxInvoice: /Tax\s*Invoice/i.test(text),
          hasStay360: /Stay\s*360/i.test(text),
          toolbarTaxish: [
            ...new Set(
              [...text.matchAll(/"label"\s*:\s*"([^"]{1,60})"/g)].map(
                (m) => m[1]!,
              ),
            ),
          ]
            .filter((l) => /tax|invoice|stay\s*360|print|email/i.test(l))
            .slice(0, 20),
          fnEchoes: [
            ...new Set(
              [...text.matchAll(/\b((?:PS|OS|AR)[A-Z0-9]{3,10})\b/g)].map(
                (m) => m[1]!,
              ),
            ),
          ].slice(0, 30),
        };
      });
      stay360.osressOpen = osressOpen;
      await page.waitForTimeout(2_500);

      // Inventory toolbar/title attributes only (no cell values).
      const inventoryChrome = () =>
        page.evaluate(() => {
          const texts = [
            ...document.querySelectorAll(
              '.x-btn-inner, .x-menu-item-text, .x-tab-strip-text, .x-tree-node-text, [title], [aria-label], img[alt]',
            ),
          ].map((el) => {
            const t = (el.textContent || '').trim();
            const title = el.getAttribute('title') || '';
            const alt = el.getAttribute('alt') || '';
            const aria = el.getAttribute('aria-label') || '';
            return [t, title, alt, aria].filter(Boolean).join(' | ');
          });
          const uniq = [...new Set(texts)].filter(
            (t) => t.length > 1 && t.length < 100,
          );
          return {
            taxInvoiceTileVisible: uniq.some((t) => /Tax\s*Invoice/i.test(t)),
            stay360Visible: uniq.some((t) => /Stay\s*360/i.test(t)),
            guestStayTaxInvoicingVisible: uniq.some((t) =>
              /Guest Stay Tax Invoic/i.test(t),
            ),
            interesting: uniq
              .filter((t) =>
                /tax|invoice|stay\s*360|print|email|resend|folio|guest stay/i.test(
                  t,
                ),
              )
              .slice(0, 50),
          };
        });

      stay360.stayDomBeforeOpen = await inventoryChrome();

      const gridMeta = await page.evaluate(() => {
        const rows = document.querySelectorAll(
          '.x-grid3-row, .x-grid-row, tr.x-grid3-row',
        );
        return { rowCount: rows.length };
      });
      stay360.gridMeta = gridMeta;

      let taxTileClicked = false;
      // Find-open first: dblclick row to expose Stay 360 chrome on an open stay.
      if (gridMeta.rowCount > 0) {
        await page
          .locator('.x-grid3-row, .x-grid-row')
          .first()
          .dblclick({ timeout: 8_000 })
          .catch(async () => {
            await page
              .locator('.x-grid3-row, .x-grid-row')
              .first()
              .click({ force: true, timeout: 5_000 })
              .catch(() => undefined);
          });
        await page.waitForTimeout(4_000);
        stay360.afterFindOpen = await inventoryChrome();
      } else {
        stay360.afterFindOpen = null;
        stay360.findOpenSkipped = 'no_grid_rows';
      }

      const chromeAfterOpen =
        (stay360.afterFindOpen as Record<string, unknown> | null) ??
        (stay360.stayDomBeforeOpen as Record<string, unknown>);

      if (chromeAfterOpen.taxInvoiceTileVisible) {
        await page
          .locator('[title*="Tax Invoice" i], [aria-label*="Tax Invoice" i]')
          .first()
          .click({ force: true, timeout: 8_000 })
          .then(() => {
            taxTileClicked = true;
          })
          .catch(async () => {
            await page
              .getByText(/Tax Invoice/i)
              .first()
              .click({ force: true, timeout: 5_000 })
              .then(() => {
                taxTileClicked = true;
              })
              .catch(() => undefined);
          });
        await page.waitForTimeout(3_000);
      } else if (chromeAfterOpen.stay360Visible) {
        // Click Stay 360 control that is NOT the Front Desk menu label if possible
        await page
          .locator(
            '.x-btn-inner:text-matches("STAY 360", "i"), [title*="Stay 360" i]',
          )
          .first()
          .click({ force: true, timeout: 8_000 })
          .catch(async () => {
            await page
              .getByText(/Stay 360/i)
              .first()
              .click({ force: true, timeout: 5_000 })
              .catch(() => undefined);
          });
        await page.waitForTimeout(3_000);
        stay360.afterStay360Click = await inventoryChrome();
        const afterS360 = stay360.afterStay360Click as Record<string, unknown>;
        if (afterS360.taxInvoiceTileVisible) {
          await page
            .locator('[title*="Tax Invoice" i], [aria-label*="Tax Invoice" i]')
            .first()
            .click({ force: true, timeout: 8_000 })
            .then(() => {
              taxTileClicked = true;
            })
            .catch(async () => {
              await page
                .getByText(/Tax Invoice/i)
                .first()
                .click({ force: true, timeout: 5_000 })
                .then(() => {
                  taxTileClicked = true;
                })
                .catch(() => undefined);
            });
          await page.waitForTimeout(3_000);
        }
      }

      const afterTile = await page.evaluate(() => {
        const body = document.body?.innerText?.slice(0, 6000) ?? '';
        return {
          hasTaxInvoiceLabel: /Tax\s*Invoice/i.test(body),
          hasGuestStayTaxInvoicing: /Guest Stay Tax Invoic/i.test(body),
          hasPrintAction: /\bPrint\b/i.test(body),
          hasEmailAction: /\bE-?mail\b/i.test(body),
          hasResendAction: /\bResend\b/i.test(body),
          hasGenerateAction: /\bGenerate\b/i.test(body),
          interestingLines: body
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 2 && l.length < 80)
            .filter((l) =>
              /tax|invoice|print|email|resend|stay\s*360|guest stay/i.test(l),
            )
            .slice(0, 30),
        };
      });

      const postsAfterStay = signatures
        .slice(sigBeforeStay)
        .filter((s) => s.method === 'POST')
        .map((s) => ({
          path: s.path,
          decision: s.decision,
          abortReason: s.abortReason,
          functionNames: s.functionNames,
        }));

      const stayFns = [
        ...new Set(
          postsAfterStay
            .flatMap((p) => p.functionNames ?? [])
            .concat(
              postsAfterStay
                .map((p) => p.path.split('/').pop()?.split('.')[0] ?? '')
                .filter((f) => /^[A-Z]{2}[A-Z0-9]{2,10}$/.test(f)),
            ),
        ),
      ].filter(
        (f) =>
          f &&
          f !== 'BSSTRT' &&
          f !== 'COMMON' &&
          f !== 'login' &&
          f !== 'OSRESS',
      );

      stay360.taxTileClicked = taxTileClicked;
      stay360.afterTile = afterTile;
      stay360.postsAfterStay = postsAfterStay.slice(0, 40);
      stay360.observedFunctionCodes = stayFns;
      stay360.stay360PathProven =
        taxTileClicked &&
        (afterTile.hasTaxInvoiceLabel || afterTile.hasGuestStayTaxInvoicing) &&
        stayFns.length > 0;
      stay360.deniedActionsPresent = {
        print: afterTile.hasPrintAction,
        email: afterTile.hasEmailAction,
        resend: afterTile.hasResendAction,
        generate: afterTile.hasGenerateAction,
      };
      stay360.note =
        'Stay 360 path is detail-adjacent; still deny print/email/resend/generate. List-only Front Desk preferred.';

      report.stay360Fallback = stay360;
    }

    // --- Verdict ---
    const fd = report.frontDeskListPath as Record<string, unknown>;
    const s360 = report.stay360Fallback as Record<string, unknown> | null;
    if (fd.listPathProven) {
      report.verdict = 'proven_front_desk_list';
      report.blockerCode = null;
      report.provenFunctionCodes = fd.observedFunctionCodes;
      report.menuPathUsed = 'Front Desk > Tax Invoice';
    } else if (s360 && s360.stay360PathProven) {
      // Detail-adjacent: capture evidence but do NOT auto-promote as list-only tool
      report.verdict = 'proven_stay360_detail_adjacent_hold';
      report.blockerCode = 'BLOCKED_TAX_INVOICE_LIST_ONLY_UNPROVEN';
      report.provenFunctionCodes = s360.observedFunctionCodes;
      report.menuPathUsed = 'Guest Stay > Stay 360 > Tax Invoice (fallback)';
      report.holdReason =
        'Stay 360 Tax Invoice opens Guest Stay Tax Invoicing tab (detail-adjacent); Phase B list-only Front Desk path still unproven. Keep fail-closed for list branch.';
    } else {
      report.verdict = 'blocked';
      report.blockerCode = 'BLOCKED_TAX_INVOICE_SURFACE_UNPROVEN';
      report.menuPathUsed = 'Front Desk > Tax Invoice (absent or no fn observed)';
      report.rcaHints = {
        taxInvoiceInMenuHarvest: menuHarvest.taxInvoiceInLabels,
        taxInvoiceInDom: treeBeforeClick.taxInvoiceExactVisible,
        frontDeskChildrenHarvest: menuHarvest.frontDeskChildren,
        frontDeskChildrenDom: treeBeforeClick.frontDeskChildrenDom,
        allTreeLabels: treeBeforeClick.allTreeLabels,
        taxInvoicePairs: menuHarvest.taxInvoicePairs,
        moduleSweepTaxHits: (
          (report as Record<string, unknown>).moduleSweep as Array<{
            moduleKey: number;
            hasTaxInvoice: boolean;
            taxishLabels: string[];
          }>
        )
          ?.filter((m) => m.hasTaxInvoice || m.taxishLabels.length > 0)
          .slice(0, 15),
        stay360Attempted: Boolean(s360),
        stay360Tile: s360
          ? (s360.stayDomBeforeOpen as Record<string, unknown> | undefined)
          : null,
        stay360AfterFindOpen: s360
          ? (s360.afterFindOpen as Record<string, unknown> | undefined)
          : null,
      };
    }

    const payload = {
      ...report,
      abortSummary: signatures
        .filter((s) => s.decision === 'abort')
        .reduce<Record<string, number>>((acc, s) => {
          const key = s.abortReason ?? 'unknown';
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
      continuedPostPaths: [
        ...new Set(
          signatures
            .filter((s) => s.decision === 'continue' && s.method === 'POST')
            .map((s) => s.path),
        ),
      ].slice(0, 60),
      abortedPostPaths: [
        ...new Set(
          signatures
            .filter((s) => s.decision === 'abort' && s.method === 'POST')
            .map((s) => `${s.path}:${s.abortReason ?? ''}`),
        ),
      ].slice(0, 80),
      signatures: signatures.slice(0, 400),
    };

    await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
    });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ok: true,
        outPath,
        verdict: report.verdict,
        blockerCode: report.blockerCode,
        menuPathUsed: report.menuPathUsed,
        provenFunctionCodes: report.provenFunctionCodes ?? [],
        listPathProven: fd.listPathProven,
        stay360PathProven: s360?.stay360PathProven ?? false,
        abortSummary: payload.abortSummary,
      }),
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
