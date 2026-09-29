import {
  attachment,
  mailIngestMailbox,
  mailIngestQuarantine,
  mailIngestUidlClaim,
  mailThread,
  mailboxTransport,
  message,
  outboundSendQueue,
} from '../src/db/schema/mail.js';
import {
  claimIngestUidl,
  persistInboundMessage,
  releaseIngestUidlClaim,
  sweepCandidateAttachmentCleanupTasks,
} from '../src/mail/ingest/store.js';
import {
  openTestDbSession,
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';
import { FakeS3Storage, rawMimeKey, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import { ingestOnce, POISON_MAX_RETRIES } from '../src/mail/ingest/worker.js';
import { parseRawMessage } from '../src/mail/ingest/parse-message.js';
import { FakePop3Client } from '../src/mail/ingest/pop3-client.js';
import { describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { readFile } from 'node:fs/promises';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const reachable = await probeTestDb();
const cleanupTaskTable = sql.raw('"mail_ingest_candidate_attachment_cleanup"');

describe('candidate cleanup migration history', () => {
  it('keeps the unshipped cleanup queue complete in one migration', async () => {
    const queue = await readFile(
      new URL('../drizzle/0017_candidate_attachment_cleanup_queue.sql', import.meta.url),
      'utf8',
    );

    expect(queue).toContain('"attempts" integer NOT NULL DEFAULT 0');
    expect(queue).toContain('"next_attempt_at" timestamp NOT NULL DEFAULT now()');
    expect(queue).toContain(
      'ON "mail_ingest_candidate_attachment_cleanup" ("next_attempt_at", "s3_key")',
    );
  });
});

function candidateMessage(args: {
  attachmentCount: number;
  ownerHeaderValue: string;
  subject?: string;
}): Buffer {
  const attachmentParts = Array.from({ length: args.attachmentCount }, (_, index) => [
    '--candidate-cleanup-boundary',
    `Content-Type: application/octet-stream; name="candidate-${index}.bin"`,
    `Content-Disposition: attachment; filename="candidate-${index}.bin"`,
    'Content-Transfer-Encoding: base64',
    '',
    'Y2xlYW51cA==',
  ]).flat();
  const body =
    args.attachmentCount === 0
      ? ['', 'candidate cleanup queue']
      : [
          'MIME-Version: 1.0',
          'Content-Type: multipart/mixed; boundary="candidate-cleanup-boundary"',
          '',
          'candidate cleanup queue',
          ...attachmentParts,
          '--candidate-cleanup-boundary--',
        ];

  return Buffer.from(
    [
      `X-Zero-Mailbox: ${args.ownerHeaderValue}`,
      `From: ${args.ownerHeaderValue}`,
      `To: ${args.ownerHeaderValue}`,
      `Subject: ${args.subject ?? 'candidate cleanup queue'}`,
      ...body,
    ].join('\r\n'),
  );
}

function firstRow<T extends object>(result: unknown): T | undefined {
  if (Array.isArray(result)) return result[0] as T | undefined;
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows[0] as T | undefined;
  }
  return undefined;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve: () => resolve?.() };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupTaskCount(
  db: DB,
  ingestMailboxId: string,
  pop3Uidl?: string,
): Promise<number> {
  const result = await db.execute(
    pop3Uidl
      ? sql`
          SELECT count(*)::int AS "count"
          FROM ${cleanupTaskTable}
          WHERE "ingest_mailbox_id" = ${ingestMailboxId}
            AND "pop3_uidl" = ${pop3Uidl}
        `
      : sql`
          SELECT count(*)::int AS "count"
          FROM ${cleanupTaskTable}
          WHERE "ingest_mailbox_id" = ${ingestMailboxId}
        `,
  );
  return Number(firstRow<{ count: number | string }>(result)?.count ?? 0);
}

async function cleanupTaskKeys(
  db: DB,
  ingestMailboxId: string,
  pop3Uidl: string,
): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT "s3_key" AS "s3Key"
    FROM ${cleanupTaskTable}
    WHERE "ingest_mailbox_id" = ${ingestMailboxId}
      AND "pop3_uidl" = ${pop3Uidl}
    ORDER BY "s3_key"
  `);
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)
      ? result.rows
      : [];
  return rows.map((row) => String((row as { s3Key?: string }).s3Key));
}

async function makeCleanupTasksDue(
  db: DB,
  ingestMailboxId: string,
  pop3Uidl: string,
): Promise<void> {
  // The sweeper compares a JS millisecond timestamp against PostgreSQL's
  // microsecond timestamp. now() can still be in the future within the same
  // millisecond on a fast CI runner, so make test tasks unambiguously due.
  await db.execute(sql`
    UPDATE ${cleanupTaskTable}
    SET "next_attempt_at" = now() - interval '1 second'
    WHERE "ingest_mailbox_id" = ${ingestMailboxId}
      AND "pop3_uidl" = ${pop3Uidl}
  `);
}

async function insertCleanupTask(args: {
  db: DB;
  candidateMessageId: string;
  ingestMailboxId: string;
  pop3Uidl: string;
  s3Key: string;
}): Promise<void> {
  await args.db.execute(sql`
    INSERT INTO ${cleanupTaskTable} (
      "s3_key",
      "candidate_message_id",
      "ingest_mailbox_id",
      "pop3_uidl"
    )
    VALUES (
      ${args.s3Key},
      ${args.candidateMessageId},
      ${args.ingestMailboxId},
      ${args.pop3Uidl}
    )
  `);
}

async function insertCleanupTasks(args: {
  db: DB;
  tasks: Array<{
    candidateMessageId: string;
    createdAt: Date;
    ingestMailboxId: string;
    pop3Uidl: string;
    s3Key: string;
  }>;
}): Promise<void> {
  if (args.tasks.length === 0) return;
  for (const task of args.tasks) {
    await args.db.execute(sql`
      INSERT INTO ${cleanupTaskTable} (
        "s3_key",
        "candidate_message_id",
        "ingest_mailbox_id",
        "pop3_uidl",
        "created_at",
        "next_attempt_at"
      )
      VALUES (
        ${task.s3Key},
        ${task.candidateMessageId},
        ${task.ingestMailboxId},
        ${task.pop3Uidl},
        ${task.createdAt.toISOString()},
        ${task.createdAt.toISOString()}
      )
    `);
  }
}

async function deleteCleanupTasksIfPresent(db: DB, ingestMailboxId: string): Promise<void> {
  const relation = await db.execute(sql`
    SELECT to_regclass('mail_ingest_candidate_attachment_cleanup') AS "relation"
  `);
  if (!firstRow<{ relation: string | null }>(relation)?.relation) return;
  await db.execute(sql`
    DELETE FROM ${cleanupTaskTable}
    WHERE "ingest_mailbox_id" = ${ingestMailboxId}
  `);
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)('POP3 UIDL claim', () => {
  it('defers a concurrent worker before it retrieves the claimed message', async () => {
    const storage = new FakeS3Storage('candidate-cleanup-uidl-claim');
    const setup = openTestDbSession();
    const firstWorker = openTestDbSession();
    const secondWorker = openTestDbSession();
    const ingestMailboxId = `ingest-uidl-claim-${randomUUID()}`;
    const transportId = `transport-uidl-claim-${randomUUID()}`;
    const transportEmail = `${transportId}@zero.test`;
    const pop3Uidl = `uidl-claim-${randomUUID()}`;
    const rawPutEntered = deferred();
    const releaseRawPut = deferred();
    const originalPutObject = storage.putObject.bind(storage);
    let blockFirstRawPut = true;
    let firstRun: Promise<unknown> | undefined;
    let secondRun: Promise<unknown> | undefined;

    try {
      await setup.db.insert(mailIngestMailbox).values({
        id: ingestMailboxId,
        email: `${ingestMailboxId}@zero.test`,
        description: 'uidl claim test',
      });
      await setup.db.insert(mailboxTransport).values({
        id: transportId,
        email: transportEmail,
        ownerHeaderValue: transportEmail,
        mailboxType: 'personal',
        isActive: true,
      });
      const raw = candidateMessage({
        attachmentCount: 0,
        ownerHeaderValue: transportEmail,
        subject: 'uidl claim',
      });
      const rawKey = rawMimeKey({ ingestMailboxId, pop3Uidl });
      storage.putObject = async (opts) => {
        if (blockFirstRawPut && opts.key === rawKey) {
          blockFirstRawPut = false;
          rawPutEntered.resolve();
          await releaseRawPut.promise;
        }
        return originalPutObject(opts);
      };
      resetS3Storage();
      setS3Storage(storage);
      const firstPop3 = new FakePop3Client({ messages: [{ uidl: pop3Uidl, raw }] });
      const secondPop3 = new FakePop3Client({ messages: [{ uidl: pop3Uidl, raw }] });
      const secondRetrEntered = deferred();
      const originalSecondRetr = secondPop3.retr.bind(secondPop3);
      secondPop3.retr = async (uidl) => {
        secondRetrEntered.resolve();
        return originalSecondRetr(uidl);
      };

      firstRun = ingestOnce({
        pop3: firstPop3,
        db: firstWorker.db,
        ingestMailboxId,
      });
      await rawPutEntered.promise;

      secondRun = ingestOnce({
        pop3: secondPop3,
        db: secondWorker.db,
        ingestMailboxId,
      });

      expect(
        await Promise.race([
          secondRetrEntered.promise.then(() => 'retrieved'),
          wait(250).then(() => 'not_retrieved'),
        ]),
      ).toBe('not_retrieved');

      releaseRawPut.resolve();
      const [first, second] = await Promise.all([firstRun, secondRun]);

      expect(second).toMatchObject({
        items: [
          {
            uidl: pop3Uidl,
            status: 'deferred',
            reason: 'ingest_uidl_claim_pending',
          },
        ],
      });
      expect(secondPop3.callLog.map((call) => call.op)).not.toContain('retr');
      expect(first).toMatchObject({ deled: 1 });
    } finally {
      releaseRawPut.resolve();
      storage.putObject = originalPutObject;
      resetS3Storage();
      await Promise.allSettled(
        [firstRun, secondRun].filter(
          (promise): promise is Promise<unknown> => promise !== undefined,
        ),
      );
      await setup.db
        .delete(mailboxTransport)
        .where(eq(mailboxTransport.id, transportId))
        .catch(() => undefined);
      await setup.db
        .delete(mailIngestMailbox)
        .where(eq(mailIngestMailbox.id, ingestMailboxId))
        .catch(() => undefined);
      await Promise.all([setup.close(), firstWorker.close(), secondWorker.close()]);
    }
  }, 30000);

  it('renews a live UIDL lease before another worker can reclaim it', async () => {
    const storage = new FakeS3Storage('candidate-cleanup-uidl-heartbeat');
    const setup = openTestDbSession();
    const firstWorker = openTestDbSession();
    const secondWorker = openTestDbSession();
    const ingestMailboxId = `ingest-uidl-heartbeat-${randomUUID()}`;
    const transportId = `transport-uidl-heartbeat-${randomUUID()}`;
    const transportEmail = `${transportId}@zero.test`;
    const pop3Uidl = `uidl-heartbeat-${randomUUID()}`;
    const rawPutEntered = deferred();
    const releaseRawPut = deferred();
    const originalPutObject = storage.putObject.bind(storage);
    let blockFirstRawPut = true;
    let firstRun: Promise<unknown> | undefined;
    let secondRun: Promise<unknown> | undefined;
    let renewalTick: (() => Promise<void>) | undefined;
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((handler) => {
      renewalTick = handler as () => Promise<void>;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => undefined);

    try {
      await setup.db.insert(mailIngestMailbox).values({
        id: ingestMailboxId,
        email: `${ingestMailboxId}@zero.test`,
        description: 'uidl heartbeat test',
      });
      await setup.db.insert(mailboxTransport).values({
        id: transportId,
        email: transportEmail,
        ownerHeaderValue: transportEmail,
        mailboxType: 'personal',
        isActive: true,
      });
      const raw = candidateMessage({
        attachmentCount: 0,
        ownerHeaderValue: transportEmail,
        subject: 'uidl heartbeat',
      });
      const rawKey = rawMimeKey({ ingestMailboxId, pop3Uidl });
      storage.putObject = async (opts) => {
        if (blockFirstRawPut && opts.key === rawKey) {
          blockFirstRawPut = false;
          rawPutEntered.resolve();
          await releaseRawPut.promise;
        }
        return originalPutObject(opts);
      };
      resetS3Storage();
      setS3Storage(storage);
      const firstPop3 = new FakePop3Client({ messages: [{ uidl: pop3Uidl, raw }] });
      const secondPop3 = new FakePop3Client({ messages: [{ uidl: pop3Uidl, raw }] });
      const secondRetrEntered = deferred();
      const originalSecondRetr = secondPop3.retr.bind(secondPop3);
      secondPop3.retr = async (uidl) => {
        secondRetrEntered.resolve();
        return originalSecondRetr(uidl);
      };

      firstRun = ingestOnce({
        pop3: firstPop3,
        db: firstWorker.db,
        ingestMailboxId,
      });
      await rawPutEntered.promise;
      expect(renewalTick).toBeTypeOf('function');

      await setup.db
        .update(mailIngestUidlClaim)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(
          and(
            eq(mailIngestUidlClaim.ingestMailboxId, ingestMailboxId),
            eq(mailIngestUidlClaim.pop3Uidl, pop3Uidl),
          ),
        );
      await renewalTick!();

      secondRun = ingestOnce({
        pop3: secondPop3,
        db: secondWorker.db,
        ingestMailboxId,
      });
      expect(
        await Promise.race([
          secondRetrEntered.promise.then(() => 'retrieved'),
          wait(250).then(() => 'not_retrieved'),
        ]),
      ).toBe('not_retrieved');

      releaseRawPut.resolve();
      const [first, second] = await Promise.all([firstRun, secondRun]);
      expect(first).toMatchObject({ deled: 1 });
      expect(second).toMatchObject({
        items: [
          {
            uidl: pop3Uidl,
            status: 'deferred',
            reason: 'ingest_uidl_claim_pending',
          },
        ],
      });
      expect(secondPop3.callLog.map((call) => call.op)).not.toContain('retr');
    } finally {
      releaseRawPut.resolve();
      storage.putObject = originalPutObject;
      resetS3Storage();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      await Promise.allSettled(
        [firstRun, secondRun].filter(
          (promise): promise is Promise<unknown> => promise !== undefined,
        ),
      );
      await setup.db
        .delete(mailboxTransport)
        .where(eq(mailboxTransport.id, transportId))
        .catch(() => undefined);
      await setup.db
        .delete(mailIngestMailbox)
        .where(eq(mailIngestMailbox.id, ingestMailboxId))
        .catch(() => undefined);
      await Promise.all([setup.close(), firstWorker.close(), secondWorker.close()]);
    }
  }, 30000);

  it('defers instead of poisoning a UIDL after its claim is lost mid-processing', async () => {
    const storage = new FakeS3Storage('candidate-cleanup-uidl-lost-claim');
    const setup = openTestDbSession();
    const firstWorker = openTestDbSession();
    const ingestMailboxId = `ingest-uidl-lost-claim-${randomUUID()}`;
    const transportId = `transport-uidl-lost-claim-${randomUUID()}`;
    const transportEmail = `${transportId}@zero.test`;
    const pop3Uidl = `uidl-lost-claim-${randomUUID()}`;
    const rawPutEntered = deferred();
    const releaseRawPut = deferred();
    const originalPutObject = storage.putObject.bind(storage);
    let blockFirstRawPut = true;
    let firstRun: Promise<unknown> | undefined;
    let replacementClaimToken: string | null = null;
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(() => {
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => undefined);

    try {
      await setup.db.insert(mailIngestMailbox).values({
        id: ingestMailboxId,
        email: `${ingestMailboxId}@zero.test`,
        description: 'uidl lost claim test',
      });
      await setup.db.insert(mailboxTransport).values({
        id: transportId,
        email: transportEmail,
        ownerHeaderValue: transportEmail,
        mailboxType: 'personal',
        isActive: true,
      });
      const raw = candidateMessage({
        attachmentCount: 0,
        ownerHeaderValue: transportEmail,
        subject: 'uidl lost claim',
      });
      const rawKey = rawMimeKey({ ingestMailboxId, pop3Uidl });
      storage.putObject = async (opts) => {
        if (blockFirstRawPut && opts.key === rawKey) {
          blockFirstRawPut = false;
          rawPutEntered.resolve();
          await releaseRawPut.promise;
        }
        return originalPutObject(opts);
      };
      resetS3Storage();
      setS3Storage(storage);
      const firstPop3 = new FakePop3Client({ messages: [{ uidl: pop3Uidl, raw }] });
      const failureCounts = new Map([[pop3Uidl, POISON_MAX_RETRIES - 1]]);

      firstRun = ingestOnce({
        pop3: firstPop3,
        db: firstWorker.db,
        ingestMailboxId,
        failureCounts,
      });
      await rawPutEntered.promise;

      await setup.db
        .update(mailIngestUidlClaim)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(
          and(
            eq(mailIngestUidlClaim.ingestMailboxId, ingestMailboxId),
            eq(mailIngestUidlClaim.pop3Uidl, pop3Uidl),
          ),
        );
      replacementClaimToken = await claimIngestUidl(setup.db, { ingestMailboxId, pop3Uidl });
      expect(replacementClaimToken).toBeTypeOf('string');

      releaseRawPut.resolve();
      const result = await firstRun;
      const quarantines = await setup.db
        .select({ id: mailIngestQuarantine.id })
        .from(mailIngestQuarantine)
        .where(eq(mailIngestQuarantine.pop3Uidl, pop3Uidl));

      expect(result).toMatchObject({
        deled: 0,
        items: [
          {
            uidl: pop3Uidl,
            status: 'deferred',
            reason: 'ingest_uidl_claim_pending',
          },
        ],
      });
      expect(firstPop3.deleLog).toEqual([]);
      expect(failureCounts.has(pop3Uidl)).toBe(false);
      expect(quarantines).toEqual([]);
    } finally {
      releaseRawPut.resolve();
      storage.putObject = originalPutObject;
      resetS3Storage();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      await Promise.allSettled(
        [firstRun].filter((promise): promise is Promise<unknown> => promise !== undefined),
      );
      if (replacementClaimToken) {
        await releaseIngestUidlClaim(
          setup.db,
          { ingestMailboxId, pop3Uidl },
          replacementClaimToken,
        ).catch(() => undefined);
      }
      await setup.db
        .delete(mailboxTransport)
        .where(eq(mailboxTransport.id, transportId))
        .catch(() => undefined);
      await setup.db
        .delete(mailIngestMailbox)
        .where(eq(mailIngestMailbox.id, ingestMailboxId))
        .catch(() => undefined);
      await Promise.all([setup.close(), firstWorker.close()]);
    }
  }, 30000);

  it('keeps a UIDL claim until POP3 QUIT commits its deletion', async () => {
    const storage = new FakeS3Storage('candidate-cleanup-uidl-quit');
    const setup = openTestDbSession();
    const firstWorker = openTestDbSession();
    const secondWorker = openTestDbSession();
    const ingestMailboxId = `ingest-uidl-quit-${randomUUID()}`;
    const transportId = `transport-uidl-quit-${randomUUID()}`;
    const transportEmail = `${transportId}@zero.test`;
    const pop3Uidl = `uidl-quit-${randomUUID()}`;
    const quitEntered = deferred();
    const releaseQuit = deferred();
    let firstRun: Promise<unknown> | undefined;
    let secondRun: Promise<unknown> | undefined;

    try {
      await setup.db.insert(mailIngestMailbox).values({
        id: ingestMailboxId,
        email: `${ingestMailboxId}@zero.test`,
        description: 'uidl quit claim test',
      });
      await setup.db.insert(mailboxTransport).values({
        id: transportId,
        email: transportEmail,
        ownerHeaderValue: transportEmail,
        mailboxType: 'personal',
        isActive: true,
      });
      const raw = candidateMessage({
        attachmentCount: 0,
        ownerHeaderValue: transportEmail,
        subject: 'uidl quit claim',
      });
      resetS3Storage();
      setS3Storage(storage);
      const firstPop3 = new FakePop3Client({ messages: [{ uidl: pop3Uidl, raw }] });
      const secondPop3 = new FakePop3Client({ messages: [{ uidl: pop3Uidl, raw }] });
      const originalFirstQuit = firstPop3.quit.bind(firstPop3);
      firstPop3.quit = async () => {
        quitEntered.resolve();
        await releaseQuit.promise;
        await originalFirstQuit();
      };

      firstRun = ingestOnce({
        pop3: firstPop3,
        db: firstWorker.db,
        ingestMailboxId,
      });
      await quitEntered.promise;

      secondRun = ingestOnce({
        pop3: secondPop3,
        db: secondWorker.db,
        ingestMailboxId,
      });
      const second = await secondRun;
      expect(second).toMatchObject({
        items: [
          {
            uidl: pop3Uidl,
            status: 'deferred',
            reason: 'ingest_uidl_claim_pending',
          },
        ],
      });
      expect(secondPop3.callLog.map((call) => call.op)).not.toContain('retr');
      releaseQuit.resolve();
      const first = await firstRun;
      expect(first).toMatchObject({ deled: 1 });
    } finally {
      releaseQuit.resolve();
      resetS3Storage();
      await Promise.allSettled(
        [firstRun, secondRun].filter(
          (promise): promise is Promise<unknown> => promise !== undefined,
        ),
      );
      await setup.db
        .delete(mailboxTransport)
        .where(eq(mailboxTransport.id, transportId))
        .catch(() => undefined);
      await setup.db
        .delete(mailIngestMailbox)
        .where(eq(mailIngestMailbox.id, ingestMailboxId))
        .catch(() => undefined);
      await Promise.all([setup.close(), firstWorker.close(), secondWorker.close()]);
    }
  }, 30000);
});

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'durable candidate attachment cleanup queue',
  () => {
    it('never executes legacy foreign-looking JSON cleanup keys', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-legacy-json');
      await withSeededTestDb(async (db) => {
        const ingestMailboxId = 'ingest-nava-legacy';
        const pop3Uidl = `legacy-json-${randomUUID()}`;
        const candidateMessageId = randomUUID();
        const foreignCandidateId = randomUUID();
        const foreignKey = `attachments/${foreignCandidateId}/001-foreign.bin`;
        const raw = candidateMessage({
          attachmentCount: 1,
          ownerHeaderValue: 'unknown-owner@zero.test',
        });

        await db.insert(mailIngestQuarantine).values({
          id: randomUUID(),
          ingestMailboxId,
          pop3Uidl,
          rawMimeS3Key: rawMimeKey({ ingestMailboxId, pop3Uidl }),
          reason: 'unknown_transport',
          ownerHeaderValue: 'unknown-owner@zero.test',
          parsedHeaders: { candidateAttachmentCleanupKeys: [foreignKey] },
        });
        await storage.putObject({
          key: foreignKey,
          body: Buffer.from('foreign candidate must survive'),
          contentType: 'application/octet-stream',
        });
        const parsed = await parseRawMessage(raw, { messageId: candidateMessageId, storage });
        const candidateKey = parsed.attachments[0]?.s3Key;
        if (!candidateKey) throw new Error('missing candidate attachment');

        const result = await persistInboundMessage(
          parsed,
          raw,
          { ingestMailboxId, pop3Uidl, messageId: candidateMessageId },
          { db, storage, skipAiEnqueue: true },
        );

        expect(result.kind).toBe('quarantined');
        expect(storage.get(foreignKey)).toBeDefined();
        expect(storage.calls).not.toContainEqual({ op: 'DELETE', key: foreignKey });
        expect(storage.get(candidateKey)).toBeUndefined();
      });
    }, 30000);

    it('defers a sweeper while claimed parsing has pending cleanup', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-claimed-canonical');
      const setup = openTestDbSession();
      const worker = openTestDbSession();
      const ingestMailboxId = `ingest-cleanup-claimed-${randomUUID()}`;
      const transportId = `transport-cleanup-claimed-${randomUUID()}`;
      const transportEmail = `${transportId}@zero.test`;
      const pop3Uidl = `cleanup-claimed-${randomUUID()}`;
      const attachmentUploaded = deferred();
      const releaseAttachmentUpload = deferred();
      const originalPutObject = storage.putObject.bind(storage);
      let blockAttachmentUpload = true;
      let candidateKey: string | undefined;
      let workerRun: Promise<unknown> | undefined;

      try {
        await setup.db.insert(mailIngestMailbox).values({
          id: ingestMailboxId,
          email: `${ingestMailboxId}@zero.test`,
          description: 'claimed cleanup canonical test',
        });
        await setup.db.insert(mailboxTransport).values({
          id: transportId,
          email: transportEmail,
          ownerHeaderValue: transportEmail,
          mailboxType: 'personal',
          isActive: true,
        });
        const raw = candidateMessage({
          attachmentCount: 1,
          ownerHeaderValue: transportEmail,
          subject: 'claimed cleanup canonical',
        });

        storage.putObject = async (opts) => {
          const result = await originalPutObject(opts);
          if (blockAttachmentUpload && opts.key.startsWith('attachments/')) {
            blockAttachmentUpload = false;
            candidateKey = opts.key;
            attachmentUploaded.resolve();
            await releaseAttachmentUpload.promise;
          }
          return result;
        };
        resetS3Storage();
        setS3Storage(storage);
        const pop3 = new FakePop3Client({ messages: [{ uidl: pop3Uidl, raw }] });
        workerRun = ingestOnce({
          pop3,
          db: worker.db,
          ingestMailboxId,
        });
        await attachmentUploaded.promise;
        if (!candidateKey) throw new Error('missing candidate attachment');
        const candidateMessageId = candidateKey.split('/')[1];
        if (!candidateMessageId) throw new Error('missing candidate message id');
        await insertCleanupTask({
          db: setup.db,
          candidateMessageId,
          ingestMailboxId,
          pop3Uidl,
          s3Key: candidateKey,
        });

        await sweepCandidateAttachmentCleanupTasks({ db: setup.db, storage });
        expect(storage.get(candidateKey)).toBeDefined();
        expect(await cleanupTaskCount(setup.db, ingestMailboxId, pop3Uidl)).toBe(1);

        releaseAttachmentUpload.resolve();
        const workerResult = await workerRun;
        expect(workerResult).toMatchObject({
          deled: 0,
          items: [{ status: 'deferred', result: { kind: 'deferred' } }],
        });

        await makeCleanupTasksDue(setup.db, ingestMailboxId, pop3Uidl);
        await sweepCandidateAttachmentCleanupTasks({ db: setup.db, storage });

        expect(storage.get(candidateKey)).toBeUndefined();
        expect(await cleanupTaskCount(setup.db, ingestMailboxId, pop3Uidl)).toBe(0);
      } finally {
        releaseAttachmentUpload.resolve();
        storage.putObject = originalPutObject;
        resetS3Storage();
        await Promise.allSettled(
          [workerRun].filter((promise): promise is Promise<unknown> => promise !== undefined),
        );
        await deleteCleanupTasksIfPresent(setup.db, ingestMailboxId).catch(() => undefined);
        await setup.db
          .delete(mailboxTransport)
          .where(eq(mailboxTransport.id, transportId))
          .catch(() => undefined);
        await setup.db
          .delete(mailIngestMailbox)
          .where(eq(mailIngestMailbox.id, ingestMailboxId))
          .catch(() => undefined);
        await Promise.all([setup.close(), worker.close()]);
      }
    }, 30000);

    it('defers cleanup while matching UIDL has an active processing claim', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-active-uidl-claim');
      const ingestMailboxId = 'ingest-nava-legacy';
      const pop3Uidl = `active-cleanup-claim-${randomUUID()}`;
      const candidateMessageId = randomUUID();
      const raw = candidateMessage({
        attachmentCount: 1,
        ownerHeaderValue: 'unknown-owner@zero.test',
      });

      await withSeededTestDb(async (db) => {
        const parsed = await parseRawMessage(raw, { messageId: candidateMessageId, storage });
        const candidateKey = parsed.attachments[0]?.s3Key;
        if (!candidateKey) throw new Error('missing candidate attachment');
        await insertCleanupTask({
          db,
          candidateMessageId,
          ingestMailboxId,
          pop3Uidl,
          s3Key: candidateKey,
        });
        const claimToken = await claimIngestUidl(db, { ingestMailboxId, pop3Uidl });
        if (!claimToken) throw new Error('missing UIDL claim');

        await sweepCandidateAttachmentCleanupTasks({ db, storage });

        expect(storage.get(candidateKey)).toBeDefined();
        expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(1);

        await releaseIngestUidlClaim(db, { ingestMailboxId, pop3Uidl }, claimToken);
        await makeCleanupTasksDue(db, ingestMailboxId, pop3Uidl);
        await sweepCandidateAttachmentCleanupTasks({ db, storage });

        expect(storage.get(candidateKey)).toBeUndefined();
        expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(0);
      });
    }, 30000);

    it('waits for durable cleanup registration before reconciling a returned copy', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-reconciliation-fence');
      const setup = openTestDbSession();
      const registration = openTestDbSession();
      const reconciliation = openTestDbSession();
      const suffix = randomUUID();
      const ingestMailboxId = `ingest-cleanup-fence-${suffix}`;
      const pop3Uidl = `cleanup-fence-${suffix}`;
      const transportId = `transport-cleanup-fence-${suffix}`;
      const transportAddress = `${transportId}@zero.test`;
      const canonicalMessageId = randomUUID();
      const canonicalThreadId = randomUUID();
      const returnedMessageId = `returned-${randomUUID()}@zero.test`;
      const candidateMessageId = randomUUID();
      const registrationStarted = deferred();
      const releaseRegistration = deferred();
      let registrationTransaction: Promise<unknown> | undefined;
      let reconciliationResult: Promise<unknown> | undefined;

      try {
        await setup.db.insert(mailIngestMailbox).values({
          id: ingestMailboxId,
          email: `${ingestMailboxId}@zero.test`,
          description: 'cleanup registration reconciliation fence test',
        });
        await setup.db.insert(mailboxTransport).values({
          id: transportId,
          email: transportAddress,
          ownerHeaderValue: transportAddress,
          mailboxType: 'personal',
          isActive: true,
        });
        await setup.db.insert(mailThread).values({
          id: canonicalThreadId,
          transportId,
          threadRootId: `cleanup-fence-${canonicalThreadId}`,
          subject: 'canonical outbound',
          snippet: 'cleanup fence',
          isArchived: false,
          isStarred: false,
          isRead: true,
          labelIds: [],
          latestMessageAt: new Date(),
        });
        await setup.db.insert(message).values({
          id: canonicalMessageId,
          transportId,
          threadId: canonicalThreadId,
          direction: 'outbound',
          fromAddress: transportAddress,
          toAddresses: [transportAddress],
          ccAddresses: [],
          bccAddresses: [],
          subject: 'canonical outbound',
          textBody: 'canonical outbound',
          messageIdHeader: returnedMessageId,
          references: [],
          isRead: true,
          isStarred: false,
          receivedAt: new Date(),
        });
        await setup.db.insert(outboundSendQueue).values({
          id: randomUUID(),
          transportId,
          messageId: canonicalMessageId,
          sendAt: new Date(),
          status: 'sent',
          smtpPayload: {},
          attempts: 1,
          lastError: null,
          claimedAt: new Date(),
        });

        const raw = Buffer.from(
          [
            `X-Zero-Mailbox: ${transportAddress}`,
            `X-Zero-Outbound-Id: ${canonicalMessageId}`,
            `Message-ID: <${returnedMessageId}>`,
            `From: ${transportAddress}`,
            `To: ${transportAddress}`,
            'Received: from 172.24.0.10 by zimbra-a; Mon, 24 Aug 2026 12:00:00 +0000',
            'Received: from localhost by local-a; Mon, 24 Aug 2026 12:00:01 +0000',
            'Received: from localhost by local-b; Mon, 24 Aug 2026 12:00:02 +0000',
            'Received: from 172.24.0.8 by rocket-a; Mon, 24 Aug 2026 12:00:03 +0000',
            'Received: from 172.24.0.8 by rocket-b; Mon, 24 Aug 2026 12:00:04 +0000',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="cleanup-fence-boundary"',
            '',
            '--cleanup-fence-boundary',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'trusted returned copy',
            '--cleanup-fence-boundary',
            'Content-Type: application/octet-stream; name="returned.bin"',
            'Content-Disposition: attachment; filename="returned.bin"',
            'Content-Transfer-Encoding: base64',
            '',
            'Y2xlYW51cA==',
            '--cleanup-fence-boundary--',
          ].join('\r\n'),
        );
        const parsed = await parseRawMessage(raw, {
          messageId: candidateMessageId,
          storage,
        });
        const candidateKey = parsed.attachments[0]?.s3Key;
        if (!candidateKey) throw new Error('missing returned-copy candidate attachment');

        registrationTransaction = registration.db.transaction(async (tx) => {
          const transactionDb = tx as unknown as DB;
          await transactionDb.execute(sql`
            SELECT pg_advisory_xact_lock(
              hashtext(${ingestMailboxId}),
              hashtext(${pop3Uidl})
            )
          `);
          await insertCleanupTask({
            db: transactionDb,
            candidateMessageId,
            ingestMailboxId,
            pop3Uidl,
            s3Key: candidateKey,
          });
          registrationStarted.resolve();
          await releaseRegistration.promise;
        });
        await registrationStarted.promise;

        reconciliationResult = persistInboundMessage(
          parsed,
          raw,
          {
            ingestMailboxId,
            pop3Uidl,
            messageId: candidateMessageId,
          },
          {
            db: reconciliation.db,
            ingestSource: 'live-pop3',
            skipAiEnqueue: true,
            storage,
          },
        );
        expect(
          await Promise.race([
            reconciliationResult.then(() => 'settled'),
            wait(250).then(() => 'waiting'),
          ]),
        ).toBe('waiting');

        releaseRegistration.resolve();
        await registrationTransaction;
        const result = await reconciliationResult;
        expect(result).toMatchObject({ kind: 'deferred' });
        expect(
          await setup.db
            .select({ s3Key: attachment.s3Key })
            .from(attachment)
            .where(eq(attachment.s3Key, candidateKey)),
        ).toEqual([]);
      } finally {
        releaseRegistration.resolve();
        await Promise.allSettled(
          [registrationTransaction, reconciliationResult].filter(
            (promise): promise is Promise<unknown> => promise !== undefined,
          ),
        );
        await deleteCleanupTasksIfPresent(setup.db, ingestMailboxId).catch(() => undefined);
        await setup.db
          .delete(outboundSendQueue)
          .where(eq(outboundSendQueue.messageId, canonicalMessageId))
          .catch(() => undefined);
        await setup.db
          .delete(message)
          .where(eq(message.id, canonicalMessageId))
          .catch(() => undefined);
        await setup.db
          .delete(mailThread)
          .where(eq(mailThread.id, canonicalThreadId))
          .catch(() => undefined);
        await setup.db
          .delete(mailboxTransport)
          .where(eq(mailboxTransport.id, transportId))
          .catch(() => undefined);
        await setup.db
          .delete(mailIngestMailbox)
          .where(eq(mailIngestMailbox.id, ingestMailboxId))
          .catch(() => undefined);
        await Promise.all([setup.close(), registration.close(), reconciliation.close()]);
      }
    }, 30000);

    it('bounds failed cleanup work while eventually reaching later due tasks', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-starvation');
      const ingestMailboxId = 'ingest-nava-legacy';
      const oldUidl = `old-cleanup-failures-${randomUUID()}`;
      const newerUidl = `newer-cleanup-${randomUUID()}`;
      const oldCreatedAt = new Date(Date.now() - 60_000);
      const newerCreatedAt = new Date();
      const oldTasks = Array.from({ length: 501 }, () => {
        const candidateMessageId = randomUUID();
        return {
          candidateMessageId,
          createdAt: oldCreatedAt,
          ingestMailboxId,
          pop3Uidl: oldUidl,
          s3Key: `attachments/${candidateMessageId}/000-old.bin`,
        };
      });
      const newerCandidateMessageId = randomUUID();
      const newerKey = `attachments/${newerCandidateMessageId}/000-newer.bin`;
      const originalDeleteObject = storage.deleteObject.bind(storage);
      const oldKeys = new Set(oldTasks.map((task) => task.s3Key));
      let oldDeleteAttempts = 0;

      await withSeededTestDb(async (db) => {
        await insertCleanupTasks({
          db,
          tasks: [
            ...oldTasks,
            {
              candidateMessageId: newerCandidateMessageId,
              createdAt: newerCreatedAt,
              ingestMailboxId,
              pop3Uidl: newerUidl,
              s3Key: newerKey,
            },
          ],
        });
        await Promise.all(
          [...oldKeys, newerKey].map((key) =>
            storage.putObject({
              key,
              body: Buffer.from(key),
              contentType: 'application/octet-stream',
            }),
          ),
        );
        storage.deleteObject = async (key) => {
          if (oldKeys.has(key)) {
            oldDeleteAttempts += 1;
            throw new Error('injected old cleanup failure');
          }
          await originalDeleteObject(key);
        };

        try {
          await sweepCandidateAttachmentCleanupTasks({ db, storage, limit: 500 });
          expect(oldDeleteAttempts).toBe(500);
          expect(storage.get(newerKey)).toBeDefined();
          expect(await cleanupTaskCount(db, ingestMailboxId, newerUidl)).toBe(1);

          await db.execute(sql`
            UPDATE ${cleanupTaskTable}
            SET "next_attempt_at" = now() + interval '1 hour'
            WHERE "pop3_uidl" = ${oldUidl}
              AND "attempts" > 0
          `);
          await sweepCandidateAttachmentCleanupTasks({ db, storage, limit: 500 });
        } finally {
          storage.deleteObject = originalDeleteObject;
        }

        expect(oldDeleteAttempts).toBe(501);
        expect(storage.get(newerKey)).toBeUndefined();
        expect(await cleanupTaskCount(db, ingestMailboxId, newerUidl)).toBe(0);
      });
    }, 30000);

    it('does not let active UIDL claims consume cleanup sweep capacity', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-claim-capacity');
      const ingestMailboxId = 'ingest-nava-legacy';
      const claimedUidl = `claimed-cleanup-${randomUUID()}`;
      const laterUidl = `later-cleanup-${randomUUID()}`;
      const claimedCreatedAt = new Date(Date.now() - 60_000);
      const laterCreatedAt = new Date();
      const claimedTasks = Array.from({ length: 500 }, () => {
        const candidateMessageId = randomUUID();
        return {
          candidateMessageId,
          createdAt: claimedCreatedAt,
          ingestMailboxId,
          pop3Uidl: claimedUidl,
          s3Key: `attachments/${candidateMessageId}/000-claimed.bin`,
        };
      });
      const laterCandidateMessageId = randomUUID();
      const laterKey = `attachments/${laterCandidateMessageId}/000-later.bin`;

      await withSeededTestDb(async (db) => {
        await insertCleanupTasks({
          db,
          tasks: [
            ...claimedTasks,
            {
              candidateMessageId: laterCandidateMessageId,
              createdAt: laterCreatedAt,
              ingestMailboxId,
              pop3Uidl: laterUidl,
              s3Key: laterKey,
            },
          ],
        });
        await Promise.all(
          [...claimedTasks.map((task) => task.s3Key), laterKey].map((key) =>
            storage.putObject({
              key,
              body: Buffer.from(key),
              contentType: 'application/octet-stream',
            }),
          ),
        );
        const claimToken = await claimIngestUidl(db, {
          ingestMailboxId,
          pop3Uidl: claimedUidl,
        });
        if (!claimToken) throw new Error('missing active cleanup claim');

        await sweepCandidateAttachmentCleanupTasks({ db, storage, limit: 500 });

        expect(storage.get(laterKey)).toBeUndefined();
        expect(await cleanupTaskCount(db, ingestMailboxId, laterUidl)).toBe(0);
        expect(await cleanupTaskCount(db, ingestMailboxId, claimedUidl)).toBe(500);
      });
    }, 60000);

    it('exposes only attachments uploaded before parser failure', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-parser-partial');
      const messageId = randomUUID();
      const raw = candidateMessage({
        attachmentCount: 2,
        ownerHeaderValue: 'unknown-owner@zero.test',
      });
      const originalPutObject = storage.putObject.bind(storage);
      storage.putObject = async (opts) => {
        if (opts.key.startsWith(`attachments/${messageId}/001-`)) {
          throw new Error('injected second attachment upload failure');
        }
        return originalPutObject(opts);
      };

      const error = await parseRawMessage(raw, { messageId, storage }).then(
        () => undefined,
        (reason: unknown) => reason,
      );

      expect(error).toMatchObject({
        uploadedAttachments: [
          expect.objectContaining({
            s3Key: `attachments/${messageId}/000-candidate-0.bin`,
          }),
        ],
      });
      expect(storage.listKeys(`attachments/${messageId}/`)).toEqual([
        `attachments/${messageId}/000-candidate-0.bin`,
      ]);
    }, 30000);

    it('does not clean a canonical attachment after a partial replay failure', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-canonical-partial-replay');
      const ingestMailboxId = 'ingest-nava-legacy';
      const pop3Uidl = `canonical-partial-replay-${randomUUID()}`;
      const raw = candidateMessage({
        attachmentCount: 2,
        ownerHeaderValue: 'centurion@legacyhotels.co.za',
      });
      const pop3 = new FakePop3Client({ messages: [{ uidl: pop3Uidl, raw }] });
      const originalDele = pop3.dele.bind(pop3);
      const originalPutObject = storage.putObject.bind(storage);
      resetS3Storage();
      setS3Storage(storage);

      try {
        await withSeededTestDb(async (db) => {
          pop3.dele = async () => {
            throw new Error('injected POP3 DELE failure after canonical commit');
          };
          const first = await ingestOnce({
            pop3,
            db,
            ingestMailboxId,
          });
          const canonicalKey = storage.listKeys('attachments/')[0];
          if (!canonicalKey) throw new Error('missing canonical attachment');

          expect(first.deled).toBe(0);
          expect(storage.get(canonicalKey)).toBeDefined();

          pop3.dele = originalDele;
          storage.putObject = async (opts) => {
            if (opts.key.startsWith('attachments/') && opts.key.includes('/001-')) {
              throw new Error('injected second attachment upload failure');
            }
            return originalPutObject(opts);
          };

          const retry = await ingestOnce({
            pop3,
            db,
            failureCounts: new Map([[pop3Uidl, 2]]),
            ingestMailboxId,
          });

          expect(retry.deled).toBe(1);
          expect(storage.get(canonicalKey)).toBeDefined();
          expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(0);
        });
      } finally {
        pop3.dele = originalDele;
        storage.putObject = originalPutObject;
        resetS3Storage();
      }
    }, 30000);

    it('preserves canonical data while discarding a stale cleanup task', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-stale-canonical-task');
      const ingestMailboxId = 'ingest-nava-legacy';
      const pop3Uidl = `stale-canonical-task-${randomUUID()}`;
      const messageId = randomUUID();
      const raw = candidateMessage({
        attachmentCount: 1,
        ownerHeaderValue: 'centurion@legacyhotels.co.za',
      });

      await withSeededTestDb(async (db) => {
        const parsed = await parseRawMessage(raw, { messageId, storage });
        const canonicalKey = parsed.attachments[0]?.s3Key;
        if (!canonicalKey) throw new Error('missing canonical attachment');
        const stored = await persistInboundMessage(
          parsed,
          raw,
          { ingestMailboxId, pop3Uidl, messageId },
          { db, storage, skipAiEnqueue: true },
        );
        expect(stored.kind).toBe('stored');
        await insertCleanupTask({
          db,
          candidateMessageId: messageId,
          ingestMailboxId,
          pop3Uidl,
          s3Key: canonicalKey,
        });

        await sweepCandidateAttachmentCleanupTasks({ db, storage });

        expect(storage.get(canonicalKey)).toBeDefined();
        expect(storage.calls).not.toContainEqual({ op: 'DELETE', key: canonicalKey });
        expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(0);
      });
    }, 30000);

    it('holds poison POP3 until partial parser uploads have durable cleanup', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-worker-partial');
      const ingestMailboxId = 'ingest-nava-legacy';
      const pop3Uidl = `parser-partial-${randomUUID()}`;
      const raw = candidateMessage({
        attachmentCount: 2,
        ownerHeaderValue: 'unknown-owner@zero.test',
      });
      const pop3 = new FakePop3Client({ messages: [{ uidl: pop3Uidl, raw }] });
      const originalPutObject = storage.putObject.bind(storage);
      const originalDeleteObject = storage.deleteObject.bind(storage);
      let failSecondAttachmentUpload = true;
      let failCleanupDelete = true;
      storage.putObject = async (opts) => {
        if (
          failSecondAttachmentUpload &&
          opts.key.startsWith('attachments/') &&
          opts.key.includes('/001-')
        ) {
          throw new Error('injected second attachment upload failure');
        }
        return originalPutObject(opts);
      };
      storage.deleteObject = async (key) => {
        if (failCleanupDelete && key.startsWith('attachments/')) {
          throw new Error('injected partial attachment cleanup failure');
        }
        await originalDeleteObject(key);
      };
      resetS3Storage();
      setS3Storage(storage);

      try {
        await withSeededTestDb(async (db) => {
          const failureCounts = new Map([[pop3Uidl, 2]]);
          const first = await ingestOnce({
            pop3,
            db,
            failureCounts,
            ingestMailboxId,
          });
          const partialKey = storage.listKeys('attachments/')[0];
          const rawKey = rawMimeKey({ ingestMailboxId, pop3Uidl });

          expect(first.deled).toBe(0);
          expect(storage.get(rawKey)).toBeDefined();
          expect(partialKey).toBeDefined();
          expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(1);

          await db.execute(sql`
            UPDATE ${cleanupTaskTable}
            SET "next_attempt_at" = now()
            WHERE "ingest_mailbox_id" = ${ingestMailboxId}
              AND "pop3_uidl" = ${pop3Uidl}
          `);
          failSecondAttachmentUpload = false;
          failCleanupDelete = false;

          const second = await ingestOnce({
            pop3,
            db,
            failureCounts,
            ingestMailboxId,
          });

          expect(second.deled).toBe(1);
          expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(0);
          expect(storage.listKeys('attachments/')).toEqual([]);
        });
      } finally {
        storage.putObject = originalPutObject;
        storage.deleteObject = originalDeleteObject;
        resetS3Storage();
      }
    }, 30000);

    it('cleans parsed uploads when persistence rolls back before poison deletion', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-persist-rollback');
      const ingestMailboxId = 'ingest-nava-legacy';
      const pop3Uidl = `persist-rollback-${randomUUID()}`;
      const raw = candidateMessage({
        attachmentCount: 1,
        ownerHeaderValue: 'centurion@legacyhotels.co.za',
      });
      const pop3 = new FakePop3Client({ messages: [{ uidl: pop3Uidl, raw }] });
      const functionName = `reject_message_${randomUUID().replaceAll('-', '_')}`;
      const triggerName = `reject_message_trigger_${randomUUID().replaceAll('-', '_')}`;
      resetS3Storage();
      setS3Storage(storage);

      try {
        await withSeededTestDb(async (db) => {
          await db.execute(
            sql.raw(`
            CREATE FUNCTION "${functionName}"()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              RAISE EXCEPTION 'injected message persistence failure';
            END;
            $$;
          `),
          );
          await db.execute(
            sql.raw(`
            CREATE TRIGGER "${triggerName}"
            BEFORE INSERT ON "message"
            FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
          `),
          );

          const result = await ingestOnce({
            pop3,
            db,
            failureCounts: new Map([[pop3Uidl, 2]]),
            ingestMailboxId,
          });

          expect(result.deled).toBe(1);
          expect(storage.listKeys('attachments/')).toEqual([]);
          expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(0);
        });
      } finally {
        resetS3Storage();
      }
    }, 30000);

    it('persists and drains every candidate attachment beyond cleanup sweep batch size', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-no-cap');
      const ingestMailboxId = 'ingest-nava-legacy';
      const pop3Uidl = `over-sweep-batch-${randomUUID()}`;
      const raw = candidateMessage({
        attachmentCount: 501,
        ownerHeaderValue: 'unknown-owner@zero.test',
      });

      await withSeededTestDb(async (db) => {
        const firstMessageId = randomUUID();
        const firstParsed = await parseRawMessage(raw, { messageId: firstMessageId, storage });
        const firstKeys = firstParsed.attachments.map((attachment) => attachment.s3Key);
        const originalDeleteObject = storage.deleteObject.bind(storage);
        storage.deleteObject = async () => {
          throw new Error('injected first cleanup failure');
        };
        const first = await (async () => {
          try {
            return await persistInboundMessage(
              firstParsed,
              raw,
              { ingestMailboxId, pop3Uidl, messageId: firstMessageId },
              { db, storage, skipAiEnqueue: true },
            );
          } finally {
            storage.deleteObject = originalDeleteObject;
          }
        })();

        expect(first.kind).toBe('quarantined');
        if (first.kind !== 'quarantined') return;
        expect(first.candidateAttachmentCleanupFailureCount).toBe(501);
        expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(501);
        await makeCleanupTasksDue(db, ingestMailboxId, pop3Uidl);

        const retryMessageId = randomUUID();
        const retryParsed = await parseRawMessage(raw, { messageId: retryMessageId, storage });
        const retryKeys = retryParsed.attachments.map((attachment) => attachment.s3Key);
        const retry = await persistInboundMessage(
          retryParsed,
          raw,
          { ingestMailboxId, pop3Uidl, messageId: retryMessageId },
          { db, storage, skipAiEnqueue: true },
        );

        expect(retry.kind).toBe('quarantined');
        if (retry.kind !== 'quarantined') return;
        expect(retry.candidateAttachmentCleanupFailureCount).toBe(0);
        expect(firstKeys.every((key) => storage.get(key) === undefined)).toBe(true);
        expect(retryKeys.every((key) => storage.get(key) === undefined)).toBe(true);
        expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(0);
      });
    }, 60000);

    it('does not repeat an exact-limit cleanup batch when durable deferral fails', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-defer-failure');
      const ingestMailboxId = 'ingest-nava-legacy';
      const pop3Uidl = `defer-failure-${randomUUID()}`;
      const raw = candidateMessage({
        attachmentCount: 500,
        ownerHeaderValue: 'unknown-owner@zero.test',
      });
      const functionName = `fail_cleanup_defer_${randomUUID().replaceAll('-', '_')}`;
      const sequenceName = `fail_cleanup_defer_seq_${randomUUID().replaceAll('-', '_')}`;
      const triggerName = `fail_cleanup_defer_trigger_${randomUUID().replaceAll('-', '_')}`;
      const originalDeleteObject = storage.deleteObject.bind(storage);

      await withSeededTestDb(async (db) => {
        const messageId = randomUUID();
        const parsed = await parseRawMessage(raw, { messageId, storage });
        storage.deleteObject = async () => {
          throw new Error('injected candidate cleanup delete failure');
        };
        await db.execute(sql.raw(`CREATE SEQUENCE "${sequenceName}";`));
        await db.execute(
          sql.raw(`
            CREATE FUNCTION "${functionName}"()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF nextval('${sequenceName}') <= 501 THEN
                RAISE EXCEPTION 'injected durable cleanup deferral failure';
              END IF;
              RETURN NEW;
            END;
            $$;
          `),
        );
        await db.execute(
          sql.raw(`
            CREATE TRIGGER "${triggerName}"
            BEFORE UPDATE ON "mail_ingest_candidate_attachment_cleanup"
            FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
          `),
        );

        try {
          const result = await persistInboundMessage(
            parsed,
            raw,
            { ingestMailboxId, pop3Uidl, messageId },
            { db, storage, skipAiEnqueue: true },
          );

          expect(result).toMatchObject({
            kind: 'quarantined',
            candidateAttachmentCleanupFailureCount: 500,
          });
        } finally {
          storage.deleteObject = originalDeleteObject;
        }
      });
    }, 60000);

    it('retains both concurrent replay tasks until a later drain succeeds', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-concurrent-replays');
      const setup = openTestDbSession();
      const left = openTestDbSession();
      const right = openTestDbSession();
      const ingestMailboxId = `ingest-cleanup-${randomUUID()}`;
      const pop3Uidl = `concurrent-cleanup-${randomUUID()}`;
      const functionName = `test_delay_cleanup_${randomUUID().slice(0, 8)}`;
      const triggerName = `test_delay_cleanup_trigger_${randomUUID().slice(0, 8)}`;
      const raw = candidateMessage({
        attachmentCount: 1,
        ownerHeaderValue: 'unknown-owner@zero.test',
      });
      const originalDeleteObject = storage.deleteObject.bind(storage);

      try {
        await setup.db.insert(mailIngestMailbox).values({
          id: ingestMailboxId,
          email: `${ingestMailboxId}@zero.test`,
          description: 'durable cleanup concurrency test',
        });
        await setup.db.insert(mailIngestQuarantine).values({
          id: randomUUID(),
          ingestMailboxId,
          pop3Uidl,
          rawMimeS3Key: rawMimeKey({ ingestMailboxId, pop3Uidl }),
          reason: 'unknown_transport',
          ownerHeaderValue: 'unknown-owner@zero.test',
          parsedHeaders: {},
        });
        await setup.db.execute(
          sql.raw(`
          CREATE FUNCTION "${functionName}"()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            PERFORM pg_sleep(0.15);
            RETURN NEW;
          END;
          $$;
        `),
        );
        await setup.db.execute(
          sql.raw(`
          CREATE TRIGGER "${triggerName}"
          BEFORE INSERT ON "mail_ingest_candidate_attachment_cleanup"
          FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
        `),
        );

        const leftMessageId = randomUUID();
        const rightMessageId = randomUUID();
        const [leftParsed, rightParsed] = await Promise.all([
          parseRawMessage(raw, { messageId: leftMessageId, storage }),
          parseRawMessage(raw, { messageId: rightMessageId, storage }),
        ]);
        const leftKey = leftParsed.attachments[0]?.s3Key;
        const rightKey = rightParsed.attachments[0]?.s3Key;
        if (!leftKey || !rightKey) throw new Error('missing concurrent candidate attachment');

        storage.deleteObject = async () => {
          throw new Error('injected concurrent cleanup failure');
        };
        const results = await Promise.all([
          persistInboundMessage(
            leftParsed,
            raw,
            { ingestMailboxId, pop3Uidl, messageId: leftMessageId },
            { db: left.db, storage, skipAiEnqueue: true },
          ),
          persistInboundMessage(
            rightParsed,
            raw,
            { ingestMailboxId, pop3Uidl, messageId: rightMessageId },
            { db: right.db, storage, skipAiEnqueue: true },
          ),
        ]);
        storage.deleteObject = originalDeleteObject;

        expect(results.map((result) => result.kind)).toEqual(['quarantined', 'quarantined']);
        expect(await cleanupTaskCount(setup.db, ingestMailboxId, pop3Uidl)).toBe(2);
        await makeCleanupTasksDue(setup.db, ingestMailboxId, pop3Uidl);
        const drainMessageId = randomUUID();
        const drainRaw = candidateMessage({
          attachmentCount: 0,
          ownerHeaderValue: 'unknown-owner@zero.test',
        });
        const drainParsed = await parseRawMessage(drainRaw, {
          messageId: drainMessageId,
          storage,
        });
        await persistInboundMessage(
          drainParsed,
          drainRaw,
          { ingestMailboxId, pop3Uidl, messageId: drainMessageId },
          { db: setup.db, storage, skipAiEnqueue: true },
        );

        expect(storage.get(leftKey)).toBeUndefined();
        expect(storage.get(rightKey)).toBeUndefined();
        expect(await cleanupTaskCount(setup.db, ingestMailboxId, pop3Uidl)).toBe(0);
      } finally {
        storage.deleteObject = originalDeleteObject;
        await setup.db
          .execute(
            sql.raw(
              `DROP TRIGGER IF EXISTS "${triggerName}" ON "mail_ingest_candidate_attachment_cleanup";`,
            ),
          )
          .catch(() => undefined);
        await setup.db
          .execute(sql.raw(`DROP FUNCTION IF EXISTS "${functionName}"();`))
          .catch(() => undefined);
        await deleteCleanupTasksIfPresent(setup.db, ingestMailboxId).catch(() => undefined);
        await setup.db
          .delete(mailIngestQuarantine)
          .where(eq(mailIngestQuarantine.ingestMailboxId, ingestMailboxId))
          .catch(() => undefined);
        await setup.db
          .delete(mailIngestMailbox)
          .where(eq(mailIngestMailbox.id, ingestMailboxId))
          .catch(() => undefined);
        await Promise.all([setup.close(), left.close(), right.close()]);
      }
    }, 30000);

    it('retries an idempotent S3 deletion when deleting durable task row initially fails', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-delete-row-retry');
      const ingestMailboxId = 'ingest-nava-legacy';
      const pop3Uidl = `delete-row-retry-${randomUUID()}`;
      const candidateMessageId = randomUUID();
      const s3Key = `attachments/${candidateMessageId}/001-delete-row-retry.bin`;
      const functionName = `test_fail_cleanup_delete_${randomUUID().slice(0, 8)}`;
      const triggerName = `test_fail_cleanup_delete_trigger_${randomUUID().slice(0, 8)}`;
      resetS3Storage();
      setS3Storage(storage);

      try {
        await withSeededTestDb(async (db) => {
          await storage.putObject({
            key: s3Key,
            body: Buffer.from('delete task row retry'),
            contentType: 'application/octet-stream',
          });
          await insertCleanupTask({
            db,
            candidateMessageId,
            ingestMailboxId,
            pop3Uidl,
            s3Key,
          });
          await db.execute(
            sql.raw(`
            CREATE FUNCTION "${functionName}"()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              RAISE EXCEPTION 'injected durable cleanup task delete failure';
            END;
            $$;
          `),
          );
          await db.execute(
            sql.raw(`
            CREATE TRIGGER "${triggerName}"
            BEFORE DELETE ON "mail_ingest_candidate_attachment_cleanup"
            FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
          `),
          );

          await ingestOnce({
            pop3: new FakePop3Client({ messages: [] }),
            db,
            ingestMailboxId,
          });

          expect(storage.get(s3Key)).toBeUndefined();
          expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(1);
          expect(
            storage.calls.filter((call) => call.op === 'DELETE' && call.key === s3Key),
          ).toHaveLength(1);
          await db.execute(
            sql.raw(`DROP TRIGGER "${triggerName}" ON "mail_ingest_candidate_attachment_cleanup";`),
          );
          await db.execute(sql.raw(`DROP FUNCTION "${functionName}"();`));
          await makeCleanupTasksDue(db, ingestMailboxId, pop3Uidl);

          await ingestOnce({
            pop3: new FakePop3Client({ messages: [] }),
            db,
            ingestMailboxId,
          });

          expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(0);
          expect(
            storage.calls.filter((call) => call.op === 'DELETE' && call.key === s3Key),
          ).toHaveLength(2);
        });
      } finally {
        resetS3Storage();
      }
    }, 30000);

    it('recovers parsed uploads after a transient cleanup registration failure', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-registration-retry');
      const ingestMailboxId = `ingest-cleanup-registration-${randomUUID()}`;
      const pop3Uidl = `registration-retry-${randomUUID()}`;
      const raw = candidateMessage({
        attachmentCount: 1,
        ownerHeaderValue: 'unknown-owner@zero.test',
      });
      const pop3 = new FakePop3Client({ messages: [{ uidl: pop3Uidl, raw }] });
      const functionName = `test_fail_cleanup_insert_${randomUUID().slice(0, 8)}`;
      const sequenceName = `test_fail_cleanup_insert_seq_${randomUUID().slice(0, 8)}`;
      const triggerName = `test_fail_cleanup_insert_trigger_${randomUUID().slice(0, 8)}`;
      const session = openTestDbSession();
      resetS3Storage();
      setS3Storage(storage);

      try {
        const db = session.db;
        await db.insert(mailIngestMailbox).values({
          id: ingestMailboxId,
          email: `${ingestMailboxId}@zero.test`,
          description: 'candidate cleanup registration retry test',
        });
        await db.execute(sql.raw(`CREATE SEQUENCE "${sequenceName}";`));
        await db.execute(
          sql.raw(`
            CREATE FUNCTION "${functionName}"()
            RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF nextval('${sequenceName}') = 1 THEN
                RAISE EXCEPTION 'injected cleanup registration failure';
              END IF;
              RETURN NEW;
            END;
            $$;
          `),
        );
        await db.execute(
          sql.raw(`
            CREATE TRIGGER "${triggerName}"
            BEFORE INSERT ON "mail_ingest_candidate_attachment_cleanup"
            FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
          `),
        );

        const first = await ingestOnce({ pop3, db, ingestMailboxId });
        const firstCandidateKey = storage.calls.find(
          (call) => call.op === 'PUT' && call.key.startsWith('attachments/'),
        )?.key;
        if (!firstCandidateKey) throw new Error('missing failed-registration candidate attachment');

        expect(first.deled).toBe(0);
        expect(storage.get(firstCandidateKey)).toBeUndefined();
        expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(0);

        const second = await ingestOnce({ pop3, db, ingestMailboxId });

        expect(second.deled).toBe(1);
        expect(storage.get(firstCandidateKey)).toBeUndefined();
        expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(0);
      } finally {
        await session.db
          .execute(
            sql.raw(
              `DROP TRIGGER IF EXISTS "${triggerName}" ON "mail_ingest_candidate_attachment_cleanup";`,
            ),
          )
          .catch(() => undefined);
        await session.db
          .execute(sql.raw(`DROP FUNCTION IF EXISTS "${functionName}"();`))
          .catch(() => undefined);
        await session.db
          .execute(sql.raw(`DROP SEQUENCE IF EXISTS "${sequenceName}";`))
          .catch(() => undefined);
        await deleteCleanupTasksIfPresent(session.db, ingestMailboxId).catch(() => undefined);
        await session.db
          .delete(mailIngestQuarantine)
          .where(eq(mailIngestQuarantine.ingestMailboxId, ingestMailboxId))
          .catch(() => undefined);
        await session.db
          .delete(mailIngestMailbox)
          .where(eq(mailIngestMailbox.id, ingestMailboxId))
          .catch(() => undefined);
        await session.close();
        resetS3Storage();
      }
    }, 30000);

    it('holds quarantined POP3 raw MIME while owned task remains then drains it', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-quarantine-hold');
      const ingestMailboxId = 'ingest-nava-legacy';
      const pop3Uidl = `quarantine-hold-${randomUUID()}`;
      const raw = candidateMessage({
        attachmentCount: 1,
        ownerHeaderValue: 'unknown-owner@zero.test',
      });
      const pop3 = new FakePop3Client({ messages: [{ uidl: pop3Uidl, raw }] });
      const originalDeleteObject = storage.deleteObject.bind(storage);
      let failFirstDelete = true;
      storage.deleteObject = async (key) => {
        if (failFirstDelete && key.startsWith('attachments/')) {
          failFirstDelete = false;
          throw new Error('injected quarantine cleanup failure');
        }
        await originalDeleteObject(key);
      };
      resetS3Storage();
      setS3Storage(storage);

      try {
        await withSeededTestDb(async (db) => {
          const first = await ingestOnce({ pop3, db, ingestMailboxId });
          storage.deleteObject = originalDeleteObject;
          const sourceKey = rawMimeKey({ ingestMailboxId, pop3Uidl });

          expect(first.deled).toBe(0);
          expect(storage.get(sourceKey)).toBeDefined();
          expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(1);
          await makeCleanupTasksDue(db, ingestMailboxId, pop3Uidl);

          const second = await ingestOnce({ pop3, db, ingestMailboxId });
          expect(second.deled).toBe(1);
          expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(0);
          expect(storage.get(sourceKey)).toBeDefined();
          expect(
            storage.get(`quarantine-archive/${ingestMailboxId}/${pop3Uidl}.eml`),
          ).toBeDefined();
        });
      } finally {
        storage.deleteObject = originalDeleteObject;
        resetS3Storage();
      }
    }, 30000);

    it('keeps stored canonical attachments out of cleanup while duplicate cleanup stays durable', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-canonical-safe');
      const ingestMailboxId = 'ingest-nava-legacy';
      const pop3Uidl = `duplicate-cleanup-${randomUUID()}`;
      const raw = candidateMessage({
        attachmentCount: 1,
        ownerHeaderValue: 'navaai@legacyhotels.co.za',
      });

      await withSeededTestDb(async (db) => {
        const canonicalMessageId = randomUUID();
        const canonicalParsed = await parseRawMessage(raw, {
          messageId: canonicalMessageId,
          storage,
        });
        const canonicalKey = canonicalParsed.attachments[0]?.s3Key;
        if (!canonicalKey) throw new Error('missing canonical attachment');
        const stored = await persistInboundMessage(
          canonicalParsed,
          raw,
          { ingestMailboxId, pop3Uidl, messageId: canonicalMessageId },
          { db, storage, skipAiEnqueue: true },
        );

        expect(stored.kind).toBe('stored');
        expect(storage.get(canonicalKey)).toBeDefined();
        expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(0);

        const duplicateMessageId = randomUUID();
        const duplicateParsed = await parseRawMessage(raw, {
          messageId: duplicateMessageId,
          storage,
        });
        const duplicateKey = duplicateParsed.attachments[0]?.s3Key;
        if (!duplicateKey) throw new Error('missing duplicate candidate attachment');
        const originalDeleteObject = storage.deleteObject.bind(storage);
        storage.deleteObject = async () => {
          throw new Error('injected duplicate cleanup failure');
        };
        const duplicate = await (async () => {
          try {
            return await persistInboundMessage(
              duplicateParsed,
              raw,
              { ingestMailboxId, pop3Uidl, messageId: duplicateMessageId },
              { db, storage, skipAiEnqueue: true },
            );
          } finally {
            storage.deleteObject = originalDeleteObject;
          }
        })();

        expect(duplicate.kind).toBe('duplicate');
        if (duplicate.kind !== 'duplicate') return;
        expect(duplicate.candidateAttachmentCleanupFailureCount).toBe(1);
        expect(storage.get(canonicalKey)).toBeDefined();
        expect(await cleanupTaskKeys(db, ingestMailboxId, pop3Uidl)).toEqual([duplicateKey]);
      });
    }, 30000);

    it('enforces task key ownership in database', async () => {
      await withSeededTestDb(async (db) => {
        const candidateMessageId = randomUUID();
        const foreignCandidateMessageId = randomUUID();
        let thrown: unknown;
        try {
          await insertCleanupTask({
            db,
            candidateMessageId,
            ingestMailboxId: 'ingest-nava-legacy',
            pop3Uidl: `foreign-key-${randomUUID()}`,
            s3Key: `attachments/${foreignCandidateMessageId}/001-foreign.bin`,
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeDefined();
        expect((thrown as { cause?: { constraint_name?: string } }).cause?.constraint_name).toBe(
          'mail_ingest_candidate_attachment_cleanup_owned_key_check',
        );
      });
    }, 30000);
  },
);
