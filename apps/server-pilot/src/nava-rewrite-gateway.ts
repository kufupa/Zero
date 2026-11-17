import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from './db/client.js';
import { mailboxAccess, mailboxTransport } from './db/schema/mail.js';
import { resolvePilotTrustedOrigins, type Auth } from './lib/auth.js';
import { signNavaAttachmentCoverage, validCoverageRequest } from './mail/nava-attachment-coverage.js';

const resourceId = '([^/]+)';
const routes: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^\/api\/nava\/v1\/threads$/ },
  { method: 'GET', path: new RegExp(`^/api/nava/v1/threads/${resourceId}$`) },
  { method: 'GET', path: new RegExp(`^/api/nava/v1/threads/${resourceId}/events$`) },
  { method: 'GET', path: new RegExp(`^/api/nava/v1/threads/${resourceId}/staff-edits$`) },
  { method: 'POST', path: new RegExp(`^/api/nava/v1/threads/${resourceId}/messages$`) },
  { method: 'GET', path: /^\/api\/nava\/v1\/capabilities$/ },
  { method: 'GET', path: /^\/api\/nava\/v1\/eligibility$/ },
  { method: 'PATCH', path: new RegExp(`^/api/nava/v1/proposals/${resourceId}$`) },
  { method: 'POST', path: new RegExp(`^/api/nava/v1/proposals/${resourceId}/(?:undo|redo|quote|stage|reconcile)$`) },
  { method: 'GET', path: new RegExp(`^/api/nava/v1/artifacts/${resourceId}$`) },
];

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, details: null } }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function eligibility(eligible: boolean): Response {
  return Response.json({ eligible }, { headers: { 'Cache-Control': 'private, no-store' } });
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

async function readImportBody(body: ReadableStream<Uint8Array>): Promise<string | null> {
  const limit=2*1024*1024, reader=body.getReader(), chunks:Uint8Array[]=[];
  let size=0;
  try {
    for (;;) {
      const next=await reader.read();
      if(next.done) break;
      size+=next.value.length;
      if(size>limit) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
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
    if (request.method==='POST' && url.pathname==='/api/nava/v1/internal/attachment-coverage') {
      const secret=process.env.NAVA_STAFF_JWT_SECRET, mailbox=process.env.NAVA_REWRITE_COHORT_MAILBOX_ID;
      if (!secret || Buffer.byteLength(secret)<32 || !mailbox || !request.body) return error(403,'forbidden','Coverage unavailable');
      const raw=await readImportBody(request.body).catch(()=>null);
      if (raw===null) return error(413,'import_too_large','Selected conversation is too large');
      const challenge=validCoverageRequest(raw,request.headers.get('X-Nava-Coverage-Request'),secret);
      if (!challenge) return error(403,'forbidden','Coverage unavailable');
      const proof=await signNavaAttachmentCoverage(raw,mailbox,secret,challenge).catch(()=>null);
      if (!proof) return error(409,'attachments_unconfirmed','Attachment inventory unavailable');
      return Response.json({proof},{headers:{'Cache-Control':'no-store'}});
    }
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
    const cohortUserId = process.env.NAVA_REWRITE_COHORT_USER_ID;
    const cohortMailboxId = process.env.NAVA_REWRITE_COHORT_MAILBOX_ID;
    const isEligibility = request.method === 'GET' && url.pathname === '/api/nava/v1/eligibility';
    if (!agentOrigin || !secret || Buffer.byteLength(secret) < 32 || !cohortUserId || !cohortMailboxId) {
      if (isEligibility) return eligibility(false);
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
      if (!session?.user?.id) return isEligibility ? eligibility(false) : error(401, 'unauthorized', 'Authentication required');
      if (session.user.id !== cohortUserId) return isEligibility ? eligibility(false) : error(403, 'forbidden', 'Rewrite is not available');

      const grants = await getDb()
        .select({ transportId: mailboxAccess.transportId })
        .from(mailboxAccess)
        .innerJoin(mailboxTransport, eq(mailboxAccess.transportId, mailboxTransport.id))
        .where(eq(mailboxAccess.userId, session.user.id));
      if (!grants.some((grant) => grant.transportId === cohortMailboxId)) {
        return isEligibility ? eligibility(false) : error(403, 'forbidden', 'Mailbox access required');
      }

      const staff = staffToken(session.user.id, [cohortMailboxId], secret);
      if (isEligibility) {
        const mailboxes = url.searchParams.getAll('mailbox_id');
        if (mailboxes.length !== 1 || mailboxes[0] !== cohortMailboxId) return eligibility(false);
        const response = await fetch(`${agentOrigin}/api/nava/v1/capabilities`, {
          headers: { Authorization: `Bearer ${staff.token}` },
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          await response.body?.cancel();
          return eligibility(false);
        }
        const capabilities: unknown = await response.json();
        return eligibility(typeof capabilities === 'object' && capabilities !== null &&
          'workflows' in capabilities && Array.isArray(capabilities.workflows) && capabilities.workflows.includes('create') &&
          'tools' in capabilities && Array.isArray(capabilities.tools) && capabilities.tools.includes('hms_prepare') && !capabilities.tools.includes('hms_save') &&
          'model' in capabilities && typeof capabilities.model === 'string' &&
          'environment_type' in capabilities && typeof capabilities.environment_type === 'string' &&
          'auth_ready' in capabilities && capabilities.auth_ready === true);
      }
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
      if (request.method==='POST' && url.pathname==='/api/nava/v1/threads' && request.body) {
        const raw=await readImportBody(request.body);
        if(raw===null) return error(413,'import_too_large','Selected conversation is too large');
        const issued=String(Date.now());
        const proof=await signNavaAttachmentCoverage(raw,cohortMailboxId,secret,issued).catch(()=>null);
        if(proof) headers.set('X-Nava-Attachment-Coverage',`${issued}.${proof}`);
        init.body=raw;
      } else if (request.method !== 'GET' && request.body) {
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
      if (isEligibility) return eligibility(false);
      return error(502, 'gateway_error', 'Gateway request failed');
    }
  };
}
