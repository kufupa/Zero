import { CENTURION_RATE_CATALOGUE } from '../../../server-pilot/src/hms/centurion-rate-catalogue';
import type { ReservationPaneSnapshot, ReservationSourceContext, ReservationRequestProjection, ReservationFieldOverride, ReservationSavedServiceTarget, ReservationGuestProfileOptionField } from './types';

type BasicRowChange = { requestId: string; parentId?: string; entityId?: string; childIds?: string[] };
export type RowChange =
  | (BasicRowChange & { kind: 'move_allocation' | 'add_allocation' | 'remove_allocation' | 'add_date_section' | 'remove_date_section'
      | 'add_quote_group' | 'remove_quote_group' | 'add_quote_extra' | 'remove_quote_extra' | 'add_target' | 'remove_target' | 'add_service' | 'remove_service'
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
  view: { busy: boolean; error: string | null; preview: boolean; saving: boolean; blocked?: boolean };
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
type ServiceCatalogueScope = { kind: 'allocation'; allocationId: string } |
  { kind: 'saved_target'; requestId: string; hintId: string; observationRef: string };
type ServiceCatalogueRow = { observation: ReservationPaneSnapshot['session']['draft']['observations'][number]; candidate: Record<string, unknown> };
const savedServiceFields = ['code', 'name', 'itemId', 'quantity', 'startDate', 'endDate', 'unitPrice', 'frequency',
  'pricingControl', 'folio', 'comment', 'currency', 'averageDaily', 'totalCost', 'status'];
function stableServiceJson(value: unknown): string | undefined {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(record(item)).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, ordered(entry)])) : item;
  return JSON.stringify(ordered(value));
}

export function createServiceCatalogueContext(snapshot: ReservationPaneSnapshot, requestId: string, allocationId: string): unknown {
  const draft = snapshot.session.draft;
  const request = draft.proposal.content.requests.find(row => row.id === requestId && row.kind === 'create');
  if (!request || request.kind !== 'create') return null;
  const root = `${requestPath(requestId)}/body`;
  const allocationsPath = `${root}/allocations`;
  const allocations = effectiveAt(snapshot, allocationsPath);
  if (!Array.isArray(allocations)) return null;
  const index = allocations.findIndex(row => record(row).id === allocationId);
  if (index < 0) return null;
  const arrayOverride = draft.fieldOverrides[allocationsPath];
  const baseAllocations = arrayOverride?.state === 'set' && Array.isArray(arrayOverride.value)
    ? arrayOverride.value : request.body.allocations;
  const allocationPath = `${root}/allocations/${index}`;
  const overrides = Object.entries(draft.fieldOverrides).filter(([path]) => path !== allocationsPath && (path === root ||
    path.startsWith(`${root}/`) && (!path.startsWith(`${root}/allocations/`) ||
      path === allocationPath || path.startsWith(`${allocationPath}/`))))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, override]) => [path, override.state, override.state === 'set' ? override.value : null]);
  const allocationStructure = allocations.map(row => ({ id: record(row).id, dateSectionId: record(row).dateSectionId }));
  return { body: { ...request.body, allocations: [baseAllocations[index] ?? null] }, allocationIndex: index, allocationStructure, overrides };
}

export function currentServiceCatalogue(snapshot: ReservationPaneSnapshot, input: { requestId: string; serviceId: string;
  fieldPath: string; operation: string; selectedRef: unknown; scope: ServiceCatalogueScope | null }):
  { rows: ServiceCatalogueRow[]; history: ServiceCatalogueRow[]; hasCompleteBatch: boolean } {
  const draft = snapshot.session.draft, expectedKind = input.operation === 'add' ? 'catalogue_candidate' : 'saved_row_candidate';
  const matches = (observation: ReservationPaneSnapshot['session']['draft']['observations'][number]) => {
    const c = record(observation.criteria), target = record(c.targetRef);
    return observation.kind === 'service_preview' && observation.status === 'complete' && observation.coverage.complete &&
      observation.generationId === draft.generationId && observation.propertyCode === draft.propertyCode &&
      observation.sourceMessageId === draft.source.messageId && (c.sourceHash === undefined || c.sourceHash === draft.source.sourceHash) &&
      c.workflow === 'services' && c.requestId === input.requestId && c.serviceId === input.serviceId && c.fieldPath === input.fieldPath &&
      (input.scope?.kind === 'allocation' ? c.sourceAllocationId === input.scope.allocationId && c.targetRef === undefined
        : input.scope?.kind === 'saved_target' && c.sourceAllocationId === undefined && target.kind === 'saved_target' &&
          target.requestId === input.scope.requestId && target.hintId === input.scope.hintId && c.targetObservationRef === input.scope.observationRef);
  };
  const history = draft.observations.flatMap(observation => {
    if (!matches(observation) || observation.criteria.kind !== expectedKind) return [];
    const candidate = record(record(observation.result).candidate);
    return Object.keys(candidate).length ? [{ observation, candidate }] : [];
  });
  const markers = draft.observations.filter(observation => {
    const c = record(observation.criteria), refs = record(observation.result).candidateRefs;
    return matches(observation) && c.kind === 'catalogue_batch' && c.catalogueKind === expectedKind &&
      c.sourceHash === draft.source.sourceHash && typeof c.batchId === 'string' && Array.isArray(refs);
  });
  const marker = markers.at(-1);
  const markerValid = (observation: ReservationPaneSnapshot['session']['draft']['observations'][number]) => {
    const refs = record(observation.result).candidateRefs;
    return Array.isArray(refs) && new Set(refs).size === refs.length && refs.every(ref => typeof ref === 'string' &&
      history.some(row => row.observation.ref === ref && row.observation.criteria.batchId === observation.criteria.batchId));
  };
  if (marker && !markerValid(marker)) return { rows: [], history, hasCompleteBatch: true };
  if (marker && input.scope?.kind === 'allocation' && marker.criteria.createContext !== undefined &&
      stableServiceJson(marker.criteria.createContext) !== stableServiceJson(createServiceCatalogueContext(snapshot, input.requestId, input.scope.allocationId)))
    return { rows: [], history, hasCompleteBatch: true };
  const refs = marker ? record(marker.result).candidateRefs : [];
  const legacy = history.filter(row => row.observation.criteria.batchId === undefined);
  const legacyDigest = input.scope?.kind === 'allocation' ? legacy.at(-1)?.observation.criteria.createRequestDigest : undefined;
  const candidates = marker && Array.isArray(refs) ? history.filter(row => refs.includes(row.observation.ref))
    : legacy.filter(row => input.scope?.kind !== 'allocation' || row.observation.criteria.createRequestDigest === legacyDigest);
  const selected = history.find(row => row.observation.ref === input.selectedRef &&
    (row.observation.criteria.batchId === undefined || markers.some(batch => markerValid(batch) &&
      batch.criteria.batchId === row.observation.criteria.batchId && Array.isArray(batch.result.candidateRefs) &&
      batch.result.candidateRefs.includes(row.observation.ref))));
  const equivalent = (left: ServiceCatalogueRow, right: ServiceCatalogueRow) => {
    if (input.scope?.kind === 'allocation' && left.observation.criteria.createRequestDigest !== right.observation.criteria.createRequestDigest) return false;
    if (input.operation === 'add') return text(left.candidate.itemId) === text(right.candidate.itemId) &&
      Boolean(text(left.candidate.itemId)) && text(left.candidate.code) === text(right.candidate.code);
    const leftFields = record(left.candidate.fields), rightFields = record(right.candidate.fields);
    return Boolean(text(left.candidate.nativeId)) && text(left.candidate.nativeId) === text(right.candidate.nativeId) &&
      savedServiceFields.every(key => Object.hasOwn(leftFields, key) && Object.hasOwn(rightFields, key) &&
        JSON.stringify(leftFields[key]) === JSON.stringify(rightFields[key]));
  };
  const latest = new Map<string, ServiceCatalogueRow>();
  for (const row of candidates) {
    const identity = text(input.operation === 'add' ? row.candidate.itemId : row.candidate.nativeId).trim();
    const key = identity ? `native:${identity}` : `observation:${row.observation.ref}`;
    latest.delete(key); latest.set(key, selected && equivalent(selected, row) ? selected : row);
  }
  return { rows: [...latest.values()], history, hasCompleteBatch: Boolean(marker) };
}
export type NativeRecommendationLead = { ref: string; value: string; label: string;
  basis: 'exact_sender' | 'normalized_entity'; support: number;
  stock?: { status: 'available_each_night' | 'sold_or_restricted' | 'unknown'; observedAt: string } };

export function autoTransferHistory(snapshot: ReservationPaneSnapshot, path: string): { support: number; denominator: number; partyKind: 'organization' | 'arAccount' } | null {
  const draft = snapshot.session.draft;
  if (snapshot.session.sourceChanged) return null;
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

export function savedAutoTransferHistory(snapshot: ReservationPaneSnapshot, requestId: string, hintId: string,
  partyKind: 'organization' | 'arAccount'): { name: string; support: number; denominator: number } | null {
  const draft = snapshot.session.draft;
  if (snapshot.session.sourceChanged) return null;
  const request = draft.proposal.content.requests.find(row => row.id === requestId && row.kind === 'amend');
  if (!request) return null;
  const root = `${requestPath(requestId)}/body`, body = record(effectiveAt(snapshot, root)), scope = record(body.targets);
  if (scope.mode !== 'explicit' || !Array.isArray(scope.include) || !Array.isArray(scope.exclude) ||
      !Array.isArray(body.sharedChanges) || !Array.isArray(body.perTarget)) return null;
  const targets = scope.include.map(record), indices = targets.flatMap((row, index) => row.id === hintId ? [index] : []);
  if (indices.length !== 1 || scope.exclude.map(record).some(row => row.id === hintId)) return null;
  const perTarget = body.perTarget.map(record).filter(row => row.hintId === hintId);
  const targetChanges = perTarget.length === 1 ? perTarget[0]?.changes : null;
  if (!Array.isArray(targetChanges)) return null;
  const changes = [...body.sharedChanges, ...targetChanges].map(record);
  if (changes.some(change => change.op != null && (change.field === partyKind || typeof change.field !== 'string'))) return null;
  if (draft.operationResults.some(operation => operation.workflow === 'amend' && operation.requestId === requestId &&
      (!operation.allocationId || operation.allocationId === hintId) && (operation.status === 'succeeded' || operation.status === 'unknown' ||
      operation.status === 'failed' && (!operation.observationRefs.length || !operation.observationRefs.every(ref =>
        draft.observations.some(row => row.ref === ref && row.criteria.workflow === 'amend' &&
          ['prepare', 'retain_callback_unsupported'].includes(text(row.criteria.stage))))) ||
      operation.status === 'prepared' && operation.observationRefs.some(ref =>
        draft.observations.some(row => row.ref === ref && row.criteria.stage === 'callback_price_review'))))) return null;
  const index = indices[0]!, target = targets[index]!, selectionPath = `${root}/targets/include/${index}/suggestedRef`;
  const selectedRef = valueAt(snapshot, selectionPath);
  if (typeof selectedRef !== 'string' || !selectedRef) return null;
  const bound = (row: ReservationPaneSnapshot['session']['draft']['observations'][number]) =>
    row.generationId === draft.generationId && row.propertyCode === draft.propertyCode && row.sourceMessageId === draft.source.messageId;
  const selectedRows = draft.observations.filter(row => row.ref === selectedRef && row.kind === 'stay_candidate' &&
    row.status === 'complete' && row.coverage.complete === true && bound(row) && row.criteria.workflow === 'amend' &&
    row.criteria.kind === 'saved_target' && row.criteria.requestId === requestId && row.criteria.hintId === hintId &&
    row.criteria.selectionPath === selectionPath);
  if (selectedRows.length !== 1) return null;
  const selected = selectedRows[0]!, query = record(selected.criteria.query), candidate = record(selected.result.candidate);
  const normalized = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
  if (!['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture'].every(key => normalized(query[key]) === normalized(target[key])) ||
      typeof candidate.confirmation !== 'string' || !/^\d{6,10}-\d{1,2}$/.test(candidate.confirmation.trim()) ||
      normalized(target.confirmation) && normalized(candidate.confirmation) !== normalized(target.confirmation)) return null;
  const prepare = draft.observations.findLast(row => row.kind === 'rate_availability' && row.status === 'complete' &&
    row.coverage.complete === true && bound(row) && row.criteria.workflow === 'amend' && row.criteria.requestId === requestId &&
    row.criteria.hintId === hintId && row.criteria.selectedRef === selectedRef && row.result.outcome === 'prepared');
  if (!prepare || prepare.criteria.draftRevision !== draft.revision) return null;
  const beforeStay = record(prepare.result.before), identity = ['confirmation', 'reservationStayId', 'reservationId', 'recordId', 'guestId'];
  if (candidate.source !== 'record_view_ext_model' || beforeStay.source !== candidate.source ||
      identity.some(key => typeof candidate[key] !== 'string' || !candidate[key] || candidate[key] !== beforeStay[key])) return null;
  const baseChanges = record(prepare.result.semanticInput).baseChanges;
  if (!baseChanges || typeof baseChanges !== 'object' || Array.isArray(baseChanges) || Object.hasOwn(baseChanges, partyKind)) return null;
  const baseline = record(prepare.result.nativePartyBaseline), party = record(baseline[partyKind]);
  const before = record(record(prepare.result.recoveryBaseline).beforeParties);
  const idField = partyKind === 'organization' ? 'companyid' : 'araccountid';
  const nameFields = partyKind === 'organization' ? ['company', 'companyname'] : ['araccountname'];
  const names = nameFields.map(key => before[key]).filter(value => value !== null && value !== undefined && value !== '');
  const normalizeName = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
  const partyName = typeof party.name === 'string' ? party.name : '';
  if (party.state !== 'selected' || typeof party.nativeId !== 'string' || !/^[1-9]\d*$/.test(party.nativeId) ||
      !partyName.trim() || String(before[idField] ?? '').trim() !== party.nativeId || !names.length ||
      names.some(name => typeof name !== 'string' || normalizeName(name) !== normalizeName(partyName))) return null;
  const hint = draft.observations.findLast(row => {
    const criteria = record(row.criteria), result = record(row.result);
    return row.kind === 'stay_candidate' && row.status === 'partial' && row.coverage.complete === false && bound(row) &&
      criteria.kind === 'historical_auto_transfer_hint' && criteria.binding === 'saved_amend_baseline' &&
      criteria.workflow === 'amend' && criteria.requestId === requestId && criteria.hintId === hintId &&
      criteria.sourceHash === draft.source.sourceHash && criteria.fieldPath === selectionPath && criteria.selectionPath === selectionPath &&
      criteria.selectedRef === selectedRef && criteria.prepareRef === prepare.ref && criteria.draftRevision === draft.revision &&
      criteria.partyKind === partyKind && criteria.partyNativeId === party.nativeId && criteria.partyQuery === partyName &&
      result.value === true && result.evidence === 'stay360_auto_transfer_card_row' &&
      typeof result.support === 'number' && Number.isSafeInteger(result.support) && result.support > 0 &&
      typeof result.denominator === 'number' && Number.isSafeInteger(result.denominator) && result.denominator >= result.support &&
      typeof result.confidence === 'number' && result.confidence >= 0.8 && result.confidence <= 1 && result.support / result.denominator >= 0.8;
  });
  if (!hint) return null;
  const result = record(hint.result);
  return typeof result.support === 'number' && typeof result.denominator === 'number'
    ? { name: partyName, support: result.support, denominator: result.denominator } : null;
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
  const role = kind === 'rate_plan' ? 'rate_plan' : kind === 'room_type' ? 'room_type' : owner.endsWith('/bookingAgency') ? 'bookingAgency'
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
  return change.field === 'bookingAgency' ? 'bookingAgency' : change.field === 'organization' ? 'organization'
    : change.field === 'arAccount' ? 'ar_account' : null;
}
function currentIdentityRow(snapshot: ReservationPaneSnapshot, path: string, observation: ReservationPaneSnapshot['session']['draft']['observations'][number], verified: boolean): boolean {
  const criteria = record(observation.criteria), result = record(observation.result);
  if (criteria.sourceHash !== undefined && criteria.sourceHash !== snapshot.session.draft.source.sourceHash) return false;
  if (verified && (record(result.rowVerification).status !== 'verified' || criteria.fieldPath !== path ||
      !Array.isArray(criteria.fieldPaths) || !criteria.fieldPaths.includes(path))) return false;
  if (criteria.fieldPath !== path && (!Array.isArray(criteria.fieldPaths) || !criteria.fieldPaths.includes(path))) return false;
  const parts = path.split('/'), requestId = decodeURIComponent(parts[4] ?? '');
  const request = snapshot.session.draft.proposal.content.requests.find(row => row.id === requestId);
  const guest = observation.kind === 'guest_candidate';
  const createdProfile = guest && request?.kind === 'create' && criteria.workflow === 'guest_profile_create';
  if (!request || (request.kind !== 'create' && request.kind !== 'quote' && request.kind !== 'amend') ||
      criteria.workflow !== request.kind && !createdProfile || criteria.requestId !== request.id) return false;
  const owner = path.replace(/\/nativeSelectionRef$/, '');
  const role = request.kind === 'amend' ? amendPartyRole(snapshot, request.id, owner) : guest ? 'guest' : owner.endsWith('/bookingAgency') ? 'bookingAgency'
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
  if (guest && valueAt(snapshot, `${owner}/profileIntent`) !== 'existing_or_unknown') return false;
  const normal = (value: unknown) => text(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const selected = snapshot.session.draft.fieldOverrides[path];
  const selectedRef = selected && selected.state !== 'inherit' ? valueAt(snapshot, path)
    : valueAt(snapshot, path) ?? valueAt(snapshot, `${owner}/suggestedRef`);
  const candidates = Array.isArray(result.candidates) ? result.candidates : [result];
  const candidate = candidates.length === 1 ? record(candidates[0]) : {};
  if (createdProfile) {
    const attemptId = criteria.attemptId;
    return criteria.fieldPath === path && typeof attemptId === 'string' && Boolean(attemptId) &&
      observation.ref === `guest-created-${attemptId}` && selectedRef === observation.ref && result.outcome === 'created' &&
      typeof candidate.nativeId === 'string' && /^\d{1,30}$/.test(candidate.nativeId) &&
      Boolean(normal(candidate.firstName)) && Boolean(normal(candidate.lastName)) &&
      normal(candidate.firstName) === normal(valueAt(snapshot, `${owner}/firstName`)) &&
      normal(candidate.lastName) === normal(valueAt(snapshot, `${owner}/lastName`)) &&
      snapshot.session.draft.operationResults.some(operation => operation.id === attemptId &&
        operation.generationId === snapshot.session.draft.generationId && operation.workflow === 'guest_profile' &&
        operation.status === 'succeeded' && operation.requestId === request.id &&
        operation.allocationId === criteria.allocationId && operation.observationRefs.includes(observation.ref));
  }
  if (observation.status === 'complete' && selectedRef === observation.ref && (guest
    ? normal(candidate.firstName) === normal(valueAt(snapshot, `${owner}/firstName`)) &&
      normal(candidate.lastName) === normal(valueAt(snapshot, `${owner}/lastName`))
    : normal(candidate.name) && normal(candidate.name) === normal(valueAt(snapshot, `${owner}/name`)))) return true;
  if (guest) {
    const query = record(criteria.query);
    if (criteria.kind !== 'guest_profile' && criteria.kind !== 'verified_native_row' && typeof criteria.candidateNativeId === 'string') {
      const guestName = (value: unknown) => {
        let name = text(value);
        const parts = name.split(',');
        if (parts.length === 2 && parts.every(part => part.trim())) name = `${parts[1]!.trim()} ${parts[0]!.trim()}`;
        return name.trim().replace(/^(?:(?:mr|mrs|ms|miss|dr|prof|professor)\.?\s+)+/i, '')
          .normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\u2018\u2019\u02bc]/g, "'")
          .replace(/\s+/gu, ' ').replace(/(^|\s)((?:[a-z]\.\s*)+[a-z]\.?)(?=\s|$)/g,
            (_match, prefix: string, initials: string) => prefix + initials.replace(/[.\s]/g, ''))
          .replace(/\b([a-z])\.(?=\s|$)/g, '$1').replace(/\b(?:[a-z]\s+)+[a-z]\b/g, initials => initials.replace(/\s+/g, ''));
      };
      const currentName = [text(valueAt(snapshot, `${owner}/firstName`)), text(valueAt(snapshot, `${owner}/lastName`))].filter(Boolean).join(' ');
      const phone = (value: unknown) => text(value).replace(/\D/g, '');
      return Boolean(guestName(criteria.name) || normal(criteria.email) || phone(criteria.mobile)) &&
        guestName(criteria.name) === guestName(currentName) &&
        normal(criteria.email) === normal(valueAt(snapshot, `${owner}/email`)) &&
        phone(criteria.mobile) === phone(valueAt(snapshot, `${owner}/mobile`));
    }
    return query.field === 'lastName' && Boolean(normal(query.value)) &&
      normal(query.value) === normal(valueAt(snapshot, `${owner}/lastName`)) &&
      normal(query.firstName) === normal(valueAt(snapshot, `${owner}/firstName`)) &&
      normal(query.email) === normal(valueAt(snapshot, `${owner}/email`)) &&
      normal(query.mobile) === normal(valueAt(snapshot, `${owner}/mobile`));
  }
  const search = typeof criteria.query === 'string' ? criteria.query : criteria.searchName ?? criteria.name ??
    (criteria.kind === 'historical_party_native_confirmation' ? candidate.name : undefined);
  return typeof search === 'string' && Boolean(normal(search)) && normal(search) === normal(valueAt(snapshot, `${owner}/name`));
}
function nativeCatalogueScope(snapshot: ReservationPaneSnapshot, path: string, kind: string | undefined,
  observation: ReservationPaneSnapshot['session']['draft']['observations'][number]): boolean {
  const draft = snapshot.session.draft, criteria = record(observation.criteria);
  const requestId = decodeURIComponent(path.split('/')[4] ?? '');
  const request = draft.proposal.content.requests.find(row => row.id === requestId);
  if (!request || criteria.kind !== 'native_catalogue' || criteria.requestId !== requestId ||
      criteria.workflow !== `${request.kind}_catalogue` && !(request.kind === 'create' && criteria.workflow === 'create') ||
      kind && criteria.catalogueKind !== kind || observation.generationId !== draft.generationId ||
      observation.propertyCode !== draft.propertyCode || observation.sourceMessageId !== draft.source.messageId ||
      criteria.sourceHash !== undefined && criteria.sourceHash !== draft.source.sourceHash ||
      !Array.isArray(criteria.fieldPaths)) return false;
  if (criteria.workflow === 'create') {
    const body = record(effectiveAt(snapshot, `${requestPath(requestId)}/body`));
    const allocations = Array.isArray(body.allocations) ? body.allocations.map(record) : [];
    const sections = Array.isArray(body.dateSections) ? body.dateSections.map(record) : [];
    const sourcePath = criteria.fieldPaths.find(value => typeof value === 'string');
    const sourceParts = typeof sourcePath === 'string' ? sourcePath.split('/') : [];
    const sourceIndex = sourceParts.indexOf('allocations');
    if (sourceIndex < 0 || allocations[Number(sourceParts[sourceIndex + 1])]?.id !== criteria.allocationId) return false;
    if (!criteria.fieldPaths.includes(path)) {
      const parts = path.split('/'), allocationIndex = parts.indexOf('allocations'), sectionIndex = parts.indexOf('dateSections');
      const expected = allocationIndex >= 0 ? allocations[Number(parts[allocationIndex + 1])]
        : sectionIndex >= 0 ? allocations.find(row => row.dateSectionId === sections[Number(parts[sectionIndex + 1])]?.id)
        : allocations[0];
      if (!expected || expected.id !== criteria.allocationId || sourceParts.at(-1) !== parts.at(-1)) return false;
    }
  } else if (!criteria.fieldPaths.includes(path) && !['rate_plan', 'room_type', 'room_type_for_charge'].includes(String(criteria.catalogueKind))) return false;
  return observation.status === 'complete' || observation.status === 'partial' &&
    record(observation.result).closeOutcome === 'closed_unsaved';
}

function nativeCatalogueContext(observation: ReservationPaneSnapshot['session']['draft']['observations'][number]): string {
  const criteria = record(observation.criteria), native = record(criteria.nativeCriteria);
  if (criteria.catalogueKind === 'rate_plan') return JSON.stringify(['rate', native.rateShopControls ?? null]);
  if (criteria.catalogueKind === 'room_type' || criteria.catalogueKind === 'room_type_for_charge')
    return JSON.stringify(['room', native.nativeFilters ?? null]);
  return '';
}

export function hasCompleteNativeCatalogue(snapshot: ReservationPaneSnapshot, path: string, kind?: string): boolean {
  const requestId = decodeURIComponent(path.split('/')[4] ?? '');
  if (kind === 'track' && snapshot.session.draft.proposal.content.requests.some(row => row.id === requestId && row.kind === 'amend')) return false;
  const exact = snapshot.session.draft.observations.filter(observation => nativeCatalogueScope(snapshot, path, kind, observation) &&
    Array.isArray(observation.criteria.fieldPaths));
  const last = exact.at(-1);
  return Boolean(last && exact.some(observation => nativeCatalogueContext(observation) === nativeCatalogueContext(last) &&
    observation.status === 'complete' && observation.coverage.complete === true));
}

export function nativeChoices(snapshot: ReservationPaneSnapshot, path: string, kind?: string): NativeChoice[] {
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
  const exactCatalogue = draft.observations.some(observation => nativeCatalogueScope(snapshot, path, kind, observation) &&
    Array.isArray(observation.criteria.fieldPaths) && observation.criteria.fieldPaths.includes(path));
  const compatibleCatalogue = (observation: ReservationPaneSnapshot['session']['draft']['observations'][number]) =>
    nativeCatalogueScope(snapshot, path, kind, observation) && (['rate_plan', 'room_type', 'room_type_for_charge'].includes(kind ?? '') || !exactCatalogue ||
      Array.isArray(observation.criteria.fieldPaths) && observation.criteria.fieldPaths.includes(path));
  const lastCatalogue = draft.observations.findLast(observation => (!amendTrack || observation.ref === latestTrackRef) && compatibleCatalogue(observation));
  const currentCatalogue = (observation: ReservationPaneSnapshot['session']['draft']['observations'][number]) =>
    compatibleCatalogue(observation) && (lastCatalogue ? nativeCatalogueContext(observation) === nativeCatalogueContext(lastCatalogue) : false);
  const lastCompleteCatalogue = draft.observations.findLastIndex(observation =>
    (!amendTrack || observation.ref === latestTrackRef) && currentCatalogue(observation) &&
    observation.status === 'complete' && observation.coverage.complete === true);
  const choices = draft.observations.flatMap((observation, observationIndex) => {
    const criteria = record(observation.criteria);
    const catalogue = criteria.kind === 'native_catalogue';
    if (amendTrack && (!latestTrackRef || observation.ref !== latestTrackRef)) return [];
    // Catalogue entries are individually observed even when the full list is incomplete.
    // Identity matches, however, require a complete search before they can be selected.
    if (catalogue ? !currentCatalogue(observation) || observationIndex < lastCompleteCatalogue
      : observation.status !== 'complete' || record(observation.coverage).complete !== true ||
        observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
        observation.sourceMessageId !== draft.source.messageId ||
        (kind && observation.kind !== kind && observation.criteria.catalogueKind !== kind)) return [];
    if ((observation.kind === 'guest_candidate' || observation.kind === 'party_candidate') &&
        !currentIdentityRow(snapshot, path, observation, criteria.kind === 'verified_native_row')) return [];
    const paths = Array.isArray(criteria.fieldPaths) ? criteria.fieldPaths : [criteria.fieldPath];
    const matches = catalogue || paths.includes(path);
    if (!matches) return [];
    const result = record(observation.result);
    const candidates = Array.isArray(result.candidates) ? result.candidates : Array.isArray(result.options) ? result.options : [result];
    // Entity selections need a unique observation for the candidate, not a batch ref.
    if (!catalogue && candidates.length > 1) return [];
    const rows = candidates.map(raw => { const row = record(raw); const code = text(row.code ?? row.nativeCode ?? row.name ?? [row.firstName, row.lastName].filter(Boolean).join(' '));
      const label = amendTrack ? typeof row.label === 'string' ? row.label : '' : text(row.label ?? row.name) || code;
      return { choice: { ref: observation.ref, value: code, label, detail: [row.meaning ?? row.description, row.nativeId, row.email].filter(Boolean).join(' · ') },
        candidate: row,
        nativeId: typeof row.nativeId === 'string' && row.nativeId.trim() ? row.nativeId : null }; }).filter(row => row.choice.value);
    return amendTrack ? rows.filter(({ choice }) => /^[A-Z0-9]{1,12}$/.test(choice.value) && choice.label.trim() &&
      choice.label.length <= 200 && ![...choice.label].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
      rows.filter(other => other.choice.value === choice.value).length === 1) : rows;
  });
  const identities = kind === 'guest_candidate' || kind === 'party_candidate';
  const selected = draft.fieldOverrides[path];
  const selectedRef = selected && selected.state !== 'inherit' ? valueAt(snapshot, path)
    : valueAt(snapshot, path) ?? valueAt(snapshot, `${path.replace(/\/nativeSelectionRef$/, '')}/suggestedRef`);
  const normal = (value: unknown) => text(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const equivalent = (left: Record<string, unknown>, right: Record<string, unknown>) => {
    const fields = kind === 'guest_candidate' ? ['firstName', 'lastName', 'email', 'city', 'country'] : ['name'];
    const phone = (row: Record<string, unknown>) => text(row.phoneNumber ?? row.mobile).replace(/\D/g, '');
    return fields.every(field => normal(left[field]) === normal(right[field])) &&
      (kind !== 'guest_candidate' || phone(left) === phone(right));
  };
  const latest = new Map<string, { choice: NativeChoice; candidate: Record<string, unknown> }>();
  for (const { choice, candidate, nativeId } of choices) {
    const key = identities ? JSON.stringify(nativeId ? ['nativeId', nativeId] : ['ref', choice.ref]) : choice.value;
    const previous = latest.get(key);
    if (identities && selectedRef != null && previous?.choice.ref === selectedRef && equivalent(previous.candidate, candidate)) continue;
    latest.delete(key); latest.set(key, { choice, candidate });
  }
  const native = [...latest.values()].map(row => row.choice);
  if (kind !== 'rate_plan') return native;
  const available = new Map<string, NativeChoice>();
  if (draft.propertyCode === 'HRCEN') for (const [code, entry] of Object.entries(CENTURION_RATE_CATALOGUE))
    available.set(code, { ref: `catalogue:${code}`, value: code, label: entry.name, detail: 'Check price and availability in Infor' });
  for (const observation of draft.observations) {
    if (observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
      observation.sourceMessageId !== draft.source.messageId || observation.criteria.requestId !== requestId) continue;
    const result = record(observation.result);
    for (const raw of Array.isArray(result.rateOptions) ? result.rateOptions : []) {
      const option = record(raw), code = text(option.rateCode ?? option.ratePlan ?? option.code);
      if (code) available.set(code, { ref: observation.ref, value: code,
        label: text(option.rateName ?? option.label) || code, detail: 'Check price and availability in Infor' });
    }
  }
  for (const choice of native) available.set(choice.value, choice);
  return [...available.values()];
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
  const role = guest ? 'guest' : ownerPath.endsWith('/bookingAgency') ? 'bookingAgency'
    : ownerPath.endsWith('/arAccount') ? 'ar_account' : 'organization';
  const leads = draft.observations.flatMap(observation => {
    if (observation.kind !== kind || observation.status !== 'partial' ||
        observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
        observation.sourceMessageId !== draft.source.messageId) return [];
    const criteria = record(observation.criteria), query = record(criteria.query);
    const paths = Array.isArray(criteria.fieldPaths) ? criteria.fieldPaths : [criteria.fieldPath];
    if (!currentIdentityRow(snapshot, path, observation, false)) return [];
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
