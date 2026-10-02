import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withSeededTestDb, TEST_DB_AVAILABLE } from './helpers/test-db.js';
import { user } from '../src/db/schema/auth.js';
import { mailboxTransport } from '../src/db/schema/mail.js';
import { outlookDevice } from '../src/db/schema/outlook-device.js';
import { outlookNavigationHistory, outlookBridgeTicket, outlookMoveReceipt } from '../src/db/schema/outlook-authorization.js';
import { pruneOutlookAuthorizationHistory } from '../src/outlook-security/retention.js';

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000);

describe.skipIf(!TEST_DB_AVAILABLE)('bounded Outlook authorization retention', () => {
  it('prunes old navigation replays, tickets and receipts while preserving live authority and bounded work', async () =>
    withSeededTestDb(async (db) => {
      const [staff] = await db.select({ id: user.id }).from(user).limit(1);
      const [transport] = await db.select({ id: mailboxTransport.id }).from(mailboxTransport).limit(1);
      const deviceId = randomUUID();
      await db.insert(outlookDevice).values({ deviceId, storeId: 'retention-test-store',
        version: '4', secretCiphertext: 'not-a-real-secret' });
      for (const index of [1, 2]) {
        await db.insert(outlookNavigationHistory).values({ deviceId,
          challengeHash: `old-nav-${index}`, registeredAt: daysAgo(31) });
        await db.insert(outlookBridgeTicket).values({ ticketHash: `old-ticket-${deviceId}-${index}`,
          deviceId, challengeHash: `old-nav-${index}`, sessionId: 'expired-session', userId: staff.id,
          transportId: transport.id, storeId: 'retention-test-store', action: 'MOVE_EMAIL',
          expiresAt: daysAgo(3), consumedAt: daysAgo(3),
          consentChallengeHash: `old-consent-${deviceId}-${index}`, consentExpiresAt: daysAgo(3) });
        await db.insert(outlookMoveReceipt).values({ deviceId, transportId: transport.id,
          operationId: `old-operation-${index}`, scopeHash: `old-scope-${index}`,
          count: 1, approvedAt: daysAgo(3) });
      }
      await db.insert(outlookNavigationHistory).values({ deviceId,
        challengeHash: 'live-nav', registeredAt: new Date() });
      await db.insert(outlookBridgeTicket).values({ ticketHash: `live-ticket-${deviceId}`,
        deviceId, challengeHash: 'live-nav', sessionId: 'staff-session', userId: staff.id,
        transportId: transport.id, storeId: 'retention-test-store', action: 'GET_ACTIVE_EMAIL',
        expiresAt: new Date(Date.now() + 60_000) });
      await db.insert(outlookMoveReceipt).values({ deviceId, transportId: transport.id,
        operationId: 'recent-operation', scopeHash: 'recent-scope', count: 1, approvedAt: new Date() });

      await pruneOutlookAuthorizationHistory(db, 1);
      expect(await db.select().from(outlookNavigationHistory).where(eq(outlookNavigationHistory.deviceId, deviceId)))
        .toHaveLength(2);
      expect(await db.select().from(outlookBridgeTicket).where(eq(outlookBridgeTicket.deviceId, deviceId)))
        .toHaveLength(2);
      expect(await db.select().from(outlookMoveReceipt).where(eq(outlookMoveReceipt.deviceId, deviceId)))
        .toHaveLength(2);

      await pruneOutlookAuthorizationHistory(db);
      expect((await db.select().from(outlookNavigationHistory).where(eq(outlookNavigationHistory.deviceId, deviceId)))
        .map((row) => row.challengeHash)).toEqual(['live-nav']);
      expect((await db.select().from(outlookBridgeTicket).where(eq(outlookBridgeTicket.deviceId, deviceId)))
        .map((row) => row.ticketHash)).toEqual([`live-ticket-${deviceId}`]);
      expect((await db.select().from(outlookMoveReceipt).where(eq(outlookMoveReceipt.deviceId, deviceId)))
        .map((row) => row.operationId)).toEqual(['recent-operation']);
    }));
});
