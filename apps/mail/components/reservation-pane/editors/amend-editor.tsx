'use client';

import { useEffect, useRef, useState } from 'react';
import type { WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { effectiveAt, record, requestPath, savedTargetOperationLocks, text, valueAt } from '@/lib/reservation-workflow/views';
import { Field, Count, Section } from '../shared/stay-fields';
import { NativePicker } from '../shared/native-pickers';
import { ReservationNote } from '../shared/reservation-note';
import styles from './other-editors.module.css';

type Editor = WorkbenchEditorProps;
const fields = [
  ['arrival', 'Arrival Date', 'date'], ['departure', 'Departure Date', 'date'],
  ['roomType', 'Room Type', 'code'], ['roomTypeForCharge', 'Room Type for Charge', 'code'],
  ['ratePlan', 'Rate Plan', 'code'], ['mealPlan', 'Meal Plan', 'text'],
  ['roomCount', 'Rooms', 'count'], ['adults', 'Adults', 'count'], ['childCount', 'Children', 'count'],
  ['childAges', 'Child ages', 'ages'], ['firstName', 'First Name', 'text'], ['lastName', 'Last Name', 'text'],
  ['guestEmail', 'E-mail Address', 'email'], ['bookingAgency', 'Primary Booking Agency', 'party'],
  ['organization', 'Organization', 'party'], ['arAccount', 'A/R Account', 'party'],
  ['billingReference', 'Billing Reference', 'text'], ['taCommission', 'TA Commission (%)', 'text'],
  ['guaranteeType', 'Guarantee Type', 'code'], ['track', 'Track / Sub Segment', 'code'],
  ['bookerName', 'Booker name', 'text'], ['bookerEmail', 'Booker email', 'email'], ['bookerMobile', 'Booker mobile', 'text'],
  ['guestOptIn', 'Terms and Conditions', 'terms'],
  ['reservationNote', 'Reservation Note', 'note'], ['cmsSend', 'CMS Send Mail', 'boolean'],
  ['cmsMessageId', 'CMS Message Id', 'code'], ['cmsRecipient', 'CMS Booker Email', 'email'],
] as const;
const clearable = new Set(['guestEmail', 'billingReference',
  'bookerName', 'bookerEmail', 'bookerMobile', 'guestOptIn', 'reservationNote', 'cmsSend', 'cmsMessageId', 'cmsRecipient']);
const unsupportedClears = new Set(['bookingAgency', 'organization', 'arAccount', 'taCommission', 'track', 'guaranteeType']);
const priceFields = new Set(['arrival', 'departure', 'roomType', 'roomTypeForCharge', 'ratePlan', 'mealPlan', 'roomCount', 'adults', 'childCount', 'childAges']);
const unsupportedFieldLabels: Record<string, string> = {};
const rows = (value: unknown) => Array.isArray(value) ? value.map(record) : [];

export function isExactConfirmation(value: unknown): boolean {
  return typeof value === 'string' && /^\d{6,10}-\d{1,2}$/.test(value.trim());
}

function exactConfirmation(hint: Record<string, unknown>) {
  return isExactConfirmation(hint.confirmation) ? text(hint.confirmation).trim() : '';
}

function definitelyDistinct(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftConfirmation = exactConfirmation(left), rightConfirmation = exactConfirmation(right);
  if (leftConfirmation && rightConfirmation) return leftConfirmation !== rightConfirmation;
  const normalize = (value: unknown) => typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() : '';
  const nameForms = (value: unknown) => {
    if (typeof value !== 'string') return [];
    const parts = value.split(',');
    return [...new Set([normalize(value), ...(parts.length === 2 ? [normalize(`${parts[1]?.trim()} ${parts[0]?.trim()}`)] : [])])]
      .filter(Boolean);
  };
  const leftNames = nameForms(left.guestName), rightNames = nameForms(right.guestName);
  const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const leftArrival = left.bookedArrival, leftDeparture = left.bookedDeparture;
  const rightArrival = right.bookedArrival, rightDeparture = right.bookedDeparture;
  const disjointDates = validDate(leftArrival) && validDate(leftDeparture) && validDate(rightArrival) && validDate(rightDeparture) &&
    (leftDeparture <= rightArrival || rightDeparture <= leftArrival);
  return leftNames.length > 0 && rightNames.length > 0 && !leftNames.some(name => rightNames.includes(name)) && disjointDates;
}

function lockedScope(editor: Editor) {
  return savedTargetOperationLocks(editor.snapshot, editor.request.id);
}

function lockedTarget(editor: Editor, hintId: string) {
  if (!hintId) return true;
  const draft = editor.snapshot.session.draft;
  return draft.operationResults.some(result => {
    if (result.requestId !== editor.request.id) return false;
    const locked = result.status === 'succeeded' || result.status === 'unknown' || result.status === 'failed' &&
      (!result.observationRefs.length || !result.observationRefs.every(ref => {
        const observation = draft.observations.find(row => row.ref === ref);
        return observation?.criteria.workflow === result.workflow && observation.criteria.requestId === result.requestId &&
          observation.criteria.stage === 'prepare';
      }));
    if (!locked) return false;
    if (result.workflow === 'amend') return !result.allocationId || result.allocationId === hintId;
    if (result.workflow !== 'services') return true;
    const refs = new Set(result.observationRefs);
    const bound = draft.observations.find(row => refs.has(row.ref) && row.criteria.workflow === 'services' &&
      row.criteria.requestId === editor.request.id && row.criteria.targetRef && typeof row.criteria.targetRef === 'object');
    const target = record(bound?.criteria.targetRef);
    return target.kind !== 'saved_target' || target.requestId !== editor.request.id ||
      typeof target.hintId !== 'string' || target.hintId === hintId;
  });
}

async function correctAmendScope(editor: Editor, body: string,
  include: Record<string, unknown>[], exclude: Record<string, unknown>[], hint: Record<string, unknown>,
  from: 'include' | 'exclude') {
  if (lockedScope(editor) || !text(hint.id)) return;
  const includePath = `${body}/targets/include`, excludePath = `${body}/targets/exclude`;
  const modePath = `${body}/targets/mode`, id = text(hint.id);
  if (valueAt(editor.snapshot, modePath) !== 'explicit') await editor.commands.edit(modePath, 'explicit');
  if (from === 'include') {
    if (include.length < 2) return;
    const duplicate = exclude.some(row => text(row.id) === id || exactConfirmation(row) && exactConfirmation(row) === exactConfirmation(hint));
    if (!duplicate) await editor.commands.edit(excludePath, [...exclude, hint]);
    await editor.commands.edit(includePath, include.filter(row => text(row.id) !== id));
    return;
  }
  const duplicate = include.some(row => text(row.id) === id || exactConfirmation(row) && exactConfirmation(row) === exactConfirmation(hint));
  if (!duplicate) {
    if (!include.every(row => definitelyDistinct(row, hint))) return;
    await editor.commands.edit(includePath, [...include, hint]);
  }
  await editor.commands.edit(excludePath, exclude.filter(row => text(row.id) !== id));
  const perTarget = rows(effectiveAt(editor.snapshot, `${body}/perTarget`));
  if (!perTarget.some(row => row.hintId === id)) {
    await editor.commands.changeRows({ kind: 'add_target', requestId: editor.request.id, entityId: id });
  }
}

export function StayFacts({ stay }: { stay: Record<string, unknown> }) {
  return <div className={styles.facts}>
    <strong>{text(stay.confirmation)} · {[text(stay.firstName), text(stay.lastName)].filter(Boolean).join(' ')}</strong>
    <span>{text(stay.arrival)} → {text(stay.departure)} · {text(stay.status) || 'Status not returned'}</span>
    {Boolean(stay.roomType || stay.ratePlan) && <span>{text(stay.roomType)} · {text(stay.ratePlan)}</span>}
  </div>;
}

/** An email confirmation is only a search hint; selection binds a complete native observation. */
export function TargetSearch({ editor, body, hint, index, workflow, locked = false }: {
  editor: Editor; body: string; hint: Record<string, unknown>; index: number; workflow: 'amend' | 'cancel' | 'services' | 'filing'; locked?: boolean;
}) {
  const root = `${body}/targets/include/${index}`;
  const path = `${root}/suggestedRef`;
  const selected = valueAt(editor.snapshot, path);
  const normalized = (value: unknown) => text(value).trim() || null;
  const query = (key: string) => normalized(valueAt(editor.snapshot, `${root}/${key}`));
  const reference = query('confirmation');
  const invalidReference = reference && !isExactConfirmation(reference);
  const perTarget = rows(effectiveAt(editor.snapshot, `${body}/perTarget`)).find(row => row.hintId === hint.id);
  const changes = workflow === 'amend' ? [
    ...rows(effectiveAt(editor.snapshot, `${body}/sharedChanges`)), ...rows(perTarget?.changes),
  ] : [];
  const repeatedDates = (['arrival', 'departure'] as const).filter(field => {
    const original = query(field === 'arrival' ? 'bookedArrival' : 'bookedDeparture');
    return original && changes.some(change => change.op === 'set' && change.field === field && change.value === original);
  });
  const draft = editor.snapshot.session.draft;
  const sameName = (left: unknown, right: unknown) => typeof left === 'string' && typeof right === 'string' &&
    left.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() ===
      right.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  const currentLookup = workflow === 'cancel' ? [...draft.observations].reverse().find(observation => {
    const criteria = observation.criteria, q = record(criteria.query), result = record(observation.result);
    return observation.kind === 'stay_candidate' && criteria.workflow === 'cancel' && criteria.stage === 'lookup' &&
      criteria.requestId === editor.request.id && criteria.hintId === hint.id &&
      normalized(q.confirmation) === query('confirmation') && normalized(q.guestName) === query('guestName') &&
      normalized(q.arrival) === query('bookedArrival') && normalized(q.departure) === query('bookedDeparture') &&
      Object.keys(record(result.currentStay)).length > 0;
  }) : undefined;
  const currentStayRecord = record(record(currentLookup?.result).currentStay);
  const currentStay = Object.keys(currentStayRecord).length ? currentStayRecord : null;
  const currentGuestName = currentStay ? text(currentStay.guestName) ||
    [text(currentStay.firstName), text(currentStay.lastName)].filter(Boolean).join(' ') : '';
  const currentMismatchFields = currentStay ? [
    query('guestName') && !sameName(query('guestName'), currentGuestName) && !sameName(query('guestName'), currentStay.lastName) ? 'guestName' : null,
    query('bookedArrival') && query('bookedArrival') !== normalized(currentStay.arrival) ? 'bookedArrival' : null,
    query('bookedDeparture') && query('bookedDeparture') !== normalized(currentStay.departure) ? 'bookedDeparture' : null,
  ].filter((field): field is string => Boolean(field)) : [];
  const candidates = editor.snapshot.session.draft.observations.flatMap(observation => {
    const c = observation.criteria, q = record(c.query), result = record(observation.result);
    if (observation.kind !== 'stay_candidate' || observation.status !== 'complete' || !record(observation.coverage).complete
      || observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode
      || observation.sourceMessageId !== draft.source.messageId || c.workflow !== workflow
      || c.requestId !== editor.request.id || (workflow === 'filing' ? c.targetHintId !== hint.id : c.hintId !== hint.id)
      || (workflow === 'amend' ? c.selectionPath !== path : workflow === 'services' ? c.kind !== 'saved_target' || c.fieldPath !== path
        : workflow === 'filing' ? normalized(c.confirmation) !== query('confirmation') ||
          normalized(c.bookedArrival) !== query('bookedArrival') : c.stage !== 'lookup' || c.fieldPath !== path)) return [];
    const arrival = workflow === 'cancel' ? q.arrival : q.bookedArrival;
    const departure = workflow === 'cancel' ? q.departure : q.bookedDeparture;
    if (workflow !== 'filing') {
      const confirmationMatches = normalized(q.confirmation) === query('confirmation');
      const queryMatches = confirmationMatches && normalized(q.guestName) === query('guestName')
        && normalized(arrival) === query('bookedArrival') && normalized(departure) === query('bookedDeparture');
      if (!queryMatches) return [];
    }
    const stay = record(workflow === 'cancel' ? result.preimage : workflow === 'filing' ? result.stay : result.candidate);
    if (!isExactConfirmation(stay.confirmation) || reference && (!isExactConfirmation(reference) || normalized(stay.confirmation) !== reference)) return [];
    if (workflow === 'filing' && (normalized(c.confirmation) !== query('confirmation') ||
        normalized(c.bookedArrival) !== query('bookedArrival'))) return [];
    const candidateName = [text(stay.firstName), text(stay.lastName)].filter(Boolean).join(' ');
    const sourceMismatchFields = workflow === 'cancel' || workflow === 'filing' ? [
      query('guestName') && !(workflow === 'cancel' && sameName(query('guestName'), stay.lastName)) && !sameName(query('guestName'), candidateName) ? 'guestName' : null,
      query('bookedArrival') && query('bookedArrival') !== normalized(stay.arrival) ? 'bookedArrival' : null,
      query('bookedDeparture') && query('bookedDeparture') !== normalized(stay.departure) ? 'bookedDeparture' : null,
    ].filter((field): field is string => Boolean(field)) : [];
    const recordedMismatches = Array.isArray(result.sourceHintMismatchFields)
      ? result.sourceHintMismatchFields.filter((field): field is string => typeof field === 'string') : [];
    if (workflow === 'cancel' && (JSON.stringify(sourceMismatchFields) !== JSON.stringify(recordedMismatches) ||
        sourceMismatchFields.length > 0 && result.sourceHintMismatchReviewRequired !== true)) return [];
    return Object.keys(stay).length ? [{ observation, stay, sourceMismatchFields,
      selectable: workflow !== 'filing' || sourceMismatchFields.length === 0 }] : [];
  });
  return <div className={styles.stack}>
    <div className={styles.grid}>
      <Field label="Infor confirmation" path={`${root}/confirmation`} editor={editor} review disabled={locked} />
      <Field label="Guest name" path={`${root}/guestName`} editor={editor} review disabled={locked} />
      <Field label="Original arrival" path={`${root}/bookedArrival`} type="date" editor={editor} review disabled={locked} />
      <Field label="Original departure" path={`${root}/bookedDeparture`} type="date" editor={editor} review disabled={locked} />
    </div>
    {invalidReference && <div className={styles.warning}>This reference is not an Infor confirmation.
      {workflow === 'amend' ? <> Clear it to search by guest name and original arrival.
        <button type="button" disabled={locked || editor.view.busy} onClick={() => void editor.commands.edit(`${root}/confirmation`, null, 'none')}>Clear reference</button></>
        : ' Enter the Infor confirmation to find the stay.'}
    </div>}
    {repeatedDates.map(field => <div className={styles.warning} key={field}>
      Original {field} matches the requested new {field}. Clear it if the original date is unknown.
      <button type="button" disabled={locked || editor.view.busy} onClick={() => void editor.commands.edit(
        `${root}/${field === 'arrival' ? 'bookedArrival' : 'bookedDeparture'}`, null, 'none')}>Clear original {field}</button>
    </div>)}
    <span className={styles.hint}>{workflow === 'cancel' || workflow === 'services' || workflow === 'filing'
      ? 'Enter the exact Infor confirmation to find this stay.' : 'Search by confirmation, or guest and original arrival.'}</span>
    {workflow === 'cancel' && currentStay && <div className={styles.card}>
      <strong>Current Infor record · {text(currentStay.confirmation)}</strong>
      <span>{currentGuestName || 'Guest not returned'} · {text(currentStay.arrival) || 'arrival not returned'} → {text(currentStay.departure) || 'departure not returned'}</span>
      <span>Status: {text(currentStay.status) || 'not returned'}</span>
      {text(currentStay.roomType) || text(currentStay.ratePlan) ? <span>{text(currentStay.roomType)} · {text(currentStay.ratePlan)}</span> : null}
      <small className={styles.hint}>Source: {query('confirmation') || 'no confirmation'} · {query('guestName') || 'guest not specified'} · {query('bookedArrival') || 'arrival not specified'} → {query('bookedDeparture') || 'departure not specified'}</small>
      {currentStay.status !== 'Reserved' && <div className={styles.warning}>This stay is {text(currentStay.status) || 'not confirmed as Reserved'} and cannot be cancelled here. No cancellation was prepared.</div>}
      {currentMismatchFields.length > 0 && <div className={styles.warning}>Infor differs from the source guest or dates. Review the exact confirmation and current facts before selecting it; update the source hints and search again if this is not the intended stay.</div>}
    </div>}
    {candidates.map(({ observation, stay, sourceMismatchFields, selectable }) => <div className={styles.card} key={observation.ref}>
      <StayFacts stay={stay} />
      {workflow === 'cancel' && sourceMismatchFields.length > 0 && <div className={styles.warning}>Guest or dates differ from the source. Selecting this exact confirmation records your review of the mismatch.</div>}
      {workflow === 'filing' && sourceMismatchFields.length > 0 && <div className={styles.warning}>Update the source guest and stay dates to the verified Infor facts, then check again before filing.</div>}
      <div className={styles.row}><button type="button" disabled={editor.view.busy || locked || !selectable} onClick={() => void (async () => {
        if (valueAt(editor.snapshot, `${body}/targets/mode`) !== 'explicit') await editor.commands.edit(`${body}/targets/mode`, 'explicit');
        await editor.commands.selectNative(path, observation.ref);
      })()}>
        {selected === observation.ref ? 'Selected stay' : workflow === 'cancel' && sourceMismatchFields.length ? 'Review and select this confirmation' : 'Select this stay'}
      </button></div>
    </div>)}
    {!candidates.some(candidate => candidate.observation.ref === selected) && !currentStay &&
      <span className={styles.hint}>Find and select an exact Infor stay before checking changes.</span>}
  </div>;
}

function ChangeList({ editor, path, label }: { editor: Editor; path: string; label: string }) {
  const changes = rows(effectiveAt(editor.snapshot, path));
  const add = (choice: string) => {
    if (!choice) return;
    const spec = fields.find(field => field[0] === choice);
    const value = spec?.[2] === 'count' ? (choice === 'adults' || choice === 'roomCount' ? 1 : 0) : spec?.[2] === 'ages' ? [] : spec?.[2] === 'boolean' || spec?.[2] === 'terms' ? false : spec?.[2] === 'party' ? { name: null, candidateRefs: [], suggestedRef: null } : '';
    const change = choice === 'shift_dates' || choice === 'shift_departure'
      ? { op: choice, days: 0, sourceRefs: [] } : { op: 'set', field: choice, value, sourceRefs: [] };
    const raw = valueAt(editor.snapshot, path);
    void editor.commands.edit(path, [...(Array.isArray(raw) ? raw : []), change]);
  };
  return <div className={styles.stack}>
    {label && <strong>{label}</strong>}
    {!changes.length && <span className={styles.hint}>No changes: keep current values.</span>}
    {changes.map((change, index) => <ChangeRow key={`${path}/${index}`} editor={editor} path={`${path}/${index}`} change={change} />)}
    <div className={styles.row}>
      <label className={styles.changeAdd}><span className={styles.visuallyHidden}>Add requested change</span>
        <select value="" disabled={editor.view.busy} onChange={event => add(event.target.value)}>
          <option value="">+ Change</option>
          {fields.filter(([name]) => name !== 'roomCount').map(([name, title]) => <option value={name} key={name}>{name === 'guestOptIn' ? `Clear ${title}` : title}</option>)}
          <option value="shift_dates">Shift both dates</option><option value="shift_departure">Shift departure</option>
        </select>
      </label>
    </div>
  </div>;
}

function AgeInput({ editor, path }: { editor: Editor; path: string }) {
  const current = valueAt(editor.snapshot, path);
  const initial = Array.isArray(current) ? current.join(', ') : text(current);
  const [value, setValue] = useState(initial);
  const dirty = useRef(false), version = useRef(0), staged = useRef<unknown>(null);
  const parse = (input: string) => {
    const parts = input.trim() ? input.split(',').map(part => part.trim()) : [];
    const ages = parts.map(Number);
    return parts.length <= 9 && parts.every((part, index) => /^\d+$/.test(part) && ages[index]! <= 17) ? ages : input;
  };
  useEffect(() => { if (!dirty.current) setValue(initial); }, [initial]);
  useEffect(() => () => { version.current += 1; editor.commands.setUncommitted(path, false); }, [path]);
  return <label className={styles.label}>Child ages (comma separated)
    <input value={value} disabled={editor.view.busy} onChange={event => {
      const next = event.target.value;
      setValue(next); dirty.current = true; version.current += 1; staged.current = parse(next);
      editor.commands.setUncommitted(path, true); editor.commands.stageEdit(path, staged.current);
    }} onBlur={() => {
      if (!dirty.current) return;
      const before = version.current, pending = staged.current;
      void editor.commands.edit(path, pending).then(() => {
        if (version.current !== before) return;
        dirty.current = false; editor.commands.setUncommitted(path, false);
        setValue(Array.isArray(pending) ? pending.join(', ') : text(pending));
      }).catch(() => {});
    }} />
  </label>;
}

function ChangeRow({ editor, path, change }: { editor: Editor; path: string; change: Record<string, unknown> }) {
  const original = record(valueAt(editor.snapshot, path));
  const kept = editor.snapshot.session.draft.fieldOverrides[`${path}/op`]?.state === 'none';
  const originalOp = text(original.op);
  const op = text(change.op) || originalOp, field = text(change.field), spec = fields.find(item => item[0] === field);
  const unsupportedClear = !kept && op === 'clear' && unsupportedClears.has(field);
  const sourceClear = originalOp === 'clear' && unsupportedClears.has(field);
  const known = Boolean(spec || op === 'shift_dates' || op === 'shift_departure');
  const setOp = (next: string) => void editor.commands.edit(`${path}/op`, next === 'keep' ? null : next, next === 'keep' ? 'none' : 'set');
  const valuePath = `${path}/value`;
  const unsupportedValue = !known && original.value !== undefined && original.value !== null
    ? Array.isArray(original.value) ? original.value.join(', ') : String(original.value) : null;
  const title = op === 'shift_dates' ? 'Shift both dates' : op === 'shift_departure' ? 'Shift departure'
    : spec?.[1] || unsupportedFieldLabels[field] || (field ? 'Additional requested change' : 'Source request');
  return <div className={styles.card}>
    <div className={styles.changeHeading}><strong>{title}</strong>
      {!known && <span>Needs Infor</span>}
      <select aria-label={`Change ${title}`} value={kept ? 'keep' : op} disabled={editor.view.busy} onChange={event => setOp(event.target.value)}>
        <option value="keep">Keep current</option>
        {field === 'guestOptIn' ? <option value={op === 'clear' ? 'clear' : 'set'}>Clear setting</option>
          : op === 'shift_dates' || op === 'shift_departure' ? <option value={op}>Apply shift</option> : known ? <>
          <option value="set">Set</option>{clearable.has(field) && <option value="clear">Clear</option>}
          {unsupportedClear && <option value="clear" disabled>Requested clear</option>}
        </> : <option value={op}>Requested</option>}
      </select></div>
    {field === 'roomCount' && <span className={styles.hint}>Add or cancel rooms as separate reservations.{!kept && ' Select Keep current to save other changes.'}</span>}
    {kept && field === 'roomCount' && original.value != null && <span className={styles.hint}>Requested rooms: {text(original.value)}</span>}
    {unsupportedValue !== null && <small className={styles.hint}>Requested: {unsupportedValue}</small>}
    {sourceClear && !unsupportedClear && <span className={styles.hint}>Original request: clear this field. {kept ? 'Infor will keep the current value.' : 'Enter or select a replacement.'}</span>}
    {!kept && field === 'taCommission' && op === 'set' && typeof original.value === 'string' && <span className={styles.hint}>
      Requested commission: {original.value}.{typeof valueAt(editor.snapshot, valuePath) === 'string' && ' Enter the percentage as a number.'}
    </span>}
    {kept ? sourceClear ? null : <span className={styles.hint}>{known ? 'Original request can be restored here.'
      : 'Infor will leave this field unchanged. Handle the displayed request manually if it is still essential.'}</span> : !known ? <div className={styles.warning}>
        Nava cannot apply this additional requested change in Amend. Keep the saved stay unchanged here and handle the request manually in Infor if it remains essential.
      </div> :
      op === 'shift_dates' || op === 'shift_departure' ? <Field label="Days to shift" path={`${path}/days`} type="number" editor={editor} compact hint="Each stay uses its own original dates." /> : <>
        {unsupportedClear ? <div className={styles.warning} role="alert">This request asks to clear {title}. It cannot be cleared here. Choose Keep current to save other changes, or Set to choose a replacement.</div> :
          op === 'clear' ? <span className={styles.hint}>Clear this field on the selected stay.</span> : spec?.[2] === 'ages' ? <AgeInput editor={editor} path={valuePath} /> :
          spec?.[2] === 'count' ? <Count label={spec[1]} path={valuePath} editor={editor} min={field === 'adults' || field === 'roomCount' ? 1 : 0} max={field === 'adults' ? 16 : field === 'roomCount' ? 8 : 9} /> :
          spec?.[2] === 'note' ? <ReservationNote path={valuePath} editor={editor} /> :
          spec?.[2] === 'terms' ? valueAt(editor.snapshot, valuePath) === false
            ? <span className={styles.hint}>This setting will be cleared.</span>
            : <div className={styles.warning}>This setting cannot be enabled here. Clear it to continue.
              <button type="button" disabled={editor.view.busy} onClick={() => void editor.commands.edit(valuePath, false)}>Clear setting</button></div> :
          spec?.[2] === 'party' ? <NativePicker label={spec[1]} path={valuePath} editor={editor} partyRole compact /> :
          spec?.[2] === 'boolean' ? <label className={styles.label}>{spec[1]}<select disabled={editor.view.busy}
            value={String(valueAt(editor.snapshot, valuePath))} onChange={event => void editor.commands.edit(valuePath, event.target.value === 'true')}>
            <option value="true">Yes</option><option value="false">No</option></select></label> :
          spec?.[2] === 'code' ? <NativePicker label={spec[1]} path={valuePath} editor={editor}
            kind={field === 'roomType' ? 'room_type' : field === 'roomTypeForCharge' ? 'room_type_for_charge' : field === 'cmsMessageId' ? 'cms_message' : field === 'guaranteeType' ? 'guarantee' : field === 'track' ? 'track' : 'rate_plan'} compact /> :
          <Field label={spec?.[1] || 'Value'} path={valuePath} editor={editor} compact type={spec?.[2] === 'date' ? 'date' : spec?.[2] === 'email' ? 'email' : field === 'taCommission' ? 'number' : 'text'} maxLength={field === 'billingReference' ? 4000 : undefined} nativeMaxLength={field === 'billingReference' ? 50 : undefined} hint={field === 'billingReference' ? 'Select an A/R Account. Infor accepts at most 50 characters.' : field === 'guestEmail' ? 'Use the guest’s own email only when explicitly stated.' : field === 'taCommission' ? 'Enter a percentage from 0 to 100.' : undefined} />}
      </>}
  </div>;
}

function displayPrice(price: unknown) {
  const row = record(price); const cents = text(row.totalCents);
  return /^\d+$/.test(cents) ? `${text(row.currency)} ${(Number(cents) / 100).toFixed(2)}` : 'Not returned';
}

export function AmendEditor(editor: Editor) {
  const body = `${requestPath(editor.request.id)}/body`;
  const scope = record(effectiveAt(editor.snapshot, `${body}/targets`));
  const targets = rows(scope.include), exclusions = rows(scope.exclude);
  const scopeLocked = lockedScope(editor);
  const perPath = `${body}/perTarget`, per = rows(effectiveAt(editor.snapshot, perPath));
  const sharedPath = `${body}/sharedChanges`, shared = rows(effectiveAt(editor.snapshot, sharedPath));
  return <div className={styles.stack}>
    <Section title="Find saved stays">
      <p className={styles.hint}>Select exact Infor stays. Unmentioned fields stay unchanged. Each stay is checked and saved separately.</p>
      {scopeLocked && <div className={styles.warning}>This Amend has a recorded success, failure, or uncertain result. Written or uncertain stays remain locked; untouched stays can still be corrected and checked. Reconcile before changing target scope.</div>}
      {scope.mode !== 'explicit' && targets.length > 0 && <div className={styles.row}>
        <div className={styles.warning}>This request covers a group. Switch to its listed stays and handle each exact stay separately.</div>
        <button type="button" disabled={editor.view.busy || scopeLocked} onClick={() => void editor.commands.edit(`${body}/targets/mode`, 'explicit')}>Use listed stays individually</button>
      </div>}
      {exclusions.map((hint, i) => {
        const duplicate = targets.some(target => text(target.id) === text(hint.id) || exactConfirmation(target) && exactConfirmation(target) === exactConfirmation(hint));
        const safelyDistinct = duplicate || targets.every(target => definitelyDistinct(target, hint));
        return <div className={styles.card} key={text(hint.id) || i}>
        <strong>Excluded · unchanged</strong>
        <div className={styles.grid}>
          <Field editor={editor} path={`${body}/targets/exclude/${i}/confirmation`} label="Infor confirmation" disabled={lockedTarget(editor, text(hint.id))} />
          <Field editor={editor} path={`${body}/targets/exclude/${i}/guestName`} label="Guest name" disabled={lockedTarget(editor, text(hint.id))} />
          <Field editor={editor} path={`${body}/targets/exclude/${i}/bookedArrival`} label="Original arrival" type="date" disabled={lockedTarget(editor, text(hint.id))} />
          <Field editor={editor} path={`${body}/targets/exclude/${i}/bookedDeparture`} label="Original departure" type="date" disabled={lockedTarget(editor, text(hint.id))} />
        </div>
        <small className={styles.hint}>Correct missing or ambiguous identity facts above, then Find in Infor. This stay remains excluded until you explicitly include it.</small>
        <button type="button" disabled={editor.view.busy || scopeLocked || scope.mode !== 'explicit' || !safelyDistinct}
          onClick={() => void correctAmendScope(editor, body, targets, exclusions, hint, 'exclude').catch(() => {})}>
          Include this exact stay in this Amend action
        </button>
        {!safelyDistinct && <small className={styles.warning}>This exclusion may overlap an included stay. Correct its exact confirmation or enter a different guest and fully disjoint original dates before including it.</small>}
        </div>;
      })}
      {targets.map((hint, i) => <div className={styles.card} key={text(hint.id) || i}>
        <strong>Stay {i + 1}</strong><TargetSearch editor={editor} body={body} hint={hint} index={i} workflow="amend" locked={lockedTarget(editor, text(hint.id))} />
        {targets.length > 1 && <button type="button" disabled={editor.view.busy || scopeLocked || scope.mode !== 'explicit'}
          onClick={() => void correctAmendScope(editor, body, targets, exclusions, hint, 'include').catch(() => {})}>
          Exclude this exact stay; preserve its change details
        </button>}
      </div>)}
      <div className={styles.row}><button type="button" disabled={editor.view.busy || scopeLocked} onClick={() => void editor.commands.changeRows({ kind: 'add_target', requestId: editor.request.id })}>Add stay</button>
        <button type="button" disabled={editor.view.busy || !targets.length} onClick={() => void editor.commands.lookup()}>Find in Infor</button></div>
    </Section>
    <Section title="Changes for all included stays"><ChangeList editor={editor} path={sharedPath} label="" /></Section>
    {targets.map((hint, i) => {
      const hintId = text(hint.id), perIndex = per.findIndex(row => row.hintId === hintId);
      const root = `${perPath}/${perIndex}`; const changes = perIndex < 0 ? [] : rows(effectiveAt(editor.snapshot, `${root}/changes`));
      const pricing = [...shared, ...changes].some(row => row.op === 'shift_dates' || row.op === 'shift_departure' || row.op === 'set' && priceFields.has(text(row.field)));
      const selected = valueAt(editor.snapshot, `${body}/targets/include/${i}/suggestedRef`);
      const latest = [...editor.snapshot.session.draft.observations].reverse().find(o => o.kind === 'rate_availability' && o.status === 'complete'
        && o.criteria.workflow === 'amend' && o.criteria.requestId === editor.request.id && o.criteria.hintId === hintId
        && o.criteria.selectedRef === selected && record(o.result).outcome === 'prepared');
      const result = record(latest?.result), before = record(result.before), target = record(result.target);
      return <Section key={hintId || i} title={`Changes for ${text(hint.confirmation) || text(hint.guestName) || `stay ${i + 1}`}`}>
        {perIndex < 0 ? <div className={styles.warning}>Add this stay’s change and rate handling before checking.
          <button type="button" disabled={editor.view.busy || scopeLocked || !hintId} onClick={() => void editor.commands.changeRows({
            kind: 'add_target', requestId: editor.request.id, entityId: hintId,
          })}>Add changes for this stay</button></div> : <div className={styles.stack}>
          <ChangeList editor={editor} path={`${root}/changes`} label="Only this stay" />
          <Field label="Rate handling" path={`${root}/rateHandling`} editor={editor} compact options={[{ value: 'retain', label: 'Keep current rate' }, { value: 'reprice', label: 'Reprice in Infor' }]} />
          {pricing && valueAt(editor.snapshot, `${root}/rateHandling`) !== 'reprice' && <div className={styles.warning}>Date, occupancy, room or rate changes require repricing.</div>}
          {latest && <div className={styles.card}><strong>Last Infor check</strong>
            <span>{text(before.arrival)} → {text(before.departure)} · {text(before.roomType)} / {text(before.ratePlan)}</span>
            <span>Requested: {text(target.arrival)} → {text(target.departure)} · {text(target.roomType)} / {text(target.ratePlan)}</span>
            <span>{result.callbackPriceReviewRequired === true ? 'Indicative total' : 'New total'}: {displayPrice(result.approvedPrices)}</span>
            <small className={styles.hint}>{result.callbackPriceReviewRequired === true ? 'Infor will return the current price after applying the requested details.' : 'Check again after changing inputs.'}</small>
          </div>}
        </div>}
      </Section>;
    })}
  </div>;
}
