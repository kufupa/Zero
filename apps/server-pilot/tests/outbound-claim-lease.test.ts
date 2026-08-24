import {
  __setSmtpTransportForTests,
  type OutboundMailPayload,
  type SmtpSendResult,
  type SmtpTransport,
} from '../src/mail/send/smtp.js';
import {
  fixtureLoopbackStore,
  resetFixtureLoopbackStoreForTests,
} from '../src/mail/fixture-loopback.js';
import { mailboxTransport, mailThread, message, outboundSendQueue } from '../src/db/schema/mail.js';
import { openTestDbSession, probeTestDb, TEST_DB_AVAILABLE } from './helpers/test-db.js';
import { flushDue } from '../src/mail/send/outbound-queue.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INGEST_EMAIL } from '../src/db/seed.js';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

const reachable = await probeTestDb();

type TestSession = ReturnType<typeof openTestDbSession>;

type QueueFixture = {
  ids: {
    transportId: string;
    messageIds: string[];
    queueIds: string[];
  };
  setup: TestSession;
  first: TestSession;
  second: TestSession;
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function queuePayload(from: string, to: string): Record<string, unknown> {
  const payload: OutboundMailPayload = {
    from,
    to: [to],
    cc: [],
    bcc: [INGEST_EMAIL],
    subject: 'claim lease',
    html: '<p>claim lease</p>',
    text: 'claim lease',
  };
  return payload;
}

async function withQueueFixture(
  count: number,
  cb: (fixture: QueueFixture) => Promise<void>,
): Promise<void> {
  const suffix = randomUUID();
  const transportId = `lease-transport-${suffix}`;
  const from = `lease-${suffix}@zero.test`;
  const setup = openTestDbSession();
  const first = openTestDbSession();
  const second = openTestDbSession();
  const messageIds = Array.from(
    { length: count },
    (_, index) => `lease-message-${suffix}-${index}`,
  );
  const queueIds = Array.from({ length: count }, (_, index) => `lease-queue-${suffix}-${index}`);

  try {
    await setup.db.insert(mailboxTransport).values({
      id: transportId,
      email: from,
      ownerHeaderValue: from,
      isActive: true,
    });

    for (const [index, messageId] of messageIds.entries()) {
      const threadId = `lease-thread-${suffix}-${index}`;
      await setup.db.insert(mailThread).values({
        id: threadId,
        transportId,
        threadRootId: `lease-root-${suffix}-${index}`,
        subject: 'claim lease',
        snippet: 'claim lease',
        labelIds: [],
        isArchived: false,
        isStarred: false,
        isRead: false,
      });
      await setup.db.insert(message).values({
        id: messageId,
        transportId,
        threadId,
        direction: 'outbound',
        fromAddress: from,
        toAddresses: [`recipient-${index}@zero.test`],
        ccAddresses: [],
        bccAddresses: [INGEST_EMAIL],
        references: [],
        isRead: false,
        isStarred: false,
      });
      await setup.db.insert(outboundSendQueue).values({
        id: queueIds[index]!,
        transportId,
        messageId,
        sendAt: new Date(Date.now() - 1_000),
        status: 'pending',
        smtpPayload: queuePayload(from, `recipient-${index}@zero.test`),
        attempts: 0,
        claimedAt: null,
      });
    }

    await cb({
      ids: { transportId, messageIds, queueIds },
      setup,
      first,
      second,
    });
  } finally {
    try {
      await setup.db.delete(mailboxTransport).where(eq(mailboxTransport.id, transportId));
    } finally {
      await Promise.all([setup.close(), first.close(), second.close()]);
    }
  }
}

function blockingTransport() {
  const started = deferred();
  const release = deferred();
  const outcome: SmtpSendResult = {
    messageId: 'lease-outcome@zero.test',
    accepted: ['recipient-0@zero.test', INGEST_EMAIL],
    rejected: [],
  };
  const send: SmtpTransport['send'] = vi.fn(async () => {
    started.resolve();
    await release.promise;
    return outcome;
  });
  return {
    started,
    release,
    send,
    transport: { kind: 'fake', send } satisfies SmtpTransport,
  };
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('outbound queue claim lease', () => {
  afterEach(() => {
    __setSmtpTransportForTests(null);
    resetFixtureLoopbackStoreForTests();
    vi.restoreAllMocks();
  });

  it('renews a live blocked SMTP lease before another flusher can reclaim it', async () => {
    await withQueueFixture(1, async ({ first, second, setup, ids }) => {
      const scripted = blockingTransport();
      __setSmtpTransportForTests(scripted.transport);
      let renewalTick: (() => Promise<void>) | undefined;
      vi.spyOn(global, 'setInterval').mockImplementation(((handler) => {
        renewalTick = handler as () => Promise<void>;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval);
      vi.spyOn(global, 'clearInterval').mockImplementation(() => undefined);

      const firstFlush = flushDue({ db: first.db, limit: 1 });
      await scripted.started.promise;
      expect(renewalTick).toBeTypeOf('function');

      const stale = new Date(Date.now() - 5 * 60 * 1000 - 1);
      await setup.db
        .update(outboundSendQueue)
        .set({ claimedAt: stale })
        .where(eq(outboundSendQueue.id, ids.queueIds[0]!));
      await renewalTick!();

      await expect(flushDue({ db: second.db, limit: 1 })).resolves.toEqual({ flushed: 0 });
      expect(scripted.send).toHaveBeenCalledTimes(1);

      scripted.release.resolve();
      await expect(firstFlush).resolves.toEqual({ flushed: 1 });
      expect(scripted.send).toHaveBeenCalledTimes(1);
    });
  }, 30000);

  it('drops durable writes and loopback when its claim epoch is stolen during SMTP', async () => {
    await withQueueFixture(1, async ({ first, setup, ids }) => {
      const scripted = blockingTransport();
      __setSmtpTransportForTests(scripted.transport);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const firstFlush = flushDue({ db: first.db, limit: 1 });
      await scripted.started.promise;
      const [claimed] = await setup.db
        .select()
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.id, ids.queueIds[0]!))
        .limit(1);
      await setup.db
        .update(outboundSendQueue)
        .set({
          attempts: claimed!.attempts + 1,
          claimedAt: new Date(),
          lastError: null,
        })
        .where(eq(outboundSendQueue.id, ids.queueIds[0]!));

      scripted.release.resolve();
      await expect(firstFlush).resolves.toEqual({ flushed: 0 });

      const [queue] = await setup.db
        .select()
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.id, ids.queueIds[0]!))
        .limit(1);
      const [outbound] = await setup.db
        .select({ messageIdHeader: message.messageIdHeader })
        .from(message)
        .where(and(eq(message.id, ids.messageIds[0]!), eq(message.transportId, ids.transportId)))
        .limit(1);
      expect(queue).toMatchObject({
        status: 'sending',
        attempts: claimed!.attempts + 1,
        lastError: null,
      });
      expect(queue!.smtpPayload).not.toHaveProperty('deliveryOutcome');
      expect(outbound!.messageIdHeader).toBeNull();
      expect(fixtureLoopbackStore.drain()).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    });
  }, 30000);

  it('claims the next row only after the blocked first row finishes', async () => {
    await withQueueFixture(2, async ({ first, setup, ids }) => {
      const firstStarted = deferred();
      const releaseFirst = deferred();
      let sends = 0;
      const send: SmtpTransport['send'] = vi.fn(async () => {
        sends += 1;
        if (sends === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return {
          messageId: `limit-${sends}@zero.test`,
          accepted: ['recipient-0@zero.test', INGEST_EMAIL],
          rejected: [],
        };
      });
      __setSmtpTransportForTests({ kind: 'fake', send });

      const flush = flushDue({ db: first.db, limit: 2 });
      await firstStarted.promise;
      const [secondQueue] = await setup.db
        .select({
          attempts: outboundSendQueue.attempts,
          status: outboundSendQueue.status,
        })
        .from(outboundSendQueue)
        .where(eq(outboundSendQueue.id, ids.queueIds[1]!))
        .limit(1);
      expect(secondQueue).toEqual({ status: 'pending', attempts: 0 });

      releaseFirst.resolve();
      await expect(flush).resolves.toEqual({ flushed: 2 });
    });
  }, 30000);
});
