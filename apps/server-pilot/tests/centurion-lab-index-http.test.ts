import {
  createCenturionLabIndexHandler,
  createWiredCenturionLabIndexHandler,
} from '../src/http/centurion-lab-index.js';
import { describe, expect, it, vi } from 'vitest';

describe('centurion lab index route', () => {
  it('returns 401 without session', async () => {
    const handler = createCenturionLabIndexHandler({
      getSession: async () => null,
      userHasMailboxAccess: async () => true,
      readIndex: async () => Buffer.from('{"rows":[]}'),
    });
    const res = await handler(new Request('http://x/api/lab/centurion-index'));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
  });

  it('returns 403 when the session has no mailbox access', async () => {
    const handler = createCenturionLabIndexHandler({
      getSession: async () => ({ user: { id: 'u1' } }),
      userHasMailboxAccess: async () => false,
      readIndex: async () => Buffer.from('{"rows":[]}'),
    });
    const res = await handler(new Request('http://x/api/lab/centurion-index'));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('');
  });

  it('returns 404 when the private index is missing', async () => {
    const handler = createCenturionLabIndexHandler({
      getSession: async () => ({ user: { id: 'u1' } }),
      userHasMailboxAccess: async () => true,
      readIndex: async () => null,
    });
    const res = await handler(new Request('http://x/api/lab/centurion-index'));
    expect(res.status).toBe(404);
  });

  it('returns private JSON for a cookie session with mailbox access', async () => {
    const payload = Buffer.from('{"generated":"test","rows":[{"inboundId":"x"}]}');
    const handler = createCenturionLabIndexHandler({
      getSession: async () => ({ user: { id: 'u1' } }),
      userHasMailboxAccess: async () => true,
      readIndex: async () => payload,
    });
    const res = await handler(new Request('http://x/api/lab/centurion-index'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.text()).toBe(payload.toString());
  });

  it('forwards the session cookie to wired auth', async () => {
    const getSession = vi.fn(async (_input: { headers: Headers }) => null);
    const handler = createWiredCenturionLabIndexHandler({
      api: { getSession },
    } as never);
    const request = new Request('https://nava.legacyhotels.co.za/api/lab/centurion-index', {
      headers: { cookie: 'better-auth.session_token=lab-session' },
    });
    const res = await handler(request);
    expect(res.status).toBe(401);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(getSession.mock.calls[0]?.[0]?.headers.get('cookie')).toBe(
      'better-auth.session_token=lab-session',
    );
  });
});
