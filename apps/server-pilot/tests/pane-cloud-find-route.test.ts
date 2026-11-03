import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cloud = vi.hoisted(() => ({ run: vi.fn(), project: vi.fn() }));
vi.mock('../src/ai/hms-cloud-saved-stay-find.js', () => ({
  runCloudStayFind: cloud.run,
  projectCloudStayFind: cloud.project,
}));
vi.mock('../src/db/client.js', async (original) => ({
  ...(await original<typeof import('../src/db/client.js')>()),
  getDb: () => { throw new Error('database unavailable in this unit test'); },
}));

import { paneStayLookupLoaders } from '../src/ai/pane-stay-lookup.js';
import { CENTURION_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';
import { appRouter } from '../src/trpc/router.js';

const confirmation = '123456-1';
const arrival = '2027-09-14';
const stay = { confirmation, firstName: 'Proof', lastName: 'Labtest', status: 'Reserved',
  arrival, departure: '2027-09-15', nights: 1, adults: 1, children: 0, roomType: 'STQN', ratePlan: 'BAR',
  mealPlan: null, averageRate: null, grandTotal: null, balance: null, sourceOfBusiness: null, guaranteeType: null,
  bookingAgency: null, organization: null };
const projected = () => ({ outcome: 'found', reason: null, stay, nativePreimage: { confirmation },
  arrivalMismatch: false, requestedArrival: arrival, hmsArrival: arrival, screenshots: [], runId: null });

function caller() {
  return appRouter.createCaller({ auth: null as never, reqHeaders: new Headers(),
    sessionUser: { id: 'user-staff', email: 'staff@example.test', name: 'Staff' },
    activeTransportId: 'transport-centurion', transportEmail: 'centurion@example.test', accessRole: 'member',
  } as never);
}

beforeEach(() => {
  cloud.run.mockResolvedValue({ outcome: 'ok' });
  cloud.project.mockReturnValue(projected());
  paneStayLookupLoaders.enabled = () => true;
  paneStayLookupLoaders.lock = { withLock: (operation) => operation() };
  paneStayLookupLoaders.spawn = null;
});
afterEach(() => {
  cloud.run.mockReset(); cloud.project.mockReset();
  paneStayLookupLoaders.enabled = null; paneStayLookupLoaders.lock = null; paneStayLookupLoaders.spawn = null;
});

describe('mounted HRCEN confirmation lookup', () => {
  it('uses the Cloud reader through the existing authenticated pane route', async () => {
    const result = await caller().paneStayLookup.findStay({ confirmation, arrival });
    expect(result).toMatchObject({ outcome: 'found', stay: { confirmation, firstName: 'Proof', lastName: 'Labtest' } });
    expect(cloud.run).toHaveBeenCalledOnce();
    expect(cloud.run).toHaveBeenCalledWith(expect.objectContaining({ request: { confirmation, arrival },
      target: CENTURION_HMS_READ_TARGET, signal: expect.any(AbortSignal) }));
  });

  it('refuses a found result without a matching native record', async () => {
    cloud.project.mockReturnValue({ ...projected(), nativePreimage: null });
    await expect(caller().paneStayLookup.findStay({ confirmation, arrival })).resolves.toMatchObject({
      outcome: 'execution_failure', stay: null, reason: 'SAVED_STAY_IDENTITY_UNVERIFIED',
    });
    cloud.project.mockReturnValue({ ...projected(), nativePreimage: { confirmation: '999-1' } });
    await expect(caller().paneStayLookup.findStay({ confirmation, arrival })).resolves.toMatchObject({
      outcome: 'execution_failure', stay: null, reason: 'SAVED_STAY_IDENTITY_UNVERIFIED',
    });
  });

  it('keeps the existing flag and rejects invalid input before opening Cloud', async () => {
    paneStayLookupLoaders.enabled = () => false;
    await expect(caller().paneStayLookup.findStay({ confirmation })).resolves.toMatchObject({ outcome: 'refused_flag_off' });
    await expect(caller().paneStayLookup.findStay({ confirmation: 'invalid' })).rejects.toThrow();
    expect(cloud.run).not.toHaveBeenCalled();
  });
});
