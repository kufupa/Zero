/**
 * Drafts router: mailbox-scoped draft CRUD.
 *
 * Drafts are scoped to the caller's active transport. A draft may optionally
 * attach to a thread (`threadId`); the thread is verified to belong to the
 * same transport before linking.
 */
import {
  DRAFT_APPROVAL_POLICY_VERSION,
  DraftApprovalError,
  assertDraftApprovalCurrent,
  buildDraftApproval,
  getDraftApprovalSigningSecret,
  type DraftApprovalPayload,
} from '../../ai/draft-approval.js';
import {
  requireThreadForTransport,
  requireMessageForTransport,
  encodePageCursor,
  decodePageCursor,
  keysetBefore,
} from './mail-helpers.js';
import {
  aiDraftGeneration,
  aiWorkflowRun,
  attachment,
  mailDraft,
  mailDraftRevision,
  message,
} from '../../db/schema/mail.js';
import {
  EvidenceRefSchema,
  isEvidenceFresh,
  type HmsEvidenceRef,
  type MailEvidenceRef,
} from '../../ai/draft-evidence.js';
import { createDraftInput, serializedAttachmentInput } from '../wire-compat.js';
import { DEFAULT_AI_MODEL_ID, enqueueAiRun } from '../../ai/run-ledger.js';
import { prepareOutboundHtml } from '../../mail/prepare-outbound-html.js';
import { parseDraftSearchQueryOrThrow } from '../../mail/search/trpc.js';
import { buildDraftSearchConditions } from '../../mail/search/query.js';
import { mailboxProcedure, router as tRouter } from '../trpc.js';
import { loadLiveThreadStateVersion } from '../../ai/drafts.js';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { getDb, type DB } from '../../db/client.js';
import { toDraftWire } from './draft-wire.js';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'node:crypto';
import { parseEnv } from '../../env.js';
import { z } from 'zod';

function isPostgresUniqueViolation(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    if ((err as { code: string }).code === '23505') return true;
  }
  if (err instanceof Error && err.cause !== undefined) {
    return isPostgresUniqueViolation(err.cause);
  }
  return false;
}

/** Bump when candidate tool registry / claim schemas change. */
export { HMS_CANDIDATE_TOOLSET_VERSION } from '../../ai/candidate-draft-agent.js';
import { HMS_CANDIDATE_TOOLSET_VERSION } from '../../ai/candidate-draft-agent.js';

export const DEFAULT_HMS_CANDIDATE_PROMPT_VERSION = 'draft-v1';

export type HmsCandidateFreshness = 'fresh' | 'stale_thread' | 'stale_evidence' | 'unknown';

export type HmsCandidateActiveRunState = 'queued' | 'claimed' | 'running' | 'retry_wait';

export type HmsCandidateState = {
  visibleCandidate: ReturnType<typeof toDraftWire> | null;
  activeRun: {
    id: string;
    state: HmsCandidateActiveRunState;
  } | null;
  outcome: 'candidate' | 'needs_clarification' | 'insufficient_evidence' | null;
  freshness: HmsCandidateFreshness;
  unresolvedFields: string[];
  refreshedAt: string | null;
};

const ACTIVE_REFRESH_STATES = new Set<string>(['queued', 'claimed', 'running', 'retry_wait']);

export function buildHmsRefreshIdempotencyKey(input: {
  transportId: string;
  threadId: string;
  threadStateVersion: string;
  toolsetVersion?: string;
}): string {
  const toolset = input.toolsetVersion ?? HMS_CANDIDATE_TOOLSET_VERSION;
  return `hms-refresh:${input.transportId}:${input.threadId}:${input.threadStateVersion}:${toolset}`;
}

/**
 * Refresh run outcome never clears a prior candidate — candidate query is
 * independent of activeRun (failed/dead_letter → activeRun null, prior stays).
 */
export function resolveHmsCandidateVisibility(input: {
  priorCandidateId: string | null;
  refreshRun: { id: string; state: string } | null;
}): {
  visibleCandidateId: string | null;
  activeRun: { id: string; state: HmsCandidateActiveRunState } | null;
} {
  const activeRun =
    input.refreshRun && ACTIVE_REFRESH_STATES.has(input.refreshRun.state)
      ? {
          id: input.refreshRun.id,
          state: input.refreshRun.state as HmsCandidateActiveRunState,
        }
      : null;
  return {
    visibleCandidateId: input.priorCandidateId,
    activeRun,
  };
}

/** Skeleton / off-mode generations skip HMS freshness hard-blocks. */
export function isHmsEnrichedGeneration(generation: {
  outcome: string | null;
  threadStateVersion: string | null;
  evidence: unknown[] | null;
}): boolean {
  if (generation.outcome) return true;
  if (generation.threadStateVersion) return true;
  return Array.isArray(generation.evidence) && generation.evidence.length > 0;
}

/**
 * Pure mirror of assertHmsDraftFreshForAction promote/send gate (no DB).
 * Off-mode skeleton → never blocked. Enriched + non-fresh → blocked.
 */
export function hmsPromoteBlockedByFreshness(input: {
  generation: {
    outcome: string | null;
    threadStateVersion: string | null;
    evidence: unknown[] | null;
  };
  liveThreadStateVersion: string;
  now?: Date;
  attachmentSourceHashes?: ReadonlyMap<string, string>;
  missingAttachmentIds?: ReadonlySet<string>;
}): boolean {
  if (!isHmsEnrichedGeneration(input.generation)) return false;
  const freshness = evaluateHmsCandidateFreshness({
    threadStateVersion: input.generation.threadStateVersion,
    liveThreadStateVersion: input.liveThreadStateVersion,
    evidence: input.generation.evidence ?? [],
    now: input.now,
    attachmentSourceHashes: input.attachmentSourceHashes,
    missingAttachmentIds: input.missingAttachmentIds,
  });
  return freshness !== 'fresh';
}

export function evaluateHmsEvidenceFreshness(input: {
  evidence: unknown[];
  now?: Date;
  /**
   * Current attachmentId → sha256 hex of attachment bytes.
   * Missing key → unknown for that ref (fail closed for promote/send).
   */
  attachmentSourceHashes?: ReadonlyMap<string, string>;
  /** Evidence attachment IDs absent from DB → stale_evidence. */
  missingAttachmentIds?: ReadonlySet<string>;
}): Exclude<HmsCandidateFreshness, 'stale_thread'> {
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) return 'unknown';
  const now = input.now ?? new Date();
  for (const raw of input.evidence) {
    const parsed = EvidenceRefSchema.safeParse(raw);
    if (!parsed.success) return 'unknown';
    const evidence = parsed.data as HmsEvidenceRef | MailEvidenceRef;
    if (evidence.kind === 'hms') {
      if (!isEvidenceFresh(evidence, now)) return 'stale_evidence';
      continue;
    }
    if (input.missingAttachmentIds?.has(evidence.attachmentId)) {
      return 'stale_evidence';
    }
    const current = input.attachmentSourceHashes?.get(evidence.attachmentId);
    if (current === undefined) return 'unknown';
    if (current !== evidence.sourceHash) return 'stale_evidence';
  }
  return 'fresh';
}

export function evaluateHmsCandidateFreshness(input: {
  threadStateVersion: string | null;
  liveThreadStateVersion: string;
  evidence: unknown[];
  now?: Date;
  attachmentSourceHashes?: ReadonlyMap<string, string>;
  missingAttachmentIds?: ReadonlySet<string>;
}): HmsCandidateFreshness {
  if (!input.threadStateVersion) return 'unknown';
  if (input.threadStateVersion !== input.liveThreadStateVersion) return 'stale_thread';
  return evaluateHmsEvidenceFreshness({
    evidence: input.evidence,
    now: input.now,
    attachmentSourceHashes: input.attachmentSourceHashes,
    missingAttachmentIds: input.missingAttachmentIds,
  });
}

/**
 * Resolve live attachment hashes for mail_attachment evidence.
 *
 * Prefer caller-injected hashes (tests / future contentHash column). Otherwise
 * load attachment rows for the thread: missing row → missingIds (stale).
 * Attachment table has no contentHash today → no hash entries → fail closed
 * `unknown` for present mail attachments until hashes are injectable/stored.
 */
export async function resolveMailAttachmentFreshnessInputs(input: {
  db: DB;
  transportId: string;
  threadId: string;
  evidence: unknown[];
  attachmentSourceHashes?: ReadonlyMap<string, string>;
}): Promise<{
  attachmentSourceHashes: ReadonlyMap<string, string>;
  missingAttachmentIds: ReadonlySet<string>;
}> {
  const attachmentIds = new Set<string>();
  for (const raw of input.evidence) {
    const parsed = EvidenceRefSchema.safeParse(raw);
    if (!parsed.success) continue;
    if (parsed.data.kind === 'mail_attachment') {
      attachmentIds.add(parsed.data.attachmentId);
    }
  }

  if (attachmentIds.size === 0) {
    return {
      attachmentSourceHashes: input.attachmentSourceHashes ?? new Map(),
      missingAttachmentIds: new Set(),
    };
  }

  const rows = await input.db
    .select({
      id: attachment.id,
      // Reserved for future contentHash column / dialect extension.
      s3Key: attachment.s3Key,
      sizeBytes: attachment.sizeBytes,
    })
    .from(attachment)
    .innerJoin(message, eq(attachment.messageId, message.id))
    .where(
      and(
        eq(message.transportId, input.transportId),
        eq(message.threadId, input.threadId),
        inArray(attachment.id, [...attachmentIds]),
      ),
    );

  const found = new Set(rows.map((r) => r.id));
  const missingAttachmentIds = new Set([...attachmentIds].filter((id) => !found.has(id)));

  // Injected hashes win. DB has no contentHash column yet — do not invent
  // metadata fingerprints that cannot match evidence.sourceHash (body sha256).
  const hashes = new Map<string, string>(input.attachmentSourceHashes ?? []);
  return { attachmentSourceHashes: hashes, missingAttachmentIds };
}

export function collectUnresolvedFields(input: {
  outcome: string | null;
  evidence: unknown[];
}): string[] {
  if (input.outcome === 'needs_clarification' || input.outcome === 'insufficient_evidence') {
    return ['evidence'];
  }
  const fields: string[] = [];
  for (const raw of input.evidence) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const unresolved = (raw as { unresolvedFields?: unknown }).unresolvedFields;
    if (Array.isArray(unresolved)) {
      for (const f of unresolved) {
        if (typeof f === 'string' && f.length > 0) fields.push(f);
      }
    }
  }
  return [...new Set(fields)];
}

/**
 * Query newest successful AI candidate independently from any active Refresh run.
 */
export async function loadHmsCandidateState(input: {
  db: DB;
  transportId: string;
  threadId: string;
  now?: Date;
  attachmentSourceHashes?: ReadonlyMap<string, string>;
}): Promise<HmsCandidateState> {
  const now = input.now ?? new Date();

  const [activeRunRow] = await input.db
    .select({
      id: aiWorkflowRun.id,
      state: aiWorkflowRun.state,
      createdAt: aiWorkflowRun.createdAt,
    })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, input.transportId),
        eq(aiWorkflowRun.threadId, input.threadId),
        eq(aiWorkflowRun.runKind, 'candidate_draft'),
        eq(aiWorkflowRun.executorLane, 'hms'),
        inArray(aiWorkflowRun.state, ['queued', 'claimed', 'running', 'retry_wait']),
      ),
    )
    .orderBy(desc(aiWorkflowRun.createdAt), desc(aiWorkflowRun.id))
    .limit(1);

  const [candidate] = await input.db
    .select()
    .from(mailDraft)
    .where(
      and(
        eq(mailDraft.transportId, input.transportId),
        eq(mailDraft.threadId, input.threadId),
        eq(mailDraft.isSent, false),
        eq(mailDraft.status, 'candidate'),
        eq(mailDraft.origin, 'ai'),
      ),
    )
    .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
    .limit(1);

  const visibility = resolveHmsCandidateVisibility({
    priorCandidateId: candidate?.id ?? null,
    refreshRun: activeRunRow ? { id: activeRunRow.id, state: activeRunRow.state } : null,
  });
  const activeRun = visibility.activeRun;

  if (!candidate?.generationId) {
    return {
      visibleCandidate: null,
      activeRun,
      outcome: null,
      freshness: 'unknown',
      unresolvedFields: [],
      refreshedAt: null,
    };
  }

  const [generation] = await input.db
    .select()
    .from(aiDraftGeneration)
    .where(
      and(
        eq(aiDraftGeneration.id, candidate.generationId),
        eq(aiDraftGeneration.transportId, input.transportId),
      ),
    )
    .limit(1);

  const outcomeRaw = generation?.outcome ?? null;
  const outcome =
    outcomeRaw === 'candidate' ||
    outcomeRaw === 'needs_clarification' ||
    outcomeRaw === 'insufficient_evidence'
      ? outcomeRaw
      : null;

  let freshness: HmsCandidateFreshness = 'unknown';
  if (generation && isHmsEnrichedGeneration(generation)) {
    const evidence = generation.evidence ?? [];
    // Omit latestDraftRevisionId → load live thread-affecting revision (Task-2 contract).
    const live = await loadLiveThreadStateVersion(input.db, {
      transportId: input.transportId,
      threadId: input.threadId,
    });
    const attachmentFreshness = await resolveMailAttachmentFreshnessInputs({
      db: input.db,
      transportId: input.transportId,
      threadId: input.threadId,
      evidence,
      attachmentSourceHashes: input.attachmentSourceHashes,
    });
    freshness = evaluateHmsCandidateFreshness({
      threadStateVersion: generation.threadStateVersion,
      liveThreadStateVersion: live,
      evidence,
      now,
      attachmentSourceHashes: attachmentFreshness.attachmentSourceHashes,
      missingAttachmentIds: attachmentFreshness.missingAttachmentIds,
    });
  }

  return {
    visibleCandidate: toDraftWire(candidate, freshness !== 'fresh'),
    activeRun,
    outcome,
    freshness,
    unresolvedFields: collectUnresolvedFields({
      outcome,
      evidence: generation?.evidence ?? [],
    }),
    refreshedAt: generation?.createdAt?.toISOString() ?? null,
  };
}

export async function assertHmsDraftFreshForAction(input: {
  db: DB;
  transportId: string;
  draft: typeof mailDraft.$inferSelect;
  conflict: 'STALE_AI_CANDIDATE' | 'STALE_AI_DRAFT';
  now?: Date;
  attachmentSourceHashes?: ReadonlyMap<string, string>;
}): Promise<void> {
  if (input.draft.origin !== 'ai') return;
  if (!input.draft.generationId || !input.draft.threadId) return;

  const [generation] = await input.db
    .select()
    .from(aiDraftGeneration)
    .where(
      and(
        eq(aiDraftGeneration.id, input.draft.generationId),
        eq(aiDraftGeneration.transportId, input.transportId),
      ),
    )
    .limit(1);
  if (!generation || !isHmsEnrichedGeneration(generation)) return;

  const evidence = generation.evidence ?? [];
  // Omit latestDraftRevisionId → load live thread-affecting revision.
  const live = await loadLiveThreadStateVersion(input.db, {
    transportId: input.transportId,
    threadId: input.draft.threadId,
  });
  const attachmentFreshness = await resolveMailAttachmentFreshnessInputs({
    db: input.db,
    transportId: input.transportId,
    threadId: input.draft.threadId,
    evidence,
    attachmentSourceHashes: input.attachmentSourceHashes,
  });
  const freshness = evaluateHmsCandidateFreshness({
    threadStateVersion: generation.threadStateVersion,
    liveThreadStateVersion: live,
    evidence,
    now: input.now,
    attachmentSourceHashes: attachmentFreshness.attachmentSourceHashes,
    missingAttachmentIds: attachmentFreshness.missingAttachmentIds,
  });
  if (freshness !== 'fresh') {
    throw new TRPCError({ code: 'CONFLICT', message: input.conflict });
  }
}

export async function enqueueHmsCandidateRefresh(input: {
  db: DB;
  transportId: string;
  threadId: string;
  triggerMessageId: string;
  requestedByUserId: string;
  modelId?: string;
  promptVersion?: string;
}): Promise<{
  runId: string;
  runState:
    | 'queued'
    | 'claimed'
    | 'running'
    | 'retry_wait'
    | 'succeeded'
    | 'dead_letter'
    | 'superseded';
  idempotencyKey: string;
  threadStateVersion: string;
}> {
  // Shadow mode: Task 5 isolated ops CLI is the only manual enqueue path.
  // Fail before any insert — never pre-create aiDraftGeneration or unscoped run.
  const hmsMode = parseEnv(
    process.env as Record<string, string | undefined>,
  ).HMS_DRAFT_ENRICHMENT_MODE;
  if (hmsMode === 'shadow') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'HMS_MANUAL_OPS_REQUIRED',
    });
  }

  const threadStateVersion = await loadLiveThreadStateVersion(input.db, {
    transportId: input.transportId,
    threadId: input.threadId,
  });
  const idempotencyKey = buildHmsRefreshIdempotencyKey({
    transportId: input.transportId,
    threadId: input.threadId,
    threadStateVersion,
  });

  const run = await enqueueAiRun(
    {
      transportId: input.transportId,
      threadId: input.threadId,
      triggerMessageId: input.triggerMessageId,
      runKind: 'candidate_draft',
      idempotencyKey,
      modelId: input.modelId ?? DEFAULT_AI_MODEL_ID,
      promptVersion: input.promptVersion ?? DEFAULT_HMS_CANDIDATE_PROMPT_VERSION,
      executorLane: 'hms',
    },
    input.db,
  );

  const generationId = run.generationId ?? `${run.id}-generation`;
  const [existingGen] = await input.db
    .select({ id: aiDraftGeneration.id })
    .from(aiDraftGeneration)
    .where(eq(aiDraftGeneration.id, generationId))
    .limit(1);
  if (!existingGen) {
    await input.db.insert(aiDraftGeneration).values({
      id: generationId,
      transportId: input.transportId,
      threadId: input.threadId,
      requestedByUserId: input.requestedByUserId,
      contextMessageIds: [input.triggerMessageId],
      model: input.modelId ?? DEFAULT_AI_MODEL_ID,
      promptVersion: input.promptVersion ?? DEFAULT_HMS_CANDIDATE_PROMPT_VERSION,
      status: 'queued',
      threadStateVersion,
      evidence: [],
      createdAt: new Date(),
    });
  }
  if (!run.generationId) {
    await input.db
      .update(aiWorkflowRun)
      .set({ generationId, updatedAt: new Date() })
      .where(and(eq(aiWorkflowRun.id, run.id), sql`${aiWorkflowRun.generationId} IS NULL`));
  }

  return {
    runId: run.id,
    runState: run.state,
    idempotencyKey,
    threadStateVersion,
  };
}

export const draftsRouter = tRouter({
  list: mailboxProcedure
    .input(
      z.object({
        q: z.string().max(512).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
        threadId: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const parsedSearch = input.q && input.q.trim() ? parseDraftSearchQueryOrThrow(input.q) : null;
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const limit = input.limit;

      const conditions = [
        eq(mailDraft.transportId, transportId),
        eq(mailDraft.isSent, false),
        inArray(mailDraft.status, ['active', 'candidate']),
      ];

      if (input.threadId) {
        await requireThreadForTransport(db, input.threadId, transportId);
        conditions.push(eq(mailDraft.threadId, input.threadId));
      }

      if (parsedSearch) {
        conditions.push(...buildDraftSearchConditions(parsedSearch));
      }

      if (input.cursor) {
        const decoded = decodePageCursor(input.cursor);
        if (decoded) {
          conditions.push(keysetBefore(mailDraft.updatedAt, mailDraft.id, decoded.ts, decoded.id));
        } else {
          const cursorDraft = await db
            .select({ updatedAt: mailDraft.updatedAt, id: mailDraft.id })
            .from(mailDraft)
            .where(and(eq(mailDraft.id, input.cursor), eq(mailDraft.transportId, transportId)))
            .limit(1);
          if (cursorDraft.length > 0) {
            const row = cursorDraft[0]!;
            conditions.push(
              keysetBefore(mailDraft.updatedAt, mailDraft.id, row.updatedAt ?? new Date(0), row.id),
            );
          }
        }
      }

      let rows = await db
        .select()
        .from(mailDraft)
        .where(and(...conditions))
        .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
        .limit(limit + 1);

      let nextPageToken: string | null = null;
      if (rows.length > limit) {
        const last = rows[limit - 1]!;
        rows = rows.slice(0, limit);
        nextPageToken = encodePageCursor(last.updatedAt, last.id);
      }

      return {
        threads: rows.map((r) => toDraftWire(r)),
        nextPageToken,
      };
    }),

  get: mailboxProcedure.input(z.object({ id: z.string() })).query(async ({ input, ctx }) => {
    const db = getDb();
    const transportId = ctx.activeTransportId;
    const rows = await db
      .select()
      .from(mailDraft)
      .where(and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)))
      .limit(1);
    if (rows.length === 0) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: draft not found' });
    }
    const r = rows[0]!;
    return toDraftWire(r);
  }),

  /**
   * Bind an explicit human review of the current AI draft to one send
   * payload. The token is intentionally opaque and is re-read at send and
   * immediately before SMTP; it is never a general-purpose send grant.
   */
  approve: mailboxProcedure
    .input(
      z.object({
        draftId: z.string().min(1),
        subject: z.string(),
        html: z.string(),
        text: z.string().default(''),
        originalMessage: z.string().optional(),
        to: z.array(z.string()),
        cc: z.array(z.string()).default([]),
        bcc: z.array(z.string()).default([]),
        attachments: z.array(serializedAttachmentInput).default([]),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const [draft] = await db
        .select()
        .from(mailDraft)
        .where(
          and(
            eq(mailDraft.id, input.draftId),
            eq(mailDraft.transportId, transportId),
            eq(mailDraft.isSent, false),
            eq(mailDraft.status, 'active'),
            eq(mailDraft.origin, 'ai'),
          ),
        )
        .limit(1);
      if (!draft || !draft.generationId || !draft.threadId) {
        throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_REQUIRED' });
      }

      const [generation] = await db
        .select()
        .from(aiDraftGeneration)
        .where(
          and(
            eq(aiDraftGeneration.id, draft.generationId),
            eq(aiDraftGeneration.transportId, transportId),
            eq(aiDraftGeneration.threadId, draft.threadId),
          ),
        )
        .limit(1);
      const [latestRevision] = await db
        .select({ id: mailDraftRevision.id })
        .from(mailDraftRevision)
        .where(eq(mailDraftRevision.draftId, draft.id))
        .orderBy(desc(mailDraftRevision.createdAt), desc(mailDraftRevision.id))
        .limit(1);
      if (!generation || !latestRevision) {
        throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });
      }

      const threadStateVersion = await loadLiveThreadStateVersion(db, {
        transportId,
        threadId: draft.threadId,
      });
      const payload: DraftApprovalPayload = {
        draftId: draft.id,
        generationId: draft.generationId,
        transportId,
        threadId: draft.threadId,
        revisionId: latestRevision.id,
        threadStateVersion,
        evidence: generation.evidence ?? [],
        policyVersion: DRAFT_APPROVAL_POLICY_VERSION,
        approvedByUserId: ctx.sessionUser.id,
        approvedAt: new Date().toISOString(),
        origin: 'ai',
        subject: input.subject,
        html: prepareOutboundHtml(
          input.originalMessage?.trim() &&
            !input.html.includes(
              input.originalMessage
                .trim()
                .slice(0, Math.min(80, input.originalMessage.trim().length)),
            )
            ? `${input.html}${input.originalMessage}`
            : input.html,
        ),
        text: input.text,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        attachments: input.attachments.map((attachment) => ({
          filename: attachment.name,
          mimeType: attachment.type,
          sizeBytes: attachment.size,
          contentBase64: attachment.base64,
        })),
      };

      try {
        const signingSecret = getDraftApprovalSigningSecret();
        const approval = buildDraftApproval(payload, signingSecret);
        await assertDraftApprovalCurrent({
          db,
          approval,
          payload,
          loadThreadStateVersion: loadLiveThreadStateVersion,
          signingSecret,
        });
        return approval;
      } catch (error) {
        if (error instanceof DraftApprovalError) {
          throw new TRPCError({ code: 'CONFLICT', message: 'DRAFT_APPROVAL_INVALID' });
        }
        throw error;
      }
    }),

  ensureEditableForReply: mailboxProcedure
    .input(
      z.object({
        threadId: z.string(),
        replyToMessageId: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      const replyToMessageId = input.replyToMessageId;
      if (!replyToMessageId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'REPLY_PARENT_REQUIRED' });
      }
      await requireThreadForTransport(db, input.threadId, transportId);
      const replyParent = await requireMessageForTransport(db, replyToMessageId, transportId);
      if (replyParent.threadId !== input.threadId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'REPLY_PARENT_THREAD_MISMATCH' });
      }

      try {
        const promoted = await db.transaction(async (tx) => {
          const activeRows = await tx
            .select()
            .from(mailDraft)
            .where(
              and(
                eq(mailDraft.transportId, transportId),
                eq(mailDraft.threadId, input.threadId),
                eq(mailDraft.isSent, false),
                eq(mailDraft.status, 'active'),
              ),
            )
            .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
            .limit(1);

          const activeDraft = activeRows[0];
          if (activeDraft) return activeDraft;

          const candidateRows = await tx
            .select()
            .from(mailDraft)
            .where(
              and(
                eq(mailDraft.transportId, transportId),
                eq(mailDraft.threadId, input.threadId),
                eq(mailDraft.isSent, false),
                eq(mailDraft.status, 'candidate'),
                eq(mailDraft.origin, 'ai'),
                eq(mailDraft.replyToMessageId, replyToMessageId),
              ),
            )
            .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
            .limit(1);

          const candidate = candidateRows[0];
          if (!candidate) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'DRAFT_NOT_FOUND' });
          }

          await assertHmsDraftFreshForAction({
            db: tx as unknown as DB,
            transportId,
            draft: candidate,
            conflict: 'STALE_AI_CANDIDATE',
          });

          await tx
            .update(mailDraft)
            .set({ status: 'discarded', updatedAt: new Date() })
            .where(
              and(
                eq(mailDraft.transportId, transportId),
                eq(mailDraft.threadId, input.threadId),
                eq(mailDraft.status, 'candidate'),
                eq(mailDraft.origin, 'ai'),
                eq(mailDraft.replyToMessageId, replyToMessageId),
                sql`${mailDraft.id} <> ${candidate.id}`,
              ),
            );

          await tx
            .update(mailDraft)
            .set({ status: 'active', updatedAt: new Date() })
            .where(and(eq(mailDraft.id, candidate.id), eq(mailDraft.transportId, transportId)));

          await tx.insert(mailDraftRevision).values({
            id: randomUUID(),
            draftId: candidate.id,
            generationId: candidate.generationId,
            actorUserId: ctx.sessionUser.id,
            kind: 'promoted',
            toAddresses: candidate.toAddresses,
            ccAddresses: candidate.ccAddresses,
            bccAddresses: candidate.bccAddresses,
            subject: candidate.subject,
            textBody: candidate.textBody,
            htmlBody: candidate.htmlBody,
            attachments: [],
          });
          return { ...candidate, status: 'active' as const, updatedAt: new Date() };
        });
        return toDraftWire(promoted);
      } catch (error) {
        if (!isPostgresUniqueViolation(error)) throw error;
        const activeRows = await db
          .select()
          .from(mailDraft)
          .where(
            and(
              eq(mailDraft.transportId, transportId),
              eq(mailDraft.threadId, input.threadId),
              eq(mailDraft.isSent, false),
              eq(mailDraft.status, 'active'),
            ),
          )
          .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
          .limit(1);
        if (activeRows[0]) return toDraftWire(activeRows[0]);
        throw error;
      }
    }),

  create: mailboxProcedure.input(createDraftInput).mutation(async ({ input, ctx }) => {
    const db = getDb();
    const transportId = ctx.activeTransportId;
    if (input.threadId) {
      await requireThreadForTransport(db, input.threadId, transportId);
    }
    const draftId = input.id ?? randomUUID();
    const existing = await db
      .select()
      .from(mailDraft)
      .where(and(eq(mailDraft.id, draftId), eq(mailDraft.transportId, transportId)))
      .limit(1);
    const row = {
      threadId: input.threadId,
      replyToMessageId: input.replyToMessageId,
      toAddresses: input.to,
      ccAddresses: input.cc,
      bccAddresses: input.bcc,
      subject: input.subject || null,
      textBody: input.html || null,
      htmlBody: input.html || null,
      attachments: [] as { filename: string; mimeType: string; sizeBytes: number; s3Key: string }[],
      updatedAt: new Date(),
    };
    if (existing.length > 0) {
      const prior = existing[0]!;
      await db
        .update(mailDraft)
        .set({ ...row, status: 'active' as const })
        .where(and(eq(mailDraft.id, draftId), eq(mailDraft.transportId, transportId)));
      const changed =
        JSON.stringify(prior.toAddresses ?? []) !== JSON.stringify(row.toAddresses) ||
        JSON.stringify(prior.ccAddresses ?? []) !== JSON.stringify(row.ccAddresses) ||
        JSON.stringify(prior.bccAddresses ?? []) !== JSON.stringify(row.bccAddresses) ||
        prior.subject !== row.subject ||
        prior.textBody !== row.textBody ||
        prior.htmlBody !== row.htmlBody ||
        JSON.stringify(prior.attachments ?? []) !== JSON.stringify(row.attachments);
      if (changed) {
        await db.insert(mailDraftRevision).values({
          id: randomUUID(),
          draftId,
          generationId: prior.generationId,
          actorUserId: ctx.sessionUser.id,
          kind: 'edited',
          toAddresses: row.toAddresses,
          ccAddresses: row.ccAddresses,
          bccAddresses: row.bccAddresses,
          subject: row.subject,
          textBody: row.textBody,
          htmlBody: row.htmlBody,
          attachments: row.attachments,
        });
      }
      return { id: draftId };
    }

    try {
      await db.insert(mailDraft).values({
        id: draftId,
        transportId,
        createdByUserId: ctx.sessionUser.id,
        isSent: false,
        status: 'active',
        origin: 'manual',
        ...row,
      });
      await db.insert(mailDraftRevision).values({
        id: randomUUID(),
        draftId,
        actorUserId: ctx.sessionUser.id,
        kind: 'created',
        toAddresses: input.to,
        ccAddresses: input.cc,
        bccAddresses: input.bcc,
        subject: input.subject || null,
        textBody: input.html || null,
        htmlBody: input.html || null,
        attachments: [],
      });
      return { id: draftId };
    } catch (error) {
      // One active draft per thread — FE may omit draftId while latestDraft already exists.
      if (!isPostgresUniqueViolation(error) || !input.threadId) throw error;
      const activeRows = await db
        .select({ id: mailDraft.id })
        .from(mailDraft)
        .where(
          and(
            eq(mailDraft.transportId, transportId),
            eq(mailDraft.threadId, input.threadId),
            eq(mailDraft.isSent, false),
            eq(mailDraft.status, 'active'),
          ),
        )
        .orderBy(desc(mailDraft.updatedAt), desc(mailDraft.id))
        .limit(1);
      const activeId = activeRows[0]?.id;
      if (!activeId) throw error;
      await db
        .update(mailDraft)
        .set(row)
        .where(and(eq(mailDraft.id, activeId), eq(mailDraft.transportId, transportId)));
      return { id: activeId };
    }
  }),

  update: mailboxProcedure
    .input(
      z.object({
        id: z.string(),
        to: z.array(z.string()).optional(),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string().optional(),
        content: z.string().optional(),
        html: z.string().optional(),
        threadId: z.string().optional(),
        replyToMessageId: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const transportId = ctx.activeTransportId;
      // Verify ownership: draft must be on this transport.
      const existing = await db
        .select({ id: mailDraft.id })
        .from(mailDraft)
        .where(and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)))
        .limit(1);
      if (existing.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: draft not found' });
      }
      if (input.threadId) {
        await requireThreadForTransport(db, input.threadId, transportId);
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (input.to) patch.toAddresses = input.to;
      if (input.cc) patch.ccAddresses = input.cc;
      if (input.bcc) patch.bccAddresses = input.bcc;
      if (input.subject !== undefined) patch.subject = input.subject || null;
      if (input.content !== undefined) patch.textBody = input.content || null;
      if (input.html !== undefined) patch.htmlBody = input.html || null;
      if (input.threadId !== undefined) patch.threadId = input.threadId || null;
      if (input.replyToMessageId !== undefined) patch.replyToMessageId = input.replyToMessageId;
      await db
        .update(mailDraft)
        .set(patch)
        .where(and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)));

      const mergedRows = await db
        .select()
        .from(mailDraft)
        .where(and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)))
        .limit(1);
      const merged = mergedRows[0]!;
      const latestRevision = await db
        .select()
        .from(mailDraftRevision)
        .where(eq(mailDraftRevision.draftId, input.id))
        .orderBy(desc(mailDraftRevision.createdAt), desc(mailDraftRevision.id))
        .limit(1);

      const changed =
        latestRevision[0]?.subject !== merged.subject ||
        latestRevision[0]?.textBody !== merged.textBody ||
        latestRevision[0]?.htmlBody !== merged.htmlBody ||
        JSON.stringify(latestRevision[0]?.toAddresses ?? []) !==
          JSON.stringify(merged.toAddresses ?? []) ||
        JSON.stringify(latestRevision[0]?.ccAddresses ?? []) !==
          JSON.stringify(merged.ccAddresses ?? []) ||
        JSON.stringify(latestRevision[0]?.bccAddresses ?? []) !==
          JSON.stringify(merged.bccAddresses ?? []);

      if (changed) {
        await db.insert(mailDraftRevision).values({
          id: randomUUID(),
          draftId: input.id,
          generationId: merged.generationId,
          actorUserId: ctx.sessionUser.id,
          kind: 'edited',
          toAddresses: merged.toAddresses,
          ccAddresses: merged.ccAddresses,
          bccAddresses: merged.bccAddresses,
          subject: merged.subject,
          textBody: merged.textBody,
          htmlBody: merged.htmlBody,
          attachments: merged.attachments ?? [],
        });
      }
      return { id: input.id };
    }),

  delete: mailboxProcedure.input(z.object({ id: z.string() })).mutation(async ({ input, ctx }) => {
    const db = getDb();
    const transportId = ctx.activeTransportId;
    const existing = await db
      .select({ id: mailDraft.id })
      .from(mailDraft)
      .where(and(eq(mailDraft.id, input.id), eq(mailDraft.transportId, transportId)))
      .limit(1);
    if (existing.length === 0) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'NOT_FOUND: draft not found' });
    }
    await db
      .update(mailDraft)
      .set({ status: 'discarded', updatedAt: new Date() })
      .where(
        and(
          eq(mailDraft.id, input.id),
          eq(mailDraft.transportId, transportId),
          inArray(mailDraft.status, ['active', 'candidate']),
        ),
      );
    return { deleted: true };
  }),
});
