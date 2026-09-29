import type { DB } from '../db/client.js';
import { enrollDevice, issueChallenge, wrappingKey } from '../outlook-security/device.js';

async function readBoundedJsonBody(request: Request): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) {
        // Do not wait for an attacker-controlled stream to acknowledge cancel.
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
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
    if (path !== '/api/outlook/native/enroll' && path !== '/api/outlook/native/challenge') return new Response(null, { status: 404 });
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > 4096) {
      void request.body?.cancel().catch(() => undefined);
      return new Response(null, { status: 413 });
    }
    let input: unknown;
    try {
      const body = await readBoundedJsonBody(request);
      if (body === null) return new Response(null, { status: 413 });
      input = JSON.parse(body);
    } catch { return new Response(null, { status: 400 }); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return new Response(null, { status: 400 });
    const values = input as Record<string, unknown>;
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
