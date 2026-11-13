'use client';

import { useEffect, useState } from 'react';
import type { WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { effectiveAt, record, requestPath, text, valueAt } from '@/lib/reservation-workflow/views';
import { sameGuestName } from '../../../../server-pilot/src/ai/guest-name-match.js';
import { Field, Section } from '../shared/stay-fields';
import { isExactConfirmation, latestStayCandidates, StayFacts } from './amend-editor';
import styles from './other-editors.module.css';

export function FilingEditor(editor: WorkbenchEditorProps) {
  const draft = editor.snapshot.session.draft;
  const body = `${requestPath(editor.request.id)}/body`;
  const scope = record(effectiveAt(editor.snapshot, `${body}/targets`));
  const include = Array.isArray(scope.include) ? scope.include.map(record) : [];
  const exclude = Array.isArray(scope.exclude) ? scope.exclude.map(record) : [];
  const owner = draft.proposal.content.requests.find(row => row.id === editor.request.id);
  const requestText = editor.request.text;
  const outgoingInvoice = /\b(?:send|forward|provide|issue|email|e-mail|share)\b[\s\S]{0,160}\binvoices?\b|\binvoices?\b[\s\S]{0,60}\b(?:requested|required)\b/i.test(requestText) &&
    !/\b(?:do not|don't|never)\s+(?:send|forward|provide|issue|email|e-mail|share)\b/i.test(requestText);
  const effectiveRefs = valueAt(editor.snapshot, `${requestPath(editor.request.id)}/documentRefs`);
  const refs = Array.isArray(effectiveRefs) ? effectiveRefs : owner?.documentRefs ?? [];
  const docs = draft.proposal.content.documents.filter(row => refs.includes(row.id) && row.ownerRequestId === editor.request.id);
  const [documentChoice, setDocumentChoice] = useState('');
  const docsKey = docs.map(row => row.id).join('\u001f');
  useEffect(() => {
    if (docs.length === 1) setDocumentChoice(docs[0]!.id);
    else if (!docs.some(row => row.id === documentChoice)) setDocumentChoice('');
  }, [docsKey, documentChoice]);
  const doc = docs.length === 1 ? docs[0] : docs.find(row => row.id === documentChoice);
  const documentRoot = doc ? `/proposal/content/documents/${encodeURIComponent(doc.id)}` : '';
  const effectiveDocument = doc ? record(effectiveAt(editor.snapshot, documentRoot)) : {};
  const effectiveTargetRefs = Array.isArray(effectiveDocument.targetRefs) ? effectiveDocument.targetRefs.map(record) : doc?.targetRefs.map(record) ?? [];
  const hint = include.length === 1 ? { ...include[0] } : undefined;
  if (hint) for (const field of ['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture']) {
    const path = `${body}/targets/include/${encodeURIComponent(text(hint.id))}/${field}`;
    const override = draft.fieldOverrides[path];
    hint[field] = !override || override.state === 'inherit' ? valueAt(editor.snapshot, `${body}/targets/include/0/${field}`)
      : override.state === 'set' ? override.value : null;
  }
  const documentKind = doc ? text(valueAt(editor.snapshot, `/proposal/content/documents/${encodeURIComponent(doc.id)}/kind`)) || doc.kind : '';
  const documentSource = doc ? text(valueAt(editor.snapshot, `/proposal/content/documents/${encodeURIComponent(doc.id)}/documentSourceRef`)) || doc.documentSourceRef : '';
  const bodyAllocation = record(effectiveAt(editor.snapshot, `${body}/allocationTarget`));
  const bodyTargetOverride = draft.fieldOverrides[`${body}/allocationTarget`];
  const documentTargetOverride = doc ? draft.fieldOverrides[`${documentRoot}/targetRefs`] : undefined;
  const allocationRefs = effectiveTargetRefs.flatMap(ref => ref.kind === 'allocation' && typeof ref.requestId === 'string' && typeof ref.allocationId === 'string'
    ? [{ kind: 'allocation' as const, requestId: ref.requestId, allocationId: ref.allocationId }] : []);
  const savedTargetRefs = effectiveTargetRefs.flatMap(ref => ref.kind === 'saved_target' && typeof ref.requestId === 'string' && typeof ref.hintId === 'string'
    ? [{ kind: 'saved_target' as const, requestId: ref.requestId, hintId: ref.hintId }] : []);
  const otherTargetRef = effectiveTargetRefs.some(ref => ref.kind !== 'allocation' && ref.kind !== 'saved_target');
  if (!allocationRefs.length && (!documentTargetOverride || documentTargetOverride.state === 'inherit') &&
      typeof bodyAllocation.requestId === 'string' && typeof bodyAllocation.allocationId === 'string')
    allocationRefs.push({ kind: 'allocation', requestId: bodyAllocation.requestId, allocationId: bodyAllocation.allocationId });
  const allocationOptions = draft.proposal.content.requests.flatMap(request => {
    if (request.kind !== 'create') return [];
    const requestBody = `${requestPath(request.id)}/body`;
    const allocations = valueAt(editor.snapshot, `${requestBody}/allocations`);
    const dateSections = valueAt(editor.snapshot, `${requestBody}/dateSections`);
    if (!Array.isArray(allocations) || !Array.isArray(dateSections)) return [];
    return allocations.flatMap((value, index) => {
      const allocation = record(value), allocationId = text(allocation.id), dateSectionId = text(allocation.dateSectionId);
      const section = dateSections.map(record).find(row => row.id === dateSectionId);
      if (!section || !allocationId) return [];
      const sectionIndex = dateSections.map(record).findIndex(row => row.id === dateSectionId);
      const allocationPath = `${requestBody}/allocations/${index}`, sectionPath = `${requestBody}/dateSections/${sectionIndex}`;
      const guest = [valueAt(editor.snapshot, `${allocationPath}/guest/firstName`), valueAt(editor.snapshot, `${allocationPath}/guest/lastName`)].filter(Boolean).join(' ').trim();
      const room = text(valueAt(editor.snapshot, `${allocationPath}/overrides/roomType`) ?? valueAt(editor.snapshot, `${sectionPath}/defaults/roomType`) ?? valueAt(editor.snapshot, `${requestBody}/shared/roomType`));
      return [{ key: `${request.id}\u001f${allocationId}`, requestId: request.id, allocationId,
        guest, arrival: valueAt(editor.snapshot, `${sectionPath}/arrival`), departure: valueAt(editor.snapshot, `${sectionPath}/departure`), room }];
    });
  });
  const hasAllocationTarget = Boolean(allocationRefs.length);
  const bodyHasRequest = typeof bodyAllocation.requestId === 'string';
  const bodyHasAllocation = typeof bodyAllocation.allocationId === 'string';
  const bodyLinkDisagrees = bodyHasRequest && bodyHasAllocation && (allocationRefs.length !== 1 ||
    allocationRefs[0]!.requestId !== bodyAllocation.requestId || allocationRefs[0]!.allocationId !== bodyAllocation.allocationId);
  const savedTargetDisagrees = savedTargetRefs.length > 1 || savedTargetRefs.some(ref => ref.requestId !== editor.request.id ||
    ![...include, ...exclude].some(row => row.id === ref.hintId));
  const intentionalExistingDestination = Boolean(bodyTargetOverride?.state === 'unknown' && !bodyHasRequest && !bodyHasAllocation &&
    allocationRefs.length === 0 && savedTargetRefs.length === 1 && savedTargetRefs[0]!.requestId === editor.request.id &&
    include.length === 1 && include[0]!.id === savedTargetRefs[0]!.hintId && isExactConfirmation(hint?.confirmation) &&
    ['documentSourceRef', 'kind', 'handling'].every(field => draft.staffReviews[`${documentRoot}/${field}`]?.status === 'accepted'));
  const targetLinkHeld = Boolean((bodyTargetOverride && ['none', 'clear'].includes(bodyTargetOverride.state)) ||
    (bodyTargetOverride?.state === 'unknown' && !intentionalExistingDestination) ||
    (documentTargetOverride && ['none', 'clear', 'unknown'].includes(documentTargetOverride.state)) ||
    bodyHasRequest !== bodyHasAllocation || (bodyTargetOverride?.state === 'set' && !bodyHasRequest) ||
    allocationRefs.length > 1 || bodyLinkDisagrees || savedTargetDisagrees || otherTargetRef);
  const targetBindingMissing = Boolean(doc && scope.mode === 'explicit' && include.length === 1 && savedTargetRefs.length === 0);
  const linkedAllocation = allocationRefs.length === 1 ? allocationRefs[0] : undefined;
  const savedAllocationKey = linkedAllocation ? `${linkedAllocation.requestId}\u001f${linkedAllocation.allocationId}` : '';
  const defaultDestinationKind = hasAllocationTarget || targetLinkHeld ? 'created' : 'existing';
  const [destinationKind, setDestinationKind] = useState<'existing' | 'created'>(defaultDestinationKind);
  useEffect(() => { setDestinationKind(defaultDestinationKind); }, [doc?.id, defaultDestinationKind]);
  const useCreateTarget = destinationKind === 'created';
  const [allocationChoice, setAllocationChoice] = useState('');
  useEffect(() => { setAllocationChoice(savedAllocationKey); }, [doc?.id, savedAllocationKey]);
  const selectedAllocation = allocationOptions.find(option => option.key === (allocationChoice || savedAllocationKey));
  const selectedAllocationKey = selectedAllocation?.key ?? '';
  const createOperations = selectedAllocation ? draft.operationResults.filter(row => row.workflow === 'create'
    && row.requestId === selectedAllocation.requestId && row.allocationId === selectedAllocation.allocationId) : [];
  const createUnknown = createOperations.filter(row => row.status === 'unknown');
  const createSuccesses = createOperations.filter(row => row.status === 'succeeded');
  const createStale = createOperations.some(row => row.status === 'succeeded' && row.generationId !== draft.generationId);
  const createStatus: 'queued' | 'failed' | 'needs_reconcile' | 'succeeded' = createUnknown.length || createStale || createSuccesses.length > 1
    ? 'needs_reconcile' : createSuccesses.length === 1 && createSuccesses[0]!.generationId === draft.generationId ? 'succeeded'
      : createOperations.some(row => row.status === 'failed' && row.generationId === draft.generationId) ? 'failed' : 'queued';
  const [resolvedAttachment, setResolvedAttachment] = useState('');
  const [chosenAttachment, setChosenAttachment] = useState<string | null>(null);
  const attachmentId = chosenAttachment ?? resolvedAttachment;
  useEffect(() => {
    let live = true;
    setResolvedAttachment('');
    if (!documentSource || !globalThis.crypto?.subtle) return () => { live = false; };
    const digest = async (value: string) => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return `src_${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 12)}`;
    };
    void (async () => {
      for (const attachment of editor.source.attachments) {
        const prefix = `${editor.source.messageId}\u001f`;
        if (await digest(`${prefix}attachment_text\u001f${attachment.sourceRef}`) === documentSource) return attachment.sourceRef;
        const vision = await Promise.all(Array.from({ length: 100 }, (_, page) => digest(`${prefix}attachment_vision\u001f${attachment.sourceRef}:${page + 1}`)));
        if (vision.includes(documentSource)) return attachment.sourceRef;
      }
      return '';
    })().then(id => { if (live) setResolvedAttachment(id); }).catch(() => {});
    return () => { live = false; };
  }, [documentSource, editor.source.messageId, editor.source.attachments]);
  const [confirmation, setConfirmation] = useState(text(hint?.confirmation));
  const [kind, setKind] = useState<'voucher' | 'payment_proof' | ''>(documentKind === 'voucher' || documentKind === 'payment_proof' ? documentKind : '');
  const attachments = editor.source.attachments;
  const selectedAttachment = attachments.find(attachment => attachment.sourceRef === attachmentId);
  const pdf = Boolean(selectedAttachment && (selectedAttachment.mimeType?.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(selectedAttachment.name))
    && selectedAttachment.uploadability !== 'unsupported' && (selectedAttachment.size === undefined || selectedAttachment.size <= 10 * 1024 * 1024));
  useEffect(() => { setConfirmation(text(hint?.confirmation)); }, [editor.request.id, hint?.id, hint?.confirmation]);
  useEffect(() => { setKind(documentKind === 'voucher' || documentKind === 'payment_proof' ? documentKind : ''); }, [doc?.id, documentKind]);
  const configuredByStaff = Boolean(doc && ['documentSourceRef', 'kind', 'handling'].every(field =>
    draft.staffReviews[`${documentRoot}/${field}`]?.status === 'accepted'));
  const dirty = (chosenAttachment !== null && chosenAttachment !== resolvedAttachment) ||
    destinationKind !== defaultDestinationKind ||
    (!useCreateTarget && confirmation.trim() !== text(hint?.confirmation)) ||
    (useCreateTarget && Boolean(selectedAllocationKey) && selectedAllocationKey !== savedAllocationKey) ||
    kind !== documentKind || targetBindingMissing || Boolean(doc && !configuredByStaff);
  const localSplitDirty = (chosenAttachment !== null && chosenAttachment !== resolvedAttachment) ||
    destinationKind !== defaultDestinationKind ||
    (!useCreateTarget && confirmation.trim() !== text(hint?.confirmation)) ||
    (useCreateTarget && Boolean(selectedAllocationKey) && selectedAllocationKey !== savedAllocationKey) ||
    (Boolean(kind) && kind !== documentKind);
  const filingLocked = draft.operationResults.some(row => row.workflow === 'filing' && row.requestId === editor.request.id &&
    (row.status === 'succeeded' || row.status === 'unknown'));
  const canSeparate = Boolean(doc && !filingLocked && !localSplitDirty && !editor.view.busy && !editor.view.saving);
  useEffect(() => {
    const key = `filing-selection:${editor.request.id}`;
    editor.commands.setUncommitted(key, dirty);
    return () => editor.commands.setUncommitted(key, false);
  }, [dirty, editor.request.id]);
  const path = hint ? `${body}/targets/include/${encodeURIComponent(text(hint.id))}/suggestedRef` : '';
  const selected = path ? valueAt(editor.snapshot, path) : null;
  const candidates = hint ? latestStayCandidates(draft.observations.flatMap(observation => {
    const c = observation.criteria, result = record(observation.result), stay = record(result.stay);
    const createOperation = createSuccesses.length === 1 ? createSuccesses[0] : undefined;
    const createReceipt = createOperation?.observationRefs.length === 1
      ? draft.observations.find(row => row.ref === createOperation.observationRefs[0]) : undefined;
    const linkedReceiptMatches = Boolean(selectedAllocation && createStatus === 'succeeded' && createOperation && createReceipt &&
      c.createRequestId === selectedAllocation.requestId && c.createAllocationId === selectedAllocation.allocationId &&
      c.createOperationId === createOperation.id && c.createObservationRef === createReceipt.ref &&
      c.createConfirmation === stay.confirmation && c.confirmation === stay.confirmation &&
      createReceipt.kind === 'stay_candidate' && createReceipt.status === 'complete' && createReceipt.coverage.complete &&
      createReceipt.generationId === draft.generationId && createReceipt.propertyCode === draft.propertyCode &&
      createReceipt.sourceMessageId === draft.source.messageId && createReceipt.criteria.workflow === 'create' &&
      createReceipt.criteria.requestId === selectedAllocation.requestId && createReceipt.criteria.allocationId === selectedAllocation.allocationId &&
      createReceipt.criteria.draftRevision === createOperation.draftRevision && record(createReceipt.result).confirmation === stay.confirmation);
    if (observation.kind !== 'stay_candidate' || observation.status !== 'complete' || record(observation.coverage).complete !== true
      || observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode
      || observation.sourceMessageId !== draft.source.messageId || c.workflow !== 'filing' || c.requestId !== editor.request.id
      || c.targetHintId !== hint.id || c.sourceHash !== draft.source.sourceHash || result.outcome !== 'found' || !isExactConfirmation(stay.confirmation)
      || (c.bookedArrival ?? null) !== (hint.bookedArrival || null)
      || (hasAllocationTarget ? !linkedReceiptMatches : c.createRequestId != null || c.confirmation !== hint.confirmation)
      || (hint.confirmation && hint.confirmation !== stay.confirmation)) return [];
    const guestMismatch = Boolean(hint.guestName && !sameGuestName(hint.guestName, `${text(stay.firstName)} ${text(stay.lastName)}`));
    const dateMismatch = Boolean(hint.bookedArrival && hint.bookedArrival !== stay.arrival ||
      hint.bookedDeparture && hint.bookedDeparture !== stay.departure);
    return [{ observation, stay, guestMismatch, dateMismatch }];
  }), selected) : [];
  const selectedStay = candidates.find(candidate => candidate.observation.ref === selected && !candidate.guestMismatch && !candidate.dateMismatch);
  const selectionNeedsReview = !filingLocked && typeof selected === 'string' && !selectedStay;
  useEffect(() => {
    const key = `target-selection:${path}`;
    editor.commands.setUncommitted(key, selectionNeedsReview);
    return () => editor.commands.setUncommitted(key, false);
  }, [path, selectionNeedsReview]);
  const proof = doc && selectedStay ? [...draft.observations].reverse().find(observation => observation.kind === 'document'
    && observation.status === 'complete' && record(observation.coverage).complete === true
    && observation.generationId === draft.generationId && observation.criteria.workflow === 'filing'
    && observation.criteria.requestId === editor.request.id && observation.criteria.documentId === doc.id
    && observation.criteria.targetObservationRef === selectedStay.observation.ref && record(observation.result).outcome === 'ready') : undefined;
  const validConfirmation = useCreateTarget ? Boolean(selectedAllocation && allocationOptions.length)
    : isExactConfirmation(confirmation);
  const canRunLookup = !targetLinkHeld && !targetBindingMissing && (!useCreateTarget || (Boolean(selectedAllocation) && createStatus === 'succeeded'));
  const needsSeparateAction = docs.length > 1 || include.length > 1 || exclude.length > 0 || scope.mode === 'scoped_all';
  const linkedCreateLabel = createStatus === 'queued' ? 'Queued — waiting for this exact Create allocation to save.'
    : createStatus === 'failed' ? 'Create failed — Filing is blocked until the booking is resolved.'
      : createStatus === 'needs_reconcile' ? 'Create outcome needs reconciliation. Do not retry or file against a guessed confirmation.'
        : 'Create receipt recorded. Find stay will verify its returned confirmation in HMS.';
  return <div className={styles.stack}>
    <Section title="PDF and destination">
      {outgoingInvoice && <div className={styles.warning}>This request asks the hotel to send an invoice. Arrange and send the invoice manually. Use Filing only if the customer also asked to file a supplied PDF.</div>}
      <p className={styles.hint}>File one admitted PDF to one exact stay. Additional files or stays need separate filing actions.</p>
      {(include.length > 1 || exclude.length > 0 || scope.mode === 'scoped_all') && <div className={styles.warning}>The source contains a broader or excluded stay scope. Resolve it as a separate one-stay action before filing.</div>}
      {docs.length > 1 && <div className={styles.warning}>This action has multiple PDFs. Choose one PDF and create a separate one-document Filing action before lookup.</div>}
      {scope.mode === 'scoped_all' && include.length === 0 && exclude.length === 0 && <div className={styles.warning}>This Filing has an opaque group scope with no exact stays to split. Lookup and filing remain blocked until one exact stay is identified.</div>}
      {targetLinkHeld && <div className={styles.warning}>The saved document/stay association is unknown or contradictory. Choose the exact destination and apply a deliberate correction before lookup.</div>}
      {targetBindingMissing && <div className={styles.warning}>This PDF has no exact saved-stay reference. Apply the destination to bind this document before lookup.</div>}
      {filingLocked && <div className={styles.warning}>This Filing already succeeded or has an uncertain result. Do not create another action until it is reconciled.</div>}
      {docs.length > 1 && <label className={styles.label}>PDF to separate
        <select value={documentChoice} disabled={editor.view.busy} onChange={event => setDocumentChoice(event.target.value)}>
          <option value="">Choose one saved PDF</option>{docs.map(row => <option key={row.id} value={row.id}>{row.requestedName || row.kind || row.documentSourceRef}</option>)}
        </select>
      </label>}
      {scope.mode === 'scoped_all' && <div className={styles.warning}>Choose a specific included or excluded stay below. A group scope cannot be filed directly.</div>}
      {needsSeparateAction && include.map((row, index) => <div className={styles.card} key={text(row.id)}>
        <strong>Included stay {index + 1}</strong>
        <small className={styles.hint}>{text(row.confirmation) || text(row.guestName) || 'Stay not identified'} · {text(row.bookedArrival) || 'arrival unknown'} → {text(row.bookedDeparture) || 'departure unknown'}</small>
        {doc && <button type="button" disabled={!canSeparate} onClick={() => void editor.commands.changeRows({
          kind: 'separate_filing_target', requestId: editor.request.id, documentId: doc.id, targetHintId: text(row.id), targetDisposition: 'included',
        }).catch(() => {})}>{docs.length > 1 ? 'Create separate Filing for this PDF and stay' : 'Create separate Filing for this included stay'}</button>}
      </div>)}
      {needsSeparateAction && exclude.map(row => <div className={styles.card} key={text(row.id)}>
        <strong>Excluded stay · {text(row.confirmation) || text(row.guestName) || 'Unidentified stay'}</strong>
        <small className={styles.hint}>{text(row.bookedArrival) || 'arrival unknown'} → {text(row.bookedDeparture) || 'departure unknown'}</small>
        {doc && <button type="button" disabled={!canSeparate} onClick={() => void editor.commands.changeRows({
          kind: 'separate_filing_target', requestId: editor.request.id, documentId: doc.id, targetHintId: text(row.id), targetDisposition: 'excluded',
        }).catch(() => {})}>{docs.length > 1 ? 'Create separate Filing for this PDF and stay' : 'Create separate Filing for this excluded stay'}</button>}
      </div>)}
      <label className={styles.label}>Attachment from this email
        <select value={attachmentId} disabled={editor.view.busy} onChange={event => setChosenAttachment(event.target.value)}>
          <option value="">Choose attachment</option>
          {attachments.map(attachment => <option key={attachment.sourceRef} value={attachment.sourceRef}>{attachment.name}</option>)}
        </select>
      </label>
      {selectedAttachment && <div className={styles.hint}>{selectedAttachment.name} · {selectedAttachment.size === undefined ? 'Size unknown' : `${(selectedAttachment.size / 1024 / 1024).toFixed(2)} MB`} · {
        selectedAttachment.uploadability === 'ready' ? 'Source available; Infor check still required' : selectedAttachment.uploadability === 'checking' ? 'Checking source bytes' : selectedAttachment.uploadability === 'unknown' ? 'Source bytes not yet verified' : 'Unsupported source'}</div>}
      {selectedAttachment && !pdf && <div className={styles.warning}>Choose a PDF no larger than 10 MB. Images and conversion are not supported.</div>}
      {!attachments.length && <div className={styles.warning}>No attachment is available in this email. A promised voucher or payment proof cannot be filed until its bytes are available.</div>}
      <div className={styles.grid}>
        <label className={styles.label}>Destination type
          <select value={destinationKind} disabled={editor.view.busy} onChange={event => {
            setDestinationKind(event.target.value === 'created' ? 'created' : 'existing');
          }}>
            <option value="existing">Existing Infor reservation</option><option value="created">Create allocation from this email</option>
          </select>
        </label>
        {useCreateTarget && allocationOptions.length ? <label className={styles.label}>Exact Create allocation
          <select value={selectedAllocationKey} disabled={editor.view.busy}
            onChange={event => setAllocationChoice(event.target.value)}>
            <option value="">Choose exact Create allocation</option>
            {allocationOptions.map(option => <option key={option.key} value={option.key}>
              {[option.guest || 'Guest not identified', text(option.arrival) || 'Arrival unknown', text(option.departure) || 'Departure unknown', option.room,
                `Create ${option.requestId} · allocation ${option.allocationId}`].filter(Boolean).join(' · ')}
            </option>)}
          </select>
        </label> : useCreateTarget ? <div className={styles.warning}>No exact Create allocation is available in this email. Choose an existing reservation or add a valid Create action first.</div>
          : <label className={styles.label}>Existing Infor confirmation
          <input value={confirmation} disabled={editor.view.busy} onChange={event => setConfirmation(event.target.value)} placeholder="12345678-1" />
        </label>}
        <label className={styles.label}>Document kind
          <select value={kind} disabled={editor.view.busy} onChange={event => setKind(event.target.value === 'voucher' || event.target.value === 'payment_proof' ? event.target.value : '')}>
            <option value="">Choose kind</option><option value="voucher">Voucher</option><option value="payment_proof">Payment proof</option>
          </select>
        </label>
      </div>
      {doc && <div className={styles.grid}>
        <Field label="Document name" path={`${documentRoot}/requestedName`} editor={editor} maxLength={150} emptyState="none" review
          hint="Optional PDF name in Infor. Leave blank to use the attachment name." />
        <Field label="Description" path={`${documentRoot}/requestedDescription`} editor={editor} maxLength={200} emptyState="none" review
          hint="Optional description in Infor. Leave blank to use the default." />
        {(['requestedName', 'requestedDescription'] as const).map(field => {
          const path = `${documentRoot}/${field}`, value = valueAt(editor.snapshot, path);
          if (typeof value !== 'string' || !value.trim() || draft.staffReviews[path]?.status === 'accepted') return null;
          const label = field === 'requestedName' ? 'document name' : 'description';
          return <button type="button" key={field} disabled={editor.view.busy} onClick={() => void editor.commands.acceptServiceReview(
            path, `Reviewed ${label}`, { path, value, generationId: draft.generationId }).catch(() => {})}>Confirm {label}</button>;
        })}
      </div>}
      {useCreateTarget && selectedAllocation && <div className={createStatus === 'needs_reconcile' || createStatus === 'failed' ? styles.warning : styles.hint}>
        {linkedCreateLabel} The confirmation is supplied only from the verified Create receipt; it is not entered or guessed here.
        {createUnknown.length === 1 && <div className={styles.row}><button type="button" disabled={editor.view.busy}
          onClick={() => void editor.commands.reconcile(createUnknown[0]!.id)}>Reconcile Create</button></div>}
      </div>}
      {hint && doc && !useCreateTarget && <div className={styles.grid}>
        <Field label="Guest name" path={`${body}/targets/include/${encodeURIComponent(text(hint.id))}/guestName`} editor={editor} resolvedValue={hint.guestName ?? null} disabled={dirty || editor.view.busy} />
        <Field label="Original Arrival Date" path={`${body}/targets/include/${encodeURIComponent(text(hint.id))}/bookedArrival`} type="date" editor={editor} resolvedValue={hint.bookedArrival ?? null} disabled={dirty || editor.view.busy} />
        <Field label="Original Departure Date" path={`${body}/targets/include/${encodeURIComponent(text(hint.id))}/bookedDeparture`} type="date" editor={editor} resolvedValue={hint.bookedDeparture ?? null} disabled={dirty || editor.view.busy} />
      </div>}
      {dirty && <div className={styles.warning}>New selection is not saved. Check and Go use the saved selection until you apply this selection.</div>}
      <div className={styles.row}><button type="button" disabled={editor.view.busy || !dirty || !pdf || !validConfirmation || !kind || docs.length > 1 || include.length > 1 || exclude.length > 0 || scope.mode === 'scoped_all'}
        onClick={() => {
          if (!kind || useCreateTarget && !selectedAllocation) return;
          const target = useCreateTarget && selectedAllocation ? { allocationTarget: { requestId: selectedAllocation.requestId,
            allocationId: selectedAllocation.allocationId } } : { confirmation: confirmation.trim() };
          void editor.commands.configureFiling(attachmentId, target, kind);
        }}>Apply PDF and destination</button>
        <button type="button" disabled={editor.view.busy || dirty || docs.length !== 1 || !hint || !doc || exclude.length > 0 || !canRunLookup}
          onClick={() => void editor.commands.lookup()}>{useCreateTarget ? 'Find created stay and check PDF' : 'Find stay and check PDF'}</button></div>
      {doc && <small className={styles.hint}>Saved selection: {attachments.find(attachment => attachment.sourceRef === resolvedAttachment)?.name || 'Source attachment unavailable'} · {documentKind === 'payment_proof' ? 'Payment proof' : documentKind === 'voucher' ? 'Voucher' : documentKind} · {useCreateTarget ? selectedAllocation ? 'Create-linked target; actual confirmation verified on lookup' : 'Choose an exact Create allocation' : text(hint?.confirmation) || 'Destination missing'}</small>}
    </Section>
    <Section title="Exact destination and source bytes">
      {candidates.map(({ observation, stay, guestMismatch, dateMismatch }) => <div className={styles.card} key={observation.ref}>
        <StayFacts stay={stay} />
        {guestMismatch && <div className={styles.warning}>The guest name differs from the source. Update the guest name and find the stay again before filing.</div>}
        {dateMismatch && <div className={styles.warning}>The stay dates differ from the source. Update the dates and find the stay again before filing.</div>}
        <div className={styles.row}><button type="button" disabled={editor.view.busy || dirty || guestMismatch || dateMismatch}
          onClick={() => void editor.commands.selectNative(path, observation.ref)}>{selected === observation.ref ? 'Selected stay' : 'Select this stay'}</button></div>
      </div>)}
      {selectionNeedsReview && <div className={styles.warning}>The selected stay needs review. Find and select the current Infor record before continuing.</div>}
      {!selectedStay && <span className={styles.hint}>Find and select the exact stay, then check the PDF again.</span>}
      {selectedStay && !proof && <div className={styles.warning}>PDF bytes have not been verified for this stay. Find the stay and check the PDF again.</div>}
      {proof && <div className={styles.hint}>Infor lookup verified the source PDF for this selected stay. Check before filing.</div>}
    </Section>
    <small className={styles.hint}>Filing payment proof does not confirm payment or settlement.</small>
  </div>;
}
