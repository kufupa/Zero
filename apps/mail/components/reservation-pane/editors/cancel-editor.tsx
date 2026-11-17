'use client';

import { useEffect, useState } from 'react';
import type { WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { cancelChargeForSelection, effectiveAt, record, requestPath, savedTargetOperationLocks, text, valueAt } from '@/lib/reservation-workflow/views';
import { Field, Section } from '../shared/stay-fields';
import { isExactConfirmation, TargetSearch } from './amend-editor';
import styles from './other-editors.module.css';

/** Staff wording for the native fee state; never show raw state keys. */
function feeLabel(value: unknown): string {
  const state = text(value);
  if (state === 'none') return 'No fee';
  if (state === 'fee_dialog_pending') return 'Infor shows a fee. Review it below.';
  if (state === 'fee_accepted_unconfirmed') return 'Fee accepted. Check it in Infor.';
  if (!state || state.startsWith('unknown') || state.includes('cannot_be_recovered')) return 'Not shown yet. Check the policy below.';
  return state.replaceAll('_', ' ');
}
function roomsLabel(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  const scope = record(value);
  if (scope.complete === true) return 'Whole stay';
  if (scope.complete === false) return 'Infor did not list every room. Check the stay in Infor.';
  return null;
}

function exactConfirmation(hint: Record<string, unknown>) {
  const confirmation = text(hint.confirmation).trim();
  return isExactConfirmation(confirmation) ? confirmation : '';
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
  return savedTargetOperationLocks(editor.snapshot, editor.request.id);
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
  const preparedFeeCanPauseForStaffGo = result.ready === true && typeof result.penaltyText === 'string' &&
    Boolean(result.penaltyText.trim());
  const charge = cancelChargeForSelection(editor.snapshot, editor.request.id);
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
  const feeAttempt = [...draft.observations].reverse().find(item => item.kind === 'stay_candidate' &&
    item.generationId === draft.generationId && item.propertyCode === draft.propertyCode &&
    item.sourceMessageId === draft.source.messageId && item.criteria.workflow === 'cancel' &&
    item.criteria.stage === 'execute' && item.criteria.requestId === editor.request.id &&
    item.criteria.hintId === hintId && text(record(item.result).penaltyText));
  const pendingFee = record(feeAttempt?.result);
  const penaltyAmount = (value: unknown) => typeof value === 'string'
    ? /Cancellation Penalty of (\d{1,12}\.\d{2}) may be added to account\./.exec(value)?.[1] : undefined;
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
  const canReview = !charge && result.ready === true && binding.required === true && binding.observationRef === preview?.ref && typeof binding.reviewFieldPath === 'string'
    && typeof binding.reviewNote === 'string' && typeof binding.observationRef === 'string';
  const accepted = canReview && editor.snapshot.session.draft.staffReviews[String(binding.reviewFieldPath)]?.status === 'accepted'
    && editor.snapshot.session.draft.staffReviews[String(binding.reviewFieldPath)]?.note === binding.reviewNote;
  return <div className={styles.stack}>
    <Section title="Find the stay to cancel">
      {editor.request.text && <p className={styles.hint}>Customer request: {editor.request.text}</p>}
      <p className={styles.hint}>One exact Infor stay per cancellation. A supplier reference alone does not identify a stay.</p>
      {scopeLocked && <div className={styles.warning}>This Cancel has a recorded success, failure, or uncertain result. Reconcile it before changing target scope or identity.</div>}
      {include.length > 1 && <div className={styles.warning}>Each Cancel action handles one exact stay so its reason, policy, penalty and staff review match that stay. Split the requested stays into separate Cancel actions before checking.</div>}
      {exclude.length > 0 && <div className={styles.hint}>Excluded stays stay out of native scope until an exact, deliberate correction. Original source claims remain attached to the request.</div>}
      {scope.mode !== 'explicit' && include.length > 0 && <button type="button" disabled={editor.view.busy}
        onClick={() => void editor.commands.edit(`${body}/targets/mode`, 'explicit')}>Use listed stays individually</button>}
      {include.map((row, i) => <div className={styles.card} key={text(row.id) || i}>
        <strong>Included stay {i + 1}</strong><TargetSearch editor={editor} body={body} hint={row} index={i} workflow="cancel" locked={scopeLocked} />
        {include.length > 1 && <button type="button" disabled={editor.view.busy || scopeLocked || scope.mode !== 'explicit'}
          onClick={() => void correctCancelScope(editor, body, include, exclude, row, 'include').catch(() => {})}>
          Exclude this exact stay from this Cancel action
        </button>}
        {include.length > 1 && <button type="button" disabled={editor.view.busy || scopeLocked || scope.mode !== 'explicit' || !exactConfirmation(row)}
          onClick={() => void editor.commands.changeRows({ kind: 'separate_cancel_target', requestId: editor.request.id, entityId: text(row.id) }).catch(() => {})}>
          Move this exact stay into its own Cancel action
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
      <p className={styles.warning}>{preparedFeeCanPauseForStaffGo
        ? 'Infor showed this penalty with the unsaved cancellation reason and note. Nava will pause for a separate staff decision if a fee appears during Go.'
        : 'If Infor shows a cancellation charge, finish this one in HMS.'}</p>
      {charge && <div className={styles.warning} role="alert"><strong>This booking has a cancellation charge - finish this one in HMS</strong><p>{charge}</p></div>}
      {text(pendingFee.penaltyText) && <div className={styles.warning} role="alert">
        <strong>This booking has a cancellation charge - finish this one in HMS</strong>
        <p>{text(pendingFee.penaltyText)}</p>
        <p>{/^cancel+ed$/i.test(text(record(pendingFee.nativeReadback).status)) ? 'Infor reports the stay cancelled' : 'Cancellation status needs verification'}.
          {pendingFee.penaltyTiming === 'after_save' ? ' Infor showed this after cancelling.' : ''}
          {' '}Check this fee in Infor before doing anything else. Do not cancel again.</p>
      </div>}
      <label className={styles.label}>Cancellation reason
        <select value={reasons.some(row => row.display === reason) ? reason : ''} disabled={editor.view.busy || !reasons.length}
          onChange={event => void editor.commands.edit(reasonPath, event.target.value, event.target.value ? 'set' : 'none')}>
          <option value="">{reasons.length ? 'Choose a reason' : 'Check the stay to load reasons'}</option>
          {reasons.map(row => <option key={text(row.value)} value={text(row.display)}>{text(row.display)}</option>)}
        </select>
      </label>
      {reasonsWarmed && <small className={styles.hint}>Reasons loaded from Infor. Nava checks them again before you cancel.</small>}
      {warmCheck.status === 'ready' && <div className={styles.card}>
        <strong>Cancellation policy and fee</strong>
        <div className={styles.facts}>
          <span>Fee: {feeLabel(warmCheck.feeState)}</span>
          <span>Penalty: {text(warmCheck.penaltyText) || 'Not returned; check the policy and fee before deciding.'}</span>
          {Array.isArray(warmCheck.policyFacts) && [...new Set(warmCheck.policyFacts.map(text)
            .filter((fact): fact is string => Boolean(fact)))].map(fact => <span key={fact}>{fact}</span>)}
        </div>
        <small className={styles.hint}>Read when this email opened. Nava checks again before you cancel.</small>
      </div>}
      {warmCheck.status === 'unavailable' && <small className={styles.hint}>Nava could not load the cancellation reasons yet. Press Check details to try again.</small>}
      {reason && reasons.length > 0 && !reasons.some(row => row.display === reason) && <div className={styles.warning}>Requested reason: {reason}. Choose a current Infor reason.</div>}
      <label className={styles.label}>Cancellation note (optional)
        <textarea rows={3} maxLength={200} value={note} disabled={editor.view.busy} onChange={event => { setNote(event.target.value); editor.commands.stageEdit(notePath, event.target.value, event.target.value ? 'set' : 'none'); }}
          onBlur={() => { if (note !== savedNote) void editor.commands.edit(notePath, note, note ? 'set' : 'none'); }} />
      </label><small className={styles.hint}>{note.length}/200 characters. Infor accepts a single line.</small>
      {/[\p{Cc}]/u.test(note) && <div className={styles.warning}>Remove line breaks and control characters from this note before checking.</div>}
    </Section>
    {preview && <Section title="What Infor will cancel">
      <div className={styles.facts}>
        <span>Stay: {text(record(result.target).confirmation)} · {text(record(result.target).arrival)} → {text(record(result.target).departure)}</span>
        <span>Fee: {feeLabel(result.feeState)}</span>
        <span>Penalty: {text(result.penaltyText) || 'Not returned; check the policy and fee before deciding.'}</span>
        {penaltyAmount(result.penaltyText) && <span>Penalty amount: {penaltyAmount(result.penaltyText)} (currency not returned)</span>}
        {Array.isArray(result.policyFacts) && [...new Set(result.policyFacts.map(text))].map(fact => <span key={fact}>{fact}</span>)}
        {roomsLabel(result.roomScope) && <span>Rooms: {roomsLabel(result.roomScope)}</span>}
      </div>
      {canReview && <div className={styles.row}>{accepted ? <span>Current cancellation policy and fee reviewed.</span> : <button type="button" disabled={editor.view.busy}
        onClick={() => void editor.commands.acceptFinancialReview(String(binding.reviewFieldPath), String(binding.reviewNote), String(binding.observationRef))}>I checked the stay, policy and fee</button>}</div>}
      <small className={styles.hint}>{preparedFeeCanPauseForStaffGo
        ? 'If the fee appears in the live cancellation dialog, Nava will pause for a separate staff Go before continuing.'
        : 'If Infor shows a charge, finish this one in HMS.'}</small>
    </Section>}
    <div className={styles.hint}>Cancelling does not remove Add-Ons or issue a refund.</div>
  </div>;
}
