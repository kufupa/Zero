import { LocalModelAdapter } from './bedrock/local.js';
import { isDraftRouteReleaseDescriptor,isDraftRouteEvidence, type DraftModelRouteConfig, type DraftRouteAuthority, type ReservationistProvider, type ReservationistProviderContext } from './draft-route-factory.js';
import type {ModelAdapter} from './bedrock/adapter.js';
import { createReservationistDependencies, type ReservationistExecutionServices } from './reservationist-execution.js';
import { RESERVATIONIST_RUNTIME_VERSION,isReservationistExecutionInput } from './reservationist-runtime.js';
import { quoteDigest } from '../quote-proposal/quote-revision.js';
import type { RevisionProposalHeader } from '../quote-proposal/proposal-pdf.js';
import type { DraftArtifactStorage } from './drafts.js';
import type { ReadExecutionContext } from '../hms/read-service.js';

export type ReservationistProviderServices = {
  services: ReservationistExecutionServices;
  header: RevisionProposalHeader;
  converter: { url: string; fetchImpl: typeof fetch };
  artifactStorage?: DraftArtifactStorage;
};
/** The same explicit extraction options accepted by the runtime/replay factory. */
export type ReservationistExtractionConfiguration = Pick<Parameters<typeof createReservationistDependencies>[0], 'extractionMode' | 'factEnrichmentMode' | 'messageBatching'>;
export type ReservationistProviderOptions = ReservationistExtractionConfiguration & {
  /** Advance only runtime-owned evaluation time for reads completed during this run. */
  currentReadEvaluation?:boolean;
  /** Trusted recorded PMS observation timeline; immutable causal/model input and real deadlines remain unchanged. */
  currentReadEvaluationClock?:()=>number;
  /** Required only for the explicitly approved Azure route; actual usage is preserved. */
  modelAdapter?:ModelAdapter;
  routeConfig: DraftModelRouteConfig;
  resolveCurrentAuthority: () => DraftRouteAuthority | undefined | Promise<DraftRouteAuthority | undefined>;
  /** Server validates the requester, generation and live claim fence; a structural check is insufficient. */
  authorizeContext: (context: ReservationistProviderContext, signal: AbortSignal) => Promise<boolean>;
  resolveServices: (context: ReservationistProviderContext) => Promise<ReservationistProviderServices>;
};
function contextIdentity(context: ReservationistProviderContext): string {
  return quoteDigest({ transportId: context.transportId, threadId: context.threadId, requestedByUserId: context.requestedByUserId, generationId: context.generationId, fence: { ...context.fence, deadlineAt: context.fence?.deadlineAt?.getTime() }, input: context.input, admissions: context.admissions.map(admission => admission.metadata) });
}
function assertContext(context: ReservationistProviderContext): void {
  const scope = context.input?.authorizationScope, fence = context.fence;
  const causal = Date.parse(context.input.clock.causalAt), sourceAt = Date.parse(context.input.clock.sourceAt);
  if (!context.db || !context.transportId || !context.threadId || !context.requestedByUserId || !context.generationId || scope?.ownerRef !== context.transportId || scope.threadId !== context.threadId || !context.input.requestId || context.input.requestId !== context.input.trigger.id || context.input.capabilities.pmsWrite !== false || context.input.capabilities.emailSend !== false || !fence?.runId || !fence.claimOwner || !fence.claimToken || !(fence.deadlineAt instanceof Date) || !Number.isFinite(fence.deadlineAt.getTime()) || fence.deadlineAt.getTime() <= Date.now() || !Number.isFinite(context.input.clock.deadlineAt) || context.input.clock.deadlineAt <= Date.now() || context.input.clock.deadlineAt > fence.deadlineAt.getTime())
    throw new Error('Reservationist provider context invalid');
  if (context.input.version !== 1 || !context.input.propertyCode || !Number.isFinite(causal) || causal !== Date.parse(context.input.trigger.at) || !Number.isFinite(sourceAt) || context.input.clock.sourceMode !== 'current_read' && sourceAt > causal || context.input.messages.length > 64 || !context.input.messages.some(message => message.id === context.input.trigger.id && message.direction === 'inbound' && Date.parse(message.at) === causal) || context.input.messages.some(message => !Number.isFinite(Date.parse(message.at)) || Date.parse(message.at) > causal))
    throw new Error('Reservationist provider context clock invalid');
}
function assertAuthority(authority: DraftRouteAuthority | undefined): asserts authority is DraftRouteAuthority {
  const route = authority?.route, release = authority?.release;
  if (!isDraftRouteEvidence(route) || route.modelId !== 'gpt-6-luna' || !isDraftRouteReleaseDescriptor(release) || release.withdrawn || Date.parse(release.issuedAt) > Date.now() || Date.parse(release.expiresAt) <= Date.now() || release.capabilityFamilyVersions.reservationist !== RESERVATIONIST_RUNTIME_VERSION)
    throw new Error('Reservationist provider authority unavailable');
}
/** Compose trusted installed services only; this constructor does not install a policy, write or deployment. */
export function createReservationistProvider(options: ReservationistProviderOptions): ReservationistProvider {
  if (typeof options.authorizeContext !== 'function' || typeof options.resolveCurrentAuthority !== 'function' || typeof options.resolveServices !== 'function' || typeof options.routeConfig.transport !== 'function') throw new Error('Reservationist provider authorization required');
  const expected = { route: structuredClone(options.routeConfig.route), release: structuredClone(options.routeConfig.release) } as DraftRouteAuthority;
  assertAuthority(expected);
  const extractionConfiguration = (): ReservationistExtractionConfiguration => ({ extractionMode: options.extractionMode, factEnrichmentMode: options.factEnrichmentMode, messageBatching: options.messageBatching });
  const extraction = extractionConfiguration(), extractionIdentity = quoteDigest(extraction),currentReadEvaluation=options.currentReadEvaluation===true,currentReadEvaluationClock=options.currentReadEvaluationClock;
  if(currentReadEvaluationClock!==undefined&&(!currentReadEvaluation||typeof currentReadEvaluationClock!=='function'))throw new Error('Reservationist provider evaluation clock invalid');
  if (extraction.extractionMode !== undefined && !['combined', 'task_first'].includes(extraction.extractionMode) || extraction.factEnrichmentMode !== undefined && (extraction.factEnrichmentMode !== 'source_batches' || extraction.extractionMode !== 'task_first') || extraction.messageBatching !== undefined && (extraction.messageBatching !== 'per_source' || extraction.factEnrichmentMode !== 'source_batches' || extraction.extractionMode !== 'task_first')) throw new Error('Reservationist provider extraction configuration invalid');
  const installedAdapter=options.modelAdapter,hosted=expected.route.protocol==='azure-foundry-responses';
  if(hosted?(!installedAdapter||typeof installedAdapter.invoke!=='function'):installedAdapter!==undefined)throw new Error('Reservationist provider installed adapter invalid');
  const authorityIdentity = quoteDigest(expected), transport = options.routeConfig.transport, reserveCalls = hosted?installedAdapter?.reserveCalls:options.routeConfig.reserveCalls;
  if (reserveCalls !== undefined && typeof reserveCalls !== 'function' || extraction.extractionMode === 'task_first' && !reserveCalls) throw new Error('Reservationist provider reservation unavailable');
  const assertConfiguration = (): void => {
    if (quoteDigest(extractionConfiguration()) !== extractionIdentity || (options.currentReadEvaluation===true)!==currentReadEvaluation || options.currentReadEvaluationClock!==currentReadEvaluationClock || options.routeConfig.transport !== transport || options.modelAdapter!==installedAdapter || (hosted?installedAdapter?.reserveCalls:options.routeConfig.reserveCalls) !== reserveCalls) throw new Error('Reservationist provider extraction configuration changed');
  };
  return async context => {
    assertContext(context);
    const identity = contextIdentity(context), db = context.db;
    const guard = async (signal: AbortSignal = context.signal): Promise<void> => {
      context.signal.throwIfAborted(); signal.throwIfAborted(); assertContext(context);
      assertConfiguration();
      if (context.db !== db || contextIdentity(context) !== identity) throw new Error('Reservationist provider context changed');
      const current = await options.resolveCurrentAuthority(); assertAuthority(current);
      if (quoteDigest(current) !== authorityIdentity) throw new Error('Reservationist provider authority changed');
      if (!await options.authorizeContext(context, signal)) throw new Error('Reservationist provider context denied');
      context.signal.throwIfAborted(); signal.throwIfAborted(); assertContext(context);
      assertConfiguration();
      if (context.db !== db || contextIdentity(context) !== identity) throw new Error('Reservationist provider context changed');
      const after = await options.resolveCurrentAuthority(); assertAuthority(after);
      if (quoteDigest(after) !== authorityIdentity) throw new Error('Reservationist provider authority changed');
    };
    await guard();
    const resolved = await options.resolveServices(context);
    await guard();
    const fields: (keyof RevisionProposalHeader)[] = ['attention', 'company', 'clientEmail', 'clientTelephone', 'agency', 'signerName', 'signerEmail'];
    if (!resolved || !resolved.services || fields.some(key => typeof resolved.header?.[key] !== 'string') || !resolved.converter?.url || typeof resolved.converter.fetchImpl !== 'function' || resolved.artifactStorage && (typeof resolved.artifactStorage.stage !== 'function' || typeof resolved.artifactStorage.read !== 'function')) throw new Error('Reservationist provider services incomplete');
    const readContext = (value: ReadExecutionContext, inheritedSignal: AbortSignal): ReadExecutionContext => {
      if (!value || typeof value.now !== 'function' || !(value.signal instanceof AbortSignal)) throw new Error('Reservationist provider read context invalid');
      const now = value.now;
      // Clock and lease helpers are synchronous interfaces. Async authority surrounds each opaque read entry.
      return { ...value, now: () => { context.signal.throwIfAborted(); value.signal.throwIfAborted(); assertContext(context); if (contextIdentity(context) !== identity || context.db !== db) throw new Error('Reservationist provider context changed'); return Reflect.apply(now, value, []); }, ...(value.handlers ? { handlers: wrap(value.handlers, inheritedSignal) } : {}), ...(value.reservationFacade ? { reservationFacade: wrap(value.reservationFacade, inheritedSignal) } : {}) };
    };
    const wrap = (value: unknown, inheritedSignal: AbortSignal = context.signal): any => {
      if (typeof value === 'function') return async function(this: unknown, ...args: unknown[]) {
        const contextArgument = args.find(arg => arg && typeof arg === 'object' && (arg as {signal?:unknown}).signal instanceof AbortSignal) as {signal:AbortSignal} | undefined;
        const signal = (args.find(arg => arg instanceof AbortSignal) ?? contextArgument?.signal ?? inheritedSignal) as AbortSignal;
        await guard(signal);
        const result = await Reflect.apply(value, this, args);
        await guard(signal);
        return wrap(result, signal);
      };
      if (Array.isArray(value)) return value.map(item => wrap(item, inheritedSignal));
      if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'context' && item && typeof (item as ReadExecutionContext).now === 'function' && (item as ReadExecutionContext).signal instanceof AbortSignal ? readContext(item as ReadExecutionContext, inheritedSignal) : wrap(item, inheritedSignal)]));
      return value; // Preserve Buffer, Date and class identity; never turn them into plain objects.
    };
    const adapter:ModelAdapter = expected.route.protocol==='in_process'
      ? new LocalModelAdapter({ route: expected.route, transport: wrap(transport), ...(reserveCalls ? { reserveCalls: wrap(reserveCalls) } : {}), defaultModelId: expected.route.modelId })
      : { ...(reserveCalls?{reserveCalls:wrap(reserveCalls.bind(installedAdapter))}:{}),invoke:async request=>{await guard(request.signal);const result=await installedAdapter!.invoke(request);await guard(request.signal);const p=result.provenance;if(result.modelId!==expected.route.modelId||!p||p.modelId!==expected.route.modelId||p.routeId!==expected.route.routeId||p.protocol!==expected.route.protocol||p.purpose!=='draft'||p.usageSource!=='reported')throw new Error('Reservationist provider model provenance denied');return result;} };
    const factory = createReservationistDependencies({ ...extraction, adapter, admissions: context.admissions, header: resolved.header, converter: { url: resolved.converter.url, fetchImpl: wrap(resolved.converter.fetchImpl) }, services: wrap(resolved.services) });
    const boundInput = quoteDigest(context.input);
    const dependencies: Parameters<typeof import('./reservationist-runtime.js').runReservationistRuntime>[1] = {
      ...factory.dependencies,
      ...(currentReadEvaluation?{currentReadEvaluation:true}:{}),
      ...(currentReadEvaluationClock?{currentReadEvaluationClock:()=>{context.signal.throwIfAborted();assertContext(context);assertConfiguration();const before=contextIdentity(context),value=currentReadEvaluationClock();assertContext(context);assertConfiguration();if(before!==identity||contextIdentity(context)!==identity)throw new Error('Reservationist provider context changed');return value;}}:{}),
      async plan(input, signal) { await guard(signal); if (quoteDigest(input) !== boundInput) throw new Error('Reservationist provider context input changed'); const plan = await factory.dependencies.plan(input, signal); await guard(signal); return plan; },
      async execute(plan, input, signal,evaluation) { await guard(signal); if (quoteDigest(input) !== boundInput && (!currentReadEvaluation||!isReservationistExecutionInput(input,context.input,evaluation))) throw new Error('Reservationist provider context input changed'); const work = await factory.dependencies.execute(plan, input, signal,evaluation); await guard(signal); return work; },
    };
    return { dependencies, collectGeneratedArtifacts: factory.collectGeneratedArtifacts, collectUsage: factory.collectUsage, ...(resolved.artifactStorage ? { artifactStorage: resolved.artifactStorage } : {}) };
  };
}
