'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { PaneField } from './field';
import type { PaneFieldProps } from './field';
import { PaneMessage, PaneSection } from './pane';
import type { FieldSpec, NativeDisplayRow, Proposal, ThreadInput } from './wire';
import styles from './pane.module.css';
import quoteStyles from './quote.module.css';

export type DraftValue = string | boolean | string[];
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
  attachmentsChecked: boolean;
  attachmentsAttention: boolean;
  attachmentsBusy: boolean;
  attachmentMessages: ThreadInput['messages'];
  onAttachmentsCheckedChange: (checked: boolean) => void;
};

export type WorkflowFooterProps = Pick<WorkflowProps, 'proposal' | 'drafts' | 'busy'> & {
  onStage?: () => void;
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

function stayLabel(proposal: Proposal, bookingId: string) {
  const index = proposal.bookings.findIndex(booking => booking.id === bookingId);
  const booking = proposal.bookings[index];
  if (!booking) return 'Stay details unavailable';
  return [`Stay ${index + 1}`, booking.property_code, booking.reservation_id && `Reservation ${booking.reservation_id}`].filter(Boolean).join(' · ');
}

function quoteGroups(proposal: Proposal) {
  const quotes = proposal.actions.filter(action => action.type === 'quote');
  return proposal.actions.flatMap((action, actionIndex) => {
    if (action.type !== 'quote') return [];
    const details = action.details;
    if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
    const quoteId = typeof details.quote_id === 'string' ? details.quote_id : undefined;
    if (!Array.isArray(details.groups)) return [];
    const quote = quotes.length > 1 ? `Quote ${quotes.indexOf(action) + 1}` : undefined;
    return details.groups.map((group, groupIndex) => ({
      key: `${actionIndex}/${groupIndex}`,
      actionIndex,
      groupIndex,
      quoteId,
      groupId: group && typeof group === 'object' && !Array.isArray(group) && typeof group.group_id === 'string' ? group.group_id : undefined,
      label: [quote, `Room group ${groupIndex + 1}`].filter(Boolean).join(' · '),
    }));
  });
}

function quoteRowContext(proposal: Proposal, row: NativeDisplayRow) {
  if (!row.quote_id && !row.group_id) return undefined;
  const groups = quoteGroups(proposal).filter(group =>
    (!row.quote_id || group.quoteId === row.quote_id) && (!row.group_id || group.groupId === row.group_id)
  );
  if (row.group_id) return groups.length === 1 ? groups[0]?.label : 'Room group unavailable';
  if (!groups.length) return 'Quote details unavailable';
  const quoteCount = proposal.actions.filter(action => action.type === 'quote').length;
  return quoteCount > 1 ? groups[0]?.label.split(' · ')[0] : undefined;
}

function ActionContext({ proposal }: { proposal: Proposal }) {
  if (proposal.actions.length === 0 && proposal.bookings.length === 0) return null;
  return <PaneSection title="Actions and stays">
    {proposal.actions.length > 0 && <ol className={styles.actionList}>{proposal.actions.map((action, index) => <li key={action.id}>
      <strong>Action {index + 1}{action.type && ` · ${action.type}`}</strong>
      {action.booking_ids.length > 0 ? <ul>{action.booking_ids.map((id, bookingIndex) => <li key={`${id}-${bookingIndex}`}>{stayLabel(proposal, id)}</li>)}</ul> : <p>No stay linked to this action.</p>}
    </li>)}</ol>}
    {proposal.bookings.length > 0 && <div className={styles.stayList}>
      <strong>Stays</strong>
      <ul>{proposal.bookings.map(booking => <li key={booking.id}>{stayLabel(proposal, booking.id)}</li>)}</ul>
    </div>}
  </PaneSection>;
}

function NativeRows({ rows, proposal }: { rows: NativeDisplayRow[]; proposal: Proposal }) {
  return <dl className={styles.nativeRows}>{rows.map(row => {
    const context = proposal.workflow === 'quote' ? quoteRowContext(proposal, row) : undefined;
    const bookingContext = row.booking_id === null ? null : stayLabel(proposal, row.booking_id);
    return <div className={styles.nativeRow} key={row.id}>
      <dt>{row.label}{(context || bookingContext) && <span>{context || bookingContext}</span>}</dt>
      <dd><NativeValue row={row} /></dd>
    </div>;
  })}</dl>;
}

function fieldContext(proposal: Proposal, path: string) {
  const match = /^\/(bookings|actions)\/(0|[1-9]\d*)\//.exec(path);
  if (!match) return undefined;
  const index = Number(match[2]);
  if (!Number.isSafeInteger(index)) return undefined;
  if (match[1] === 'bookings' && proposal.bookings[index]) return `Stay ${index + 1}`;
  if (match[1] === 'actions' && proposal.actions[index]) {
    if (proposal.workflow !== 'quote') return `Action ${index + 1}`;
    const action = proposal.actions[index];
    const quotes = proposal.actions.filter(item => item.type === 'quote');
    if (action.type === 'quote') return quotes.length > 1 ? `Quote ${quotes.indexOf(action) + 1}` : undefined;
    return proposal.actions.length > 1 ? `Request ${index + 1}` : undefined;
  }
  return undefined;
}

function childFieldPath(path: string, field: 'child_count' | 'child_ages') {
  const match = /^(\/bookings\/(?:0|[1-9]\d*)\/fields\/)child_(?:count|ages)$/.exec(path);
  return match ? `${match[1]}${field}` : undefined;
}

function childCount(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 && count <= 16 ? count : undefined;
}

function ageInputs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(age => typeof age === 'string' || typeof age === 'number' ? String(age) : '');
}

function Field({ spec, proposal, drafts, onEdit, reviews, onReview, locked, showContext = true }: WorkflowProps & { spec: FieldSpec; locked: boolean; showContext?: boolean }) {
  const context = showContext ? fieldContext(proposal, spec.path) : undefined;
  const label = context ? `${spec.label} · ${context}` : spec.label;
  const resolved = resolvePointer(proposal, spec.path);
  if (resolved.kind === 'invalid') return <PaneMessage tone="error">{label}: this value is unavailable. Refresh the proposal.</PaneMessage>;
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
  const common = { label, required: spec.required, disabled: locked || !spec.editable, error: spec.error, hint, review };
  let control: ReactNode;

  const agesPath = proposal.workflow === 'create' ? childFieldPath(spec.path, 'child_ages') : undefined;
  const countPath = proposal.workflow === 'create' ? childFieldPath(spec.path, 'child_count') : undefined;
  const agesSpec = agesPath && proposal.field_specs.find(item => item.path === agesPath);
  if (agesPath && spec.path === agesPath && countPath) {
    const resolvedCount = resolvePointer(proposal, countPath);
    const countValue = Object.prototype.hasOwnProperty.call(drafts, countPath) ? drafts[countPath] : resolvedCount.kind === 'value' ? resolvedCount.value : undefined;
    const count = childCount(countValue);
    const ages = ageInputs(shown);
    control = count === undefined ? <PaneMessage>{label}: enter a child count from 0 to 16 first.</PaneMessage> : <>
      {count === 0 && !Array.isArray(shown) && <PaneMessage>
        Confirm there are no children.
        <button type="button" disabled={locked || !spec.editable} onClick={() => onEdit(spec.path, [])}>Confirm no children</button>
      </PaneMessage>}
      {Array.from({ length: count }, (_, index) => {
        const age = ages[index] ?? '';
        const valid = /^\d+$/.test(age) && Number(age) <= 17;
        return <PaneField key={index} label={`Child ${index + 1} age${context ? ` · ${context}` : ''}`} control="number"
          value={age} min="0" max="17" step="1" required disabled={locked || !spec.editable}
          error={valid ? undefined : 'Enter an age from 0 to 17.'}
          review={aiFilled && index < ages.length ? { provenance: 'ai', kind: 'marker' } : undefined}
          onChange={next => {
            const updated = Array.from({ length: Math.max(count, ages.length) }, (_, i) => ages[i] ?? '');
            updated[index] = next;
            onEdit(spec.path, updated);
          }} />;
      })}
      {ages.length > count && <PaneMessage tone="error">
        There are more saved ages than children. Confirm which ages to keep.
        <button type="button" disabled={locked || !spec.editable} onClick={() => onEdit(spec.path, ages.slice(0, count))}>Keep the first {count} {count === 1 ? 'age' : 'ages'}</button>
      </PaneMessage>}
    </>;
  } else if (countPath && spec.path === countPath && agesPath && spec.control === 'number') {
    const count = childCount(shown);
    const resolvedAges = resolvePointer(proposal, agesPath);
    const ages = ageInputs(Object.prototype.hasOwnProperty.call(drafts, agesPath) ? drafts[agesPath] : resolvedAges.kind === 'value' ? resolvedAges.value : undefined);
    if (shown === null || shown === undefined || typeof shown === 'number' || typeof shown === 'string') {
      control = <PaneField {...common} disabled={common.disabled || !agesSpec?.editable} control="number" value={shown === null || shown === undefined ? '' : String(shown)}
        min="0" max="16" step="1" error={spec.error || (shown !== null && shown !== undefined && count === undefined ? 'Enter a child count from 0 to 16.' : undefined)}
        hint={!agesSpec?.editable ? 'Child ages are unavailable to edit. Refresh the proposal.' : hint}
        onChange={next => {
          onEdit(spec.path, next);
          const nextCount = childCount(next);
          if (nextCount !== undefined) onEdit(agesPath, Array.from({ length: nextCount }, (_, i) => ages[i] ?? ''));
        }} />;
    }
  } else if (spec.control === 'checkbox') {
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
      const rateCode = proposal.workflow === 'create' && /^\/bookings\/(0|[1-9]\d*)\/fields\/rate_plan$/.test(spec.path);
      control = rateCode && spec.options.length === 0
        ? <PaneField {...common} control="text" value={text} onChange={next => onEdit(spec.path, next)} />
        : <PaneField {...common} control={rateCode ? 'combobox' : spec.control} value={text} options={spec.options} onChange={next => onEdit(spec.path, next)} />;
    } else {
      const date = spec.control === 'date' && text && !isDateValue(text) ? 'text' : spec.control;
      control = <PaneField {...common} control={date} value={text} onChange={next => onEdit(spec.path, next)} />;
    }
  }

  return <div>
    {control ?? <PaneMessage>{label}: value cannot be displayed or edited in this view. Check the source.</PaneMessage>}
    {spec.evidence.some(item => item.quote) && <details>
      <summary>Source for {label}</summary>
      {spec.evidence.map((item, index) => item.quote && <p key={index} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.quote}</p>)}
    </details>}
  </div>;
}

function QuoteFields(props: WorkflowProps & { locked: boolean }) {
  const groups = quoteGroups(props.proposal);
  const sections: { key: string; label?: string; fields: FieldSpec[] }[] = [];
  const grouped = new Map<string, { key: string; label?: string; fields: FieldSpec[] }>();
  for (const spec of props.proposal.field_specs) {
    const match = /^\/actions\/(0|[1-9]\d*)\/details\/groups\/(0|[1-9]\d*)(?:\/|$)/.exec(spec.path);
    const group = match && groups.find(item => item.actionIndex === Number(match[1]) && item.groupIndex === Number(match[2]));
    const legacyStay = /^\/bookings\/(0|[1-9]\d*)\//.exec(spec.path) && fieldContext(props.proposal, spec.path);
    const key = group ? `group/${group.key}` : legacyStay ? `stay/${legacyStay}` : undefined;
    if (!key) {
      sections.push({ key: spec.path, fields: [spec] });
      continue;
    }
    let section = grouped.get(key);
    if (!section) {
      section = { key, label: group?.label || legacyStay || undefined, fields: [] };
      grouped.set(key, section);
      sections.push(section);
    }
    section.fields.push(spec);
  }

  return <PaneSection title="Quote details">
    {sections.map(section => section.label
      ? <fieldset className={quoteStyles.stay} key={section.key}>
        <legend>{section.label}</legend>
        {section.fields.map(spec => <Field key={spec.path} {...props} spec={spec} showContext={false} />)}
      </fieldset>
      : <div key={section.key}>{section.fields.map(spec => <Field key={spec.path} {...props} spec={spec} />)}</div>)}
  </PaneSection>;
}

function QuoteRequests({ proposal }: { proposal: Proposal }) {
  if (proposal.actions.length <= 1) return null;
  const quotes = proposal.actions.filter(action => action.type === 'quote');
  const groups = quoteGroups(proposal);
  return <details className={quoteStyles.requests}>
    <summary>Requests in this email</summary>
    <ol>{proposal.actions.map((action, index) => {
      const count = groups.filter(group => group.actionIndex === index).length;
      return <li key={action.id}>
        <strong>{action.type === 'quote' ? quotes.length > 1 ? `Quote ${quotes.indexOf(action) + 1}` : 'Quote' : `Request ${index + 1}${action.type && ` · ${action.type.replace(/[_-]/g, ' ')}`}`}</strong>
        {action.type === 'quote' && count > 0 && <p>{count} {count === 1 ? 'room group' : 'room groups'}</p>}
        {action.booking_ids.length > 0 && <ul>{action.booking_ids.map((id, bookingIndex) => <li key={`${id}-${bookingIndex}`}>{stayLabel(proposal, id)}</li>)}</ul>}
      </li>;
    })}</ol>
  </details>;
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
  if (proposal.error?.message.trim()) return proposal.error.message;
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
  const phaseMessage = proposal.phase === 'prefilling' ? proposal.workflow === 'quote' ? 'Nava is preparing the quote.' : 'Nava is reading the email.'
    : proposal.phase === 'staging' ? 'Checking in Infor…'
    : proposal.phase === 'saving' ? 'Waiting for Infor and readback…' : null;
  const stageCurrent = proposal.stage?.revision === proposal.revision && Object.keys(props.drafts).length === 0;
  const dispositionMessage = {
    propose: null, needs_info: 'More information is needed.', decline: 'Marked for decline.',
    skip: 'No action needed.', staff_review: 'Needs review.',
  }[proposal.disposition];

  return <>
    {phaseMessage && <PaneMessage><span role="status">{phaseMessage}{longWait && (proposal.workflow === 'quote' && proposal.phase === 'prefilling' ? ' This is taking longer than expected. Nava is still working on the quote.' : ' This is taking longer than expected. Please wait.')}</span></PaneMessage>}
    {uncertain(proposal) && !proposal.error && <PaneMessage>Infor has not confirmed the outcome. Check Infor before trying again.</PaneMessage>}
    {proposal.error && <PaneMessage tone="error">
      {errorMessage(proposal)}
      {proposal.error.recovery?.trim() && <p>{proposal.error.recovery}</p>}
    </PaneMessage>}
    {dispositionMessage && <PaneMessage>{dispositionMessage}</PaneMessage>}
    {proposal.reason && <PaneMessage>{proposal.reason}</PaneMessage>}
    {proposal.missing.length > 0 && <PaneSection title="Information needed"><ul>{proposal.missing.map((item, index) => <li key={index}>{item}</li>)}</ul></PaneSection>}
    {proposal.warnings.length > 0 && <PaneSection title="Check these details"><ul>{proposal.warnings.map((item, index) => <li key={index}>{item}</li>)}</ul></PaneSection>}
    {['create', 'amend', 'cancel', 'filing'].includes(proposal.workflow) && <PaneSection title="Check attachments">
      <p>{props.attachmentsAttention ? "Nava couldn't read attachments from one or more emails. " : ''}Check the attachments in the selected email and each earlier email listed below in Outlook. Include all relevant attachment details in this proposal, then confirm.</p>
      {props.attachmentMessages.length > 0 ? <ul>{props.attachmentMessages.map(message => <li key={message.id}>
        {message.subject || '(No subject)'} · {message.from.name || message.from.email} · <time dateTime={message.received_at}>{message.received_at}</time>
        {message.attachment_status === 'has_unread' ? ' · Attachments not read by Nava' : message.attachment_status !== 'complete' ? ' · Attachment status unknown' : ''}
      </li>)}</ul> : <p>Emails used by Nava are unavailable. Refresh the proposal before confirming.</p>}
      <PaneField control="checkbox" label="I reviewed attachments for every relevant email in this conversation and reflected every material attachment instruction in the current proposal." value={props.attachmentsChecked}
        disabled={locked || props.attachmentsBusy || Object.keys(props.drafts).length > 0 || props.attachmentMessages.length === 0}
        onChange={props.onAttachmentsCheckedChange} />
    </PaneSection>}
    {proposal.workflow !== 'quote' && <ActionContext proposal={proposal} />}
    {proposal.workflow === 'quote' && proposal.field_specs.length > 0 && <QuoteFields {...props} locked={locked} />}
    {proposal.workflow !== 'quote' && proposal.field_specs.length > 0 && <PaneSection title="Details">
      {proposal.field_specs.map(spec => <Field key={spec.path} {...props} spec={spec} locked={locked} />)}
    </PaneSection>}
    {proposal.workflow === 'quote' && <QuoteRequests proposal={proposal} />}
    {proposal.display_rows.length > 0 && <PaneSection title="Infor details">
      {proposal.workflow === 'quote' && <p className={quoteStyles.resultNote}>Changing quote details does not update these results.</p>}
      <NativeRows rows={proposal.display_rows} proposal={proposal} />
    </PaneSection>}
    {proposal.stage && <PaneSection title={stageCurrent ? 'Checked details' : 'Earlier check'}>
      {!stageCurrent && <p>Details have changed since this check.</p>}
      {proposal.stage.summary.length > 0 && <div className={styles.stageSummary}>
        <strong>Check notes</strong>
        <ul>{proposal.stage.summary.map((item, index) => <li key={index}>{item}</li>)}</ul>
      </div>}
      {proposal.stage.display_rows.length > 0 ? <NativeRows rows={proposal.stage.display_rows} proposal={proposal} /> : <p>No Infor details were provided for this check.</p>}
      {proposal.workflow === 'create' && stageCurrent && <p>Saving is not switched on yet</p>}
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

export function workflowPrimaryAction({ proposal, drafts, busy, onStage, onReconcile }: WorkflowFooterProps) {
  const dirty = Object.keys(drafts).length > 0;
  if (uncertain(proposal)) return onReconcile ? { label: 'Check Infor', disabled: busy, onClick: onReconcile } : undefined;
  const mutableWorkflow = proposal.workflow === 'create' || proposal.workflow === 'amend' || proposal.workflow === 'cancel' || proposal.workflow === 'filing';
  if (!mutableWorkflow) return undefined;
  const stageCurrent = proposal.stage?.revision === proposal.revision;
  if (proposal.phase === 'waiting_go' && stageCurrent) return undefined;
  if ((proposal.phase === 'ready' || proposal.phase === 'waiting_go') && onStage) return { label: 'Prepare in Infor', disabled: dirty || busy, onClick: onStage };
  return undefined;
}
