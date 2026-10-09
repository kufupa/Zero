import {
  acquisitionWithin,
  isPropertyReadLockDeadline,
  PANE_PROPERTY_LOCK_WAIT_MS,
} from '../hms/property-read-lock.js';
import { paneStaySpawnEnv, warnPaneStaySpawnFailed } from './pane-stay-spawn-env.js';
import { paneStayPropertyLock, type PaneStayLock } from './pane-stay-save.js';
import { quoteRateContextEnabled } from './quote-rate-switch.js';
import { matchKey } from './party-match.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

export type PanePartyFindInput = { name: string };

export type PanePartyFindResult = {
  outcome:
    | 'resolved'
    | 'ambiguous'
    | 'no_match'
    | 'input_gap'
    | 'execution_failure'
    | 'external_system_unavailable'
    | 'refused_flag_off'
    | 'refused_input_invalid'
    | 'refused_lock_unavailable'
    | 'refused_lock_busy';
  results: PanePartyCandidate[];
  /** True when an HMS grid held its 50-row load or the merged list passed the cap. More matches may exist. */
  truncated: boolean;
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

function withoutResults(outcome: PanePartyFindResult['outcome'], truncated = false): PanePartyFindResult {
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
export function panePartyFindResultFromCli(kind: PanePartyKind, raw: unknown): PanePartyFindResult {
  const cli = (raw ?? {}) as { outcome?: unknown; candidates?: unknown; truncated?: unknown };
  const outcome =
    typeof cli.outcome === 'string' && CLI_OUTCOMES.has(cli.outcome)
      ? cli.outcome
      : 'execution_failure';
  if (outcome !== 'resolved' && outcome !== 'ambiguous' && outcome !== 'no_match') {
    return withoutResults(outcome as PanePartyFindResult['outcome']);
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
function rankKindCandidates(query: string, candidates: readonly PanePartyCandidate[]): { kept: PanePartyCandidate[]; more: boolean } {
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
  return { kept: ranked.slice(0, PANE_PARTY_PER_KIND_CAP), more: ranked.length > PANE_PARTY_PER_KIND_CAP };
}

/**
 * One answer for a search over both kinds. A refusal or failure on either kind is the answer, with no results.
 * Otherwise each kind is ranked and capped on its own, and the companies come before the agencies.
 */
export function mergePartyKindResults(
  perKind: readonly PanePartyFindResult[],
  query = '',
): PanePartyFindResult {
  const refused = perKind.find((result) => result.outcome.startsWith('refused_'));
  if (refused) return withoutResults(refused.outcome);
  for (const failure of KIND_FAILURES) {
    if (perKind.some((result) => result.outcome === failure)) return withoutResults(failure);
  }
  const candidates = perKind.flatMap((result) => result.results);
  const results: PanePartyCandidate[] = [];
  let truncated = perKind.some((result) => result.truncated);
  for (const kind of PARTY_KINDS) {
    const ranked = rankKindCandidates(query, candidates.filter((candidate) => candidate.kind === kind));
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

async function defaultSpawn(input: { kind: PanePartyKind; name: string }): Promise<unknown> {
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
        { timeout: PARTY_LOOKUP_KIND_TIMEOUT_MS, killSignal: 'SIGKILL', env: paneStaySpawnEnv(), maxBuffer: 1024 * 1024 },
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

/**
 * Read-only HMS search of companies and agencies for one name, under the session hotel's property lock, one lookup
 * per kind. It links nothing: every candidate goes back to staff, who pick one. The kill switch QUOTE_RATE_CONTEXT=off
 * refuses it.
 */
export async function findParty(input: PanePartyFindInput): Promise<PanePartyFindResult> {
  const enabled = panePartyLookupLoaders.enabled ?? (() => quoteRateContextEnabled());
  if (!enabled()) return withoutResults('refused_flag_off');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 256) return withoutResults('refused_input_invalid');
  const lock = panePartyLookupLoaders.lock ?? paneStayPropertyLock();
  if (!lock) return withoutResults('refused_lock_unavailable');
  const spawn = panePartyLookupLoaders.spawn ?? defaultSpawn;
  const perKind: PanePartyFindResult[] = [];
  for (const kind of PARTY_KINDS) {
    let raw: unknown;
    try {
      raw = await lock.withLock(
        () => spawn({ kind, name }),
        acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
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
    if (result.outcome !== 'resolved' && result.outcome !== 'ambiguous' && result.outcome !== 'no_match') {
      break;
    }
  }
  return mergePartyKindResults(perKind, name);
}

export type VerifiedPartyResult =
  | { ok: true; party: { kind: PanePartyKind; nativeId: string; name: string } }
  | {
      ok: false;
      reason: 'refused_flag_off' | 'refused_lock_busy' | 'refused_lock_unavailable' | 'not_found' | 'unverified';
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
export async function verifyPartyPick(pick: {
  kind: PanePartyKind;
  nativeId: string;
  name: string;
}): Promise<VerifiedPartyResult> {
  const enabled = panePartyLookupLoaders.enabled ?? (() => quoteRateContextEnabled());
  if (!enabled()) return { ok: false, reason: 'refused_flag_off' };
  const name = typeof pick.name === 'string' ? pick.name.trim() : '';
  if (!name || name.length > 256 || !pick.nativeId) return { ok: false, reason: 'not_found' };
  const lock = panePartyLookupLoaders.lock ?? paneStayPropertyLock();
  if (!lock) return { ok: false, reason: 'refused_lock_unavailable' };
  const spawn = panePartyLookupLoaders.spawn ?? defaultSpawn;
  let raw: unknown;
  try {
    raw = await lock.withLock(() => spawn({ kind: pick.kind, name }), acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS));
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return { ok: false, reason: 'refused_lock_busy' };
    warnPaneStaySpawnFailed('party', error);
    return { ok: false, reason: 'unverified' };
  }
  const found = panePartyFindResultFromCli(pick.kind, raw);
  const row = found.results.find(
    (candidate) => candidate.kind === pick.kind && candidate.nativeId === pick.nativeId && sameHmsName(candidate.name, name),
  );
  if (!row) return { ok: false, reason: found.outcome === 'execution_failure' ? 'unverified' : 'not_found' };
  return { ok: true, party: { kind: row.kind, nativeId: row.nativeId, name: row.name } };
}
