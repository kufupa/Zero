import { paneStayInput } from '../src/trpc/routes/quote-workflow.js';
import { cloudCreatePolicyIssue, mapPaneStayToCloudCreateInput } from '../src/ai/pane-create-cloud-input.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertLabStayGuard,
  PANE_PAID_BOOKING_COPY,
  PANE_PREVIEW_TTL_MS,
  PANE_RUN_TTL_MS,
  PANE_STAY_PROPERTY_CODE,
  type PaneStayLock,
  type PaneStaySpawnInput,
  type PaneStaySpawnResult,
  paneStayDigest,
  paneStayClock,
  takePanePreview,
  paneStayPropertyLock,
  paneStayPropertyRefusal,
  paneStayRequestBody,
  paneStaySaveEnabled,
  paneStaySaveLoaders,
  paneWriteMode,
  clearPanePreviewMemory,
  paneWriteModes,
  paneStayCreatePropertyArgs,
  paneStayCreateSpawnEnv,
  paneStayCreateTarget,
  paneStayTenantId,
  readPaneStayScreenshot,
  runPaneStay,
} from '../src/ai/pane-stay-save.js';
import { hmsDavinciCreateMode } from '../src/env.js';
import { CreateFenceError } from '../src/ai/pane-create-dispatch-fence.js';
import { CENTURION_HMS_READ_TARGET, DAVINCI_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';
import { PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';
import {
  PANE_BOOKER_EMAIL_MAX,
  PANE_BOOKER_NAME_MAX,
  PANE_MARKET_SEGMENT_MAX,
  PANE_PARTY_NAME_MAX,
  PANE_PARTY_NATIVE_ID_MAX,
  PANE_RESERVATION_NOTE_MAX,
  paneStayModeRefusal,
  paneStaySaveMode,
} from '../src/ai/pane-stay-save.js';
import {
  loadCreateToolSchema,
  optionalPartyAndNoteFills,
  validateCreateRequest,
} from '../tooling/hms-cloud/create-request.mjs';
import {
  marketSegmentOptions,
  profileFor,
} from '../tooling/hms-cloud/property-profile.mjs';
import {
  PANE_STAY_ALREADY_BOOKED,
  stayCommitFromPaneResult,
  stayCommitGuard,
  stayCommitOf,
  withStayCommit,
  withStayActionResult,
} from '../src/ai/work-items.js';
import {
  stayPreviewOf,
  withStayPreview,
} from '../src/ai/pane-stay-preview-persist.js';

const labStay = {
  firstName: 'Proof',
  lastName: 'Labtest',
  arrival: '2027-09-14',
  departure: '2027-09-16',
  adults: 1,
  sourceOfBusiness: 'Walk in',
  roomType: 'SUITE',
  ratePlan: 'BAR',
  track: 'BAR',
  guaranteeType: 'Awaiting Voucher',
};


let ownerSeq = 0;
// Each test gets its own owner, so grants from one test never satisfy another.
function freshOwner(transportId = 'transport-centurion'): string {
  ownerSeq += 1;
  return `user-${ownerSeq}:${transportId}`;
}

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

function cliSpawn(input: PaneStaySpawnInput): Promise<PaneStaySpawnResult> {
  return Promise.resolve(
    input.paneCommit
      ? { outcome: 'committed', clickedSave: true, confirmationNumber: '46184891-1' }
      : { outcome: 'previewed', clickedSave: false, confirmationNumber: '' },
  );
}

// Flag on, lock and reader passing, the CLI faked. Commit still needs a matching preview grant.
function enableSave(): void {
  paneStaySaveLoaders.mode = () => 'lab';
  paneStaySaveLoaders.lock = passingLock();
  paneStaySaveLoaders.osressGuestDatesSearch = async () => 'clear';
  paneStaySaveLoaders.spawn = cliSpawn;
}

afterEach(() => {
  paneStaySaveLoaders.spawn = null;
  paneStaySaveLoaders.lock = null;
  paneStaySaveLoaders.osressGuestDatesSearch = null;
  paneStaySaveLoaders.mode = null;
  paneStaySaveLoaders.now = null;
  paneStaySaveLoaders.previewPersist = null;
  clearPanePreviewMemory();
  vi.unstubAllEnvs();
});

describe('pane stay save guards', () => {
  it('requires a durable Staff Go even after an unsaved preview', async () => {
    vi.stubEnv('PANE_WRITE_CREATE', 'lab');
    vi.stubEnv('PANE_CLOUD_CREATE_DISPATCH', 'on');
    enableSave();
    const owner = freshOwner();
    const preview = await runPaneStay({ mode: 'preview', stay: labStay, owner });
    expect(preview).toMatchObject({ status: 'ok', outcome: 'previewed', clickedSave: false });
    const read = vi.fn(async () => 'clear' as const);
    const spawn = vi.fn(cliSpawn);
    paneStaySaveLoaders.osressGuestDatesSearch = read;
    paneStaySaveLoaders.spawn = spawn;
    await expect(runPaneStay({ mode: 'commit', stay: labStay, owner, previewDigest: preview.previewDigest }))
      .resolves.toEqual({ status: 'refused', reason: 'fresh_preparation_required' });
    expect(read).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('is off unless RESERVATIONIST_PANE_SAVE is exactly lab or on', () => {
    expect(paneStaySaveEnabled({})).toBe(false);
    expect(paneStaySaveEnabled({ RESERVATIONIST_PANE_SAVE: 'off' })).toBe(false);
    expect(paneStaySaveEnabled({ RESERVATIONIST_PANE_SAVE: 'lab' })).toBe(true);
    expect(paneStaySaveEnabled({ RESERVATIONIST_PANE_SAVE: 'on' })).toBe(true);
    expect(paneStaySaveMode({})).toBe('off');
    expect(paneStaySaveMode({ RESERVATIONIST_PANE_SAVE: 'off' })).toBe('off');
    expect(paneStaySaveMode({ RESERVATIONIST_PANE_SAVE: 'lab' })).toBe('lab');
    expect(paneStaySaveMode({ RESERVATIONIST_PANE_SAVE: 'on' })).toBe('on');
    // Any other spelling fails closed.
    for (const value of ['ON', 'true', '1', ' on', 'lab ']) {
      expect(paneStaySaveMode({ RESERVATIONIST_PANE_SAVE: value })).toBe('off');
    }
  });

  it('falls back to SAVE only when all five PANE_WRITE_* flags are unset', () => {
    expect(paneWriteMode('create', 'unpaid', { RESERVATIONIST_PANE_SAVE: 'lab' })).toBe('lab');
    expect(paneWriteMode('cancel', 'unpaid', { RESERVATIONIST_PANE_SAVE: 'on' })).toBe('on');
    expect(paneWriteMode('amend', 'unpaid', { RESERVATIONIST_PANE_SAVE: 'on' })).toBe('off');
    expect(
      paneWriteMode('create', 'unpaid', {
        PANE_WRITE_CREATE: 'lab',
        RESERVATIONIST_PANE_SAVE: 'on',
      }),
    ).toBe('lab');
  });

  it('once any new flag is set, an unset or invalid sibling is off', () => {
    expect(paneWriteMode('amend', 'unpaid', { PANE_WRITE_CREATE: 'on' })).toBe('off');
    expect(paneWriteMode('cancel', 'unpaid', { PANE_WRITE_CREATE: 'lab' })).toBe('off');
    expect(
      paneWriteMode('create', 'unpaid', {
        PANE_WRITE_CREATE: 'lab',
        PANE_WRITE_AMEND_UNPAID: 'nope',
      }),
    ).toBe('lab');
    expect(
      paneWriteMode('amend', 'unpaid', {
        PANE_WRITE_CREATE: 'lab',
        PANE_WRITE_AMEND_UNPAID: 'nope',
      }),
    ).toBe('off');
    expect(paneStaySaveMode({ PANE_WRITE_AMEND_UNPAID: 'lab' })).toBe('off');
  });

  it('paid or guaranteed copy tells staff to handle the stay in HMS', () => {
    expect(PANE_PAID_BOOKING_COPY).toBe(
      'Paid or guaranteed booking: handle in HMS (Nava only changes unpaid bookings for now)',
    );
  });

  it('accepts dedicated paid amend and cancel flags', () => {
    expect(paneWriteMode('amend', 'paid', { PANE_WRITE_AMEND_PAID: 'on' })).toBe('on');
    expect(paneWriteMode('cancel', 'paid', { PANE_WRITE_CANCEL_PAID: 'on' })).toBe('on');
    expect(paneWriteMode('amend', 'paid', { PANE_WRITE_AMEND_PAID: 'lab' })).toBe('lab');
    expect(paneWriteModes({ PANE_WRITE_CREATE: 'on' })).toEqual({
      create: 'on',
      amendUnpaid: 'off',
      amendPaid: 'off',
      cancelUnpaid: 'off',
      cancelPaid: 'off',
    });
  });

  it('requires Labtest last name and arrival in 2027 or later', () => {
    expect(() =>
      assertLabStayGuard({ lastName: 'Labtest', arrivalDate: '2027-01-01' }),
    ).not.toThrow();
    expect(() =>
      assertLabStayGuard({ lastName: 'Guest', arrivalDate: '2027-01-01' }),
    ).toThrow(/labtest/i);
    expect(() =>
      assertLabStayGuard({ lastName: 'Labtest', arrivalDate: '2026-12-31' }),
    ).toThrow(/2027/);
  });

  it('refuses preview and commit when the mode is off', async () => {
    paneStaySaveLoaders.mode = () => 'off';
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      runPaneStay({ mode: 'preview', stay: labStay, owner: freshOwner() }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_flag_off' });
    await expect(
      runPaneStay({ mode: 'commit', stay: labStay, owner: freshOwner() }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_flag_off' });
  });

  it('requires the Labtest last name as a whole word, not a substring', () => {
    expect(() =>
      assertLabStayGuard({ lastName: ' Labtest ', arrivalDate: '2027-01-01' }),
    ).not.toThrow();
    expect(() =>
      assertLabStayGuard({ lastName: 'Labtest Smith', arrivalDate: '2027-09-14' }),
    ).toThrow(/labtest/i);
    expect(() =>
      assertLabStayGuard({ lastName: 'Labtestino', arrivalDate: '2027-09-14' }),
    ).toThrow(/labtest/i);
  });

  it('refuses refused_lock_busy in preview when the property lock stays held past the 20 s wait', async () => {
    enableSave();
    paneStaySaveLoaders.lock = {
      withLock: async () => {
        throw busyLockError();
      },
    };
    await expect(
      runPaneStay({ mode: 'preview', stay: labStay, owner: freshOwner() }),
    ).resolves.toEqual({ status: 'refused', reason: 'refused_lock_busy' });
  });

  it('refuses adults 0 before any write lock or spawn', async () => {
    const locked: string[] = [];
    paneStaySaveLoaders.mode = () => 'lab';
    paneStaySaveLoaders.lock = passingLock(locked);
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      runPaneStay({ mode: 'preview', stay: { ...labStay, adults: 0 }, owner: freshOwner() }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_adults_required' });
    expect(paneStayModeRefusal('lab', { ...labStay, adults: 0 })).toBe('pane_save_adults_required');
    expect(paneStayModeRefusal('on', { ...labStay, adults: 1 })).toBeNull();
    expect(locked).toEqual([]);
  });

  it('refuses a property outside the authenticated mailbox before lock or spawn', async () => {
    const locked: string[] = [];
    paneStaySaveLoaders.mode = () => 'lab';
    paneStaySaveLoaders.lock = passingLock(locked);
    const spawn = vi.fn(cliSpawn);
    paneStaySaveLoaders.spawn = spawn;
    for (const mode of ['preview', 'commit'] as const) {
      await expect(runPaneStay({ mode, stay: { ...labStay, propertyCode: 'HRDAV' }, owner: freshOwner() }))
        .resolves.toMatchObject({ status: 'refused', reason: 'property_mismatch' });
    }
    expect(locked).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('accepts an explicit propertyCode that names the session hotel', () => {
    expect(paneStayPropertyRefusal(undefined)).toBeNull();
    expect(paneStayPropertyRefusal(PANE_STAY_PROPERTY_CODE)).toBeNull();
    expect(paneStayPropertyRefusal('hrcen')).toBe('pane_save_property_mismatch');
    expect(paneStayPropertyRefusal('')).toBe('pane_save_property_mismatch');
  });

  it('refuses unknown, collector, and missing pane targets instead of defaulting to HRCEN', () => {
    expect(paneStayCreateTarget({ transportId: 'transport-unknown' })).toEqual({ ok: false, reason: 'unknown_transport' });
    expect(paneStayCreateTarget({ transportId: 'transport-nava' })).toEqual({ ok: false, reason: 'collector_no_hotel' });
    expect(paneStayCreateTarget({})).toEqual({ ok: false, reason: 'property_required' });
    expect(paneStayCreateTarget({ propertyCode: 'OTHER' })).toEqual({ ok: false, reason: 'property_unknown' });
  });

  it('refuses an unknown transport before any lock or spawn', async () => {
    const locked: string[] = [];
    paneStaySaveLoaders.mode = () => 'lab';
    paneStaySaveLoaders.lock = passingLock(locked);
    const spawn = vi.fn(cliSpawn);
    paneStaySaveLoaders.spawn = spawn;
    await expect(runPaneStay({ mode: 'preview', stay: labStay, owner: freshOwner('transport-unknown') }))
      .resolves.toMatchObject({ status: 'refused', reason: 'unknown_transport' });
    expect(locked).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('requires a registered Cloud property identity for the read lock', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:secret@127.0.0.1:5432/zero_test');
    expect(paneStayPropertyLock(CENTURION_HMS_READ_TARGET)).not.toBeNull();
    expect(paneStayPropertyLock({ ...CENTURION_HMS_READ_TARGET, propertyCode: 'HRDAV' })).toBeNull();
    expect(paneStayPropertyLock({ ...CENTURION_HMS_READ_TARGET, origin: 'https://wrong.invalid' })).toBeNull();
  });

  it('creates read locks only for each property registered with its own secret and origin', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:secret@127.0.0.1:5432/zero_test');
    expect(paneStayPropertyLock(CENTURION_HMS_READ_TARGET)).not.toBeNull();
    expect(paneStayPropertyLock(DAVINCI_HMS_READ_TARGET)).not.toBeNull();
    expect(paneStayPropertyLock({ ...DAVINCI_HMS_READ_TARGET, secretId: CENTURION_HMS_READ_TARGET.secretId })).toBeNull();
  });

  it('the lock tenant is PANE_STAY_TENANT_ID, then HMS_EXPECTED_TENANT, then legacy', () => {
    vi.stubEnv('PANE_STAY_TENANT_ID', '');
    vi.stubEnv('HMS_EXPECTED_TENANT', 'centurion');
    expect(paneStayTenantId()).toBe('centurion');
    vi.stubEnv('PANE_STAY_TENANT_ID', 'pilot');
    expect(paneStayTenantId()).toBe('pilot');
    vi.stubEnv('PANE_STAY_TENANT_ID', '');
    vi.stubEnv('HMS_EXPECTED_TENANT', '  ');
    expect(paneStayTenantId()).toBe('legacy');
  });

  it('has no production lock without DATABASE_URL', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(paneStayPropertyLock(CENTURION_HMS_READ_TARGET)).toBeNull();
  });

  it('omits propertyCode from the CLI request body', () => {
    expect(paneStayRequestBody({ ...labStay, propertyCode: 'HRCEN' })).not.toHaveProperty(
      'propertyCode',
    );
  });

  it('treats a refused CLI outcome as refused, not ok', async () => {
    paneStaySaveLoaders.mode = () => 'lab';
    paneStaySaveLoaders.lock = { withLock: async (fn) => fn() };
    paneStaySaveLoaders.spawn = async () => ({
      outcome: 'refused_save_blank_required',
      clickedSave: false,
      confirmationNumber: '',
    });
    await expect(
      runPaneStay({ mode: 'preview', stay: labStay, owner: freshOwner() }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'refused_save_blank_required' });
  });

  it('preview fills and checks availability under the property lock without saving', async () => {
    const seen: string[] = [];
    paneStaySaveLoaders.mode = () => 'lab';
    paneStaySaveLoaders.lock = passingLock(seen);
    paneStaySaveLoaders.spawn = async (input) => {
      seen.push(input.stopBefore ?? 'none');
      expect(input.paneCommit).toBeFalsy();
      return { outcome: 'previewed', clickedSave: false, confirmationNumber: '' };
    };
    const result = await runPaneStay({ mode: 'preview', stay: labStay, owner: freshOwner() });
    expect(result).toMatchObject({ status: 'ok', outcome: 'previewed' });
    expect(seen).toEqual(['lock', 'save']);
  });

});

describe('pane stay preview digest and commit', () => {
  it('a successful preview returns the digest of the normalized stay', async () => {
    enableSave();
    const preview = await runPaneStay({ mode: 'preview', stay: labStay, owner: freshOwner() });
    expect(preview).toMatchObject({
      status: 'ok',
      outcome: 'previewed',
      previewDigest: paneStayDigest(labStay),
    });
    expect(paneStayDigest(labStay)).toMatch(/^[0-9a-f]{64}$/);
    expect(paneStayDigest({ ...labStay, firstName: '  Proof  ' })).toBe(paneStayDigest(labStay));
    expect(paneStayDigest({ ...labStay, arrival: '2027-09-15' })).not.toBe(paneStayDigest(labStay));
  });

  it('a refused preview never authorizes a Save', async () => {
    vi.stubEnv('PANE_WRITE_CREATE', 'lab');
    vi.stubEnv('PANE_CLOUD_CREATE_DISPATCH', 'on');
    enableSave();
    const owner = freshOwner();
    paneStaySaveLoaders.spawn = async () => ({ outcome: 'refused_save_blank_required', clickedSave: false, confirmationNumber: '' });
    const preview = await runPaneStay({ mode: 'preview', stay: labStay, owner });
    expect(preview).toMatchObject({ status: 'refused', reason: 'refused_save_blank_required' });
    expect(preview.previewDigest).toBeUndefined();
    const spawn = vi.fn(cliSpawn);
    paneStaySaveLoaders.spawn = spawn;
    await expect(runPaneStay({ mode: 'commit', stay: labStay, owner, previewDigest: paneStayDigest(labStay) }))
      .resolves.toMatchObject({ status: 'refused', reason: 'fresh_preparation_required' });
    expect(spawn).not.toHaveBeenCalled();
  });

});

describe('pane stay screenshots', () => {
  it('returns screenshot names and serves the bytes only to the owner who ran the stay', async () => {
    enableSave();
    const runDir = await mkdtemp(join(tmpdir(), 'pane-stay-test-'));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(join(runDir, 'filled.png'), png);
    await writeFile(join(runDir, 'request.json'), '{}');
    const runId = randomUUID();
    const owner = freshOwner();
    paneStaySaveLoaders.spawn = async () => ({
      outcome: 'previewed',
      clickedSave: false,
      confirmationNumber: '',
      runId,
      runDir,
      screenshots: ['filled.png'],
    });
    await expect(runPaneStay({ mode: 'preview', stay: labStay, owner })).resolves.toMatchObject({
      status: 'ok',
      runId,
      screenshots: ['filled.png'],
    });
    await expect(readPaneStayScreenshot({ runId, name: 'filled.png', owner })).resolves.toEqual({
      status: 'ok',
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    });
    await expect(
      readPaneStayScreenshot({ runId, name: 'filled.png', owner: freshOwner() }),
    ).resolves.toMatchObject({ status: 'unavailable' });
    await expect(
      readPaneStayScreenshot({ runId, name: '../request.json', owner }),
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'screenshot_request_invalid' });
    await expect(
      readPaneStayScreenshot({ runId, name: 'request.json', owner }),
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'screenshot_request_invalid' });
    await expect(
      readPaneStayScreenshot({ runId: randomUUID(), name: 'filled.png', owner }),
    ).resolves.toMatchObject({ status: 'unavailable' });
    await rm(runDir, { recursive: true, force: true });
  });

  it('removes a run directory once its retention window has passed', async () => {
    enableSave();
    const runDir = await mkdtemp(join(tmpdir(), 'pane-stay-test-'));
    await writeFile(join(runDir, 'saved.png'), Buffer.from([1, 2, 3]));
    const runId = randomUUID();
    const owner = freshOwner();
    let now = 5_000_000;
    paneStaySaveLoaders.now = () => now;
    paneStaySaveLoaders.spawn = async () => ({
      outcome: 'previewed',
      clickedSave: false,
      confirmationNumber: '',
      runId,
      runDir,
      screenshots: ['saved.png'],
    });
    await runPaneStay({ mode: 'preview', stay: labStay, owner });
    await expect(readPaneStayScreenshot({ runId, name: 'saved.png', owner })).resolves.toMatchObject({
      status: 'ok',
    });
    now += PANE_RUN_TTL_MS + 1;
    await expect(readPaneStayScreenshot({ runId, name: 'saved.png', owner })).resolves.toMatchObject({
      status: 'unavailable',
    });
    await expect(stat(runDir)).rejects.toThrow();
  });

  it('serves saved.png from the durable dir after the in-memory run expires', async () => {
    enableSave();
    const shotsRoot = await mkdtemp(join(tmpdir(), 'hms-shots-test-'));
    vi.stubEnv('HMS_SHOTS_DIR', shotsRoot);
    const runDir = await mkdtemp(join(tmpdir(), 'pane-stay-test-'));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(join(runDir, 'saved.png'), png);
    const runId = randomUUID();
    const workItemId = randomUUID();
    const owner = freshOwner();
    paneStaySaveLoaders.previewPersist = { record: () => undefined, take: () => false };
    let now = 9_000_000;
    paneStaySaveLoaders.now = () => now;
    paneStaySaveLoaders.spawn = async () => ({
      outcome: 'previewed',
      clickedSave: false,
      confirmationNumber: '',
      runId,
      runDir,
      screenshots: ['saved.png'],
    });
    await runPaneStay({
      mode: 'preview',
      stay: labStay,
      owner,
      workItemId,
      stayId: 's_1',
    });
    now += PANE_RUN_TTL_MS + 1;
    await expect(readPaneStayScreenshot({ runId, name: 'saved.png', owner })).resolves.toEqual({
      status: 'ok',
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    });
    await rm(shotsRoot, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  it('a later save run removes an expired run directory even if nobody reads it', async () => {
    enableSave();
    const runDir = await mkdtemp(join(tmpdir(), 'pane-stay-test-'));
    await writeFile(join(runDir, 'filled.png'), Buffer.from([1]));
    const runId = randomUUID();
    let now = 7_000_000;
    paneStaySaveLoaders.now = () => now;
    paneStaySaveLoaders.spawn = async () => ({
      outcome: 'previewed',
      clickedSave: false,
      confirmationNumber: '',
      runId,
      runDir,
      screenshots: ['filled.png'],
    });
    await runPaneStay({ mode: 'preview', stay: labStay, owner: freshOwner() });
    now += PANE_RUN_TTL_MS + 1;
    paneStaySaveLoaders.spawn = cliSpawn;
    await runPaneStay({ mode: 'preview', stay: labStay, owner: freshOwner() });
    await expect(stat(runDir)).rejects.toThrow();
  });
});

const realStay = {
  ...labStay,
  firstName: 'Ann',
  lastName: 'Smith',
  arrival: '2026-11-12',
  departure: '2026-11-14',
};

describe('pane stay save modes', () => {
  it('allows a real unsaved preview but enforces Labtest identity and dates at Save', async () => {
    vi.stubEnv('PANE_WRITE_CREATE', 'lab');
    vi.stubEnv('PANE_CLOUD_CREATE_DISPATCH', 'on');
    enableSave();
    const spawn = vi.fn(cliSpawn);
    paneStaySaveLoaders.spawn = spawn;
    await expect(runPaneStay({ mode: 'preview', stay: realStay, owner: freshOwner() }))
      .resolves.toMatchObject({ status: 'ok', outcome: 'previewed', clickedSave: false });
    spawn.mockClear();
    await expect(runPaneStay({ mode: 'commit', stay: realStay, owner: freshOwner() }))
      .resolves.toMatchObject({ status: 'refused', reason: 'pane_save_labtest_required' });
    await expect(runPaneStay({ mode: 'commit', stay: { ...labStay, arrival: '2026-12-31' }, owner: freshOwner() }))
      .resolves.toMatchObject({ status: 'refused', reason: 'pane_save_arrival_2027_required' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('off refuses a real guest and a lab stay in both preview and commit, before any spawn', async () => {
    paneStaySaveLoaders.mode = () => 'off';
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    for (const stay of [realStay, labStay]) {
      await expect(runPaneStay({ mode: 'preview', stay, owner: freshOwner() })).resolves.toMatchObject({
        status: 'refused',
        reason: 'pane_save_flag_off',
      });
      await expect(
        runPaneStay({ mode: 'commit', stay, owner: freshOwner(), previewDigest: paneStayDigest(stay) }),
      ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_flag_off' });
    }
  });

  it('the digest covers the new fields, ignores key order inside a party, and treats a blank note as absent', () => {
    expect(paneStayDigest({ ...realStay, reservationNote: 'A' })).not.toBe(paneStayDigest(realStay));
    expect(paneStayDigest({ ...realStay, bookingAgency: { name: 'XYZ' } })).not.toBe(
      paneStayDigest(realStay),
    );
    expect(paneStayDigest({ ...realStay, bookerName: 'Ann' })).not.toBe(paneStayDigest(realStay));
    expect(paneStayDigest({ ...realStay, bookingAgency: { name: 'XYZ', nativeId: '7' } })).toBe(
      paneStayDigest({ ...realStay, bookingAgency: { nativeId: '7', name: '  XYZ ' } }),
    );
    expect(paneStayDigest({ ...realStay, reservationNote: '   ' })).toBe(paneStayDigest(realStay));
  });

  it('rejects out-of-range child ages at the pane boundary', () => {
    expect(paneStayInput.safeParse({ ...realStay, childAges: [0, 17] }).success).toBe(true);
    expect(paneStayInput.safeParse({ ...realStay, stayId: `room_${'a'.repeat(36)}_1` }).success).toBe(true);
    expect(paneStayInput.safeParse({ ...realStay, childAges: [18] }).success).toBe(false);
    expect(paneStayInput.safeParse({ ...realStay, childAges: [-1] }).success).toBe(false);
    expect(paneStayInput.safeParse({ ...realStay, childAges: [1.5] }).success).toBe(false);
    expect(paneStayInput.safeParse({ ...realStay, bookingAgency: { id: '7', name: 'XYZ' } }).success).toBe(true);
    expect(paneStayInput.safeParse({ ...realStay, bookingAgency: { id: '7', nativeId: '8', name: 'XYZ' } }).success).toBe(false);
  });

  it('allows children and passes ages through to the create request', async () => {
    enableSave();
    paneStaySaveLoaders.mode = () => 'on';
    const withChildren = { ...realStay, childAges: [5] };
    expect(paneStayModeRefusal('on', withChildren)).toBeNull();
    expect(paneStayRequestBody(withChildren).childAges).toEqual([5]);
    await expect(runPaneStay({ mode: 'preview', stay: withChildren, owner: freshOwner() }))
      .resolves.toMatchObject({ status: 'ok', outcome: 'previewed' });
  });

  it('sends the agency, organization, note and booker fields to the runner request, and the request passes the schema', async () => {
    enableSave();
    paneStaySaveLoaders.mode = () => 'on';
    const seen: PaneStaySpawnInput[] = [];
    paneStaySaveLoaders.spawn = async (input) => {
      seen.push(input);
      return cliSpawn(input);
    };
    const full = {
      ...realStay,
      bookingAgency: { name: 'XYZ TRAVEL' },
      organization: { nativeId: '4411', name: 'Bidvest Bank' },
      reservationNote: 'Pay by EFT',
      bookerName: 'Ann Booker',
      bookerEmail: 'ann@example.invalid',
      propertyCode: 'HRCEN',
    };
    await runPaneStay({ mode: 'preview', stay: full, owner: freshOwner() });
    expect(seen[0]?.stay).toMatchObject({
      bookingAgency: { name: 'XYZ TRAVEL' },
      organization: { nativeId: '4411', name: 'Bidvest Bank' },
      reservationNote: 'Pay by EFT',
      bookerName: 'Ann Booker',
      bookerEmail: 'ann@example.invalid',
    });
    const body = paneStayRequestBody(full);
    expect(body).not.toHaveProperty('propertyCode');
    expect(validateCreateRequest(body, await loadCreateToolSchema())).toMatchObject({ ok: true });
  });
});

describe('Da Vinci pane create (HMS_DAVINCI_CREATE)', () => {
  const davinciSegment = marketSegmentOptions(profileFor('HRDAV'))?.[0] ?? '';
  const davinciStay = {
    ...labStay,
    propertyCode: 'HRDAV' as const,
    marketSegment: davinciSegment,
    guestoptin4: true,
    reservationNote: 'Test billing instructions',
  };


  it('validates Cloud Create fields before native staging', () => {
    const stay = { ...labStay, propertyCode: 'HRDAV', marketSegment: 'COR', guestoptin4: false,
      reservationNote: 'Test billing instructions', childAges: [] };
    expect(mapPaneStayToCloudCreateInput(stay, 'prepare')).toMatchObject({ outcome: 'ok', input: {
      propertyCode: 'HRDAV', marketSegment: 'COR', guestoptin4: false,
    } });
    expect(mapPaneStayToCloudCreateInput({ ...stay, marketSegment: '' }, 'prepare'))
      .toMatchObject({ outcome: 'refused', field: 'marketSegment' });
    expect(mapPaneStayToCloudCreateInput({ ...stay, reservationNote: ' ' }, 'prepare'))
      .toMatchObject({ outcome: 'refused', reason: 'staff_note_required' });
    expect(mapPaneStayToCloudCreateInput({ ...stay, guaranteeType: 'UNKNOWN' }, 'prepare'))
      .toMatchObject({ outcome: 'refused', reason: 'cloud_create_guarantee_unsupported' });
    expect(mapPaneStayToCloudCreateInput({ ...stay, confirmationSendMail: true }, 'prepare', undefined, { allowRealGuest: true }))
      .toMatchObject({ outcome: 'refused', reason: 'labtest_send_forbidden' });
  });

  it('is off unless HMS_DAVINCI_CREATE is lab or on, same as PANE_WRITE_CREATE', () => {
    expect(hmsDavinciCreateMode({})).toBe('off');
    expect(hmsDavinciCreateMode({ HMS_DAVINCI_CREATE: 'off' })).toBe('off');
    expect(hmsDavinciCreateMode({ HMS_DAVINCI_CREATE: 'true' })).toBe('off');
    expect(hmsDavinciCreateMode({ HMS_DAVINCI_CREATE: '1' })).toBe('off');
    expect(hmsDavinciCreateMode({ HMS_DAVINCI_MAKE_QUOTE: 'on' })).toBe('off');
    expect(hmsDavinciCreateMode({ HMS_DAVINCI_READS: 'on' })).toBe('off');
    expect(hmsDavinciCreateMode({ HMS_DAVINCI_CREATE: 'lab' })).toBe('lab');
    expect(hmsDavinciCreateMode({ HMS_DAVINCI_CREATE: 'on' })).toBe('on');
  });

  it('HRDAV + gate off → refused before lock or spawn', async () => {
    vi.stubEnv('HMS_DAVINCI_CREATE', 'off');
    const locked: string[] = [];
    paneStaySaveLoaders.mode = () => 'lab';
    paneStaySaveLoaders.lock = passingLock(locked);
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      runPaneStay({ mode: 'preview', stay: davinciStay, owner: freshOwner('transport-davinci') }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_property_mismatch' });
    await expect(
      runPaneStay({
        mode: 'preview',
        stay: labStay,
        owner: freshOwner('transport-faith'),
      }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_property_mismatch' });
    expect(paneStayCreateTarget({ transportId: 'transport-davinci' })).toEqual({
      ok: false,
      reason: 'pane_save_property_mismatch',
    });
    expect(locked).toEqual([]);
  });

  it('stages HRDAV with its selected Cloud property and no borrowed browser settings', async () => {
    vi.stubEnv('HMS_DAVINCI_CREATE', 'lab');
    enableSave();
    const seen: PaneStaySpawnInput[] = [];
    paneStaySaveLoaders.spawn = async (input) => { seen.push(input); return cliSpawn(input); };
    await expect(runPaneStay({ mode: 'preview', stay: davinciStay, owner: freshOwner('transport-davinci') }))
      .resolves.toMatchObject({ status: 'ok', outcome: 'previewed', clickedSave: false });
    expect(seen[0]?.target).toEqual(DAVINCI_HMS_READ_TARGET);
    expect(seen[0]?.transportId).toBe('transport-davinci');
    const env = paneStayCreateSpawnEnv(DAVINCI_HMS_READ_TARGET, { PATH: '/usr/bin',
      HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19223', HMS_READ_SECRET_ARN: 'legacy-secret' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HMS_STAGEHAND_CDP_URL).toBeUndefined();
    expect(env.HMS_READ_SECRET_ARN).toBeUndefined();
    expect(paneStayCreateTarget({ transportId: 'transport-kmgidi', env: { HMS_DAVINCI_CREATE: 'on' } }))
      .toEqual({ ok: true, target: DAVINCI_HMS_READ_TARGET });
  });

  it('allows real HRDAV details in an unsaved lab preview and refuses them at Save', async () => {
    vi.stubEnv('HMS_DAVINCI_ENABLED_PROPERTIES', 'HRDAV');
    vi.stubEnv('HMS_DAVINCI_READS', 'on');
    vi.stubEnv('HMS_DAVINCI_CREATE', 'lab');
    enableSave();
    const guest = { ...davinciStay, lastName: 'Guest' };
    const spawn = vi.fn(cliSpawn);
    paneStaySaveLoaders.spawn = spawn;
    await expect(runPaneStay({ mode: 'preview', stay: guest, owner: freshOwner('transport-davinci') }))
      .resolves.toMatchObject({ status: 'ok', outcome: 'previewed', clickedSave: false });
    expect(spawn.mock.calls[0]?.[0].target?.propertyCode).toBe('HRDAV');
    spawn.mockClear();
    await expect(runPaneStay({ mode: 'commit', stay: guest, owner: freshOwner('transport-davinci') }))
      .resolves.toMatchObject({ status: 'refused', reason: 'pane_save_labtest_required' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('HRDAV + on lets a real guest through when PANE_WRITE_CREATE is on', async () => {
    vi.stubEnv('HMS_DAVINCI_CREATE', 'on');
    enableSave();
    paneStaySaveLoaders.mode = () => 'on';
    const seen: PaneStaySpawnInput[] = [];
    paneStaySaveLoaders.spawn = async (input) => {
      seen.push(input);
      return cliSpawn(input);
    };
    const guest = { ...davinciStay, lastName: 'Guest', arrival: '2026-11-12', departure: '2026-11-14' };
    await expect(
      runPaneStay({ mode: 'preview', stay: guest, owner: freshOwner('transport-davinci') }),
    ).resolves.toMatchObject({ status: 'ok', outcome: 'previewed' });
    expect(seen[0]?.target).toEqual(DAVINCI_HMS_READ_TARGET);
  });

  it('keeps Centurion staging scoped to HRCEN when Da Vinci is enabled', async () => {
    vi.stubEnv('HMS_DAVINCI_CREATE', 'lab');
    enableSave();
    const seen: PaneStaySpawnInput[] = [];
    paneStaySaveLoaders.spawn = async (input) => { seen.push(input); return cliSpawn(input); };
    await expect(runPaneStay({ mode: 'preview', stay: labStay, owner: freshOwner('transport-centurion') }))
      .resolves.toMatchObject({ status: 'ok', outcome: 'previewed', clickedSave: false });
    expect(seen[0]?.target).toEqual(CENTURION_HMS_READ_TARGET);
    expect(seen[0]?.transportId).toBe('transport-centurion');
    expect(paneStayCreateTarget({ transportId: 'transport-centurion', env: { HMS_DAVINCI_CREATE: 'lab' } }))
      .toEqual({ ok: true, target: CENTURION_HMS_READ_TARGET });
  });

  it('passes --property for every HMS target', () => {
    expect(paneStayCreatePropertyArgs(DAVINCI_HMS_READ_TARGET)).toEqual(['--property', 'HRDAV']);
    expect(paneStayCreatePropertyArgs(CENTURION_HMS_READ_TARGET)).toEqual(['--property', 'HRCEN']);
    expect(paneStayCreatePropertyArgs(null)).toEqual([]);
  });

  it('PANE_WRITE_CREATE off still refuses Da Vinci create when the DV gate is lab', async () => {
    vi.stubEnv('HMS_DAVINCI_CREATE', 'lab');
    paneStaySaveLoaders.mode = () => 'off';
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      runPaneStay({ mode: 'preview', stay: davinciStay, owner: freshOwner('transport-davinci') }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_flag_off' });
  });
});

describe('create request schema for the pane fields', () => {
  const base = {
    arrival: '2026-11-12',
    departure: '2026-11-14',
    adults: 1,
    sourceOfBusiness: 'Walk in',
    roomType: 'STQN',
    ratePlan: 'TAXYZ',
    track: 'BAR',
    firstName: 'Ann',
    lastName: 'Smith',
    guaranteeType: 'Awaiting Voucher',
  };

  it('refuses adults 0 in the create request schema', async () => {
    const schema = await loadCreateToolSchema();
    expect(schema.$defs.request.properties.adults.minimum).toBe(1);
    expect(validateCreateRequest({ ...base, adults: 0 }, schema).ok).toBe(false);
    expect(validateCreateRequest({ ...base, adults: 1 }, schema).ok).toBe(true);
  });

  it('keeps the schema caps equal to the server caps', async () => {
    const schema = await loadCreateToolSchema();
    const request = schema.$defs.request.properties;
    expect(request.reservationNote.maxLength).toBe(PANE_RESERVATION_NOTE_MAX);
    expect(request.bookerName.maxLength).toBe(PANE_BOOKER_NAME_MAX);
    expect(request.bookerEmail.maxLength).toBe(PANE_BOOKER_EMAIL_MAX);
    expect(request.marketSegment.maxLength).toBe(PANE_MARKET_SEGMENT_MAX);
    expect(schema.$defs.partyRef.properties.name.maxLength).toBe(PANE_PARTY_NAME_MAX);
    expect(schema.$defs.partyRef.properties.nativeId.maxLength).toBe(PANE_PARTY_NATIVE_ID_MAX);
  });

  it('accepts a 2000-character reservation note and refuses 2001', async () => {
    const schema = await loadCreateToolSchema();
    expect(validateCreateRequest({ ...base, reservationNote: 'n'.repeat(2000) }, schema).ok).toBe(true);
    expect(validateCreateRequest({ ...base, reservationNote: 'n'.repeat(2001) }, schema).ok).toBe(false);
  });

  it('still rejects keys the schema does not name, at the top level and inside a party', async () => {
    const schema = await loadCreateToolSchema();
    expect(validateCreateRequest({ ...base, mysteryKey: 'x' }, schema).ok).toBe(false);
    expect(
      validateCreateRequest({ ...base, bookingAgency: { name: 'XYZ', extra: 1 } }, schema).ok,
    ).toBe(false);
  });

  it('takes the draft organization as a name and the pane organization as a party', async () => {
    const schema = await loadCreateToolSchema();
    expect(validateCreateRequest({ ...base, organization: 'Bidvest' }, schema).ok).toBe(true);
    expect(validateCreateRequest({ ...base, organization: { name: 'Bidvest' } }, schema).ok).toBe(true);
    expect(validateCreateRequest({ ...base, organization: { name: '' } }, schema).ok).toBe(false);
  });

  it('maps the pane fields onto the runner fills, and a blank stay fills nothing', () => {
    expect(
      optionalPartyAndNoteFills({
        bookingAgency: { name: 'XYZ TRAVEL' },
        organization: { name: 'Bidvest' },
        reservationNote: 'Pay by EFT',
        bookerName: 'Ann',
        bookerEmail: 'ann@example.invalid',
      }),
    ).toEqual({
      company: 'Bidvest',
      reservationnote: 'Pay by EFT',
      caller: 'Ann',
      udfchar06: 'ann@example.invalid',
    });
    expect(optionalPartyAndNoteFills({ agency: 'CIDB', organization: 'Org' })).toMatchObject({
      company: 'Org',
    });
    expect(optionalPartyAndNoteFills(base)).toEqual({
      company: '',
      reservationnote: '',
      caller: '',
      udfchar06: '',
    });
  });

  it('enforces property form policy and preserves both opt-in values in Cloud input', () => {
    const policy = { requiredFields: ['marketsegment', 'guestoptin4'], guestOptIn: 'required' as const,
      cancellation: 'unknown' as const, guaranteeChoices: [], cmsChoices: [], childCategoryPolicy: 'discover_active' as const,
      marketSegmentChoices: [{ code: 'COR', meaning: 'Corporate' }] };
    expect(cloudCreatePolicyIssue(policy, {})).toBe('guest_opt_in_required');
    expect(cloudCreatePolicyIssue(policy, { guestoptin4: false })).toBe('market_segment_required');
    expect(cloudCreatePolicyIssue(policy, { guestoptin4: false, marketSegment: 'OTHER' })).toBe('market_segment_unavailable');
    for (const guestoptin4 of [false, true]) {
      const stay = { ...labStay, propertyCode: 'HRDAV', marketSegment: 'COR', guestoptin4,
        reservationNote: 'Test instructions', childAges: [] };
      const mapped = mapPaneStayToCloudCreateInput(stay, 'prepare');
      expect(mapped).toMatchObject({ outcome: 'ok', input: { propertyCode: 'HRDAV', marketSegment: 'COR', guestoptin4 } });
      if (mapped.outcome !== 'ok') throw new Error('expected valid Cloud input');
      expect(cloudCreatePolicyIssue(policy, mapped.input)).toBeNull();
    }
  });
});

describe('stay commit persist/reload', () => {
  const booked = {
    confirmationNumber: '46184891-1',
    status: 'booked' as const,
    screenshotRef: { runId: '11111111-2222-3333-4444-555555555555', name: 'saved.png' },
  };

  it('reload reads the confirmation saved on the stay', () => {
    const state = withStayCommit({}, 's_1', booked);
    expect(stayCommitOf(state, 's_1')).toEqual(booked);
    const longId = `room_${'a'.repeat(36)}_1`;
    expect(stayCommitOf(JSON.parse(JSON.stringify(withStayCommit(state, longId, booked))), longId)).toEqual(booked);
  });

  it('persists a saved CMS mismatch across JSON reload without permitting another booking', () => {
    const cmsMismatches = [{ field: 'udfchar09', expected: '03', actual: '' },
      { field: 'send', expected: true, actual: false }];
    const record = stayCommitFromPaneResult({ status: 'ok', outcome: 'committed_unverified',
      confirmationNumber: '46184891-1', cmsReason: 'saved_cms_mismatch', cmsMismatches });
    expect(record).not.toBeNull();
    const state = JSON.parse(JSON.stringify(withStayCommit({}, 's_1', record!)));
    expect(stayCommitOf(state, 's_1')).toMatchObject({ status: 'unknown',
      cmsReason: 'saved_cms_mismatch', cmsMismatches });
    expect(stayCommitGuard(stayCommitOf(state, 's_1'))).toEqual({ action: 'refuse', reason: PANE_STAY_ALREADY_BOOKED });
    const afterAction = withStayActionResult(state, 's_1', { confirmationNumber: '46184891-1', screenshotRef: null });
    expect(stayCommitOf(afterAction, 's_1')).toMatchObject({ cmsReason: 'saved_cms_mismatch', cmsMismatches });
  });

  it('commit refuses a stay that already has a number', () => {
    expect(stayCommitGuard(booked)).toEqual({ action: 'refuse', reason: PANE_STAY_ALREADY_BOOKED });
    expect(stayCommitGuard({ confirmationNumber: '46184891-1', status: 'unknown', screenshotRef: null })).toEqual({
      action: 'refuse',
      reason: PANE_STAY_ALREADY_BOOKED,
    });
  });

  it('unknown outcome requires an HMS read before retry', () => {
    expect(stayCommitGuard({ confirmationNumber: null, status: 'unknown', screenshotRef: booked.screenshotRef })).toEqual(
      { action: 'read_hms' },
    );
  });

  it('keeps field-path edits next to the nested stays map', () => {
    const state = withStayCommit({ 'stays[s_1].requested.arrival': '2027-10-25' }, 's_1', booked);
    expect(state['stays[s_1].requested.arrival']).toBe('2027-10-25');
    expect(stayCommitOf(state, 's_1')).toEqual(booked);
  });

  it('records an unverified save without a number as unknown', () => {
    expect(stayCommitFromPaneResult({ status: 'ok', outcome: 'committed_unverified' })).toEqual({
      confirmationNumber: null,
      status: 'unknown',
      screenshotRef: null,
    });
    expect(
      stayCommitFromPaneResult({
        status: 'refused',
        reason: 'pane_save_unconfirmed',
        runId: booked.screenshotRef.runId,
        screenshots: ['saved.png'],
      }),
    ).toEqual({
      confirmationNumber: null,
      status: 'unknown',
      screenshotRef: booked.screenshotRef,
      runId: booked.screenshotRef.runId,
    });
  });
});

describe('pane stay preview persist', () => {
  it('refuses partial or blank bound identity before any preview or commit', async () => {
    enableSave();
    const owner = freshOwner();
    const spawn = vi.fn(cliSpawn);
    paneStaySaveLoaders.spawn = spawn;
    for (const mode of ['preview', 'commit'] as const) {
      for (const binding of [
        { workItemId: randomUUID() }, { stayId: 's_1' },
        { workItemId: '', stayId: 's_1' }, { workItemId: randomUUID(), stayId: '' },
      ]) {
        await expect(runPaneStay({ mode, stay: labStay, owner, ...binding, previewDigest: paneStayDigest(labStay) }))
          .resolves.toEqual({ status: 'refused', reason: 'pane_preview_binding_required' });
      }
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses a bound preview when persistence fails and discards its local preview', async () => {
    enableSave();
    const owner = freshOwner();
    paneStaySaveLoaders.previewPersist = { record: () => { throw new Error('database_unavailable'); }, take: () => false };
    await expect(runPaneStay({ mode: 'preview', stay: labStay, owner, workItemId: randomUUID(), stayId: 's_1' }))
      .resolves.toEqual({ status: 'refused', reason: 'pane_preview_persist_failed' });
    expect(takePanePreview(owner, paneStayDigest(labStay), paneStayClock())).toBe(false);
  });

  it('registers a fenced preview run for expiry even when preview persistence refuses', async () => {
    enableSave();
    const owner = freshOwner();
    const runDir = await mkdtemp(join(tmpdir(), 'pane-stay-test-'));
    const runId = randomUUID();
    let now = 9_000_000;
    paneStaySaveLoaders.now = () => now;
    paneStaySaveLoaders.spawn = async () => ({
      outcome: 'previewed', clickedSave: false, confirmationNumber: '', runId, runDir,
    });
    paneStaySaveLoaders.previewPersist = {
      record: () => { throw new CreateFenceError('active'); },
      take: () => false,
    };
    try {
      await expect(runPaneStay({
        mode: 'preview', stay: labStay, owner, workItemId: randomUUID(), stayId: 's_1',
      })).resolves.toMatchObject({ status: 'refused', reason: 'pane_preview_persist_failed' });
      now += PANE_RUN_TTL_MS + 1;
      await readPaneStayScreenshot({ runId, name: 'filled.png', owner });
      await expect(stat(runDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('does not retain a local preview if a create fence prevents persistence', async () => {
    enableSave();
    const owner = freshOwner();
    paneStaySaveLoaders.previewPersist = { record: () => { throw new CreateFenceError('active'); }, take: () => false };
    await expect(runPaneStay({ mode: 'preview', stay: labStay, owner, workItemId: randomUUID(), stayId: 's_1' }))
      .resolves.toMatchObject({ status: 'refused', reason: 'pane_preview_persist_failed' });
    expect(takePanePreview(owner, paneStayDigest(labStay), paneStayClock())).toBe(false);
  });

  it('persists preview data across reload without treating it as Save authority', async () => {
    vi.stubEnv('PANE_WRITE_CREATE', 'lab');
    vi.stubEnv('PANE_CLOUD_CREATE_DISPATCH', 'on');
    enableSave();
    let state: Record<string, unknown> = {};
    paneStaySaveLoaders.previewPersist = {
      record: ({ stayId, digest, now }) => { state = withStayPreview(state, stayId,
        { digest, status: 'previewed', expiresAt: now + PANE_PREVIEW_TTL_MS }); },
      take: () => false,
    };
    const owner = freshOwner(), workItemId = randomUUID(), stayId = 's_1';
    const preview = await runPaneStay({ mode: 'preview', stay: labStay, owner, workItemId, stayId });
    expect(preview).toMatchObject({ status: 'ok', outcome: 'previewed', clickedSave: false });
    const reloaded = JSON.parse(JSON.stringify(state));
    expect(stayPreviewOf(reloaded, stayId)?.digest).toBe(paneStayDigest(labStay));
    clearPanePreviewMemory();
    const spawn = vi.fn(cliSpawn);
    paneStaySaveLoaders.spawn = spawn;
    await expect(runPaneStay({ mode: 'commit', stay: labStay, owner, workItemId, stayId, previewDigest: preview.previewDigest }))
      .resolves.toMatchObject({ status: 'refused', reason: 'fresh_preparation_required' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses a bound preview when no durable persistence is available', async () => {
    enableSave();
    const owner = freshOwner();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(runPaneStay({ mode: 'preview', stay: labStay, owner, workItemId: randomUUID(), stayId: 's_1' }))
        .resolves.toMatchObject({ status: 'refused', reason: 'pane_preview_persist_failed' });
      expect(takePanePreview(owner, paneStayDigest(labStay), paneStayClock())).toBe(false);
    } finally { warn.mockRestore(); }
  });
});
