import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildStayLookupArgs,
  findStay,
  guestDatesDuplicateCheckViaCli,
  guestDatesVerdict,
  type PaneStayFields,
  type PaneStayLookupSpawnInput,
  type PaneStayLookupSpawnResult,
  paneStayLookupEnabled,
  paneStayLookupLoaders,
} from '../src/ai/pane-stay-lookup.js';
import { type PaneStayLock, paneStaySaveLoaders } from '../src/ai/pane-stay-save.js';
import { PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';
import { appRouter } from '../src/trpc/router.js';

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: () => {
    throw new Error('getDb must not run in pane-stay-lookup tests');
  },
}));

const STAY: PaneStayFields = {
  status: 'Cancelled',
  confirmation: '57291630-1',
  lastName: 'Labtest',
  firstName: 'Nava',
  arrival: '2027-09-14',
  departure: '2027-09-15',
  nights: 1,
  adults: 1,
  children: 0,
  roomType: 'STQN',
  ratePlan: 'BAR',
  mealPlan: 'Bed & Breakfast R',
  averageRate: '2060.00',
  grandTotal: '2060.00',
  balance: '0.00',
  sourceOfBusiness: 'Walk in',
  guaranteeType: 'Non-Guaranteed Indi...',
  bookingAgency: null,
  organization: null,
};

const DUP_QUERY = { lastName: 'Labtest', arrival: '2027-09-14', departure: '2027-09-15' };

function passingLock(seen: string[] = []): PaneStayLock {
  return {
    withLock: async (fn) => {
      seen.push('lock');
      return fn();
    },
  };
}

// The error the production lock throws when its acquisition deadline passes while another run holds the lock.
function busyLockError(): Error {
  return Object.assign(new Error('property read advisory lock could not be acquired'), {
    code: 'PROPERTY_READ_LOCK_LOST',
    cause: new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE),
  });
}

function lookupResult(overrides: Partial<PaneStayLookupSpawnResult> = {}): PaneStayLookupSpawnResult {
  return {
    outcome: 'found',
    reason: null,
    stay: STAY,
    rows: [],
    screenshots: ['/tmp/pane-lookup-x/record.png'],
    ...overrides,
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

const cleanupDirs: string[] = [];

afterEach(async () => {
  paneStayLookupLoaders.spawn = null;
  paneStayLookupLoaders.lock = null;
  paneStayLookupLoaders.enabled = null;
  paneStaySaveLoaders.lock = null;
  paneStaySaveLoaders.osressGuestDatesSearch = null;
  vi.unstubAllEnvs();
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('pane stay lookup flag', () => {
  it('is on unless PANE_STAY_LOOKUP is off, and does not depend on RESERVATIONIST_PANE_SAVE', () => {
    expect(paneStayLookupEnabled({})).toBe(true);
    expect(paneStayLookupEnabled({ PANE_STAY_LOOKUP: 'on' })).toBe(true);
    expect(paneStayLookupEnabled({ PANE_STAY_LOOKUP: 'off' })).toBe(false);
    expect(paneStayLookupEnabled({ RESERVATIONIST_PANE_SAVE: 'off' })).toBe(true);
  });
});

describe('findStay', () => {
  it('refuses with PANE_STAY_LOOKUP=off before any lock or spawn', async () => {
    const seen: string[] = [];
    paneStayLookupLoaders.lock = passingLock(seen);
    paneStayLookupLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    vi.stubEnv('PANE_STAY_LOOKUP', 'off');
    await expect(findStay({ confirmation: '57291630-1' }, { lock: () => passingLock(seen) })).resolves.toEqual({
      outcome: 'refused_flag_off',
      reason: null,
      stay: null,
      arrivalMismatch: false,
      requestedArrival: null,
      hmsArrival: null,
      screenshots: [],
      runId: null,
    });
    expect(seen).toEqual([]);
  });

  it('runs without RESERVATIONIST_PANE_SAVE and validates the confirmation and arrival format', async () => {
    const calls: PaneStayLookupSpawnInput[] = [];
    paneStayLookupLoaders.lock = passingLock();
    paneStayLookupLoaders.spawn = async (input) => {
      calls.push(input);
      return lookupResult({ outcome: 'not_found', stay: null, screenshots: [] });
    };
    vi.stubEnv('RESERVATIONIST_PANE_SAVE', 'off');
    await expect(findStay({ confirmation: '57291630-1' }, { lock: () => passingLock() })).resolves.toMatchObject({
      outcome: 'not_found',
    });
    await expect(findStay({ confirmation: 'ABC' }, { lock: () => passingLock() })).resolves.toMatchObject({
      outcome: 'refused_input_invalid',
    });
    await expect(
      findStay({ confirmation: '57291630-1', arrival: '2027-02-30' }, { lock: () => passingLock() }),
    ).resolves.toMatchObject({ outcome: 'refused_input_invalid' });
    expect(calls).toEqual([{ mode: 'find', confirmation: '57291630-1', arrival: null }]);
  });

  it('has no 2027 floor: a pre-2027 arrival is looked up, not refused', async () => {
    const calls: PaneStayLookupSpawnInput[] = [];
    paneStayLookupLoaders.spawn = async (input) => {
      calls.push(input);
      return lookupResult();
    };
    await expect(
      findStay({ confirmation: '57291630-1', arrival: '2026-12-31' }, { lock: () => passingLock() }),
    ).resolves.toMatchObject({ outcome: 'found' });
    expect(calls).toEqual([{ mode: 'find', confirmation: '57291630-1', arrival: '2026-12-31' }]);
  });

  it('refuses when no property lock can be made, with no spawn', async () => {
    paneStayLookupLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(findStay({ confirmation: '57291630-1' }, { lock: () => null })).resolves.toMatchObject({
      outcome: 'refused_lock_unavailable',
    });
  });

  it('refuses refused_lock_busy when the property lock stays held past the 20 s wait, with no spawn', async () => {
    const waits: number[] = [];
    paneStayLookupLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    const busy: PaneStayLock = {
      withLock: async (_fn, acquisition) => {
        waits.push(acquisition?.deadlineAt ?? 0);
        throw busyLockError();
      },
    };
    await expect(findStay({ confirmation: '57291630-1' }, { lock: () => busy })).resolves.toMatchObject({
      outcome: 'refused_lock_busy',
    });
    const waitMs = (waits[0] ?? 0) - Date.now();
    expect(waitMs).toBeGreaterThan(19_000);
    expect(waitMs).toBeLessThanOrEqual(20_000);
  });

  it('reports busy, not duplicate, when the guest-dates check cannot get the property lock in time', async () => {
    const busy: PaneStayLock = {
      withLock: async () => {
        throw busyLockError();
      },
    };
    await expect(guestDatesDuplicateCheckViaCli(DUP_QUERY, { lock: () => busy })).resolves.toBe('busy');
  });

  it('runs the find CLI under the lock and maps a found stay with its file names', async () => {
    const seen: string[] = [];
    let registered: { runId: string; dir: string } | null = null;
    paneStayLookupLoaders.spawn = async () => {
      seen.push('spawn');
      return lookupResult({
        runId: '3f2b9c1e-6a4d-4b8e-9f00-1234567890ab',
        runDir: '/tmp/pane-lookup-3f2b9c1e-6a4d-4b8e-9f00-1234567890ab',
        screenshots: ['/tmp/pane-lookup-3f2b9c1e-6a4d-4b8e-9f00-1234567890ab/record.png'],
      });
    };
    await expect(
      findStay(
        { confirmation: '57291630-1', arrival: '2027-09-14' },
        {
          lock: () => passingLock(seen),
          onRun: (run) => {
            registered = run;
          },
        },
      ),
    ).resolves.toEqual({
      outcome: 'found',
      reason: null,
      stay: STAY,
      arrivalMismatch: false,
      requestedArrival: '2027-09-14',
      hmsArrival: '2027-09-14',
      screenshots: ['record.png'],
      runId: '3f2b9c1e-6a4d-4b8e-9f00-1234567890ab',
    });
    expect(seen).toEqual(['lock', 'spawn']);
    expect(registered).toEqual({
      runId: '3f2b9c1e-6a4d-4b8e-9f00-1234567890ab',
      dir: '/tmp/pane-lookup-3f2b9c1e-6a4d-4b8e-9f00-1234567890ab',
    });
  });

  it('the arrival is a hint: a date-change request for another day still finds the booking, and both dates are reported', async () => {
    paneStayLookupLoaders.lock = passingLock();
    paneStayLookupLoaders.spawn = async () =>
      lookupResult({ arrivalMismatch: true, requestedArrival: '2027-10-13', hmsArrival: '2027-10-12' });
    await expect(
      findStay({ confirmation: '61143613-1', arrival: '2027-10-13' }, { lock: () => passingLock() }),
    ).resolves.toMatchObject({
      outcome: 'found',
      arrivalMismatch: true,
      requestedArrival: '2027-10-13',
      hmsArrival: '2027-10-12',
    });
  });

  it('carries no stay for not_found, ambiguous or an unknown CLI outcome', async () => {
    paneStayLookupLoaders.spawn = async () => lookupResult({ outcome: 'not_found', stay: null, screenshots: [] });
    await expect(findStay({ confirmation: '57291630-1' }, { lock: () => passingLock() })).resolves.toMatchObject({
      outcome: 'not_found',
      stay: null,
    });
    paneStayLookupLoaders.spawn = async () => lookupResult({ outcome: 'ambiguous', reason: 'arrival_mismatch' });
    await expect(findStay({ confirmation: '57291630-1' }, { lock: () => passingLock() })).resolves.toMatchObject({
      outcome: 'ambiguous',
      reason: 'arrival_mismatch',
      stay: null,
    });
    paneStayLookupLoaders.spawn = async () => lookupResult({ outcome: 'ok' });
    await expect(findStay({ confirmation: '57291630-1' }, { lock: () => passingLock() })).resolves.toMatchObject({
      outcome: 'execution_failure',
      stay: null,
    });
  });

  it('maps a spawn failure to execution_failure without registering a run', async () => {
    let registered = false;
    paneStayLookupLoaders.spawn = async () => {
      throw new Error('CDP unreachable');
    };
    await expect(
      findStay({ confirmation: '57291630-1' }, { lock: () => passingLock(), onRun: () => (registered = true) }),
    ).resolves.toEqual({
      outcome: 'execution_failure',
      reason: null,
      stay: null,
      arrivalMismatch: false,
      requestedArrival: null,
      hmsArrival: null,
      screenshots: [],
      runId: null,
    });
    expect(registered).toBe(false);
  });

  it('builds the find and search-guest CLI arguments, with optional arrival and departure', () => {
    expect(buildStayLookupArgs({ mode: 'find', confirmation: '57291630-1', arrival: null }, '/tmp/run').slice(1)).toEqual([
      '--mode', 'find', '--confirmation', '57291630-1', '--out', '/tmp/run',
    ]);
    expect(buildStayLookupArgs({ mode: 'find', confirmation: '57291630-1', arrival: '2027-09-14' }, '/tmp/run').slice(-2)).toEqual([
      '--arrival', '2027-09-14',
    ]);
    const guest = buildStayLookupArgs({ mode: 'search-guest', ...DUP_QUERY }, '/tmp/run');
    expect(guest.slice(1)).toEqual([
      '--mode', 'search-guest', '--last-name', 'Labtest', '--arrival', '2027-09-14', '--out', '/tmp/run', '--departure', '2027-09-15',
    ]);
  });
});

describe('guestDatesVerdict', () => {
  const row = (overrides: Partial<{ lastName: string; arrival: string | null; departure: string | null; status: string }> = {}) => ({
    confirmation: '46184891-1',
    firstName: 'Ana',
    lastName: 'Labtest',
    status: 'Reserved',
    arrival: '2027-09-14',
    departure: '2027-09-15',
    ...overrides,
  });

  it('is a duplicate for the same surname, arrival and departure that is not Cancelled', () => {
    expect(guestDatesVerdict([row()], DUP_QUERY)).toBe('duplicate');
    expect(guestDatesVerdict([row({ lastName: 'LABTEST ' })], DUP_QUERY)).toBe('duplicate');
    expect(guestDatesVerdict([row({ status: 'Checked In' })], DUP_QUERY)).toBe('duplicate');
  });

  it('is clear when the matching row is Cancelled or differs in surname, arrival or departure', () => {
    expect(guestDatesVerdict([row({ status: 'Cancelled' })], DUP_QUERY)).toBe('clear');
    expect(guestDatesVerdict([row({ status: 'Canceled' })], DUP_QUERY)).toBe('clear');
    expect(guestDatesVerdict([row({ departure: '2027-09-16' })], DUP_QUERY)).toBe('clear');
    expect(guestDatesVerdict([row({ arrival: '2027-09-15' })], DUP_QUERY)).toBe('clear');
    expect(guestDatesVerdict([row({ lastName: 'Labtests' })], DUP_QUERY)).toBe('clear');
    expect(guestDatesVerdict([], DUP_QUERY)).toBe('clear');
  });

  it('treats a row whose departure is not shown as a duplicate, since it cannot be ruled out', () => {
    expect(guestDatesVerdict([row({ departure: null })], DUP_QUERY)).toBe('duplicate');
  });
});

describe('guestDatesDuplicateCheckViaCli', () => {
  it('runs the search-guest CLI under the lock and returns the verdict of a complete read', async () => {
    const seen: string[] = [];
    const calls: PaneStayLookupSpawnInput[] = [];
    paneStayLookupLoaders.spawn = async (input) => {
      calls.push(input);
      return lookupResult({
        outcome: 'ok',
        stay: null,
        rows: [
          {
            confirmation: '46184891-1',
            firstName: 'Ana',
            lastName: 'Labtest',
            status: 'Reserved',
            arrival: '2027-09-14',
            departure: '2027-09-15',
          },
        ],
        screenshots: [],
      });
    };
    await expect(guestDatesDuplicateCheckViaCli(DUP_QUERY, { lock: () => passingLock(seen) })).resolves.toBe('duplicate');
    expect(seen).toEqual(['lock']);
    expect(calls).toEqual([{ mode: 'search-guest', ...DUP_QUERY }]);
  });

  it('checks a Labtest stay in 2027 too: the lab guard does not skip the duplicate read', async () => {
    const calls: PaneStayLookupSpawnInput[] = [];
    paneStayLookupLoaders.spawn = async (input) => {
      calls.push(input);
      return lookupResult({ outcome: 'ok', stay: null, rows: [], screenshots: [] });
    };
    await expect(guestDatesDuplicateCheckViaCli(DUP_QUERY, { lock: () => passingLock() })).resolves.toBe('clear');
    expect(calls).toHaveLength(1);
  });

  it('is parked without a lock, with no spawn', async () => {
    paneStayLookupLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(guestDatesDuplicateCheckViaCli(DUP_QUERY, { lock: () => null })).resolves.toBe('parked');
  });

  it('fails closed to duplicate on an incomplete or failed read', async () => {
    paneStayLookupLoaders.spawn = async () => lookupResult({ outcome: 'ambiguous_capped', stay: null, rows: [], screenshots: [] });
    await expect(guestDatesDuplicateCheckViaCli(DUP_QUERY, { lock: () => passingLock() })).resolves.toBe('duplicate');
    paneStayLookupLoaders.spawn = async () => lookupResult({ outcome: 'execution_failure', stay: null, rows: [], screenshots: [] });
    await expect(guestDatesDuplicateCheckViaCli(DUP_QUERY, { lock: () => passingLock() })).resolves.toBe('duplicate');
    paneStayLookupLoaders.spawn = async () => {
      throw new Error('pane_lookup_no_result');
    };
    await expect(guestDatesDuplicateCheckViaCli(DUP_QUERY, { lock: () => passingLock() })).resolves.toBe('duplicate');
  });

  it('removes its run directory once the verdict is read, since panel screenshots show guest names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pane-lookup-dup-test-'));
    cleanupDirs.push(dir);
    await writeFile(join(dir, 'panel.png'), Buffer.from('png'));
    paneStayLookupLoaders.spawn = async () =>
      lookupResult({ outcome: 'ok', stay: null, rows: [], screenshots: [join(dir, 'panel.png')], runId: 'x', runDir: dir });
    await expect(guestDatesDuplicateCheckViaCli(DUP_QUERY, { lock: () => passingLock() })).resolves.toBe('clear');
    await expect(access(dir)).rejects.toThrow();
  });
});

describe('save path wiring', () => {
  it('assigns the CLI duplicate reader at module init unless PANE_STAY_DUP_CHECK=off', async () => {
    const saved = process.env.PANE_STAY_DUP_CHECK;
    try {
      delete process.env.PANE_STAY_DUP_CHECK;
      vi.resetModules();
      const on = await import('../src/ai/pane-stay-save.js');
      expect(typeof on.paneStaySaveLoaders.osressGuestDatesSearch).toBe('function');
      expect(on.paneStayDupCheckMode({})).toBe('cli');
      expect(on.paneStayDupCheckMode({ PANE_STAY_DUP_CHECK: 'off' })).toBe('off');
      expect(on.paneStayDupCheckMode({ PANE_STAY_DUP_CHECK: 'anything-else' })).toBe('cli');

      process.env.PANE_STAY_DUP_CHECK = 'off';
      vi.resetModules();
      const off = await import('../src/ai/pane-stay-save.js');
      expect(off.paneStaySaveLoaders.osressGuestDatesSearch).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.PANE_STAY_DUP_CHECK;
      else process.env.PANE_STAY_DUP_CHECK = saved;
      vi.resetModules();
    }
  });

  it('the wired reader takes the save path lock and spawns the search-guest CLI', async () => {
    const saved = process.env.PANE_STAY_DUP_CHECK;
    try {
      delete process.env.PANE_STAY_DUP_CHECK;
      vi.resetModules();
      const save = await import('../src/ai/pane-stay-save.js');
      const lookup = await import('../src/ai/pane-stay-lookup.js');
      const seen: string[] = [];
      const calls: PaneStayLookupSpawnInput[] = [];
      save.paneStaySaveLoaders.lock = passingLock(seen);
      lookup.paneStayLookupLoaders.spawn = async (input) => {
        calls.push(input);
        return lookupResult({ outcome: 'ok', stay: null, rows: [], screenshots: [] });
      };
      const reader = save.paneStaySaveLoaders.osressGuestDatesSearch;
      expect(reader).toBeTypeOf('function');
      await expect(reader?.(DUP_QUERY)).resolves.toBe('clear');
      expect(seen).toEqual(['lock']);
      expect(calls).toEqual([{ mode: 'search-guest', ...DUP_QUERY }]);
    } finally {
      if (saved === undefined) delete process.env.PANE_STAY_DUP_CHECK;
      else process.env.PANE_STAY_DUP_CHECK = saved;
      vi.resetModules();
    }
  });
});

describe('paneStayLookup router', () => {
  it('findStay is registered as a read-only mutation with a strict input and returns the find shape', async () => {
    paneStayLookupLoaders.lock = passingLock();
    paneStayLookupLoaders.spawn = async () => lookupResult({ runId: undefined, runDir: undefined });
    await expect(mailboxCaller().paneStayLookup.findStay({ confirmation: '57291630-1' })).resolves.toEqual({
      outcome: 'found',
      reason: null,
      stay: STAY,
      arrivalMismatch: false,
      requestedArrival: null,
      hmsArrival: '2027-09-14',
      screenshots: ['record.png'],
      runId: null,
    });
    await expect(
      mailboxCaller().paneStayLookup.findStay({ confirmation: '57291630-1', arrival: '2027-09-14' }),
    ).resolves.toMatchObject({ outcome: 'found' });
    await expect(
      mailboxCaller().paneStayLookup.findStay({ confirmation: '57291630-1', propertyCode: 'OTHER' } as never),
    ).rejects.toThrow();
    await expect(mailboxCaller().paneStayLookup.findStay({ confirmation: 'ABC' })).rejects.toThrow();
    await expect(
      mailboxCaller().paneStayLookup.findStay({ confirmation: '57291630-1', arrival: '14-SEP-2027' }),
    ).rejects.toThrow();
  });

  it('serves a lookup screenshot to its owner through the registered run, and refuses other owners and unknown runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pane-lookup-shot-test-'));
    cleanupDirs.push(dir);
    const runId = '6d1e2f3a-4b5c-4d6e-8f70-89abcdef0123';
    await writeFile(join(dir, 'record.png'), Buffer.from('png-bytes'));
    paneStayLookupLoaders.lock = passingLock();
    paneStayLookupLoaders.spawn = async () =>
      lookupResult({ runId, runDir: dir, screenshots: [join(dir, 'record.png')] });

    await expect(mailboxCaller().paneStayLookup.findStay({ confirmation: '57291630-1' })).resolves.toMatchObject({
      runId,
      screenshots: ['record.png'],
    });
    await expect(
      mailboxCaller().paneStayLookup.screenshot({ runId, name: 'record.png' }),
    ).resolves.toEqual({
      status: 'ok',
      dataUrl: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`,
    });
    await expect(
      mailboxCaller().paneStayLookup.screenshot({ runId: '00000000-0000-4000-8000-000000000000', name: 'record.png' }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'screenshot_unavailable' });
    await expect(
      mailboxCaller().paneStayLookup.screenshot({ runId, name: '../record.png' } as never),
    ).rejects.toThrow();
  });
});
