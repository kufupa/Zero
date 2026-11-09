import type { ReservationPaneSnapshot, ReservationSourceContext, ReservationRequestProjection, ReservationFieldOverride, ReservationSavedServiceTarget, ReservationGuestProfileOptionField } from './types';

export type RowChange = { kind: 'move_allocation' | 'add_allocation' | 'remove_allocation' | 'add_date_section' | 'remove_date_section' | 'add_quote_group' | 'remove_quote_group' | 'add_target' | 'remove_target' | 'add_service' | 'remove_service' | 'add_document' | 'remove_document' | 'remove_action'; requestId: string; parentId?: string; entityId?: string; childIds?: string[] };
export type WorkbenchCommands = {
  stageEdit(path: string, value: unknown, state?: ReservationFieldOverride['state']): void;
  setUncommitted(key: string, dirty: boolean): void;
  edit(path: string, value: unknown, state?: ReservationFieldOverride['state']): Promise<void>;
  changeRows(change: RowChange): Promise<void>;
  selectNative(path: string, observationRef: string): Promise<void>;
  verifyNativeLead?(path: string, observationRef: string): Promise<void>;
  lookup(): Promise<void>;
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
  configureFiling(attachmentId: string, confirmation: string, kind: 'voucher' | 'payment_proof'): Promise<void>;
  lookupServices(target: string | ReservationSavedServiceTarget, serviceId?: string): Promise<void>;
  previewServices(target: string | ReservationSavedServiceTarget, serviceId?: string): Promise<void>;
  executeServices(target: string | ReservationSavedServiceTarget, serviceId: string, reviewedPrepareRef?: string): Promise<void>;
};
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
function currentIdentityRow(snapshot: ReservationPaneSnapshot, path: string, observation: ReservationPaneSnapshot['session']['draft']['observations'][number], verified: boolean): boolean {
  const criteria = record(observation.criteria), result = record(observation.result);
  if (verified && (record(result.rowVerification).status !== 'verified' || criteria.fieldPath !== path ||
      !Array.isArray(criteria.fieldPaths) || !criteria.fieldPaths.includes(path))) return false;
  if (criteria.fieldPath !== path && (!Array.isArray(criteria.fieldPaths) || !criteria.fieldPaths.includes(path))) return false;
  const parts = path.split('/'), requestId = decodeURIComponent(parts[4] ?? '');
  const request = snapshot.session.draft.proposal.content.requests.find(row => row.id === requestId);
  if (!request || (request.kind !== 'create' && request.kind !== 'quote') ||
      criteria.workflow !== request.kind || criteria.requestId !== request.id) return false;
  const owner = path.replace(/\/nativeSelectionRef$/, ''), guest = observation.kind === 'guest_candidate';
  const role = guest ? 'guest' : owner.endsWith('/bookingAgency') || owner.endsWith('/agency') ? 'agency'
    : owner.endsWith('/arAccount') ? 'ar_account' : owner.endsWith('/company') ? 'company' : 'organization';
  if (!guest && criteria.role !== role || guest && request.kind !== 'create') return false;
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
      normal(query.email) === normal(valueAt(snapshot, `${owner}/email`));
  }
  const search = typeof criteria.query === 'string' ? criteria.query : criteria.searchName;
  return typeof search === 'string' && Boolean(normal(search)) && normal(search) === normal(valueAt(snapshot, `${owner}/name`));
}
export function nativeChoices(snapshot: ReservationPaneSnapshot, path: string, kind?: string): NativeChoice[] {
  const field = path.split('/').at(-1);
  const requestId = path.split('/')[4];
  const draft = snapshot.session.draft;
  const choices = draft.observations.flatMap(observation => {
    const criteria = record(observation.criteria);
    const catalogue = criteria.kind === 'native_catalogue';
    // Catalogue entries are individually observed even when the full list is incomplete.
    // Identity matches, however, require a complete search before they can be selected.
    if (observation.status !== 'complete' || (!catalogue && record(observation.coverage).complete !== true) ||
        observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
        observation.sourceMessageId !== draft.source.messageId ||
        (kind && observation.kind !== kind && observation.criteria.catalogueKind !== kind)) return [];
    if (criteria.kind === 'verified_native_row' && !currentIdentityRow(snapshot, path, observation, true)) return [];
    const paths = Array.isArray(criteria.fieldPaths) ? criteria.fieldPaths : [criteria.fieldPath];
    const matches = paths.includes(path) || catalogue && criteria.requestId === requestId && paths.some(p => typeof p === 'string' && p.split('/').at(-1) === field);
    if (!matches) return [];
    const result = record(observation.result);
    const candidates = Array.isArray(result.candidates) ? result.candidates : Array.isArray(result.options) ? result.options : [result];
    // Entity selections need a unique observation for the candidate, not a batch ref.
    if (!catalogue && candidates.length > 1) return [];
    return candidates.map(raw => { const row = record(raw); const code = text(row.code ?? row.nativeCode ?? row.name ?? [row.firstName, row.lastName].filter(Boolean).join(' '));
      return { ref: observation.ref, value: code, label: text(row.label ?? row.name) || code, detail: [row.meaning ?? row.description, row.nativeId, row.email].filter(Boolean).join(' · ') }; }).filter(row => row.value);
  });
  return choices.filter((row, index) => choices.findIndex(v => v.ref === row.ref && v.value === row.value) === index);
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
  const role = guest ? 'guest' : ownerPath.endsWith('/bookingAgency') || ownerPath.endsWith('/agency') ? 'agency'
    : ownerPath.endsWith('/arAccount') ? 'ar_account' : ownerPath.endsWith('/company') ? 'company' : 'organization';
  const leads = draft.observations.flatMap(observation => {
    if (observation.kind !== kind || observation.status !== 'partial' ||
        observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
        observation.sourceMessageId !== draft.source.messageId) return [];
    const criteria = record(observation.criteria), query = record(criteria.query);
    const paths = Array.isArray(criteria.fieldPaths) ? criteria.fieldPaths : [criteria.fieldPath];
    if (criteria.kind === 'source_bound_display_lead') {
      if (observation.coverage.complete !== false || !request || (request.kind !== 'create' && request.kind !== 'quote') ||
          criteria.workflow !== request.kind || criteria.requestId !== request.id || criteria.role !== role ||
          criteria.fieldPath !== path || paths.length !== 1 || paths[0] !== path ||
          request.kind === 'create' && (!expectedAllocation.id || criteria.allocationId !== expectedAllocation.id) ||
          guest && (query.field !== 'lastName' || normal(query.value) !== name || normal(query.firstName) !== first || normal(query.email) !== email) ||
          !guest && (typeof criteria.query !== 'string' || normal(criteria.query) !== name)) return [];
    } else if (!paths.includes(path)) return [];
    const search = normal(typeof criteria.query === 'string' ? criteria.query : query.value ?? criteria.searchName);
    if (search && search !== name || normal(query.firstName) && normal(query.firstName) !== first ||
        normal(query.email) && normal(query.email) !== email) return [];
    const result = record(observation.result);
    const coverage = record(guest ? result.coverage : result.nativeCoverage ?? result.coverage);
    const detail = coverage.truncated === true || coverage.serverMoreRecords === true ? 'Search truncated; more matches may exist.'
      : coverage.possiblyTruncated === true ? 'Search may be incomplete; more matches may exist.' : 'Infor result needs checking.';
    const rows = Array.isArray(result.candidates) ? result.candidates : [result];
    const candidate = record(rows[0]);
    const canVerify = rows.length === 1 && typeof candidate.nativeId === 'string' && /^\d{1,30}$/.test(candidate.nativeId) &&
      (guest || typeof candidate.name === 'string' && Boolean(candidate.name.trim())) &&
      currentIdentityRow(snapshot, path, observation, false);
    return rows.map(raw => {
      const row = record(raw);
      const label = text(row.name) || [text(row.firstName), text(row.lastName)].filter(Boolean).join(' ');
      return { ref: observation.ref, label: [label, text(row.nativeId), text(row.email)].filter(Boolean).join(' · '), detail, canVerify };
    }).filter(row => row.label);
  });
  return leads.filter((row, index) => leads.findIndex(other => other.ref === row.ref && other.label === row.label) === index);
}
