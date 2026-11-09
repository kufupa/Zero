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
      <p className={styles.hint}>Each Add-On is checked and saved for one exact room. Infor calculates the total from its pricing basis; the quantity does not multiply occupants again.</p>
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
  const allocation = ref.kind === 'allocation' ? ref.allocationId : null;
  const savedTarget: SavedTarget | null = ref.kind === 'saved_target' ? ref : null;
  const argument = allocation || savedTarget;
  const targetBody = savedTarget ? `${requestPath(savedTarget.requestId)}/body` : '';
  const scope = savedTarget ? record(effectiveAt(editor.snapshot, `${targetBody}/targets`)) : {};
  const included = Array.isArray(scope.include) ? scope.include.map(record) : [];
  const hintIndex = included.findIndex(hint => hint.id === savedTarget?.hintId);
  const hint = included[hintIndex];
  const stayPath = `${targetBody}/targets/include/${hintIndex}/suggestedRef`;
  const selectedStay = hintIndex >= 0 ? valueAt(editor.snapshot, stayPath) : null;
  const selectedPath = operation === 'add' ? itemPath : `${targetRoot}/savedRowCandidateRef`;
  const room = allocation ? editor.snapshot.session.draft.proposal.content.requests.find(row => row.id === ref.requestId) : null;
  const roomGuest = room && room.kind === 'create' ? room.body.allocations.find(entry => entry.id === allocation)?.guest : null;
  const roomLabel = roomGuest ? [roomGuest.firstName, roomGuest.lastName].filter(Boolean).join(' ') : '';
  const linkedAmend = savedTarget && draft.proposal.content.requests.some(row => row.id === savedTarget.requestId && row.kind === 'amend');
  const linkedCreate = ref.kind === 'allocation' && editor.snapshot.operationResults.some(result => result.workflow === 'create'
    && result.requestId === ref.requestId && result.allocationId === ref.allocationId && result.status === 'succeeded');
  const selectedItem = valueAt(editor.snapshot, selectedPath);
  const catalogue = draft.observations.flatMap(observation => {
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
  const latest = [...draft.observations].reverse().find(observation => observation.kind === 'service_preview'
    && observation.status === 'complete' && observation.criteria.workflow === 'services'
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
      {scope.mode === 'scoped_all' || Array.isArray(scope.exclude) && scope.exclude.length > 0
        ? <div className={styles.warning}>Choose individual included stays without exclusions before checking an Add-On.</div> : null}
      {scope.mode === 'scoped_all' && !(Array.isArray(scope.exclude) && scope.exclude.length) && <button type="button" disabled={editor.view.busy}
        onClick={() => void editor.commands.edit(`${targetBody}/targets/mode`, 'explicit').catch(() => {})}>Use the individual included stays</button>}
      {linkedAmend ? <small className={styles.hint}>Uses the stay selected for this amendment.</small> : <TargetSearch editor={editor} body={targetBody} hint={hint} index={hintIndex} workflow="services" />}
      <div className={styles.row}><button type="button" disabled={editor.view.busy} onClick={() => void (async () => {
        if (scope.mode === 'unresolved') await editor.commands.edit(`${targetBody}/targets/mode`, 'explicit');
        await editor.commands.lookupServices(savedTarget, service.id);
      })().catch(() => {})}>{linkedAmend ? 'Refresh selected stay' : 'Find stay in Infor'}</button></div>
      <small className={styles.hint}>Select the stay, then find its items and select the exact item or saved row.</small>
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
          {Boolean(selectedItem) && !catalogue.some(row => row.observation.ref === selectedItem) && <option value={text(selectedItem)}>Previous selection needs refresh</option>}
          {catalogue.map(({ observation, candidate }) => <option key={observation.ref} value={observation.ref}>
            {text(record(candidate.fields).code || candidate.code)} · {text(record(candidate.fields).name || candidate.name)}
            {candidate.nativeId ? ` · row ${text(candidate.nativeId)} · ${text(record(candidate.fields).startDate)} → ${text(record(candidate.fields).endDate)} · ${text(record(candidate.fields).totalCost)} ${text(record(candidate.fields).currency)}` : ''}
          </option>)}
        </select>
      </label>
      {operation !== 'remove' && <div className={styles.grid}>{serviceFields.map(([field, label, type]) => {
        const shared = valueAt(editor.snapshot, `${serviceRoot}/sharedFields/${field}`);
        return <Field key={field} editor={editor} path={`${targetRoot}/fields/${field}`} label={label} type={type} review
          hint={shared != null && text(shared) ? `Shared value: ${text(shared)}; a room value overrides it.` : operation === 'edit' ? 'Leave unmentioned values unchanged.' : undefined} />;
      })}</div>
      }
      <div className={styles.hint}>{operation === 'add' ? 'A positive explicit unit price and quantity are required. Unknown or zero price is unpriced. ' : operation === 'remove' ? 'Removing an item does not establish a refund. ' : ''}Infor returns actual service dates and total.</div>
      <div className={styles.row}><button type="button" disabled={editor.view.busy || !argument || !catalogue.some(row => row.observation.ref === selectedItem)}
        onClick={() => { if (argument) void editor.commands.previewServices(argument, service.id).catch(() => {}); }}>Check Add-On</button></div>
    </>}
    {latest && <div className={styles.stack}>
      {Object.keys(previous).length > 0 && <NativeItem title="Previously reviewed" item={previous} />}
      {Object.keys(before).length > 0 && <NativeItem title="Current saved item" item={record(before.fields).code ? record(before.fields) : before} />}
      {Object.keys(after).length > 0 && <NativeItem title="Proposed item" item={record(after.fields).code ? record(after.fields) : after} />}
      {preview.operation === 'remove' && <div className={styles.warning}>Requested removal · financial effect is unknown.</div>}
      {Object.keys(native).length > 0 && <NativeItem title={fresh ? 'Latest saved-stay check' : 'Last Infor check'} item={native} />}
      {fresh && <small className={styles.hint}>Review the latest saved-stay details before saving.</small>}
      <small className={styles.hint}>Check again after any change. Infor is the source of dates, pricing basis and total.</small>
      <small className={styles.hint}>Save mode: {text(capability.writeMode) || 'Unavailable'}. {capability.canSave === true ? 'This stay is admitted for Save.' : 'Save is unavailable for this stay or mode.'}</small>
    </div>}
    {allocation && connected && !linkedCreate && <div className={styles.hint}>Save and verify this room before adding its service.</div>}
    {serviceResults.filter(result => result.status === 'unknown').map(result => <div className={styles.warning} key={result.id}>
      <div>{result.summary || 'Save outcome is uncertain. Check the outcome before trying again.'}</div>
      <button type="button" disabled={editor.view.busy} onClick={() => void editor.commands.reconcile(result.id).catch(() => {})}>Check outcome</button>
    </div>)}
    {saved && <div className={styles.hint}>Infor readback confirmed this Add-On.</div>}
    {connected && latest && !saved && !multiTarget && <div className={styles.row}>
      <button type="button" disabled={editor.view.busy || Boolean(fresh && !reviewPaths.length)} onClick={() => void (async () => {
        if (!savedTarget) {
          if (fresh) for (const path of reviewPaths) await editor.commands.acceptServiceReview(path, freshNote);
          else await editor.commands.review('services', [service.id]);
          return;
        }
        for (const path of reviewPaths) await editor.commands.acceptServiceReview(path, 'Reviewed the requested Add-On and native result');
        await editor.commands.acceptServiceReview(selectedPath, reviewNote);
      })().catch(() => {})}>{(savedTarget || fresh) && reviewed ? 'Reviewed' : 'Review this item'}</button>
      <button type="button" disabled={editor.view.busy || Boolean(allocation && !linkedCreate) || uncertain || !argument || editor.view.preview || capability.canSave !== true || !reviewed}
        onClick={() => { if (argument) void editor.commands.executeServices(argument, service.id, savedTarget || fresh ? latest.ref : undefined).catch(() => {}); }}>Go · save Add-On</button>
    </div>}
  </div>;
}
