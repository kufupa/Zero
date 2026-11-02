import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { StayRecordWire } from '@/lib/quote-workflow/amend-find';
import {
  amendmentReadbackDifferences, initialSavedStayAmendDraft, savedStayAmendProposal,
  type SavedStayAmendDraft, type SavedStayAmendProposal, type SavedStayAmendResult,
} from '@/lib/quote-workflow/saved-stay-amendment';

const inputClass = 'h-8 min-w-0 w-full rounded-sm border border-[#cbd5e1] bg-white px-2 text-[12px] text-[#1e293b]';
const labelClass = 'text-[10px] font-semibold uppercase tracking-wide text-[#64748b]';
const smallClass = 'text-[11.5px] text-[#64748b]';

type Props = {
  confirmation: string;
  stay: StayRecordWire;
  requestedArrival?: string | null;
  requestedDeparture?: string | null;
  result?: SavedStayAmendResult | null;
  screenshot?: ReactNode;
  onDraftChange?: (input: { proposal: SavedStayAmendProposal | null; errors: string[] }) => void;
};

/** Local request only. Nothing here approves or writes to HMS. */
export function SavedStayAmendEditor(props: Props) {
  return <SavedStayAmendEditorContent key={props.confirmation} {...props} />;
}

function SavedStayAmendEditorContent({ confirmation, stay, requestedArrival, requestedDeparture, result, screenshot, onDraftChange }: Props) {
  const [draft, setDraft] = useState(() => initialSavedStayAmendDraft(stay, {
    arrival: requestedArrival, departure: requestedDeparture,
  }));
  const [touched, setTouched] = useState(false);
  const onDraftRef = useRef(onDraftChange);
  onDraftRef.current = onDraftChange;
  const validation = savedStayAmendProposal(confirmation, stay, draft);
  useEffect(() => {
    onDraftRef.current?.(savedStayAmendProposal(confirmation, stay, draft));
  }, [confirmation, stay, draft]);
  useEffect(() => () => {
    onDraftRef.current?.({ proposal: null, errors: ['The booking selection changed.'] });
  }, []);
  const update = (next: SavedStayAmendDraft) => {
    setTouched(true);
    setDraft(next);
    onDraftRef.current?.(savedStayAmendProposal(confirmation, stay, next));
  };
  const field = (name: 'arrival' | 'departure' | 'adults' | 'children' | 'childAges', value: string) =>
    update({ ...draft, [name]: value });
  const visibleResult = result?.confirmation === confirmation && result.proposal?.confirmation === confirmation ? result : null;
  const readback = visibleResult?.state === 'verified' && visibleResult.screenshotRef ? visibleResult.readback : null;
  const differences = readback && visibleResult ? amendmentReadbackDifferences(visibleResult) : [];
  return (
    <div data-testid="amend-form" className="flex flex-col gap-2 border-t border-[#e2e8f0] pt-2">
      <p className={labelClass}>Requested change</p>
      <p className={smallClass}>These entries stay only while this panel is open and are not saved to HMS. Save the change in HMS for now.</p>
      <div className="grid grid-cols-2 gap-2">
        {(['arrival', 'departure', 'adults', 'children'] as const).map((name) => {
          const title = { arrival: 'Arrival', departure: 'Departure', adults: 'Adults', children: 'Children' }[name];
          const current = stay[name];
          return <label key={name} className="flex min-w-0 flex-col gap-1">
            <span className={labelClass}>{title}</span>
            <span className={smallClass}>HMS now: {current == null || current === '' ? 'Not shown' : String(current)}</span>
            <input aria-label={`Requested ${title.toLowerCase()}`} className={inputClass}
              type={name === 'arrival' || name === 'departure' ? 'date' : 'number'}
              min={name === 'adults' ? 1 : name === 'children' ? 0 : undefined}
              max={name === 'adults' ? 16 : name === 'children' ? 9 : undefined}
              step={name === 'adults' || name === 'children' ? 1 : undefined}
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
      {touched && validation.errors.length ? <ul aria-live="polite" className="text-[11.5px] text-amber-900">
        {validation.errors.map((error) => <li key={error}>{error}</li>)}
      </ul> : null}
      {visibleResult ? <div aria-live="polite" className={smallClass}>
        {readback ? <>
          <p>Last HMS read-back after save</p>
          <p>Dates: {readback.arrival || 'Not shown'} to {readback.departure || 'Not shown'}</p>
          <p>Adults: {readback.adults ?? 'Not shown'} · Children: {readback.children ?? 'Not shown'}</p>
          <p>Child ages: {readback.childAges?.join(', ') || (readback.childAges?.length === 0 ? 'None' : 'Not shown')}</p>
          <p>HMS average rate: {readback.averageRate || 'Not shown'} · HMS grand total: {readback.grandTotal || 'Not shown'}</p>
          {differences.map((difference) => <p key={difference}>{difference}</p>)}
          {screenshot}
        </> : <p>{visibleResult.state === 'not_dispatched' ? 'No change was sent to HMS.' : 'Outcome needs checking in HMS before another attempt.'}</p>}
      </div> : null}
    </div>
  );
}
