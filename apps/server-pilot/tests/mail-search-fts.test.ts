import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { mailThread } from '../src/db/schema/mail.js';
import { parseRawMessage, generateMessageId } from '../src/mail/ingest/parse-message.js';
import { persistInboundMessage } from '../src/mail/ingest/store.js';
import {
  THREAD_SEARCH_VECTOR_CONFIG,
  threadSearchVectorText,
} from '../src/mail/search/search-vector.js';
import { FakeS3Storage, resetS3Storage, setS3Storage } from '../src/storage/s3.js';
import {
  TEST_DB_AVAILABLE,
  probeTestDb,
  withSeededTestDb,
} from './helpers/test-db';
import { readFixture } from './helpers/fixtures';

const reachable = await probeTestDb();

function withFakeS3(): FakeS3Storage {
  const fake = new FakeS3Storage('test-mail-bucket');
  resetS3Storage();
  setS3Storage(fake);
  return fake;
}

describe.skipIf(!TEST_DB_AVAILABLE || !reachable)(
  'mail ingest search_vector FTS',
  () => {
    it(
      'sets search_vector from thread subject and snippet on ingest',
      async () => {
        const storage = withFakeS3();
        const raw = readFixture('centurion-stamped.eml');

        const result = await withSeededTestDb(async (db) => {
          const messageId = generateMessageId();
          const parsed = await parseRawMessage(raw, { messageId, storage });
          const stored = await persistInboundMessage(
            parsed,
            raw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-search-vector-1',
              messageId,
            },
            { db, storage },
          );
          expect(stored.kind).toBe('stored');
          if (stored.kind !== 'stored') return null;

          const threadRows = await db
            .select()
            .from(mailThread)
            .where(eq(mailThread.id, stored.threadId));
          const thread = threadRows[0];
          if (!thread) return null;

          const [vectorRow] = await db.execute<{
            matches_backfill: boolean;
            finds_subject_term: boolean;
            finds_snippet_term: boolean;
          }>(sql`
            SELECT
              "search_vector" = to_tsvector(${THREAD_SEARCH_VECTOR_CONFIG}, coalesce("subject", '') || ' ' || coalesce("snippet", '')) AS matches_backfill,
              "search_vector" @@ plainto_tsquery(${THREAD_SEARCH_VECTOR_CONFIG}, 'centurion') AS finds_subject_term,
              "search_vector" @@ plainto_tsquery(${THREAD_SEARCH_VECTOR_CONFIG}, 'amenities') AS finds_snippet_term
            FROM "mail_thread"
            WHERE "id" = ${stored.threadId}
          `);

          return { thread, vectorRow };
        });

        expect(result).not.toBeNull();
        if (!result) return;

        expect(result.thread.subject).toBe('Centurion booking confirmation #4471');
        expect(result.thread.snippet).toContain('welcome amenities');
        expect(threadSearchVectorText(result.thread.subject, result.thread.snippet)).toContain(
          'Centurion booking confirmation #4471',
        );
        expect(result.vectorRow?.matches_backfill).toBe(true);
        expect(result.vectorRow?.finds_subject_term).toBe(true);
        expect(result.vectorRow?.finds_snippet_term).toBe(true);
      },
      30000,
    );

    it(
      'refreshes search_vector when reply updates snippet',
      async () => {
        const storage = withFakeS3();
        const parentRaw = readFixture('centurion-stamped.eml');
        const replyRaw = readFixture('reply-in-thread.eml');

        const result = await withSeededTestDb(async (db) => {
          const parentMessageId = generateMessageId();
          const parentParsed = await parseRawMessage(parentRaw, {
            messageId: parentMessageId,
            storage,
          });
          const parentStored = await persistInboundMessage(
            parentParsed,
            parentRaw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-search-vector-parent',
              messageId: parentMessageId,
            },
            { db, storage },
          );
          expect(parentStored.kind).toBe('stored');
          if (parentStored.kind !== 'stored') return null;

          const replyMessageId = generateMessageId();
          const replyParsed = await parseRawMessage(replyRaw, {
            messageId: replyMessageId,
            storage,
          });
          const replyStored = await persistInboundMessage(
            replyParsed,
            replyRaw,
            {
              ingestMailboxId: 'ingest-nava-legacy',
              pop3Uidl: 'uidl-search-vector-reply',
              messageId: replyMessageId,
            },
            { db, storage },
          );
          expect(replyStored.kind).toBe('stored');
          if (replyStored.kind !== 'stored') return null;

          const threadRows = await db
            .select()
            .from(mailThread)
            .where(eq(mailThread.id, parentStored.threadId));
          const thread = threadRows[0];
          if (!thread) return null;

          const [vectorRow] = await db.execute<{
            matches_backfill: boolean;
            finds_reply_snippet: boolean;
          }>(sql`
            SELECT
              "search_vector" = to_tsvector(${THREAD_SEARCH_VECTOR_CONFIG}, coalesce("subject", '') || ' ' || coalesce("snippet", '')) AS matches_backfill,
              "search_vector" @@ plainto_tsquery(${THREAD_SEARCH_VECTOR_CONFIG}, 'amenities') AS finds_reply_snippet
            FROM "mail_thread"
            WHERE "id" = ${parentStored.threadId}
          `);

          return { thread, vectorRow };
        });

        expect(result).not.toBeNull();
        if (!result) return;

        expect(result.thread.snippet).toContain('Welcome amenities');
        expect(result.vectorRow?.matches_backfill).toBe(true);
        expect(result.vectorRow?.finds_reply_snippet).toBe(true);
      },
      30000,
    );
  },
);
