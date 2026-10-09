import {
  PARTY_TRUNCATED_NOTE,
  partyChipText,
  partyKindLabel,
  partyNoCandidateNote,
  type PartyCandidate,
  type PartyFinder,
  type PartyFindReply,
} from '../../lib/quote-workflow/party-lookup';
import type { StaffQuoteParty } from '../../lib/quote-workflow/types';
import { useState } from 'react';

export const PARTY_PICKER_HINT =
  'Pick the exact company or agency so Luna can get their rate. Takes about a minute.';

export const PARTY_PICKER_BUSY = 'Searching HMS for companies and agencies. This takes about a minute.';

type PickerState =
  | { status: 'idle' }
  | { status: 'busy' }
  | { status: 'listed'; results: PartyCandidate[]; truncated: boolean }
  | { status: 'none'; note: string };

/**
 * Find in HMS for the quote's company or agency. One search covers both kinds, and each candidate shows its kind.
 * Staff pick one; the pick then shows as a chip with Clear. `party` is the quote's picked party, of either kind.
 */
export function PartyPicker({
  name,
  party,
  find,
  onPick,
  onClear,
}: {
  /** The text to search for: the quote's company or agency name. */
  name: string;
  party: StaffQuoteParty | undefined;
  find: PartyFinder;
  onPick: (party: StaffQuoteParty) => void;
  onClear: () => void;
}) {
  const [state, setState] = useState<PickerState>({ status: 'idle' });

  if (party) {
    return (
      <div className="flex items-center gap-2 text-[11.5px] font-semibold text-[#166534]">
        <span>{partyChipText(party)}</span>
        <button type="button" className="text-[#0066cc] underline" onClick={onClear}>
          Clear
        </button>
      </div>
    );
  }

  const run = async () => {
    setState({ status: 'busy' });
    try {
      const reply: PartyFindReply = await find(name.trim());
      if (reply.results.length) {
        setState({ status: 'listed', results: reply.results, truncated: reply.truncated });
        return;
      }
      setState({
        status: 'none',
        note: reply.truncated ? PARTY_TRUNCATED_NOTE : partyNoCandidateNote(reply.outcome),
      });
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
      {state.status === 'busy' ? <p role="status">{PARTY_PICKER_BUSY}</p> : null}
      {state.status === 'none' ? <p role="status">{state.note}</p> : null}
      {state.status === 'listed' ? (
        <>
          <ul className="flex flex-col gap-1" aria-label="Companies and agencies found in HMS">
            {state.results.map((candidate) => (
              <li
                key={`${candidate.kind}:${candidate.nativeId}`}
                className="flex items-center gap-2"
              >
                <button
                  type="button"
                  className="text-left text-[11.5px] font-semibold text-[#0066cc] underline"
                  onClick={() => {
                    onPick({
                      kind: candidate.kind,
                      nativeId: candidate.nativeId,
                      name: candidate.name,
                    });
                    setState({ status: 'idle' });
                  }}
                >
                  {candidate.name}
                </button>
                <span className="text-[10.5px] text-[#64748b]">{partyKindLabel(candidate.kind)}</span>
              </li>
            ))}
          </ul>
          {state.truncated ? <p role="status">{PARTY_TRUNCATED_NOTE}</p> : null}
        </>
      ) : null}
    </div>
  );
}
