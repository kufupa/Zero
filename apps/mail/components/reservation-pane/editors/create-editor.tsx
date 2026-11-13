'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { effectiveAt, guestProfileReceipt, record, requestPath, staffEnteredAt, text, valueAt, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { Count, Field, FieldReview, Section } from '../shared/stay-fields';
import { NativePicker } from '../shared/native-pickers';
import { ReservationNote } from '../shared/reservation-note';
import styles from './create-quote-editor.module.css';

type Editor = WorkbenchEditorProps;
type BookingField = { key: string; label: string; picker?: string; party?: boolean; type?: string; hint?: string; maxLength?: number };
const roomFields: BookingField[] = [
  { key: 'requestedMealPlan', label: 'Requested Meal Plan', maxLength: 120, hint: 'Customer meal plan request. Confirm it against the Infor rate.' },
  { key: 'roomType', label: 'Room Type', picker: 'room_type' },
  { key: 'roomTypeForCharge', label: 'Room Type for Charge', picker: 'room_type_for_charge', hint: 'Blank uses the Infor default. Infor checks the price for the selected category.' },
  { key: 'ratePlan', label: 'Rate Plan', picker: 'rate_plan' },
  { key: 'mealPlan', label: 'Meal Plan', maxLength: 120, hint: 'Confirm against the selected Infor rate.' },
];
const partyFields: BookingField[] = [
  { key: 'bookingAgency', label: 'Primary Booking Agency', party: true },
  { key: 'organization', label: 'Organization', party: true },
  { key: 'arAccount', label: 'A/R Account', party: true },
  { key: 'billingReference', label: 'Billing Reference', maxLength: 4000, hint: 'Select an A/R Account. Infor accepts at most 50 characters.' },
  { key: 'taCommission', label: 'Travel agency commission (%)', type: 'percentage', maxLength: 40, hint: 'Enter a percentage from 0 to 100.' },
];
const stayFields: BookingField[] = [
  { key: 'reasonForStay', label: 'Reason for Stay', picker: 'reason_for_stay' },
  { key: 'sourceOfBusiness', label: 'Source of Business', picker: 'source_of_business' },
  { key: 'guaranteeType', label: 'Guarantee Type', picker: 'guarantee' },
];
const trackField: BookingField = { key: 'track', label: 'Track / Sub Segment', picker: 'track' };
const otherFields: BookingField[] = [
  { key: 'bookerName', label: 'Booker name', maxLength: 50 },
  { key: 'bookerEmail', label: 'Booker email', maxLength: 320, type: 'email' },
  { key: 'bookerMobile', label: 'Booker mobile', maxLength: 120 },
  { key: 'reservationNote', label: 'Reservation note', maxLength: 2000, type: 'textarea' },
  { key: 'cmsSend', label: 'CMS Send Mail', type: 'checkbox' },
  { key: 'cmsMessageId', label: 'CMS Message Id', picker: 'cms_message' },
  { key: 'cmsRecipient', label: 'CMS Booker Email', maxLength: 255, type: 'email' },
];
const allFields = [...partyFields, ...stayFields, ...roomFields, trackField, ...otherFields];

export function resolveCreateCmsRecipientDefault(snapshot: Editor['snapshot'], requestId: string, _sender: string): string {
  const email = (value: string) => {
    const candidate = value.trim();
    return candidate.length <= 255 && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(candidate) ? candidate : '';
  };
  const path = `${requestPath(requestId)}/body/shared/bookerEmail`;
  if (!staffEnteredAt(snapshot, path) && snapshot.session.draft.staffReviews[path]?.status !== 'accepted') return '';
  return email(text(valueAt(snapshot, path)));
}

function BookingControl({ field, path, editor, defaultValue, emptyState }: {
  field: BookingField; path: string; editor: Editor; defaultValue?: string; emptyState?: 'inherit';
}) {
  if (field.key === 'reservationNote') return <ReservationNote path={path} editor={editor} />;
  return field.picker || field.party
    ? <NativePicker label={field.label} path={path} editor={editor} kind={field.picker} allowNone={field.party || field.key === 'roomTypeForCharge'} hint={field.hint} compact />
    : <Field label={field.label} path={path} editor={editor} type={field.type} hint={field.hint} maxLength={field.maxLength}
      defaultValue={defaultValue} emptyState={emptyState} nativeMaxLength={field.key === 'billingReference' ? 50 : undefined} compact />;
}

function UnsupportedTerms({ editor, path }: { editor: Editor; path: string }) {
  if (effectiveAt(editor.snapshot, path) !== true) return null;
  return <div className={styles.notice}>Terms and Conditions: this stored setting cannot be applied in Infor.
    <button type="button" disabled={editor.view.busy} onClick={() => void editor.commands.edit(path, false)}>Clear unsupported setting</button>
  </div>;
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
  const inheritedValueAtParent = inheritedValue(editor, parentPaths);
  const inherited = field.key === 'cmsRecipient' && !text(inheritedValueAtParent).trim()
    ? resolveCreateCmsRecipientDefault(editor.snapshot, editor.request.id, editor.source.sender) || inheritedValueAtParent
    : inheritedValueAtParent;
  const label = text(inherited) || (typeof inherited === 'boolean' ? (inherited ? 'Yes' : 'No') : 'Not set');
  return <div className={styles.scopeField} data-field-path={own ? undefined : path}>
    {own ? <>
      <BookingControl field={field} path={path} editor={editor} emptyState={field.key === 'cmsRecipient' ? 'inherit' : undefined} />
      <button type="button" className={styles.linkButton} onClick={() => void editor.commands.edit(path, undefined, 'inherit')}>Use {parentLabel} ({label})</button>
    </> : <div className={styles.inherited}>
      <span><b>{field.label}</b><small>{parentLabel}: {label}</small></span>
      <button type="button" className={styles.linkButton} onClick={() => void editor.commands.edit(path,
        inherited === undefined || inherited === null ? (field.party ? { name: null, candidateRefs: [], suggestedRef: null }
          : field.type === 'checkbox' ? false : field.key === 'taCommission' ? null : '') : inherited)}>Set own</button>
    </div>}
  </div>;
}

/** Save count and age slots together; unknown ages stay blank. */
export function ChildAges({ editor, path, max = 12 }: { editor: Editor; path: string; max?: number }) {
  const countId = useId();
  const countPath = `${path}/childCount`, agesPath = `${path}/childAges`;
  const countValue = valueAt(editor.snapshot, countPath);
  const ageValue = valueAt(editor.snapshot, agesPath);
  const [count, setCount] = useState(countValue == null ? '' : String(countValue));
  const [ages, setAges] = useState<Array<number | null>>(Array.isArray(ageValue) ? ageValue as Array<number | null> : []);
  const [reviewing, setReviewing] = useState(false);
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
    if (!dirty.current || !staged.current) return;
    const pending = staged.current, beforeCount = countVersion.current, beforeAges = agesVersion.current;
    await editor.commands.edit(path, pending);
    if (dirtyCount.current && countVersion.current === beforeCount) {
      dirtyCount.current = false;
      setCount(pending.childCount == null ? '' : String(pending.childCount));
      editor.commands.setUncommitted(countPath, false);
    }
    if (dirtyAges.current && agesVersion.current === beforeAges) {
      dirtyAges.current = false;
      editor.commands.setUncommitted(agesPath, false);
    }
    if (staged.current === pending) {
      const next = Array.isArray(pending.childAges) ? pending.childAges as Array<number | null> : [];
      ageInput.current = next; setAges(next);
    }
  };
  const updateCount = (value: string) => {
    const numeric = value === '' ? null : Number(value);
    const next = numeric != null && Number.isInteger(numeric) && numeric >= 0 && numeric <= max ? numeric : null;
    const resized = next == null ? null : Array.from({ length: next }, (_, index) => validAge(ageInput.current[index] ?? null));
    setCount(value); if (resized) ageInput.current = resized; setAges(resized ?? []);
    dirtyCount.current = true; countVersion.current += 1; editor.commands.setUncommitted(countPath, true);
    stage(next, resized);
  };
  const step = (amount: number) => {
    const current = count === '' ? 0 : Number(count);
    updateCount(String(Math.max(0, Math.min(max, current + amount))));
    void commit('count').catch(() => {});
  };
  return <>
    <div className={styles.localField} data-field-path={countPath}>
      <div className={styles.countHeading}><label htmlFor={countId}>Children</label><FieldReview editor={editor} path={countPath} label="Children" onPendingChange={setReviewing} /></div>
      <div className={styles.countStepper}>
        <button type="button" aria-label={count === '' ? 'Set Children to 0' : 'Decrease Children'} disabled={reviewing || count !== '' && Number(count) <= 0 || editor.view.busy} onMouseDown={event => event.preventDefault()} onClick={() => step(-1)}>−</button>
        <input id={countId} type="number" min="0" max={max} value={count} placeholder="?" disabled={reviewing} onChange={event => updateCount(event.target.value)} onBlur={() => void commit('count').catch(() => {})} />
        <button type="button" aria-label="Increase Children" disabled={reviewing || Number(count) >= max || editor.view.busy} onMouseDown={event => event.preventDefault()} onClick={() => step(1)}>+</button>
      </div>
    </div>
    {Number.isInteger(Number(count)) && Number(count) > 0 && Number(count) <= max && <div className={styles.ageGrid} data-field-path={agesPath}>
      {Array.from({ length: Number(count) }, (_, index) => <label className={styles.localField} key={index}>Child {index + 1} age
        <input type="number" min="0" max="17" value={ages[index] ?? ''} disabled={reviewing} onChange={(event) => {
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
  const draft = editor.snapshot.session.draft;
  const operation = [...draft.operationResults].reverse().find((item) => item.requestId === editor.request.id &&
    item.allocationId === allocationId && item.workflow === 'create' && (item.status === 'prepared' || item.status === 'failed'));
  const observation = operation && draft.observations.find((item) => operation.observationRefs.includes(item.ref) &&
    item.kind === 'rate_availability' && (item.status === 'complete' || item.status === 'partial') &&
    item.generationId === draft.generationId && item.propertyCode === draft.propertyCode && item.sourceMessageId === draft.source.messageId &&
    item.criteria.workflow === 'create' && item.criteria.requestId === editor.request.id && item.criteria.allocationId === allocationId &&
    item.criteria.draftRevision === editor.snapshot.session.revision && typeof item.criteria.semanticDigest === 'string');
  const result = record(observation?.result), mealPlan = text(record(result.applied).mealPlan);
  if (!price?.price && !mealPlan) return null;
  const details = price?.price;
  const input = record(result.semanticInput), stay = record(input.stay), room = record(input.room);
  return <div className={styles.price}>
    <strong>{details ? price?.current ? 'Infor price' : 'Infor price · check needed' : 'Last Infor check'}</strong>
    {details && <span>{text(details.currency)} {text(details.totalRate) || '—'} total{details.averageRate != null ? ` · ${text(details.averageRate)} average` : ''}</span>}
    {mealPlan && <span>Infor Meal Plan: {mealPlan}</span>}
    {observation && <small>{text(stay.arrival)} – {text(stay.departure)} · {text(stay.adults)} adults, {text(stay.childCount)} children · {text(room.roomType)} / {text(room.ratePlan)}
      {observation.observedAt ? ` · observed ${new Date(observation.observedAt).toLocaleString()}` : ''}. Check again after changes.</small>}
    {price?.issue && <small>Price needs attention. Check the room details.</small>}
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

function ProfileChoice({ editor, allocationId, guestPath, field, label, optionField, disabled }: {
  editor: Editor; allocationId: string; guestPath: string; field: string; label: string;
  optionField: 'title' | 'phoneType' | 'emailType'; disabled: boolean;
}) {
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState('');
  return <div>
    <Field label={label} path={`${guestPath}/${field}`} editor={editor} options={options} disabled={disabled || !loaded} compact requireReview />
    <button type="button" className={styles.linkButton} disabled={disabled} onClick={() => {
      setMessage('');
      void editor.commands.guestProfileOptions(allocationId, optionField).then(reply => {
        const coverage = record(reply.coverage);
        if (reply.outcome !== 'ok' || coverage.complete !== true || !Array.isArray(reply.options)) {
          setMessage('Infor did not return a complete list.'); return;
        }
        setOptions(reply.options.map(record).flatMap(row => typeof row.code === 'string' && typeof row.label === 'string'
          ? [{ value: row.code, label: `${row.code} · ${row.label}` }] : []));
        setLoaded(true);
      }).catch(() => setMessage('Could not load Infor choices.'));
    }}>{loaded ? `Refresh ${label} choices` : `Load ${label} choices`}</button>
    {message && <p className={styles.notice}>{message}</p>}
  </div>;
}

function GuestDetails({ editor, allocationPath, allocationId, newProfile, disabled }: {
  editor: Editor; allocationPath: string; allocationId: string; newProfile: boolean; disabled: boolean;
}) {
  const guestPath = `${allocationPath}/guest`;
  const showMore = newProfile && ['titleCode', 'phoneTypeCode', 'phoneNumber', 'emailTypeCode']
    .some(field => Boolean(text(valueAt(editor.snapshot, `${guestPath}/${field}`)).trim()));
  return <div className={styles.stack}>
    <Field label="Last Name" path={`${guestPath}/lastName`} editor={editor} disabled={disabled} compact requireReview={newProfile} />
    <Field label="First Name" path={`${guestPath}/firstName`} editor={editor} disabled={disabled} compact requireReview={newProfile} />
    {newProfile && <Field label="Mobile Number" path={`${guestPath}/mobile`} editor={editor} type="tel" disabled={disabled} compact requireReview hint="Required for a new profile." />}
    <Field label="E-mail Address" path={`${guestPath}/email`} editor={editor} type="email" disabled={disabled} compact requireReview={newProfile} hint="Use the guest’s own email only when explicitly stated." />
    {editor.snapshot.issues.filter((issue) => issue.kind === 'guest_email_conflict' && issue.path === `${allocationPath}/guest/email`)
      .map((issue, index) => <p className={styles.notice} key={index}>{issue.explanation}</p>)}
    <details className={styles.details} open={showMore || undefined}><summary>More guest details</summary>
      {newProfile ? <>
        <ProfileChoice editor={editor} allocationId={allocationId} guestPath={guestPath} field="titleCode" label="Title" optionField="title" disabled={disabled} />
        <ProfileChoice editor={editor} allocationId={allocationId} guestPath={guestPath} field="phoneTypeCode" label="Phone Type" optionField="phoneType" disabled={disabled} />
        <Field label="Phone Number" path={`${guestPath}/phoneNumber`} editor={editor} type="tel" disabled={disabled} compact requireReview />
        <ProfileChoice editor={editor} allocationId={allocationId} guestPath={guestPath} field="emailTypeCode" label="E-mail Type" optionField="emailType" disabled={disabled} />
      </> : <><Field label="Mobile Number" path={`${guestPath}/mobile`} editor={editor} type="tel" disabled={disabled} compact hint="Use the guest’s own mobile only when explicitly stated." />
        <p className={styles.note}>Matching details do not change the Infor profile.</p></>}
    </details>
  </div>;
}

function GuestProfile({ editor, allocationPath, allocationId }: { editor: Editor; allocationPath: string; allocationId: string }) {
  const guestPath = `${allocationPath}/guest`;
  const newProfile = valueAt(editor.snapshot, `${guestPath}/profileIntent`) === 'requested_new';
  const guest = record(effectiveAt(editor.snapshot, guestPath));
  const operations = editor.snapshot.operationResults.filter(row => row.workflow === 'guest_profile' &&
    row.requestId === editor.request.id && row.allocationId === allocationId);
  const latest = operations.at(-1);
  const localPending = editor.commands.guestProfilePending(allocationId);
  const unknown = latest?.status === 'unknown' || Boolean(localPending);
  const prepared = latest && editor.snapshot.session.draft.observations.find(row =>
    Array.isArray(latest.observationRefs) && latest.observationRefs.includes(row.ref) && row.criteria.workflow === 'guest_profile_prepare');
  const previous = record(record(prepared?.result).business).guest;
  const previousGuest = record(previous);
  const identityPart = (value: unknown) => text(value).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  const sameGuest = ['firstName', 'lastName', 'mobile', 'email'].every(field => identityPart(guest[field]) === identityPart(previousGuest[field]));
  const duplicate = latest?.status === 'failed' && text(latest.summary).includes('PROFILE_NAME_ALREADY_EXISTS') && sameGuest;
  const succeeded = [...operations].reverse().find(row => row.status === 'succeeded');
  const receipt = guestProfileReceipt(succeeded);
  const missingReceipt = Boolean(succeeded && !receipt);
  const selectedCreated = receipt && !unknown && receipt.observationRef === valueAt(editor.snapshot, `${guestPath}/nativeSelectionRef`);
  const locked = editor.view.busy || Boolean(unknown);
  const fields = ['firstName', 'lastName', 'mobile', 'email', 'titleCode', 'phoneNumber', 'phoneTypeCode', 'emailTypeCode'];
  const pendingReview = fields.some(field => {
    const path = `${guestPath}/${field}`, value = valueAt(editor.snapshot, path);
    return typeof value === 'string' && Boolean(value.trim()) && !staffEnteredAt(editor.snapshot, path) &&
      editor.snapshot.session.draft.fieldReviewRequirements[path]?.required !== false &&
      editor.snapshot.session.draft.staffReviews[path]?.status !== 'accepted';
  });
  const required = ['firstName', 'lastName', 'mobile'].every(field => text(guest[field]).trim());
  return <div className={styles.stack}>
    {newProfile ? <div className={styles.groupHeading}><strong>New guest profile</strong>
      <button type="button" className={styles.linkButton} disabled={locked} onClick={() => void editor.commands.edit(`${guestPath}/profileIntent`, 'existing_or_unknown')}>Search instead</button></div>
      : <div className={styles.guestProfileRow}><NativePicker label="Guest Profile" path={`${guestPath}/nativeSelectionRef`} editor={editor} kind="guest_candidate" disabled={locked} compact />
        {!succeeded && <button type="button" className={styles.linkButton} disabled={locked} onClick={() => void editor.commands.edit(`${guestPath}/profileIntent`, 'requested_new')}>+ New</button>}</div>}
    {newProfile && (unknown || !receipt) && <p className={styles.note}>Profile ID · {unknown ? 'Unknown' : missingReceipt ? 'Needs confirmation' : 'Not created'}</p>}
    {receipt && <p className={styles.note}>{selectedCreated ? 'Profile ID' : 'Previously created profile'} · {receipt.nativeId} ✓ Created</p>}
    {missingReceipt && !unknown && <p className={styles.notice}>The profile result needs confirmation. Contact Nava support before creating another profile.</p>}
    <GuestDetails editor={editor} allocationPath={allocationPath} allocationId={allocationId} newProfile={newProfile} disabled={locked} />
    {unknown ? <div className={styles.notice}>Profile creation outcome is unknown. Do not create another profile until it is confirmed. Contact Nava support if it cannot be confirmed.
      <button type="button" disabled={editor.view.busy} onClick={() => void (localPending
        ? editor.commands.checkGuestProfile(allocationId) : editor.commands.reconcile(text(latest?.id))).catch(() => {})}>Check outcome</button></div>
      : newProfile && !succeeded && <>
        {duplicate && <p className={styles.notice}>Infor found a profile with this name. Search for the existing guest, or create a different profile.</p>}
        {pendingReview && <p className={styles.note}>Confirm the marked guest details before creating the profile.</p>}
        <button type="button" className={styles.secondaryButton} disabled={locked || editor.view.preview || !required || pendingReview}
          onClick={() => void editor.commands.createGuestProfile(allocationId, Boolean(duplicate)).catch(() => {})}>
          {duplicate ? 'Create different profile' : 'Create profile & check price'}
        </button>
        <p className={styles.note}>The profile remains in Infor even if the reservation is not saved. The room price is checked when the booking details are ready.</p>
      </>}
  </div>;
}

export function CreateEditor(editor: Editor) {
  const { snapshot, request, commands, view } = editor;
  const bodyPath = `${requestPath(request.id)}/body`;
  const body = record(effectiveAt(snapshot, bodyPath));
  const sections = Array.isArray(body.dateSections) ? body.dateSections.map(record) : [];
  const allocations = Array.isArray(body.allocations) ? body.allocations.map(record) : [];
  const shared = `${bodyPath}/shared`;
  const defaultRecipient = resolveCreateCmsRecipientDefault(snapshot, request.id, editor.source.sender);
  const hasCompleted = allocations.some((allocation) => Boolean(completedRoom(editor, text(allocation.id))));
  const allCompleted = allocations.length > 0 && allocations.every((allocation) => Boolean(completedRoom(editor, text(allocation.id))));
  const commission = partyFields.find(field => field.key === 'taCommission')!;
  const commissionPath = `${shared}/taCommission`;
  const commissionValue = valueAt(snapshot, commissionPath);
  const commissionInvalid = commissionValue != null && (typeof commissionValue !== 'number' || !Number.isFinite(commissionValue) || commissionValue < 0 || commissionValue > 100);
  const commissionNeedsAttention = commissionInvalid || snapshot.session.draft.fieldReviewRequirements[commissionPath]?.required === true ||
    Boolean(snapshot.fields[commissionPath]?.issue) || snapshot.issues.some(issue => issue.path === commissionPath) ||
    snapshot.preparationViews.some(item => item.requestId === request.id && item.fields?.some(field => field.includes('taCommission')));
  const [commissionOpen, setCommissionOpen] = useState(commissionNeedsAttention);
  useEffect(() => { if (commissionNeedsAttention) setCommissionOpen(true); }, [commissionNeedsAttention]);
  const sharedBooking = [stayFields.find(field => field.key === 'guaranteeType')!, ...roomFields];
  const extraStay = [...stayFields.filter(field => field.key !== 'guaranteeType'), trackField];
  return <div className={`${styles.editor} ${styles.compactCreate}`}>
    {hasCompleted && <p className={styles.notice}>Saved rooms keep their confirmed details. Changes to shared values and dates apply to remaining rooms only.</p>}
    <Section title="Commercial">
      <fieldset disabled={allCompleted} className={styles.plainFieldset}>
        {partyFields.filter(field => field.key !== 'taCommission').map(field => <BookingControl key={field.key} field={field} path={`${shared}/${field.key}`} editor={editor} />)}
        <details className={styles.details} open={commissionOpen} onToggle={event => setCommissionOpen(event.currentTarget.open)}>
          <summary>Travel agency commission{typeof commissionValue === 'number' && !commissionInvalid ? ` · ${commissionValue}%` : ''}</summary>
          <BookingControl field={commission} path={commissionPath} editor={editor} />
        </details>
        <UnsupportedTerms editor={editor} path={`${shared}/guestOptIn`} />
      </fieldset>
    </Section>
    {sections.map((section, sectionIndex) => {
      const sectionPath = `${bodyPath}/dateSections/${sectionIndex}`;
      const sectionId = text(section.id);
      const rooms = allocations.map((allocation, index) => ({ allocation, index })).filter(({ allocation }) => allocation.dateSectionId === section.id);
      const sectionHasCompleted = rooms.some(({ allocation }) => Boolean(completedRoom(editor, text(allocation.id))));
      const sectionAllCompleted = rooms.length > 0 && rooms.every(({ allocation }) => Boolean(completedRoom(editor, text(allocation.id))));
      const requested = valueAt(snapshot, `${sectionPath}/requestedRooms`);
      const requestedTotals = record(effectiveAt(snapshot, `${sectionPath}/requestedTotals`));
      const roomTotal = (field: 'adults' | 'childCount') => {
        const values = rooms.map(({ allocation }) => record(allocation.occupancy)[field]);
        if (!values.length || values.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < (field === 'adults' ? 1 : 0))) return null;
        return values.reduce<number>((sum, value) => sum + Number(value), 0);
      };
      const adults = roomTotal('adults'), children = roomTotal('childCount');
      const discrepancies = [
        requested != null && requested !== rooms.length ? `rooms: requested ${text(requested)}, added ${rooms.length}` : '',
        requestedTotals.adults != null && adults !== null && requestedTotals.adults !== adults ? `adults: requested ${text(requestedTotals.adults)}, assigned ${adults}` : '',
        requestedTotals.childCount != null && children !== null && requestedTotals.childCount !== children ? `children: requested ${text(requestedTotals.childCount)}, assigned ${children}` : '',
      ].filter(Boolean);
      const unresolved = requestedTotals.adults != null && adults === null || requestedTotals.childCount != null && children === null;
      return <section className={styles.group} key={sectionId || sectionIndex}>
        <div className={styles.groupHeading}><strong>{sections.length > 1 ? `Date range ${sectionIndex + 1}` : 'Stay dates'}</strong>
          <button type="button" className={styles.linkButton} aria-label={`Add room to date range ${sectionIndex + 1}`} disabled={view.busy || allocations.length >= 8 || !sectionId}
            onClick={() => void commands.changeRows({ kind: 'add_allocation', requestId: request.id, parentId: sectionId,
              entityId: `room_${crypto.randomUUID().replaceAll('-', '')}` })}>+ Room</button></div>
        <div className={styles.dateFields}>
          <Field label="Arrival Date" path={`${sectionPath}/arrival`} editor={editor} type="date" disabled={sectionAllCompleted} review />
          <Nights editor={editor} sectionPath={sectionPath} />
          <Field label="Departure Date" path={`${sectionPath}/departure`} editor={editor} type="date" disabled={sectionAllCompleted} review />
        </div>
        <p className={styles.note}>{rooms.length} {rooms.length === 1 ? 'room' : 'rooms'} · {adults ?? 'unknown'} adults · {children ?? 'unknown'} children on these dates</p>
        {discrepancies.length > 0 && <p className={styles.notice} role="alert">Requested totals differ from the rooms: {discrepancies.join('; ')}. Review the rooms or adjust the requested totals.</p>}
        {unresolved && <p className={styles.note}>Enter occupancy for every room to compare with the requested totals.</p>}
        <details className={styles.details}><summary>Review source request totals</summary>
          <p className={styles.note}>Requested: {requested == null ? 'unknown' : text(requested)} rooms · {requestedTotals.adults == null ? 'unknown' : text(requestedTotals.adults)} adults · {requestedTotals.childCount == null ? 'unknown' : text(requestedTotals.childCount)} children.</p>
          <details className={styles.details}><summary>Adjust requested totals</summary><fieldset disabled={sectionHasCompleted} className={styles.plainFieldset}>
            <Field label="Requested rooms" type="number" path={`${sectionPath}/requestedRooms`} editor={editor} review />
            <Field label="Requested adults" type="number" path={`${sectionPath}/requestedTotals/adults`} editor={editor} review />
            <Field label="Requested children" type="number" path={`${sectionPath}/requestedTotals/childCount`} editor={editor} review />
            <small>Blank means unknown. Known requested totals must match the rooms before saving.</small>
          </fieldset></details>
        </details>
        {rooms.map(({ allocation, index }) => completedRoom(editor, text(allocation.id)) ? null : <div className={styles.occupancyRow} key={text(allocation.id) || index}>
          <strong>Room {index + 1} occupancy</strong>
          <div className={styles.twoCol}>
            <Count label="Adults" path={`${bodyPath}/allocations/${index}/occupancy/adults`} editor={editor} min={1} max={20} review asSelect />
            <ChildAges editor={editor} path={`${bodyPath}/allocations/${index}/occupancy`} />
          </div>
        </div>)}
        {sections.length > 1 && <button type="button" className={styles.linkButton} disabled={view.busy || sectionHasCompleted}
          onClick={() => void commands.changeRows({ kind: 'remove_date_section', requestId: request.id, entityId: sectionId,
            childIds: rooms.map(({ allocation }) => text(allocation.id)) })}>Remove dates and rooms</button>}
      </section>;
    })}
    {!sections.length && <p className={styles.notice}>Add dates to start a manual reservation.</p>}
    <button type="button" className={styles.linkButton} disabled={view.busy} onClick={() => void commands.changeRows({ kind: 'add_date_section', requestId: request.id, entityId: `dates_${crypto.randomUUID().replaceAll('-', '')}` })}>+ Another date range</button>
    <Section title="Stay details">
      <fieldset disabled={allCompleted} className={styles.plainFieldset}>
        {extraStay.map(field => <BookingControl key={field.key} field={field} path={`${shared}/${field.key}`} editor={editor} />)}
      </fieldset>
    </Section>
    <Section title="Shared booking settings">
      <fieldset disabled={allCompleted} className={styles.plainFieldset}>
        {sharedBooking.map(field => <BookingControl key={field.key} field={field} path={`${shared}/${field.key}`} editor={editor} />)}
      </fieldset>
      <button type="button" className={styles.linkButton} disabled={view.busy} onClick={() => void commands.lookup()}>Search / refresh Infor</button>
    </Section>
    {sections.map((section, sectionIndex) => {
      const sectionPath = `${bodyPath}/dateSections/${sectionIndex}`;
      const sectionId = text(section.id);
      const rooms = allocations.map((allocation, index) => ({ allocation, index })).filter(({ allocation }) => allocation.dateSectionId === section.id);
      const sectionHasCompleted = rooms.some(({ allocation }) => Boolean(completedRoom(editor, text(allocation.id))));
      const sectionAllCompleted = rooms.length > 0 && rooms.every(({ allocation }) => Boolean(completedRoom(editor, text(allocation.id))));
      const unassigned = Array.isArray(section.unassignedGuestNames) ? section.unassignedGuestNames.filter((name): name is string => typeof name === 'string') : [];
      return <section className={styles.group} key={sectionId || sectionIndex}>
        <div className={styles.groupHeading}><strong>{sections.length > 1 ? `Guests · date range ${sectionIndex + 1}` : 'Guests'}</strong></div>
        {unassigned.length > 0 && <p className={styles.notice}>Guests to assign: {unassigned.join(', ')}</p>}
        <details open={allFields.some(field => hasOwn(editor, `${sectionPath}/defaults/${field.key}`)) || effectiveAt(snapshot, `${sectionPath}/defaults/guestOptIn`) === true || undefined} className={styles.details}>
          <summary>Settings for these rooms{sectionHasCompleted ? ' · remaining rooms' : ''}</summary>
          <fieldset disabled={sectionAllCompleted} className={styles.plainFieldset}>{allFields.map(field => <ScopedField key={field.key} field={field} path={`${sectionPath}/defaults/${field.key}`}
            parentPaths={[`${shared}/${field.key}`]} parentLabel="shared" editor={editor} />)}
            <UnsupportedTerms editor={editor} path={`${sectionPath}/defaults/guestOptIn`} /></fieldset>
        </details>
        {rooms.map(({ allocation, index }) => {
          const allocationPath = `${bodyPath}/allocations/${index}`;
          const allocationId = text(allocation.id);
          const completed = completedRoom(editor, allocationId);
          if (completed) return <SavedRoom key={allocationId || index} editor={editor} result={completed} index={index} />;
          const overrides = `${allocationPath}/overrides`, dateDefaults = `${sectionPath}/defaults`;
          const exceptions = ownSummary(editor, overrides);
          return <div className={styles.roomCard} key={allocationId || index}>
            <div className={styles.groupHeading}><strong>Room {index + 1}</strong>
              <button type="button" className={styles.linkButton} disabled={view.busy || allocations.length <= 1}
                onClick={() => void commands.changeRows({ kind: 'remove_allocation', requestId: request.id, entityId: allocationId, parentId: sectionId })}>Remove</button></div>
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
            <GuestProfile editor={editor} allocationPath={allocationPath} allocationId={allocationId} />
            <Price editor={editor} allocationId={allocationId} />
            <details open={Boolean(exceptions) || effectiveAt(snapshot, `${overrides}/guestOptIn`) === true || undefined} className={styles.details}>
              <summary>Room exceptions{exceptions ? ` · ${exceptions}` : ''}</summary>
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
                {allFields.map(field => <ScopedField key={field.key} field={field} path={`${overrides}/${field.key}`}
                  parentPaths={[`${dateDefaults}/${field.key}`, `${shared}/${field.key}`]} parentLabel="date/shared" editor={editor} />)}
                <UnsupportedTerms editor={editor} path={`${overrides}/guestOptIn`} />
              </div>
            </details>
          </div>;
        })}
      </section>;
    })}
    <Section title="Booker and confirmation">
      <fieldset disabled={allCompleted} className={styles.plainFieldset}>
        {otherFields.map(field => <BookingControl key={field.key} field={field.key === 'cmsRecipient' ? { ...field,
          hint: defaultRecipient ? `Blank uses ${defaultRecipient}.` : 'Enter an email when CMS Send Mail is enabled.' } : field} path={`${shared}/${field.key}`} editor={editor}
          defaultValue={field.key === 'cmsRecipient' ? defaultRecipient || undefined : undefined} />)}
      </fieldset>
    </Section>
  </div>;
}
