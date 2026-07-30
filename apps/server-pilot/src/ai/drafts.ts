import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import {
  aiDraftGeneration,
  mailDraft,
  mailDraftRevision,
} from '../db/schema/mail.js';

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
