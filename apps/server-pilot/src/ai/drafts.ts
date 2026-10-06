import {
  canonicalJson,
  resolveDraftApprovalRouteBinding,
  type DraftApprovalRouteBinding,
} from './draft-approval.js';
import {
  aiDraftGeneration,
  aiWorkflowRun,
  mailDraft,
  mailDraftRevision,
  message,
} from '../db/schema/mail.js';
import { and, desc, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import { computeThreadStateVersion } from './thread-context.js';
import { getS3Storage, type S3Storage } from '../storage/s3.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DB } from '../db/client.js';

export class ThreadStateStaleError extends Error {
  constructor(message = 'thread state version stale') {
    super(message);
    this.name = 'ThreadStateStaleError';
  }
}

/** A retry must not reuse an edited body under a different AI release. */
export class DraftGenerationRouteMismatchError extends Error {
  constructor(message = 'draft generation route release changed') {
    super(message);
    this.name = 'DraftGenerationRouteMismatchError';
  }
}

/**
 * Revision kinds that participate in threadStateVersion.
 * Exclude `ai_generated` so candidate persist does not immediately self-stale.
 * Sent / edited / promoted / created = human or outbound state change.
 */
export const THREAD_STATE_REVISION_KINDS = ['created', 'promoted', 'edited', 'sent'] as const;

/** Fail closed when expected version does not match live thread hash. */
export function assertThreadStateVersionFresh(expected: string, live: string): void {
  if (expected !== live) throw new ThreadStateStaleError();
}

/**
 * Latest thread-affecting draft revision for transport+thread.
 * Used by threadStateVersion so sent revision / completed actions mark stale.
 */
export async function loadLatestThreadAffectingDraftRevisionId(
  db: DB,
  input: {
    transportId: string;
    threadId: string;
    /** Queue revalidation may omit its own sent revision. */
    excludeSentMessageIds?: readonly string[];
  },
): Promise<string | null> {
  const revisionConditions = [
    eq(mailDraft.transportId, input.transportId),
    eq(mailDraft.threadId, input.threadId),
    inArray(mailDraftRevision.kind, [...THREAD_STATE_REVISION_KINDS]),
  ];
  if (input.excludeSentMessageIds?.length) {
    revisionConditions.push(
      or(
        isNull(mailDraftRevision.sentMessageId),
        notInArray(mailDraftRevision.sentMessageId, [...input.excludeSentMessageIds]),
      )!,
    );
  }
  const [row] = await db
    .select({ id: mailDraftRevision.id })
    .from(mailDraftRevision)
    .innerJoin(mailDraft, eq(mailDraftRevision.draftId, mailDraft.id))
    .where(and(...revisionConditions))
    .orderBy(desc(mailDraftRevision.createdAt), desc(mailDraftRevision.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Live thread state version (messages + latest thread-affecting draft revision).
 * Omit `latestDraftRevisionId` to load live from DB; pass explicit value to
 * pin (tests / fence with a known snapshot).
 */
export async function loadLiveThreadStateVersion(
  db: DB,
  input: {
    transportId: string;
    threadId: string;
    latestDraftRevisionId?: string | null;
    /** Queue revalidation may exclude its own unsent outbound message. */
    excludeMessageIds?: readonly string[];
    /** Queue revalidation may exclude its own sent draft revision. */
    excludeSentMessageIds?: readonly string[];
  },
): Promise<string> {
  const messageConditions = [
    eq(message.threadId, input.threadId),
    eq(message.transportId, input.transportId),
  ];
  if (input.excludeMessageIds?.length) {
    messageConditions.push(notInArray(message.id, [...input.excludeMessageIds]));
  }
  const rows = await db
    .select({
      id: message.id,
      direction: message.direction,
      receivedAt: message.receivedAt,
      sentAt: message.sentAt,
    })
    .from(message)
    .where(and(...messageConditions));

  const latestDraftRevisionId =
    input.latestDraftRevisionId !== undefined
      ? input.latestDraftRevisionId
      : await loadLatestThreadAffectingDraftRevisionId(db, {
          transportId: input.transportId,
          threadId: input.threadId,
          excludeSentMessageIds: input.excludeSentMessageIds,
        });

  return computeThreadStateVersion({
    messages: rows.map((m) => ({
      id: m.id,
      direction: (m.direction === 'outbound' ? 'outbound' : 'inbound') as 'inbound' | 'outbound',
      timestamp: (m.sentAt ?? m.receivedAt)?.toISOString() ?? '1970-01-01T00:00:00.000Z',
    })),
    latestDraftRevisionId,
  });
}

export type GeneratedDraftArtifact = {
  artifactRef: string;
  filename: string;
  mimeType: 'application/pdf';
  body: Buffer;
  sha256: string;
};
export type PersistedGeneratedArtifact = {
  artifactRef: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  s3Key: string;
  sourceHash: string;
  generationId: string;
};
export type DraftArtifactStorage = {
  stage: (key: string, body: Buffer, mimeType: string) => Promise<void>;
  read: (key: string) => Promise<Buffer | null>;
};
export function createDraftArtifactStorage(
  storage: S3Storage = getS3Storage(),
): DraftArtifactStorage {
  return {
    stage: async (key, body, mimeType) => {
      await storage.putObject({ key, body, contentType: mimeType });
    },
    read: async (key) =>
      (await storage.getObjectBounded(key, 20 * 1024 * 1024, new AbortController().signal))?.body ??
      null,
  };
}
export type ReservationistPersistedResult = {
  version: 1;
  readiness: string;
  tasks: unknown[];
  quoteRevisionIds: string[];
  artifactRefs: string[];
  actionDigest: string;
  quoteRevisions?: unknown[];
  proposalFacts?: { ref: string; facts: unknown }[];
  importedOffers?: unknown[];
  approvedOverrides?: unknown[];
  rateComparisons?: unknown[];
  packets?: unknown[];
  readReceipts?: unknown[];
  existingDocumentReceipts?: unknown[];
  readRecoveries?: unknown[];
  preparedFacts?: import('./prepared-draft-input.js').PreparedFact[];
  recipientPreparations?: import('./reservationist-recipient-preparation.js').RecipientPreparationReceipt[];
  currentNativeObservations?: import('./reservationist-execution.js').CurrentNativeObservationReceipt[];
  sourceRecoveries?: import('./reservationist-runtime.js').RuntimeWorkResult['sourceRecoveries'];
  paymentComparisons?: unknown[];
};
export function typedResultDigest(
  result: ReservationistPersistedResult,
  artifacts: readonly PersistedGeneratedArtifact[],
): string {
  return createHash('sha256')
    .update(canonicalJson({ result, artifacts: artifacts.map(({ s3Key, ...safe }) => safe) }))
    .digest('hex');
}

export interface PersistAiCandidateDraftInput {
  db: DB;
  transportId: string;
  threadId: string;
  replyToMessageId: string;
  createdByUserId: string;
  generationId: string;
  model: string;
  promptVersion: string;
  contextMessageIds: string[];
  toAddresses: string[];
  ccAddresses?: string[];
  bccAddresses?: string[];
  subject: string;
  textBody: string;
  htmlBody: string;
  /** HMS enrichment outcome; omitted for legacy skeleton. */
  outcome?: 'candidate' | 'needs_clarification' | 'insufficient_evidence';
  evidence?: unknown[];
  threadStateVersion?: string;
  /**
   * Revision id baked into threadStateVersion at context build.
   * Fence reloads live revision; this is retained for callers/metrics.
   */
  latestDraftRevisionId?: string | null;
  /**
   * When false (shadow / non-candidate), persist generation metrics only —
   * no mailDraft / revision rows.
   */
  persistDraft?: boolean;
  /** Complete trusted route/release provenance for a normal candidate run. */
  routeBinding?: DraftApprovalRouteBinding;
  workflowRunId?: string;
  runFence?: { claimOwner: string; claimToken: string; deadlineAt: Date };
  reservationistResult?: ReservationistPersistedResult;
  generatedArtifacts?: GeneratedDraftArtifact[];
  artifactStorage?: DraftArtifactStorage;
  signal?: AbortSignal;
  revalidateSources?: () => Promise<boolean>;
  /** Track only objects staged by this invocation; no deletion of reused files. */
  onGeneratedOrphans?: (keys: readonly string[]) => void;
}

export async function persistAiCandidateDraft(input: PersistAiCandidateDraftInput) {
  const persistDraft = input.persistDraft ?? false;
  const outcome = input.outcome ?? 'candidate';
  const evidence = input.evidence ?? [];

  if (
    input.reservationistResult &&
    persistDraft &&
    (!input.revalidateSources || !(await input.revalidateSources()))
  )
    throw new Error('draft_source_revalidation_failed');
  const existingGeneration = await input.db
    .select({ id: aiDraftGeneration.id })
    .from(aiDraftGeneration)
    .where(eq(aiDraftGeneration.id, input.generationId))
    .limit(1);

  if (existingGeneration.length > 0) {
    const existingDraft = await input.db
      .select()
      .from(mailDraft)
      .where(
        and(
          eq(mailDraft.generationId, input.generationId),
          eq(mailDraft.transportId, input.transportId),
        ),
      )
      .limit(1);
    if (existingDraft[0]) {
      if (input.reservationistResult && persistDraft) {
        await input.db.transaction(async (tx) => {
          const fence = input.runFence;
          if (!fence) throw new Error('draft_claim_fence_required');
          const [run] = await tx
            .select()
            .from(aiWorkflowRun)
            .where(
              and(
                eq(aiWorkflowRun.id, input.workflowRunId!),
                eq(aiWorkflowRun.transportId, input.transportId),
                eq(aiWorkflowRun.threadId, input.threadId),
                eq(aiWorkflowRun.triggerMessageId, input.replyToMessageId),
                eq(aiWorkflowRun.state, 'running'),
                eq(aiWorkflowRun.claimOwner, fence.claimOwner),
                eq(aiWorkflowRun.claimToken, fence.claimToken),
              ),
            )
            .limit(1)
            .for('update');
          if (
            !run ||
            !run.deadlineAt ||
            run.deadlineAt.getTime() !== fence.deadlineAt.getTime() ||
            run.deadlineAt.getTime() <= Date.now()
          )
            throw new Error('draft_claim_fence_stale');
          const [generation] = await tx
            .select()
            .from(aiDraftGeneration)
            .where(eq(aiDraftGeneration.id, input.generationId))
            .limit(1);
          if (
            !generation ||
            generation.transportId !== input.transportId ||
            generation.threadId !== input.threadId ||
            generation.requestedByUserId !== input.createdByUserId ||
            existingDraft[0].threadId !== input.threadId
          )
            throw new Error('draft_retry_scope_mismatch');
          if (
            canonicalJson(run.metrics?.reservationistResult) !==
              canonicalJson(input.reservationistResult) ||
            run.metrics?.resultDigest !==
              typedResultDigest(
                input.reservationistResult!,
                existingDraft[0].attachments as PersistedGeneratedArtifact[],
              )
          )
            throw new Error('draft_retry_result_mismatch');
          if (!input.revalidateSources || !(await input.revalidateSources()))
            throw new Error('draft_source_revalidation_failed');
        });
      }

      if (persistDraft && existingDraft[0].attachments.length) {
        if (!input.artifactStorage) throw new Error('artifact_storage_unavailable');
        for (const raw of existingDraft[0].attachments) {
          const artifact = raw as typeof raw & { sourceHash?: string };
          const current = await input.artifactStorage.read(artifact.s3Key);
          if (
            !current ||
            current.length !== artifact.sizeBytes ||
            createHash('sha256').update(current).digest('hex') !== artifact.sourceHash
          )
            throw new Error('artifact_identity_changed');
        }
      }

      if (persistDraft && input.routeBinding && existingDraft[0].origin === 'ai') {
        const [previousRun] = await input.db
          .select({ metrics: aiWorkflowRun.metrics })
          .from(aiWorkflowRun)
          .where(
            and(
              eq(aiWorkflowRun.generationId, input.generationId),
              eq(aiWorkflowRun.runKind, 'candidate_draft'),
              eq(aiWorkflowRun.state, 'succeeded'),
            ),
          )
          .orderBy(desc(aiWorkflowRun.finishedAt), desc(aiWorkflowRun.createdAt))
          .limit(1);
        const previousBinding = resolveDraftApprovalRouteBinding(previousRun?.metrics);
        if (
          !previousBinding ||
          canonicalJson(previousBinding) !== canonicalJson(input.routeBinding)
        ) {
          throw new DraftGenerationRouteMismatchError();
        }
      }
      return existingDraft[0];
    }

    const existingRevision = await input.db
      .select({ draftId: mailDraftRevision.draftId })
      .from(mailDraftRevision)
      .where(eq(mailDraftRevision.generationId, input.generationId))
      .limit(1);
    if (existingRevision[0]) {
      const [draftByRevision] = await input.db
        .select()
        .from(mailDraft)
        .where(eq(mailDraft.id, existingRevision[0].draftId))
        .limit(1);
      if (draftByRevision) return draftByRevision;
    }

    if (!persistDraft) {
      const [gen] = await input.db
        .select()
        .from(aiDraftGeneration)
        .where(eq(aiDraftGeneration.id, input.generationId))
        .limit(1);
      return {
        ...gen,
        id: undefined as unknown as string,
        generationId: input.generationId,
        status: 'candidate' as const,
      };
    }
  }

  const artifacts: PersistedGeneratedArtifact[] = [];
  const stagedKeys: string[] = [];
  if (input.signal?.aborted) throw new Error('draft_cancelled');
  if (persistDraft && (input.generatedArtifacts?.length || input.reservationistResult)) {
    if (
      !input.reservationistResult ||
      !input.workflowRunId ||
      !input.artifactStorage ||
      input.reservationistResult.version !== 1 ||
      Buffer.byteLength(canonicalJson(input.reservationistResult), 'utf8') > 256 * 1024 ||
      input.reservationistResult.tasks.length > 32 ||
      input.reservationistResult.artifactRefs.length > 16 ||
      !/^[a-f0-9]{64}$/.test(input.reservationistResult.actionDigest)
    )
      throw new Error('artifact_result_contract_invalid');
    if ((input.generatedArtifacts?.length ?? 0) > 16) throw new Error('artifact_limit');
    const refs = new Set<string>();
    try {
      for (const artifact of input.generatedArtifacts ?? []) {
        if (
          refs.has(artifact.artifactRef) ||
          !/^generated:[a-zA-Z0-9_-]{1,128}$/.test(artifact.artifactRef) ||
          artifact.mimeType !== 'application/pdf' ||
          !artifact.filename ||
          artifact.filename.length > 160 ||
          /[\\/\r\n]/.test(artifact.filename) ||
          artifact.body.length < 5 ||
          artifact.body.length > 20 * 1024 * 1024 ||
          artifact.body.subarray(0, 5).toString() !== '%PDF-' ||
          createHash('sha256').update(artifact.body).digest('hex') !== artifact.sha256
        )
          throw new Error('artifact_invalid');
        refs.add(artifact.artifactRef);
        const key = `generated-drafts/${input.transportId}/${input.generationId}/${randomUUID()}.pdf`;
        await input.artifactStorage.stage(key, artifact.body, artifact.mimeType);
        stagedKeys.push(key);
        const verified = await input.artifactStorage.read(key);
        if (
          !verified ||
          verified.length !== artifact.body.length ||
          createHash('sha256').update(verified).digest('hex') !== artifact.sha256
        )
          throw new Error('artifact_verification_failed');
        artifacts.push({
          artifactRef: artifact.artifactRef,
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          sizeBytes: verified.length,
          s3Key: key,
          sourceHash: artifact.sha256,
          generationId: input.generationId,
        });
      }
      if (
        input.reservationistResult.artifactRefs.some((ref) => !refs.has(ref)) ||
        refs.size !== input.reservationistResult.artifactRefs.length
      )
        throw new Error('artifact_result_refs_mismatch');
    } catch (error) {
      input.onGeneratedOrphans?.(stagedKeys);
      throw error;
    }
  }
  const draftId = randomUUID();
  const revisionId = randomUUID();
  const now = new Date();

  try {
    await input.db.transaction(async (tx) => {
      if (input.signal?.aborted) throw new Error('draft_cancelled');
      if (input.reservationistResult && persistDraft) {
        const fence = input.runFence;
        if (
          !fence ||
          !fence.claimOwner ||
          !fence.claimToken ||
          !Number.isFinite(fence.deadlineAt.getTime())
        )
          throw new Error('draft_claim_fence_required');
        const [claimed] = await tx
          .select()
          .from(aiWorkflowRun)
          .where(
            and(
              eq(aiWorkflowRun.id, input.workflowRunId!),
              eq(aiWorkflowRun.transportId, input.transportId),
              eq(aiWorkflowRun.threadId, input.threadId),
              eq(aiWorkflowRun.triggerMessageId, input.replyToMessageId),
              eq(aiWorkflowRun.state, 'running'),
              eq(aiWorkflowRun.claimOwner, fence.claimOwner),
              eq(aiWorkflowRun.claimToken, fence.claimToken),
            ),
          )
          .limit(1)
          .for('update');
        if (
          !claimed ||
          !claimed.deadlineAt ||
          claimed.deadlineAt.getTime() !== fence.deadlineAt.getTime() ||
          claimed.deadlineAt.getTime() <= Date.now()
        )
          throw new Error('draft_claim_fence_stale');
        if (!input.revalidateSources || !(await input.revalidateSources()))
          throw new Error('draft_source_revalidation_failed');
      }

      if (input.threadStateVersion) {
        // Live messages + thread-affecting revision (not pinned to context snapshot).
        const live = await loadLiveThreadStateVersion(tx as unknown as DB, {
          transportId: input.transportId,
          threadId: input.threadId,
        });
        assertThreadStateVersionFresh(input.threadStateVersion, live);
      }

      await tx
        .insert(aiDraftGeneration)
        .values({
          id: input.generationId,
          transportId: input.transportId,
          threadId: input.threadId,
          requestedByUserId: input.createdByUserId,
          contextMessageIds: input.contextMessageIds,
          model: input.model,
          promptVersion: input.promptVersion,
          status: 'succeeded',
          outcome,
          threadStateVersion: input.threadStateVersion ?? null,
          evidence,
          createdAt: now,
        })
        .onConflictDoNothing();

      if (existingGeneration.length > 0) {
        await tx
          .update(aiDraftGeneration)
          .set({
            outcome,
            threadStateVersion: input.threadStateVersion ?? null,
            evidence,
            status: 'succeeded',
          })
          .where(eq(aiDraftGeneration.id, input.generationId));
      }

      if (input.reservationistResult && persistDraft) {
        const [run] = await tx
          .select()
          .from(aiWorkflowRun)
          .where(
            and(
              eq(aiWorkflowRun.id, input.workflowRunId!),
              eq(aiWorkflowRun.transportId, input.transportId),
              eq(aiWorkflowRun.threadId, input.threadId),
              eq(aiWorkflowRun.triggerMessageId, input.replyToMessageId),
              eq(aiWorkflowRun.runKind, 'candidate_draft'),
            ),
          )
          .limit(1);
        if (!run) throw new Error('artifact_run_scope_invalid');
        await tx
          .update(aiWorkflowRun)
          .set({
            generationId: input.generationId,
            metrics: {
              ...(run.metrics ?? {}),
              reservationistResult: input.reservationistResult,
              resultDigest: typedResultDigest(input.reservationistResult, artifacts),
            },
          })
          .where(eq(aiWorkflowRun.id, run.id));
      }
      if (input.signal?.aborted) throw new Error('draft_cancelled');
      if (!persistDraft) return;

      // Atomic replace: supersede older visible AI candidates for this thread.
      await tx
        .update(mailDraft)
        .set({ status: 'discarded', updatedAt: now })
        .where(
          and(
            eq(mailDraft.transportId, input.transportId),
            eq(mailDraft.threadId, input.threadId),
            eq(mailDraft.isSent, false),
            eq(mailDraft.status, 'candidate'),
            eq(mailDraft.origin, 'ai'),
          ),
        );

      await tx.insert(mailDraft).values({
        id: draftId,
        transportId: input.transportId,
        threadId: input.threadId,
        createdByUserId: input.createdByUserId,
        status: 'candidate',
        origin: 'ai',
        replyToMessageId: input.replyToMessageId,
        generationId: input.generationId,
        toAddresses: input.toAddresses,
        ccAddresses: input.ccAddresses ?? [],
        bccAddresses: input.bccAddresses ?? [],
        subject: input.subject,
        textBody: input.textBody,
        htmlBody: input.htmlBody,
        attachments: artifacts,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(mailDraftRevision).values({
        id: revisionId,
        draftId,
        generationId: input.generationId,
        kind: 'ai_generated',
        toAddresses: input.toAddresses,
        ccAddresses: input.ccAddresses ?? [],
        bccAddresses: input.bccAddresses ?? [],
        subject: input.subject,
        textBody: input.textBody,
        htmlBody: input.htmlBody,
        attachments: artifacts,
        createdAt: now,
      });
      if (input.signal?.aborted) throw new Error('draft_cancelled');
    });
  } catch (error) {
    input.onGeneratedOrphans?.(stagedKeys);
    throw error;
  }

  if (!persistDraft) {
    return {
      id: undefined as unknown as string,
      generationId: input.generationId,
      status: 'candidate' as const,
    };
  }

  const [draft] = await input.db.select().from(mailDraft).where(eq(mailDraft.id, draftId)).limit(1);
  return draft!;
}
