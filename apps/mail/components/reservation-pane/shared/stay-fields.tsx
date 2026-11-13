'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { effectiveAt, text, valueAt, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import styles from '../reservation-pane.module.css';

function hasStaffOverride(editor: WorkbenchEditorProps, path: string) {
  return Object.entries(editor.snapshot.session.draft.fieldOverrides).some(([key, value]) =>
    (path === key || path.startsWith(`${key}/`)) && value.state !== 'inherit');
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.section}><h3>{title}</h3>{children}</section>;
}

export function FieldSource({ editor, path, label }: { editor: WorkbenchEditorProps; path: string; label: string }) {
  const draft = editor.snapshot.session.draft;
  if (!editor.onOpenEvidence || hasStaffOverride(editor, path)) return null;
  const claim = draft.proposal.sourceClaims.find(row => row.path === path);
  const refs = claim?.sourceRefs ?? draft.fieldReviewRequirements[path]?.evidenceRefs;
  const reference = refs?.find(ref => draft.observations.some(row => row.kind === 'source' && row.sourceRefs.includes(ref)));
  if (!reference) return null;
  return <button type="button" className={styles.fieldSource} aria-label={`View source for ${label}`}
    title={claim?.raw || 'View source suggestion'} onClick={() => editor.onOpenEvidence?.(reference)}>✦</button>;
}

/** Acknowledgement is stored against the displayed draft field, not local UI state. */
export function FieldReview({ editor, path, label, onPendingChange, requireReview = false, disabled = false }: { editor: WorkbenchEditorProps; path: string; label: string; onPendingChange?: (pending: boolean) => void; requireReview?: boolean; disabled?: boolean }) {
  const [peek, setPeek] = useState(false);
  const peekRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!peek) return;
    const fit = () => {
      const popup = peekRef.current;
      if (!popup) return;
      const pane = popup.closest('[data-reservation-pane]')?.getBoundingClientRect();
      const left = Math.max(0, pane?.left ?? 0), right = Math.min(window.innerWidth, pane?.right ?? window.innerWidth);
      popup.style.width = `${Math.max(0, Math.min(292, right - left - 24))}px`;
      popup.style.transform = '';
      const bounds = popup.getBoundingClientRect();
      const shift = bounds.left < left + 12 ? left + 12 - bounds.left : bounds.right > right - 12 ? right - 12 - bounds.right : 0;
      if (shift) popup.style.transform = `translateX(${shift}px)`;
    };
    const pane = peekRef.current?.closest('[data-reservation-pane]');
    const observer = pane && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    if (pane) observer?.observe(pane);
    fit(); window.addEventListener('resize', fit);
    return () => { observer?.disconnect(); window.removeEventListener('resize', fit); };
  }, [peek]);
  const draft = editor.snapshot.session.draft;
  const claim = draft.proposal.sourceClaims.find(row => row.path === path);
  const refs = claim?.sourceRefs ?? draft.fieldReviewRequirements[path]?.evidenceRefs;
  const reference = refs?.find(ref => draft.observations.some(row => row.kind === 'source' && row.sourceRefs.includes(ref)));
  const value = effectiveAt(editor.snapshot, path);
  if (hasStaffOverride(editor, path)) return null;
  if (!reference && (!requireReview || value == null || value === '' || draft.fieldReviewRequirements[path]?.required === false)) return null;
  const accepted = draft.staffReviews[path]?.status === 'accepted' || draft.fieldReviewRequirements[path]?.required === false;
  const excerpt = claim?.raw?.trim() ?? '';
  const showSource = async () => {
    try {
      const input = new TextEncoder().encode(`${editor.source.messageId}\u001fmessage\u001f${editor.source.messageId}`);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
      const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const body = editor.source.sourceText ?? '';
      if (reference === `src_${hex.slice(0, 12)}` && excerpt && body.includes(excerpt)) { setPeek(true); return; }
    } catch { /* Open the host evidence view instead. */ }
    if (reference) editor.onOpenEvidence?.(reference);
  };
  return <span className={styles.fieldReview}>
    {reference && <button type="button" className={styles.fieldSource} aria-label={`View source for ${label}`} title="View source suggestion"
      onClick={() => { void showSource(); }}>✦</button>}
    {!accepted && draft.fieldReviewRequirements[path]?.required === true && <span className={styles.reviewRequired} title="Review required" aria-hidden="true">*</span>}
    <input type="checkbox" aria-label={`Confirm ${label}`} checked={accepted} disabled={disabled || accepted || editor.view.busy}
      onChange={event => {
        if (!event.target.checked) return;
        onPendingChange?.(true);
        const guardPath = path.endsWith('/nativeSelectionRef') ? path.slice(0, -'/nativeSelectionRef'.length) : path;
        const expected = { path: guardPath, value: effectiveAt(editor.snapshot, guardPath), generationId: draft.generationId };
        void editor.commands.acceptServiceReview(path, 'Reviewed by staff', expected).catch(() => {}).finally(() => onPendingChange?.(false));
      }} />
    {peek && <span ref={peekRef} className={styles.sourcePeek} role="dialog" aria-label={`Source for ${label}`}>
      <span className={styles.peekHeading}>From the email <button type="button" aria-label="Close source" onClick={() => setPeek(false)}>×</button></span>
      <span className={styles.peekText}>{excerpt.length > 350 ? `${excerpt.slice(0, 350)}…` : excerpt}</span>
      <button type="button" className={styles.peekOpen} onClick={() => { setPeek(false); if (reference) editor.onOpenEvidence?.(reference); }}>Open email</button>
    </span>}
  </span>;
}

export function Field({ label, path, editor, type = 'text', options, disabled, hint, defaultValue, emptyState, resolvedValue, compact = false, review = false, requireReview = false, unmatchedOptionLabel, maxLength }: {
  label: string; path: string; editor: WorkbenchEditorProps; type?: string;
  options?: { value: string; label: string }[]; disabled?: boolean; hint?: string; defaultValue?: string; emptyState?: 'inherit'; resolvedValue?: unknown; compact?: boolean; review?: boolean; requireReview?: boolean; unmatchedOptionLabel?: string; maxLength?: number;
}) {
  const id = useId();
  const saved = resolvedValue === undefined ? valueAt(editor.snapshot, path) : resolvedValue;
  const savedText = type === 'string-list' && Array.isArray(saved)
    ? saved.filter((item): item is string => typeof item === 'string').join('\n') : text(saved);
  const [local, setLocal] = useState(savedText);
  const [dirty, setDirty] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const version = useRef(0);
  useEffect(() => { if (!dirty) setLocal(savedText); }, [savedText, dirty]);
  const clearedCreateOptional = (value: unknown) => editor.request.kind === 'create' && value === ''
    && /\/(?:bookerName|bookerEmail|bookerMobile|billingReference|reservationNote|cmsRecipient)$/.test(path);
  const parsedValue = (value: string) => type === 'string-list' ? value.split(/[\n,]/u).map(item => item.trim()).filter(Boolean)
    : type === 'number' ? value === '' ? null : Number(value)
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
  return <div data-field-path={path} className={`${styles.field} ${compact ? styles.compactField : ''}`}><div className={styles.fieldLabel}><label htmlFor={id}>{label}</label>{!compact && (review ? <FieldReview editor={editor} path={path} label={label} onPendingChange={setReviewing} requireReview={requireReview} disabled={disabled} /> : <FieldSource editor={editor} path={path} label={label} />)}</div>
    <div className={styles.controlSlot}>
    {type === 'checkbox' ? <input id={id} type="checkbox" checked={saved === true} disabled={disabled || reviewing || editor.view.busy}
      onChange={event => { void editor.commands.edit(path, event.target.checked).catch(() => {}); }} />
      : options ? <select id={id} value={local} disabled={disabled || reviewing} onChange={event => { const value = event.target.value; setLocal(value); void editor.commands.edit(path, value).catch(() => setDirty(true)); }}>
        <option value="">Choose…</option>{local && !options.some(option => option.value === local) && <option value={local} disabled={Boolean(unmatchedOptionLabel)}>{local}{unmatchedOptionLabel ? ` · ${unmatchedOptionLabel}` : ''}</option>}{options.filter(option => option.value).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      : type === 'textarea' || type === 'string-list' ? <textarea id={id} value={local} maxLength={maxLength} disabled={disabled || reviewing} onChange={event => onChange(event.target.value)} onBlur={() => { void save(); }} />
      : <input id={id} type={type} value={local} maxLength={maxLength} placeholder={defaultValue} disabled={disabled || reviewing} onChange={event => onChange(event.target.value)} onBlur={() => { void save(); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />}
    {type === 'date' && local && !/^\d{4}-\d{2}-\d{2}$/.test(local) && <small>Requested: {local}. Choose the full date above.</small>}
    {dirty && <span className={styles.small}>Unsaved</span>}{hint && <small>{hint}</small>}</div>
    {compact && <FieldReview editor={editor} path={path} label={label} onPendingChange={setReviewing} requireReview={requireReview} disabled={disabled} />}
  </div>;
}

export function Count({ label, path, editor, min = 0, max = 12, review = false, asSelect = false }: { label: string; path: string; editor: WorkbenchEditorProps; min?: number; max?: number; review?: boolean; asSelect?: boolean }) {
  const [reviewing, setReviewing] = useState(false);
  const value = valueAt(editor.snapshot, path);
  const numeric = typeof value === 'number' ? value : null;
  const change = (next: number) => { void editor.commands.edit(path, Math.max(min, Math.min(max, next))).catch(() => {}); };
  return <div data-field-path={path} className={styles.field}><div className={styles.fieldLabel}><label>{label}</label>{review && <FieldReview editor={editor} path={path} label={label} onPendingChange={setReviewing} />}</div>{asSelect
    ? <select aria-label={label} value={numeric ?? ''} disabled={reviewing || editor.view.busy} onChange={event => { if (event.target.value !== '') change(Number(event.target.value)); }}>
      <option value="">Choose…</option>{numeric !== null && (numeric < min || numeric > max) && <option value={numeric}>{numeric}</option>}
      {Array.from({ length: max - min + 1 }, (_, i) => min + i).map(option => <option key={option} value={option}>{option}</option>)}
    </select> : <div className={styles.stepper}>
    <button type="button" aria-label={`Decrease ${label}`} disabled={reviewing || numeric === null || numeric <= min || editor.view.busy} onClick={() => change((numeric ?? min) - 1)}>−</button>
    <input aria-label={label} type="number" min={min} max={max} value={numeric ?? ''} placeholder="?" disabled={reviewing} onChange={event => { const next = Number(event.target.value); if (event.target.value !== '' && Number.isInteger(next)) change(next); }} />
    <button type="button" aria-label={`Increase ${label}`} disabled={reviewing || numeric !== null && numeric >= max || editor.view.busy} onClick={() => change((numeric ?? min - 1) + 1)}>+</button>
  </div>}</div>;
}
