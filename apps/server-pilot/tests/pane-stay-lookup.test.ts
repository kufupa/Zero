import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildStayLookupArgs,
  classifyAmendPayment,
  findStay,
  guestDatesDuplicateCheckViaCli,
  guestDatesVerdict,
  type GuestSearchQuery,
  isGuestSurname,
  type PaneStayFields,
  type PaneStayLookupSpawnInput,
  type PaneStayLookupSpawnResult,
  paneStayLookupEnabled,
  paneStayLookupLoaders,
  searchGuest,
} from '../src/ai/pane-stay-lookup.js';
import { type PaneStayLock, paneStaySaveLoaders } from '../src/ai/pane-stay-save.js';
import { PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';
import {
  CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
  mailboxHmsOriginBindLoaders,
} from '../src/hms/mailbox-hms-origin-bind.js';
import { appRouter } from '../src/trpc/router.js';

const jobMocks = vi.hoisted(() => ({
  readHmsJobView: vi.fn(),
  queueUserHmsJob: vi.fn(),
  queueUserPartyHmsJob: vi.fn(),
  enqueueHmsBatch: vi.fn(),
}));

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: () => {
    throw new Error('getDb must not run in pane-stay-lookup tests');
  },
}));

vi.mock('../src/ai/hms-jobs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/hms-jobs.js')>()),
  readHmsJobView: jobMocks.readHmsJobView,
  queueUserHmsJob: jobMocks.queueUserHmsJob,
  queueUserPartyHmsJob: jobMocks.queueUserPartyHmsJob,
  enqueueHmsBatch: jobMocks.enqueueHmsBatch,
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
  depositReceived: null,
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

beforeEach(() => {
  mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
    fromAddress: 'guest@example.invalid',
    toAddresses: ['centurion@legacyhotels.co.za'],
  });
});

afterEach(async () => {
  jobMocks.readHmsJobView.mockReset().mockResolvedValue(null);
  jobMocks.queueUserHmsJob.mockReset();
  jobMocks.queueUserPartyHmsJob.mockReset();
  jobMocks.enqueueHmsBatch.mockReset();
  paneStayLookupLoaders.spawn = null;
  paneStayLookupLoaders.lock = null;
  paneStayLookupLoaders.enabled = null;
  paneStaySaveLoaders.lock = null;
  paneStaySaveLoaders.osressGuestDatesSearch = null;
  mailboxHmsOriginBindLoaders.loadThreadOrigin = null;
  mailboxHmsOriginBindLoaders.loadThreadOriginScan = null;
  mailboxHmsOriginBindLoaders.loadWorkItemAnchors = null;
  vi.unstubAllEnvs();
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('classifyAmendPayment', () => {
  const unpaid = {
    status: 'Reserved',
    guaranteeType: 'Non-Guaranteed Individual',
    depositReceived: '0',
  };

  it('is unpaid only for provisional + deposit 0 + non-paying guarantee', () => {
    expect(classifyAmendPayment(unpaid)).toBe('unpaid');
    expect(classifyAmendPayment({ ...unpaid, depositReceived: '0.00' })).toBe('unpaid');
    expect(classifyAmendPayment({ ...unpaid, guaranteeType: 'Non-Guaranteed Indi...' })).toBe('unpaid');
    expect(classifyAmendPayment({ ...unpaid, guaranteeType: 'None' })).toBe('unpaid');
    expect(classifyAmendPayment({ ...unpaid, depositReceived: '' })).toBe('unpaid');
  });

  it('treats a confirmed blank deposit as 0 and an unread null as unknown', () => {
    expect(classifyAmendPayment({ ...unpaid, depositReceived: '' })).toBe('unpaid');
    expect(classifyAmendPayment({ ...unpaid, depositReceived: null })).toBe('unknown');
    expect(classifyAmendPayment({ ...unpaid, depositReceived: undefined })).toBe('unknown');
  });

  it('fails closed for paid, guaranteed, and missing fields', () => {
    expect(classifyAmendPayment({ ...unpaid, depositReceived: '80.00' })).toBe('paid');
    expect(classifyAmendPayment({ ...unpaid, guaranteeType: 'Guaranteed By Agent' })).toBe('guaranteed');
    expect(classifyAmendPayment({ ...unpaid, depositReceived: null, guaranteeType: 'Guaranteed By Agent' })).not.toBe(
      'unpaid',
    );
    expect(classifyAmendPayment({ ...unpaid, guaranteeType: null })).toBe('unknown');
    expect(classifyAmendPayment({ ...unpaid, status: 'Confirmed' })).toBe('unknown');
    expect(classifyAmendPayment({ ...unpaid, status: 'Confirmed', depositReceived: '' })).not.toBe('unpaid');
  });
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

  it('passes through only populated allowlisted commercial fields for a found stay', async () => {
    paneStayLookupLoaders.spawn = async () => lookupResult({
      commercial: {
        company: { name: 'Northstar Conference Group', nativeId: 'COMP-42' },
        agency: { name: 'Harbor Travel', nativeId: 'AG-9', iata: '77206673' },
        ratePlan: 'Corporate Saver',
        status: 'Reserved',
        unknownField: 'must be dropped',
      } as never,
    });
    const result = await findStay({ confirmation: '57291630-1' }, { lock: () => passingLock() });
    expect(result).toMatchObject({
      outcome: 'found',
      commercial: {
        company: { name: 'Northstar Conference Group', nativeId: 'COMP-42' },
        agency: { name: 'Harbor Travel', nativeId: 'AG-9', iata: '77206673' },
        ratePlan: 'Corporate Saver',
        status: 'Reserved',
      },
    });
    expect(result.commercial).toEqual({
      company: { name: 'Northstar Conference Group', nativeId: 'COMP-42' },
      agency: { name: 'Harbor Travel', nativeId: 'AG-9', iata: '77206673' },
      ratePlan: 'Corporate Saver',
      status: 'Reserved',
    });
  });

  it('keeps depositReceived and guaranteeType on the found stay and commercial allow-list', async () => {
    paneStayLookupLoaders.spawn = async () =>
      lookupResult({
        stay: { ...STAY, guaranteeType: 'Non-Guaranteed Individual', depositReceived: '0.00' },
        commercial: { guaranteeType: 'Non-Guaranteed Individual', depositReceived: '0.00', unknownField: 'drop' } as never,
      });
    const result = await findStay({ confirmation: '57291630-1' }, { lock: () => passingLock() });
    expect(result.stay).toMatchObject({
      guaranteeType: 'Non-Guaranteed Individual',
      depositReceived: '0.00',
    });
    expect(result.commercial).toEqual({
      guaranteeType: 'Non-Guaranteed Individual',
      depositReceived: '0.00',
    });
  });

  it('keeps an agency identified only by IATA in the commercial fields', async () => {
    paneStayLookupLoaders.spawn = async () =>
      lookupResult({ commercial: { agency: { iata: '77206673' } } });
    const result = await findStay({ confirmation: '57291630-1' }, { lock: () => passingLock() });
    expect(result.commercial?.agency).toEqual({ iata: '77206673' });
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
  it('runs the search-guest CLI without taking a lock, and returns the verdict of a complete read', async () => {
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
    await expect(guestDatesDuplicateCheckViaCli(DUP_QUERY)).resolves.toBe('duplicate');
    expect(calls).toEqual([{ mode: 'search-guest', ...DUP_QUERY }]);
  });

  it('checks a Labtest stay in 2027 too: the lab guard does not skip the duplicate read', async () => {
    const calls: PaneStayLookupSpawnInput[] = [];
    paneStayLookupLoaders.spawn = async (input) => {
      calls.push(input);
      return lookupResult({ outcome: 'ok', stay: null, rows: [], screenshots: [] });
    };
    await expect(guestDatesDuplicateCheckViaCli(DUP_QUERY)).resolves.toBe('clear');
    expect(calls).toHaveLength(1);
  });

  it('fails closed to duplicate on an incomplete or failed read', async () => {
    paneStayLookupLoaders.spawn = async () => lookupResult({ outcome: 'ambiguous_capped', stay: null, rows: [], screenshots: [] });
    await expect(guestDatesDuplicateCheckViaCli(DUP_QUERY)).resolves.toBe('duplicate');
    paneStayLookupLoaders.spawn = async () => lookupResult({ outcome: 'execution_failure', stay: null, rows: [], screenshots: [] });
    await expect(guestDatesDuplicateCheckViaCli(DUP_QUERY)).resolves.toBe('duplicate');
    paneStayLookupLoaders.spawn = async () => {
      throw new Error('pane_lookup_no_result');
    };
    await expect(guestDatesDuplicateCheckViaCli(DUP_QUERY)).resolves.toBe('duplicate');
  });

  it('removes its run directory once the verdict is read, since panel screenshots show guest names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pane-lookup-dup-test-'));
    cleanupDirs.push(dir);
    await writeFile(join(dir, 'panel.png'), Buffer.from('png'));
    paneStayLookupLoaders.spawn = async () =>
      lookupResult({ outcome: 'ok', stay: null, rows: [], screenshots: [join(dir, 'panel.png')], runId: 'x', runDir: dir });
    await expect(guestDatesDuplicateCheckViaCli(DUP_QUERY)).resolves.toBe('clear');
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

  it('the wired reader spawns the search-guest CLI without taking a lock', async () => {
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
      expect(seen).toEqual([]);
      expect(calls).toEqual([{ mode: 'search-guest', ...DUP_QUERY }]);
    } finally {
      if (saved === undefined) delete process.env.PANE_STAY_DUP_CHECK;
      else process.env.PANE_STAY_DUP_CHECK = saved;
      vi.resetModules();
    }
  });
});

describe('paneStayLookup router origin guard', () => {
  it('queueFind refuses Da Vinci-origin and does not enqueue', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
      fromAddress: 'guest@example.invalid',
      toAddresses: ['centurion@legacyhotels.co.za', 'davinci@legacyhotels.co.za'],
    });
    jobMocks.queueUserHmsJob.mockResolvedValue({ id: 'should-not-enqueue' });
    await expect(
      mailboxCaller().paneStayLookup.queueFind({
        threadId: 'thread-dv',
        confirmation: '57291630-1',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
    });
    expect(jobMocks.queueUserHmsJob).not.toHaveBeenCalled();
  });

  it('queueFind allows Centurion-origin and enqueues', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
      fromAddress: 'guest@example.invalid',
      toAddresses: ['centurion@legacyhotels.co.za'],
    });
    jobMocks.queueUserHmsJob.mockResolvedValue({ id: 'run-queued' });
    await expect(
      mailboxCaller().paneStayLookup.queueFind({
        threadId: 'thread-cen',
        confirmation: '57291630-1',
      }),
    ).resolves.toEqual({ runId: 'run-queued' });
    expect(jobMocks.queueUserHmsJob).toHaveBeenCalledTimes(1);
  });

  it('findStay refuses Da Vinci-origin before any lock or spawn', async () => {
    const seen: string[] = [];
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
      fromAddress: 'guest@example.invalid',
      toAddresses: ['centurion@legacyhotels.co.za', 'davinci@legacyhotels.co.za'],
    });
    paneStayLookupLoaders.lock = passingLock(seen);
    paneStayLookupLoaders.spawn = vi.fn(async () => lookupResult());
    await expect(
      mailboxCaller().paneStayLookup.findStay({
        confirmation: '57291630-1',
        threadId: 'thread-dv',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
    });
    expect(seen).toEqual([]);
    expect(paneStayLookupLoaders.spawn).not.toHaveBeenCalled();
  });

  it('searchGuest refuses Da Vinci-origin before any lock or spawn', async () => {
    const seen: string[] = [];
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
      fromAddress: 'guest@example.invalid',
      toAddresses: ['davinci@legacyhotels.co.za'],
    });
    paneStayLookupLoaders.lock = passingLock(seen);
    paneStayLookupLoaders.spawn = vi.fn(async () => lookupResult({ outcome: 'ok', stay: null, rows: [] }));
    await expect(
      mailboxCaller().paneStayLookup.searchGuest({
        lastName: 'Mokoena',
        arrival: '2027-09-14',
        threadId: 'thread-dv',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
    });
    expect(seen).toEqual([]);
    expect(paneStayLookupLoaders.spawn).not.toHaveBeenCalled();
  });

  it('findStay omits the origin guard when threadId is missing', async () => {
    const loadThreadOrigin = vi.fn(async () => ({
      fromAddress: 'guest@example.invalid',
      toAddresses: ['davinci@legacyhotels.co.za'],
    }));
    mailboxHmsOriginBindLoaders.loadThreadOrigin = loadThreadOrigin;
    paneStayLookupLoaders.lock = passingLock();
    paneStayLookupLoaders.spawn = async () => lookupResult();
    await expect(
      mailboxCaller().paneStayLookup.findStay({ confirmation: '57291630-1' }),
    ).resolves.toMatchObject({ outcome: 'found' });
    expect(loadThreadOrigin).not.toHaveBeenCalled();
  });

  it('queueSearchGuest refuses Da Vinci-origin and does not enqueue', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
      fromAddress: 'guest@example.invalid',
      toAddresses: ['davinci@legacyhotels.co.za'],
    });
    jobMocks.queueUserHmsJob.mockResolvedValue({ id: 'should-not-enqueue' });
    await expect(
      mailboxCaller().paneStayLookup.queueSearchGuest({
        threadId: 'thread-dv',
        lastName: 'Mokoena',
        arrival: '2027-09-14',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
    });
    expect(jobMocks.queueUserHmsJob).not.toHaveBeenCalled();
  });

  it('queueParty refuses Da Vinci-origin and does not enqueue', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
      fromAddress: 'guest@example.invalid',
      toAddresses: ['davinci@legacyhotels.co.za'],
    });
    jobMocks.queueUserPartyHmsJob.mockResolvedValue({ id: 'should-not-enqueue' });
    await expect(
      mailboxCaller().paneStayLookup.queueParty({
        threadId: 'thread-dv',
        name: 'Acme',
        partyKind: 'agency',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
    });
    expect(jobMocks.queueUserPartyHmsJob).not.toHaveBeenCalled();
  });

  it('findStay and queueFind pass the selected message id into the origin guard', async () => {
    const seen: Array<{ threadId: string; messageId?: string }> = [];
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async (input) => {
      seen.push({ threadId: input.threadId, messageId: input.messageId });
      return {
        fromAddress: 'guest@example.invalid',
        toAddresses: ['davinci@legacyhotels.co.za'],
      };
    };
    paneStayLookupLoaders.spawn = vi.fn(async () => lookupResult());
    jobMocks.queueUserHmsJob.mockResolvedValue({ id: 'should-not-enqueue' });
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    await expect(
      mailboxCaller().paneStayLookup.findStay({
        confirmation: '57291630-1',
        threadId: 'thread-mixed',
        messageId: 'msg-older-dv',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
    });
    await expect(
      mailboxCaller().paneStayLookup.queueFind({
        threadId: 'thread-mixed',
        confirmation: '57291630-1',
        messageId: 'msg-older-dv',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: CENTURION_HMS_ORIGIN_REFUSED_MESSAGE,
    });
    expect(seen).toEqual([
      { threadId: 'thread-mixed', messageId: 'msg-older-dv' },
      { threadId: 'thread-mixed', messageId: 'msg-older-dv' },
    ]);
    expect(paneStayLookupLoaders.spawn).not.toHaveBeenCalled();
    expect(jobMocks.queueUserHmsJob).not.toHaveBeenCalled();
  });

  it('queueBatch skips Da Vinci-origin items before enqueue and still queues Centurion items', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    const dvItem = '11111111-1111-4111-8111-111111111111';
    const cenItem = '22222222-2222-4222-8222-222222222222';
    const batchId = '33333333-3333-4333-8333-333333333333';
    const order: string[] = [];
    mailboxHmsOriginBindLoaders.loadWorkItemAnchors = async () => [
      { workItemId: dvItem, threadId: 'thread-dv', messageId: 'msg-dv' },
      { workItemId: cenItem, threadId: 'thread-cen', messageId: 'msg-cen' },
    ];
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async (input) => {
      order.push(`origin:${input.threadId}:${input.messageId ?? ''}`);
      return {
        fromAddress: 'guest@example.invalid',
        toAddresses:
          input.threadId === 'thread-dv'
            ? ['davinci@legacyhotels.co.za']
            : ['centurion@legacyhotels.co.za'],
      };
    };
    jobMocks.enqueueHmsBatch.mockImplementation(async (input) => {
      order.push('enqueue');
      return {
        batchId: input.batchId,
        status: 'queued',
        summary: {
          total: input.workItemIds.length,
          queued: input.workItemIds.length,
          running: 0,
          retrying: 0,
          done: 0,
          failed: 0,
          cancelled: 0,
          skipped: 0,
          reused: 0,
        },
        items: [],
      };
    });
    await expect(
      mailboxCaller().paneStayLookup.queueBatch({
        batchId,
        workItemIds: [dvItem, cenItem],
      }),
    ).resolves.toMatchObject({ batchId, status: 'queued' });
    expect(order).toEqual([
      'origin:thread-dv:msg-dv',
      'origin:thread-cen:msg-cen',
      'enqueue',
    ]);
    expect(jobMocks.enqueueHmsBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId,
        transportId: 'transport-1',
        userId: 'user-ropperman',
        workItemIds: [dvItem, cenItem],
        originRefusedWorkItemIds: [dvItem],
      }),
    );
  });

  it('queueBatch still enqueues when every item is Centurion-origin', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    const cenItem = '22222222-2222-4222-8222-222222222222';
    const batchId = '33333333-3333-4333-8333-333333333333';
    mailboxHmsOriginBindLoaders.loadWorkItemAnchors = async () => [
      { workItemId: cenItem, threadId: 'thread-cen', messageId: 'msg-cen' },
    ];
    mailboxHmsOriginBindLoaders.loadThreadOrigin = async () => ({
      fromAddress: 'guest@example.invalid',
      toAddresses: ['centurion@legacyhotels.co.za'],
    });
    jobMocks.enqueueHmsBatch.mockResolvedValue({
      batchId,
      status: 'queued',
      summary: {
        total: 1,
        queued: 1,
        running: 0,
        retrying: 0,
        done: 0,
        failed: 0,
        cancelled: 0,
        skipped: 0,
        reused: 0,
      },
      items: [],
    });
    await expect(
      mailboxCaller().paneStayLookup.queueBatch({
        batchId,
        workItemIds: [cenItem],
      }),
    ).resolves.toMatchObject({ batchId });
    expect(jobMocks.enqueueHmsBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemIds: [cenItem],
        originRefusedWorkItemIds: [],
      }),
    );
  });
});

describe('paneStayLookup router', () => {
  it('threads the authenticated user into run-id job status reads for staff-quote ownership checks', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', 'on');
    const runId = '3f2b9c1e-6a4d-4b8e-9f00-1234567890ab';

    await expect(mailboxCaller().paneStayLookup.jobStatus({ runId })).resolves.toBeNull();

    expect(jobMocks.readHmsJobView).toHaveBeenCalledWith({
      transportId: 'transport-1',
      runId,
      staffQuoteOwnerId: 'user-ropperman',
    });
  });

  it('with HMS_JOB_QUEUE unset, the queue routes queue nothing and jobStatus reads nothing', async () => {
    vi.stubEnv('HMS_JOB_QUEUE', '');
    const spawn = vi.fn(async () => lookupResult());
    paneStayLookupLoaders.spawn = spawn;
    const caller = mailboxCaller();
    await expect(caller.paneStayLookup.jobQueueEnabled()).resolves.toBe(false);
    await expect(caller.paneStayLookup.queueFind({ threadId: 'thread-1', confirmation: '57291630-1' })).resolves.toEqual({
      runId: null,
    });
    await expect(
      caller.paneStayLookup.queueFind({ threadId: 'thread-1', confirmation: '57291630-1', autoStart: true }),
    ).resolves.toEqual({ runId: null });
    await expect(
      caller.paneStayLookup.queueSearchGuest({ threadId: 'thread-1', lastName: 'Mokoena', arrival: '2027-09-14' }),
    ).resolves.toEqual({ runId: null });
    await expect(
      caller.paneStayLookup.queueSearchGuest({
        threadId: 'thread-1',
        lastName: 'Mokoena',
        arrival: '2027-09-14',
        autoStart: true,
      }),
    ).resolves.toEqual({ runId: null });
    await expect(
      caller.paneStayLookup.queueParty({
        threadId: 'thread-1',
        name: 'Acme Travel',
        partyKind: 'company',
      }),
    ).resolves.toEqual({ runId: null });
    await expect(
      caller.paneStayLookup.queueSearchGuest({
        threadId: 'thread-1',
        lastName: 'Mokoena',
        arrival: '2027-09-14',
        departure: '2027-09-15',
        autoStart: true,
      }),
    ).rejects.toThrow();
    await expect(
      caller.paneStayLookup.jobStatus({ threadId: 'thread-1', kind: 'find', confirmation: '57291630-1' }),
    ).resolves.toBeNull();
    await expect(
      caller.paneStayLookup.jobStatus({
        threadId: 'thread-1',
        kind: 'search_guest',
        lastName: 'Mokoena',
        arrival: '2027-09-14',
        departure: null,
      }),
    ).resolves.toBeNull();
    await expect(
      caller.paneStayLookup.jobStatus({
        threadId: 'thread-1',
        kind: 'party',
        name: 'Acme Travel',
        partyKind: 'company',
      }),
    ).resolves.toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

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

const SEARCH_ROW = {
  confirmation: '46184891-1',
  firstName: 'Ana',
  lastName: 'Labtest',
  status: 'Reserved',
  arrival: '2027-09-14',
  departure: '2027-09-15',
};

describe('searchGuest', () => {
  it('accepts letters, spaces, apostrophes and hyphens in a 2 to 40 character surname, and nothing else', () => {
    for (const ok of ["O'Brien", 'Smith-Jones', 'De la Rey', 'Müller', 'Li']) expect(isGuestSurname(ok)).toBe(true);
    for (const bad of ['L', '', '-Labtest', 'Labtest-', 'Labtest2', 'Labtest.', 'A'.repeat(41)]) {
      expect(isGuestSurname(bad)).toBe(false);
    }
  });

  it('refuses bad input before any lock or spawn: surname shape, real ISO dates, departure after arrival', async () => {
    const seen: string[] = [];
    paneStayLookupLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    const bad: GuestSearchQuery[] = [
      { lastName: 'X', arrival: '2027-09-14' },
      { lastName: '-Smith', arrival: '2027-09-14' },
      { lastName: 'Labtest', arrival: '2027-02-30' },
      { lastName: 'Labtest', arrival: '14-SEP-2027' },
      { lastName: 'Labtest', arrival: '2027-09-14', departure: '2027-09-14' },
      { lastName: 'Labtest', arrival: '2027-09-14', departure: '2027-09-13' },
    ];
    for (const input of bad) {
      await expect(searchGuest(input, { lock: () => passingLock(seen) })).resolves.toEqual({
        outcome: 'refused_input_invalid',
        rows: [],
        screenshots: [],
        runId: null,
      });
    }
    expect(seen).toEqual([]);
  });

  it('refuses refused_flag_off with no spawn, and refused_lock_unavailable when no lock can be made', async () => {
    paneStayLookupLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    vi.stubEnv('PANE_STAY_LOOKUP', 'off');
    await expect(searchGuest(DUP_QUERY, { lock: () => passingLock() })).resolves.toMatchObject({
      outcome: 'refused_flag_off',
      rows: [],
    });
    vi.stubEnv('PANE_STAY_LOOKUP', 'on');
    await expect(searchGuest(DUP_QUERY, { lock: () => null })).resolves.toMatchObject({
      outcome: 'refused_lock_unavailable',
      rows: [],
    });
  });

  it('runs the search CLI under the lock and returns the complete rows of an ok read, dropping rows with no confirmation', async () => {
    const seen: string[] = [];
    const calls: PaneStayLookupSpawnInput[] = [];
    let registered: { runId: string; dir: string } | null = null;
    paneStayLookupLoaders.spawn = async (input) => {
      seen.push('spawn');
      calls.push(input);
      return lookupResult({
        outcome: 'ok',
        stay: null,
        rows: [
          SEARCH_ROW,
          { ...SEARCH_ROW, confirmation: '46184892-1', status: 'Cancelled' },
          { ...SEARCH_ROW, confirmation: '   ' },
          null as never,
        ],
        screenshots: ['/tmp/pane-lookup-s/panel.png'],
        runId: 'run-search-1',
        runDir: '/tmp/pane-lookup-s',
      });
    };
    await expect(
      searchGuest(DUP_QUERY, {
        lock: () => passingLock(seen),
        onRun: (run) => {
          registered = run;
        },
      }),
    ).resolves.toEqual({
      outcome: 'ok',
      rows: [
        SEARCH_ROW,
        { ...SEARCH_ROW, confirmation: '46184892-1', status: 'Cancelled' },
      ],
      screenshots: ['panel.png'],
      runId: 'run-search-1',
    });
    expect(seen).toEqual(['lock', 'spawn']);
    expect(calls).toEqual([{ mode: 'search-guest', ...DUP_QUERY }]);
    expect(registered).toEqual({ runId: 'run-search-1', dir: '/tmp/pane-lookup-s' });
  });

  it('returns only the rows on the requested arrival, and on the requested departure when one is given', async () => {
    const row = (confirmation: string, arrival: string, departure: string | null) => ({
      confirmation,
      lastName: 'Labtest',
      firstName: 'Guest',
      status: 'Reserved',
      arrival,
      departure,
    });
    paneStayLookupLoaders.spawn = async () =>
      lookupResult({
        outcome: 'ok',
        stay: null,
        rows: [
          row('1-1', '2027-09-14', '2027-09-15'),
          row('1-2', '2027-09-20', '2027-09-21'),
          row('1-3', '2027-09-14', '2027-09-17'),
          row('1-4', '2027-09-14', null),
        ],
        screenshots: [],
      });
    const onArrival = await searchGuest({ lastName: 'Labtest', arrival: '2027-09-14' }, { lock: () => passingLock() });
    expect(onArrival.rows.map((item) => item.confirmation)).toEqual(['1-1', '1-3', '1-4']);
    const onDates = await searchGuest(
      { lastName: 'Labtest', arrival: '2027-09-14', departure: '2027-09-15' },
      { lock: () => passingLock() },
    );
    expect(onDates.rows.map((item) => item.confirmation)).toEqual(['1-1']);
  });

  it('passes no departure to the CLI when the search has none', async () => {
    const calls: PaneStayLookupSpawnInput[] = [];
    paneStayLookupLoaders.spawn = async (input) => {
      calls.push(input);
      return lookupResult({ outcome: 'ok', stay: null, rows: [], screenshots: [] });
    };
    await expect(searchGuest({ lastName: 'Labtest', arrival: '2027-09-14' }, { lock: () => passingLock() })).resolves.toEqual({
      outcome: 'ok',
      rows: [],
      screenshots: [],
      runId: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ mode: 'search-guest', lastName: 'Labtest', arrival: '2027-09-14' });
    expect(calls[0]).not.toHaveProperty('departure');
  });

  it('reports ambiguous_capped with no rows, so a partial list is never picked from', async () => {
    paneStayLookupLoaders.spawn = async () =>
      lookupResult({ outcome: 'ambiguous_capped', stay: null, rows: [SEARCH_ROW], screenshots: [] });
    await expect(searchGuest(DUP_QUERY, { lock: () => passingLock() })).resolves.toEqual({
      outcome: 'ambiguous_capped',
      rows: [],
      screenshots: [],
      runId: null,
    });
  });

  it('refuses refused_lock_busy when the property lock stays held, and maps a spawn failure or an unknown outcome to execution_failure', async () => {
    paneStayLookupLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    const busy: PaneStayLock = {
      withLock: async () => {
        throw busyLockError();
      },
    };
    await expect(searchGuest(DUP_QUERY, { lock: () => busy })).resolves.toMatchObject({
      outcome: 'refused_lock_busy',
      rows: [],
    });
    paneStayLookupLoaders.spawn = async () => {
      throw new Error('CDP unreachable');
    };
    await expect(searchGuest(DUP_QUERY, { lock: () => passingLock() })).resolves.toMatchObject({
      outcome: 'execution_failure',
      rows: [],
    });
    paneStayLookupLoaders.spawn = async () => lookupResult({ outcome: 'found', rows: [SEARCH_ROW], screenshots: [] });
    await expect(searchGuest(DUP_QUERY, { lock: () => passingLock() })).resolves.toEqual({
      outcome: 'execution_failure',
      rows: [],
      screenshots: [],
      runId: null,
    });
  });
});

describe('paneStayLookup.searchGuest route', () => {
  it('returns the rows of an ok read, and serves its panel screenshot to the owner who ran it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pane-lookup-search-test-'));
    cleanupDirs.push(dir);
    const runId = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203';
    await writeFile(join(dir, 'panel.png'), Buffer.from('panel-bytes'));
    paneStayLookupLoaders.lock = passingLock();
    paneStayLookupLoaders.spawn = async () =>
      lookupResult({ outcome: 'ok', stay: null, rows: [SEARCH_ROW], runId, runDir: dir, screenshots: [join(dir, 'panel.png')] });

    await expect(
      mailboxCaller().paneStayLookup.searchGuest({ lastName: 'Labtest', arrival: '2027-09-14', departure: '2027-09-15' }),
    ).resolves.toEqual({ outcome: 'ok', rows: [SEARCH_ROW], screenshots: ['panel.png'], runId });
    await expect(mailboxCaller().paneStayLookup.screenshot({ runId, name: 'panel.png' })).resolves.toEqual({
      status: 'ok',
      dataUrl: `data:image/png;base64,${Buffer.from('panel-bytes').toString('base64')}`,
    });
  });

  it('returns ambiguous_capped with no rows, and the refusals with no rows', async () => {
    paneStayLookupLoaders.lock = passingLock();
    paneStayLookupLoaders.spawn = async () =>
      lookupResult({ outcome: 'ambiguous_capped', stay: null, rows: [SEARCH_ROW], screenshots: [] });
    await expect(
      mailboxCaller().paneStayLookup.searchGuest({ lastName: 'Labtest', arrival: '2027-09-14' }),
    ).resolves.toEqual({ outcome: 'ambiguous_capped', rows: [], screenshots: [], runId: null });

    paneStayLookupLoaders.lock = { withLock: async () => { throw busyLockError(); } };
    await expect(
      mailboxCaller().paneStayLookup.searchGuest({ lastName: 'Labtest', arrival: '2027-09-14' }),
    ).resolves.toMatchObject({ outcome: 'refused_lock_busy', rows: [] });

    vi.stubEnv('PANE_STAY_LOOKUP', 'off');
    await expect(
      mailboxCaller().paneStayLookup.searchGuest({ lastName: 'Labtest', arrival: '2027-09-14' }),
    ).resolves.toMatchObject({ outcome: 'refused_flag_off', rows: [] });
  });

  it('rejects a bad surname, a bad date, or an extra key before any run, and refuses a departure before arrival', async () => {
    paneStayLookupLoaders.lock = passingLock();
    paneStayLookupLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    const caller = mailboxCaller().paneStayLookup;
    await expect(caller.searchGuest({ lastName: 'L', arrival: '2027-09-14' })).rejects.toThrow();
    await expect(caller.searchGuest({ lastName: 'Labtest1', arrival: '2027-09-14' })).rejects.toThrow();
    await expect(caller.searchGuest({ lastName: '-Labtest', arrival: '2027-09-14' })).rejects.toThrow();
    await expect(caller.searchGuest({ lastName: 'Labtest', arrival: '14-SEP-2027' })).rejects.toThrow();
    await expect(caller.searchGuest({ lastName: 'Labtest', arrival: '2027-09-14', departure: 'soon' })).rejects.toThrow();
    await expect(
      caller.searchGuest({ lastName: 'Labtest', arrival: '2027-09-14', propertyCode: 'OTHER' } as never),
    ).rejects.toThrow();
    await expect(caller.searchGuest({ lastName: 'Labtest', arrival: '2027-09-14', departure: '2027-09-13' })).resolves.toMatchObject({
      outcome: 'refused_input_invalid',
      rows: [],
    });
  });
});
