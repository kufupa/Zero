import {
  findParty,
  findPartyJob,
  mergePartyKindResults,
  PANE_PARTY_CANDIDATE_CAP,
  PANE_PARTY_PER_KIND_CAP,
  panePartyCandidates,
  panePartyFindResultFromCli,
  panePartyLookupLoaders,
  spawnPartyLookup,
} from '../src/ai/pane-party-lookup.js';
import { lookupNativeParty } from '../src/ai/reservation-workflow-v2-native-party.js';
import { readFile } from 'node:fs/promises';
import { replaceLearnedSenderMapForTests } from '../src/ai/party-sender-map.js';
import { quoteRateContextEnabled } from '../src/ai/quote-rate-switch.js';
import { PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';
import {
  CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
  mailboxHmsOriginBindLoaders,
} from '../src/hms/mailbox-hms-origin-bind.js';
import {
  CENTURION_HMS_READ_TARGET,
  DAVINCI_HMS_READ_TARGET,
  DAVINCI_STAFF_TRANSPORT_IDS,
  hmsReadTargetForProperty,
} from '../src/hms/hms-read-target.js';
import type { PaneStayLock } from '../src/ai/pane-stay-save.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { partySearchTerms } from '../src/ai/party-match.js';
import {
  PARTY_ROW_CACHE_TTL_MS,
  resetPartyCacheForTests,
  verifyPartyPick,
} from '../src/ai/pane-party-lookup.js';

const { execFileMock } = vi.hoisted(() => {
  const execFileMock = vi.fn();
  Object.defineProperty(execFileMock, Symbol.for('nodejs.util.promisify.custom'), {
    value: (...args: unknown[]) => execFileMock(...args),
  });
  return { execFileMock };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));
vi.mock('../src/ai/reservation-workflow-v2-native-party.js', () => ({ lookupNativeParty: vi.fn() }));

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
  partyLookupPropertyCode: (request: unknown) => string | null;
  assertPartyLookupAccount: (secret: { expectedPropertyCode?: string }, propertyCode: string) => void;
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

function cliForPaneKind(
  kind: 'organization' | 'bookingAgency',
  name: string,
  grids: { organization?: typeof HMS_COMPANIES; bookingAgency?: typeof HMS_AGENCIES; loaded?: number } = {},
) {
  if (kind === 'organization') {
    return {
      kind: 'organization' as const,
      name,
      ...cliForGrid('organization', name, grids.organization ?? HMS_COMPANIES, grids.loaded),
    };
  }
  return {
    kind: 'bookingAgency' as const,
    name,
    ...cliForGrid('bookingAgency', name, grids.bookingAgency ?? HMS_AGENCIES),
  };
}

/** A spawn seam that answers each kind from its fixture grid. A batch `searches` list is one CLI envelope. */
function fixtureSpawn(
  grids: { organization?: typeof HMS_COMPANIES; bookingAgency?: typeof HMS_AGENCIES; loaded?: number } = {},
) {
  return vi.fn(async (input: {
    kind: 'organization' | 'bookingAgency';
    name: string;
    searches?: Array<{ kind: 'organization' | 'bookingAgency'; name: string }>;
  }) => {
    const items = input.searches?.length ? input.searches : [{ kind: input.kind, name: input.name }];
    const searches = items.map(({ kind, name }) => cliForPaneKind(kind, name, grids));
    if (input.searches?.length) return { searches, phaseMs: { connect: 0, login: 0, navigate: 0, search: 0 } };
    const { kind: _kind, name: _name, ...cli } = searches[0];
    return cli;
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

function mailboxCaller(activeTransportId = 'transport-centurion') {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: {
      id: 'user-ropperman',
      email: 'ropperman@legacyhotels.co.za',
      name: 'R Opperman',
    },
    activeTransportId,
    transportEmail: 'centurion@legacyhotels.co.za',
    accessRole: 'owner',
  } as never);
}

afterEach(() => {
  panePartyLookupLoaders.spawn = null;
  panePartyLookupLoaders.lock = null;
  panePartyLookupLoaders.enabled = null;
  mailboxHmsOriginBindLoaders.loadThreadOrigin = null;
  mailboxHmsOriginBindLoaders.loadThreadOriginScan = null;
  replaceLearnedSenderMapForTests(null);
  vi.mocked(lookupNativeParty).mockReset();
  execFileMock.mockReset();
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

  it('cancels a property-lock wait when only the caller signal is supplied', async () => {
    const controller = new AbortController();
    const spawn = vi.fn();
    let lockSignal: AbortSignal | undefined;
    let deadlineAt: number | undefined;
    panePartyLookupLoaders.spawn = spawn;
    panePartyLookupLoaders.lock = {
      withLock: async (_fn, acquisition) => {
        lockSignal = acquisition?.signal;
        deadlineAt = acquisition?.deadlineAt;
        return new Promise<never>((_resolve, reject) => {
          lockSignal?.addEventListener('abort', () => reject(lockSignal?.reason), { once: true });
        });
      },
    };
    const result = findParty({ name: 'ABC', kind: 'organization' }, { signal: controller.signal });
    expect(lockSignal).toBe(controller.signal);
    expect(deadlineAt).toEqual(expect.any(Number));
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
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
      results: [{ kind: 'organization', nativeId: '206', name: 'Tourvest Test Profile' }],
      truncated: false,
      best: { kind: 'organization', nativeId: '206', name: 'Tourvest Test Profile' },
      searchedFor: 'Tourvest',
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      searches: [
        { kind: 'organization', name: 'Tourvest' },
        { kind: 'bookingAgency', name: 'Tourvest' },
      ],
    }));
    expect(seen).toEqual(['lock']);
  });

  it('"360" is found as an agency, with its HMS id and name', async () => {
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = fixtureSpawn();
    await expect(findParty({ name: '360' })).resolves.toEqual({
      outcome: 'resolved',
      results: [{ kind: 'bookingAgency', nativeId: '113', name: '360 degrees Travel' }],
      truncated: false,
      best: { kind: 'bookingAgency', nativeId: '113', name: '360 degrees Travel' },
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
      { kind: 'organization', nativeId: '206', name: 'Tourvest Test Profile' },
      { kind: 'bookingAgency', nativeId: '999', name: 'Tourvest Travel Agency' },
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
    panePartyLookupLoaders.spawn = vi.fn(async (input: {
      kind: string;
      name: string;
      searches?: Array<{ kind: 'organization' | 'bookingAgency'; name: string }>;
    }) => {
      const items = input.searches?.length ? input.searches : [{ kind: input.kind, name: input.name }];
      return {
        searches: items.map(({ kind, name }) =>
          kind === 'organization'
            ? { kind: 'organization', name, ...cliForGrid('organization', name, HMS_COMPANIES) }
            : { kind: 'bookingAgency', name, outcome: 'external_system_unavailable', candidates: [] },
        ),
      };
    });
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
          kind: 'organization' as const,
          nativeId: String(i),
          name: `C${i}`,
        })),
        truncated: false,
      },
      {
        outcome: 'ambiguous',
        results: Array.from({ length: 15 }, (_, i) => ({
          kind: 'bookingAgency' as const,
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

describe('panePartyLookup.suggest rank', () => {
  it('returns body mention before learned sender history before domain, and domain stays unverified', async () => {
    replaceLearnedSenderMapForTests([
      { host: 'renniesbcdtravel.com', kind: 'bookingAgency', name: 'Harbor Travel', support: 4 },
    ]);
    await expect(
      mailboxCaller().panePartyLookup.suggest({
        sender: 'ops@renniesbcdtravel.com',
        body: 'Travel Agency Details: Northstar Group',
      }),
    ).resolves.toEqual({
      suggestions: [
        {
          source: 'body',
          kind: 'bookingAgency',
          name: 'Northstar Group',
          nativeId: null,
          idStatus: 'unverified',
        },
        {
          source: 'sender',
          kind: 'bookingAgency',
          name: 'Harbor Travel',
          nativeId: null,
          idStatus: 'unverified',
        },
        {
          source: 'sender',
          kind: 'bookingAgency',
          name: 'Rennies Travel',
          nativeId: null,
          idStatus: 'unverified',
        },
      ],
    });
  });

  it('uses the active property for learned sender suggestions', async () => {
    replaceLearnedSenderMapForTests([
      {
        propertyCode: CENTURION_HMS_READ_TARGET.propertyCode,
        host: 'agency.example',
        kind: 'bookingAgency',
        name: 'First property agency',
        support: 4,
      },
      {
        propertyCode: DAVINCI_HMS_READ_TARGET.propertyCode,
        host: 'agency.example',
        kind: 'bookingAgency',
        name: 'Second property agency',
        support: 4,
      },
    ]);

    await expect(
      mailboxCaller(DAVINCI_STAFF_TRANSPORT_IDS[0]!).panePartyLookup.suggest({
        sender: 'ops@agency.example',
        body: '',
      }),
    ).resolves.toEqual({
      suggestions: [
        { source: 'sender', kind: 'bookingAgency', name: 'Second property agency', nativeId: null, idStatus: 'unverified' },
      ],
    });
  });
});

describe('merged list: exact and prefix matches first, one row per HMS id, each kind capped', () => {
  const companyRow = (nativeId: string, name: string) => ({ kind: 'organization' as const, nativeId, name });
  const agencyRow = (nativeId: string, name: string) => ({ kind: 'bookingAgency' as const, nativeId, name });

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
    expect(merged.results.filter((row) => row.kind === 'organization')).toHaveLength(PANE_PARTY_PER_KIND_CAP);
    expect(merged.results.filter((row) => row.kind === 'bookingAgency').map((row) => row.nativeId)).toEqual(['A1', 'A2', 'A3']);
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
    const result = panePartyFindResultFromCli('organization', {
      outcome: 'ambiguous',
      candidates: [company(1), company(2)].map((c) => ({ ...c, kind: 'organization' })),
      truncated: true,
    });
    expect(result).toEqual({
      outcome: 'ambiguous',
      results: [
        { kind: 'organization', nativeId: '4001', name: 'ABC Travel 1' },
        { kind: 'organization', nativeId: '4002', name: 'ABC Travel 2' },
      ],
      truncated: true,
    });
  });

  it('keeps optional HMS grid columns on each candidate', () => {
    const kept = panePartyCandidates('bookingAgency', [
      {
        nativeId: '280',
        displayName: 'Tourvest Travel Services',
        kind: 'bookingAgency',
        iata: '12345',
        city: 'Cape Town',
        address: '1 Example Road',
        country: 'South Africa',
        externalId: 'EXT-9',
      },
    ]);
    expect(kept).toEqual([
      {
        kind: 'bookingAgency',
        nativeId: '280',
        name: 'Tourvest Travel Services',
        iata: '12345',
        city: 'Cape Town',
        address: '1 Example Road',
        country: 'South Africa',
        externalId: 'EXT-9',
      },
    ]);
  });

  it('drops candidates of the other HMS kind, or with no id or name', () => {
    const kept = panePartyCandidates('organization', [
      { ...company(1), kind: 'organization' },
      { nativeId: 'TA-1', displayName: 'Agency', kind: 'bookingAgency' },
      { nativeId: '', displayName: 'No id', kind: 'organization' },
      { nativeId: '77', displayName: '   ', kind: 'organization' },
      'not an object',
      null,
    ]);
    expect(kept).toEqual([{ kind: 'organization', nativeId: '4001', name: 'ABC Travel 1' }]);
  });

  it('turns a resolved or ambiguous CLI result with no usable candidate into no_match, and an unknown outcome into execution_failure', () => {
    expect(panePartyFindResultFromCli('bookingAgency', { outcome: 'resolved', candidates: [] })).toEqual({
      outcome: 'no_match',
      results: [],
      truncated: false,
    });
    expect(panePartyFindResultFromCli('bookingAgency', { outcome: 'made_up', candidates: [] })).toEqual({
      outcome: 'execution_failure',
      results: [],
      truncated: false,
    });
    expect(panePartyFindResultFromCli('bookingAgency', undefined)).toEqual({
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
      best: { kind: 'organization', nativeId: '206' },
    });
  });

  it('omits the origin guard only when threadId is missing (non-thread callers)', async () => {
    const loadThreadOrigin = vi.fn(async () => ({
      fromAddress: 'guest@example.invalid',
      toAddresses: ['davinci@legacyhotels.co.za'],
    }));
    mailboxHmsOriginBindLoaders.loadThreadOrigin = loadThreadOrigin;
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = fixtureSpawn();
    await expect(mailboxCaller().panePartyLookup.findParty({ name: 'Tourvest' })).resolves.toMatchObject({
      outcome: 'resolved',
      best: { kind: 'organization', nativeId: '206' },
    });
    expect(loadThreadOrigin).not.toHaveBeenCalled();
  });

  it('passes the selected message id into the origin guard', async () => {
    const loadThreadOrigin = vi.fn(async () => ({
      fromAddress: 'guest@example.invalid',
      toAddresses: ['davinci@legacyhotels.co.za'],
    }));
    mailboxHmsOriginBindLoaders.loadThreadOrigin = loadThreadOrigin;
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = fixtureSpawn();
    await expect(
      mailboxCaller().panePartyLookup.findParty({
        name: 'Tourvest',
        threadId: 'thread-mixed',
        messageId: 'msg-older-dv',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
    });
    expect(loadThreadOrigin).toHaveBeenCalledWith({
      transportId: 'transport-centurion',
      threadId: 'thread-mixed',
      messageId: 'msg-older-dv',
    });
    expect(panePartyLookupLoaders.spawn).not.toHaveBeenCalled();
  });

  it('searches HRDAV when Da Vinci reads are on, and never the Centurion slot', async () => {
    vi.stubEnv('HMS_DAVINCI_READS', 'on');
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
      fromAddress: 'guest@example.invalid',
      toAddresses: ['davinci@legacyhotels.co.za'],
    });
    const spawn = fixtureSpawn();
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = spawn;
    await expect(
      mailboxCaller().panePartyLookup.findParty({ name: 'Tourvest', threadId: 'thread-dv' }),
    ).resolves.toMatchObject({
      outcome: 'resolved',
      best: { kind: 'organization', nativeId: '206' },
    });
    expect(spawn).toHaveBeenCalled();
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ target: DAVINCI_HMS_READ_TARGET });
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
      results: [{ kind: 'bookingAgency', nativeId: '113', name: '360 degrees Travel' }],
      truncated: false,
      best: { kind: 'bookingAgency', nativeId: '113', name: '360 degrees Travel' },
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

  it('keeps optional HMS grid columns through findParty', async () => {
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = vi.fn(async () => ({
      outcome: 'resolved',
      candidates: [
        {
          kind: 'organization',
          nativeId: '206',
          displayName: 'Tourvest Test Profile',
          city: 'Cape Town',
          country: 'South Africa',
          address: '1 Example Road',
          externalId: 'EXT-1',
        },
      ],
      truncated: false,
    }));
    const found = await findParty({ name: 'Tourvest', kind: 'organization' });
    expect(found.results[0]).toEqual({
      kind: 'organization',
      nativeId: '206',
      name: 'Tourvest Test Profile',
      city: 'Cape Town',
      country: 'South Africa',
      address: '1 Example Road',
      externalId: 'EXT-1',
    });
    expect(found.best).toEqual(found.results[0]);
  });

  it('searches only that kind, in one HMS run, and reports the text it used', async () => {
    panePartyLookupLoaders.lock = passingLock();
    const spawn = fixtureSpawn();
    panePartyLookupLoaders.spawn = spawn;
    const found = await findParty({ name: 'Tourvest', kind: 'organization' });
    expect(spawn.mock.calls.map(([input]) => ({ kind: input.kind, name: input.name }))).toEqual([
      { kind: 'organization', name: 'Tourvest' },
    ]);
    expect(found).toMatchObject({
      outcome: 'resolved',
      best: { kind: 'organization', nativeId: '206' },
      searchedFor: 'Tourvest',
    });
  });

  it('falls back to the first distinctive word when the full name finds nothing, in one spawn', async () => {
    panePartyLookupLoaders.lock = passingLock();
    const spawn = vi.fn(async (input: {
      kind: string;
      name: string;
      searches?: Array<{ kind: string; name: string }>;
      stopOnFirstHit?: boolean;
    }) => {
      const items = input.searches?.length ? input.searches : [{ kind: input.kind, name: input.name }];
      return {
        searches: items.map(({ name }) =>
          name === 'Foschini'
            ? {
                kind: 'organization',
                name,
                outcome: 'resolved',
                candidates: [{ kind: 'organization', nativeId: '77', displayName: 'FOSCHINI GROUP LIMITED' }],
                truncated: false,
              }
            : { kind: 'organization', name, outcome: 'no_match', candidates: [] },
        ),
      };
    });
    panePartyLookupLoaders.spawn = spawn;
    const found = await findParty({ name: 'Foschini Retail Group (pty) Ltd', kind: 'organization' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      searches: [
        { kind: 'organization', name: 'Foschini Retail Group' },
        { kind: 'organization', name: 'Foschini' },
      ],
      stopOnFirstHit: true,
    }));
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
    const found = await findParty({ name: 'Foschini Retail Group (pty) Ltd', kind: 'organization' });
    expect(found.best).toEqual({ kind: 'organization', nativeId: '2', name: 'FOSCHINI RETAIL GROUP (PTY) LTD' });
    expect(found.results.map((row) => row.nativeId)).toEqual(['2', '1']);
    expect(found.outcome).toBe('ambiguous');
  });
});

describe('findPartyJob: V2 planned terms in one spawn', () => {
  it('runs every planned term under one lock hold and one spawn', async () => {
    const seen: string[] = [];
    const spawn = fixtureSpawn();
    panePartyLookupLoaders.lock = passingLock(seen);
    panePartyLookupLoaders.spawn = spawn;
    const found = await findPartyJob([
      { kind: 'organization', name: 'Tourvest' },
      { kind: 'bookingAgency', name: '360' },
    ]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      searches: [
        { kind: 'organization', name: 'Tourvest' },
        { kind: 'bookingAgency', name: '360' },
      ],
    }));
    expect(seen).toEqual(['lock']);
    expect(found.map((row) => row.best?.nativeId)).toEqual(['206', '113']);
  });
});

describe('Da Vinci guarded party reads', () => {
  const target = hmsReadTargetForProperty('HRDAVS');
  const transportId = 'transport-faith';
  const complete = (outcome: 'matches' | 'no_match', candidates: unknown[]) => ({
    status: 'complete' as const,
    result: { outcome, candidates, truncated: false },
    coverage: { complete: true, notes: [] },
  });

  beforeEach(() => {
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.enabled = () => true;
    resetPartyCacheForTests();
  });

  it('passes the actual transport and signal through a planned job in order', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    vi.mocked(lookupNativeParty)
      .mockResolvedValueOnce(complete('no_match', []))
      .mockResolvedValueOnce(complete('matches', [{ nativeId: '29', name: 'ABC Travel', city: 'Pretoria' }]));
    const found = await findPartyJob([
      { kind: 'organization', name: 'ABC' },
      { kind: 'bookingAgency', name: 'ABC Travel' },
    ], { target, transportId, signal });
    const calls = vi.mocked(lookupNativeParty).mock.calls.map(([input]) => input);
    expect(calls).toEqual([
      { role: 'organization', name: 'ABC', target, transportId, signal: expect.any(AbortSignal), exactTerm: true },
      { role: 'agency', name: 'ABC Travel', target, transportId, signal: expect.any(AbortSignal), exactTerm: true },
    ]);
    expect(calls[0].signal).toBe(calls[1].signal);
    controller.abort();
    expect(calls[0].signal?.aborted).toBe(true);
    expect(found).toMatchObject([
      { outcome: 'no_match', results: [], searchedFor: 'ABC' },
      { outcome: 'resolved', results: [{ kind: 'bookingAgency', nativeId: '29', name: 'ABC Travel', city: 'Pretoria' }], searchedFor: 'ABC Travel' },
    ]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('preserves fallback order and stops after the first matching term', async () => {
    const signal = new AbortController().signal;
    vi.mocked(lookupNativeParty).mockResolvedValue(complete('matches', [{ nativeId: '77', name: 'FOSCHINI GROUP LIMITED' }]));
    const found = await findParty({ name: 'Foschini Retail Group (pty) Ltd', kind: 'organization' },
      { target, transportId, signal });
    expect(lookupNativeParty).toHaveBeenCalledTimes(1);
    expect(lookupNativeParty).toHaveBeenCalledWith({
      role: 'organization', name: 'Foschini Retail Group', target, transportId, signal: expect.any(AbortSignal), exactTerm: true,
    });
    expect(found).toMatchObject({ outcome: 'resolved', searchedFor: 'Foschini Retail Group', best: { nativeId: '77' } });

    vi.mocked(lookupNativeParty).mockReset();
    vi.mocked(lookupNativeParty)
      .mockResolvedValueOnce(complete('no_match', []))
      .mockResolvedValueOnce(complete('matches', [{ nativeId: '77', name: 'FOSCHINI GROUP LIMITED' }]));
    const fallback = await findParty({ name: 'Foschini Retail Group (pty) Ltd', kind: 'organization' },
      { target, transportId, signal });
    expect(vi.mocked(lookupNativeParty).mock.calls.map(([input]) => input.name)).toEqual(['Foschini Retail Group', 'Foschini']);
    expect(fallback).toMatchObject({ outcome: 'resolved', searchedFor: 'Foschini', best: { nativeId: '77' } });
  });

  it('only exposes an agency reference as IATA when its verified type is IATA', async () => {
    vi.mocked(lookupNativeParty).mockResolvedValue(complete('matches', [
      { nativeId: '1', name: 'ABC One', referenceNumber: '12345', referenceNumberType: 'IATA' },
      { nativeId: '2', name: 'ABC Two', referenceNumber: '67890', referenceNumberType: 'TIDS' },
      { nativeId: '3', name: 'ABC Three', referenceNumber: '98765' },
    ]));
    const found = await findParty({ name: 'ABC', kind: 'bookingAgency' }, { target, transportId });
    expect(found.results).toEqual([
      { kind: 'bookingAgency', nativeId: '1', name: 'ABC One', iata: '12345' },
      { kind: 'bookingAgency', nativeId: '2', name: 'ABC Two' },
      { kind: 'bookingAgency', nativeId: '3', name: 'ABC Three' },
    ]);
  });

  it('does not turn incomplete coverage or a refusal into a clean result', async () => {
    vi.mocked(lookupNativeParty)
      .mockResolvedValueOnce({ status: 'partial', result: { outcome: 'matches', candidates: [{ nativeId: '77', name: 'ABC' }], truncated: false }, coverage: { complete: false, notes: ['unverified'] } })
      .mockResolvedValueOnce({ status: 'partial', result: { outcome: 'no_match', candidates: [], truncated: false }, coverage: { complete: false, notes: ['unverified'] } })
      .mockResolvedValueOnce({ status: 'failed', result: { outcome: 'refused_flag_off' }, coverage: { complete: false, notes: ['refused_flag_off'] } });
    const found = await findPartyJob([
      { kind: 'organization', name: 'ABC' },
      { kind: 'organization', name: 'DEF' },
      { kind: 'bookingAgency', name: 'GHI' },
    ], { target, transportId });
    expect(found.map(({ outcome, results }) => ({ outcome, results }))).toEqual([
      { outcome: 'execution_failure', results: [] },
      { outcome: 'execution_failure', results: [] },
      { outcome: 'refused_flag_off', results: [] },
    ]);
  });

  it('carries a login outage through both the per-kind and merged replies for queue parking', async () => {
    vi.mocked(lookupNativeParty).mockResolvedValue({
      status: 'failed', result: { outcome: 'execution_failure', reason: 'AUTHENTICATED_SHELL_TIMEOUT' },
      coverage: { complete: false, notes: ['AUTHENTICATED_SHELL_TIMEOUT'] },
    });
    await expect(findParty({ name: 'ABC', kind: 'organization' }, { target, transportId }))
      .resolves.toMatchObject({ outcome: 'execution_failure', error: 'AUTHENTICATED_SHELL_TIMEOUT' });
    await expect(findParty({ name: 'ABC' }, { target, transportId }))
      .resolves.toMatchObject({ outcome: 'execution_failure', error: 'AUTHENTICATED_SHELL_TIMEOUT' });
    await expect(findPartyJob([{ kind: 'organization', name: 'ABC' }], { target, transportId }))
      .resolves.toMatchObject([{ outcome: 'execution_failure', error: 'AUTHENTICATED_SHELL_TIMEOUT' }]);
  });

  it('propagates aborts and forwards transport for live pick verification', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(findParty({ name: 'ABC', kind: 'organization' }, { target, transportId, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(lookupNativeParty).not.toHaveBeenCalled();

    vi.mocked(lookupNativeParty).mockResolvedValue(complete('matches', [{ nativeId: '77', name: 'ABC' }]));
    await expect(verifyPartyPick({ kind: 'organization', nativeId: '77', name: 'ABC', target, transportId }))
      .resolves.toEqual({ ok: true, party: { kind: 'organization', nativeId: '77', name: 'ABC' } });
    expect(lookupNativeParty).toHaveBeenCalledWith(expect.objectContaining({ target, transportId }));

    resetPartyCacheForTests();
    vi.mocked(lookupNativeParty).mockResolvedValue({
      status: 'unavailable', result: { outcome: 'unavailable', reason: 'capability_unavailable' },
      coverage: { complete: false, notes: ['capability_unavailable'] },
    });
    await expect(verifyPartyPick({ kind: 'organization', nativeId: '77', name: 'ABC', target, transportId }))
      .resolves.toEqual({ ok: false, reason: 'unverified' });
  });

  it('keeps the HRCEN CLI path and request', async () => {
    execFileMock.mockImplementation(async (_executable: string, args: string[]) => {
      expect(args[0]).toContain('tooling/playwright-quote/party-lookup.mjs');
      expect(args[1]).toBe('--request');
      expect(JSON.parse(await readFile(args[2], 'utf8'))).toEqual({
        kind: 'organization', query: { organizationName: 'ABC' }, propertyCode: 'HRCEN',
      });
      return { stdout: JSON.stringify({ outcome: 'no_match', candidates: [], truncated: false }) };
    });
    await expect(spawnPartyLookup({ kind: 'organization', name: 'ABC', target: CENTURION_HMS_READ_TARGET }))
      .resolves.toEqual({ outcome: 'no_match', candidates: [], truncated: false });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(lookupNativeParty).not.toHaveBeenCalled();
  });
});

describe('verifyPartyPick property cache', () => {
  it('does not bind an HRDAV pick from a remembered HRCEN row', async () => {
    resetPartyCacheForTests();
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = fixtureSpawn();
    await findParty({ name: 'Tourvest' });
    panePartyLookupLoaders.spawn = vi.fn(async () => {
      throw new Error('HRCEN cache must not satisfy an HRDAV pick');
    });
    await expect(
      verifyPartyPick({
        kind: 'organization',
        nativeId: '206',
        name: 'Tourvest Test Profile',
        target: DAVINCI_HMS_READ_TARGET,
      }),
    ).resolves.toEqual({ ok: false, reason: 'unverified' });
    panePartyLookupLoaders.spawn = fixtureSpawn();
    await expect(
      verifyPartyPick({ kind: 'organization', nativeId: '206', name: 'Tourvest Test Profile' }),
    ).resolves.toEqual({
      ok: true,
      party: { kind: 'organization', nativeId: '206', name: 'Tourvest Test Profile' },
    });
  });
});

describe('verifyPartyPick and the remembered rows', () => {
  beforeEach(() => resetPartyCacheForTests());
  afterEach(() => vi.useRealTimers());

  it('a row a search just returned binds with no HMS run', async () => {
    panePartyLookupLoaders.lock = passingLock();
    const spawn = fixtureSpawn();
    panePartyLookupLoaders.spawn = spawn;
    await findParty({ name: 'Tourvest', kind: 'organization' });
    expect(spawn).toHaveBeenCalledTimes(1);
    await expect(verifyPartyPick({ kind: 'organization', nativeId: '206', name: 'Tourvest Test Profile' })).resolves.toEqual({
      ok: true,
      party: { kind: 'organization', nativeId: '206', name: 'Tourvest Test Profile' },
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('a remembered id with a different name still runs HMS', async () => {
    panePartyLookupLoaders.lock = passingLock();
    const spawn = fixtureSpawn();
    panePartyLookupLoaders.spawn = spawn;
    await findParty({ name: 'Tourvest', kind: 'organization' });
    await expect(verifyPartyPick({ kind: 'organization', nativeId: '206', name: 'Some Other Name' })).resolves.toEqual({
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
    await findParty({ name: 'Tourvest', kind: 'organization' });
    vi.setSystemTime(start + PARTY_ROW_CACHE_TTL_MS - 1);
    await verifyPartyPick({ kind: 'organization', nativeId: '206', name: 'Tourvest Test Profile' });
    expect(spawn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(start + PARTY_ROW_CACHE_TTL_MS);
    await verifyPartyPick({ kind: 'organization', nativeId: '206', name: 'Tourvest Test Profile' });
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
            { kind: 'organization', nativeId: '31', name: 'Pick ’n Pay Hypermarket' },
            { kind: 'organization', nativeId: '32', name: 'Société Générale' },
            { kind: 'organization', nativeId: '33', name: 'Unrelated Company' },
          ],
          truncated: false,
        },
      ],
      'Pick n Pay',
    );
    expect(merged.results[0]?.nativeId).toBe('31');
    const societe = mergePartyKindResults(
      [{ outcome: 'resolved', results: [{ kind: 'organization', nativeId: '32', name: 'Société Générale' }], truncated: false }],
      'Societe',
    );
    expect(societe.results.map((row) => row.nativeId)).toEqual(['32']);
  });
});

describe('party-lookup CLI property', () => {
  it('requires an explicit registered property and never falls back from an unknown code', () => {
    expect(runner.partyLookupPropertyCode(undefined)).toBeNull();
    expect(runner.partyLookupPropertyCode({ kind: 'organization', query: { organizationName: 'ACME' } })).toBeNull();
    expect(runner.partyLookupPropertyCode({ propertyCode: 'hrdav' })).toBe('HRDAV');
    expect(runner.partyLookupPropertyCode({ propertyCode: 'HROTH' })).toBeNull();
  });

  it('refuses a Centurion secret for an HRDAV lookup', () => {
    expect(() => runner.assertPartyLookupAccount({ expectedPropertyCode: 'HRDAV' }, 'HRDAV')).not.toThrow();
    expect(() => runner.assertPartyLookupAccount({ expectedPropertyCode: 'HRCEN' }, 'HRDAV')).toThrow(
      /ACCOUNT_PROPERTY_MISMATCH/,
    );
  });
});
