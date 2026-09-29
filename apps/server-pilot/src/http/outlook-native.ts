import type { DB } from '../db/client.js';
import { randomBytes } from 'node:crypto';
import { enrollDevice, issueChallenge, verifyDeviceRequest, wrappingKey } from '../outlook-security/device.js';
import { authorizeNative, registerNavigation, type NativeScopeInput } from '../outlook-security/authorization.js';

async function readBoundedJsonBody(request: Request, maxBytes: number): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        // Do not wait for an attacker-controlled stream to acknowledge cancel.
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

/** Public native bootstrap only. Task 3 adds signed native routes after verifying HMAC. */
export function createOutlookNativeHandler(db: DB, key: string) {
  // Validate at handler construction so a missing/weak deployment key fails closed.
  wrappingKey(key);
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const path = new URL(request.url).pathname;
    if (!['/api/outlook/native/enroll', '/api/outlook/native/challenge', '/api/outlook/native/bootstrap',
      '/api/outlook/native/register-navigation', '/api/outlook/native/authorize'].includes(path)) return new Response(null, { status: 404 });
    if (new URL(request.url).search) return new Response(null, { status: 400 });
    // Signed batch EntryIDs are larger than enrollment; still cap streaming uploads.
    const maxBytes = path.endsWith('/authorize') ? 32_768 : 4096;
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > maxBytes) {
      void request.body?.cancel().catch(() => undefined);
      return new Response(null, { status: 413 });
    }
    let input: unknown;
    let body: Buffer;
    try {
      const raw = await readBoundedJsonBody(request, maxBytes);
      if (raw === null) return new Response(null, { status: 413 });
      body = raw;
      input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch { return new Response(null, { status: 400 }); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return new Response(null, { status: 400 });
    const values = input as Record<string, unknown>;
    if (path.endsWith('/bootstrap')) return Response.json({ protocol: 'nava-outlook-v4', status: 'ready',
      paneChallenge: randomBytes(32).toString('base64url'), expiresInSeconds: 60 },
    { headers: { 'cache-control': 'no-store' } });
    if (path.endsWith('/authorize') || path.endsWith('/register-navigation')) {
      const verified = await verifyDeviceRequest(db, {
        deviceId: request.headers.get('x-nava-device-id') ?? '', nonce: request.headers.get('x-nava-nonce') ?? '',
        timestamp: request.headers.get('x-nava-timestamp') ?? '', signature: request.headers.get('x-nava-signature') ?? '',
        method: request.method, path, body,
      }, key);
      if (!verified) return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } });
      if (path.endsWith('/register-navigation')) {
        const ok = await registerNavigation(db, verified.deviceId, values.paneChallenge as string);
        return Response.json({ registered: ok }, { status: ok ? 200 : 403, headers: { 'cache-control': 'no-store' } });
      }
      const valid = typeof values.ticket === 'string' && typeof values.action === 'string'
        && typeof values.storeId === 'string' && typeof values.transportId === 'string'
        && values.storeId === verified.storeId && typeof values.operationId !== 'number';
      if (!valid) return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } });
      const authorized = await authorizeNative(db, verified.deviceId, values as NativeScopeInput);
      return authorized ? Response.json(authorized, { headers: { 'cache-control': 'no-store' } })
        : new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } });
    }
    if (path.endsWith('/challenge')) {
      if (typeof values.deviceId !== 'string' || values.deviceId.length > 128) return new Response(null, { status: 400 });
      const nonce = await issueChallenge(db, values.deviceId, key);
      return Response.json({ nonce, expiresInSeconds: 60 }, { headers: { 'cache-control': 'no-store' } });
    }
    if (typeof values.code !== 'string' || typeof values.deviceId !== 'string' || typeof values.storeId !== 'string'
      || typeof values.version !== 'string' || typeof values.secret !== 'string'
      || values.code.length > 128 || values.deviceId.length > 128 || values.storeId.length > 512
      || values.version.length > 16 || values.secret.length > 128) return new Response(null, { status: 400 });
    const result = await enrollDevice(db, {
      code: values.code, deviceId: values.deviceId, storeId: values.storeId,
      version: values.version, secret: values.secret,
    }, key);
    return Response.json(result ? { enrolled: true } : { enrolled: false }, {
      status: result ? 200 : 403, headers: { 'cache-control': 'no-store' },
    });
  };
}
