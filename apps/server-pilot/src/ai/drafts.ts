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
import type { DB } from '../db/client.js';
import { randomUUID } from 'node:crypto';

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
}

export async function persistAiCandidateDraft(input: PersistAiCandidateDraftInput) {
  const persistDraft = input.persistDraft ?? false;
  const outcome = input.outcome ?? 'candidate';
  const evidence = input.evidence ?? [];

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

  const draftId = randomUUID();
  const revisionId = randomUUID();
  const now = new Date();

  await input.db.transaction(async (tx) => {
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
      attachments: [],
      createdAt: now,
    });
  });

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
