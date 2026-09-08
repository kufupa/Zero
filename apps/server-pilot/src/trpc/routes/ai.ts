import {
  enqueueAiRun,
  NOT_APPLICABLE_MODEL_ID,
  READ_TOOL_PROMPT_VERSION,
} from '../../ai/run-ledger.js';
import {
  issueReadAdmissionFromMailbox,
  loadReadMailboxGrant,
} from '../../hms/read-admission-issuer.js';
import {
  getCachedActiveReadRuntime,
  loadWorkerActiveReadSet,
} from '../../hms/active-read-runtime.js';
import { router as tRouter, privateProcedure, mailboxProcedure } from '../trpc.js';
import { persistedReadAdmissionIssuerSchema } from '../../hms/read-admission.js';
import { enqueueHmsCandidateRefresh, loadHmsCandidateState } from './drafts.js';
import { resolveHmsSourceRevision } from '../../hms/production-runtime.js';
import { runtimeFingerprintSha256 } from '../../hms/evidence-runtime.js';
import { readRefSchema } from '../../hms/read-service-contracts.js';
import { aiWorkflowRun, message } from '../../db/schema/mail.js';
import { readRequestSchema } from '../../hms/read-service.js';
import { requireThreadForTransport } from './mail-helpers.js';
import { readAiRunReceipt } from '../../ai/run-ledger.js';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

async function activeFindAdmission() {
  let active = getCachedActiveReadRuntime();
  if (!active) {
    active = await loadWorkerActiveReadSet({
      registryPath:
        process.env.HMS_ACTIVE_REGISTRY_PATH?.trim() ||
        '/opt/nava/shared/hms-active-registry/active.json',
      releaseRoot: process.env.HMS_RELEASE_ROOT?.trim() || '/opt/nava/shared/hms-releases',
      runtimeFingerprintSha256: runtimeFingerprintSha256({
        sourceRevision: resolveHmsSourceRevision(),
        playwrightRevision: '1.52.0',
        chromiumRevision: '1169',
      }),
    });
  }
  const release = active.releases.get('hms_find_reservation');
  const hmsRelease = release?.evidenceKind === 'hms' ? release : null;
  const branch = hmsRelease?.requestBranches.find(
    (candidate) => candidate.id === 'guest_stay_search',
  );
  if (!hmsRelease || !branch || active.handlerPathActive !== true) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'HMS_READ_RELEASE_UNAVAILABLE',
    });
  }
  return { releaseId: hmsRelease.releaseId, requestBranchId: branch.id };
}

function readRouteNotFound(): TRPCError {
  return new TRPCError({ code: 'NOT_FOUND', message: 'READ_RECEIPT_NOT_FOUND' });
}

export const aiRouter = tRouter({
  generateSearchQuery: privateProcedure
    .input(z.object({ prompt: z.string().optional() }).optional())
    .query(() => ({ query: '', disabled: true })),

  webSearch: privateProcedure
    .input(z.object({ query: z.string().optional() }).optional())
    .query(() => ({ results: [], disabled: true })),

  compose: privateProcedure
    .input(z.unknown().optional())
    .mutation(() => ({ text: '', disabled: true })),

  generateEmailSubject: privateProcedure
    .input(z.unknown().optional())
    .mutation(() => ({ subject: '', disabled: true })),

  /**
   * Newest successful HMS candidate + independent active Refresh run.
   * Prior candidate stays visible while Refresh is queued/running/failed.
   */
  hmsCandidateState: mailboxProcedure
    .input(z.object({ threadId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      await requireThreadForTransport(db, input.threadId, transportId);
      return loadHmsCandidateState({
        db,
        transportId,
        threadId: input.threadId,
      });
    }),

  /**
   * Full-agent Refresh. Idempotent on threadStateVersion + toolsetVersion.
   * Does not discard the prior candidate.
   */
  refreshHmsCandidate: mailboxProcedure
    .input(z.object({ threadId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Shadow: fixed block before any DB write (enqueue helper also gates).
      const { parseEnv } = await import('../../env.js');
      const { HMS_MANUAL_OPS_REQUIRED } = await import('../../ai/hms-shadow.js');
      if (
        parseEnv(process.env as Record<string, string | undefined>).HMS_DRAFT_ENRICHMENT_MODE ===
        'shadow'
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: HMS_MANUAL_OPS_REQUIRED,
        });
      }

      const db = getDb();
      const transportId = ctx.activeTransportId;
      await requireThreadForTransport(db, input.threadId, transportId);

      const [latestInbound] = await db
        .select({ id: message.id })
        .from(message)
        .where(
          and(
            eq(message.transportId, transportId),
            eq(message.threadId, input.threadId),
            eq(message.direction, 'inbound'),
          ),
        )
        .orderBy(desc(message.receivedAt), desc(message.id))
        .limit(1);
      if (!latestInbound) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'INBOUND_MESSAGE_NOT_FOUND' });
      }

      const result = await enqueueHmsCandidateRefresh({
        db,
        transportId,
        threadId: input.threadId,
        triggerMessageId: latestInbound.id,
        requestedByUserId: ctx.sessionUser.id,
      });

      return {
        runId: result.runId,
        runState: result.runState,
        triggerMessageId: latestInbound.id,
        threadStateVersion: result.threadStateVersion,
        idempotencyKey: result.idempotencyKey,
      };
    }),

  /**
   * Authenticated, model-free reservation find. The route derives trigger and
   * candidate from the scoped thread; callers receive only an opaque receipt.
   */
  enqueueHmsRead: mailboxProcedure
    .input(z.object({ threadId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const release = await activeFindAdmission();
      const issued = await issueReadAdmissionFromMailbox({
        db,
        userId: ctx.sessionUser.id,
        transportId: ctx.activeTransportId,
        threadId: input.threadId,
        toolId: 'hms_find_reservation',
        ...release,
      });
      const readResultRef = `hms-read-${randomUUID()}`;
      const run = await enqueueAiRun(
        {
          transportId: ctx.activeTransportId,
          threadId: input.threadId,
          triggerMessageId: issued.triggerMessageId,
          runKind: 'read_tool',
          idempotencyKey: `hms-read-find:${ctx.activeTransportId}:${input.threadId}:${issued.triggerMessageId}:${issued.candidateId}`,
          modelId: NOT_APPLICABLE_MODEL_ID,
          promptVersion: READ_TOOL_PROMPT_VERSION,
          executorLane: 'hms',
          readRequest: issued.readRequest,
          readResultRef,
          readAdmissionIssuer: issued.issuer,
        },
        db,
      );
      return {
        runId: run.id,
        runState: run.state,
        readResultRef: run.readResultRef ?? readResultRef,
        triggerMessageId: issued.triggerMessageId,
        candidateId: issued.candidateId,
      };
    }),

  /**
   * Context follow-up. A prior exact positive typed find receipt is the only
   * source of entitlement for the server-issued context reference.
   */
  enqueueHmsContextRead: mailboxProcedure
    .input(
      z.object({
        threadId: z.string().min(1),
        findResultRef: readRefSchema,
        sections: z
          .array(z.enum(['core', 'stay', 'rates', 'policies', 'operations']))
          .min(1)
          .max(5)
          .refine((sections) => new Set(sections).size === sections.length),
        detail: z.enum(['summary', 'detail']).default('summary'),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const release = await activeFindAdmission();
      const issued = await issueReadAdmissionFromMailbox({
        db,
        userId: ctx.sessionUser.id,
        transportId: ctx.activeTransportId,
        threadId: input.threadId,
        toolId: 'hms_read_reservation',
        parentReadResultRef: input.findResultRef,
        sections: input.sections,
        detail: input.detail,
        ...release,
      });
      const readResultRef = `hms-read-${randomUUID()}`;
      const run = await enqueueAiRun(
        {
          transportId: ctx.activeTransportId,
          threadId: input.threadId,
          triggerMessageId: issued.triggerMessageId,
          runKind: 'read_tool',
          idempotencyKey: `hms-read-context:${ctx.activeTransportId}:${input.threadId}:${input.findResultRef}:${input.sections.join(',')}:${input.detail}`,
          modelId: NOT_APPLICABLE_MODEL_ID,
          promptVersion: READ_TOOL_PROMPT_VERSION,
          executorLane: 'hms',
          readRequest: issued.readRequest,
          readResultRef,
          readAdmissionIssuer: issued.issuer,
        },
        db,
      );
      return {
        runId: run.id,
        runState: run.state,
        readResultRef: run.readResultRef ?? readResultRef,
        triggerMessageId: issued.triggerMessageId,
        candidateId: issued.candidateId,
        reservationRef: issued.admission.reservationRef,
        reservationRefExpiresAt: issued.admission.reservationRefExpiresAt,
      };
    }),

  /** Read a typed receipt using only the authenticated mailbox/thread scope. */
  readHmsReceipt: mailboxProcedure
    .input(z.object({ threadId: z.string().min(1), readResultRef: readRefSchema }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      await requireThreadForTransport(db, input.threadId, ctx.activeTransportId);
      const grant = await loadReadMailboxGrant({
        db,
        userId: ctx.sessionUser.id,
        transportId: ctx.activeTransportId,
      });
      const [run] = await db
        .select()
        .from(aiWorkflowRun)
        .where(eq(aiWorkflowRun.readResultRef, input.readResultRef))
        .limit(1);
      if (
        !run ||
        run.runKind !== 'read_tool' ||
        run.transportId !== ctx.activeTransportId ||
        run.threadId !== input.threadId
      ) {
        throw readRouteNotFound();
      }
      const request = readRequestSchema.safeParse(run.readRequest);
      const admission = request.success ? request.data.admission : undefined;
      const metrics =
        run.metrics && typeof run.metrics === 'object'
          ? (run.metrics as Record<string, unknown>)
          : null;
      const issuer = persistedReadAdmissionIssuerSchema.safeParse(metrics?.readAdmissionIssuer);
      if (
        !request.success ||
        !admission ||
        !issuer.success ||
        issuer.data.userId !== ctx.sessionUser.id ||
        issuer.data.mailboxAccessId !== grant.accessId ||
        issuer.data.triggerMessageId !== run.triggerMessageId
      ) {
        throw readRouteNotFound();
      }
      const receipt = await readAiRunReceipt(
        {
          readResultRef: input.readResultRef,
          transportId: ctx.activeTransportId,
          threadId: input.threadId,
          triggerMessageId: run.triggerMessageId,
          requesterAuthorizationId: grant.accessId,
        },
        db,
      );
      if (!receipt) throw readRouteNotFound();
      return receipt;
    }),
});
