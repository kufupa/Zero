/**
 * Real-browser gate for the /nava-preview viewer. Read-only: it opens each thread, waits
 * for the pane's analysis to settle, takes screenshots, and records what the pane shows.
 *
 * It never clicks a control. Every tRPC request that is not a GET is aborted unless it is
 * quoteWorkflow.analyseSelection (the analysis read), so no HMS or mailbox write can start.
 * Aborted requests are listed per thread in results.json.
 *
 * Environment (values are never printed):
 *   NAVA_PREVIEW_BASE_URL       origin of the app, e.g. https://pilot.example
 *   NAVA_PREVIEW_STORAGE_STATE  Playwright storageState JSON holding a staff session
 *   NAVA_PREVIEW_CHROMIUM       optional path to a Chromium binary
 *
 * Usage (from the repo root):
 *   pnpm --dir apps/server-pilot exec tsx scripts/nava-preview-run.ts --latest 5
 *   pnpm --dir apps/server-pilot exec tsx scripts/nava-preview-run.ts --threads id1,id2 --out out/run-1
 *
 * Output: <out>/results.json, <out>/index.html (gallery), <out>/threads/<id>/{pane,page}.png
 */
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_TIMEOUT_MS = 90_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_LATEST = 50;
const LIST_TIMEOUT_MS = 30_000;
const POLL_MS = 1_000;
const MAX_FIELDS = 60;
const MAX_BANNERS = 12;
const MAX_BLOCKED = 20;
/**
 * tRPC queries the viewer and the pane call. Classified by procedure name, not HTTP method:
 * the app sends queries as POST (methodOverride). A batched path lists every procedure, so one
 * write in a batch blocks the whole request. tests/nava-preview-trpc-classes.test.ts checks
 * these names against the server router and against the pane's client code.
 */
export const READ_PROCEDURES: ReadonlySet<string> = new Set([
  'brain.getCapabilities',
  'connections.getDefault',
  'connections.list',
  'drafts.get',
  'drafts.list',
  'mail.get',
  'mail.listThreads',
  'paneStayCancel.paneStayScreenshot',
  'paneStayLookup.screenshot',
  'workstation.getPriorStaffQuoteRequote',
  'workstation.hmsQueueStatus',
  'workstation.listThreadQuoteRevisions',
  'workstation.outlookSync.status',
  'workstation.quoteRunScreenshot',
  'workstation.staffQuoteSource',
]);
/** The one mutation the viewer may call: a read-only analysis (cache and ledger rows, no HMS, no mail). */
export const ANALYSIS_PROCEDURES: ReadonlySet<string> = new Set(['quoteWorkflow.analyseSelection']);
/** Mutations the pane references. Named so a block reads as a write. Any other name is blocked as unknown. */
export const KNOWN_WRITE_PROCEDURES: ReadonlySet<string> = new Set([
  'paneStayLookup.findStay',
  'paneStayLookup.searchGuest',
  'quoteWorkflow.commitStay',
  'quoteWorkflow.previewStay',
  'workstation.bridgeTicket',
  'workstation.executeStaffQuote',
  'workstation.outlookSync.activate',
  'workstation.outlookSync.control',
  'workstation.ping',
  'workstation.prepareBookingDraft',
  'workstation.qualifiedQuoteProposalPdf',
  'workstation.reportBridgeFailure',
  'workstation.usePriorQuoteForBooking',
]);

export type TrpcDecision = {
  allowed: boolean;
  procedures: string[];
  blocked: Array<{ procedure: string; reason: 'write' | 'unknown' }>;
};

const TRPC_PREFIX = '/api/trpc/';

/**
 * Classifies one request by the procedure names in its /api/trpc/ path, batched or not.
 * The HTTP method is not an input: a query sent as POST is still a read.
 */
export function classifyTrpcRequest(url: string): TrpcDecision {
  const { pathname } = new URL(url);
  const procedures = pathname.startsWith(TRPC_PREFIX)
    ? pathname.slice(TRPC_PREFIX.length).split(',').filter(Boolean)
    : [];
  if (procedures.length === 0) {
    return { allowed: false, procedures, blocked: [{ procedure: '(none)', reason: 'unknown' }] };
  }
  const blocked: TrpcDecision['blocked'] = [];
  for (const procedure of procedures) {
    if (READ_PROCEDURES.has(procedure) || ANALYSIS_PROCEDURES.has(procedure)) continue;
    blocked.push({
      procedure,
      reason: KNOWN_WRITE_PROCEDURES.has(procedure) ? 'write' : 'unknown',
    });
  }
  return { allowed: blocked.length === 0, procedures, blocked };
}
const THREAD_ID_PATTERN = /^[A-Za-z0-9_.:~@-]{1,128}$/;

export type Outcome = 'intent' | 'fallback' | 'error' | 'unsynced' | 'timeout';
export type RunSelection = { kind: 'latest'; count: number } | { kind: 'threads'; ids: string[] };
export type RunConfig = {
  baseUrl: string;
  storageStatePath: string;
  chromiumPath: string | null;
  selection: RunSelection;
  outDir: string;
  timeoutMs: number;
};
export type PrefilledField = { field: string; value: string };
export type ThreadResult = {
  threadId: string;
  subject: string;
  outcome: Outcome;
  paneStatus: string;
  unsyncedReason: string | null;
  intent: string | null;
  amendment: string | null;
  aiUnavailable: boolean;
  prefilled: PrefilledField[];
  party: string[];
  banners: string[];
  blockedWrites: string[];
  screenshots: { pane: string | null; page: string | null };
  elapsedMs: number;
};

/** Emails and phone-like digit runs (9 to 15 digits) are redacted; dates and small counts are not. */
export function redactText(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, (match) => {
      const digits = match.replace(/\D/g, '').length;
      return digits >= 9 && digits <= 15 ? '[phone]' : match;
    });
}

/** A thread id as a directory name. Ids are already restricted; this only guards the output path. */
export function safeSegment(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96) || 'thread';
}

function parseCount(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error('--latest needs a whole number');
  const count = Number(raw);
  if (count < 1 || count > MAX_LATEST) throw new Error(`--latest must be 1 to ${MAX_LATEST}`);
  return count;
}

function argValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

/**
 * Validates the environment and arguments. Error messages never echo a secret or the
 * storage-state path.
 */
export function parseRunConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  now: Date = new Date(),
): RunConfig {
  const rawBase = env.NAVA_PREVIEW_BASE_URL?.trim() ?? '';
  let base: URL;
  try {
    base = new URL(rawBase);
  } catch {
    throw new Error('NAVA_PREVIEW_BASE_URL must be an absolute http(s) origin');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('NAVA_PREVIEW_BASE_URL must be http or https');
  }
  if (base.username || base.password)
    throw new Error('NAVA_PREVIEW_BASE_URL must not carry credentials');

  const storageStatePath = env.NAVA_PREVIEW_STORAGE_STATE?.trim() ?? '';
  if (!storageStatePath || !existsSync(storageStatePath) || !statSync(storageStatePath).isFile()) {
    throw new Error('NAVA_PREVIEW_STORAGE_STATE must point to an existing storageState file');
  }

  const latest = argValue(argv, '--latest');
  const threads = argValue(argv, '--threads');
  if ((latest === null) === (threads === null)) {
    throw new Error('Choose exactly one of --latest N or --threads id1,id2');
  }
  let selection: RunSelection;
  if (latest !== null) {
    selection = { kind: 'latest', count: parseCount(latest) };
  } else {
    const ids = (threads ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0 || ids.length > MAX_LATEST)
      throw new Error(`--threads needs 1 to ${MAX_LATEST} ids`);
    if (!ids.every((id) => THREAD_ID_PATTERN.test(id)))
      throw new Error('--threads has an invalid thread id');
    selection = { kind: 'threads', ids };
  }

  const timeoutRaw = argValue(argv, '--timeout-ms');
  const timeoutMs = timeoutRaw === null ? DEFAULT_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`--timeout-ms must be ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
  }

  const outRaw = argValue(argv, '--out');
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(cwd, outRaw ?? join('out', `nava-preview-${stamp}`));
  const chromiumPath = env.NAVA_PREVIEW_CHROMIUM?.trim() || null;
  return {
    baseUrl: base.origin,
    storageStatePath,
    chromiumPath,
    selection,
    outDir,
    timeoutMs,
  };
}

/** Browser-side: reads the pane and the list row for one thread. Plain JS, no DOM types. */
const READ_PANE_JS = `(threadId) => {
  const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const panel = document.querySelector('[data-preview-pane]');
  const status = panel ? panel.querySelector('[data-preview-status]') : null;
  const row = document.querySelector('aside a[data-thread-id="' + CSS.escape(threadId) + '"]');
  const text = panel ? clean(panel.innerText) : '';
  const labelNode = panel
    ? Array.from(panel.querySelectorAll('span')).find(
        (el) => el.childElementCount === 0 && ['Quote', 'Booking', 'Other'].includes(clean(el.textContent)),
      )
    : undefined;
  const amendment = panel ? panel.querySelector('[data-amendment-kind]') : null;
  const alerts = panel
    ? Array.from(panel.querySelectorAll('[role="alert"], [role="status"]')).map((el) => clean(el.textContent))
    : [];
  const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]')).map((el) => clean(el.textContent));
  const fields = panel
    ? Array.from(panel.querySelectorAll('input[aria-label], select[aria-label], textarea[aria-label]'))
        .map((el) => {
          const field = clean(el.getAttribute('aria-label'));
          if (el.type === 'checkbox') return el.checked ? { field, value: 'yes' } : null;
          const value = clean(el.value);
          return value ? { field, value } : null;
        })
        .filter(Boolean)
    : [];
  return {
    subject: row ? clean(row.querySelector('.font-medium') ? row.querySelector('.font-medium').textContent : row.textContent) : null,
    paneStatus: status ? status.getAttribute('data-preview-status') : 'missing',
    unsyncedReason: status ? status.getAttribute('data-preview-reason') : null,
    analysing: /Luna is (reading the email|re-reading with your note)/.test(text),
    intent: labelNode ? clean(labelNode.textContent) : null,
    amendment: amendment ? clean(amendment.textContent) : null,
    aiUnavailable: /Read without AI/.test(text),
    alerts: alerts.concat(toasts).filter(Boolean),
    fields: fields,
    statusText: status && status.getAttribute('data-preview-status') !== 'ready' ? clean(status.textContent) : '',
  };
}`;

type PaneRead = {
  subject: string | null;
  paneStatus: string;
  unsyncedReason: string | null;
  analysing: boolean;
  intent: string | null;
  amendment: string | null;
  aiUnavailable: boolean;
  alerts: string[];
  fields: PrefilledField[];
  statusText: string;
};

/** A thread has settled when the pane shows an intent, an error, or a fallback notice. */
export function outcomeOf(read: PaneRead): Outcome | null {
  if (read.paneStatus === 'unsynced') return 'unsynced';
  if (read.paneStatus === 'error') return 'error';
  if (read.paneStatus !== 'ready' || read.analysing) return null;
  if (read.aiUnavailable) return 'fallback';
  if (read.intent || read.amendment) return 'intent';
  if (read.alerts.length > 0) return 'error';
  return null;
}

const PARTY_FIELD = /company|agency|attention|party/i;

/**
 * Marks elements whose visible text or value holds an email, a phone-like number, or a
 * contact-labelled input, so the screenshots can cover them. Runs only in the page.
 */
const MARK_PII_JS = `() => {
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/;
  const phones = /\\+?\\d[\\d\\s().-]{6,}\\d/g;
  const hasPhone = (text) =>
    (text.match(phones) || []).some((m) => {
      const digits = m.replace(/\\D/g, '').length;
      return digits >= 9 && digits <= 15;
    });
  const contact = /email|mail|phone|tel|mobile|attention|guest|name|party/i;
  let marked = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (el.matches('input, textarea, select')) {
      const label = el.getAttribute('aria-label') || '';
      const value = String(el.value || '');
      if (contact.test(label) || email.test(value) || hasPhone(value)) {
        el.setAttribute('data-runner-mask', '');
        marked += 1;
      }
      continue;
    }
    const text = el.childElementCount === 0 ? el.textContent || '' : '';
    if (text && (email.test(text) || hasPhone(text))) {
      el.setAttribute('data-runner-mask', '');
      marked += 1;
    }
  }
  return marked;
}`;

function cleanBanners(values: readonly string[]): string[] {
  const unique = Array.from(new Set(values.map((value) => redactText(value).slice(0, 300))));
  return unique.filter(Boolean).slice(0, MAX_BANNERS);
}

function shapeResult(
  threadId: string,
  read: PaneRead,
  outcome: Outcome,
  blockedWrites: string[],
  screenshots: ThreadResult['screenshots'],
  elapsedMs: number,
): ThreadResult {
  const prefilled = read.fields.slice(0, MAX_FIELDS).map((item) => ({
    field: redactText(item.field).slice(0, 80),
    value: redactText(item.value).slice(0, 200),
  }));
  return {
    threadId,
    subject: redactText(read.subject ?? '').slice(0, 200),
    outcome,
    paneStatus: read.paneStatus,
    unsyncedReason: read.unsyncedReason,
    intent: read.intent,
    amendment: read.amendment,
    aiUnavailable: read.aiUnavailable,
    prefilled,
    party: prefilled.filter((item) => PARTY_FIELD.test(item.field)).map((item) => item.value),
    banners: cleanBanners(read.alerts.length > 0 ? read.alerts : [read.statusText].filter(Boolean)),
    blockedWrites: blockedWrites.slice(0, MAX_BLOCKED),
    screenshots,
    elapsedMs,
  };
}

/** A write the guard stopped, with the thread whose page sent it (null when none). */
export type BlockedWrite = { thread: string | null; procedure: string };

function threadFromReferer(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).searchParams.get('thread');
  } catch {
    return null;
  }
}

async function installWriteGuard(page: Page, blocked: BlockedWrite[]): Promise<void> {
  await page.route('**/api/trpc/**', async (route: Route) => {
    const request = route.request();
    const decision = classifyTrpcRequest(request.url());
    if (decision.allowed) {
      await route.continue();
      return;
    }
    const thread = threadFromReferer(request.headers().referer);
    for (const item of decision.blocked) {
      blocked.push({ thread, procedure: item.procedure });
    }
    await route.abort('blockedbyclient');
  });
}

async function listLatest(page: Page, count: number): Promise<string[]> {
  const rows = page.locator('aside a[data-thread-id]');
  await rows
    .first()
    .waitFor({ state: 'attached', timeout: LIST_TIMEOUT_MS })
    .catch(() => undefined);
  const ids = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-thread-id') ?? '').filter(Boolean),
  );
  if (ids.length === 0) throw new Error('the thread list is empty or did not load');
  return ids.slice(0, count);
}

async function viewThread(
  page: Page,
  baseUrl: string,
  threadId: string,
  outDir: string,
  timeoutMs: number,
  blocked: BlockedWrite[],
): Promise<ThreadResult> {
  const started = Date.now();
  const url = `${baseUrl}/nava-preview?thread=${encodeURIComponent(threadId)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const readPane = async (): Promise<PaneRead | null> =>
    page
      .evaluate(`(${READ_PANE_JS})(${JSON.stringify(threadId)})`)
      .then((value) => value as PaneRead)
      .catch(() => null);

  let read: PaneRead | null = null;
  let outcome: Outcome | null = null;
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(POLL_MS);
    read = await readPane();
    outcome = read ? outcomeOf(read) : null;
    if (outcome) break;
  }
  const settled = outcome !== null;
  if (!read) read = await readPane();
  if (!read) throw new Error('the thread view never rendered');
  const blockedWrites = blocked
    .filter((item) => item.thread === threadId)
    .map((item) => item.procedure);

  const dir = join(outDir, 'threads', safeSegment(threadId));
  mkdirSync(dir, { recursive: true });
  const panel = page.locator('[data-preview-pane]');
  const panePath = join(dir, 'pane.png');
  const pagePath = join(dir, 'page.png');
  await page.evaluate(`(${MARK_PII_JS})()`).catch(() => 0);
  const mask = [page.locator('[data-runner-mask]')];
  await panel.screenshot({ path: panePath, mask, timeout: 15_000 }).catch(() => undefined);
  await page
    .screenshot({ path: pagePath, fullPage: true, mask, timeout: 15_000 })
    .catch(() => undefined);
  const rel = (path: string) =>
    existsSync(path) ? `threads/${safeSegment(threadId)}/${path.split('/').pop()}` : null;
  return shapeResult(
    threadId,
    read,
    settled ? (outcome as Outcome) : 'timeout',
    blockedWrites,
    { pane: rel(panePath), page: rel(pagePath) },
    Date.now() - started,
  );
}

/** A thread that could not be viewed at all. The message is the error text only, never a stack. */
function errorResult(
  threadId: string,
  error: unknown,
  blocked: readonly BlockedWrite[],
  elapsedMs: number,
): ThreadResult {
  const message = error instanceof Error ? error.message : 'the thread could not be viewed';
  return {
    threadId,
    subject: '',
    outcome: 'error',
    paneStatus: 'error',
    unsyncedReason: null,
    intent: null,
    amendment: null,
    aiUnavailable: false,
    prefilled: [],
    party: [],
    banners: cleanBanners([message]),
    blockedWrites: blocked
      .filter((item) => item.thread === threadId)
      .map((item) => item.procedure)
      .slice(0, MAX_BLOCKED),
    screenshots: { pane: null, page: null },
    elapsedMs,
  };
}

export type RunOutput = { results: ThreadResult[]; blockedOutsideThreads: string[] };

export async function runPreview(
  config: RunConfig,
  log: (line: string) => void,
): Promise<RunOutput> {
  const launchOptions = config.chromiumPath ? { executablePath: config.chromiumPath } : {};
  const browser: Browser = await chromium.launch({ headless: true, ...launchOptions });
  try {
    const context = await browser.newContext({
      storageState: config.storageStatePath,
      viewport: { width: 1600, height: 1000 },
      acceptDownloads: false,
    });
    const page = await context.newPage();
    const blocked: BlockedWrite[] = [];
    await installWriteGuard(page, blocked);

    await page.goto(`${config.baseUrl}/nava-preview`, { waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).pathname.startsWith('/login')) {
      throw new Error('the storage state has no signed-in session; export a fresh one');
    }
    const threadIds =
      config.selection.kind === 'latest'
        ? await listLatest(page, config.selection.count)
        : config.selection.ids;
    log(`threads: ${threadIds.length}`);

    const results: ThreadResult[] = [];
    for (const threadId of threadIds) {
      const started = Date.now();
      const result = await viewThread(
        page,
        config.baseUrl,
        threadId,
        config.outDir,
        config.timeoutMs,
        blocked,
      ).catch((error: unknown) => errorResult(threadId, error, blocked, Date.now() - started));
      log(`${results.length + 1}/${threadIds.length} ${result.outcome}`);
      results.push(result);
    }
    await context.close();
    const blockedOutsideThreads = blocked
      .filter((item) => item.thread === null || !threadIds.includes(item.thread))
      .map((item) => item.procedure);
    return { results, blockedOutsideThreads };
  } finally {
    await browser.close();
  }
}

export function summarize(
  results: readonly ThreadResult[],
  blockedOutsideThreads: readonly string[] = [],
): Record<Outcome | 'blockedWrites', number> {
  const counts: Record<Outcome | 'blockedWrites', number> = {
    intent: 0,
    fallback: 0,
    error: 0,
    unsynced: 0,
    timeout: 0,
    blockedWrites: 0,
  };
  for (const result of results) {
    counts[result.outcome] += 1;
    counts.blockedWrites += result.blockedWrites.length;
  }
  counts.blockedWrites += blockedOutsideThreads.length;
  return counts;
}

/** Whether the run fails the gate: a thread timed out or errored, or the viewer tried a write. */
export function gateFailures(
  results: readonly ThreadResult[],
  blockedOutsideThreads: readonly string[] = [],
): string[] {
  const failures: string[] = [];
  const counts = summarize(results, blockedOutsideThreads);
  if (counts.timeout > 0) failures.push(`${counts.timeout} thread(s) did not settle`);
  if (counts.error > 0) failures.push(`${counts.error} thread(s) showed a pane error`);
  if (counts.blockedWrites > 0)
    failures.push(`${counts.blockedWrites} write request(s) were blocked`);
  return failures;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Static gallery of the run. Every text value is escaped; images are relative paths. */
export function buildGalleryHtml(results: readonly ThreadResult[], generatedAt: string): string {
  const counts = summarize(results);
  const cards = results
    .map((result) => {
      const e = escapeHtml;
      const fields = result.prefilled
        .map((item) => `<tr><th>${e(item.field)}</th><td>${e(item.value)}</td></tr>`)
        .join('');
      const banners = result.banners.map((line) => `<li>${e(line)}</li>`).join('');
      const shots = [result.screenshots.pane, result.screenshots.page]
        .filter((src): src is string => Boolean(src))
        .map(
          (src) => `<a href="${e(src)}"><img src="${e(src)}" alt="screenshot" loading="lazy"></a>`,
        )
        .join('');
      const blocked = result.blockedWrites.length
        ? `<p class="bad">Blocked writes: ${e(result.blockedWrites.join('; '))}</p>`
        : '';
      return `<article class="card ${e(result.outcome)}">
  <header><span class="badge">${e(result.outcome)}</span> <strong>${e(result.subject || '(no subject)')}</strong></header>
  <p class="meta">${e(result.threadId)} · ${e(result.intent ?? '—')}${result.amendment ? ` · ${e(result.amendment)}` : ''}${result.aiUnavailable ? ' · read without AI' : ''} · ${result.elapsedMs} ms</p>
  ${result.unsyncedReason ? `<p class="meta">Unsynced: ${e(result.unsyncedReason)}</p>` : ''}
  ${blocked}
  ${banners ? `<ul class="banners">${banners}</ul>` : ''}
  ${fields ? `<table>${fields}</table>` : ''}
  <div class="shots">${shots}</div>
</article>`;
    })
    .join('\n');
  const summary = Object.entries(counts)
    .map(([key, value]) => `${escapeHtml(key)}: ${value}`)
    .join(' · ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Nava preview run</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#0f172a;background:#f8fafc}
h1{font-size:18px;margin:0 0 4px} .sum{color:#475569;margin-bottom:16px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;margin:0 0 14px}
.badge{font-size:11px;text-transform:uppercase;letter-spacing:.04em;background:#e2e8f0;border-radius:4px;padding:2px 6px}
.intent .badge{background:#dcfce7} .fallback .badge{background:#fef3c7} .error .badge,.timeout .badge{background:#fee2e2}
.meta{color:#64748b;margin:4px 0} .bad{color:#b91c1c}
table{border-collapse:collapse;margin:8px 0} th,td{text-align:left;padding:2px 10px 2px 0;vertical-align:top}
th{color:#475569;font-weight:600;white-space:nowrap} .banners{color:#92400e;margin:6px 0 6px 18px}
.shots{display:flex;gap:12px;flex-wrap:wrap} .shots img{max-width:420px;border:1px solid #e2e8f0;border-radius:4px}
</style></head>
<body>
<h1>/nava-preview real-browser run</h1>
<p class="sum">${escapeHtml(generatedAt)} · ${results.length} thread(s) · ${summary}</p>
${cards}
</body></html>
`;
}

export function writeOutputs(
  outDir: string,
  results: readonly ThreadResult[],
  generatedAt: string,
  blockedOutsideThreads: readonly string[] = [],
): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'results.json'),
    `${JSON.stringify(
      {
        generatedAt,
        summary: summarize(results, blockedOutsideThreads),
        blockedOutsideThreads,
        results,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(outDir, 'index.html'), buildGalleryHtml(results, generatedAt));
}

async function main(): Promise<void> {
  const config = parseRunConfig(process.argv.slice(2), process.env, process.cwd());
  const generatedAt = new Date().toISOString();
  const { results, blockedOutsideThreads } = await runPreview(config, (line) => console.log(line));
  writeOutputs(config.outDir, results, generatedAt, blockedOutsideThreads);
  const counts = summarize(results, blockedOutsideThreads);
  console.log(`out: ${config.outDir}`);
  console.log(
    `intent=${counts.intent} fallback=${counts.fallback} error=${counts.error} unsynced=${counts.unsynced} timeout=${counts.timeout} blockedWrites=${counts.blockedWrites}`,
  );
  const failures = gateFailures(results, blockedOutsideThreads);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = failures.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Error text can echo page content, so print the message only and never the stack.
    console.error(`nava-preview-run: ${error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 2;
  });
}
