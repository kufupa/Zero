import {
  approveReadRoot,
  enrollDevice,
  issueChallenge,
  issueEnrollment,
} from '../../src/outlook-security/device.js';
import { mailboxAccess, mailboxTransport } from '../../src/db/schema/mail.js';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { SyncObservationV1 } from '../../src/outlook-sync/contracts.js';
import { user, session } from '../../src/db/schema/auth.js';
import type { DB } from '../../src/db/client.js';

export async function outlookSyncFixture(db: DB) {
  const userId = randomUUID(),
    transportId = randomUUID(),
    deviceId = randomUUID(),
    sessionId = randomUUID();
  const storeId = `store-${randomUUID()}`,
    rootEntryId = 'approved-root';
  const key = randomBytes(32).toString('base64'),
    secret = randomBytes(32).toString('base64');
  await db
    .insert(user)
    .values({
      id: userId,
      name: 'Sync Staff',
      email: `${userId}@example.test`,
      emailVerified: true,
    });
  await db
    .insert(mailboxTransport)
    .values({
      id: transportId,
      email: `${transportId}@example.test`,
      ownerHeaderValue: transportId,
    });
  await db.insert(mailboxAccess).values({ id: randomUUID(), userId, transportId, role: 'member' });
  await db
    .insert(session)
    .values({
      id: sessionId,
      token: randomUUID(),
      userId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  const code = await issueEnrollment(db, { userId, transportId, storeId });
  await enrollDevice(db, { code, deviceId, storeId, version: '4', secret }, key);
  await approveReadRoot(db, {
    deviceId,
    userId,
    transportId,
    storeId,
    rootEntryId,
    policyVersion: 1,
  });
  const auth = {
    api: {
      getSession: async () => ({
        user: { id: userId, email: `${userId}@example.test` },
        session: { id: sessionId },
      }),
    },
  };
  const activation = {
    deviceId,
    storeId,
    rootEntryId,
    capabilityVersion: 1 as const,
    idempotencyKey: randomUUID(),
  };
  async function signedRequest(route: string, input: unknown) {
    const body = JSON.stringify(input),
      nonce = await issueChallenge(db, deviceId, key),
      timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', Buffer.from(secret, 'base64'))
      .update(
        [
          'nava-outlook-v4',
          'POST',
          route,
          createHash('sha256').update(body).digest('hex'),
          deviceId,
          timestamp,
          nonce,
        ].join('\n'),
      )
      .digest('hex');
    return new Request(`https://test.invalid${route}`, {
      method: 'POST',
      body,
      headers: {
        'x-nava-device-id': deviceId,
        'x-nava-nonce': nonce,
        'x-nava-timestamp': timestamp,
        'x-nava-signature': signature,
      },
    });
  }
  const observation = (sourceObservationId = randomUUID()): SyncObservationV1 => ({
    version: 1,
    sourceObservationId,
    semanticVersion: 1,
    locator: { storeId, rootEntryId, folderEntryId: 'inbox', entryId: sourceObservationId },
    availability: 'available',
    direction: 'inbound',
    timestamps: {
      receivedAt: new Date().toISOString(),
      sentAt: null,
      createdAt: null,
      modifiedAt: null,
      originalDate: null,
    },
    event: {
      kind: 'inventory',
      observedAt: new Date().toISOString(),
      receivedAt: null,
      wasUnsent: false,
      isUnsent: false,
      sentCopySaved: false,
    },
    semantic: {
      internetMessageId: null,
      subject: 'Fixture',
      from: 'fixture@example.test',
      to: [],
      references: [],
      inReplyTo: null,
      sender: null,
      sentRepresenting: null,
      cc: [],
      bcc: [],
      replyTo: [],
      conversationId: null,
      conversationIndex: null,
      isRead: false,
      categories: [],
      transportHeaders: null,
    },
    requiredArtifactRoles: ['original-msg'],
  });
  return {
    db,
    userId,
    transportId,
    deviceId,
    sessionId,
    storeId,
    rootEntryId,
    key,
    secret,
    auth,
    activation,
    signedRequest,
    observation,
  };
}
