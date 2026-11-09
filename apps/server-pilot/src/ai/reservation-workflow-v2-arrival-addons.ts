import { reservationWorkflowV2ObservationSchema } from './reservation-workflow-v2-contract.js';
import { getReservationWorkflowV2Draft } from './reservation-workflow-v2-state.js';
import type { ReservationWorkflowV2ServerContext } from './reservation-workflow-v2-tools.js';
import { savedTarget,
  type ReservationWorkflowV2ServicesInput, type ReservationWorkflowV2SavedServicesInput } from './reservation-workflow-v2-services.js';
import { lookupAddOns } from './reservation-workflow-v2-addon-check.js';
import { canonicalJson } from './draft-approval.js';
import { loadSyncedQuoteSelectionFromMailbox } from './quote-workflow-synced-selection.js';
import { sourceEvidence } from './reservation-workflow-v2-prefill.js';
import { paneStayLookupEnabled } from './pane-stay-lookup.js';
import { paneStayPropertyLock } from './pane-stay-save.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { CENTURION_HMS_READ_TARGET } from '../hms/hms-read-target.js';
import { acquisitionWithin, PANE_PROPERTY_LOCK_WAIT_MS } from '../hms/property-read-lock.js';

type Input = ReservationWorkflowV2ServicesInput | ReservationWorkflowV2SavedServicesInput;
type Evidence = ReturnType<typeof sourceEvidence>[number];
const normal = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function citedText(evidence: Evidence[], refs: string[]): string {
  const wanted = new Set(refs);
  return evidence.filter(row => wanted.has(row.ref) && row.kind !== 'attachment_vision')
    .map(row => normal(row.text)).join('\n');
}
function containsCode(source: string, value: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(normal(value))}($|[^\\p{L}\\p{N}_])`, 'u').test(source);
}
/** Run one actorless native check; the arrival transaction owns all persistence. */
export async function reservationArrivalAddOnLookup(ctx: ReservationWorkflowV2ServerContext, input: Input):
  Promise<{ status: string; issue?: string }> {
  const batch = ctx.nativeBatch;
  if (!batch || !input.serviceId || ctx.property.propertyCode !== 'HRCEN')
    return { status: 'unsupported', issue: 'service_arrival_context_required' };
  const scoped = { db: ctx.db, transportId: ctx.transport.id, userId: null, propertyCode: ctx.property.propertyCode, nativeBatch: batch };
  const current = async () => {
    const loaded = await getReservationWorkflowV2Draft(scoped, input);
    if (loaded.status !== 'ok' || loaded.revision !== batch.expectedRevision || loaded.seq !== batch.expectedSeq ||
        loaded.draft.generationId !== batch.generationId || loaded.draft.prefill?.status !== 'running' ||
        loaded.draft.prefill.phase !== 'native_checks' || loaded.draft.prefill.jobRunId !== batch.jobFence.runId) return null;
    return loaded.draft;
  };
  const draft = await current();
  if (!draft) return { status: 'needs_input', issue: 'service_draft_changed' };
  const service = draft.proposal.content.services.find(row => row.id === input.serviceId);
  const request = draft.proposal.content.requests.find(row => row.id === input.requestId);
  const target = 'allocationId' in input ? { kind: 'allocation', requestId: input.requestId, allocationId: input.allocationId } : input.targetRef;
  const matching = service?.targets.filter(row => canonicalJson(row.target) === canonicalJson(target)) ?? [];
  if (!service || !request || matching.length !== 1 || (service.ownerRequestId && service.ownerRequestId !== request.id) ||
      draft.proposal.content.requests.some(row => row.id !== request.id && row.serviceRefs.includes(service.id)))
    return { status: 'needs_input', issue: 'service_target_ambiguous' };
  if (service.operation !== 'add') return { status: 'needs_input', issue: 'service_add_only' };
  if (!('allocationId' in input) && !paneStayLookupEnabled()) return { status: 'needs_input', issue: 'stay_lookup_disabled' };
  const selection = await loadSyncedQuoteSelectionFromMailbox({ db: ctx.db, transportId: ctx.transport.id,
    messageId: input.source.messageId, includeThreadState: true, sourceCutoffOnly: true, signal: batch.signal });
  if (!selection || selection.messageId !== input.source.messageId || selection.threadId !== input.source.threadId)
    return { status: 'needs_input', issue: 'service_source_unavailable' };
  const admitted = new Set(draft.observations.filter(row => row.kind === 'source' && row.generationId === draft.generationId)
    .flatMap(row => Array.isArray(row.result.evidenceRefs) ? row.result.evidenceRefs.filter((ref): ref is string => typeof ref === 'string') : []));
  const evidence = sourceEvidence({ source: input.source, selection, vision: { currentProposalSources: [] } })
    .filter(row => admitted.has(row.ref));
  if (!citedText(evidence, service.sourceRefs)) return { status: 'needs_input', issue: 'service_source_unavailable' };
  if (!('allocationId' in input)) {
    const found = savedTarget(draft, input);
    const hint = request && 'targets' in request.body ? request.body.targets?.include.find(row => row.id === input.targetRef.hintId) : undefined;
    const text = hint ? citedText(evidence, hint.sourceRefs) : '';
    const confirmation = found?.hint.confirmation, guestName = found?.hint.guestName;
    if (!found || !text || !(typeof confirmation === 'string' && confirmation.trim() && containsCode(text, confirmation.trim()) ||
        typeof guestName === 'string' && guestName.trim() && text.includes(normal(guestName.trim()))))
      return { status: 'needs_input', issue: 'service_saved_target_source_required' };
  }
  const resolved = paneStayHmsTargetForTransport(ctx.transport.id);
  if (!resolved.ok || (['propertyCode', 'secretId', 'browserSlot', 'origin', 'installationEnvName'] as const)
    .some(key => resolved.target[key] !== CENTURION_HMS_READ_TARGET[key]))
    return { status: 'unsupported', issue: 'service_property_session_unavailable' };
  const lock = paneStayPropertyLock(resolved.target);
  if (!lock) return { status: 'needs_input', issue: 'service_property_lock_unavailable' };
  const result = await lock.withLock(async () => {
    batch.signal.throwIfAborted();
    if (!('allocationId' in input) && !paneStayLookupEnabled()) return { status: 'needs_input', issue: 'stay_lookup_disabled', observations: [] };
    const latest = await current();
    if (!latest) return { status: 'needs_input', issue: 'service_draft_changed', observations: [] };
    // A matching cursor is required for the whole source-checked snapshot, not just the helper's revision check.
    if (canonicalJson(latest) !== canonicalJson(draft)) return { status: 'needs_input', issue: 'service_draft_changed', observations: [] };
    return lookupAddOns({ draft: latest, input, transportId: ctx.transport.id, signal: batch.signal });
  }, { ...acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS), signal: batch.signal });
  batch.signal.throwIfAborted();
  const refs = new Set(draft.observations.map(row => row.ref));
  if (draft.observations.length + batch.observations.length + result.observations.length > 5000)
    return { status: 'needs_input', issue: 'service_observation_limit' };
  for (const observation of result.observations) {
    const parsed = reservationWorkflowV2ObservationSchema.safeParse(observation);
    if (!parsed.success || parsed.data.generationId !== draft.generationId || parsed.data.propertyCode !== draft.propertyCode ||
        parsed.data.sourceMessageId !== input.source.messageId || refs.has(parsed.data.ref) ||
        parsed.data.sourceRefs.some(ref => !refs.has(ref))) return { status: 'failed', issue: 'service_observation_invalid' };
    refs.add(parsed.data.ref);
  }
  batch.observations.push(...result.observations);
  return { status: result.status, ...(result.issue ? { issue: result.issue } : {}) };
}
