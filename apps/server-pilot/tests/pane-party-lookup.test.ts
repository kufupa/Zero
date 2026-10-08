import {
  findParty,
  PANE_PARTY_CANDIDATE_CAP,
  panePartyCandidates,
  panePartyFindResultFromCli,
  panePartyLookupLoaders,
} from '../src/ai/pane-party-lookup.js';
import { PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';
import type { PaneStayLock } from '../src/ai/pane-stay-save.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: () => {
    throw new Error('getDb must not run in pane-party-lookup tests');
  },
}));

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
  vi.unstubAllEnvs();
});

const company = (i: number) => ({
  nativeId: String(4000 + i),
  displayName: `ABC Travel ${i}`,
  kind: 'organization',
  matchedOn: ['store'],
});

describe('findParty', () => {
  it('refuses with QUOTE_RATE_CONTEXT=off before any lock or spawn', async () => {
    vi.stubEnv('QUOTE_RATE_CONTEXT', 'off');
    const seen: string[] = [];
    panePartyLookupLoaders.lock = passingLock(seen);
    panePartyLookupLoaders.spawn = async () => {
      seen.push('spawn');
      return { outcome: 'resolved', candidates: [company(1)] };
    };
    await expect(findParty({ kind: 'company', name: 'ABC' })).resolves.toEqual({
      outcome: 'refused_flag_off',
      candidates: [],
    });
    expect(seen).toEqual([]);
  });

  it('refuses a blank or over-long name before any lock or spawn', async () => {
    const seen: string[] = [];
    panePartyLookupLoaders.lock = passingLock(seen);
    panePartyLookupLoaders.spawn = async () => {
      seen.push('spawn');
      return { outcome: 'resolved', candidates: [] };
    };
    await expect(findParty({ kind: 'agency', name: '   ' })).resolves.toMatchObject({
      outcome: 'refused_input_invalid',
    });
    await expect(findParty({ kind: 'agency', name: 'x'.repeat(257) })).resolves.toMatchObject({
      outcome: 'refused_input_invalid',
    });
    expect(seen).toEqual([]);
  });

  it('refuses when no property lock can be made, with no spawn', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const spawn = vi.fn();
    panePartyLookupLoaders.spawn = spawn;
    await expect(findParty({ kind: 'company', name: 'ABC' })).resolves.toMatchObject({
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
    await expect(findParty({ kind: 'company', name: 'ABC' })).resolves.toEqual({
      outcome: 'refused_lock_busy',
      candidates: [],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('runs the lookup under the lock with the HMS kind, and returns every candidate of an ambiguous match', async () => {
    const seen: string[] = [];
    const spawn = vi.fn(async () => {
      seen.push('spawn');
      return { outcome: 'ambiguous', candidates: [company(1), company(2)] };
    });
    panePartyLookupLoaders.lock = passingLock(seen);
    panePartyLookupLoaders.spawn = spawn;
    await expect(findParty({ kind: 'company', name: ' ABC ' })).resolves.toEqual({
      outcome: 'ambiguous',
      candidates: [
        { nativeId: '4001', displayName: 'ABC Travel 1', kind: 'company' },
        { nativeId: '4002', displayName: 'ABC Travel 2', kind: 'company' },
      ],
    });
    expect(seen).toEqual(['lock', 'spawn']);
    expect(spawn).toHaveBeenCalledWith({ kind: 'company', name: 'ABC' });
  });

  it('maps a resolved agency match and carries no candidates for a failure', async () => {
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = async () => ({
      outcome: 'resolved',
      candidates: [{ nativeId: 'TA-9', displayName: 'Safari Agency', kind: 'bookingAgency' }],
    });
    await expect(findParty({ kind: 'agency', name: 'Safari' })).resolves.toEqual({
      outcome: 'resolved',
      candidates: [{ nativeId: 'TA-9', displayName: 'Safari Agency', kind: 'agency' }],
    });
    panePartyLookupLoaders.spawn = async () => ({
      outcome: 'external_system_unavailable',
      candidates: [company(1)],
    });
    await expect(findParty({ kind: 'company', name: 'ABC' })).resolves.toEqual({
      outcome: 'external_system_unavailable',
      candidates: [],
    });
  });

  it('maps a spawn failure to execution_failure with no candidates', async () => {
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = async () => {
      throw new Error('Command failed: node party-lookup.mjs --request /tmp/x');
    };
    await expect(findParty({ kind: 'company', name: 'ABC' })).resolves.toEqual({
      outcome: 'execution_failure',
      candidates: [],
    });
  });
});

describe('panePartyFindResultFromCli and panePartyCandidates', () => {
  it('caps an ambiguous list at 20 candidates and keeps the ambiguous outcome', () => {
    const many = Array.from({ length: 25 }, (_, i) => company(i));
    const result = panePartyFindResultFromCli('company', {
      outcome: 'ambiguous',
      candidates: many,
    });
    expect(PANE_PARTY_CANDIDATE_CAP).toBe(20);
    expect(result.outcome).toBe('ambiguous');
    expect(result.candidates).toHaveLength(20);
    expect(result.candidates[19]).toEqual({
      nativeId: '4019',
      displayName: 'ABC Travel 19',
      kind: 'company',
    });
  });

  it('drops candidates of the other HMS kind, or with no id or name', () => {
    const kept = panePartyCandidates('company', [
      company(1),
      { nativeId: 'TA-1', displayName: 'Agency', kind: 'bookingAgency' },
      { nativeId: '', displayName: 'No id', kind: 'organization' },
      { nativeId: '77', displayName: '   ', kind: 'organization' },
      'not an object',
      null,
    ]);
    expect(kept).toEqual([{ nativeId: '4001', displayName: 'ABC Travel 1', kind: 'company' }]);
  });

  it('turns a resolved or ambiguous CLI result with no usable candidate into no_match, and an unknown outcome into execution_failure', () => {
    expect(panePartyFindResultFromCli('agency', { outcome: 'resolved', candidates: [] })).toEqual({
      outcome: 'no_match',
      candidates: [],
    });
    expect(panePartyFindResultFromCli('agency', { outcome: 'made_up', candidates: [] })).toEqual({
      outcome: 'execution_failure',
      candidates: [],
    });
    expect(panePartyFindResultFromCli('agency', undefined)).toEqual({
      outcome: 'execution_failure',
      candidates: [],
    });
  });
});

describe('panePartyLookup router', () => {
  it('is a registered mutation that returns the find result, and refuses a native id or any extra key', async () => {
    vi.stubEnv('QUOTE_RATE_CONTEXT', 'off');
    await expect(
      mailboxCaller().panePartyLookup.findParty({ kind: 'company', name: 'ABC' }),
    ).resolves.toEqual({
      outcome: 'refused_flag_off',
      candidates: [],
    });
    vi.stubEnv('QUOTE_RATE_CONTEXT', 'on');
    panePartyLookupLoaders.lock = passingLock();
    panePartyLookupLoaders.spawn = async () => ({ outcome: 'no_match', candidates: [] });
    await expect(
      mailboxCaller().panePartyLookup.findParty({ kind: 'agency', name: 'Safari' }),
    ).resolves.toEqual({
      outcome: 'no_match',
      candidates: [],
    });
    await expect(
      mailboxCaller().panePartyLookup.findParty({
        kind: 'company',
        name: 'ABC',
        nativeId: '4001',
      } as never),
    ).rejects.toThrow();
    await expect(
      mailboxCaller().panePartyLookup.findParty({ kind: 'guest', name: 'ABC' } as never),
    ).rejects.toThrow();
  });
});
