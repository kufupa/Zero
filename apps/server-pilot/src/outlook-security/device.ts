import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt, lt, isNull, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { mailboxAccess, mailboxTransport } from '../db/schema/mail.js';
import { user } from '../db/schema/auth.js';
import { outlookEnrollment, outlookEnrollmentGrant, outlookDevice, outlookDeviceGrant, outlookDeviceNonce, outlookDeviceReadRoot } from '../db/schema/outlook-device.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const issuedAt = Date.now();
  const expiry = input.expiresAt ?? new Date(issuedAt + 10 * 60_000);
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() > issuedAt + 10 * 60_000)
    throw new Error('Approval exceeds 10 minutes or has an invalid expiry');
  await db.transaction(async (tx) => {
    for (const grant of grants) {
      const approved = await tx.select({ userId: user.id }).from(user)
        .innerJoin(mailboxAccess, eq(mailboxAccess.userId, user.id))
        .innerJoin(mailboxTransport, eq(mailboxTransport.id, mailboxAccess.transportId))
        .where(and(eq(user.id, grant.userId), eq(user.emailVerified, true),
          eq(mailboxTransport.id, grant.transportId), eq(mailboxTransport.isActive, true)))
        .limit(1);
      if (approved.length !== 1) throw new Error('Named staff must have verified email and active mailbox access');
    }
    await tx.insert(outlookEnrollment).values({ codeHash: digest(code), storeId: input.storeId, expiresAt: expiry });
    await tx.insert(outlookEnrollmentGrant).values(grants.map((g) => ({ ...g, codeHash: digest(code) })));
  });
  return code;
}

export async function enrollDevice(db: DB, input: { code: string; storeId: string; deviceId: string; version: string; secret: string }, rawKey: string): Promise<{ deviceId: string } | null> {
  const key = wrappingKey(rawKey);
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.code) || !UUID_V4.test(input.deviceId)
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
  if (!UUID_V4.test(request.deviceId) || !/^[A-Za-z0-9_-]{96}$/.test(request.nonce)
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
    // DB wall-clock freshness and unique consumption occur in one SQL statement;
    // a queued transaction cannot authenticate a nonce after it expires.
    const issuedSeconds = Number(nonce.readBigUInt64BE(32)) / 1000;
    const signedSeconds = Number(request.timestamp);
    const claimed = await tx.execute(sql`INSERT INTO outlook_device_nonce
      (nonce_hash, device_id, expires_at, consumed_at)
      SELECT ${digest(request.nonce)}, ${request.deviceId},
        (to_timestamp(${issuedSeconds + 60}) AT TIME ZONE 'UTC'), clock_timestamp() AT TIME ZONE 'UTC'
      WHERE clock_timestamp() >= to_timestamp(${issuedSeconds})
        AND clock_timestamp() < to_timestamp(${issuedSeconds + 60})
        AND clock_timestamp() >= to_timestamp(${signedSeconds - 60})
        AND clock_timestamp() <= to_timestamp(${signedSeconds + 60})
      ON CONFLICT (nonce_hash) DO NOTHING RETURNING nonce_hash`);
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
export async function isDeviceAuthorized(db: DB, deviceId: string, userId: string, transportId: string,
  observedStoreId: string, holdThroughGrant = false): Promise<boolean> {
  const query = db.select({ deviceId: outlookDevice.deviceId }).from(outlookDevice)
    .innerJoin(outlookDeviceGrant, eq(outlookDeviceGrant.deviceId, outlookDevice.deviceId))
    .innerJoin(mailboxAccess, and(eq(mailboxAccess.userId, outlookDeviceGrant.userId), eq(mailboxAccess.transportId, outlookDeviceGrant.transportId)))
    .innerJoin(mailboxTransport, eq(mailboxTransport.id, outlookDeviceGrant.transportId))
    .where(and(eq(outlookDevice.deviceId, deviceId), eq(outlookDevice.storeId, observedStoreId),
      isNull(outlookDevice.revokedAt), eq(outlookDeviceGrant.userId, userId),
      eq(outlookDeviceGrant.transportId, transportId), eq(mailboxTransport.isActive, true))).limit(1);
  // When minting a scope, hold the exact device, named staff/mailbox grant and
  // transport rows until commit. A simultaneous revocation then linearizes
  // either before this check (deny) or after the already-issued short lease.
  const grant = await (holdThroughGrant ? query.for('share') : query);
  return grant.length === 1;
}

export async function revokeDevice(db: DB, deviceId: string): Promise<boolean> {
  if (!UUID_V4.test(deviceId)) return false;
  const rows = await db.update(outlookDevice).set({ revokedAt: new Date() })
    .where(and(eq(outlookDevice.deviceId, deviceId), isNull(outlookDevice.revokedAt))).returning({ deviceId: outlookDevice.deviceId });
  return rows.length === 1;
}

export type ReadRootPolicyV1 = { storeId: string; rootEntryId: string; policyVersion: 1; policyGeneration: number };
export type ReadRootApprovalInput = StaffMailboxGrant & { deviceId: string; storeId: string; rootEntryId: string; policyVersion: 1 };
const validReadRoot = (input: ReadRootApprovalInput) => UUID_V4.test(input.deviceId) && input.policyVersion === 1
  && [input.userId, input.transportId, input.storeId, input.rootEntryId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 512);
const readRootWhere = (input: ReadRootApprovalInput) => and(eq(outlookDeviceReadRoot.deviceId, input.deviceId),
  eq(outlookDeviceReadRoot.userId, input.userId), eq(outlookDeviceReadRoot.transportId, input.transportId),
  eq(outlookDeviceReadRoot.storeId, input.storeId), eq(outlookDeviceReadRoot.rootEntryId, input.rootEntryId));

/** Restricted operator only. Approval cannot create a device/mailbox/staff grant. */
export async function approveReadRoot(db: DB, input: ReadRootApprovalInput, options: { unchangedIsNoop?: boolean } = {}): Promise<boolean> {
  if (!validReadRoot(input)) throw new Error('Invalid read root approval');
  return db.transaction(async tx => {
    // Serialize operator approvals per enrolled device so concurrent adds cannot exceed the finite DTO bound.
    await tx.select({ id: outlookDevice.deviceId }).from(outlookDevice).where(eq(outlookDevice.deviceId, input.deviceId)).for('update');
    if (!await isDeviceAuthorized(tx as DB, input.deviceId, input.userId, input.transportId, input.storeId, true))
      throw new Error('Read root requires an active exact device, staff and mailbox grant');
    const activeForStore = await tx
      .select({
        userId: outlookDeviceReadRoot.userId,
        transportId: outlookDeviceReadRoot.transportId,
        rootEntryId: outlookDeviceReadRoot.rootEntryId,
      })
      .from(outlookDeviceReadRoot)
      .where(
        and(
          eq(outlookDeviceReadRoot.deviceId, input.deviceId),
          eq(outlookDeviceReadRoot.storeId, input.storeId),
          isNull(outlookDeviceReadRoot.revokedAt),
        ),
      )
      .for('share');
    const sameBinding = activeForStore.some(
      (root) =>
        root.userId === input.userId &&
        root.transportId === input.transportId &&
        root.rootEntryId === input.rootEntryId,
    );
    if (activeForStore.length >= 1 && !sameBinding)
      throw new Error('Read root policy allows at most one active root per device store');
    // An identical active root is already authority. Re-reporting it must not bump the generation under live sync sessions.
    if (sameBinding && options.unchangedIsNoop) return false;
    await tx.insert(outlookDeviceReadRoot).values(input).onConflictDoUpdate({
      target: [outlookDeviceReadRoot.deviceId, outlookDeviceReadRoot.userId, outlookDeviceReadRoot.transportId,
        outlookDeviceReadRoot.storeId, outlookDeviceReadRoot.rootEntryId],
      set: { policyVersion: 1, policyGeneration: sql`${outlookDeviceReadRoot.policyGeneration} + 1`, revokedAt: null, approvedAt: new Date() },
    });
    return true;
  });
}
export async function revokeReadRoot(db: DB, input: ReadRootApprovalInput): Promise<boolean> {
  if (!validReadRoot(input)) throw new Error('Invalid read root revocation');
  const rows = await db.update(outlookDeviceReadRoot).set({ revokedAt: new Date(),
    policyGeneration: sql`${outlookDeviceReadRoot.policyGeneration} + 1` })
    .where(and(readRootWhere(input), isNull(outlookDeviceReadRoot.revokedAt))).returning({ root: outlookDeviceReadRoot.rootEntryId });
  return rows.length === 1;
}
/** Stable denial codes. Any other failure is reported as approve_failed and its database text stays server-side. */
const READ_ROOT_DENIALS: Record<string, string> = {
  'Invalid read root approval': 'invalid_root',
  'Read root requires an active exact device, staff and mailbox grant': 'binding_denied',
  'Read root policy allows at most one active root per device store': 'root_conflict',
};

/** Signed device reports its store root. Accepted only when the device's single active staff/mailbox grant exists and the store matches enrollment. An identical active root is a no-op, so a repeat report after an Outlook restart leaves live sync sessions alone. */
export async function acceptDeviceStoreRoot(db: DB, device: VerifiedDevice, input: { storeId: string; rootEntryId: string }): Promise<{ accepted: boolean; reason: string }> {
  if (input.storeId !== device.storeId) return { accepted: false, reason: 'store_mismatch' };
  if ([...input.rootEntryId].some((ch) => ch.charCodeAt(0) < 32)) return { accepted: false, reason: 'invalid_root' };
  const grants = await db.select({ userId: outlookDeviceGrant.userId, transportId: outlookDeviceGrant.transportId })
    .from(outlookDeviceGrant).innerJoin(mailboxTransport, eq(mailboxTransport.id, outlookDeviceGrant.transportId))
    .where(and(eq(outlookDeviceGrant.deviceId, device.deviceId), eq(mailboxTransport.isActive, true)));
  if (grants.length !== 1) return { accepted: false, reason: 'grant_not_single' };
  try {
    const changed = await approveReadRoot(db, { ...grants[0], deviceId: device.deviceId, storeId: input.storeId, rootEntryId: input.rootEntryId, policyVersion: 1 }, { unchangedIsNoop: true });
    return { accepted: true, reason: changed ? 'accepted' : 'unchanged' };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!READ_ROOT_DENIALS[message]) console.error('outlook_store_root_failed', error instanceof Error ? error.name : 'unknown');
    return { accepted: false, reason: READ_ROOT_DENIALS[message] ?? 'approve_failed' };
  }
}

/** Caller must also validate live staff session. Native must check actual COM ancestry before every read. */
export async function getApprovedReadRoots(db: DB, deviceId: string, userId: string, transportId: string,
  storeId: string, holdThroughGrant = false): Promise<ReadRootPolicyV1[]> {
  if (!await isDeviceAuthorized(db, deviceId, userId, transportId, storeId, holdThroughGrant)) return [];
  const query = db.select({ storeId: outlookDeviceReadRoot.storeId, rootEntryId: outlookDeviceReadRoot.rootEntryId,
    policyVersion: outlookDeviceReadRoot.policyVersion, policyGeneration: outlookDeviceReadRoot.policyGeneration })
    .from(outlookDeviceReadRoot).where(and(eq(outlookDeviceReadRoot.deviceId, deviceId),
      eq(outlookDeviceReadRoot.userId, userId), eq(outlookDeviceReadRoot.transportId, transportId),
      eq(outlookDeviceReadRoot.storeId, storeId), eq(outlookDeviceReadRoot.policyVersion, 1), isNull(outlookDeviceReadRoot.revokedAt)))
    .orderBy(outlookDeviceReadRoot.rootEntryId).limit(2);
  const rows = await (holdThroughGrant ? query.for('share') : query);
  if (rows.length > 1) throw new Error('Read root policy exceeds one active root per device store');
  return rows as ReadRootPolicyV1[];
}
