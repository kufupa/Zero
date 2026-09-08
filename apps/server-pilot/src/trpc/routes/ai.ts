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
import { folioReadSectionIdSchema, readRefSchema } from '../../hms/read-service-contracts.js';
import { router as tRouter, privateProcedure, mailboxProcedure } from '../trpc.js';
import { persistedReadAdmissionIssuerSchema } from '../../hms/read-admission.js';
import { enqueueHmsCandidateRefresh, loadHmsCandidateState } from './drafts.js';
import { resolveHmsSourceRevision } from '../../hms/production-runtime.js';
import { runtimeFingerprintSha256 } from '../../hms/evidence-runtime.js';
import { aiWorkflowRun, message } from '../../db/schema/mail.js';
import { readRequestSchema } from '../../hms/read-service.js';
import { requireThreadForTransport } from './mail-helpers.js';
import { readAiRunReceipt } from '../../ai/run-ledger.js';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const EXISTING_DOCUMENT_RELEASE_ID = 'mail-existing-documents-v1';
const EXISTING_DOCUMENT_BRANCH_ID = 'mail_attachment_authorized';
const existingDocumentSourceSchema = z.enum([
  'mail_attachment',
  'hms_sent_attachment',
  'hms_finalized_document',
  'approved_property_document',
]);
const existingDocumentKindSchema = z.enum([
  'reservation_confirmation',
  'tax_invoice',
  'pro_forma',
  'folio',
  'statement',
  'contract',
  'supplier_compliance',
  'property_information',
  'other_existing',
]);

function existingDocumentAdmissionRelease() {
  return {
    releaseId: EXISTING_DOCUMENT_RELEASE_ID,
    requestBranchId: EXISTING_DOCUMENT_BRANCH_ID,
  };
}

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
  return {
    releaseId: hmsRelease.releaseId,
    requestBranchId: branch.id,
    manifestSha256: branch.manifestSha256,
  };
}

async function activeQuoteAdmission() {
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
  const release = active.releases.get('hms_quote_stay');
  const hmsRelease = release?.evidenceKind === 'hms' ? release : null;
  const branch = hmsRelease?.requestBranches.find(
    (candidate) => candidate.id === 'quote_availability_search',
  );
  if (!hmsRelease || !branch || active.handlerPathActive !== true) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'HMS_QUOTE_RELEASE_UNAVAILABLE',
    });
  }
  return {
    releaseId: hmsRelease.releaseId,
    requestBranchId: branch.id,
    manifestSha256: branch.manifestSha256,
  };
}

async function activeFolioAdmission(sections: readonly string[]) {
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
  const release = active.releases.get('hms_read_folio');
  const hmsRelease = release?.evidenceKind === 'hms' ? release : null;
  const branchId = sections.some((section) => ['deposits', 'transactions'].includes(section))
    ? 'deposit_ledger_summary'
    : 'folio_summary';
  const branch = hmsRelease?.requestBranches.find((candidate) => candidate.id === branchId);
  if (!hmsRelease || !branch || active.handlerPathActive !== true) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'HMS_FOLIO_READ_RELEASE_UNAVAILABLE',
    });
  }
  return {
    releaseId: hmsRelease.releaseId,
    requestBranchId: branch.id,
    manifestSha256: branch.manifestSha256,
  };
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
    .input(
      z.object({
        threadId: z.string().min(1),
        toolId: z.enum(['hms_find_reservation', 'hms_quote_stay']).default('hms_find_reservation'),
        quoteRequestRef: readRefSchema.optional(),
        detail: z.enum(['summary', 'detail']).default('summary'),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const isQuote = input.toolId === 'hms_quote_stay';
      const release = isQuote ? await activeQuoteAdmission() : await activeFindAdmission();
      const readResultRef = `hms-read-${randomUUID()}`;
      const issued = await issueReadAdmissionFromMailbox({
        db,
        userId: ctx.sessionUser.id,
        transportId: ctx.activeTransportId,
        threadId: input.threadId,
        toolId: input.toolId,
        ...(isQuote ? { quoteRequestRef: input.quoteRequestRef, detail: input.detail } : {}),
        captureBindingRef: readResultRef,
        ...release,
      });
      const run = await enqueueAiRun(
        {
          transportId: ctx.activeTransportId,
          threadId: input.threadId,
          triggerMessageId: issued.triggerMessageId,
          runKind: 'read_tool',
          idempotencyKey: isQuote
            ? `hms-read-quote:${ctx.activeTransportId}:${input.threadId}:${issued.triggerMessageId}:${issued.quoteRequestRef}`
            : `hms-read-find:${ctx.activeTransportId}:${input.threadId}:${issued.triggerMessageId}:${issued.candidateId}`,
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
        quoteRequestRef: issued.quoteRequestRef,
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
      const readResultRef = `hms-read-${randomUUID()}`;
      const issued = await issueReadAdmissionFromMailbox({
        db,
        userId: ctx.sessionUser.id,
        transportId: ctx.activeTransportId,
        threadId: input.threadId,
        toolId: 'hms_read_reservation',
        parentReadResultRef: input.findResultRef,
        sections: input.sections,
        detail: input.detail,
        captureBindingRef: readResultRef,
        ...release,
      });
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

  /** Authenticated, parent-bound folio/deposit read; no model or write path. */
  enqueueHmsFolioRead: mailboxProcedure
    .input(
      z.object({
        threadId: z.string().min(1),
        findResultRef: readRefSchema,
        sections: z
          .array(folioReadSectionIdSchema)
          .min(1)
          .max(4)
          .refine((sections) => new Set(sections).size === sections.length),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const release = await activeFolioAdmission(input.sections);
      const readResultRef = `hms-read-${randomUUID()}`;
      const issued = await issueReadAdmissionFromMailbox({
        db,
        userId: ctx.sessionUser.id,
        transportId: ctx.activeTransportId,
        threadId: input.threadId,
        toolId: 'hms_read_folio',
        parentReadResultRef: input.findResultRef,
        sections: input.sections,
        captureBindingRef: readResultRef,
        ...release,
      });
      const run = await enqueueAiRun(
        {
          transportId: ctx.activeTransportId,
          threadId: input.threadId,
          triggerMessageId: issued.triggerMessageId,
          runKind: 'read_tool',
          idempotencyKey: `hms-read-folio:${ctx.activeTransportId}:${input.threadId}:${input.findResultRef}:${input.sections.join(',')}`,
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

  /**
   * Authenticated, model-free mail-document list. Scope, source records and
   * attachment authority are derived by the DB issuer; callers cannot supply
   * a storage key, URL, attachment ID or document scope.
   */
  enqueueExistingDocumentList: mailboxProcedure
    .input(
      z.object({
        threadId: z.string().min(1),
        source: existingDocumentSourceSchema.default('mail_attachment'),
        kind: existingDocumentKindSchema.optional(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: readRefSchema.optional(),
        requestedPriceVisibility: z.enum(['allowed', 'forbidden', 'unknown']).default('allowed'),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const issued = await issueReadAdmissionFromMailbox({
        db,
        userId: ctx.sessionUser.id,
        transportId: ctx.activeTransportId,
        threadId: input.threadId,
        toolId: 'documents_list_existing',
        source: input.source,
        kind: input.kind,
        limit: input.limit,
        cursor: input.cursor,
        requestedPriceVisibility: input.requestedPriceVisibility,
        ...existingDocumentAdmissionRelease(),
      });
      const readResultRef = `hms-read-${randomUUID()}`;
      const run = await enqueueAiRun(
        {
          transportId: ctx.activeTransportId,
          threadId: input.threadId,
          triggerMessageId: issued.triggerMessageId,
          runKind: 'read_tool',
          idempotencyKey: `hms-read-doc-list:${ctx.activeTransportId}:${input.threadId}:${issued.triggerMessageId}:${input.source}:${input.kind ?? ''}:${input.limit ?? 20}:${input.cursor ?? ''}:${input.requestedPriceVisibility}`,
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
      };
    }),

  /** Authenticated queued read of one previously issued opaque document ref. */
  enqueueExistingDocumentRead: mailboxProcedure
    .input(
      z.object({
        threadId: z.string().min(1),
        documentRef: readRefSchema,
        format: z.enum(['text', 'artifact']),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const issued = await issueReadAdmissionFromMailbox({
        db,
        userId: ctx.sessionUser.id,
        transportId: ctx.activeTransportId,
        threadId: input.threadId,
        toolId: 'documents_read_existing',
        source: 'mail_attachment',
        documentRef: input.documentRef,
        format: input.format,
        ...existingDocumentAdmissionRelease(),
      });
      const readResultRef = `hms-read-${randomUUID()}`;
      const run = await enqueueAiRun(
        {
          transportId: ctx.activeTransportId,
          threadId: input.threadId,
          triggerMessageId: issued.triggerMessageId,
          runKind: 'read_tool',
          idempotencyKey: `hms-read-doc-read:${ctx.activeTransportId}:${input.threadId}:${input.documentRef}:${input.format}`,
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
