/** Cancellable, actorless native observations. Caller owns fencing, persistence, and source eligibility. */
import { randomUUID } from 'node:crypto';
import { canonicalJson } from './draft-approval.js';
import { reservationWorkflowV2DraftSchema, type ReservationWorkflowV2Draft, type ReservationWorkflowV2Observation } from './reservation-workflow-v2-contract.js';
import { compileReservationWorkflowV2Create } from './reservation-workflow-v2-tools.js';
import { reservationWorkflowV2ServicesForAllocation, reservationWorkflowV2CompileServiceItem,
  reservationWorkflowV2CompileSavedService, nativeServiceGuestNameMatches, savedServiceBusiness,
  savedTarget, selectedSavedStay, savedStayMatches, savedValue, samePerson, pointer, positiveDecimal,
  type ReservationWorkflowV2ServicesInput, type ReservationWorkflowV2SavedServicesInput } from './reservation-workflow-v2-services.js';
import { runCloudStayFind, projectCloudStayFind } from './hms-cloud-saved-stay-find.js';
import { paneStayHmsTargetForTransport } from './pane-stay-spawn-env.js';
import { paneStayLookupEnabled } from './pane-stay-lookup.js';
import { CENTURION_HMS_READ_TARGET } from '../hms/hms-read-target.js';

export type AddOnObservationInput = { draft: ReservationWorkflowV2Draft; input: ReservationWorkflowV2ServicesInput | ReservationWorkflowV2SavedServicesInput; transportId: string; signal: AbortSignal };
export type AddOnObservationResult = { status: string; observations: ReservationWorkflowV2Observation[]; issue?: string };
type NativeCreate = { outcome?: string; issue?: string; requestBinding?: { request?: unknown; digest?: unknown }; ratePlanAvailability?: unknown; commitOnlyFields?: string[] };
type CompiledCreate = Pick<Extract<ReturnType<typeof compileReservationWorkflowV2Create>, { outcome: 'ok' }>, 'nativeInput' | 'expectedGuest'>;
export type CheckAddOnsTarget =
  | { kind: 'unsaved'; nativeInput: CompiledCreate['nativeInput']; expectedGuest: CompiledCreate['expectedGuest']; nativeBindingDigest: string }
  | { kind: 'saved'; confirmation: string; guestName: string; arrival: string; departure: string };
export type CheckAddOnsItem = { serviceId: string; operation?: 'add' | 'edit' | 'remove'; code: string; quantity: string;
  unitPrice: string; startDate: string; endDate: string };
export type CheckAddOnsResult = { status: 'prepared' | 'needs_input' | 'failed'; saved: false;
  coverage: { complete: boolean; loaded?: number; reportedTotal?: number }; candidates: Array<Record<string, unknown>>;
  previews: Array<Record<string, unknown>>; target?: Record<string, unknown>; issue?: string };
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const nativeServiceControls = (value: unknown): Record<string, unknown> | undefined => {
  const controls = record(record(value)?.controls);
  if (!controls) return undefined;
  const selected = Object.fromEntries(['frequency', 'pricingControl', 'folio']
    .flatMap(key => record(controls[key]) ? [[key, controls[key]]] : []));
  return Object.keys(selected).length ? selected : undefined;
};

function validate({ draft, input, transportId, signal }: AddOnObservationInput): AddOnObservationResult | null {
  signal.throwIfAborted();
  if (!reservationWorkflowV2DraftSchema.safeParse(draft).success || !input || draft.workItemId !== input.workItemId ||
      draft.transportId !== transportId || canonicalJson(draft.source) !== canonicalJson(input.source) || draft.revision !== input.expectedRevision)
    return { status: 'stale_revision', issue: 'service_draft_context_mismatch', observations: [] };
  if (draft.propertyCode !== 'HRCEN') return { status: 'unsupported', issue: 'service_property_not_supported', observations: [] };
  const resolved = paneStayHmsTargetForTransport(transportId);
  if (!resolved.ok || (['propertyCode', 'secretId', 'browserSlot', 'origin', 'installationEnvName'] as const)
    .some(key => resolved.target[key] !== CENTURION_HMS_READ_TARGET[key]))
    return { status: 'unsupported', issue: 'service_property_session_unavailable', observations: [] };
  if (!text(input.requestId) || ('allocationId' in input ? !text(input.allocationId) : input.targetRef?.kind !== 'saved_target' || !text(input.targetRef.hintId)))
    return { status: 'invalid_input', issue: 'service_input_invalid', observations: [] };
  return null;
}

/** Caller holds the resolved HRCEN property lock for the entire awaited call, including cleanup. */
export async function lookupAddOns(args: AddOnObservationInput): Promise<AddOnObservationResult> {
  const invalid = validate(args); if (invalid) return invalid;
  const { draft, input, transportId, signal } = args;
  const result = 'allocationId' in input ? await lookupUnsaved(draft, input, signal) : await lookupSaved(draft, input, transportId, signal);
  signal.throwIfAborted();
  return result;
}

/** Caller holds the resolved HRCEN property lock for the entire awaited call, including cleanup. */
export async function previewAddOns(args: AddOnObservationInput): Promise<AddOnObservationResult> {
  const invalid = validate(args); if (invalid) return invalid;
  const { draft, input, signal } = args;
  const result = 'allocationId' in input ? await previewUnsaved(draft, input, signal) : await previewSaved(draft, input, signal);
  signal.throwIfAborted();
  return result;
}


async function createThenAddon(compiled: CompiledCreate,
  operation: (page: unknown, readForm: () => Promise<unknown>) => Promise<unknown>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (compiled.nativeInput.mode !== 'prepare') throw new Error('create_prepare_required');
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
      signal?.throwIfAborted();
      await callback(session);
      signal?.throwIfAborted();
      const readForm = () => session.runTool({ tool: 'readGuestStayForm', propertyCode: 'HRCEN' });
      addon = await operation(session.page, readForm);
      signal?.throwIfAborted();
    }, { ...options, memory: null, blockServiceWorkers: true, signal });
  const native = await createTool.createReservation(compiled.nativeInput, { allowRealGuest: true,
    expectedGuest: compiled.expectedGuest, requireExplicitGuestSelection: true, allowCommitOnlyBillingReference: true,
    withSession });
  signal?.throwIfAborted();
  return { native, addon };
}

/** Caller holds the HRCEN property lock through cleanup and fences source and persistence. */
export async function checkAddOns({ propertyCode, target, items, signal }: { propertyCode: string; target: CheckAddOnsTarget;
  items: CheckAddOnsItem[]; signal: AbortSignal }): Promise<CheckAddOnsResult> {
  signal.throwIfAborted();
  const result = (status: CheckAddOnsResult['status'], issue: string): CheckAddOnsResult =>
    ({ status, issue, saved: false, coverage: { complete: false }, candidates: [], previews: [] });
  const validDate = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (propertyCode !== 'HRCEN' || !target || !Array.isArray(items) || !items.length || items.length > 100 ||
      items.some(item => !item || (item.operation !== undefined && item.operation !== 'add') ||
        !text(item.serviceId) || !text(item.code) || item.code !== item.code.trim() ||
        !positiveDecimal(item.quantity) || !positiveDecimal(item.unitPrice) || !validDate(item.startDate) || !validDate(item.endDate)) ||
      new Set(items.map(item => item.serviceId)).size !== items.length)
    return result('needs_input', 'addon_check_input_unresolved');
  if (target.kind === 'unsaved') {
    if (target.nativeInput?.mode !== 'prepare' || target.nativeInput?.propertyCode !== 'HRCEN' ||
        !text(target.expectedGuest?.firstName) || !text(target.expectedGuest?.lastName) ||
        !/^[a-f0-9]{64}$/.test(target.nativeBindingDigest ?? ''))
      return result('needs_input', 'addon_create_binding_required');
  } else if (target.kind === 'saved') {
    if (!paneStayLookupEnabled()) return result('needs_input', 'pane_stay_lookup_flag_off');
    if (!/^\d+-\d+$/.test(target.confirmation ?? '') || !text(target.guestName) ||
        !validDate(target.arrival) || !validDate(target.departure)) return result('needs_input', 'addon_saved_target_required');
  } else return result('needs_input', 'addon_target_unresolved');

  const nativeItems = items.map(({ code, quantity, unitPrice, startDate, endDate }) => ({ code, quantity, unitPrice, startDate, endDate }));
  const matched = (listing: Record<string, unknown> | null) => {
    const coverage = record(listing?.coverage);
    const rows = Array.isArray(listing?.candidates) ? listing.candidates.map(record).filter((row): row is Record<string, unknown> => !!row) : [];
    const candidates = items.flatMap(item => rows.filter(row => row.code === item.code && text(row.itemId) && typeof row.name === 'string')
      .map(row => ({ serviceId: item.serviceId, code: row.code, name: row.name, itemId: row.itemId })));
    const complete = listing?.outcome === 'ok' && coverage?.complete === true && Array.isArray(listing.candidates);
    const unique = complete && items.every(item => rows.filter(row => row.code === item.code).length === 1 &&
      candidates.filter(row => row.serviceId === item.serviceId).length === 1);
    return { complete, unique, coverage: { complete, ...(typeof coverage?.loaded === 'number' ? { loaded: coverage.loaded } : {}),
      ...(typeof coverage?.reportedTotal === 'number' ? { reportedTotal: coverage.reportedTotal } : {}) }, candidates };
  };
  try {
    let listing: Record<string, unknown> | null = null, prepared: Record<string, unknown> | null = null;
    let verifiedTarget: Record<string, unknown> | null = null;
    if (target.kind === 'unsaved') {
      const addonTool = await import(new URL('../../tooling/hms-cloud/stay360-addons.mjs', import.meta.url).href) as {
        listUnsavedStay360AddOnItems: (page: unknown, options: Record<string, unknown>) => Promise<unknown>;
        previewUnsavedStay360AddOns: (page: unknown, options: Record<string, unknown>) => Promise<unknown>;
      };
      const { native, addon } = await createThenAddon(target, async (page, readForm) => {
        const options = { expectedCreate: target.nativeInput, expectedGuest: target.expectedGuest, readForm };
        const found = record(await addonTool.listUnsavedStay360AddOnItems(page, options));
        signal.throwIfAborted();
        const match = matched(found);
        const preview = match.unique ? record(await addonTool.previewUnsavedStay360AddOns(page, { ...options, items: nativeItems })) : null;
        signal.throwIfAborted();
        return { found, preview };
      }, signal);
      const binding = record(native.requestBinding), data = record(addon);
      listing = record(data?.found); prepared = record(data?.preview);
      if (native.outcome !== 'prepared' || binding?.digest !== target.nativeBindingDigest || !record(binding.request) ||
          !record(native.ratePlanAvailability))
        return result('needs_input', 'addon_create_binding_unverified');
      if (!listing || listing.outcome !== 'ok') return result(listing?.outcome === 'execution_failure' ? 'failed' : 'needs_input',
        text(listing?.issue) ?? 'addon_catalogue_unavailable');
      if (listing.propertyCode !== 'HRCEN' || listing.unsaved !== true) return result('needs_input', 'addon_create_target_unverified');
      const listingTarget = record(listing.target), preparedTarget = record(prepared?.target);
      if (!listingTarget || (prepared && (!preparedTarget || canonicalJson(listingTarget) !== canonicalJson(preparedTarget))))
        return result('needs_input', 'addon_create_target_changed');
      verifiedTarget = { kind: 'unsaved', native: listingTarget, requestBinding: binding };
    } else {
      const addon = await import(new URL('../../tooling/hms-cloud/stay360-addons-session.mjs', import.meta.url).href) as {
        withStay360AddOnSession: (callback: (session: { runTool: (request: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>,
          options: Record<string, unknown>) => Promise<unknown>;
      };
      const browser = await import(new URL('../../tooling/playwright-quote/centurion-stay360.mjs', import.meta.url).href) as {
        withCenturionStay360Page: (callback: (page: unknown) => Promise<unknown>, options: Record<string, unknown>) => Promise<unknown>;
      };
      const data = record(await addon.withStay360AddOnSession(async session => {
        const run = async (request: Record<string, unknown>) => { signal.throwIfAborted();
          const value = await session.runTool(request); signal.throwIfAborted(); return record(value); };
        const read = await run({ tool: 'read', confirmation: target.confirmation, guestName: target.guestName, arrivalDate: target.arrival });
        const stay = record(read?.target);
        if (read?.outcome !== 'ok' || read.propertyCode !== 'HRCEN' || record(read.coverage)?.complete !== true ||
            !stay || stay.confirmation !== target.confirmation || stay.status !== 'Reserved' || stay.arrival !== target.arrival ||
            stay.departure !== target.departure || !nativeServiceGuestNameMatches(stay.guestName, target.guestName)) return { read };
        const found = await run({ tool: 'list', confirmation: target.confirmation });
        const preview = matched(found).unique ? await run({ tool: 'prepare', confirmation: target.confirmation, items: nativeItems }) : null;
        return { stay, found, preview };
      }, { headless: true, blockServiceWorkers: true, withPage: (callback: (page: unknown) => Promise<unknown>, options: Record<string, unknown>) =>
        browser.withCenturionStay360Page(callback, { ...options, signal }) }));
      signal.throwIfAborted();
      if (!data || !record(data.stay)) {
        const read = record(data?.read);
        return result(read?.outcome === 'execution_failure' ? 'failed' : 'needs_input', text(read?.issue) ?? 'addon_saved_target_unverified');
      }
      listing = record(data.found); prepared = record(data.preview); verifiedTarget = record(data.stay);
    }
    if (!listing || listing.outcome !== 'ok') return result(listing?.outcome === 'execution_failure' ? 'failed' : 'needs_input',
      text(listing?.issue) ?? 'addon_catalogue_unavailable');
    const match = matched(listing);
    const base = { saved: false as const, coverage: match.coverage, candidates: match.candidates, target: verifiedTarget ?? undefined };
    if (!match.unique) return { ...base, status: 'needs_input', previews: [], issue: match.complete ? 'addon_catalogue_ambiguous' : 'addon_catalogue_incomplete' };
    if (prepared?.outcome !== 'prepared' || prepared.propertyCode !== 'HRCEN' || prepared.saved !== false ||
        !Array.isArray(prepared.items) || prepared.items.length !== items.length ||
        (target.kind === 'unsaved' && prepared.unsaved !== true) || (target.kind === 'saved' && prepared.confirmation !== target.confirmation))
      return { ...base, status: 'needs_input', previews: [], issue: text(prepared?.issue) ?? 'addon_preview_unverified' };
    const preparedItems = prepared.items;
    const previews = items.map((item, index) => {
      const entry = record(preparedItems[index]);
      const actual = target.kind === 'unsaved' ? record(entry?.item) : entry;
      const candidate = match.candidates.find(row => row.serviceId === item.serviceId);
      const valid = actual && (target.kind !== 'unsaved' || entry?.outcome === 'prepared') &&
        actual.code === item.code && actual.itemId === candidate?.itemId && actual.status === 'VALID' &&
        positiveDecimal(actual.quantity) === positiveDecimal(item.quantity) && positiveDecimal(actual.unitPrice) === positiveDecimal(item.unitPrice) &&
        actual.startDate === item.startDate && actual.endDate === item.endDate && text(actual.currency) && text(actual.totalCost);
      return valid ? { serviceId: item.serviceId, native: actual } : null;
    });
    if (previews.some(preview => !preview)) return { ...base, status: 'needs_input', previews: [], issue: 'addon_preview_fields_unverified' };
    signal.throwIfAborted();
    return { ...base, status: 'prepared', previews: previews.filter((preview): preview is NonNullable<typeof preview> => !!preview) };
  } catch {
    signal.throwIfAborted();
    return result('failed', 'addon_native_check_failed');
  }
}


async function lookupUnsaved(draft: ReservationWorkflowV2Draft, input: ReservationWorkflowV2ServicesInput, signal: AbortSignal): Promise<AddOnObservationResult> {
  const loaded = { draft };
  const linked = reservationWorkflowV2ServicesForAllocation(loaded.draft, input);
  if (linked.outcome !== 'ok') return { status: linked.outcome, issue: linked.issue, observations: [] };
  if (!linked.rows.length) return { status: 'needs_input', issue: input.serviceId ? 'service_target_not_found' : 'no_service_target', observations: [] };
  const unsupported = linked.rows.filter(row => row.service.operation !== 'add');
  const addRows = linked.rows.filter(row => row.service.operation === 'add');
  if (!addRows.length) return { status: 'unsupported', issue: 'saved_addon_edit_remove_not_connected', observations: [] };
  const compiled = compileReservationWorkflowV2Create(loaded.draft, input.requestId, input.allocationId, draft.propertyCode);
  if (compiled.outcome !== 'ok') return { status: compiled.outcome, issue: compiled.issue, observations: [] };
  try {
    const addonTool = await import(new URL('../../tooling/hms-cloud/stay360-addons.mjs', import.meta.url).href) as {
      listUnsavedStay360AddOnItems: (page: unknown, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const { native, addon } = await createThenAddon(compiled, (page, readForm) =>
      addonTool.listUnsavedStay360AddOnItems(page, { expectedCreate: compiled.nativeInput,
        expectedGuest: compiled.expectedGuest, readForm }), signal);
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
      return { status: text(listing?.outcome) ?? 'failed', issue: text(listing?.issue) ?? native.issue ?? 'native_item_catalogue_empty', observations };
    }
    return { status: unsupported.length || !complete ? 'partial' : 'ok', observations };
  } catch {
    signal.throwIfAborted();
    return { status: 'failed', issue: 'native_service_catalogue_lookup_failed', observations: [] };
  }
}


async function previewUnsaved(draft: ReservationWorkflowV2Draft, input: ReservationWorkflowV2ServicesInput, signal: AbortSignal): Promise<AddOnObservationResult> {
  const loaded = { draft };
  const linked = reservationWorkflowV2ServicesForAllocation(loaded.draft, input);
  if (linked.outcome !== 'ok') return { status: linked.outcome, issue: linked.issue, observations: [] };
  if (!linked.rows.length) return { status: 'needs_input', issue: input.serviceId ? 'service_target_not_found' : 'no_service_target', observations: [] };
  const unsupported = linked.rows.filter(row => row.service.operation !== 'add');
  const compiledCreate = compileReservationWorkflowV2Create(loaded.draft, input.requestId, input.allocationId, draft.propertyCode);
  if (compiledCreate.outcome !== 'ok') return { status: compiledCreate.outcome, issue: compiledCreate.issue, observations: [] };
  const compiled = linked.rows.map(row => ({ row, plan: reservationWorkflowV2CompileServiceItem(loaded.draft!, input, row) }));
  const invalid = compiled.filter(item => item.plan.outcome === 'needs_input');
  if (invalid.length) return { status: 'needs_input', issue: 'service_preview_fields_unresolved', observations: [] };
  const plans = compiled.flatMap(item => item.plan.outcome === 'ok' ? [item.plan] : []);
  if (!plans.length) return { status: 'unsupported', issue: 'saved_addon_edit_remove_not_connected', observations: [] };
  if (plans.some(plan => {
    const matches = draft.observations.filter(observation => observation.ref === plan.candidateRef);
    return matches.length !== 1 || matches[0]!.coverage.complete !== true || matches[0]!.sourceMessageId !== draft.source.messageId;
  })) {
    return { status: 'needs_input', issue: 'host_catalogue_candidate_unverified', observations: [] };
  }
  try {
    const addonTool = await import(new URL('../../tooling/hms-cloud/stay360-addons.mjs', import.meta.url).href) as {
      previewUnsavedStay360AddOns: (page: unknown, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    const items = plans.map(plan => plan.items);
    const { native, addon } = await createThenAddon(compiledCreate, (page, readForm) =>
      addonTool.previewUnsavedStay360AddOns(page, { expectedCreate: compiledCreate.nativeInput,
        expectedGuest: compiledCreate.expectedGuest, readForm, items }), signal);
    const preview = record(addon), nativeItems = Array.isArray(preview?.items) ? preview.items.map(record) : [];
    const capability = (await import('./reservation-workflow-v2-services-execute.js')).linkedServiceCapability(loaded.draft, input);
    const createBound = native.outcome === 'prepared' && typeof record(native.requestBinding)?.digest === 'string' &&
      record(native.ratePlanAvailability) !== null;
    const observations: ReservationWorkflowV2Observation[] = [];
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
        coverage: { complete, notes: complete ? [] : [String(nativeItem?.issue ?? preview?.issue ?? native.issue ?? 'native_addon_preview_incomplete').slice(0, 500)] },
        result: { operation: 'add', saved: false, targetRef: plan.targetRef, serviceId: plan.serviceId,
          itemCandidate: plan.candidate, requestedFields: plan.items,
          native: businessItem && controls ? { ...businessItem, controls } : businessItem,
          ...(nativeControls ? { nativeControls } : {}),
          issue: nativeItem?.issue ?? preview?.issue ?? native.issue ?? null,
          hostValuesRequireReview: plan.reviewPaths, createRatePlanAvailability: native.ratePlanAvailability,
          priceWasNativeCalculated: Boolean(actual?.averageDaily && actual?.totalCost), capability } };
      observations.push(observation);
    }
    return { status: !unsupported.length && observations.every(item => item.status === 'complete') ? 'prepared' : 'partial', observations };
  } catch {
    signal.throwIfAborted();
    return { status: 'failed', issue: 'native_service_preview_failed', observations: [] };
  }
}


async function lookupSaved(draft: ReservationWorkflowV2Draft, input: ReservationWorkflowV2SavedServicesInput, transportId: string, signal: AbortSignal): Promise<AddOnObservationResult> {
  const observations: ReservationWorkflowV2Observation[] = [];
  if (!paneStayLookupEnabled()) return { status: 'refused_flag_off', issue: 'pane_stay_lookup_flag_off', observations };
  const found = savedTarget(draft, input);
  if (!found) return { status: 'needs_input', issue: 'one_saved_stay_confirmation_required', observations };
  const amendSelection = found.request.kind === 'amend' ? selectedSavedStay(draft, input, found) : null;
  if (found.request.kind === 'amend' && !amendSelection) return { status: 'needs_input', issue: 'select_amend_saved_stay_first', observations };
  const confirmation = amendSelection?.stay.confirmation ?? found.hint.confirmation;
  const arrival = amendSelection?.stay.arrival ?? found.hint.bookedArrival;
  if (!/^\d+-\d+$/.test(String(confirmation ?? ''))) return { status: 'needs_input', issue: 'one_saved_stay_confirmation_required', observations };
  if (typeof arrival === 'string' && arrival && (!/^\d{4}-\d{2}-\d{2}$/.test(arrival) ||
      !Number.isFinite(Date.parse(`${arrival}T00:00:00Z`)) || new Date(`${arrival}T00:00:00Z`).toISOString().slice(0, 10) !== arrival))
    return { status: 'refused_input_invalid', issue: 'service_target_arrival_invalid', observations };
  const resolved = paneStayHmsTargetForTransport(transportId);
  if (!resolved.ok || (['propertyCode', 'secretId', 'browserSlot', 'origin', 'installationEnvName'] as const)
    .some(key => resolved.target[key] !== CENTURION_HMS_READ_TARGET[key])) return { status: 'unsupported', issue: 'service_property_session_unavailable', observations };
  const query = Object.fromEntries(['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture'].map(key => [key, found.hint[key] || null]));
  const request = { confirmation: String(confirmation), ...(typeof arrival === 'string' && arrival ? { arrival } : {}) };
  let result: ReturnType<typeof projectCloudStayFind> | null = null;
  try {
    result = projectCloudStayFind(request, await runCloudStayFind({ request, target: resolved.target, signal }));
    signal.throwIfAborted();
  } catch { signal.throwIfAborted(); }
  const stay = record(result?.stay), selectedStay = amendSelection?.stay;
  const sameSelected = Boolean(stay && selectedStay && stay.confirmation === selectedStay.confirmation && stay.status === 'Reserved' &&
    stay.arrival === selectedStay.arrival && stay.departure === selectedStay.departure &&
    samePerson(stay.firstName, selectedStay.firstName) && samePerson(stay.lastName, selectedStay.lastName));
  const identityUnverified = result?.outcome === 'found' &&
    (!result.nativePreimage || result.nativePreimage.confirmation !== request.confirmation);
  const complete = Boolean(result?.outcome === 'found' && !identityUnverified && !result.arrivalMismatch && stay &&
    (amendSelection ? sameSelected : savedStayMatches(stay, found.hint)));
  let observation: ReservationWorkflowV2Observation | undefined;
  if (!amendSelection) {
    observation = { ref: randomUUID(), generationId: draft.generationId, kind: 'stay_candidate',
      status: complete ? 'complete' : 'partial', observedAt: new Date().toISOString(), propertyCode: draft.propertyCode,
      sourceMessageId: draft.source.messageId, sourceRefs: [], criteria: { workflow: 'services', kind: 'saved_target',
        requestId: input.requestId, hintId: input.targetRef.hintId, fieldPath: found.selectionPath, query },
      coverage: { complete, notes: complete ? [] : ['Exact Reserved stay was not verified.'] },
      result: { outcome: complete ? 'found' : 'needs_input', candidate: complete ? stay : null } };
    observations.push(observation);
  }
  if (!complete || !stay) return { status: !result || identityUnverified || result.outcome === 'execution_failure' ? 'failed' : 'needs_input',
    issue: identityUnverified ? 'SAVED_STAY_IDENTITY_UNVERIFIED' :
      text(result?.reason)?.slice(0, 500) ?? (!result ? 'saved_stay_lookup_failed' : 'reserved_stay_not_verified'), observations };
  const selected = amendSelection ?? selectedSavedStay(draft, input, found);
  if (!selected || (amendSelection ? !sameSelected : canonicalJson(selected.stay) !== canonicalJson(stay)))
    return { status: 'needs_input', issue: 'select_exact_saved_stay', observations };
  try {
    const nativeFailure: { issue: string | null; outcome: string | null } = { issue: null, outcome: null };
    const addon = await import(new URL('../../tooling/hms-cloud/stay360-addons-session.mjs', import.meta.url).href) as {
      withStay360AddOnSession: (callback: (session: { runTool: (request: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>,
        options?: Record<string, unknown>) => Promise<unknown>;
    };
    const guestName = `${stay.firstName} ${stay.lastName}`;
    const browser = await import(new URL('../../tooling/playwright-quote/centurion-stay360.mjs', import.meta.url).href) as { withCenturionStay360Page: (callback: (page: unknown) => Promise<unknown>, options: Record<string, unknown>) => Promise<unknown> };
    const native = record(await addon.withStay360AddOnSession(async session => {
      const runTool = async (request: Record<string, unknown>) => {
        signal.throwIfAborted();
        const result = await session.runTool(request);
        signal.throwIfAborted();
        const value = record(result);
        if (value?.outcome !== 'ok' && value?.outcome !== 'prepared') {
          nativeFailure.issue = text(value?.issue)?.slice(0, 500) ?? null;
          nativeFailure.outcome = text(value?.outcome);
        }
        return result;
      };
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
    }, { headless: true, blockServiceWorkers: true, withPage: (callback: (page: unknown) => Promise<unknown>, options: Record<string, unknown>) => browser.withCenturionStay360Page(callback, { ...options, signal }) }));
    signal.throwIfAborted();
    if (!native) return { status: nativeFailure.outcome === 'execution_failure' ? 'failed' : nativeFailure.outcome === 'unsupported' ? 'unsupported' : 'needs_input',
      issue: nativeFailure.issue ?? 'saved_addon_read_incomplete', observations };
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
        observations.push(item);
      }
    }
    return { status: 'ok', observations };
  } catch { signal.throwIfAborted(); return { status: 'failed', issue: 'saved_addon_read_failed', observations }; }
}


async function previewSaved(draft: ReservationWorkflowV2Draft, input: ReservationWorkflowV2SavedServicesInput, signal: AbortSignal): Promise<AddOnObservationResult> {
  const plan = reservationWorkflowV2CompileSavedService(draft, input);
  if (plan.status !== 'ok') return { status: plan.status, issue: plan.issue, observations: [] };
  const { selected, row, operation, candidateObservation, candidate, prior, nativeId, fields, requested, reviewPaths, inputDigest } = plan;
  try {
    const nativeFailure: { issue: string | null; outcome: string | null } = { issue: null, outcome: null };
    const addon = await import(new URL('../../tooling/hms-cloud/stay360-addons-session.mjs', import.meta.url).href) as {
      withStay360AddOnSession: (callback: (session: { runTool: (request: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>,
        options?: Record<string, unknown>) => Promise<unknown>;
    };
    const stay = selected.stay, guestName = `${stay.firstName} ${stay.lastName}`;
    const browser = await import(new URL('../../tooling/playwright-quote/centurion-stay360.mjs', import.meta.url).href) as { withCenturionStay360Page: (callback: (page: unknown) => Promise<unknown>, options: Record<string, unknown>) => Promise<unknown> };
    const staged = record(await addon.withStay360AddOnSession(async session => {
      const runTool = async (request: Record<string, unknown>) => {
        signal.throwIfAborted();
        const result = await session.runTool(request);
        signal.throwIfAborted();
        const value = record(result);
        if (value?.outcome !== 'ok' && value?.outcome !== 'prepared') {
          nativeFailure.issue = text(value?.issue)?.slice(0, 500) ?? null;
          nativeFailure.outcome = text(value?.outcome);
        }
        return result;
      };
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
    }, { headless: true, blockServiceWorkers: true, withPage: (callback: (page: unknown) => Promise<unknown>, options: Record<string, unknown>) => browser.withCenturionStay360Page(callback, { ...options, signal }) }));
    signal.throwIfAborted();
    if (!staged) return { status: nativeFailure.outcome === 'execution_failure' ? 'failed' : nativeFailure.outcome === 'unsupported' ? 'unsupported' : 'needs_input',
      issue: nativeFailure.issue ?? 'saved_addon_prepare_unverified', observations: [] };
    const capability = await (await import('./reservation-workflow-v2-services-execute.js')).savedServiceCapability(selected.stay, signal);
    signal.throwIfAborted();
    const observation: ReservationWorkflowV2Observation = { ref: randomUUID(), generationId: draft.generationId, kind: 'service_preview',
      status: 'complete', observedAt: new Date().toISOString(), propertyCode: draft.propertyCode, sourceMessageId: draft.source.messageId,
      sourceRefs: [selected.observation.ref, candidateObservation.ref], criteria: { workflow: 'services', kind: 'saved_addon_preview',
        requestId: input.requestId, serviceId: row.service.id, targetRef: input.targetRef, targetObservationRef: selected.observation.ref,
        candidateRef: candidateObservation.ref, inputDigest, reviewPaths }, coverage: { complete: true, notes: [] },
      result: { operation, targetRef: input.targetRef, saved: false, requested, ...staged,
        priceWasNativeCalculated: true, financialEffect: operation === 'remove' ? 'unknown' : null, capability } };
    return { status: 'prepared', observations: [observation] };
  } catch { signal.throwIfAborted(); return { status: 'failed', issue: 'saved_addon_prepare_failed', observations: [] }; }
}
