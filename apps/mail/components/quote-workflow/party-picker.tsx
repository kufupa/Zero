import {
  PARTY_TRUNCATED_NOTE,
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
import { LinkButton, Notice, SecondaryButton } from '../nava-pane/pane-ui';
import { useEffect, useReducer, useRef, useState } from 'react';

export const PARTY_PICKER_HINT =
  'Pick the exact company or agency so Nava can get their rate. Takes about a minute.';

export const PARTY_PICKER_BUSY = 'Searching HMS for companies and agencies. This takes about a minute.';

export const PARTY_SUGGESTION_HINT = 'Suggested from this email. Staff confirm before any rate is used.';

/** How long the typing rests before the HMS list is searched. The list is local, so this only spares the server a call per key. */
export const PARTY_INDEX_DEBOUNCE_MS = 250;

/**
 * How long the typing rests before Nava searches HMS by itself. Each search is a browser run of about 20 seconds, so a
 * name still being typed must not start one.
 */
export const PARTY_AUTO_LOOKUP_DEBOUNCE_MS = 600;

/** An automatic search needs at least this many characters. */
const AUTO_LOOKUP_MIN_CHARS = 3;

/** The most HMS rows shown as chips under a field. The server already sends at most this many. */
const CHIP_LIMIT = 5;

// Every state names the query it belongs to, so a result for one name never shows for another.
type PickerState =
  | { status: 'idle' }
  | { status: 'busy'; query: string }
  | { status: 'listed'; query: string; results: PartyCandidate[]; truncated: boolean }
  | { status: 'none'; query: string; note: string };

const IDLE: PickerState = { status: 'idle' };

type IndexState = { status: 'idle' } | { status: 'ready'; query: string; reply: PartyIndexReply };
const IDLE_INDEX: IndexState = { status: 'idle' };

/** One automatic search. Its reply is set once HMS answers. */
type AutoEntry = { reply: PartyFindReply | null; promise: Promise<PartyFindReply> };

// One automatic search per kind and normalised name, for the whole pane session. Re-renders and re-analysis reuse it.
const autoMemo = new Map<string, AutoEntry>();

const FAILED_REPLY: PartyFindReply = {
  outcome: 'execution_failure',
  results: [],
  truncated: false,
  best: null,
  searchedFor: null,
};

/** The same normalisation as the server's matchKey, so "Foschini (Pty) Ltd" and "foschini pty ltd" share one search. */
function searchKey(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The memo entry for a key. A forced start replaces it, which is what Search again does. */
function startAutoSearch(key: string, start: () => Promise<PartyFindReply>, force: boolean): AutoEntry {
  const known = autoMemo.get(key);
  if (known && !force) return known;
  const entry: AutoEntry = { reply: null, promise: Promise.resolve(FAILED_REPLY) };
  entry.promise = new Promise<PartyFindReply>((resolve) => resolve(start())).then(
    (reply) => {
      entry.reply = reply;
      return reply;
    },
    () => {
      entry.reply = FAILED_REPLY;
      return FAILED_REPLY;
    },
  );
  autoMemo.set(key, entry);
  return entry;
}

/** Test seam: forgets every automatic search. */
export function resetPartyAutoLookupForTests(): void {
  autoMemo.clear();
}

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

function ResultChips({
  label,
  rows,
  onPick,
}: {
  label: string;
  rows: readonly PartyCandidate[];
  onPick: (row: PartyCandidate) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[10.5px] font-semibold text-[#334155]">{label}</p>
      <div className="flex flex-wrap gap-2">
        {rows.slice(0, CHIP_LIMIT).map((row) => (
          <button
            key={`${row.kind}:${row.nativeId}`}
            type="button"
            className="rounded-[3px] border border-[#0066cc] bg-white px-2 py-0.5 text-[11.5px] font-semibold text-[#0066cc] hover:bg-[#eff6ff]"
            onClick={() => onPick(row)}
          >
            {`${row.name} (#${row.nativeId})`}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Find in HMS for one field of the quote header. A field with a kind (Company or Agency) searches its own text, and shows
 * only that kind: its pick, its matches and its suggestions. Without a kind, one picker covers both kinds and each result
 * shows its kind.
 *
 * With autoLookup, Nava searches HMS for the field's name by itself, once the typing rests, and picks the best match. The
 * other matches show as chips. With no match, or with a failure, the field says so and offers Search again. Without
 * autoLookup, the field keeps one Find in HMS button. The HMS list the sweep wrote is searched as staff type, and its
 * matches are a candidate only. Suggestions from the email are offered for staff to confirm. Only a suggestion HMS
 * listed can be picked. An unverified one can only be searched.
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
  autoLookup = false,
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
  /** Search HMS by itself for this field's name and pick the best match. Needs a kind. Off, the field keeps Find in HMS. */
  autoLookup?: boolean;
}) {
  const query = name.trim();
  const [state, setState] = useState<PickerState>(IDLE);
  const [index, setIndex] = useState<IndexState>(IDLE_INDEX);
  const indexToken = useRef(0);
  // Each manual search takes the next number, and only the latest number may write a reply. A name change takes one too.
  const latest = useRef(0);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  // The search that last decided this field's pick: the row Nava picked from it, or null when staff picked a row. A search
  // decides once, so a pick made after it is never overwritten by it.
  const autoPicked = useRef<{ key: string; party: StaffQuoteParty | null } | null>(null);
  // A field that already holds its pick asks the list and HMS nothing more.
  const pickedHere = Boolean(kind ? parties[kind] : parties.company || parties.agency);
  const autoMemoKey = autoLookup && kind && query.length >= AUTO_LOOKUP_MIN_CHARS ? `${kind}:${searchKey(query)}` : null;
  const autoKey = pickedHere ? null : autoMemoKey;
  const autoReply = autoMemoKey ? (autoMemo.get(autoMemoKey)?.reply ?? null) : null;

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

  // The automatic search. It starts once the typing rests, and a name's search runs once, however often the pane renders.
  useEffect(() => {
    if (!autoKey || !kind) return;
    const searchKind = kind;
    let live = true;
    const timer = setTimeout(() => {
      const entry = startAutoSearch(autoKey, () => find(query, searchKind), false);
      if (!entry.reply) void entry.promise.then(() => live && rerender());
    }, PARTY_AUTO_LOOKUP_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [autoKey]);

  // The best row of an automatic search is picked for the field, once for each search.
  useEffect(() => {
    if (!autoKey || !autoReply?.best) return;
    if (autoPicked.current?.key === autoKey) return;
    const best = autoReply.best;
    autoPicked.current = { key: autoKey, party: { kind: best.kind, nativeId: best.nativeId, name: best.name } };
    onPick({ kind: best.kind, nativeId: best.nativeId, name: best.name });
  }, [autoKey, autoReply]);

  const searchAgain = () => {
    if (!autoMemoKey || !kind) return;
    autoPicked.current = null;
    const entry = startAutoSearch(autoMemoKey, () => find(query, kind), true);
    rerender();
    void entry.promise.then(() => rerender());
  };

  const run = async () => {
    const token = ++latest.current;
    setState({ status: 'busy', query });
    try {
      const reply: PartyFindReply = kind ? await find(query, kind) : await find(query);
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

  // Results count only for the name typed now. A name change has already cleared them; this covers the render before
  // the effect runs.
  const shown: PickerState = state.status !== 'idle' && state.query === query ? state : IDLE;
  const indexReply: PartyIndexReply | null = index.status === 'ready' && index.query === query ? index.reply : null;
  // The list's own matches need the list file.
  const indexMatches: PartyIndexReply | null = indexReply?.available ? indexReply : null;

  // With a kind, only that kind is in scope. Without one, every kind is.
  const inScope = (party: { kind: StaffQuoteParty['kind'] }) => !kind || party.kind === kind;
  const indexResults = (indexMatches?.results ?? []).filter(inScope);

  const picked: StaffQuoteParty[] = [];
  for (const party of [parties.company, parties.agency]) if (party && inScope(party)) picked.push(party);
  const pickedKinds = new Set(picked.map((party) => party.kind));
  const offered = suggestions.filter((suggestion) => inScope(suggestion) && !pickedKinds.has(suggestion.kind));
  const pickedByNava = (party: StaffQuoteParty) => {
    const byNava = autoPicked.current?.party;
    return byNava?.kind === party.kind && byNava.nativeId === party.nativeId;
  };
  // The automatic search's matches, without the row already picked for this field.
  const autoRows = uniqueCandidates(autoReply?.results ?? []).filter(
    (row) => !picked.some((party) => party.kind === row.kind && party.nativeId === row.nativeId),
  );
  // A row staff pick, in this field's search, is theirs: the search does not pick over it.
  const pickRow = (row: PartyCandidate) => {
    if (autoMemoKey) autoPicked.current = { key: autoMemoKey, party: null };
    onPick({ kind: row.kind, nativeId: row.nativeId, name: row.name });
  };
  const showAutoStatus = Boolean(autoMemoKey) && !pickedHere;
  const showManualButton = !autoLookup || !kind;

  return (
    <div
      role={kind ? 'group' : undefined}
      aria-label={kind ? `${partyKindLabel(kind)} lookup in HMS` : undefined}
      className="flex flex-col gap-1 text-[11px] text-[#64748b]"
    >
      {picked.map((party) => (
        <div key={party.kind} className="flex flex-wrap items-center gap-2 text-[11.5px] font-semibold text-[#166534]">
          <span>{`✓ ${party.name} (#${party.nativeId})${pickedByNava(party) ? ' — picked by Nava' : ''}`}</span>
          <LinkButton onClick={() => onClear(party.kind)}>Change</LinkButton>
        </div>
      ))}
      {Boolean(autoMemoKey) && pickedHere && autoRows.length ? (
        <ResultChips label="Also in HMS:" rows={autoRows} onPick={pickRow} />
      ) : null}
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
      {showAutoStatus ? (
        autoReply ? (
          <div className="flex flex-col gap-1">
            {autoReply.results.length ? (
              <ResultChips label="Found in HMS:" rows={autoRows} onPick={pickRow} />
            ) : (
              <Notice tone={autoReply.outcome === 'no_match' && !autoReply.truncated ? 'info' : 'warn'} role="status">
                {noCandidateNote(autoReply, kind)}
              </Notice>
            )}
            <div>
              <LinkButton onClick={searchAgain}>Search again</LinkButton>
            </div>
          </div>
        ) : (
          <p role="status" className="flex items-center gap-2 text-[11.5px] text-[#0066cc]">
            <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-[#0066cc] border-t-transparent" />
            {`Searching HMS for "${query}"… about 20 seconds`}
          </p>
        )
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
      {showManualButton ? (
        <div className="flex flex-wrap items-center gap-2">
          <SecondaryButton disabled={!query || shown.status === 'busy'} onClick={() => void run()}>
            Find in HMS
          </SecondaryButton>
          <span>{PARTY_PICKER_HINT}</span>
        </div>
      ) : null}
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
