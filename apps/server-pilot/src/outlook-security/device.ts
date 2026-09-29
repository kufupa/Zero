import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lt, isNull, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { mailboxAccess, mailboxTransport } from '../db/schema/mail.js';
import { user } from '../db/schema/auth.js';
import { outlookEnrollment, outlookEnrollmentGrant, outlookDevice, outlookDeviceGrant, outlookDeviceNonce } from '../db/schema/outlook-device.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Configure NAVA_OUTLOOK_DEVICE_WRAPPING_KEY as exactly 32 random base64 bytes, separate from auth/DB keys. */
export function wrappingKey(raw: string | undefined): Buffer {
  if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) throw new Error('Outlook device wrapping key is not configured');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) throw new Error('Invalid Outlook device wrapping key');
  return key;
}

function encrypt(secret: Buffer, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

function decrypt(ciphertext: string, key: Buffer): Buffer {
  const payload = Buffer.from(ciphertext, 'base64');
  if (payload.length !== 60) throw new Error('Invalid stored device key');
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
}

export type StaffMailboxGrant = { userId: string; transportId: string };

/** Operator-only: caller must supply named staff and transport IDs, never display names. */
export async function issueEnrollment(db: DB, input: { storeId: string; expiresAt?: Date } & StaffMailboxGrant & { grants?: StaffMailboxGrant[] }): Promise<string> {
  const grants = input.grants ?? [{ userId: input.userId, transportId: input.transportId }];
  if (!input.storeId || input.storeId.length > 512 || grants.length < 1 || grants.length > 25) throw new Error('Invalid operator approval');
  const code = randomBytes(32).toString('base64url');
  const expiry = input.expiresAt ?? new Date(Date.now() + 10 * 60_000);
  if (expiry.getTime() > Date.now() + 10 * 60_000 + 1000) throw new Error('Approval exceeds 10 minutes');
  await db.transaction(async (tx) => {
    for (const grant of grants) {
      const approved = await tx.select({ userId: user.id }).from(user)
        .innerJoin(mailboxAccess, eq(mailboxAccess.userId, user.id))
        .innerJoin(mailboxTransport, eq(mailboxTransport.id, mailboxAccess.transportId))
        .where(and(eq(user.id, grant.userId), eq(mailboxTransport.id, grant.transportId), eq(mailboxTransport.isActive, true)))
        .limit(1);
      if (approved.length !== 1) throw new Error('Staff must have active mailbox access');
    }
    await tx.insert(outlookEnrollment).values({ codeHash: digest(code), storeId: input.storeId, expiresAt: expiry });
    await tx.insert(outlookEnrollmentGrant).values(grants.map((g) => ({ ...g, codeHash: digest(code) })));
  });
  return code;
}

export async function enrollDevice(db: DB, input: { code: string; storeId: string; deviceId: string; version: string; secret: string }, rawKey: string): Promise<{ deviceId: string } | null> {
  const key = wrappingKey(rawKey);
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.code) || !/^[0-9a-fA-F-]{36}$/.test(input.deviceId)
    || !input.storeId || input.storeId.length > 512 || input.version !== '4'
    || !/^[A-Za-z0-9+/]{43}=$/.test(input.secret)) return null;
  const secret = Buffer.from(input.secret, 'base64');
  if (secret.length !== 32 || secret.toString('base64') !== input.secret) return null;
  return db.transaction(async (tx) => {
    // Conditional update locks the code row. The device/grant inserts commit with consumption.
    const claimed = await tx.update(outlookEnrollment).set({ consumedAt: new Date() })
      .where(and(eq(outlookEnrollment.codeHash, digest(input.code)), eq(outlookEnrollment.storeId, input.storeId),
        isNull(outlookEnrollment.consumedAt), gt(outlookEnrollment.expiresAt, sql`clock_timestamp()`)))
      .returning({ codeHash: outlookEnrollment.codeHash });
    if (claimed.length !== 1) return null;
    const grants = await tx.select({ userId: outlookEnrollmentGrant.userId, transportId: outlookEnrollmentGrant.transportId })
      .from(outlookEnrollmentGrant).where(eq(outlookEnrollmentGrant.codeHash, claimed[0].codeHash));
    if (!grants.length) throw new Error('Enrollment has no staff binding');
    const inserted = await tx.insert(outlookDevice).values({ deviceId: input.deviceId, version: input.version,
      storeId: input.storeId, secretCiphertext: encrypt(secret, key) }).onConflictDoNothing().returning({ deviceId: outlookDevice.deviceId });
    if (!inserted.length) throw new Error('Device identifier already enrolled');
    await tx.insert(outlookDeviceGrant).values(grants.map((grant) => ({ ...grant, deviceId: input.deviceId })));
    return { deviceId: input.deviceId };
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'Device identifier already enrolled') return null;
    throw error;
  });
}

/** Stateless public challenge, constant response shape for unknown and revoked IDs; no public issuance writes. */
export async function issueChallenge(_db: DB, deviceId: string, rawKey: string): Promise<string> {
  const payload = Buffer.alloc(40);
  randomBytes(32).copy(payload);
  payload.writeBigUInt64BE(BigInt(Date.now()), 32);
  const mac = createHmac('sha256', wrappingKey(rawKey)).update(deviceId).update(payload).digest();
  return Buffer.concat([payload, mac]).toString('base64url');
}

export type SignedDeviceRequest = { deviceId: string; nonce: string; timestamp: string; signature: string; method: string; path: string; body: Uint8Array };
export type VerifiedDevice = { deviceId: string; storeId: string; version: string };

/** Caller must pass the exact request bytes and pathname; null means deny. This does not authorize a staff operation. */
export async function verifyDeviceRequest(db: DB, request: SignedDeviceRequest, rawKey: string): Promise<VerifiedDevice | null> {
  const key = wrappingKey(rawKey);
  if (!/^[0-9a-fA-F-]{36}$/.test(request.deviceId) || !/^[A-Za-z0-9_-]{96}$/.test(request.nonce)
    || !/^\d{10}$/.test(request.timestamp) || !/^[0-9a-f]{64}$/.test(request.signature)
    || Math.abs(Date.now() / 1000 - Number(request.timestamp)) > 60
    || !/^[A-Z]+$/.test(request.method) || !request.path.startsWith('/api/outlook/native/')) return null;
  const nonce = Buffer.from(request.nonce, 'base64url');
  if (nonce.length !== 72 || nonce.toString('base64url') !== request.nonce
    || Math.abs(Date.now() - Number(nonce.readBigUInt64BE(32))) > 60_000
    || !timingSafeEqual(createHmac('sha256', key).update(request.deviceId).update(nonce.subarray(0, 40)).digest(), nonce.subarray(40))) return null;
  return db.transaction(async (tx) => {
    const [device] = await tx.select().from(outlookDevice)
      .where(and(eq(outlookDevice.deviceId, request.deviceId), isNull(outlookDevice.revokedAt))).limit(1);
    if (!device) return null;
    let secret: Buffer;
    try { secret = decrypt(device.secretCiphertext, key); } catch { return null; }
    const bodyHash = createHash('sha256').update(request.body).digest('hex');
    const message = ['nava-outlook-v4', request.method, request.path, bodyHash, request.deviceId, request.timestamp, request.nonce].join('\n');
    const expected = createHmac('sha256', secret).update(message).digest();
    const submitted = Buffer.from(request.signature, 'hex');
    if (!timingSafeEqual(expected, submitted)) return null;
    const claimed = await tx.insert(outlookDeviceNonce).values({ nonceHash: digest(request.nonce), deviceId: request.deviceId,
      expiresAt: new Date(Number(nonce.readBigUInt64BE(32)) + 60_000), consumedAt: new Date() })
      .onConflictDoNothing()
      .returning({ nonceHash: outlookDeviceNonce.nonceHash });
    if (claimed.length !== 1) return null;
    const touched = await tx.update(outlookDevice).set({ lastHandshakeAt: new Date() })
      .where(and(eq(outlookDevice.deviceId, request.deviceId), isNull(outlookDevice.revokedAt)))
      .returning({ deviceId: outlookDevice.deviceId });
    // Only signed successful calls can persist nonces; expire old replay records.
    if (touched.length) await tx.delete(outlookDeviceNonce).where(lt(outlookDeviceNonce.expiresAt, sql`clock_timestamp() - interval '1 minute'`));
    return touched.length === 1 ? { deviceId: device.deviceId, storeId: device.storeId, version: device.version } : null;
  });
}

/** Always check live session and mailboxAccess separately for each staff ticket/COM authorization. */
export async function isDeviceAuthorized(db: DB, deviceId: string, userId: string, transportId: string, observedStoreId: string): Promise<boolean> {
  const grant = await db.select({ deviceId: outlookDevice.deviceId }).from(outlookDevice)
    .innerJoin(outlookDeviceGrant, eq(outlookDeviceGrant.deviceId, outlookDevice.deviceId))
    .innerJoin(mailboxAccess, and(eq(mailboxAccess.userId, outlookDeviceGrant.userId), eq(mailboxAccess.transportId, outlookDeviceGrant.transportId)))
    .innerJoin(mailboxTransport, eq(mailboxTransport.id, outlookDeviceGrant.transportId))
    .where(and(eq(outlookDevice.deviceId, deviceId), eq(outlookDevice.storeId, observedStoreId),
      isNull(outlookDevice.revokedAt), eq(outlookDeviceGrant.userId, userId),
      eq(outlookDeviceGrant.transportId, transportId), eq(mailboxTransport.isActive, true))).limit(1);
  return grant.length === 1;
}

export async function revokeDevice(db: DB, deviceId: string): Promise<boolean> {
  const rows = await db.update(outlookDevice).set({ revokedAt: new Date() })
    .where(and(eq(outlookDevice.deviceId, deviceId), isNull(outlookDevice.revokedAt))).returning({ deviceId: outlookDevice.deviceId });
  return rows.length === 1;
}
