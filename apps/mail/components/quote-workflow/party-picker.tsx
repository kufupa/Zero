import {
  partyChipText,
  partyNoCandidateNote,
  type PartyCandidate,
  type PartyFinder,
} from '../../lib/quote-workflow/party-lookup';
import type { StaffQuoteParty } from '../../lib/quote-workflow/types';
import { useState } from 'react';

export const PARTY_PICKER_HINT =
  'Pick the exact company or agency so Luna can get their rate. Takes about 30 seconds.';

type PickerState =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'listed'; candidates: PartyCandidate[] }
  | { status: 'none'; note: string };

/**
 * Find in HMS next to a Company or Agency field. Staff pick one candidate; the pick then shows as a chip with Clear.
 * `party` is the quote's picked party, shown only when it is of this picker's kind.
 */
export function PartyPicker({
  kind,
  name,
  party,
  find,
  onPick,
  onClear,
}: {
  kind: StaffQuoteParty['kind'];
  name: string;
  party: StaffQuoteParty | undefined;
  find: PartyFinder;
  onPick: (party: StaffQuoteParty) => void;
  onClear: () => void;
}) {
  const [state, setState] = useState<PickerState>({ status: 'idle' });
  const chosen = party && party.kind === kind ? party : null;

  if (chosen) {
    return (
      <div className="flex items-center gap-2 text-[11.5px] font-semibold text-[#166534]">
        <span>{partyChipText(chosen)}</span>
        <button type="button" className="text-[#0066cc] underline" onClick={onClear}>
          Clear
        </button>
      </div>
    );
  }

  const run = async () => {
    setState({ status: 'busy' });
    try {
      const reply = await find(kind, name.trim());
      setState(
        reply.candidates.length
          ? { status: 'listed', candidates: reply.candidates }
          : { status: 'none', note: partyNoCandidateNote(reply.outcome) },
      );
    } catch {
      setState({ status: 'none', note: partyNoCandidateNote('execution_failure') });
    }
  };

  return (
    <div className="flex flex-col gap-1 text-[11px] text-[#64748b]">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-xs border border-[#cbd5e1] bg-white px-2 py-0.5 text-[11.5px] font-semibold text-[#1e293b] disabled:opacity-50"
          disabled={!name.trim() || state.status === 'busy'}
          onClick={() => void run()}
        >
          Find in HMS
        </button>
        <span>{PARTY_PICKER_HINT}</span>
      </div>
      {state.status === 'busy' ? (
        <p role="status">Searching HMS. This takes about 30 seconds.</p>
      ) : null}
      {state.status === 'none' ? <p role="status">{state.note}</p> : null}
      {state.status === 'listed' ? (
        <ul
          className="flex flex-col gap-1"
          aria-label={`${kind === 'agency' ? 'Agencies' : 'Companies'} found in HMS`}
        >
          {state.candidates.map((candidate) => (
            <li key={`${candidate.kind}:${candidate.nativeId}`}>
              <button
                type="button"
                className="text-left text-[11.5px] font-semibold text-[#0066cc] underline"
                onClick={() => {
                  onPick({ kind, nativeId: candidate.nativeId, name: candidate.displayName });
                  setState({ status: 'idle' });
                }}
              >
                {candidate.displayName}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
