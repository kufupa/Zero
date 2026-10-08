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
  paneStayTenantId,
  readPaneStayScreenshot,
  runPaneStay,
} from '../src/ai/pane-stay-save.js';
import { propertyReadLockKey } from '../src/hms/property-read-lock.js';

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
function freshOwner(): string {
  ownerSeq += 1;
  return `user-${ownerSeq}:transport-1`;
}

function passingLock(seen: string[] = []): PaneStayLock {
  return {
    withLock: async (fn) => {
      seen.push('lock');
      return fn();
    },
  };
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
  paneStaySaveLoaders.enabled = () => true;
  paneStaySaveLoaders.lock = passingLock();
  paneStaySaveLoaders.osressGuestDatesSearch = async () => 'clear';
  paneStaySaveLoaders.spawn = cliSpawn;
}

afterEach(() => {
  paneStaySaveLoaders.spawn = null;
  paneStaySaveLoaders.lock = null;
  paneStaySaveLoaders.osressGuestDatesSearch = null;
  paneStaySaveLoaders.enabled = null;
  paneStaySaveLoaders.now = null;
  vi.unstubAllEnvs();
});

describe('pane stay save guards', () => {
  it('is off unless RESERVATIONIST_PANE_SAVE is on', () => {
    expect(paneStaySaveEnabled({})).toBe(false);
    expect(paneStaySaveEnabled({ RESERVATIONIST_PANE_SAVE: 'off' })).toBe(false);
    expect(paneStaySaveEnabled({ RESERVATIONIST_PANE_SAVE: 'on' })).toBe(true);
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

  it('refuses preview and commit when the flag is unset', async () => {
    paneStaySaveLoaders.enabled = () => false;
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

  it('refuses an explicit propertyCode for another hotel before any lock or spawn', async () => {
    const locked: string[] = [];
    paneStaySaveLoaders.enabled = () => true;
    paneStaySaveLoaders.lock = passingLock(locked);
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    for (const mode of ['preview', 'commit'] as const) {
      await expect(
        runPaneStay({
          mode,
          stay: { ...labStay, propertyCode: 'OTHER' },
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

  it('the production property lock is keyed on the session hotel and the worker tenant', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:secret@127.0.0.1:5432/zero_test');
    vi.stubEnv('PANE_STAY_TENANT_ID', '');
    vi.stubEnv('HMS_EXPECTED_TENANT', 'centurion');
    const lock = paneStayPropertyLock() as unknown as { key: string } | null;
    expect(lock?.key).toBe(propertyReadLockKey('centurion', 'HRCEN'));
    expect(lock?.key).not.toBe(propertyReadLockKey('centurion', 'OTHER'));
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
    expect(paneStayPropertyLock()).toBeNull();
  });

  it('omits propertyCode from the CLI request body', () => {
    expect(paneStayRequestBody({ ...labStay, propertyCode: 'HRCEN' })).not.toHaveProperty(
      'propertyCode',
    );
  });

  it('treats a refused CLI outcome as refused, not ok', async () => {
    paneStaySaveLoaders.enabled = () => true;
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
    paneStaySaveLoaders.enabled = () => true;
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
    paneStaySaveLoaders.enabled = () => true;
    paneStaySaveLoaders.osressGuestDatesSearch = async () => 'duplicate';
    paneStaySaveLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      runPaneStay({ mode: 'commit', stay: labStay, owner: freshOwner() }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'osress_duplicate' });
  });

  it('commit refuses when the OSRESS guest-date reader is parked', async () => {
    paneStaySaveLoaders.enabled = () => true;
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
