import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/client.js';
import { mailThread, message } from '../src/db/schema/mail.js';
import { seedAll, TRANSPORT_ID } from '../src/db/seed.js';
import { quotePropertyMatchesOrigin } from '../src/hms/hms-quote-target.js';
import { openTestDbSession, probeTestDb, TEST_DB_AVAILABLE } from './helpers/test-db.js';

const reachable = await probeTestDb();

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('quote origin transaction fence (disposable DB)', () => {
  it('excludes inbound inserts and changes until the checked transaction commits', async () => {
    const setup = openTestDbSession(), locker = openTestDbSession(), writer = openTestDbSession();
    const threadId = randomUUID(), selectedId = randomUUID(), newMessageId = randomUUID();
    let release!: () => void, signalReady!: (current: boolean) => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<boolean>((resolve) => { signalReady = resolve; });
    let holding: Promise<unknown> | undefined;
    try {
      await seedAll(setup.db);
      await setup.db.insert(mailThread).values({ id: threadId, transportId: TRANSPORT_ID, threadRootId: threadId });
      await setup.db.insert(message).values({ id: selectedId, transportId: TRANSPORT_ID, threadId,
        direction: 'inbound', fromAddress: 'guest@example.invalid', toAddresses: ['centurion@legacyhotels.co.za'] });
      const scope = { transportId: TRANSPORT_ID, threadId, messageId: selectedId, propertyCode: 'HRCEN' };
      holding = locker.db.transaction(async (tx) => {
        const current = await quotePropertyMatchesOrigin({ ...scope, db: tx as unknown as DB, lock: true });
        signalReady(current);
        await gate;
      });
      void holding.catch(() => signalReady(false));
      expect(await ready).toBe(true);
      const blocked = async (action: (db: DB) => Promise<unknown>) => {
        try {
          await writer.db.transaction(async (tx) => {
            await tx.execute(sql`set local lock_timeout = '250ms'`);
            await action(tx as unknown as DB);
          });
          return null;
        } catch (error) {
          const nested = error as { code?: string; cause?: { code?: string } };
          return nested.cause?.code ?? nested.code ?? null;
        }
      };
      expect(await blocked(async (db) => { await db.insert(message).values({ id: newMessageId, transportId: TRANSPORT_ID,
        threadId, direction: 'inbound', fromAddress: 'davinci@legacyhotels.co.za' }); })).toBe('55P03');
      expect(await blocked(async (db) => { await db.update(message).set({ toAddresses: ['davinci@legacyhotels.co.za'] })
        .where(eq(message.id, selectedId)); })).toBe('55P03');
      release();
      await holding;
      await writer.db.insert(message).values({ id: newMessageId, transportId: TRANSPORT_ID,
        threadId, direction: 'inbound', fromAddress: 'davinci@legacyhotels.co.za' });
      expect(await quotePropertyMatchesOrigin({ ...scope, db: setup.db })).toBe(false);
    } finally {
      release();
      await holding?.catch(() => undefined);
      await setup.db.delete(mailThread).where(eq(mailThread.id, threadId)).catch(() => undefined);
      await Promise.all([setup.close(), locker.close(), writer.close()]);
    }
  }, 20_000);
});
