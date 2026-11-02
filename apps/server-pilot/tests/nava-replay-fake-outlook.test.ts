import { installFakeOutlookBridge, type FakeOutlookEmail } from '../scripts/nava-replay-fake-outlook';
import { installWriteGuard, type BlockedWrite } from '../scripts/nava-preview-run';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';

const chromiumBinary = [
  chromium.executablePath(),
  '/home/orca/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell',
].find(existsSync);

const email = (id: string): FakeOutlookEmail => ({
  entryId: id, storeId: 'store-1', folderEntryId: 'inbox', subject: `Subject ${id}`,
  senderEmail: 'guest@example.test', senderName: 'Guest', receivedTime: '2026-11-02T08:00:00Z',
  bodyText: 'Please quote', bodyHtml: '<p>Please quote</p>', internetMessageId: `<${id}@example.test>`,
});

describe('fake Outlook bridge', () => {
  it.skipIf(!chromiumBinary)('performs v4 handshake, A/B/A selection and in-memory reply with attachment', async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => { requests.push(req.url ?? ''); res.end('<html></html>'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch({ executablePath: chromiumBinary, headless: true });
    try {
      const context = await browser.newContext({ extraHTTPHeaders: { 'x-zero-active-transport': 'mailbox-1' } });
      const page = await context.newPage();
      const blocked: BlockedWrite[] = [];
      await installWriteGuard(page, blocked);
      await installFakeOutlookBridge(page, { origin, transportId: 'mailbox-1', storeId: 'store-1', emails: [email('A'), email('B')] });
      await page.goto(origin);
      const result = await page.evaluate(async () => {
        type Response = { version: number; requestId: string; action: string; success: boolean; data: Record<string, unknown> | null };
        type Event = { data: string };
        type Webview = { postMessage: (message: string) => void; addEventListener: (type: string, cb: (event: Event) => void) => void; removeEventListener: (type: string, cb: (event: Event) => void) => void };
        type State = { select: (index: number) => void; drafts: Array<{ location: Record<string, unknown>; attachments: unknown[] }> };
        const host = globalThis as unknown as { chrome: { webview: Webview }; __navaFakeOutlook: State };
        const bridge = host.chrome.webview;
        let sequence = 0;
        const native = (action: string, payload: Record<string, unknown> = {}, ticket?: string) => new Promise<Response>((resolve) => {
          const requestId = `req_${++sequence}`;
          const listener = (event: Event) => {
            const response = JSON.parse(event.data) as Response;
            if (response.requestId !== requestId) return;
            bridge.removeEventListener('message', listener);
            resolve(response);
          };
          bridge.addEventListener('message', listener);
          bridge.postMessage(JSON.stringify({ version: 4, requestId, action, payload,
            ...(ticket ? { ticket, transportId: 'mailbox-1' } : {}) }));
        });
        const ping = await native('PING');
        const bootstrap = await fetch('/api/outlook/native/bootstrap', { method: 'POST' }).then((r) => r.json()) as { paneChallenge: string };
        const registration = await native('REGISTER_NAVIGATION', { paneChallenge: bootstrap.paneChallenge });
        const issue = async (action: string) => fetch('/api/trpc/workstation.bridgeTicket?batch=1', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 0: { json: {
            deviceId: '00000000-0000-4000-8000-000000000001', paneChallenge: bootstrap.paneChallenge, action,
          } } }),
        }).then((r) => r.json());
        const grant = async (action: string) => {
          const reply = await issue(action) as Array<{ result: { data: { json: { ticket: string; storeId: string } } } }>;
          return reply[0]!.result.data.json;
        };
        const ticket = await grant('GET_CAPABILITIES');
        const capabilities = await native('GET_CAPABILITIES', {}, ticket.ticket);
        const reused = await native('GET_CAPABILITIES', {}, ticket.ticket);
        const mismatched = await grant('GET_ACTIVE_EMAIL');
        const wrongAction = await native('CREATE_REPLY_DRAFT', {}, mismatched.ticket);
        const selections: unknown[] = [];
        for (const index of [0, 1, 0]) {
          host.__navaFakeOutlook.select(index);
          selections.push((await native('GET_ACTIVE_EMAIL', {}, (await grant('GET_ACTIVE_EMAIL')).ticket)).data?.entryId);
        }
        const reply = await native('CREATE_REPLY_DRAFT', { operationId: 'reply-1', entryId: 'A', storeId: 'store-1',
          folderEntryId: 'inbox', htmlBody: 'Reply', replyAll: false }, (await grant('CREATE_REPLY_DRAFT')).ticket);
        const duplicateReply = await native('CREATE_REPLY_DRAFT', { operationId: 'reply-1', entryId: 'A', storeId: 'store-1',
          folderEntryId: 'inbox', htmlBody: 'changed', replyAll: false }, (await grant('CREATE_REPLY_DRAFT')).ticket);
        const location = reply.data!;
        const attachment = await native('ADD_ATTACHMENT_TO_DRAFT', { operationId: 'attachment-1', ...location,
          fileName: 'quote.pdf', base64Data: 'UERG' }, (await grant('ADD_ATTACHMENT_TO_DRAFT')).ticket);
        const repeatAttachment = await native('ADD_ATTACHMENT_TO_DRAFT', { operationId: 'attachment-1', ...location,
          fileName: 'quote.pdf', base64Data: 'UERG' }, (await grant('ADD_ATTACHMENT_TO_DRAFT')).ticket);
        const forbidden = await native('SEND_EMAIL', {}, (await grant('GET_ACTIVE_EMAIL')).ticket);
        let mixedBlocked = false;
        try { await fetch('/api/trpc/workstation.bridgeTicket,quoteWorkflow.commitStay?batch=1', { method: 'POST' }); }
        catch { mixedBlocked = true; }
        return { ping, bootstrap, registration, ticket, capabilities, reused, wrongAction, selections, reply, duplicateReply, attachment, repeatAttachment, forbidden,
          mixedBlocked, drafts: host.__navaFakeOutlook.drafts };
      });
      expect(result.ping).toMatchObject({ version: 4, success: true, data: { paired: true } });
      expect(result.bootstrap.paneChallenge).toHaveLength(43);
      expect(result.registration.success).toBe(true);
      expect(result.ticket).toMatchObject({ storeId: 'store-1' });
      expect(result.capabilities.success).toBe(true);
      expect(result.reused.success).toBe(false);
      expect(result.wrongAction.success).toBe(false);
      expect(result.selections).toEqual(['A', 'B', 'A']);
      expect(result.reply.data).toMatchObject({ entryId: 'fake-draft-1', folderEntryId: 'fake-drafts' });
      expect(result.duplicateReply.success).toBe(false);
      expect(result.attachment.success).toBe(true);
      expect(result.repeatAttachment.success).toBe(true);
      expect(result.drafts[0]?.attachments).toHaveLength(1);
      expect(result.forbidden.success).toBe(false);
      expect(result.mixedBlocked).toBe(true);
      expect(blocked.map((item) => item.procedure)).toContain('quoteWorkflow.commitStay');
      expect(requests).toEqual(['/']);
      await context.close();
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);
});
