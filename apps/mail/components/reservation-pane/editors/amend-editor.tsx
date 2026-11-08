'use client';

import { useEffect, useRef, useState } from 'react';
import type { WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { effectiveAt, record, requestPath, text, valueAt } from '@/lib/reservation-workflow/views';
import { Field, Count, Section } from '../shared/stay-fields';
import { NativePicker } from '../shared/native-pickers';
import styles from './other-editors.module.css';

type Editor = WorkbenchEditorProps;
const fields = [
  ['arrival', 'Arrival', 'date'], ['departure', 'Departure', 'date'], ['roomType', 'Room category', 'code'],
  ['ratePlan', 'Rate plan', 'code'], ['adults', 'Adults', 'count'], ['childCount', 'Children', 'count'],
  ['childAges', 'Child ages', 'ages'], ['firstName', 'Guest first name', 'text'], ['lastName', 'Guest last name', 'text'],
  ['guestEmail', 'Guest email', 'email'], ['bookerName', 'Booker name', 'text'], ['bookerContact', 'Booker contact', 'text'],
  ['cmsSend', 'Send confirmation', 'boolean'], ['cmsMessageId', 'Confirmation template', 'text'],
  ['cmsRecipient', 'Confirmation recipient', 'email'],
] as const;
const clearable = new Set(['guestEmail', 'bookerName', 'bookerContact', 'cmsSend', 'cmsMessageId', 'cmsRecipient']);
const priceFields = new Set(['arrival', 'departure', 'roomType', 'ratePlan', 'adults', 'childCount', 'childAges']);
const rows = (value: unknown) => Array.isArray(value) ? value.map(record) : [];

export function StayFacts({ stay }: { stay: Record<string, unknown> }) {
  return <div className={styles.facts}>
    <strong>{text(stay.confirmation)} · {[text(stay.firstName), text(stay.lastName)].filter(Boolean).join(' ')}</strong>
    <span>{text(stay.arrival)} → {text(stay.departure)} · {text(stay.status) || 'Status not returned'}</span>
    {Boolean(stay.roomType || stay.ratePlan) && <span>{text(stay.roomType)} · {text(stay.ratePlan)}</span>}
  </div>;
}

/** An email confirmation is only a search hint; selection binds a complete native observation. */
export function TargetSearch({ editor, body, hint, index, workflow }: {
  editor: Editor; body: string; hint: Record<string, unknown>; index: number; workflow: 'amend' | 'cancel' | 'services';
}) {
  const root = `${body}/targets/include/${index}`;
  const path = `${root}/suggestedRef`;
  const selected = valueAt(editor.snapshot, path);
  const query = (key: string) => text(valueAt(editor.snapshot, `${root}/${key}`)) || null;
  const candidates = editor.snapshot.session.draft.observations.flatMap(observation => {
    const c = observation.criteria, q = record(c.query), result = record(observation.result);
    if (observation.kind !== 'stay_candidate' || observation.status !== 'complete' || !record(observation.coverage).complete
      || observation.generationId !== editor.snapshot.session.draft.generationId || c.workflow !== workflow
      || c.requestId !== editor.request.id || c.hintId !== hint.id
      || (workflow === 'amend' ? c.selectionPath !== path : workflow === 'services' ? c.kind !== 'saved_target' || c.fieldPath !== path : c.stage !== 'lookup' || c.fieldPath !== path)) return [];
    const arrival = workflow === 'cancel' ? q.arrival : q.bookedArrival;
    const departure = workflow === 'cancel' ? q.departure : q.bookedDeparture;
    if ((q.confirmation ?? null) !== query('confirmation') || (q.guestName ?? null) !== query('guestName')
      || (arrival ?? null) !== query('bookedArrival') || (departure ?? null) !== query('bookedDeparture')) return [];
    const stay = record(workflow === 'cancel' ? result.preimage : result.candidate);
    return Object.keys(stay).length ? [{ observation, stay }] : [];
  });
  return <div className={styles.stack}>
    <div className={styles.grid}>
      <Field label="Confirmation or supplier reference" path={`${root}/confirmation`} editor={editor} />
      <Field label="Guest name" path={`${root}/guestName`} editor={editor} />
      <Field label="Original arrival" path={`${root}/bookedArrival`} type="date" editor={editor} />
      <Field label="Original departure" path={`${root}/bookedDeparture`} type="date" editor={editor} />
    </div>
    <span className={styles.hint}>{workflow === 'cancel' || workflow === 'services' ? 'Enter the exact Infor confirmation to find this stay.' : 'Search by confirmation, or guest and original arrival.'}</span>
    {candidates.map(({ observation, stay }) => <div className={styles.card} key={observation.ref}>
      <StayFacts stay={stay} />
      <div className={styles.row}><button type="button" disabled={editor.view.busy} onClick={() => void (async () => {
        if (workflow !== 'cancel' && valueAt(editor.snapshot, `${body}/targets/mode`) === 'unresolved') await editor.commands.edit(`${body}/targets/mode`, 'explicit');
        await editor.commands.selectNative(path, observation.ref);
      })()}>
        {selected === observation.ref ? 'Selected stay' : 'Select this stay'}
      </button></div>
    </div>)}
    {!candidates.some(candidate => candidate.observation.ref === selected) && <span className={styles.hint}>Find and select an exact Infor stay before checking changes.</span>}
  </div>;
}

function ChangeList({ editor, path, label }: { editor: Editor; path: string; label: string }) {
  const changes = rows(effectiveAt(editor.snapshot, path));
  const [choice, setChoice] = useState('');
  const add = () => {
    if (!choice) return;
    const spec = fields.find(field => field[0] === choice);
    const value = spec?.[2] === 'count' ? 0 : spec?.[2] === 'ages' ? [] : spec?.[2] === 'boolean' ? false : '';
    const change = choice === 'shift_dates' || choice === 'shift_departure'
      ? { op: choice, days: 0, sourceRefs: [] } : { op: 'set', field: choice, value, sourceRefs: [] };
    const raw = valueAt(editor.snapshot, path);
    void editor.commands.edit(path, [...(Array.isArray(raw) ? raw : []), change]);
    setChoice('');
  };
  return <div className={styles.stack}>
    <strong>{label}</strong>
    {!changes.length && <span className={styles.hint}>No changes: keep current values.</span>}
    {changes.map((change, index) => <ChangeRow key={`${path}/${index}`} editor={editor} path={`${path}/${index}`} change={change} />)}
    <div className={styles.row}>
      <label className={styles.label}>Add requested change
        <select value={choice} disabled={editor.view.busy} onChange={event => setChoice(event.target.value)}>
          <option value="">Choose a field</option>
          {fields.map(([name, title]) => <option value={name} key={name}>{title}</option>)}
          <option value="shift_dates">Shift both dates</option><option value="shift_departure">Shift departure</option>
        </select>
      </label>
      <button type="button" disabled={!choice || editor.view.busy} onClick={add}>Add change</button>
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
  const known = Boolean(spec || op === 'shift_dates' || op === 'shift_departure');
  const setOp = (next: string) => void editor.commands.edit(`${path}/op`, next);
  const valuePath = `${path}/value`;
  return <div className={styles.card}>
    <div className={styles.row}><strong>{op === 'shift_dates' ? 'Shift both dates' : op === 'shift_departure' ? 'Shift departure' : spec?.[1] || field || 'Source request'}</strong>
      {!known && <span>Needs Infor</span>}
      <button type="button" disabled={editor.view.busy} onClick={() => void editor.commands.edit(`${path}/op`, kept ? originalOp : null, kept ? 'set' : 'none')}>{kept ? 'Restore change' : 'Keep current'}</button></div>
    {kept ? <span className={styles.hint}>Keep current for this change. Original request remains available to restore.</span> : !known ? <div className={styles.warning}>This requested change is not connected to Amend. Complete it in Infor; it blocks this amendment until resolved.</div> :
      op === 'shift_dates' || op === 'shift_departure' ? <Field label="Days to shift" path={`${path}/days`} type="number" editor={editor} hint="Each stay uses its own original dates." /> : <>
        <label className={styles.label}>Change
          <select value={op} disabled={editor.view.busy} onChange={event => setOp(event.target.value)}>
            <option value="set">Set</option>{clearable.has(field) && <option value="clear">Clear</option>}
          </select>
        </label>
        {op === 'clear' ? <span className={styles.hint}>Clear this field on the selected stay.</span> : spec?.[2] === 'ages' ? <AgeInput editor={editor} path={valuePath} /> :
          spec?.[2] === 'count' ? <Count label={spec[1]} path={valuePath} editor={editor} min={field === 'adults' ? 1 : 0} max={field === 'adults' ? 16 : 9} /> :
          spec?.[2] === 'boolean' ? <label className={styles.label}>{spec[1]}<select disabled={editor.view.busy}
            value={String(valueAt(editor.snapshot, valuePath))} onChange={event => void editor.commands.edit(valuePath, event.target.value === 'true')}>
            <option value="true">Yes</option><option value="false">No</option></select></label> :
          spec?.[2] === 'code' ? <NativePicker label={spec[1]} path={valuePath} editor={editor} /> :
          <Field label={spec?.[1] || 'Value'} path={valuePath} editor={editor} type={spec?.[2] === 'date' ? 'date' : spec?.[2] === 'email' ? 'email' : 'text'} />}
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
  const perPath = `${body}/perTarget`, per = rows(effectiveAt(editor.snapshot, perPath));
  const sharedPath = `${body}/sharedChanges`, shared = rows(effectiveAt(editor.snapshot, sharedPath));
  return <div className={styles.stack}>
    <Section title="Find saved stays">
      <p className={styles.hint}>Select exact Infor stays. Unmentioned fields stay unchanged. Each stay is checked and saved separately.</p>
      {scope.mode === 'scoped_all' && <div className={styles.warning}>Identify individual stays before changing this group.</div>}
      {exclusions.map((hint, i) => <div className={styles.hint} key={i}>Excluded: {text(hint.confirmation) || text(hint.guestName) || 'Unidentified stay'}</div>)}
      {targets.map((hint, i) => <div className={styles.card} key={text(hint.id) || i}>
        <strong>Stay {i + 1}</strong><TargetSearch editor={editor} body={body} hint={hint} index={i} workflow="amend" />
      </div>)}
      <div className={styles.row}><button type="button" disabled={editor.view.busy} onClick={() => void editor.commands.changeRows({ kind: 'add_target', requestId: editor.request.id })}>Add stay</button>
        <button type="button" disabled={editor.view.busy || !targets.length} onClick={() => void editor.commands.lookup()}>Find in Infor</button></div>
    </Section>
    <Section title="Changes for all included stays"><ChangeList editor={editor} path={sharedPath} label="Shared changes" /></Section>
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
          <button type="button" disabled={editor.view.busy || !hintId} onClick={() => void editor.commands.changeRows({
            kind: 'add_target', requestId: editor.request.id, entityId: hintId,
          })}>Add changes for this stay</button></div> : <div className={styles.stack}>
          <ChangeList editor={editor} path={`${root}/changes`} label="Only this stay" />
          <Field label="Rate handling" path={`${root}/rateHandling`} editor={editor} options={[{ value: 'retain', label: 'Keep current rate' }, { value: 'reprice', label: 'Reprice in Infor' }]} />
          {pricing && valueAt(editor.snapshot, `${root}/rateHandling`) !== 'reprice' && <div className={styles.warning}>Date, occupancy, room or rate changes require repricing.</div>}
          {latest && <div className={styles.card}><strong>Last Infor check</strong>
            <span>{text(before.arrival)} → {text(before.departure)} · {text(before.roomType)} / {text(before.ratePlan)}</span>
            <span>Requested: {text(target.arrival)} → {text(target.departure)} · {text(target.roomType)} / {text(target.ratePlan)}</span>
            <span>New total: {displayPrice(result.approvedPrices)}</span><small className={styles.hint}>Check again after changing inputs.</small>
          </div>}
        </div>}
      </Section>;
    })}
  </div>;
}
