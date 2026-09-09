import {
  parseExecutiveDashboardQuery,
  resolveExecutiveDashboardQuery,
  loadAdminDashboardMetrics,
} from '../src/trpc/routes/admin-dashboard.js';
import {
  assertAdminDashboardGrant,
  resolveAdminDashboardGrant,
  type AdminDashboardGrant,
} from '../src/metrics/admin-dashboard-access.js';
import { aiShadowAssessment, aiShadowPrediction } from '../src/db/schema/ai-shadow-evaluation.js';
import { persistMailBaselineProjection } from '../src/metrics/mail-baseline-projection.js';
import { mailThread, mailThreadCategory, message } from '../src/db/schema/mail.js';
import type { MailBaselineEvidence } from '../src/metrics/mail-baseline.js';
import { TEST_DB_AVAILABLE, withSeededTestDb } from './helpers/test-db.js';
import { __setDbForTests } from '../src/db/client.js';
import { appRouter } from '../src/trpc/router.js';
import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';

const CUTOFF = '2026-08-08T00:00:00.000Z';

describe('executive dashboard query and grants', () => {
  it('authorizes the cohort and operation independently before any data load', () => {
    const client = resolveAdminDashboardGrant('ropperman@legacyhotels.co.za', 'centurion');
    expect(client).toMatchObject({
      cohortId: 'centurion',
      aggregate: true,
      drilldown: true,
      export: true,
    });
    expect(() => assertAdminDashboardGrant(client, 'aggregate')).not.toThrow();
    expect(() => assertAdminDashboardGrant(client, 'drilldown')).not.toThrow();
    expect(() => assertAdminDashboardGrant(client, 'export')).not.toThrow();

    for (const email of [
      'navaai@legacyhotels.co.za',
      'ropperman@legacyhotels.co.za',
      'dbezuidenhout@legacyhotels.co.za',
    ]) {
      const researchGrant = resolveAdminDashboardGrant(email, 'research');
      expect(researchGrant).toMatchObject({
        cohortId: 'research',
        aggregate: true,
        drilldown: true,
        export: true,
      });
    }

    expect(() => resolveAdminDashboardGrant('not-allowed@example.com', 'centurion')).toThrowError(
      TRPCError,
    );
  });

  it('rejects an unauthorized dashboard caller before resolving the database', async () => {
    const caller = appRouter.createCaller({
      auth: null as never,
      reqHeaders: new Headers(),
      sessionUser: { id: 'u10a-unauthorized', email: 'not-allowed@example.com', name: null },
    });
    await expect(caller.adminDashboard.getMetrics({ operation: 'export' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'ADMIN_DASHBOARD_FORBIDDEN',
    });
  });

  it('rejects a future or inverted cutoff instead of widening the evidence window', () => {
    expect(() =>
      parseExecutiveDashboardQuery(
        {
          cohortId: 'centurion',
          window: '7d',
          observationCutoff: '2026-08-09T00:00:00.000Z',
        },
        new Date(CUTOFF),
      ),
    ).toThrow(/cutoff/i);

    expect(() =>
      parseExecutiveDashboardQuery({
        cohortId: 'centurion',
        windowStart: '2026-08-09T00:00:00.000Z',
        windowEnd: '2026-08-08T00:00:00.000Z',
        observationCutoff: CUTOFF,
      }),
    ).toThrow(/window/i);

    expect(() =>
      parseExecutiveDashboardQuery(
        {
          cohortId: 'centurion',
          window: '7d',
          windowStart: '2026-08-01T00:00:00.000Z',
          windowEnd: '2026-09-06T00:00:00.000Z',
          observationCutoff: '2026-09-07T00:00:00.000Z',
        },
        new Date('2026-09-07T00:00:00.000Z'),
      ),
    ).toThrow(/window/i);
  });

  it('allows configured pilot users to use all configured dashboard operations', async () => {
    expect(() =>
      assertAdminDashboardGrant(
        resolveAdminDashboardGrant('ropperman@legacyhotels.co.za'),
        'drilldown',
      ),
    ).not.toThrow();
    expect(() =>
      assertAdminDashboardGrant(
        resolveAdminDashboardGrant('ropperman@legacyhotels.co.za'),
        'export',
      ),
    ).not.toThrow();
  });

  it('resolves a bounded default Centurion query with an explicit cutoff and source vintage', () => {
    const query = resolveExecutiveDashboardQuery(
      { cohortId: 'centurion', window: '7d', observationCutoff: CUTOFF },
      new Date(CUTOFF),
    );
    expect(query).toMatchObject({
      cohortId: 'centurion',
      windowStart: '2026-08-01T00:00:00.000Z',
      windowEnd: CUTOFF,
      observationCutoff: CUTOFF,
      sourceVintage: CUTOFF,
    });
  });
});

// The disposable-DB gate supplies this profile explicitly. Keep DB assertions out
// of the pure unit child when that prerequisite is absent; the DB child is required
// and fails closed before Vitest if the profile is missing.
if (process.env.CONFIRM_DISPOSABLE_TEST_DB === '1' && process.env.TEST_DATABASE_URL) {
  describe('executive dashboard bounded query (disposable DB)', () => {
    const coverageEvidence = (threadId: string): MailBaselineEvidence[] => [
      {
        id: `u2-second-coverage-ask-${threadId}`,
        requestId: `u2-second-coverage-request-${threadId}`,
        askId: `u2-second-coverage-ask-${threadId}`,
        threadId,
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
        linkStrength: 'header',
        delivery: null,
      },
      {
        id: `u2-second-coverage-answer-${threadId}`,
        requestId: `u2-second-coverage-request-${threadId}`,
        askId: `u2-second-coverage-ask-${threadId}`,
        threadId,
        transportId: 'transport-centurion',
        eventType: 'answer',
        direction: 'outbound',
        eventAt: '2026-09-02T09:30:00.000Z',
        observedAt: '2026-09-02T09:31:00.000Z',
        source: 'external_sent',
        sourceBasis: 'source_event',
        requiresHotelResponse: false,
        requiresCustomerInformation: false,
        answerState: 'supported',
        workState: 'complete',
        substantive: true,
        linkStrength: 'header',
        delivery: { status: 'sent' },
      },
    ];

    it('uses persisted producer coverage through the authorized GET and export route', async () => {
      const priorMeasurementConfig = process.env.MAIL_MEASUREMENT_CONFIG_JSON;
      process.env.MAIL_MEASUREMENT_CONFIG_JSON = JSON.stringify({
        version: 1,
        transportId: 'transport-centurion',
        cohortId: 'centurion',
        measurementStartAt: '2026-09-05T00:00:00.000Z',
        captureAssumptionBasis: 'mutable-current-config',
        confirmedGapIntervals: [
          { startAt: '2026-09-02T09:15:00.000Z', endAt: '2026-09-02T09:45:00.000Z' },
        ],
      });
      try {
        const query = resolveExecutiveDashboardQuery(
          {
            cohortId: 'centurion',
            windowStart: '2026-09-01T00:00:00.000Z',
            windowEnd: '2026-09-08T00:00:00.000Z',
            observationCutoff: '2026-09-08T12:00:00.000Z',
          },
          new Date('2026-09-08T12:00:00.000Z'),
        );
        const result = await withSeededTestDb(async (db) => {
          __setDbForTests({ db, conn: null as never });
          try {
            const threadId = 'u2-second-dashboard-coverage-thread';
            const threadAt = new Date('2026-09-02T09:00:00.000Z');
            await db.insert(mailThread).values({
              id: threadId,
              transportId: 'transport-centurion',
              threadRootId: `${threadId}-root`,
              subject: 'u2 second coverage fixture',
              snippet: 'u2 second coverage fixture',
              createdAt: threadAt,
              updatedAt: threadAt,
              latestMessageAt: threadAt,
            });
            await persistMailBaselineProjection(db, {
              transportId: 'transport-centurion',
              threadId,
              generationId: 'u2-second-dashboard-coverage-generation',
              sourceVintage: 'u2-second-dashboard-coverage-v1',
              interpretationVersion: 'mail-baseline-interpretation-v1',
              observationCutoff: query.observationCutoff,
              measurementStartAt: '2026-09-01T00:00:00.000Z',
              coverage: {
                configVersion: 'v1',
                startAt: '2026-09-01T00:00:00.000Z',
                endAt: query.observationCutoff,
                basis: 'configured-v1',
                complete: true,
                confirmedGapIntervals: [],
              },
              evidence: coverageEvidence(threadId),
            });
            const loaded = await loadAdminDashboardMetrics(query);
            const caller = appRouter.createCaller({
              auth: null as never,
              reqHeaders: new Headers(),
              sessionUser: {
                id: 'u2-second-authorized-export',
                email: 'ropperman@legacyhotels.co.za',
                name: null,
              },
            });
            const exported = await caller.adminDashboard.getMetrics({
              ...query,
              operation: 'export',
            });
            return { loaded, exported };
          } finally {
            __setDbForTests(null);
          }
        });

        expect(result.loaded.service.firstUsefulReply).toMatchObject({
          availability: 'available',
          value: 30,
          denominator: 1,
          measurementConfigVersion: 'v1',
          captureBasis: 'configured-v1',
        });
        expect(result.exported).toMatchObject({
          schemaVersion: 'admin-dashboard-export-v1',
          metrics: {
            service: {
              firstUsefulReply: expect.objectContaining({
                availability: 'available',
                value: 30,
                measurementConfigVersion: 'v1',
                captureBasis: 'configured-v1',
              }),
            },
          },
          provenance: {
            measurementConfigVersions: expect.arrayContaining(['v1']),
            captureBases: expect.arrayContaining(['configured-v1']),
          },
        });
      } finally {
        if (priorMeasurementConfig === undefined) delete process.env.MAIL_MEASUREMENT_CONFIG_JSON;
        else process.env.MAIL_MEASUREMENT_CONFIG_JSON = priorMeasurementConfig;
      }
    });

    it('keeps missing producer T0 unavailable through the authorized GET/export route', async () => {
      const priorMeasurementConfig = process.env.MAIL_MEASUREMENT_CONFIG_JSON;
      process.env.MAIL_MEASUREMENT_CONFIG_JSON = JSON.stringify({
        version: 1,
        transportId: 'transport-centurion',
        cohortId: 'centurion',
        measurementStartAt: '2026-09-05T00:00:00.000Z',
        captureAssumptionBasis: 'later-current-config',
        confirmedGapIntervals: [],
      });
      try {
        const query = resolveExecutiveDashboardQuery(
          {
            cohortId: 'centurion',
            windowStart: '2026-09-01T00:00:00.000Z',
            windowEnd: '2026-09-08T00:00:00.000Z',
            observationCutoff: '2026-09-08T12:00:00.000Z',
          },
          new Date('2026-09-08T12:00:00.000Z'),
        );
        const result = await withSeededTestDb(async (db) => {
          __setDbForTests({ db, conn: null as never });
          try {
            const threadId = 'u2-second-dashboard-missing-t0-thread';
            const threadAt = new Date('2026-09-02T09:00:00.000Z');
            await db.insert(mailThread).values({
              id: threadId,
              transportId: 'transport-centurion',
              threadRootId: `${threadId}-root`,
              subject: 'u2 second missing T0 fixture',
              snippet: 'u2 second missing T0 fixture',
              createdAt: threadAt,
              updatedAt: threadAt,
              latestMessageAt: threadAt,
            });
            await persistMailBaselineProjection(db, {
              transportId: 'transport-centurion',
              threadId,
              generationId: 'u2-second-dashboard-missing-t0-generation',
              sourceVintage: 'u2-second-dashboard-missing-t0-v1',
              interpretationVersion: 'mail-baseline-interpretation-v1',
              observationCutoff: query.observationCutoff,
              measurementStartAt: null,
              coverage: {
                configVersion: null,
                startAt: null,
                endAt: query.observationCutoff,
                basis: 'coverage_unconfigured',
                complete: false,
                confirmedGapIntervals: [],
              },
              evidence: coverageEvidence(threadId),
            });
            const loaded = await loadAdminDashboardMetrics(query);
            const caller = appRouter.createCaller({
              auth: null as never,
              reqHeaders: new Headers(),
              sessionUser: {
                id: 'u2-second-authorized-missing-t0',
                email: 'ropperman@legacyhotels.co.za',
                name: null,
              },
            });
            const exported = await caller.adminDashboard.getMetrics({
              ...query,
              operation: 'export',
            });
            return { loaded, exported };
          } finally {
            __setDbForTests(null);
          }
        });

        expect(result.loaded.service.firstUsefulReply).toMatchObject({
          availability: 'unavailable',
          value: null,
          availabilityReason: 'coverage_unavailable',
          measurementConfigVersion: null,
          captureBasis: 'coverage_unconfigured',
        });
        expect(result.exported).toMatchObject({
          metrics: {
            service: {
              firstUsefulReply: expect.objectContaining({
                availability: 'unavailable',
                value: null,
                availabilityReason: 'coverage_unavailable',
              }),
            },
          },
        });
      } finally {
        if (priorMeasurementConfig === undefined) delete process.env.MAIL_MEASUREMENT_CONFIG_JSON;
        else process.env.MAIL_MEASUREMENT_CONFIG_JSON = priorMeasurementConfig;
      }
    });

    it('loads only selected-cohort rows with event clocks bounded by window and cutoff', async () => {
      if (!TEST_DB_AVAILABLE) {
        throw new Error('disposable dashboard DB profile was not made available');
      }

      const query = resolveExecutiveDashboardQuery(
        {
          cohortId: 'centurion',
          windowStart: '2026-08-01T00:00:00.000Z',
          windowEnd: '2026-08-06T00:00:00.000Z',
          observationCutoff: CUTOFF,
        },
        new Date(CUTOFF),
      );

      const result = await withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        try {
          const threadId = 'u10a-dashboard-query-thread';
          const now = new Date('2026-08-01T00:00:00.000Z');
          await db.insert(mailThread).values({
            id: threadId,
            transportId: 'transport-centurion',
            threadRootId: 'u10a-dashboard-query-root',
            subject: 'dashboard query fixture',
            snippet: 'synthetic query fixture',
            createdAt: now,
            updatedAt: now,
            latestMessageAt: new Date('2026-08-07T12:00:00.000Z'),
          });
          await db.insert(message).values([
            {
              id: 'u10a-dashboard-query-inbound',
              transportId: 'transport-centurion',
              threadId,
              direction: 'inbound',
              messageIdHeader: '<u10a-dashboard-inbound@example.com>',
              fromAddress: 'guest@example.com',
              toAddresses: ['centurion@legacyhotels.co.za'],
              ccAddresses: [],
              bccAddresses: [],
              receivedAt: new Date('2026-08-02T08:00:00.000Z'),
              createdAt: new Date('2026-08-02T08:01:00.000Z'),
            },
            {
              id: 'u10a-dashboard-query-prior',
              transportId: 'transport-centurion',
              threadId,
              direction: 'inbound',
              messageIdHeader: '<u10a-dashboard-prior@example.com>',
              fromAddress: 'prior-guest@example.com',
              toAddresses: ['centurion@legacyhotels.co.za'],
              ccAddresses: [],
              bccAddresses: [],
              receivedAt: new Date('2026-07-30T08:00:00.000Z'),
              createdAt: new Date('2026-07-30T08:01:00.000Z'),
            },
            {
              id: 'u10a-dashboard-query-outbound',
              transportId: 'transport-centurion',
              threadId,
              direction: 'outbound',
              messageIdHeader: '<u10a-dashboard-outbound@example.com>',
              fromAddress: 'centurion@legacyhotels.co.za',
              toAddresses: ['guest@example.com'],
              ccAddresses: [],
              bccAddresses: [],
              sentAt: new Date('2026-08-03T09:00:00.000Z'),
              createdAt: new Date('2026-08-03T09:01:00.000Z'),
            },
            {
              id: 'u10a-dashboard-query-late-outbound',
              transportId: 'transport-centurion',
              threadId,
              direction: 'outbound',
              messageIdHeader: '<u10a-dashboard-late-outbound@example.com>',
              fromAddress: 'centurion@legacyhotels.co.za',
              toAddresses: ['guest@example.com'],
              ccAddresses: [],
              bccAddresses: [],
              sentAt: new Date('2026-08-07T12:00:00.000Z'),
              createdAt: new Date('2026-08-07T12:01:00.000Z'),
            },
            {
              id: 'u10a-dashboard-query-future',
              transportId: 'transport-centurion',
              threadId,
              direction: 'inbound',
              messageIdHeader: '<u10a-dashboard-future@example.com>',
              fromAddress: 'future@example.com',
              toAddresses: ['centurion@legacyhotels.co.za'],
              ccAddresses: [],
              bccAddresses: [],
              receivedAt: new Date('2026-08-09T08:00:00.000Z'),
              createdAt: new Date('2026-08-05T08:01:00.000Z'),
            },
          ]);
          return loadAdminDashboardMetrics(query);
        } finally {
          __setDbForTests(null);
        }
      });

      expect(result.query).toMatchObject({
        cohortId: 'centurion',
        windowStart: '2026-08-01T00:00:00.000Z',
        windowEnd: '2026-08-06T00:00:00.000Z',
        observationCutoff: CUTOFF,
      });
      expect(result.traffic.inbound.value).toBe(1);
      expect(result.traffic.outbound.value).toBe(1);
      expect(result.dataHealth?.directionCounts).toMatchObject({ inbound: 1, outbound: 2 });
      expect(result.dataHealth?.unscorable.invalidClock).toBe(1);
      expect(result.traffic.comparableWindowChangePercent).toMatchObject({
        availability: 'available',
        value: 0,
      });
      // A bounded row with a future source clock is retained for explicit
      // unknown/diagnostic coverage, but it must not enter traffic totals.
      expect(result.traffic.inbound.exclusions).toMatchObject({ future_or_cutoff: 1 });
      expect(result.transports.map((transport) => transport.id)).toEqual(['transport-centurion']);
    });

    it('authorizes and returns a bounded export through the real router', async () => {
      const grant: AdminDashboardGrant = resolveAdminDashboardGrant(
        'ropperman@legacyhotels.co.za',
        'centurion',
      );
      expect(grant.aggregate).toBe(true);
      expect(grant.drilldown).toBe(true);
      expect(grant.export).toBe(true);

      const caller = appRouter.createCaller({
        auth: null as never,
        reqHeaders: new Headers(),
        sessionUser: {
          id: 'u10a-export-authorized',
          email: 'ropperman@legacyhotels.co.za',
          name: null,
        },
      });
      const result = await caller.adminDashboard.getMetrics({
        cohortId: 'centurion',
        windowStart: '2026-08-01T00:00:00.000Z',
        windowEnd: CUTOFF,
        observationCutoff: CUTOFF,
        operation: 'export',
      });
      expect(result).toMatchObject({
        schemaVersion: 'admin-dashboard-export-v1',
        query: { cohortId: 'centurion', observationCutoff: CUTOFF },
      });
      expect(Object.keys((result as { buckets: Record<string, unknown> }).buckets)).toEqual([
        'awaiting_hotel_reply',
        'awaiting_customer_information',
        'hotel_action_pending',
        'unknown',
        'answered',
        'no_reply_required',
      ]);
      expect(JSON.stringify(result)).not.toContain('textBody');
    });

    it('projects the current retained folder snapshot for a current-cutoff query', async () => {
      if (!TEST_DB_AVAILABLE) {
        throw new Error('disposable dashboard DB profile was not made available');
      }

      const result = await withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        try {
          const now = Date.now();
          const threadId = 'u10a-current-classification-thread';
          const eventAt = new Date(now - 60 * 60 * 1000);
          await db.insert(mailThread).values({
            id: threadId,
            transportId: 'transport-centurion',
            threadRootId: 'u10a-current-classification-root',
            subject: 'current classification fixture',
            createdAt: eventAt,
            updatedAt: eventAt,
            latestMessageAt: eventAt,
          });
          await db.insert(mailThreadCategory).values({
            threadId,
            categoryId: 'category-transport-centurion-bookings',
            transportId: 'transport-centurion',
          });
          await db.insert(message).values({
            id: 'u10a-current-classification-message',
            transportId: 'transport-centurion',
            threadId,
            direction: 'inbound',
            messageIdHeader: '<u10a-current-classification@example.com>',
            fromAddress: 'current-guest@example.com',
            toAddresses: ['centurion@legacyhotels.co.za'],
            ccAddresses: [],
            bccAddresses: [],
            receivedAt: eventAt,
            createdAt: eventAt,
          });
          await db.insert(message).values({
            id: 'u10a-current-classification-unknown-history',
            transportId: 'transport-centurion',
            threadId,
            direction: 'inbound',
            messageIdHeader: '<u10a-current-classification-unknown@example.com>',
            fromAddress: 'unknown-history@example.com',
            toAddresses: ['centurion@legacyhotels.co.za'],
            ccAddresses: [],
            bccAddresses: [],
            createdAt: new Date(now - 8 * 24 * 60 * 60 * 1000),
          });
          return loadAdminDashboardMetrics(
            resolveExecutiveDashboardQuery({ cohortId: 'centurion', window: '7d' }),
          );
        } finally {
          __setDbForTests(null);
        }
      });

      expect(result.activity.activeConversations.value).toBe(1);
      expect(result.activity.newlyObservedConversations).toMatchObject({
        availability: 'unavailable',
        value: null,
        availabilityReason: 'pre_window_history_unknown',
      });
      expect(result.activity.continuingConversations).toMatchObject({
        availability: 'unavailable',
        value: null,
        availabilityReason: 'pre_window_history_unknown',
      });
      expect(result.folders.mix.availability).toBe('available');
      expect(result.folders.mix.classificationAsOf).toBe(result.query.observationCutoff);
      expect(result.folders.mix.value).toEqual(
        expect.arrayContaining([expect.objectContaining({ folder: 'bookings', count: 1 })]),
      );
    });

    it('serves the private shadow scorecard as a real aggregate consumer', async () => {
      const query = resolveExecutiveDashboardQuery(
        {
          cohortId: 'centurion',
          windowStart: '2026-09-01T00:00:00.000Z',
          windowEnd: '2026-09-08T00:00:00.000Z',
          observationCutoff: '2026-09-08T12:00:00.000Z',
        },
        new Date('2026-09-08T12:00:00.000Z'),
      );
      const result = await withSeededTestDb(async (db) => {
        __setDbForTests({ db, conn: null as never });
        try {
          const threadId = 'u13-dashboard-scorecard-thread';
          const messageId = 'u13-dashboard-scorecard-message';
          const predictionId = 'u13-dashboard-scorecard-prediction';
          const predictionKey = `shadow-prediction:${predictionId}`;
          const eventAt = new Date('2026-09-02T09:00:00.000Z');
          await db.insert(mailThread).values({
            id: threadId,
            transportId: 'transport-centurion',
            threadRootId: `${threadId}-root`,
            subject: 'U13 scorecard fixture',
            snippet: 'U13 scorecard fixture',
            createdAt: eventAt,
            updatedAt: eventAt,
            latestMessageAt: eventAt,
          });
          await db.insert(message).values({
            id: messageId,
            transportId: 'transport-centurion',
            threadId,
            direction: 'inbound',
            messageIdHeader: `<${messageId}@example.test>`,
            fromAddress: 'scorecard-guest@example.test',
            toAddresses: ['centurion@legacyhotels.co.za'],
            ccAddresses: [],
            bccAddresses: [],
            receivedAt: eventAt,
            createdAt: eventAt,
            updatedAt: eventAt,
          });
          await db.insert(aiShadowPrediction).values({
            id: predictionId,
            predictionKey,
            evaluationMode: 'future_shadow',
            evaluationVersion: 'shadow-evaluation-v1',
            admissionStatus: 'admitted',
            predictionStatus: 'sealed',
            transportId: 'transport-centurion',
            threadId,
            triggerMessageId: messageId,
            asOfAt: eventAt,
            sealedAt: eventAt,
            observationEndsAt: new Date('2026-09-09T09:00:00.000Z'),
            sourceVintage: eventAt.toISOString(),
            inputDigest: 'a'.repeat(64),
            messageIds: [messageId],
            attachmentIds: [],
            excludedFutureMessageIds: [],
            modelId: 'u13-dashboard-model',
            promptVersion: 'shadow-mail/v1',
            route: {
              routeId: 'u13-dashboard-route',
              purpose: 'shadow',
              protocol: 'in_process',
              modelId: 'u13-dashboard-model',
            },
            modelUsage: { inputTokens: 2, outputTokens: 1, latencyMs: 1 },
            prediction: { outcome: 'partial' },
          });
          await db.insert(aiShadowAssessment).values({
            id: 'u13-dashboard-scorecard-assessment',
            predictionId,
            revision: 1,
            revisionKey: `${predictionKey}:matched`,
            evaluationMode: 'future_shadow',
            status: 'matched',
            referenceMessageId: null,
            linkStrength: 'unknown',
            reason: 'approved reference fixture',
            labelProvenance: {
              source: 'approved_reference',
              labelId: 'u13-approved-label',
              unique: true,
              bound: true,
            },
            verdict: 'correct',
            assessment: {},
          });
          return loadAdminDashboardMetrics(query);
        } finally {
          __setDbForTests(null);
        }
      });

      expect(result.shadowScorecard).toMatchObject({
        evaluationMode: 'future_shadow',
        counts: expect.objectContaining({
          admitted: 1,
          sealed: 1,
          matched: 1,
          labelled: 1,
          scorable: 1,
          correct: 1,
        }),
        quality: expect.objectContaining({
          availability: 'available',
          denominator: 1,
          correctRate: 1,
          usefulRate: 1,
        }),
      });
    });
  });
}
