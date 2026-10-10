/**
 * Shared pieces of the AE1 and AE2 live-proof drivers (nava-ae1-rates-proof.ts, nava-ae2-find-proof.ts): the browser
 * launch with a request guard, the pane settle, masked screenshots and the proposal Excel reader. The AE4 driver
 * (nava-ae4-override-proof.ts) supplies the tRPC parsing and the wait helpers.
 *
 * Nothing here prints page text. Screenshots mask every guest detail the way nava-preview-run.ts does.
 */
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response, type Route } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import {
  Blocker,
  decodeXml,
  parseTrpcBatch,
  readPane,
  waitFor,
  type Captured,
} from './nava-ae4-override-proof';
import { fitPaneToContent, MARK_PII_JS, outcomeOf, PII_SELECTOR, type RunConfig } from './nava-preview-run';

export {
  allowEditsFrom,
  browserMailboxApi,
  mailboxFailures,
  MailboxSwitchError,
  needsEditsMessage,
  newMailboxPermit,
  newMailboxSwitch,
  withActiveMailbox,
  withMailboxPermit,
  type MailboxRecord,
  type MailboxSwitch,
} from './nava-proof-safety';

export const SETTLE_MS = 120_000;
export const STEP_MS = 30_000;
export const DOC_MS = 180_000;
export const VIEWPORT = { width: 1600, height: 1000 };

/** What a guard says about one tRPC request. A batch goes only when every call in it may. */
export type GuardDecision<Reason extends string = string> = {
  allowed: boolean;
  procedures: string[];
  blocked: Array<{ procedure: string; reason: Reason }>;
};

export type ProofPage = { browser: Browser; context: BrowserContext; page: Page; captured: Captured };

/**
 * Launches Chromium with the run's session and pins the host, as nava-preview-run.ts does. Every tRPC request from any
 * page of the context (the pane's page and the driver's own mailbox page) goes through `classify`; a refused one is
 * aborted and listed in captured.blocked. Every tRPC response of the pane's page is split into captured.outcomes. Any
 * other request (the app shell, assets) is left alone.
 */
export async function openProofPage(
  config: RunConfig,
  classify: (url: string, postData: string | null) => GuardDecision,
): Promise<ProofPage> {
  const host = new URL(config.baseUrl).hostname;
  const browser = await chromium.launch({
    headless: true,
    args: config.resolveTo ? [`--host-resolver-rules=MAP ${host} ${config.resolveTo}`] : [],
    ignoreDefaultArgs: ['--hide-scrollbars'],
    ...(config.chromiumPath ? { executablePath: config.chromiumPath } : {}),
  });
  const captured: Captured = { outcomes: [], blocked: [] };
  try {
    const context = await browser.newContext({
      storageState: config.storageStatePath,
      viewport: VIEWPORT,
      acceptDownloads: false,
      ...(config.transportId ? { extraHTTPHeaders: { 'x-zero-active-transport': config.transportId } } : {}),
    });
    await context.route('**/api/trpc/**', async (route: Route) => {
      const request: Request = route.request();
      const decision = classify(request.url(), request.postData());
      if (decision.allowed) {
        await route.continue();
        return;
      }
      for (const item of decision.blocked) captured.blocked.push(`${item.procedure} (${item.reason})`);
      await route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('response', (response: Response) => {
      const url = response.url();
      if (!url.includes('/api/trpc/')) return;
      void response
        .text()
        .then((body) => {
          captured.outcomes.push(...parseTrpcBatch(url, body));
        })
        .catch(() => undefined);
    });
    return { browser, context, page, captured };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/** Opens the thread in /nava-preview and waits until the pane has read it (the "Nava is reading" line is gone). */
export async function openThread(page: Page, baseUrl: string, threadId: string): Promise<void> {
  await page.goto(`${baseUrl}/nava-preview?thread=${encodeURIComponent(threadId)}`, { waitUntil: 'domcontentloaded' });
  if (new URL(page.url()).pathname.startsWith('/login')) throw new Blocker('the storage state has no session');
  await waitFor('the pane to read the email', SETTLE_MS, async () => {
    const read = await readPane(page, threadId);
    const outcome = read ? outcomeOf(read) : null;
    if (outcome === 'unsynced' || outcome === 'error') throw new Blocker(`pane ${outcome}`);
    return outcome;
  });
}

/**
 * Screenshots of the pane and of parts of it, guest details masked ([data-pii], guest fields, emails and phone numbers).
 * `shots` maps a file stem to a selector; "pane" is always the whole pane. Returns which files were written.
 */
export async function captureShots(
  page: Page,
  outDir: string,
  shots: Record<string, string>,
): Promise<Record<string, boolean>> {
  await fitPaneToContent(page);
  await page.evaluate(`(${MARK_PII_JS})()`).catch(() => 0);
  const mask = [page.locator(`[data-runner-mask], ${PII_SELECTOR}`)];
  const written: Record<string, boolean> = {};
  for (const [name, selector] of Object.entries({ pane: '[data-preview-pane]', ...shots })) {
    const path = join(outDir, `${name}.png`);
    await page
      .locator(selector)
      .first()
      .screenshot({ path, mask, timeout: 15_000 })
      .catch(() => undefined);
    written[name] = existsSync(path);
  }
  await page.setViewportSize(VIEWPORT).catch(() => undefined);
  return written;
}

/** Guard blocks that are not on the mode's expected list. Each is a failure: the pane tried something the proof forbids. */
export function unexpectedBlocks(blocked: readonly string[], expected: readonly string[]): string[] {
  return blocked.filter((entry) => !expected.includes(entry));
}

// ---------------------------------------------------------------------------------------------------------------------
// Proposal Excel

export type SheetCell = { text: string | null; value: string | null; formula: string | null };
/** Row number -> column letters -> cell. */
export type SheetRows = Map<number, Map<string, SheetCell>>;

/** The first worksheet's cells, shared strings resolved. Styles and drawings are not read. */
export function xlsxSheetRows(bytes: Uint8Array): SheetRows {
  const files = unzipSync(bytes, {
    filter: (file) => file.name === 'xl/sharedStrings.xml' || file.name === 'xl/worksheets/sheet1.xml',
  });
  const sheet = files['xl/worksheets/sheet1.xml'];
  if (!sheet) throw new Error('the workbook has no first sheet');
  const shared: string[] = [];
  const sharedXml = files['xl/sharedStrings.xml'];
  if (sharedXml) {
    for (const item of strFromU8(sharedXml).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const parts = [...item[1]!.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]!));
      shared.push(parts.join(''));
    }
  }
  const rows: SheetRows = new Map();
  for (const cell of strFromU8(sheet).matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = cell[1] ?? '';
    const inner = cell[2] ?? '';
    const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
    if (!ref) continue;
    const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? null;
    const formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(inner)?.[1] ?? null;
    const inline = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]!));
    let text: string | null = inline.length ? inline.join('') : null;
    if (/\bt="s"/.test(attrs) && value !== null) text = shared[Number(value)] ?? null;
    const row = Number(ref[2]);
    if (!rows.has(row)) rows.set(row, new Map());
    rows.get(row)!.set(ref[1]!, {
      text,
      value: /\bt="s"/.test(attrs) ? null : value === null ? null : decodeXml(value),
      formula: formula === null ? null : decodeXml(formula),
    });
  }
  return rows;
}

export type WorkbookCount = {
  /** Priced line rows (QTY x NIGHTS x RATE) with a quantity. */
  lines: number;
  /** Line rows for a room ("… per room …"): one per stay x room, or more when a room's nightly rate changes. */
  roomLines: number;
  /** Line rows for an authorised extra (dinner, shuttle and the like). */
  extraLines: number;
  /** Subtotal rows (SUM over the line block). The proposal has exactly one. */
  totalRows: number;
  /** The one subtotal equals the sum of the line totals (cached values). Null without exactly one subtotal. */
  totalMatches: boolean | null;
};

const num = (cell: SheetCell | undefined): number | null => {
  const raw = cell?.value?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

/**
 * Counts the proposal's line rows and its total row (quote-workbook.ts). A line row has the template's line formula
 * +B<r>*F<r>*G<r> in H and a quantity in B; an unused template row keeps the formula but has no quantity. The subtotal is
 * the one SUM(H…:H…) row.
 */
export function countWorkbookLines(rows: SheetRows): WorkbookCount {
  let lines = 0;
  let roomLines = 0;
  let lineSum = 0;
  const totals: number[] = [];
  for (const [row, cells] of rows) {
    const formula = cells.get('H')?.formula?.replace(/\s+/g, '') ?? '';
    if (new RegExp(`^\\+?B${row}\\*F${row}\\*G${row}$`).test(formula)) {
      const qty = num(cells.get('B'));
      if (qty === null || qty <= 0) continue;
      lines += 1;
      if (/\bper room\b/i.test(cells.get('C')?.text ?? '')) roomLines += 1;
      lineSum += num(cells.get('H')) ?? 0;
      continue;
    }
    if (/^SUM\(H\d+:H\d+\)$/i.test(formula)) totals.push(num(cells.get('H')) ?? Number.NaN);
  }
  return {
    lines,
    roomLines,
    extraLines: lines - roomLines,
    totalRows: totals.length,
    totalMatches: totals.length === 1 ? Math.abs(totals[0]! - lineSum) < 0.005 : null,
  };
}

/** How many Excel lines one room row makes: one per run of nights at the same rate (quote-lines.ts deriveQuoteLines). */
export function rateSegments(nightlyMinor: readonly number[]): number {
  let segments = 0;
  nightlyMinor.forEach((amount, index) => {
    if (index === 0 || amount !== nightlyMinor[index - 1]) segments += 1;
  });
  return segments;
}
