import { useEffect, useRef, useState, type ReactNode } from 'react';
import { sendableArrival, type StayRecordWire } from '@/lib/quote-workflow/amend-find';
import {
  amendmentReadbackDifferences, initialSavedStayAmendDraft, savedStayAmendProposal, savedStayAmendReviewBasis,
  type SavedStayAmendDraft, type SavedStayAmendDraftUpdate, type SavedStayAmendEditorIdentity, type SavedStayAmendRequest,
  type SavedStayAmendProposal, type SavedStayAmendResult,
} from '@/lib/quote-workflow/saved-stay-amendment';

const inputClass = 'h-8 min-w-0 w-full rounded-sm border border-[#cbd5e1] bg-white px-2 text-[12px] text-[#1e293b]';
const labelClass = 'text-[10px] font-semibold uppercase tracking-wide text-[#64748b]';
const smallClass = 'text-[11.5px] text-[#64748b]';

type Props = {
  /** Keep one store in the owning workflow, outside any conditionally mounted editor. */
  draftStore: SavedStayAmendDraftStore;
  identity: SavedStayAmendEditorIdentity;
  /** Caller-owned extraction revision, independent of the mail source hash. */
  extractionRevision: string;
  confirmation: string;
  stay: StayRecordWire;
  requestedArrival?: string | null;
  requestedDeparture?: string | null;
  requestedAdults?: number | null;
  requestedChildren?: number | null;
  requestedChildAges?: number[] | null;
  cleared?: SavedStayAmendRequest['cleared'];
  onFieldEdit?: (field: keyof SavedStayAmendDraft, value: string, next: SavedStayAmendDraft) => void;
  result?: SavedStayAmendResult | null;
  /** The current source and the proposal actually submitted, not values copied from the result. */
  resultContext?: {
    source: { threadId: string; messageId: string; mailboxEmail: string; sourceHash: string };
    extractionRevision: string;
    basis: string;
    submittedProposal: SavedStayAmendProposal;
  } | null;
  screenshot?: ReactNode;
  /** Consumer compares identity, extraction revision and basis to its current selection before using an update. */
  onDraftChange?: (input: SavedStayAmendDraftUpdate) => void;
};

function sameProposal(a: SavedStayAmendProposal | null | undefined, b: SavedStayAmendProposal | null | undefined): boolean {
  if (!a || !b || !a.changes || !b.changes || a.confirmation !== b.confirmation) return false;
  const left = a.changes as Record<string, unknown>, right = b.changes as Record<string, unknown>;
  const keys = Object.keys(left).sort(), otherKeys = Object.keys(right).sort();
  return keys.length === otherKeys.length && keys.every((key, index) =>
    key === otherKeys[index] && JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

type DraftField = keyof SavedStayAmendDraft;
type StoredDraft = { draft: SavedStayAmendDraft; touched: DraftField[]; acceptedBasis: string };
export type SavedStayAmendDraftStore = Map<string, StoredDraft>;
export function createSavedStayAmendDraftStore(): SavedStayAmendDraftStore { return new Map(); }
const changedDetails = 'Booking or email details changed. Update untouched entries, then review the request.';

function departureAfterNights(arrival: string, nights: string): string {
  const start = sendableArrival(arrival), count = Number(nights);
  if (!start || !/^\d+$/.test(nights) || !Number.isSafeInteger(count) || count < 1) return '';
  const date = new Date(Date.parse(`${start}T00:00:00Z`) + count * 86400000);
  if (!Number.isFinite(date.getTime())) return '';
  return sendableArrival(date.toISOString().slice(0, 10)) ?? '';
}

function nightsBetween(arrival: string, departure: string): string {
  if (!sendableArrival(arrival) || !sendableArrival(departure)) return '';
  const nights = (Date.parse(`${departure}T00:00:00Z`) - Date.parse(`${arrival}T00:00:00Z`)) / 86400000;
  return Number.isInteger(nights) && nights > 0 ? String(nights) : '';
}

/** Local request only. Nothing here approves or writes to HMS. */
export function SavedStayAmendEditor(props: Props) {
  const drafts = useRef(props.draftStore);
  const onDraftRef = useRef(props.onDraftChange);
  onDraftRef.current = props.onDraftChange;
  const identity = props.identity;
  const parts = [identity?.propertyCode, identity?.threadId, identity?.messageId, identity?.mailboxEmail,
    identity?.sourceHash, props.confirmation];
  const validIdentity = props.draftStore instanceof Map && drafts.current === props.draftStore &&
    [...parts, props.extractionRevision].every((part) => typeof part === 'string' && part.trim() !== '');
  useEffect(() => {
    if (!validIdentity) onDraftRef.current?.({ identity, confirmation: props.confirmation,
      extractionRevision: props.extractionRevision, basis: null, proposal: null,
      errors: ['Select the property, email, booking and current request first.'] });
  }, [validIdentity, identity?.propertyCode, identity?.threadId, identity?.messageId, identity?.mailboxEmail,
    identity?.sourceHash, props.confirmation, props.extractionRevision, props.draftStore]);
  if (!validIdentity) return <p aria-live="polite" className={smallClass}>Select the property, email, booking and current request first.</p>;
  const key = JSON.stringify(parts);
  return <SavedStayAmendEditorContent key={key} {...props} storedDraft={drafts.current.get(key)}
    storeDraft={(value) => drafts.current.set(key, { ...value, draft: { ...value.draft }, touched: [...value.touched] })} />;
}

function SavedStayAmendEditorContent({ identity, extractionRevision, confirmation, stay, requestedArrival, requestedDeparture,
  requestedAdults, requestedChildren, requestedChildAges, cleared, result, resultContext,
  screenshot, onDraftChange, onFieldEdit, storedDraft, storeDraft }: Props & {
    storedDraft?: StoredDraft; storeDraft: (draft: StoredDraft) => void;
  }) {
  const request = { arrival: requestedArrival, departure: requestedDeparture,
    adults: requestedAdults, children: requestedChildren, childAges: requestedChildAges, cleared };
  const basis = savedStayAmendReviewBasis(stay, request, extractionRevision);
  const [draft, setDraft] = useState(() => storedDraft ? { ...storedDraft.draft } : initialSavedStayAmendDraft(stay, request));
  const [touched, setTouched] = useState<DraftField[]>(() => storedDraft?.touched ?? []);
  const [acceptedBasis, setAcceptedBasis] = useState(() => storedDraft?.acceptedBasis ?? basis);
  const needsReview = basis !== acceptedBasis;
  const onDraftRef = useRef(onDraftChange);
  onDraftRef.current = onDraftChange;
  const currentBasis = useRef({ basis, extractionRevision });
  currentBasis.current = { basis, extractionRevision };
  const binding = useRef({ identity: { ...identity }, confirmation }).current;
  const validation = needsReview ? { proposal: null, errors: [changedDetails] } : savedStayAmendProposal(confirmation, stay, draft);
  useEffect(() => {
    onDraftRef.current?.({ identity: { ...binding.identity }, confirmation: binding.confirmation, extractionRevision, basis,
      ...(basis !== acceptedBasis ? { proposal: null, errors: [changedDetails] } : savedStayAmendProposal(confirmation, stay, draft)) });
  }, [binding, basis, acceptedBasis, draft]);
  useEffect(() => () => {
    onDraftRef.current?.({ identity: { ...binding.identity }, confirmation: binding.confirmation,
      ...currentBasis.current, proposal: null, errors: ['The booking selection changed.'] });
  }, [binding]);
  const field = (name: DraftField, value: string) => {
    const next = { ...draft, [name]: value };
    if (name === 'nights') next.departure = departureAfterNights(next.arrival, value);
    else if (name === 'arrival' || name === 'departure') next.nights = nightsBetween(next.arrival, next.departure);
    // The last date or night edit determines the other value when a new email is rebased.
    const nextTouched = touched.filter((field) => name === 'nights' ? field !== 'departure'
      : name === 'arrival' || name === 'departure' ? field !== 'nights' : true);
    if (name === 'arrival' && touched.includes('nights') && !nextTouched.includes('departure')) nextTouched.push('departure');
    if (!nextTouched.includes(name)) nextTouched.push(name);
    setTouched(nextTouched);
    setDraft(next);
    storeDraft({ draft: next, touched: nextTouched, acceptedBasis });
    onFieldEdit?.(name, value, next);
    onDraftRef.current?.({ identity: { ...binding.identity }, confirmation: binding.confirmation, extractionRevision, basis,
      ...(needsReview ? { proposal: null, errors: [changedDetails] } : savedStayAmendProposal(confirmation, stay, next)) });
  };
  const updateUntouched = () => {
    const next = initialSavedStayAmendDraft(stay, request);
    for (const name of touched) next[name] = draft[name];
    if (touched.includes('nights')) next.departure = departureAfterNights(next.arrival, next.nights);
    else if (touched.includes('arrival') || touched.includes('departure')) next.nights = nightsBetween(next.arrival, next.departure);
    setDraft(next);
    setAcceptedBasis(basis);
    storeDraft({ draft: next, touched, acceptedBasis: basis });
    onDraftRef.current?.({ identity: { ...binding.identity }, confirmation: binding.confirmation, extractionRevision, basis,
      ...savedStayAmendProposal(confirmation, stay, next) });
  };
  const sourceMatches = !!result && !!resultContext && result.propertyCode === identity.propertyCode &&
    typeof result.extractionRevision === 'string' && result.extractionRevision.trim() !== '' &&
    typeof result.basis === 'string' && result.basis !== '' &&
    result.extractionRevision === resultContext.extractionRevision && result.basis === resultContext.basis &&
    (['threadId', 'messageId', 'mailboxEmail', 'sourceHash'] as const)
      .every((key) => resultContext.source[key] === identity[key] && result[key] === identity[key]);
  const visibleResult = sourceMatches && result?.confirmation === confirmation &&
    sameProposal(result.proposal, resultContext?.submittedProposal) && result.proposal.confirmation === confirmation ? result : null;
  const resultMatchesDraft = visibleResult ? visibleResult.extractionRevision === extractionRevision && visibleResult.basis === basis &&
    sameProposal(visibleResult.proposal, validation.proposal) : false;
  const readback = visibleResult?.state === 'verified' && visibleResult.screenshotRef ? visibleResult.readback : null;
  const differences = readback && visibleResult ? amendmentReadbackDifferences(visibleResult) : [];
  return (
    <div data-testid="amend-form" className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
      <p className={labelClass}>Stay · HMS now → requested</p>
      <p className={smallClass}>Changes are not saved to HMS until Go.</p>
      {needsReview ? <div aria-live="polite" className={smallClass}>
        <p>{changedDetails}</p>
        <button type="button" className="min-h-8 font-semibold text-[#1e40af] underline" onClick={updateUntouched}>Update untouched entries</button>
      </div> : null}
      <div className="grid grid-cols-2 gap-2">
        {(['arrival', 'departure', 'nights', 'adults', 'children'] as const).map((name) => {
          const title = { arrival: 'Arrival', departure: 'Departure', nights: 'Nights', adults: 'Adults', children: 'Children' }[name];
          const current = stay[name];
          return <label key={name} className="flex min-w-0 flex-col gap-1">
            <span className={labelClass}>{title}</span>
            <span className={smallClass}>HMS at lookup: {current == null || current === '' ? 'Not shown' : String(current)}</span>
            <input aria-label={`Requested ${title.toLowerCase()}`} className={inputClass}
              type={name === 'arrival' || name === 'departure' ? 'date' : 'number'}
              min={name === 'adults' || name === 'nights' ? 1 : name === 'children' ? 0 : undefined}
              max={name === 'adults' ? 16 : name === 'children' ? 9 : undefined}
              step={name === 'adults' || name === 'children' || name === 'nights' ? 1 : undefined}
              value={draft[name]} onChange={(event) => field(name, event.target.value)} />
          </label>;
        })}
      </div>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>Requested child ages</span>
        <input className={inputClass} value={draft.childAges} onChange={(event) => field('childAges', event.target.value)}
          placeholder="Ages separated by commas" aria-describedby="amend-child-ages-hint" />
      </label>
      <p id="amend-child-ages-hint" className={smallClass}>HMS child ages not shown. If changing children, enter one age per child.</p>
      {!needsReview && validation.errors.some((error) => error !== 'Choose a change to the booking.') ? <ul aria-live="polite" className="text-[11.5px] text-amber-900">
        {validation.errors.filter((error) => error !== 'Choose a change to the booking.').map((error) => <li key={error}>{error}</li>)}
      </ul> : null}
      {visibleResult ? <div aria-live="polite" className={smallClass}>
        {!resultMatchesDraft ? <p>Previous HMS attempt. Its result describes the submitted change, not the current entries.</p> : null}
        {readback ? <>
          <p>Last HMS read-back after save</p>
          <p>Dates: {readback.arrival || 'Not shown'} to {readback.departure || 'Not shown'}</p>
          <p>Adults: {readback.adults ?? 'Not shown'} · Children: {readback.children ?? 'Not shown'}</p>
          <p>Child ages: {readback.childAges?.join(', ') || (readback.childAges?.length === 0 ? 'None' : 'Not shown')}</p>
          <p>HMS average rate: {readback.averageRate || 'Not shown'} · HMS grand total: {readback.grandTotal || 'Not shown'}</p>
          {differences.map((difference) => <p key={difference}>{difference}</p>)}
          {screenshot}
        </> : <p>{visibleResult.state === 'not_dispatched' ? 'No change was sent to HMS.' : 'The HMS outcome is not confirmed. Do not make another change to this booking until Nava confirms the booking and previous session are safe.'}</p>}
      </div> : null}
    </div>
  );
}
