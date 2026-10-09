import {
  acquisitionWithin,
  isPropertyReadLockDeadline,
  PANE_PROPERTY_LOCK_WAIT_MS,
} from '../hms/property-read-lock.js';
import { paneStaySpawnEnv, warnPaneStaySpawnFailed } from './pane-stay-spawn-env.js';
import { paneStayPropertyLock, type PaneStayLock } from './pane-stay-save.js';
import { quoteRateContextEnabled } from './quote-rate-switch.js';
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

/**
 * One answer for a search over both kinds. A refusal or failure on either kind is the answer, with no results.
 * Otherwise the two kinds' candidates merge in order and are capped.
 */
export function mergePartyKindResults(perKind: readonly PanePartyFindResult[]): PanePartyFindResult {
  const refused = perKind.find((result) => result.outcome.startsWith('refused_'));
  if (refused) return withoutResults(refused.outcome);
  for (const failure of KIND_FAILURES) {
    if (perKind.some((result) => result.outcome === failure)) return withoutResults(failure);
  }
  const all = perKind.flatMap((result) => result.results);
  const truncated = perKind.some((result) => result.truncated) || all.length > PANE_PARTY_CANDIDATE_CAP;
  const results = all.slice(0, PANE_PARTY_CANDIDATE_CAP);
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
        { timeout: PARTY_LOOKUP_KIND_TIMEOUT_MS, env: paneStaySpawnEnv(), maxBuffer: 1024 * 1024 },
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
  return mergePartyKindResults(perKind);
}
