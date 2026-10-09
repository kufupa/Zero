import {
  PARTY_TRUNCATED_NOTE,
  partyChipText,
  partyFromSuggestion,
  partyKindLabel,
  partyNoCandidateNote,
  type PartyCandidate,
  type PartyFinder,
  type PartyFindReply,
  type PartySuggestion,
} from '../../lib/quote-workflow/party-lookup';
import type { StaffQuoteParties, StaffQuoteParty } from '../../lib/quote-workflow/types';
import { useEffect, useRef, useState } from 'react';

export const PARTY_PICKER_HINT =
  'Pick the exact company or agency so Nava can get their rate. Takes about a minute.';

export const PARTY_PICKER_BUSY = 'Searching HMS for companies and agencies. This takes about a minute.';

export const PARTY_SUGGESTION_HINT = 'Suggested from this email. Staff confirm before any rate is used.';

// Every state names the query it belongs to, so a result for one name never shows for another.
type PickerState =
  | { status: 'idle' }
  | { status: 'busy'; query: string }
  | { status: 'listed'; query: string; results: PartyCandidate[]; truncated: boolean }
  | { status: 'none'; query: string; note: string };

const IDLE: PickerState = { status: 'idle' };

/**
 * Find in HMS for the quote's company and agency. One search covers both kinds, and each result shows its kind. Staff
 * pick one; a pick shows as a chip with Clear, and both kinds may be picked. Suggestions from the email are offered for
 * staff to confirm. Only a suggestion HMS listed can be picked. An unverified one can only be searched.
 */
export function PartyPicker({
  name,
  parties,
  find,
  onPick,
  onClear,
  suggestions = [],
  onSearchName,
}: {
  /** The text to search for: the quote's company or agency name. */
  name: string;
  /** What is picked so far: at most one company and one agency. */
  parties: StaffQuoteParties;
  find: PartyFinder;
  onPick: (party: StaffQuoteParty) => void;
  onClear: (kind: StaffQuoteParty['kind']) => void;
  suggestions?: PartySuggestion[];
  /** Puts an unverified suggestion's name in the matching field, so staff can search it in HMS. */
  onSearchName?: (name: string, kind: StaffQuoteParty['kind']) => void;
}) {
  const query = name.trim();
  const [state, setState] = useState<PickerState>(IDLE);
  // Each search takes the next number, and only the latest number may write a reply. A name change takes one too,
  // so a reply still in flight for the old name is dropped.
  const latest = useRef(0);

  useEffect(() => {
    latest.current += 1;
    setState(IDLE);
  }, [query]);

  // Results count only for the name typed now. A name change has already cleared them; this covers the render before
  // the effect runs.
  const shown: PickerState = state.status !== 'idle' && state.query === query ? state : IDLE;

  const run = async () => {
    const token = ++latest.current;
    setState({ status: 'busy', query });
    try {
      const reply: PartyFindReply = await find(query);
      if (token !== latest.current) return;
      if (reply.results.length) {
        setState({ status: 'listed', query, results: reply.results, truncated: reply.truncated });
        return;
      }
      setState({
        status: 'none',
        query,
        note: reply.truncated ? PARTY_TRUNCATED_NOTE : partyNoCandidateNote(reply.outcome),
      });
    } catch {
      if (token !== latest.current) return;
      setState({ status: 'none', query, note: partyNoCandidateNote('execution_failure') });
    }
  };

  const picked = [parties.company, parties.agency].filter((party): party is StaffQuoteParty => Boolean(party));
  const pickedKinds = new Set(picked.map((party) => party.kind));
  const offered = suggestions.filter((suggestion) => !pickedKinds.has(suggestion.kind));

  return (
    <div className="flex flex-col gap-1 text-[11px] text-[#64748b]">
      {picked.map((party) => (
        <div key={party.kind} className="flex items-center gap-2 text-[11.5px] font-semibold text-[#166534]">
          <span>{partyChipText(party)}</span>
          <span className="text-[10.5px] font-normal text-[#64748b]">{partyKindLabel(party.kind)}</span>
          <button type="button" className="text-[#0066cc] underline" onClick={() => onClear(party.kind)}>
            Clear
          </button>
        </div>
      ))}
      {offered.length ? (
        <div className="flex flex-col gap-1" aria-label="Suggested from this email">
          <p>{PARTY_SUGGESTION_HINT}</p>
          {offered.map((suggestion) => {
            const party = partyFromSuggestion(suggestion);
            return party ? (
              <div key={`${suggestion.source}:${suggestion.kind}:${suggestion.name}`} className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-left text-[11.5px] font-semibold text-[#0066cc] underline"
                  onClick={() => onPick(party)}
                >
                  {`Use ${suggestion.name}`}
                </button>
                <span className="text-[10.5px]">{partyKindLabel(suggestion.kind)}</span>
              </div>
            ) : (
              <div key={`${suggestion.source}:${suggestion.kind}:${suggestion.name}`} className="flex items-center gap-2">
                <span>{`${suggestion.name} (${partyKindLabel(suggestion.kind)}), not confirmed in HMS`}</span>
                <button
                  type="button"
                  className="rounded-xs border border-[#cbd5e1] bg-white px-2 py-0.5 text-[11.5px] font-semibold text-[#1e293b] disabled:opacity-50"
                  disabled={!onSearchName}
                  onClick={() => onSearchName?.(suggestion.name, suggestion.kind)}
                >
                  Search HMS for this name
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-xs border border-[#cbd5e1] bg-white px-2 py-0.5 text-[11.5px] font-semibold text-[#1e293b] disabled:opacity-50"
          disabled={!query || shown.status === 'busy'}
          onClick={() => void run()}
        >
          Find in HMS
        </button>
        <span>{PARTY_PICKER_HINT}</span>
      </div>
      {shown.status === 'busy' ? <p role="status">{PARTY_PICKER_BUSY}</p> : null}
      {shown.status === 'none' ? <p role="status">{shown.note}</p> : null}
      {shown.status === 'listed' ? (
        <>
          <ul className="flex flex-col gap-1" aria-label="Companies and agencies found in HMS">
            {shown.results.map((candidate) => (
              <li key={`${candidate.kind}:${candidate.nativeId}`} className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-left text-[11.5px] font-semibold text-[#0066cc] underline"
                  onClick={() => {
                    onPick({
                      kind: candidate.kind,
                      nativeId: candidate.nativeId,
                      name: candidate.name,
                    });
                    setState(IDLE);
                  }}
                >
                  {candidate.name}
                </button>
                <span className="text-[10.5px] text-[#64748b]">{partyKindLabel(candidate.kind)}</span>
              </li>
            ))}
          </ul>
          {shown.truncated ? <p role="status">{PARTY_TRUNCATED_NOTE}</p> : null}
        </>
      ) : null}
    </div>
  );
}
