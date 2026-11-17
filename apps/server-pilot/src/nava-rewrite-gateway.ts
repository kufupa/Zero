import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from './db/client.js';
import { mailboxAccess, mailboxTransport } from './db/schema/mail.js';
import { resolvePilotTrustedOrigins, type Auth } from './lib/auth.js';

const resourceId = '([^/]+)';
const routes: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^\/api\/nava\/v1\/threads$/ },
  { method: 'GET', path: new RegExp(`^/api/nava/v1/threads/${resourceId}$`) },
  { method: 'GET', path: new RegExp(`^/api/nava/v1/threads/${resourceId}/events$`) },
  { method: 'GET', path: new RegExp(`^/api/nava/v1/threads/${resourceId}/staff-edits$`) },
  { method: 'POST', path: new RegExp(`^/api/nava/v1/threads/${resourceId}/messages$`) },
  { method: 'GET', path: /^\/api\/nava\/v1\/capabilities$/ },
  { method: 'PATCH', path: new RegExp(`^/api/nava/v1/proposals/${resourceId}$`) },
  { method: 'POST', path: new RegExp(`^/api/nava/v1/proposals/${resourceId}/(?:undo|redo|quote|stage|go|reconcile)$`) },
  { method: 'GET', path: new RegExp(`^/api/nava/v1/artifacts/${resourceId}$`) },
];

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, details: null } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function configuredAgentOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function staffToken(userId: string, mailboxIds: string[], secret: string) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 300;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: userId, aud: 'nava-agent', mailbox_ids: mailboxIds, iat: now, exp: expiresAt,
  })}`;
  return {
    token: `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`,
    expiresAtMs: expiresAt * 1000,
  };
}

function expireEventStream(body: ReadableStream<Uint8Array>, expiresAtMs: number) {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;

  function close(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    controller.close();
    void reader.cancel().catch(() => {});
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const remaining = expiresAtMs - Date.now();
      if (remaining <= 0) return close(controller);
      timer = setTimeout(() => close(controller), remaining);
      timer.unref();
    },
    async pull(controller) {
      if (Date.now() >= expiresAtMs) return close(controller);
      try {
        const chunk = await reader.read();
        if (finished) return;
        if (chunk.done || Date.now() >= expiresAtMs) return close(controller);
        controller.enqueue(chunk.value);
      } catch (error) {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

export function createNavaRewriteGateway(auth: Auth) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const match = routes
      .filter((route) => route.method === request.method)
      .map((route) => route.path.exec(url.pathname))
      .find((candidate) => candidate !== null);
    if (!match) return error(404, 'not_found', 'Not found');
    if (match[1]) {
      try {
        const id = decodeURIComponent(match[1]);
        if (id === '.' || id === '..' || /[\/\\%\x00-\x1f\x7f]/.test(id)) {
          return error(404, 'not_found', 'Not found');
        }
      } catch {
        return error(404, 'not_found', 'Not found');
      }
    }

    const agentOrigin = configuredAgentOrigin(process.env.NAVA_AGENT_BASE_URL);
    const secret = process.env.NAVA_STAFF_JWT_SECRET;
    if (!agentOrigin || !secret || Buffer.byteLength(secret) < 32) {
      return error(503, 'gateway_unavailable', 'Gateway is not configured');
    }
    if (request.method !== 'GET') {
      const origin = request.headers.get('origin');
      if (!origin || !resolvePilotTrustedOrigins().includes(origin)) {
        return error(403, 'forbidden', 'Untrusted request origin');
      }
    }

    try {
      // Only the Better Auth cookie can establish identity, never forwarded identity headers.
      const sessionHeaders = new Headers();
      const cookie = request.headers.get('cookie');
      if (cookie) sessionHeaders.set('cookie', cookie);
      const session = await auth.api.getSession({ headers: sessionHeaders });
      if (!session?.user?.id) return error(401, 'unauthorized', 'Authentication required');

      const grants = await getDb()
        .select({ transportId: mailboxAccess.transportId })
        .from(mailboxAccess)
        .innerJoin(mailboxTransport, eq(mailboxAccess.transportId, mailboxTransport.id))
        .where(eq(mailboxAccess.userId, session.user.id));
      if (!grants.length) return error(403, 'forbidden', 'Mailbox access required');

      const staff = staffToken(session.user.id, grants.map((grant) => grant.transportId), secret);
      const headers = new Headers({
        Authorization: `Bearer ${staff.token}`,
        'Accept-Encoding': 'identity',
      });
      for (const name of ['accept', 'content-type', 'idempotency-key', 'last-event-id', 'range', 'if-none-match', 'if-modified-since']) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }

      const init: RequestInit & { duplex?: 'half' } = {
        method: request.method,
        headers,
        redirect: 'manual',
        signal: request.signal,
      };
      if (request.method !== 'GET' && request.body) {
        init.body = request.body;
        init.duplex = 'half';
      }
      const upstream = await fetch(`${agentOrigin}${url.pathname}${url.search}`, init);
      if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.has('location')) {
        await upstream.body?.cancel();
        return error(502, 'gateway_error', 'Unexpected upstream redirect');
      }
      const responseHeaders = new Headers(upstream.headers);
      const connection = responseHeaders.get('connection');
      if (connection) {
        for (const header of connection.split(',')) responseHeaders.delete(header.trim());
      }
      for (const header of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
        'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'content-encoding',
        'set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials']) {
        responseHeaders.delete(header);
      }
      responseHeaders.set('Cache-Control', 'private, no-store');
      responseHeaders.set('X-Content-Type-Options', 'nosniff');
      const isEventStream = responseHeaders.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'text/event-stream';
      if (isEventStream) {
        responseHeaders.set('X-Accel-Buffering', 'no');
      }
      const body = isEventStream && upstream.body
        ? expireEventStream(upstream.body, staff.expiresAtMs)
        : upstream.body;
      return new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch {
      return error(502, 'gateway_error', 'Gateway request failed');
    }
  };
}
