import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';
import { PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';
import {
  clearPanePreviewMemory,
  paneStaySaveLoaders,
  type OsressDuplicateStatus,
  type PaneStaySpawnInput,
  type PaneStaySpawnResult,
} from '../src/ai/pane-stay-save.js';

const failProfile = vi.hoisted(() => ({ enabled: false }));
vi.mock('../tooling/playwright-quote/property-profile.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../tooling/playwright-quote/property-profile.mjs')>();
  return { ...original, profileFor: (propertyCode: string) => {
    if (failProfile.enabled) throw new Error('synthetic profile read failure');
    return original.profileFor(propertyCode);
  } };
});

// Exercise the real route and work-item guard with a serialized in-memory transaction, never a database.
let state: Record<string, unknown> = {};
let exists = true;
let otherUnresolved = false;
let updateCount = 0;
let failUpdateAt = 0;
let failUpdatesFrom = 0;
let tail: Promise<void> = Promise.resolve();
const fakeDb = {
  async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      let nextState: Record<string, unknown> | undefined;
      const tx = {
        execute: async () => undefined,
        select: (fields: Record<string, unknown>) => ({ from: () => ({ where: () => ({
          limit: () => 'id' in fields
            ? Promise.resolve(otherUnresolved ? [{ id: 'other-work-item' }] : [])
            : { for: async () => exists ? [{ state: structuredClone(state) }] : [] },
        }) }) }),
        update: () => ({ set: (values: { state: Record<string, unknown> }) => ({
          where: async () => {
            updateCount += 1;
            if (updateCount === failUpdateAt || (failUpdatesFrom > 0 && updateCount >= failUpdatesFrom)) {
              throw new Error('synthetic persistence failure');
            }
            nextState = values.state;
          },
        }) }),
      };
      const result = await fn(tx);
      if (nextState) state = structuredClone(nextState);
      return result;
    } finally {
      release();
    }
  },
};

vi.mock('../src/db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/client.js')>()),
  getDb: () => fakeDb,
}));
const workItemId = '00000000-0000-4000-8000-000000000001';
const parentId = 's_aaaa1111_1';
const childId = 's_aaaa1111_2';
const input = {
  firstName: 'Proof', lastName: 'Labtest', arrival: '2027-09-14', departure: '2027-09-16', adults: 1,
  sourceOfBusiness: 'Walk in', roomType: 'STQN', ratePlan: 'BAR', track: 'BAR',
  guaranteeType: 'Awaiting Voucher', propertyCode: 'HRCEN', workItemId, stayId: parentId,
};
const child = { ...input, stayId: childId };
const unknown = { status: 'unknown', confirmationNumber: null, screenshotRef: null };
const booked = { status: 'booked', confirmationNumber: '11111111-1', screenshotRef: null };

function caller() {
  return appRouter.createCaller({
    auth: null as never, reqHeaders: new Headers(),
    sessionUser: { id: 'test-staff', email: 'staff@example.invalid', name: 'Test Staff' },
    activeTransportId: 'transport-centurion', transportEmail: 'hotel@example.invalid', accessRole: 'owner',
  } as never);
}

function fakeRunner() {
  const read = vi.fn(async (): Promise<OsressDuplicateStatus> => 'clear');
  const spawn = vi.fn(async (request: PaneStaySpawnInput): Promise<PaneStaySpawnResult> => request.paneCommit
    ? { outcome: 'committed', clickedSave: true, confirmationNumber: '11111111-1' }
    : { outcome: 'previewed', clickedSave: false, confirmationNumber: '' });
  paneStaySaveLoaders.mode = () => 'lab';
  paneStaySaveLoaders.lock = { withLock: async (fn) => fn() };
  paneStaySaveLoaders.osressGuestDatesSearch = read;
  paneStaySaveLoaders.spawn = spawn;
  return { read, spawn };
}

async function preview(client: ReturnType<typeof caller>, stay = input) {
  const result = await client.quoteWorkflow.previewStay(stay);
  expect(result).toMatchObject({ status: 'ok', outcome: 'previewed' });
  return result.previewDigest!;
}

beforeEach(() => {
  failProfile.enabled = false;
  state = {};
  exists = true;
  otherUnresolved = false;
  updateCount = 0;
  failUpdateAt = 0;
  failUpdatesFrom = 0;
  tail = Promise.resolve();
  clearPanePreviewMemory();
});
afterEach(() => {
  failProfile.enabled = false;
  paneStaySaveLoaders.spawn = null;
  paneStaySaveLoaders.lock = null;
  paneStaySaveLoaders.osressGuestDatesSearch = null;
  paneStaySaveLoaders.mode = null;
  clearPanePreviewMemory();
  vi.restoreAllMocks();
});

describe('quoteWorkflow commit safety with fake storage and HMS', () => {
  it('does not reach HMS for another work item while the property has an unresolved save', async () => {
    const { spawn, read } = fakeRunner();
    const client = caller();
    const previewDigest = await preview(client);
    otherUnresolved = true;
    expect(await client.quoteWorkflow.commitStay({ ...input, previewDigest })).toMatchObject({
      status: 'refused', reason: 'pane_save_dependency_unconfirmed',
    });
    expect(read).not.toHaveBeenCalled();
    expect(spawn.mock.calls.filter(([request]) => request.paneCommit)).toHaveLength(0);
  });

  it('requires a work item and stay identity before a direct commit', async () => {
    const { spawn, read } = fakeRunner();
    const client = caller();
    for (const ids of [{}, { workItemId }, { stayId: parentId }]) {
      const { workItemId: _workItemId, stayId: _stayId, ...withoutIds } = input;
      const result = await client.quoteWorkflow.commitStay({ ...withoutIds, ...ids, previewDigest: 'c'.repeat(64) });
      expect(result).toMatchObject({ status: 'refused', reason: 'pane_save_identity_required' });
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([unknown, { ...unknown, confirmationNumber: '11111111-1' }])(
    'holds direct and reloaded dependent requests while the parent remains unknown',
    async (parent) => {
      state = { stays: { [parentId]: parent } };
      const { spawn, read } = fakeRunner();
      const client = caller();
      const previewDigest = 'c'.repeat(64);
      expect(await client.quoteWorkflow.commitStay({ ...child, previewDigest })).toMatchObject({
        status: 'refused', reason: 'pane_save_dependency_unconfirmed',
      });
      expect(await caller().quoteWorkflow.commitStay({ ...child, parentStayId: parentId, previewDigest })).toMatchObject({
        status: 'refused', reason: 'pane_save_dependency_unconfirmed',
      });
      expect(await caller().quoteWorkflow.commitStay({ ...input, previewDigest })).toMatchObject({
        status: 'refused', reason: 'pane_save_unconfirmed',
      });
      expect(spawn).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('holds another room when a booked receipt has no usable confirmation', async () => {
    state = { stays: { [parentId]: { ...booked, confirmationNumber: 'not-a-confirmation' } } };
    const { spawn, read } = fakeRunner();
    expect(await caller().quoteWorkflow.commitStay({ ...child, previewDigest: 'c'.repeat(64) }))
      .toEqual({ status: 'refused', reason: 'pane_save_dependency_unconfirmed' });
    expect(read).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps an unknown result and its known number across a new caller and refuses a child', async () => {
    const { spawn } = fakeRunner();
    spawn.mockImplementation(async (request) => request.paneCommit
      ? { outcome: 'committed_unverified', clickedSave: true, confirmationNumber: '11111111-1' }
      : { outcome: 'previewed', clickedSave: false, confirmationNumber: '' });
    const client = caller();
    const parentPreview = await preview(client);
    const childPreview = await preview(client, child);
    expect(await client.quoteWorkflow.commitStay({ ...input, previewDigest: parentPreview })).toMatchObject({
      status: 'ok', outcome: 'committed_unverified', confirmationNumber: '11111111-1',
    });
    expect(state.stays).toMatchObject({ [parentId]: { status: 'unknown', confirmationNumber: '11111111-1' } });
    expect(await caller().quoteWorkflow.commitStay({ ...child, previewDigest: childPreview })).toMatchObject({
      status: 'refused', reason: 'pane_save_dependency_unconfirmed',
    });
    expect(spawn.mock.calls.filter(([request]) => request.paneCommit)).toHaveLength(1);
  });

  it('preserves the confirmed parent when the linked child is uncertain', async () => {
    const { spawn } = fakeRunner();
    let count = 0;
    spawn.mockImplementation(async (request) => {
      if (!request.paneCommit) return { outcome: 'previewed', clickedSave: false, confirmationNumber: '' };
      count += 1;
      return count === 1
        ? { outcome: 'committed', clickedSave: true, confirmationNumber: '11111111-1' }
        : { outcome: 'committed_unverified', clickedSave: true, confirmationNumber: '22222222-1' };
    });
    const client = caller();
    const parentPreview = await preview(client);
    const childPreview = await preview(client, child);
    await client.quoteWorkflow.commitStay({ ...input, previewDigest: parentPreview });
    await client.quoteWorkflow.commitStay({ ...child, parentStayId: parentId, previewDigest: childPreview });
    expect(state.stays).toMatchObject({
      [parentId]: booked,
      [childId]: { status: 'unknown', confirmationNumber: '22222222-1' },
    });
    expect(spawn.mock.calls.filter(([request]) => request.paneCommit)[1]?.[0]).toMatchObject({
      parentConfirmation: '11111111-1',
    });
  });

  it('records an unknown intent before HMS and blocks a concurrent child until a verified result', async () => {
    const { spawn } = fakeRunner();
    let finish!: (value: PaneStaySpawnResult) => void;
    spawn.mockImplementation(async (request) => request.paneCommit
      ? new Promise((resolve) => { finish = resolve; })
      : { outcome: 'previewed', clickedSave: false, confirmationNumber: '' });
    const client = caller();
    const parentPreview = await preview(client);
    const childPreview = await preview(client, child);
    const first = client.quoteWorkflow.commitStay({ ...input, previewDigest: parentPreview });
    await vi.waitFor(() => expect(spawn.mock.calls.filter(([request]) => request.paneCommit)).toHaveLength(1));
    expect(state.stays).toMatchObject({ [parentId]: unknown });
    expect(await caller().quoteWorkflow.commitStay({ ...child, previewDigest: childPreview })).toMatchObject({
      status: 'refused', reason: 'pane_save_dependency_unconfirmed',
    });
    finish({ outcome: 'committed', clickedSave: true, confirmationNumber: '11111111-1' });
    expect(await first).toMatchObject({ status: 'ok', outcome: 'committed' });
    expect(state.stays).toMatchObject({ [parentId]: booked });
    spawn.mockImplementation(async (request) => request.paneCommit
      ? { outcome: 'committed', clickedSave: true, confirmationNumber: '22222222-1' }
      : { outcome: 'previewed', clickedSave: false, confirmationNumber: '' });
    expect(await caller().quoteWorkflow.commitStay({ ...child, parentStayId: parentId, previewDigest: childPreview }))
      .toMatchObject({ status: 'ok', outcome: 'committed', confirmationNumber: '22222222-1' });
    expect(spawn.mock.calls.filter(([request]) => request.paneCommit)[1]?.[0]).toMatchObject({
      parentConfirmation: '11111111-1',
    });
  });

  it('releases the claim after a duplicate check proves Save was never attempted', async () => {
    const { spawn, read } = fakeRunner();
    read.mockResolvedValueOnce('duplicate');
    const client = caller();
    const parentPreview = await preview(client);
    expect(await client.quoteWorkflow.commitStay({ ...input, previewDigest: parentPreview })).toMatchObject({
      status: 'refused', reason: 'osress_duplicate', clickedSave: false,
    });
    expect(state.stays).toEqual({});
    expect(spawn.mock.calls.filter(([request]) => request.paneCommit)).toHaveLength(0);
    expect(await client.quoteWorkflow.commitStay({ ...input, previewDigest: parentPreview })).toMatchObject({
      status: 'ok', outcome: 'committed',
    });
  });

  it.each(['lock connection', 'duplicate lookup', 'preview grant'])(
    'releases the claim when the %s fails before the runner starts', async (stage) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { spawn } = fakeRunner();
    const client = caller();
    const previewDigest = await preview(client);
    if (stage === 'lock connection') paneStaySaveLoaders.lock = { withLock: async () => { throw new Error('lock failed'); } };
    if (stage === 'duplicate lookup') paneStaySaveLoaders.osressGuestDatesSearch = async () => { throw new Error('lookup failed'); };
    if (stage === 'preview grant') failUpdateAt = updateCount + 2; // Claim succeeds; taking the preview fails.
    expect(await client.quoteWorkflow.commitStay({ ...input, previewDigest })).toMatchObject({
      status: 'refused', reason: 'pane_save_preflight_unavailable', clickedSave: false,
    });
    expect(state.stays).toEqual({});
    expect(state.paneStaySaveClaims).toBeUndefined();
    expect(spawn.mock.calls.filter(([request]) => request.paneCommit)).toHaveLength(0);
  });

  it('clears the claim when the property profile cannot be read before the runner starts', async () => {
    const { spawn } = fakeRunner();
    const client = caller();
    const previewDigest = await preview(client);
    failProfile.enabled = true;
    expect(await client.quoteWorkflow.commitStay({ ...input, previewDigest })).toMatchObject({
      status: 'refused', reason: 'pane_save_preflight_unavailable', clickedSave: false,
    });
    expect(state.stays).toEqual({});
    expect(state.paneStaySaveClaims).toBeUndefined();
    expect(spawn.mock.calls.filter(([request]) => request.paneCommit)).toHaveLength(0);
  });

  it('retains the unknown claim if a pre-save refusal cannot be durably cleared', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fakeRunner();
    const client = caller();
    const previewDigest = await preview(client);
    paneStaySaveLoaders.osressGuestDatesSearch = async () => { throw new Error('lookup failed'); };
    failUpdatesFrom = updateCount + 2; // Claim succeeds; removing it fails.
    expect(await client.quoteWorkflow.commitStay({ ...input, previewDigest })).toMatchObject({
      status: 'refused', reason: 'pane_save_unconfirmed', clickedSave: false,
    });
    expect(state.stays).toMatchObject({ [parentId]: unknown });
    expect(state.paneStaySaveClaims).toMatchObject({ [parentId]: expect.any(String) });
  });

  it('preserves a runner confirmation when releasing the property lock fails', async () => {
    fakeRunner();
    const client = caller();
    const previewDigest = await preview(client);
    paneStaySaveLoaders.lock = { withLock: async (fn) => { await fn(); throw new Error('unlock failed'); } };
    expect(await client.quoteWorkflow.commitStay({ ...input, previewDigest })).toMatchObject({
      status: 'ok', outcome: 'committed_unverified', confirmationNumber: '11111111-1',
    });
    expect(state.stays).toMatchObject({ [parentId]: { status: 'unknown', confirmationNumber: '11111111-1' } });
    expect(state.paneStaySaveClaims).toBeUndefined();
  });

  it.each(['refused_save', 'refused_save_blank_required'])(
    'clears a claim after the runner proves %s happened before Save',
    async (outcome) => {
      const { spawn } = fakeRunner();
      spawn.mockImplementation(async (request) => request.paneCommit
        ? { outcome, clickedSave: false, confirmationNumber: '' }
        : { outcome: 'previewed', clickedSave: false, confirmationNumber: '' });
      const client = caller();
      const previewDigest = await preview(client);
      expect(await client.quoteWorkflow.commitStay({ ...input, previewDigest })).toMatchObject({
        status: 'refused', reason: outcome, clickedSave: false,
      });
      expect(state.stays).toEqual({});
      expect(state.paneStaySaveClaims).toBeUndefined();
    },
  );

  it.each(['missing work item', 'failed write'])('does not return a ready preview after a %s', async (cause) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { spawn } = fakeRunner();
    if (cause === 'missing work item') exists = false;
    else failUpdateAt = 1;
    const result = await caller().quoteWorkflow.previewStay(input);
    expect(result).toMatchObject({ status: 'refused', reason: 'pane_save_work_item_unavailable' });
    expect(result.previewDigest).toBeUndefined();
    expect(spawn.mock.calls.filter(([request]) => request.paneCommit)).toHaveLength(0);
  });

  it('retains a possible number if the runner refuses after Save may have fired', async () => {
    const { spawn } = fakeRunner();
    spawn.mockImplementation(async (request) => request.paneCommit
      ? { outcome: 'refused_message_box', clickedSave: true, confirmationNumber: '11111111-1',
        runId: '00000000-0000-4000-8000-000000000002', screenshots: ['saved.png'] }
      : { outcome: 'previewed', clickedSave: false, confirmationNumber: '' });
    const client = caller();
    const parentPreview = await preview(client);
    expect(await client.quoteWorkflow.commitStay({ ...input, previewDigest: parentPreview })).toMatchObject({
      status: 'ok', outcome: 'committed_unverified', confirmationNumber: '11111111-1',
    });
    expect(state.stays).toMatchObject({ [parentId]: {
      status: 'unknown', confirmationNumber: '11111111-1',
      screenshotRef: { runId: '00000000-0000-4000-8000-000000000002', name: 'saved.png' },
    } });
  });

  it('stores a known number as unknown after a transient receipt failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeRunner();
    const client = caller();
    const parentPreview = await preview(client);
    // Claim, consume the preview, then fail the receipt write.
    failUpdateAt = updateCount + 3;
    expect(await client.quoteWorkflow.commitStay({ ...input, previewDigest: parentPreview })).toMatchObject({
      status: 'ok', outcome: 'committed_unverified', confirmationNumber: '11111111-1',
    });
    expect(state.stays).toMatchObject({ [parentId]: { status: 'unknown', confirmationNumber: '11111111-1' } });
    expect(state.paneStaySaveClaims).toBeUndefined();
    expect(await caller().quoteWorkflow.commitStay({ ...child, previewDigest: 'c'.repeat(64) })).toMatchObject({
      status: 'refused', reason: 'pane_save_dependency_unconfirmed',
    });
  });

  it('retains a durable unknown claim during an ongoing receipt outage', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeRunner();
    const client = caller();
    const parentPreview = await preview(client);
    failUpdatesFrom = updateCount + 3;
    expect(await client.quoteWorkflow.commitStay({ ...input, previewDigest: parentPreview })).toMatchObject({
      status: 'ok', outcome: 'committed_unverified', confirmationNumber: '11111111-1',
    });
    expect(state.stays).toMatchObject({ [parentId]: unknown });
    expect(state.paneStaySaveClaims).toMatchObject({ [parentId]: expect.any(String) });
    expect(await caller().quoteWorkflow.commitStay({ ...child, previewDigest: 'c'.repeat(64) })).toMatchObject({
      status: 'refused', reason: 'pane_save_dependency_unconfirmed',
    });
  });

  it.each(['synthetic interruption', PROPERTY_READ_LOCK_DEADLINE_MESSAGE])(
    'keeps the unknown claim after a runner interruption: %s', async (message) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { spawn } = fakeRunner();
    spawn.mockImplementation(async (request) => {
      if (request.paneCommit) throw new Error(message);
      return { outcome: 'previewed', clickedSave: false, confirmationNumber: '' };
    });
    const client = caller();
    const parentPreview = await preview(client);
    expect(await client.quoteWorkflow.commitStay({ ...input, previewDigest: parentPreview })).toMatchObject({
      status: 'refused', reason: 'pane_save_unconfirmed',
    });
    expect(state.stays).toMatchObject({ [parentId]: unknown });
    expect(state.paneStaySaveClaims).toMatchObject({ [parentId]: expect.any(String) });
  });

  it('does not create a claim or call HMS when the work item is unavailable', async () => {
    const { spawn } = fakeRunner();
    exists = false;
    expect(await caller().quoteWorkflow.commitStay({ ...input, previewDigest: 'c'.repeat(64) })).toMatchObject({
      status: 'refused', reason: 'pane_save_work_item_unavailable',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails closed on malformed saved receipts or a failed claim write', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { spawn } = fakeRunner();
    state = { stays: { [parentId]: { unexpected: true } } };
    expect(await caller().quoteWorkflow.commitStay({ ...child, previewDigest: 'c'.repeat(64) })).toMatchObject({
      status: 'refused', reason: 'pane_save_work_item_unavailable',
    });
    state = {};
    failUpdateAt = 1;
    expect(await caller().quoteWorkflow.commitStay({ ...input, previewDigest: 'c'.repeat(64) })).toMatchObject({
      status: 'refused', reason: 'pane_save_work_item_unavailable',
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
