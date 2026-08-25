import {
  attachment,
  mailIngestMailbox,
  mailIngestQuarantine,
  mailThread,
  mailboxTransport,
  message,
  outboundSendQueue,
} from '../src/db/schema/mail.js';
import {
  openTestDbSession,
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';
import {
  persistInboundMessage,
  sweepCandidateAttachmentCleanupTasks,
} from '../src/mail/ingest/store.js';
import { FakeS3Storage, rawMimeKey, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import { parseRawMessage } from '../src/mail/ingest/parse-message.js';
import { FakePop3Client } from '../src/mail/ingest/pop3-client.js';
import { ingestOnce } from '../src/mail/ingest/worker.js';
import type { DB } from '../src/db/client.js';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

const reachable = await probeTestDb();
const cleanupTaskTable = sql.raw('"mail_ingest_candidate_attachment_cleanup"');

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
  await db.execute(sql`
    UPDATE ${cleanupTaskTable}
    SET "next_attempt_at" = now()
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
        "created_at"
      )
      VALUES (
        ${task.s3Key},
        ${task.candidateMessageId},
        ${task.ingestMailboxId},
        ${task.pop3Uidl},
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

    it('does not let overlapping sweepers delete a retry that becomes canonical', async () => {
      const storage = new FakeS3Storage('candidate-cleanup-overlapping-sweepers');
      const setup = openTestDbSession();
      const firstSweeper = openTestDbSession();
      const secondSweeper = openTestDbSession();
      const retry = openTestDbSession();
      const ingestMailboxId = `ingest-cleanup-race-${randomUUID()}`;
      const transportId = `transport-cleanup-race-${randomUUID()}`;
      const transportEmail = `${transportId}@zero.test`;
      const pop3Uidl = `cleanup-race-${randomUUID()}`;
      const candidateMessageId = randomUUID();
      const firstDeleteEntered = deferred();
      const releaseFirstDelete = deferred();
      const canonicalStored = deferred();
      const originalDeleteObject = storage.deleteObject.bind(storage);
      let deleteCalls = 0;
      let firstSweep: Promise<unknown> | undefined;
      let secondSweep: Promise<unknown> | undefined;
      let retryPersistence: Promise<unknown> | undefined;

      try {
        await setup.db.insert(mailIngestMailbox).values({
          id: ingestMailboxId,
          email: `${ingestMailboxId}@zero.test`,
          description: 'overlapping cleanup sweeper test',
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
          subject: 'cleanup sweeper race',
        });
        const parsed = await parseRawMessage(raw, { messageId: candidateMessageId, storage });
        const candidateKey = parsed.attachments[0]?.s3Key;
        if (!candidateKey) throw new Error('missing candidate attachment');
        await insertCleanupTask({
          db: setup.db,
          candidateMessageId,
          ingestMailboxId,
          pop3Uidl,
          s3Key: candidateKey,
        });

        storage.deleteObject = async (key) => {
          deleteCalls += 1;
          if (deleteCalls === 1) {
            firstDeleteEntered.resolve();
            await releaseFirstDelete.promise;
          }
          await originalDeleteObject(key);
        };

        firstSweep = sweepCandidateAttachmentCleanupTasks({
          db: firstSweeper.db,
          storage,
          limit: 1,
        });
        await firstDeleteEntered.promise;
        secondSweep = sweepCandidateAttachmentCleanupTasks({
          db: secondSweeper.db,
          storage,
          limit: 1,
        });
        await secondSweep;

        retryPersistence = (async () => {
          await retry.db.execute(sql`
            DELETE FROM ${cleanupTaskTable}
            WHERE "s3_key" = ${candidateKey}
          `);
          const retryParsed = await parseRawMessage(raw, {
            messageId: candidateMessageId,
            storage,
          });
          const result = await persistInboundMessage(
            retryParsed,
            raw,
            { ingestMailboxId, pop3Uidl, messageId: candidateMessageId },
            { db: retry.db, storage, skipAiEnqueue: true },
          );
          canonicalStored.resolve();
          return result;
        })();

        await Promise.race([canonicalStored.promise, wait(750)]);
        releaseFirstDelete.resolve();
        const [, , retryResult] = await Promise.all([firstSweep, secondSweep, retryPersistence]);

        expect(retryResult).toMatchObject({ kind: 'stored' });
        expect(storage.get(candidateKey)).toBeDefined();
      } finally {
        releaseFirstDelete.resolve();
        storage.deleteObject = originalDeleteObject;
        await Promise.allSettled(
          [firstSweep, secondSweep, retryPersistence].filter(
            (promise): promise is Promise<unknown> => promise !== undefined,
          ),
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
        await Promise.all([
          setup.close(),
          firstSweeper.close(),
          secondSweeper.close(),
          retry.close(),
        ]);
      }
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

    it('processes newer due cleanup after old failures are deferred', async () => {
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
          if (oldKeys.has(key)) throw new Error('injected old cleanup failure');
          await originalDeleteObject(key);
        };

        try {
          await sweepCandidateAttachmentCleanupTasks({ db, storage, limit: 500 });
        } finally {
          storage.deleteObject = originalDeleteObject;
        }

        expect(storage.get(newerKey)).toBeUndefined();
        expect(await cleanupTaskCount(db, ingestMailboxId, newerUidl)).toBe(0);
      });
    }, 30000);

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
    }, 30000);

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

    it('reuses candidate keys after failed cleanup registration instead of poison-draining them', async () => {
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
        const firstCandidateKey = storage.listKeys('attachments/')[0];
        if (!firstCandidateKey) throw new Error('missing failed-registration candidate attachment');

        expect(first.deled).toBe(0);
        expect(storage.get(firstCandidateKey)).toBeDefined();
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
