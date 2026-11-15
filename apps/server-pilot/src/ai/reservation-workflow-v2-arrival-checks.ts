import type { ReservationWorkflowV2Draft, ReservationWorkflowV2ItemInput } from './reservation-workflow-v2-contract.js';
import {
  commitReservationNativeCheck, getReservationWorkflowV2Draft,
  type ReservationNativeCheckBatch, type ReservationPrefillJobFence, type ReservationWorkflowV2Context,
} from './reservation-workflow-v2-state.js';
import { reservationWorkflowV2Lookup, reservationWorkflowV2Prepare, reservationWorkflowV2NativeChoices } from './reservation-workflow-v2-tools.js';
import type { ReservationWorkflowV2SystemReadContext } from './reservation-workflow-v2-system-read-context.js';
import { reservationWorkflowV2QuoteLookup, reservationWorkflowV2QuotePrepare } from './reservation-workflow-v2-quote.js';
import { reservationWorkflowV2AmendLookup, reservationWorkflowV2AmendPrepare } from './reservation-workflow-v2-amend.js';
import { reservationWorkflowV2CancelLookup } from './reservation-workflow-v2-cancel.js';
import { reservationWorkflowV2FilingLookup } from './reservation-workflow-v2-filing.js';
import { paneStayLookupEnabled } from './pane-stay-lookup.js';
import { reservationArrivalAddOnLookup } from './reservation-workflow-v2-arrival-addons.js';
import { recordHmsPrepareFailure } from './work-events.js';

type Outcome = { status: string; issue?: string; [key: string]: unknown };
type Step = { key: string; run: (ctx: ReservationWorkflowV2SystemReadContext, item: ReservationWorkflowV2ItemInput) => Promise<Outcome> };
const CHECK_LIMIT = 100;
const NATIVE_BUDGET_MS = 7 * 60_000;
const stayLookup = (run: Step['run']): Step['run'] => (ctx, item) => paneStayLookupEnabled()
  ? run(ctx, item) : Promise.resolve({ status: 'needs_input', issue: 'stay_lookup_disabled' });

/** Each step performs only reads or an unsaved Prepare. No route, Go, review or Send is invoked. */
function nativeSteps(draft: ReservationWorkflowV2Draft): { steps: Step[]; omitted: number } {
  const steps: Step[] = [];
  for (const request of draft.proposal.content.requests) {
    const requestId = request.id;
    if (request.kind === 'create') {
      steps.push({ key: `create:lookup:${requestId}`, run: (ctx, item) => request.body.allocations.length
        ? reservationWorkflowV2Lookup(ctx, { ...item, requestId })
        : Promise.resolve({ status: 'needs_input', issue: 'create_allocation_required' }) });
      for (const allocation of request.body.allocations) {
        const allocationId = allocation.id;
        steps.push({ key: `create:prepare:${requestId}:${allocationId}`,
          run: (ctx, item) => reservationWorkflowV2Prepare(ctx, { ...item, requestId, allocationId }) });
      }
    } else if (request.kind === 'quote') {
      if (request.body.groups.length) for (const field of ['ratePlan', 'roomCodes']) {
        const path = `/proposal/content/requests/${encodeURIComponent(requestId)}/body/groups/0/${field}`;
        steps.push({ key: `quote:native_catalogue:${requestId}:${field}`, run: (ctx, item) =>
          reservationWorkflowV2NativeChoices(ctx, { ...item, requestId, nativeFieldPath: path }) });
      }
      steps.push({ key: `quote:lookup:${requestId}`, run: (ctx, item) => reservationWorkflowV2QuoteLookup(ctx, { ...item, requestId }) });
      steps.push({ key: `quote:prepare:${requestId}`, run: (ctx, item) => reservationWorkflowV2QuotePrepare(ctx, { ...item, requestId }) });
    } else if (request.kind === 'amend') {
      const cataloguePaths = request.body.sharedChanges.flatMap((change, index) => change.op === 'set' &&
        ['ratePlan', 'roomType', 'roomTypeForCharge'].includes(change.field)
        ? [`/proposal/content/requests/${encodeURIComponent(requestId)}/body/sharedChanges/${index}/value`] : []);
      for (const [targetIndex, target] of request.body.perTarget.entries()) for (const [changeIndex, change] of target.changes.entries())
        if (change.op === 'set' && ['ratePlan', 'roomType', 'roomTypeForCharge'].includes(change.field))
          cataloguePaths.push(`/proposal/content/requests/${encodeURIComponent(requestId)}/body/perTarget/${targetIndex}/changes/${changeIndex}/value`);
      for (const path of cataloguePaths) steps.push({ key: `amend:native_catalogue:${requestId}:${path}`, run: (ctx, item) =>
        reservationWorkflowV2NativeChoices(ctx, { ...item, requestId, nativeFieldPath: path }) });
      steps.push({ key: `amend:lookup:${requestId}`, run: stayLookup((ctx, item) => reservationWorkflowV2AmendLookup(ctx, { ...item, requestId })) });
      for (const hint of request.body.targets.include) steps.push({ key: `amend:prepare:${requestId}:${hint.id}`,
        run: stayLookup((ctx, item) => reservationWorkflowV2AmendPrepare(ctx, { ...item, requestId, allocationId: hint.id })) });
    } else if (request.kind === 'cancel') {
      steps.push({ key: `cancel:lookup:${requestId}`, run: stayLookup((ctx, item) => reservationWorkflowV2CancelLookup(ctx, { ...item, requestId })) });
    } else if (request.kind === 'filing') {
      steps.push({ key: `filing:lookup:${requestId}`, run: stayLookup((ctx, item) => reservationWorkflowV2FilingLookup(ctx, { ...item, requestId })) });
      steps.push({ key: `filing:prepare:${requestId}`, run: async () => ({
        status: 'needs_input', issue: 'filing_preview_requires_staff_document_review' }) });
    }
  }
  for (const service of draft.proposal.content.services) for (const { target } of service.targets) {
    const requestId = target.requestId, serviceId = service.id;
    if (target.kind === 'allocation') {
      const allocationId = target.allocationId;
      steps.push({ key: `service:lookup:${serviceId}:${requestId}:${allocationId}`,
        run: async () => ({ status: 'needs_input', issue: 'service_lookup_requires_staff' }) });
    } else if (target.kind === 'saved_target') {
      steps.push({ key: `service:lookup:${serviceId}:${requestId}:${target.hintId}`,
        run: stayLookup((ctx, item) => reservationArrivalAddOnLookup(ctx, { ...item, requestId, targetRef: target, serviceId })) });
    }
  }
  return { steps: steps.slice(0, CHECK_LIMIT), omitted: Math.max(0, steps.length - CHECK_LIMIT) };
}

function checkOutcome(outcome: Outcome, batch: ReservationNativeCheckBatch) {
  const nested = ['quotes', 'lookups', 'services'].flatMap((key) => Array.isArray(outcome[key]) ? outcome[key] as unknown[] : [])
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && !Array.isArray(row)));
  const incomplete = nested.find((row) => typeof row.status === 'string' &&
    !['ok', 'prepared', 'priced', 'found', 'matches', 'candidate', 'excluded'].includes(row.status));
  const incompleteObservation = batch.observations.find((row) => row.status !== 'complete' || !row.coverage.complete);
  const status = outcome.status === 'ok' && (incomplete || incompleteObservation) ? 'partial' : outcome.status;
  const issue = typeof outcome.issue === 'string' ? outcome.issue : typeof incomplete?.issue === 'string' ? incomplete.issue
    : incompleteObservation?.coverage.notes[0] ?? null;
  return { status: status.slice(0, 50) || 'failed', issue: issue?.slice(0, 500) ?? null };
}

/** Resume from committed checks, retaining all earlier results after a later failure. */
export async function runReservationArrivalChecks(input: { scoped: ReservationWorkflowV2Context;
  item: ReservationWorkflowV2ItemInput; draft: ReservationWorkflowV2Draft; fence: ReservationPrefillJobFence;
  deadlineAt: Date; signal: AbortSignal; recoveryHeartbeat?: string }): Promise<'complete' | 'superseded'> {
  const plan = nativeSteps(input.draft);
  const item = input.item;
  let draft = input.draft;
  const makeBatch = (signal: AbortSignal, deadlineAt: number): ReservationNativeCheckBatch => ({
    jobFence: input.fence, expectedRevision: item.expectedRevision,
    expectedSeq: item.expectedSeq, generationId: input.draft.generationId, signal, deadlineAt,
    observations: [], results: [] });
  if (draft.prefill?.nativeActive) {
    const recovered = await commitReservationNativeCheck(input.scoped, { ...item,
      batch: makeBatch(input.signal, input.deadlineAt.getTime()), recoveryHeartbeat: input.recoveryHeartbeat });
    if (recovered.status !== 'ok') return 'superseded';
    draft = recovered.draft;
  }
  let completed = new Set(draft.prefill?.nativeChecks?.map((check) => check.key) ?? []);
  for (const step of plan.steps) {
    if (completed.has(step.key)) continue;
    if (input.signal.aborted) input.signal.throwIfAborted();
    const remaining = Math.min(NATIVE_BUDGET_MS - (draft.prefill?.nativeSpentMs ?? 0), input.deadlineAt.getTime() - Date.now());
    if (remaining <= 0) break;
    const latest = await getReservationWorkflowV2Draft(input.scoped, item);
    if (latest.status !== 'ok' || latest.revision !== item.expectedRevision || latest.seq !== item.expectedSeq ||
        latest.draft.generationId !== input.draft.generationId || latest.draft.prefill?.status !== 'running' ||
        latest.draft.prefill.phase !== 'native_checks') return 'superseded';
    const deadlineAt = Date.now() + remaining;
    const phaseSignal = AbortSignal.any([input.signal, AbortSignal.timeout(remaining)]);
    const batch = makeBatch(phaseSignal, deadlineAt);
    if (phaseSignal.aborted) { input.signal.throwIfAborted(); break; }
    let begun;
    try { begun = await commitReservationNativeCheck(input.scoped, { ...item, batch, begin: step.key }); }
    catch (error) {
      input.signal.throwIfAborted();
      if (phaseSignal.aborted) break;
      throw error;
    }
    if (phaseSignal.aborted) { input.signal.throwIfAborted(); break; }
    if (begun.status !== 'ok') return 'superseded';
    const ctx: ReservationWorkflowV2SystemReadContext = { system: true, db: input.scoped.db,
      transport: { id: input.scoped.transportId }, property: { propertyCode: input.scoped.propertyCode }, nativeBatch: batch };
    let outcome: Outcome;
    const dependency = step.key.startsWith('quote:prepare:')
      ? step.key.replace(':prepare:', ':lookup:') : null;
    const dependencyResult = dependency ? draft.prefill?.nativeChecks?.find((entry) => entry.key === dependency) : undefined;
    const startedAt = Date.now();
    try {
      phaseSignal.throwIfAborted();
      outcome = dependency && dependencyResult?.status !== 'ok'
        ? { status: 'needs_input', issue: 'prior_native_lookup_incomplete' } : await step.run(ctx, item);
      phaseSignal.throwIfAborted();
    } catch {
      input.signal.throwIfAborted();
      outcome = { status: 'failed', issue: phaseSignal.aborted ? 'prepared_deadline_exceeded' : 'native_check_failed' };
    }
    const check = { key: step.key, ...checkOutcome(outcome, batch) };
    if (step.key.split(':')[1] === 'prepare' &&
        !['ok', 'prepared', 'priced', 'found', 'matches', 'candidate', 'excluded'].includes(check.status)) {
      const [workflow] = step.key.split(':');
      await recordHmsPrepareFailure(input.scoped.db, { workItemId: item.workItemId, actorUserId: null,
        workflow: workflow === 'service' ? 'addons' : workflow, stage: 'check',
        status: check.status, codes: [check.issue],
        propertyCode: input.scoped.propertyCode, durationMs: Date.now() - startedAt });
    }
    input.signal.throwIfAborted();
    if (phaseSignal.aborted) break;
    if (phaseSignal.aborted) { input.signal.throwIfAborted(); break; }
    let saved;
    try { saved = await commitReservationNativeCheck(input.scoped, { ...item, batch, check }); }
    catch (error) {
      input.signal.throwIfAborted();
      if (phaseSignal.aborted) break;
      throw error;
    }
    if (saved.status !== 'ok') {
      if (phaseSignal.aborted) { input.signal.throwIfAborted(); break; }
      return 'superseded';
    }
    draft = saved.draft;
    completed = new Set(saved.draft.prefill?.nativeChecks?.map((entry) => entry.key) ?? []);
    if (phaseSignal.aborted) { input.signal.throwIfAborted(); break; }
  }
  const unrun = plan.steps.filter((step) => !completed.has(step.key)).length + plan.omitted;
  const batch = makeBatch(input.signal, input.deadlineAt.getTime());
  input.signal.throwIfAborted();
  const finish = await commitReservationNativeCheck(input.scoped, { ...item, batch, finish: true,
    ...(unrun ? { check: { key: 'native:unrun', status: 'partial', issue: `${unrun} checks were not run within the native budget.` } } : {}) });
  return finish.status === 'ok' ? 'complete' : 'superseded';
}
