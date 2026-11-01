import { RESERVATION_EVIDENCE_TTL_MS } from '../hms/adapter.js';
import { createPostgresPropertyReadLock, propertyReadLockKey } from '../hms/property-read-lock.js';
import { assertHmsReadOriginAllowed } from '../hms/hms-read-target.js';
import { confirmationMatches, confirmationSearchValues } from '../hms/confirmation-match.js';
import { isDocxMimeType } from '../mail/artifacts/read-artifact.js';
import { quoteDigest } from '../quote-proposal/quote-revision.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ModelAdapter } from './bedrock/adapter.js';
import { maskIncomingCardNumbers } from './card-mask.js';
import type { ReservationistProvider } from './draft-route-factory.js';
import { createReservationistDependencies, currentAuthoredGuestRequest, deriveRequestedArrivalAcknowledgement, type ReservationistExecutionServices } from './reservationist-execution.js';
import type { ReservationistCancellationReview, ReservationistPendingActionEvidence } from './reservationist-pending-action.js';
import type { ReservationistRuntimeInput, RuntimeSourceRecovery } from './reservationist-runtime.js';
import { paneStayPropertyLock, paneStayTenantId } from './pane-stay-save.js';
import { getInstalledStaffQuoteServices, readInstalledStaffQuoteConfiguration } from './staff-quote-installation.js';

type CancellationToolRequest =
  | { tool: 'read'; confirmation: string }
  | { tool: 'prepareCancellation'; requestedScope: 'unspecified' };
type CancellationToolResult = {
  outcome?: unknown;
  issue?: unknown;
  observedAt?: unknown;
  searchResults?: { complete?: unknown; total?: unknown };
  shallow?: { confirmation?: unknown };
  target?: { confirmation?: unknown; verified?: unknown };
  stay?: {
    status?: { state?: unknown; value?: unknown };
    arrivalDate?: { state?: unknown; value?: unknown };
    departureDate?: { state?: unknown; value?: unknown };
  };
  roomScope?: { requested?: unknown; state?: unknown; complete?: unknown };
  policy?: { state?: unknown };
  fee?: { state?: unknown; amount?: unknown; currency?: unknown };
  action?: { actor?: unknown; cancellationStarted?: unknown; commitAvailable?: unknown };
};
type SavedStaySession = {
  runTool(request: CancellationToolRequest): Promise<CancellationToolResult>;
};
type SavedStaySessionOptions = { signal?: AbortSignal };
type SavedStaySessionModule = {
  withSavedStayAgentSession<T>(operation: (session: SavedStaySession) => Promise<T>, options?: SavedStaySessionOptions): Promise<T>;
};
type CancellationPreflightModule = { parseDateDisplay(value: string): string | null };
const savedStaySessionUrl = new URL('../../tooling/hms-cloud/saved-stay-agent-session.mjs', import.meta.url);
const cancellationPreflightUrl = new URL('../../tooling/hms-cloud/guest-stay-cancel-preflight.mjs', import.meta.url);

async function withSavedStayAgentSession<T>(operation: (session: SavedStaySession) => Promise<T>, options?: SavedStaySessionOptions): Promise<T> {
  const module = await import(pathToFileURL(fileURLToPath(savedStaySessionUrl)).href) as SavedStaySessionModule;
  return module.withSavedStayAgentSession(operation, options);
}

async function normalizeHmsDate(value: unknown): Promise<string | null> {
  if (typeof value !== 'string') return null;
  const module = await import(pathToFileURL(fileURLToPath(cancellationPreflightUrl)).href) as CancellationPreflightModule;
  return module.parseDateDisplay(value);
}

function cancellationReviewOf(value: CancellationToolResult): ReservationistCancellationReview | null {
  if (value.outcome !== 'prepared_for_human_review' || value.roomScope?.requested !== 'unspecified' ||
      value.roomScope.state !== 'unresolved' || value.roomScope.complete !== false || value.policy?.state !== 'unknown' ||
      value.fee?.state !== 'unknown_precommit' || value.fee.amount !== null || value.fee.currency !== null ||
      value.action?.actor !== 'human' || value.action.cancellationStarted !== false || value.action.commitAvailable !== false)
    return null;
  return {
    outcome: 'prepared_for_human_review',
    roomScope: { state: 'unresolved', complete: false },
    policy: { state: 'unknown' },
    fee: { state: 'unknown_precommit', amount: null, currency: null },
    action: { actor: 'human', cancellationStarted: false, commitAvailable: false },
  };
}

/**
 * Compose the real quote reader with the shared reservationist runtime.
 * Installation/release is deliberately separate from this factory.
 */
export function createInstalledReservationistProvider(
  adapter: ModelAdapter,
  savedStaySession = withSavedStayAgentSession,
): ReservationistProvider {
  return async (context) => {
    const inputIdentity = (input: ReservationistRuntimeInput) => {
      const { sourceAt: _sourceAt, ...clock } = input.clock;
      return quoteDigest({ ...input, clock });
    };
    const originalIdentity = inputIdentity(context.input);
    if (context.input.propertyCode !== 'HRCEN' ||
        context.input.authorizationScope?.ownerRef !== context.transportId ||
        context.input.authorizationScope.threadId !== context.threadId ||
        context.input.clock.sourceMode !== 'current_read' ||
        context.input.capabilities.pmsWrite !== false || context.input.capabilities.emailSend !== false)
      throw new Error('reservationist_provider_scope_invalid');
    const fresh = async (input: ReservationistRuntimeInput = context.input) => {
      context.signal.throwIfAborted();
      if (inputIdentity(input) !== originalIdentity || !await context.revalidateSources() ||
          inputIdentity(input) !== originalIdentity) throw new Error('reservationist_source_changed');
      context.signal.throwIfAborted();
    };

    // Extracted, card-masked document text remains useful. Original PDFs and
    // pictures cannot be proved card-free by inspecting their headers, so the
    // unexamined visual content stays visible as a staff task.
    const visualReason = 'visual_content_requires_staff_review';
    const visualTextSources = context.admissions.filter((admission) => admission.status === 'admitted')
      .filter((admission) => (admission.metadata.mimeType === 'application/pdf' || isDocxMimeType(admission.metadata.mimeType)) &&
        admission.source?.pages?.some((page) => page.trim()));
    const visualRecoveries: RuntimeSourceRecovery[] = visualTextSources.map(({ metadata: m }) => ({
      kind: 'attachment_manual', reason: visualReason, sourceRef: m.attachmentId, sourceHash: m.sourceHash,
      sourceKind: 'attachment', messageId: m.messageId, mimeType: m.mimeType,
      signatureNoise: m.signatureNoise === true, disclosure: 'staff_only',
      provenance: { reason: visualReason, taskIds: [], sources: [{ attachmentId: m.attachmentId, sourceHash: m.sourceHash }] },
    }));
    const admissions = context.admissions.map((admission) => {
      if (admission.status !== 'admitted') return admission;
      const media = admission.metadata.mimeType === 'application/pdf' || admission.metadata.mimeType.startsWith('image/');
      if (media && !admission.source?.pages?.some((page) => page.trim())) {
        const { bytes: _bytes, source: _source, ...rest } = admission;
        return { ...rest, status: 'manual_required' as const, reason: visualReason };
      }
      return admission;
    });
    const assertMasked = (input: ReservationistRuntimeInput) => {
      const text = [
        ...input.messages.flatMap((message) => [message.text, message.subject ?? '']),
        ...(input.requiredAskSpans ?? []).map((ask) => ask.text),
        ...admissions.flatMap((admission) => admission.source?.pages ?? []),
      ];
      if (text.some((value) => maskIncomingCardNumbers(value) !== value))
        throw new Error('reservationist_text_not_masked');
    };
    const textOnlyAdapter: ModelAdapter = {
      ...(adapter.reserveCalls ? { reserveCalls: (count, signal) => adapter.reserveCalls!(count, signal) } : {}),
      invoke: (request) => { assertMasked(context.input); return adapter.invoke({ ...request, files: [], images: [] }); },
    };
    const basicServices: ReservationistExecutionServices = {
      resolveRequestedArrivalAcknowledgement: async (ctx) => deriveRequestedArrivalAcknowledgement(ctx),
    };
    let activeServices = basicServices;
    const services = new Proxy({} as ReservationistExecutionServices, {
      get: (_target, key) => Reflect.get(activeServices, key),
    });
    const factory = createReservationistDependencies({
      adapter: textOnlyAdapter, admissions,
      header: { attention: '', company: '', clientEmail: '', clientTelephone: '', agency: '', signerName: '', signerEmail: '' },
      converter: { url: process.env.GOTENBERG_URL ?? '' }, services,
    });
    const addVisualWarnings = (existing: RuntimeSourceRecovery[] = []) => [...existing, ...visualRecoveries];
    return {
      ...factory,
      dependencies: {
        ...factory.dependencies,
        signal: context.signal,
        currentReadEvaluation: true,
        plan: async (input, signal) => {
          await fresh(input);
          assertMasked(input);
          const plan = await factory.dependencies.plan(input, signal);
          await fresh(input);
          if (visualRecoveries.length && plan.noAction) {
            plan.noAction = { ...plan.noAction, kind: 'source_review' };
            plan.sourceRecoveries = addVisualWarnings(plan.sourceRecoveries);
          }
          return plan;
        },
        execute: async (plan, input, signal, evaluation) => {
          const run = async () => {
            await fresh(input);
            const work = await factory.dependencies.execute(plan, input, signal, evaluation);
            await fresh(input);
            work.sourceRecoveries = addVisualWarnings(work.sourceRecoveries);
            return work;
          };
          const needsQuote = plan.tasks.some((task) => task.kind === 'quote');
          const needsCancellationRead = plan.tasks.some((task) => task.kind === 'cancel_request');
          if (!needsQuote && !needsCancellationRead) return run();
          let config: ReturnType<typeof readInstalledStaffQuoteConfiguration> | undefined;
          try { config = readInstalledStaffQuoteConfiguration(input.propertyCode); }
          catch { /* cancellation reads have their own property-lock authority */ }
          const quoteConfigReady = config?.owner.propertyCode === input.propertyCode;
          const databaseUrl = process.env.DATABASE_URL;
          if (!databaseUrl || needsQuote && !quoteConfigReady && !needsCancellationRead) return run();
          const assertOrigin = async () => {
            await fresh(input);
            const target = await assertHmsReadOriginAllowed({ transportId: context.transportId, threadId: context.threadId, messageId: input.trigger.id });
            if (target.propertyCode !== input.propertyCode) throw new Error('reservationist_property_origin_invalid');
            await fresh(input);
            return target;
          };
          let lock: ReturnType<typeof createPostgresPropertyReadLock> | ReturnType<typeof paneStayPropertyLock>;
          let tenantId: string;
          if (quoteConfigReady) {
            tenantId = config!.tenantId;
            lock = createPostgresPropertyReadLock({ tenantId, propertyCode: input.propertyCode, databaseUrl });
          } else if (needsCancellationRead) {
            const target = await assertOrigin();
            tenantId = paneStayTenantId();
            if (target.propertyCode !== 'HRCEN' || tenantId === 'legacy') return run();
            lock = paneStayPropertyLock(target);
          } else return run();
          if (!lock) return run();
          return lock.withLock(async () => {
            await assertOrigin();
            const traces: Promise<void>[] = [];
            const activeCancellationSessions = new Set<Promise<unknown>>();
            const installedServices: ReservationistExecutionServices = { ...basicServices };
            if (needsQuote && quoteConfigReady) Object.assign(installedServices, getInstalledStaffQuoteServices({
              authorizationId: context.generationId,
              authorizeContext: async (ctx) => { await fresh(ctx.input); await assertOrigin(); return true; },
              signer: { signerName: '', signerEmail: '' }, propertyCode: input.propertyCode,
              childEnv: { ...process.env, HMS_PROPERTY_LOCK_HELD: propertyReadLockKey(tenantId, input.propertyCode), PANE_STAY_TENANT_ID: tenantId },
              onTraceFinish: (finished) => { traces.push(finished); },
            }));
            if (needsCancellationRead) installedServices.resolvePendingActionTask = async (ctx) => {
              if (ctx.task.kind !== 'cancel_request' || !currentAuthoredGuestRequest(ctx.task, ctx.input))
                throw new Error('pending_action_request_unavailable');
              const refs = ctx.facts.filter((fact) => fact.kind === 'reservation_reference');
              if (refs.length !== 1) throw new Error('pending_action_target_unavailable');
              const ref = refs[0]!;
              const source = ctx.task.source;
              const requestMessage = ctx.input.messages.find((message) => `message:${message.id}` === source.attachmentId);
              const cancellationVerb = /\b(?:cancel(?:l?ed|lation)?)\b/i.exec(source.quote ?? '');
              const cancellationOffset = cancellationVerb && Number.isSafeInteger(source.start)
                ? source.start! + cancellationVerb.index : null;
              const referenceStart = ref.source.start, referenceEnd = ref.source.end;
              const sameCancellationClause = !!requestMessage && cancellationOffset !== null &&
                Number.isSafeInteger(source.end) && Number.isSafeInteger(referenceStart) && Number.isSafeInteger(referenceEnd) &&
                referenceStart! >= source.start! && referenceEnd! <= source.end! &&
                !/[.!?;](?=\s|$)/.test(requestMessage.text.slice(Math.min(cancellationOffset, referenceStart!), Math.max(cancellationOffset, referenceStart!)));
              if (ref.verification !== 'text_verified' || ref.disclosure !== 'guest' || ref.authority !== 'customer_claim' ||
                  ref.source.attachmentId !== source.attachmentId || ref.source.sourceHash !== source.sourceHash ||
                  !ref.source.quote?.includes(ref.value) ||
                  !currentAuthoredGuestRequest({ ...ctx.task, source: ref.source }, ctx.input) || !sameCancellationClause)
                throw new Error('pending_action_target_unavailable');
              if (!requestMessage) throw new Error('pending_action_request_unavailable');

              await fresh(ctx.input);
              await assertOrigin();
              let resolvedConfirmation: string | null = null;
              const session = savedStaySession(async ({ runTool }) => {
                const attempts = confirmationSearchValues(ref.value);
                for (const [index, attempt] of attempts.entries()) {
                  const read = await runTool({ tool: 'read', confirmation: attempt.searchValue });
                  if (read.outcome === 'ok') {
                    const selected = read.shallow?.confirmation;
                    if (typeof selected !== 'string' || !confirmationMatches(ref.value, selected))
                      throw new Error('reservation_read_target_unavailable');
                    resolvedConfirmation = selected;
                    break;
                  }
                  const next = attempts[index + 1];
                  const resultCount = read.searchResults?.total;
                  if (!next || attempt.matchedBy !== 'confirmation' || next.matchedBy !== 'confirmation_leg_retry' ||
                      read.outcome !== 'read_failed' || read.issue !== 'CONFIRMATION_NOT_FOUND' ||
                      read.searchResults?.complete !== true || (resultCount !== 0 && resultCount !== 1))
                    throw new Error('reservation_read_unavailable');
                }
                if (!resolvedConfirmation) throw new Error('reservation_read_unavailable');
                // Retain the guest-supplied reference; the selected HMS confirmation is bound separately.
                return runTool({ tool: 'prepareCancellation', requestedScope: 'unspecified' });
              }, { signal: ctx.signal });
              activeCancellationSessions.add(session);
              let preflight: CancellationToolResult;
              try { preflight = await session; }
              finally { activeCancellationSessions.delete(session); }
              if (!resolvedConfirmation) throw new Error('cancellation_preflight_unavailable');
              ctx.signal.throwIfAborted();
              await fresh(ctx.input);
              await assertOrigin();

              const cancellationReview = cancellationReviewOf(preflight);
              const observedAt = typeof preflight.observedAt === 'string' ? preflight.observedAt : '';
              const arrivalDate = await normalizeHmsDate(preflight.stay?.arrivalDate?.value);
              const departureDate = await normalizeHmsDate(preflight.stay?.departureDate?.value);
              if (!cancellationReview || preflight.target?.confirmation !== resolvedConfirmation || preflight.target?.verified !== true ||
                  preflight.stay?.status?.state !== 'observed' || preflight.stay?.status?.value !== 'Reserved' ||
                  preflight.stay?.arrivalDate?.state !== 'observed' || preflight.stay?.departureDate?.state !== 'observed' ||
                  !arrivalDate || !departureDate || !Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) > Date.now())
                throw new Error('cancellation_preflight_unavailable');
              const current = { arrivalDate, departureDate };
              const evidence: ReservationistPendingActionEvidence = {
                requestId: ctx.input.requestId,
                ownerRef: ctx.input.authorizationScope!.ownerRef,
                threadId: ctx.input.authorizationScope!.threadId,
                authorizationId: context.generationId,
                propertyCode: ctx.input.propertyCode,
                reservationRef: ref.value,
                resolvedConfirmation,
                sourceRef: `hms-record:${quoteDigest({ propertyCode: ctx.input.propertyCode, reservationRef: resolvedConfirmation }).slice(0, 24)}`,
                sourceHash: quoteDigest({ propertyCode: ctx.input.propertyCode, reservationRef: resolvedConfirmation, observedAt, current, cancellationReview }),
                observedAt,
                expiresAt: new Date(Date.parse(observedAt) + RESERVATION_EVIDENCE_TTL_MS).toISOString(),
                maxSourceAgeMs: RESERVATION_EVIDENCE_TTL_MS,
                current,
                requestSource: {
                  sourceRef: source.attachmentId,
                  sourceHash: source.sourceHash,
                  observedAt: requestMessage.at,
                  taskId: ctx.task.id,
                },
                cancellationReview,
              };
              const evidenceIdentity = quoteDigest(evidence);
              const actionInput = {
                kind: 'cancel_request' as const,
                taskId: ctx.task.id,
                requestId: ctx.input.requestId,
                propertyCode: ctx.input.propertyCode,
                ownerRef: ctx.input.authorizationScope!.ownerRef,
                threadId: ctx.input.authorizationScope!.threadId,
                reservationRef: ref.value,
                clock: { causalAt: ctx.input.clock.causalAt, sourceAt: observedAt, sourceMode: 'current_read' as const },
              };
              return {
                input: actionInput,
                evidence,
                authorizeSource: async (candidate, signal) => {
                  signal.throwIfAborted();
                  if (quoteDigest(candidate) !== evidenceIdentity) return false;
                  await fresh(ctx.input);
                  await assertOrigin();
                  const now = Date.now();
                  return now - Date.parse(candidate.observedAt) <= candidate.maxSourceAgeMs &&
                    Date.parse(candidate.expiresAt) > now;
                },
              };
            };
            activeServices = installedServices;
            try {
              const work = await run();
              await Promise.all(traces);
              await fresh(input);
              return work;
            } finally {
              while (activeCancellationSessions.size) await Promise.allSettled(activeCancellationSessions);
              await Promise.allSettled(traces);
              activeServices = basicServices;
            }
          }, { signal, deadlineAt: input.clock.deadlineAt });
        },
      },
    };
  };
}
