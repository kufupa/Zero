import type { ReservationPaneSnapshot, ReservationSourceContext, ReservationRequestProjection, ReservationFieldOverride, ReservationSavedServiceTarget, ReservationGuestProfileOptionField } from './types';

type BasicRowChange = { requestId: string; parentId?: string; entityId?: string; childIds?: string[] };
export type RowChange =
  | (BasicRowChange & { kind: 'move_allocation' | 'add_allocation' | 'remove_allocation' | 'add_date_section' | 'remove_date_section'
      | 'add_quote_group' | 'remove_quote_group' | 'add_target' | 'remove_target' | 'add_service' | 'remove_service'
      | 'add_document' | 'remove_document' | 'remove_action' | 'separate_quote_money' | 'split_quote_dates' })
  | (BasicRowChange & { kind: 'separate_cancel_target' })
  | { kind: 'separate_filing_target'; requestId: string; documentId: string; targetHintId: string;
      targetDisposition: 'included' | 'excluded' }
  | { kind: 'link_created_addon_target'; requestId: string; allocationId: string; serviceId: string };
export type WorkbenchCommands = {
  stageEdit(path: string, value: unknown, state?: ReservationFieldOverride['state']): void;
  setUncommitted(key: string, dirty: boolean): void;
  edit(path: string, value: unknown, state?: ReservationFieldOverride['state']): Promise<void>;
  changeRows(change: RowChange): Promise<void>;
  selectNative(path: string, observationRef: string): Promise<void>;
  verifyNativeLead?(path: string, observationRef: string): Promise<void>;
  lookup(): Promise<void>;
  lookupChoices?(path: string): Promise<void>;
  guestProfileOptions(allocationId: string, field: ReservationGuestProfileOptionField): Promise<Record<string, unknown>>;
  createGuestProfile(allocationId: string, confirmDuplicateName?: boolean): Promise<void>;
  guestProfilePending(allocationId: string): string | null;
  checkGuestProfile(allocationId: string): Promise<void>;
  prepare(allocationId?: string): Promise<void>;
  review(scope: 'request' | 'allocations' | 'targets' | 'services' | 'documents', ids: string[]): Promise<void>;
  execute(allocationId?: string): Promise<void>;
  reconcile(operationId: string): Promise<void>;
  acceptServiceReview(fieldPath: string, note: string, expected?: { path: string; value: unknown; generationId: string }): Promise<void>;
  acceptFinancialReview(fieldPath: string, note: string, observationRef: string): Promise<void>;
  configureFiling(attachmentId: string, target: string | { confirmation: string } | { allocationTarget: { requestId: string; allocationId: string } }, kind: 'voucher' | 'payment_proof'): Promise<void>;
  lookupServices(target: string | ReservationSavedServiceTarget, serviceId?: string): Promise<void>;
  previewServices(target: string | ReservationSavedServiceTarget, serviceId?: string): Promise<void>;
  executeServices(target: string | ReservationSavedServiceTarget, serviceId: string, reviewedPrepareRef?: string): Promise<void>;
};
/** Failed operations only unlock scope correction when every receipt proves a no-write Prepare. */
export function savedTargetOperationLocks(snapshot: ReservationPaneSnapshot, requestId: string): boolean {
  const draft = snapshot.session.draft;
  return draft.operationResults.some(result => {
    if (result.requestId !== requestId) return false;
    if (result.status === 'succeeded' || result.status === 'unknown') return true;
    if (result.status !== 'failed') return false;
    const refs = result.observationRefs;
    return !refs.length || !refs.every(ref => draft.observations.some(observation => observation.ref === ref &&
      observation.criteria.workflow === result.workflow && observation.criteria.stage === 'prepare'));
  });
}
export type WorkbenchEditorProps = {
  source: ReservationSourceContext;
  snapshot: ReservationPaneSnapshot;
  request: ReservationRequestProjection;
  view: { busy: boolean; error: string | null; preview: boolean; saving: boolean };
  commands: WorkbenchCommands;
  onOpenEvidence?: (ref: string) => void;
};
export function snapshotMatchesSource(snapshot: ReservationPaneSnapshot | null, source: ReservationSourceContext): snapshot is ReservationPaneSnapshot {
  const draft = snapshot?.session.draft;
  return Boolean(draft && draft.transportId === source.mailboxId && draft.propertyCode === source.propertyId
    && draft.source.messageId === source.messageId && draft.source.threadId === source.threadId
    && (draft.source.sourceHash === source.sourceHash || snapshot?.session.sourceChanged === true)
    && snapshot?.sourceMessageId === source.messageId);
}
export const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const text = (v: unknown): string => v == null ? '' : typeof v === 'object' ? String(record(v).name ?? record(v).code ?? '') : String(v);
export function guestProfileReceipt(row: Record<string, unknown> | undefined): { nativeId: string; observationRef: string } | null {
  if (!row || row.workflow !== 'guest_profile' || row.status !== 'succeeded' ||
      typeof row.nativeId !== 'string' || !/^\d+$/.test(row.nativeId) ||
      typeof row.nativeIdObservationRef !== 'string' || !row.nativeIdObservationRef.trim()) return null;
  return { nativeId: row.nativeId, observationRef: row.nativeIdObservationRef };
}
export function staffEnteredAt(snapshot: ReservationPaneSnapshot, path: string): boolean {
  return Object.entries(snapshot.session.draft.fieldOverrides).some(([key, value]) =>
    (path === key || path.startsWith(`${key}/`)) && value.state === 'set');
}
export const pointer = (...parts: (string | number)[]) => '/' + parts.map(p => encodeURIComponent(String(p))).join('/');
export const requestPath = (id: string) => pointer('proposal', 'content', 'requests', id);
export function valueAt(snapshot: ReservationPaneSnapshot, path: string): unknown {
  const parts = path.split('/').slice(1).map(decodeURIComponent);
  let value: unknown = snapshot.session.draft;
  let current = '';
  for (const part of parts) {
    current += '/' + encodeURIComponent(part);
    value = Array.isArray(value) ? (/^\d+$/.test(part) ? value[Number(part)] : value.find(v => record(v).id === part)) : record(value)[part];
    const override = snapshot.session.draft.fieldOverrides[current];
    if (override?.state === 'set') value = override.value;
    else if (override && ['none', 'clear', 'unknown'].includes(override.state)) return null;
  }
  return value;
}
export function effectiveAt(snapshot: ReservationPaneSnapshot, path: string): unknown {
  const raw = valueAt(snapshot, path);
  const direct = snapshot.session.draft.fieldOverrides[path];
  if (direct && ['none', 'clear', 'unknown'].includes(direct.state)) return null;
  const childKeys = Object.keys(snapshot.session.draft.fieldOverrides).filter(key => key.startsWith(path + '/')).map(key => decodeURIComponent(key.slice(path.length + 1).split('/')[0]!));
  if (Array.isArray(raw)) return raw.map((_, i) => effectiveAt(snapshot, `${path}/${i}`));
  if (raw && typeof raw === 'object' || childKeys.length) return Object.fromEntries([...new Set([...Object.keys(record(raw)), ...childKeys])].map(k => [k, effectiveAt(snapshot, `${path}/${encodeURIComponent(k)}`)]));
  return raw;
}
export type NativeChoice = { ref: string; label: string; value: string; detail?: string };
export type NativeRecommendationLead = { ref: string; value: string; label: string;
  basis: 'exact_sender' | 'normalized_entity'; support: number;
  stock?: { status: 'available_each_night' | 'sold_or_restricted' | 'unknown'; observedAt: string } };

export function autoTransferHistory(snapshot: ReservationPaneSnapshot, path: string): { support: number; denominator: number; partyKind: 'organization' | 'arAccount' } | null {
  const draft = snapshot.session.draft;
  const requestId = decodeURIComponent(path.split('/')[4] ?? '');
  const request = draft.proposal.content.requests.find(row => row.id === requestId);
  if (!request || request.kind !== 'create' && request.kind !== 'amend') return null;
  const root = `${requestPath(requestId)}/body/`;
  if (!path.startsWith(root)) return null;
  const relative = path.slice(root.length);
  const createParty = request.kind === 'create' ? /^(?:shared|dateSections\/\d+\/defaults|allocations\/\d+\/overrides)\/(organization|arAccount)$/.exec(relative)?.[1] : undefined;
  const amendChange = request.kind === 'amend' && /^(?:sharedChanges\/\d+|perTarget\/\d+\/changes\/\d+)\/value$/.test(relative)
    ? path.slice(0, -'/value'.length) : null;
  const partyKind = createParty ?? (amendChange && valueAt(snapshot, `${amendChange}/op`) === 'set'
    ? valueAt(snapshot, `${amendChange}/field`) : null);
  if (partyKind !== 'organization' && partyKind !== 'arAccount') return null;
  const normalize = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase() : '';
  const currentName = normalize(valueAt(snapshot, `${path}/name`));
  if (!currentName) return null;
  const observation = [...draft.observations].reverse().find(row => {
    const criteria = record(row.criteria), result = record(row.result);
    return row.kind === 'stay_candidate' && row.status === 'partial' && row.coverage.complete === false &&
      row.generationId === draft.generationId && row.propertyCode === draft.propertyCode && row.sourceMessageId === draft.source.messageId &&
      criteria.kind === 'historical_auto_transfer_hint' && criteria.workflow === request.kind && criteria.requestId === request.id &&
      criteria.sourceHash === draft.source.sourceHash && criteria.fieldPath === path && criteria.partyKind === partyKind &&
      normalize(criteria.partyQuery) === currentName && result.value === true && result.evidence === 'stay360_auto_transfer_card_row' &&
      typeof result.support === 'number' && Number.isSafeInteger(result.support) && result.support > 0 &&
      typeof result.denominator === 'number' && Number.isSafeInteger(result.denominator) && result.denominator >= result.support &&
      typeof result.confidence === 'number' && result.confidence >= 0.8 && result.confidence <= 1 && result.support / result.denominator >= 0.8;
  });
  if (!observation) return null;
  const result = record(observation.result);
  return typeof result.support === 'number' && typeof result.denominator === 'number'
    ? { support: result.support, denominator: result.denominator, partyKind } : null;
}

function currentRoomStock(snapshot: ReservationPaneSnapshot, requestId: string, raw: unknown): NativeRecommendationLead['stock'] {
  const stock = record(raw), draft = snapshot.session.draft;
  if (!['available_each_night', 'sold_or_restricted', 'unknown'].includes(text(stock.status)) ||
      typeof stock.observationRef !== 'string' || typeof stock.observedAt !== 'string' || !Number.isFinite(Date.parse(stock.observedAt)) ||
      typeof stock.arrival !== 'string' || typeof stock.departure !== 'string' ||
      typeof stock.requestedCount !== 'number' || typeof stock.adults !== 'number' || !Array.isArray(stock.childAges) ||
      stock.combinedAvailability !== 'unknown') return undefined;
  const read = draft.observations.find(row => row.ref === stock.observationRef && row.kind === 'rate_availability' &&
    (row.status === 'complete' || row.status === 'partial') && row.generationId === draft.generationId &&
    row.propertyCode === draft.propertyCode && row.sourceMessageId === draft.source.messageId);
  const result = record(read?.result);
  if (!read || result.outcome !== 'read' || result.source !== 'hms_cloud_hotel_availability' ||
      result.roomScope !== 'all_room_types' || result.observedAt !== stock.observedAt) return undefined;
  const body = record(effectiveAt(snapshot, `${requestPath(requestId)}/body`));
  const sections = Array.isArray(body.dateSections) ? body.dateSections.map(record) : [];
  const allocations = Array.isArray(body.allocations) ? body.allocations.map(record) : [];
  if (sections.length !== 1 || !allocations.length || allocations.length !== stock.requestedCount) return undefined;
  const section = sections[0]!, childAges = stock.childAges;
  if (section.arrival !== stock.arrival || section.departure !== stock.departure || allocations.some(allocation => {
    const occupancy = record(allocation.occupancy);
    return allocation.dateSectionId !== section.id || occupancy.adults !== stock.adults ||
      occupancy.childCount !== childAges.length || !Array.isArray(occupancy.childAges) ||
      JSON.stringify(occupancy.childAges) !== JSON.stringify(childAges);
  })) return undefined;
  if (stock.status === 'available_each_night' || stock.status === 'sold_or_restricted' || stock.status === 'unknown')
    return { status: stock.status, observedAt: stock.observedAt };
  return undefined;
}

/** Historical names and codes are search suggestions, never native selections. */
export function nativeRecommendationLeads(snapshot: ReservationPaneSnapshot, path: string, kind?: string): NativeRecommendationLead[] {
  if (kind !== 'party_candidate' && kind !== 'rate_plan' && kind !== 'room_type') return [];
  const draft = snapshot.session.draft;
  const requestId = decodeURIComponent(path.split('/')[4] ?? '');
  const request = draft.proposal.content.requests.find(row => row.id === requestId);
  if (!request || !['create', 'quote'].includes(request.kind)) return [];
  const owner = path.replace(/\/nativeSelectionRef$/, '');
  const role = kind === 'rate_plan' ? 'rate_plan' : kind === 'room_type' ? 'room_type' : owner.endsWith('/bookingAgency') ? (request.kind === 'quote' ? 'bookingAgency' : 'agency')
    : owner.endsWith('/arAccount') ? 'ar_account' : 'organization';
  const queryPath = kind === 'rate_plan' || kind === 'room_type' ? path : `${owner}/name`;
  const normalize = (value: unknown) => text(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const currentQuery = normalize(valueAt(snapshot, queryPath));
  const leads = draft.observations.flatMap(observation => {
    const criteria = record(observation.criteria);
    const paths = Array.isArray(criteria.fieldPaths) ? criteria.fieldPaths : [criteria.fieldPath];
    if (criteria.kind !== 'historical_lookup_leads' || criteria.requestId !== request.id || criteria.workflow !== request.kind ||
        criteria.role !== role || criteria.sourceHash !== draft.source.sourceHash || !paths.includes(path) ||
        observation.status !== 'partial' || observation.coverage.complete !== false ||
        observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
        observation.sourceMessageId !== draft.source.messageId || normalize(criteria.query) !== currentQuery) return [];
    const rows = record(observation.result).leads;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap(raw => {
      const row = record(raw);
      if (typeof row.value !== 'string' || !row.value.trim() || typeof row.label !== 'string' ||
          (row.basis !== 'exact_sender' && row.basis !== 'normalized_entity') ||
          typeof row.support !== 'number' || !Number.isSafeInteger(row.support) || row.support < 1 ||
          kind === 'room_type' && (typeof row.confidence !== 'number' || row.confidence < 0.8)) return [];
      const stock = kind === 'room_type' ? currentRoomStock(snapshot, request.id, row.liveStock) : undefined;
      const historicalRank = typeof row.historicalRank === 'number' && Number.isSafeInteger(row.historicalRank) && row.historicalRank >= 0
        ? row.historicalRank : undefined;
      return [{ ref: observation.ref, value: row.value, label: row.label, basis: row.basis, support: row.support,
        ...(stock ? { stock } : {}), ...(historicalRank !== undefined ? { historicalRank } : {}) } satisfies NativeRecommendationLead & { historicalRank?: number }];
    });
  });
  const stockRank = (row: NativeRecommendationLead) => row.stock?.status === 'available_each_night' ? 0
    : row.stock?.status === 'sold_or_restricted' ? 2 : 1;
  return leads.filter((row, index) => leads.findIndex(other => normalize(other.value) === normalize(row.value)) === index)
    .sort((a, b) => stockRank(a) - stockRank(b) || (a.historicalRank ?? 0) - (b.historicalRank ?? 0)).slice(0, 3);
}
function amendPartyRole(snapshot: ReservationPaneSnapshot, requestId: string, owner: string): string | null {
  const root = `${requestPath(requestId)}/body/`;
  if (!owner.startsWith(root) || !/^(?:sharedChanges\/\d+|perTarget\/\d+\/changes\/\d+)\/value$/.test(owner.slice(root.length))) return null;
  const change = record(effectiveAt(snapshot, owner.slice(0, -'/value'.length)));
  if (change.op !== 'set') return null;
  return change.field === 'bookingAgency' ? 'agency' : change.field === 'organization' ? 'organization'
    : change.field === 'arAccount' ? 'ar_account' : null;
}
function currentIdentityRow(snapshot: ReservationPaneSnapshot, path: string, observation: ReservationPaneSnapshot['session']['draft']['observations'][number], verified: boolean): boolean {
  const criteria = record(observation.criteria), result = record(observation.result);
  if (verified && (record(result.rowVerification).status !== 'verified' || criteria.fieldPath !== path ||
      !Array.isArray(criteria.fieldPaths) || !criteria.fieldPaths.includes(path))) return false;
  if (criteria.fieldPath !== path && (!Array.isArray(criteria.fieldPaths) || !criteria.fieldPaths.includes(path))) return false;
  const parts = path.split('/'), requestId = decodeURIComponent(parts[4] ?? '');
  const request = snapshot.session.draft.proposal.content.requests.find(row => row.id === requestId);
  if (!request || (request.kind !== 'create' && request.kind !== 'quote' && request.kind !== 'amend') ||
      criteria.workflow !== request.kind || criteria.requestId !== request.id) return false;
  const owner = path.replace(/\/nativeSelectionRef$/, ''), guest = observation.kind === 'guest_candidate';
  const role = request.kind === 'amend' ? amendPartyRole(snapshot, request.id, owner) : guest ? 'guest' : owner.endsWith('/bookingAgency') ? 'agency'
    : owner.endsWith('/arAccount') ? 'ar_account' : 'organization';
  if (!role || !guest && criteria.role !== role || guest && request.kind !== 'create' ||
      request.kind === 'amend' && (guest || criteria.kind !== 'party_name')) return false;
  if (request.kind === 'create') {
    const body = record(effectiveAt(snapshot, `${requestPath(request.id)}/body`));
    const allocations = Array.isArray(body.allocations) ? body.allocations.map(record) : [];
    const allocationIndex = parts.indexOf('allocations'), sectionIndex = parts.indexOf('dateSections');
    if (allocationIndex >= 0) {
      if (allocations[Number(parts[allocationIndex + 1])]?.id !== criteria.allocationId) return false;
    } else if (sectionIndex >= 0) {
      const sections = Array.isArray(body.dateSections) ? body.dateSections.map(record) : [];
      const section = sections[Number(parts[sectionIndex + 1])];
      if (!section || !allocations.some(row => row.id === criteria.allocationId && row.dateSectionId === section.id)) return false;
    } else if (!allocations.some(row => row.id === criteria.allocationId)) return false;
  }
  const selected = snapshot.session.draft.fieldOverrides[path];
  if (verified && selected?.state === 'set' && selected.value === observation.ref) return true;
  if (!verified && guest && valueAt(snapshot, `${owner}/profileIntent`) !== 'existing_or_unknown') return false;
  const normal = (value: unknown) => text(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (guest) {
    const query = record(criteria.query);
    return query.field === 'lastName' && Boolean(normal(query.value)) &&
      normal(query.value) === normal(valueAt(snapshot, `${owner}/lastName`)) &&
      normal(query.firstName) === normal(valueAt(snapshot, `${owner}/firstName`)) &&
      normal(query.email) === normal(valueAt(snapshot, `${owner}/email`)) &&
      normal(query.mobile) === normal(valueAt(snapshot, `${owner}/mobile`));
  }
  const search = typeof criteria.query === 'string' ? criteria.query : criteria.searchName;
  return typeof search === 'string' && Boolean(normal(search)) && normal(search) === normal(valueAt(snapshot, `${owner}/name`));
}
export function nativeChoices(snapshot: ReservationPaneSnapshot, path: string, kind?: string): NativeChoice[] {
  const field = path.split('/').at(-1);
  const requestId = decodeURIComponent(path.split('/')[4] ?? '');
  const draft = snapshot.session.draft;
  const request = draft.proposal.content.requests.find(row => row.id === requestId);
  const amendTrack = request?.kind === 'amend' && kind === 'track';
  const bodyPath = `${requestPath(requestId)}/body`;
  const body = amendTrack ? record(effectiveAt(snapshot, bodyPath)) : {};
  const scope = record(body.targets);
  const included = Array.isArray(scope.include) ? scope.include.map(record) : [];
  const excluded = Array.isArray(scope.exclude) ? scope.exclude.map(record) : [];
  const relativePath = path.startsWith(`${bodyPath}/`) ? path.slice(bodyPath.length + 1).split('/') : [];
  const perTargets = Array.isArray(body.perTarget) ? body.perTarget.map(record) : [];
  const perTarget = relativePath[0] === 'perTarget' && /^\d+$/.test(relativePath[1] ?? '')
    ? perTargets[Number(relativePath[1])] : undefined;
  const excludedIds = new Set(excluded.map(row => row.id));
  const scopedTargets = included.filter(row => !excludedIds.has(row.id) &&
    (relativePath[0] === 'sharedChanges' || row.id === perTarget?.hintId));
  const targetKeys = scopedTargets.map(row => JSON.stringify([row.id, row.suggestedRef])).sort();
  const validTrackScope = scope.mode === 'explicit' && Array.isArray(scope.include) && Array.isArray(scope.exclude) &&
    scopedTargets.length > 0 && scopedTargets.every(row => typeof row.id === 'string' && row.id &&
      typeof row.suggestedRef === 'string' && row.suggestedRef) &&
    new Set(scopedTargets.map(row => row.id)).size === scopedTargets.length;
  const latestTrackRef = amendTrack ? draft.observations.findLast(observation => {
    const criteria = record(observation.criteria);
    const selectedTargets = Array.isArray(criteria.selectedTargets) ? criteria.selectedTargets.map(record) : [];
    const selectedKeys = selectedTargets.map(row => JSON.stringify([row.hintId, row.ref])).sort();
    return observation.status === 'complete' && observation.generationId === draft.generationId &&
      observation.propertyCode === draft.propertyCode && observation.sourceMessageId === draft.source.messageId &&
      criteria.kind === 'native_catalogue' && criteria.workflow === 'amend_catalogue' && criteria.catalogueKind === 'track' &&
      criteria.requestId === requestId && criteria.sourceHash === draft.source.sourceHash &&
      Array.isArray(criteria.fieldPaths) && criteria.fieldPaths.includes(path) &&
      validTrackScope && JSON.stringify(selectedKeys) === JSON.stringify(targetKeys) &&
      record(observation.coverage).complete === true && record(criteria.nativeCoverage).nativeResponseCorrelated === true;
  })?.ref : undefined;
  const choices = draft.observations.flatMap(observation => {
    const criteria = record(observation.criteria);
    const catalogue = criteria.kind === 'native_catalogue';
    if (amendTrack && (!latestTrackRef || observation.ref !== latestTrackRef)) return [];
    // Catalogue entries are individually observed even when the full list is incomplete.
    // Identity matches, however, require a complete search before they can be selected.
    if (observation.status !== 'complete' || (!catalogue && record(observation.coverage).complete !== true) ||
        observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
        observation.sourceMessageId !== draft.source.messageId ||
        (catalogue && criteria.sourceHash !== undefined && criteria.sourceHash !== draft.source.sourceHash) ||
        (kind && observation.kind !== kind && observation.criteria.catalogueKind !== kind)) return [];
    if (criteria.kind === 'verified_native_row' && !currentIdentityRow(snapshot, path, observation, true) ||
        criteria.kind === 'guest_profile' && observation.kind === 'guest_candidate' && !currentIdentityRow(snapshot, path, observation, false) ||
        request?.kind === 'amend' && observation.kind === 'party_candidate' &&
        !currentIdentityRow(snapshot, path, observation, false)) return [];
    const paths = Array.isArray(criteria.fieldPaths) ? criteria.fieldPaths : [criteria.fieldPath];
    const matches = paths.includes(path) || catalogue && criteria.requestId === requestId && paths.some(p => typeof p === 'string' && p.split('/').at(-1) === field);
    if (!matches) return [];
    const result = record(observation.result);
    const candidates = Array.isArray(result.candidates) ? result.candidates : Array.isArray(result.options) ? result.options : [result];
    // Entity selections need a unique observation for the candidate, not a batch ref.
    if (!catalogue && candidates.length > 1) return [];
    const rows = candidates.map(raw => { const row = record(raw); const code = text(row.code ?? row.nativeCode ?? row.name ?? [row.firstName, row.lastName].filter(Boolean).join(' '));
      const label = amendTrack ? typeof row.label === 'string' ? row.label : '' : text(row.label ?? row.name) || code;
      return { ref: observation.ref, value: code, label, detail: [row.meaning ?? row.description, row.nativeId, row.email].filter(Boolean).join(' · ') }; }).filter(row => row.value);
    return amendTrack ? rows.filter(row => /^[A-Z0-9]{1,12}$/.test(row.value) && row.label.trim() &&
      row.label.length <= 200 && ![...row.label].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
      rows.filter(other => other.value === row.value).length === 1) : rows;
  });
  const identities = kind === 'guest_candidate' || kind === 'party_candidate';
  const latest = new Map<string, NativeChoice>();
  for (const row of choices) {
    const key = identities ? JSON.stringify([row.ref, row.value]) : row.value;
    latest.delete(key); latest.set(key, row);
  }
  return [...latest.values()];
}

/** Incomplete native searches are useful leads, never selectable identities. */
export function partialNativeLeads(snapshot: ReservationPaneSnapshot, path: string, kind?: string): { ref: string; label: string; detail: string; canVerify: boolean }[] {
  if (kind !== 'guest_candidate' && kind !== 'party_candidate') return [];
  const draft = snapshot.session.draft;
  const ownerPath = path.replace(/\/nativeSelectionRef$/, '');
  const guest = kind === 'guest_candidate';
  const normal = (value: unknown) => text(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const name = normal(valueAt(snapshot, guest ? `${ownerPath}/lastName` : `${ownerPath}/name`));
  const first = normal(valueAt(snapshot, `${ownerPath}/firstName`));
  const email = normal(valueAt(snapshot, `${ownerPath}/email`));
  const mobile = normal(valueAt(snapshot, `${ownerPath}/mobile`));
  if (!name) return [];
  const parts = path.split('/'), requestId = parts[4];
  const allocationIndex = parts.indexOf('allocations');
  const body = requestId ? record(effectiveAt(snapshot, `/proposal/content/requests/${requestId}/body`)) : {};
  const allocations = Array.isArray(body.allocations) ? body.allocations : [];
  const allocation = allocationIndex >= 0 ? record(allocations[Number(parts[allocationIndex + 1])]) : {};
  const sectionIndex = parts.indexOf('dateSections');
  const sections = Array.isArray(body.dateSections) ? body.dateSections : [];
  const section = sectionIndex >= 0 ? record(sections[Number(parts[sectionIndex + 1])]) : {};
  const expectedAllocation = allocationIndex >= 0 ? allocation : sectionIndex >= 0
    ? record(allocations.find(row => record(row).dateSectionId === section.id)) : record(allocations[0]);
  const request = draft.proposal.content.requests.find(row => row.id === decodeURIComponent(requestId ?? ''));
  const role = guest ? 'guest' : ownerPath.endsWith('/bookingAgency') ? 'agency'
    : ownerPath.endsWith('/arAccount') ? 'ar_account' : 'organization';
  const leads = draft.observations.flatMap(observation => {
    if (observation.kind !== kind || observation.status !== 'partial' ||
        observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
        observation.sourceMessageId !== draft.source.messageId) return [];
    const criteria = record(observation.criteria), query = record(criteria.query);
    const paths = Array.isArray(criteria.fieldPaths) ? criteria.fieldPaths : [criteria.fieldPath];
    if ((request?.kind === 'amend' || criteria.kind === 'guest_profile' && guest) &&
        !currentIdentityRow(snapshot, path, observation, false)) return [];
    if (criteria.kind === 'source_bound_display_lead') {
      if (observation.coverage.complete !== false || !request || (request.kind !== 'create' && request.kind !== 'quote') ||
          criteria.workflow !== request.kind || criteria.requestId !== request.id || criteria.role !== role ||
          criteria.fieldPath !== path || paths.length !== 1 || paths[0] !== path ||
          request.kind === 'create' && (!expectedAllocation.id || criteria.allocationId !== expectedAllocation.id) ||
          guest && (query.field !== 'lastName' || normal(query.value) !== name || normal(query.firstName) !== first || normal(query.email) !== email || normal(query.mobile) !== mobile) ||
          !guest && (typeof criteria.query !== 'string' || normal(criteria.query) !== name)) return [];
    } else if (!paths.includes(path)) return [];
    const search = normal(typeof criteria.query === 'string' ? criteria.query : query.value ?? criteria.searchName);
    if (search && search !== name || normal(query.firstName) && normal(query.firstName) !== first ||
        normal(query.email) && normal(query.email) !== email || normal(query.mobile) && normal(query.mobile) !== mobile) return [];
    const result = record(observation.result);
    const coverage = record(guest ? result.coverage : result.nativeCoverage ?? result.coverage);
    const detail = coverage.truncated === true || coverage.serverMoreRecords === true ? 'Search truncated; more matches may exist.'
      : coverage.possiblyTruncated === true ? 'Search may be incomplete; more matches may exist.' : 'Infor result needs checking.';
    const rows = Array.isArray(result.candidates) ? result.candidates : [result];
    const candidate = record(rows[0]);
    const canVerify = rows.length === 1 && typeof candidate.nativeId === 'string' && /^\d{1,30}$/.test(candidate.nativeId) &&
      (guest || typeof candidate.name === 'string' && Boolean(candidate.name.trim())) &&
      criteria.workflow !== 'amend' && currentIdentityRow(snapshot, path, observation, false);
    return rows.map(raw => {
      const row = record(raw);
      const label = text(row.name) || [text(row.firstName), text(row.lastName)].filter(Boolean).join(' ');
      return { ref: observation.ref, label: [label, text(row.nativeId), text(row.email)].filter(Boolean).join(' · '), detail, canVerify };
    }).filter(row => row.label);
  });
  return leads.filter((row, index) => leads.findIndex(other => other.ref === row.ref && other.label === row.label) === index);
}
