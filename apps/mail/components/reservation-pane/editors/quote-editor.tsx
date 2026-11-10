'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { effectiveAt, nativeChoices, record, requestPath, text, valueAt, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { Count, Field, FieldReview, Section } from '../shared/stay-fields';
import { NativePicker, usePickerPosition } from '../shared/native-pickers';
import { ChildAges } from './create-editor';
import styles from './create-quote-editor.module.css';
import pickerStyles from '../reservation-pane.module.css';

type Editor = WorkbenchEditorProps;
const boards = [
  { value: 'room_only', label: 'Room only' },
  { value: 'bb', label: 'Bed and breakfast' },
  { value: 'dinner_bb', label: 'Dinner, bed and breakfast' },
];
const strategies = [
  { value: 'BAR', label: 'BAR · best available rate' }, { value: 'PROMO', label: 'PROMO · promotion' },
  { value: 'PRESET', label: 'PRESET' }, { value: 'WS', label: 'WS' }, { value: 'NC', label: 'NC' },
  { value: 'GOV', label: 'GOV · government' }, { value: 'AIR', label: 'AIR' },
  { value: 'DOML', label: 'DOML' }, { value: 'OTHER', label: 'OTHER' },
];

function SharedDate({ editor, groups, bodyPath, field, label }: {
  editor: Editor; groups: Record<string, unknown>[]; bodyPath: string; field: 'arrival' | 'departure'; label: string;
}) {
  const first = groups[0];
  const date = text(first?.[field]);
  const id = useId();
  const [value, setValue] = useState(date);
  const [reviewing, setReviewing] = useState(false);
  const dirty = useRef(false), version = useRef(0);
  const editKey = `${bodyPath}/groups/shared/${field}`;
  useEffect(() => { if (!dirty.current) setValue(date); }, [date]);
  useEffect(() => () => editor.commands.setUncommitted(editKey, false), [editKey]);
  return <div data-field-path={`${bodyPath}/groups/0/${field}`} className={styles.localField}>
    <div className={styles.countHeading}><label htmlFor={id}>{label}</label>
      {groups.length === 1 && <FieldReview editor={editor} path={`${bodyPath}/groups/0/${field}`} label={label} onPendingChange={setReviewing} />}</div>
    <input id={id} type="date" value={value} disabled={editor.view.busy || reviewing} onChange={(event) => {
      const next = event.target.value; setValue(next); dirty.current = true; version.current += 1;
      editor.commands.setUncommitted(editKey, true);
      groups.forEach((_, index) => editor.commands.stageEdit(`${bodyPath}/groups/${index}/${field}`, next || null));
    }} onBlur={() => {
      if (!dirty.current || !groups.length) return;
      const before = version.current;
      void editor.commands.edit(`${bodyPath}/groups/0/${field}`, value || null).then(() => {
        if (version.current === before) { dirty.current = false; editor.commands.setUncommitted(editKey, false); }
      }).catch(() => {});
    }} />
  </div>;
}

function latestQuote(editor: Editor) {
  const draft = editor.snapshot.session.draft;
  return [...draft.observations].reverse().find((item) => item.kind === 'rate_availability' &&
    item.generationId === draft.generationId && item.propertyCode === draft.propertyCode &&
    item.sourceMessageId === draft.source.messageId && item.criteria.sourceHash === draft.source.sourceHash &&
    item.criteria.workflow === 'quote' && item.criteria.requestId === editor.request.id);
}
function quoteCurrent(editor: Editor, observation: ReturnType<typeof latestQuote>) {
  const draft = editor.snapshot.session.draft;
  if (!observation || observation.status !== 'complete' || !observation.coverage.complete ||
      observation.generationId !== draft.generationId || observation.propertyCode !== draft.propertyCode ||
      observation.sourceMessageId !== draft.source.messageId || observation.criteria.sourceHash !== draft.source.sourceHash) return false;
  const result = record(observation.result);
  const until = Date.parse(text(result.freshUntil));
  if (!Number.isFinite(until) || until <= Date.now()) return false;
  const index = editor.snapshot.session.draft.proposal.content.requests.findIndex((request) => request.id === editor.request.id);
  const prefixes = [requestPath(editor.request.id), `/proposal/content/requests/${index}`];
  const current = Object.fromEntries(Object.entries(editor.snapshot.session.draft.fieldOverrides)
    .filter(([path]) => prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, override]) => [path, { state: override.state, ...(override.state === 'set' ? { value: override.value } : {}) }]));
  if (JSON.stringify(current) !== JSON.stringify(result.inputOverrides)) return false;
  // Structural row changes need a scope comparison too; adding/removing a group does not create a field override.
  const body = record(effectiveAt(editor.snapshot, `${requestPath(editor.request.id)}/body`));
  const groups = Array.isArray(body.groups) ? body.groups.map(record) : [];
  const revision = record(result.revision);
  const priced = Array.isArray(revision.groups) ? revision.groups.map(record) : [];
  if (groups.length !== priced.length) return false;
  return groups.every((group) => {
    const native = priced.find((row) => row.id === group.id), occupancy = record(group.occupancy);
    if (!native || native.arrivalDate !== group.arrival || native.departureDate !== group.departure ||
        native.quantity !== group.quantity || native.adults !== occupancy.adults || native.children !== occupancy.childCount ||
        JSON.stringify(native.childAges) !== JSON.stringify(occupancy.childAges ?? [])) return false;
    const roomCodes = Array.isArray(group.roomCodes) ? group.roomCodes : [];
    return (!roomCodes.length || roomCodes.includes(native.roomCode)) && (!group.ratePlan || group.ratePlan === native.rateCode);
  });
}
function quoteBoardCode(value: unknown) {
  const board = text(value).trim().toLocaleLowerCase().replace(/[\s&-]+/gu, '_');
  if (['room_only', 'roomonly', 'ro'].includes(board)) return 'room_only';
  if (['bb', 'b_b', 'breakfast', 'bed_and_breakfast'].includes(board)) return 'bb';
  if (['dinner_bb', 'dinner_b_b', 'dinner_bed_breakfast', 'dinner_and_breakfast'].includes(board)) return 'dinner_bb';
  return null;
}
function quoteOffersCurrent(editor: Editor, observation: ReturnType<typeof latestQuote>) {
  if (quoteCurrent(editor, observation)) return true;
  if (!observation || observation.sourceMessageId !== editor.snapshot.session.draft.source.messageId ||
      observation.criteria.sourceHash !== editor.snapshot.session.draft.source.sourceHash) return false;
  const result = record(observation.result);
  if (!Array.isArray(result.quoteDiagnostics) || !result.quoteDiagnostics.length ||
      result.sourceHash !== editor.snapshot.session.draft.source.sourceHash) return false;
  const until = Date.parse(text(result.freshUntil));
  if (!Number.isFinite(until) || until <= Date.now()) return false;
  const index = editor.snapshot.session.draft.proposal.content.requests.findIndex((request) => request.id === editor.request.id);
  const prefixes = [requestPath(editor.request.id), `/proposal/content/requests/${index}`];
  const overrides = Object.fromEntries(Object.entries(editor.snapshot.session.draft.fieldOverrides)
    .filter(([path]) => prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, override]) => [path, { state: override.state, ...(override.state === 'set' ? { value: override.value } : {}) }]));
  if (JSON.stringify(overrides) !== JSON.stringify(result.inputOverrides)) return false;
  const body = record(effectiveAt(editor.snapshot, `${requestPath(editor.request.id)}/body`));
  const groups = Array.isArray(body.groups) ? body.groups.map(record) : [];
  const requested = Array.isArray(result.requestedGroups) ? result.requestedGroups.map(record) : [];
  if (!groups.length || groups.length !== requested.length) return false;
  return groups.every((group) => {
    const native = requested.find((row) => row.id === group.id), occupancy = record(group.occupancy);
    return native && native.arrivalDate === group.arrival && native.departureDate === group.departure &&
      native.quantity === group.quantity && native.adults === occupancy.adults && native.board === quoteBoardCode(group.board) &&
      native.childrenAges instanceof Array && native.childrenAges.length === occupancy.childCount &&
      JSON.stringify(native.childrenAges) === JSON.stringify(occupancy.childAges ?? []) &&
      JSON.stringify(native.roomCodes ?? []) === JSON.stringify(group.roomCodes ?? []) &&
      (native.rateCode ?? '') === (group.ratePlan ?? '');
  });
}
function money(minor: unknown, currency: unknown) {
  return typeof minor === 'number' && Number.isSafeInteger(minor) ? `${text(currency) || 'ZAR'} ${(minor / 100).toFixed(2)}` : '';
}

function availabilityMessage(result: Record<string, unknown>): string | null {
  const shortfall = record(result.shortfall);
  if (result.failureKind === 'proven_shortage' && typeof shortfall.roomLabel === 'string' &&
      typeof shortfall.date === 'string' && typeof shortfall.demand === 'number' && Number.isSafeInteger(shortfall.demand) &&
      typeof shortfall.supply === 'number' && Number.isSafeInteger(shortfall.supply)) {
    const demand = shortfall.demand, supply = shortfall.supply;
    return `Infor confirmed ${supply} of ${demand} requested ${shortfall.roomLabel} rooms available on ${shortfall.date}. This is only the selected room/date, not a hotel-wide sold-out result.`;
  }
  if (result.failureKind === 'requested_mismatch' || result.failureKind === 'requested_unqualified')
    return 'Infor did not confirm a matching rate for the selected room and board. Availability is not confirmed; choose an available offer or refresh the search.';
  if (result.failureKind === 'restricted')
    return 'Infor marked part of this stay restricted. This is not a sold-out result; review the affected dates or choose another offer.';
  if (result.failureKind === 'qualification_failure')
    return 'Infor could not verify that this request qualifies for the selected rate. Availability is not confirmed; check the agency/rate selection and retry.';
  if (result.failureKind === 'read_failure')
    return result.availabilityTruncated === true
      ? 'Infor availability could not be fully read. No unavailable-room or sold-out conclusion was made; refresh the search.'
      : 'Infor availability could not be confirmed. No unavailable-room or sold-out conclusion was made; refresh the search.';
  return null;
}

function hasSavedSeparateOther(editor: Editor, requestId: string, moneyId: string): boolean {
  if (!moneyId) return false;
  const requests = editor.snapshot.session.draft.proposal.content.requests as unknown as Array<Record<string, unknown>>;
  return requests.some((request) => {
    if (request.kind !== 'other') return false;
    const separatedFrom = record(record(request.body).separatedFrom);
    return separatedFrom?.requestId === requestId && separatedFrom.moneyId === moneyId;
  });
}

function RoomCode({ editor, path, options }: { editor: Editor; path: string; options: Record<string, unknown>[] }) {
  const id = useId(), picker = useRef<HTMLDivElement>(null);
  const saved = valueAt(editor.snapshot, path);
  const initial = Array.isArray(saved) ? saved.map(text).join(', ') : '';
  const [value, setValue] = useState(initial), [open, setOpen] = useState(false);
  const position = usePickerPosition(open, picker);
  const [reviewing, setReviewing] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null), [search, setSearch] = useState('');
  const dirty = useRef(false), version = useRef(0), loadingRef = useRef(false);
  const parse = (input: string) => [...new Set(input.split(',').map(code => code.trim().toUpperCase()).filter(Boolean))];
  useEffect(() => { if (!dirty.current) setValue(initial); }, [initial]);
  useEffect(() => () => editor.commands.setUncommitted(path, false), [path]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => { if (!picker.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss, true); document.addEventListener('focusin', dismiss, true);
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('focusin', dismiss, true); };
  }, [open]);
  const codes = [...new Map([...nativeChoices(editor.snapshot, path, 'room_type').map(row => [row.value, row.label] as const),
    ...options.map(option => [text(option.roomCode), text(option.roomLabel)] as const)].filter(([code]) => code)).entries()];
  const load = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true; setLoading(true); setError(null);
    try { await commit(); if (editor.commands.lookupChoices) await editor.commands.lookupChoices(path); else await editor.commands.lookup(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Infor room categories could not load.'); }
    finally { loadingRef.current = false; setLoading(false); }
  };
  const openChoices = () => { setOpen(true); setSearch(''); if (!codes.length && !error) void load(); };
  const change = (next: string) => {
    setValue(next); dirty.current = true; version.current += 1;
    editor.commands.setUncommitted(path, true); editor.commands.stageEdit(path, parse(next));
  };
  const commit = async () => {
    if (!dirty.current) return;
    const before = version.current, next = parse(value);
    await editor.commands.edit(path, next);
    if (version.current === before) { dirty.current = false; setValue(next.join(', ')); editor.commands.setUncommitted(path, false); }
  };
  const choose = async (code: string) => {
    const selected = parse(value), next = selected.includes(code) ? selected.filter(item => item !== code) : [...selected, code];
    change(next.join(', ')); const before = version.current;
    try { await editor.commands.edit(path, next); if (version.current === before) { dirty.current = false; editor.commands.setUncommitted(path, false); } }
    catch { /* controller retains the failure and pending edit */ }
  };
  return <div data-field-path={path} className={`${styles.localField} ${styles.quoteLine}`}>
    <label htmlFor={id}>Room categories</label>
    <div ref={picker} className={pickerStyles.picker}>
      <div className={pickerStyles.pickerInput}><input id={id} value={value} role="combobox" aria-expanded={open} aria-controls={`${id}-rooms`}
        disabled={reviewing || editor.view.busy && !loading} placeholder="Any category, or codes separated by commas" onFocus={openChoices} onClick={openChoices}
        onChange={event => change(event.target.value)} onBlur={() => { void commit().catch(() => {}); }}
        onKeyDown={event => { if (event.key === 'Escape') setOpen(false); if (event.key === 'ArrowDown') { event.preventDefault(); openChoices(); } }} />
        <button type="button" aria-label="Show room categories" disabled={reviewing || loading} onMouseDown={event => event.preventDefault()}
          onClick={() => open ? setOpen(false) : openChoices()}>⌄</button></div>
      {open && <div id={`${id}-rooms`} role="listbox" aria-multiselectable="true" className={pickerStyles.options} style={position}>
        <input aria-label="Search room categories" value={search} placeholder="Search code or meaning" onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }} />
        {loading && <small role="status">Loading room categories from Infor…</small>}
        {error && <small role="alert">{error}</small>}
        {codes.filter(([code, label]) => `${code} ${label}`.toLowerCase().includes(search.toLowerCase())).map(([code, label]) =>
          <button key={code} type="button" role="option" aria-selected={parse(value).includes(code)} disabled={editor.view.busy || reviewing}
            onMouseDown={event => event.preventDefault()} onClick={() => { void choose(code); }}><span aria-hidden="true">{parse(value).includes(code) ? '✓ ' : ''}</span><strong>{code}</strong>{label && label !== code ? ` — ${label}` : ''}</button>)}
        {!codes.length && !loading && !error && <small>No Infor room categories returned.</small>}
        <small>Choose one or more categories. Blank searches every category. Review & check verifies prices and availability.</small>
        <button type="button" disabled={loading} onMouseDown={event => event.preventDefault()} onClick={() => { void load(); }}>{error ? 'Retry Infor' : 'Refresh Infor choices'}</button>
      </div>}
    </div>
    <span className={styles.quoteReview}><FieldReview editor={editor} path={path} label="Room categories" onPendingChange={pending => { setReviewing(pending); if (pending) setOpen(false); }} /></span>
  </div>;
}

function OfferList({ editor, groupId, groupPath, observation }: { editor: Editor; groupId: string; groupPath: string; observation: ReturnType<typeof latestQuote> }) {
  const result = record(observation?.result);
  const options = Array.isArray(result.rateOptions) ? result.rateOptions.map(record).filter((option) => option.groupId === groupId) : [];
  const current = quoteOffersCurrent(editor, observation);
  return <div className={styles.offerList}>
    {observation && !current && <p className={styles.notice}>Earlier availability shown. Refresh the price before choosing.</p>}
    {result.availabilityTruncated === true && <p className={styles.notice}>Infor's availability results were truncated; some offers may be missing.</p>}
    {!options.length && <p className={styles.note}>{observation ? 'No selectable Infor offers were returned for this group.' : 'Available Infor offers appear after lookup.'}</p>}
    {options.map((option, index) => {
      const room = text(option.roomCode), rate = text(option.rateCode), board = text(option.board);
      const selected = Array.isArray(valueAt(editor.snapshot, `${groupPath}/roomCodes`)) &&
        (valueAt(editor.snapshot, `${groupPath}/roomCodes`) as unknown[]).includes(room) &&
        text(valueAt(editor.snapshot, `${groupPath}/ratePlan`)) === rate && text(valueAt(editor.snapshot, `${groupPath}/board`)) === board;
      const nightly = money(option.perNightMinor, option.currency), total = money(option.totalMinor, option.currency);
      return <div className={styles.offer} key={`${room}-${rate}-${board}-${index}`}>
        <div><strong>{room} · {text(option.roomLabel) || room} / {rate} · {text(option.rateLabel) || rate}</strong>
          <small>{text(option.boardLabel) || board}{nightly ? ` · ${nightly} per night` : ''}{total ? ` · ${total} ${option.priced === 'summary' ? 'indicative sum' : 'total'}` : ''}
            {typeof option.roomsLeft === 'number' ? ` · ${option.roomsLeft} rooms left` : ''}{option.priced === 'summary' ? ' · summary only' : ''}</small></div>
        <button type="button" className={styles.secondaryButton} disabled={!current || editor.view.busy || !room || !rate || !board}
          aria-pressed={selected} onClick={() => {
            const pending = `${groupPath}/offer`;
            editor.commands.setUncommitted(pending, true);
            void (async () => {
              await editor.commands.edit(`${groupPath}/roomCodes`, [room]);
              await editor.commands.edit(`${groupPath}/ratePlan`, rate);
              await editor.commands.edit(`${groupPath}/board`, board);
            })().finally(() => editor.commands.setUncommitted(pending, false)).catch(() => {});
          }}>{selected ? 'Selected' : 'Use this'}</button>
      </div>;
    })}
  </div>;
}

function MoneyRequests({ editor, bodyPath, groups, rows }: { editor: Editor; bodyPath: string; groups: Record<string, unknown>[]; rows: Record<string, unknown>[] }) {
  if (!rows.length) return null;
  return <Section title="Requested prices and allowances">
    <p className={styles.note}>Customer amounts are separate from Infor room rates. They never replace a native rate.</p>
    {rows.map((row, index) => {
      const path = `${bodyPath}/requestedMoney/${index}`;
      const kindPath = `${path}/staffAllowanceType`;
      const kind = text(valueAt(editor.snapshot, kindPath));
      const moneyId = text(row.id);
      const separateOtherSaved = hasSavedSeparateOther(editor, editor.request.id, moneyId);
      const scope = text(valueAt(editor.snapshot, `${path}/scope`));
      const targets = valueAt(editor.snapshot, `${path}/targetRefs`);
      const selected = Array.isArray(targets) ? targets.map(text) : [];
      return <div className={styles.roomCard} key={text(row.id) || index}>
        <div className={styles.twoCol}><Field label="Requested amount" path={`${path}/amount`} editor={editor} />
          <Field label="Currency" path={`${path}/currency`} editor={editor} /></div>
        <Field label="Unit" path={`${path}/unit`} editor={editor} options={[
          { value: 'per_person_per_night', label: 'Per person per night' },
          { value: 'per_room_per_night', label: 'Per room per night' },
          { value: 'per_person', label: 'Per person' },
        ]} />
        <label className={styles.localField}>Handle as
          <select value={kind || 'unresolved'} disabled={editor.view.busy} onChange={(event) => {
            const next = event.target.value;
            if (next === 'unsupported') {
              if (kind === 'unsupported' && separateOtherSaved) return;
              void editor.commands.changeRows({ kind: 'separate_quote_money', requestId: editor.request.id, entityId: String(index) } as never);
            } else if (next === 'dinner') void editor.commands.edit(kindPath, 'dinner');
          }}>
            <option value="unresolved">Choose how to handle</option>
            <option value="dinner">Dinner allowance</option>
            <option value="unsupported">Other request · handle separately</option>
          </select>
        </label>
        <label className={styles.localField}>Scope
          <select value={scope || 'unresolved'} disabled={editor.view.busy} onChange={(event) => {
            const nextScope = event.target.value;
            editor.commands.setUncommitted(`${path}/scope`, true);
            void (async () => {
              if (nextScope === 'overall' && selected.length) await editor.commands.edit(`${path}/targetRefs`, []);
              await editor.commands.edit(`${path}/scope`, nextScope);
            })().finally(() => editor.commands.setUncommitted(`${path}/scope`, false)).catch(() => {});
          }}><option value="unresolved">Unresolved</option><option value="overall">All groups</option>
            <option value="per_target">Selected groups</option></select>
        </label>
        {scope === 'per_target' && <fieldset className={styles.targetFields}><legend>Apply to groups</legend>
          {groups.map((group, groupIndex) => { const id = text(group.id); return <label key={id}>
            <input type="checkbox" checked={selected.includes(id)} onChange={(event) => void editor.commands.edit(`${path}/targetRefs`,
              event.target.checked ? [...selected, id] : selected.filter((value) => value !== id))} /> Group {groupIndex + 1}
          </label>; })}
        </fieldset>}
        {kind === 'unsupported' && separateOtherSaved
          ? <p className={styles.note}>Saved as a separate Other request. This supported room quote can continue independently.</p>
          : kind === 'unsupported'
            ? <p className={styles.notice}>The separate follow-up is not saved yet. Save it as an Other request before generating this quote.</p>
            : kind !== 'dinner' && <p className={styles.notice}>Choose dinner allowance or save this follow-up as a separate Other request before generating the room quote.</p>}
      </div>;
    })}
  </Section>;
}

function PreparedReview({ editor }: { editor: Editor }) {
  const draft = editor.snapshot.session.draft;
  const operation = [...draft.operationResults].reverse().find((row) => row.workflow === 'quote' && row.requestId === editor.request.id &&
    row.generationId === draft.generationId && row.status === 'prepared');
  const observation = operation && draft.observations.find((row) => operation.observationRefs.includes(row.ref) &&
    row.kind === 'rate_availability' && row.status === 'complete' && row.coverage.complete && row.generationId === draft.generationId &&
    row.propertyCode === draft.propertyCode && row.sourceMessageId === draft.source.messageId &&
    row.criteria.workflow === 'quote' && row.criteria.requestId === editor.request.id);
  const result = record(observation?.result);
  const notes = Array.isArray(result.extrasReviewItems) ? result.extrasReviewItems.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
  if (!operation || !observation || !notes.length) return null;
  const revision = record(result.revision);
  const groups = Array.isArray(revision.groups) ? revision.groups.map(record) : [];
  const rates = Array.isArray(result.rowRates) ? result.rowRates.map(record) : [];
  const facts = record(result.facts);
  const extras = Array.isArray(facts.extras) ? facts.extras.map(record) : [];
  const entitlements = Array.isArray(facts.includedEntitlements) ? facts.includedEntitlements.map(record) : [];
  const review = draft.staffReviews[`${requestPath(editor.request.id)}/body`];
  const current = quoteCurrent(editor, observation);
  const accepted = current && review?.status === 'accepted' && Date.parse(review.at ?? '') >= Date.parse(observation.observedAt) &&
    Date.parse(review.at ?? '') >= Date.parse(operation.updatedAt);
  const unitNames: Record<string, string> = { per_person_night: 'per person per night', per_person: 'per person',
    per_room_per_night: 'per room per night', per_trip: 'per trip', item: 'per item' };
  return <Section title="Review prepared price and extras">
    <div className={styles.price}><strong>{money(result.totalMinor, result.currency) || 'Total unavailable'}</strong>
      <small>Prepared total for the groups and extras below.</small></div>
    {groups.map((group, index) => {
      const row = rates.find((rate) => rate.groupId === group.id);
      const nightly = Array.isArray(row?.nightlyMinor) ? row.nightlyMinor : [];
      const quantity = typeof group.quantity === 'number' ? group.quantity : 0;
      const groupTotal = nightly.length && nightly.every((amount) => typeof amount === 'number' && Number.isSafeInteger(amount))
        ? nightly.reduce<number>((sum, amount) => sum + (amount as number), 0) * quantity : null;
      return <p className={styles.note} key={text(group.id) || index}>Group {index + 1} · {text(group.quantity)} rooms · {text(group.arrivalDate)} – {text(group.departureDate)} · {text(group.roomCode)} / {text(group.rateCode)} · {text(group.board)}{groupTotal != null ? ` · ${money(groupTotal, result.currency)}` : ''}</p>;
    })}
    {extras.map((extra, index) => {
      const ids = Array.isArray(extra.groupIds) ? extra.groupIds.map(text) : [];
      const scope = ids.length ? ids.map((id) => { const i = groups.findIndex((group) => group.id === id); return i < 0 ? 'quote group' : `Group ${i + 1}`; }).join(', ') : 'All quote groups';
      const dates = Array.isArray(extra.dates) ? extra.dates.map(text).filter(Boolean) : [];
      const unit = text(extra.chargeUnit);
      const persons = Array.isArray(extra.persons) ? extra.persons.map(record) : [];
      const chargedUnits = extra.unitKind === 'person_service' ? persons.reduce((sum, person) => sum + dates.filter((date) =>
        !entitlements.some((entry) => entry.service === extra.service && Array.isArray(entry.personIds) && entry.personIds.includes(person.id) &&
          Array.isArray(entry.dates) && entry.dates.includes(date))).length, 0)
        : typeof extra.quantity === 'number' && typeof extra.units === 'number' ? extra.quantity * extra.units : null;
      const total = chargedUnits != null && typeof extra.unitMinor === 'number' ? chargedUnits * extra.unitMinor : null;
      const basis = extra.unitKind === 'person_service' ? `${persons.length} people · ${dates.length} service dates${chargedUnits != null ? ` · ${chargedUnits} charged units` : ''}`
        : `quantity ${text(extra.quantity)} · units ${text(extra.units)}`;
      return <div className={styles.roomCard} key={text(extra.id) || index}>
        <strong>{text(extra.label)}</strong>
        <div>{money(extra.unitMinor, result.currency)} {unitNames[unit] || text(extra.unitKind).replaceAll('_', ' ')}{total != null && Number.isSafeInteger(total) ? ` · ${money(total, result.currency)} total` : ''}</div>
        <small>{scope} · {basis}{dates.length ? ` · ${dates.join(', ')}` : ''}</small>
      </div>;
    })}
    {notes.map((note, index) => <p className={styles.notice} key={index}>{note}</p>)}
    {!current && <p className={styles.notice}>Details changed or the price expired. Review and check again before accepting.</p>}
    {accepted ? <p className={styles.note}>Prepared price and extra details accepted.</p> : <button type="button" className={styles.secondaryButton}
      disabled={!current || editor.view.busy} onClick={() => { void editor.commands.review('request', [editor.request.id]).catch(() => {}); }}>
      Accept prepared price and extras
    </button>}
  </Section>;
}

export function QuoteEditor(editor: Editor) {
  const { request, snapshot, commands, view } = editor;
  const bodyPath = `${requestPath(request.id)}/body`;
  const body = record(effectiveAt(snapshot, bodyPath));
  const groups = Array.isArray(body.groups) ? body.groups.map(record) : [];
  const rows = Array.isArray(body.requestedMoney) ? body.requestedMoney.map(record) : [];
  const observation = latestQuote(editor);
  const result = record(observation?.result);
  const searchContext = record(result.searchContext);
  const strategyUsedDiscoveryBar = observation?.status === 'complete' &&
    searchContext.strategySource === 'discovery_default' && searchContext.salesStrategy === 'BAR';
  const selectedStrategy = text(valueAt(snapshot, `${bodyPath}/salesStrategy`)).trim();
  const offersCurrent = quoteOffersCurrent(editor, observation);
  const availabilityNotice = availabilityMessage(result);
  const mismatch = groups.some((group) => group.arrival !== groups[0]?.arrival || group.departure !== groups[0]?.departure);
  const artifactPath = `${bodyPath}/outputIntent/artifacts`;
  const artifactsValue = valueAt(snapshot, artifactPath);
  const artifacts = Array.isArray(artifactsValue) ? artifactsValue.map(text) : [];
  const moneySeparated = rows.every((row, index) => text(valueAt(snapshot,
    `${bodyPath}/requestedMoney/${index}/staffAllowanceType`)) === 'unsupported' &&
    hasSavedSeparateOther(editor, request.id, text(row.id)));
  const storedRequest = snapshot.session.draft.proposal.content.requests.find(row => row.id === request.id);
  const linkedAncillary = Boolean(storedRequest?.serviceRefs.length || storedRequest?.documentRefs.length);
  const splitDatesReady = (!rows.length || moneySeparated) && !linkedAncillary;
  const outputOptions = [
    { kind: 'email_quote', label: 'Cover email' },
    { kind: 'pdf_quote', label: 'PDF quote' },
    { kind: 'xlsx_quote', label: 'Excel quote' },
  ] as const;
  const allOutputsSelected = outputOptions.every((option) => artifacts.includes(option.kind));
  const provisional = valueAt(snapshot, `${bodyPath}/provisionalBookingRequested`);
  return <div className={`${styles.editor} ${styles.compactQuote}`}>
    <Section title="Stay and rooms">
      {groups.length ? <>
        <div className={styles.twoCol}><SharedDate editor={editor} groups={groups} bodyPath={bodyPath} field="arrival" label="Arrival" />
          <SharedDate editor={editor} groups={groups} bodyPath={bodyPath} field="departure" label="Departure" /></div>
        {mismatch && <p className={styles.notice}>This quote contains more than one date pair. Split it into separate quote actions; dates are never combined into one price.</p>}
        {mismatch && rows.length > 0 && !moneySeparated && <p className={styles.notice}>Handle shared extras separately before splitting date ranges. Save each follow-up as an Other request first.</p>}
        {mismatch && linkedAncillary && <p className={styles.notice}>Handle linked services and documents separately before splitting date ranges.</p>}
        {mismatch && <button type="button" className={styles.linkButton} disabled={view.busy || !splitDatesReady}
          onClick={() => void commands.changeRows({ kind: 'split_quote_dates', requestId: request.id } as never)}>
          Split into separate quote actions
        </button>}
      </> : <p className={styles.notice}>Add a room group to start a manual quote.</p>}
      {availabilityNotice && <p className={styles.notice}>{offersCurrent ? availabilityNotice : `Earlier Infor result: ${availabilityNotice} Refresh before relying on it.`}</p>}
      <div className={styles.groupHeading}><strong>Room groups</strong>
        <button type="button" className={styles.linkButton} aria-label="Add room group" disabled={view.busy || groups.length >= 8}
          onClick={() => void commands.changeRows({ kind: 'add_quote_group', requestId: request.id,
            entityId: `group_${crypto.randomUUID().replaceAll('-', '')}` })}>+ Group</button></div>
      {groups.map((group, index) => {
        const groupPath = `${bodyPath}/groups/${index}`;
        const options = Array.isArray(result.rateOptions) ? result.rateOptions.map(record).filter((option) => option.groupId === group.id) : [];
        const scope = text(record(group.occupancy).scope);
        return <div className={styles.roomCard} key={text(group.id) || index}>
          <div className={styles.groupHeading}><strong>Room group {index + 1}</strong>
            <button type="button" className={styles.linkButton} disabled={view.busy || groups.length <= 1} onClick={() => void commands.changeRows({ kind: 'remove_quote_group',
              requestId: request.id, entityId: text(group.id) })}>Remove</button></div>
          {mismatch && <p className={styles.note}>This group: {text(group.arrival) || 'arrival missing'} – {text(group.departure) || 'departure missing'}</p>}
          <div className={styles.twoCol}><Count label="Rooms" path={`${groupPath}/quantity`} editor={editor} min={1} max={100} review />
            <Field label="Board" path={`${groupPath}/board`} editor={editor} options={boards} review /></div>
          <Field label="Occupancy scope" path={`${groupPath}/occupancy/scope`} editor={editor} compact options={[
            { value: 'unresolved', label: 'Needs allocation' }, { value: 'whole_group', label: 'Whole group · needs allocation' },
            { value: 'per_room', label: 'Per room' },
          ]} />
          {scope !== 'per_room' && <p className={styles.notice}>Allocate adults and children per room before pricing. Totals are not divided automatically.</p>}
          <div className={styles.twoCol}><Count label="Adults per room" path={`${groupPath}/occupancy/adults`} editor={editor} min={1} max={6} review />
            <ChildAges editor={editor} path={`${groupPath}/occupancy`} max={6} /></div>
          <RoomCode editor={editor} path={`${groupPath}/roomCodes`} options={options} />
          <NativePicker label="Rate plan" path={`${groupPath}/ratePlan`} editor={editor} kind="rate_plan" compact />
          <OfferList editor={editor} groupId={text(group.id)} groupPath={groupPath} observation={observation} />
        </div>;
      })}
      <div className={styles.inlineButtons}><button type="button" className={styles.secondaryButton} disabled={view.busy} onClick={() => void commands.lookup()}>Refresh Infor offers</button></div>
      {observation && <div className={styles.price}><strong>{quoteCurrent(editor, observation) ? 'Current Infor quote' : offersCurrent ? 'Current Infor availability' : 'Earlier Infor observation'}</strong>
        {money(result.totalMinor, result.currency) && <span>{money(result.totalMinor, result.currency)} total</span>}
        <small>{text(result.arrivalDate)} – {text(result.departureDate)}{observation.observedAt ? ` · observed ${new Date(observation.observedAt).toLocaleString()}` : ''}</small>
        {rows.some((_, i) => text(valueAt(snapshot, `${bodyPath}/requestedMoney/${i}/staffAllowanceType`)) !== 'dinner') &&
          <small>Unresolved requests above are not included in this total.</small>}</div>}
    </Section>
    <Section title="Company and agency">
      <NativePicker label="Company" path={`${bodyPath}/parties/company`} editor={editor} kind="party_candidate" allowNone compact />
      <NativePicker label="Agency" path={`${bodyPath}/parties/agency`} editor={editor} kind="party_candidate" allowNone compact />
      <Field label="Sales strategy" path={`${bodyPath}/salesStrategy`} editor={editor} compact options={strategies} />
      {strategyUsedDiscoveryBar && selectedStrategy !== 'BAR' && <p className={styles.notice}>
        This source price used BAR as a discovery default; no sales strategy was selected. Choose the intended strategy above before Review/Check. If it is not BAR, check and prepare the price again.
      </p>}
    </Section>
    <MoneyRequests editor={editor} bodyPath={bodyPath} groups={groups} rows={rows} />
    <PreparedReview editor={editor} />
    <Section title="Contact and outputs">
      <Field label="Attention" path={`${bodyPath}/client/attention`} editor={editor} compact />
      <Field label="Email recipient" path={`${bodyPath}/client/email`} editor={editor} type="email" compact />
      <Field label="Telephone" path={`${bodyPath}/client/telephone`} editor={editor} type="tel" compact />
      <Field label="Quote note" path={`${bodyPath}/notes`} editor={editor} type="textarea" compact />
      <p className={styles.note}>Choose outputs from the same current Infor-priced facts. Saving the cover email creates an unsent draft; quote files stay available to download.</p>
      <fieldset data-field-path={artifactPath} className={styles.targetFields}><legend>Quote outputs</legend>
        {outputOptions.map((option) => <label key={option.kind}>
          <input type="checkbox" checked={artifacts.includes(option.kind)} disabled={view.busy}
            onChange={(event) => void commands.edit(artifactPath, event.target.checked
              ? [...artifacts, option.kind] : artifacts.filter((kind) => kind !== option.kind))} /> {option.label}
        </label>)}
      </fieldset>
      {!artifacts.length && <p className={styles.notice}>Select at least one output before generating the quote.</p>}
      {!allOutputsSelected && <button type="button" className={styles.linkButton} disabled={view.busy}
        onClick={() => void commands.edit(artifactPath, outputOptions.map((option) => option.kind))}>Select full quote package</button>}
      <p className={styles.note}>A provisional booking needs a separate Create action.</p>
      {provisional !== false && <div data-field-path={`${bodyPath}/provisionalBookingRequested`} className={styles.notice}>This request has not been confirmed as quote-only.
        <button type="button" className={styles.linkButton} onClick={() => void commands.edit(`${bodyPath}/provisionalBookingRequested`, false)}>Continue with quote only</button>
      </div>}
    </Section>
  </div>;
}
