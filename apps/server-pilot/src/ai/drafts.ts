import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import {
  aiDraftGeneration,
  mailDraft,
  mailDraftRevision,
  message,
} from '../db/schema/mail.js';
import { computeThreadStateVersion } from './thread-context.js';

export class ThreadStateStaleError extends Error {
  constructor(message = 'thread state version stale') {
    super(message);
    this.name = 'ThreadStateStaleError';
  }
}

/** Fail closed when expected version does not match live thread hash. */
export function assertThreadStateVersionFresh(expected: string, live: string): void {
  if (expected !== live) throw new ThreadStateStaleError();
}

export async function loadLiveThreadStateVersion(
  db: DB,
  input: {
    transportId: string;
    threadId: string;
    latestDraftRevisionId?: string | null;
  },
): Promise<string> {
  const rows = await db
    .select({
      id: message.id,
      direction: message.direction,
      receivedAt: message.receivedAt,
      sentAt: message.sentAt,
    })
    .from(message)
    .where(
      and(eq(message.threadId, input.threadId), eq(message.transportId, input.transportId)),
    );

  return computeThreadStateVersion({
    messages: rows.map((m) => ({
      id: m.id,
      direction: (m.direction === 'outbound' ? 'outbound' : 'inbound') as
        | 'inbound'
        | 'outbound',
      timestamp:
        (m.sentAt ?? m.receivedAt)?.toISOString() ?? '1970-01-01T00:00:00.000Z',
    })),
    latestDraftRevisionId: input.latestDraftRevisionId ?? null,
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
  /** Same value used when context was built (worker currently passes null). */
  latestDraftRevisionId?: string | null;
  /**
   * When false (shadow / non-candidate), persist generation metrics only —
   * no mailDraft / revision rows.
   */
  persistDraft?: boolean;
}

export async function persistAiCandidateDraft(input: PersistAiCandidateDraftInput) {
  const persistDraft = input.persistDraft ?? true;
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
    if (existingDraft[0]) return existingDraft[0];

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
      const live = await loadLiveThreadStateVersion(tx as unknown as DB, {
        transportId: input.transportId,
        threadId: input.threadId,
        latestDraftRevisionId: input.latestDraftRevisionId ?? null,
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

  const [draft] = await input.db
    .select()
    .from(mailDraft)
    .where(eq(mailDraft.id, draftId))
    .limit(1);
  return draft!;
}
