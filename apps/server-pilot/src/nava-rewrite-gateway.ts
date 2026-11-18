import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { readPaneFilingAttachment } from './mail/pane-filing-attachment.js';
import { getDb } from './db/client.js';
import { mailboxAccess, mailboxTransport } from './db/schema/mail.js';
import { resolvePropertyScope } from './hms/property-registry.js';
import { resolvePilotTrustedOrigins, type Auth } from './lib/auth.js';
import { canonicalCenturionPaneImport, isCenturionFilingSource } from './mail/nava-outlook-import.js';
import { getS3Storage } from './storage/s3.js';

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
  { method: 'POST', path: new RegExp(`^/api/nava/v1/proposals/${resourceId}/(?:undo|redo|quote|quote-artifacts|stage|go|reconcile|target|target/select)$`) },
  { method: 'GET', path: new RegExp(`^/api/nava/v1/artifacts/${resourceId}$`) },
  { method: 'POST', path: /^\/api\/nava\/v1\/internal\/filing-pdf$/ },
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

function hasEligibleCapability(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('workflows' in value) || !Array.isArray(value.workflows) ||
      !('tools' in value) || !Array.isArray(value.tools) || value.tools.includes('hms_save') ||
      !('workflow_capabilities' in value) || typeof value.workflow_capabilities !== 'object' || value.workflow_capabilities === null ||
      !('model' in value) || typeof value.model !== 'string' ||
      !('environment_type' in value) || typeof value.environment_type !== 'string' ||
      !('auth_ready' in value) || value.auth_ready !== true) return false;
  const capabilities = value.workflow_capabilities;
  const workflows = value.workflows;
  return ['triage', 'quote', 'create', 'amend', 'cancel', 'filing'].some(workflow => {
    if (!workflows.includes(workflow) || !(workflow in capabilities)) return false;
    const capability = Object.entries(capabilities).find(([key]) => key === workflow)?.[1];
    if (typeof capability !== 'object' || capability === null) return false;
    return workflow === 'quote'
      ? 'quote' in capability && capability.quote === true
      : 'stage' in capability && capability.stage === true;
  });
}

async function readImportBody(body: ReadableStream<Uint8Array>): Promise<Buffer | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(chunks);
      size += chunk.value.length;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); return null; }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}

const filingPdfRequest = z.object({
  actor: z.string().min(1).max(256), mailbox_id: z.string().min(1).max(256),
  source_thread_id: z.string().min(1).max(256), message_id: z.string().min(1).max(256),
  attachment_id: z.string().min(1).max(256), exp: z.number().int(),
}).strict();

async function readFilingPdf(request: Request, secret: string): Promise<Response> {
  if (!request.body) return error(400, 'invalid_input', 'Filing source is required');
  const raw = await readImportBody(request.body);
  if (raw === null) return error(413, 'invalid_input', 'Filing request is too large');
  const signature = request.headers.get('x-nava-filing-signature');
  if (!signature || !/^[a-f0-9]{64}$/.test(signature)) return error(403, 'forbidden', 'Filing source unavailable');
  const expected = createHmac('sha256', secret).update('nava-filing-pdf-v1\n').update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return error(403, 'forbidden', 'Filing source unavailable');
  let payload: unknown;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { return error(400, 'invalid_input', 'Invalid filing request'); }
  const parsed = filingPdfRequest.safeParse(payload);
  if (!parsed.success) return error(400, 'invalid_input', 'Invalid filing request');
  const input = parsed.data;
  const fresh = () => input.exp > Math.floor(Date.now() / 1000) && input.exp <= Math.floor(Date.now() / 1000) + 60;
  if (!fresh()) return error(403, 'forbidden', 'Filing source unavailable');
  const db = getDb();
  const checkAuthority = async () => {
    if (!fresh()) return false;
    const grants = await db.select({ transportId: mailboxAccess.transportId }).from(mailboxAccess)
      .innerJoin(mailboxTransport, eq(mailboxAccess.transportId, mailboxTransport.id))
      .where(eq(mailboxAccess.userId, input.actor));
    return grants.some(grant => grant.transportId === input.mailbox_id) && await isCenturionFilingSource({
      mailboxId: input.mailbox_id, conversationId: input.source_thread_id,
      messageId: input.message_id, attachmentId: input.attachment_id,
    });
  };
  const source = await readPaneFilingAttachment({ db, s3: getS3Storage(), transportId: input.mailbox_id,
    messageId: input.message_id, attachmentId: input.attachment_id,
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]), checkAuthority });
  if (!source) return error(404, 'not_found', 'Filing source unavailable');
  return new Response(Uint8Array.from(source.bytes), { headers: {
    'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  } });
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

function expireEventStream(body: ReadableStream<Uint8Array>, expiresAtMs: number, shutdown?: AbortSignal) {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  let finished = false;

  function cleanup() {
    if (timer) clearTimeout(timer);
    if (stop) shutdown?.removeEventListener('abort', stop);
  }

  function close(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (finished) return;
    finished = true;
    cleanup();
    controller.close();
    void reader.cancel().catch(() => {});
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const remaining = expiresAtMs - Date.now();
      if (remaining <= 0 || shutdown?.aborted) return close(controller);
      stop = () => close(controller);
      shutdown?.addEventListener('abort', stop, { once: true });
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
        cleanup();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      cleanup();
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

export function createNavaRewriteGateway(auth: Auth, eventShutdown?: AbortSignal) {
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
        if (id === '.' || id === '..' || id.includes('/') || id.includes('\\') || id.includes('%') || /\p{Cc}/u.test(id)) {
          return error(404, 'not_found', 'Not found');
        }
      } catch {
        return error(404, 'not_found', 'Not found');
      }
    }

    const agentOrigin = configuredAgentOrigin(process.env.NAVA_AGENT_BASE_URL);
    const secret = process.env.NAVA_STAFF_JWT_SECRET;
    const isEligibility = request.method === 'GET' && url.pathname === '/api/nava/v1/eligibility';
    if (!agentOrigin || !secret || Buffer.byteLength(secret) < 32) {
      if (isEligibility) return eligibility(false);
      return error(503, 'gateway_unavailable', 'Gateway is not configured');
    }
    if (request.method === 'POST' && url.pathname === '/api/nava/v1/internal/filing-pdf') {
      try { return await readFilingPdf(request, secret); }
      catch { return error(502, 'gateway_error', 'Filing source unavailable'); }
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
      const grants = await getDb()
        .select({ transportId: mailboxAccess.transportId })
        .from(mailboxAccess)
        .innerJoin(mailboxTransport, eq(mailboxAccess.transportId, mailboxTransport.id))
        .where(eq(mailboxAccess.userId, session.user.id));
      const mailboxIds = grants.map(grant => grant.transportId).filter(transportId => {
        try { return resolvePropertyScope({ transportId }).propertyCode === 'HRCEN'; }
        catch { return false; }
      });
      if (!mailboxIds.length) {
        return isEligibility ? eligibility(false) : error(403, 'forbidden', 'Mailbox access required');
      }

      const staff = staffToken(session.user.id, mailboxIds, secret);
      if (isEligibility) {
        const mailboxes = url.searchParams.getAll('mailbox_id');
        if (mailboxes.length !== 1 || !mailboxIds.includes(mailboxes[0])) return eligibility(false);
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
        return eligibility(hasEligibleCapability(capabilities));
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
      if (request.method === 'POST' && url.pathname === '/api/nava/v1/threads') {
        if (!request.body) return error(400, 'invalid_input', 'A selected mail thread is required');
        const body = await readImportBody(request.body);
        if (body === null) return error(413, 'invalid_input', 'Mail thread is too large');
        let payload: unknown;
        try { payload = JSON.parse(body.toString('utf8')); }
        catch { return error(400, 'invalid_input', 'Invalid mail thread'); }
        const requested = z.object({ mailbox_id: z.string() }).safeParse(payload);
        if (!requested.success || !mailboxIds.includes(requested.data.mailbox_id)) {
          return error(403, 'source_not_eligible', 'This email is not an eligible Centurion source');
        }
        const canonical = await canonicalCenturionPaneImport(payload, requested.data.mailbox_id);
        if (!canonical) {
          return error(403, 'source_not_eligible', 'This email is not an eligible Centurion source');
        }
        const canonicalBody = JSON.stringify(canonical);
        headers.set('idempotency-key', createHash('sha256').update(canonicalBody).digest('hex'));
        init.body = canonicalBody;
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
        ? expireEventStream(upstream.body, staff.expiresAtMs, eventShutdown)
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
