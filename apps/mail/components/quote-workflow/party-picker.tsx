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
import { preconditionFailedMessage, useHmsJob } from '../../lib/quote-workflow/use-hms-job';
import { useEffect, useReducer, useRef, useState } from 'react';
import { HmsAsOf, HmsJobStatusLine, HmsLookupProgress } from './hms-queue-status';

export const PARTY_PICKER_HINT = 'Runs in the background. You can keep working.';

export const PARTY_PICKER_BUSY = 'Searching HMS for companies and agencies.';

const PARTY_PREFETCH_HINT = 'Suggested match from HMS. Confirm before any rate is used.';

/** How long the typing rests before the HMS list is searched. The list is local, so this only spares the server a call per key. */
export const PARTY_INDEX_DEBOUNCE_MS = 250;

/**
 * How long the typing rests before Nava searches HMS by itself. Each search is a browser run of about 20 seconds, so a
 * name still being typed must not start one.
 */
export const PARTY_AUTO_LOOKUP_DEBOUNCE_MS = 600;
export const PARTY_SEARCH_DEADLINE_MS = 4 * 60_000;

/** An automatic search needs at least this many characters. */
const AUTO_LOOKUP_MIN_CHARS = 3;
const MANUAL_LOOKUP_MIN_CHARS = 2;

/** The most HMS rows shown as chips under a field. The server already sends at most this many. */
const CHIP_LIMIT = 5;
const PARTY_RETRY_OPTIONS = { retry: true } as const;

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
  'refused_origin_mismatch',
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

function candidateNameKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

function duplicateCandidateNames(rows: readonly PartyCandidate[]): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = candidateNameKey(row.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

function candidateDetails(row: PartyCandidate): string[] {
  const iata = typeof row.iata === 'string' ? row.iata.trim() : '';
  const address = typeof row.address === 'string' ? row.address.trim() : '';
  const city = typeof row.city === 'string' ? row.city.trim() : '';
  return [iata ? `IATA ${iata}` : null, address || null, city || null].filter(
    (detail): detail is string => detail !== null,
  );
}

function candidatesWithinLimit(
  rows: readonly PartyCandidate[],
  allRows: readonly PartyCandidate[],
): PartyCandidate[] {
  const duplicates = duplicateCandidateNames(allRows);
  return rows.filter(
    (row, index) => index < CHIP_LIMIT || duplicates.has(candidateNameKey(row.name)),
  );
}

function candidateChoiceLabel(
  row: PartyCandidate,
  duplicateNames: ReadonlySet<string>,
  includeNativeId = false,
): string {
  if (!duplicateNames.has(candidateNameKey(row.name))) {
    return includeNativeId ? `${row.name} (#${row.nativeId})` : row.name;
  }
  const details = candidateDetails(row);
  return `${row.name}${details.length ? ` · ${details.join(' · ')}` : ''} (#${row.nativeId})`;
}

function findWithMail(
  find: PartyFinder,
  query: string,
  kind: StaffQuoteParty['kind'] | undefined,
  threadId: string | null | undefined,
  messageId?: string | null,
): Promise<PartyFindReply> {
  const thread = threadId?.trim();
  const selected = messageId?.trim();
  const mail = thread
    ? { threadId: thread, ...(selected ? { messageId: selected } : {}) }
    : undefined;
  return mail ? find(query, kind, mail) : kind ? find(query, kind) : find(query);
}

function sameJobName(left: string, right: string): boolean {
  const normalize = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  return normalize(left) === normalize(right);
}

function partyJobIsV2(view: HmsJobView | null): boolean {
  const result = view?.result;
  return Boolean(
    view?.request?.kind === 'party' &&
      result?.matchVersion === 2 &&
      (result.matchStatus === 'bound' || result.matchStatus === 'needs_pick') &&
      Object.hasOwn(result, 'boundParty') &&
      Array.isArray(result.suggestions),
  );
}

/** The stored read receipt is the same party-search reply the inline route returns. */
function partyReplyFromJob(
  view: HmsJobView | null,
  name: string,
  kind?: StaffQuoteParty['kind'],
): PartyFindReply | null {
  const v2 = partyJobIsV2(view);
  if (!view || view.request?.kind !== 'party' || (!v2 && name && !sameJobName(view.request.name, name)))
    return null;
  if (kind && view.request.partyKind !== kind && !(view.prefetch && !view.request.partyKind)) return null;
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
  allRows = rows,
  onPick,
}: {
  label: string;
  rows: readonly PartyCandidate[];
  allRows?: readonly PartyCandidate[];
  onPick: (row: PartyCandidate) => void;
}) {
  const duplicateNames = duplicateCandidateNames(allRows);
  const visibleRows = candidatesWithinLimit(rows, allRows);
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[10.5px] font-semibold text-[#334155]">{label}</p>
      <div className="flex flex-wrap gap-2">
        {visibleRows.map((row) => (
          <button
            key={`${row.kind}:${row.nativeId}`}
            type="button"
            className="rounded-[3px] border border-[#0066cc] bg-white px-2 py-0.5 text-[12.5px] font-semibold text-[#0066cc] hover:bg-[#eff6ff]"
            onClick={() => onPick(row)}
          >
            {candidateChoiceLabel(row, duplicateNames, true)}
          </button>
        ))}
      </div>
    </div>
  );
}

function PartyAlternatives({
  rows,
  defaultOpen,
  label,
  onPick,
}: {
  rows: readonly PartyCandidate[];
  defaultOpen: boolean;
  label: string;
  onPick: (row: PartyCandidate) => void;
}) {
  return (
    <details open={defaultOpen} className="flex flex-col gap-1">
      <summary className="cursor-pointer text-[10.5px] font-semibold text-[#334155]">
        {`${label} (${rows.length})`}
      </summary>
      <ul aria-label={label} className="flex flex-col gap-1">
        {rows.map((row) => {
          const details = [partyKindLabel(row.kind), ...candidateDetails(row), `#${row.nativeId}`];
          return (
            <li
              key={`${row.kind}:${row.nativeId}`}
              className="flex items-center justify-between gap-2"
            >
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-1">
                <span className="text-[11.5px] font-semibold text-[#334155]">{row.name}</span>
                <span className="text-[10.5px] text-[#64748b]">{details.join(' · ')}</span>
              </div>
              <button
                type="button"
                aria-label={`Use ${row.name} (${partyKindLabel(row.kind)}) (#${row.nativeId})`}
                className="shrink-0 rounded-[3px] border border-[#0066cc] bg-white px-2 py-0.5 text-[11.5px] font-semibold text-[#0066cc] hover:bg-[#eff6ff]"
                onClick={() => onPick(row)}
              >
                Use
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/**
 * Find in HMS for one field of the quote header. A field with a kind (Company or Agency) searches its own text, and shows
 * only that kind: its pick, its matches and its suggestions. Without a kind, one picker covers both kinds and each result
 * shows its kind.
 *
 * With autoLookup and the queue off, Nava searches the field's name inline once typing rests. A match is only offered for
 * staff confirmation. With the queue on, only Find starts a pane job; extraction prefetch may still suggest a best row.
 * The HMS list the sweep wrote is searched as staff type, and its matches are a candidate only. Email suggestions also
 * need a deliberate search and staff confirmation.
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
  sourceMessageId,
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
  /** The selected email whose party prefetch may be resumed. */
  sourceMessageId?: string | null;
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
  // A stored high-confidence V2 binding is applied once per run. Clearing/changing it must not silently reapply it.
  const appliedV2Bindings = useRef(new Set<string>());
  const [v2JobCache, setV2JobCache] = useState<
    { scope: string; query: string; view: HmsJobView } | null
  >(null);
  const seededSuggestion = useRef<string | null>(null);
  const appliedSuggestionPick = useRef(new Set<string>());
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  // A field that already holds its pick asks the list and HMS nothing more.
  const selectedParty = kind ? parties[kind] ?? null : parties.company ?? parties.agency ?? null;
  const pickedHere = Boolean(selectedParty);
  const [queueMode, setQueueMode] = useState<'checking' | 'on' | 'off'>(() =>
    jobTransport?.jobQueueEnabled ? 'checking' : 'off',
  );
  useEffect(() => {
    const readQueueMode = jobTransport?.jobQueueEnabled;
    if (!readQueueMode) {
      setQueueMode('off');
      return;
    }
    let live = true;
    void readQueueMode().then(
      (enabled) => live && setQueueMode(enabled ? 'on' : 'off'),
      () => live && setQueueMode('on'),
    );
    return () => {
      live = false;
    };
  }, [jobTransport?.jobQueueEnabled]);
  const autoMemoKey =
    autoLookup && (!jobTransport || queueMode === 'off') && kind && query.length >= AUTO_LOOKUP_MIN_CHARS
      ? `${kind}:${searchKey(query)}:${threadId ?? ''}:${sourceMessageId ?? ''}`
      : null;
  const autoKey = pickedHere ? null : autoMemoKey;
  const jobResume =
    jobTransport &&
    sourceMessageId !== null &&
    !pickedHere &&
    (query.length >= MANUAL_LOOKUP_MIN_CHARS || kind)
      ? {
          kind: 'party' as const,
          ...(query && !(autoLookup && queueMode === 'on') ? { name: query } : {}),
          ...(kind ? { partyKind: kind } : {}),
        }
      : null;
  const partyJob = useHmsJob({
    transport: jobTransport ?? null,
    resume: jobResume,
    scope:
      jobTransport && threadId
        ? `${threadId}:${sourceMessageId ?? ''}:${kind ?? ''}:${searchKey(query)}`
        : null,
    deadlineMs: PARTY_SEARCH_DEADLINE_MS,
    retryOptions: PARTY_RETRY_OPTIONS,
  });
  const viewRequest = partyJob.view?.request;
  const v2Prefetch = Boolean(partyJob.view?.prefetch && partyJobIsV2(partyJob.view));
  const sourceMatches =
    !v2Prefetch ||
    sourceMessageId === undefined ||
    (sourceMessageId !== null && partyJob.view?.sourceMessageId === sourceMessageId);
  const currentJobView =
    sourceMatches && viewRequest?.kind === 'party' &&
    (!query || v2Prefetch || sameJobName(viewRequest.name, query)) &&
    (!kind || viewRequest.partyKind === kind || (partyJob.view?.prefetch && !viewRequest.partyKind))
      ? partyJob.view
      : null;
  const v2JobScopeKey = JSON.stringify([
    threadId ?? null,
    sourceMessageId ?? null,
    kind ?? null,
  ]);
  const v2JobQueryKey = searchKey(query);
  const v2CachedJobView =
    !partyJob.queuing &&
    !partyJob.queueFailed &&
    !partyJob.statusFailed &&
    v2JobCache?.scope === v2JobScopeKey &&
    v2JobCache.query === v2JobQueryKey
      ? v2JobCache.view
      : null;
  const v2DisplayJobView = currentJobView
    ? currentJobView.status === 'done' && partyJobIsV2(currentJobView)
      ? currentJobView
      : null
    : v2CachedJobView;
  const jobReply = partyReplyFromJob(currentJobView, query, kind);
  const autoReply = autoMemoKey ? (autoMemo.get(autoMemoKey)?.reply ?? null) : null;
  // Only an explicit, user-started job can hold rates. A prefetch and the typed-name read-back never do.
  const lookupPending =
    Boolean(autoKey && !autoReply) ||
    Boolean(
      !currentJobView?.prefetch &&
        (partyJob.queuing || (currentJobView && !isSettled(currentJobView))),
    );

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

  // Queue-off automatic lookup only. Queue-on typed text never starts a job.
  useEffect(() => {
    if (!autoKey || !kind) return;
    const searchKind = kind;
    let live = true;
    const timer = setTimeout(() => {
      const entry = startAutoSearch(autoKey, () =>
        findWithMail(find, query, searchKind, threadId, sourceMessageId),
      );
      // A search for this name may have finished while the field showed another name: render its reply now.
      if (entry.reply) rerender();
      else void entry.promise.then(() => live && rerender());
    }, PARTY_AUTO_LOOKUP_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [autoKey]);

  // Only an inline queue-off lookup or an explicit non-prefetch job holds the rates step.
  useEffect(() => {
    onLookupPending?.(lookupPending);
  });
  useEffect(() => () => onLookupPending?.(false), []);

  const run = async () => {
    const token = ++latest.current;
    if (jobTransport) {
      setState(IDLE);
      setV2JobCache(null);
      const request = { kind: 'party' as const, name: query, ...(kind ? { partyKind: kind } : {}) };
      partyJob.start(request);
      return;
    }
    setState({ status: 'busy', query });
    try {
      const reply: PartyFindReply = await findWithMail(find, query, kind, threadId, sourceMessageId);
      if (token !== latest.current) return;
      const results = reply.results.filter(inScope);
      if (results.length) {
        setState({ status: 'listed', query, results, truncated: reply.truncated });
        return;
      }
      setState({ status: 'none', query, note: noCandidateNote(reply, kind, query) });
    } catch (error) {
      if (token !== latest.current) return;
      setState({
        status: 'none',
        query,
        note:
          preconditionFailedMessage(error) ?? partyNoCandidateNote('execution_failure', kind, query),
      });
    }
  };

  // Results count only for the name typed now. A name change has already cleared them; this covers the render before
  // the effect runs.
  const shown: PickerState = state.status !== 'idle' && state.query === query ? state : IDLE;
  const shownDuplicateNames =
    shown.status === 'listed' ? duplicateCandidateNames(shown.results) : new Set<string>();
  const indexReply: PartyIndexReply | null =
    index.status === 'ready' && index.query === query ? index.reply : null;
  // The list's own matches need the list file.
  const indexMatches: PartyIndexReply | null = indexReply?.available ? indexReply : null;

  // With a kind, only that kind is in scope. Without one, every kind is.
  const inScope = (party: { kind: StaffQuoteParty['kind'] }) => !kind || party.kind === kind;
  const indexResults = (indexMatches?.results ?? []).filter(inScope);
  const indexDuplicateNames = duplicateCandidateNames(indexResults);
  const v2PartyJob = Boolean(v2DisplayJobView?.prefetch);
  const v2Result = v2PartyJob ? v2DisplayJobView?.result : null;
  const v2MatchStatus = v2Result?.matchStatus === 'bound' || v2Result?.matchStatus === 'needs_pick'
    ? v2Result.matchStatus
    : null;
  const v2BoundParty = isPartyCandidate(v2Result?.boundParty) ? v2Result.boundParty : null;
  const v2BoundKey =
    v2DisplayJobView?.runId && v2BoundParty
      ? `${v2DisplayJobView.runId}:${v2BoundParty.kind}:${v2BoundParty.nativeId}`
      : null;
  const v2BoundWasApplied = Boolean(v2BoundKey && appliedV2Bindings.current.has(v2BoundKey));
  const v2ResultRows = uniqueCandidates(partyCandidatesFrom(v2Result?.results) ?? []).filter(inScope);
  const v2PartyToOmit = selectedParty ?? (v2BoundWasApplied ? null : v2BoundParty);
  const v2Alternatives = v2ResultRows.filter(
    (row) =>
      !v2PartyToOmit ||
      row.kind !== v2PartyToOmit.kind ||
      row.nativeId !== v2PartyToOmit.nativeId,
  );
  const v2Reason = typeof v2Result?.reason === 'string' ? v2Result.reason : '';
  const v2BoundForField =
    !pickedHere && v2MatchStatus === 'bound' && v2BoundParty && inScope(v2BoundParty)
      ? v2BoundParty
      : null;
  const v2NeedsPick = Boolean(
    v2PartyJob &&
      !pickedHere &&
      (v2MatchStatus === 'needs_pick' ||
        (v2MatchStatus === 'bound' &&
          v2BoundParty &&
          ((kind && !inScope(v2BoundParty)) || v2BoundWasApplied))),
  );

  useEffect(() => {
    if (currentJobView?.status === 'done' && partyJobIsV2(currentJobView)) {
      setV2JobCache((cached) =>
        cached?.scope === v2JobScopeKey &&
        cached.query === v2JobQueryKey &&
        cached.view === currentJobView
          ? cached
          : { scope: v2JobScopeKey, query: v2JobQueryKey, view: currentJobView },
      );
    }
  }, [currentJobView, v2JobQueryKey, v2JobScopeKey]);

  useEffect(() => {
    if (!v2BoundForField || !v2BoundKey || !v2DisplayJobView || pickedHere) return;
    if (appliedV2Bindings.current.has(v2BoundKey)) return;
    appliedV2Bindings.current.add(v2BoundKey);
    setV2JobCache({
      scope: v2JobScopeKey,
      query: searchKey(v2BoundForField.name),
      view: v2DisplayJobView,
    });
    onPick({
      kind: v2BoundForField.kind,
      nativeId: v2BoundForField.nativeId,
      name: v2BoundForField.name,
    });
  }, [v2BoundKey, v2DisplayJobView, v2JobScopeKey, onPick, pickedHere, v2BoundForField]);

  const topSuggestion = !pickedHere ? suggestions.find((suggestion) => inScope(suggestion)) : undefined;

  useEffect(() => {
    if (pickedHere || v2BoundForField || !onSearchName || !topSuggestion) return;
    const seedKey = `${topSuggestion.kind}:${topSuggestion.name}`;
    if (seededSuggestion.current === seedKey) return;
    if (query && searchKey(query) === searchKey(topSuggestion.name)) {
      seededSuggestion.current = seedKey;
      return;
    }
    if (query) return;
    seededSuggestion.current = seedKey;
    onSearchName(topSuggestion.name, topSuggestion.kind);
  }, [onSearchName, pickedHere, query, topSuggestion, v2BoundForField]);

  const picked: StaffQuoteParty[] = [];
  for (const party of [parties.company, parties.agency])
    if (party && inScope(party)) picked.push(party);
  // The automatic search's matches, without the row already picked for this field.
  const autoRows = uniqueCandidates(autoReply?.results ?? []).filter(
    (row) =>
      inScope(row) &&
      !picked.some((party) => party.kind === row.kind && party.nativeId === row.nativeId),
  );
  const jobResults = uniqueCandidates(jobReply?.results.filter(inScope) ?? []);
  const autoDuplicateNames = duplicateCandidateNames(autoRows);
  const jobDuplicateNames = duplicateCandidateNames(jobResults);
  const autoBest =
    !pickedHere && autoReply?.best && inScope(autoReply.best) ? autoReply.best : null;
  const autoOtherRows = autoRows.filter(
    (row) => !autoBest || row.kind !== autoBest.kind || row.nativeId !== autoBest.nativeId,
  );
  const prefetchedBest =
    !v2PartyJob && !pickedHere && currentJobView?.prefetch && jobReply?.best && inScope(jobReply.best)
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
    if (
      v2PartyJob &&
      v2DisplayJobView &&
      v2ResultRows.some(
        (candidate) => candidate.kind === row.kind && candidate.nativeId === row.nativeId,
      )
    ) {
      setV2JobCache({
        scope: v2JobScopeKey,
        query: searchKey(row.name),
        view: v2DisplayJobView,
      });
    }
    onPick({ kind: row.kind, nativeId: row.nativeId, name: row.name });
  };

  useEffect(() => {
    if (pickedHere || !topSuggestion) return;
    const candidate = autoBest ?? prefetchedBest;
    if (
      !candidate ||
      searchKey(query) !== searchKey(topSuggestion.name) ||
      searchKey(candidate.name) !== searchKey(topSuggestion.name)
    )
      return;
    const key = `${candidate.kind}:${candidate.nativeId}`;
    if (appliedSuggestionPick.current.has(key)) return;
    appliedSuggestionPick.current.add(key);
    onPick({ kind: candidate.kind, nativeId: candidate.nativeId, name: candidate.name });
  }, [autoBest, onPick, pickedHere, prefetchedBest, query, topSuggestion]);
  const showAutoStatus =
    Boolean(autoMemoKey) && !pickedHere && shown.status === 'idle';
  const jobFailureOutcome = jobReply?.outcome ?? 'execution_failure';
  const partySearchTimedOut = currentJobView?.failureClass === 'PARTY_SEARCH_TIMEOUT';
  const timeoutMessage = 'Party search timed out after four minutes. You can retry.';
  const jobName = currentJobView?.request?.kind === 'party' ? currentJobView.request.name : query;
  const jobDisplayName = query || jobName;
  const partyType = kind ? partyKindLabel(kind).toLowerCase() : 'company or agency';
  const jobDetail = `Searching for the ${partyType} in HMS.`;
  const jobReadBackPending = Boolean(
    jobTransport && jobResume && !partyJob.readBackSettled && !partyJob.statusFailed,
  );
  const jobBusy = Boolean(
    partyJob.queuing || (jobResume && !partyJob.readBackSettled),
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
          <span>{`✓ ${party.name} (#${party.nativeId})`}</span>
          {v2MatchStatus === 'bound' &&
          v2BoundParty?.kind === party.kind &&
          v2BoundParty.nativeId === party.nativeId &&
          v2Reason ? (
            <span className="font-normal text-[#64748b]">{v2Reason}</span>
          ) : null}
          <LinkButton onClick={() => onClear(party.kind)}>Change</LinkButton>
        </div>
      ))}
      {v2PartyJob &&
      v2Alternatives.length > 0 &&
      ((v2MatchStatus === 'bound' && !v2NeedsPick) ||
        (v2MatchStatus === 'needs_pick' && pickedHere)) ? (
        <PartyAlternatives
          key={v2DisplayJobView?.runId}
          rows={v2Alternatives}
          defaultOpen={false}
          label="Other HMS matches"
          onPick={pickRow}
        />
      ) : null}
      {Boolean(autoMemoKey) && pickedHere && autoRows.length ? (
        <ResultChips label="Also in HMS:" rows={autoRows} onPick={pickRow} />
      ) : null}
      {showAutoStatus ? (
        autoReply ? (
          <div className="flex flex-col gap-1">
            {autoBest ? (
              <div className="flex flex-col gap-1" aria-label="Suggested match from HMS">
                <p>{PARTY_PREFETCH_HINT}</p>
                <button
                  type="button"
                  className="w-fit rounded-[3px] border border-[#0066cc] bg-white px-2 py-0.5 text-[12.5px] font-semibold text-[#0066cc] hover:bg-[#eff6ff]"
                  aria-label={`Confirm ${candidateChoiceLabel(autoBest, autoDuplicateNames)}`}
                  onClick={() => pickRow(autoBest)}
                >
                  {`Confirm ${candidateChoiceLabel(autoBest, autoDuplicateNames)}`}
                </button>
                {autoOtherRows.length ? (
                  <ResultChips
                    label="Other matches in HMS:"
                    rows={autoOtherRows}
                    allRows={autoRows}
                    onPick={pickRow}
                  />
                ) : null}
              </div>
            ) : autoRows.length ? (
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
          failedMessage={partySearchTimedOut ? timeoutMessage : partyNoCandidateNote(jobFailureOutcome, kind, jobDisplayName)}
          queueFailureMessage={
            partyJob.queueFailureMessage ?? partyNoCandidateNote('execution_failure', kind, query)
          }
        />
      ) : null}
      {v2NeedsPick ? (
        <div className="flex flex-col gap-1" aria-label="Party match needs a pick">
          <p className="text-[10.5px] font-semibold text-[#334155]">Pick the company/agency</p>
          {v2Alternatives.length ? (
            <PartyAlternatives
              key={v2DisplayJobView?.runId}
              rows={v2Alternatives}
              defaultOpen
              label="HMS matches"
              onPick={pickRow}
            />
          ) : null}
          {v2Reason ? <p role="status">{v2Reason}</p> : null}
          <HmsAsOf asOf={v2DisplayJobView?.asOf ?? null} />
        </div>
      ) : null}
      {jobTransport &&
      !v2PartyJob &&
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
            aria-label={`Confirm ${candidateChoiceLabel(prefetchedBest, jobDuplicateNames)}`}
            onClick={() => pickRow(prefetchedBest)}
          >
            {`Confirm ${candidateChoiceLabel(prefetchedBest, jobDuplicateNames)}`}
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
                  {candidateChoiceLabel(candidate, indexDuplicateNames)}
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
      {jobTransport && !v2PartyJob && currentJobView?.status === 'done' && jobResults.length && !prefetchedBest ? (
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
                  {candidateChoiceLabel(candidate, jobDuplicateNames)}
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
        <ResultChips
          label="Other matches in HMS:"
          rows={otherJobResults}
          allRows={jobResults}
          onPick={pickRow}
        />
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
                  {candidateChoiceLabel(candidate, shownDuplicateNames)}
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
