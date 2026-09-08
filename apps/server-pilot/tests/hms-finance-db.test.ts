import {
  __setCachedActiveReadRuntimeForTests,
  clearCachedActiveReadRuntimeForTests,
  type ActiveReadRuntimeState,
} from '../src/hms/active-read-runtime.js';
import { aiWorkflowRun, mailboxAccess, mailThread, message } from '../src/db/schema/mail.js';
import { CENTURION_USER_ID, MARTHA_USER_ID, TRANSPORT_ID } from '../src/db/seed.js';
import { executeAiRun, type CandidateSessionFactory } from '../src/ai/worker.js';
import { mergeFolioEvidence } from '../src/hms/live-folio-read-driver.js';
import { probeTestDb, withSeededTestDb } from './helpers/test-db.js';
import { resolveMailboxContext } from '../src/trpc/context.js';
import { __setDbForTests, type DB } from '../src/db/client.js';
import { claimNextAiRun } from '../src/ai/run-ledger.js';
import { afterEach, describe, expect, it } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

const reachable = await probeTestDb();
const OBSERVED_AT = new Date('2026-09-07T12:00:00.000Z');

function installFindRelease(): void {
  __setCachedActiveReadRuntimeForTests({
    releases: new Map([
      [
        'hms_find_reservation',
        {
          releaseId: 'u17-db-find-release',
          toolId: 'hms_find_reservation',
          evidenceKind: 'hms',
          requestBranches: [{ id: 'guest_stay_search' }],
        },
      ],
      [
        'hms_read_folio',
        {
          releaseId: 'u17-db-folio-release',
          toolId: 'hms_read_folio',
          evidenceKind: 'hms',
          requestBranches: [
            { id: 'folio_summary', discoveryOperationId: 'folio_summary' },
            {
              id: 'deposit_ledger_summary',
              discoveryOperationId: 'deposit_ledger_summary',
            },
          ],
        },
      ],
    ]),
    predecessors: new Map(),
    toolIds: new Set(['hms_find_reservation']),
    registry: null,
    handlerPathActive: true,
    cutoverComplete: false,
  } as unknown as ActiveReadRuntimeState);
}

async function seedMailThread(db: DB) {
  const threadId = randomUUID();
  const triggerMessageId = randomUUID();
  await db.insert(mailThread).values({
    id: threadId,
    transportId: TRANSPORT_ID,
    threadRootId: `<u17-finance-db-${threadId}@example.com>`,
    subject: 'U17 finance DB fixture',
    snippet: 'U17 finance DB fixture',
    latestMessageAt: OBSERVED_AT,
  });
  await db.insert(message).values({
    id: triggerMessageId,
    transportId: TRANSPORT_ID,
    threadId,
    direction: 'inbound',
    fromAddress: 'u17-finance-db@example.com',
    toAddresses: ['nava@example.com'],
    subject: 'U17 finance DB fixture',
    textBody: 'Please reconcile confirmation CONF-U17DB-001.',
    receivedAt: OBSERVED_AT,
  });
  return { threadId, triggerMessageId };
}

async function withDb<T>(callback: (db: DB) => Promise<T>): Promise<T> {
  return withSeededTestDb(async (db) => {
    __setDbForTests({ db, conn: null as never });
    try {
      return await callback(db);
    } finally {
      __setDbForTests(null);
    }
  });
}

async function withReadOnlyWorkerEnv<T>(callback: () => Promise<T>): Promise<T> {
  const keys = [
    'PORT',
    'BETTER_AUTH_URL',
    'BETTER_AUTH_SECRET',
    'AWS_REGION',
    'S3_BUCKET',
    'AI_WORKER_LANE',
    'HMS_READ_SERVICE_ENABLED',
    'HMS_DRAFT_ENRICHMENT_MODE',
    'HMS_RUN_DEADLINE_MS',
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.PORT = '3000';
  process.env.BETTER_AUTH_URL = 'https://nava.legacy.local';
  process.env.BETTER_AUTH_SECRET = 'x'.repeat(32);
  process.env.AWS_REGION = 'synthetic-region-1';
  process.env.S3_BUCKET = 'u17-finance-synthetic-bucket';
  process.env.AI_WORKER_LANE = 'hms';
  process.env.HMS_READ_SERVICE_ENABLED = 'true';
  process.env.HMS_DRAFT_ENRICHMENT_MODE = 'off';
  process.env.HMS_RUN_DEADLINE_MS = '150000';
  try {
    return await callback();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

afterEach(() => {
  clearCachedActiveReadRuntimeForTests();
});

describe('U17 finance normal-runtime DB RED contract', () => {
  it('uses the authenticated mailbox grant, parent queue, worker, and typed finance receipt', async () => {
    if (!reachable) throw new Error('owned disposable DB probe unexpectedly unavailable');

    await withDb(async (db) => {
      installFindRelease();
      const context = await seedMailThread(db);
      const mailbox = await resolveMailboxContext(CENTURION_USER_ID, TRANSPORT_ID, db);
      const caller = appRouter.createCaller({
        auth: null as never,
        c: null as never,
        reqHeaders: new Headers(),
        sessionUser: { id: CENTURION_USER_ID, email: '', name: null },
        ...mailbox,
      });

      const parent = await caller.ai.enqueueHmsRead({ threadId: context.threadId });
      expect(parent).toMatchObject({
        runState: 'queued',
        triggerMessageId: context.triggerMessageId,
        readResultRef: expect.any(String),
      });

      const financeObservedAt = new Date().toISOString();
      let sessionFactoryCalls = 0;
      const sessionFactory: CandidateSessionFactory = async ({ lookupCandidates }) => {
        sessionFactoryCalls += 1;
        return {
          findReservation: async () => ({
            status: 'ok' as const,
            draftReady: false,
            data: {
              matches: [
                {
                  confirmationNumber: 'CONF-U17DB-001',
                  externalReference: null,
                  guestName: null,
                  reservationStatus: 'Confirmed',
                  arrivalDate: '2026-09-10',
                  departureDate: '2026-09-12',
                  roomType: 'STD',
                  ratePlan: null,
                },
              ],
              matchCount: 1,
              capped: false,
            },
            unresolvedFields: [],
            evidence: {
              kind: 'hms' as const,
              id: randomUUID(),
              toolId: 'hms_find_reservation' as const,
              toolVersion: '1.2.0',
              propertyCode: 'HRCEN',
              observedAt: OBSERVED_AT.toISOString(),
              expiresAt: '2099-09-07T12:05:00.000Z',
              claimKeys: [],
              sourceHash: '1'.repeat(64),
            },
          }),
          quoteStay: async () => {
            throw new Error('not used');
          },
          readArtifact: async () => {
            throw new Error('not used');
          },
          readFolio: async () =>
            mergeFolioEvidence(
              [
                {
                  status: 'ok',
                  currency: 'ZAR',
                  totalBalance: '-120.00',
                  evidenceId: randomUUID(),
                  blocker: null,
                  rowsScanned: 2,
                  bytesObserved: 120,
                  durationMs: 5,
                  observedAt: financeObservedAt,
                },
                {
                  status: 'ok',
                  currency: 'ZAR',
                  depositSummary: {
                    total: '500.00',
                    due: { amount: '500.00', status: 'due' },
                    paid: { amount: '300.00', status: 'paid' },
                    refunded: { amount: '0.00', status: 'none_refunded' },
                    forfeited: { amount: '0.00', status: 'none_forfeited' },
                    transferred: { amount: '100.00', status: 'transferred' },
                  },
                  evidenceId: randomUUID(),
                  blocker: null,
                  rowsScanned: 2,
                  bytesObserved: 120,
                  durationMs: 5,
                  observedAt: financeObservedAt,
                },
              ],
              { recipientClass: 'unknown', inquiryClass: 'other' },
            ),
          lookupCandidates: new Map(lookupCandidates.map((candidate) => [candidate.id, candidate])),
          authorizedAttachmentIds: new Set(),
          propertyReadLock: {
            key: 'u17-finance-db',
            withLock: async (callback) =>
              callback({ query: async () => [], close: async () => undefined }),
          },
        };
      };

      await withReadOnlyWorkerEnv(async () => {
        expect(
          await claimNextAiRun({
            ownerId: 'u17-finance-worker',
            lane: 'hms',
            runKind: 'read_tool',
            db,
          }),
        ).toMatchObject({ id: parent.runId });
        const parentExecution = await executeAiRun(parent.runId, {
          candidateSessionFactory: sessionFactory,
        });
        if (parentExecution.state !== 'succeeded') {
          const [failedParent] = await db
            .select({
              state: aiWorkflowRun.state,
              lastError: aiWorkflowRun.lastError,
              failureClass: aiWorkflowRun.failureClass,
            })
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, parent.runId));
          throw new Error(`parent execution failed: ${JSON.stringify(failedParent)}`);
        }
        const parentReceipt = await caller.ai.readHmsReceipt({
          threadId: context.threadId,
          readResultRef: parent.readResultRef,
        });
        expect(parentReceipt.result).toMatchObject({
          toolId: 'hms_find_reservation',
          status: 'ok',
        });

        const finance = await caller.ai.enqueueHmsFolioRead({
          threadId: context.threadId,
          findResultRef: parent.readResultRef,
          sections: ['balance', 'deposits'],
        });
        expect(finance).toMatchObject({ runState: 'queued', reservationRef: expect.any(String) });
        expect(
          await claimNextAiRun({
            ownerId: 'u17-finance-worker',
            lane: 'hms',
            runKind: 'read_tool',
            db,
          }),
        ).toMatchObject({ id: finance.runId });
        const financeExecution = await executeAiRun(finance.runId, {
          candidateSessionFactory: sessionFactory,
        });
        if (financeExecution.state !== 'succeeded') {
          const [failedFinance] = await db
            .select({
              state: aiWorkflowRun.state,
              lastError: aiWorkflowRun.lastError,
              failureClass: aiWorkflowRun.failureClass,
            })
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, finance.runId));
          throw new Error(`finance execution failed: ${JSON.stringify(failedFinance)}`);
        }
        const receipt = await caller.ai.readHmsReceipt({
          threadId: context.threadId,
          readResultRef: finance.readResultRef,
        });
        expect(receipt.result).toMatchObject({
          toolId: 'hms_read_folio',
          status: 'ok',
          completeness: 'complete',
          scopeRef: finance.reservationRef,
        });
        expect(receipt.result.data).toMatchObject({
          totalBalance: '-120.00',
          disclosure: { claimEligibility: 'blocked' },
        });

        const runRows = async () => db.select({ id: aiWorkflowRun.id }).from(aiWorkflowRun);
        const runsBeforeControls = await runRows();

        const foreignMailbox = await resolveMailboxContext(MARTHA_USER_ID, TRANSPORT_ID, db);
        const [foreignGrant] = await db
          .select({ id: mailboxAccess.id })
          .from(mailboxAccess)
          .where(
            and(
              eq(mailboxAccess.userId, MARTHA_USER_ID),
              eq(mailboxAccess.transportId, TRANSPORT_ID),
            ),
          )
          .limit(1);
        if (!foreignGrant) throw new Error('foreign current grant missing for provenance control');
        const foreignCaller = appRouter.createCaller({
          auth: null as never,
          c: null as never,
          reqHeaders: new Headers(),
          sessionUser: { id: MARTHA_USER_ID, email: '', name: null },
          ...foreignMailbox,
        });
        await expect(
          foreignCaller.ai.enqueueHmsFolioRead({
            threadId: context.threadId,
            findResultRef: parent.readResultRef,
            sections: ['balance'],
          }),
        ).rejects.toThrow(/parent|issuer|scope|grant/i);
        expect(await runRows()).toHaveLength(runsBeforeControls.length);

        const [storedParent] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, parent.runId))
          .limit(1);
        if (!storedParent || !storedParent.readResult || !storedParent.readResultExpiresAt) {
          throw new Error('positive parent row missing for authority controls');
        }
        const positiveParentResult = storedParent.readResult;
        const positiveParentExpiry = storedParent.readResultExpiresAt;
        const positiveParentData = parentReceipt.result.data as {
          matches: readonly unknown[];
          matchCount: number;
          capped: boolean;
        };
        await db
          .update(aiWorkflowRun)
          .set({
            readResult: {
              ...parentReceipt.result,
              status: 'ambiguous',
              data: {
                ...positiveParentData,
                matches: [...positiveParentData.matches, ...positiveParentData.matches],
                matchCount: 2,
              },
            },
          })
          .where(eq(aiWorkflowRun.id, parent.runId));
        await expect(
          caller.ai.enqueueHmsFolioRead({
            threadId: context.threadId,
            findResultRef: parent.readResultRef,
            sections: ['balance'],
          }),
        ).rejects.toThrow(/positive|evidence|parent|receipt/i);
        await db
          .update(aiWorkflowRun)
          .set({ readResult: positiveParentResult })
          .where(eq(aiWorkflowRun.id, parent.runId));

        await db
          .update(aiWorkflowRun)
          .set({ readResultExpiresAt: new Date(Date.now() - 1_000) })
          .where(eq(aiWorkflowRun.id, parent.runId));
        await expect(
          caller.ai.enqueueHmsFolioRead({
            threadId: context.threadId,
            findResultRef: parent.readResultRef,
            sections: ['balance'],
          }),
        ).rejects.toThrow(/expired|evidence|receipt|parent/i);
        await db
          .update(aiWorkflowRun)
          .set({ readResultExpiresAt: positiveParentExpiry })
          .where(eq(aiWorkflowRun.id, parent.runId));

        const claimReadRun = async (runId: string) => {
          expect(
            await claimNextAiRun({
              ownerId: 'u17-finance-worker',
              lane: 'hms',
              runKind: 'read_tool',
              db,
            }),
          ).toMatchObject({ id: runId });
        };
        const expectAuthorityDeadLetter = async (runId: string, errorPattern: RegExp) => {
          const execution = await executeAiRun(runId, {
            candidateSessionFactory: sessionFactory,
          });
          expect(execution).toMatchObject({ state: 'dead_letter' });
          const [run] = await db
            .select({ state: aiWorkflowRun.state, lastError: aiWorkflowRun.lastError })
            .from(aiWorkflowRun)
            .where(eq(aiWorkflowRun.id, runId));
          expect(run).toMatchObject({ state: 'dead_letter' });
          expect(run?.lastError).toMatch(errorPattern);
          expect(sessionFactoryCalls).toBe(2);
        };

        const expiredFinance = await caller.ai.enqueueHmsFolioRead({
          threadId: context.threadId,
          findResultRef: parent.readResultRef,
          sections: ['balance'],
        });
        await claimReadRun(expiredFinance.runId);
        const [storedExpiredFinance] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, expiredFinance.runId))
          .limit(1);
        if (
          !storedExpiredFinance ||
          !storedExpiredFinance.readRequest ||
          !storedExpiredFinance.metrics ||
          typeof storedExpiredFinance.readRequest !== 'object' ||
          typeof storedExpiredFinance.metrics !== 'object'
        ) {
          throw new Error('issued finance run missing persisted expiry authority');
        }
        const expiredIssuedAt = new Date(Date.now() - 60_000).toISOString();
        const expiredAt = new Date(Date.now() - 1_000).toISOString();
        const expiredRequest = storedExpiredFinance.readRequest as Record<string, unknown>;
        const expiredAdmission = expiredRequest.admission;
        const expiredMetrics = storedExpiredFinance.metrics as Record<string, unknown>;
        const expiredIssuer = expiredMetrics.readAdmissionIssuer;
        if (
          !expiredAdmission ||
          typeof expiredAdmission !== 'object' ||
          !expiredIssuer ||
          typeof expiredIssuer !== 'object'
        ) {
          throw new Error('issued finance run missing expiry admission provenance');
        }
        await db
          .update(aiWorkflowRun)
          .set({
            readRequest: {
              ...expiredRequest,
              admission: {
                ...(expiredAdmission as Record<string, unknown>),
                reservationRefIssuedAt: expiredIssuedAt,
                reservationRefExpiresAt: expiredAt,
              },
            },
            metrics: {
              ...expiredMetrics,
              readAdmissionIssuer: {
                ...(expiredIssuer as Record<string, unknown>),
                reservationRefIssuedAt: expiredIssuedAt,
                reservationRefExpiresAt: expiredAt,
              },
            },
          })
          .where(eq(aiWorkflowRun.id, expiredFinance.runId));
        await expectAuthorityDeadLetter(expiredFinance.runId, /expired|not yet issued/i);

        const provenanceFinance = await caller.ai.enqueueHmsFolioRead({
          threadId: context.threadId,
          findResultRef: parent.readResultRef,
          sections: ['deposits'],
        });
        await claimReadRun(provenanceFinance.runId);
        const [storedProvenanceFinance] = await db
          .select()
          .from(aiWorkflowRun)
          .where(eq(aiWorkflowRun.id, provenanceFinance.runId))
          .limit(1);
        if (
          !storedProvenanceFinance ||
          !storedProvenanceFinance.metrics ||
          typeof storedProvenanceFinance.metrics !== 'object'
        ) {
          throw new Error('issued finance run missing persisted provenance');
        }
        const provenanceMetrics = storedProvenanceFinance.metrics as Record<string, unknown>;
        const provenanceIssuer = provenanceMetrics.readAdmissionIssuer;
        if (!provenanceIssuer || typeof provenanceIssuer !== 'object') {
          throw new Error('issued finance run missing issuer provenance');
        }
        await db
          .update(aiWorkflowRun)
          .set({
            metrics: {
              ...provenanceMetrics,
              readAdmissionIssuer: {
                ...(provenanceIssuer as Record<string, unknown>),
                mailboxAccessId: foreignGrant.id,
              },
            },
          })
          .where(eq(aiWorkflowRun.id, provenanceFinance.runId));
        await expectAuthorityDeadLetter(
          provenanceFinance.runId,
          /issuer|provenance|mailbox|authorization/i,
        );

        const revokedFinance = await caller.ai.enqueueHmsFolioRead({
          threadId: context.threadId,
          findResultRef: parent.readResultRef,
          sections: ['transactions'],
        });
        await claimReadRun(revokedFinance.runId);

        await db
          .delete(mailboxAccess)
          .where(eq(mailboxAccess.id, `access-${CENTURION_USER_ID}-${TRANSPORT_ID}`));
        await expectAuthorityDeadLetter(revokedFinance.runId, /grant|mailbox|active/i);
        const runsBeforeRevokedProducerControl = await runRows();
        await expect(
          caller.ai.enqueueHmsFolioRead({
            threadId: context.threadId,
            findResultRef: parent.readResultRef,
            sections: ['balance'],
          }),
        ).rejects.toThrow(/grant|mailbox|active/i);
        expect(await runRows()).toHaveLength(runsBeforeRevokedProducerControl.length);
        expect(sessionFactoryCalls).toBe(2);
      });
    });
  });
});
