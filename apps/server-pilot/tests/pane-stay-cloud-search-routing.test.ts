import { rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { paneStayLookupLoaders, searchGuest } from '../src/ai/pane-stay-lookup.js';
import { CENTURION_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';

const cloud = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('../tooling/hms-cloud/pane-guest-search.mjs', () => ({ searchGuestInCloud: cloud.search }));

const dirs: string[] = [];
afterEach(async () => {
  paneStayLookupLoaders.enabled = null;
  paneStayLookupLoaders.spawn = null;
  cloud.search.mockReset();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('routes the mounted Centurion surname search to Cloud and returns the matching result', async () => {
  paneStayLookupLoaders.enabled = () => true;
  cloud.search.mockResolvedValue({ outcome: 'ok', screenshots: [], rows: [{
    confirmation: '123-1', lastName: 'Labtest', firstName: 'Proof', status: 'Reserved',
    arrival: '2027-09-14', departure: '2027-09-15',
  }] });
  const result = await searchGuest({ lastName: 'Labtest', arrival: '2027-09-14' }, {
    target: CENTURION_HMS_READ_TARGET,
    lock: () => ({ withLock: async (fn) => fn() }),
    onRun: ({ dir }) => { dirs.push(dir); },
  });
  expect(cloud.search).toHaveBeenCalledOnce();
  expect(cloud.search).toHaveBeenCalledWith(expect.objectContaining({
    mode: 'search-guest', lastName: 'Labtest', arrival: '2027-09-14',
  }));
  expect(result).toMatchObject({ outcome: 'ok', rows: [{ confirmation: '123-1', lastName: 'Labtest' }] });
});

it('does not run Cloud for a mismatched Centurion target', async () => {
  paneStayLookupLoaders.enabled = () => true;
  const result = await searchGuest({ lastName: 'Labtest', arrival: '2027-09-14' }, {
    target: { ...CENTURION_HMS_READ_TARGET, origin: 'https://unreviewed.invalid' },
    lock: () => ({ withLock: async (fn) => fn() }),
  });
  expect(result.outcome).toBe('execution_failure');
  expect(cloud.search).not.toHaveBeenCalled();
});
