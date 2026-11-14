import { rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { paneStayLookupLoaders, searchGuest, searchGuestCloudBatch } from '../src/ai/pane-stay-lookup.js';
import { CENTURION_HMS_READ_TARGET, hmsReadTargetForProperty } from '../src/hms/hms-read-target.js';

const cloud = vi.hoisted(() => ({ search: vi.fn(), guard: vi.fn(), session: vi.fn() }));
vi.mock('../tooling/hms-cloud/pane-guest-search.mjs', () => ({ searchGuestInCloud: cloud.search, installGuestLookupGuard: cloud.guard }));
vi.mock('../tooling/hms-cloud/cloud-session.mjs', () => ({ withCloudReadSession: cloud.session }));

const dirs: string[] = [];
afterEach(async () => {
  paneStayLookupLoaders.enabled = null;
  paneStayLookupLoaders.spawn = null;
  cloud.search.mockReset();
  cloud.guard.mockReset();
  cloud.session.mockReset();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('routes the mounted Centurion surname search to Cloud and returns the matching result', async () => {
  paneStayLookupLoaders.enabled = () => true;
  cloud.search.mockResolvedValue({ propertyCode: 'HRCEN', outcome: 'ok', screenshots: [], rows: [{
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

it('uses one verified HRDAVS session for serial guest searches and rejects mismatched targets', async () => {
  paneStayLookupLoaders.enabled = () => true;
  const target = hmsReadTargetForProperty('HRDAVS');
  const identity = { propertyCode: 'HRDAVS', tenantId: 'DAVINCI_PRD', landingPropertyCode: 'HRDAV', origin: target.origin };
  const page = {};
  cloud.session.mockImplementation(async (operation, options) => {
    await options.prepareContext({});
    return operation(page, identity);
  });
  let active = 0, maximum = 0;
  cloud.search.mockImplementation(async (query, options) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await options.openSession(async (actualPage: unknown, actualIdentity: unknown) => {
      expect(actualPage).toBe(page);
      expect(actualIdentity).toEqual(identity);
      await Promise.resolve();
    });
    active -= 1;
    return { propertyCode: query.propertyCode, outcome: 'ok', rows: [] };
  });
  const queries = [{ lastName: 'One', arrival: '2027-09-14' }, { lastName: 'Two', arrival: '2027-09-14' }];
  expect((await searchGuestCloudBatch(queries, target)).map((result) => result.outcome)).toEqual(['ok', 'ok']);
  expect(cloud.session).toHaveBeenCalledOnce();
  expect(cloud.guard).toHaveBeenCalledWith({}, 'HRDAVS');
  expect(cloud.search).toHaveBeenCalledTimes(2);
  expect(maximum).toBe(1);
  cloud.search.mockClear();
  cloud.session.mockImplementation(async (operation) => operation(page, { ...identity, propertyCode: 'HRDAV' }));
  expect((await searchGuestCloudBatch(queries, target)).map((result) => result.outcome))
    .toEqual(['execution_failure', 'execution_failure']);
  expect(cloud.search).not.toHaveBeenCalled();
  cloud.session.mockClear();
  expect((await searchGuestCloudBatch(queries, { ...target, secretId: 'other' })).map((result) => result.outcome))
    .toEqual(['refused_unknown_transport', 'refused_unknown_transport']);
  expect(cloud.session).not.toHaveBeenCalled();
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
