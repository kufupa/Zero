'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { QuoteDraftBinding } from '@/components/reservation-pane/use-quote-output';
import { PaneField } from './field';
import { quoteArtifactIds } from './quote-draft';
import type { PaneFieldProps } from './field';
import { PaneMessage, PaneSection } from './pane';
import type { FieldSpec, NativeDisplayRow, Proposal, QuoteSelection, ThreadInput } from './wire';
import type { StayLookup } from './api';
import styles from './pane.module.css';
import quoteStyles from './quote.module.css';

export type DraftValue = string | boolean | string[] | { roomCode: string; rateCode: string };
type ReviewControl = { checked: boolean; actionLabel: string; disabled?: boolean };
export type GuestCandidate = { nativeId: string; firstName: string; lastName: string };

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
  onQuote?: (quoteId: string) => void;
  onGenerateQuoteArtifacts?: (quoteId: string, selections: QuoteSelection[]) => void;
  quoteDraftTarget?: 'webmail' | 'outlook';
  onSaveQuoteDraft?: (body: string) => Promise<{ status: string; message: string }>;
  quoteConnectionReady?: boolean;
  onFindQuoteDraft?: (binding: QuoteDraftBinding) => Promise<boolean>;
  onOpenQuoteDraft?: (binding: QuoteDraftBinding) => Promise<{ subject: string; body: string; files: string[]; to?: string; cc?: string } | null>;
  onAddContext?: (text: string) => Promise<string>;
  onSelectGuest?: (candidate: GuestCandidate, roomIndex: number) => void;
  onLookupStay?: (lookup: StayLookup) => void;
  onSelectStay?: (jobId: string, removeFields: string[]) => void;
  attachmentsChecked: boolean;
  attachmentsAttention: boolean;
  attachmentsBusy: boolean;
  attachmentMessages: ThreadInput['messages'];
  selectedMessageId: string;
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

const observedLabels: Record<string, string> = {
  arrival: 'Arrival', departure: 'Departure', adults: 'Adults', childAges: 'Child ages',
  roomType: 'Room type', roomTypeForCharge: 'Room type for charge', ratePlan: 'Rate plan',
  guaranteeType: 'Guarantee type', sourceOfBusiness: 'Booking source', track: 'Track', mealPlan: 'Meal plan',
};
const amendLabels: Record<string, string> = {
  arrival_date: 'Arrival', departure_date: 'Departure', adults: 'Adults', children: 'Children', child_ages: 'Child ages',
  room_type: 'Room type', room_type_for_charge: 'Room type for charge', rate_plan: 'Rate plan',
  reservation_note: 'Reservation note', billing_reference: 'Billing reference',
};
function fieldText(value: unknown): string | null {
  if (typeof value === 'string') return value || '(empty)';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value) && value.every(item => typeof item === 'number' || typeof item === 'string')) return value.length ? value.join(', ') : 'None';
  return null;
}

function ObservedFields({ proposal }: { proposal: Proposal }) {
  const stage = proposal.stage;
  if (!stage) return null;
  if (proposal.workflow === 'create' && stage.native_result && typeof stage.native_result === 'object' && !Array.isArray(stage.native_result) && Array.isArray(stage.native_result.rooms)) {
    return <div>{stage.native_result.rooms.map((room,index)=>{
      if (!room || typeof room!=='object' || Array.isArray(room)) return null;
      const observed=room.observed_fields && typeof room.observed_fields==='object' && !Array.isArray(room.observed_fields) ? room.observed_fields : {};
      const rows=Object.entries(observedLabels).flatMap(([key,label])=>{const value=fieldText(observed[key]); return value===null?[]:[{key,label,value}];});
      return <div key={proposal.bookings[index]?.id ?? index}><p>Room {index+1}: {room.state==='prepared'?'checked in Infor':'check incomplete'}</p>
        <dl className={styles.nativeRows}>{rows.map(row=><div className={styles.nativeRow} key={row.key}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl></div>;
    })}</div>;
  }
  if (proposal.workflow === 'create' && stage.observed_fields && typeof stage.observed_fields === 'object' && !Array.isArray(stage.observed_fields)) {
    const observed = stage.observed_fields;
    const rows = Object.entries(observedLabels).flatMap(([key, label]) => {
      const value = fieldText(observed[key]);
      return value === null ? [] : [{ key, label, value }];
    });
    if (!rows.length) return null;
    return <div><p>{proposal.error ? 'Check incomplete. Infor showed these values before it stopped.' : 'Values shown by Infor during this check.'}</p>
      <dl className={styles.nativeRows}>{rows.map(row => <div className={styles.nativeRow} key={row.key}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
    </div>;
  }
  if (proposal.workflow !== 'amend' || !stage.native_result || typeof stage.native_result !== 'object' || Array.isArray(stage.native_result)) return null;
  const native = stage.native_result;
  const before = native.current_state && typeof native.current_state === 'object' && !Array.isArray(native.current_state) ? native.current_state : {};
  const after = native.fields && typeof native.fields === 'object' && !Array.isArray(native.fields) ? native.fields : {};
  const changed = Array.isArray(native.changed_fields) ? native.changed_fields : [];
  const rows = changed.flatMap(key => {
    if (typeof key !== 'string' || !Object.hasOwn(amendLabels, key)) return [];
    const oldValue = fieldText(before[key]), newValue = fieldText(after[key]);
    return oldValue === null || newValue === null ? [] : [{ key, label: amendLabels[key], oldValue, newValue }];
  });
  if (!rows.length && native.original_stay_unchanged !== true) return null;
  return <div><p>Changes prepared in Infor:</p><dl className={styles.nativeRows}>{rows.map(row => <div className={styles.nativeRow} key={row.key}>
    <dt>{row.label}</dt><dd>{row.oldValue} → {row.newValue}</dd>
  </div>)}</dl>
    {native.original_stay_unchanged === true && <p>The saved reservation remains unchanged.</p>}
    {native.current_cms_send === false && <p>CMS sending remained off during this check.</p>}
  </div>;
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

function childFieldPath(path: string, field: 'child_count' | 'child_ages', workflow: Proposal['workflow']) {
  if (workflow === 'create') {
    const match = /^(\/bookings\/(?:0|[1-9]\d*)\/fields\/)child_(?:count|ages)$/.exec(path);
    return match ? `${match[1]}${field}` : undefined;
  }
  if (workflow === 'quote') {
    const match = /^(\/actions\/(?:0|[1-9]\d*)\/details\/groups\/(?:0|[1-9]\d*)\/rooms\/(?:0|[1-9]\d*)\/)(?:children|child_ages)$/.exec(path);
    return match ? `${match[1]}${field === 'child_count' ? 'children' : 'child_ages'}` : undefined;
  }
  return undefined;
}

function childCount(value: unknown, workflow: Proposal['workflow']): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 && (workflow !== 'create' || count <= 16) ? count : undefined;
}

function ageInputs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(age => typeof age === 'string' || typeof age === 'number' ? String(age) : '');
}

function currentNativeResult(proposal: Proposal, drafts: WorkflowProps['drafts']) {
  const stage = proposal.stage;
  if (!stage || stage.revision !== proposal.revision || proposal.phase === 'staging' || Object.keys(drafts).length > 0) return undefined;
  const value = stage.native_result;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function currentNativeRoom(proposal: Proposal, drafts: WorkflowProps['drafts'], index: number) {
  const native=currentNativeResult(proposal,drafts);
  if(proposal.bookings.length===1) return native;
  const room=Array.isArray(native?.rooms) ? native.rooms[index] : null;
  return room && typeof room==='object' && !Array.isArray(room) ? room : undefined;
}

function nativeRateOptions(proposal: Proposal, drafts: WorkflowProps['drafts'], index: number) {
  const choices = currentNativeRoom(proposal, drafts, index)?.rate_choices;
  if (!choices || typeof choices !== 'object' || Array.isArray(choices) || choices.status === 'unavailable' || !Array.isArray(choices.items)) return [];
  return choices.items.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.value !== 'string' || !item.value || typeof item.label !== 'string') return [];
    const meaning = [
      typeof item.meaning === 'string' ? item.meaning : null,
      typeof item.room_type === 'string' ? `Room: ${item.room_type}` : null,
      typeof item.rate_scope === 'string' ? `Rate scope: ${item.rate_scope}` : null,
      typeof item.availability === 'string' ? `Availability: ${item.availability}` : null,
    ].filter(Boolean).join(' · ');
    return [{ value: item.value, label: item.label, meaning: meaning || null }];
  });
}

function nativeRoomOptions(proposal: Proposal, drafts: WorkflowProps['drafts'], index: number) {
  const choices = currentNativeRoom(proposal, drafts, index)?.room_choices;
  if (!choices || typeof choices !== 'object' || Array.isArray(choices) || choices.status !== 'available' || !Array.isArray(choices.items)) return [];
  return choices.items.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.value !== 'string' || !item.value || typeof item.label !== 'string') return [];
    return [{ value: item.value, label: item.label, meaning: typeof item.meaning === 'string' ? item.meaning : null }];
  });
}

function nativeTrackOptions(proposal: Proposal, drafts: WorkflowProps['drafts'], index: number) {
  const choices = currentNativeRoom(proposal, drafts, index)?.track_choices;
  if (!choices || typeof choices !== 'object' || Array.isArray(choices) || choices.status !== 'available' ||
      choices.property_code !== proposal.bookings[index]?.property_code || !Array.isArray(choices.items)) return [];
  return choices.items.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.value !== 'string' || !item.value || typeof item.label !== 'string') return [];
    return [{ value: item.value, label: item.label, meaning: typeof item.meaning === 'string' ? item.meaning : null }];
  });
}

function quoteCodeOptions(proposal: Proposal, drafts: WorkflowProps['drafts'], path: string, kind: 'room' | 'rate') {
  const match = /^\/actions\/(0|[1-9]\d*)\/details\/groups\/(0|[1-9]\d*)\/rooms\/(0|[1-9]\d*)\/required$/.exec(path);
  const stage = proposal.stage;
  if (!match || !stage?.quote_id || stage.revision !== proposal.revision || proposal.phase === 'staging' || Object.keys(drafts).length) return [];
  const action = proposal.actions[Number(match[1])];
  const details = action?.details;
  if (!details || typeof details !== 'object' || Array.isArray(details) || details.quote_id !== stage.quote_id || !Array.isArray(details.groups)) return [];
  const group = details.groups[Number(match[2])];
  if (!group || typeof group !== 'object' || Array.isArray(group) || typeof group.group_id !== 'string' || !Array.isArray(group.rooms)) return [];
  const room = group.rooms[Number(match[3])];
  if (!room || typeof room !== 'object' || Array.isArray(room) || typeof room.id !== 'string') return [];
  const seen = new Set<string>();
  return (stage.quote_choices ?? stage.quote_options ?? []).flatMap(option => {
    const code = option[kind];
    if (option.group_id !== group.group_id || option.room_id !== room.id || seen.has(code.code)) return [];
    seen.add(code.code);
    return [{ value: code.code, label: code.code, meaning: code.label }];
  });
}

function FieldEvidence({ spec, label }: { spec: FieldSpec; label: string }) {
  if (!spec.evidence.some(item => item.quote)) return null;
  return <details>
    <summary>Source for {label}</summary>
    {[...new Set(spec.evidence.map(item => item.quote))].map(quote => quote && <p key={quote} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{quote}</p>)}
  </details>;
}

function Field({ spec, proposal, drafts, onEdit, reviews, onReview, locked, attachmentMessages, selectedMessageId, showContext = true }: WorkflowProps & { spec: FieldSpec; locked: boolean; showContext?: boolean }) {
  if(proposal.workflow==='create' && /\/fields\/(profile_mobile|profile_email)$/.test(spec.path)) {
    const flagPath=spec.path.replace(/\/(profile_mobile|profile_email)$/, '/profile_create_new');
    const flag=Object.prototype.hasOwnProperty.call(drafts,flagPath) ? drafts[flagPath] : resolvePointer(proposal,flagPath);
    const enabled=flag && typeof flag==='object' && 'kind' in flag ? flag.kind==='value' && flag.value===true : flag===true;
    if(!enabled) return null;
  }
  const roomMatch = proposal.workflow === 'quote' ? /^\/actions\/(?:0|[1-9]\d*)\/details\/groups\/(?:0|[1-9]\d*)\/rooms\/(0|[1-9]\d*)\//.exec(spec.path) : null;
  const context = roomMatch ? `Room ${Number(roomMatch[1]) + 1}` : showContext ? fieldContext(proposal, spec.path) : undefined;
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
  const cmsDetail = proposal.workflow === 'create' && /\/(cms_message_id|cms_recipient)$/.exec(spec.path);
  if (cmsDetail) {
    const sendPath = spec.path.replace(/\/(cms_message_id|cms_recipient)$/, '/cms_send');
    const send = Object.prototype.hasOwnProperty.call(drafts, sendPath) ? drafts[sendPath] : resolvePointer(proposal, sendPath);
    const sendValue = send && typeof send === 'object' && 'kind' in send ? (send.kind === 'value' ? send.value : undefined) : send;
    if (sendValue === false) return null;
  }
  const guestProfile = proposal.workflow === 'create' && /^\/bookings\/(?:0|[1-9]\d*)\/fields\/guest_profile_id$/.test(spec.path);
  const newProfileMatch=proposal.workflow==='create' ? /^\/bookings\/(0|[1-9]\d*)\/fields\/profile_create_new$/.exec(spec.path) : null;
  const profileIndex=newProfileMatch ? Number(newProfileMatch[1]) : -1;
  const booking=proposal.bookings[profileIndex];
  const stageChoices=currentNativeRoom(proposal,drafts,profileIndex)?.guest_candidates;
  const hasChoices=stageChoices && typeof stageChoices==='object' && !Array.isArray(stageChoices) && stageChoices.status==='available';
  const hasReviewed=proposal.profile_reviews.some(item=>item.booking_id===booking?.id && item.first_name===booking.fields.first_name && item.last_name===booking.fields.last_name && item.guest_email===(booking.fields.guest_email??null));
  const searchFirst=!!newProfileMatch && !hasChoices && !hasReviewed && shown!==true;
  const selectedProfile=!!newProfileMatch && !!booking?.fields.guest_profile_id;
  const hint = searchFirst ? 'Check Infor for matching profiles first.' : selectedProfile ? 'An existing profile is selected.' : guestProfile ? 'Run Prepare to load verified Infor profiles.'
    : resolved.kind === 'missing' || value === null ? 'No saved value.' : undefined;
  const requiredEmpty = spec.required && (shown === null || shown === undefined || typeof shown === 'string' && shown.trim() === '');
  const common = { label, required: spec.required, disabled: locked || !spec.editable || guestProfile || searchFirst || selectedProfile, error: spec.error ?? (requiredEmpty && spec.control !== 'checkbox' ? 'Required — fill before Go.' : null), hint, review };
  let control: ReactNode;

  const filingField = proposal.workflow === 'filing' && /^(\/actions\/(?:0|[1-9]\d*)\/details\/)attachment_id$/.exec(spec.path);
  if (filingField) {
    const messageId = resolvePointer(proposal, `${filingField[1]}message_id`);
    const selected = attachmentMessages.find(message => message.id === selectedMessageId && message.direction === 'inbound');
    if (messageId.kind !== 'value' || messageId.value !== selectedMessageId || !selected) {
      control = <PaneMessage tone="error">The selected email is unavailable for document selection. Reopen the request.</PaneMessage>;
    } else if (shown === null || shown === undefined || typeof shown === 'string') {
      const options = selected.attachments.filter(attachment => attachment.mime_type.toLowerCase() === 'application/pdf')
        .map(attachment => ({ value: attachment.id, label: attachment.name, meaning: `${attachment.size} bytes` }));
      control = <PaneField {...common} label="PDF from selected email" control="select" value={shown ?? ''} options={options}
        disabled={common.disabled || options.length === 0} hint={options.length === 0 ? 'No PDF is available in the selected email.' : undefined}
        error={spec.error || (shown && !options.some(option => option.value === shown) ? 'Choose an available PDF from the selected email.' : undefined)}
        onChange={next => { if (next) onEdit(spec.path, next); }} />;
    }
    return <div>{control ?? <PaneMessage>PDF selection is unavailable. Reopen the request.</PaneMessage>}<FieldEvidence spec={spec} label={label} /></div>;
  }
  if (proposal.workflow === 'filing' && /^\/actions\/(?:0|[1-9]\d*)\/details\/message_id$/.test(spec.path)) return null;

  const quoteRequired = proposal.workflow === 'quote' && /^\/actions\/(?:0|[1-9]\d*)\/details\/groups\/(?:0|[1-9]\d*)\/rooms\/(?:0|[1-9]\d*)\/required$/.test(spec.path);
  if (quoteRequired) {
    const saved: Record<string, unknown> = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const roomCodes = Array.isArray(saved.roomCodes) ? saved.roomCodes.filter((code): code is string => typeof code === 'string') : [];
    const rateCodes = Array.isArray(saved.rateCodes) ? saved.rateCodes.filter((code): code is string => typeof code === 'string') : [];
    const chosen = draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : { roomCode: roomCodes[0] ?? '', rateCode: rateCodes[0] ?? '' };
    const rooms = quoteCodeOptions(proposal, drafts, spec.path, 'room');
    const rates = quoteCodeOptions(proposal, drafts, spec.path, 'rate');
    const roomNote = roomCodes.length > 1 ? 'Changing the room replaces the current list of room codes.'
      : rooms.length ? 'Choices from the latest Infor check. Check again after changing.' : 'Type a room code, or check Infor to load choices.';
    const rateNote = rateCodes.length > 1 ? 'Changing the rate replaces the current list of rate codes.'
      : rates.length ? 'Choices from the latest Infor check. Check again after changing.' : 'Type a rate code, or check Infor to load choices.';
    return <div><PaneField {...common} review={chosen.roomCode ? review : undefined} label={context ? `Room type · ${context}` : 'Room type'} control="combobox" value={chosen.roomCode}
      options={rooms} placeholder="Type a room code" hint={roomNote} onChange={next => onEdit(spec.path, { ...chosen, roomCode: next })} />
      <PaneField {...common} review={chosen.rateCode ? review : undefined} label={context ? `Rate plan · ${context}` : 'Rate plan'} control="combobox" value={chosen.rateCode}
        options={rates} placeholder="Type a rate code" hint={rateNote} onChange={next => onEdit(spec.path, { ...chosen, rateCode: next })} />
      <FieldEvidence spec={spec} label="Rate plan" /></div>;
  }

  const quotePreference = proposal.workflow === 'quote' && /\/rooms\/(?:0|[1-9]\d*)\/preferred\/(?:rateCodes|bedTypes|mealPlanBases)$/.test(spec.path);
  if (quotePreference) {
    const text = typeof shown === 'string' ? shown : Array.isArray(shown) && shown.every(item => typeof item === 'string') ? shown.join(', ') : shown == null ? '' : null;
    return <div>{text === null ? <PaneMessage>{label}: this value cannot be displayed. Check the source.</PaneMessage>
      : <PaneField {...common} control="text" value={text} hint="Separate multiple preferences with commas." onChange={next => onEdit(spec.path, next)} />}
      <FieldEvidence spec={spec} label={label} /></div>;
  }

  const agesPath = childFieldPath(spec.path, 'child_ages', proposal.workflow);
  const countPath = childFieldPath(spec.path, 'child_count', proposal.workflow);
  const agesSpec = agesPath ? proposal.field_specs.find(item => item.path === agesPath) : undefined;
  if (agesPath && spec.path === agesPath && countPath) {
    const resolvedCount = resolvePointer(proposal, countPath);
    const countValue = Object.prototype.hasOwnProperty.call(drafts, countPath) ? drafts[countPath] : resolvedCount.kind === 'value' ? resolvedCount.value : undefined;
    const count = childCount(countValue, proposal.workflow);
    const ages = ageInputs(shown);
    const ageMax = proposal.workflow === 'quote' ? 99 : 17;
    const visibleCount = count === undefined ? 0 : proposal.workflow === 'quote' ? Math.min(count, Math.max(ages.length + 1, 32)) : count;
    control = count === undefined ? <PaneMessage>{label}: {proposal.workflow === 'quote' ? 'enter a non-negative whole number of children first.' : 'enter a child count from 0 to 16 first.'}</PaneMessage> : <>
      {count === 0 && !Array.isArray(shown) && <PaneMessage>
        Confirm there are no children.
        <button type="button" disabled={locked || !spec.editable} onClick={() => onEdit(spec.path, [])}>Confirm no children</button>
      </PaneMessage>}
      {Array.from({ length: visibleCount }, (_, index) => {
        const age = ages[index] ?? '';
        const valid = /^\d+$/.test(age) && Number(age) <= ageMax;
        return <PaneField key={index} label={`Child ${index + 1} age${context ? ` · ${context}` : ''}`} control="number"
          value={age} min="0" max={String(ageMax)} step="1" required disabled={locked || !spec.editable}
          error={valid ? undefined : `Enter an age from 0 to ${ageMax}.`}
          review={aiFilled && index < ages.length ? { provenance: 'ai', kind: 'marker' } : undefined}
          onChange={next => {
            const updated = Array.from({ length: Math.max(visibleCount, ages.length) }, (_, i) => ages[i] ?? '');
            updated[index] = next;
            onEdit(spec.path, updated);
          }} />;
      })}
      {visibleCount < count && <p>Enter these ages to show the remaining children.</p>}
      {ages.length > count && <PaneMessage tone="error">
        There are more saved ages than children. Confirm which ages to keep.
        <button type="button" disabled={locked || !spec.editable} onClick={() => onEdit(spec.path, ages.slice(0, count))}>Keep the first {count} {count === 1 ? 'age' : 'ages'}</button>
      </PaneMessage>}
    </>;
  } else if (countPath && spec.path === countPath && agesPath && (proposal.workflow === 'quote' || spec.control === 'number')) {
    const count = childCount(shown, proposal.workflow);
    const resolvedAges = resolvePointer(proposal, agesPath);
    const ages = ageInputs(Object.prototype.hasOwnProperty.call(drafts, agesPath) ? drafts[agesPath] : resolvedAges.kind === 'value' ? resolvedAges.value : undefined);
    if (shown === null || shown === undefined || typeof shown === 'number' || typeof shown === 'string') {
      control = <PaneField {...common} disabled={common.disabled || !agesSpec?.editable} control="number" value={shown === null || shown === undefined ? '' : String(shown)}
        min="0" max={proposal.workflow === 'create' ? '16' : undefined} step="1" error={spec.error || common.error || (shown !== null && shown !== undefined && count === undefined ? proposal.workflow === 'quote' ? 'Enter a non-negative whole number of children.' : 'Enter a child count from 0 to 16.' : undefined)}
        hint={!agesSpec?.editable ? 'Child ages are unavailable to edit. Refresh the proposal.' : hint}
        onChange={next => {
          onEdit(spec.path, next);
          const nextCount = childCount(next, proposal.workflow);
          if (nextCount !== undefined) {
            const length = proposal.workflow === 'quote' ? Math.min(nextCount, Math.max(ages.length, 32)) : nextCount;
            onEdit(agesPath, Array.from({ length }, (_, i) => ages[i] ?? ''));
          }
        }} />;
    }
  } else if (spec.control === 'checkbox') {
    if (shown === null || shown === undefined) {
      control = <PaneField {...common} control="select" value="" placeholder="Not provided" options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} onChange={next => { if (next) onEdit(spec.path, next === 'true'); }} />;
    } else if (typeof shown === 'boolean') {
      control = <PaneField {...common} control="checkbox" value={shown} onChange={next => onEdit(spec.path, next)} />;
    }
  } else if (spec.control === 'number' || proposal.workflow === 'quote' && /\/rooms\/(?:0|[1-9]\d*)\/(?:quantity|adults)$/.test(spec.path)) {
    if (shown === null || shown === undefined || typeof shown === 'number' || typeof shown === 'string' && hasDraft) {
      control = <PaneField {...common} control="number" value={shown === null || shown === undefined ? '' : String(shown)} onChange={next => onEdit(spec.path, next)} />;
    }
  } else if (shown === null || shown === undefined || typeof shown === 'string') {
    const text = shown ?? '';
    const nativeCode = /\/(rate_plan|room_type|room_type_for_charge|guest_profile_id|track)$/.test(spec.path);
    const createCode = proposal.workflow === 'create' ? /^\/bookings\/(0|[1-9]\d*)\/fields\/(rate_plan|room_type|track)$/.exec(spec.path) : null;
    const rates = createCode?.[2] === 'rate_plan' ? nativeRateOptions(proposal, drafts, Number(createCode[1])) : [];
    const rooms = createCode?.[2] === 'room_type' ? nativeRoomOptions(proposal, drafts, Number(createCode[1])) : [];
    const tracks = createCode?.[2] === 'track' ? nativeTrackOptions(proposal, drafts, Number(createCode[1])) : [];
    const options = nativeCode ? [...rates, ...rooms, ...tracks] : spec.options;
    if (spec.control === 'select' || spec.control === 'combobox' || nativeCode && options.length > 0) {
      control = nativeCode && options.length === 0
        ? <PaneField {...common} control="text" value={text} onChange={next => onEdit(spec.path, next)} />
        : <PaneField {...common} hint={rates.length || rooms.length ? 'Choices from the last Infor check; coverage may be incomplete.' : tracks.length ? 'Choices from the last Infor check for this hotel.' : common.hint} control={nativeCode ? 'combobox' : spec.control === 'select' ? 'select' : 'combobox'} value={text} options={options} onChange={next => onEdit(spec.path, next)} />;
    } else {
      const quoteDate = proposal.workflow === 'quote' && /\/groups\/(?:0|[1-9]\d*)\/(?:arrival_date|departure_date)$/.test(spec.path);
      const date = (spec.control === 'date' || quoteDate) && (!text || isDateValue(text)) ? 'date' : spec.control === 'date' ? 'text' : spec.control;
      control = <PaneField {...common} control={date} value={text} onChange={next => onEdit(spec.path, next)} />;
    }
  }

  return <div>
    {control ?? <PaneMessage>{label}: value cannot be displayed or edited in this view. Check the source.</PaneMessage>}
    {guestProfile && typeof shown === 'string' && shown.trim() !== '' && <button type="button" disabled={locked || !spec.editable} onClick={() => onEdit(spec.path, '')}>Clear selected profile</button>}
    <FieldEvidence spec={spec} label={label} />
  </div>;
}

function QuoteFields(props: WorkflowProps & { locked: boolean }) {
  const groups = quoteGroups(props.proposal);
  const sections: { key: string; label?: string; fields: FieldSpec[] }[] = [];
  const grouped = new Map<string, { key: string; label?: string; fields: FieldSpec[] }>();
  const specs = [...props.proposal.field_specs].sort((a, b) => Number(!a.path.endsWith('/details/property_code')) - Number(!b.path.endsWith('/details/property_code')));
  for (const spec of specs) {
    if (/\/rooms\/(?:0|[1-9]\d*)\/preferred\/roomCodes$/.test(spec.path)) continue;
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
        {[...section.fields].sort((left, right) => quoteFieldOrder(left.path) - quoteFieldOrder(right.path))
          .map(spec => <Field key={spec.path} {...props} spec={spec} showContext={false} />)}
      </fieldset>
      : <div key={section.key}>{section.fields.map(spec => <Field key={spec.path} {...props} spec={spec} />)}</div>)}
  </PaneSection>;
}

function quoteFieldOrder(path: string) {
  const room = /\/rooms\/(0|[1-9]\d*)\//.exec(path);
  const key = path.split('/').at(-1);
  const order: Record<string, number> = {
    arrival_date: 0, departure_date: 1, quantity: 0, adults: 1, children: 2, child_ages: 3,
    roomCodes: 4, bedTypes: 5, rateCodes: 6, required: 6, mealPlanBases: 7,
  };
  const rank = key ? order[key] ?? 9 : 9;
  return room ? 10 + Number(room[1]) * 10 + rank : rank;
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

export function validQuoteChildren(proposal: Proposal, quoteId: string): boolean {
  const actions = proposal.actions.filter(action => {
    const details = action.details;
    return action.type === 'quote' && details && typeof details === 'object' && !Array.isArray(details) && details.quote_id === quoteId;
  });
  if (actions.length !== 1) return false;
  const details = actions[0]?.details;
  if (!details || typeof details !== 'object' || Array.isArray(details) || !Array.isArray(details.groups) || details.groups.length === 0) return false;
  return details.groups.every(group => {
    if (!group || typeof group !== 'object' || Array.isArray(group) || !Array.isArray(group.rooms) || group.rooms.length === 0) return false;
    return group.rooms.every(room => room && typeof room === 'object' && !Array.isArray(room) &&
      typeof room.children === 'number' && Number.isSafeInteger(room.children) && room.children >= 0 &&
      Array.isArray(room.child_ages) && room.child_ages.length === room.children &&
      room.child_ages.every(age => typeof age === 'number' && Number.isInteger(age) && age >= 0 && age <= 99));
  });
}

export function quoteCheckIssue(proposal: Proposal, quoteId: string): string | null {
  const matching = proposal.actions.filter(action => action.type === 'quote' && action.details &&
    typeof action.details === 'object' && !Array.isArray(action.details) && action.details.quote_id === quoteId);
  const details = matching.length === 1 ? matching[0]?.details : null;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return 'Quote details are unavailable. Review the request.';
  if (typeof details.property_code !== 'string' || !details.property_code.trim()) return 'Enter the hotel before checking Infor.';
  if (!Array.isArray(details.groups) || !details.groups.length) return 'Add the room details before checking Infor.';
  for (const group of details.groups) {
    if (!group || typeof group !== 'object' || Array.isArray(group) || typeof group.arrival_date !== 'string' ||
        typeof group.departure_date !== 'string' || !isDateValue(group.arrival_date) || !isDateValue(group.departure_date) || group.departure_date <= group.arrival_date)
      return 'Enter valid arrival and departure dates for each group.';
    if (!Array.isArray(group.rooms) || !group.rooms.length || group.rooms.some(room => !room || typeof room !== 'object' || Array.isArray(room) ||
        typeof room.quantity !== 'number' || !Number.isSafeInteger(room.quantity) || room.quantity < 1 ||
        typeof room.adults !== 'number' || !Number.isSafeInteger(room.adults) || room.adults < 1))
      return 'Enter the number of rooms and adults for each group.';
  }
  return validQuoteChildren(proposal, quoteId) ? null : 'Enter a child count and an age for each child.';
}

function QuoteChecks({ proposal, drafts, busy, onQuote }: WorkflowProps) {
  if (!onQuote) return null;
  const quotes = proposal.actions.filter(action => action.type === 'quote');
  return <PaneSection title="Check availability and rates">
    {quotes.map((action, index) => {
      const details = action.details;
      const quoteId = details && typeof details === 'object' && !Array.isArray(details) && typeof details.quote_id === 'string' ? details.quote_id : undefined;
      const issue = quoteId ? quoteCheckIssue(proposal, quoteId) : 'Quote details are unavailable. Review the request.';
      return <div key={action.id}>
        <button type="button" disabled={busy || Object.keys(drafts).length > 0 || Boolean(issue) || !['ready', 'waiting_go'].includes(proposal.phase)}
        onClick={() => { if (quoteId) onQuote(quoteId); }}>
        {quotes.length > 1 ? `Check quote ${index + 1} in Infor` : 'Check quote in Infor'}
        </button>
        {issue && <p>{issue}</p>}
      </div>;
    })}
    {quotes.length === 0 && <p>Quote details are unavailable.</p>}
  </PaneSection>;
}

function quoteRooms(proposal: Proposal, quoteId: string) {
  const actions = proposal.actions.filter(action => action.type === 'quote' && action.details &&
    typeof action.details === 'object' && !Array.isArray(action.details) && action.details.quote_id === quoteId);
  if (actions.length !== 1) return [];
  const details = actions[0]?.details;
  if (!details || typeof details !== 'object' || Array.isArray(details) || !Array.isArray(details.groups)) return [];
  return details.groups.flatMap((group, groupIndex) => {
    if (!group || typeof group !== 'object' || Array.isArray(group) || typeof group.group_id !== 'string' || !Array.isArray(group.rooms)) return [];
    return group.rooms.flatMap((room, roomIndex) => {
      if (!room || typeof room !== 'object' || Array.isArray(room) || typeof room.id !== 'string') return [];
      return [{ groupId: group.group_id as string, roomId: room.id, label: `Room group ${groupIndex + 1} · Room ${roomIndex + 1}` }];
    });
  });
}

function QuoteOptions({ proposal, busy, onGenerateQuoteArtifacts }: WorkflowProps) {
  const [selected, setSelected] = useState<Record<string, number>>(() => Object.fromEntries(
    (proposal.stage?.quote_selected_options ?? []).map(option => [JSON.stringify([option.group_id, option.room_id]), option.option_index])));
  const stage = proposal.stage;
  if (!stage?.quote_id || !stage.job_id || !stage.quote_options || !onGenerateQuoteArtifacts) return null;
  const rooms = quoteRooms(proposal, stage.quote_id);
  if (!rooms.length) return <PaneMessage>Room details are unavailable. Check the quote again.</PaneMessage>;
  const selections = rooms.flatMap(room => {
    const key = JSON.stringify([room.groupId, room.roomId]);
    const index = selected[key];
    return index !== undefined && stage.quote_options?.some(option => option.group_id === room.groupId && option.room_id === room.roomId && option.option_index === index)
      ? [{ group_id: room.groupId, room_id: room.roomId, option_index: index }] : [];
  });
  return <PaneSection title="Choose quote options">
    <p>Choose one verified option for each room. Prices and availability are from the latest Infor check.</p>
    {stage.quote_artifact_block_reason === 'overlapping_date_searches' && <p>Infor has not confirmed availability across these overlapping dates together. Use your usual process to complete this quote.</p>}
    {rooms.map(room => {
      const key = JSON.stringify([room.groupId, room.roomId]);
      const sourceOptions = stage.artifacts?.length ? stage.quote_selected_options ?? [] : stage.quote_options;
      const options = sourceOptions?.filter(option => option.group_id === room.groupId && option.room_id === room.roomId) ?? [];
      const picked = stage.artifacts?.length ? options[0] : options.find(option => option.option_index === selected[key]);
      const format = (code: string, meaning: string | null) => meaning && meaning !== code ? `${code} — ${meaning}` : code;
      return <fieldset key={key} className={quoteStyles.stay}>
        <legend>{room.label}</legend>
        {options.length ? <>
          <label className={styles.field}>Option
            <select value={picked ? String(picked.option_index) : ''} disabled={busy || Boolean(stage.artifacts?.length)}
              onChange={event => {
                const next = event.target.value;
                setSelected(current => {
                  const updated = { ...current };
                  if (next === '') delete updated[key];
                  else updated[key] = Number(next);
                  return updated;
                });
              }}>
              <option value="">Choose an option</option>
              {options.map(option => <option key={option.option_index} value={option.option_index}>
                {format(option.room.code, option.room.label)} · {format(option.rate.code, option.rate.label)}
              </option>)}
            </select>
          </label>
          {picked && <div className={quoteStyles.optionDetail}>
            <strong>{format(picked.room.code, picked.room.label)} · {format(picked.rate.code, picked.rate.label)}</strong>
            {typeof picked.meal_plan === 'string' && picked.meal_plan && <p>{picked.meal_plan}</p>}
            {picked.meal_plan && typeof picked.meal_plan === 'object' && !Array.isArray(picked.meal_plan) &&
              <p>{[picked.meal_plan.code, picked.meal_plan.label].filter(value => typeof value === 'string' && value).join(' · ')}</p>}
            <ul>{picked.nightly.map(night => <li key={night.date}>{night.date}: {night.price.currency} {night.price.amount} per room · {night.inventory} available</li>)}</ul>
          </div>}
        </> : <p>{stage.artifacts?.length ? 'The selected option is unavailable for these files. Check Infor again to make a new quote.'
          : stage.quote_choices?.some(option => option.group_id === room.groupId && option.room_id === room.roomId)
          ? 'Choose a room type and rate above, then check Infor again before making the files.'
          : 'No verified options for this room. Check the details and run Infor again.'}</p>}
      </fieldset>;
    })}
    {!stage.artifacts?.length && <button type="button" disabled={busy || selections.length !== rooms.length} onClick={() => onGenerateQuoteArtifacts(stage.quote_id!, selections)}>Create PDF and Excel</button>}
    {stage.artifacts?.length ? <p>To change these options, check the quote again.</p> : null}
  </PaneSection>;
}

function QuoteCover({ proposal, busy, drafts, onSaveQuoteDraft, onFindQuoteDraft, onOpenQuoteDraft, quoteConnectionReady, quoteDraftTarget = 'outlook' }: WorkflowProps) {
  const [body, setBody] = useState(proposal.reply_draft || 'Good day,\n\nPlease find the quotation attached.\n\nKind regards');
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [checking, setChecking] = useState(Boolean(onFindQuoteDraft));
  const [opened, setOpened] = useState<{ subject: string; body: string; files: string[]; to?: string; cc?: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const artifacts = proposal.stage?.artifacts ?? [];
  const pdf = artifacts.find(item => item.mime_type === 'application/pdf');
  const workbook = artifacts.find(item => item.mime_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const quoteId = proposal.stage?.quote_id, jobId = proposal.stage?.job_id;
  const artifactIds = quoteArtifactIds(artifacts);
  const binding: QuoteDraftBinding = { proposalId: proposal.id, revision: proposal.revision, quoteId: quoteId ?? '', jobId: jobId ?? '', artifactIds: artifactIds ?? ['', ''] };
  const bindingKey = JSON.stringify(binding);
  useEffect(() => {
    let active = true;
    setSaved(false); setOpened(null);
    if (onFindQuoteDraft && quoteConnectionReady !== false && quoteId && jobId && artifactIds && Object.keys(drafts).length === 0) {
      setChecking(true);
      void onFindQuoteDraft(JSON.parse(bindingKey)).then(found => { if (active) setSaved(found); })
        .catch(() => { if (active) setMessage('Could not check the saved draft. Try again.'); })
        .finally(() => { if (active) setChecking(false); });
    } else setChecking(false);
    return () => { active = false; };
  }, [bindingKey, refresh, quoteConnectionReady, Object.keys(drafts).length]);
  if (!pdf || !workbook || !artifactIds) return null;
  return <PaneSection title="Cover email and quote files">
    {!saved && <PaneField label="Cover email" control="textarea" value={body} disabled={busy || saving} onChange={value => { setBody(value); setMessage(null); }} />}
    <p>Files: {pdf.name}, {workbook.name}</p>
    {onSaveQuoteDraft && !saved && quoteConnectionReady === false && <p>Reconnect to Nava before saving the draft.</p>}
    {onSaveQuoteDraft && !saved && <button type="button" disabled={busy || saving || checking || Object.keys(drafts).length > 0 || !body.trim() || quoteConnectionReady === false} onClick={() => {
      setSaving(true); setMessage(null);
      void onSaveQuoteDraft(body).then(result => { setMessage(result.message); if (result.status === 'created') { setSaved(true); setRefresh(value => value + 1); } })
        .catch(() => setMessage('Could not confirm the draft. Check Drafts before trying again.')).finally(() => setSaving(false));
    }}>{saving ? 'Saving draft…' : quoteDraftTarget === 'webmail' ? 'Save unsent draft' : 'Save unsent Outlook draft'}</button>}
    {saved && onOpenQuoteDraft && <button type="button" disabled={busy || saving || quoteConnectionReady === false} onClick={() => {
      setSaving(true); setMessage(null);
      void onOpenQuoteDraft(binding).then(result => {
        if (result) setOpened(result);
        else if (quoteDraftTarget === 'outlook') setMessage('The draft is no longer available. Check Outlook Drafts.');
      }).catch(() => setMessage('Could not open the draft. Check Drafts and try again.')).finally(() => setSaving(false));
    }}>Open unsent draft</button>}
    {saved && <p role="status">Unsent draft saved. Staff review and send it.</p>}
    {message && <p role="status">{message}</p>}
    {opened && <div><strong>{opened.subject}</strong>{opened.to && <p>To: {opened.to}</p>}{opened.cc && <p>Cc: {opened.cc}</p>}<p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{opened.body}</p>
      <p>Files: {opened.files.join(', ')}</p><p>Open Outlook Drafts to edit and send.</p></div>}
  </PaneSection>;
}

function StaffContext({ busy, onAddContext }: WorkflowProps) {
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!onAddContext) return null;
  return <PaneSection title="Add missing details">
    <p>Tell Nava what is missing or needs correction. This updates the request; no email is sent.</p>
    <PaneField label="Details for Nava" control="textarea" value={text} disabled={busy || pending} onChange={value => { setText(value); setMessage(null); }} />
    <button type="button" disabled={busy || pending || !text.trim()} onClick={() => {
      setPending(true); setMessage(null);
      void onAddContext(text.trim()).then(result => { setMessage(result); if (result.startsWith('Nava is reviewing')) setText(''); })
        .catch(() => setMessage('Could not confirm the update. Check the request before trying again.')).finally(() => setPending(false));
    }}>{pending ? 'Updating request…' : 'Update request'}</button>
    {message && <p role="status">{message}</p>}
  </PaneSection>;
}

function GuestChoices({ proposal, drafts, busy, onSelectGuest }: WorkflowProps) {
  if (proposal.workflow !== 'create' || !onSelectGuest) return null;
  return <>{proposal.bookings.map((booking,index)=><GuestRoomChoices key={booking.id} proposal={proposal} drafts={drafts} busy={busy} index={index} onSelectGuest={onSelectGuest} />)}</>;
}

function GuestRoomChoices({proposal,drafts,busy,index,onSelectGuest}: Pick<WorkflowProps,'proposal'|'drafts'|'busy'> & {index:number;onSelectGuest:(candidate:GuestCandidate,roomIndex:number)=>void}) {
  const booking=proposal.bookings[index];
  const review=proposal.profile_reviews.find(item=>item.booking_id===booking.id && item.first_name===booking.fields.first_name && item.last_name===booking.fields.last_name && item.guest_email===(booking.fields.guest_email??null));
  const choices = currentNativeRoom(proposal,drafts,index)?.guest_candidates ?? review?.choices;
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) return null;
  if (choices.status === 'unavailable') return <PaneMessage>Guest profile choices are unavailable. Check the profile in Infor.</PaneMessage>;
  if (!Array.isArray(choices.items)) return null;
  const candidates = choices.items.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.native_id !== 'string' || !/^\d+$/.test(item.native_id) ||
      typeof item.first_name !== 'string' || !item.first_name.trim() || typeof item.last_name !== 'string' || !item.last_name.trim()) return [];
    return [{ nativeId: item.native_id, firstName: item.first_name, lastName: item.last_name,
      location: [item.city, item.country].filter((part): part is string => typeof part === 'string' && part.length > 0).join(', ') }];
  });
  const score=(candidate:{firstName:string;lastName:string})=>{
    const first=typeof booking.fields.first_name==='string'?booking.fields.first_name.trim().toLowerCase():'';
    const last=typeof booking.fields.last_name==='string'?booking.fields.last_name.trim().toLowerCase():'';
    const candidateFirst=candidate.firstName.trim().toLowerCase(), candidateLast=candidate.lastName.trim().toLowerCase();
    return (last && candidateLast===last ? 2 : 0) + (first && candidateFirst===first ? 2 : first && candidateFirst.startsWith(first) ? 1 : 0);
  };
  candidates.sort((a,b)=>score(b)-score(a));
  const coverage = choices.coverage;
  const complete = coverage && typeof coverage === 'object' && !Array.isArray(coverage) && coverage.complete === true && coverage.possibly_truncated === false && coverage.truncated === false;
  return <PaneSection title={proposal.bookings.length>1 ? `Choose guest profile · Room ${index+1}` : 'Choose a guest profile'}>
    {!complete && <p>Search coverage may be incomplete. Check the profile details in Infor.</p>}
    {candidates.length > 0 ? <PaneField label="Guest profile" control="select" value="" disabled={busy || uncertain(proposal) || ['prefilling', 'staging', 'saving', 'done'].includes(proposal.phase)} placeholder="Choose a profile"
      options={candidates.map(candidate => ({ value: candidate.nativeId, label: `${candidate.firstName} ${candidate.lastName} · ${candidate.nativeId}`, meaning: candidate.location || null }))}
      onChange={value => {
        const matches = candidates.filter(candidate => candidate.nativeId === value);
        if (matches.length === 1 && matches[0]) onSelectGuest(matches[0],index);
      }} /> : <p>No guest profiles were returned.</p>}
  </PaneSection>;
}

function StayTarget({proposal,drafts,busy,onLookupStay,onSelectStay}:WorkflowProps) {
  const booking=proposal.bookings[0];
  const [surname,setSurname]=useState('');
  const [confirmation,setConfirmation]=useState(booking?.reservation_id ?? '');
  const [changed,setChanged]=useState(false);
  const [previousJob,setPreviousJob]=useState<string | null>(null);
  const [removed,setRemoved]=useState<Record<string,boolean>>(()=>Object.fromEntries(
    ['guest_name','group_name','guest_names','confirmation_number','guest_last_name','guest_first_name','guest_names_hint','reservation_hint','confirmation_hint'].map(key=>[key,true])));
  if(!['amend','cancel'].includes(proposal.workflow) || proposal.disposition!=='propose' || proposal.bookings.length!==1 || !booking || !onLookupStay || !onSelectStay) return null;
  const stage=proposal.stage;
  const native=stage?.state==='target' && stage.revision===proposal.revision && proposal.phase==='ready' &&
    stage.job_id!==previousJob && !changed && Object.keys(drafts).length===0 ? stage.native_result : null;
  const result=native && typeof native==='object' && !Array.isArray(native) ? native : null;
  const selection=result?.selection && typeof result.selection==='object' && !Array.isArray(result.selection) ? result.selection : null;
  const state=selection?.current_state && typeof selection.current_state==='object' && !Array.isArray(selection.current_state) ? selection.current_state : null;
  const candidates=result?.kind==='surname' && Array.isArray(result.candidates) ? result.candidates : [];
  const locked=busy || proposal.phase!=='ready' || Object.keys(drafts).length>0;
  const exact=/^\d{6,10}-\d{1,10}$/;
  return <PaneSection title="Find the stay in Infor">
    <p>Search uses this mailbox’s hotel.</p>
    {proposal.stay_target_selected && <p>Selected: {booking.reservation_id} · {String(booking.current_state?.first_name ?? '')} {String(booking.current_state?.last_name ?? '')} · arrival {String(booking.current_state?.arrival_date ?? '')}</p>}
    {!proposal.stay_target_selected && booking.reservation_id && <p>Confirmation from the request: {booking.reservation_id}. Check and select the stay below.</p>}
    <PaneField label="Guest surname" control="text" value={surname} disabled={locked} onChange={value=>{setSurname(value);setChanged(true);}} />
    <button type="button" disabled={locked || !surname.trim()} onClick={()=>{setPreviousJob(stage?.job_id ?? '');setChanged(false);onLookupStay({kind:'surname',surname:surname.trim()});}}>Search by surname</button>
    <PaneField label="Exact confirmation number" control="text" value={confirmation} disabled={locked} hint="Include the suffix, for example 1234567890-1." onChange={value=>{setConfirmation(value);setChanged(true);}} />
    <button type="button" disabled={locked || !exact.test(confirmation.trim())} onClick={()=>{setPreviousJob(stage?.job_id ?? '');setChanged(false);onLookupStay({kind:'confirmation',confirmation:confirmation.trim()});}}>Check confirmation</button>
    {stage?.state==='target' && (changed || stage.job_id===previousJob || Object.keys(drafts).length>0) && <p>Search details changed. Previous results are out of date; search again.</p>}
    {result?.kind==='surname' && <>
      <p>{candidates.length>1 ? 'More than one stay matched. Choose a confirmation to check.' : 'Choose a confirmation to check.'} Search covers a limited date range; additional stays may exist.</p>
      {candidates.length===0 && <p>No matching stays were returned. Check the surname or use an exact confirmation.</p>}
      <ul>{candidates.map((candidate,index)=>{
        if(!candidate || typeof candidate!=='object' || Array.isArray(candidate) || typeof candidate.confirmation!=='string' || !exact.test(candidate.confirmation)) return null;
        const id=candidate.confirmation;
        return <li key={`${id}:${index}`}><button type="button" disabled={locked} onClick={()=>{setConfirmation(id);setPreviousJob(stage?.job_id ?? '');setChanged(false);onLookupStay({kind:'confirmation',confirmation:id});}}>
          {id} · {String(candidate.firstName ?? '')} {String(candidate.lastName ?? '')} · {String(candidate.arrival ?? '')} – {String(candidate.departure ?? '')}
        </button></li>;
      })}</ul>
    </>}
    {result?.kind==='confirmation' && selection && state && stage?.job_id && <>
      <p>Infor found: {String(selection.property_code)} · {String(selection.confirmation)} · {String(state.first_name)} {String(state.last_name)} · {String(state.arrival_date)} – {String(state.departure_date)} · {String(result.status)}</p>
      {proposal.workflow==='amend' && Object.keys(booking.fields).length>0 && <div>
        <p>Mark lookup clues that should not be sent as changes:</p>
        {Object.entries(booking.fields).map(([key,value])=><PaneField key={key} control="checkbox" label={`Remove ${proposal.field_specs.find(spec=>spec.path===`/bookings/0/fields/${key}`)?.label ?? key.replace(/_/g,' ')}: ${String(typeof value==='string'?value:JSON.stringify(value)).slice(0,100)} from changes`} value={removed[key]===true} disabled={locked}
          onChange={checked=>setRemoved(current=>({...current,[key]:checked}))} />)}
      </div>}
      <button type="button" disabled={locked} onClick={()=>onSelectStay(stage.job_id!,proposal.workflow==='amend'?Object.keys(booking.fields).filter(key=>removed[key]):[])}>Use this stay</button>
    </>}
  </PaneSection>;
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
  const locked = props.busy || uncertain(proposal) || ['prefilling', 'staging', 'saving', 'done'].includes(proposal.phase) ||
    (proposal.workflow === 'create' && proposal.phase === 'error' && Boolean(proposal.result?.rooms));
  const phaseMessage = proposal.phase === 'prefilling' ? proposal.workflow === 'quote' ? 'Nava is preparing the quote.' : 'Nava is reading the email.'
    : proposal.phase === 'staging' ? 'Checking in Infor…'
    : proposal.phase === 'saving' ? 'Saving in Infor… this can take up to 2 minutes.' : null;
  const stageCurrent = proposal.stage?.revision === proposal.revision && proposal.phase !== 'staging' && Object.keys(props.drafts).length === 0;
  const rateChoices = proposal.workflow === 'create' ? currentNativeResult(proposal, props.drafts)?.rate_choices : undefined;
  const rateChoicesUnavailable = Boolean(rateChoices && typeof rateChoices === 'object' && !Array.isArray(rateChoices) && rateChoices.status === 'unavailable');
  const dispositionMessage = {
    propose: null, needs_info: 'More information is needed.', decline: 'Marked for decline.',
    skip: 'No action needed.', staff_review: 'Needs review.',
  }[proposal.disposition];

  return <>
    {phaseMessage && <PaneMessage><span role="status">{phaseMessage}{longWait && (proposal.workflow === 'quote' && proposal.phase === 'prefilling' ? ' This is taking longer than expected. Nava is still working on the quote.' : ' This is taking longer than expected. Please wait.')}</span></PaneMessage>}
    {proposal.profile_outcome && <PaneMessage>Guest Profile creation is unconfirmed. Check Infor before trying again.{proposal.profile_outcome.native_id ? ` Guest Profile ID: ${proposal.profile_outcome.native_id}.` : ''}</PaneMessage>}
    {uncertain(proposal) && !proposal.error && <PaneMessage>Infor has not confirmed the outcome. Check Infor before trying again.</PaneMessage>}
    {proposal.error && <PaneMessage tone="error">
      {errorMessage(proposal)}
      {proposal.error.recovery?.trim() && <p>{proposal.error.recovery}</p>}
    </PaneMessage>}
    {dispositionMessage && <PaneMessage>{dispositionMessage}</PaneMessage>}
    {proposal.reason && <PaneMessage>{proposal.reason}</PaneMessage>}
    {proposal.missing.length > 0 && <PaneSection title="Information needed"><ul>{[...new Set(proposal.missing)].map(item => <li key={item}>{item}</li>)}</ul></PaneSection>}
    {proposal.warnings.length > 0 && <PaneSection title="Check these details"><ul>{[...new Set(proposal.warnings)].map(item => <li key={item}>{item}</li>)}</ul></PaneSection>}
    {['needs_info', 'staff_review'].includes(proposal.disposition) && <StaffContext key={proposal.id} {...props} />}
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
    <StayTarget key={proposal.id} {...props} />
    {proposal.workflow === 'quote' && proposal.field_specs.length > 0 && <QuoteFields {...props} locked={locked} />}
    <GuestChoices {...props} busy={locked} />
    {proposal.workflow==='create' && proposal.bookings.some(booking=>booking.fields.profile_create_new===true && !booking.fields.guest_profile_id) && <PaneMessage>Review the matching profiles, name, mobile and email. The next button creates the new Guest Profile, even if Infor asks about the same name, then checks the price. The profile is Active; consent is off. If an email is supplied, its type is Primary.</PaneMessage>}
    {proposal.workflow !== 'quote' && proposal.field_specs.length > 0 && <PaneSection title="Details">
      {proposal.field_specs.map(spec => <Field key={spec.path} {...props} spec={spec} locked={locked} />)}
      {proposal.workflow === 'filing' && !proposal.field_specs.some(spec => /^\/actions\/(?:0|[1-9]\d*)\/details\/attachment_id$/.test(spec.path) && spec.editable) && <PaneMessage>PDF selection is unavailable for this request. Handle it using your usual process.</PaneMessage>}
    </PaneSection>}
    {rateChoicesUnavailable && <PaneMessage>Infor rate choices are unavailable for these stay details. Verify the rate code in Infor.</PaneMessage>}
    {proposal.workflow === 'quote' && <QuoteRequests proposal={proposal} />}
    {proposal.workflow === 'quote' && <QuoteChecks {...props} />}
    {proposal.workflow !== 'quote' && proposal.display_rows.length > 0 && <PaneSection title="Infor details">
      <NativeRows rows={proposal.display_rows} proposal={proposal} />
    </PaneSection>}
    {proposal.stage && !stageCurrent && <PaneMessage>{proposal.phase === 'staging' ? 'A new check is in progress; earlier results are hidden.' : 'Details have changed since the last check. Check again for current Infor results.'}</PaneMessage>}
    {proposal.workflow === 'quote' && stageCurrent && proposal.stage?.job_id && <QuoteOptions key={`options:${proposal.id}:${proposal.revision}:${proposal.stage.job_id}`} {...props} />}
    {proposal.stage && stageCurrent && proposal.stage.state !== 'target' && <PaneSection title="Checked details">
      {proposal.stage.summary.length > 0 && <div className={styles.stageSummary}>
        <strong>Check notes</strong>
        <ul>{[...new Set(proposal.stage.summary)].map(item => <li key={item}>{item}</li>)}</ul>
      </div>}
      <ObservedFields proposal={proposal} />
      {proposal.workflow === 'quote' && proposal.stage.quote_options?.length ? null
        : proposal.stage.display_rows.length > 0 ? <NativeRows rows={proposal.stage.display_rows} proposal={proposal} /> : <p>No price or availability details were provided for this check.</p>}
      {proposal.workflow === 'quote' && proposal.stage.artifacts?.map(artifact => <p key={artifact.id}>
        {props.onOpenArtifact ? <button type="button" onClick={() => props.onOpenArtifact?.(artifact.id)}>{artifact.name}</button> : artifact.name}
      </p>)}
      {proposal.phase !== 'done' && ['create', 'amend', 'cancel', 'filing'].includes(proposal.workflow) && <p>{proposal.workflow==='create' ? 'This check did not save a booking in Infor.' : 'This check did not save changes in Infor.'}</p>}
    </PaneSection>}
    {proposal.workflow === 'quote' && stageCurrent && proposal.stage?.job_id && <QuoteCover key={`cover:${proposal.id}:${proposal.revision}:${proposal.stage.job_id}`} {...props} />}
    {proposal.result && proposal.workflow !== 'quote' && <PaneSection title="Infor result">
      {proposal.result.rooms && <ul>{proposal.result.rooms.map((room,index)=><li key={room.booking_id}>Room {index+1}: {room.state==='saved' ? `confirmed${room.confirmation ? ` · Confirmation ${room.confirmation}` : ''}${room.reservation_id ? ` · Reservation ${room.reservation_id}` : ''}` : room.state==='unattempted' ? 'not attempted' : room.state==='dispatched' || room.state==='uncertain' ? 'outcome unconfirmed; check Infor' : 'not saved'}</li>)}</ul>}
      {proposal.result.readback !== null && proposal.phase === 'done' && <p role="status">{
        proposal.workflow === 'cancel' ? 'Infor confirms the booking is cancelled.'
          : proposal.workflow === 'filing' ? 'Infor confirms the PDF is in the stay’s Documents.'
          : proposal.workflow === 'amend' ? 'Infor confirms the changes were saved.'
          : 'Infor confirms the booking was saved.'
      }</p>}
      {proposal.result.confirmation && <p style={{ fontSize: '1.25em', fontWeight: 600 }}>Confirmation: {proposal.result.confirmation}</p>}
      {proposal.result.reservation_id && <p>Reservation: {proposal.result.reservation_id}</p>}
      {proposal.result.display_rows.length > 0 && <NativeRows rows={proposal.result.display_rows} proposal={proposal} />}
      {proposal.result.artifacts.map(artifact => <p key={artifact.id}>{props.onOpenArtifact
        ? <button type="button" onClick={() => props.onOpenArtifact?.(artifact.id)}>{artifact.name}</button>
        : artifact.name}</p>)}
    </PaneSection>}
    {proposal.phase === 'done' && !proposal.result && <PaneMessage>No readback was provided. Refresh this proposal.</PaneMessage>}
    {proposal.reply_draft !== null && (proposal.workflow !== 'quote' || proposal.revision === 1 && Object.keys(props.drafts).length === 0) && <PaneSection title={proposal.workflow === 'quote' ? 'Initial reply draft' : 'Reply draft'}>
      {proposal.workflow === 'quote' && <p>This draft may contain outdated rates. Check current prices in Infor before using it.</p>}
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{proposal.reply_draft}</p>
    </PaneSection>}
  </>;
}

export function hasWorkflowAction(proposal: Proposal) {
  return proposal.actions.some(action => action.type === proposal.workflow ||
    proposal.workflow === 'filing' && ['attach_document', 'voucher_submission', 'payment_proof_submission'].includes(action.type));
}

export function workflowPrimaryAction({ proposal, drafts, busy, onStage, onReconcile }: WorkflowFooterProps) {
  const dirty = Object.keys(drafts).length > 0;
  if (uncertain(proposal)) return onReconcile ? { label: 'Check Infor', disabled: busy, onClick: onReconcile } : undefined;
  const mutableWorkflow = proposal.workflow === 'triage' || proposal.workflow === 'create' || proposal.workflow === 'amend' || proposal.workflow === 'cancel' || proposal.workflow === 'filing';
  if (!mutableWorkflow) return undefined;
  if (proposal.workflow !== 'triage' && (proposal.disposition !== 'propose' || !hasWorkflowAction(proposal))) return undefined;
  if ((proposal.workflow === 'amend' || proposal.workflow === 'cancel') && !proposal.stay_target_selected) return undefined;
  if ((proposal.workflow === 'amend' || proposal.workflow === 'cancel') && proposal.stage?.state === 'target') return undefined;
  if ((proposal.phase === 'ready' || proposal.phase === 'waiting_go') && onStage) return { label: proposal.workflow === 'triage' ? 'Look up in Infor' : proposal.workflow === 'create' && proposal.bookings.some(booking=>booking.fields.profile_create_new===true && !booking.fields.guest_profile_id) ? 'Create Guest Profile and check price' : 'Prepare in Infor', disabled: dirty || busy, onClick: onStage };
  return undefined;
}
