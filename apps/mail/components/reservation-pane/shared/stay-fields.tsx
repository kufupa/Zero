'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { text, valueAt, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import styles from '../reservation-pane.module.css';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.section}><h3>{title}</h3>{children}</section>;
}

export function FieldSource({ editor, path, label }: { editor: WorkbenchEditorProps; path: string; label: string }) {
  const draft = editor.snapshot.session.draft;
  if (!editor.onOpenEvidence || draft.fieldOverrides[path]?.state && draft.fieldOverrides[path]?.state !== 'inherit') return null;
  const claim = draft.proposal.sourceClaims.find(row => row.path === path);
  const refs = claim?.sourceRefs ?? draft.fieldReviewRequirements[path]?.evidenceRefs;
  const reference = refs?.find(ref => draft.observations.some(row => row.kind === 'source' && row.sourceRefs.includes(ref)));
  if (!reference) return null;
  return <button type="button" className={styles.fieldSource} aria-label={`View source for ${label}`}
    title={claim?.raw || 'View source suggestion'} onClick={() => editor.onOpenEvidence?.(reference)}>✦</button>;
}

export function Field({ label, path, editor, type = 'text', options, disabled, hint, defaultValue, emptyState }: {
  label: string; path: string; editor: WorkbenchEditorProps; type?: string;
  options?: { value: string; label: string }[]; disabled?: boolean; hint?: string; defaultValue?: string; emptyState?: 'inherit';
}) {
  const id = useId();
  const saved = valueAt(editor.snapshot, path);
  const [local, setLocal] = useState(text(saved));
  const [dirty, setDirty] = useState(false);
  const version = useRef(0);
  useEffect(() => { if (!dirty) setLocal(text(saved)); }, [saved, dirty]);
  const clearedCreateOptional = (value: unknown) => editor.request.kind === 'create' && value === ''
    && /\/(?:bookerName|bookerContact|billingReference|reservationNote|cmsRecipient)$/.test(path);
  const parsedValue = (value: string) => type === 'number' ? value === '' ? null : Number(value)
    : value === '' && defaultValue ? defaultValue : value;
  const stateFor = (raw: string, value: unknown) => raw === '' && emptyState ? emptyState
    : clearedCreateOptional(value) ? 'none' as const : 'set' as const;
  const save = async () => {
    if (!dirty) return;
    const value = parsedValue(local), before = version.current;
    try { await editor.commands.edit(path, value, stateFor(local, value)); if (version.current === before) setDirty(false); } catch { /* keep unsaved input */ }
  };
  const onChange = (value: string) => {
    version.current += 1; setLocal(value); setDirty(true); const parsed = parsedValue(value);
    editor.commands.stageEdit(path, parsed, stateFor(value, parsed));
  };
  return <div className={styles.field}><div className={styles.fieldLabel}><label htmlFor={id}>{label}</label><FieldSource editor={editor} path={path} label={label} /></div>
    {type === 'checkbox' ? <input id={id} type="checkbox" checked={saved === true} disabled={disabled || editor.view.busy}
      onChange={event => { void editor.commands.edit(path, event.target.checked).catch(() => {}); }} />
      : options ? <select id={id} value={local} disabled={disabled} onChange={event => { const value = event.target.value; setLocal(value); void editor.commands.edit(path, value).catch(() => setDirty(true)); }}>
        <option value="">Choose…</option>{local && !options.some(option => option.value === local) && <option value={local}>{local}</option>}{options.filter(option => option.value).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      : type === 'textarea' ? <textarea id={id} value={local} disabled={disabled} onChange={event => onChange(event.target.value)} onBlur={() => { void save(); }} />
      : <input id={id} type={type} value={local} placeholder={defaultValue} disabled={disabled} onChange={event => onChange(event.target.value)} onBlur={() => { void save(); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />}
    {dirty && <span className={styles.small}>Unsaved</span>}{hint && <small>{hint}</small>}
  </div>;
}

export function Count({ label, path, editor, min = 0, max = 12 }: { label: string; path: string; editor: WorkbenchEditorProps; min?: number; max?: number }) {
  const value = valueAt(editor.snapshot, path);
  const numeric = typeof value === 'number' ? value : null;
  const change = (next: number) => { void editor.commands.edit(path, Math.max(min, Math.min(max, next))).catch(() => {}); };
  return <div className={styles.field}><label>{label}</label><div className={styles.stepper}>
    <button type="button" aria-label={`Decrease ${label}`} disabled={numeric === null || numeric <= min || editor.view.busy} onClick={() => change((numeric ?? min) - 1)}>−</button>
    <input aria-label={label} type="number" min={min} max={max} value={numeric ?? ''} placeholder="?" onChange={event => { const next = Number(event.target.value); if (event.target.value !== '' && Number.isInteger(next)) change(next); }} />
    <button type="button" aria-label={`Increase ${label}`} disabled={numeric !== null && numeric >= max || editor.view.busy} onClick={() => change((numeric ?? min - 1) + 1)}>+</button>
  </div></div>;
}
