import {
  createMailBaselineProjectionRows,
  persistMailBaselineProjection,
  queryMailBaselineProjection,
  reduceProjectedMailBaseline,
} from '../src/metrics/mail-baseline-projection.js';
import { TEST_DB_AVAILABLE, probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import type { MailBaselineEvidence } from '../src/metrics/mail-baseline.js';
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

  it('selects one immutable generation as-of without mixing retained lineage', () => {
    const makeEvidence = (overrides: Partial<MailBaselineEvidence>): MailBaselineEvidence => ({
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
      workState: 'open',
      answerState: null,
      substantive: false,
      linkStrength: 'header',
      delivery: null,
      ...overrides,
    });
    const older = createMailBaselineProjectionRows({
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      generationId: 'generation-old',
      sourceVintage: 'v1',
      interpretationVersion: 'interpretation-1',
      observationCutoff: '2026-09-04T12:00:00.000Z',
      evidence: [
        makeEvidence({ id: 'ask-old', factKey: 'ask-fact', unknownReason: 'legacy_unknown' }),
        makeEvidence({
          id: 'answer-old',
          factKey: 'answer-fact',
          eventType: 'answer',
          direction: 'outbound',
          eventAt: '2026-09-02T11:00:00.000Z',
          answerState: 'unknown',
          workState: 'unknown',
          substantive: false,
          delivery: { status: 'unknown' },
        }),
      ],
    });
    const selected = createMailBaselineProjectionRows({
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      generationId: 'generation-selected',
      sourceVintage: 'v2',
      interpretationVersion: 'interpretation-1',
      observationCutoff: '2026-09-06T12:00:00.000Z',
      evidence: [
        makeEvidence({ id: 'ask-selected', factKey: 'ask-fact' }),
        makeEvidence({
          id: 'answer-selected',
          factKey: 'answer-fact',
          eventType: 'answer',
          direction: 'outbound',
          eventAt: '2026-09-02T11:00:00.000Z',
          answerState: 'supported',
          workState: 'complete',
          substantive: true,
          delivery: { status: 'accepted', acceptedAt: '2026-09-02T11:00:01.000Z' },
        }),
      ],
    });
    const future = createMailBaselineProjectionRows({
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      generationId: 'generation-future',
      sourceVintage: 'v2',
      interpretationVersion: 'interpretation-1',
      observationCutoff: '2026-09-09T12:00:00.000Z',
      evidence: [
        makeEvidence({ id: 'future-ask', factKey: 'ask-fact', requiresHotelResponse: true }),
      ],
    });

    const result = reduceProjectedMailBaseline([...older, ...selected, ...future], {
      observationCutoff: '2026-09-08T12:00:00.000Z',
      sourceVintage: 'v2',
      interpretationVersion: 'interpretation-1',
    });

    expect(result.primaryBucket).toBe('answered');
    expect(result.sourceVintage).toBe('v2');
    expect(result.asks[0]).toMatchObject({ askId: 'ask-1', replyState: 'answered' });
  });

  it('uses the latest eligible observation cutoff when source vintage ties', () => {
    const makeEvidence = (overrides: Partial<MailBaselineEvidence>): MailBaselineEvidence => ({
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
      workState: 'open',
      answerState: null,
      substantive: false,
      linkStrength: 'header',
      delivery: null,
      ...overrides,
    });
    const older = createMailBaselineProjectionRows({
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      generationId: 'generation-tied-old',
      sourceVintage: 'v2',
      interpretationVersion: 'interpretation-1',
      observationCutoff: '2026-09-05T12:00:00.000Z',
      evidence: [makeEvidence({ factKey: 'ask-fact' })],
    });
    const newer = createMailBaselineProjectionRows({
      transportId: 'transport-centurion',
      threadId: 'thread-1',
      generationId: 'generation-tied-new',
      sourceVintage: 'v2',
      interpretationVersion: 'interpretation-1',
      observationCutoff: '2026-09-06T12:00:00.000Z',
      evidence: [
        makeEvidence({
          factKey: 'ask-fact',
          requiresHotelResponse: false,
          workState: 'unknown',
          unknownReason: 'newer_unknown',
        }),
      ],
    });

    const result = reduceProjectedMailBaseline([...older, ...newer], {
      observationCutoff: '2026-09-08T12:00:00.000Z',
      sourceVintage: 'v2',
      interpretationVersion: 'interpretation-1',
    });

    expect(result.primaryBucket).toBe('unknown');
    expect(result.asks[0]?.unknownReasons).toContain('newer_unknown');
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

    it('keeps independent source messages in one thread when selecting retained generations', async () => {
      if (!TEST_DB_AVAILABLE)
        throw new Error('disposable DB is required for this integration case');
      await withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        try {
          const threadId = `u2-lineage-thread-${randomUUID()}`;
          const firstMessageId = `u2-lineage-message-a-${randomUUID()}`;
          const secondMessageId = `u2-lineage-message-b-${randomUUID()}`;
          const firstAt = new Date('2026-09-02T09:00:00.000Z');
          const secondAt = new Date('2026-09-03T09:00:00.000Z');
          await db.insert(mailThread).values({
            id: threadId,
            transportId: 'transport-centurion',
            threadRootId: `<${threadId}@example.test>`,
            subject: 'Independent asks in one thread',
            snippet: 'Independent asks in one thread',
            createdAt: firstAt,
            updatedAt: secondAt,
            latestMessageAt: secondAt,
          });
          await db.insert(message).values([
            {
              id: firstMessageId,
              transportId: 'transport-centurion',
              threadId,
              direction: 'inbound',
              fromAddress: 'guest-a@example.test',
              toAddresses: ['hotel@example.test'],
              ccAddresses: [],
              bccAddresses: [],
              subject: 'First request',
              textBody: 'body a',
              messageIdHeader: `<${firstMessageId}@example.test>`,
              receivedAt: firstAt,
              createdAt: firstAt,
              updatedAt: firstAt,
            },
            {
              id: secondMessageId,
              transportId: 'transport-centurion',
              threadId,
              direction: 'inbound',
              fromAddress: 'guest-b@example.test',
              toAddresses: ['hotel@example.test'],
              ccAddresses: [],
              bccAddresses: [],
              subject: 'Second request',
              textBody: 'body b',
              messageIdHeader: `<${secondMessageId}@example.test>`,
              receivedAt: secondAt,
              createdAt: secondAt,
              updatedAt: secondAt,
            },
          ]);
          const evidence = (input: {
            id: string;
            askId: string;
            sourceMessageId: string;
            eventAt: Date;
            requiresHotelResponse?: boolean;
            requiresCustomerInformation?: boolean;
          }) => ({
            id: input.id,
            requestId: `${input.askId}:request`,
            askId: input.askId,
            threadId,
            transportId: 'transport-centurion' as const,
            eventType: 'ask' as const,
            direction: 'inbound' as const,
            eventAt: input.eventAt,
            observedAt: input.eventAt,
            source: 'mail_event' as const,
            sourceBasis: 'source_event' as const,
            sourceMessageId: input.sourceMessageId,
            requiresHotelResponse: input.requiresHotelResponse ?? false,
            requiresCustomerInformation: input.requiresCustomerInformation ?? false,
            workState: 'open' as const,
            answerState: null,
            substantive: false,
            linkStrength: 'header' as const,
            delivery: null,
          });
          await persistMailBaselineProjection(db, {
            transportId: 'transport-centurion',
            threadId,
            generationId: 'lineage-generation-a',
            sourceVintage: '2026-09-02T09:05:00.000Z',
            interpretationVersion: 'mail-baseline-interpretation-v1',
            observationCutoff: '2026-09-02T09:06:00.000Z',
            evidence: [
              evidence({
                id: 'lineage-evidence-a',
                askId: 'lineage-ask-a',
                sourceMessageId: firstMessageId,
                eventAt: firstAt,
                requiresHotelResponse: true,
              }),
            ],
          });
          await persistMailBaselineProjection(db, {
            transportId: 'transport-centurion',
            threadId,
            generationId: 'lineage-generation-b',
            sourceVintage: '2026-09-03T09:05:00.000Z',
            interpretationVersion: 'mail-baseline-interpretation-v1',
            observationCutoff: '2026-09-03T09:06:00.000Z',
            evidence: [
              evidence({
                id: 'lineage-evidence-b',
                askId: 'lineage-ask-b',
                sourceMessageId: secondMessageId,
                eventAt: secondAt,
                requiresCustomerInformation: true,
              }),
            ],
          });
          const rows = await queryMailBaselineProjection(db, {
            transportIds: ['transport-centurion'],
            threadIds: [threadId],
            observationCutoff: '2026-09-08T12:00:00.000Z',
            limit: 20,
          });
          expect(rows).toHaveLength(2);
          const reduced = reduceProjectedMailBaseline(rows, {
            transportId: 'transport-centurion',
            threadId,
            observationCutoff: '2026-09-08T12:00:00.000Z',
            sourceVintage: '2026-09-03T09:05:00.000Z',
            interpretationVersion: 'mail-baseline-interpretation-v1',
          });
          expect(reduced.asks).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ askId: 'lineage-ask-a', replyState: 'awaiting_hotel' }),
              expect.objectContaining({
                askId: 'lineage-ask-b',
                replyState: 'awaiting_customer',
              }),
            ]),
          );
        } finally {
          __setDbForTests(null);
        }
      });
    }, 30000);
  });
