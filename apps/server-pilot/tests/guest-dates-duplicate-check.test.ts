import { afterEach, describe, expect, it } from 'vitest';
import { paneStaySaveLoaders, runPaneStay, type PaneStay } from '../src/ai/pane-stay-save.js';
import type { ReservationObservation } from '../src/hms/contracts.js';
import {
  createGuestDatesDuplicateStatus,
  createGuestDatesDuplicateVerdict,
  wirePaneStayDuplicateCheck,
  type GuestDatesDriverHandle,
  type GuestDatesSearchDeps,
} from '../src/hms/guest-dates-duplicate-check.js';
import type { GuestStaySearchResult } from '../src/hms/live-guest-stay-driver.js';
import type { SurnameDatesReservationCandidate } from '../src/hms/live-read-manifest.js';

const NOW = () => new Date('2026-10-08T00:00:00Z');
const SEARCH = { lastName: 'SMITH', arrival: '2026-12-01', departure: '2026-12-03' };

function observation(overrides: Partial<ReservationObservation> = {}): ReservationObservation {
  return {
    confirmationNumber: 'CONF1',
    externalReference: null,
    guestName: 'SMITH, JOHN',
    arrivalDate: '2026-12-01',
    departureDate: '2026-12-03',
    reservationStatus: 'RESERVED',
    roomType: 'DBL',
    ratePlan: 'BAR',
    ...overrides,
  };
}

type Behaviour = (
  candidate: SurnameDatesReservationCandidate,
  signal: AbortSignal,
) => Promise<GuestStaySearchResult>;

/** Fake driver: counts opens, searches and disposes; behaviour decides the search outcome. */
function fakeDeps(behaviour: Behaviour, extra: Partial<GuestDatesSearchDeps> = {}) {
  const log = {
    opened: 0,
    disposed: 0,
    searched: [] as SurnameDatesReservationCandidate[],
  };
  const deps: GuestDatesSearchDeps = {
    now: NOW,
    openDriver: async () => {
      log.opened += 1;
      return {
        driver: {
          searchExact: async (candidate, signal) => {
            const surnameCandidate = candidate as SurnameDatesReservationCandidate;
            log.searched.push(surnameCandidate);
            return behaviour(surnameCandidate, signal);
          },
        },
        dispose: async () => {
          log.disposed += 1;
        },
      };
    },
    ...extra,
  };
  return { deps, log };
}

const labStay: PaneStay = {
  firstName: 'Pat',
  lastName: 'Labtest',
  arrival: '2027-01-15',
  departure: '2027-01-17',
  adults: 1,
  sourceOfBusiness: 'Walk in',
  roomType: 'SUITE',
  ratePlan: 'BAR',
  track: 'BAR',
  guaranteeType: 'Awaiting Voucher',
};

describe('guest dates duplicate check', () => {
  afterEach(() => {
    paneStaySaveLoaders.spawn = null;
    paneStaySaveLoaders.lock = null;
    paneStaySaveLoaders.osressGuestDatesSearch = null;
    paneStaySaveLoaders.enabled = null;
  });

  it('reports an exact surname and dates match as a duplicate', async () => {
    const { deps, log } = fakeDeps(async () => ({
      outcome: 'matched',
      observations: [observation()],
      capped: false,
    }));
    const verdict = await createGuestDatesDuplicateVerdict(deps)(SEARCH);
    expect(verdict).toEqual({
      verdict: 'duplicate',
      reason: 'exact_match',
      matches: [
        {
          confirmation: 'CONF1',
          lastName: 'SMITH',
          firstName: 'JOHN',
          arrival: '2026-12-01',
          departure: '2026-12-03',
          status: 'RESERVED',
        },
      ],
    });
    expect(log.searched[0]).toMatchObject({
      kind: 'surname_dates',
      surname: 'SMITH',
      arrivalDate: '2026-12-01',
      departureDate: '2026-12-03',
    });
    expect(log.disposed).toBe(1);
    await expect(createGuestDatesDuplicateStatus(deps)(SEARCH)).resolves.toBe('duplicate');
  });

  it('clears when the grid has no row for the surname and dates', async () => {
    const { deps, log } = fakeDeps(async () => ({
      outcome: 'not_found',
      observations: [],
      capped: false,
    }));
    await expect(createGuestDatesDuplicateVerdict(deps)(SEARCH)).resolves.toEqual({
      verdict: 'clear',
      matches: [],
      reason: 'no_match',
    });
    expect(log.disposed).toBe(1);
    await expect(createGuestDatesDuplicateStatus(deps)(SEARCH)).resolves.toBe('clear');
  });

  it('treats several correlated rows as an ambiguous possible duplicate', async () => {
    const { deps } = fakeDeps(async () => ({
      outcome: 'ambiguous',
      observations: [
        observation({ confirmationNumber: 'A1', guestName: null }),
        observation({ confirmationNumber: 'A2', guestName: null }),
      ],
      capped: false,
    }));
    const verdict = await createGuestDatesDuplicateVerdict(deps)(SEARCH);
    expect(verdict.verdict).toBe('possible_duplicate');
    expect(verdict).toMatchObject({ reason: 'ambiguous' });
    expect(verdict.matches.map((m) => [m.confirmation, m.lastName])).toEqual([
      ['A1', null],
      ['A2', null],
    ]);
    await expect(createGuestDatesDuplicateStatus(deps)(SEARCH)).resolves.toBe('duplicate');
  });

  it('treats a capped result as a possible duplicate', async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      observation({ confirmationNumber: `C${i}`, guestName: null }),
    );
    const { deps } = fakeDeps(async () => ({
      outcome: 'ambiguous',
      observations: rows,
      capped: true,
    }));
    const verdict = await createGuestDatesDuplicateVerdict(deps)(SEARCH);
    expect(verdict).toMatchObject({ verdict: 'possible_duplicate', reason: 'capped' });
    expect(verdict.matches).toHaveLength(20);
    await expect(createGuestDatesDuplicateStatus(deps)(SEARCH)).resolves.toBe('duplicate');
  });

  it('fails closed when the search throws, and still disposes the session', async () => {
    const { deps, log } = fakeDeps(async () => {
      throw Object.assign(new Error('grid drift'), { code: 'SCHEMA_DRIFT' });
    });
    const verdict = await createGuestDatesDuplicateVerdict(deps)(SEARCH);
    expect(verdict).toEqual({
      verdict: 'possible_duplicate',
      matches: [],
      reason: 'search_error:SCHEMA_DRIFT',
    });
    expect(log.disposed).toBe(1);
    await expect(createGuestDatesDuplicateStatus(deps)(SEARCH)).resolves.toBe('duplicate');
  });

  it('fails closed when the driver cannot open, without disposing anything', async () => {
    const deps: GuestDatesSearchDeps = {
      now: NOW,
      openDriver: async () => {
        throw new Error('runtime start failed');
      },
    };
    await expect(createGuestDatesDuplicateVerdict(deps)(SEARCH)).resolves.toEqual({
      verdict: 'possible_duplicate',
      matches: [],
      reason: 'search_error:unknown',
    });
    await expect(createGuestDatesDuplicateStatus(deps)(SEARCH)).resolves.toBe('duplicate');
  });

  it('fails closed on timeout', async () => {
    const { deps } = fakeDeps(
      (_candidate, signal) =>
        new Promise<GuestStaySearchResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      { deadlineMs: 20 },
    );
    await expect(createGuestDatesDuplicateVerdict(deps)(SEARCH)).resolves.toEqual({
      verdict: 'possible_duplicate',
      matches: [],
      reason: 'timeout',
    });
  });

  it('fails closed on timeout even when the driver ignores its signal', async () => {
    const { deps, log } = fakeDeps(() => new Promise<GuestStaySearchResult>(() => undefined), {
      deadlineMs: 20,
    });
    await expect(createGuestDatesDuplicateVerdict(deps)(SEARCH)).resolves.toEqual({
      verdict: 'possible_duplicate',
      matches: [],
      reason: 'timeout',
    });
    expect(log.disposed).toBe(1);
  });

  it('closes a session that finishes opening after the deadline', async () => {
    let disposed = 0;
    const deps: GuestDatesSearchDeps = {
      now: NOW,
      deadlineMs: 10,
      openDriver: () =>
        new Promise<GuestDatesDriverHandle>((resolve) => {
          setTimeout(() => {
            resolve({
              driver: {
                searchExact: async () => ({ outcome: 'not_found', observations: [], capped: false }),
              },
              dispose: async () => {
                disposed += 1;
              },
            });
          }, 60);
        }),
    };
    await expect(createGuestDatesDuplicateVerdict(deps)(SEARCH)).resolves.toMatchObject({
      verdict: 'possible_duplicate',
      reason: 'timeout',
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(disposed).toBe(1);
  });

  it('refuses malformed or out-of-window input without opening a session', async () => {
    const { deps, log } = fakeDeps(async () => ({
      outcome: 'not_found',
      observations: [],
      capped: false,
    }));
    const verdict = createGuestDatesDuplicateVerdict(deps);
    await expect(
      verdict({ ...SEARCH, arrival: '2026-02-30' }),
    ).resolves.toMatchObject({ verdict: 'possible_duplicate', reason: 'invalid_input' });
    await expect(
      verdict({ ...SEARCH, departure: '2026-11-30' }),
    ).resolves.toMatchObject({ verdict: 'possible_duplicate', reason: 'invalid_input' });
    await expect(
      verdict({ lastName: '  ', arrival: SEARCH.arrival, departure: SEARCH.departure }),
    ).resolves.toMatchObject({ verdict: 'possible_duplicate', reason: 'invalid_input' });
    // 2027-12-01 is more than 335 days out: the OSRESS window may not cover it.
    await expect(
      verdict({ lastName: 'SMITH', arrival: '2027-12-01', departure: '2027-12-03' }),
    ).resolves.toMatchObject({ verdict: 'possible_duplicate', reason: 'outside_search_window' });
    expect(log.opened).toBe(0);
  });

  it('fails closed with the production default when HMS config is absent', async () => {
    const status = createGuestDatesDuplicateStatus({ env: {}, now: NOW });
    await expect(status(SEARCH)).resolves.toBe('duplicate');
    const verdict = await createGuestDatesDuplicateVerdict({ env: {}, now: NOW })(SEARCH);
    expect(verdict.verdict).toBe('possible_duplicate');
  });

  it('wired reader refuses commit as duplicate before any spawn', async () => {
    const { deps } = fakeDeps(async () => ({
      outcome: 'matched',
      observations: [observation({ guestName: 'LABTEST, PAT' })],
      capped: false,
    }));
    wirePaneStayDuplicateCheck(deps);
    paneStaySaveLoaders.enabled = () => true;
    paneStaySaveLoaders.lock = { withLock: async (fn) => fn() };
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn on duplicate');
    };
    await expect(runPaneStay({ mode: 'commit', stay: labStay })).resolves.toEqual({
      status: 'refused',
      reason: 'osress_duplicate',
    });
  });

  it('wired reader lets a clear search reach the lock and spawn', async () => {
    const { deps } = fakeDeps(async () => ({
      outcome: 'not_found',
      observations: [],
      capped: false,
    }));
    wirePaneStayDuplicateCheck(deps);
    paneStaySaveLoaders.enabled = () => true;
    paneStaySaveLoaders.lock = { withLock: async (fn) => fn() };
    let spawned = 0;
    paneStaySaveLoaders.spawn = async () => {
      spawned += 1;
      return { outcome: 'committed', clickedSave: true, confirmationNumber: 'C123' };
    };
    await expect(runPaneStay({ mode: 'commit', stay: labStay })).resolves.toMatchObject({
      status: 'ok',
      confirmationNumber: 'C123',
    });
    expect(spawned).toBe(1);
  });
});
