/** Synthetic loopback test: mounts the real Outlook React pane, with no live mailbox, HMS or sends. */
import { ANALYSIS_PROCEDURES, READ_PROCEDURES, analysisInputsSafe, classifyTrpcRequest, type BlockedWrite } from '../scripts/nava-preview-run';
import { installFakeOutlookBridge, type FakeOutlookEmail } from '../scripts/nava-replay-fake-outlook';
import { createReplayPage, type BlockedReplayNetwork } from '../scripts/nava-replay-network';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

const chromiumBinary = [
  chromium.executablePath(),
  '/home/orca/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',
].find(existsSync);
const mailRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mail');
const email = (id: string): FakeOutlookEmail => ({
  entryId: id, storeId: 'fake-store', folderEntryId: 'fake-inbox', subject: `Synthetic ${id}`,
  senderEmail: 'guest@example.test', senderName: 'Guest', receivedTime: '2026-11-02T08:00:00Z',
  bodyText: 'Synthetic fixture message', bodyHtml: '<p>Synthetic fixture message</p>',
  internetMessageId: `<${id}@example.test>`,
});

describe('synthetic real Outlook pane', () => {
  it.skipIf(!chromiumBinary)('follows A/B/A and inserts the selected thread’s saved reply and PDF', async () => {
    const vitePath = pathToFileURL(join(mailRoot, 'node_modules/vite/dist/node/index.js')).href;
    const vite = await import(vitePath);
    const server = await vite.createServer({ configFile: join(mailRoot, 'vite.nava-replay-fixture.config.ts'),
      logLevel: 'error', server: { port: 0, host: '127.0.0.1', strictPort: true } });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Synthetic fixture has no loopback address');
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ executablePath: chromiumBinary, headless: true });
    try {
      const blocked: BlockedReplayNetwork[] = [], blockedTrpc: BlockedWrite[] = [];
      const savedReplyReads: string[] = [];
      const calls: Array<{ method: string; procedures: string[] }> = [];
      const savedReply = { id: 'saved-A', html: '<p>Synthetic saved reply</p>',
        attachments: [{ fileName: 'synthetic-quote.pdf', pdfBase64: 'JVBERi0xLjQKJSVFT0YK' }] };
      const { context, page } = await createReplayPage(browser, origin, blocked, blockedTrpc, { syntheticLoopback: true });
      await installFakeOutlookBridge(page, { origin, transportId: 'mailbox-1', storeId: 'fake-store', emails: [email('A'), email('B')] });
      await page.route('**/api/auth/get-session', async (route) => {
        if (new URL(route.request().url()).origin !== origin || route.request().method() !== 'GET') return route.fallback();
        await route.fulfill({ json: { user: { id: 'fixture-user', name: 'Fixture', email: 'staff@example.test' },
          session: { id: 'fixture-session', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } } });
      });
      await page.route('**/api/trpc/**', async (route) => {
        const request = route.request(), url = new URL(request.url());
        const decision = classifyTrpcRequest(url.href);
        calls.push({ method: request.method(), procedures: decision.procedures });
        if (url.origin !== origin || request.method() !== 'POST' || decision.procedures.length !== 1 || !decision.allowed ||
          !analysisInputsSafe(url.href, request.method(), request.postData(), decision.procedures)) return route.fallback();
        const name = decision.procedures[0]!;
        if (!READ_PROCEDURES.has(name) && !ANALYSIS_PROCEDURES.has(name)) return route.fallback();
        let input: Record<string, unknown> = {};
        try { input = (request.postDataJSON() as { 0?: { json?: Record<string, unknown> } })[0]?.json ?? {}; } catch { /* no input */ }
        if (name === 'drafts.savedReply') {
          const threadId = typeof input.threadId === 'string' ? input.threadId : '';
          savedReplyReads.push(threadId);
          const value = threadId === 'thread-A' ? savedReply : null;
          await route.fulfill({ json: [{ result: { data: { json: value } } }] });
          return;
        }
        const id = input.internetMessageId === '<B@example.test>' ? 'B' : 'A';
        const ready = { status: 'ready', kind: id === 'A' ? 'quote' : 'booking', workItemId: `fixture-${id}`,
          workItemStatus: 'needs_you', extractionId: `extraction-${id}`, refs: {},
          contact: { name: null, company: null, endClient: null, email: null, phone: null }, language: null, translation: null,
          analysis: { status: 'ready', intent: id === 'A' ? 'quote' : 'other', groups: [], secondaryAsks: [], alternatives: [], sourceRevision: 1 } };
        const responses: Record<string, unknown> = {
          'connections.getDefault': { id: 'mailbox-1', email: 'staff@example.test', name: 'Fixture', providerId: 'mailbox' },
          'connections.list': [], 'labels.list': [], 'categories.list': [],
          'settings.get': { settings: { colorTheme: 'system', defaultEmailAlias: 'staff@example.test' } },
          'workItems.getByMessage': ready, 'workItems.list': [],
          'workstation.staffQuoteSource': { status: 'ready', messageId: id, threadId: `thread-${id}`, sourceHash: 'a'.repeat(64) },
          'quoteWorkflow.makeQuote': { makeQuote: false, propertyCode: null },
          'brain.getCapabilities': { ai: false, brain: false, paneSave: false },
        };
        await route.fulfill({ json: [{ result: { data: { json: responses[name] ?? null } } }] });
      });
      await page.goto(`${origin}/outlook-pane`, { waitUntil: 'domcontentloaded' });
      for (const [index, subject, readAs] of [[0, 'Synthetic A', 'quote'], [1, 'Synthetic B', 'new_booking'], [0, 'Synthetic A', 'quote']] as const) {
        await page.evaluate((index) => (globalThis as unknown as { __navaFakeOutlook: { select: (index: number) => void } }).__navaFakeOutlook.select(index), index);
        await page.waitForFunction(({ subject, readAs }) => {
          const selected = document.querySelector('#quote-selected-message[aria-label="Selected email"]');
          return selected?.textContent?.includes(subject) && document.querySelector('[data-read-as]')?.getAttribute('data-read-as') === readAs;
        }, { subject, readAs }, { timeout: 30_000 });
      }
      const insert = page.getByRole('button', { name: 'Insert saved reply' });
      try {
        await insert.waitFor({ state: 'visible', timeout: 30_000 });
      } catch (error) {
        const state = await page.evaluate(() => ({
          text: document.body.innerText.slice(0, 3000),
          actions: (globalThis as unknown as { __navaFakeOutlook: { requests: Array<{ action?: string }> } })
            .__navaFakeOutlook.requests.map((item) => item.action),
        }));
        throw new Error(`Saved-reply diagnostics: ${JSON.stringify({ calls: calls.slice(-50), savedReplyReads, blocked, blockedTrpc, state })}`, { cause: error });
      }
      const readsBeforeClick = savedReplyReads.filter((threadId) => threadId === 'thread-A').length;
      expect(readsBeforeClick).toBeGreaterThanOrEqual(1);
      const requestsBeforeClick = await page.evaluate(() => (globalThis as unknown as {
        __navaFakeOutlook: { requests: unknown[] };
      }).__navaFakeOutlook.requests.length);
      await insert.click({ timeout: 30_000 });
      await page.waitForFunction(() => {
        const fake = (globalThis as unknown as { __navaFakeOutlook: {
          drafts: Array<{ attachments: unknown[] }>;
        } }).__navaFakeOutlook;
        return fake.drafts.length === 1 && fake.drafts[0]?.attachments.length === 1;
      }, null, { timeout: 30_000 });
      expect(savedReplyReads.filter((threadId) => threadId === 'thread-A').length).toBeGreaterThan(readsBeforeClick);
      const fake = await page.evaluate(() => (globalThis as unknown as { __navaFakeOutlook: {
        requests: Array<{ action?: string }>;
        drafts: Array<{ reply: Record<string, unknown>; location: Record<string, unknown>; attachments: Array<Record<string, unknown>> }>;
        forbidden: string[];
      } }).__navaFakeOutlook);
      const actions = fake.requests.map((item) => item.action);
      expect(actions).toContain('REGISTER_NAVIGATION');
      expect(actions.filter((action) => action === 'GET_ACTIVE_EMAIL').length).toBeGreaterThanOrEqual(4);
      const insertedActions = actions.slice(requestsBeforeClick);
      expect(insertedActions.indexOf('GET_ACTIVE_EMAIL')).toBeGreaterThanOrEqual(0);
      expect(insertedActions.indexOf('CREATE_REPLY_DRAFT')).toBeGreaterThan(insertedActions.indexOf('GET_ACTIVE_EMAIL'));
      expect(insertedActions.indexOf('ADD_ATTACHMENT_TO_DRAFT')).toBeGreaterThan(insertedActions.indexOf('CREATE_REPLY_DRAFT'));
      expect(fake.drafts).toHaveLength(1);
      expect(fake.drafts[0]).toMatchObject({
        reply: { entryId: 'A', storeId: 'fake-store', folderEntryId: 'fake-inbox', htmlBody: savedReply.html },
        attachments: [{ entryId: 'fake-draft-1', storeId: 'fake-store', folderEntryId: 'fake-drafts',
          fileName: savedReply.attachments[0]!.fileName, base64Data: savedReply.attachments[0]!.pdfBase64 }],
      });
      expect(fake.forbidden).toEqual([]);
      expect(blockedTrpc.map((item) => item.procedure)).not.toContain('mail.send');
      expect(blockedTrpc.map((item) => item.procedure)).not.toContain('quoteWorkflow.commitStay');
      expect(blocked.filter((item) => item.reason === 'origin')).toEqual([]);
      await context.close();
    } finally {
      await browser.close();
      await server.close();
    }
  }, 120_000);
});
