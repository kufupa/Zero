import type { ReservationPaneSnapshot, ReservationSourceContext, ReservationRequestProjection, ReservationFieldOverride, ReservationSavedServiceTarget, ReservationGuestProfileOptionField } from './types';

export type RowChange = { kind: 'move_allocation' | 'add_allocation' | 'remove_allocation' | 'add_date_section' | 'remove_date_section' | 'add_quote_group' | 'remove_quote_group' | 'add_target' | 'remove_target' | 'add_service' | 'remove_service' | 'add_document' | 'remove_document' | 'remove_action'; requestId: string; parentId?: string; entityId?: string; childIds?: string[] };
export type WorkbenchCommands = {
  stageEdit(path: string, value: unknown, state?: ReservationFieldOverride['state']): void;
  setUncommitted(key: string, dirty: boolean): void;
  edit(path: string, value: unknown, state?: ReservationFieldOverride['state']): Promise<void>;
  changeRows(change: RowChange): Promise<void>;
  selectNative(path: string, observationRef: string): Promise<void>;
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
    && draft.source.sourceHash === source.sourceHash && snapshot?.sourceMessageId === source.messageId);
}
export const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const text = (v: unknown): string => v == null ? '' : typeof v === 'object' ? String(record(v).name ?? record(v).code ?? '') : String(v);
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
export function nativeChoices(snapshot: ReservationPaneSnapshot, path: string, kind?: string): NativeChoice[] {
  const field = path.split('/').at(-1);
  const requestId = path.split('/')[4];
  const choices = snapshot.session.draft.observations.flatMap(observation => {
    if (observation.status !== 'complete' || (kind && observation.kind !== kind && observation.criteria.catalogueKind !== kind)) return [];
    const criteria = record(observation.criteria);
    const paths = Array.isArray(criteria.fieldPaths) ? criteria.fieldPaths : [criteria.fieldPath];
    const catalogue = criteria.kind === 'native_catalogue';
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
