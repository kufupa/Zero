'use client';

import { useEffect, useId, useState } from 'react';
import { nativeChoices, partialNativeLeads, record, text, valueAt, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import styles from '../reservation-pane.module.css';
import { FieldReview, FieldSource } from './stay-fields';

/** One editable code/identity search with persistent access to native alternatives. */
export function NativePicker({ label, path, editor, kind, allowNone = false, compact = false, hint, disabled = false }: {
  label: string; path: string; editor: WorkbenchEditorProps; kind?: string; allowNone?: boolean; compact?: boolean; hint?: string; disabled?: boolean;
}) {
  const id = useId();
  const party = /\/(bookingAgency|organization|arAccount|agency|company)$/.test(path);
  const entity = party || path.endsWith('/nativeSelectionRef');
  const selectionPath = party ? `${path}/nativeSelectionRef` : path;
  const guestPath = !party && entity ? path.replace(/\/nativeSelectionRef$/, '') : null;
  const inputPath = party ? `${path}/name` : guestPath ? `${guestPath}/lastName` : path;
  // HMS guest search is by surname. Keep first name separate; a name's last
  // token is not necessarily its surname (for example, "van der Merwe").
  const saved = party ? text(valueAt(editor.snapshot, `${path}/name`)) : text(valueAt(editor.snapshot, inputPath));
  const choiceKind = kind ?? (party ? 'party_candidate' : undefined);
  const choices = nativeChoices(editor.snapshot, entity ? selectionPath : path, choiceKind);
  const [query, setQuery] = useState(saved);
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const leads = entity && (!dirty || normalized(query) === normalized(saved))
    ? partialNativeLeads(editor.snapshot, selectionPath, choiceKind) : [];
  useEffect(() => { if (!dirty) setQuery(saved); }, [saved, dirty]);
  const editValue = (value: string) => party ? { name: value, candidateRefs: [], suggestedRef: null } : value;
  const editPath = party ? path : inputPath;
  const choose = async (ref: string, value: string) => {
    try { if (entity) await editor.commands.selectNative(selectionPath, ref); else await editor.commands.edit(path, value); setDirty(false); setOpen(false); setActiveIndex(-1); }
    catch { /* controller retains failure */ }
  };
  const saveSearch = async () => {
    if (!dirty) return;
    await editor.commands.edit(editPath, editValue(query));
    setDirty(false);
  };
  const visible = choices.filter(row => !query || `${row.value} ${row.label} ${row.detail ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const shown = visible.length ? visible : choices;
  const selectionOverride = editor.snapshot.session.draft.fieldOverrides[selectionPath];
  const selectedRef = entity ? selectionOverride && selectionOverride.state !== 'inherit'
    ? valueAt(editor.snapshot, selectionPath)
    : valueAt(editor.snapshot, selectionPath) ?? (party ? record(valueAt(editor.snapshot, path)).suggestedRef : valueAt(editor.snapshot, `${guestPath}/suggestedRef`)) : null;
  const selectedChoice = choices.find(row => entity ? row.ref === selectedRef : row.value === saved);
  const display = dirty || open ? query : guestPath
    ? selectedChoice?.label || [text(valueAt(editor.snapshot, `${guestPath}/firstName`)), saved].filter(Boolean).join(' ')
    : !entity && selectedChoice && selectedChoice.label !== saved ? `${saved} — ${selectedChoice.label}` : query;
  return <div className={`${styles.field} ${compact ? styles.compactField : ''}`}><div className={styles.fieldLabel}><label htmlFor={id}>{label}</label>{!compact && <FieldSource editor={editor} path={path} label={label} />}</div><div className={`${styles.picker} ${styles.controlSlot}`}>
    <div className={styles.pickerInput}><input id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-options`} aria-autocomplete="list"
      aria-activedescendant={open && activeIndex >= 0 && shown[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
      value={display} disabled={disabled || reviewing} onFocus={() => setOpen(true)} placeholder={guestPath ? 'Surname to find in Infor' : allowNone ? 'None / find in Infor' : 'Code or search'} onChange={event => {
        const value = event.target.value; setQuery(value); setDirty(true); setOpen(true); setActiveIndex(-1);
        editor.commands.stageEdit(editPath, editValue(value));
      }}
      onBlur={() => { void saveSearch().catch(() => {}); }} onKeyDown={event => {
        if (event.key === 'Escape') { setOpen(false); setActiveIndex(-1); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(true);
          setActiveIndex(index => shown.length ? (event.key === 'ArrowDown' ? Math.min(index + 1, shown.length - 1) : index < 0 ? shown.length - 1 : Math.max(0, index - 1)) : -1);
        }
        if (event.key === 'Enter') { event.preventDefault(); const row = open && (shown[activeIndex] ?? (visible.length === 1 ? visible[0] : undefined));
          if (row) void choose(row.ref, row.value); else void saveSearch().catch(() => {}); }
      }} />
      <button type="button" aria-label={`Show ${label} choices`} disabled={disabled || reviewing} onMouseDown={event => event.preventDefault()} onClick={() => setOpen(!open)}>⌄</button></div>
    {open && !disabled && <div id={`${id}-options`} role="listbox" className={styles.options}>
      {allowNone && <button type="button" role="option" aria-selected={!query} onMouseDown={event => event.preventDefault()} onClick={() => { void editor.commands.edit(party ? path : inputPath, null, 'none').then(() => { setQuery(''); setDirty(false); setOpen(false); }).catch(() => {}); }}>None</button>}
      {shown.map((row, index) => <button id={`${id}-option-${index}`} key={`${row.ref}:${row.value}`} type="button" role="option" aria-selected={entity ? selectedRef === row.ref : saved === row.value}
        onMouseDown={event => event.preventDefault()} onClick={() => { void choose(row.ref, row.value); }}><strong>{row.value}</strong>{row.label !== row.value && <span> — {row.label}</span>}{row.detail && <small>{row.detail}</small>}</button>)}
      {leads.length > 0 && <div role="note"><small><strong>Unverified Infor leads</strong> · Search Infor to verify before selecting.</small>
        {leads.map(lead => <small key={lead}>{lead}</small>)}</div>}
      {!choices.length && <small>Find options in Infor to load native choices.</small>}
      <button type="button" onClick={() => { void saveSearch().then(() => editor.commands.lookup()).catch(() => {}); }}>Search Infor</button>
    </div>}
  {dirty ? <small>Unsaved search</small> : entity && !selectedRef && query ? <small>Select an Infor match</small> : null}{hint && <small>{hint}</small>}</div>
    {compact && <FieldReview editor={editor} path={path} label={label} onPendingChange={pending => { setReviewing(pending); if (pending) setOpen(false); }} />}</div>;
}
