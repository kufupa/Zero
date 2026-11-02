/** Test-only Outlook bridge. Never reaches a native add-in or issues a real bridge ticket. */
import type { Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { isProtectedReplayPage } from './nava-replay-network';

export type FakeOutlookEmail = {
  entryId: string;
  storeId: string;
  folderEntryId: string;
  subject: string;
  senderEmail: string;
  senderName: string;
  receivedTime: string;
  bodyText: string;
  bodyHtml: string;
  internetMessageId: string;
};

export type FakeOutlookFixture = {
  origin: string;
  transportId: string;
  storeId: string;
  emails: FakeOutlookEmail[];
};

const CHALLENGE = 'f'.repeat(43);
const DEVICE = '00000000-0000-4000-8000-000000000001';
const ACTIONS = ['GET_CAPABILITIES', 'GET_ACTIVE_EMAIL', 'CREATE_REPLY_DRAFT', 'ADD_ATTACHMENT_TO_DRAFT'];

/** Install only on the designated fenced replay page. Invalid requests fall through to its guard. */
export async function installFakeOutlookBridge(page: Page, fixture: FakeOutlookFixture): Promise<void> {
  if (!isProtectedReplayPage(page, fixture.origin)) throw new Error('Fake Outlook requires a protected replay page');
  if (!fixture.transportId || !fixture.storeId || !fixture.emails.length ||
    fixture.emails.some((mail) => mail.storeId !== fixture.storeId))
    throw new Error('Fake Outlook requires selected emails from the configured store');
  await page.route('**/api/outlook/native/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.origin || url.pathname !== '/api/outlook/native/bootstrap' || route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { protocol: 'nava-outlook-v4', status: 'ready', paneChallenge: CHALLENGE, expiresInSeconds: 60 } });
  });
  await page.route('**/api/trpc/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const procedures = url.pathname.slice('/api/trpc/'.length).split(',');
    // The general guard must see mixed batches, including their forbidden members.
    if (!procedures.includes('workstation.bridgeTicket') || procedures.length !== 1) {
      await route.fallback();
      return;
    }
    let input: Record<string, unknown> | null = null;
    try {
      const body: unknown = request.postDataJSON();
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const record = body as Record<string, unknown>;
        const envelope = url.searchParams.has('batch')
          ? Object.keys(record).length === 1 && record['0'] : record;
        if (envelope && typeof envelope === 'object' && !Array.isArray(envelope) &&
          !('meta' in envelope)) {
          const json = (envelope as Record<string, unknown>).json;
          if (json && typeof json === 'object' && !Array.isArray(json)) input = json as Record<string, unknown>;
        }
      }
    } catch { /* malformed requests are blocked */ }
    if (url.origin !== fixture.origin || request.method() !== 'POST' ||
      request.headers()['x-zero-active-transport'] !== fixture.transportId ||
      input?.deviceId !== DEVICE || input?.paneChallenge !== CHALLENGE ||
      typeof input.action !== 'string' || !ACTIONS.includes(input.action) ||
      (input.storeId !== undefined && input.storeId !== fixture.storeId)) {
      await route.fallback();
      return;
    }
    const ticket = `fake-${randomUUID()}`;
    try {
      const registered = await page.evaluate(({ ticket, action }) => {
        const state = (globalThis as unknown as { __navaFakeOutlook?: {
          issue: (ticket: string, action: string) => boolean;
        } }).__navaFakeOutlook;
        return state?.issue(ticket, action) === true;
      }, { ticket, action: input.action });
      if (!registered) throw new Error('Fake navigation is not registered');
    } catch {
      await route.fallback();
      return;
    }
    const result = { result: { data: { json: { ticket, storeId: fixture.storeId, expiresInSeconds: 60 } } } };
    await route.fulfill({ json: url.searchParams.has('batch') ? [result] : result });
  });
  await page.addInitScript(({ fixture, challenge, device, actions }) => {
    type Request = { version?: number; requestId?: string; action?: string; payload?: Record<string, unknown>; ticket?: string; transportId?: string };
    type Listener = (event: { data: string }) => void;
    type Draft = { operationId: unknown; reply: Record<string, unknown>; location: Record<string, unknown>; attachments: Record<string, unknown>[] };
    const listeners = new Set<Listener>();
    let selected = 0;
    let registered = false;
    let eventSequence = 0;
    const grants = new Map<string, { action: string; expiresAt: number }>();
    const consume = (ticket: string | undefined, action: string) => {
      if (!ticket) return false;
      const grant = grants.get(ticket);
      grants.delete(ticket);
      return !!grant && grant.action === action && grant.expiresAt > Date.now();
    };
    const requests: Request[] = [];
    const forbidden: string[] = [];
    const drafts: Draft[] = [];
    const emit = (message: unknown) => {
      const event = { data: JSON.stringify(message) };
      for (const listener of listeners) listener(event);
    };
    const bridge = {
      addEventListener: (kind: string, listener: Listener) => { if (kind === 'message') listeners.add(listener); },
      removeEventListener: (kind: string, listener: Listener) => { if (kind === 'message') listeners.delete(listener); },
      postMessage: (raw: string) => {
        let request: Request;
        try { request = JSON.parse(raw) as Request; } catch { return; }
        requests.push(request);
        let data: unknown = null;
        let error: string | null = null;
        const payload = request.payload ?? {};
        if (request.version !== 4 || !request.requestId || !request.action) error = 'Invalid fake bridge request';
        else if (request.action === 'PING') data = { bridgeProtocolVersion: 4, version: '1.0.12', paired: true, deviceId: device };
        else if (request.action === 'REGISTER_NAVIGATION') {
          grants.clear();
          registered = payload.paneChallenge === challenge;
          if (registered) data = { registered: true }; else error = 'Invalid fake challenge';
        } else if (request.action === 'CLEAR_NAVIGATION' || request.action === 'CLEAR_SESSION') { registered = false; grants.clear(); data = { cleared: true }; }
        else if (!registered || request.transportId !== fixture.transportId || !consume(request.ticket, request.action)) error = 'Fake navigation denied';
        else if (request.action === 'GET_CAPABILITIES') data = {
          bridgeProtocolVersion: 4, addinVersion: '1.0.12', outlookVersion: 'fake', runtime: 'fake',
          newOutlookSupported: false, interactiveProfileRequired: true, maxPageSize: 200,
          maxFolderDepth: 64, maxFolderCount: 5000, maxFolderSnapshotItems: 5000, supportedActions: actions,
        };
        else if (request.action === 'GET_ACTIVE_EMAIL') data = fixture.emails[selected] ?? null;
        else if (request.action === 'CREATE_REPLY_DRAFT') {
          const email = fixture.emails[selected];
          const previous = drafts.find((draft) => draft.operationId === payload.operationId);
          if (!email || !payload.operationId || payload.entryId !== email.entryId || payload.storeId !== email.storeId || payload.folderEntryId !== email.folderEntryId)
            error = 'Fake draft selection mismatch';
          else if (previous && JSON.stringify(previous.reply) !== JSON.stringify(payload)) error = 'Fake draft operation mismatch';
          else if (previous) data = previous.location;
          else {
            const location = { entryId: `fake-draft-${drafts.length + 1}`, storeId: fixture.storeId,
              folderEntryId: 'fake-drafts', folderName: 'Drafts', displayed: false };
            drafts.push({ operationId: payload.operationId, reply: payload, location, attachments: [] });
            data = location;
          }
        } else if (request.action === 'ADD_ATTACHMENT_TO_DRAFT') {
          const draft = drafts.find((item) => item.location.entryId === payload.entryId &&
            item.location.storeId === payload.storeId && item.location.folderEntryId === payload.folderEntryId);
          if (!draft || !payload.operationId || !payload.fileName || !payload.base64Data) error = 'Fake draft attachment mismatch';
          else {
            const prior = drafts.flatMap((item) => item.attachments).find((item) => item.operationId === payload.operationId);
            if (prior && JSON.stringify(prior) !== JSON.stringify(payload)) error = 'Fake attachment operation mismatch';
            else { if (!prior) draft.attachments.push(payload); data = { added: true }; }
          }
        } else error = 'Fake Outlook action is forbidden';
        if (error) forbidden.push('invalid_or_forbidden_bridge_action');
        queueMicrotask(() => emit({ version: 4, requestId: request.requestId, action: request.action,
          success: !error, data, ...(error ? { error } : {}) }));
      },
    };
    const root = globalThis as unknown as { chrome?: { webview?: typeof bridge }; __navaFakeOutlook?: unknown };
    root.chrome ??= {};
    root.chrome.webview = bridge;
    root.__navaFakeOutlook = {
      requests, drafts, forbidden,
      issue: (ticket: string, action: string) => {
        if (!registered || !actions.includes(action)) return false;
        grants.set(ticket, { action, expiresAt: Date.now() + 60_000 });
        return true;
      },
      select: (index: number) => {
        if (!Number.isInteger(index) || index < 0 || index >= fixture.emails.length) throw new Error('Invalid fake selection');
        selected = index;
        emit({ version: 4, requestId: `evt_${++eventSequence}`, action: 'ON_SELECTION_CHANGED', success: true, data: null });
      },
    };
  }, { fixture, challenge: CHALLENGE, device: DEVICE, actions: ACTIONS });
}
