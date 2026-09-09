import {
  createMailBaselineProjectionRows,
  persistMailBaselineProjection,
  queryMailBaselineProjection,
  reduceProjectedMailBaseline,
} from '../src/metrics/mail-baseline-projection.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { mailThread, message } from '../src/db/schema/mail.js';
import { __setDbForTests } from '../src/db/client.js';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

const reachable = await probeTestDb();

describe('mail baseline projection', () => {
  it('creates immutable versioned rows with compact semantic evidence only', () => {
    const rows = createMailBaselineProjectionRows({
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      generationId: 'generation-1',
      sourceVintage: 'v1',
      interpretationVersion: 'interpretation-1',
      observationCutoff: '2026-09-08T12:00:00.000Z',
      evidence: [
        {
          id: 'ask-1',
          requestId: 'request-1',
          askId: 'ask-1',
          threadId: 'thread-1',
          transportId: 'transport-centurion',
          eventType: 'ask',
          direction: 'inbound',
          eventAt: '2026-09-02T09:00:00.000Z',
          observedAt: '2026-09-02T09:01:00.000Z',
          source: 'mail_event',
          sourceBasis: 'source_event',
          requiresHotelResponse: true,
          requiresCustomerInformation: false,
          answerState: null,
          workState: 'open',
          substantive: false,
          linkStrength: 'thread',
          delivery: null,
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      generationId: 'generation-1',
      projectionVersion: expect.any(String),
      eventKind: 'ask',
      sourceBasis: 'source_event',
    });
    expect(JSON.stringify(rows[0])).not.toContain('textBody');
  });

  it('reduces rows deterministically at an observation cutoff', () => {
    const rows = createMailBaselineProjectionRows({
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      generationId: 'generation-2',
      sourceVintage: 'v1',
      interpretationVersion: 'interpretation-1',
      observationCutoff: '2026-09-08T12:00:00.000Z',
      evidence: [
        {
          id: 'ask-1',
          requestId: 'request-1',
          askId: 'ask-1',
          threadId: 'thread-1',
          transportId: 'transport-centurion',
          eventType: 'ask',
          direction: 'inbound',
          eventAt: '2026-09-02T09:00:00.000Z',
          observedAt: '2026-09-02T09:01:00.000Z',
          source: 'mail_event',
          sourceBasis: 'source_event',
          requiresHotelResponse: true,
          requiresCustomerInformation: false,
          answerState: null,
          workState: 'open',
          substantive: false,
          linkStrength: 'thread',
          delivery: null,
        },
      ],
    });
    const result = reduceProjectedMailBaseline(rows, {
      observationCutoff: '2026-09-08T12:00:00.000Z',
      sourceVintage: 'v1',
      interpretationVersion: 'interpretation-1',
    });
    expect(result.primaryBucket).toBe('awaiting_hotel_reply');
    expect(result.sourceVintage).toBe('v1');
  });
});

if (TEST_DB_AVAILABLE && reachable)
  describe('mail baseline projection (disposable DB)', () => {
    it('persists one semantic generation idempotently and serves bounded rows without body reads', async () => {
      if (!TEST_DB_AVAILABLE)
        throw new Error('disposable DB is required for this integration case');
      await withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        try {
          const migrationMetadata = await db.execute<{
            count: number;
            latestCreatedAt: string | number;
          }>(sql`
            SELECT count(*)::int AS count, max(created_at)::bigint AS "latestCreatedAt"
            FROM drizzle.__drizzle_migrations
          `);
          expect(migrationMetadata[0]?.count).toBe(26);
          expect(Number(migrationMetadata[0]?.latestCreatedAt)).toBe(1788950400000);

          const threadId = `u2-baseline-thread-${randomUUID()}`;
          const messageId = `u2-baseline-message-${randomUUID()}`;
          const now = new Date('2026-09-02T09:00:00.000Z');
          await db.insert(mailThread).values({
            id: threadId,
            transportId: 'transport-centurion',
            threadRootId: `<${threadId}@example.test>`,
            subject: 'U2 projection fixture',
            snippet: 'U2 projection fixture',
            createdAt: now,
            updatedAt: now,
            latestMessageAt: now,
          });
          await db.insert(message).values({
            id: messageId,
            transportId: 'transport-centurion',
            threadId,
            direction: 'inbound',
            fromAddress: 'u2@example.test',
            toAddresses: ['centurion@legacyhotels.co.za'],
            ccAddresses: [],
            bccAddresses: [],
            subject: 'U2 projection fixture',
            textBody: 'body must never be read by the dashboard query',
            messageIdHeader: `<${messageId}@example.test>`,
            receivedAt: now,
            createdAt: now,
            updatedAt: now,
          });
          const input = {
            transportId: 'transport-centurion' as const,
            threadId,
            generationId: `u2-generation-${randomUUID()}`,
            sourceVintage: 'v1',
            interpretationVersion: 'interpretation-1',
            observationCutoff: '2026-09-08T12:00:00.000Z',
            evidence: [
              {
                id: `u2-evidence-${randomUUID()}`,
                requestId: `u2-request-${randomUUID()}`,
                askId: `u2-ask-${randomUUID()}`,
                threadId,
                transportId: 'transport-centurion' as const,
                eventType: 'ask' as const,
                direction: 'inbound' as const,
                eventAt: now.toISOString(),
                observedAt: now.toISOString(),
                source: 'mail_event' as const,
                sourceBasis: 'source_event' as const,
                requiresHotelResponse: true,
                requiresCustomerInformation: false,
                answerState: null,
                workState: 'open' as const,
                substantive: false,
                linkStrength: 'thread' as const,
                delivery: null,
                sourceMessageId: messageId,
              },
            ],
          };
          const first = await persistMailBaselineProjection(db, input);
          const second = await persistMailBaselineProjection(db, input);
          expect(first.inserted).toBe(1);
          expect(second.inserted).toBe(0);
          const rows = await queryMailBaselineProjection(db, {
            transportIds: ['transport-centurion'],
            threadIds: [threadId],
            observationCutoff: '2026-09-08T12:00:00.000Z',
            limit: 20,
          });
          expect(rows).toHaveLength(1);
          expect(rows[0]?.sourceMessageId).toBe(messageId);
          expect(rows[0]).not.toHaveProperty('textBody');
        } finally {
          __setDbForTests(null);
        }
      });
    }, 30000);
  });
