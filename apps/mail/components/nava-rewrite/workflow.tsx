'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { PaneField } from './field';
import type { PaneFieldProps } from './field';
import { PaneMessage, PaneSection } from './pane';
import type { FieldSpec, NativeDisplayRow, Proposal } from './wire';
import styles from './pane.module.css';

export type DraftValue = string | boolean;
type ReviewControl = { checked: boolean; actionLabel: string; disabled?: boolean };

export type WorkflowProps = {
  proposal: Proposal;
  // Caller retains drafts until the corresponding edit is acknowledged by the backend.
  drafts: Readonly<Record<string, DraftValue>>;
  onEdit: (path: string, value: DraftValue) => void;
  busy?: boolean;
  operationStartedAt?: number;
  reviews?: Readonly<Record<string, ReviewControl>>;
  onReview?: (path: string, checked: boolean) => void;
  onOpenArtifact?: (artifactId: string) => void;
};

export type WorkflowFooterProps = Pick<WorkflowProps, 'proposal' | 'drafts' | 'busy'> & {
  onStage?: () => void;
  onGo?: () => void;
  onReconcile?: () => void;
};

type Resolved = { kind: 'value'; value: unknown } | { kind: 'missing' } | { kind: 'invalid' };

function resolvePointer(root: unknown, path: string): Resolved {
  if (path === '') return { kind: 'value', value: root };
  if (!path.startsWith('/')) return { kind: 'invalid' };
  let value: unknown = root;
  for (const encoded of path.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(encoded)) return { kind: 'invalid' };
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (key === 'native_result' || key === 'readback' || key === 'current_state') return { kind: 'invalid' };
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return { kind: 'invalid' };
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index >= value.length) return { kind: 'missing' };
      value = value[index];
    } else if (value !== null && typeof value === 'object') {
      const entry = Object.entries(value).find(([name]) => name === key);
      if (!entry) return { kind: 'missing' };
      value = entry[1];
    } else {
      return { kind: 'missing' };
    }
  }
  return { kind: 'value', value };
}

function isDateValue(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function NativeValue({ row }: { row: NativeDisplayRow }) {
  switch (row.kind) {
    case 'text': return <>{row.value === '' ? '(empty)' : row.value ?? 'Not provided'}</>;
    case 'code': return <>{row.code === '' ? '(empty)' : row.code ?? 'Code not provided'}{row.meaning && ` — ${row.meaning}`}</>;
    case 'money': return <>
      {row.amount === '' ? '(empty)' : row.amount ?? 'Amount not provided'} · {row.currency === '' ? '(empty)' : row.currency ?? 'Currency not provided'}
      {row.unit && ` / ${row.unit}`}{row.date && ` · ${row.date}`}
      {(row.basis === 'calculated' || !row.official) && <> · Not HMS payable total</>}
    </>;
    case 'availability': return <>
      {{ available: 'Available', unavailable: 'Unavailable', restricted: 'Restricted', unknown: 'Unknown' }[row.status]}
      {row.rooms_available !== null && ` · ${row.rooms_available} ${row.rooms_available === 1 ? 'room' : 'rooms'} available`}
    </>;
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

function NativeRows({ rows, proposal }: { rows: NativeDisplayRow[]; proposal: Proposal }) {
  return <dl className={styles.nativeRows}>{rows.map(row => {
    const index = row.booking_id === null ? -1 : proposal.bookings.findIndex(booking => booking.id === row.booking_id);
    const booking = index < 0 ? undefined : proposal.bookings[index];
    const context = row.booking_id === null ? null : booking
      ? `Stay ${index + 1}${booking.reservation_id ? ` · ${booking.reservation_id}` : ''}`
      : 'Stay reference unavailable';
    return <div className={styles.nativeRow} key={row.id}>
      <dt>{row.label}{context && <span>{context}</span>}</dt>
      <dd><NativeValue row={row} /></dd>
    </div>;
  })}</dl>;
}

function Field({ spec, proposal, drafts, onEdit, reviews, onReview, locked }: WorkflowProps & { spec: FieldSpec; locked: boolean }) {
  const resolved = resolvePointer(proposal, spec.path);
  if (resolved.kind === 'invalid') return <PaneMessage tone="error">{spec.label}: this value is unavailable. Refresh the proposal.</PaneMessage>;
  const value = resolved.kind === 'value' ? resolved.value : null;
  const hasDraft = Object.prototype.hasOwnProperty.call(drafts, spec.path);
  const draft = hasDraft ? drafts[spec.path] : undefined;
  const shown = hasDraft ? draft : value;
  const reviewControl = reviews?.[spec.path];
  const aiFilled = spec.provenance === 'ai' && !hasDraft && value !== null && value !== undefined && (typeof value !== 'string' || value.trim() !== '');
  const review: PaneFieldProps['review'] = !aiFilled ? undefined : reviewControl && onReview
    ? { provenance: 'ai', ...reviewControl, onChange: (checked: boolean) => onReview(spec.path, checked) }
    : { provenance: 'ai', kind: 'marker' };
  const hint = resolved.kind === 'missing' || value === null ? 'No saved value.' : undefined;
  const common = { label: spec.label, required: spec.required, disabled: locked || !spec.editable, error: spec.error, hint, review };
  let control: ReactNode;

  if (spec.control === 'checkbox') {
    if (shown === null || shown === undefined) {
      control = <PaneField {...common} control="select" value="" placeholder="Not provided" options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} onChange={next => { if (next) onEdit(spec.path, next === 'true'); }} />;
    } else if (typeof shown === 'boolean') {
      control = <PaneField {...common} control="checkbox" value={shown} onChange={next => onEdit(spec.path, next)} />;
    }
  } else if (spec.control === 'number') {
    if (shown === null || shown === undefined || typeof shown === 'number' || typeof shown === 'string' && hasDraft) {
      control = <PaneField {...common} control="number" value={shown === null || shown === undefined ? '' : String(shown)} onChange={next => onEdit(spec.path, next)} />;
    }
  } else if (shown === null || shown === undefined || typeof shown === 'string') {
    const text = shown ?? '';
    if (spec.control === 'select' || spec.control === 'combobox') {
      control = <PaneField {...common} control={spec.control} value={text} options={spec.options} onChange={next => onEdit(spec.path, next)} />;
    } else {
      const date = spec.control === 'date' && text && !isDateValue(text) ? 'text' : spec.control;
      control = <PaneField {...common} control={date} value={text} onChange={next => onEdit(spec.path, next)} />;
    }
  }

  return <div>
    {control ?? <PaneMessage>{spec.label}: value cannot be displayed or edited in this view. Check the source.</PaneMessage>}
    {spec.evidence.some(item => item.quote) && <details>
      <summary>Source for {spec.label}</summary>
      {spec.evidence.map((item, index) => item.quote && <p key={index} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.quote}</p>)}
    </details>}
  </div>;
}

function useLongWait(proposal: Proposal, operationStartedAt: number | undefined) {
  const [longWait, setLongWait] = useState(false);
  useEffect(() => {
    setLongWait(false);
    if (proposal.phase !== 'prefilling' && proposal.phase !== 'staging' && proposal.phase !== 'saving') return;
    const elapsed = operationStartedAt === undefined || !Number.isFinite(operationStartedAt)
      ? 0 : Math.max(0, Date.now() - operationStartedAt);
    const timer = window.setTimeout(() => setLongWait(true), Math.max(0, 30_000 - elapsed));
    return () => window.clearTimeout(timer);
  }, [proposal.id, proposal.phase, operationStartedAt]);
  return longWait;
}

function uncertain(proposal: Proposal) {
  return proposal.phase === 'uncertain' || proposal.error?.outcome === 'uncertain';
}

function errorMessage(proposal: Proposal) {
  if (uncertain(proposal)) return 'Infor has not confirmed the outcome. Check Infor before trying again.';
  const subject = {
    triage: 'email review', quote: 'quote request', create: 'reservation request',
    amend: 'change request', cancel: 'cancellation request', filing: 'document request',
  }[proposal.workflow];
  return `Nava couldn’t complete this ${subject}. Check the details.`;
}

export function Workflow(props: WorkflowProps) {
  const { proposal } = props;
  const longWait = useLongWait(proposal, props.operationStartedAt);
  const locked = props.busy || uncertain(proposal) || ['prefilling', 'staging', 'saving', 'done'].includes(proposal.phase);
  const phaseMessage = proposal.phase === 'prefilling' ? 'Nava is reading the email.'
    : proposal.phase === 'staging' ? 'Checking in Infor…'
    : proposal.phase === 'saving' ? 'Waiting for Infor and readback…' : null;
  const stageCurrent = proposal.stage?.revision === proposal.revision && Object.keys(props.drafts).length === 0;
  const dispositionMessage = {
    propose: null, needs_info: 'More information is needed.', decline: 'Marked for decline.',
    skip: 'No action needed.', staff_review: 'Needs review.',
  }[proposal.disposition];

  return <>
    {phaseMessage && <PaneMessage><span role="status">{phaseMessage}{longWait && ' This is taking longer than expected. Please wait.'}</span></PaneMessage>}
    {uncertain(proposal) && !proposal.error && <PaneMessage>Infor has not confirmed the outcome. Check Infor before trying again.</PaneMessage>}
    {proposal.error && <PaneMessage tone="error">{errorMessage(proposal)}</PaneMessage>}
    {dispositionMessage && <PaneMessage>{dispositionMessage}</PaneMessage>}
    {proposal.reason && <PaneMessage>{proposal.reason}</PaneMessage>}
    {proposal.missing.length > 0 && <PaneSection title="Information needed"><ul>{proposal.missing.map((item, index) => <li key={index}>{item}</li>)}</ul></PaneSection>}
    {proposal.warnings.length > 0 && <PaneSection title="Check these details"><ul>{proposal.warnings.map((item, index) => <li key={index}>{item}</li>)}</ul></PaneSection>}
    {proposal.field_specs.length > 0 && <PaneSection title="Details">{proposal.field_specs.map(spec => <Field key={spec.path} {...props} spec={spec} locked={locked} />)}</PaneSection>}
    {proposal.display_rows.length > 0 && <PaneSection title="Infor details"><NativeRows rows={proposal.display_rows} proposal={proposal} /></PaneSection>}
    {proposal.stage && <PaneSection title={stageCurrent ? 'Checked details' : 'Earlier check'}>
      {!stageCurrent && <p>Details have changed since this check.</p>}
      {proposal.stage.display_rows.length > 0 ? <NativeRows rows={proposal.stage.display_rows} proposal={proposal} /> : <p>No Infor details were provided for this check.</p>}
    </PaneSection>}
    {proposal.result && <PaneSection title="Infor result">
      {proposal.result.confirmation && <p>Confirmation: {proposal.result.confirmation}</p>}
      {proposal.result.reservation_id && <p>Reservation: {proposal.result.reservation_id}</p>}
      {proposal.result.display_rows.length > 0 && <NativeRows rows={proposal.result.display_rows} proposal={proposal} />}
      {proposal.result.artifacts.map(artifact => <p key={artifact.id}>{props.onOpenArtifact
        ? <button type="button" onClick={() => props.onOpenArtifact?.(artifact.id)}>{artifact.name}</button>
        : artifact.name}</p>)}
    </PaneSection>}
    {proposal.phase === 'done' && !proposal.result && <PaneMessage>No readback was provided. Refresh this proposal.</PaneMessage>}
    {proposal.reply_draft !== null && <PaneSection title="Reply draft"><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{proposal.reply_draft}</p></PaneSection>}
  </>;
}

export function workflowPrimaryAction({ proposal, drafts, busy, onStage, onGo, onReconcile }: WorkflowFooterProps) {
  const dirty = Object.keys(drafts).length > 0;
  if (uncertain(proposal)) return onReconcile ? { label: 'Check Infor', disabled: busy, onClick: onReconcile } : undefined;
  const mutableWorkflow = proposal.workflow === 'create' || proposal.workflow === 'amend' || proposal.workflow === 'cancel' || proposal.workflow === 'filing';
  if (!mutableWorkflow) return undefined;
  const stageCurrent = proposal.stage?.revision === proposal.revision;
  if (proposal.phase === 'waiting_go' && stageCurrent) return onGo ? { label: 'Go', disabled: dirty || busy, onClick: onGo } : undefined;
  if ((proposal.phase === 'ready' || proposal.phase === 'waiting_go') && onStage) return { label: 'Check in Infor', disabled: dirty || busy, onClick: onStage };
  return undefined;
}
