/** Run one selected-message replay through the actual Outlook pane and fail-closed evidence gate. */
import type { Browser, Page } from 'playwright';
import { createReplayPage, type BlockedReplayNetwork } from './nava-replay-network';
import { installFakeOutlookBridge } from './nava-replay-fake-outlook';
import { loadReplayEmail, loadReplayVoucherAttachment } from './nava-replay-mailbox';
import { captureOutlookPane, readOutlookPane } from './nava-replay-outlook-pane';
import { replayGateFailures, type ReplayDraftEvidence, type ReplayExpectation, type ReplayObservation } from './nava-replay-gate';
import { PREPARE_PREVIEW_PROCEDURES, type BlockedWrite, type ReplayPreparePolicy } from './nava-preview-run';

export type ReplayCase = {
  id: string;
  workflow: 'quote' | 'create' | 'filing' | 'amend' | 'triage';
  threadId: string;
  messageId: string;
  expected: { readAs: string };
};

export type ReplayCaseResult = {
  id: string;
  failures: string[];
  outcome: string;
  readAs: string | null;
  screenshotPaths: string[];
  /** Source metadata does not establish file bytes or HMS filing. */
  sourceAttachmentMetadataPresent: boolean;
};

/** The decline label comes from the pane's reviewed reply state, not historical availability. */
export function replayExpectationForCase(item: ReplayCase, readyAction: string | null): ReplayExpectation {
  const isQuote = item.workflow === 'quote';
  return {
    threadId: item.threadId,
    messageId: item.messageId,
    readAs: item.expected.readAs,
    requireDraft: isQuote,
    requireAttachment: isQuote && readyAction !== 'Draft decline reply',
    requireSourceAttachment: item.workflow === 'filing',
  };
}

/** Observe the pane's own message-binding request. Never authorize it here; the existing guard still decides. */
async function observePaneBinding(page: Page, origin: string, internetMessageId: string): Promise<() => boolean> {
  let matched = false;
  await page.route('**/api/trpc/**', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin && url.pathname === '/api/trpc/workstation.staffQuoteSource' && request.method() === 'POST') {
      try {
        const body: unknown = request.postDataJSON();
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          const wire = body as Record<string, unknown>;
          const envelope = url.searchParams.get('batch') === '1' ? wire['0'] : wire;
          if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
            const json = (envelope as Record<string, unknown>).json;
            if (json && typeof json === 'object' && !Array.isArray(json) &&
              (json as Record<string, unknown>).internetMessageId === internetMessageId) matched = true;
          }
        }
      } catch { /* malformed request never proves binding */ }
    }
    await route.fallback();
  });
  return () => matched;
}

/** No direct database access, native add-in, HMS commit, or mail send is used. */
export async function runOutlookReplayCase(input: {
  browser: Browser;
  origin: string;
  storageStatePath: string;
  userId: string;
  transportId: string;
  item: ReplayCase;
  screenshotDir: string;
  allowHmsReads?: boolean;
  prepareProcedures?: readonly string[];
  timeoutMs?: number;
}): Promise<ReplayCaseResult> {
  const { item } = input;
  if (!item.id || !item.threadId || !item.messageId || !item.expected.readAs || !input.userId || !input.transportId)
    throw new Error('Replay case and session identity must be explicit');
  const requestedPrepare = input.prepareProcedures ?? [];
  if (new Set(requestedPrepare).size !== requestedPrepare.length ||
    !requestedPrepare.every((name) => PREPARE_PREVIEW_PROCEDURES.has(name)))
    throw new Error('Replay prepare contains an unreviewed procedure');
  const preparePolicy: ReplayPreparePolicy | undefined = requestedPrepare.length ? {
    origin: input.origin, userId: input.userId, transportId: input.transportId,
    messageId: item.messageId, procedures: new Set(requestedPrepare),
  } : undefined;
  const blockedNetwork: BlockedReplayNetwork[] = [], blockedTrpc: BlockedWrite[] = [];
  const { context, page } = await createReplayPage(input.browser, input.origin, blockedNetwork, blockedTrpc, {
    allowHmsReads: input.allowHmsReads === true, preparePolicy,
    contextOptions: { storageState: input.storageStatePath, viewport: { width: 1600, height: 1000 },
      extraHTTPHeaders: { 'x-zero-active-transport': input.transportId } },
  });
  let readyAction: string | null = null;
  const observed: ReplayObservation = {
    threadId: item.threadId, messageId: item.messageId, synchronized: false, outcome: 'error', readAs: null,
    drafts: [], forbiddenBatches: [], forbiddenNetwork: [], forbiddenBridgeActions: [],
    sourceAttachmentMetadata: null, screenshotPaths: [],
  };
  try {
    // APIRequestContext bypasses page routes: these are exact-origin, explicitly reviewed app reads only.
    const response = await context.request.get(`${input.origin}/api/auth/get-session`, { timeout: 5_000, maxRedirects: 0 });
    const session = response.ok() ? await response.json() as { user?: { id?: unknown } } | null : null;
    if (session?.user?.id !== input.userId) throw new Error('Replay session identity does not match');
    const email = await loadReplayEmail({ request: context.request, origin: input.origin, transportId: input.transportId,
      threadId: item.threadId, messageId: item.messageId, fakeStoreId: 'nava-replay-store' });
    if (!email) throw new Error('Replay selected message or required source metadata is unavailable');
    if (item.workflow === 'filing') {
      const sourceAttachment = await loadReplayVoucherAttachment({ request: context.request, origin: input.origin,
        transportId: input.transportId, threadId: item.threadId, messageId: item.messageId,
        internetMessageId: email.internetMessageId });
      if (sourceAttachment) observed.sourceAttachmentMetadata = {
        threadId: item.threadId, messageId: item.messageId, ...sourceAttachment,
      };
    }
    await installFakeOutlookBridge(page, { origin: input.origin, transportId: input.transportId,
      storeId: email.storeId, emails: [email] });
    const bindingSeen = await observePaneBinding(page, input.origin, email.internetMessageId);
    await page.goto(`${input.origin}/outlook-pane`, { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + Math.max(5_000, Math.min(input.timeoutMs ?? 90_000, 600_000));
    while (Date.now() < deadline) {
      const pane = await readOutlookPane(page);
      observed.outcome = pane.outcome;
      observed.readAs = pane.readAs;
      const selected = page.locator('#quote-selected-message[aria-label="Selected email"]');
      const selectedText = await selected.innerText().catch(() => '');
      observed.synchronized = bindingSeen() && Boolean(email.subject) &&
        selectedText.replace(/\s+/g, ' ').includes(email.subject.replace(/\s+/g, ' ').trim());
      if (pane.outcome !== 'reading' && observed.synchronized) break;
      await page.waitForTimeout(500);
    }
    if (item.workflow === 'quote' && observed.synchronized && observed.outcome === 'intent') {
      // The enabled button is the reviewed current pane outcome; never infer sold out from staff history.
      while (Date.now() < deadline && !readyAction) {
        for (const label of ['Draft decline reply', 'Draft quotation into email reply']) {
          const button = page.getByRole('button', { name: label, exact: true });
          if (await button.count() === 1 && await button.isEnabled()) {
            readyAction = label;
            await button.click();
            await page.waitForFunction((needsAttachment) => {
              const fake = (globalThis as unknown as { __navaFakeOutlook?: {
                drafts: Array<{ attachments: unknown[] }>;
              } }).__navaFakeOutlook;
              return Boolean(fake?.drafts.some((draft) => !needsAttachment || draft.attachments.length > 0));
            }, label !== 'Draft decline reply', { timeout: 15_000 }).catch(() => undefined);
            break;
          }
        }
        if (!readyAction) await page.waitForTimeout(500);
      }
    }
    const fake = await page.evaluate(() => (globalThis as unknown as { __navaFakeOutlook?: {
      drafts: Array<{ reply: { entryId?: string }; location: ReplayDraftEvidence['location']; attachments: ReplayDraftEvidence['attachments'] }>;
      forbidden: string[];
    } }).__navaFakeOutlook ?? null);
    observed.drafts = fake?.drafts.map((draft) => ({ messageId: draft.reply.entryId ?? '',
      location: draft.location, attachments: draft.attachments })) ?? [];
    observed.forbiddenBridgeActions = fake?.forbidden ?? ['missing_fake_bridge'];
    const screenshots = await captureOutlookPane(page, input.screenshotDir);
    observed.screenshotPaths = [screenshots.pane, screenshots.page].filter((path): path is string => Boolean(path));
  } catch {
    // Do not leak guest content, session values or provider errors into replay results.
    observed.outcome = 'error';
  } finally {
    observed.forbiddenBatches = blockedTrpc.map((item) => [item.procedure]);
    observed.forbiddenNetwork = blockedNetwork.map((item) => item.reason);
    await context.close();
  }
  const failures = replayGateFailures(replayExpectationForCase(item, readyAction), observed);
  return { id: item.id, failures, outcome: observed.outcome, readAs: observed.readAs,
    screenshotPaths: observed.screenshotPaths, sourceAttachmentMetadataPresent: Boolean(observed.sourceAttachmentMetadata) };
}

export type ReplayRunConfig = {
  origin: string;
  storageStatePath: string;
  userId: string;
  transportId: string;
  outDir: string;
  caseIds: string[];
  chromiumPath?: string;
  allowHmsReads: boolean;
  prepareProcedures: string[];
};

/** Require an explicit fixture selection and a fresh output directory. */
export function parseReplayRunConfig(argv: readonly string[], env: NodeJS.ProcessEnv): ReplayRunConfig {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!name || !['--cases', '--out'].includes(name) || !value || value.startsWith('--') || args.has(name))
      throw new Error('Use --cases id1,id2 --out new-directory');
    args.set(name, value);
  }
  const origin = env.NAVA_PREVIEW_BASE_URL?.trim() ?? '';
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error('Replay needs an exact application origin'); }
  if (parsed.origin !== origin || parsed.username || parsed.password ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1')))
    throw new Error('Replay needs HTTPS or a loopback HTTP origin');
  const storageStatePath = env.NAVA_PREVIEW_STORAGE_STATE?.trim() ?? '';
  const userId = env.NAVA_PREVIEW_USER_ID?.trim() ?? '';
  const transportId = env.NAVA_PREVIEW_TRANSPORT_ID?.trim() ?? '';
  if (!storageStatePath || !userId || !transportId || !args.get('--out'))
    throw new Error('Replay needs storage state, user, transport and output directory');
  const caseIds = (args.get('--cases') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!caseIds.length || new Set(caseIds).size !== caseIds.length ||
    !caseIds.every((id) => /^[a-z0-9-]{1,80}$/.test(id))) throw new Error('Replay case selection is invalid');
  const prepareProcedures = (env.NAVA_PREVIEW_PREPARE_PROCEDURES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (new Set(prepareProcedures).size !== prepareProcedures.length ||
    !prepareProcedures.every((name) => PREPARE_PREVIEW_PROCEDURES.has(name)))
    throw new Error('Replay prepare contains an unreviewed procedure');
  return { origin, storageStatePath, userId, transportId, outDir: args.get('--out')!, caseIds,
    ...(env.NAVA_PREVIEW_CHROMIUM?.trim() ? { chromiumPath: env.NAVA_PREVIEW_CHROMIUM.trim() } : {}),
    allowHmsReads: env.NAVA_PREVIEW_ALLOW_HMS_READS === '1', prepareProcedures };
}

async function main(): Promise<void> {
  const { readFileSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const { chromium } = await import('playwright');
  const config = parseReplayRunConfig(process.argv.slice(2), process.env);
  const manifest: unknown = JSON.parse(readFileSync(new URL('../tests/fixtures/nava-replay-staff.json', import.meta.url), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !('cases' in manifest) || !Array.isArray(manifest.cases))
    throw new Error('Replay fixture manifest is invalid');
  const cases = config.caseIds.map((id) => {
    const matches = (manifest.cases as ReplayCase[]).filter((entry) => entry.id === id);
    if (matches.length !== 1) throw new Error('Replay fixture case was not uniquely found');
    return matches[0]!;
  });
  // Fails if the output directory already exists, so prior evidence is never overwritten.
  const outDir = resolve(config.outDir);
  mkdirSync(outDir, { mode: 0o700 });
  const browser = await chromium.launch({ headless: true, ...(config.chromiumPath ? { executablePath: config.chromiumPath } : {}) });
  const results: ReplayCaseResult[] = [];
  try {
    for (const item of cases) {
      try {
        results.push(await runOutlookReplayCase({ browser, ...config, item, screenshotDir: join(outDir, item.id) }));
      } catch {
        results.push({ id: item.id, failures: ['case_execution_failed'], outcome: 'error', readAs: null,
          screenshotPaths: [], sourceAttachmentMetadataPresent: false });
      }
      console.log(`${item.id}: ${results.at(-1)!.failures.length ? 'FAIL' : 'PASS'}`);
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(outDir, 'results.json'), `${JSON.stringify({ results }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.exitCode = results.some((result) => result.failures.length) ? 1 : 0;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === (await import('node:url')).pathToFileURL(invokedPath).href) {
  main().catch(() => {
    console.error('Replay could not start. Check configuration and authentication.');
    process.exitCode = 2;
  });
}
