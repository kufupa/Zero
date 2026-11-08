'use client';

import { useEffect, useState } from 'react';
import type { WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { effectiveAt, record, requestPath, text, valueAt } from '@/lib/reservation-workflow/views';
import { Field, Section } from '../shared/stay-fields';
import { StayFacts } from './amend-editor';
import styles from './other-editors.module.css';

export function FilingEditor(editor: WorkbenchEditorProps) {
  const draft = editor.snapshot.session.draft;
  const body = `${requestPath(editor.request.id)}/body`;
  const scope = record(effectiveAt(editor.snapshot, `${body}/targets`));
  const include = Array.isArray(scope.include) ? scope.include.map(record) : [];
  const exclude = Array.isArray(scope.exclude) ? scope.exclude.map(record) : [];
  const owner = draft.proposal.content.requests.find(row => row.id === editor.request.id);
  const effectiveRefs = valueAt(editor.snapshot, `${requestPath(editor.request.id)}/documentRefs`);
  const refs = Array.isArray(effectiveRefs) ? effectiveRefs : owner?.documentRefs ?? [];
  const docs = draft.proposal.content.documents.filter(row => refs.includes(row.id) && row.ownerRequestId === editor.request.id);
  const doc = docs.length === 1 ? docs[0] : undefined;
  const hint = include.length === 1 ? { ...include[0] } : undefined;
  if (hint) for (const field of ['confirmation', 'guestName', 'bookedArrival', 'bookedDeparture']) {
    const path = `${body}/targets/include/${encodeURIComponent(text(hint.id))}/${field}`;
    const override = draft.fieldOverrides[path];
    hint[field] = !override || override.state === 'inherit' ? valueAt(editor.snapshot, `${body}/targets/include/0/${field}`)
      : override.state === 'set' ? override.value : null;
  }
  const documentKind = doc ? text(valueAt(editor.snapshot, `/proposal/content/documents/${encodeURIComponent(doc.id)}/kind`)) || doc.kind : '';
  const documentSource = doc ? text(valueAt(editor.snapshot, `/proposal/content/documents/${encodeURIComponent(doc.id)}/documentSourceRef`)) || doc.documentSourceRef : '';
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
  const dirty = (chosenAttachment !== null && chosenAttachment !== resolvedAttachment) || confirmation.trim() !== text(hint?.confirmation) || kind !== documentKind;
  useEffect(() => {
    const key = `filing-selection:${editor.request.id}`;
    editor.commands.setUncommitted(key, dirty);
    return () => editor.commands.setUncommitted(key, false);
  }, [dirty, editor.request.id]);
  const path = hint ? `${body}/targets/include/${encodeURIComponent(text(hint.id))}/suggestedRef` : '';
  const selected = path ? valueAt(editor.snapshot, path) : null;
  const candidates = hint ? draft.observations.flatMap(observation => {
    const c = observation.criteria, result = record(observation.result), stay = record(result.stay);
    if (observation.kind !== 'stay_candidate' || observation.status !== 'complete' || record(observation.coverage).complete !== true
      || observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode
      || observation.sourceMessageId !== draft.source.messageId || c.workflow !== 'filing' || c.requestId !== editor.request.id
      || c.targetHintId !== hint.id || result.outcome !== 'found' || !Object.keys(stay).length
      || (hint.confirmation && hint.confirmation !== stay.confirmation)
      || (hint.bookedArrival && hint.bookedArrival !== stay.arrival) || (hint.bookedDeparture && hint.bookedDeparture !== stay.departure)) return [];
    return [{ observation, stay }];
  }) : [];
  const selectedStay = candidates.find(candidate => candidate.observation.ref === selected);
  const proof = doc && selectedStay ? [...draft.observations].reverse().find(observation => observation.kind === 'document'
    && observation.status === 'complete' && record(observation.coverage).complete === true
    && observation.generationId === draft.generationId && observation.criteria.workflow === 'filing'
    && observation.criteria.requestId === editor.request.id && observation.criteria.documentId === doc.id
    && observation.criteria.targetObservationRef === selectedStay.observation.ref && record(observation.result).outcome === 'ready') : undefined;
  const validConfirmation = /^\d+-\d+$/.test(confirmation.trim());
  return <div className={styles.stack}>
    <Section title="PDF and destination">
      <p className={styles.hint}>File one admitted PDF to one exact stay. Additional files or stays need separate filing actions.</p>
      {(include.length > 1 || exclude.length > 0 || scope.mode === 'scoped_all') && <div className={styles.warning}>The source contains a broader or excluded stay scope. Resolve it as a separate one-stay action before filing.</div>}
      {exclude.map(row => <div key={text(row.id)} className={styles.hint}>Excluded: {text(row.confirmation) || text(row.guestName) || 'Unidentified stay'}</div>)}
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
        <label className={styles.label}>Infor confirmation
          <input value={confirmation} disabled={editor.view.busy} onChange={event => setConfirmation(event.target.value)} placeholder="12345678-1" />
        </label>
        <label className={styles.label}>Document kind
          <select value={kind} disabled={editor.view.busy} onChange={event => setKind(event.target.value === 'voucher' || event.target.value === 'payment_proof' ? event.target.value : '')}>
            <option value="">Choose kind</option><option value="voucher">Voucher</option><option value="payment_proof">Payment proof</option>
          </select>
        </label>
      </div>
      {hint && doc && <div className={styles.grid}>
        <Field label="Original Arrival Date" path={`${body}/targets/include/${encodeURIComponent(text(hint.id))}/bookedArrival`} type="date" editor={editor} resolvedValue={hint.bookedArrival ?? null} disabled={dirty || editor.view.busy} />
        <Field label="Original Departure Date" path={`${body}/targets/include/${encodeURIComponent(text(hint.id))}/bookedDeparture`} type="date" editor={editor} resolvedValue={hint.bookedDeparture ?? null} disabled={dirty || editor.view.busy} />
      </div>}
      {dirty && <div className={styles.warning}>New selection is not saved. Check and Go use the saved selection until you apply this selection.</div>}
      <div className={styles.row}><button type="button" disabled={editor.view.busy || !dirty || !pdf || !validConfirmation || !kind || include.length > 1 || exclude.length > 0 || scope.mode === 'scoped_all'}
        onClick={() => { if (kind) void editor.commands.configureFiling(attachmentId, confirmation.trim(), kind); }}>Apply PDF and destination</button>
        <button type="button" disabled={editor.view.busy || dirty || !hint || !doc || exclude.length > 0} onClick={() => void editor.commands.lookup()}>Find stay and check PDF</button></div>
      {doc && <small className={styles.hint}>Saved selection: {attachments.find(attachment => attachment.sourceRef === resolvedAttachment)?.name || 'Source attachment unavailable'} · {documentKind === 'payment_proof' ? 'Payment proof' : documentKind === 'voucher' ? 'Voucher' : documentKind} · {text(hint?.confirmation) || 'Destination missing'}</small>}
    </Section>
    <Section title="Exact destination and source bytes">
      {candidates.map(({ observation, stay }) => <div className={styles.card} key={observation.ref}>
        <StayFacts stay={stay} /><div className={styles.row}><button type="button" disabled={editor.view.busy || dirty}
          onClick={() => void editor.commands.selectNative(path, observation.ref)}>{selected === observation.ref ? 'Selected stay' : 'Select this stay'}</button></div>
      </div>)}
      {!selectedStay && <span className={styles.hint}>Find and select the exact stay, then check the PDF again.</span>}
      {selectedStay && !proof && <div className={styles.warning}>PDF bytes have not been verified for this stay. Find the stay and check the PDF again.</div>}
      {proof && <div className={styles.hint}>Infor lookup verified the source PDF for this selected stay. Check before filing.</div>}
    </Section>
    <small className={styles.hint}>Filing payment proof does not confirm payment or settlement.</small>
  </div>;
}
