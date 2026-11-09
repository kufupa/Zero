'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { effectiveAt, quoteOutputState, record, requestPath, text, valueAt, type WorkbenchEditorProps } from '@/lib/reservation-workflow/views';
import { Count, Field, FieldReview, Section } from '../shared/stay-fields';
import { NativePicker } from '../shared/native-pickers';
import { ChildAges } from './create-editor';
import styles from './create-quote-editor.module.css';

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
  return <div className={styles.localField}>
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

function RoomCode({ editor, path, options }: { editor: Editor; path: string; options: Record<string, unknown>[] }) {
  const id = useId();
  const saved = valueAt(editor.snapshot, path);
  const initial = Array.isArray(saved) ? saved.map(text).join(', ') : '';
  const [value, setValue] = useState(initial);
  const [reviewing, setReviewing] = useState(false);
  const dirty = useRef(false), version = useRef(0);
  const parse = (input: string) => input.split(',').map((code) => code.trim().toUpperCase()).filter(Boolean);
  useEffect(() => { if (!dirty.current) setValue(initial); }, [initial]);
  useEffect(() => () => editor.commands.setUncommitted(path, false), [path]);
  const listId = `rooms-${path.replace(/[^a-z0-9]/giu, '-')}`;
  const codes = [...new Map(options.map((option): [string, string] => [text(option.roomCode), text(option.roomLabel)]).filter(([code]) => code)).entries()];
  return <div className={`${styles.localField} ${styles.quoteLine}`}>
    <label htmlFor={id}>Room categories</label>
    <input id={id} value={value} list={listId} disabled={editor.view.busy || reviewing} placeholder="Any category, or codes separated by commas" onChange={(event) => {
      const next = event.target.value; setValue(next); dirty.current = true; version.current += 1;
      editor.commands.setUncommitted(path, true); editor.commands.stageEdit(path, parse(next));
    }}
      onBlur={() => {
        if (!dirty.current) return;
        const before = version.current, next = parse(value);
        void editor.commands.edit(path, next).then(() => {
          if (version.current === before) { dirty.current = false; setValue(next.join(', ')); editor.commands.setUncommitted(path, false); }
        }).catch(() => {});
      }} />
    <datalist id={listId}>{codes.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</datalist>
    <span className={styles.quoteReview}><FieldReview editor={editor} path={path} label="Room categories" onPendingChange={setReviewing} /></span>
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
    <p className={styles.note}>Amounts are customer requests. Choose how to handle each allowance; they do not override an Infor room rate.</p>
    {rows.map((row, index) => {
      const path = `${bodyPath}/requestedMoney/${index}`;
      const kindPath = `${path}/staffAllowanceType`;
      const kind = text(valueAt(editor.snapshot, kindPath));
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
        <Field label="Handle as" path={kindPath} editor={editor} options={[
          { value: 'dinner', label: 'Dinner allowance' },
          { value: 'unsupported', label: 'Other request · handle separately' },
        ]} />
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
        {kind !== 'dinner' && <p className={styles.notice}>This request needs a supported allowance choice or separate handling before quote generation.</p>}
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
  const [manualDocumentsAck, setManualDocumentsAck] = useState<string | null>(null);
  const bodyPath = `${requestPath(request.id)}/body`;
  const body = record(effectiveAt(snapshot, bodyPath));
  const groups = Array.isArray(body.groups) ? body.groups.map(record) : [];
  const rows = Array.isArray(body.requestedMoney) ? body.requestedMoney.map(record) : [];
  const observation = latestQuote(editor);
  const result = record(observation?.result);
  const shortfall = record(result.shortfall);
  const hasShortfall = result.failureKind === 'proven_shortage' && typeof shortfall.roomCode === 'string' &&
    typeof shortfall.roomLabel === 'string' && typeof shortfall.date === 'string' &&
    typeof shortfall.demand === 'number' && Number.isSafeInteger(shortfall.demand) &&
    typeof shortfall.supply === 'number' && Number.isSafeInteger(shortfall.supply);
  const offersCurrent = quoteOffersCurrent(editor, observation);
  const mismatch = groups.some((group) => group.arrival !== groups[0]?.arrival || group.departure !== groups[0]?.departure);
  const outputState = quoteOutputState(snapshot, request.id);
  const artifactPath = outputState.path;
  const artifactsValue = effectiveAt(snapshot, artifactPath);
  const artifacts = Array.isArray(artifactsValue) ? artifactsValue.map(text) : [];
  const sourceRequest = snapshot.session.draft.proposal.content.requests.find(row => row.id === request.id);
  const sourceOutputs = record(record(sourceRequest?.body).outputIntent).artifacts;
  const isDocument = (item: unknown): item is string => item === 'pdf_quote' || item === 'xlsx_quote';
  const sourceDocuments = Array.isArray(sourceOutputs) ? sourceOutputs.filter(isDocument) : [];
  const selectedDocuments = artifacts.filter(isDocument);
  const overrideDocuments = outputState.overrides.flatMap(([path, override]) => {
    if (override.state !== 'set') return [];
    let value = override.value;
    if (artifactPath.startsWith(`${path}/`)) {
      for (const part of artifactPath.slice(path.length + 1).split('/').map(decodeURIComponent)) {
        value = Array.isArray(value) ? (/^\d+$/.test(part) ? value[Number(part)] : value.find(row => record(row).id === part)) : record(value)[part];
      }
    }
    return (Array.isArray(value) ? value : [value]).filter(isDocument);
  });
  const needsTextOutput = !outputState.textOnly;
  const requestedDocuments = [...new Set([...sourceDocuments, ...selectedDocuments, ...(needsTextOutput ? overrideDocuments : [])])];
  const earlierDocuments = needsTextOutput ? [] : [...new Set(overrideDocuments.filter(item => !requestedDocuments.includes(item)))];
  const unpreservedDocuments = needsTextOutput ? requestedDocuments.filter(item => !sourceDocuments.includes(item)) : [];
  const acknowledgementKey = outputState.fingerprint;
  const documentIssues = snapshot.session.draft.proposal.issues.filter(issue =>
    issue.kind === 'quote_document_manual' && issue.path === artifactPath);
  const provisional = valueAt(snapshot, `${bodyPath}/provisionalBookingRequested`);
  return <div className={`${styles.editor} ${styles.compactQuote}`}>
    <Section title="Stay and rooms">
      {groups.length ? <>
        <div className={styles.twoCol}><SharedDate editor={editor} groups={groups} bodyPath={bodyPath} field="arrival" label="Arrival" />
          <SharedDate editor={editor} groups={groups} bodyPath={bodyPath} field="departure" label="Departure" /></div>
        {mismatch && <p className={styles.notice}>This quote contains more than one date pair. Use separate quote actions, or set common dates for all groups.</p>}
      </> : <p className={styles.notice}>Add a room group to start a manual quote.</p>}
      {hasShortfall && <p className={styles.notice}>{'Earlier pricing shortage; refresh selected criteria'}: {text(shortfall.roomLabel)} ({text(shortfall.roomCode)}) · {text(shortfall.date)} · {String(shortfall.demand)} requested, {String(shortfall.supply)} available.</p>}
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
            <ChildAges editor={editor} path={`${groupPath}/occupancy`} /></div>
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
    </Section>
    <MoneyRequests editor={editor} bodyPath={bodyPath} groups={groups} rows={rows} />
    <PreparedReview editor={editor} />
    <Section title="Contact and outputs">
      <Field label="Attention" path={`${bodyPath}/client/attention`} editor={editor} compact />
      <Field label="Email recipient" path={`${bodyPath}/client/email`} editor={editor} type="email" compact />
      <Field label="Telephone" path={`${bodyPath}/client/telephone`} editor={editor} type="tel" compact />
      <Field label="Quote note" path={`${bodyPath}/notes`} editor={editor} type="textarea" compact />
      <p className={styles.note}>Output · Unsent email reply, text only</p>
      {requestedDocuments.length > 0 && <p className={styles.notice}>
        This draft includes {requestedDocuments.map(item => item === 'pdf_quote' ? 'PDF' : 'Excel').join(' and ')}.
        Create and attach those documents separately; this pane prepares the text reply.
      </p>}
      {earlierDocuments.length > 0 && <p className={styles.notice}>
        Earlier quote settings include {earlierDocuments.map(item => item === 'pdf_quote' ? 'PDF' : 'Excel').join(' and ')}.
        Check whether those documents still need separate handling.
      </p>}
      {documentIssues.map((issue, index) => <p className={styles.notice} key={`${issue.path}-${index}`}>{issue.explanation}</p>)}
      {unpreservedDocuments.length > 0 && <label className={styles.documentAcknowledgement}>
        <input type="checkbox" checked={manualDocumentsAck === acknowledgementKey} disabled={view.busy}
          onChange={event => setManualDocumentsAck(event.target.checked ? acknowledgementKey : null)} />
        <span>I recorded the {unpreservedDocuments.map(item => item === 'pdf_quote' ? 'PDF' : 'Excel').join(' and ')} request elsewhere for manual handling.
          It will be removed from this draft when I continue.</span>
      </label>}
      {outputState.blockedAncestor && <p className={styles.notice}>Output settings are unavailable. Undo the change if possible, or ask for support.</p>}
      {needsTextOutput && <button type="button" className={styles.linkButton}
        disabled={view.busy || outputState.blockedAncestor || unpreservedDocuments.length > 0 && manualDocumentsAck !== acknowledgementKey}
        onClick={() => { void commands.selectQuoteTextOutput(request.id, acknowledgementKey).catch(() => {}); }}>
        {requestedDocuments.length ? 'Continue with text reply; handle documents separately' : 'Use text reply'}
      </button>}
      <p className={styles.note}>Generate the quote, then save the reply as an unsent draft. A provisional booking needs a separate Create action.</p>
      {provisional !== false && <div className={styles.notice}>This request has not been confirmed as quote-only.
        <button type="button" className={styles.linkButton} onClick={() => void commands.edit(`${bodyPath}/provisionalBookingRequested`, false)}>Continue with quote only</button>
      </div>}
    </Section>
  </div>;
}
