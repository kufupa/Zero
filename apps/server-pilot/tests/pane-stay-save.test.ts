import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertLabStayGuard,
  PANE_PREVIEW_TTL_MS,
  PANE_RUN_TTL_MS,
  PANE_STAY_PROPERTY_CODE,
  type PaneStayLock,
  type PaneStaySpawnInput,
  type PaneStaySpawnResult,
  paneStayDigest,
  paneStayPropertyLock,
  paneStayPropertyRefusal,
  paneStayRequestBody,
  paneStaySaveEnabled,
  paneStaySaveLoaders,
  paneWriteMode,
  paneWriteModes,
  paneStayCreatePropertyArgs,
  paneStayCreateSpawnEnv,
  paneStayCreateTarget,
  paneStayTenantId,
  readPaneStayScreenshot,
  runPaneStay,
} from '../src/ai/pane-stay-save.js';
import { hmsDavinciCreateMode } from '../src/env.js';
import { CENTURION_HMS_READ_TARGET, DAVINCI_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';
import { PROPERTY_READ_LOCK_DEADLINE_MESSAGE, propertyReadLockKey } from '../src/hms/property-read-lock.js';
import {
  PANE_BOOKER_EMAIL_MAX,
  PANE_BOOKER_NAME_MAX,
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
} from '../tooling/playwright-quote/create-request.mjs';
import {
  PANE_STAY_ALREADY_BOOKED,
  stayCommitFromPaneResult,
  stayCommitGuard,
  stayCommitOf,
  withStayCommit,
} from '../src/ai/work-items.js';

const labStay = {
  firstName: 'Pat',
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
  vi.unstubAllEnvs();
});

describe('pane stay save guards', () => {
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

  it('treats *_PAID=on as off and logs it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(paneWriteMode('amend', 'paid', { PANE_WRITE_AMEND_PAID: 'on' })).toBe('off');
    expect(paneWriteMode('cancel', 'paid', { PANE_WRITE_CANCEL_PAID: 'on' })).toBe('off');
    expect(paneWriteMode('amend', 'paid', { PANE_WRITE_AMEND_PAID: 'lab' })).toBe('lab');
    expect(warn).toHaveBeenCalledWith('pane_write_paid_on_ignored', { env: 'PANE_WRITE_AMEND_PAID' });
    expect(warn).toHaveBeenCalledWith('pane_write_paid_on_ignored', { env: 'PANE_WRITE_CANCEL_PAID' });
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

  it('refuses refused_lock_busy in commit when the duplicate check cannot get the lock in time', async () => {
    enableSave();
    paneStaySaveLoaders.osressGuestDatesSearch = async () => 'busy';
    await expect(
      runPaneStay({ mode: 'commit', stay: labStay, owner: freshOwner(), previewDigest: paneStayDigest(labStay) }),
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

  it('refuses an explicit HRDAV propertyCode before any write lock or spawn', async () => {
    const locked: string[] = [];
    paneStaySaveLoaders.mode = () => 'lab';
    paneStaySaveLoaders.lock = passingLock(locked);
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    for (const mode of ['preview', 'commit'] as const) {
      await expect(
        runPaneStay({
          mode,
          stay: { ...labStay, propertyCode: 'HRDAV' },
          owner: freshOwner(),
          previewDigest: '0'.repeat(64),
        }),
      ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_property_mismatch' });
    }
    expect(locked).toEqual([]);
  });

  it('accepts an explicit propertyCode that names the session hotel', () => {
    expect(paneStayPropertyRefusal(undefined)).toBeNull();
    expect(paneStayPropertyRefusal(PANE_STAY_PROPERTY_CODE)).toBeNull();
    expect(paneStayPropertyRefusal('hrcen')).toBe('pane_save_property_mismatch');
    expect(paneStayPropertyRefusal('')).toBe('pane_save_property_mismatch');
  });

  it('refuses unknown, collector, and missing pane targets instead of defaulting to HRCEN', () => {
    expect(paneStayCreateTarget({ transportId: 'transport-unknown' })).toEqual({
      ok: false,
      reason: 'property_unknown',
    });
    expect(paneStayCreateTarget({ transportId: 'transport-nava' })).toEqual({
      ok: false,
      reason: 'collector_no_hotel',
    });
    expect(paneStayCreateTarget({})).toEqual({ ok: false, reason: 'property_required' });
    expect(paneStayCreateTarget({ propertyCode: 'OTHER' })).toEqual({
      ok: false,
      reason: 'property_unknown',
    });
  });

  it('refuses an unknown transport before any write lock or spawn', async () => {
    const locked: string[] = [];
    paneStaySaveLoaders.mode = () => 'lab';
    paneStaySaveLoaders.lock = passingLock(locked);
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      runPaneStay({ mode: 'preview', stay: labStay, owner: freshOwner('transport-unknown') }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'property_unknown' });
    expect(locked).toEqual([]);
  });

  it('the production property lock is keyed on the session hotel and the worker tenant', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:secret@127.0.0.1:5432/zero_test');
    vi.stubEnv('PANE_STAY_TENANT_ID', '');
    vi.stubEnv('HMS_EXPECTED_TENANT', 'centurion');
    const lock = paneStayPropertyLock(CENTURION_HMS_READ_TARGET) as unknown as { key: string } | null;
    expect(lock?.key).toBe(propertyReadLockKey('centurion', 'HRCEN'));
    expect(lock?.key).not.toBe(propertyReadLockKey('centurion', 'OTHER'));
  });

  it('read locks for HRCEN and HRDAV use distinct keys', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:secret@127.0.0.1:5432/zero_test');
    vi.stubEnv('HMS_EXPECTED_TENANT', 'centurion');
    const hrcen = paneStayPropertyLock(CENTURION_HMS_READ_TARGET) as unknown as { key: string } | null;
    const hrdav = paneStayPropertyLock(DAVINCI_HMS_READ_TARGET) as unknown as { key: string } | null;
    expect(hrcen?.key).toBe(propertyReadLockKey('centurion', 'HRCEN'));
    expect(hrdav?.key).toBe(propertyReadLockKey('centurion', 'HRDAV'));
    expect(hrcen?.key).not.toBe(hrdav?.key);
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

  it('commit refuses when OSRESS finds a duplicate stay', async () => {
    paneStaySaveLoaders.mode = () => 'lab';
    paneStaySaveLoaders.lock = passingLock();
    paneStaySaveLoaders.osressGuestDatesSearch = async () => 'duplicate';
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      runPaneStay({ mode: 'commit', stay: labStay, owner: freshOwner(), previewDigest: paneStayDigest(labStay) }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'osress_duplicate' });
  });

  it('commit refuses when the OSRESS guest-date reader is parked', async () => {
    paneStaySaveLoaders.mode = () => 'lab';
    paneStaySaveLoaders.osressGuestDatesSearch = null;
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      runPaneStay({ mode: 'commit', stay: labStay, owner: freshOwner() }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'osress_reader_parked' });
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
    expect(paneStayDigest({ ...labStay, firstName: '  Pat  ' })).toBe(paneStayDigest(labStay));
    expect(paneStayDigest({ ...labStay, arrival: '2027-09-15' })).not.toBe(paneStayDigest(labStay));
  });

  it('a refused preview grants nothing, so its digest cannot commit', async () => {
    enableSave();
    const owner = freshOwner();
    paneStaySaveLoaders.spawn = async () => ({
      outcome: 'refused_save_blank_required',
      clickedSave: false,
      confirmationNumber: '',
    });
    const preview = await runPaneStay({ mode: 'preview', stay: labStay, owner });
    expect(preview).toMatchObject({ status: 'refused', reason: 'refused_save_blank_required' });
    expect(preview.previewDigest).toBeUndefined();
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      runPaneStay({ mode: 'commit', stay: labStay, owner, previewDigest: paneStayDigest(labStay) }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_preview_required' });
  });

  it('commit without a previewDigest is refused before the lock or any spawn', async () => {
    enableSave();
    const seen: string[] = [];
    paneStaySaveLoaders.lock = passingLock(seen);
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      runPaneStay({ mode: 'commit', stay: labStay, owner: freshOwner() }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_preview_required' });
    expect(seen).toEqual([]);
  });

  it('a digest for a different stay is a mismatch and never spawns', async () => {
    enableSave();
    const owner = freshOwner();
    await runPaneStay({ mode: 'preview', stay: labStay, owner });
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      runPaneStay({
        mode: 'commit',
        stay: { ...labStay, roomType: 'DBL' },
        owner,
        previewDigest: paneStayDigest(labStay),
      }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_digest_mismatch' });
  });

  it('runs the duplicate read under the same property lock as the save, taken once', async () => {
    enableSave();
    const owner = freshOwner();
    const preview = await runPaneStay({ mode: 'preview', stay: labStay, owner });
    const previewDigest = preview.previewDigest as string;
    let held = false;
    let acquisitions = 0;
    paneStaySaveLoaders.lock = {
      withLock: async (fn) => {
        acquisitions += 1;
        held = true;
        try {
          return await fn();
        } finally {
          held = false;
        }
      },
    };
    const heldDuringRead: boolean[] = [];
    paneStaySaveLoaders.osressGuestDatesSearch = async () => {
      heldDuringRead.push(held);
      return 'clear';
    };
    await expect(
      runPaneStay({ mode: 'commit', stay: labStay, owner, previewDigest }),
    ).resolves.toMatchObject({ status: 'ok', outcome: 'committed' });
    expect(heldDuringRead).toEqual([true]);
    expect(acquisitions).toBe(1);
  });

  it('a matching preview commits once; replaying the same grant is refused', async () => {
    enableSave();
    const owner = freshOwner();
    const preview = await runPaneStay({ mode: 'preview', stay: labStay, owner });
    const previewDigest = preview.previewDigest as string;
    await expect(
      runPaneStay({ mode: 'commit', stay: labStay, owner, previewDigest }),
    ).resolves.toMatchObject({ status: 'ok', outcome: 'committed', confirmationNumber: '46184891-1' });
    await expect(
      runPaneStay({ mode: 'commit', stay: labStay, owner, previewDigest }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_preview_required' });
  });

  it('a preview grant expires after 10 minutes and belongs to the previewing owner', async () => {
    enableSave();
    const owner = freshOwner();
    let now = 1_000_000;
    paneStaySaveLoaders.now = () => now;
    await runPaneStay({ mode: 'preview', stay: labStay, owner });
    const previewDigest = paneStayDigest(labStay);
    await expect(
      runPaneStay({ mode: 'commit', stay: labStay, owner: freshOwner(), previewDigest }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_preview_required' });
    now += PANE_PREVIEW_TTL_MS + 1;
    await expect(
      runPaneStay({ mode: 'commit', stay: labStay, owner, previewDigest }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_preview_required' });
  });

  it('never reports committed when the runner readback did not match', async () => {
    enableSave();
    const owner = freshOwner();
    const preview = await runPaneStay({ mode: 'preview', stay: labStay, owner });
    paneStaySaveLoaders.spawn = async () => ({
      outcome: 'committed_unverified',
      clickedSave: true,
      confirmationNumber: '46184891-1',
    });
    await expect(
      runPaneStay({
        mode: 'commit',
        stay: labStay,
        owner,
        previewDigest: preview.previewDigest ?? undefined,
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      outcome: 'committed_unverified',
      confirmationNumber: '46184891-1',
    });
  });

  it('commit spawns a fresh fill under lock after its preview and returns the confirmation', async () => {
    enableSave();
    const owner = freshOwner();
    const preview = await runPaneStay({ mode: 'preview', stay: labStay, owner });
    paneStaySaveLoaders.spawn = async (input) => {
      expect(input.paneCommit).toBe(true);
      expect(input.stopBefore).toBeNull();
      return { outcome: 'committed', clickedSave: true, confirmationNumber: '46184891-1' };
    };
    await expect(
      runPaneStay({ mode: 'commit', stay: labStay, owner, previewDigest: preview.previewDigest ?? undefined }),
    ).resolves.toMatchObject({ status: 'ok', outcome: 'committed', confirmationNumber: '46184891-1' });
  });

  it('does not reuse a preview session for commit', async () => {
    enableSave();
    const sessions: string[] = [];
    paneStaySaveLoaders.spawn = async (input) => {
      sessions.push(input.paneCommit ? 'commit' : 'preview');
      return cliSpawn(input);
    };
    const owner = freshOwner();
    const preview = await runPaneStay({ mode: 'preview', stay: labStay, owner });
    await runPaneStay({ mode: 'commit', stay: labStay, owner, previewDigest: preview.previewDigest ?? undefined });
    expect(sessions).toEqual(['preview', 'commit']);
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

describe('pane stay unconfirmed saves', () => {
  it('a commit with no booking number is refused as pane_save_unconfirmed, keeps its run, and spends the grant', async () => {
    enableSave();
    const owner = freshOwner();
    const runDir = await mkdtemp(join(tmpdir(), 'pane-stay-test-'));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(join(runDir, 'saved.png'), png);
    const runId = randomUUID();
    paneStaySaveLoaders.spawn = async (input) =>
      input.paneCommit
        ? {
            outcome: 'save_unconfirmed',
            clickedSave: true,
            confirmationNumber: '',
            runId,
            runDir,
            screenshots: ['saved.png'],
          }
        : { outcome: 'previewed', clickedSave: false, confirmationNumber: '' };
    try {
      const preview = await runPaneStay({ mode: 'preview', stay: labStay, owner });
      const previewDigest = preview.previewDigest as string;
      await expect(
        runPaneStay({ mode: 'commit', stay: labStay, owner, previewDigest }),
      ).resolves.toEqual({
        status: 'refused',
        reason: 'pane_save_unconfirmed',
        runId,
        screenshots: ['saved.png'],
      });
      await expect(readPaneStayScreenshot({ runId, name: 'saved.png', owner })).resolves.toEqual({
        status: 'ok',
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      });
      await expect(
        runPaneStay({ mode: 'commit', stay: labStay, owner, previewDigest }),
      ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_preview_required' });
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it('a save_failed from the CLI gets the same rule: it is never a plain failure', async () => {
    enableSave();
    const owner = freshOwner();
    paneStaySaveLoaders.spawn = async (input) =>
      input.paneCommit
        ? { outcome: 'save_failed', clickedSave: true, confirmationNumber: '' }
        : { outcome: 'previewed', clickedSave: false, confirmationNumber: '' };
    const preview = await runPaneStay({ mode: 'preview', stay: labStay, owner });
    await expect(
      runPaneStay({ mode: 'commit', stay: labStay, owner, previewDigest: preview.previewDigest as string }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_unconfirmed' });
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
  it('lab keeps the Labtest guard: a real surname or a 2026 arrival is refused before any spawn', async () => {
    enableSave();
    paneStaySaveLoaders.mode = () => 'lab';
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      runPaneStay({ mode: 'preview', stay: realStay, owner: freshOwner() }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_labtest_required' });
    await expect(
      runPaneStay({
        mode: 'preview',
        stay: { ...labStay, arrival: '2026-12-31', departure: '2027-01-02' },
        owner: freshOwner(),
      }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_arrival_2027_required' });
    await expect(
      runPaneStay({
        mode: 'commit',
        stay: realStay,
        owner: freshOwner(),
        previewDigest: paneStayDigest(realStay),
      }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_labtest_required' });
  });

  it('on lets a real guest through preview and commit, under the same grant rules', async () => {
    enableSave();
    paneStaySaveLoaders.mode = () => 'on';
    const owner = freshOwner();
    const preview = await runPaneStay({ mode: 'preview', stay: realStay, owner });
    expect(preview).toMatchObject({
      status: 'ok',
      outcome: 'previewed',
      previewDigest: paneStayDigest(realStay),
    });
    await expect(
      runPaneStay({ mode: 'commit', stay: realStay, owner, previewDigest: paneStayDigest(realStay) }),
    ).resolves.toMatchObject({ status: 'ok', outcome: 'committed', confirmationNumber: '46184891-1' });
  });

  it('on still refuses a commit when the duplicate check finds the guest on those dates', async () => {
    enableSave();
    paneStaySaveLoaders.mode = () => 'on';
    paneStaySaveLoaders.osressGuestDatesSearch = async () => 'duplicate';
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      runPaneStay({
        mode: 'commit',
        stay: realStay,
        owner: freshOwner(),
        previewDigest: paneStayDigest(realStay),
      }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'osress_duplicate' });
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

  it('refuses a commit whose agency, organization, note or booker differs from the previewed stay', async () => {
    enableSave();
    paneStaySaveLoaders.mode = () => 'on';
    const owner = freshOwner();
    const previewed = {
      ...realStay,
      bookingAgency: { name: 'XYZ TRAVEL' },
      reservationNote: 'Late arrival',
    };
    const preview = await runPaneStay({ mode: 'preview', stay: previewed, owner });
    const digest = preview.previewDigest as string;
    for (const changed of [
      { ...previewed, reservationNote: 'Early arrival' },
      { ...previewed, bookingAgency: { name: 'ABC TRAVEL' } },
      { ...previewed, organization: { name: 'Bidvest' } },
      { ...previewed, bookerEmail: 'other@example.invalid' },
    ]) {
      await expect(
        runPaneStay({ mode: 'commit', stay: changed, owner, previewDigest: digest }),
      ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_digest_mismatch' });
    }
    // A mismatch does not spend the grant: the previewed stay still commits.
    await expect(
      runPaneStay({ mode: 'commit', stay: previewed, owner, previewDigest: digest }),
    ).resolves.toMatchObject({ status: 'ok', outcome: 'committed' });
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

  it('children are copy-only: a stay with child ages is refused before any spawn, in preview and commit', async () => {
    enableSave();
    paneStaySaveLoaders.mode = () => 'on';
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    const withChildren = { ...realStay, childAges: [5] };
    await expect(
      runPaneStay({ mode: 'preview', stay: withChildren, owner: freshOwner() }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_children_unsupported' });
    await expect(
      runPaneStay({
        mode: 'commit',
        stay: withChildren,
        owner: freshOwner(),
        previewDigest: paneStayDigest(withChildren),
      }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_children_unsupported' });
    expect(paneStayModeRefusal('on', { ...realStay, childAges: [] })).toBeNull();
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
  const davinciStay = { ...labStay, propertyCode: 'HRDAV' as const };

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

  it('HRDAV + gate lab + Labtest → spawn env has DV slot/secret and propertyCode HRDAV', async () => {
    vi.stubEnv('HMS_DAVINCI_CREATE', 'lab');
    enableSave();
    const seen: PaneStaySpawnInput[] = [];
    paneStaySaveLoaders.spawn = async (input) => {
      seen.push(input);
      return cliSpawn(input);
    };
    await expect(
      runPaneStay({ mode: 'preview', stay: davinciStay, owner: freshOwner('transport-davinci') }),
    ).resolves.toMatchObject({ status: 'ok', outcome: 'previewed' });
    expect(seen[0]?.target).toEqual(DAVINCI_HMS_READ_TARGET);
    expect(seen[0]?.target?.propertyCode).toBe('HRDAV');
    const spawnEnv = paneStayCreateSpawnEnv(DAVINCI_HMS_READ_TARGET, {
      PATH: '/usr/bin',
      HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19223',
      HMS_STAGEHAND_CDP_URL_DAVINCI: 'http://127.0.0.1:19225',
      HMS_READ_SECRET_ARN: 'nava-zero/server-pilot/infor-hms-read',
    });
    expect(spawnEnv.HMS_READ_SECRET_ARN).toBe(DAVINCI_HMS_READ_TARGET.secretId);
    expect(spawnEnv.HMS_STAGEHAND_CDP_URL).toBe('http://127.0.0.1:19225');
    expect(spawnEnv.HMS_STAGEHAND_BROWSER_OWNERSHIP).toBe('borrowed');
    expect(paneStayCreateTarget({ transportId: 'transport-kmgidi', env: { HMS_DAVINCI_CREATE: 'on' } })).toEqual({
      ok: true,
      target: DAVINCI_HMS_READ_TARGET,
    });
    vi.stubEnv('DATABASE_URL', 'postgres://user:secret@127.0.0.1:5432/zero_test');
    vi.stubEnv('HMS_EXPECTED_TENANT', 'centurion');
    const lock = paneStayPropertyLock(DAVINCI_HMS_READ_TARGET) as unknown as {
      key: string;
    } | null;
    expect(lock?.key).toBe(propertyReadLockKey('centurion', 'HRDAV'));
  });

  it('HRDAV + lab + non-Labtest → refused even when PANE_WRITE_CREATE is on', async () => {
    vi.stubEnv('HMS_DAVINCI_CREATE', 'lab');
    const locked: string[] = [];
    paneStaySaveLoaders.mode = () => 'on';
    paneStaySaveLoaders.lock = passingLock(locked);
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      runPaneStay({
        mode: 'preview',
        stay: { ...davinciStay, lastName: 'Guest' },
        owner: freshOwner('transport-davinci'),
      }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_labtest_required' });
    expect(locked).toEqual([]);
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

  it('Centurion create stays on HRCEN when the DV create gate is lab', async () => {
    vi.stubEnv('HMS_DAVINCI_CREATE', 'lab');
    enableSave();
    const seen: PaneStaySpawnInput[] = [];
    paneStaySaveLoaders.spawn = async (input) => {
      seen.push(input);
      return cliSpawn(input);
    };
    await expect(
      runPaneStay({ mode: 'preview', stay: labStay, owner: freshOwner('transport-centurion') }),
    ).resolves.toMatchObject({ status: 'ok', outcome: 'previewed' });
    expect(seen[0]?.target).toEqual(CENTURION_HMS_READ_TARGET);
    const spawnEnv = paneStayCreateSpawnEnv(CENTURION_HMS_READ_TARGET, {
      PATH: '/usr/bin',
      HMS_STAGEHAND_CDP_URL: 'http://127.0.0.1:19223',
      HMS_STAGEHAND_CDP_URL_DAVINCI: 'http://127.0.0.1:19225',
      HMS_READ_SECRET_ARN: 'nava-zero/server-pilot/infor-hms-read',
    });
    expect(spawnEnv.HMS_STAGEHAND_CDP_URL).toBe('http://127.0.0.1:19223');
    expect(spawnEnv.HMS_READ_SECRET_ARN).toBe('nava-zero/server-pilot/infor-hms-read');
    expect(paneStayCreateTarget({ transportId: 'transport-centurion', env: { HMS_DAVINCI_CREATE: 'lab' } })).toEqual(
      { ok: true, target: CENTURION_HMS_READ_TARGET },
    );
  });

  it('passes --property HRDAV only for the Da Vinci target', () => {
    expect(paneStayCreatePropertyArgs(DAVINCI_HMS_READ_TARGET)).toEqual(['--property', 'HRDAV']);
    expect(paneStayCreatePropertyArgs(CENTURION_HMS_READ_TARGET)).toEqual([]);
    expect(paneStayCreatePropertyArgs(null)).toEqual([]);
  });

  it('DV commit dup-check runs with the HRDAV target', async () => {
    vi.stubEnv('HMS_DAVINCI_CREATE', 'lab');
    enableSave();
    const seen: unknown[] = [];
    paneStaySaveLoaders.osressGuestDatesSearch = async (input) => {
      seen.push(input.target);
      return 'clear';
    };
    const owner = freshOwner('transport-davinci');
    const preview = await runPaneStay({ mode: 'preview', stay: davinciStay, owner });
    await expect(
      runPaneStay({
        mode: 'commit',
        stay: davinciStay,
        owner,
        previewDigest: preview.previewDigest ?? paneStayDigest(davinciStay),
      }),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(seen).toEqual([DAVINCI_HMS_READ_TARGET]);
  });

  it('Centurion commit dup-check stays on HRCEN', async () => {
    enableSave();
    const seen: unknown[] = [];
    paneStaySaveLoaders.osressGuestDatesSearch = async (input) => {
      seen.push(input.target);
      return 'clear';
    };
    const owner = freshOwner();
    const preview = await runPaneStay({ mode: 'preview', stay: labStay, owner });
    await expect(
      runPaneStay({
        mode: 'commit',
        stay: labStay,
        owner,
        previewDigest: preview.previewDigest ?? paneStayDigest(labStay),
      }),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(seen).toEqual([CENTURION_HMS_READ_TARGET]);
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
      ta1: 'XYZ TRAVEL',
      company: 'Bidvest',
      reservationnote: 'Pay by EFT',
      caller: 'Ann',
      udfchar06: 'ann@example.invalid',
    });
    expect(optionalPartyAndNoteFills({ agency: 'CIDB', organization: 'Org' })).toMatchObject({
      ta1: 'CIDB',
      company: 'Org',
    });
    expect(optionalPartyAndNoteFills(base)).toEqual({
      ta1: '',
      company: '',
      reservationnote: '',
      caller: '',
      udfchar06: '',
    });
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
    });
  });
});
