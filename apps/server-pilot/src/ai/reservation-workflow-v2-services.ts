import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  ReservationWorkflowV2Draft,
  ReservationWorkflowV2Observation,
  ReservationWorkflowV2Source,
} from './reservation-workflow-v2-contract.js';
import {
  reservationWorkflowV2DraftSchema,
} from './reservation-workflow-v2-contract.js';
import {
  appendReservationWorkflowV2Observation,
  getReservationWorkflowV2Draft,
  recordReservationWorkflowV2Result,
} from './reservation-workflow-v2-state.js';
import { canonicalJson } from './draft-approval.js';
import {
  compileReservationWorkflowV2Create,
  type ReservationWorkflowV2ServerContext,
} from './reservation-workflow-v2-tools.js';

export type ReservationWorkflowV2ServicesInput = { workItemId: string; source: ReservationWorkflowV2Source; expectedRevision: number; expectedSeq: number;
  requestId: string; allocationId: string; serviceId?: string };
type Input = ReservationWorkflowV2ServicesInput;
type Result = { status: string; issue?: string; [key: string]: unknown };
type NativeCreate = { outcome?: string; issue?: string; requestBinding?: { request?: unknown; digest?: unknown };
  ratePlanAvailability?: unknown; commitOnlyFields?: string[] };
type AddOnItem = { code: string; quantity?: string; startDate?: string; endDate?: string; unitPrice?: string;
  frequency?: string; pricingControl?: string; folio?: string; comment?: string };
type Effective = { value: unknown; path: string; override?: boolean; none?: boolean } | { issue: string; path: string };
type ServiceProposal = ReservationWorkflowV2Draft['proposal']['content']['services'][number];
type CreateRequest = Extract<ReservationWorkflowV2Draft['proposal']['content']['requests'][number], { kind: 'create' }>;
type ServiceTarget = ServiceProposal['targets'][number];
type ServiceTargetRef = Extract<ServiceTarget['target'], { kind: 'allocation' }>;
export type ReservationWorkflowV2ServiceRow = { service: ServiceProposal; serviceIndex: number; target: ServiceTarget; targetIndex: number;
  targetRef: ServiceTargetRef };
type ServiceLinkResult = { outcome: 'not_found' | 'needs_input'; issue: string } |
  { outcome: 'ok'; createRequest: CreateRequest; rows: ReservationWorkflowV2ServiceRow[] };
export type ReservationWorkflowV2CompiledServiceItem = { outcome: 'ok'; items: AddOnItem; candidate: Record<string, unknown>; candidateRef: string;
  serviceId: string; targetRef: ServiceTargetRef; serviceIndex: number; targetIndex: number;
  fieldPaths: Record<string, string>; reviewPaths: string[]; inputDigest: string } |
  { outcome: 'needs_input' | 'unsupported'; issue: string; fields: string[]; reviewPaths?: string[];
    candidate?: Record<string, unknown>; paths?: Record<string, string> };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const sourceInputSchema = z.object({ threadId: z.string().min(1).max(500), messageId: z.string().min(1).max(500),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), arrivedAt: z.string().datetime({ offset: true }) }).strict();
const inputSchema = z.object({ workItemId: z.string().uuid(), source: sourceInputSchema,
  expectedRevision: z.number().int().nonnegative(), expectedSeq: z.number().int().nonnegative(),
  requestId: z.string().min(1).max(80), allocationId: z.string().min(1).max(80),
  serviceId: z.string().min(1).max(80).optional() }).strict();

function stateContext(ctx: ReservationWorkflowV2ServerContext) {
  return { db: ctx.db, transportId: ctx.transport.id, userId: ctx.user.id, propertyCode: ctx.property.propertyCode };
}

function pointer(...parts: Array<string | number>): string {
  return `/${parts.map(part => encodeURIComponent(String(part))).join('/')}`;
}

function effective(draft: ReservationWorkflowV2Draft, path: string, source: unknown): Effective {
  const override = draft.fieldOverrides[path];
  if (override) {
    if (override.state === 'unknown') return { issue: 'staff_value_unknown', path };
    if (override.state === 'set') return { value: override.value, path, override: true };
    if (override.state === 'none' || override.state === 'clear') return { value: undefined, path, override: true, none: true };
    if (override.state === 'inherit') return { value: source && typeof source === 'object' && !Array.isArray(source) &&
      (source as { kind?: unknown }).kind === 'none' ? undefined : source, path,
      ...(source && typeof source === 'object' && !Array.isArray(source) &&
        (source as { kind?: unknown }).kind === 'none' ? { none: true } : {}) };
  }
  if (source && typeof source === 'object' && !Array.isArray(source) &&
      (source as { kind?: unknown }).kind === 'none') return { value: undefined, path, none: true };
  return { value: source, path };
}

function effectiveServiceField(draft: ReservationWorkflowV2Draft, service: Record<string, unknown>, serviceIndex: number,
  target: Record<string, unknown>, targetIndex: number, field: string): Effective {
  const targetValue = record(target.fields)?.[field];
  const targetPath = pointer('proposal', 'content', 'services', serviceIndex, 'targets', targetIndex, 'fields', field);
  const sharedPath = pointer('proposal', 'content', 'services', serviceIndex, 'sharedFields', field);
  if (draft.fieldOverrides[targetPath]?.state === 'inherit') {
    return effective(draft, sharedPath, record(service.sharedFields)?.[field]);
  }
  const local = effective(draft, targetPath, targetValue);
  if ('issue' in local || local.none || (local.value !== undefined && local.value !== null &&
      (typeof local.value !== 'string' || local.value.trim() !== ''))) return local;
  return effective(draft, sharedPath, record(service.sharedFields)?.[field]);
}

function accepted(draft: ReservationWorkflowV2Draft, path: string): boolean {
  return draft.fieldReviewRequirements[path]?.required === false || draft.staffReviews[path]?.status === 'accepted';
}

function valueAt(draft: ReservationWorkflowV2Draft, path: string, source: unknown): Effective {
  return effective(draft, path, source);
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function positiveDecimal(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const [rawWhole, rawFraction = ''] = value.trim().split('.');
  const whole = rawWhole!.replace(/^0+(?=\d)/, '');
  const fraction = rawFraction.replace(/0+$/, '').padEnd(2, '0');
  return /^0+$/.test(`${whole}${fraction}`) ? null : `${whole}.${fraction}`;
}

function targetRefOf(value: unknown) {
  const target = record(value);
  const requestId = text(target?.requestId), allocationId = text(target?.allocationId);
  return target?.kind === 'allocation' && requestId && allocationId
    ? { kind: 'allocation' as const, requestId, allocationId } : null;
}

export function reservationWorkflowV2ServicesForAllocation(draft: ReservationWorkflowV2Draft, input: Input): ServiceLinkResult {
  const createRequest = draft.proposal.content.requests.find(request => request.id === input.requestId);
  if (!createRequest || createRequest.kind !== 'create') return { outcome: 'not_found' as const, issue: 'create_request_not_found' };
  if (!createRequest.body.allocations.some(allocation => allocation.id === input.allocationId)) {
    return { outcome: 'not_found' as const, issue: 'create_allocation_not_found' };
  }
  const rows: ReservationWorkflowV2ServiceRow[] = [];
  const targetKeys = new Set<string>();
  for (const [serviceIndex, service] of draft.proposal.content.services.entries()) {
    if (input.serviceId && service.id !== input.serviceId) continue;
    const matches = service.targets.flatMap((target, targetIndex) => {
      const targetRef = targetRefOf(target.target);
      return targetRef?.requestId === input.requestId && targetRef.allocationId === input.allocationId
        ? [{ service, serviceIndex, target, targetIndex, targetRef }] : [];
    });
    const linkedHere = service.ownerRequestId === input.requestId || createRequest.serviceRefs.includes(service.id) || matches.length > 0;
    if (!linkedHere) continue;
    const referencedElsewhere = draft.proposal.content.requests.some(request => request.id !== input.requestId &&
      request.serviceRefs.includes(service.id));
    if ((service.ownerRequestId !== null && service.ownerRequestId !== input.requestId) || referencedElsewhere) {
      return { outcome: 'needs_input' as const, issue: 'service_request_ownership_conflict' };
    }
    for (const row of matches) {
      const targetKey = `${row.service.id}\u0000${row.targetRef.requestId}\u0000${row.targetRef.allocationId}`;
      if (targetKeys.has(targetKey)) return { outcome: 'needs_input' as const, issue: 'duplicate_service_allocation_target' };
      targetKeys.add(targetKey);
      rows.push(row);
    }
  }
  return { outcome: 'ok' as const, createRequest, rows };
}

function candidateFor(draft: ReservationWorkflowV2Draft, input: Input, row: ReservationWorkflowV2ServiceRow) {
  const service = row.service as unknown as Record<string, unknown>;
  const path = pointer('proposal', 'content', 'services', row.serviceIndex, 'itemCandidateRef');
  const candidateRef = valueAt(draft, path, service.itemCandidateRef);
  if ('issue' in candidateRef || typeof candidateRef.value !== 'string') return { issue: 'native_item_selection_required', path };
  const observation = draft.observations.find(item => item.ref === candidateRef.value && item.kind === 'service_preview' &&
    item.status === 'complete' && item.propertyCode === draft.propertyCode && item.generationId === draft.generationId &&
    item.criteria.workflow === 'services' && item.criteria.kind === 'catalogue_candidate' &&
    item.criteria.serviceId === service.id && item.criteria.requestId === input.requestId &&
    item.criteria.fieldPath === path);
  const candidate = observation && record(observation.result)?.candidate;
  if (!record(candidate) || !text(record(candidate)?.code) || !text(record(candidate)?.itemId)) {
    return { issue: 'host_catalogue_candidate_unverified', path };
  }
  return { candidate: record(candidate)!, path, observation: observation! };
}

export function reservationWorkflowV2CompileServiceItem(draft: ReservationWorkflowV2Draft, input: Input,
  row: ReservationWorkflowV2ServiceRow): ReservationWorkflowV2CompiledServiceItem {
  const service = row.service as unknown as Record<string, unknown>;
  const target = row.target as unknown as Record<string, unknown>;
  if (service.operation !== 'add') return { outcome: 'unsupported', issue: 'saved_addon_edit_remove_not_connected', fields: [] };
  const candidate = candidateFor(draft, input, row);
  if ('issue' in candidate) return { outcome: 'needs_input' as const, issue: candidate.issue ?? 'service_candidate_unavailable', fields: [candidate.path] };

  const items: AddOnItem = { code: String(candidate.candidate.code) };
  const paths: Record<string, string> = {};
  const errors: string[] = [];
  const reviewPaths = new Set<string>();
  for (const field of ['quantity', 'startDate', 'endDate', 'unitPrice', 'frequency', 'pricingControl', 'folio', 'comment'] as const) {
    const value = effectiveServiceField(draft, service, row.serviceIndex, target, row.targetIndex, field);
    paths[field] = value.path;
    if ('issue' in value) { errors.push(`${field}:${value.issue}`); continue; }
    if (value.value === undefined || value.value === null) {
      if (field === 'quantity' && record(service.quantityRequest)?.scope === 'per_target' &&
          typeof record(service.quantityRequest)?.value === 'string') {
        const quantityPath = pointer('proposal', 'content', 'services', row.serviceIndex, 'quantityRequest', 'value');
        paths.quantity = quantityPath;
        const quantity = positiveDecimal(record(service.quantityRequest)?.value);
        if (!quantity) errors.push('quantity:positive_target_quantity_required');
        else {
          items.quantity = quantity;
          if (!accepted(draft, quantityPath)) reviewPaths.add(quantityPath);
        }
      }
      continue;
    }
    if (typeof value.value !== 'string') { errors.push(`${field}:invalid_type`); continue; }
    if (!accepted(draft, value.path)) reviewPaths.add(value.path);
    if (field === 'unitPrice') {
      const price = positiveDecimal(value.value);
      if (!price) errors.push(`${field}:positive_source_price_required`);
      else items.unitPrice = price;
    } else if (field === 'quantity') {
      const quantity = positiveDecimal(value.value);
      if (!quantity) errors.push(`${field}:positive_target_quantity_required`);
      else items.quantity = quantity;
    } else if (field === 'startDate' || field === 'endDate') {
      if (!validDate(value.value)) errors.push(`${field}:explicit_target_date_required`);
      else items[field] = value.value;
    } else items[field] = value.value;
  }
  const quantityScope = record(service.quantityRequest)?.scope;
  const targetQuantityPath = pointer('proposal', 'content', 'services', row.serviceIndex, 'targets', row.targetIndex, 'fields', 'quantity');
  const targetQuantitySet = paths.quantity === targetQuantityPath ||
    (quantityScope === 'per_target' && [
      pointer('proposal', 'content', 'services', row.serviceIndex, 'quantityRequest', 'value'),
      pointer('proposal', 'content', 'services', row.serviceIndex, 'sharedFields', 'quantity'),
    ].some((path) => path === paths.quantity));
  const serviceTargets = row.service.targets;
  if (!targetQuantitySet && !(quantityScope === 'overall' && serviceTargets.length === 1)) {
    errors.push('quantity:whole_booking_allocation_unresolved');
  }
  if (quantityScope === 'overall' && serviceTargets.length === 1 && !items.quantity) {
    const quantityRequest = record(service.quantityRequest);
    const quantityPath = pointer('proposal', 'content', 'services', row.serviceIndex, 'quantityRequest', 'value');
    const quantity = positiveDecimal(quantityRequest?.value);
    if (!quantity) errors.push('quantity:target_quantity_required');
    else {
      items.quantity = quantity;
      paths.quantity = quantityPath;
      if (!accepted(draft, quantityPath)) reviewPaths.add(quantityPath);
    }
  }
  if (!items.unitPrice) errors.push('unitPrice:source_price_required');
  if (!items.quantity) errors.push('quantity:target_quantity_required');
  if (!items.startDate || !items.endDate) errors.push('dates:explicit_source_or_staff_values_required');
  if (items.startDate && items.endDate && items.startDate >= items.endDate) errors.push('dates:range_invalid');
  if (serviceTargets.length > 1 && quantityScope === 'overall' && !targetQuantitySet) {
    errors.push('quantity:whole_booking_quantity_must_not_be_split');
  }
  if (errors.length) return { outcome: 'needs_input' as const, issue: 'service_fields_incomplete_or_ambiguous', fields: errors,
    reviewPaths: [...reviewPaths], candidate: candidate.candidate, paths };
  const allPaths = [candidate.path, ...Object.entries(paths).filter(([field]) => Object.hasOwn(items, field)).map(([, path]) => path)];
  return { outcome: 'ok' as const, items, candidate: candidate.candidate, candidateRef: candidate.observation.ref,
    serviceId: service.id as string, targetRef: row.targetRef, serviceIndex: row.serviceIndex, targetIndex: row.targetIndex,
    fieldPaths: paths, reviewPaths: [...new Set([...reviewPaths, ...allPaths.filter(path => !accepted(draft, path))])],
    inputDigest: hash({ serviceId: service.id, targetRef: row.targetRef, items, candidate: candidate.candidate }) };
}

export function reservationWorkflowV2ServiceReviewPaths(plan: Extract<ReservationWorkflowV2CompiledServiceItem, { outcome: 'ok' }>): string[] {
  return [...new Set(Object.entries(plan.fieldPaths).filter(([field]) => Object.hasOwn(plan.items, field)).map(([, path]) => path))];
}

async function currentDraft(ctx: ReservationWorkflowV2ServerContext, input: Input) {
  const loaded = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (loaded.status !== 'ok') return { result: loaded, draft: null } as const;
  if (loaded.revision !== input.expectedRevision || loaded.seq !== input.expectedSeq ||
      loaded.draft.revision !== input.expectedRevision || loaded.draft.propertyCode !== ctx.property.propertyCode) {
    return { result: { status: 'stale_revision' }, draft: null } as const;
  }
  return { result: loaded, draft: reservationWorkflowV2DraftSchema.parse(loaded.draft) } as const;
}

async function createThenAddon(compiled: Extract<ReturnType<typeof compileReservationWorkflowV2Create>, { outcome: 'ok' }>,
  operation: (page: unknown, readForm: () => Promise<unknown>) => Promise<unknown>) {
  const createTool = await import(new URL('../../tooling/hms-cloud/create-reservation.mjs', import.meta.url).href) as {
    createReservation: (input: Record<string, unknown>, options: Record<string, unknown>) => Promise<NativeCreate>;
  };
  const bookingTool = await import(new URL('../../tooling/hms-cloud/booking-lookup-session.mjs', import.meta.url).href) as {
    withBookingLookupSession: (callback: (session: { page: unknown; runTool: (input: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>,
      options?: Record<string, unknown>) => Promise<unknown>;
  };
  let addon: unknown = null;
  const withSession = (callback: (session: { page: unknown; runTool: (input: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>,
    options: Record<string, unknown> = {}) => bookingTool.withBookingLookupSession(async session => {
      await callback(session);
      const readForm = () => session.runTool({ tool: 'readGuestStayForm', propertyCode: 'HRCEN' });
      addon = await operation(session.page, readForm);
    }, { ...options, memory: null, blockServiceWorkers: true });
  const native = await createTool.createReservation(compiled.nativeInput, { allowRealGuest: true,
    expectedGuest: compiled.expectedGuest, requireExplicitGuestSelection: true, allowCommitOnlyBillingReference: true,
    withSession });
  return { native, addon };
}

function persistableContext(ctx: ReservationWorkflowV2ServerContext, input: Input) {
  return { workItemId: input.workItemId, source: input.source, expectedRevision: input.expectedRevision,
    expectedSeq: input.expectedSeq };
}

async function appendServiceObservation(ctx: ReservationWorkflowV2ServerContext, input: Input,
  observation: ReservationWorkflowV2Observation, status?: 'prepared' | 'failed', summary?: string) {
  const base = persistableContext(ctx, input);
  const check = await currentDraft(ctx, input);
  if (!check.draft) return check.result;
  const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), { workItemId: input.workItemId,
    source: input.source, observation });
  if (appended.status !== 'ok') return appended;
  if (!status) return appended;
  const result = await recordReservationWorkflowV2Result(stateContext(ctx), { ...base, result: {
    id: observation.ref, generationId: observation.generationId,
    requestId: input.requestId, allocationId: input.allocationId, workflow: 'services', status,
    draftRevision: input.expectedRevision, observationRefs: [observation.ref], updatedAt: new Date().toISOString(),
    summary: summary ?? null,
  } });
  return result;
}

function serviceTargets(draft: ReservationWorkflowV2Draft, input: Input) {
  return reservationWorkflowV2ServicesForAllocation(draft, input);
}

/** Read the native ITEM catalogue for linked Add-On requests on an unsaved Create stay. */
export async function reservationWorkflowV2LookupServices(ctx: ReservationWorkflowV2ServerContext, rawInput: Input): Promise<Result> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) return { status: 'invalid_input', issue: 'service_lookup_input_invalid' };
  const input = parsed.data;
  if (ctx.property.propertyCode !== 'HRCEN') return { status: 'unsupported', issue: 'service_property_not_supported' };
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return { ...loaded.result };
  const linked = serviceTargets(loaded.draft, input);
  if (linked.outcome !== 'ok') return { status: linked.outcome, issue: linked.issue };
  if (!linked.rows.length) return { status: 'needs_input', issue: input.serviceId ? 'service_target_not_found' : 'no_service_target' };
  const unsupported = linked.rows.filter(row => row.service.operation !== 'add');
  const addRows = linked.rows.filter(row => row.service.operation === 'add');
  if (!addRows.length) return { status: 'unsupported', issue: 'saved_addon_edit_remove_not_connected',
    unsupportedServices: unsupported.map(row => ({ serviceId: row.service.id, operation: row.service.operation,
      targetRef: row.targetRef, issue: 'saved_addon_edit_remove_not_connected' })) };
  const compiled = compileReservationWorkflowV2Create(loaded.draft, input.requestId, input.allocationId, ctx.property.propertyCode);
  if (compiled.outcome !== 'ok') return { status: compiled.outcome, issue: compiled.issue,
    ...(compiled.fields ? { fields: compiled.fields } : {}) };
  try {
    const addonTool = await import(new URL('../../tooling/hms-cloud/stay360-addons.mjs', import.meta.url).href) as {
      listUnsavedStay360AddOnItems: (page: unknown, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const { native, addon } = await createThenAddon(compiled, (page, readForm) =>
      addonTool.listUnsavedStay360AddOnItems(page, { expectedCreate: compiled.nativeInput, readForm }));
    const listing = record(addon);
    const candidates = Array.isArray(listing?.candidates) ? listing.candidates.map(record).filter(Boolean) : [];
    const coverage = record(listing?.coverage);
    const complete = native.outcome === 'prepared' && typeof record(native.requestBinding)?.digest === 'string' &&
      record(native.ratePlanAvailability) !== null && listing?.outcome === 'ok' && listing.unsaved === true &&
      listing.saved !== true && listing.propertyCode === 'HRCEN' && coverage?.complete === true;
    const observations: ReservationWorkflowV2Observation[] = [];
    const serviceRows = new Map(addRows.map(row => [row.service.id, row]));
    for (const row of serviceRows.values()) {
      const service = row.service as unknown as Record<string, unknown>;
      const path = pointer('proposal', 'content', 'services', row.serviceIndex, 'itemCandidateRef');
      for (const candidateValue of candidates) {
        const candidate = record(candidateValue)!;
        if (!text(candidate.code) || !text(candidate.itemId) || typeof candidate.name !== 'string') continue;
        observations.push({ ref: randomUUID(), generationId: loaded.draft.generationId, kind: 'service_preview',
          status: complete ? 'complete' : 'partial', observedAt: new Date().toISOString(), propertyCode: loaded.draft.propertyCode,
          sourceMessageId: loaded.draft.source.messageId, sourceRefs: [],
          criteria: { workflow: 'services', kind: 'catalogue_candidate', serviceId: service.id,
            requestId: input.requestId, sourceAllocationId: input.allocationId, fieldPath: path,
            createRequestDigest: record(native.requestBinding)?.digest ?? null, coverage: coverage ?? null },
          coverage: { complete, notes: complete ? [] : ['native_item_catalogue_incomplete_or_create_prepare_unverified'] },
          result: { candidate: { code: candidate.code, name: candidate.name, itemId: candidate.itemId },
            catalogCoverage: coverage ?? null, saved: false } });
      }
    }
    if (!observations.length) {
      const detail = { status: text(listing?.outcome) ?? 'failed', issue: text(listing?.issue) ?? native.issue ?? 'native_item_catalogue_empty',
        requestId: input.requestId, allocationId: input.allocationId };
      return detail;
    }
    for (const observation of observations) {
      const saved = await appendServiceObservation(ctx, input, observation);
      if (saved.status !== 'ok') return { ...saved };
    }
    return { status: unsupported.length ? 'partial' : 'ok', requestId: input.requestId, allocationId: input.allocationId,
      candidates: observations.map(observation => ({ ref: observation.ref, ...(record(observation.result)?.candidate as object) })),
      unsupportedServices: unsupported.map(row => ({ serviceId: row.service.id, operation: row.service.operation,
        targetRef: row.targetRef, issue: 'saved_addon_edit_remove_not_connected' })),
      coverage, observations, nativeCreate: { outcome: native.outcome, ratePlanAvailability: native.ratePlanAvailability,
        commitOnlyFields: native.commitOnlyFields ?? [] } };
  } catch {
    return { status: 'failed', issue: 'native_service_catalogue_lookup_failed' };
  }
}

/** Prepare exact service/room Add-On amounts on the owning unsaved Create draft; this does not Save the Add-On. */
export async function reservationWorkflowV2PreviewServices(ctx: ReservationWorkflowV2ServerContext, rawInput: Input): Promise<Result> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) return { status: 'invalid_input', issue: 'service_preview_input_invalid' };
  const input = parsed.data;
  if (ctx.property.propertyCode !== 'HRCEN') return { status: 'unsupported', issue: 'service_property_not_supported' };
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return { ...loaded.result };
  const linked = serviceTargets(loaded.draft, input);
  if (linked.outcome !== 'ok') return { status: linked.outcome, issue: linked.issue };
  if (!linked.rows.length) return { status: 'needs_input', issue: input.serviceId ? 'service_target_not_found' : 'no_service_target' };
  const unsupported = linked.rows.filter(row => row.service.operation !== 'add');
  const compiledCreate = compileReservationWorkflowV2Create(loaded.draft, input.requestId, input.allocationId, ctx.property.propertyCode);
  if (compiledCreate.outcome !== 'ok') return { status: compiledCreate.outcome, issue: compiledCreate.issue,
    ...(compiledCreate.fields ? { fields: compiledCreate.fields } : {}) };
  const compiled = linked.rows.map(row => ({ row, plan: reservationWorkflowV2CompileServiceItem(loaded.draft!, input, row) }));
  const invalid = compiled.filter(item => item.plan.outcome === 'needs_input');
  if (invalid.length) return { status: 'needs_input', issue: 'service_preview_fields_unresolved',
    services: invalid.map(item => ({ serviceId: item.row.service.id, ...(item.plan as object) })),
    unsupportedServices: compiled.filter(item => item.plan.outcome === 'unsupported').map(item => ({
      serviceId: item.row.service.id, targetRef: item.row.targetRef,
      issue: item.plan.outcome !== 'ok' ? item.plan.issue : 'service_preview_unavailable',
    })) };
  const plans = compiled.flatMap(item => item.plan.outcome === 'ok' ? [item.plan] : []);
  if (!plans.length) return { status: 'unsupported', issue: 'saved_addon_edit_remove_not_connected', saved: false,
    services: compiled.map(item => ({ serviceId: item.row.service.id, targetRef: item.row.targetRef,
      status: 'unsupported', issue: item.plan.outcome !== 'ok' ? item.plan.issue : 'service_preview_unavailable' })) };
  try {
    const addonTool = await import(new URL('../../tooling/hms-cloud/stay360-addons.mjs', import.meta.url).href) as {
      previewUnsavedStay360AddOns: (page: unknown, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const items = plans.map(plan => plan.items);
    const { native, addon } = await createThenAddon(compiledCreate, (page, readForm) =>
      addonTool.previewUnsavedStay360AddOns(page, { expectedCreate: compiledCreate.nativeInput, readForm, items }));
    const preview = record(addon), nativeItems = Array.isArray(preview?.items) ? preview.items.map(record) : [];
    const createBound = native.outcome === 'prepared' && typeof record(native.requestBinding)?.digest === 'string' &&
      record(native.ratePlanAvailability) !== null;
    const results: Result[] = [];
    for (const [index, plan] of plans.entries()) {
      const nativeItem = record(nativeItems[index]);
      const actual = record(nativeItem?.item);
      const expectedPrice = positiveDecimal(plan.items.unitPrice);
      const actualPrice = positiveDecimal(actual?.unitPrice);
      const actualQuantity = positiveDecimal(actual?.quantity);
      const expectedQuantity = positiveDecimal(plan.items.quantity);
      const itemIdMatches = actual?.itemId === plan.candidate.itemId;
      const priceMatches = Boolean(expectedPrice && actualPrice === expectedPrice && actual?.totalCost && actual?.currency &&
        actual?.status === 'VALID');
      const complete = createBound && preview?.outcome === 'prepared' && preview.unsaved === true && preview.saved === false &&
        preview.propertyCode === 'HRCEN' && nativeItem?.outcome === 'prepared' &&
        itemIdMatches && priceMatches && actual?.code === plan.candidate.code &&
        actualQuantity === expectedQuantity && actual?.startDate === plan.items.startDate && actual?.endDate === plan.items.endDate;
      const businessItem = actual ? Object.fromEntries(['code', 'name', 'itemId', 'quantity', 'startDate', 'endDate',
        'unitPrice', 'frequency', 'pricingControl', 'folio', 'comment', 'currency', 'averageDaily', 'totalCost', 'status']
        .filter(key => Object.hasOwn(actual, key)).map(key => [key, actual[key]])) : null;
      const observation: ReservationWorkflowV2Observation = { ref: randomUUID(), generationId: loaded.draft!.generationId,
        kind: 'service_preview', status: complete ? 'complete' : 'partial', observedAt: new Date().toISOString(),
        propertyCode: loaded.draft!.propertyCode, sourceMessageId: loaded.draft!.source.messageId, sourceRefs: [],
        criteria: { workflow: 'services', kind: 'unsaved_addon_preview', serviceId: plan.serviceId,
          requestId: input.requestId, allocationId: input.allocationId, targetRef: plan.targetRef, targetIndex: plan.targetIndex,
          draftRevision: input.expectedRevision, inputDigest: plan.inputDigest,
          createRequestDigest: record(native.requestBinding)?.digest ?? null,
          itemCandidateRef: plan.candidateRef },
        coverage: { complete, notes: complete ? [] : [String(nativeItem?.issue ?? preview?.issue ?? native.issue ?? 'native_addon_preview_incomplete')] },
        result: { operation: 'add', saved: false, targetRef: plan.targetRef, serviceId: plan.serviceId,
          itemCandidate: plan.candidate, requestedFields: plan.items,
          native: businessItem, issue: nativeItem?.issue ?? preview?.issue ?? native.issue ?? null,
          hostValuesRequireReview: plan.reviewPaths, createRatePlanAvailability: native.ratePlanAvailability,
          priceWasNativeCalculated: Boolean(actual?.averageDaily && actual?.totalCost), } };
      const stored = await appendServiceObservation(ctx, input, observation, complete ? 'prepared' : 'failed',
        complete ? `Unsaved native Add-On preview ${String(actual?.name ?? actual?.code)}; not saved` : 'Unsaved Add-On preview needs input; not saved');
      if (stored.status !== 'ok') return { ...stored };
      results.push({ status: complete ? 'prepared' : 'needs_input', serviceId: plan.serviceId,
        observationRef: observation.ref, targetRef: plan.targetRef, item: businessItem,
        issue: text(nativeItem?.issue) ?? text(preview?.issue) ?? native.issue,
        reviewPaths: plan.reviewPaths, saved: false });
    }
    results.unshift(...compiled.filter(item => item.plan.outcome === 'unsupported').map(item => ({
      status: 'unsupported', serviceId: item.row.service.id, targetRef: item.row.targetRef,
      issue: item.plan.outcome !== 'ok' ? item.plan.issue : 'service_preview_unavailable', saved: false,
    })));
    return { status: !unsupported.length && results.every(result => result.status === 'prepared') ? 'prepared' : 'partial',
      requestId: input.requestId, allocationId: input.allocationId, nativeCreate: {
        outcome: native.outcome, ratePlanAvailability: native.ratePlanAvailability, commitOnlyFields: native.commitOnlyFields ?? [],
      }, services: results, saved: false };
  } catch {
    return { status: 'failed', issue: 'native_service_preview_failed', saved: false };
  }
}

export { reservationWorkflowV2ExecuteServices, reservationWorkflowV2ReconcileServices,
  reservationWorkflowV2ServicesExecuteInputSchema }
  from './reservation-workflow-v2-services-execute.js';
export type { ReservationWorkflowV2ServicesExecuteInput, ReservationWorkflowV2ServicesResult, ReservationWorkflowV2ServicesStatus }
  from './reservation-workflow-v2-services-execute.js';
