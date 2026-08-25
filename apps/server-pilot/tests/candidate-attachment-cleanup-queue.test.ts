import {
  openTestDbSession,
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db.js';
import { FakeS3Storage, rawMimeKey, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import { mailIngestMailbox, mailIngestQuarantine } from '../src/db/schema/mail.js';
import { parseRawMessage } from '../src/mail/ingest/parse-message.js';
import { persistInboundMessage } from '../src/mail/ingest/store.js';
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
        expect(first.candidateAttachmentCleanupFailureCount).toBe(500);
        expect(await cleanupTaskCount(db, ingestMailboxId, pop3Uidl)).toBe(501);

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
