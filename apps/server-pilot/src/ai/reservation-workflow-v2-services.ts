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
import { findStay } from './pane-stay-lookup.js';
import { projectCloudStayFind, runCloudStayFind } from './hms-cloud-saved-stay-find.js';
import { paneStayPropertyLock } from './pane-stay-save.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { CENTURION_HMS_READ_TARGET } from '../hms/hms-read-target.js';
import { acquisitionWithin, PANE_PROPERTY_LOCK_WAIT_MS } from '../hms/property-read-lock.js';
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

/** Preserve the native dropdown controls without adding them to business-value comparisons. */
export function nativeServiceControls(value: unknown): Record<string, unknown> | undefined {
  const controls = record(record(value)?.controls);
  if (!controls) return undefined;
  const selected = Object.fromEntries(['frequency', 'pricingControl', 'folio']
    .flatMap(key => record(controls[key]) ? [[key, controls[key]]] : []));
  return Object.keys(selected).length ? selected : undefined;
}

const sourceInputSchema = z.object({ threadId: z.string().min(1).max(500), messageId: z.string().min(1).max(500),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), arrivedAt: z.string().datetime({ offset: true }) }).strict();
const inputSchema = z.object({ workItemId: z.string().uuid(), source: sourceInputSchema,
  expectedRevision: z.number().int().nonnegative(), expectedSeq: z.number().int().nonnegative(),
  requestId: z.string().min(1).max(80), allocationId: z.string().min(1).max(80),
  serviceId: z.string().min(1).max(80).optional() }).strict();

function stateContext(ctx: ReservationWorkflowV2ServerContext) {
  return { db: ctx.db, transportId: ctx.transport.id, userId: ctx.nativeBatch ? null : ctx.user.id,
    propertyCode: ctx.property.propertyCode, nativeBatch: ctx.nativeBatch };
}

export function pointer(...parts: Array<string | number>): string {
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

export function positiveDecimal(value: unknown): string | null {
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

async function currentDraft(ctx: ReservationWorkflowV2ServerContext, input: Pick<Input, 'workItemId' | 'source' | 'expectedRevision' | 'expectedSeq'>) {
  const loaded = await getReservationWorkflowV2Draft(stateContext(ctx), input);
  if (loaded.status !== 'ok') return { result: loaded, draft: null } as const;
  if (loaded.revision !== input.expectedRevision || loaded.seq !== input.expectedSeq ||
      loaded.draft.revision !== input.expectedRevision || loaded.draft.propertyCode !== ctx.property.propertyCode) {
    return { result: { status: 'stale_revision' }, draft: null } as const;
  }
  return { result: loaded, draft: reservationWorkflowV2DraftSchema.parse(loaded.draft) } as const;
}

async function createThenAddon(compiled: Extract<ReturnType<typeof compileReservationWorkflowV2Create>, { outcome: 'ok' }>,
  operation: (page: unknown, readForm: () => Promise<unknown>) => Promise<unknown>, signal?: AbortSignal) {
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
    }, { ...options, memory: null, blockServiceWorkers: true, signal });
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
      addonTool.listUnsavedStay360AddOnItems(page, { expectedCreate: compiled.nativeInput,
        expectedGuest: compiled.expectedGuest, readForm }), ctx.nativeBatch?.signal);
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
      addonTool.previewUnsavedStay360AddOns(page, { expectedCreate: compiledCreate.nativeInput,
        expectedGuest: compiledCreate.expectedGuest, readForm, items }), ctx.nativeBatch?.signal);
    const preview = record(addon), nativeItems = Array.isArray(preview?.items) ? preview.items.map(record) : [];
    const capability = (await import('./reservation-workflow-v2-services-execute.js')).linkedServiceCapability(loaded.draft, input);
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
      const controls = nativeServiceControls(actual);
      const nativeControls = createBound && preview?.propertyCode === 'HRCEN' && preview.unsaved === true && preview.saved === false &&
        itemIdMatches && actual?.code === plan.candidate.code ? controls : undefined;
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
          native: businessItem && controls ? { ...businessItem, controls } : businessItem,
          ...(nativeControls ? { nativeControls } : {}),
          issue: nativeItem?.issue ?? preview?.issue ?? native.issue ?? null,
          hostValuesRequireReview: plan.reviewPaths, createRatePlanAvailability: native.ratePlanAvailability,
          priceWasNativeCalculated: Boolean(actual?.averageDaily && actual?.totalCost), capability } };
      const stored = await appendServiceObservation(ctx, input, observation, complete ? 'prepared' : 'failed',
        complete ? `Unsaved native Add-On preview ${String(actual?.name ?? actual?.code)}; not saved` : 'Unsaved Add-On preview needs input; not saved');
      if (stored.status !== 'ok') return { ...stored };
      results.push({ status: complete ? 'prepared' : 'needs_input', serviceId: plan.serviceId,
        observationRef: observation.ref, targetRef: plan.targetRef, item: businessItem,
        ...(nativeControls ? { nativeControls } : {}),
        issue: text(nativeItem?.issue) ?? text(preview?.issue) ?? native.issue,
        reviewPaths: plan.reviewPaths, capability, saved: false });
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

/** A saved service is bound to a draft hint; the caller never supplies an HMS identity. */
export type ReservationWorkflowV2SavedServicesInput = Omit<ReservationWorkflowV2ServicesInput, 'allocationId'> & {
  targetRef: { kind: 'saved_target'; requestId: string; hintId: string };
};

export function savedValue(draft: ReservationWorkflowV2Draft, path: string): unknown {
  let value: unknown = draft;
  let prefix = '';
  for (const part of path.split('/').slice(1).map(decodeURIComponent)) {
    prefix += `/${encodeURIComponent(part)}`;
    value = Array.isArray(value) ? (/^\d+$/.test(part) ? value[Number(part)] : value.find(row => record(row)?.id === part)) : record(value)?.[part];
    const override = draft.fieldOverrides[prefix];
    if (override?.state === 'set') value = override.value;
    else if (override && override.state !== 'inherit') value = null;
  }
  return value;
}

export function savedTarget(draft: ReservationWorkflowV2Draft, input: ReservationWorkflowV2SavedServicesInput) {
  if (input.targetRef.requestId !== input.requestId) return null;
  const request = draft.proposal.content.requests.find(row => row.id === input.requestId);
  if (!request || !('targets' in request.body)) return null;
  const root = pointer('proposal', 'content', 'requests', input.requestId, 'body', 'targets');
  const include = savedValue(draft, `${root}/include`), exclude = savedValue(draft, `${root}/exclude`);
  if (savedValue(draft, `${root}/mode`) !== 'explicit' || !Array.isArray(include) || !Array.isArray(exclude) || exclude.length) return null;
  const index = include.findIndex(row => record(row)?.id === input.targetRef.hintId);
  if (index < 0) return null;
  const hintRoot = `${root}/include/${index}`;
  const hintFields = ['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture'];
  if (request.kind === 'amend' && hintFields.some(key => draft.fieldOverrides[`${hintRoot}/${key}`]?.state === 'unknown')) return null;
  const hint = Object.fromEntries(['id', 'confirmation', 'guestName', 'bookedArrival', 'bookedDeparture']
    .map(key => {
      const value = savedValue(draft, `${hintRoot}/${key}`);
      return [key, request.kind === 'amend' && key !== 'id' && typeof value === 'string' ? value.trim() || null : value];
    }));
  const selectionPath = `${hintRoot}/suggestedRef`;
  const matches = draft.proposal.content.services.flatMap((service, serviceIndex) => {
    if (input.serviceId && service.id !== input.serviceId) return [];
    if (service.ownerRequestId !== null && service.ownerRequestId !== input.requestId) return [];
    return service.targets.flatMap((target, targetIndex) => canonicalJson(target.target) === canonicalJson(input.targetRef)
      ? [{ service, serviceIndex, target, targetIndex }] : []);
  });
  if (!matches.length || input.serviceId && matches.length !== 1) return null;
  return { request, hint, selectionPath, matches };
}

export function samePerson(left: unknown, right: unknown) {
  const normalize = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
  return normalize(left) !== '' && normalize(left) === normalize(right);
}

/** Stay 360's guestfullname displays Last, First; keep all name parts and their order. */
export function nativeServiceGuestNameMatches(nativeName: unknown, expectedName: unknown): boolean {
  if (samePerson(nativeName, expectedName)) return true;
  if (typeof nativeName !== 'string') return false;
  const parts = nativeName.split(',');
  return parts.length === 2 && Boolean(parts[0]?.trim() && parts[1]?.trim()) &&
    samePerson(`${parts[1]?.trim()} ${parts[0]?.trim()}`, expectedName);
}

export function savedStayMatches(stay: Record<string, unknown>, hint: Record<string, unknown>, requireConfirmation = true) {
  const name = text(hint.guestName);
  // Amend accepts a surname by itself, or the full first and last name.
  const amendName = !name || (typeof stay.firstName === 'string' && typeof stay.lastName === 'string' &&
    name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() ===
      (name.includes(' ') ? `${stay.firstName} ${stay.lastName}` : stay.lastName)
        .normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase());
  return typeof stay.confirmation === 'string' && (hint.confirmation ? stay.confirmation === hint.confirmation : !requireConfirmation) && stay.status === 'Reserved'
    && typeof stay.firstName === 'string' && typeof stay.lastName === 'string' && typeof stay.arrival === 'string'
    && typeof stay.departure === 'string' && (requireConfirmation
      ? !hint.guestName || samePerson(hint.guestName, `${stay.firstName} ${stay.lastName}`) : amendName)
    && (!hint.bookedArrival || hint.bookedArrival === stay.arrival) && (!hint.bookedDeparture || hint.bookedDeparture === stay.departure);
}

export function selectedSavedStay(draft: ReservationWorkflowV2Draft, input: ReservationWorkflowV2SavedServicesInput,
  found: NonNullable<ReturnType<typeof savedTarget>>) {
  const selected = savedValue(draft, found.selectionPath);
  const observation = draft.observations.find(row => row.ref === selected && row.kind === 'stay_candidate' && row.status === 'complete'
    && row.coverage.complete === true && row.generationId === draft.generationId && row.propertyCode === draft.propertyCode
    && row.sourceMessageId === draft.source.messageId && row.criteria.kind === 'saved_target'
    && row.criteria.requestId === input.requestId && row.criteria.hintId === input.targetRef.hintId
    && (found.request.kind === 'amend' ? row.criteria.workflow === 'amend' && row.criteria.selectionPath === found.selectionPath
      : row.criteria.workflow === 'services' && row.criteria.fieldPath === found.selectionPath));
  const stay = record(record(observation?.result)?.candidate);
  const query = record(observation?.criteria.query);
  const normalized = (value: unknown) => typeof value === 'string' ? value.trim() || null : value ?? null;
  if (!observation || !stay || !query || !savedStayMatches(stay, found.hint, found.request.kind !== 'amend') ||
      ['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture'].some(key => found.request.kind === 'amend'
        ? normalized(query[key]) !== normalized(found.hint[key]) : (query[key] ?? null) !== (found.hint[key] || null))) return null;
  if (found.request.kind !== 'amend') return { observation, stay };
  if (draft.operationResults.some(row => row.workflow === 'amend' && row.requestId === input.requestId && !row.allocationId &&
      (row.status === 'succeeded' || row.status === 'unknown'))) return null;
  const outcomes = draft.operationResults.filter(row => row.workflow === 'amend' && row.requestId === input.requestId &&
    row.allocationId === input.targetRef.hintId && (row.status === 'succeeded' || row.status === 'unknown'));
  if (outcomes.some(row => row.status === 'unknown') || outcomes.length > 1) return null;
  const completed = outcomes[0];
  if (!completed) return { observation, stay };
  const receipt = draft.observations.find(row => completed.observationRefs.includes(row.ref) && row.kind === 'stay_candidate' &&
    row.status === 'complete' && row.coverage.complete && row.generationId === draft.generationId &&
    row.propertyCode === draft.propertyCode && row.sourceMessageId === draft.source.messageId && row.criteria.workflow === 'amend' &&
    row.criteria.requestId === input.requestId && row.criteria.hintId === input.targetRef.hintId &&
    (row.criteria.idempotencyKey === completed.id || row.criteria.operationId === completed.id));
  const prepared = draft.observations.find(row => row.ref === receipt?.criteria.prepareObservationRef && row.kind === 'rate_availability' &&
    row.status === 'complete' && row.coverage.complete && row.generationId === draft.generationId && row.propertyCode === draft.propertyCode &&
    row.sourceMessageId === draft.source.messageId && row.criteria.workflow === 'amend' && row.criteria.requestId === input.requestId &&
    row.criteria.hintId === input.targetRef.hintId);
  const before = record(record(receipt?.result)?.before) ?? record(record(prepared?.result)?.before);
  const after = record(record(receipt?.result)?.nativeReadback);
  if (!before || !after || !stay.reservationStayId || before.reservationStayId !== stay.reservationStayId ||
      before.guestId !== stay.guestId || after.nativeStayId !== stay.reservationStayId ||
      after.confirmation !== stay.confirmation || !text(after.firstName) || !text(after.lastName) ||
      !validDate(after.arrival) || !validDate(after.departure)) return null;
  return { observation, stay: { ...stay, ...after, reservationStayId: stay.reservationStayId, guestId: stay.guestId, status: 'Reserved' } };
}

/** Read-only saved-stay lookup, then catalogue and exact saved-row observations for that selection. */
export async function reservationWorkflowV2LookupSavedServices(ctx: ReservationWorkflowV2ServerContext,
  input: ReservationWorkflowV2SavedServicesInput): Promise<Result> {
  if (ctx.property.propertyCode !== 'HRCEN' || input.targetRef.kind !== 'saved_target') return { status: 'unsupported', issue: 'service_property_not_supported' };
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return { ...loaded.result };
  const draft = loaded.draft, found = savedTarget(draft, input);
  if (!found) return { status: 'needs_input', issue: 'one_saved_stay_confirmation_required' };
  const amendSelection = found.request.kind === 'amend' ? selectedSavedStay(draft, input, found) : null;
  if (found.request.kind === 'amend' && !amendSelection) return { status: 'needs_input', issue: 'select_amend_saved_stay_first' };
  const confirmation = amendSelection?.stay.confirmation ?? found.hint.confirmation;
  const arrival = amendSelection?.stay.arrival ?? found.hint.bookedArrival;
  if (!/^\d+-\d+$/.test(String(confirmation ?? ''))) return { status: 'needs_input', issue: 'one_saved_stay_confirmation_required' };
  const resolved = paneStayHmsTargetForTransport(ctx.transport.id);
  if (!resolved.ok || (['propertyCode', 'secretId', 'browserSlot', 'origin', 'installationEnvName'] as const)
    .some(key => resolved.target[key] !== CENTURION_HMS_READ_TARGET[key])) return { status: 'unsupported', issue: 'service_property_session_unavailable' };
  const query = Object.fromEntries(['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture'].map(key => [key, found.hint[key] || null]));
  const request = { confirmation: String(confirmation), ...(typeof arrival === 'string' && arrival ? { arrival } : {}) };
  const result = ctx.nativeBatch
    ? await (async () => {
      const lock = paneStayPropertyLock(resolved.target);
      if (!lock) return null;
      return lock.withLock(async () => projectCloudStayFind(request,
        await runCloudStayFind({ request, target: resolved.target, signal: ctx.nativeBatch!.signal })),
      { ...acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS), signal: ctx.nativeBatch!.signal });
    })().catch(() => null)
    : await findStay(request, { target: resolved.target, lock: () => paneStayPropertyLock(resolved.target),
      acquisition: acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS) }).catch(() => null);
  const stay = record(result?.stay), selectedStay = amendSelection?.stay;
  const sameSelected = Boolean(stay && selectedStay && stay.confirmation === selectedStay.confirmation && stay.status === 'Reserved' &&
    stay.arrival === selectedStay.arrival && stay.departure === selectedStay.departure &&
    samePerson(stay.firstName, selectedStay.firstName) && samePerson(stay.lastName, selectedStay.lastName));
  const complete = Boolean(result?.outcome === 'found' && !result.arrivalMismatch && stay &&
    (amendSelection ? sameSelected : savedStayMatches(stay, found.hint)));
  let observation: ReservationWorkflowV2Observation | undefined;
  if (!amendSelection) {
    observation = { ref: randomUUID(), generationId: draft.generationId, kind: 'stay_candidate',
      status: complete ? 'complete' : 'partial', observedAt: new Date().toISOString(), propertyCode: draft.propertyCode,
      sourceMessageId: draft.source.messageId, sourceRefs: [], criteria: { workflow: 'services', kind: 'saved_target',
        requestId: input.requestId, hintId: input.targetRef.hintId, fieldPath: found.selectionPath, query },
      coverage: { complete, notes: complete ? [] : ['Exact Reserved stay was not verified.'] },
      result: { outcome: complete ? 'found' : 'needs_input', candidate: complete ? stay : null } };
    const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), { workItemId: input.workItemId, source: input.source, observation });
    if (appended.status !== 'ok') return { ...appended };
  }
  if (!complete || !stay) return { status: 'needs_input', issue: 'reserved_stay_not_verified' };
  const selected = amendSelection ?? selectedSavedStay(draft, input, found);
  if (!selected || (amendSelection ? !sameSelected : canonicalJson(selected.stay) !== canonicalJson(stay)))
    return { status: 'needs_input', issue: 'select_exact_saved_stay', observationRef: observation?.ref };
  try {
    const addon = await import(new URL('../../tooling/hms-cloud/stay360-addons-session.mjs', import.meta.url).href) as {
      withStay360AddOnSession: (callback: (session: { runTool: (request: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>,
        options?: Record<string, unknown>) => Promise<unknown>;
    };
    const guestName = `${stay.firstName} ${stay.lastName}`;
    const native = record(await addon.withStay360AddOnSession(async ({ runTool }) => {
      const read = record(await runTool({ tool: 'read', confirmation: stay.confirmation, guestName, arrivalDate: stay.arrival }));
      const target = record(read?.target);
      if (read?.outcome !== 'ok' || read.propertyCode !== 'HRCEN' || !target || target.confirmation !== stay.confirmation ||
          target.status !== 'Reserved' || target.arrival !== stay.arrival || target.departure !== stay.departure || !nativeServiceGuestNameMatches(target.guestName, guestName) ||
          record(read.coverage)?.complete !== true) return null;
      if (!Array.isArray(read.items)) return null;
      const summaries = read.items.map(record).filter((row): row is Record<string, unknown> => Boolean(row));
      const ids = summaries.map(row => text(row.nativeId)).filter((id): id is string => Boolean(id && /^\d+$/.test(id)));
      if (ids.length !== summaries.length || new Set(ids).size !== ids.length || record(read.coverage)?.loaded !== ids.length ||
          record(read.coverage)?.reportedTotal !== ids.length) return null;
      const detailed = ids.length ? record(await runTool({ tool: 'read', confirmation: stay.confirmation, detailIds: ids })) : read;
      const details = Array.isArray(detailed?.details) ? detailed.details : [];
      if (detailed?.outcome !== 'ok' || record(detailed.coverage)?.complete !== true || details.length !== ids.length ||
          ids.some(id => !details.some(row => record(row)?.nativeId === id))) return null;
      const needsCatalogue = found.matches.some(row => savedValue(draft, pointer('proposal', 'content', 'services', row.serviceIndex, 'operation')) === 'add');
      const listing = needsCatalogue ? record(await runTool({ tool: 'list', confirmation: stay.confirmation })) : null;
      if (needsCatalogue && (listing?.outcome !== 'ok' || record(listing.coverage)?.complete !== true || !Array.isArray(listing.candidates))) return null;
      return { details, candidates: Array.isArray(listing?.candidates) ? listing.candidates : [] };
    }, { headless: true, blockServiceWorkers: true, signal: ctx.nativeBatch?.signal }));
    if (!native) return { status: 'needs_input', issue: 'saved_addon_read_incomplete' };
    let count = 0;
    for (const row of found.matches) {
      const operation = savedValue(draft, pointer('proposal', 'content', 'services', row.serviceIndex, 'operation'));
      if (operation !== 'add' && operation !== 'edit' && operation !== 'remove') continue;
      const itemPath = pointer('proposal', 'content', 'services', row.serviceIndex, 'itemCandidateRef');
      const savedRowPath = pointer('proposal', 'content', 'services', row.serviceIndex, 'targets', row.targetIndex, 'savedRowCandidateRef');
      const options = operation === 'add' ? native.candidates : native.details;
      for (const raw of options as unknown[]) {
        const candidate = record(raw), fields = record(candidate?.fields);
        if (!candidate || (operation === 'add' ? !text(candidate.code) || !text(candidate.itemId) : !text(candidate.nativeId) || !fields)) continue;
        const item: ReservationWorkflowV2Observation = { ref: randomUUID(), generationId: draft.generationId, kind: 'service_preview',
          status: 'complete', observedAt: new Date().toISOString(), propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId,
          sourceRefs: [selected.observation.ref], criteria: { workflow: 'services', kind: operation === 'add' ? 'catalogue_candidate' : 'saved_row_candidate',
            requestId: input.requestId, serviceId: row.service.id, targetRef: input.targetRef, targetObservationRef: selected.observation.ref,
            fieldPath: operation === 'add' ? itemPath : savedRowPath }, coverage: { complete: true, notes: [] },
          result: { candidate } };
        const saved = await appendReservationWorkflowV2Observation(stateContext(ctx), { workItemId: input.workItemId, source: input.source, observation: item });
        if (saved.status !== 'ok') return { ...saved };
        count += 1;
      }
    }
    return { status: 'ok', targetRef: input.targetRef, candidates: count, saved: false };
  } catch { return { status: 'failed', issue: 'saved_addon_read_failed', saved: false }; }
}

const savedBusinessKeys = ['code', 'name', 'itemId', 'quantity', 'startDate', 'endDate', 'unitPrice', 'frequency',
  'pricingControl', 'folio', 'comment', 'currency', 'averageDaily', 'totalCost', 'status'] as const;
export function savedServiceBusiness(value: unknown): Record<string, unknown> | null {
  const item = record(value);
  if (!item || savedBusinessKeys.some(key => !Object.hasOwn(item, key))) return null;
  return Object.fromEntries(savedBusinessKeys.map(key => [key, item[key]]));
}

/** Compile the exact saved target and one Add-On without trusting caller-supplied native identifiers. */
export function reservationWorkflowV2CompileSavedService(draft: ReservationWorkflowV2Draft,
  input: ReservationWorkflowV2SavedServicesInput) {
  if (!input.serviceId) return { status: 'needs_input' as const, issue: 'one_service_target_required' };
  const found = savedTarget(draft, input), selected = found && selectedSavedStay(draft, input, found);
  if (!found || !selected || found.matches.length !== 1) return { status: 'needs_input' as const, issue: 'select_exact_saved_stay' };
  const row = found.matches[0]!;
  const operation = savedValue(draft, pointer('proposal', 'content', 'services', row.serviceIndex, 'operation'));
  if (operation !== 'add' && operation !== 'edit' && operation !== 'remove') return { status: 'needs_input' as const, issue: 'service_operation_required' };
  const selectionPath = operation === 'add' ? pointer('proposal', 'content', 'services', row.serviceIndex, 'itemCandidateRef')
    : pointer('proposal', 'content', 'services', row.serviceIndex, 'targets', row.targetIndex, 'savedRowCandidateRef');
  const selectedRef = savedValue(draft, selectionPath);
  const candidateObservation = draft.observations.find(item => item.ref === selectedRef && item.kind === 'service_preview'
    && item.status === 'complete' && item.coverage.complete === true && item.generationId === draft.generationId
    && item.propertyCode === draft.propertyCode && item.sourceMessageId === draft.source.messageId
    && item.criteria.workflow === 'services' && item.criteria.requestId === input.requestId
    && item.criteria.serviceId === row.service.id && item.criteria.fieldPath === selectionPath
    && item.criteria.targetObservationRef === selected.observation.ref
    && canonicalJson(item.criteria.targetRef) === canonicalJson(input.targetRef)
    && item.criteria.kind === (operation === 'add' ? 'catalogue_candidate' : 'saved_row_candidate'));
  const candidate = record(record(candidateObservation?.result)?.candidate);
  const prior = savedServiceBusiness(candidate?.fields), nativeId = text(candidate?.nativeId);
  if (!candidateObservation || !candidate || (operation === 'add' ? !text(candidate.code) || !text(candidate.itemId)
    : !nativeId || !/^\d+$/.test(nativeId) || !prior)) return { status: 'needs_input' as const, issue: operation === 'add' ? 'select_native_item' : 'select_exact_saved_addon_row' };
  const fields: Record<string, string> = {}, paths: Record<string, string> = {}, errors: string[] = [];
  if (operation !== 'remove') for (const field of ['quantity', 'startDate', 'endDate', 'unitPrice', 'frequency', 'pricingControl', 'folio', 'comment'] as const) {
    const explicitTarget = pointer('proposal', 'content', 'services', row.serviceIndex, 'targets', row.targetIndex, 'fields', field);
    const explicitOverride = draft.fieldOverrides[explicitTarget];
    if (operation === 'edit' && field === 'comment' && explicitOverride?.state === 'set' && explicitOverride.value === '') {
      fields.comment = ''; paths.comment = explicitTarget; continue;
    }
    const resolved = effectiveServiceField(draft, row.service as unknown as Record<string, unknown>, row.serviceIndex,
      row.target as unknown as Record<string, unknown>, row.targetIndex, field);
    if ('issue' in resolved) { errors.push(field); continue; }
    if (resolved.value === null || resolved.value === undefined || resolved.value === '') {
      const targetPath = pointer('proposal', 'content', 'services', row.serviceIndex, 'targets', row.targetIndex, 'fields', field);
      const override = draft.fieldOverrides[targetPath];
      if (operation === 'edit' && field === 'comment' && override?.state === 'set' && override.value === '') {
        fields.comment = ''; paths.comment = targetPath;
      }
      continue;
    }
    if (typeof resolved.value !== 'string') { errors.push(field); continue; }
    if (field === 'quantity' && !positiveDecimal(resolved.value) || field === 'unitPrice' &&
        (operation === 'add' ? !positiveDecimal(resolved.value) : !/^\d+(?:\.\d+)?$/.test(resolved.value)) ||
        (field === 'startDate' || field === 'endDate') && !validDate(resolved.value)) { errors.push(field); continue; }
    fields[field] = resolved.value; paths[field] = resolved.path;
  }
  if (operation === 'add' && !fields.quantity && (row.service.quantityRequest.scope === 'per_target' ||
      row.service.quantityRequest.scope === 'overall' && row.service.targets.length === 1)) {
    const quantity = savedValue(draft, pointer('proposal', 'content', 'services', row.serviceIndex, 'quantityRequest', 'value'));
    if (typeof quantity === 'string' && quantity && positiveDecimal(quantity)) {
      fields.quantity = quantity;
      paths.quantity = pointer('proposal', 'content', 'services', row.serviceIndex, 'quantityRequest', 'value');
    }
  }
  const targetQuantityPath = pointer('proposal', 'content', 'services', row.serviceIndex, 'targets', row.targetIndex, 'fields', 'quantity');
  if (operation === 'add' && row.service.targets.length > 1 && row.service.quantityRequest.scope !== 'per_target' &&
      paths.quantity !== targetQuantityPath) errors.push('quantity_must_be_allocated_to_this_stay');
  if (operation === 'add' && (!fields.quantity || !fields.startDate || !fields.endDate || !fields.unitPrice)) {
    errors.push('positive_quantity_dates_and_unit_price_required');
  }
  if (operation === 'add' && fields.startDate && fields.endDate && fields.startDate > fields.endDate) errors.push('dates');
  if (operation === 'edit' && !Object.keys(fields).length) errors.push('edit_fields_required');
  if (errors.length) return { status: 'needs_input' as const, issue: 'service_fields_incomplete_or_invalid', fields: errors };
  const requested = operation === 'add' ? { code: candidate.code, ...fields }
    : operation === 'edit' ? { operation, nativeId, patch: fields } : { operation, nativeId };
  const reviewPaths = [found.selectionPath, selectionPath, ...Object.values(paths)];
  const inputDigest = hash({ requestId: input.requestId, targetRef: input.targetRef, serviceId: row.service.id,
    operation, selectedStayRef: selected.observation.ref, candidateRef: candidateObservation.ref, requested });
  return { status: 'ok', found, selected, row, operation, candidateObservation, candidate,
    prior, nativeId, fields, paths, requested, reviewPaths, inputDigest } as const;
}

/** Unsaved, single-item preparation. A later Save must reprepare and bind its own durable approval. */
export async function reservationWorkflowV2PreviewSavedServices(ctx: ReservationWorkflowV2ServerContext,
  input: ReservationWorkflowV2SavedServicesInput): Promise<Result> {
  if (ctx.property.propertyCode !== 'HRCEN') return { status: 'unsupported', issue: 'service_property_not_supported' };
  const loaded = await currentDraft(ctx, input);
  if (!loaded.draft) return { ...loaded.result };
  const draft = loaded.draft, plan = reservationWorkflowV2CompileSavedService(draft, input);
  if (plan.status !== 'ok') return plan;
  const { selected, row, operation, candidateObservation, candidate, prior, nativeId, fields, requested, reviewPaths, inputDigest } = plan;
  try {
    const addon = await import(new URL('../../tooling/hms-cloud/stay360-addons-session.mjs', import.meta.url).href) as {
      withStay360AddOnSession: (callback: (session: { runTool: (request: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>,
        options?: Record<string, unknown>) => Promise<unknown>;
    };
    const stay = selected.stay, guestName = `${stay.firstName} ${stay.lastName}`;
    const staged = record(await addon.withStay360AddOnSession(async ({ runTool }) => {
      const read = record(await runTool({ tool: 'read', confirmation: stay.confirmation, guestName, arrivalDate: stay.arrival }));
      const target = record(read?.target);
      if (read?.outcome !== 'ok' || read.propertyCode !== 'HRCEN' || record(read.coverage)?.complete !== true ||
          !target || target.confirmation !== stay.confirmation || target.status !== 'Reserved' || target.arrival !== stay.arrival ||
          target.departure !== stay.departure || !nativeServiceGuestNameMatches(target.guestName, guestName)) return null;
      const prepared = record(await runTool(operation === 'add'
        ? { tool: 'prepare', confirmation: stay.confirmation, items: [requested] }
        : { tool: 'prepareChanges', confirmation: stay.confirmation, changes: [requested] }));
      if (prepared?.outcome !== 'prepared' || prepared.saved !== false || prepared.propertyCode !== 'HRCEN') return null;
      if (operation === 'add') {
        const actual = Array.isArray(prepared.items) ? prepared.items[0] : null;
        const native = savedServiceBusiness(actual);
        if (!native || native.code !== candidate.code || native.itemId !== candidate.itemId || native.status !== 'VALID' ||
            positiveDecimal(native.quantity) !== positiveDecimal(fields.quantity) || positiveDecimal(native.unitPrice) !== positiveDecimal(fields.unitPrice) ||
            native.startDate !== fields.startDate || native.endDate !== fields.endDate || !text(native.currency) || !text(native.totalCost)) return null;
        const controls = nativeServiceControls(actual);
        return { native: controls ? { ...native, controls } : native, ...(controls ? { nativeControls: controls } : {}) };
      }
      const change = record(Array.isArray(prepared.changes) ? prepared.changes[0] : null);
      const before = record(change?.before), after = record(change?.after);
      if (!change || change.operation !== operation || change.nativeId !== nativeId || before?.nativeId !== nativeId ||
          canonicalJson(savedServiceBusiness(before.fields)) !== canonicalJson(prior) ||
          (operation === 'edit' && (after?.nativeId !== nativeId || !savedServiceBusiness(after.fields)))) return null;
      const afterFields = record(after?.fields);
      const controls = operation === 'edit' && text(afterFields?.code) && text(afterFields?.itemId) &&
        afterFields?.code === prior?.code && afterFields?.itemId === prior?.itemId ? nativeServiceControls(afterFields) : undefined;
      return { before, after: operation === 'remove' ? null : after, ...(controls ? { nativeControls: controls } : {}) };
    }, { headless: true, blockServiceWorkers: true, signal: ctx.nativeBatch?.signal }));
    if (!staged) return { status: 'needs_input', issue: 'saved_addon_prepare_unverified', saved: false };
    const capability = await (await import('./reservation-workflow-v2-services-execute.js')).savedServiceCapability(selected.stay);
    const observation: ReservationWorkflowV2Observation = { ref: randomUUID(), generationId: draft.generationId, kind: 'service_preview',
      status: 'complete', observedAt: new Date().toISOString(), propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId,
      sourceRefs: [selected.observation.ref, candidateObservation.ref], criteria: { workflow: 'services', kind: 'saved_addon_preview',
        requestId: input.requestId, serviceId: row.service.id, targetRef: input.targetRef, targetObservationRef: selected.observation.ref,
        candidateRef: candidateObservation.ref, inputDigest, reviewPaths }, coverage: { complete: true, notes: [] },
      result: { operation, targetRef: input.targetRef, saved: false, requested, ...staged,
        priceWasNativeCalculated: true, financialEffect: operation === 'remove' ? 'unknown' : null, capability } };
    const appended = await appendReservationWorkflowV2Observation(stateContext(ctx), { workItemId: input.workItemId, source: input.source, observation });
    if (appended.status !== 'ok') return { ...appended };
    const recorded = await recordReservationWorkflowV2Result(stateContext(ctx), { workItemId: input.workItemId, source: input.source,
      result: { id: observation.ref,
        generationId: draft.generationId, requestId: input.requestId, allocationId: null, workflow: 'services', status: 'prepared',
        draftRevision: input.expectedRevision, observationRefs: [observation.ref], updatedAt: new Date().toISOString(),
        summary: 'Infor Add-On checked; not saved' } });
    if (recorded.status !== 'ok') return { ...recorded };
    return { status: 'prepared', targetRef: input.targetRef, serviceId: row.service.id, observationRef: observation.ref,
      reviewPaths, ...staged, capability, saved: false };
  } catch { return { status: 'failed', issue: 'saved_addon_prepare_failed', saved: false }; }
}
