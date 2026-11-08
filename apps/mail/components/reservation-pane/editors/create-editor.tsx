'use client';

import { useEffect, useRef, useState } from 'react';
import { effectiveAt, record, requestPath, text, valueAt, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { Count, Field, Section } from '../shared/stay-fields';
import { NativePicker } from '../shared/native-pickers';
import styles from './create-quote-editor.module.css';

type Editor = WorkbenchEditorProps;
type BookingField = { key: string; label: string; picker?: string; party?: boolean; type?: string; hint?: string };
const roomFields: BookingField[] = [
  { key: 'roomType', label: 'Room Type', picker: 'room_type' },
  { key: 'roomTypeForCharge', label: 'Room Type for Charge', picker: 'room_type_for_charge', hint: 'Blank uses the Infor default. Infor checks the price for the selected category.' },
  { key: 'ratePlan', label: 'Rate Plan', picker: 'rate_plan' },
];
const partyFields: BookingField[] = [
  { key: 'bookingAgency', label: 'Primary Booking Agency', party: true },
  { key: 'organization', label: 'Organization', party: true },
  { key: 'arAccount', label: 'A/R Account', party: true },
  { key: 'billingReference', label: 'Billing Reference', hint: 'Applied when the reservation is saved.' },
];
const stayFields: BookingField[] = [
  { key: 'reasonForStay', label: 'Reason for Stay', picker: 'reason_for_stay' },
  { key: 'sourceOfBusiness', label: 'Source of Business', picker: 'source_of_business' },
  { key: 'guaranteeType', label: 'Guarantee Type', picker: 'guarantee' },
];
const trackField: BookingField = { key: 'track', label: 'Track / Sub Segment', picker: 'track' };
const otherFields: BookingField[] = [
  { key: 'bookerName', label: 'Booker name' },
  { key: 'bookerContact', label: 'Booker contact' },
  { key: 'reservationNote', label: 'Reservation note', type: 'textarea' },
  { key: 'cmsSend', label: 'CMS Send Mail', type: 'checkbox' },
  { key: 'cmsMessageId', label: 'CMS Message Id', picker: 'cms_message' },
  { key: 'cmsRecipient', label: 'CMS Booker Email', type: 'email' },
];
const allFields = [...partyFields, ...stayFields, ...roomFields, trackField, ...otherFields];

function BookingControl({ field, path, editor }: { field: BookingField; path: string; editor: Editor }) {
  return field.picker || field.party
    ? <><NativePicker label={field.label} path={path} editor={editor} kind={field.picker} allowNone={field.party || field.key === 'roomTypeForCharge'} />
      {field.hint && <p className={styles.note}>{field.hint}</p>}</>
    : <Field label={field.label} path={path} editor={editor} type={field.type} hint={field.hint} />;
}

function hasOwn(editor: Editor, path: string) {
  const override = editor.snapshot.session.draft.fieldOverrides[path];
  if (override) return override.state !== 'inherit';
  if (Object.entries(editor.snapshot.session.draft.fieldOverrides).some(([key, value]) => key.startsWith(`${path}/`) && value.state !== 'inherit')) return true;
  const value = valueAt(editor.snapshot, path);
  return value !== undefined && value !== null;
}

function inheritedValue(editor: Editor, paths: string[]) {
  for (const path of paths) {
    if (!hasOwn(editor, path)) continue;
    return effectiveAt(editor.snapshot, path);
  }
  return undefined;
}

function ownSummary(editor: Editor, base: string) {
  return allFields.filter((field) => hasOwn(editor, `${base}/${field.key}`)).map((field) => {
    const value = effectiveAt(editor.snapshot, `${base}/${field.key}`);
    const shown = typeof value === 'boolean' ? (value ? 'Yes' : 'No') : text(value) || 'None';
    return `${field.label}: ${shown}`;
  }).join(', ');
}

function ScopedField({ field, path, parentPaths, parentLabel, editor }: {
  field: BookingField; path: string; parentPaths: string[]; parentLabel: string; editor: Editor;
}) {
  const own = hasOwn(editor, path);
  const inherited = inheritedValue(editor, parentPaths);
  const label = text(inherited) || (typeof inherited === 'boolean' ? (inherited ? 'Yes' : 'No') : 'Not set');
  return <div className={styles.scopeField}>
    {own ? <>
      <BookingControl field={field} path={path} editor={editor} />
      <button type="button" className={styles.linkButton} onClick={() => void editor.commands.edit(path, undefined, 'inherit')}>Use {parentLabel} ({label})</button>
    </> : <div className={styles.inherited}>
      <span><b>{field.label}</b><small>{parentLabel}: {label}</small></span>
      <button type="button" className={styles.linkButton} onClick={() => void editor.commands.edit(path,
        inherited === undefined || inherited === null ? (field.party ? { name: null, candidateRefs: [], suggestedRef: null }
          : field.type === 'checkbox' ? false : '') : inherited)}>Set own</button>
    </div>}
  </div>;
}

/** Save count and age slots together; unknown ages stay blank. */
export function ChildAges({ editor, path }: { editor: Editor; path: string }) {
  const countPath = `${path}/childCount`, agesPath = `${path}/childAges`;
  const countValue = valueAt(editor.snapshot, countPath);
  const ageValue = valueAt(editor.snapshot, agesPath);
  const [count, setCount] = useState(countValue == null ? '' : String(countValue));
  const [ages, setAges] = useState<Array<number | null>>(Array.isArray(ageValue) ? ageValue as Array<number | null> : []);
  const ageInput = useRef(ages);
  const staged = useRef<Record<string, unknown> | null>(null);
  const dirtyCount = useRef(false), dirtyAges = useRef(false);
  const countVersion = useRef(0), agesVersion = useRef(0);
  useEffect(() => () => { editor.commands.setUncommitted(countPath, false); editor.commands.setUncommitted(agesPath, false); }, [path]);
  useEffect(() => { if (!dirtyCount.current) setCount(countValue == null ? '' : String(countValue)); }, [countValue]);
  useEffect(() => { if (!dirtyAges.current && !dirtyCount.current) {
    const next = Array.isArray(ageValue) ? ageValue as Array<number | null> : [];
    ageInput.current = next; setAges(next);
  } }, [JSON.stringify(ageValue)]);
  const validAge = (age: number | null) => age != null && Number.isInteger(age) && age >= 0 && age <= 17 ? age : null;
  const stage = (childCount: number | null, childAges: Array<number | null> | null) => {
    const next = { ...record(effectiveAt(editor.snapshot, path)), childCount, childAges };
    staged.current = next;
    editor.commands.stageEdit(path, next);
  };
  const commit = async (kind: 'count' | 'ages') => {
    const dirty = kind === 'count' ? dirtyCount : dirtyAges;
    const version = kind === 'count' ? countVersion : agesVersion;
    if (!dirty.current || !staged.current) return;
    const pending = staged.current, before = version.current;
    await editor.commands.edit(path, pending);
    if (version.current !== before) return;
    dirty.current = false;
    if (kind === 'count') {
      setCount(pending.childCount == null ? '' : String(pending.childCount));
      editor.commands.setUncommitted(countPath, false);
    } else editor.commands.setUncommitted(agesPath, false);
    if (staged.current === pending) {
      const next = Array.isArray(pending.childAges) ? pending.childAges as Array<number | null> : [];
      ageInput.current = next; setAges(next);
    }
  };
  return <>
    <label className={styles.localField}>Children
      <input type="number" min="0" max="12" value={count} onChange={(event) => {
        const value = event.target.value, numeric = value === '' ? null : Number(value);
        const next = numeric != null && Number.isInteger(numeric) && numeric >= 0 && numeric <= 12 ? numeric : null;
        const resized = next == null ? null : Array.from({ length: next }, (_, index) => validAge(ageInput.current[index] ?? null));
        setCount(value); if (resized) ageInput.current = resized; setAges(resized ?? []);
        dirtyCount.current = true; countVersion.current += 1; editor.commands.setUncommitted(countPath, true);
        stage(next, resized);
      }} onBlur={() => void commit('count').catch(() => {})} />
    </label>
    {Number.isInteger(Number(count)) && Number(count) > 0 && Number(count) <= 12 && <div className={styles.ageGrid}>
      {Array.from({ length: Number(count) }, (_, index) => <label className={styles.localField} key={index}>Child {index + 1} age
        <input type="number" min="0" max="17" value={ages[index] ?? ''} onChange={(event) => {
          const next = [...ageInput.current]; next[index] = event.target.value === '' ? null : Number(event.target.value);
          ageInput.current = next; setAges(next);
          dirtyAges.current = true; agesVersion.current += 1; editor.commands.setUncommitted(agesPath, true);
          stage(Number(count), Array.from({ length: Number(count) }, (_, i) => validAge(next[i] ?? null)));
        }} onBlur={() => void commit('ages').catch(() => {})} />
      </label>)}
    </div>}
  </>;
}

function Price({ editor, allocationId }: { editor: Editor; allocationId: string }) {
  const price = editor.snapshot.preparationViews.find((item) => item.requestId === editor.request.id && item.allocationId === allocationId);
  if (!price?.price) return null;
  const details = price.price;
  const operation = [...editor.snapshot.session.draft.operationResults].reverse().find((item) => item.requestId === editor.request.id &&
    item.allocationId === allocationId && item.workflow === 'create' && item.status === 'prepared');
  const observation = price.current && operation ? editor.snapshot.session.draft.observations.find((item) =>
    operation.observationRefs.includes(item.ref) && item.kind === 'rate_availability' && item.status === 'complete') : undefined;
  const input = record(record(observation?.result).semanticInput), stay = record(input.stay), room = record(input.room);
  return <div className={styles.price}>
    <strong>{price.current ? 'Infor price' : 'Infor price · check needed'}</strong>
    {details && <span>{text(details.currency)} {text(details.totalRate) || '—'} total{details.averageRate != null ? ` · ${text(details.averageRate)} average` : ''}</span>}
    {observation && <small>{text(stay.arrival)} – {text(stay.departure)} · {text(stay.adults)} adults, {text(stay.childCount)} children · {text(room.roomType)} / {text(room.ratePlan)}
      {observation.observedAt ? ` · observed ${new Date(observation.observedAt).toLocaleString()}` : ''}</small>}
    {price.issue && <small>Price needs attention. Check the room details.</small>}
  </div>;
}

// Match the continuation's last terminal result for this room.
function completedRoom(editor: Editor, allocationId: string) {
  const result = [...editor.snapshot.operationResults].reverse().find((row) => row.workflow === 'create' &&
    row.requestId === editor.request.id && row.allocationId === allocationId && ['succeeded', 'unknown'].includes(String(row.status)));
  return result?.status === 'succeeded' ? result : undefined;
}

function SavedRoom({ editor, result, index }: { editor: Editor; result: Record<string, unknown>; index: number }) {
  const draft = editor.snapshot.session.draft;
  const operation = draft.operationResults.find((row) => row.id === result.id && row.workflow === 'create');
  const observation = operation && draft.observations.find((row) => operation.observationRefs.includes(row.ref) &&
    row.kind === 'stay_candidate' && row.status === 'complete' && row.coverage.complete &&
    row.criteria.workflow === 'create' && row.criteria.requestId === editor.request.id && row.criteria.allocationId === operation.allocationId);
  const receipt = record(observation?.result), readback = record(receipt.nativeReadback);
  const fields = Array.isArray(readback.fields) ? readback.fields.map(record) : [];
  const field = (name: string, recoveredName?: string) => {
    const matching = fields.filter((item) => item.name === name);
    return matching.length === 1 ? text(matching[0]?.value) : text(recoveredName ? readback[recoveredName] : '');
  };
  const name = [field('firstname', 'firstName'), field('lastname', 'lastName')].filter(Boolean).join(' ');
  const arrival = field('arrivaldate', 'arrival'), departure = field('departuredate', 'departure');
  const room = field('roomtype', 'roomType'), rate = field('rateplan', 'ratePlan');
  const chargeRoom = field('roomtypecharge', 'roomTypeForCharge');
  const price = record(receipt.savedPrice);
  const confirmation = text(receipt.confirmation) || text(result.confirmation);
  return <div className={styles.roomCard}>
    <div className={styles.groupHeading}><strong>Room {index + 1} · Created</strong></div>
    {confirmation && <div>Confirmation {confirmation}</div>}
    {name && <div>{name}</div>}
    {(arrival || departure) && <div>{arrival || '—'} – {departure || '—'}</div>}
    {(room || rate) && <div>{[room, rate].filter(Boolean).join(' / ')}{chargeRoom ? ` · Room Type for Charge ${chargeRoom}` : ''}</div>}
    {price.totalRate != null && <div>{text(price.currency)} {text(price.totalRate)} total</div>}
    {!confirmation && <p className={styles.note}>{text(result.summary) || 'Saved in Infor; receipt details unavailable.'}</p>}
    <p className={styles.note}>This room is saved. Use Amend to change it.</p>
  </div>;
}

function Nights({ editor, sectionPath }: { editor: Editor; sectionPath: string }) {
  const arrival = text(valueAt(editor.snapshot, `${sectionPath}/arrival`));
  const departure = text(valueAt(editor.snapshot, `${sectionPath}/departure`));
  const date = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const result = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(result) && new Date(result).toISOString().slice(0, 10) === value ? result : NaN;
  };
  const nights = (date(departure) - date(arrival)) / 86400000;
  return <label className={styles.localField}>Nights<input value={Number.isInteger(nights) && nights > 0 ? String(nights) : ''} readOnly /></label>;
}

function GuestDetails({ editor, allocationPath }: { editor: Editor; allocationPath: string }) {
  return <div className={styles.stack}>
    <div className={styles.twoCol}>
      <Field label="Last Name" path={`${allocationPath}/guest/lastName`} editor={editor} />
      <Field label="First Name" path={`${allocationPath}/guest/firstName`} editor={editor} />
    </div>
    <Field label="Mobile Number" path={`${allocationPath}/guest/mobile`} editor={editor} type="tel" disabled hint="Shown for reference; this does not update the Infor profile." />
    <Field label="E-mail Address" path={`${allocationPath}/guest/email`} editor={editor} type="email" />
    {editor.snapshot.issues.filter((issue) => issue.kind === 'guest_email_conflict' && issue.path === `${allocationPath}/guest/email`)
      .map((issue, index) => <p className={styles.notice} key={index}>{issue.explanation}</p>)}
    <p className={styles.note}>Matching details do not change the Infor profile.</p>
  </div>;
}

export function CreateEditor(editor: Editor) {
  const { snapshot, request, commands, view } = editor;
  const bodyPath = `${requestPath(request.id)}/body`;
  const body = record(effectiveAt(snapshot, bodyPath));
  const sections = Array.isArray(body.dateSections) ? body.dateSections.map(record) : [];
  const allocations = Array.isArray(body.allocations) ? body.allocations.map(record) : [];
  const shared = `${bodyPath}/shared`;
  const hasCompleted = allocations.some((allocation) => Boolean(completedRoom(editor, text(allocation.id))));
  const allCompleted = allocations.length > 0 && allocations.every((allocation) => Boolean(completedRoom(editor, text(allocation.id))));
  return <div className={styles.editor}>
    {hasCompleted && <p className={styles.notice}>Saved rooms keep their confirmed details. Changes to shared values and dates apply to remaining rooms only.</p>}
    <Section title={hasCompleted ? 'Stay · remaining rooms' : 'Stay'}>
      <fieldset disabled={allCompleted} className={styles.plainFieldset}>
        {partyFields.map((field) => <BookingControl key={field.key} field={field} path={`${shared}/${field.key}`} editor={editor} />)}
      </fieldset>
      {sections.map((section, sectionIndex) => {
        const sectionPath = `${bodyPath}/dateSections/${sectionIndex}`;
        const sectionId = String(section.id ?? '');
        const rooms = allocations.map((allocation, index) => ({ allocation, index })).filter(({ allocation }) => allocation.dateSectionId === section.id);
        const sectionHasCompleted = rooms.some(({ allocation }) => Boolean(completedRoom(editor, text(allocation.id))));
        const sectionAllCompleted = rooms.length > 0 && rooms.every(({ allocation }) => Boolean(completedRoom(editor, text(allocation.id))));
        const unassigned = Array.isArray(section.unassignedGuestNames) ? section.unassignedGuestNames.filter((name): name is string => typeof name === 'string') : [];
        const requested = valueAt(snapshot, `${sectionPath}/requestedRooms`);
        return <div className={styles.group} key={sectionId || sectionIndex}>
          {sections.length > 1 && <div className={styles.groupHeading}><strong>Stay dates {sectionIndex + 1}</strong>
            <button type="button" className={styles.linkButton} disabled={view.busy || sectionHasCompleted || allocations.length - rooms.length < 1}
              onClick={() => void commands.changeRows({ kind: 'remove_date_section', requestId: request.id, entityId: sectionId,
                childIds: rooms.map(({ allocation }) => text(allocation.id)) })}>Remove dates and rooms</button></div>}
          <div className={styles.dateFields}>
            <Field label="Arrival Date" path={`${sectionPath}/arrival`} editor={editor} type="date" disabled={sectionAllCompleted} />
            <Nights editor={editor} sectionPath={sectionPath} />
            <Field label="Departure Date" path={`${sectionPath}/departure`} editor={editor} type="date" disabled={sectionAllCompleted} />
          </div>
          <p className={styles.note}>Rooms: {rooms.length}{requested != null && Number(requested) !== rooms.length ? ` · requested ${text(requested)}` : ''}</p>
          {unassigned.length > 0 && <p className={styles.notice}>Guests to assign: {unassigned.join(', ')}</p>}
          {record(section.requestedTotals).adults != null && <p className={styles.note}>Requested group: {text(record(section.requestedTotals).adults)} adults{record(section.requestedTotals).childCount != null ? `, ${text(record(section.requestedTotals).childCount)} children` : ''}. Enter occupancy for each room.</p>}
          {rooms.map(({ allocation, index }) => {
            const allocationPath = `${bodyPath}/allocations/${index}`;
            const allocationId = String(allocation.id ?? '');
            const completed = completedRoom(editor, allocationId);
            if (completed) return <SavedRoom key={allocationId || index} editor={editor} result={completed} index={index} />;
            return <div className={styles.roomCard} key={allocationId || index}>
              <div className={styles.groupHeading}><strong>Room {index + 1}</strong>
                <button type="button" className={styles.linkButton} disabled={view.busy || allocations.length <= 1}
                  onClick={() => void commands.changeRows({ kind: 'remove_allocation', requestId: request.id, entityId: allocationId, parentId: sectionId })}>Remove</button></div>
              <div className={styles.twoCol}>
                <Count label="Adults" path={`${allocationPath}/occupancy/adults`} editor={editor} min={1} max={20} />
                <ChildAges editor={editor} path={`${allocationPath}/occupancy`} />
              </div>
            </div>;
          })}
          <button type="button" className={styles.secondaryButton} disabled={view.busy || allocations.length >= 8 || !sectionId}
            onClick={() => void commands.changeRows({ kind: 'add_allocation', requestId: request.id, parentId: sectionId,
              entityId: `room_${crypto.randomUUID().replaceAll('-', '')}` })}>Add room</button>
          <details open={allFields.some((field) => hasOwn(editor, `${sectionPath}/defaults/${field.key}`)) || undefined} className={styles.details}>
            <summary>Date defaults{sectionHasCompleted ? ' · remaining rooms' : ''} · {ownSummary(editor, `${sectionPath}/defaults`) || 'uses shared values'}</summary>
            <fieldset disabled={sectionAllCompleted} className={styles.plainFieldset}>{allFields.map((field) => <ScopedField key={field.key} field={field} path={`${sectionPath}/defaults/${field.key}`}
              parentPaths={[`${shared}/${field.key}`]} parentLabel="shared" editor={editor} />)}</fieldset>
          </details>
        </div>;
      })}
      {!sections.length && <p className={styles.notice}>Add dates to start a manual reservation.</p>}
      <div className={styles.inlineButtons}>
        <button type="button" className={styles.secondaryButton} disabled={view.busy} onClick={() => void commands.changeRows({ kind: 'add_date_section', requestId: request.id, entityId: `dates_${crypto.randomUUID().replaceAll('-', '')}` })}>Add dates</button>
      </div>
      <fieldset disabled={allCompleted} className={styles.plainFieldset}>
        {[...stayFields, ...roomFields, trackField].map((field) => <BookingControl key={field.key} field={field} path={`${shared}/${field.key}`} editor={editor} />)}
        <p className={styles.note}>Infor prices each room separately when ready.</p>
      </fieldset>
      <button type="button" className={styles.secondaryButton} disabled={view.busy} onClick={() => void commands.lookup()}>Search / refresh Infor</button>
    </Section>
    <Section title="Guest">
      <p className={styles.note}>Select an existing Infor profile for each room.</p>
      {allocations.map((allocation, index) => {
        const allocationPath = `${bodyPath}/allocations/${index}`;
        const allocationId = String(allocation.id ?? '');
        if (completedRoom(editor, allocationId)) return null;
        const sectionIndex = sections.findIndex((section) => section.id === allocation.dateSectionId);
        if (sectionIndex < 0) return null;
        const section = sections[sectionIndex]!, sectionPath = `${bodyPath}/dateSections/${sectionIndex}`;
        const sectionId = String(section.id ?? ''), overrides = `${allocationPath}/overrides`, dateDefaults = `${sectionPath}/defaults`;
        const unassigned = Array.isArray(section.unassignedGuestNames) ? section.unassignedGuestNames.filter((name): name is string => typeof name === 'string') : [];
        const exceptions = ownSummary(editor, overrides), guestOptIn = inheritedValue(editor, [`${overrides}/guestOptIn`, `${dateDefaults}/guestOptIn`, `${shared}/guestOptIn`]);
        const conflict = snapshot.issues.some((issue) => issue.kind === 'guest_email_conflict' && issue.path === `${allocationPath}/guest/email`);
        return <div className={styles.roomCard} key={allocationId || index}>
          {allocations.length > 1 && <strong>Room {index + 1}</strong>}
          {unassigned.length > 0 && <label className={styles.localField}>Assign a guest from the email
            <select value="" onChange={(event) => {
              if (!event.target.value) return;
              const chosenIndex = Number(event.target.value); if (!Number.isInteger(chosenIndex) || chosenIndex < 0) return;
              const chosen = unassigned[chosenIndex]; if (!chosen) return;
              const [first, ...rest] = chosen.trim().split(/\s+/u);
              const pending = `${allocationPath}/guest/assignment`;
              commands.setUncommitted(pending, true);
              void (async () => {
                await commands.edit(`${allocationPath}/guest/firstName`, first ?? '');
                await commands.edit(`${allocationPath}/guest/lastName`, rest.join(' '));
                await commands.edit(`${sectionPath}/unassignedGuestNames`, unassigned.filter((_, i) => i !== chosenIndex));
              })().finally(() => commands.setUncommitted(pending, false)).catch(() => {});
            }}><option value="">Choose guest</option>{unassigned.map((name, i) => <option key={`${name}-${i}`} value={i}>{name}</option>)}</select>
          </label>}
          <NativePicker label="Profile ID / selection" path={`${allocationPath}/guest/nativeSelectionRef`} editor={editor} kind="guest_candidate" />
          {allocations.length === 1 ? <GuestDetails editor={editor} allocationPath={allocationPath} />
            : <details open={conflict || undefined} className={styles.details}>
              <summary>Guest details{text(record(allocation.guest).email) ? ` · ${text(record(allocation.guest).email)}` : ''}</summary>
              <GuestDetails editor={editor} allocationPath={allocationPath} />
            </details>}
          <Price editor={editor} allocationId={allocationId} />
          {guestOptIn === true && <p className={styles.notice}>Guest marketing opt-in needs Infor.</p>}
          <details open={Boolean(exceptions) || undefined} className={styles.details}>
            <summary>Room exceptions · {exceptions || 'uses date and shared values'}</summary>
            <div className={styles.stack}>
              <label className={styles.localField}>Stay dates
                <select value={sectionId} disabled={view.busy || sections.length < 2} onChange={(event) => {
                  const nextId = event.target.value;
                  if (nextId && nextId !== sectionId) void commands.changeRows({ kind: 'move_allocation', requestId: request.id,
                    entityId: allocationId, parentId: nextId });
                }}>{sections.map((dates, i) => <option key={text(dates.id) || i} value={text(dates.id)}>
                  {`Stay ${i + 1} · ${text(dates.arrival) || 'arrival missing'} – ${text(dates.departure) || 'departure missing'}`}
                </option>)}</select>
              </label>
              {allFields.map((field) => <ScopedField key={field.key} field={field} path={`${overrides}/${field.key}`}
                parentPaths={[`${dateDefaults}/${field.key}`, `${shared}/${field.key}`]} parentLabel="date/shared" editor={editor} />)}
            </div>
          </details>
        </div>;
      })}
    </Section>
    <details className={styles.details}>
      <summary>Booker and confirmation · {hasCompleted ? 'remaining rooms' : 'all rooms'}</summary>
      <fieldset disabled={allCompleted} className={styles.plainFieldset}>
        {otherFields.map((field) => <BookingControl key={field.key} field={field} path={`${shared}/${field.key}`} editor={editor} />)}
        {valueAt(snapshot, `${shared}/guestOptIn`) === true && <p className={styles.notice}>Guest marketing opt-in needs Infor.</p>}
      </fieldset>
    </details>
  </div>;
}
