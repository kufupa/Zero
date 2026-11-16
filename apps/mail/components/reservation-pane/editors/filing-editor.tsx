'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { effectiveAt, record, requestPath, text, valueAt } from '@/lib/reservation-workflow/views';
import { Field, Section } from '../shared/stay-fields';
import { isExactConfirmation } from './amend-editor';
import {
  AMEND_FIND_COPY,
  amendFindClientFromTrpc,
  formatStayDate,
  hmsJobTransport,
  pendingJobView,
  pollHmsJob,
  searchRequestFor,
  searchRunFromJob,
  type GuestSearchRow,
  type HmsJobView,
} from '@/lib/quote-workflow/amend-find';
import { trpcClient } from '@/providers/query-provider';
import styles from './other-editors.module.css';

/** A filename that clearly names one document family fills the category; ambiguous or silent names leave the choice to staff. */
export function inferFilingDocumentKind(name: string): 'voucher' | 'payment_proof' | null {
  const lower = ` ${name.toLowerCase().replace(/[\s_-]+/g, ' ')} `;
  const voucher = /\bvouchers?\b/.test(lower);
  const proof = /\bproof of payment\b|\bpayment (?:proof|receipt|confirmation|advice)\b|\bremittance(?: advice| receipt)?\b|\bdeposit receipt\b|\bp o p\b|\bpop\b(?!\s*ups?\b)/.test(lower);
  return voucher && !proof ? 'voucher' : proof && !voucher ? 'payment_proof' : null;
}

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
  const [filing, setFiling] = useState(false);
  const [filingError, setFilingError] = useState('');
  const [rejectedPreparation, setRejectedPreparation] = useState<string | null>(null);
  const filingInFlight = useRef(false);
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
  const [searchForm, setSearchForm] = useState({ lastName: '', arrival: '', departure: '' });
  const [searchRun, setSearchRun] = useState<{ key: string; view: HmsJobView | null; queueFailed: boolean; queueMessage: string | null } | null>(null);
  const [pickedRow, setPickedRow] = useState<GuestSearchRow | null>(null);
  const searchGeneration = useRef(0);
  const jobClient = useMemo(() => amendFindClientFromTrpc(trpcClient, editor.source.mailboxId), [editor.source.mailboxId]);
  const searchTransport = useMemo(() => hmsJobTransport(jobClient, editor.source.threadId, editor.source.messageId,
    { exactSource: true, sourceHash: editor.source.sourceHash,
      ...(editor.source.propertySwitch ? { propertySwitch: editor.source.propertySwitch } : {}) }),
    [jobClient, editor.source.threadId, editor.source.messageId, editor.source.sourceHash, editor.source.propertySwitch]);
  useEffect(() => () => { searchGeneration.current += 1; }, []);
  const searchResult = searchRun ? searchRunFromJob(searchRun.view, searchRun.queueFailed, searchRun.queueMessage) : null;
  const searchRows = searchResult?.kind === 'rows' ? searchResult.rows : [];
  const searching = Boolean(searchRun && !searchRun.queueFailed && searchRun.view &&
    ['queued', 'running', 'retrying'].includes(searchRun.view.status));
  const updateSearchForm = (field: 'lastName' | 'arrival' | 'departure', value: string) => {
    searchGeneration.current += 1;
    setSearchRun(null);
    if (pickedRow && confirmation.trim() === pickedRow.confirmation) setConfirmation(text(hint?.confirmation));
    setPickedRow(null);
    setSearchForm(form => ({ ...form, [field]: value }));
  };
  const runGuestSearch = () => {
    if (!searchTransport) return;
    const built = searchRequestFor({ lastName: searchForm.lastName, arrival: searchForm.arrival || null,
      departure: searchForm.departure || null });
    if ('error' in built) { setSearchRun({ key: 'invalid', view: null, queueFailed: true, queueMessage: built.error }); return; }
    const request = built.request, key = JSON.stringify(request), generation = ++searchGeneration.current;
    setPickedRow(null);
    setSearchRun({ key, view: pendingJobView('', request), queueFailed: false, queueMessage: null });
    void searchTransport.queue(request).then(start => {
      if (generation !== searchGeneration.current) return;
      if (start.runId) {
        setSearchRun(current => current?.key === key && start.runId ? { ...current, view: pendingJobView(start.runId, request) } : current);
        void pollHmsJob(searchTransport, start.runId, { live: () => generation === searchGeneration.current,
          onView: view => { if (generation === searchGeneration.current) setSearchRun(current => current?.key === key ? { ...current, view } : current); } });
      } else {
        setSearchRun(current => current?.key === key ? { ...current, view: start.view ?? null,
          queueFailed: !start.view, queueMessage: start.view ? null : AMEND_FIND_COPY.searchFailed } : current);
      }
    }).catch(() => { if (generation === searchGeneration.current)
      setSearchRun(current => current?.key === key ? { ...current, queueFailed: true, queueMessage: null } : current); });
  };
  const configuredByStaff = Boolean(doc && effectiveDocument.handling === 'filing_requested' && ['documentSourceRef', 'kind', 'handling'].every(field =>
    draft.staffReviews[`${documentRoot}/${field}`]?.status === 'accepted'));
  const pickedTarget = !useCreateTarget && pickedRow && pickedRow.confirmation === confirmation.trim() ? pickedRow : null;
  const pickedGuest = pickedTarget ? [pickedTarget.firstName, pickedTarget.lastName].filter(Boolean).join(' ').trim() : '';
  const pickedArrival = pickedTarget?.arrival || (pickedTarget ? searchForm.arrival : '');
  const pickedDeparture = pickedTarget?.departure || (confirmation.trim() === text(hint?.confirmation) ? text(hint?.bookedDeparture) : '');
  useEffect(() => {
    if (pickedTarget && confirmation.trim() === text(hint?.confirmation) &&
        (!pickedGuest || pickedGuest === text(hint?.guestName)) &&
        (!pickedArrival || pickedArrival === text(hint?.bookedArrival)) &&
        (!pickedDeparture || pickedDeparture === text(hint?.bookedDeparture)))
      setPickedRow(current => current === pickedTarget ? null : current);
  }, [pickedTarget, confirmation, hint?.confirmation, hint?.guestName, hint?.bookedArrival, hint?.bookedDeparture,
    pickedGuest, pickedArrival, pickedDeparture]);
  const pickedHintsDirty = Boolean(pickedTarget && (pickedGuest !== text(hint?.guestName) ||
    pickedArrival !== text(hint?.bookedArrival) || pickedDeparture !== text(hint?.bookedDeparture)));
  const dirty = (chosenAttachment !== null && chosenAttachment !== resolvedAttachment) ||
    destinationKind !== defaultDestinationKind ||
    (!useCreateTarget && confirmation.trim() !== text(hint?.confirmation)) ||
    pickedHintsDirty ||
    (useCreateTarget && Boolean(selectedAllocationKey) && selectedAllocationKey !== savedAllocationKey) ||
    kind !== documentKind || targetBindingMissing || Boolean(doc && !configuredByStaff);
  const localSplitDirty = (chosenAttachment !== null && chosenAttachment !== resolvedAttachment) ||
    destinationKind !== defaultDestinationKind ||
    (!useCreateTarget && confirmation.trim() !== text(hint?.confirmation)) ||
    pickedHintsDirty ||
    (useCreateTarget && Boolean(selectedAllocationKey) && selectedAllocationKey !== savedAllocationKey) ||
    (Boolean(kind) && kind !== documentKind);
  const filingLocked = draft.operationResults.some(row => row.workflow === 'filing' && row.requestId === editor.request.id &&
    (row.status === 'succeeded' || row.status === 'unknown'));
  const canSeparate = Boolean(doc && !filingLocked && !localSplitDirty && !editor.view.busy && !editor.view.saving);
  useEffect(() => {
    const key = `filing-selection:${editor.request.id}`;
    editor.commands.setUncommitted(key, dirty && !filingLocked);
    return () => editor.commands.setUncommitted(key, false);
  }, [dirty, filingLocked, editor.request.id]);
  const validConfirmation = useCreateTarget ? Boolean(selectedAllocation && allocationOptions.length)
    : isExactConfirmation(confirmation);
  const needsSeparateAction = docs.length > 1 || include.length > 1 || exclude.length > 0 || scope.mode === 'scoped_all';
  const linkedCreateLabel = createStatus === 'queued' ? 'Queued — waiting for this exact Create allocation to save.'
    : createStatus === 'failed' ? 'Create failed — Filing is blocked until the booking is resolved.'
      : createStatus === 'needs_reconcile' ? 'Create outcome needs reconciliation. Do not retry or file against a guessed confirmation.'
        : 'Create receipt recorded. Infor will verify its returned confirmation before filing.';
  const receipt = editor.snapshot.session.workflowPreparations?.find(row => row.endpoint === 'execute' && row.requestId === editor.request.id &&
    row.expectedRevision === editor.snapshot.session.revision && row.generationId === draft.generationId);
  const preparedOperation = [...draft.operationResults].reverse().find(row => row.workflow === 'filing' && row.requestId === editor.request.id &&
    row.generationId === draft.generationId && row.status === 'prepared');
  const prepared = doc && hint && [...draft.observations].reverse().find(row => preparedOperation?.observationRefs.includes(row.ref) &&
    row.kind === 'document' && row.status === 'complete' && row.coverage.complete && row.generationId === draft.generationId &&
    row.propertyCode === draft.propertyCode && row.sourceMessageId === draft.source.messageId && row.criteria.workflow === 'filing' &&
    row.criteria.requestId === editor.request.id && row.criteria.documentId === doc.id &&
    row.criteria.targetObservationRef === valueAt(editor.snapshot, `${body}/targets/include/${encodeURIComponent(text(hint.id))}/suggestedRef`) &&
    record(row.result).outcome === 'prepared');
  const preparedResult = record(prepared?.result), preparedTarget = record(preparedResult.target);
  const preparedCurrent = Boolean(receipt && receipt.preparedRef !== rejectedPreparation && prepared && !dirty && !editor.view.saving && !editor.view.blocked &&
    text(preparedTarget.confirmation) && text(preparedTarget.firstName) && text(preparedTarget.lastName) &&
    text(preparedTarget.arrival) && text(preparedTarget.departure) && text(preparedResult.documentName));
  const safeFailure = (failure: unknown) => {
    const message = failure instanceof Error ? failure.message : '';
    return ['The filing outcome could not be confirmed. Check Infor before trying again.',
      'The email or filing details changed. Review them before filing again.',
      'The checked filing changed. Check the details again before filing.',
      'The filing details changed. Check the stay and document again.',
      'Finish editing and check the details before filing.', 'Finish editing the details before filing.',
      'Check the earlier filing outcome before trying again.', 'Separate the documents and stays before filing.',
      'Choose one document before filing.', 'Choose one stay before filing.',
      'Infor did not verify the selected stay. Check the guest and dates before filing.',
      'The selected stay could not be confirmed.', 'Infor could not verify this PDF for the selected stay.',
      'Infor could not check these details. Review them and try again.'].includes(message)
      ? message : 'Infor could not complete this step. Check the details and try again.';
  };
  const check = async () => {
    if (filingInFlight.current || !kind || !validConfirmation || !pdf || useCreateTarget && (!selectedAllocation || createStatus !== 'succeeded')) return;
    filingInFlight.current = true;
    setFiling(true);
    setFilingError('');
    const picked = !useCreateTarget && pickedRow && pickedRow.confirmation === confirmation.trim() ? pickedRow : null;
    const guest = picked ? [picked.firstName, picked.lastName].filter(Boolean).join(' ').trim() : confirmation.trim() === text(hint?.confirmation) ? text(hint?.guestName) : '';
    const arrival = picked?.arrival || (picked ? searchForm.arrival : confirmation.trim() === text(hint?.confirmation) ? text(hint?.bookedArrival) : '');
    const departure = picked ? text(picked.departure) : confirmation.trim() === text(hint?.confirmation) ? text(hint?.bookedDeparture) : '';
    if (!useCreateTarget && departure && !arrival) {
      setFilingError('Add the original arrival date before checking this stay.');
      filingInFlight.current = false;
      setFiling(false);
      return;
    }
    const target = useCreateTarget && selectedAllocation ? { allocationTarget: { requestId: selectedAllocation.requestId, allocationId: selectedAllocation.allocationId } }
      : { confirmation: confirmation.trim(), ...(guest ? { guestName: guest } : {}),
        ...(arrival ? { bookedArrival: arrival, ...(departure ? { bookedDeparture: departure } : {}) } : {}) };
    try { await editor.commands.prepareFiling(attachmentId, target, kind); setRejectedPreparation(null); }
    catch (failure) { setFilingError(safeFailure(failure)); }
    finally { filingInFlight.current = false; setFiling(false); }
  };
  const file = async () => {
    if (filingInFlight.current || !preparedCurrent || !receipt || !prepared) return;
    filingInFlight.current = true;
    setFiling(true);
    setFilingError('');
    try { await editor.commands.fileFiling(receipt.preparedRef, prepared.ref); }
    catch (failure) {
      if (failure instanceof Error && failure.message === 'The filing details changed. Check the stay and document again.')
        setRejectedPreparation(receipt.preparedRef);
      setFilingError(safeFailure(failure));
    }
    finally { filingInFlight.current = false; setFiling(false); }
  };
  return <fieldset className={styles.stack} disabled={filing} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
    <Section title="Stay">
      {outgoingInvoice && <div className={styles.warning}>This request asks the hotel to send an invoice. Arrange and send the invoice manually. Use Filing only if the customer also asked to file a supplied PDF.</div>}
      <p className={styles.hint}>File one PDF to one stay. Additional files or stays need separate filing actions.</p>
      {(include.length > 1 || exclude.length > 0 || scope.mode === 'scoped_all') && <div className={styles.warning}>The source contains a broader or excluded stay scope. Resolve it as a separate one-stay action before filing.</div>}
      {docs.length > 1 && <div className={styles.warning}>This action has multiple PDFs. Choose one PDF and create a separate one-document Filing action before lookup.</div>}
      {scope.mode === 'scoped_all' && include.length === 0 && exclude.length === 0 && <div className={styles.warning}>This Filing has an opaque group scope with no exact stays to split. Lookup and filing remain blocked until one exact stay is identified.</div>}
      {targetLinkHeld && <div className={styles.warning}>Choose the stay and document to correct the saved selection.</div>}
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
      <div className={styles.grid}>
        <label className={styles.label}>Destination type
          <select value={destinationKind} disabled={editor.view.busy || filingLocked} onChange={event => {
            setDestinationKind(event.target.value === 'created' ? 'created' : 'existing');
          }}>
            <option value="existing">Existing Infor reservation</option><option value="created">Create allocation from this email</option>
          </select>
        </label>
        {useCreateTarget && allocationOptions.length ? <label className={styles.label}>Exact Create allocation
          <select value={selectedAllocationKey} disabled={editor.view.busy || filingLocked}
            onChange={event => setAllocationChoice(event.target.value)}>
            <option value="">Choose exact Create allocation</option>
            {allocationOptions.map(option => <option key={option.key} value={option.key}>
              {[option.guest || 'Guest not identified', text(option.arrival) || 'Arrival unknown', text(option.departure) || 'Departure unknown', option.room,
                `Create ${option.requestId} · allocation ${option.allocationId}`].filter(Boolean).join(' · ')}
            </option>)}
          </select>
        </label> : useCreateTarget ? <div className={styles.warning}>No exact Create allocation is available in this email. Choose an existing reservation or add a valid Create action first.</div>
          : <label className={styles.label}>Existing Infor confirmation
          <input value={confirmation} disabled={editor.view.busy || filingLocked} onChange={event => setConfirmation(event.target.value)} placeholder="12345678-1" />
        </label>}
      </div>
      {!useCreateTarget && !filingLocked && <details className={styles.card} open={!isExactConfirmation(confirmation)}>
        <summary>Find the stay by guest name</summary>
        <small className={styles.hint}>Use this when the email has no Infor booking number. Search by surname and arrival day; it takes about a minute. The stay you pick is verified in Infor before filing.</small>
        <div className={styles.grid}>
          <label className={styles.label}>Guest surname
            <input value={searchForm.lastName} disabled={editor.view.busy || searching}
              onChange={event => updateSearchForm('lastName', event.target.value)} placeholder="Smith" />
          </label>
          <label className={styles.label}>Arrival Date
            <input type="date" value={searchForm.arrival} disabled={editor.view.busy || searching}
              onChange={event => updateSearchForm('arrival', event.target.value)} />
          </label>
          <label className={styles.label}>Departure Date — optional
            <input type="date" value={searchForm.departure} disabled={editor.view.busy || searching}
              onChange={event => updateSearchForm('departure', event.target.value)} />
          </label>
        </div>
        <div className={styles.row}>
          <button type="button" disabled={editor.view.busy || searching || !searchTransport}
            onClick={runGuestSearch}>{searching ? 'Searching Infor…' : 'Search Infor'}</button>
        </div>
        {searching && <small className={styles.hint}>{AMEND_FIND_COPY.searching} {AMEND_FIND_COPY.lookupWait}</small>}
        {searchResult?.kind === 'none' && <small className={styles.hint}>Not found in Infor by surname {searchResult.lastName} and arrival {formatStayDate(searchResult.arrival)}.</small>}
        {searchResult?.kind === 'capped' && <small className={styles.hint}>{AMEND_FIND_COPY.searchCapped}</small>}
        {searchResult?.kind === 'error' && <div className={styles.warning}>{searchResult.message}</div>}
        {searchRows.map(row => {
          const rowPicked = pickedRow?.confirmation === row.confirmation;
          return <div className={styles.card} key={`${row.confirmation}:${row.arrival ?? ''}`}>
            <strong>{[row.firstName, row.lastName].filter(Boolean).join(' ') || 'Guest'} · {row.confirmation}</strong>
            <small className={styles.hint}>{[row.status, row.arrival ? `arrives ${formatStayDate(row.arrival)}` : 'arrival unknown',
              row.departure ? `departs ${formatStayDate(row.departure)}` : null].filter(Boolean).join(' · ')}</small>
            <div className={styles.row}><button type="button" disabled={editor.view.busy}
              onClick={() => { setConfirmation(row.confirmation); setPickedRow(row); }}>{rowPicked ? 'Selected stay' : 'Use this stay'}</button></div>
          </div>;
        })}
        {pickedRow && <small className={styles.hint}>Picked stay {pickedRow.confirmation} fills the confirmation above. Its guest and dates are checked against a fresh Infor read before filing.</small>}
      </details>}
      {useCreateTarget && selectedAllocation && <div className={createStatus === 'needs_reconcile' || createStatus === 'failed' ? styles.warning : styles.hint}>
        {linkedCreateLabel} The confirmation is supplied only from the verified Create receipt; it is not entered or guessed here.
        {createUnknown.length === 1 && <div className={styles.row}><button type="button" disabled={editor.view.busy}
          onClick={() => void editor.commands.reconcile(createUnknown[0]!.id)}>Reconcile Create</button></div>}
      </div>}
      {hint && !useCreateTarget && !pickedTarget && confirmation.trim() === text(hint.confirmation) && <div className={styles.grid}>
        <Field label="Guest name" path={`${body}/targets/include/${encodeURIComponent(text(hint.id))}/guestName`} editor={editor} resolvedValue={hint.guestName ?? null} disabled={editor.view.busy || filingLocked} />
        <Field label="Original Arrival Date" path={`${body}/targets/include/${encodeURIComponent(text(hint.id))}/bookedArrival`} type="date" editor={editor} resolvedValue={hint.bookedArrival ?? null} disabled={editor.view.busy || filingLocked} />
        <Field label="Original Departure Date" path={`${body}/targets/include/${encodeURIComponent(text(hint.id))}/bookedDeparture`} type="date" editor={editor} resolvedValue={hint.bookedDeparture ?? null} disabled={editor.view.busy || filingLocked} />
      </div>}
    </Section>
    <Section title="Document">
      <label className={styles.label}>Attachment from this email
        <select value={attachmentId} disabled={editor.view.busy || filingLocked} onChange={event => {
          const nextId = event.target.value;
          setChosenAttachment(nextId);
          const picked = attachments.find(attachment => attachment.sourceRef === nextId);
          setKind(picked ? inferFilingDocumentKind(picked.name) ?? '' : '');
        }}>
          <option value="">Choose attachment</option>
          {attachments.map(attachment => <option key={attachment.sourceRef} value={attachment.sourceRef}>{attachment.name}</option>)}
        </select>
      </label>
      {selectedAttachment && <div className={styles.hint}>{selectedAttachment.name} · {selectedAttachment.size === undefined ? 'Size unknown' : `${(selectedAttachment.size / 1024 / 1024).toFixed(2)} MB`} · {
        selectedAttachment.uploadability === 'ready' ? 'Source available; Infor check still required' : selectedAttachment.uploadability === 'checking' ? 'Checking attachment' : selectedAttachment.uploadability === 'unknown' ? 'Attachment not yet checked' : 'Unsupported source'}</div>}
      {selectedAttachment && !pdf && <div className={styles.warning}>Choose a PDF no larger than 10 MB. Images and conversion are not supported.</div>}
      {!attachments.length && <div className={styles.warning}>No attachment is available in this email. A promised voucher or payment proof cannot be filed until the attachment is available.</div>}
      <label className={styles.label}>Attachment category
          <select value={kind} disabled={editor.view.busy || filingLocked} onChange={event => setKind(event.target.value === 'voucher' || event.target.value === 'payment_proof' ? event.target.value : '')}>
            <option value="">Choose category</option><option value="voucher">Voucher</option><option value="payment_proof">Payment proof</option>
          </select>
        </label>
      {doc && <div className={styles.grid}>
        <Field label="Document name" path={`${documentRoot}/requestedName`} editor={editor} maxLength={150} emptyState="none" review
          disabled={filingLocked || editor.view.busy} hint="Optional PDF name in Infor. Leave blank to use the attachment name." />
        <Field label="Description" path={`${documentRoot}/requestedDescription`} editor={editor} maxLength={200} emptyState="none" review
          disabled={filingLocked || editor.view.busy} hint="Optional description in Infor. Leave blank to use the default." />
      </div>}
      {preparedCurrent && <div className={styles.card}>
        <strong>Check the stay and document from Infor</strong>
        <p>{text(preparedTarget.firstName)} {text(preparedTarget.lastName)} · {text(preparedTarget.confirmation)}</p>
        <p>{text(preparedTarget.arrival)} → {text(preparedTarget.departure)}</p>
        <p>Document: {text(preparedResult.documentName)}{text(preparedResult.documentDescription) ? ` · ${text(preparedResult.documentDescription)}` : ''}</p>
      </div>}
      <div className={styles.row}>{preparedCurrent
        ? <button type="button" className={styles.primary} disabled={editor.view.busy || editor.view.preview || filingLocked || !['lab', 'staff-enabled'].includes(editor.configuration?.capabilities?.attach?.status ?? '')} onClick={() => { void file(); }}>File to stay</button>
        : <button type="button" className={styles.primary} disabled={editor.view.busy || filingLocked || !pdf || !validConfirmation || !kind || docs.length > 1 || include.length > 1 || exclude.length > 0 || scope.mode === 'scoped_all' || (useCreateTarget && createStatus !== 'succeeded') || !['prepare-only', 'lab', 'staff-enabled'].includes(editor.configuration?.capabilities?.attach?.status ?? '')} onClick={() => { void check(); }}>Check stay and document</button>}</div>
      {!['lab', 'staff-enabled'].includes(editor.configuration?.capabilities?.attach?.status ?? '') && <small className={styles.hint}>Filing is not available for this hotel yet.</small>}
      {filingError && <div className={styles.warning} role="alert">{filingError}</div>}
      {filing && <small className={styles.hint}>Working in Infor. This may take a few minutes.</small>}
    </Section>
    <small className={styles.hint}>Filing payment proof does not confirm payment or settlement.</small>
  </fieldset>;
}
