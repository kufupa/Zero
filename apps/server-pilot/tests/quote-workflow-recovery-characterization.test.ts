/**
 * Offline characterization only. The real tRPC routes and pane-save runner execute;
 * storage, locking, duplicate reads and the HMS subprocess are fakes. Assertions
 * describing unsafe behavior must become safety expectations in the recovery fix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import {
  clearPanePreviewMemory,
  paneStaySaveLoaders,
  type OsressDuplicateStatus,
  type PaneStaySpawnInput,
} from '../src/ai/pane-stay-save.js';
import { loadStayCommit, recordStayCommit } from '../src/ai/work-items.js';

// No test may connect to a database. A fake DB handle is passed only to mocked storage seams.
vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: vi.fn(() => ({})),
}));
vi.mock('../src/ai/work-items.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/work-items.js')>()),
  loadStayCommit: vi.fn(),
  recordStayCommit: vi.fn(),
}));
// Exercise the real same-process preview grant without writing a work item.
vi.mock('../src/ai/pane-stay-preview-persist.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ai/pane-stay-preview-persist.js')>()),
  createWorkItemPreviewPersist: () => ({ record: async () => {}, take: async () => false }),
}));

const workItemId = '00000000-0000-4000-8000-000000000001';
const stayId = 's_aaaa1111_1';
const input = {
  firstName: 'Proof',
  lastName: 'Labtest',
  arrival: '2027-09-14',
  departure: '2027-09-16',
  adults: 1,
  sourceOfBusiness: 'Walk in',
  roomType: 'STQN',
  ratePlan: 'BAR',
  track: 'BAR',
  guaranteeType: 'Awaiting Voucher',
  propertyCode: 'HRCEN',
  workItemId,
  stayId,
};

function caller() {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: 'test-staff', email: 'staff@example.invalid', name: 'Test Staff' },
    activeTransportId: 'transport-centurion',
    transportEmail: 'hotel@example.invalid',
    accessRole: 'owner',
  } as never);
}

function fakeRunner(duplicateStatus: OsressDuplicateStatus = 'clear') {
  const read = vi.fn(async () => duplicateStatus);
  const spawn = vi.fn(async (request: PaneStaySpawnInput) => request.paneCommit
    ? { outcome: 'committed', clickedSave: true, confirmationNumber: '99999999-1' }
    : { outcome: 'previewed', clickedSave: false, confirmationNumber: '' });
  paneStaySaveLoaders.mode = () => 'lab';
  paneStaySaveLoaders.lock = { withLock: async (fn) => fn() };
  paneStaySaveLoaders.osressGuestDatesSearch = read;
  paneStaySaveLoaders.spawn = spawn;
  return { read, spawn };
}

async function freshPreview(client: ReturnType<typeof caller>) {
  const result = await client.quoteWorkflow.previewStay(input);
  expect(result).toMatchObject({ status: 'ok', outcome: 'previewed' });
  expect(result.previewDigest).toMatch(/^[0-9a-f]{64}$/);
  return result.previewDigest!;
}

beforeEach(() => {
  clearPanePreviewMemory();
  vi.mocked(loadStayCommit).mockResolvedValue(undefined);
  vi.mocked(recordStayCommit).mockResolvedValue({ status: 'recorded' });
});

afterEach(() => {
  paneStaySaveLoaders.spawn = null;
  paneStaySaveLoaders.lock = null;
  paneStaySaveLoaders.osressGuestDatesSearch = null;
  paneStaySaveLoaders.mode = null;
  clearPanePreviewMemory();
  vi.mocked(loadStayCommit).mockReset();
  vi.mocked(recordStayCommit).mockReset();
  vi.restoreAllMocks();
});

describe('offline characterization of quoteWorkflow commit recovery', () => {
  it.each(['duplicate', 'clear'] as const)(
    'after a stored unknown and fresh preview, follows the fake duplicate read: %s',
    async (duplicateStatus) => {
      vi.mocked(loadStayCommit).mockResolvedValue({
        status: 'unknown', confirmationNumber: null, screenshotRef: null,
      });
      const { read, spawn } = fakeRunner(duplicateStatus);
      const client = caller();
      const previewDigest = await freshPreview(client);
      const result = await client.quoteWorkflow.commitStay({ ...input, previewDigest });

      expect(loadStayCommit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workItemId, stayId }));
      expect(read).toHaveBeenCalledTimes(1);
      if (duplicateStatus === 'duplicate') {
        expect(result).toMatchObject({ status: 'refused', reason: 'osress_duplicate' });
        expect(spawn.mock.calls.map(([request]) => request.paneCommit)).toEqual([false]);
        expect(recordStayCommit).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ status: 'ok', outcome: 'committed' });
        expect(spawn.mock.calls.map(([request]) => request.paneCommit)).toEqual([false, true]);
        expect(recordStayCommit).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each(['throws', 'not_found', 'already_booked'] as const)(
    'currently returns the HMS result when receipt storage %s',
    async (storageResult) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      if (storageResult === 'throws') {
        vi.mocked(recordStayCommit).mockRejectedValueOnce(new Error('Synthetic receipt failure'));
      } else {
        vi.mocked(recordStayCommit).mockResolvedValueOnce({ status: storageResult });
      }
      fakeRunner();
      const client = caller();
      const previewDigest = await freshPreview(client);
      const result = await client.quoteWorkflow.commitStay({ ...input, previewDigest });

      expect(recordStayCommit).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: 'ok', outcome: 'committed', confirmationNumber: '99999999-1' });
      if (storageResult === 'throws') {
        expect(warn).toHaveBeenCalledWith('stay_commit_persist_failed', expect.objectContaining({ workItemId, stayId }));
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    },
  );

  it('does not attempt a receipt when the runner throws during commit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { spawn } = fakeRunner();
    spawn.mockImplementation(async (request) => {
      if (request.paneCommit) throw new Error('Synthetic runner interruption');
      return { outcome: 'previewed', clickedSave: false, confirmationNumber: '' };
    });
    const client = caller();
    const previewDigest = await freshPreview(client);

    await expect(client.quoteWorkflow.commitStay({ ...input, previewDigest })).rejects.toThrow('Synthetic runner interruption');
    expect(recordStayCommit).not.toHaveBeenCalled();
  });
});
