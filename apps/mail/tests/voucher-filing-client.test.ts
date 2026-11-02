import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@zero/server/trpc';
import superjson from 'superjson';
import * as mailScope from '../lib/mail/mail-cache-scope';
import { setMailCacheScope } from '../lib/mail/mail-cache-scope';
import { filingPrepareClientFromTrpc } from '../lib/quote-workflow/voucher-filing-client';

const choice = { workItemId: 'work', messageId: 'message', attachmentId: 'attachment', expectedSessionId: null,
  kind: 'voucher' as const, stay: { confirmation: '123-1', arrival: '2027-01-01', lastName: 'Labtest' } };
const prepared = { status: 'prepared' as const, ...choice, filename: 'proof.pdf',
  stay: { ...choice.stay, firstName: 'Proof' }, formDigest: 'a'.repeat(64) };
const transportId = 'transport-a';
const ready = { status: 'ready', capability: 'voucher-filing/v1', messageId: choice.messageId, transportId };
let lifecycle: AbortController;
let clientScope: { transportId: string; messageId: string; isCurrent: () => boolean; signal: AbortSignal };
let mailbox: { context: { activeTransportId: string }; signal: AbortSignal };
const setScope = (activeTransportId: string | null, userId: string | null = 'staff-a') =>
  setMailCacheScope({ userId, activeTransportId });
beforeEach(() => {
  lifecycle = new AbortController();
  clientScope = { transportId, messageId: choice.messageId, isCurrent: () => true, signal: lifecycle.signal };
  mailbox = { context: { activeTransportId: transportId }, signal: lifecycle.signal };
  setScope(transportId);
});
afterEach(() => { lifecycle.abort(); setScope(null, null); vi.restoreAllMocks(); });
const setup = async (reply: unknown = prepared) => {
  const prepare = vi.fn(async () => reply), go = vi.fn(async () => ({ status: 'queued', operationId: 'run' }));
  const api = await filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query: async () => ready }, prepare: { mutate: prepare }, go: { mutate: go } } }, clientScope);
  if (!api) throw new Error('missing client');
  return { api, prepare, go };
};

describe('filing prepare client', () => {
  it('stays unavailable for absent routes or unready, malformed and failed readiness', async () => {
    expect(await filingPrepareClientFromTrpc({}, clientScope)).toBeNull();
    expect(await filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query: async () => ready }, prepare: { mutate: vi.fn() } } }, clientScope)).toBeNull();
    for (const reply of [null, {}, { status: 'ready' }, { ...ready, capability: 'other' }, { ...ready, messageId: 'other' }, { ...ready, transportId: 'other' }, { ...ready, unexpected: true }, { ...ready, status: 'disabled' }]) {
      const prepare = vi.fn(), go = vi.fn();
      expect(await filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query: async () => reply }, prepare: { mutate: prepare }, go: { mutate: go } } }, clientScope)).toBeNull();
      expect(prepare).not.toHaveBeenCalled();
      expect(go).not.toHaveBeenCalled();
    }
    expect(await filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query: async () => { throw new Error('network'); } }, prepare: { mutate: vi.fn() }, go: { mutate: vi.fn() } } }, clientScope)).toBeNull();
  });

  it('rejects an absent transport before querying readiness', async () => {
    const query = vi.fn(async () => ready);
    const routes = { voucherFiling: { readiness: { query }, prepare: { mutate: vi.fn() }, go: { mutate: vi.fn() } } };
    expect(await filingPrepareClientFromTrpc(routes, { ...clientScope, transportId: '' })).toBeNull();
    expect(await filingPrepareClientFromTrpc(routes, { ...clientScope, messageId: '' })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('pins the readiness check to the selected mailbox', async () => {
    const query = vi.fn(async (_input: unknown, _options: unknown) => ready);
    const api = await filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query }, prepare: { mutate: vi.fn() }, go: { mutate: vi.fn() } } }, clientScope);
    expect(api).not.toBeNull();
    expect(query).toHaveBeenCalledWith({ messageId: choice.messageId }, mailbox);
  });

  it('refuses unknown or changed actor and mailbox scopes', async () => {
    const query = vi.fn(async () => ready);
    const routes = { voucherFiling: { readiness: { query }, prepare: { mutate: vi.fn() }, go: { mutate: vi.fn() } } };
    setScope(null); expect(await filingPrepareClientFromTrpc(routes, clientScope)).toBeNull();
    setScope(transportId, null); expect(await filingPrepareClientFromTrpc(routes, clientScope)).toBeNull();
    setScope('transport-b'); expect(await filingPrepareClientFromTrpc(routes, clientScope)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('does not return a client when mailbox changes while readiness is pending', async () => {
    let resolve!: (value: unknown) => void;
    const query = vi.fn(() => new Promise<unknown>((done) => { resolve = done; }));
    const pending = filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query }, prepare: { mutate: vi.fn() }, go: { mutate: vi.fn() } } }, clientScope);
    setScope('transport-b'); resolve(ready);
    expect(await pending).toBeNull();
  });

  it('refuses Prepare or Go after the active mailbox or actor changes', async () => {
    const first = await setup();
    setScope('transport-b');
    expect(await first.api.prepare(choice)).toEqual({ status: 'unavailable' });
    expect(first.prepare).not.toHaveBeenCalled();
    setScope(transportId);
    expect(await first.api.prepare(choice)).toEqual({ status: 'unavailable' });
    const fresh = await setup();
    const preparedResult = await fresh.api.prepare(choice);
    if (preparedResult.status !== 'prepared') throw new Error('prepare failed');
    setScope(transportId, 'staff-b');
    expect(await fresh.api.go(preparedResult.value)).toEqual({ status: 'needs_check' });
    expect(fresh.go).not.toHaveBeenCalled();
  });

  it('treats an in-flight Go as uncertain if the mailbox changes', async () => {
    let resolve!: (value: unknown) => void;
    const go = vi.fn(() => new Promise<unknown>((done) => { resolve = done; }));
    const api = await filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query: async () => ready }, prepare: { mutate: async () => prepared }, go: { mutate: go } } }, clientScope);
    if (!api) throw new Error('missing client');
    const result = await api.prepare(choice);
    if (result.status !== 'prepared') throw new Error('prepare failed');
    const pending = api.go(result.value);
    setScope('transport-b'); resolve({ status: 'queued', operationId: 'run' });
    expect(await pending).toEqual({ status: 'needs_check' });
    setScope(transportId);
    expect(await api.go(result.value)).toEqual({ status: 'needs_check' });
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('discards readiness if the selected message changes while it is pending', async () => {
    let current = true;
    let resolve!: (value: unknown) => void;
    const query = vi.fn(() => new Promise<unknown>((done) => { resolve = done; }));
    const pending = filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query }, prepare: { mutate: vi.fn() }, go: { mutate: vi.fn() } } },
      { ...clientScope, isCurrent: () => current });
    current = false; resolve(ready);
    expect(await pending).toBeNull();
  });

  it('never prepares or files a different or no longer current selection', async () => {
    let current = true;
    const prepare = vi.fn(async () => prepared), go = vi.fn(async () => ({ status: 'queued', operationId: 'run' }));
    const api = await filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query: async () => ready }, prepare: { mutate: prepare }, go: { mutate: go } } },
      { ...clientScope, isCurrent: () => current });
    if (!api) throw new Error('missing client');
    expect(await api.prepare({ ...choice, messageId: 'other' })).toEqual({ status: 'unavailable' });
    expect(prepare).not.toHaveBeenCalled();
    const result = await api.prepare(choice);
    if (result.status !== 'prepared') throw new Error('prepare failed');
    current = false;
    expect(await api.go(result.value)).toEqual({ status: 'needs_check' });
    expect(go).not.toHaveBeenCalled();
  });

  it('treats an in-flight Go as uncertain if the selected message changes', async () => {
    let current = true;
    let resolve!: (value: unknown) => void;
    const go = vi.fn(() => new Promise<unknown>((done) => { resolve = done; }));
    const api = await filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query: async () => ready }, prepare: { mutate: async () => prepared }, go: { mutate: go } } },
      { ...clientScope, isCurrent: () => current });
    if (!api) throw new Error('missing client');
    const result = await api.prepare(choice);
    if (result.status !== 'prepared') throw new Error('prepare failed');
    const pending = api.go(result.value);
    current = false; resolve({ status: 'queued', operationId: 'run' });
    expect(await pending).toEqual({ status: 'needs_check' });
    current = true;
    expect(await api.go(result.value)).toEqual({ status: 'needs_check' });
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('does not return a prepared review if the selected message changes during Prepare', async () => {
    let current = true;
    let resolve!: (value: unknown) => void;
    const prepare = vi.fn(() => new Promise<unknown>((done) => { resolve = done; }));
    const api = await filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query: async () => ready }, prepare: { mutate: prepare }, go: { mutate: vi.fn() } } },
      { ...clientScope, isCurrent: () => current });
    if (!api) throw new Error('missing client');
    const pending = api.prepare(choice);
    current = false; resolve(prepared);
    expect(await pending).toEqual({ status: 'unavailable' });
    current = true;
    expect(await api.prepare(choice)).toEqual({ status: 'unavailable' });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('treats a failed current-selection callback as stale', async () => {
    const query = vi.fn(async () => ready);
    const api = await filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query }, prepare: { mutate: vi.fn() }, go: { mutate: vi.fn() } } },
      { ...clientScope, isCurrent: () => { throw new Error('stale'); } });
    expect(api).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('invalidates pending readiness after an A-to-B-to-A mailbox transition', async () => {
    let resolve!: (value: unknown) => void;
    const query = vi.fn(() => new Promise<unknown>((done) => { resolve = done; }));
    const pending = filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query }, prepare: { mutate: vi.fn() }, go: { mutate: vi.fn() } } }, clientScope);
    setScope('transport-b'); setScope(transportId); resolve(ready);
    expect(await pending).toBeNull();
  });

  it('invalidates an in-flight Prepare after an A-to-B-to-A transition', async () => {
    let resolve!: (value: unknown) => void;
    const prepare = vi.fn(() => new Promise<unknown>((done) => { resolve = done; }));
    const api = await filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query: async () => ready }, prepare: { mutate: prepare }, go: { mutate: vi.fn() } } }, clientScope);
    if (!api) throw new Error('missing client');
    const pending = api.prepare(choice);
    setScope('transport-b'); setScope(transportId);
    expect(await pending).toEqual({ status: 'unavailable' });
    resolve(prepared);
    expect(await api.prepare(choice)).toEqual({ status: 'unavailable' });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('never permits a reviewed Go after an A-to-B-to-A actor change', async () => {
    const { api, go } = await setup();
    const result = await api.prepare(choice);
    if (result.status !== 'prepared') throw new Error('prepare failed');
    setScope(transportId, 'staff-b'); setScope(transportId);
    expect(await api.go(result.value)).toEqual({ status: 'needs_check' });
    expect(go).not.toHaveBeenCalled();
  });

  it('treats in-flight Go as uncertain after an A-to-B-to-A mailbox transition', async () => {
    let resolve!: (value: unknown) => void;
    const go = vi.fn(() => new Promise<unknown>((done) => { resolve = done; }));
    const api = await filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query: async () => ready }, prepare: { mutate: async () => prepared }, go: { mutate: go } } }, clientScope);
    if (!api) throw new Error('missing client');
    const result = await api.prepare(choice);
    if (result.status !== 'prepared') throw new Error('prepare failed');
    const pending = api.go(result.value);
    setScope('transport-b'); setScope(transportId);
    expect(await pending).toEqual({ status: 'needs_check' });
    resolve({ status: 'queued', operationId: 'run' });
    expect(await api.go(result.value)).toEqual({ status: 'needs_check' });
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on rejection, invalidation, or explicit client disposal', async () => {
    const realSubscribe = mailScope.subscribeMailCacheScope;
    const unsubscribed = vi.fn();
    vi.spyOn(mailScope, 'subscribeMailCacheScope').mockImplementation((listener) => {
      const stop = realSubscribe(listener);
      return () => { unsubscribed(); stop(); };
    });
    expect(await filingPrepareClientFromTrpc({}, clientScope)).toBeNull();
    expect(unsubscribed).toHaveBeenCalledTimes(1);
    const first = await setup();
    first.api.dispose(); first.api.dispose();
    expect(unsubscribed).toHaveBeenCalledTimes(2);
    expect(await first.api.prepare(choice)).toEqual({ status: 'unavailable' });
    const second = await setup();
    setScope('transport-b');
    expect(unsubscribed).toHaveBeenCalledTimes(3);
    setScope(transportId);
    second.api.dispose();
    expect(unsubscribed).toHaveBeenCalledTimes(3);
  });

  it('releases its listener when selection aborts during pending readiness', async () => {
    const realSubscribe = mailScope.subscribeMailCacheScope;
    const unsubscribed = vi.fn();
    vi.spyOn(mailScope, 'subscribeMailCacheScope').mockImplementation((listener) => {
      const stop = realSubscribe(listener);
      return () => { unsubscribed(); stop(); };
    });
    let resolve!: (value: unknown) => void;
    const query = vi.fn(() => new Promise<unknown>((done) => { resolve = done; }));
    const pending = filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query }, prepare: { mutate: vi.fn() }, go: { mutate: vi.fn() } } }, clientScope);
    lifecycle.abort();
    expect(unsubscribed).toHaveBeenCalledTimes(1);
    expect(await pending).toBeNull();
    resolve(ready);
    expect(unsubscribed).toHaveBeenCalledTimes(1);
  });

  it('does not issue Prepare or Go after lifecycle abort', async () => {
    const { api, prepare, go } = await setup();
    const result = await api.prepare(choice);
    if (result.status !== 'prepared') throw new Error('prepare failed');
    lifecycle.abort();
    expect(await api.go(result.value)).toEqual({ status: 'needs_check' });
    expect(await api.prepare(choice)).toEqual({ status: 'unavailable' });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();
  });

  it('keeps an aborted in-flight Go uncertain, including after a late rejection', async () => {
    let reject!: (error: Error) => void;
    const go = vi.fn(() => new Promise<unknown>((_done, fail) => { reject = fail; }));
    const api = await filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query: async () => ready }, prepare: { mutate: async () => prepared }, go: { mutate: go } } }, clientScope);
    if (!api) throw new Error('missing client');
    const result = await api.prepare(choice);
    if (result.status !== 'prepared') throw new Error('prepare failed');
    const pending = api.go(result.value);
    lifecycle.abort();
    expect(await pending).toEqual({ status: 'needs_check' });
    reject(new Error('late network error'));
    await Promise.resolve();
    expect(await api.go(result.value)).toEqual({ status: 'needs_check' });
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('cleans up its scope listener on malformed routes and thrown readiness', async () => {
    const realSubscribe = mailScope.subscribeMailCacheScope;
    const stopped = vi.fn();
    vi.spyOn(mailScope, 'subscribeMailCacheScope').mockImplementation((listener) => {
      const stop = realSubscribe(listener);
      return () => { stopped(); stop(); };
    });
    const throwingRoutes = Object.defineProperty({}, 'voucherFiling', { get: () => { throw new Error('bad proxy'); } });
    const rejected = { voucherFiling: { readiness: { query: async () => { throw new Error('denied'); } },
      prepare: { mutate: vi.fn() }, go: { mutate: vi.fn() } } };
    for (const trpc of [undefined, throwingRoutes, rejected]) expect(await filingPrepareClientFromTrpc(trpc, clientScope)).toBeNull();
    expect(stopped).toHaveBeenCalledTimes(3);
  });

  it('does not infer readiness from arbitrary paths on the real tRPC proxy', async () => {
    const calls: string[] = [];
    const trpc = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: 'https://pane.invalid/api/trpc', transformer: superjson,
      fetch: async (url) => { calls.push(String(url)); return new Response(JSON.stringify([{ error: { message: 'Not found', code: -32004, data: { code: 'NOT_FOUND', httpStatus: 404 } } }]), { status: 404, headers: { 'content-type': 'application/json' } }); },
    })] });
    const synthetic = trpc as unknown as { voucherFiling: { prepare: { mutate: unknown }; go: { mutate: unknown } } };
    expect(typeof synthetic.voucherFiling.prepare.mutate).toBe('function');
    expect(typeof synthetic.voucherFiling.go.mutate).toBe('function');
    expect(await filingPrepareClientFromTrpc(trpc, clientScope)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('voucherFiling.readiness');
  });

  it('shows the server-prepared form and sends only the reviewed digest on Go', async () => {
    const { api, prepare, go } = await setup(), result = await api.prepare(choice);
    expect(prepare).toHaveBeenCalledWith(choice, mailbox);
    if (result.status !== 'prepared') throw new Error('prepare failed');
    expect(result.value.filename).toBe('proof.pdf');
    expect(Object.isFrozen(result.value.stay)).toBe(true);
    expect(await api.go(result.value)).toEqual({ status: 'queued', operationId: 'run' });
    expect(go).toHaveBeenCalledWith({ workItemId: 'work', messageId: 'message', formDigest: 'a'.repeat(64), expectedSessionId: null }, mailbox);
    expect(await api.go(result.value)).toEqual({ status: 'needs_check' });
    expect(go).toHaveBeenCalledTimes(1);
    expect(await api.go({ ...result.value })).toEqual({ status: 'needs_check' });
    expect(go).toHaveBeenCalledTimes(1);
  });

  it('rejects changed selection, malformed forms and unexpected authority fields', async () => {
    for (const response of [
      { ...prepared, workItemId: 'other' }, { ...prepared, messageId: 'other' }, { ...prepared, attachmentId: 'other' },
      { ...prepared, expectedSessionId: 'other' }, { ...prepared, kind: 'proof_of_payment' },
      { ...prepared, stay: { ...prepared.stay, confirmation: '999-1' } },
      { ...prepared, stay: { ...prepared.stay, arrival: '2027-01-02' } },
      { ...prepared, stay: { ...prepared.stay, lastName: 'Other' } },
      { ...prepared, filename: '' }, { ...prepared, formDigest: 'not-a-digest' }, { ...prepared, grantRef: 'not-for-the-pane' },
    ]) expect(await (await setup(response)).api.prepare(choice)).toEqual({ status: 'unavailable' });
  });

  it('treats a lost or refused Go response as needing a check and never retries automatically', async () => {
    const prepare = vi.fn(async () => prepared), go = vi.fn(async () => { throw new Error('network'); });
    const api = await filingPrepareClientFromTrpc({ voucherFiling: { readiness: { query: async () => ready }, prepare: { mutate: prepare }, go: { mutate: go } } }, clientScope);
    if (!api) throw new Error('missing client');
    const result = await api.prepare(choice);
    if (result.status !== 'prepared') throw new Error('prepare failed');
    expect(await api.go(result.value)).toEqual({ status: 'needs_check' });
    expect(await api.go(result.value)).toEqual({ status: 'needs_check' });
    expect(go).toHaveBeenCalledTimes(1);
  });
});
