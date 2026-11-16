'use client';

import { quoteCompositionSchema, separatedQuoteMoneyLinked } from '../../../../server-pilot/src/ai/reservation-workflow-v2-contract';
import { boardCode, quoteCompositionStatus, quoteGuestCountNeedsConfirmation, quoteRateNeedsConfirmation, quoteRoomCountNeedsConfirmation } from '../../../../server-pilot/src/ai/reservation-workflow-v2-quote-readiness';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { effectiveAt, nativeChoices, record, requestPath, text, valueAt, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { Count, Field, FieldReview, Section } from '../shared/stay-fields';
import { NativePicker, usePickerPosition } from '../shared/native-pickers';
import { ChildAges } from './create-editor';
import styles from './create-quote-editor.module.css';
import pickerStyles from '../reservation-pane.module.css';

type Editor = WorkbenchEditorProps;
const reviewContextPath = (path: string) => /\/body\/(?:guestNames|groups\/[^/]+\/(?:guestNames|requestedRoomDescription))(?:\/|$)/u.test(path);
function pricingOverrides(value: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record(value)).filter(([path]) => !reviewContextPath(path)));
}

const strategies = [
  { value: 'BAR', label: 'BAR · best available rate' }, { value: 'PROMO', label: 'PROMO · promotion' },
  { value: 'PRESET', label: 'PRESET' }, { value: 'WS', label: 'WS' }, { value: 'NC', label: 'NC' },
  { value: 'GOV', label: 'GOV · Government' }, { value: 'AIR', label: 'AIR' },
  { value: 'DOML', label: 'DOML' }, { value: 'OTHER', label: 'OTHER' },
];

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
  if (JSON.stringify(pricingOverrides(current)) !== JSON.stringify(pricingOverrides(result.inputOverrides))) return false;
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
function quoteMealPlanCode(value: unknown, configuration: Editor['configuration']) {
  const label = text(value).trim().toLocaleLowerCase().replace(/\s+/gu, ' ');
  const observed = configuration?.nativeMealMappings.find(row => row.label.trim().toLocaleLowerCase().replace(/\s+/gu, ' ') === label);
  if (observed) return observed.mealPlan;
  if (configuration && configuration.propertyCode !== 'HRCEN') {
    return label === 'room_only' || label === 'bb' || label === 'dinner_bb' ? label : null;
  }
  const mealPlan = label.replace(/[,\s&-]+/gu, '_').replace(/_for_all$/u, '');
  if (['room_only', 'roomonly', 'ro'].includes(mealPlan)) return 'room_only';
  if (['bb', 'b_b', 'breakfast', 'bed_and_breakfast', 'bed_breakfast'].includes(mealPlan)) return 'bb';
  if (['dbb', 'dinner_bb', 'dinner_b_b', 'dinner_bed_breakfast', 'dinner_bed_and_breakfast', 'dinner_and_breakfast'].includes(mealPlan)) return 'dinner_bb';
  return null;
}
function quoteOffersCurrent(editor: Editor, observation: ReturnType<typeof latestQuote>) {
  if (quoteCurrent(editor, observation)) return true;
  if (!observation || observation.generationId !== editor.snapshot.session.draft.generationId ||
      observation.propertyCode !== editor.snapshot.session.draft.propertyCode ||
      observation.sourceMessageId !== editor.snapshot.session.draft.source.messageId ||
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
  if (JSON.stringify(pricingOverrides(overrides)) !== JSON.stringify(pricingOverrides(result.inputOverrides))) return false;
  const body = record(effectiveAt(editor.snapshot, `${requestPath(editor.request.id)}/body`));
  const groups = Array.isArray(body.groups) ? body.groups.map(record) : [];
  const requested = Array.isArray(result.requestedGroups) ? result.requestedGroups.map(record) : [];
  if (!groups.length || groups.length !== requested.length) return false;
  return groups.every((group) => {
    const native = requested.find((row) => row.id === group.id), occupancy = record(group.occupancy);
    return native && native.arrivalDate === group.arrival && native.departureDate === group.departure &&
      native.quantity === group.quantity && native.adults === occupancy.adults &&
      native.mealPlan === (quoteMealPlanCode(group.mealPlan, editor.configuration)
        ?? quoteMealPlanCode(group.requestedMealPlan, editor.configuration)
        ?? (!text(group.mealPlan).trim() && !text(group.requestedMealPlan).trim() ? 'bb' : null)) &&
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
    return 'Infor did not confirm a matching rate for the selected room and meal plan. Availability is not confirmed; choose an available offer or refresh the search.';
  if (result.failureKind === 'restricted')
    return 'Infor marked part of this stay restricted. This is not a sold-out result; review the affected dates or choose another offer.';
  if (['system_fault', 'qualification_failure', 'read_failure'].includes(text(result.failureKind)))
    return 'Nava problem, not yours. Contact Nava support.';
  return null;
}

function hasSavedSeparateOther(editor: Editor, requestId: string, moneyId: string): boolean {
  if (!moneyId) return false;
  return editor.snapshot.session.draft.proposal.content.requests.some(request => request.kind === 'other' &&
    separatedQuoteMoneyLinked(request.body.separatedFrom, requestId, moneyId));
}

function RoomCode({ editor, path, options, requested }: { editor: Editor; path: string; options: Record<string, unknown>[]; requested: string }) {
  const id = useId(), picker = useRef<HTMLDivElement>(null);
  const saved = valueAt(editor.snapshot, path);
  const initial = Array.isArray(saved) ? saved.map(text).join(', ') : '';
  const [value, setValue] = useState(initial), [open, setOpen] = useState(false);
  const position = usePickerPosition(open, picker);
  const [reviewing, setReviewing] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null), [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
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
  const codes = [...new Map([...nativeChoices(editor.snapshot, path, 'room_type', editor.configuration).map(row => [row.value, row.label] as const),
    ...options.map(option => [text(option.roomCode), text(option.roomLabel)] as const)].filter(([code]) => code)).entries()];
  const words = requested.toLocaleLowerCase().match(/[\p{L}]+/gu)?.filter(word => !['x', 'room', 'rooms'].includes(word)) ?? [];
  const matching = words.length ? codes.filter(([, label]) => {
    const meaning = label.toLocaleLowerCase();
    return words.every(word => meaning.includes(word));
  }) : [];
  const load = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true; setLoading(true); setError(null);
    try { await commit(); if (editor.commands.lookupChoices) await editor.commands.lookupChoices(path); else await editor.commands.lookup(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Infor room categories could not load.'); }
    finally { loadingRef.current = false; setLoading(false); }
  };
  const openChoices = () => { setOpen(true); setSearch(''); setActiveIndex(-1); if (!codes.length && !error) void load(); };
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
  const shown = codes.filter(([code, label]) => `${code} ${label}`.toLowerCase().includes(search.toLowerCase()));
  const activeId = open && activeIndex >= 0 && shown[activeIndex] ? `${id}-room-${activeIndex}` : undefined;
  const keyboard = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { setOpen(false); setActiveIndex(-1); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); if (!open) openChoices();
      const count = open ? shown.length : codes.length;
      setActiveIndex(index => !count ? -1 : event.key === 'ArrowDown' ? Math.min(index + 1, count - 1)
        : index < 0 ? count - 1 : Math.max(0, index - 1));
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const row = open && shown[activeIndex];
      if (row && !editor.view.busy && !reviewing) void choose(row[0]);
      else if (!row) void commit().catch(() => {});
    }
  };
  useEffect(() => {
    if (!activeId) return;
    const option = document.getElementById(activeId), menu = option?.closest('[role=listbox]');
    if (!(menu instanceof HTMLElement) || !option) return;
    const bounds = option.getBoundingClientRect(), viewport = menu.getBoundingClientRect();
    if (bounds.bottom > viewport.bottom) menu.scrollTop += bounds.bottom - viewport.bottom;
    else if (bounds.top < viewport.top) menu.scrollTop += bounds.top - viewport.top;
  }, [activeId]);
  return <div data-field-path={path} className={`${styles.localField} ${styles.quoteLine}`}>
    <label htmlFor={id}>Room categories</label>
    {!parse(value).length && requested && <div className={styles.roomSuggestions}>
      <small>Requested: {requested}. Choose an Infor room type.</small>
      {matching.map(([code, label]) => <button type="button" key={code} disabled={editor.view.busy || reviewing}
        onClick={() => { void choose(code); }}><strong>{code}</strong>{label !== code ? ` — ${label}` : ''}</button>)}
    </div>}
    <div ref={picker} className={pickerStyles.picker}>
      <div className={pickerStyles.pickerInput}><input id={id} value={value} role="combobox" aria-expanded={open} aria-controls={`${id}-rooms`} aria-activedescendant={activeId}
        disabled={reviewing || editor.view.busy && !loading} placeholder="Any category, or codes separated by commas" onFocus={openChoices} onClick={openChoices}
        onChange={event => { change(event.target.value); setActiveIndex(-1); }} onBlur={() => { void commit().catch(() => {}); }}
        onKeyDown={keyboard} />
        <button type="button" aria-label="Show room categories" disabled={reviewing || loading} onMouseDown={event => event.preventDefault()}
          onClick={() => open ? setOpen(false) : openChoices()}>⌄</button></div>
      {open && <div id={`${id}-rooms`} role="listbox" aria-multiselectable="true" className={pickerStyles.options} style={position}>
        <input aria-label="Search room categories" aria-activedescendant={activeId} value={search} placeholder="Search code or meaning" onChange={event => { setSearch(event.target.value); setActiveIndex(-1); }} onKeyDown={keyboard} />
        {loading && <small role="status">Loading room categories from Infor…</small>}
        {error && <small role="alert">{error}</small>}
        {shown.map(([code, label], index) =>
          <button id={`${id}-room-${index}`} key={code} type="button" role="option" aria-selected={parse(value).includes(code)} style={activeIndex === index ? { background: '#f4f2ff' } : undefined} disabled={editor.view.busy || reviewing}
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
    {observation && !current && <p className={styles.notice}>Earlier availability shown. Generate the quote again before choosing.</p>}
    {result.availabilityTruncated === true && <p className={styles.notice}>Infor's availability results were truncated; some offers may be missing.</p>}
    {!options.length && <p className={styles.note}>{observation ? 'No selectable Infor offers were returned for this group.' : 'Available Infor offers appear after lookup.'}</p>}
    {options.map((option, index) => {
      const room = text(option.roomCode), rate = text(option.rateCode), mealPlan = text(option.mealPlan);
      const selected = Array.isArray(valueAt(editor.snapshot, `${groupPath}/roomCodes`)) &&
        (valueAt(editor.snapshot, `${groupPath}/roomCodes`) as unknown[]).includes(room) &&
        text(valueAt(editor.snapshot, `${groupPath}/ratePlan`)) === rate && text(valueAt(editor.snapshot, `${groupPath}/mealPlan`)) === mealPlan;
      const nightly = money(option.perNightMinor, option.currency), total = money(option.totalMinor, option.currency);
      return <div className={styles.offer} key={`${room}-${rate}-${mealPlan}-${index}`}>
        <div><strong>{room} · {text(option.roomLabel) || room} / {rate} · {text(option.rateLabel) || rate}</strong>
          <small>{text(option.mealPlanLabel) || mealPlan}{nightly ? ` · ${nightly} per night` : ''}{total ? ` · ${total} ${option.priced === 'summary' ? 'indicative sum' : 'total'}` : ''}
            {typeof option.roomsLeft === 'number' ? ` · ${option.roomsLeft} rooms left` : ''}{option.priced === 'summary' ? ' · summary only' : ''}</small></div>
        <button type="button" className={styles.secondaryButton} disabled={!current || editor.view.busy || !room || !rate || !mealPlan}
          aria-pressed={selected} onClick={() => {
            const pending = `${groupPath}/offer`;
            editor.commands.setUncommitted(pending, true);
            void (async () => {
              await editor.commands.edit(`${groupPath}/roomCodes`, [room]);
              await editor.commands.edit(`${groupPath}/ratePlan`, rate);
              await editor.commands.edit(`${groupPath}/mealPlan`, mealPlan);
            })().finally(() => editor.commands.setUncommitted(pending, false)).catch(() => {});
          }}>{selected ? 'Selected' : 'Use this'}</button>
      </div>;
    })}
  </div>;
}

function MoneyRequests({ editor, bodyPath, groups, rows }: { editor: Editor; bodyPath: string; groups: Record<string, unknown>[]; rows: Record<string, unknown>[] }) {
  return <Section title="Extras">
    <p className={styles.note}>Add lunch and transfers as separate lines.</p>
    <div className={styles.inlineButtons}>{[
      { kind: 'lunch', label: 'Lunch' },
      { kind: 'airport_transfer', label: 'Airport Transfer / Shuttle' },
      { kind: 'office_transfer', label: 'Office Transfer' },
      { kind: 'dinner', label: 'Dinner' },
    ].map(extra => <button type="button" key={extra.kind} className={styles.linkButton} disabled={editor.view.busy || rows.length >= 100}
      data-field-path={extra.kind === 'lunch' ? `${bodyPath}/requestedMoney` : undefined}
      onClick={() => void editor.commands.changeRows({ kind: 'add_quote_extra', requestId: editor.request.id, entityId: extra.kind })}>+ {extra.label}</button>)}</div>
    {rows.length > 0 && <p className={styles.note}>Extras are added on top of the Infor room rate. They never change it.</p>}
    {rows.map((row, index) => {
      const path = `${bodyPath}/requestedMoney/${index}`;
      const kindPath = `${path}/staffAllowanceType`;
      const kind = text(valueAt(editor.snapshot, kindPath));
      const moneyId = text(row.id);
      const separateOtherSaved = hasSavedSeparateOther(editor, editor.request.id, moneyId);
      const scope = text(valueAt(editor.snapshot, `${path}/scope`));
      const targets = valueAt(editor.snapshot, `${path}/targetRefs`);
      const selected = Array.isArray(targets) ? targets.map(text) : [];
      const allIds = groups.map((group) => text(group.id));
      const applied = scope === 'overall' ? allIds : scope === 'per_target' ? selected : [];
      // One control replaces the old scope select: every group ticked means all room groups.
      const setApplied = (next: string[]) => {
        const all = allIds.length > 0 && allIds.every((id) => next.includes(id));
        editor.commands.setUncommitted(`${path}/scope`, true);
        void (async () => {
          await editor.commands.edit(`${path}/targetRefs`, all ? [] : next);
          await editor.commands.edit(`${path}/scope`, all ? 'overall' : 'per_target');
        })().finally(() => editor.commands.setUncommitted(`${path}/scope`, false)).catch(() => {});
      };
      return <div className={styles.roomCard} key={text(row.id) || index}>
        <div className={styles.twoCol}><Field label="Amount" path={`${path}/amount`} editor={editor} review requireReview />
          <Field label="Currency" path={`${path}/currency`} editor={editor} review requireReview /></div>
        <Field label="Unit" path={`${path}/unit`} editor={editor} review requireReview options={[
          { value: 'per_person_per_night', label: 'Per person per night' },
          { value: 'per_room_per_night', label: 'Per room per night' },
          { value: 'per_person', label: 'Per person' },
          { value: 'per_trip', label: 'Per trip' },
          { value: 'item', label: 'Once' },
        ]} />
        <label data-field-path={kindPath} className={styles.localField}>Handle as
          <FieldReview editor={editor} path={kindPath} label="extra type" requireReview />
          <select value={kind || 'unresolved'} disabled={editor.view.busy} onChange={(event) => {
            const next = event.target.value;
            if (next === 'unsupported') {
              if (kind === 'unsupported' && separateOtherSaved) return;
              void editor.commands.changeRows({ kind: 'separate_quote_money', requestId: editor.request.id, entityId: String(index) } as never);
            } else if (['dinner', 'lunch', 'airport_transfer', 'office_transfer'].includes(next)) {
              void editor.commands.edit(kindPath, next).then(() => {
                // Only a single-group quote has an unambiguous default; with several groups staff tick the rooms.
                if (allIds.length === 1 && scope !== 'overall' && scope !== 'per_target') setApplied(allIds);
              }).catch(() => {});
            }
          }}>
            <option value="unresolved">Choose how to handle</option>
            <option value="dinner">Dinner allowance</option>
            <option value="lunch">Lunch</option>
            <option value="airport_transfer">Airport Transfer / Shuttle</option>
            <option value="office_transfer">Office Transfer</option>
            <option value="unsupported">Other request · handle separately</option>
          </select>
        </label>
        <fieldset className={styles.targetFields} data-field-path={`${path}/scope`}>
          <legend className={styles.countHeading}><span>Applies to</span>
            <span className={styles.inlineButtons}><FieldReview editor={editor} path={`${path}/scope`} label="rooms for this extra" requireReview />
              <span data-field-path={`${path}/targetRefs`}><FieldReview editor={editor} path={`${path}/targetRefs`} label="rooms for this extra" requireReview /></span></span></legend>
          {groups.map((group, groupIndex) => { const id = text(group.id); return <label key={id || groupIndex}>
            <input type="checkbox" disabled={editor.view.busy} checked={applied.includes(id)}
              onChange={(event) => setApplied(event.target.checked ? [...applied, id] : applied.filter((value) => value !== id))} />
            {groups.length === 1 ? ' All rooms' : ` Room group ${groupIndex + 1}`}
          </label>; })}
          {kind !== 'unsupported' && applied.length === 0 && <p className={styles.notice}>Tick the rooms this extra is for.</p>}
        </fieldset>
        {kind === 'unsupported' && separateOtherSaved
          ? <p className={styles.note}>Saved as a separate Other request. This supported room quote can continue independently.</p>
          : kind === 'unsupported'
            ? <p className={styles.notice}>The separate follow-up is not saved yet. Save it as an Other request before generating this quote.</p>
            : !['dinner', 'lunch', 'airport_transfer', 'office_transfer'].includes(kind) && <p className={styles.notice}>Choose the extra to include in this quote, or save it as a separate Other request.</p>}
        {kind !== 'unsupported' && <button type="button" className={styles.linkButton} disabled={editor.view.busy}
          onClick={() => void editor.commands.changeRows({ kind: 'remove_quote_extra', requestId: editor.request.id, entityId: moneyId })}>Remove extra</button>}
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
  const accepted = current && review?.status === 'accepted' && review.note === `quote-extras:${operation.id}:${observation.ref}` &&
    Date.parse(review.at ?? '') >= Date.parse(observation.observedAt) &&
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
      return <p className={styles.note} key={text(group.id) || index}>Group {index + 1} · {text(group.quantity)} rooms · {text(group.arrivalDate)} – {text(group.departureDate)} · {text(group.roomCode)} / {text(group.rateCode)} · {text(group.mealPlan)}{groupTotal != null ? ` · ${money(groupTotal, result.currency)}` : ''}</p>;
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
      disabled={!current || editor.view.busy} onClick={() => {
        const path = `${requestPath(editor.request.id)}/body`;
        void editor.commands.acceptServiceReview(path, `quote-extras:${operation.id}:${observation.ref}`,
          { path, value: effectiveAt(editor.snapshot, path), generationId: draft.generationId }).catch(() => {});
      }}>
      Accept prepared price and extras
    </button>}
  </Section>;
}

export function QuoteEditor(editor: Editor) {
  const { request, snapshot, commands, view } = editor;
  const bodyPath = `${requestPath(request.id)}/body`;
  const body = record(effectiveAt(snapshot, bodyPath));
  const groups = Array.isArray(body.groups) ? body.groups.map(record) : [];
  const sourceQuote = snapshot.session.draft.proposal.content.requests.find(row => row.id === request.id && row.kind === 'quote');
  const composition = sourceQuote?.kind === 'quote' ? quoteCompositionStatus(snapshot.session.draft, sourceQuote) : 'additive';
  const parsedComposition = quoteCompositionSchema.safeParse(valueAt(snapshot, `${bodyPath}/quoteComposition`));
  const scenarios = parsedComposition.success && parsedComposition.data.kind === 'scenarios' ? parsedComposition.data.scenarios : [];
  const groupIds = groups.map(group => group.id).filter((id): id is string => typeof id === 'string' && Boolean(id));
  const validGroupIds = groupIds.length === groups.length && new Set(groupIds).size === groupIds.length;
  const groupsByMeal = new Map<string, string[]>();
  for (const group of groups) {
    const meal = boardCode(group.mealPlan, snapshot.session.draft.propertyCode) ?? boardCode(group.requestedMealPlan, snapshot.session.draft.propertyCode);
    if (meal && typeof group.id === 'string') groupsByMeal.set(meal, [...(groupsByMeal.get(meal) ?? []), group.id]);
  }
  const rows = Array.isArray(body.requestedMoney) ? body.requestedMoney.map(record) : [];
  const observation = latestQuote(editor);
  const result = record(observation?.result);
  const searchContext = record(result.searchContext);
  const strategyUsedDiscoveryBar = observation?.status === 'complete' &&
    searchContext.strategySource === 'discovery_default' && searchContext.salesStrategy === 'BAR';
  const selectedStrategy = text(valueAt(snapshot, `${bodyPath}/salesStrategy`)).trim();
  const offersCurrent = quoteOffersCurrent(editor, observation);
  const availabilityNotice = availabilityMessage(result);
  const provisional = valueAt(snapshot, `${bodyPath}/provisionalBookingRequested`);
  return <div className={`${styles.editor} ${styles.compactQuote}`}>
    <Section title="Client">
      <p className={styles.note}>Type the name as the client wrote it. Pick an Infor match only when its contract rate applies.</p>
      <NativePicker label="Organization" path={`${bodyPath}/parties/organization`} editor={editor} kind="party_candidate" allowNone compact quoteName />
      <NativePicker label="Primary Booking Agency" path={`${bodyPath}/parties/bookingAgency`} editor={editor} kind="party_candidate" allowNone compact quoteName />
      <Field label="Attention" path={`${bodyPath}/client/attention`} editor={editor} compact />
      <div className={styles.twoCol}><Field label="Email" path={`${bodyPath}/client/email`} editor={editor} type="email" compact />
        <Field label="Telephone" path={`${bodyPath}/client/telephone`} editor={editor} type="tel" compact /></div>
    </Section>
    <Section title="Stay and rooms">
      <Field label="Sales Strategy" path={`${bodyPath}/salesStrategy`} editor={editor} compact options={strategies} />
      {strategyUsedDiscoveryBar && selectedStrategy !== 'BAR' && <p className={styles.notice}>
        This price used BAR. Choose the Sales Strategy you want, then generate again.
      </p>}
      {!groups.length && <p className={styles.notice}>Add a room group to start the quote.</p>}
      {composition === 'additive' && groups.length > 1 && <button type="button" className={styles.linkButton} disabled={view.busy}
        onClick={() => void commands.edit(`${bodyPath}/quoteComposition`, { kind: 'unresolved', evidenceRefs: [] })}>Change how these groups are quoted</button>}
      {(composition === 'unresolved' || composition === 'invalid') && <div className={styles.notice} data-field-path={`${bodyPath}/quoteComposition`}>
        Are these room groups part of one quote, or different options for the customer?
        <div className={styles.inlineButtons}>
          <button type="button" disabled={view.busy} onClick={() => void commands.edit(`${bodyPath}/quoteComposition`, { kind: 'additive' })}>One quote together</button>
          {validGroupIds && groupsByMeal.size > 1 && [...groupsByMeal.values()].reduce((total, ids) => total + ids.length, 0) === groups.length && <button type="button" disabled={view.busy}
            onClick={() => void commands.edit(`${bodyPath}/quoteComposition`, { kind: 'scenarios', scenarios: [...groupsByMeal].map(([meal, groupIds], index) => ({
              id: `option_${index + 1}`, label: meal === 'bb' ? 'Bed and breakfast' : meal === 'room_only' ? 'Room only' : 'Dinner, bed and breakfast', groupIds, evidenceRefs: [],
            })) })}>Separate meal options</button>}
          {validGroupIds && groups.length > 1 && groups.length <= 32 && <button type="button" disabled={view.busy}
            onClick={() => void commands.edit(`${bodyPath}/quoteComposition`, { kind: 'scenarios', scenarios: groupIds.map((groupId, index) => ({
              id: `option_${index + 1}`, label: `Option ${index + 1}`, groupIds: [groupId], evidenceRefs: [],
            })) })}>Each group is an option</button>}
        </div>
      </div>}
      {composition === 'scenarios' && <div className={styles.note}>
        <p>These options will be priced separately and included in one draft. Move groups into the same option if they belong together.</p>
        {groupIds.map((groupId, index) => <label key={groupId}>Group {index + 1} option{' '}
          <select value={scenarios.find(scenario => scenario.groupIds.includes(groupId))?.id ?? ''} disabled={view.busy} onChange={event => {
            const next = scenarios.map(scenario => ({ ...scenario, evidenceRefs: [], groupIds: scenario.id === event.target.value
              ? [...scenario.groupIds.filter(id => id !== groupId), groupId] : scenario.groupIds.filter(id => id !== groupId) }))
              .filter(scenario => scenario.groupIds.length);
            void commands.edit(`${bodyPath}/quoteComposition`, next.length > 1 ? { kind: 'scenarios', scenarios: next } : { kind: 'additive' });
          }}>{scenarios.map(scenario => <option key={scenario.id} value={scenario.id}>{scenario.label}</option>)}</select>
        </label>)}
      </div>}
      {availabilityNotice && <p className={styles.notice}>{offersCurrent ? availabilityNotice : `Earlier Infor result: ${availabilityNotice} Generate the quote again before relying on it.`}</p>}
      {groups.map((group, index) => {
        const groupPath = `${bodyPath}/groups/${index}`;
        const roomSource = snapshot.session.draft.proposal.sourceClaims.find((claim) => claim.path === `${groupPath}/quantity`);
        const options = Array.isArray(result.rateOptions) ? result.rateOptions.map(record).filter((option) => option.groupId === group.id) : [];
        const scope = text(record(group.occupancy).scope);
        const originalOccupancy = sourceQuote?.kind === 'quote' ? sourceQuote.body.groups[index]?.occupancy : undefined;
        const guessedCounts = (['adults', 'childCount'] as const).flatMap(field => {
          const path = `${groupPath}/occupancy/${field}`;
          const value = valueAt(snapshot, path);
          return originalOccupancy && quoteGuestCountNeedsConfirmation(snapshot.session.draft, path, originalOccupancy[field]) && typeof value === 'number'
            ? [{ path, value }] : [];
        });
        const quantityPath = `${groupPath}/quantity`;
        const inferredQuantity = quoteRoomCountNeedsConfirmation(snapshot.session.draft, quantityPath) ? valueAt(snapshot, quantityPath) : null;
        const askedFor = text(valueAt(snapshot, `${groupPath}/requestedRoomDescription`)).trim() || text(roomSource?.raw).trim();
        return <div className={styles.roomCard} key={text(group.id) || index}>
          {groups.length > 1 && <div className={styles.groupHeading}><strong>Room group {index + 1}</strong>
            <button type="button" className={styles.linkButton} data-field-path={groupPath}
              disabled={view.busy} onClick={() => void commands.changeRows({ kind: 'remove_quote_group',
              requestId: request.id, entityId: text(group.id) })}>Remove</button></div>}
          {sourceQuote?.kind === 'quote' && sourceQuote.body.groups[index]?.sourceAssociationUnresolved === true && valueAt(snapshot, `${groupPath}/sourceAssociationUnresolved`) !== false && <div className={styles.notice} data-field-path={`${groupPath}/sourceAssociationUnresolved`}>
            Check this group's dates and room request against the email. Remove any duplicate, or confirm the details.{' '}
            <button type="button" disabled={view.busy} onClick={() => void commands.edit(`${groupPath}/sourceAssociationUnresolved`, false)}>Details are correct</button>
          </div>}
          {quoteRateNeedsConfirmation(snapshot.session.draft, request.id, index) && <div className={styles.notice} data-field-path={`${groupPath}/ratePlan`}>
            The customer asked for a rate by name. Choose it from Infor, or confirm another available rate.{' '}
            <button type="button" disabled={view.busy} onClick={() => void commands.edit(`${groupPath}/ratePlan`, null, 'none')}>Use another available rate</button>
          </div>}
          {askedFor && <p className={styles.note} data-field-path={`${groupPath}/requestedRoomDescription`}>Client asked for: {askedFor}</p>}
          <div className={styles.twoCol}><Field label="Arrival" path={`${groupPath}/arrival`} editor={editor} type="date" review />
            <Field label="Departure" path={`${groupPath}/departure`} editor={editor} type="date" review /></div>
          {scope !== 'per_room' && <div className={styles.notice} data-field-path={`${groupPath}/occupancy/scope`}>
            {scope === 'whole_group' ? 'The email gives guest numbers for the whole group.' : 'Check how many guests stay in each room.'}{' '}
            Enter adults and children for one room, then confirm.{' '}
            <button type="button" disabled={view.busy} onClick={() => void commands.edit(`${groupPath}/occupancy/scope`, 'per_room')}>Numbers are per room</button>
          </div>}
          <div className={styles.twoCol}><Count label="Rooms" path={`${groupPath}/quantity`} editor={editor} min={1} max={100} review />
            <Count label={scope === 'whole_group' ? 'Adults (whole group)' : 'Adults per room'} path={`${groupPath}/occupancy/adults`} editor={editor} min={1} max={scope === 'per_room' ? 6 : 100} review /></div>
          {typeof inferredQuantity === 'number' && <div className={styles.notice}>The room count was inferred from guest names. Check it.{' '}
            <button type="button" disabled={view.busy} onClick={() => void commands.edit(quantityPath, inferredQuantity)}>Confirm room count</button>
          </div>}
          {guessedCounts.length > 0 && <div className={styles.notice}>The email did not specify all guest counts. Check the counts shown.{' '}
            <button type="button" disabled={view.busy} onClick={() => { void (async () => {
              for (const count of guessedCounts) await commands.edit(count.path, count.value);
            })().catch(() => {}); }}>Confirm guest counts</button>
          </div>}
          <ChildAges editor={editor} path={`${groupPath}/occupancy`} max={6} />
          <RoomCode editor={editor} path={`${groupPath}/roomCodes`} options={options} requested={askedFor} />
          <NativePicker label="Rate Plan" path={`${groupPath}/ratePlan`} editor={editor} kind="rate_plan" compact />
          <div className={styles.twoCol}>
            <Field label="Meal Plan request" path={`${groupPath}/requestedMealPlan`} editor={editor} maxLength={120} review />
            <div data-field-path={`${groupPath}/mealPlan`} className={styles.localField}>
              <div className={styles.countHeading}><span>Meal Plan</span>
                {group.mealPlan != null && <FieldReview editor={editor} path={`${groupPath}/mealPlan`} label="Meal Plan" requireReview />}</div>
              <span>{text(group.mealPlan) || 'Set by the Rate Plan'}</span>
            </div>
          </div>
          <OfferList editor={editor} groupId={text(group.id)} groupPath={groupPath} observation={observation} />
        </div>;
      })}
      <button type="button" className={styles.linkButton} aria-label="Add room group"
        data-field-path={`${bodyPath}/groups`}
        disabled={view.busy || groups.length >= 8}
        onClick={() => void commands.changeRows({ kind: 'add_quote_group', requestId: request.id,
          entityId: `group_${crypto.randomUUID().replaceAll('-', '')}` })}>+ Add another room type or dates</button>
      {observation && <div className={styles.price}><strong>{quoteCurrent(editor, observation) ? 'Current Infor quote' : offersCurrent ? 'Current Infor availability' : 'Earlier Infor observation'}</strong>
        {money(result.totalMinor, result.currency) && <span>{money(result.totalMinor, result.currency)} total</span>}
        <small>{text(result.arrivalDate)} – {text(result.departureDate)}{observation.observedAt ? ` · observed ${new Date(observation.observedAt).toLocaleString()}` : ''}</small>
        {rows.some((_, i) => !['dinner', 'lunch', 'airport_transfer', 'office_transfer'].includes(text(valueAt(snapshot, `${bodyPath}/requestedMoney/${i}/staffAllowanceType`))) || !text(valueAt(snapshot, `${bodyPath}/requestedMoney/${i}/amount`)).trim()) &&
          <small>Extras still to sort out are not in this total.</small>}</div>}
    </Section>
    <MoneyRequests editor={editor} bodyPath={bodyPath} groups={groups} rows={rows} />
    <PreparedReview editor={editor} />
    <Section title="Note">
      <Field label="Quote note" path={`${bodyPath}/notes`} editor={editor} type="textarea" compact />
      {provisional !== false && <div data-field-path={`${bodyPath}/provisionalBookingRequested`} className={styles.notice}>The client may also want a provisional booking. Book it later with Create.{' '}
        <button type="button" className={styles.linkButton} onClick={() => void commands.edit(`${bodyPath}/provisionalBookingRequested`, false)}>Quote only for now</button>
      </div>}
    </Section>
  </div>;
}
