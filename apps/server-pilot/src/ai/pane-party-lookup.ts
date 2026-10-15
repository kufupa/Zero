import {
  isDaVinciMailboxOrigin,
  type MailboxHmsOriginFields,
} from '../hms/mailbox-hms-origin-bind.js';
import {
  acquisitionWithin,
  isPropertyReadLockDeadline,
  PANE_PROPERTY_LOCK_WAIT_MS,
  type PropertyReadLockAcquisitionOptions,
} from '../hms/property-read-lock.js';
import { matchKey, partyNameParts, partySearchTerms, type PartyNameParts } from './party-match.js';
import { paneStaySpawnEnv, warnPaneStaySpawnFailed } from './pane-stay-spawn-env.js';
import { paneStayPropertyLock, type PaneStayLock } from './pane-stay-save.js';
import { quoteRateContextEnabled } from './quote-rate-switch.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { HMS_JOB_PROMPT_VERSION } from './run-ledger.js';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { aiWorkflowRun } from '../db/schema/mail.js';
import { getDb, type DB } from '../db/client.js';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const PARTY_LOOKUP = fileURLToPath(
  new URL('../../tooling/playwright-quote/party-lookup.mjs', import.meta.url),
);
// A search runs the lookup once per kind. Each run is bounded here, so the pair plus two 20 s lock waits stays under
// the 6 min browser deadline for this route (apps/mail/lib/trpc-request-timeout.ts).
const PARTY_LOOKUP_KIND_TIMEOUT_MS = 150_000;
export const PANE_PARTY_CANDIDATE_CAP = 20;

/** The pane's words for a party. The HMS kinds are organization (company) and bookingAgency (agency). */
export type PanePartyKind = 'agency' | 'company';

export type PanePartyCandidate = { kind: PanePartyKind; nativeId: string; name: string };

/** A kind is searched alone when given. Without one, both kinds are searched, as before. */
export type PanePartyFindInput = { name: string; kind?: PanePartyKind };

export type PanePartyOutcome =
  | 'resolved'
  | 'ambiguous'
  | 'no_match'
  | 'input_gap'
  | 'execution_failure'
  | 'external_system_unavailable'
  | 'refused_flag_off'
  | 'refused_input_invalid'
  | 'refused_origin_mismatch'
  | 'refused_lock_unavailable'
  | 'refused_lock_busy';

/** One search's answer before ranking. The CLI mapping and the per-kind merge return this shape. */
export type PanePartyLookupCore = {
  outcome: PanePartyOutcome;
  results: PanePartyCandidate[];
  /** True when an HMS grid held its 50-row load or the merged list passed the cap. More matches may exist. */
  truncated: boolean;
};

/** The pane's reply: the search answer, ranked best first, with the best row and the HMS text that found the rows. */
export type PanePartyFindResult = PanePartyLookupCore & {
  /** The top row when it answers the typed name well (score 0 to 3). Null otherwise. */
  best: PanePartyCandidate | null;
  /** The HMS search text that produced the rows, or the last one tried. Null on a refusal or failure. */
  searchedFor: string | null;
};

// Companies first, then agencies. Each kind has its own HMS window, so each is one lookup run.
const PARTY_KINDS: readonly PanePartyKind[] = ['company', 'agency'];

const HMS_KIND: Record<PanePartyKind, 'organization' | 'bookingAgency'> = {
  company: 'organization',
  agency: 'bookingAgency',
};

const CLI_OUTCOMES: ReadonlySet<string> = new Set([
  'resolved',
  'ambiguous',
  'no_match',
  'input_gap',
  'execution_failure',
  'external_system_unavailable',
]);

// Outcomes that stop a search: a half-run search must never look like a clean no_match.
const KIND_FAILURES = ['execution_failure', 'external_system_unavailable', 'input_gap'] as const;

// Test seam, like paneStayLookupLoaders. spawn returns what party-lookup.mjs prints as its result line.
export const panePartyLookupLoaders: {
  spawn: ((input: { kind: PanePartyKind; name: string }) => Promise<unknown>) | null;
  lock: PaneStayLock | null;
  enabled: (() => boolean) | null;
} = {
  spawn: null,
  lock: null,
  enabled: null,
};

function withoutResults(outcome: PanePartyOutcome, truncated = false): PanePartyLookupCore {
  return { outcome, results: [], truncated };
}

/** Keeps the CLI candidates of the kind asked for that carry an id and a name. Anything else is dropped. */
export function panePartyCandidates(kind: PanePartyKind, raw: unknown): PanePartyCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: PanePartyCandidate[] = [];
  for (const item of raw) {
    const candidate = (item ?? {}) as { nativeId?: unknown; displayName?: unknown; kind?: unknown };
    if (candidate.kind !== HMS_KIND[kind]) continue;
    if (typeof candidate.nativeId !== 'string' || !candidate.nativeId.trim()) continue;
    if (typeof candidate.displayName !== 'string' || !candidate.displayName.trim()) continue;
    // The name is sent back as the rate context name, so it stays exactly as HMS shows it.
    out.push({ kind, nativeId: candidate.nativeId.trim(), name: candidate.displayName });
  }
  return out;
}

/** Maps one kind's CLI result to the pane's result. Only resolved and ambiguous carry candidates. */
export function panePartyFindResultFromCli(kind: PanePartyKind, raw: unknown): PanePartyLookupCore {
  const cli = (raw ?? {}) as { outcome?: unknown; candidates?: unknown; truncated?: unknown };
  const outcome =
    typeof cli.outcome === 'string' && CLI_OUTCOMES.has(cli.outcome)
      ? cli.outcome
      : 'execution_failure';
  if (outcome !== 'resolved' && outcome !== 'ambiguous' && outcome !== 'no_match') {
    return withoutResults(outcome as PanePartyOutcome);
  }
  const truncated = cli.truncated === true;
  const results = panePartyCandidates(kind, cli.candidates);
  if (!results.length) return withoutResults('no_match', truncated);
  return { outcome, results, truncated };
}

/** Each kind shows at most this many, so a broad company name cannot crowd out the agencies. */
export const PANE_PARTY_PER_KIND_CAP = 10;

/** 0 for an exact name, 1 for a name that starts with the query, 2 for one that contains it, else 3. */
function matchRank(query: string, name: string): number {
  const wanted = matchKey(query);
  const found = matchKey(name);
  if (found === wanted) return 0;
  if (found.startsWith(wanted)) return 1;
  if (found.includes(wanted)) return 2;
  return 3;
}

/** One kind's candidates: one row per HMS id, the best matches first, capped. `more` says there were further rows. */
function rankKindCandidates(
  query: string,
  candidates: readonly PanePartyCandidate[],
): { kept: PanePartyCandidate[]; more: boolean } {
  const seen = new Set<string>();
  const ranked = candidates
    .filter((candidate) => {
      const key = `${candidate.kind}:${candidate.nativeId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((candidate, index) => ({ candidate, index, rank: matchRank(query, candidate.name) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((row) => row.candidate);
  return {
    kept: ranked.slice(0, PANE_PARTY_PER_KIND_CAP),
    more: ranked.length > PANE_PARTY_PER_KIND_CAP,
  };
}

/**
 * One answer for a search over both kinds. A refusal or failure on either kind is the answer, with no results.
 * Otherwise each kind is ranked and capped on its own, and the companies come before the agencies.
 */
export function mergePartyKindResults(
  perKind: readonly PanePartyLookupCore[],
  query = '',
): PanePartyLookupCore {
  const refused = perKind.find((result) => result.outcome.startsWith('refused_'));
  if (refused) return withoutResults(refused.outcome);
  for (const failure of KIND_FAILURES) {
    if (perKind.some((result) => result.outcome === failure)) return withoutResults(failure);
  }
  const candidates = perKind.flatMap((result) => result.results);
  const results: PanePartyCandidate[] = [];
  let truncated = perKind.some((result) => result.truncated);
  for (const kind of PARTY_KINDS) {
    const ranked = rankKindCandidates(
      query,
      candidates.filter((candidate) => candidate.kind === kind),
    );
    results.push(...ranked.kept);
    truncated = truncated || ranked.more;
  }
  if (!results.length) return withoutResults('no_match', truncated);
  return {
    outcome: results.length === 1 && !truncated ? 'resolved' : 'ambiguous',
    results,
    truncated,
  };
}

/** One runner run for one kind and name. The sweep and the pane both call it, so both use the fail-closed runner. */
export async function spawnPartyLookup(input: {
  kind: PanePartyKind;
  name: string;
}): Promise<unknown> {
  // mkdtemp makes the directory 0700. The request holds only the typed name, and the directory goes after the run.
  const dir = await mkdtemp(join(tmpdir(), 'pane-party-'));
  try {
    const requestPath = join(dir, 'request.json');
    const query =
      input.kind === 'company'
        ? { organizationName: input.name }
        : { bookingAgencyName: input.name };
    await writeFile(requestPath, JSON.stringify({ kind: HMS_KIND[input.kind], query }), {
      mode: 0o600,
      flag: 'wx',
    });
    let stdout = '';
    try {
      ({ stdout } = await execFileAsync(
        process.execPath,
        [PARTY_LOOKUP, '--request', requestPath],
        // The same borrowed browser and credential file the stay lookups use.
        // SIGKILL: a runner stuck on HMS is stopped outright, not asked politely. Its temp request goes in the finally.
        {
          timeout: PARTY_LOOKUP_KIND_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          env: paneStaySpawnEnv(),
          maxBuffer: 1024 * 1024,
        },
      ));
    } catch (error) {
      // The CLI exits 2 on failures but still prints its result line. Without one, the run failed.
      stdout = String((error as { stdout?: unknown }).stdout ?? '');
      if (!stdout.trim()) throw error;
    }
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** A kind search tries at most this many HMS texts: the cleaned name, then its first distinctive word. */
const PARTY_KIND_SEARCH_TERMS = 2;
const ANSWERED_OUTCOMES: ReadonlySet<string> = new Set(['resolved', 'ambiguous', 'no_match']);
/** The most rows the pane gets, best first. */
export const PANE_PARTY_RESULT_CAP = 5;
/** How long a row HMS returned is remembered for verifyPartyPick. */
export const PARTY_ROW_CACHE_TTL_MS = 30 * 60_000;

// Rows HMS returned, by kind and id. A pick the pane was just shown binds without another HMS run.
const partyRowCache = new Map<string, { name: string; at: number }>();

function rememberPartyRows(rows: readonly PanePartyCandidate[]): void {
  const now = Date.now();
  for (const [key, entry] of partyRowCache) {
    if (now - entry.at >= PARTY_ROW_CACHE_TTL_MS) partyRowCache.delete(key);
  }
  for (const row of rows)
    partyRowCache.set(`${row.kind}:${row.nativeId}`, { name: row.name, at: now });
}

/** The name HMS gave this id, when it was remembered within the TTL and still matches the name asked for. */
function rememberedPartyName(
  pick: { kind: PanePartyKind; nativeId: string },
  name: string,
): string | null {
  const key = `${pick.kind}:${pick.nativeId}`;
  const entry = partyRowCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at >= PARTY_ROW_CACHE_TTL_MS) {
    partyRowCache.delete(key);
    return null;
  }
  return sameHmsName(entry.name, name) ? entry.name : null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Recent successful party-job snapshots are shared across processes
 * for the same mailbox transport.
 */
async function rememberedPartyJobName(
  pick: { kind: PanePartyKind; nativeId: string },
  name: string,
  transportId: string,
  db: DB = getDb(),
): Promise<string | null> {
  const normalized = name.replace(/\s+/g, ' ').trim().toLowerCase();
  const rows = await db
    .select({ readRequest: aiWorkflowRun.readRequest, readResult: aiWorkflowRun.readResult })
    .from(aiWorkflowRun)
    .where(
      and(
        eq(aiWorkflowRun.transportId, transportId),
        eq(aiWorkflowRun.runKind, 'read_tool'),
        eq(aiWorkflowRun.promptVersion, HMS_JOB_PROMPT_VERSION),
        eq(aiWorkflowRun.state, 'succeeded'),
        gte(aiWorkflowRun.finishedAt, new Date(Date.now() - PARTY_ROW_CACHE_TTL_MS)),
        sql`${aiWorkflowRun.readRequest}->>'kind' = 'party'`,
        sql`exists (
          select 1
          from jsonb_array_elements(
            case
              when jsonb_typeof(${aiWorkflowRun.readResult}->'results') = 'array'
                then ${aiWorkflowRun.readResult}->'results'
              else '[]'::jsonb
            end
          ) as candidate(value)
          where candidate.value->>'kind' = ${pick.kind}
            and candidate.value->>'nativeId' = ${pick.nativeId}
            and lower(
              btrim(
                regexp_replace(
                  candidate.value->>'name',
                  '[[:space:]]+',
                  ' ',
                  'g'
                )
              )
            ) = ${normalized}
        )`,
      ),
    )
    .orderBy(desc(aiWorkflowRun.finishedAt), desc(aiWorkflowRun.createdAt))
    .limit(1);
  for (const row of rows) {
    const request = objectRecord(row.readRequest);
    if (request.partyKind && request.partyKind !== pick.kind) continue;
    const result = objectRecord(row.readResult);
    if (!Array.isArray(result.results)) continue;
    for (const candidateValue of result.results) {
      const candidate = objectRecord(candidateValue);
      if (
        candidate.kind === pick.kind &&
        candidate.nativeId === pick.nativeId &&
        typeof candidate.name === 'string' &&
        sameHmsName(candidate.name, name)
      ) {
        return candidate.name;
      }
    }
  }
  return null;
}

/** Test seam: forgets every remembered row. */
export function resetPartyCacheForTests(): void {
  partyRowCache.clear();
}

/** 0 exact, 1 starts with the cleaned name, 2 holds every word of it, 3 holds the first distinctive word, else 4. */
function rowScore(name: string, parts: PartyNameParts, row: string): number {
  const found = matchKey(row);
  if (found === matchKey(name)) return 0;
  const padded = ` ${found} `;
  const cleaned = matchKey(parts.cleaned);
  if (cleaned && (found === cleaned || found.startsWith(`${cleaned} `))) return 1;
  if (cleaned && cleaned.split(' ').every((word) => padded.includes(` ${word} `))) return 2;
  const first = parts.firstWord ? matchKey(parts.firstWord) : '';
  if (first && padded.includes(` ${first} `)) return 3;
  return 4;
}

/** The rows best first, one per HMS id. Equal scores keep HMS's order. */
function rankRows(
  name: string,
  rows: readonly PanePartyCandidate[],
): Array<{ row: PanePartyCandidate; score: number }> {
  const parts = partyNameParts(name);
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const key = `${row.kind}:${row.nativeId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row, index) => ({ row, index, score: rowScore(name, parts, row.name) }))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ row, score }) => ({ row, score }));
}

/** A refusal or failure as the reply: no rows, no best, nothing searched. */
function replyWithout(outcome: PanePartyOutcome): PanePartyFindResult {
  return { ...withoutResults(outcome), best: null, searchedFor: null };
}

/** The reply for a search that ran: rows best first and capped, the best row, and the HMS text that was searched. */
function rankedReply(
  name: string,
  core: PanePartyLookupCore,
  searchedFor: string,
  cap: number = PANE_PARTY_RESULT_CAP,
): PanePartyFindResult {
  if (!ANSWERED_OUTCOMES.has(core.outcome)) return replyWithout(core.outcome);
  const ranked = rankRows(name, core.results);
  const results = ranked.slice(0, cap).map(({ row }) => row);
  rememberPartyRows(results);
  const top = ranked[0];
  return {
    outcome: core.outcome,
    results,
    truncated: core.truncated || ranked.length > cap,
    best: top && top.score <= 3 ? top.row : null,
    searchedFor,
  };
}

/** One runner run for one kind and HMS text, under the property lock. A refusal or failure comes back in the core shape. */
async function lookupKind(
  kind: PanePartyKind,
  term: string,
  lock: PaneStayLock,
  spawn: (input: { kind: PanePartyKind; name: string }) => Promise<unknown>,
  acquisition?: PropertyReadLockAcquisitionOptions,
): Promise<PanePartyLookupCore> {
  let raw: unknown;
  try {
    raw = await lock.withLock(
      () => spawn({ kind, name: term }),
      acquisition ?? acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
    );
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return withoutResults('refused_lock_busy');
    warnPaneStaySpawnFailed('party', error);
    return withoutResults('execution_failure');
  }
  return panePartyFindResultFromCli(kind, raw);
}

/**
 * A search for one kind. Its HMS texts are tried in turn and the search stops at the first that finds rows, so there are
 * at most two HMS runs. A refusal or failure ends it at once.
 */
async function findPartyOfKind(
  kind: PanePartyKind,
  name: string,
  lock: PaneStayLock,
  spawn: (input: { kind: PanePartyKind; name: string }) => Promise<unknown>,
  options: {
    acquisition?: PropertyReadLockAcquisitionOptions;
    exactTerm?: boolean;
    resultCap?: number;
  } = {},
): Promise<PanePartyFindResult> {
  const terms = options.exactTerm ? [name] : partySearchTerms(name).slice(0, PARTY_KIND_SEARCH_TERMS);
  const tries = terms.length ? terms : [name];
  let core: PanePartyLookupCore = withoutResults('no_match');
  let searchedFor = tries[0];
  for (const term of tries) {
    searchedFor = term;
    core = await lookupKind(kind, term, lock, spawn, options.acquisition);
    if (!ANSWERED_OUTCOMES.has(core.outcome) || core.results.length) break;
  }
  return rankedReply(name, core, searchedFor, options.resultCap ?? PANE_PARTY_RESULT_CAP);
}

/**
 * Read-only HMS search of companies and agencies for one name, under the session hotel's property lock. With a kind, only
 * that kind is searched, and its HMS texts are tried in turn. Without one, it runs one lookup per kind. It links nothing:
 * every candidate goes back to staff, who pick one. The kill switch QUOTE_RATE_CONTEXT=off refuses it.
 */
export async function findParty(
  input: PanePartyFindInput,
  options: {
    acquisition?: PropertyReadLockAcquisitionOptions;
    /** V2 already owns a bounded plan and must run exactly one planned term through the existing lookup runner. */
    exactTerm?: boolean;
    /** Wider aggregate input for the V2 LLM (still capped before it is sent). */
    resultCap?: number;
    /** Trigger mailbox origin. Da Vinci identity must not take the Centurion HMS slot. */
    origin?: MailboxHmsOriginFields;
  } = {},
): Promise<PanePartyFindResult> {
  const enabled = panePartyLookupLoaders.enabled ?? (() => quoteRateContextEnabled());
  if (!enabled()) return replyWithout('refused_flag_off');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 256) return replyWithout('refused_input_invalid');
  if (options.origin && isDaVinciMailboxOrigin(options.origin)) {
    return replyWithout('refused_origin_mismatch');
  }
  const lock = panePartyLookupLoaders.lock ?? paneStayPropertyLock();
  if (!lock) return replyWithout('refused_lock_unavailable');
  const spawn = panePartyLookupLoaders.spawn ?? spawnPartyLookup;
  if (input.kind) return findPartyOfKind(input.kind, name, lock, spawn, options);
  const perKind: PanePartyLookupCore[] = [];
  for (const kind of PARTY_KINDS) {
    let raw: unknown;
    try {
      raw = await lock.withLock(
        () => spawn({ kind, name }),
        options.acquisition ?? acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
      );
    } catch (error) {
      if (isPropertyReadLockDeadline(error)) {
        perKind.push(withoutResults('refused_lock_busy'));
      } else {
        warnPaneStaySpawnFailed('party', error);
        perKind.push(withoutResults('execution_failure'));
      }
      break;
    }
    const result = panePartyFindResultFromCli(kind, raw);
    perKind.push(result);
    // A refusal or failure already decides the search, so the other kind is not run.
    if (
      result.outcome !== 'resolved' &&
      result.outcome !== 'ambiguous' &&
      result.outcome !== 'no_match'
    ) {
      break;
    }
  }
  // Both kinds keep their own per-kind cap from the merge, as before. The 5-row cap is for a kind search.
  return rankedReply(name, mergePartyKindResults(perKind, name), name, Number.POSITIVE_INFINITY);
}

export type VerifiedPartyResult =
  | { ok: true; party: { kind: PanePartyKind; nativeId: string; name: string } }
  | {
      ok: false;
      reason:
        | 'refused_flag_off'
        | 'refused_lock_busy'
        | 'refused_lock_unavailable'
        | 'not_found'
        | 'unverified';
    };

function sameHmsName(left: string, right: string): boolean {
  const key = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
  return key(left) === key(right);
}

/**
 * Re-checks a company or agency the pane sent, before any rate is bound to it. The server looks the name up in HMS of
 * the same kind, and binds only a row with the same HMS id and the same name. The name bound is HMS's own, so the quote
 * validator sees the name HMS reports. A client-sent id that HMS does not return is refused.
 */
export async function verifyPartyPick(
  pick: {
    kind: PanePartyKind;
    nativeId: string;
    name: string;
    transportId?: string;
  },
  db?: DB,
): Promise<VerifiedPartyResult> {
  const enabled = panePartyLookupLoaders.enabled ?? (() => quoteRateContextEnabled());
  if (!enabled()) return { ok: false, reason: 'refused_flag_off' };
  const name = typeof pick.name === 'string' ? pick.name.trim() : '';
  if (!name || name.length > 256 || !pick.nativeId) return { ok: false, reason: 'not_found' };
  // A row HMS returned within the TTL, with the same name, binds with no HMS run and no lock wait.
  const remembered = rememberedPartyName(pick, name);
  if (remembered !== null)
    return { ok: true, party: { kind: pick.kind, nativeId: pick.nativeId, name: remembered } };
  if (pick.transportId) {
    try {
      const fromJob = await rememberedPartyJobName(pick, name, pick.transportId, db);
      if (fromJob !== null)
        return { ok: true, party: { kind: pick.kind, nativeId: pick.nativeId, name: fromJob } };
    } catch {
      // A missed shared cache is not verification; continue through the existing live lookup.
    }
  }
  const lock = panePartyLookupLoaders.lock ?? paneStayPropertyLock();
  if (!lock) return { ok: false, reason: 'refused_lock_unavailable' };
  const spawn = panePartyLookupLoaders.spawn ?? spawnPartyLookup;
  let raw: unknown;
  try {
    raw = await lock.withLock(
      () => spawn({ kind: pick.kind, name }),
      acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
    );
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return { ok: false, reason: 'refused_lock_busy' };
    warnPaneStaySpawnFailed('party', error);
    return { ok: false, reason: 'unverified' };
  }
  const found = panePartyFindResultFromCli(pick.kind, raw);
  if (ANSWERED_OUTCOMES.has(found.outcome)) rememberPartyRows(found.results);
  const row = found.results.find(
    (candidate) =>
      candidate.kind === pick.kind &&
      candidate.nativeId === pick.nativeId &&
      sameHmsName(candidate.name, name),
  );
  if (!row)
    return {
      ok: false,
      reason: found.outcome === 'execution_failure' ? 'unverified' : 'not_found',
    };
  return { ok: true, party: { kind: row.kind, nativeId: row.nativeId, name: row.name } };
}
