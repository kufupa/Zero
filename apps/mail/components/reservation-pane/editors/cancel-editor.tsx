'use client';

import { useEffect, useState } from 'react';
import type { WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { effectiveAt, record, requestPath, text, valueAt } from '@/lib/reservation-workflow/views';
import { Field, Section } from '../shared/stay-fields';
import { TargetSearch } from './amend-editor';
import styles from './other-editors.module.css';

function exactConfirmation(hint: Record<string, unknown>) {
  const confirmation = text(hint.confirmation).trim();
  return /^\d{6,10}-\d{1,2}$/.test(confirmation) ? confirmation : '';
}

function definitelyDistinct(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftConfirmation = exactConfirmation(left), rightConfirmation = exactConfirmation(right);
  if (leftConfirmation && rightConfirmation) return leftConfirmation !== rightConfirmation;
  const normalize = (value: unknown) => typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() : '';
  const nameForms = (value: unknown) => {
    if (typeof value !== 'string') return [];
    const parts = value.split(',');
    return [...new Set([normalize(value), ...(parts.length === 2 ? [normalize(`${parts[1]?.trim()} ${parts[0]?.trim()}`)] : [])])]
      .filter(Boolean);
  };
  const leftNames = nameForms(left.guestName), rightNames = nameForms(right.guestName);
  const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const leftArrival = left.bookedArrival, leftDeparture = left.bookedDeparture;
  const rightArrival = right.bookedArrival, rightDeparture = right.bookedDeparture;
  const disjointDates = validDate(leftArrival) && validDate(leftDeparture) && validDate(rightArrival) && validDate(rightDeparture) &&
    (leftDeparture <= rightArrival || rightDeparture <= leftArrival);
  return leftNames.length > 0 && rightNames.length > 0 && !leftNames.some(name => rightNames.includes(name)) && disjointDates;
}

function lockedScope(editor: WorkbenchEditorProps) {
  return editor.snapshot.session.draft.operationResults.some(result => result.requestId === editor.request.id &&
    (result.status === 'succeeded' || result.status === 'failed' || result.status === 'unknown'));
}

async function correctCancelScope(editor: WorkbenchEditorProps, body: string,
  include: Record<string, unknown>[], exclude: Record<string, unknown>[], hint: Record<string, unknown>,
  from: 'include' | 'exclude') {
  if (lockedScope(editor) || !text(hint.id)) return;
  const includePath = `${body}/targets/include`, excludePath = `${body}/targets/exclude`;
  const modePath = `${body}/targets/mode`, id = text(hint.id);
  if (valueAt(editor.snapshot, modePath) !== 'explicit') await editor.commands.edit(modePath, 'explicit');
  if (from === 'include') {
    if (include.length < 2) return;
    const duplicate = exclude.some(row => text(row.id) === id || exactConfirmation(row) && exactConfirmation(row) === exactConfirmation(hint));
    if (!duplicate) await editor.commands.edit(excludePath, [...exclude, hint]);
    await editor.commands.edit(includePath, include.filter(row => text(row.id) !== id));
    return;
  }
  const duplicate = include.some(row => text(row.id) === id || exactConfirmation(row) && exactConfirmation(row) === exactConfirmation(hint));
  if (!duplicate) {
    if (!exactConfirmation(hint) || !include.every(row => definitelyDistinct(row, hint))) return;
    await editor.commands.edit(includePath, [...include, hint]);
  }
  await editor.commands.edit(excludePath, exclude.filter(row => text(row.id) !== id));
}

export function CancelEditor(editor: WorkbenchEditorProps) {
  const body = `${requestPath(editor.request.id)}/body`;
  const scope = record(effectiveAt(editor.snapshot, `${body}/targets`));
  const include = Array.isArray(scope.include) ? scope.include.map(record) : [];
  const exclude = Array.isArray(scope.exclude) ? scope.exclude.map(record) : [];
  const scopeLocked = lockedScope(editor);
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
  const selectedLookup = editor.snapshot.session.draft.observations.find(item => item.ref === selected && item.kind === 'stay_candidate'
    && item.status === 'complete' && item.generationId === editor.snapshot.session.draft.generationId
    && item.propertyCode === editor.snapshot.session.draft.propertyCode && item.sourceMessageId === editor.snapshot.session.draft.source.messageId
    && item.criteria.workflow === 'cancel' && item.criteria.stage === 'lookup' && item.criteria.requestId === editor.request.id
    && item.criteria.hintId === hintId);
  // Arrival reads do not make a staff destination selection. Their current,
  // exact-source options can still populate the dropdown before that choice.
  const draft = editor.snapshot.session.draft;
  const normalizeHint = (value: unknown) => typeof value === 'string' ? value.trim() || null : null;
  const arrivalLookup = !selectedLookup && hint ? [...draft.observations].reverse().find(item => {
    const query = record(item.criteria.query);
    return item.kind === 'stay_candidate' && item.status === 'complete' && item.coverage.complete &&
      item.generationId === draft.generationId && item.propertyCode === draft.propertyCode &&
      item.sourceMessageId === draft.source.messageId && item.criteria.workflow === 'cancel' &&
      item.criteria.stage === 'lookup' && item.criteria.requestId === editor.request.id && item.criteria.hintId === hintId &&
      normalizeHint(query.confirmation) === normalizeHint(hint.confirmation) &&
      normalizeHint(query.guestName) === normalizeHint(hint.guestName) &&
      normalizeHint(query.arrival) === normalizeHint(hint.bookedArrival) &&
      normalizeHint(query.departure) === normalizeHint(hint.bookedDeparture);
  }) : undefined;
  const warmCheck = record(record((selectedLookup ?? arrivalLookup)?.result).warmCancellationCheck);
  const previewReasons = Array.isArray(result.reasons) ? result.reasons.map(record).filter(row => typeof row.value === 'string' && typeof row.display === 'string') : [];
  const warmReasons = warmCheck.status === 'ready' && Array.isArray(warmCheck.reasons)
    ? warmCheck.reasons.map(record).filter(row => typeof row.value === 'string' && typeof row.display === 'string') : [];
  const warmObservedAt = typeof warmCheck.observedAt === 'string' ? warmCheck.observedAt : null;
  const warmIsNewer = warmReasons.length > 0 && (!preview || !Number.isFinite(Date.parse(preview.observedAt)) ||
    Number.isFinite(Date.parse(warmObservedAt ?? '')) && Date.parse(warmObservedAt!) >= Date.parse(preview.observedAt));
  const reasons = warmIsNewer ? warmReasons : previewReasons.length ? previewReasons : warmReasons;
  const reasonsWarmed = reasons === warmReasons && warmReasons.length > 0;
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
      {scopeLocked && <div className={styles.warning}>This Cancel has a recorded success, failure, or uncertain result. Reconcile it before changing target scope or identity.</div>}
      {include.length > 1 && <div className={styles.warning}>This request includes {include.length} stays. Select one exact included stay for each cancellation; other stays are not cancelled by it.</div>}
      {exclude.length > 0 && <div className={styles.hint}>Excluded stays stay out of native scope until an exact, deliberate correction. Original source claims remain attached to the request.</div>}
      {scope.mode !== 'explicit' && include.length > 0 && <button type="button" disabled={editor.view.busy}
        onClick={() => void editor.commands.edit(`${body}/targets/mode`, 'explicit')}>Use listed stays individually</button>}
      {include.map((row, i) => <div className={styles.card} key={text(row.id) || i}>
        <strong>Included stay {i + 1}</strong><TargetSearch editor={editor} body={body} hint={row} index={i} workflow="cancel" locked={scopeLocked} />
        {include.length > 1 && <button type="button" disabled={editor.view.busy || scopeLocked || scope.mode !== 'explicit'}
          onClick={() => void correctCancelScope(editor, body, include, exclude, row, 'include').catch(() => {})}>
          Exclude this exact stay from this Cancel action
        </button>}
      </div>)}
      {exclude.map((row, i) => {
        const duplicate = include.some(target => text(target.id) === text(row.id) || exactConfirmation(target) && exactConfirmation(target) === exactConfirmation(row));
        const safelyDistinct = duplicate || include.every(target => definitelyDistinct(target, row));
        return <div className={styles.card} key={text(row.id) || i}>
        <strong>Excluded stay · unchanged</strong>
        <div className={styles.grid}>
          <Field editor={editor} path={`${body}/targets/exclude/${i}/confirmation`} label="Confirmation or supplier reference" disabled={scopeLocked} />
          <Field editor={editor} path={`${body}/targets/exclude/${i}/guestName`} label="Guest name" disabled={scopeLocked} />
          <Field editor={editor} path={`${body}/targets/exclude/${i}/bookedArrival`} label="Original arrival" type="date" disabled={scopeLocked} />
          <Field editor={editor} path={`${body}/targets/exclude/${i}/bookedDeparture`} label="Original departure" type="date" disabled={scopeLocked} />
        </div>
        <small className={styles.hint}>Correct missing or ambiguous identity facts above, then Find again. Excluded stay is not cancelled while it remains here.</small>
        <button type="button" disabled={editor.view.busy || scopeLocked || scope.mode !== 'explicit' || !exactConfirmation(row) || !safelyDistinct}
          onClick={() => void correctCancelScope(editor, body, include, exclude, row, 'exclude').catch(() => {})}>
          Include this exact stay in this Cancel action
        </button>
        {!safelyDistinct && <small className={styles.warning}>This exclusion may overlap an included stay. Correct its exact confirmation or enter a different guest and fully disjoint original dates before including it.</small>}
        </div>;
      })}
      <div className={styles.row}>
        {hint && scope.mode !== 'explicit' && <button type="button" disabled={editor.view.busy} onClick={() => void editor.commands.edit(`${body}/targets/mode`, 'explicit')}>Use this one stay</button>}
        <button type="button" disabled={editor.view.busy || scopeLocked} onClick={() => void editor.commands.changeRows({ kind: 'add_target', requestId: editor.request.id })}>Add exact stay</button>
        <button type="button" disabled={editor.view.busy || !include.length || scope.mode !== 'explicit'} onClick={() => void editor.commands.lookup()}>Find included stays in Infor</button>
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
      {reasonsWarmed && <small className={styles.hint}>Current Infor options were read during arrival checks without saving or recording staff review. Prepare again before Go.</small>}
      {warmCheck.status === 'ready' && <div className={styles.card}>
        <strong>Cancellation policy and fee · arrival check</strong>
        <div className={styles.facts}>
          <span>Fee status: {text(warmCheck.feeState).replaceAll('_', ' ') || 'Unknown'}</span>
          <span>Penalty: {text(warmCheck.penaltyText) || 'Not returned; check the policy and fee before deciding.'}</span>
          {Array.isArray(warmCheck.policyFacts) && [...new Set(warmCheck.policyFacts.map(text)
            .filter((fact): fact is string => Boolean(fact)))].map(fact => <span key={fact}>{fact}</span>)}
        </div>
        <small className={styles.hint}>Read-only arrival context. Prepare again for a current review; this does not count as staff acceptance.</small>
      </div>}
      {warmCheck.status === 'unavailable' && <small className={styles.hint}>Arrival checks could not load current cancellation reasons. Check again before deciding.</small>}
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
        {Boolean(result.roomScope) && <span>Room scope: {typeof result.roomScope === 'string' ? result.roomScope : JSON.stringify(result.roomScope)}</span>}
      </div>
      {canReview && <div className={styles.row}>{accepted ? <span>Current cancellation policy and fee reviewed.</span> : <button type="button" disabled={editor.view.busy}
        onClick={() => void editor.commands.acceptFinancialReview(String(binding.reviewFieldPath), String(binding.reviewNote), String(binding.observationRef))}>I reviewed this scope, policy and fee</button>}</div>}
      <small className={styles.hint}>If Infor returns different financial facts at Go, review the new facts and decide again.</small>
    </Section>}
    <div className={styles.hint}>Linked PDFs and Add-Ons remain as separate work in this email case. Cancellation does not remove Add-Ons or issue a refund.</div>
  </div>;
}
