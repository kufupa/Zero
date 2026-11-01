import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { aiDraftGeneration, aiWorkflowRun } from '../db/schema/mail.js';
import { assertHmsReadOriginAllowed } from '../hms/hms-read-target.js';
import { convertDocxWithGotenberg } from '../quote-proposal/gotenberg.js';
import { getS3Storage, type S3Storage } from '../storage/s3.js';
import { createDraftArtifactStorage, persistAiCandidateDraft, typedResultDigest, type ReservationistPersistedResult } from './drafts.js';
import { isDraftRouteReleaseDescriptor, type DraftModelRouteConfig } from './draft-route-factory.js';
import { sealReservationistDraftSource } from './reservationist-draft-source.js';
import { loadReservationistMailboxInput } from './reservationist-mailbox-input.js';
import { RESERVATIONIST_RUNTIME_VERSION, runReservationistRuntime, type RuntimePlan } from './reservationist-runtime.js';
import { markAiRunSucceeded, type AiRunFence, type AiWorkflowRun } from './run-ledger.js';

/** The ordinary worker may use this path only with a matching installed release. */
export async function runReservationistWorkerCandidate(options: {
  db: DB;
  run: AiWorkflowRun;
  fence: AiRunFence;
  route: DraftModelRouteConfig;
  replyTo: string;
  subject: string;
  signal: AbortSignal;
  s3?: S3Storage;
}) {
  const { db, run, fence, route, signal } = options;
  const release = route.release;
  const now = Date.now();
  if (!route.reservationist || !isDraftRouteReleaseDescriptor(release) || release.withdrawn ||
      Date.parse(release.issuedAt) > now || Date.parse(release.expiresAt) <= now ||
      release.capabilityFamilyVersions.reservationist !== RESERVATIONIST_RUNTIME_VERSION ||
      route.route.modelId !== run.modelId) throw new Error('reservationist_route_unavailable');
  const target = await assertHmsReadOriginAllowed({ transportId: run.transportId, threadId: run.threadId, messageId: run.triggerMessageId });
  if (target.propertyCode !== 'HRCEN') throw new Error('reservationist_property_unavailable');
  const s3 = options.s3 ?? getS3Storage();
  const gotenbergUrl = process.env.GOTENBERG_URL?.trim();
  const mailbox = await loadReservationistMailboxInput({
    db, runId: run.id, claimOwner: fence.claimOwner, claimToken: fence.claimToken,
    deadlineAt: fence.deadlineAt, propertyCode: target.propertyCode, s3, signal,
    ...(gotenbergUrl ? { officeConverter: (docx, edge) => convertDocxWithGotenberg(docx, { url: gotenbergUrl, signal: edge }) } : {}),
  });
  if (!run.generationId || mailbox.generationId !== run.generationId) throw new Error('reservationist_generation_unavailable');
  const provider = await route.reservationist({
    db, transportId: run.transportId, threadId: run.threadId, requestedByUserId: mailbox.requestedByUserId,
    generationId: mailbox.generationId, admissions: mailbox.admissions, input: mailbox.input, signal, fence,
    revalidateSources: mailbox.revalidateSources,
  });
  let selectedPlan: RuntimePlan | undefined;
  const runtime = await runReservationistRuntime(mailbox.input, {
    ...provider.dependencies,
    signal,
    plan: async (input, edge) => {
      selectedPlan = await provider.dependencies.plan(input, edge);
      return selectedPlan;
    },
  });
  if (!selectedPlan || !await mailbox.revalidateSources()) throw new Error('reservationist_source_changed');
  const result: ReservationistPersistedResult = {
    version: 1, readiness: runtime.readiness, tasks: runtime.tasks,
    quoteRevisionIds: runtime.quoteRefs, artifactRefs: runtime.artifacts.map((artifact) => artifact.ref),
    actionDigest: runtime.digest, quoteRevisions: runtime.quoteRevisions, proposalFacts: runtime.proposalFacts,
    importedOffers: runtime.importedOffers, approvedOverrides: runtime.approvedOverrides,
    rateComparisons: runtime.rateComparisons, packets: runtime.packets, readReceipts: runtime.readReceipts,
    existingDocumentReceipts: runtime.existingDocumentReceipts, readRecoveries: runtime.readRecoveries,
    preparedFacts: runtime.preparedFacts, recipientPreparations: runtime.recipientPreparations,
    currentNativeObservations: runtime.currentNativeObservations, sourceRecoveries: runtime.sourceRecoveries,
    paymentComparisons: runtime.paymentComparisons,
  };
  const source = await mailbox.createDraftSource(selectedPlan, result);
  const routeBinding = { ...route.route, release };
  const commonMetrics = { routeBinding, modelId: run.modelId, reservationistReadiness: runtime.readiness,
    ...(provider.collectUsage ? { modelUsage: provider.collectUsage() } : {}) };

  // Do not create an empty guest draft for a message with no current request.
  // A source needing manual review is not silently classified as no action.
  if (!runtime.tasks.length && runtime.readiness === 'no_action') {
    const resultDigest = typedResultDigest(result, []);
    await db.transaction(async (tx) => {
      const [claimed] = await tx.select().from(aiWorkflowRun).where(and(
        eq(aiWorkflowRun.id, run.id), eq(aiWorkflowRun.state, 'running'),
        eq(aiWorkflowRun.claimOwner, fence.claimOwner), eq(aiWorkflowRun.claimToken, fence.claimToken),
      )).limit(1).for('update');
      if (!claimed?.deadlineAt || claimed.deadlineAt.getTime() !== fence.deadlineAt.getTime() ||
          claimed.deadlineAt.getTime() <= Date.now() || !await mailbox.revalidateSources())
        throw new Error('reservationist_claim_stale');
      await tx.update(aiDraftGeneration).set({ status: 'succeeded', outcome: 'no_action',
        threadStateVersion: mailbox.threadStateVersion, contextMessageIds: mailbox.input.messages.map((message) => message.id),
      }).where(eq(aiDraftGeneration.id, mailbox.generationId));
      const marked = await markAiRunSucceeded({ runId: run.id, claimOwner: fence.claimOwner,
        claimToken: fence.claimToken, expectedStates: ['running'], generationId: mailbox.generationId,
        metrics: { ...commonMetrics, reservationistResult: result, resultDigest,
          reservationistDraftSource: sealReservationistDraftSource({ ...source, resultDigest }) },
      }, tx as unknown as DB);
      if (!marked) throw new Error('reservationist_claim_stale');
    });
    return { runId: run.id, state: 'succeeded' as const };
  }
  if (!runtime.tasks.length && (runtime.readiness !== 'needs_clarification' || !runtime.sourceRecoveries?.length))
    throw new Error('reservationist_source_review_required');

  const outcome = runtime.readiness === 'blocked' ? 'insufficient_evidence' :
    runtime.readiness === 'needs_clarification' ? 'needs_clarification' : 'candidate';
  await db.transaction(async (tx) => {
    const draft = await persistAiCandidateDraft({
      db: tx as unknown as DB, transportId: run.transportId, threadId: run.threadId,
      replyToMessageId: run.triggerMessageId, createdByUserId: mailbox.requestedByUserId,
      generationId: mailbox.generationId, model: run.modelId, promptVersion: run.promptVersion,
      contextMessageIds: mailbox.input.messages.map((message) => message.id), threadStateVersion: mailbox.threadStateVersion,
      toAddresses: [options.replyTo], subject: options.subject, textBody: runtime.textBody, htmlBody: runtime.htmlBody,
      outcome, persistDraft: true, routeBinding, workflowRunId: run.id, runFence: fence,
      reservationistResult: result, reservationistDraftSource: source,
      generatedArtifacts: provider.collectGeneratedArtifacts(),
      artifactStorage: provider.artifactStorage ?? createDraftArtifactStorage(s3),
      revalidateSources: mailbox.revalidateSources, signal,
    });
    const marked = await markAiRunSucceeded({ runId: run.id, claimOwner: fence.claimOwner,
      claimToken: fence.claimToken, expectedStates: ['running'], generationId: mailbox.generationId,
      metrics: { ...commonMetrics, draftId: draft.id },
    }, tx as unknown as DB);
    if (!marked) throw new Error('reservationist_claim_stale');
  });
  return { runId: run.id, state: 'succeeded' as const };
}
