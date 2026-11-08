'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { text, valueAt, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import styles from '../reservation-pane.module.css';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.section}><h3>{title}</h3>{children}</section>;
}

export function Field({ label, path, editor, type = 'text', options, disabled, hint }: {
  label: string; path: string; editor: WorkbenchEditorProps; type?: string;
  options?: { value: string; label: string }[]; disabled?: boolean; hint?: string;
}) {
  const id = useId();
  const saved = valueAt(editor.snapshot, path);
  const [local, setLocal] = useState(text(saved));
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setLocal(text(saved)); }, [saved, dirty]);
  const save = async () => {
    if (!dirty) return;
    const value = type === 'number' ? local === '' ? null : Number(local) : local;
    try { await editor.commands.edit(path, value); setDirty(false); } catch { /* keep unsaved input */ }
  };
  const onChange = (value: string) => { setLocal(value); setDirty(true); editor.commands.stageEdit(path, type === 'number' ? value === '' ? null : Number(value) : value); };
  return <div className={styles.field}><label htmlFor={id}>{label}</label>
    {type === 'checkbox' ? <input id={id} type="checkbox" checked={saved === true} disabled={disabled || editor.view.busy}
      onChange={event => { void editor.commands.edit(path, event.target.checked).catch(() => {}); }} />
      : options ? <select id={id} value={local} disabled={disabled} onChange={event => { const value = event.target.value; setLocal(value); void editor.commands.edit(path, value).catch(() => setDirty(true)); }}>
        <option value="">Choose…</option>{local && !options.some(option => option.value === local) && <option value={local}>{local}</option>}{options.filter(option => option.value).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      : type === 'textarea' ? <textarea id={id} value={local} disabled={disabled} onChange={event => onChange(event.target.value)} onBlur={() => { void save(); }} />
      : <input id={id} type={type} value={local} disabled={disabled} onChange={event => onChange(event.target.value)} onBlur={() => { void save(); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />}
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
