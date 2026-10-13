import {
  PARTY_TRUNCATED_NOTE,
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
import {
  isSettled,
  type HmsJobTransport,
  type HmsJobView,
} from '../../lib/quote-workflow/amend-find';
import type { StaffQuoteParties, StaffQuoteParty } from '../../lib/quote-workflow/types';
import { LinkButton, Notice, SecondaryButton } from '../nava-pane/pane-ui';
import { useHmsJob } from '../../lib/quote-workflow/use-hms-job';
import { useEffect, useReducer, useRef, useState } from 'react';
import { HmsAsOf, HmsJobStatusLine, HmsLookupProgress } from './hms-queue-status';

export const PARTY_PICKER_HINT = 'Runs in the background. You can keep working.';

export const PARTY_PICKER_BUSY = 'Searching HMS for companies and agencies.';

export const PARTY_SUGGESTION_HINT =
  'Suggested from this email. Staff confirm before any rate is used.';
const PARTY_PREFETCH_HINT = 'Suggested match from HMS. Confirm before any rate is used.';

/** How long the typing rests before the HMS list is searched. The list is local, so this only spares the server a call per key. */
export const PARTY_INDEX_DEBOUNCE_MS = 250;

/**
 * How long the typing rests before Nava searches HMS by itself. Each search is a browser run of about 20 seconds, so a
 * name still being typed must not start one.
 */
export const PARTY_AUTO_LOOKUP_DEBOUNCE_MS = 600;

/** An automatic search needs at least this many characters. */
const AUTO_LOOKUP_MIN_CHARS = 3;
const MANUAL_LOOKUP_MIN_CHARS = 2;

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

const PARTY_JOB_OUTCOMES = new Set<PartyFindReply['outcome']>([
  'resolved',
  'ambiguous',
  'no_match',
  'input_gap',
  'execution_failure',
  'external_system_unavailable',
  'refused_flag_off',
  'refused_input_invalid',
  'refused_lock_unavailable',
  'refused_lock_busy',
]);

function isPartyJobOutcome(value: unknown): value is PartyFindReply['outcome'] {
  return typeof value === 'string' && PARTY_JOB_OUTCOMES.has(value as PartyFindReply['outcome']);
}

function isPartyCandidate(value: unknown): value is PartyCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.kind === 'company' || candidate.kind === 'agency') &&
    typeof candidate.nativeId === 'string' &&
    candidate.nativeId.trim().length > 0 &&
    typeof candidate.name === 'string' &&
    candidate.name.trim().length > 0
  );
}

function partyCandidatesFrom(value: unknown): PartyCandidate[] | null {
  return Array.isArray(value) && value.every(isPartyCandidate) ? value : null;
}

/** The same normalisation as the server's matchKey, so "Foschini (Pty) Ltd" and "foschini pty ltd" share one search. */
function searchKey(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The memo entry for a key. */
function startAutoSearch(key: string, start: () => Promise<PartyFindReply>): AutoEntry {
  const known = autoMemo.get(key);
  if (known) return known;
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

function sameJobName(left: string, right: string): boolean {
  const normalize = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  return normalize(left) === normalize(right);
}

/** The stored read receipt is the same party-search reply the inline route returns. */
function partyReplyFromJob(
  view: HmsJobView | null,
  name: string,
  kind?: StaffQuoteParty['kind'],
): PartyFindReply | null {
  if (!view || view.request?.kind !== 'party' || (name && !sameJobName(view.request.name, name)))
    return null;
  if (kind && view.request.partyKind !== kind) return null;
  if (view.status === 'failed' || view.status === 'retrying') {
    const outcome =
      view.outcome ??
      (view.failureClass === 'HMS_LOCK_BUSY'
        ? 'refused_lock_busy'
        : view.failureClass === 'TRANSIENT_NETWORK'
          ? 'execution_failure'
          : null);
    return isPartyJobOutcome(outcome)
      ? {
          outcome,
          results: [],
          truncated: false,
          best: null,
          searchedFor: null,
        }
      : null;
  }
  if (view.status !== 'done' || !view.result) return null;
  const result = view.result;
  const best = result.best;
  const results = partyCandidatesFrom(result.results);
  const truncated = result.truncated === undefined ? false : result.truncated;
  const searchedFor = result.searchedFor ?? null;
  if (
    !isPartyJobOutcome(result.outcome) ||
    !results ||
    typeof truncated !== 'boolean' ||
    (searchedFor !== null && typeof searchedFor !== 'string')
  ) {
    return FAILED_REPLY;
  }
  let bestRow: PartyCandidate | null = null;
  if (best !== null && best !== undefined) {
    if (
      !isPartyCandidate(best) ||
      !results.some((row) => row.kind === best.kind && row.nativeId === best.nativeId)
    ) {
      return FAILED_REPLY;
    }
    bestRow = best;
  }
  return {
    outcome: result.outcome,
    results,
    truncated,
    best: bestRow,
    searchedFor,
  };
}

/** The note for a search that listed nothing in scope. A field with a kind says when HMS matched only the other kind. */
function noCandidateNote(
  reply: PartyFindReply,
  kind: StaffQuoteParty['kind'] | undefined,
  name: string,
): string {
  if (reply.truncated) return PARTY_TRUNCATED_NOTE;
  if (kind && reply.results.length) return partyNoKindNote(kind);
  return partyNoCandidateNote(reply.outcome, kind, name);
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
            className="rounded-[3px] border border-[#0066cc] bg-white px-2 py-0.5 text-[12.5px] font-semibold text-[#0066cc] hover:bg-[#eff6ff]"
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
 * other matches show as chips. With no match, or with a failure, the field says so; the one Find in HMS button lets staff
 * retry and see the candidates. Without autoLookup, that button is the only HMS search. The HMS list the sweep wrote is
 * searched as staff type, and its matches are a candidate only. Suggestions from the email are offered for staff to
 * confirm. A suggestion carries no HMS id, so it can only be searched.
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
  jobTransport,
  threadId,
  autoLookup = false,
  onLookupPending,
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
  /** Persisted party jobs, when the mailbox server has the HMS queue routes. */
  jobTransport?: HmsJobTransport | null;
  /** The message thread whose party job is resumed when this field reopens. */
  threadId?: string | null;
  /** Search HMS by itself for this field's name and pick the best match. Needs a kind. Off, the field keeps Find in HMS. */
  autoLookup?: boolean;
  /** Told whether this field's automatic search still has to decide its pick. The pane holds a rates run until it does. */
  onLookupPending?: (pending: boolean) => void;
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
  const autoMemoKey =
    autoLookup && kind && query.length >= AUTO_LOOKUP_MIN_CHARS
      ? `${kind}:${searchKey(query)}`
      : null;
  const autoKey = pickedHere ? null : autoMemoKey;
  const jobResume =
    jobTransport && !pickedHere && (query.length >= MANUAL_LOOKUP_MIN_CHARS || kind)
      ? {
          kind: 'party' as const,
          ...(query ? { name: query } : {}),
          ...(kind ? { partyKind: kind } : {}),
        }
      : null;
  const partyJob = useHmsJob({
    transport: jobTransport ?? null,
    resume: jobResume,
    scope: jobTransport && threadId ? `${threadId}:${kind ?? ''}:${searchKey(query)}` : null,
    autoStartIfMissing: Boolean(
      jobTransport && autoLookup && kind && query.length >= AUTO_LOOKUP_MIN_CHARS && !pickedHere,
    ),
    autoStartDelayMs: PARTY_AUTO_LOOKUP_DEBOUNCE_MS,
  });
  const viewRequest = partyJob.view?.request;
  const currentJobView =
    viewRequest?.kind === 'party' &&
    (!query || sameJobName(viewRequest.name, query)) &&
    (!kind || viewRequest.partyKind === kind)
      ? partyJob.view
      : null;
  const jobReply = partyReplyFromJob(currentJobView, query, kind);
  const autoReply = jobTransport
    ? jobReply
    : autoMemoKey
      ? (autoMemo.get(autoMemoKey)?.reply ?? null)
      : null;
  // A prefetched best match still needs one explicit confirmation before rates can use it.
  const lookupPending =
    Boolean(jobTransport && currentJobView?.prefetch && jobReply?.best && !pickedHere) ||
    (Boolean(autoKey) &&
      (jobTransport
        ? !partyJob.readBackSettled ||
          partyJob.queuing ||
          Boolean(currentJobView && !isSettled(currentJobView)) ||
          Boolean(currentJobView?.prefetch && jobReply?.best) ||
          Boolean(
            jobReply?.best && !currentJobView?.prefetch && autoPicked.current?.key !== autoKey,
          )
        : !autoReply || (Boolean(autoReply.best) && autoPicked.current?.key !== autoKey)));

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
    if (!autoKey || !kind || jobTransport) return;
    const searchKind = kind;
    let live = true;
    const timer = setTimeout(() => {
      const entry = startAutoSearch(autoKey, () => find(query, searchKind));
      // A search for this name may have finished while the field showed another name: render its reply now.
      if (entry.reply) rerender();
      else void entry.promise.then(() => live && rerender());
    }, PARTY_AUTO_LOOKUP_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [autoKey, jobTransport]);

  // The best row of an automatic search is picked for the field, once for each search.
  useEffect(() => {
    if (!autoKey || !autoReply?.best) return;
    if (jobTransport && currentJobView?.prefetch) return;
    if (autoPicked.current?.key === autoKey) return;
    const best = autoReply.best;
    autoPicked.current = {
      key: autoKey,
      party: { kind: best.kind, nativeId: best.nativeId, name: best.name },
    };
    onPick({ kind: best.kind, nativeId: best.nativeId, name: best.name });
    rerender();
  }, [autoKey, autoReply, jobTransport, currentJobView?.prefetch]);

  // The pane holds a rates run until this field's search decides its pick. Reported on every render, so a session reset
  // cannot drop it while the search runs. Released when the field unmounts.
  useEffect(() => {
    onLookupPending?.(lookupPending);
  });
  useEffect(() => () => onLookupPending?.(false), []);

  const run = async () => {
    const token = ++latest.current;
    if (jobTransport) {
      setState(IDLE);
      const request = { kind: 'party' as const, name: query, ...(kind ? { partyKind: kind } : {}) };
      partyJob.start(request);
      return;
    }
    setState({ status: 'busy', query });
    try {
      const reply: PartyFindReply = kind ? await find(query, kind) : await find(query);
      if (token !== latest.current) return;
      const results = reply.results.filter(inScope);
      if (results.length) {
        setState({ status: 'listed', query, results, truncated: reply.truncated });
        return;
      }
      setState({ status: 'none', query, note: noCandidateNote(reply, kind, query) });
    } catch {
      if (token !== latest.current) return;
      setState({
        status: 'none',
        query,
        note: partyNoCandidateNote('execution_failure', kind, query),
      });
    }
  };

  // Results count only for the name typed now. A name change has already cleared them; this covers the render before
  // the effect runs.
  const shown: PickerState = state.status !== 'idle' && state.query === query ? state : IDLE;
  const indexReply: PartyIndexReply | null =
    index.status === 'ready' && index.query === query ? index.reply : null;
  // The list's own matches need the list file.
  const indexMatches: PartyIndexReply | null = indexReply?.available ? indexReply : null;

  // With a kind, only that kind is in scope. Without one, every kind is.
  const inScope = (party: { kind: StaffQuoteParty['kind'] }) => !kind || party.kind === kind;
  const indexResults = (indexMatches?.results ?? []).filter(inScope);

  const picked: StaffQuoteParty[] = [];
  for (const party of [parties.company, parties.agency])
    if (party && inScope(party)) picked.push(party);
  const pickedKinds = new Set(picked.map((party) => party.kind));
  const offered = suggestions.filter(
    (suggestion) => inScope(suggestion) && !pickedKinds.has(suggestion.kind),
  );
  const pickedByNava = (party: StaffQuoteParty) => {
    const byNava = autoPicked.current?.party;
    return byNava?.kind === party.kind && byNava.nativeId === party.nativeId;
  };
  // The automatic search's matches, without the row already picked for this field.
  const autoRows = uniqueCandidates(autoReply?.results ?? []).filter(
    (row) => !picked.some((party) => party.kind === row.kind && party.nativeId === row.nativeId),
  );
  const jobResults = uniqueCandidates(jobReply?.results.filter(inScope) ?? []);
  const prefetchedBest =
    !pickedHere && currentJobView?.prefetch && jobReply?.best && inScope(jobReply.best)
      ? jobReply.best
      : null;
  const otherJobResults = jobResults.filter(
    (row) =>
      !prefetchedBest ||
      row.kind !== prefetchedBest.kind ||
      row.nativeId !== prefetchedBest.nativeId,
  );
  // A row staff pick, in this field's search, is theirs: the search does not pick over it.
  const pickRow = (row: PartyCandidate) => {
    if (autoMemoKey) autoPicked.current = { key: autoMemoKey, party: null };
    onPick({ kind: row.kind, nativeId: row.nativeId, name: row.name });
  };
  const showAutoStatus =
    Boolean(autoMemoKey) && !pickedHere && shown.status === 'idle' && !jobTransport;
  const jobFailureOutcome = jobReply?.outcome ?? 'execution_failure';
  const jobName = currentJobView?.request?.kind === 'party' ? currentJobView.request.name : query;
  const jobDisplayName = query || jobName;
  const partyType = kind ? partyKindLabel(kind).toLowerCase() : 'company or agency';
  const jobDetail = `Searching for the ${partyType} in HMS.`;
  const jobReadBackPending = Boolean(
    jobTransport && jobResume && !partyJob.readBackSettled && !partyJob.statusFailed,
  );
  const jobBusy = Boolean(
    partyJob.queuing ||
      (currentJobView && !isSettled(currentJobView)) ||
      (jobResume && !partyJob.readBackSettled),
  );
  const showManualButton = true;

  return (
    <div
      role={kind ? 'group' : undefined}
      aria-label={kind ? `${partyKindLabel(kind)} lookup in HMS` : undefined}
      className="flex flex-col gap-1 text-[12.5px] text-[#64748b]"
    >
      {picked.map((party) => (
        <div
          key={party.kind}
          className="flex flex-wrap items-center gap-2 text-[12.5px] font-semibold text-[#166534]"
        >
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
          {offered.map((suggestion) => (
            <div
              key={`${suggestion.source}:${suggestion.kind}:${suggestion.name}`}
              className="flex items-center gap-2"
            >
              <span>{`${suggestion.name} (${partyKindLabel(suggestion.kind)}), not confirmed in HMS`}</span>
              <button
                type="button"
                className="rounded-xs border border-[#cbd5e1] bg-white px-2 py-0.5 text-[12.5px] font-semibold text-[#1e293b] disabled:opacity-50"
                disabled={!onSearchName}
                onClick={() => onSearchName?.(suggestion.name, suggestion.kind)}
              >
                Search HMS for this name
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {showAutoStatus ? (
        autoReply ? (
          <div className="flex flex-col gap-1">
            {autoReply.results.length ? (
              <ResultChips label="Found in HMS:" rows={autoRows} onPick={pickRow} />
            ) : (
              <Notice
                tone={autoReply.outcome === 'no_match' && !autoReply.truncated ? 'info' : 'warn'}
                role="status"
              >
                {noCandidateNote(autoReply, kind, query)}
              </Notice>
            )}
          </div>
        ) : (
          <HmsLookupProgress
            pending
            detail={`Searching HMS for "${query}" (${kind ? partyKindLabel(kind).toLowerCase() : 'party'})`}
          />
        )
      ) : null}
      {jobReadBackPending ? <p role="status">Checking for a background HMS lookup…</p> : null}
      {jobTransport ? (
        <HmsJobStatusLine
          view={currentJobView}
          queuing={partyJob.queuing}
          detail={jobDetail}
          onRetry={partyJob.retry}
          statusFailed={partyJob.statusFailed}
          queueFailed={partyJob.queueFailed}
          failureMessage={partyNoCandidateNote(jobFailureOutcome, kind, jobDisplayName)}
          failedMessage={partyNoCandidateNote(jobFailureOutcome, kind, jobDisplayName)}
          queueFailureMessage={partyNoCandidateNote('execution_failure', kind, query)}
        />
      ) : null}
      {jobTransport &&
      jobReply &&
      !jobReply.results.length &&
      currentJobView?.status !== 'failed' ? (
        <Notice
          tone={jobReply.outcome === 'no_match' && !jobReply.truncated ? 'info' : 'warn'}
          role="status"
        >
          {noCandidateNote(jobReply, kind, jobDisplayName)}
        </Notice>
      ) : null}
      {prefetchedBest ? (
        <div className="flex flex-col gap-1" aria-label="Suggested match from HMS">
          <p>{PARTY_PREFETCH_HINT}</p>
          <button
            type="button"
            className="w-fit rounded-[3px] border border-[#0066cc] bg-white px-2 py-0.5 text-[12.5px] font-semibold text-[#0066cc] hover:bg-[#eff6ff]"
            aria-label={`Confirm ${prefetchedBest.name}`}
            onClick={() => pickRow(prefetchedBest)}
          >
            {`Confirm ${prefetchedBest.name}`}
          </button>
          <HmsAsOf asOf={currentJobView?.asOf ?? null} />
        </div>
      ) : null}
      {indexResults.length ? (
        <section aria-label="Matches from the HMS list" className="flex flex-col gap-1">
          <p className="text-[10.5px] font-semibold text-[#334155]">
            {partyIndexHeading(indexMatches?.ageMs ?? 0)}
          </p>
          <ul className="flex flex-col gap-1">
            {indexResults.map((candidate) => (
              <li
                key={`${candidate.kind}:${candidate.nativeId}`}
                className="flex items-center gap-2"
              >
                <button
                  type="button"
                  className="text-left text-[12.5px] font-semibold text-[#0066cc] underline"
                  onClick={() => {
                    onPick({
                      kind: candidate.kind,
                      nativeId: candidate.nativeId,
                      name: candidate.name,
                    });
                    setIndex(IDLE_INDEX);
                  }}
                >
                  {candidate.name}
                </button>
                <span className="text-[10.5px] text-[#64748b]">
                  {partyKindLabel(candidate.kind)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {showManualButton ? (
        <div className="flex flex-wrap items-center gap-2">
          <SecondaryButton
            disabled={
              query.length < MANUAL_LOOKUP_MIN_CHARS ||
              shown.status === 'busy' ||
              lookupPending ||
              jobBusy
            }
            onClick={() => void run()}
          >
            Find in HMS
          </SecondaryButton>
          <span>{PARTY_PICKER_HINT}</span>
        </div>
      ) : null}
      {shown.status === 'busy' ? <p role="status">{PARTY_PICKER_BUSY}</p> : null}
      {shown.status === 'none' ? <p role="status">{shown.note}</p> : null}
      {jobTransport && currentJobView?.status === 'done' && jobResults.length && !prefetchedBest ? (
        <>
          <ul className="flex flex-col gap-1" aria-label="Companies and agencies found in HMS">
            {jobResults.map((candidate) => (
              <li
                key={`${candidate.kind}:${candidate.nativeId}`}
                className="flex items-center gap-2"
              >
                <button
                  type="button"
                  className="text-left text-[11.5px] font-semibold text-[#0066cc] underline"
                  onClick={() => pickRow(candidate)}
                >
                  {candidate.name}
                </button>
                <span className="text-[10.5px] text-[#64748b]">
                  {partyKindLabel(candidate.kind)}
                </span>
              </li>
            ))}
          </ul>
          {jobReply?.truncated ? <p role="status">{PARTY_TRUNCATED_NOTE}</p> : null}
          <HmsAsOf asOf={currentJobView?.asOf ?? null} />
        </>
      ) : null}
      {prefetchedBest && otherJobResults.length ? (
        <ResultChips label="Other matches in HMS:" rows={otherJobResults} onPick={pickRow} />
      ) : null}
      {shown.status === 'listed' ? (
        <>
          <ul className="flex flex-col gap-1" aria-label="Companies and agencies found in HMS">
            {shown.results.map((candidate) => (
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
                    setState(IDLE);
                  }}
                >
                  {candidate.name}
                </button>
                <span className="text-[10.5px] text-[#64748b]">
                  {partyKindLabel(candidate.kind)}
                </span>
              </li>
            ))}
          </ul>
          {shown.truncated ? <p role="status">{PARTY_TRUNCATED_NOTE}</p> : null}
        </>
      ) : null}
    </div>
  );
}
