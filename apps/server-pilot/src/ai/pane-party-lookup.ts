import {
  acquisitionWithin,
  isPropertyReadLockDeadline,
  PANE_PROPERTY_LOCK_WAIT_MS,
} from '../hms/property-read-lock.js';
import { paneStaySpawnEnv, warnPaneStaySpawnFailed } from './pane-stay-spawn-env.js';
import { paneStayPropertyLock, type PaneStayLock } from './pane-stay-save.js';
import { quoteRateContextEnabled } from './staff-quote-workflow.js';
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
// The lookup connects, logs in, searches one HMS window and reads its grid. The quote path uses the same bound.
const PARTY_LOOKUP_TIMEOUT_MS = 5 * 60_000;
export const PANE_PARTY_CANDIDATE_CAP = 20;

/** The pane's words for a party. The HMS kinds are organization (company) and bookingAgency (agency). */
export type PanePartyKind = 'agency' | 'company';

export type PanePartyCandidate = { nativeId: string; displayName: string; kind: PanePartyKind };

export type PanePartyFindInput = { kind: PanePartyKind; name: string };

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
  candidates: PanePartyCandidate[];
};

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

// Test seam, like paneStayLookupLoaders. spawn returns what party-lookup.mjs prints as its result line.
export const panePartyLookupLoaders: {
  spawn: ((input: PanePartyFindInput) => Promise<unknown>) | null;
  lock: PaneStayLock | null;
  enabled: (() => boolean) | null;
} = {
  spawn: null,
  lock: null,
  enabled: null,
};

function refused(outcome: PanePartyFindResult['outcome']): PanePartyFindResult {
  return { outcome, candidates: [] };
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
    // The display name is sent back as the rate context name, so it stays exactly as HMS shows it.
    out.push({ nativeId: candidate.nativeId.trim(), displayName: candidate.displayName, kind });
  }
  return out;
}

/** Maps one CLI result to the pane's result. Only resolved and ambiguous carry candidates, capped. */
export function panePartyFindResultFromCli(kind: PanePartyKind, raw: unknown): PanePartyFindResult {
  const cli = (raw ?? {}) as { outcome?: unknown; candidates?: unknown };
  const outcome =
    typeof cli.outcome === 'string' && CLI_OUTCOMES.has(cli.outcome)
      ? cli.outcome
      : 'execution_failure';
  if (outcome !== 'resolved' && outcome !== 'ambiguous' && outcome !== 'no_match') {
    return refused(outcome as PanePartyFindResult['outcome']);
  }
  const candidates = panePartyCandidates(kind, cli.candidates).slice(0, PANE_PARTY_CANDIDATE_CAP);
  if (!candidates.length) return refused('no_match');
  return { outcome, candidates };
}

async function defaultSpawn(input: PanePartyFindInput): Promise<unknown> {
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
        { timeout: PARTY_LOOKUP_TIMEOUT_MS, env: paneStaySpawnEnv(), maxBuffer: 1024 * 1024 },
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
 * Read-only HMS party search under the session hotel's property lock, for the pane's Find in HMS picker. It links
 * nothing: every candidate goes back to staff, who pick one. The kill switch QUOTE_RATE_CONTEXT=off refuses it.
 */
export async function findParty(input: PanePartyFindInput): Promise<PanePartyFindResult> {
  const enabled = panePartyLookupLoaders.enabled ?? (() => quoteRateContextEnabled());
  if (!enabled()) return refused('refused_flag_off');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 256 || !(input.kind === 'company' || input.kind === 'agency')) {
    return refused('refused_input_invalid');
  }
  const lock = panePartyLookupLoaders.lock ?? paneStayPropertyLock();
  if (!lock) return refused('refused_lock_unavailable');
  const spawn = panePartyLookupLoaders.spawn ?? defaultSpawn;
  let raw: unknown;
  try {
    raw = await lock.withLock(
      () => spawn({ kind: input.kind, name }),
      acquisitionWithin(PANE_PROPERTY_LOCK_WAIT_MS),
    );
  } catch (error) {
    if (isPropertyReadLockDeadline(error)) return refused('refused_lock_busy');
    warnPaneStaySpawnFailed('party', error);
    return refused('execution_failure');
  }
  return panePartyFindResultFromCli(input.kind, raw);
}
