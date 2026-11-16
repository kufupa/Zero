'use client';

import { useId, useState } from 'react';
import { effectiveAt, record, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import styles from '../reservation-pane.module.css';

/** Auto-pick suggestion contract v1 (server observation `criteria.kind === 'autopick_suggestion'`). */
export type AutopickEvidence = { kind: string; count: number | null; total: number | null; lastSeen: string | null; key?: string; quote?: string };
export type AutopickOption = { ref: string; label: string; count: number | null; total: number | null };
export type AutopickSuggestion = {
  observationRef: string; sourceRefs: string[]; ref: string; value: string; label: string;
  confidence: 'usual' | 'check'; reason: string; evidence: AutopickEvidence[]; alternatives: AutopickOption[];
};

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const words = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/** The host-written suggestion for one field, or null (the field then behaves as before). */
export function autopickSuggestion(snapshot: WorkbenchEditorProps['snapshot'], requestId: string, selectionPath: string): AutopickSuggestion | null {
  const draft = snapshot.session.draft;
  const row = draft.observations.findLast(observation => observation.criteria.kind === 'autopick_suggestion' &&
    observation.criteria.selectionPath === selectionPath && observation.criteria.requestId === requestId &&
    observation.generationId === draft.generationId && observation.propertyCode === draft.propertyCode &&
    observation.sourceMessageId === draft.source.messageId && observation.status === 'complete');
  const result = record(row?.result);
  const confidence = result.confidence === 'usual' || result.confidence === 'check' ? result.confidence : null;
  const evidence = (Array.isArray(result.evidence) ? result.evidence : []).map(record).filter(entry => words(entry.kind))
    .map(entry => ({ kind: words(entry.kind), count: count(entry.count), total: count(entry.total),
      lastSeen: words(entry.lastSeen) || null, ...(words(entry.key) ? { key: words(entry.key) } : {}),
      ...(words(entry.quote) ? { quote: words(entry.quote) } : {}) }));
  if (!row || !confidence || !words(result.label) || typeof result.value !== 'string' || typeof result.ref !== 'string' || !evidence.length) return null;
  const alternatives = (Array.isArray(result.alternatives) ? result.alternatives : []).map(record)
    .filter(entry => words(entry.ref) && words(entry.label) && entry.ref !== result.ref).slice(0, 5)
    .map(entry => ({ ref: words(entry.ref), label: words(entry.label), count: count(entry.count), total: count(entry.total) }));
  return { observationRef: row.ref, sourceRefs: row.sourceRefs, ref: result.ref, value: result.value, label: words(result.label),
    confidence, reason: words(result.reason), evidence, alternatives };
}

function day(iso: string | null): string {
  const time = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short',
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

function ratio(row: { count: number | null; total: number | null }): string {
  return row.count === null ? '' : row.total === null ? `${row.count}` : `${row.count} of ${row.total}`;
}

/** Plain-language evidence line. Numbers come only from the payload. */
export function evidenceSentence(row: AutopickEvidence): string {
  const numbers = ratio(row), last = day(row.lastSeen);
  const history = (who: string) => `${numbers ? `${numbers} past bookings` : 'Past bookings'} ${who}${last ? `, last on ${last}` : ''}`;
  switch (row.kind) {
    case 'sender_history': return history(row.key ? `from ${row.key}` : 'from this sender');
    case 'company_history': return history(row.key ? `for ${row.key}` : 'for this company');
    case 'agency_domain': return history(row.key ? `from ${row.key}` : 'from this email domain');
    case 'email_text': return row.quote ? `Named in this email: “${row.quote}”` : 'Named in this email';
    case 'model_choice': return row.quote ? `Matched to this email text: “${row.quote}”` : 'Matched to the email text';
    case 'attachment': return 'Proof of payment or voucher attached';
    case 'policy_default': return 'Hotel default for email bookings';
    default: return numbers ? `${numbers} past bookings` : 'Earlier bookings';
  }
}

/**
 * Below an auto-picked field: the usual/check mark, a "Why" expander with evidence and up to five ranked
 * alternatives, and a Read tick. There is no reject control: staff who disagree change the value, and the
 * edit trace records it.
 */
export function AutopickPanel({ editor, suggestion, selectionPath, changed, onChoose, onPendingChange, disabled = false, label }: {
  editor: WorkbenchEditorProps; suggestion: AutopickSuggestion; selectionPath: string; label: string;
  /** True when staff set this field themselves. */ changed: boolean;
  onChoose: (option: { ref: string; label: string }) => Promise<void>;
  onPendingChange?: (pending: boolean) => void; disabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const draft = editor.snapshot.session.draft;
  const accepted = draft.staffReviews[selectionPath]?.status === 'accepted';
  const busy = disabled || pending || editor.view.busy;
  const choose = async (option: { ref: string; label: string }) => {
    setPending(true); onPendingChange?.(true);
    try { await onChoose(option); } catch { /* the workbench shows the failure */ }
    finally { setPending(false); onPendingChange?.(false); }
  };
  const tick = () => {
    setPending(true); onPendingChange?.(true);
    const guardPath = selectionPath.endsWith('/nativeSelectionRef') ? selectionPath.slice(0, -'/nativeSelectionRef'.length) : selectionPath;
    const expected = { path: guardPath, value: effectiveAt(editor.snapshot, guardPath), generationId: draft.generationId };
    void editor.commands.acceptServiceReview(selectionPath, `Read Nava pick ${suggestion.observationRef}`, expected)
      .catch(() => {}).finally(() => { setPending(false); onPendingChange?.(false); });
  };
  const emailRef = editor.onOpenEvidence ? suggestion.sourceRefs[0] : undefined;
  const mark = suggestion.confidence;
  return <div className={styles.autopick} data-autopick={mark}>
    <div className={styles.autopickBar}>
      <span className={styles.autopickMark}>{mark === 'usual' ? 'Usual choice' : 'Check this'}</span>
      <button type="button" className={styles.autopickWhy} aria-expanded={open} aria-controls={`${id}-why`}
        onClick={() => setOpen(value => !value)}>Why {open ? '▴' : '▾'}</button>
      {!changed && <label className={styles.autopickTick} title={accepted ? 'Marked as read' : `Tick when you have read ${label}`}>
        <input type="checkbox" aria-label={`Read ${label}`} checked={accepted} disabled={accepted || busy}
          onChange={event => { if (event.target.checked) tick(); }} />Read</label>}
    </div>
    {open && <div id={`${id}-why`} className={styles.autopickBody}>
      <p><strong>{suggestion.label}</strong></p>
      {suggestion.reason && <p>{suggestion.reason}</p>}
      <ul>{suggestion.evidence.map((row, index) => <li key={`${row.kind}:${index}`}>{evidenceSentence(row)}
        {(row.kind === 'email_text' || row.kind === 'model_choice') && emailRef && <> <button type="button" className={styles.autopickLink}
          onClick={() => editor.onOpenEvidence?.(emailRef)}>Show</button></>}</li>)}</ul>
      {suggestion.alternatives.length > 0 && <div role="group" aria-label={`Other ${label} choices`} className={styles.autopickOptions}>
        <small>Other choices</small>
        {suggestion.alternatives.map(option => <button key={option.ref} type="button" disabled={busy}
            onClick={() => { void choose(option); }}>
            <span>{option.label}</span>
            <small>{ratio(option) ? `${ratio(option)} bookings` : ''}</small>
          </button>)}
      </div>}
    </div>}
  </div>;
}
