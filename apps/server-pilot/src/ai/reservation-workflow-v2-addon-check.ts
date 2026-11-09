/** Read-only Add-On staging for already resolved reservation targets and source-supported items. */
export type AddOnCheckTarget =
  | { kind: 'unsaved_create'; nativeInput: Record<string, unknown>; expectedGuest: { firstName: string; lastName: string } }
  | { kind: 'saved_stay'; confirmation: string; guestName: string; arrival: string; departure: string };
export type AddOnCheckItem = { serviceId: string; operation: 'add'; code: string; quantity: string;
  unitPrice: string; startDate: string; endDate: string };
export type AddOnCheckInput = { propertyCode: 'HRCEN'; target: AddOnCheckTarget; items: AddOnCheckItem[]; signal?: AbortSignal };
export type AddOnCheckResult = { status: 'prepared' | 'partial' | 'needs_input' | 'unsupported' | 'failed'; saved: false;
  coverage: { complete: boolean; notes: string[]; catalogue?: unknown; nativeOutcome?: string; missing?: string[] }; candidates: Array<Record<string, unknown>>;
  previews: Array<Record<string, unknown>>; issue?: string };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const nativeIssue = (value: unknown, fallback: string) => typeof value === 'string' && value.length ? value.slice(0, 500) : fallback;
const decimal = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return `${whole!.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`;
};
const positive = (value: unknown) => { const number = decimal(value); return number !== null && /[1-9]/.test(number); };
const date = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};
const samePerson = (native: unknown, expected: unknown) => {
  const normalize = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
  const wanted = normalize(expected), parts = typeof native === 'string' ? native.split(',') : [];
  return Boolean(wanted && (normalize(native) === wanted || parts.length === 2 && parts.every(part => part.trim()) &&
    normalize(`${parts[1]!.trim()} ${parts[0]!.trim()}`) === wanted));
};
const result = (status: AddOnCheckResult['status'], reason: string, candidates: Array<Record<string, unknown>> = [],
  previews: Array<Record<string, unknown>> = [], catalogue?: unknown): AddOnCheckResult => ({ status, saved: false,
  coverage: { complete: false, notes: [reason], ...(catalogue === undefined ? {} : { catalogue }) }, candidates, previews, issue: reason });
const nativeFailure = (native: Record<string, unknown> | null, fallback: string, candidates: Array<Record<string, unknown>> = [], catalogue?: unknown) => {
  const reason = nativeIssue(native?.issue, fallback), outcome = text(native?.outcome);
  const failed = result(outcome === 'unsupported' ? 'unsupported' : outcome === 'needs_input' || outcome === 'input_gap' ? 'needs_input' : 'failed',
    reason, candidates, [], catalogue);
  if (outcome) failed.coverage.nativeOutcome = outcome;
  if (Array.isArray(native?.missing)) failed.coverage.missing = native.missing.filter((field): field is string => typeof field === 'string');
  return failed;
};

function validate(input: AddOnCheckInput): string | null {
  if (input.propertyCode !== 'HRCEN') return 'addon_property_unsupported';
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) return 'addon_items_required';
  const serviceIds = new Set<string>();
  for (const item of input.items) {
    if (!record(item) || item.operation !== 'add' || !text(item.serviceId) || serviceIds.has(item.serviceId) ||
        !text(item.code) || item.code !== item.code.trim() || !positive(item.quantity) || !positive(item.unitPrice) ||
        !date(item.startDate) || !date(item.endDate) || item.startDate > item.endDate ||
        Object.keys(item).some(key => !['serviceId', 'operation', 'code', 'quantity', 'unitPrice', 'startDate', 'endDate'].includes(key))) {
      return 'addon_explicit_source_fields_required';
    }
    serviceIds.add(item.serviceId);
  }
  const target = record(input.target);
  if (target?.kind === 'unsaved_create') {
    const nativeInput = record(target.nativeInput), guest = record(target.expectedGuest);
    if (!nativeInput || nativeInput.mode !== 'prepare' || nativeInput.propertyCode !== 'HRCEN' ||
        !text(record(nativeInput.guest)?.profileId) || !text(guest?.firstName) || !text(guest?.lastName)) return 'addon_prepared_create_required';
  } else if (target?.kind === 'saved_stay') {
    if (typeof target.confirmation !== 'string' || !/^\d+-\d+$/.test(target.confirmation) || !text(target.guestName) ||
        !date(target.arrival) || !date(target.departure) || target.arrival >= target.departure) return 'addon_saved_target_required';
  } else return 'addon_target_required';
  return null;
}

type Listing = { candidates: Array<Record<string, unknown>>; coverage: unknown; error?: AddOnCheckResult };
function catalogueFor(raw: unknown, items: AddOnCheckItem[]): Listing {
  const listing = record(raw), coverage = record(listing?.coverage);
  const source = Array.isArray(listing?.candidates) ? listing.candidates : Array.isArray(listing?.options) ? listing.options : [];
  const rows = source.map(record).filter((row): row is Record<string, unknown> => Boolean(row));
  const candidates = items.flatMap(item => rows.filter(row => row.code === item.code).map(row =>
    ({ serviceId: item.serviceId, code: row.code, name: row.name, itemId: row.itemId })));
  if (listing?.outcome !== 'ok' || listing.propertyCode !== 'HRCEN') {
    return { candidates, coverage, error: nativeFailure(listing, 'addon_catalogue_failed', candidates, coverage) };
  }
  if (coverage?.complete !== true || !Array.isArray(listing.candidates) || rows.length !== source.length) {
    return { candidates, coverage, error: result('needs_input', 'addon_catalogue_incomplete', candidates, [], coverage) };
  }
  for (const item of items) {
    const matches = candidates.filter(row => row.serviceId === item.serviceId);
    if (matches.length !== 1 || !text(matches[0]?.name) || !text(matches[0]?.itemId)) {
      return { candidates, coverage, error: result('needs_input', matches.length > 1 ? 'addon_catalogue_ambiguous' : 'addon_catalogue_match_required', candidates, [], coverage) };
    }
  }
  return { candidates, coverage };
}

function previewResults(items: AddOnCheckItem[], candidates: Array<Record<string, unknown>>, raw: unknown,
  target: Record<string, unknown>, catalogue: unknown, unsaved: boolean): AddOnCheckResult {
  const prepared = record(raw);
  if ((prepared?.outcome !== 'prepared' && !(unsaved && prepared?.outcome === 'partial')) || prepared.saved !== false ||
      prepared.propertyCode !== 'HRCEN' || unsaved && prepared.unsaved !== true || !Array.isArray(prepared.items)) {
    return nativeFailure(prepared, 'addon_prepare_failed', candidates, catalogue);
  }
  const previews: Array<Record<string, unknown>> = [];
  let firstIssue: string | undefined;
  let successes = 0, failureStatus: AddOnCheckResult['status'] = 'needs_input';
  for (const [index, item] of items.entries()) {
    const row = record(prepared.items[index]);
    const actual = unsaved ? record(row?.item) : row;
    const ok = (!unsaved || row?.outcome === 'prepared') && actual?.code === item.code &&
      actual?.itemId === candidates[index]?.itemId && actual?.status === 'VALID' &&
      decimal(actual?.quantity) === decimal(item.quantity) && decimal(actual?.unitPrice) === decimal(item.unitPrice) &&
      actual?.startDate === item.startDate && actual?.endDate === item.endDate && text(actual?.currency) && decimal(actual?.totalCost) !== null;
    if (!ok) {
      const outcome = text(row?.outcome);
      const status = outcome === 'unsupported' ? 'unsupported' : outcome && !['prepared', 'needs_input', 'input_gap'].includes(outcome)
        ? 'failed' : 'needs_input';
      const reason = nativeIssue(row?.issue, 'addon_preview_unverified');
      firstIssue ??= reason;
      if (status === 'failed' || status === 'unsupported' && failureStatus !== 'failed') failureStatus = status;
      previews.push({ serviceId: item.serviceId, status, ...(outcome ? { nativeOutcome: outcome } : {}), issue: reason,
        ...(actual ? { fields: actual } : {}), ...(Array.isArray(row?.options) ? { options: row.options } : {}) });
      continue;
    }
    successes++;
    previews.push({ serviceId: item.serviceId, status: 'prepared', code: actual!.code, itemId: actual!.itemId, fields: actual, target });
  }
  if (prepared.items.length !== items.length || successes !== items.length || prepared.outcome !== 'prepared') {
    return result(successes ? 'partial' : failureStatus, firstIssue ?? 'addon_preview_incomplete', candidates, previews, catalogue);
  }
  return { status: 'prepared', saved: false, coverage: { complete: true, notes: [], catalogue }, candidates, previews };
}

/** Caller supplies explicit source-supported prices and quantities; this never saves or approves them. */
export async function checkAddOns(input: AddOnCheckInput): Promise<AddOnCheckResult> {
  const { signal } = input;
  signal?.throwIfAborted();
  let target: AddOnCheckTarget, items: AddOnCheckItem[];
  try { target = structuredClone(input.target); items = structuredClone(input.items); }
  catch { return result('needs_input', 'addon_input_invalid'); }
  const invalid = validate({ propertyCode: input.propertyCode, target, items });
  if (invalid) return result(invalid === 'addon_property_unsupported' ? 'unsupported' : 'needs_input', invalid);
  try {
    if (target.kind === 'unsaved_create') {
      const unsavedTarget = target;
      const create = await import(new URL('../../tooling/hms-cloud/create-reservation.mjs', import.meta.url).href) as {
        createReservation(input: unknown, options: Record<string, unknown>): Promise<Record<string, unknown>> };
      const booking = await import(new URL('../../tooling/hms-cloud/booking-lookup-session.mjs', import.meta.url).href) as {
        withBookingLookupSession(callback: (session: { page: unknown; runTool(request: Record<string, unknown>): Promise<unknown> }) => Promise<unknown>,
          options: Record<string, unknown>): Promise<unknown> };
      const addon = await import(new URL('../../tooling/hms-cloud/stay360-addons.mjs', import.meta.url).href) as {
        listUnsavedStay360AddOnItems(page: unknown, options: Record<string, unknown>): Promise<unknown>;
        previewUnsavedStay360AddOns(page: unknown, options: Record<string, unknown>): Promise<unknown> };
      const state: { checked?: { listing: Listing; prepared: unknown } } = {};
      const withSession = (callback: (session: { page: unknown; runTool(request: Record<string, unknown>): Promise<unknown> }) => Promise<unknown>,
        options: Record<string, unknown> = {}) => booking.withBookingLookupSession(async session => {
          signal?.throwIfAborted();
          await callback(session);
          signal?.throwIfAborted();
          const readForm = () => session.runTool({ tool: 'readGuestStayForm', propertyCode: 'HRCEN' });
          const options = { expectedCreate: unsavedTarget.nativeInput, expectedGuest: unsavedTarget.expectedGuest, readForm };
          const listed = record(await addon.listUnsavedStay360AddOnItems(session.page, options));
          const listing = catalogueFor(listed, items);
          signal?.throwIfAborted();
          if (listed?.outcome === 'ok' && listed.unsaved !== true) {
            state.checked = { listing: { ...listing, error: result('failed', 'addon_unsaved_target_unverified', listing.candidates, [], listing.coverage) }, prepared: null };
            return;
          }
          if (listing.error) { state.checked = { listing, prepared: null }; return; }
          const prepared = await addon.previewUnsavedStay360AddOns(session.page, { ...options,
            items: items.map(({ code, quantity, unitPrice, startDate, endDate }) => ({ code, quantity, unitPrice, startDate, endDate })) });
          signal?.throwIfAborted();
          state.checked = { listing, prepared };
        }, { ...options, memory: null, blockServiceWorkers: true, signal });
      const native = await create.createReservation(unsavedTarget.nativeInput, { allowRealGuest: true, expectedGuest: unsavedTarget.expectedGuest,
        requireExplicitGuestSelection: true, allowCommitOnlyBillingReference: true, withSession });
      signal?.throwIfAborted();
      const binding = record(native.requestBinding);
      if (native.outcome !== 'prepared' || !binding || !/^[a-f0-9]{64}$/.test(String(binding.digest ?? '')) ||
          !record(binding.request) || !record(native.ratePlanAvailability)) return nativeFailure(native, 'addon_create_prepare_unverified');
      if (!state.checked) return result('failed', 'addon_session_result_missing');
      if (state.checked.listing.error) return state.checked.listing.error;
      return previewResults(items, state.checked.listing.candidates, state.checked.prepared,
        { kind: 'unsaved_create', requestBinding: binding }, state.checked.listing.coverage, true);
    }
    const savedTarget = target;
    const addon = await import(new URL('../../tooling/hms-cloud/stay360-addons-session.mjs', import.meta.url).href) as {
      withStay360AddOnSession(callback: (session: { runTool(request: Record<string, unknown>): Promise<unknown> }) => Promise<unknown>,
        options: Record<string, unknown>): Promise<unknown> };
    const browser = await import(new URL('../../tooling/playwright-quote/centurion-stay360.mjs', import.meta.url).href) as {
      withCenturionStay360Page(callback: (page: unknown) => Promise<unknown>, options: Record<string, unknown>): Promise<unknown> };
    const checked = await addon.withStay360AddOnSession(async ({ runTool }) => {
      signal?.throwIfAborted();
      const read = record(await runTool({ tool: 'read', confirmation: savedTarget.confirmation, guestName: savedTarget.guestName, arrivalDate: savedTarget.arrival }));
      signal?.throwIfAborted();
      const stay = record(read?.target);
      if (read?.outcome !== 'ok') return nativeFailure(read, 'addon_saved_target_read_failed', [], read?.coverage);
      if (read.propertyCode !== 'HRCEN' || record(read.coverage)?.complete !== true || !stay ||
          stay.confirmation !== savedTarget.confirmation || stay.status !== 'Reserved' || stay.arrival !== savedTarget.arrival ||
          stay.departure !== savedTarget.departure || !samePerson(stay.guestName, savedTarget.guestName)) return result('needs_input', 'addon_saved_target_unverified', [], [], read.coverage);
      const listing = catalogueFor(await runTool({ tool: 'list', confirmation: savedTarget.confirmation }), items);
      signal?.throwIfAborted();
      if (listing.error) return listing.error;
      const prepared = await runTool({ tool: 'prepare', confirmation: savedTarget.confirmation,
        items: items.map(({ code, quantity, unitPrice, startDate, endDate }) => ({ code, quantity, unitPrice, startDate, endDate })) });
      signal?.throwIfAborted();
      return previewResults(items, listing.candidates, prepared, { kind: 'saved_stay', ...stay }, listing.coverage, false);
    }, { withPage: (callback: (page: unknown) => Promise<unknown>, options: Record<string, unknown>) =>
      browser.withCenturionStay360Page(callback, { ...options, signal }) });
    signal?.throwIfAborted();
    return checked as AddOnCheckResult;
  } catch {
    signal?.throwIfAborted();
    return result('failed', 'addon_session_failed');
  }
}
