'use client';

import { useEffect, useState } from 'react';
import type { WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { effectiveAt, record, requestPath, text, valueAt } from '@/lib/reservation-workflow/views';
import { Section } from '../shared/stay-fields';
import { TargetSearch } from './amend-editor';
import styles from './other-editors.module.css';

export function CancelEditor(editor: WorkbenchEditorProps) {
  const body = `${requestPath(editor.request.id)}/body`;
  const scope = record(effectiveAt(editor.snapshot, `${body}/targets`));
  const include = Array.isArray(scope.include) ? scope.include.map(record) : [];
  const exclude = Array.isArray(scope.exclude) ? scope.exclude.map(record) : [];
  const hint = include.length === 1 ? include[0] : undefined;
  const hintId = text(hint?.id), selected = valueAt(editor.snapshot, `${body}/targets/include/0/suggestedRef`);
  const reasonPath = `${body}/reason/text`, notePath = `${body}/cancellationNote`;
  const reason = text(valueAt(editor.snapshot, reasonPath));
  const savedNote = text(valueAt(editor.snapshot, notePath));
  const [note, setNote] = useState(savedNote);
  useEffect(() => setNote(savedNote), [savedNote]);
  const preview = [...editor.snapshot.session.draft.observations].reverse().find(item => item.kind === 'stay_candidate'
    && item.status === 'complete' && item.criteria.workflow === 'cancel' && item.criteria.stage === 'prepare'
    && item.criteria.requestId === editor.request.id && item.criteria.hintId === hintId && item.criteria.selectionRef === selected);
  const result = record(preview?.result);
  const reasons = Array.isArray(result.reasons) ? result.reasons.map(record).filter(row => typeof row.value === 'string' && typeof row.display === 'string') : [];
  const reply = record(editor.snapshot.workflowReply);
  const refsValue = effectiveAt(editor.snapshot, `${body}/previewObservationRefs`);
  const refs = Array.isArray(refsValue) ? refsValue.map(text) : [];
  // The saved native preview retains its review identity across email reopen.
  const storedBinding = preview && result.ready === true && typeof result.approvalDigest === 'string' ? {
    required: true, observationRef: preview.ref,
    reviewFieldPath: `${body}/previewObservationRefs/${refs.includes(preview.ref) ? refs.indexOf(preview.ref) : refs.length}`,
    reviewNote: `cancel-preview:${preview.ref}:${result.approvalDigest}`,
  } : {};
  const replyBinding = record(reply.financialReview);
  const binding = replyBinding.observationRef === preview?.ref ? replyBinding : storedBinding;
  const canReview = binding.required === true && binding.observationRef === preview?.ref && typeof binding.reviewFieldPath === 'string'
    && typeof binding.reviewNote === 'string' && typeof binding.observationRef === 'string';
  const accepted = canReview && editor.snapshot.session.draft.staffReviews[String(binding.reviewFieldPath)]?.status === 'accepted'
    && editor.snapshot.session.draft.staffReviews[String(binding.reviewFieldPath)]?.note === binding.reviewNote;
  return <div className={styles.stack}>
    <Section title="Find the stay to cancel">
      <p className={styles.hint}>One exact Infor stay per cancellation. A supplier reference alone does not identify a stay.</p>
      {include.length > 1 && <div className={styles.warning}>This request includes {include.length} stays. Create a separate cancellation for each stay; this request cannot be checked as one cancellation.</div>}
      {exclude.length > 0 && <div className={styles.warning}>This request has excluded stays. The current cancellation cannot be checked until its scope is resolved; excluded stays will not be removed automatically.</div>}
      {include.map((row, i) => <div className={styles.card} key={text(row.id) || i}>
        <strong>Included stay {i + 1}</strong><TargetSearch editor={editor} body={body} hint={row} index={i} workflow="cancel" />
      </div>)}
      {exclude.map(row => <div className={styles.hint} key={text(row.id)}>Excluded: {text(row.confirmation) || text(row.guestName) || 'Unidentified stay'} · {text(row.bookedArrival)} → {text(row.bookedDeparture)}</div>)}
      <div className={styles.row}>
        {hint && !exclude.length && scope.mode !== 'explicit' && <button type="button" disabled={editor.view.busy} onClick={() => void editor.commands.edit(`${body}/targets/mode`, 'explicit')}>Use this one stay</button>}
        {!include.length && <button type="button" disabled={editor.view.busy} onClick={() => void editor.commands.changeRows({ kind: 'add_target', requestId: editor.request.id })}>Add stay</button>}
        <button type="button" disabled={editor.view.busy || !hint || exclude.length > 0 || scope.mode !== 'explicit'} onClick={() => void editor.commands.lookup()}>Find in Infor</button>
      </div>
    </Section>
    <Section title="Cancellation details">
      <label className={styles.label}>Infor cancellation reason
        <select value={reasons.some(row => row.display === reason) ? reason : ''} disabled={editor.view.busy || !reasons.length}
          onChange={event => void editor.commands.edit(reasonPath, event.target.value, event.target.value ? 'set' : 'none')}>
          <option value="">{reasons.length ? 'Choose a reason' : 'Check the stay to load reasons'}</option>
          {reasons.map(row => <option key={text(row.value)} value={text(row.display)}>{text(row.display)}</option>)}
        </select>
      </label>
      {reason && reasons.length > 0 && !reasons.some(row => row.display === reason) && <div className={styles.warning}>Requested reason: {reason}. Choose a current Infor reason.</div>}
      <label className={styles.label}>Cancellation note (optional)
        <textarea rows={3} maxLength={200} value={note} disabled={editor.view.busy} onChange={event => { setNote(event.target.value); editor.commands.stageEdit(notePath, event.target.value, event.target.value ? 'set' : 'none'); }}
          onBlur={() => { if (note !== savedNote) void editor.commands.edit(notePath, note, note ? 'set' : 'none'); }} />
      </label><small className={styles.hint}>{note.length}/200 characters. Infor accepts a single line.</small>
      {/[\p{Cc}]/u.test(note) && <div className={styles.warning}>Remove line breaks and control characters from this note before checking.</div>}
    </Section>
    {preview && <Section title="Last Infor cancellation check">
      <div className={styles.facts}>
        <span>Scope: {text(record(result.target).confirmation)} · {text(record(result.target).arrival)} → {text(record(result.target).departure)}</span>
        <span>Fee status: {text(result.feeState).replaceAll('_', ' ') || 'Unknown'}</span>
        <span>Penalty: {text(result.penaltyText) || 'Not returned; check the policy and fee before deciding.'}</span>
        {Array.isArray(result.policyFacts) && [...new Set(result.policyFacts.map(text))].map(fact => <span key={fact}>{fact}</span>)}
        {result.roomScope && <span>Room scope: {typeof result.roomScope === 'string' ? result.roomScope : JSON.stringify(result.roomScope)}</span>}
      </div>
      {canReview && <div className={styles.row}>{accepted ? <span>Current cancellation policy and fee reviewed.</span> : <button type="button" disabled={editor.view.busy}
        onClick={() => void editor.commands.acceptFinancialReview(String(binding.reviewFieldPath), String(binding.reviewNote), String(binding.observationRef))}>I reviewed this scope, policy and fee</button>}</div>}
      <small className={styles.hint}>If Infor returns different financial facts at Go, review the new facts and decide again.</small>
    </Section>}
    <div className={styles.hint}>Cancellation does not remove Add-Ons or issue a refund.</div>
  </div>;
}
