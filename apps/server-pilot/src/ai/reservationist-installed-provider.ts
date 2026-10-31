import { createPostgresPropertyReadLock, propertyReadLockKey } from '../hms/property-read-lock.js';
import { isDocxMimeType } from '../mail/artifacts/read-artifact.js';
import { quoteDigest } from '../quote-proposal/quote-revision.js';
import type { ModelAdapter } from './bedrock/adapter.js';
import type { ReservationistProvider } from './draft-route-factory.js';
import { createReservationistDependencies, deriveRequestedArrivalAcknowledgement, type ReservationistExecutionServices } from './reservationist-execution.js';
import type { ReservationistRuntimeInput, RuntimeSourceRecovery } from './reservationist-runtime.js';
import { getInstalledStaffQuoteServices, readInstalledStaffQuoteConfiguration } from './staff-quote-installation.js';

/**
 * Compose the real quote reader with the shared reservationist runtime.
 * Installation/release is deliberately separate from this factory.
 */
export function createInstalledReservationistProvider(adapter: ModelAdapter): ReservationistProvider {
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
    const visualTextSources = context.admissions.filter((admission) => admission.status === 'admitted' &&
      (admission.metadata.mimeType === 'application/pdf' || isDocxMimeType(admission.metadata.mimeType)) &&
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
    const textOnlyAdapter: ModelAdapter = {
      ...(adapter.reserveCalls ? { reserveCalls: (count, signal) => adapter.reserveCalls!(count, signal) } : {}),
      invoke: (request) => adapter.invoke({ ...request, files: [], images: [] }),
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
          if (!plan.tasks.some((task) => task.kind === 'quote')) return run();
          let config: ReturnType<typeof readInstalledStaffQuoteConfiguration>;
          try { config = readInstalledStaffQuoteConfiguration(input.propertyCode); }
          catch { return run(); }
          const databaseUrl = process.env.DATABASE_URL;
          if (!databaseUrl || config.owner.propertyCode !== input.propertyCode)
            return run();
          const lock = createPostgresPropertyReadLock({ tenantId: config.tenantId, propertyCode: input.propertyCode, databaseUrl });
          return lock.withLock(async () => {
            await fresh(input);
            const traces: Promise<void>[] = [];
            activeServices = { ...basicServices, ...getInstalledStaffQuoteServices({
              authorizationId: context.generationId,
              authorizeContext: async (ctx) => { await fresh(ctx.input); return true; },
              signer: { signerName: '', signerEmail: '' }, propertyCode: input.propertyCode,
              childEnv: { ...process.env, HMS_PROPERTY_LOCK_HELD: propertyReadLockKey(config.tenantId, input.propertyCode), PANE_STAY_TENANT_ID: config.tenantId },
              onTraceFinish: (finished) => { traces.push(finished); },
            }) };
            try {
              const work = await run();
              await Promise.all(traces);
              await fresh(input);
              return work;
            } finally {
              await Promise.allSettled(traces);
              activeServices = basicServices;
            }
          }, { signal, deadlineAt: input.clock.deadlineAt });
        },
      },
    };
  };
}
