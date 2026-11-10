'use client';

import type { WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { effectiveAt, record, requestPath, text, valueAt } from '@/lib/reservation-workflow/views';
import { Field, Section } from '../shared/stay-fields';
import { TargetSearch } from './amend-editor';
import styles from './other-editors.module.css';

type Editor = WorkbenchEditorProps;
type SavedTarget = { kind: 'saved_target'; requestId: string; hintId: string };
const serviceFields = [
  ['quantity', 'Quantity', 'text'], ['startDate', 'Start date', 'date'], ['endDate', 'End date', 'date'],
  ['unitPrice', 'Unit price', 'text'], ['frequency', 'Frequency', 'text'], ['pricingControl', 'Pricing basis', 'text'],
  ['folio', 'Folio', 'text'], ['comment', 'Comment', 'text'],
] as const;
const nativeFields = [
  ['code', 'Item'], ['name', 'Description'], ['quantity', 'Quantity'], ['startDate', 'Start'], ['endDate', 'End'],
  ['unitPrice', 'Unit price'], ['frequency', 'Frequency'], ['pricingControl', 'Pricing basis'], ['folio', 'Folio'],
  ['comment', 'Comment'], ['averageDaily', 'Native average'],
] as const;

function nativeOptions(control: Record<string, unknown>) {
  const rows = Array.isArray(control.options) ? control.options.map(record).filter(row => typeof row.code === 'string' && row.code.trim()) : [];
  return rows.filter(row => rows.filter(other => other.code === row.code).length === 1).map(row => {
    const code = row.code as string, name = text(row.name).trim();
    return { value: code, label: name && name !== code ? `${code} · ${name}` : code };
  });
}

type CatalogueRow = { observation: Editor['snapshot']['session']['draft']['observations'][number]; candidate: Record<string, unknown> };
function latestCatalogueByIdentity(rows: CatalogueRow[], operation: string): CatalogueRow[] {
  const latest = new Map<string, CatalogueRow>();
  for (const row of [...rows].reverse()) {
    const identity = text(operation === 'add' ? row.candidate.itemId : row.candidate.nativeId).trim();
    const key = identity ? `native:${identity}` : `observation:${row.observation.ref}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  return [...latest.values()].reverse();
}

function excludedScopeIssue(stay: Record<string, unknown> | null, exclusions: unknown[]): 'overlap' | 'unresolved' | null {
  if (!exclusions.length) return null;
  if (!stay) return 'unresolved';
  const confirmation = text(stay.confirmation), nativeName = `${text(stay.firstName)} ${text(stay.lastName)}`.trim();
  const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const sameGuest = (left: unknown, right: unknown) => {
    const normalize = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() : '';
    const forms = (value: unknown) => {
      const raw = normalize(value);
      if (typeof value !== 'string') return [raw].filter(Boolean);
      const parts = value.split(',');
      return [raw, ...(parts.length === 2 ? [normalize(`${parts[1]?.trim()} ${parts[0]?.trim()}`)] : [])].filter(Boolean);
    };
    const leftForms = forms(left);
    return leftForms.some(value => forms(right).includes(value));
  };
  for (const value of exclusions) {
    const hint = record(value), excludedConfirmation = text(hint.confirmation);
    if (excludedConfirmation && /^\d{6,10}-\d{1,2}$/.test(excludedConfirmation)) {
      if (excludedConfirmation === confirmation) return 'overlap';
      continue;
    }
    const guestName = text(hint.guestName), arrival = hint.bookedArrival, departure = hint.bookedDeparture;
    const disjointDates = validDate(arrival) && validDate(departure) && validDate(stay.arrival) && validDate(stay.departure) &&
      (departure <= stay.arrival || stay.departure <= arrival);
    const differentGuest = Boolean(guestName && nativeName && !sameGuest(nativeName, guestName));
    if (sameGuest(guestName, nativeName) && validDate(arrival) && validDate(departure) && validDate(stay.arrival) && validDate(stay.departure) && !disjointDates) return 'overlap';
    if (!differentGuest || !disjointDates) return 'unresolved';
  }
  return null;
}

const unknownServiceValue = Symbol('unknown service value');
const noneServiceValue = Symbol('no service value');
function servicePreviewMatches(editor: Editor, service: Service, root: string, targetRoot: string, operation: string, preview: Record<string, unknown>, savedTarget: boolean) {
  if (preview.operation !== operation) return false;
  if (operation === 'remove') return true;
  const request = record(preview.requested);
  const requested = operation === 'edit' ? record(request.patch) : record(preview.requestedFields ?? preview.requested);
  if (!Object.keys(requested).length) return false;
  const draft = editor.snapshot.session.draft;
  const read = (path: string) => {
    if (draft.fieldOverrides[path]?.state === 'unknown') return unknownServiceValue;
    const value = valueAt(editor.snapshot, path);
    return record(value).kind === 'none' ? noneServiceValue : value ?? undefined;
  };
  const current = (field: string) => {
    const path = `${targetRoot}/fields/${field}`, shared = `${root}/sharedFields/${field}`;
    const override = draft.fieldOverrides[path];
    if (operation === 'edit' && field === 'comment' && override?.state === 'set' && override.value === '') return '';
    if (override?.state === 'unknown') return unknownServiceValue;
    const local = override?.state === 'none' || override?.state === 'clear' ? noneServiceValue
      : override?.state === 'inherit' ? undefined : read(path);
    if (local === unknownServiceValue) return local;
    let value = local === noneServiceValue ? undefined : local !== undefined && (typeof local !== 'string' || local.trim() !== '') ? local : read(shared);
    if (value === unknownServiceValue) return value;
    if (value === noneServiceValue) value = undefined;
    if (savedTarget && value === '') value = undefined;
    if (field === 'quantity' && operation === 'add' && (value === undefined || value === null || value === '')) {
      const scope = service.quantityRequest.scope;
      if (scope === 'per_target' || scope === 'overall' && service.targets.length === 1)
        value = savedTarget ? read(`${root}/quantityRequest/value`) : service.quantityRequest.value ?? undefined;
    }
    return value;
  };
  const comparable = (value: unknown, decimal: boolean) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') return unknownServiceValue;
    if (!decimal) return value;
    const match = value.trim().match(/^(\d+)(?:\.(\d+))?$/);
    if (!match) return unknownServiceValue;
    const whole = match[1]!.replace(/^0+(?=\d)/, ''), fraction = (match[2] ?? '').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole;
  };
  return serviceFields.every(([field]) => {
    const decimal = !savedTarget && (field === 'quantity' || field === 'unitPrice');
    const actual = comparable(current(field), decimal), expected = comparable(requested[field], decimal);
    return actual !== unknownServiceValue && expected !== unknownServiceValue && actual === expected;
  });
}

function NativeItem({ title, item }: { title: string; item: Record<string, unknown> }) {
  return <div className={styles.card}><strong>{title}</strong><div className={styles.facts}>
    <div className={styles.fact}><strong>Infor total</strong><strong>{text(item.totalCost) || 'Not returned'}{text(item.totalCost) ? ` ${text(item.currency)}` : ''}</strong></div>
    {nativeFields.map(([key, label]) => <div className={styles.fact} key={key}><span>{label}</span>
      <span>{text(item[key]) || 'Not returned'}{(key === 'unitPrice' || key === 'averageDaily') && item[key] ? ` ${text(item.currency)}` : ''}</span></div>)}
  </div></div>;
}

export function AddonsEditor(editor: Editor) {
  const { snapshot, request } = editor;
  const proposal = snapshot.session.draft.proposal.content;
  const owner = proposal.requests.find(row => row.id === request.id);
  const addTargets = owner?.kind === 'create' ? owner.body.allocations.map((room, index) => ({ id: room.id,
    label: [room.guest.firstName, room.guest.lastName].filter(Boolean).join(' ') || `Room ${index + 1}` }))
    : owner && 'targets' in owner.body ? (Array.isArray(record(effectiveAt(snapshot, `${requestPath(request.id)}/body/targets`)).include)
      ? (record(effectiveAt(snapshot, `${requestPath(request.id)}/body/targets`)).include as unknown[]).map((hint, index) => ({
        id: text(record(hint).id), label: text(record(hint).confirmation) || text(record(hint).guestName) || `Stay ${index + 1}` })) : []) : [];
  const services = proposal.services.map((service, index) => ({ service, index })).filter(({ service }) =>
    service.ownerRequestId === request.id || owner?.serviceRefs.includes(service.id)
      || service.targets.some(target => target.target.requestId === request.id));
  return <div className={styles.stack}>
    <Section title="Add-Ons">
      <p className={styles.hint}>Each Add-On is checked and saved for one exact room or saved stay. Infor calculates the total using the unit price, pricing basis and quantity.</p>
      {!services.length && <div className={styles.warning}>No Add-On and room target are selected. Add or link the requested item and room before checking.</div>}
      {owner?.kind === 'services' && <div className={styles.row}><button type="button" disabled={editor.view.busy}
        onClick={() => void editor.commands.changeRows({ kind: 'add_target', requestId: request.id }).catch(() => {})}>Add stay</button></div>}
      <div className={styles.row}>{addTargets.map(target => <button type="button" key={target.id} disabled={editor.view.busy}
        onClick={() => void editor.commands.changeRows({ kind: 'add_service', requestId: request.id, parentId: target.id })}>
        Add item for {target.label}
      </button>)}</div>
      {services.map(({ service, index }) => <div className={styles.stack} key={service.id}>
        {(service.requestedText || service.code) && <strong>{service.requestedText || service.code}</strong>}
        {service.requestedMoney.map(money => <div className={styles.hint} key={money.id}>Requested: {money.amount || 'amount unknown'} {money.currency || ''} {money.unit || ''} · {money.scope.replaceAll('_', ' ')}</div>)}
        {!service.targets.length && <div className={styles.warning}>Choose the specific room for this Add-On. No room will be charged automatically.</div>}
        {service.targets.length > 1 && <div className={styles.warning}>This request covers several rooms. Use “Add item” for each room above and enter each quantity. This request stays here for reference.</div>}
        {service.targets.map((target, targetIndex) => <ServiceRow key={`${service.id}:${targetIndex}`} editor={editor}
          service={service} serviceIndex={index} target={target} targetIndex={targetIndex} multiTarget={service.targets.length > 1} />)}
      </div>)}
    </Section>
    <small className={styles.hint}>Restaurant seating or menu arrangements still need staff action. Removing an Add-On does not establish a refund.</small>
  </div>;
}

type Service = Editor['snapshot']['session']['draft']['proposal']['content']['services'][number];
function ServiceRow({ editor, service, serviceIndex, target, targetIndex, multiTarget }: {
  editor: Editor; service: Service; serviceIndex: number; target: Service['targets'][number]; targetIndex: number; multiTarget: boolean;
}) {
  const draft = editor.snapshot.session.draft;
  const serviceRoot = `/proposal/content/services/${serviceIndex}`, targetRoot = `${serviceRoot}/targets/${targetIndex}`;
  const itemPath = `${serviceRoot}/itemCandidateRef`, ref = target.target;
  const operation = text(valueAt(editor.snapshot, `${serviceRoot}/operation`)) || service.operation;
  const allocationRef = ref.kind === 'allocation' ? ref : null;
  const allocation = allocationRef?.allocationId ?? null;
  const savedTarget: SavedTarget | null = ref.kind === 'saved_target' ? ref : null;
  const argument = allocation || savedTarget;
  const targetBody = savedTarget ? `${requestPath(savedTarget.requestId)}/body` : '';
  const scope = savedTarget ? record(effectiveAt(editor.snapshot, `${targetBody}/targets`)) : {};
  const included = Array.isArray(scope.include) ? scope.include.map(record) : [];
  const hasExclusionList = Array.isArray(scope.exclude);
  const exclusionRows: unknown[] = hasExclusionList ? scope.exclude as unknown[] : [];
  const hintIndex = included.findIndex(hint => hint.id === savedTarget?.hintId);
  const hint = included[hintIndex];
  const stayPath = `${targetBody}/targets/include/${hintIndex}/suggestedRef`;
  const selectedStay = hintIndex >= 0 ? valueAt(editor.snapshot, stayPath) : null;
  const selectedPath = operation === 'add' ? itemPath : `${targetRoot}/savedRowCandidateRef`;
  const room = allocation ? editor.snapshot.session.draft.proposal.content.requests.find(row => row.id === ref.requestId) : null;
  const roomGuest = room && room.kind === 'create' ? room.body.allocations.find(entry => entry.id === allocation)?.guest : null;
  const roomLabel = roomGuest ? [roomGuest.firstName, roomGuest.lastName].filter(Boolean).join(' ') : '';
  const linkedAmend = savedTarget && draft.proposal.content.requests.some(row => row.id === savedTarget.requestId && row.kind === 'amend');
  const createOperations = allocation ? draft.operationResults.filter(result => result.workflow === 'create'
    && result.requestId === ref.requestId && result.allocationId === allocation) : [];
  const createUnknown = createOperations.filter(result => result.status === 'unknown');
  const createSuccesses = createOperations.filter(result => result.status === 'succeeded');
  const createStale = createOperations.some(result => result.status === 'succeeded' && result.generationId !== draft.generationId);
  const createStatus: 'queued' | 'failed' | 'needs_reconcile' | 'succeeded' = createUnknown.length || createStale || createSuccesses.length > 1
    ? 'needs_reconcile' : createSuccesses.length === 1 && createSuccesses[0]!.generationId === draft.generationId ? 'succeeded'
      : createOperations.some(result => result.status === 'failed' && result.generationId === draft.generationId) ? 'failed' : 'queued';
  const linkedCreate = createStatus === 'succeeded';
  const selectedItem = valueAt(editor.snapshot, selectedPath);
  const stayObservation = savedTarget && draft.observations.find(observation => observation.ref === selectedStay
    && observation.kind === 'stay_candidate' && observation.status === 'complete' && observation.coverage.complete
    && observation.generationId === draft.generationId && observation.propertyCode === draft.propertyCode
    && observation.sourceMessageId === draft.source.messageId && observation.criteria.kind === 'saved_target'
    && observation.criteria.requestId === savedTarget.requestId && observation.criteria.hintId === savedTarget.hintId
    && (linkedAmend ? observation.criteria.workflow === 'amend' && observation.criteria.selectionPath === stayPath
      : observation.criteria.workflow === 'services' && observation.criteria.fieldPath === stayPath));
  const stayQuery = record(stayObservation?.criteria.query);
  const queryValue = (value: unknown) => linkedAmend && typeof value === 'string' ? value.trim() || null : value || null;
  const nativeStay = record(record(stayObservation?.result).candidate);
  const exclusionIssue = savedTarget ? excludedScopeIssue(nativeStay, exclusionRows) : null;
  const scopeRequest = savedTarget ? draft.proposal.content.requests.find(row => row.id === savedTarget.requestId) : undefined;
  const canResolveExclusionsHere = scopeRequest?.kind === 'services' && !linkedAmend;
  const scopeLocked = Boolean(savedTarget && draft.operationResults.some(result => result.requestId === savedTarget.requestId &&
    (result.status === 'succeeded' || result.status === 'unknown')));
  const exclusionPath = savedTarget ? `${targetBody}/targets/exclude` : '';
  const selectedExcluded = hasExclusionList && exclusionRows.some(row => record(row).id === savedTarget?.hintId);
  const savedTargetCurrent = Boolean(savedTarget && hint && scope.mode === 'explicit' && hasExclusionList && !selectedExcluded
    && !exclusionIssue && stayObservation && ['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture']
      .every(key => queryValue(stayQuery[key]) === queryValue(hint[key])));
  const catalogueHistory = draft.observations.flatMap(observation => {
    const c = observation.criteria;
    if (observation.kind !== 'service_preview' || observation.status !== 'complete' || record(observation.coverage).complete !== true
      || observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode
      || observation.sourceMessageId !== draft.source.messageId
      || c.workflow !== 'services' || c.kind !== (operation === 'add' ? 'catalogue_candidate' : 'saved_row_candidate') || c.requestId !== ref.requestId
      || c.serviceId !== service.id || c.fieldPath !== selectedPath
      || allocation && c.sourceAllocationId !== allocation
      || savedTarget && (JSON.stringify(c.targetRef) !== JSON.stringify(savedTarget) || c.targetObservationRef !== selectedStay)) return [];
    const candidate = record(record(observation.result).candidate);
    return Object.keys(candidate).length ? [{ observation, candidate }] : [];
  });
  const catalogue = latestCatalogueByIdentity(catalogueHistory, operation);
  const latest = [...draft.observations].reverse().find(observation => observation.kind === 'service_preview'
    && observation.status === 'complete' && observation.coverage.complete && observation.criteria.workflow === 'services'
    && observation.generationId === draft.generationId && observation.propertyCode === draft.propertyCode
    && observation.sourceMessageId === draft.source.messageId
    && observation.criteria.requestId === ref.requestId && observation.criteria.serviceId === service.id
    && ['unsaved_addon_preview', 'saved_addon_preview', 'saved_addon_fresh_prepare'].includes(String(observation.criteria.kind))
    && (allocation ? observation.criteria.allocationId === allocation
      && (observation.criteria.kind === 'unsaved_addon_preview' ? observation.criteria.itemCandidateRef === selectedItem
        : observation.criteria.kind === 'saved_addon_fresh_prepare' && draft.observations.some(parent =>
          parent.ref === observation.criteria.unsavedPreviewRef && parent.criteria.itemCandidateRef === selectedItem))
      : JSON.stringify(observation.criteria.targetRef) === JSON.stringify(ref)
      && observation.criteria.targetObservationRef === selectedStay && observation.criteria.candidateRef === selectedItem));
  const preview = record(latest?.result), native = record(preview.native), before = record(preview.before), after = record(preview.after);
  const selectedCandidateCurrent = catalogue.some(row => row.observation.ref === selectedItem);
  const selectedCandidate = catalogueHistory.find(row => row.observation.ref === selectedItem)?.candidate;
  const controls = [record(native.controls), record(record(after.fields).controls), record(record(selectedCandidate?.fields).controls)];
  const unsavedPreview = latest?.criteria.kind === 'saved_addon_fresh_prepare'
    ? draft.observations.find(row => row.ref === latest.criteria.unsavedPreviewRef) : latest;
  const createPrepared = allocation ? [...draft.operationResults].reverse().find(result => result.workflow === 'create'
    && result.requestId === ref.requestId && result.allocationId === allocation && result.status === 'prepared'
    && result.generationId === draft.generationId) : undefined;
  const createObservation = createPrepared && draft.observations.find(row => createPrepared.observationRefs.includes(row.ref)
    && row.kind === 'rate_availability' && row.status === 'complete' && row.generationId === draft.generationId);
  const createRoot = `${requestPath(ref.requestId)}/body`;
  const createEditedSinceCheck = unsavedPreview && Object.entries(draft.fieldOverrides).some(([path, override]) =>
    (path === createRoot || path.startsWith(`${createRoot}/`)) && Date.parse(override.updatedAt) > Date.parse(unsavedPreview.observedAt));
  const createCurrent = Boolean(allocation && unsavedPreview && createObservation && !createEditedSinceCheck
    && Date.parse(createObservation.observedAt) <= Date.parse(unsavedPreview.observedAt)
    && editor.snapshot.preparationViews.some(view => view.requestId === ref.requestId && view.allocationId === allocation && view.current));
  const amendments = linkedAmend ? draft.operationResults.filter(result => result.workflow === 'amend'
    && result.requestId === ref.requestId && (!result.allocationId || result.allocationId === savedTarget?.hintId)
    && (result.status === 'succeeded' || result.status === 'unknown')) : [];
  const amendmentCurrent = !amendments.some(result => !result.allocationId || result.status === 'unknown')
    && amendments.length <= 1 && (!amendments[0] || Boolean(latest && Date.parse(amendments[0].updatedAt) <= Date.parse(latest.observedAt)));
  const previewCurrent = Boolean(latest && selectedCandidateCurrent && (allocation ? createCurrent : savedTargetCurrent && amendmentCurrent)
    && servicePreviewMatches(editor, service, serviceRoot, targetRoot, operation, preview, Boolean(savedTarget)));
  const capability = record(preview.capability);
  const fresh = latest?.criteria.kind === 'saved_addon_fresh_prepare';
  const previous = record(preview.previouslyApprovedNative);
  const reviewNote = savedTarget && latest ? `services_saved:${savedTarget.requestId}:${savedTarget.hintId}:${service.id}:${latest.ref}` : '';
  const reviewPaths = Array.isArray(latest?.criteria.reviewPaths) ? latest.criteria.reviewPaths.filter((path): path is string => typeof path === 'string') : [];
  const freshNote = fresh && latest ? `services_fresh:${latest.criteria.requestId}:${latest.criteria.allocationId}:${latest.criteria.serviceId}:${latest.ref}` : '';
  const freshReviewed = Boolean(fresh && latest && reviewPaths.length && reviewPaths.every(path => {
    const review = draft.staffReviews[path];
    return review?.status === 'accepted' && review.note === freshNote && review.at != null
      && Date.parse(review.at) > Date.parse(latest.observedAt);
  }));
  const reviewed = fresh ? freshReviewed : !savedTarget || Boolean(latest && reviewPaths.length && reviewPaths.every(path => draft.staffReviews[path]?.status === 'accepted'
    || draft.fieldReviewRequirements[path]?.required === false) && draft.staffReviews[selectedPath]?.status === 'accepted'
    && draft.staffReviews[selectedPath]?.note === reviewNote);
  const serviceResults = draft.operationResults.filter(result => result.workflow === 'services' && result.requestId === ref.requestId
    && (allocation ? result.allocationId === allocation : result.observationRefs.some(refId => draft.observations.some(observation =>
      observation.ref === refId && record(observation.criteria.targetRef).kind === 'saved_target'
      && record(observation.criteria.targetRef).requestId === savedTarget?.requestId && record(observation.criteria.targetRef).hintId === savedTarget?.hintId))));
  const uncertain = serviceResults.some(result => result.status === 'unknown');
  const saved = serviceResults.some(result => result.status === 'succeeded' && Array.isArray(result.observationRefs)
    && result.observationRefs.some(refId => draft.observations.some(observation => observation.ref === refId && observation.criteria.serviceId === service.id)));
  const connected = Boolean(allocation && operation === 'add' || savedTarget && hint);
  return <div className={styles.card}>
    <h3>{operation === 'add' ? 'Add' : operation === 'edit' ? 'Edit' : 'Remove'} · {service.code || service.requestedText || 'item'}</h3>
    <div className={styles.hint}>{allocation ? `Create room${roomLabel ? ` · ${roomLabel}` : ''}` : savedTarget
      ? `Existing saved stay${text(hint?.confirmation) || text(hint?.guestName) ? ` · ${text(hint?.confirmation) || text(hint?.guestName)}` : ''}` : 'Unresolved target'} · one native item</div>
    {savedTarget && <Field editor={editor} path={`${serviceRoot}/operation`} label="Action" compact options={[
      { value: 'add', label: 'Add item' }, { value: 'edit', label: 'Edit saved item' }, { value: 'remove', label: 'Remove saved item' },
    ]} />}
    {savedTarget && hint && <div className={styles.stack}>
      {scope.mode !== 'explicit' && <div className={styles.warning}>This is a group action. Choose one listed stay at a time; other stays will remain unchanged.</div>}
      {hasExclusionList && exclusionRows.length > 0 && <div className={exclusionIssue ? styles.warning : styles.hint}>
        {exclusionIssue === 'overlap' ? 'An excluded stay matches this current Infor reservation. Resolve the exclusion before preparing or saving an Add-On.'
          : exclusionIssue === 'unresolved' ? 'These exclusions are not proven to be different exact stays. Find the current stay; any overlap or ambiguity blocks preparation and Save.'
            : 'Every excluded stay has a distinct exact native identity. Excluded stays remain untouched; this action applies only to the selected included stay.'}
        {scopeLocked && exclusionIssue && <div className={styles.warning}>A prior successful or uncertain operation locks this request scope. Reconcile it before changing exclusions.</div>}
        {linkedAmend && exclusionIssue && <div className={styles.warning}>This Add-On follows an Amend target. Resolve the exclusion in the Amendment action; this Add-On cannot change its scope.</div>}
        {nativeStay && !scopeLocked && exclusionRows.map((value, index) => {
          const issue = excludedScopeIssue(nativeStay, [value]);
          if (!issue || !canResolveExclusionsHere) return null;
          const row = record(value);
          return <div className={styles.card} key={text(row.id) || index}>
            <strong>Unresolved excluded stay</strong>
            <small className={styles.hint}>{text(row.confirmation) || text(row.guestName) || 'Stay not identified'} · {text(row.bookedArrival) || 'arrival unknown'} → {text(row.bookedDeparture) || 'departure unknown'}</small>
            <button type="button" disabled={editor.view.busy} onClick={() => void editor.commands.edit(exclusionPath,
              exclusionRows.filter((_, rowIndex) => rowIndex !== index)).catch(() => {})}>
              Remove this exclusion from every Add-On in this request
            </button>
          </div>;
        })}
      </div>}
      {scope.mode !== 'explicit' && <button type="button" disabled={editor.view.busy}
        onClick={() => void editor.commands.edit(`${targetBody}/targets/mode`, 'explicit').catch(() => {})}>Use the listed stays individually</button>}
      {linkedAmend ? <small className={styles.hint}>Uses the stay selected for this amendment.</small> : <TargetSearch editor={editor} body={targetBody} hint={hint} index={hintIndex} workflow="services" />}
      <div className={styles.row}><button type="button" disabled={editor.view.busy} onClick={() => void (async () => {
        if (scope.mode === 'unresolved') await editor.commands.edit(`${targetBody}/targets/mode`, 'explicit');
        await editor.commands.lookupServices(savedTarget, service.id);
      })().catch(() => {})}>{linkedAmend ? 'Refresh selected stay' : 'Find stay in Infor'}</button></div>
      <small className={styles.hint}>Select one included stay, then find its items and select the exact item or saved row.</small>
    </div>}
    {savedTarget && !hint && <div className={styles.warning}>This item is missing its exact stay target. Link it to an included stay.</div>}
    {allocation && operation !== 'add' && <div className={styles.warning}>Edit and remove apply to a specific saved stay and saved item.</div>}
    {ref.kind === 'quote_group' && <div className={styles.warning}>A quote group is not a saved room. Choose a room before adding this item.</div>}
    {connected && !multiTarget && <>
      <div className={styles.row}><button type="button" disabled={editor.view.busy || !argument || Boolean(savedTarget && !selectedStay)} onClick={() => { if (argument) void editor.commands.lookupServices(argument, service.id).catch(() => {}); }}>Find Infor items</button></div>
      <label className={styles.label}>{operation === 'add' ? 'Infor item' : 'Saved Add-On'}
        <select aria-label={operation === 'add' ? 'Infor item' : 'Saved Add-On'} value={text(selectedItem)} disabled={editor.view.busy || !catalogue.length} onChange={event => {
          const ref = event.target.value;
          if (ref && catalogue.some(row => row.observation.ref === ref)) void editor.commands.selectNative(selectedPath, ref).catch(() => {});
        }}>
          <option value="">{catalogue.length ? 'Select an Infor match' : 'Find items in Infor first'}</option>
          {Boolean(selectedItem) && !selectedCandidateCurrent && <option value={text(selectedItem)} disabled>Previous selection · reselect a current Infor choice</option>}
          {catalogue.map(({ observation, candidate }) => <option key={observation.ref} value={observation.ref}>
            {text(record(candidate.fields).code || candidate.code)} · {text(record(candidate.fields).name || candidate.name)}
            {candidate.nativeId ? ` · row ${text(candidate.nativeId)} · ${text(record(candidate.fields).startDate)} → ${text(record(candidate.fields).endDate)} · ${text(record(candidate.fields).totalCost)} ${text(record(candidate.fields).currency)}` : ''}
          </option>)}
        </select>
      </label>
      {operation !== 'remove' && <div className={styles.grid}>{serviceFields.map(([field, label, type]) => {
        const shared = valueAt(editor.snapshot, `${serviceRoot}/sharedFields/${field}`);
        const isChoice = field === 'frequency' || field === 'pricingControl' || field === 'folio';
        const control = isChoice ? controls.map(source => record(source[field])).find(source => Object.keys(source).length > 0) : undefined;
        const options = control ? nativeOptions(control) : [];
        const savedControl = record(record(record(selectedCandidate?.fields).controls)[field]);
        const displayControl = operation === 'edit' ? savedControl : control;
        const nativeValue = text(displayControl?.value), nativeDisplay = text(displayControl?.display);
        const nativeHint = nativeValue ? `Infor ${operation === 'edit' ? 'current' : 'last check'}: ${nativeValue}${nativeDisplay && nativeDisplay !== nativeValue ? ` · ${nativeDisplay}` : ''}.` : '';
        const choiceHint = isChoice ? control?.editable === false ? 'This field is not editable in Infor.'
          : options.length ? 'Infor choices; check again after changes.' : 'Check the Add-On to load Infor choices.' : '';
        const priceHint = field === 'unitPrice' ? 'Enter source price or an explicit staff price; zero is allowed. Infor calculates the total.' : '';
        const sharedHint = shared != null && text(shared) ? `Shared value: ${text(shared)}; a room value overrides it.` : operation === 'edit' ? 'Leave unmentioned values unchanged.' : '';
        return <Field key={field} editor={editor} path={`${targetRoot}/fields/${field}`} label={label} type={type} review
          options={options.length ? options : undefined} disabled={editor.view.busy || control?.editable === false}
          unmatchedOptionLabel={options.length ? 'Not returned by Infor' : undefined}
          hint={[sharedHint, nativeHint, choiceHint, priceHint].filter(Boolean).join(' ') || undefined} />;
      })}</div>
      }
      <div className={styles.hint}>{operation === 'add' ? 'A nonnegative explicit unit price and positive quantity are required. ' : operation === 'remove' ? 'Removing an item does not establish a refund. ' : ''}Infor returns actual service dates and total.</div>
      <div className={styles.row}><button type="button" disabled={editor.view.busy || !argument || !catalogue.some(row => row.observation.ref === selectedItem)}
        onClick={() => { if (argument) void editor.commands.previewServices(argument, service.id).catch(() => {}); }}>Check Add-On</button></div>
    </>}
    {latest && <div className={styles.stack}>
      {!previewCurrent && <div className={styles.warning}>{allocation && !createCurrent
        ? 'Check the room price in Create, then check this Add-On again before reviewing or saving.'
        : 'The Add-On or its stay changed. Check again before reviewing or saving.'}</div>}
      {Object.keys(previous).length > 0 && <NativeItem title="Previously reviewed" item={previous} />}
      {Object.keys(before).length > 0 && <NativeItem title={previewCurrent ? 'Current saved item' : 'Earlier saved-item check'} item={record(before.fields).code ? record(before.fields) : before} />}
      {Object.keys(after).length > 0 && <NativeItem title={previewCurrent ? 'Proposed item' : 'Earlier proposed item'} item={record(after.fields).code ? record(after.fields) : after} />}
      {preview.operation === 'remove' && <div className={styles.warning}>Requested removal · financial effect is unknown.</div>}
      {Object.keys(native).length > 0 && <NativeItem title={!previewCurrent ? 'Earlier Infor check' : fresh ? 'Latest saved-stay check' : 'Last Infor check'} item={native} />}
      {fresh && <small className={styles.hint}>Review the latest saved-stay details before saving.</small>}
      <small className={styles.hint}>Check again after any change. Infor returns the service dates and calculated total.</small>
      <small className={styles.hint}>Save mode: {text(capability.writeMode) || 'Unavailable'}. {capability.canSave === true ? 'This stay is admitted for Save.' : 'Save is unavailable for this stay or mode.'}</small>
    </div>}
    {allocation && connected && !linkedCreate && <div className={createStatus === 'needs_reconcile' || createStatus === 'failed' ? styles.warning : styles.hint}>
      {createStatus === 'queued' ? 'Save and verify this exact room before linking its Add-On.'
        : createStatus === 'failed' ? 'Create failed. This Add-On remains on the unsaved Create path.'
          : 'Create is stale or uncertain. Reconcile the exact room before linking; do not retry a Save.'}
      {createUnknown.length === 1 && <div className={styles.row}><button type="button" disabled={editor.view.busy}
        onClick={() => void editor.commands.reconcile(createUnknown[0]!.id).catch(() => {})}>Check Create outcome</button></div>}
    </div>}
    {allocationRef && operation === 'add' && linkedCreate && <div className={styles.stack}>
      <div className={styles.hint}>Create has a current success record for this exact room. The link command verifies its durable receipt before creating a separate saved-stay action; the unsaved Create Add-On path remains intact.</div>
      <button type="button" disabled={editor.view.busy || uncertain || saved} onClick={() => void editor.commands.changeRows({
        kind: 'link_created_addon_target', requestId: allocationRef.requestId, allocationId: allocationRef.allocationId, serviceId: service.id,
      }).catch(() => {})}>Continue this Add-On on the saved booking</button>
    </div>}
    {serviceResults.filter(result => result.status === 'unknown').map(result => <div className={styles.warning} key={result.id}>
      <div>{result.summary || 'Save outcome is uncertain. Check the outcome before trying again.'}</div>
      <button type="button" disabled={editor.view.busy} onClick={() => void editor.commands.reconcile(result.id).catch(() => {})}>Check outcome</button>
    </div>)}
    {saved && <div className={styles.hint}>Infor readback confirmed this Add-On.</div>}
    {connected && latest && !saved && !multiTarget && <div className={styles.row}>
      <button type="button" disabled={editor.view.busy || !previewCurrent || Boolean(fresh && !reviewPaths.length)} onClick={() => void (async () => {
        if (!savedTarget) {
          if (fresh) for (const path of reviewPaths) await editor.commands.acceptServiceReview(path, freshNote);
          else await editor.commands.review('services', [service.id]);
          return;
        }
        for (const path of reviewPaths) await editor.commands.acceptServiceReview(path, 'Reviewed the requested Add-On and native result');
        await editor.commands.acceptServiceReview(selectedPath, reviewNote);
      })().catch(() => {})}>{(savedTarget || fresh) && reviewed ? 'Reviewed' : 'Review this item'}</button>
      <button type="button" disabled={editor.view.busy || !previewCurrent || Boolean(allocation && !linkedCreate) || uncertain || !argument || editor.view.preview || capability.canSave !== true || !reviewed}
        onClick={() => { if (argument) void editor.commands.executeServices(argument, service.id, savedTarget || fresh ? latest.ref : undefined).catch(() => {}); }}>Go · save Add-On</button>
    </div>}
  </div>;
}
