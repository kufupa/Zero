import {
  PARTY_TRUNCATED_NOTE,
  partyChipText,
  partyFromSuggestion,
  partyIndexHeading,
  partyKindLabel,
  partyNoCandidateNote,
  partyNoKindNote,
  type PartyCandidate,
  type PartyFinder,
  type PartyFindReply,
  type PartyIndexReply,
  type PartyIndexSearcher,
  type PartySuggestion,
} from '../../lib/quote-workflow/party-lookup';
import type { StaffQuoteParties, StaffQuoteParty } from '../../lib/quote-workflow/types';
import { useEffect, useRef, useState } from 'react';

export const PARTY_PICKER_HINT =
  'Pick the exact company or agency so Nava can get their rate. Takes about a minute.';

export const PARTY_PICKER_BUSY = 'Searching HMS for companies and agencies. This takes about a minute.';

export const PARTY_SUGGESTION_HINT = 'Suggested from this email. Staff confirm before any rate is used.';

/** How long the typing rests before the HMS list is searched. The list is local, so this only spares the server a call per key. */
export const PARTY_INDEX_DEBOUNCE_MS = 250;

/** Most one-click chips under a field. The listed parties come first, then the list's best matches. */
const PARTY_CHIP_LIMIT = 3;

// Every state names the query it belongs to, so a result for one name never shows for another.
type PickerState =
  | { status: 'idle' }
  | { status: 'busy'; query: string }
  | { status: 'listed'; query: string; results: PartyCandidate[]; truncated: boolean }
  | { status: 'none'; query: string; note: string };

const IDLE: PickerState = { status: 'idle' };

type IndexState = { status: 'idle' } | { status: 'ready'; query: string; reply: PartyIndexReply };
const IDLE_INDEX: IndexState = { status: 'idle' };

/** One candidate per HMS id. The first one seen is kept. */
function uniqueCandidates(candidates: PartyCandidate[]): PartyCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.kind}:${candidate.nativeId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The note for a search that listed nothing in scope. A field with a kind says when HMS matched only the other kind. */
function noCandidateNote(reply: PartyFindReply, kind: StaffQuoteParty['kind'] | undefined): string {
  if (reply.truncated) return PARTY_TRUNCATED_NOTE;
  if (kind && reply.results.length) return partyNoKindNote(kind);
  return partyNoCandidateNote(reply.outcome);
}

/**
 * Find in HMS for one field of the quote header. A field with a kind (Company or Agency) searches its own text, and
 * shows only that kind: its matches, its pick and its suggestions. Without a kind, one picker covers both kinds and each
 * result shows its kind. The HMS list the sweep wrote is searched as staff type, and its matches are a candidate only:
 * the live search and the quote's own check in HMS are what bind a party. Suggestions from the email are offered for
 * staff to confirm. Only a suggestion HMS listed can be picked. An unverified one can only be searched. The name's
 * listed parties and list matches also show as one-click chips, until a party is picked for the field.
 */
export function PartyPicker({
  name,
  kind,
  parties,
  find,
  onPick,
  onClear,
  suggestions = [],
  onSearchName,
  indexSearch,
}: {
  /** The text to search for: this field's company or agency name. */
  name: string;
  /** The kind this field holds. Omitted, the picker covers both kinds. */
  kind?: StaffQuoteParty['kind'];
  /** What is picked so far: at most one company and one agency. */
  parties: StaffQuoteParties;
  find: PartyFinder;
  onPick: (party: StaffQuoteParty) => void;
  onClear: (kind: StaffQuoteParty['kind']) => void;
  suggestions?: PartySuggestion[];
  /** Puts an unverified suggestion's name in the matching field, so staff can search it in HMS. */
  onSearchName?: (name: string, kind: StaffQuoteParty['kind']) => void;
  /** The HMS list the sweep wrote, searched locally while staff type. Null or absent keeps only the live search. */
  indexSearch?: PartyIndexSearcher | null;
}) {
  const query = name.trim();
  const [state, setState] = useState<PickerState>(IDLE);
  const [index, setIndex] = useState<IndexState>(IDLE_INDEX);
  const indexToken = useRef(0);
  // Each search takes the next number, and only the latest number may write a reply. A name change takes one too,
  // so a reply still in flight for the old name is dropped.
  const latest = useRef(0);
  // A field that already holds its pick asks the list nothing more, and shows no chips.
  const pickedHere = Boolean(kind ? parties[kind] : parties.company || parties.agency);

  useEffect(() => {
    latest.current += 1;
    setState(IDLE);
  }, [query]);

  // Each typed name asks the local list once it rests. A reply for a name that has since changed is dropped.
  useEffect(() => {
    const token = ++indexToken.current;
    setIndex(IDLE_INDEX);
    if (!indexSearch || !query || pickedHere) return;
    const timer = setTimeout(() => {
      indexSearch(query)
        .then((reply) => {
          if (token === indexToken.current) setIndex({ status: 'ready', query, reply });
        })
        .catch(() => {
          if (token === indexToken.current) setIndex(IDLE_INDEX);
        });
    }, PARTY_INDEX_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, indexSearch, pickedHere]);

  // Results count only for the name typed now. A name change has already cleared them; this covers the render before
  // the effect runs.
  const shown: PickerState = state.status !== 'idle' && state.query === query ? state : IDLE;
  const indexReply: PartyIndexReply | null = index.status === 'ready' && index.query === query ? index.reply : null;
  // The list's own matches need the list file. The listed parties above do not.
  const indexMatches: PartyIndexReply | null = indexReply?.available ? indexReply : null;

  // With a kind, only that kind is in scope. Without one, every kind is.
  const inScope = (party: { kind: StaffQuoteParty['kind'] }) => !kind || party.kind === kind;
  const indexResults = (indexMatches?.results ?? []).filter(inScope);

  const run = async () => {
    const token = ++latest.current;
    setState({ status: 'busy', query });
    try {
      const reply: PartyFindReply = await find(query);
      if (token !== latest.current) return;
      const results = reply.results.filter(inScope);
      if (results.length) {
        setState({ status: 'listed', query, results, truncated: reply.truncated });
        return;
      }
      setState({ status: 'none', query, note: noCandidateNote(reply, kind) });
    } catch {
      if (token !== latest.current) return;
      setState({ status: 'none', query, note: partyNoCandidateNote('execution_failure') });
    }
  };

  const picked: StaffQuoteParty[] = [];
  for (const party of [parties.company, parties.agency]) if (party && inScope(party)) picked.push(party);
  const pickedKinds = new Set(picked.map((party) => party.kind));
  const offered = suggestions.filter((suggestion) => inScope(suggestion) && !pickedKinds.has(suggestion.kind));
  const chips = pickedHere
    ? []
    : uniqueCandidates([...(indexReply?.listed ?? []), ...(indexReply?.results ?? [])])
        .filter(inScope)
        .slice(0, PARTY_CHIP_LIMIT);

  return (
    <div
      role={kind ? 'group' : undefined}
      aria-label={kind ? `${partyKindLabel(kind)} lookup in HMS` : undefined}
      className="flex flex-col gap-1 text-[11px] text-[#64748b]"
    >
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
      {chips.length ? (
        <div className="flex flex-wrap gap-2">
          {chips.map((candidate) => (
            <button
              key={`${candidate.kind}:${candidate.nativeId}`}
              type="button"
              className="rounded-xs border border-[#0066cc] bg-white px-2 py-0.5 text-[11.5px] font-semibold text-[#0066cc]"
              onClick={() => {
                onPick({ kind: candidate.kind, nativeId: candidate.nativeId, name: candidate.name });
                setState(IDLE);
                setIndex(IDLE_INDEX);
              }}
            >
              {`Use ${candidate.name} (#${candidate.nativeId})`}
            </button>
          ))}
        </div>
      ) : null}
      {indexResults.length ? (
        <section aria-label="Matches from the HMS list" className="flex flex-col gap-1">
          <p className="text-[10.5px] font-semibold text-[#334155]">{partyIndexHeading(indexMatches?.ageMs ?? 0)}</p>
          <ul className="flex flex-col gap-1">
            {indexResults.map((candidate) => (
              <li key={`${candidate.kind}:${candidate.nativeId}`} className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-left text-[11.5px] font-semibold text-[#0066cc] underline"
                  onClick={() => {
                    onPick({ kind: candidate.kind, nativeId: candidate.nativeId, name: candidate.name });
                    setIndex(IDLE_INDEX);
                  }}
                >
                  {candidate.name}
                </button>
                <span className="text-[10.5px] text-[#64748b]">{partyKindLabel(candidate.kind)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-xs border border-[#cbd5e1] bg-white px-2 py-0.5 text-[11.5px] font-semibold text-[#1e293b] disabled:opacity-50"
          disabled={!query || shown.status === 'busy'}
          onClick={() => void run()}
        >
          Search HMS now
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
