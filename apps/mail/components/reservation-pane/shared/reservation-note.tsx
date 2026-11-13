'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { AWAITING_PAYMENT_PREFIX, RESERVATION_NOTE_MAX, RESERVATION_NOTE_PRESETS } from '../../../../server-pilot/src/ai/reservation-note-presets.js';
import { text, valueAt, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { FieldReview } from './stay-fields';
import styles from '../reservation-pane.module.css';

/** Presets replace text only when staff explicitly applies one. */
export function ReservationNote({ path, editor, disabled = false }: { path: string; editor: WorkbenchEditorProps; disabled?: boolean }) {
  const id = useId();
  const saved = text(valueAt(editor.snapshot, path));
  const [note, setNote] = useState(saved);
  const [preset, setPreset] = useState('');
  const [dirty, setDirty] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState('');
  const version = useRef(0);
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
    commit(next);
  };
  const applyPreset = () => {
    const chosen = RESERVATION_NOTE_PRESETS.find(item => item.id === preset);
    if (!chosen) return;
    const next = `${waiting ? AWAITING_PAYMENT_PREFIX : ''}${chosen.text}`;
    if (next.length > RESERVATION_NOTE_MAX) { setError(`Preset would exceed ${RESERVATION_NOTE_MAX} characters.`); return; }
    commit(next);
  };
  return <div data-field-path={path} className={styles.noteEditor}>
    <div className={styles.fieldLabel}><label htmlFor={id}>Reservation Note</label><FieldReview editor={editor} path={path} label="Reservation Note" onPendingChange={setReviewing} disabled={disabled} /></div>
    <textarea id={id} value={note} disabled={disabled || reviewing} onChange={event => {
      const next = event.target.value; ++version.current; setNote(next); setDirty(true); setError('');
      editor.commands.setUncommitted(path, next.length > RESERVATION_NOTE_MAX);
      if (next.length <= RESERVATION_NOTE_MAX) editor.commands.stageEdit(path, next, editor.request.kind === 'create' && !next ? 'none' : 'set');
    }} onBlur={() => { if (dirty) commit(note); }} />
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
