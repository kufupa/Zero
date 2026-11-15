'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { AWAITING_PAYMENT_PREFIX, RESERVATION_NOTE_MAX, RESERVATION_NOTE_PRESETS } from '../../../../server-pilot/src/ai/reservation-note-presets.js';
import { noteCompositionSummary, text, valueAt, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { FieldReview } from './stay-fields';
import styles from '../reservation-pane.module.css';

function guidanceDismissed(key: string): boolean {
  try { return typeof window !== 'undefined' && window.sessionStorage.getItem(`reservation-note:${key}`) === 'dismissed'; }
  catch { return false; }
}

/** Presets replace text only when staff explicitly applies one. */
export function ReservationNote({ path, editor, disabled = false }: { path: string; editor: WorkbenchEditorProps; disabled?: boolean }) {
  const id = useId();
  const saved = text(valueAt(editor.snapshot, path));
  const [note, setNote] = useState(saved);
  const [preset, setPreset] = useState('');
  const [dirty, setDirty] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState<string[]>([]);
  const version = useRef(0);
  const summary = noteCompositionSummary(editor.snapshot, path);
  const summaryKey = summary ? `${summary.sourceHash}:${path}` : '';
  const override = editor.snapshot.session.draft.fieldOverrides[path];
  const explicitlyNone = override && override.state !== 'inherit' ? override.state === 'none' || override.state === 'clear'
    : summary?.existing.state === 'none';
  const showSummary = summary && !dismissed.includes(summaryKey) && !guidanceDismissed(summaryKey) &&
    (!override || override.state === 'inherit' || explicitlyNone);
  const dismiss = () => {
    try { window.sessionStorage.setItem(`reservation-note:${summaryKey}`, 'dismissed'); } catch {}
    setDismissed(current => current.includes(summaryKey) ? current : [...current, summaryKey]);
  };
  useEffect(() => { if (!dirty) setNote(saved); }, [saved, dirty]);
  const overLimit = note.length > RESERVATION_NOTE_MAX;
  useEffect(() => {
    editor.commands.setUncommitted(path, overLimit);
    return () => editor.commands.setUncommitted(path, false);
  }, [path, overLimit]);
  const commit = (next: string) => {
    if (next.length > RESERVATION_NOTE_MAX) {
      setError(`Shorten the note to ${RESERVATION_NOTE_MAX} characters before saving.`);
      editor.commands.setUncommitted(path, true);
      return;
    }
    editor.commands.setUncommitted(path, false);
    const before = ++version.current;
    setNote(next); setDirty(true); setError('');
    const state = editor.request.kind === 'create' && !next ? 'none' : 'set';
    editor.commands.stageEdit(path, next, state);
    void editor.commands.edit(path, next, state).then(() => {
      if (version.current === before) setDirty(false);
    }).catch(() => {});
  };
  const waiting = note.startsWith(AWAITING_PAYMENT_PREFIX);
  const toggleWaiting = () => {
    const next = waiting ? note.slice(AWAITING_PAYMENT_PREFIX.length) : `${AWAITING_PAYMENT_PREFIX}${note}`;
    if (next.length > RESERVATION_NOTE_MAX) { setError(`Note would exceed ${RESERVATION_NOTE_MAX} characters.`); return; }
    if (summaryKey) dismiss();
    commit(next);
  };
  const applyPreset = () => {
    const chosen = RESERVATION_NOTE_PRESETS.find(item => item.id === preset);
    if (!chosen) return;
    const next = `${waiting ? AWAITING_PAYMENT_PREFIX : ''}${chosen.text}`;
    if (next.length > RESERVATION_NOTE_MAX) { setError(`Preset would exceed ${RESERVATION_NOTE_MAX} characters.`); return; }
    if (summaryKey) dismiss();
    commit(next);
  };
  return <div data-field-path={path} className={styles.noteEditor}>
    <div className={styles.fieldLabel}><label htmlFor={id}>Reservation Note</label><FieldReview editor={editor} path={path} label="Reservation Note" onPendingChange={setReviewing} disabled={disabled} /></div>
    <textarea id={id} value={note} disabled={disabled || reviewing} onChange={event => {
      if (summaryKey) dismiss();
      const next = event.target.value; ++version.current; setNote(next); setDirty(true); setError('');
      editor.commands.setUncommitted(path, next.length > RESERVATION_NOTE_MAX);
      if (next.length <= RESERVATION_NOTE_MAX) editor.commands.stageEdit(path, next, editor.request.kind === 'create' && !next ? 'none' : 'set');
    }} onBlur={() => { if (dirty) commit(note); }} />
    {showSummary && <div role="note">
      {summary.sourceClauses.map((clause, index) => <small key={`${index}:${clause.text}`}>Source: {clause.text}</small>)}
      {summary.conflicts.map(conflict => <small key={conflict}>{conflict}</small>)}
      {summary.compositionStatus === 'over_limit' && <small>Combined note exceeds {RESERVATION_NOTE_MAX} characters.</small>}
      {summary.compositionStatus === 'blocked_none' && <small>Note marked none; memory was not applied.</small>}
      {summary.memory.map(item => <div key={item.kind}><small>History {item.kind}: {item.value} · {item.support}/{item.denominator} · {Math.round(item.purity * 100)}%
        {item.autoApplied ? ' · Applied' : item.blockedReason ? ` · ${item.blockedReason.replaceAll('_', ' ')}` : ' · Review'}</small>
        {item.text && !item.autoApplied && <button type="button" disabled={disabled || reviewing || editor.view.busy || dirty || Boolean(explicitlyNone) ||
          summary.compositionStatus !== 'clean' || item.blockedReason === 'source_conflict'} onClick={() => {
            if (dirty || explicitlyNone || note !== saved) return;
            const next = [note, item.text].filter(Boolean).join('\n');
            if (next.length > RESERVATION_NOTE_MAX) { setError(`Note would exceed ${RESERVATION_NOTE_MAX} characters.`); return; }
            dismiss(); commit(next);
          }}>Add {item.kind} suggestion</button>}</div>)}
      {(summary.sourceClauses.length > 0 || summary.memory.length > 0 || summary.conflicts.length > 0) &&
        <button type="button" onClick={dismiss}>Dismiss note guidance</button>}
    </div>}
    <div className={styles.noteActions}>
      <label><input type="checkbox" checked={waiting} disabled={disabled || reviewing || editor.view.busy} onChange={toggleWaiting} /> Awaiting payment</label>
      <select aria-label="Reservation Note preset" value={preset} disabled={disabled || reviewing} onChange={event => setPreset(event.target.value)}>
        <option value="">Choose preset…</option>{RESERVATION_NOTE_PRESETS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      <button type="button" disabled={!preset || disabled || reviewing || editor.view.busy} onClick={applyPreset}>Replace note with preset</button>
    </div>
    <small>{note.length}/{RESERVATION_NOTE_MAX} characters. Preset replaces the note; the payment prefix is retained.</small>
    {(error || note.length > RESERVATION_NOTE_MAX) && <small role="alert">{error || `Shorten the note to ${RESERVATION_NOTE_MAX} characters before saving.`}</small>}
  </div>;
}
