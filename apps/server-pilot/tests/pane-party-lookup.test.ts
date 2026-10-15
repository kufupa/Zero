import {
  findParty,
  mergePartyKindResults,
  PANE_PARTY_CANDIDATE_CAP,
  PANE_PARTY_PER_KIND_CAP,
  panePartyCandidates,
  panePartyFindResultFromCli,
  panePartyLookupLoaders,
} from '../src/ai/pane-party-lookup.js';
import { quoteRateContextEnabled } from '../src/ai/quote-rate-switch.js';
import { PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';
import {
  CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
  mailboxHmsOriginBindLoaders,
} from '../src/hms/mailbox-hms-origin-bind.js';
import type { PaneStayLock } from '../src/ai/pane-stay-save.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { partySearchTerms } from '../src/ai/party-match.js';
import {
  PARTY_ROW_CACHE_TTL_MS,
  resetPartyCacheForTests,
  verifyPartyPick,
} from '../src/ai/pane-party-lookup.js';

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: () => {
    throw new Error('getDb must not run in pane-party-lookup tests');
  },
}));

// The runner's own classifier, so the fixture rows go through the same outcome and truncation rules the CLI uses.
type RunnerSeams = {
  classifyKindRows: (
    kind: string,
    rows: Array<{ nativeId: string; displayName: string; matchedOn: string[] }>,
    request: { query: Record<string, string> },
    loaded?: number,
  ) => { outcome: string; candidates: unknown[]; truncated: boolean };
  filterNotApplied: () => { outcome: string; candidates: unknown[]; truncated: boolean };
  lookupBusyTimeout: () => { outcome: string; candidates: unknown[]; truncated: boolean };
};
const runner = (await import(
  new URL('../tooling/playwright-quote/party-lookup.mjs', import.meta.url).href
)) as RunnerSeams;

// Fixture HMS grids for each kind. Names are test fixtures, not HMS data.
const HMS_COMPANIES = [
  { nativeId: '206', displayName: 'Tourvest Test Profile', matchedOn: ['store'] },
  { nativeId: '207', displayName: 'Unrelated Company', matchedOn: ['store'] },
];
const HMS_AGENCIES = [
  { nativeId: '113', displayName: '360 degrees Travel', matchedOn: ['store'] },
  { nativeId: '290', displayName: 'CWT JNB', matchedOn: ['store'] },
];

/** What party-lookup.mjs prints for one kind's grid, classified by the runner for this name. */
function cliForGrid(
  kind: 'organization' | 'bookingAgency',
  name: string,
  rows: typeof HMS_COMPANIES,
  loaded = rows.length,
) {
  const query = kind === 'organization' ? { organizationName: name } : { bookingAgencyName: name };
  return runner.classifyKindRows(kind, rows, { query }, loaded);
}

/** A spawn seam that answers each kind from its fixture grid. */
function fixtureSpawn(
  grids: { organization?: typeof HMS_COMPANIES; bookingAgency?: typeof HMS_AGENCIES; loaded?: number } = {},
) {
  return vi.fn(async ({ kind, name }: { kind: 'company' | 'agency'; name: string }) => {
    if (kind === 'company') {
      return cliForGrid('organization', name, grids.organization ?? HMS_COMPANIES, grids.loaded);
    }
    return cliForGrid('bookingAgency', name, grids.bookingAgency ?? HMS_AGENCIES);
  });
}

function passingLock(seen: string[] = []): PaneStayLock {
  return {
    withLock: async (fn) => {
      seen.push('lock');
      return fn();
    },
  };
}

function mailboxCaller() {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: {
      id: 'user-ropperman',
      email: 'ropperman@legacyhotels.co.za',
      name: 'R Opperman',
    },
    activeTransportId: 'transport-1',
    transportEmail: 'centurion@legacyhotels.co.za',
    accessRole: 'owner',
  } as never);
}

afterEach(() => {
  panePartyLookupLoaders.spawn = null;
  panePartyLookupLoaders.lock = null;
  panePartyLookupLoaders.enabled = null;
  mailboxHmsOriginBindLoaders.loadThreadOrigin = null;
  vi.unstubAllEnvs();
});

const company = (i: number) => ({
  nativeId: String(4000 + i),
  displayName: `ABC Travel ${i}`,
  matchedOn: ['store'],
});

describe('findParty: refusals before any lock or spawn', () => {
  it('refuses with QUOTE_RATE_CONTEXT=off before any lock or spawn', async () => {
    vi.stubEnv('QUOTE_RATE_CONTEXT', 'off');
    const seen: string[] = [];
    panePartyLookupLoaders.lock = passingLock(seen);
    panePartyLookupLoaders.spawn = fixtureSpawn();
    await expect(findParty({ name: 'Tourvest' })).resolves.toEqual({
      outcome: 'refused_flag_off',
      results: [],
      truncated: false,
      best: null,
      searchedFor: null,
    });
    expect(seen).toEqual([]);
    expect(panePartyLookupLoaders.spawn).not.toHaveBeenCalled();
  });

  it('refuses a blank or over-long name before any lock or spawn', async () => {
    const seen: string[] = [];
    panePartyLookupLoaders.lock = passingLock(seen);
    panePartyLookupLoaders.spawn = fixtureSpawn();
    await expect(findParty({ name: '   ' })).resolves.toMatchObject({
      outcome: 'refused_input_invalid',
    });
    await expect(findParty({ name: 'x'.repeat(257) })).resolves.toMatchObject({
      outcome: 'refused_input_invalid',
    });
    expect(seen).toEqual([]);
  });

  it('refuses when no property lock can be made, with no spawn', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const spawn = vi.fn();
    panePartyLookupLoaders.spawn = spawn;
    await expect(findParty({ name: 'ABC' })).resolves.toMatchObject({
      outcome: 'refused_lock_unavailable',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses refused_lock_busy when the property lock stays held past the wait, with no spawn', async () => {
    const spawn = vi.fn();
    panePartyLookupLoaders.spawn = spawn;
    panePartyLookupLoaders.lock = {
      withLock: async () => {
        throw Object.assign(new Error('lock wait'), {
          cause: new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE),
        });
      },
    };
    await expect(findParty({ name: 'ABC' })).resolves.toEqual({
      outcome: 'refused_lock_busy',
      results: [],
      truncated: false,
      best: null,
      searchedFor: null,
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('findParty: one search over companies and agencies', () => {
  it('Tourvest is found as a company, with its HMS id and name', async () => {
    const seen: string[] = [];
    const spawn = fixtureSpawn();
    panePartyLookupLoaders.lock = passingLock(seen);
    panePartyLookupLoaders.spawn = spawn;
    await expect(findParty({ name: ' Tourvest ' })).resolves.toEqual({
      outcome: 'resolved',
      results: [{ kind: 'company', nativeId: '206', name: 'Tourvest Test Profile' }],
      truncated: false,
      best: { kind: 'company', nativeId: '206', name: 'Tourvest Test Profile' },
      searchedFor: 'Tourvest',
    });
    expect(spawn.mock.calls.map(([input]) => input)).toEqual([
      { kind: 'company', name: 'Tourvest' },
      { kind: 'agency', name: 'Tourvest' },
    ]);
    expect(seen).toEqual(['lock', 'lock']);
  });

  it('"360" is found as an agency, with its HMS id and name', async () => {
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = fixtureSpawn();
    await expect(findParty({ name: '360' })).resolves.toEqual({
      outcome: 'resolved',
      results: [{ kind: 'agency', nativeId: '113', name: '360 degrees Travel' }],
      truncated: false,
      best: { kind: 'agency', nativeId: '113', name: '360 degrees Travel' },
      searchedFor: '360',
    });
  });

  it('keeps both kinds when one name matches a company and an agency, and marks it ambiguous', async () => {
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = fixtureSpawn({
      bookingAgency: [{ nativeId: '999', displayName: 'Tourvest Travel Agency', matchedOn: ['store'] }],
    });
    const found = await findParty({ name: 'Tourvest' });
    expect(found.outcome).toBe('ambiguous');
    expect(found.results).toEqual([
      { kind: 'company', nativeId: '206', name: 'Tourvest Test Profile' },
      { kind: 'agency', nativeId: '999', name: 'Tourvest Travel Agency' },
    ]);
  });

  it('a name that matches neither kind is no_match, with no results', async () => {
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = fixtureSpawn();
    await expect(findParty({ name: 'Nobody Here' })).resolves.toEqual({
      outcome: 'no_match',
      results: [],
      truncated: false,
      best: null,
      searchedFor: 'Nobody Here',
    });
  });

  it('a spawn failure on one kind is execution_failure, never no_match, and the other kind is not run', async () => {
    panePartyLookupLoaders.lock = passingLock();
    const spawn = vi.fn(async () => {
      throw new Error('Command failed: node party-lookup.mjs --request /tmp/x');
    });
    panePartyLookupLoaders.spawn = spawn;
    await expect(findParty({ name: 'ABC' })).resolves.toEqual({
      outcome: 'execution_failure',
      results: [],
      truncated: false,
      best: null,
      searchedFor: null,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('an agency failure beside a company match gives the failure, not the company', async () => {
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = vi.fn(async ({ kind, name }: { kind: string; name: string }) =>
      kind === 'company'
        ? cliForGrid('organization', name, HMS_COMPANIES)
        : { outcome: 'external_system_unavailable', candidates: [] },
    );
    await expect(findParty({ name: 'Tourvest' })).resolves.toEqual({
      outcome: 'external_system_unavailable',
      results: [],
      truncated: false,
      best: null,
      searchedFor: null,
    });
  });
});

describe('findParty: a busy HMS store is a failure too', () => {
  it('a store still busy at the timeout is execution_failure with no results, never a grid or no_match', async () => {
    panePartyLookupLoaders.lock = passingLock();
    const spawn = vi.fn(async () => runner.lookupBusyTimeout());
    panePartyLookupLoaders.spawn = spawn;
    await expect(findParty({ name: 'Tourvest' })).resolves.toEqual({
      outcome: 'execution_failure',
      results: [],
      truncated: false,
      best: null,
      searchedFor: null,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('findParty: a filter that did not apply is a failure', () => {
  it('filter-not-applied from the runner is execution_failure with no results, and no_match is never reported', async () => {
    panePartyLookupLoaders.lock = passingLock();
    const spawn = vi.fn(async () => runner.filterNotApplied());
    panePartyLookupLoaders.spawn = spawn;
    const found = await findParty({ name: 'Tourvest' });
    expect(found).toEqual({ outcome: 'execution_failure', results: [], truncated: false, best: null, searchedFor: null });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('a no_match on the other kind does not turn a failed filter into no_match', () => {
    expect(
      mergePartyKindResults([
        { outcome: 'execution_failure', results: [], truncated: false },
        { outcome: 'no_match', results: [], truncated: false },
      ]),
    ).toEqual({ outcome: 'execution_failure', results: [], truncated: false });
  });
});

describe('findParty: the 50-row load and the cap', () => {
  it('a full 50-row grid is truncated, and the candidates still come back', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      nativeId: String(3000 + i),
      displayName: `Tourvest Branch ${i}`,
      matchedOn: ['store'],
    }));
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = fixtureSpawn({ organization: rows, loaded: 50 });
    const found = await findParty({ name: 'Tourvest' });
    expect(found.truncated).toBe(true);
    expect(found.outcome).toBe('ambiguous');
    // One kind shows at most PANE_PARTY_PER_KIND_CAP rows, so the 50 companies are cut to 10.
    expect(found.results).toHaveLength(PANE_PARTY_PER_KIND_CAP);
    expect(PANE_PARTY_PER_KIND_CAP * 2).toBe(PANE_PARTY_CANDIDATE_CAP);
  });

  it('a 50-row grid with no local match is no_match, and still truncated so the pane asks for more of the name', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      nativeId: String(3000 + i),
      displayName: `Other ${i}`,
      matchedOn: ['store'],
    }));
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = fixtureSpawn({ organization: rows, loaded: 50 });
    await expect(findParty({ name: 'Tourvest' })).resolves.toEqual({
      outcome: 'no_match',
      results: [],
      truncated: true,
      best: null,
      searchedFor: 'Tourvest',
    });
  });

  it('caps a merged list at 20 and marks it truncated', () => {
    const merged = mergePartyKindResults([
      {
        outcome: 'ambiguous',
        results: Array.from({ length: 15 }, (_, i) => ({
          kind: 'company' as const,
          nativeId: String(i),
          name: `C${i}`,
        })),
        truncated: false,
      },
      {
        outcome: 'ambiguous',
        results: Array.from({ length: 15 }, (_, i) => ({
          kind: 'agency' as const,
          nativeId: `A${i}`,
          name: `A${i}`,
        })),
        truncated: false,
      },
    ]);
    expect(PANE_PARTY_CANDIDATE_CAP).toBe(20);
    expect(merged.outcome).toBe('ambiguous');
    expect(merged.results).toHaveLength(20);
    expect(merged.truncated).toBe(true);
  });
});

describe('merged list: exact and prefix matches first, one row per HMS id, each kind capped', () => {
  const companyRow = (nativeId: string, name: string) => ({ kind: 'company' as const, nativeId, name });
  const agencyRow = (nativeId: string, name: string) => ({ kind: 'agency' as const, nativeId, name });

  it('puts the exact name first, then names that start with it, and caps companies so agencies still show', () => {
    const companies = [
      companyRow('900', 'The Tourvest Group'),
      companyRow('901', 'Tourvest'),
      companyRow('902', 'Tourvest Travel'),
      ...Array.from({ length: 20 }, (_, i) => companyRow(String(1000 + i), `Other ${i}`)),
    ];
    const agencies = [agencyRow('A1', 'Agency One'), agencyRow('A2', 'Agency Two'), agencyRow('A3', 'Agency Three')];
    const merged = mergePartyKindResults(
      [
        { outcome: 'ambiguous', results: companies, truncated: false },
        { outcome: 'ambiguous', results: agencies, truncated: false },
      ],
      'Tourvest',
    );
    expect(PANE_PARTY_PER_KIND_CAP).toBe(10);
    expect(merged.results.slice(0, 3).map((row) => row.nativeId)).toEqual(['901', '902', '900']);
    expect(merged.results.filter((row) => row.kind === 'company')).toHaveLength(PANE_PARTY_PER_KIND_CAP);
    expect(merged.results.filter((row) => row.kind === 'agency').map((row) => row.nativeId)).toEqual(['A1', 'A2', 'A3']);
    expect(merged.truncated).toBe(true);
    expect(merged.outcome).toBe('ambiguous');
  });

  it('shows one row per HMS id, even when the CLI repeats a candidate', () => {
    const merged = mergePartyKindResults(
      [{ outcome: 'ambiguous', results: [companyRow('206', 'Tourvest'), companyRow('206', 'Tourvest')], truncated: false }],
      'Tourvest',
    );
    expect(merged.results).toEqual([companyRow('206', 'Tourvest')]);
    expect(merged.outcome).toBe('resolved');
  });
});

describe('panePartyFindResultFromCli and panePartyCandidates', () => {
  it('maps an ambiguous CLI grid to the pane shape with name, and keeps the runner truncation flag', () => {
    const result = panePartyFindResultFromCli('company', {
      outcome: 'ambiguous',
      candidates: [company(1), company(2)].map((c) => ({ ...c, kind: 'organization' })),
      truncated: true,
    });
    expect(result).toEqual({
      outcome: 'ambiguous',
      results: [
        { kind: 'company', nativeId: '4001', name: 'ABC Travel 1' },
        { kind: 'company', nativeId: '4002', name: 'ABC Travel 2' },
      ],
      truncated: true,
    });
  });

  it('drops candidates of the other HMS kind, or with no id or name', () => {
    const kept = panePartyCandidates('company', [
      { ...company(1), kind: 'organization' },
      { nativeId: 'TA-1', displayName: 'Agency', kind: 'bookingAgency' },
      { nativeId: '', displayName: 'No id', kind: 'organization' },
      { nativeId: '77', displayName: '   ', kind: 'organization' },
      'not an object',
      null,
    ]);
    expect(kept).toEqual([{ kind: 'company', nativeId: '4001', name: 'ABC Travel 1' }]);
  });

  it('turns a resolved or ambiguous CLI result with no usable candidate into no_match, and an unknown outcome into execution_failure', () => {
    expect(panePartyFindResultFromCli('agency', { outcome: 'resolved', candidates: [] })).toEqual({
      outcome: 'no_match',
      results: [],
      truncated: false,
    });
    expect(panePartyFindResultFromCli('agency', { outcome: 'made_up', candidates: [] })).toEqual({
      outcome: 'execution_failure',
      results: [],
      truncated: false,
    });
    expect(panePartyFindResultFromCli('agency', undefined)).toEqual({
      outcome: 'execution_failure',
      results: [],
      truncated: false,
    });
  });
});

describe('kill switch', () => {
  it('is on unless QUOTE_RATE_CONTEXT is off', () => {
    expect(quoteRateContextEnabled({})).toBe(true);
    expect(quoteRateContextEnabled({ QUOTE_RATE_CONTEXT: 'on' })).toBe(true);
    expect(quoteRateContextEnabled({ QUOTE_RATE_CONTEXT: ' OFF ' })).toBe(false);
  });
});

describe('panePartyLookup router origin guard', () => {
  it('refuses Da Vinci-origin before any lock or spawn, with the pane message', async () => {
    const seen: string[] = [];
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
      fromAddress: 'guest@example.invalid',
      toAddresses: ['centurion@legacyhotels.co.za', 'davinci@legacyhotels.co.za'],
    });
    panePartyLookupLoaders.lock = passingLock(seen);
    panePartyLookupLoaders.spawn = fixtureSpawn();
    await expect(
      mailboxCaller().panePartyLookup.findParty({ name: 'Tourvest', threadId: 'thread-dv' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
    });
    expect(seen).toEqual([]);
    expect(panePartyLookupLoaders.spawn).not.toHaveBeenCalled();
  });

  it('allows Centurion-origin and still searches HMS', async () => {
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
      fromAddress: 'guest@example.invalid',
      toAddresses: ['centurion@legacyhotels.co.za'],
    });
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = fixtureSpawn();
    await expect(
      mailboxCaller().panePartyLookup.findParty({ name: 'Tourvest', threadId: 'thread-cen' }),
    ).resolves.toMatchObject({
      outcome: 'resolved',
      best: { kind: 'company', nativeId: '206' },
    });
  });
});

describe('panePartyLookup router', () => {
  it('is a registered mutation that returns the search result, and refuses a native id, an unknown kind, or any extra key', async () => {
    vi.stubEnv('QUOTE_RATE_CONTEXT', 'off');
    await expect(mailboxCaller().panePartyLookup.findParty({ name: 'Tourvest' })).resolves.toEqual({
      outcome: 'refused_flag_off',
      results: [],
      truncated: false,
      best: null,
      searchedFor: null,
    });
    vi.stubEnv('QUOTE_RATE_CONTEXT', 'on');
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = fixtureSpawn();
    await expect(mailboxCaller().panePartyLookup.findParty({ name: '360' })).resolves.toEqual({
      outcome: 'resolved',
      results: [{ kind: 'agency', nativeId: '113', name: '360 degrees Travel' }],
      truncated: false,
      best: { kind: 'agency', nativeId: '113', name: '360 degrees Travel' },
      searchedFor: '360',
    });
    await expect(
      mailboxCaller().panePartyLookup.findParty({ name: 'ABC', nativeId: '4001' } as never),
    ).rejects.toThrow();
    await expect(
      mailboxCaller().panePartyLookup.findParty({ name: 'ABC', kind: 'bogus' } as never),
    ).rejects.toThrow();
  });
});

describe('partySearchTerms: the HMS texts to try for a name', () => {
  it('cuts the legal form, then the first distinctive word', () => {
    expect(partySearchTerms('Foschini Retail Group (pty) Ltd')).toEqual(['Foschini Retail Group', 'Foschini']);
  });

  it('keeps a bracketed acronym as a candidate', () => {
    expect(partySearchTerms('HWSETA (Health and Welfare Sector Education and Training Authority)')).toContain('HWSETA');
  });

  it('a plain name is its only term, and SA stays when it is not the last word', () => {
    expect(partySearchTerms('Woolworths')).toEqual(['Woolworths']);
    expect(partySearchTerms('SA Tours')).toEqual(['SA Tours', 'Tours']);
  });
});

describe('findParty with a kind', () => {
  beforeEach(() => resetPartyCacheForTests());

  it('searches only that kind, in one HMS run, and reports the text it used', async () => {
    panePartyLookupLoaders.lock = passingLock();
    const spawn = fixtureSpawn();
    panePartyLookupLoaders.spawn = spawn;
    const found = await findParty({ name: 'Tourvest', kind: 'company' });
    expect(spawn.mock.calls.map(([input]) => input)).toEqual([{ kind: 'company', name: 'Tourvest' }]);
    expect(found).toMatchObject({
      outcome: 'resolved',
      best: { kind: 'company', nativeId: '206' },
      searchedFor: 'Tourvest',
    });
  });

  it('falls back to the first distinctive word when the full name finds nothing, at most two runs', async () => {
    panePartyLookupLoaders.lock = passingLock();
    const spawn = vi.fn(async ({ name }: { kind: string; name: string }) =>
      name === 'Foschini'
        ? {
            outcome: 'resolved',
            candidates: [{ kind: 'organization', nativeId: '77', displayName: 'FOSCHINI GROUP LIMITED' }],
            truncated: false,
          }
        : { outcome: 'no_match', candidates: [] },
    );
    panePartyLookupLoaders.spawn = spawn;
    const found = await findParty({ name: 'Foschini Retail Group (pty) Ltd', kind: 'company' });
    expect(spawn.mock.calls.map(([input]) => input.name)).toEqual(['Foschini Retail Group', 'Foschini']);
    expect(found).toMatchObject({ outcome: 'resolved', searchedFor: 'Foschini', best: { nativeId: '77' } });
  });

  it('ranks an exact name above a row that only contains its words', async () => {
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = vi.fn(async () => ({
      outcome: 'ambiguous',
      candidates: [
        { kind: 'organization', nativeId: '1', displayName: 'Big Foschini Retail Group Holdings' },
        { kind: 'organization', nativeId: '2', displayName: 'FOSCHINI RETAIL GROUP (PTY) LTD' },
      ],
      truncated: false,
    }));
    const found = await findParty({ name: 'Foschini Retail Group (pty) Ltd', kind: 'company' });
    expect(found.best).toEqual({ kind: 'company', nativeId: '2', name: 'FOSCHINI RETAIL GROUP (PTY) LTD' });
    expect(found.results.map((row) => row.nativeId)).toEqual(['2', '1']);
    expect(found.outcome).toBe('ambiguous');
  });
});

describe('verifyPartyPick and the remembered rows', () => {
  beforeEach(() => resetPartyCacheForTests());
  afterEach(() => vi.useRealTimers());

  it('a row a search just returned binds with no HMS run', async () => {
    panePartyLookupLoaders.lock = passingLock();
    const spawn = fixtureSpawn();
    panePartyLookupLoaders.spawn = spawn;
    await findParty({ name: 'Tourvest', kind: 'company' });
    expect(spawn).toHaveBeenCalledTimes(1);
    await expect(verifyPartyPick({ kind: 'company', nativeId: '206', name: 'Tourvest Test Profile' })).resolves.toEqual({
      ok: true,
      party: { kind: 'company', nativeId: '206', name: 'Tourvest Test Profile' },
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('a remembered id with a different name still runs HMS', async () => {
    panePartyLookupLoaders.lock = passingLock();
    const spawn = fixtureSpawn();
    panePartyLookupLoaders.spawn = spawn;
    await findParty({ name: 'Tourvest', kind: 'company' });
    await expect(verifyPartyPick({ kind: 'company', nativeId: '206', name: 'Some Other Name' })).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('a remembered row expires after the TTL and HMS is asked again', async () => {
    const start = Date.parse('2026-10-09T10:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    panePartyLookupLoaders.lock = passingLock();
    const spawn = fixtureSpawn();
    panePartyLookupLoaders.spawn = spawn;
    await findParty({ name: 'Tourvest', kind: 'company' });
    vi.setSystemTime(start + PARTY_ROW_CACHE_TTL_MS - 1);
    await verifyPartyPick({ kind: 'company', nativeId: '206', name: 'Tourvest Test Profile' });
    expect(spawn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + PARTY_ROW_CACHE_TTL_MS);
    await verifyPartyPick({ kind: 'company', nativeId: '206', name: 'Tourvest Test Profile' });
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe('one name normalization for the runner and the server', () => {
  it('the server and the runner agree on every name, so a row that matches in one matches in the other', async () => {
    const { matchKey } = await import('../src/ai/party-match.js');
    const runnerKey = (runner as unknown as { matchKey: (value: string) => string }).matchKey;
    for (const sample of ['Société Générale', 'Pick ’n Pay', 'Zoë', '李明 有限公司', 'Woolworths (Pty) Ltd.', '  Tour   Vest ']) {
      expect(matchKey(sample)).toBe(runnerKey(sample));
    }
  });

  it('Societe matches Société, and Pick n Pay matches Pick ’n Pay, in the ranking', () => {
    const merged = mergePartyKindResults(
      [
        {
          outcome: 'ambiguous',
          results: [
            { kind: 'company', nativeId: '31', name: 'Pick ’n Pay Hypermarket' },
            { kind: 'company', nativeId: '32', name: 'Société Générale' },
            { kind: 'company', nativeId: '33', name: 'Unrelated Company' },
          ],
          truncated: false,
        },
      ],
      'Pick n Pay',
    );
    expect(merged.results[0]?.nativeId).toBe('31');
    const societe = mergePartyKindResults(
      [{ outcome: 'resolved', results: [{ kind: 'company', nativeId: '32', name: 'Société Générale' }], truncated: false }],
      'Societe',
    );
    expect(societe.results.map((row) => row.nativeId)).toEqual(['32']);
  });
});
