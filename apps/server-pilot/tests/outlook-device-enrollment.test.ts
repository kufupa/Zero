import { randomBytes, randomUUID, createHmac, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { withTestDb, openTestDbSession, TEST_DB_AVAILABLE } from './helpers/test-db.js';
import { user } from '../src/db/schema/auth.js';
import { mailboxAccess, mailboxTransport } from '../src/db/schema/mail.js';
import { outlookDevice, outlookDeviceGrant, outlookDeviceNonce } from '../src/db/schema/outlook-device.js';
import { issueEnrollment, enrollDevice, issueChallenge, verifyDeviceRequest, revokeDevice, isDeviceAuthorized, wrappingKey } from '../src/outlook-security/device.js';
import { createOutlookNativeHandler } from '../src/http/outlook-native.js';

const key = randomBytes(32).toString('base64');
const secret = randomBytes(32).toString('base64');
const storeId = '0000000038A1B1C1D1E1F1A1';
const otherStoreId = '0000000038A1B1C1D1E1F1A2';
const method = 'POST';
const path = '/api/outlook/native/authorize';

describe.skipIf(!TEST_DB_AVAILABLE)('Outlook device enrollment (disposable PostgreSQL)', () => {
  it('pairs one time with actual approved store and persists only wrapped secret', async () => {
    await withTestDb(async (db) => {
      const ids = await fixtures(db);
      const code = await issueEnrollment(db, { ...ids, storeId });
      const deviceId = randomUUID();
      const input = { code, deviceId, storeId, version: '4', secret };
      expect(await enrollDevice(db, input, key)).toEqual({ deviceId });
      expect(await enrollDevice(db, { ...input, deviceId: randomUUID() }, key)).toBeNull();
      const [saved] = await db.select().from(outlookDevice).where(eq(outlookDevice.deviceId,deviceId));
      expect(saved.secretCiphertext).not.toContain(secret);
      expect(saved.secretCiphertext).not.toContain(code);
      expect(saved.storeId).toBe(storeId);
      expect(await isDeviceAuthorized(db, deviceId, ids.userId, ids.transportId, storeId)).toBe(true);
      expect(await isDeviceAuthorized(db, deviceId, ids.userId, ids.transportId, otherStoreId)).toBe(false);
      expect(await isDeviceAuthorized(db, deviceId, randomUUID(), ids.transportId, storeId)).toBe(false);
      expect(await isDeviceAuthorized(db, deviceId, ids.userId, randomUUID(), storeId)).toBe(false);
      expect((await db.select().from(outlookDeviceGrant).where(eq(outlookDeviceGrant.deviceId, deviceId))).length).toBe(1);
    });
  });

  it('rejects guessed, expired and incorrect-store pairing without consuming valid code', async () => {
    await withTestDb(async (db) => {
      const ids = await fixtures(db);
      const code = await issueEnrollment(db, { ...ids, storeId });
      const input = { code, deviceId: randomUUID(), storeId, version: '4', secret };
      expect(await enrollDevice(db, { ...input, code: randomBytes(32).toString('base64url') }, key)).toBeNull();
      expect(await enrollDevice(db, { ...input, storeId: otherStoreId }, key)).toBeNull();
      expect(await enrollDevice(db, input, key)).toEqual({ deviceId: input.deviceId });
      const expiredCode = await issueEnrollment(db, { ...ids, storeId, expiresAt: new Date(Date.now() - 1) });
      expect(await enrollDevice(db, { ...input, code: expiredCode, deviceId: randomUUID() }, key)).toBeNull();
    });
  });

  it('never issues a custom operator approval lasting even one second beyond ten minutes', async () => {
    await withTestDb(async (db) => {
      const ids = await fixtures(db);
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        await expect(issueEnrollment(db, { ...ids, storeId,
          expiresAt: new Date(now + 10 * 60_000 + 1) })).rejects.toThrow(/10 minutes/);
      } finally {
        clock.mockRestore();
      }
    });
  });

  it('only one simultaneous independent connection can consume a code', async () => {
    const first = openTestDbSession();
    const second = openTestDbSession();
    try {
      const ids = await fixtures(first.db);
      const code = await issueEnrollment(first.db, { ...ids, storeId });
      const outcomes = await Promise.all([first.db, second.db].map((db) =>
        enrollDevice(db, { code, deviceId: randomUUID(), storeId, version: '4', secret }, key)));
      expect(outcomes.filter(Boolean)).toHaveLength(1);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('only one simultaneous independent connection can consume the same signed nonce', async () => {
    const first = openTestDbSession();
    const second = openTestDbSession();
    try {
      const ids = await fixtures(first.db);
      const deviceId = randomUUID();
      const code = await issueEnrollment(first.db, { ...ids, storeId });
      await enrollDevice(first.db, { code, deviceId, storeId, version: '4', secret }, key);
      const nonce = await issueChallenge(first.db, deviceId, key);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = Buffer.from('{"one":true}');
      const signature = createHmac('sha256', Buffer.from(secret, 'base64'))
        .update(['nava-outlook-v4', method, path, createHash('sha256').update(body).digest('hex'), deviceId, timestamp, nonce].join('\n')).digest('hex');
      const signed = { deviceId, nonce, timestamp, signature, method, path, body };
      const outcomes = await Promise.all([first.db, second.db].map((db) => verifyDeviceRequest(db, signed, key)));
      expect(outcomes.filter(Boolean)).toHaveLength(1);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('requires a canonical strong independent wrapping key', () => {
    expect(() => wrappingKey(undefined)).toThrow();
    expect(() => wrappingKey('too-short')).toThrow();
    expect(wrappingKey(key).length).toBe(32);
  });

  it('refuses to issue an approval for a staff account with unverified email', async () => {
    await withTestDb(async (db) => {
      const ids = await fixtures(db, false);
      await expect(issueEnrollment(db, { ...ids, storeId })).rejects.toThrow(/verified/i);
    });
  });

  it('operator CLI also refuses unverified named staff before creating an enrollment', async () => {
    const session = openTestDbSession();
    try {
      const ids = await fixtures(session.db, false);
      const [staff] = await session.db.select({ email: user.email }).from(user).where(eq(user.id, ids.userId));
      const [transport] = await session.db.select({ email: mailboxTransport.email }).from(mailboxTransport).where(eq(mailboxTransport.id, ids.transportId));
      const attempt = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/outlook-device-operator.ts',
        'issue', '--store-id', storeId, '--staff-email', staff.email, '--transport-email', transport.email], {
        cwd: process.cwd(), encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL,
          NAVA_OUTLOOK_DEVICE_WRAPPING_KEY: key, NODE_ENV: 'test', PORT: '8788',
          BETTER_AUTH_URL: 'https://localhost.test', BETTER_AUTH_SECRET: 'test-secret-of-at-least-32-characters',
          AWS_REGION: 'us-east-1', S3_BUCKET: 'outlook-disposable-test-bucket' },
      });
      expect(attempt.status).toBe(1);
      expect(attempt.stderr).toMatch(/verified named staff/i);
      expect(attempt.stdout).toBe('');
    } finally { await session.close(); }
  });

  it('uses database wall clock when a nonce expires after the JavaScript pre-check', async () => {
    await withTestDb(async (db) => {
      const ids = await fixtures(db);
      const deviceId = randomUUID();
      const code = await issueEnrollment(db, { ...ids, storeId });
      await enrollDevice(db, { code, deviceId, storeId, version: '4', secret }, key);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 120_000);
      try {
        const nonce = await issueChallenge(db, deviceId, key);
        const timestamp = String(Math.floor(Date.now() / 1000));
        const body = Buffer.from('{}');
        const signature = createHmac('sha256', Buffer.from(secret, 'base64'))
          .update(['nava-outlook-v4', method, path, createHash('sha256').update(body).digest('hex'), deviceId, timestamp, nonce].join('\n')).digest('hex');
        expect(await verifyDeviceRequest(db, { deviceId, nonce, timestamp, signature, method, path, body }, key)).toBeNull();
        expect(await db.select().from(outlookDeviceNonce).where(eq(outlookDeviceNonce.deviceId, deviceId))).toHaveLength(0);
      } finally { clock.mockRestore(); }
    });
  });

  it('rejects identifiers that are not random UUID v4', async () => {
    await withTestDb(async (db) => {
      const ids = await fixtures(db);
      const code = await issueEnrollment(db, { ...ids, storeId });
      const nonV4 = '00000000-0000-1000-8000-000000000001';
      expect(await enrollDevice(db, { code, deviceId: nonV4, storeId, version: '4', secret }, key)).toBeNull();
      expect(await enrollDevice(db, { code, deviceId: randomUUID(), storeId, version: '4', secret }, key)).toMatchObject({ deviceId: expect.any(String) });
    });
  });

  it('bounds unread chunked uploads before buffering the whole unauthenticated body', async () => {
    await withTestDb(async (db) => {
      let chunksRead = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksRead++;
          controller.enqueue(new Uint8Array(2048));
          if (chunksRead === 100) controller.close();
        },
        cancel() { cancelled = true; },
      });
      const request = new Request('https://nava.legacyhotels.co.za/api/outlook/native/enroll', {
        method: 'POST', body, duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      expect(request.headers.get('content-length')).toBeNull();
      const response = await createOutlookNativeHandler(db, key)(request);
      expect(response.status).toBe(413);
      expect(chunksRead).toBeLessThan(10);
      expect(cancelled).toBe(true);
    });
  });

  it('authenticates exact bytes once; rejects tamper, replay, revocation and wrong key', async () => {
    await withTestDb(async (db) => {
      const ids = await fixtures(db);
      const deviceId = randomUUID();
      const code = await issueEnrollment(db, { ...ids, storeId });
      await enrollDevice(db, { code, deviceId, storeId, version: '4', secret }, key);
      const body = Buffer.from('{"a":1}');
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sign = (nonce: string, bytes: Buffer) => createHmac('sha256', Buffer.from(secret, 'base64'))
        .update(['nava-outlook-v4', method, path, createHash('sha256').update(bytes).digest('hex'), deviceId, timestamp, nonce].join('\n'))
        .digest('hex');
      const nonce = await issueChallenge(db, deviceId, key);
      expect(nonce).not.toBeNull();
      const signed = { deviceId, nonce: nonce!, timestamp, signature: sign(nonce!, body), method, path, body };
      expect(await verifyDeviceRequest(db, signed, key)).toMatchObject({ deviceId, storeId, version: '4' });
      expect(await verifyDeviceRequest(db, signed, key)).toBeNull();
      const nonce2 = (await issueChallenge(db, deviceId, key))!;
      expect(await verifyDeviceRequest(db, { ...signed, nonce: nonce2, body: Buffer.from('{"a":2}'), signature: sign(nonce2, body) }, key)).toBeNull();
      expect(await verifyDeviceRequest(db, { ...signed, nonce: nonce2, signature: sign(nonce2, body) }, key)).toMatchObject({ deviceId });
      const nonce3 = (await issueChallenge(db, deviceId, key))!;
      expect(await verifyDeviceRequest(db, { ...signed, nonce: nonce3, signature: sign(nonce3, body) }, randomBytes(32).toString('base64'))).toBeNull();
      await revokeDevice(db, deviceId);
      expect((await issueChallenge(db, deviceId, key)).length).toBe(nonce3.length);
      expect(await isDeviceAuthorized(db, deviceId, ids.userId, ids.transportId, storeId)).toBe(false);
      expect(await verifyDeviceRequest(db, { ...signed, nonce: nonce3, signature: sign(nonce3, body) }, key)).toBeNull();
      expect((await db.select().from(outlookDeviceNonce)).length).toBeGreaterThan(0);
    });
  });

  it('returns no secrets or approvals through public enrollment and challenge HTTP', async () => {
    await withTestDb(async (db) => {
      const ids = await fixtures(db);
      const code = await issueEnrollment(db, { ...ids, storeId });
      const deviceId = randomUUID();
      const handler = createOutlookNativeHandler(db, key);
      const response = await handler(new Request('https://nava.legacyhotels.co.za/api/outlook/native/enroll', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, deviceId, storeId, version: '4', secret }),
      }));
      expect(response.status).toBe(200);
      const content = await response.text();
      expect(content).not.toContain(secret);
      expect(content).not.toContain(code);
      expect(content).not.toContain(ids.userId);
      expect(content).not.toContain(ids.transportId);
      const challenge = await handler(new Request('https://nava.legacyhotels.co.za/api/outlook/native/challenge', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId }),
      }));
      expect(challenge.status).toBe(200);
      expect(await challenge.text()).not.toContain(secret);
    });
  });
});

async function fixtures(db: Parameters<typeof issueEnrollment>[0], emailVerified = true) {
  const userId = randomUUID();
  const transportId = randomUUID();
  await db.insert(user).values({ id: userId, name: 'Named Staff', email: `${userId}@example.test`, emailVerified });
  await db.insert(mailboxTransport).values({ id: transportId, email: `${transportId}@example.test`, ownerHeaderValue: transportId });
  await db.insert(mailboxAccess).values({ id: randomUUID(), userId, transportId, role: 'member' });
  return { userId, transportId };
}
