import {
  buildCancelStayArgs,
  checkCancelInput,
  commitCancel,
  paneCancelDigest,
  paneStayCancelEnabled,
  paneStayCancelLoaders,
  previewCancel,
  type PaneStayCancelSpawnInput,
  type PaneStayCancelSpawnResult,
} from '../src/ai/pane-stay-cancel.js';
import {
  PANE_PREVIEW_TTL_MS,
  PANE_RUN_ID_PATTERN,
  type PaneStayLock,
  paneStaySaveLoaders,
} from '../src/ai/pane-stay-save.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { appRouter } from '../src/trpc/router.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PROPERTY_READ_LOCK_DEADLINE_MESSAGE } from '../src/hms/property-read-lock.js';

const stay = { confirmation: '57291630-1', arrival: '2027-09-14' };
const owner = 'user-ropperman:transport-1';

// The error the production lock throws when its acquisition deadline passes while another run holds the lock.
function busyLockError(): Error {
  return Object.assign(new Error('property read advisory lock could not be acquired'), {
    code: 'PROPERTY_READ_LOCK_LOST',
    cause: new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE),
  });
}

// The digest the spec names: sha256 of the canonical JSON of {confirmation, arrival}, keys in fixed order.
function digestOf(input: { confirmation: string; arrival: string }): string {
  return createHash('sha256')
    .update(JSON.stringify({ arrival: input.arrival, confirmation: input.confirmation }))
    .digest('hex');
}

function mailboxCallerAs(userId: string) {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: {
      id: userId,
      email: 'ropperman@legacyhotels.co.za',
      name: 'R Opperman',
    },
    activeTransportId: 'transport-1',
    transportEmail: 'centurion@legacyhotels.co.za',
    accessRole: 'owner',
  } as never);
}

function mailboxCaller() {
  return mailboxCallerAs('user-ropperman');
}

function passingLock(seen: string[] = []): PaneStayLock {
  return {
    withLock: async (fn) => {
      seen.push('lock');
      return fn();
    },
  };
}

function cliResult(overrides: Partial<PaneStayCancelSpawnResult> = {}): PaneStayCancelSpawnResult {
  return {
    outcome: 'preview_ok',
    statusBefore: 'Reserved',
    statusAfter: 'Reserved',
    reasons: ['Test Reservations'],
    penaltyText: null,
    screenshots: [],
    ...overrides,
  };
}

// Flag on, lock passing, and a CLI fake. Returns the spawn inputs in call order.
function enableCancel(
  answers: {
    preview?: Partial<PaneStayCancelSpawnResult>;
    commit?: Partial<PaneStayCancelSpawnResult>;
  } = {},
): PaneStayCancelSpawnInput[] {
  const calls: PaneStayCancelSpawnInput[] = [];
  paneStayCancelLoaders.enabled = () => true;
  paneStayCancelLoaders.lock = passingLock();
  paneStayCancelLoaders.spawn = async (input) => {
    calls.push(input);
    return input.mode === 'preview'
      ? cliResult({ outcome: 'preview_ok', ...answers.preview })
      : cliResult({ outcome: 'cancelled', statusAfter: 'Cancelled', ...answers.commit });
  };
  return calls;
}

describe('pane stay cancel', () => {
  afterEach(() => {
    paneStayCancelLoaders.spawn = null;
    paneStayCancelLoaders.lock = null;
    paneStayCancelLoaders.enabled = null;
    paneStaySaveLoaders.now = null;
    vi.unstubAllEnvs();
  });

  it('uses the save path flag: only RESERVATIONIST_PANE_SAVE=on enables it', () => {
    expect(paneStayCancelEnabled({})).toBe(false);
    expect(paneStayCancelEnabled({ RESERVATIONIST_PANE_SAVE: 'off' })).toBe(false);
    expect(paneStayCancelEnabled({ RESERVATIONIST_PANE_SAVE: 'on' })).toBe(true);
  });

  it('refuses preview and commit when the flag is off, with no lock or spawn', async () => {
    const seen: string[] = [];
    paneStayCancelLoaders.enabled = () => false;
    paneStayCancelLoaders.lock = passingLock(seen);
    paneStayCancelLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(previewCancel({ ...stay, owner })).resolves.toEqual({
      outcome: 'refused_flag_off',
      statusBefore: null,
      statusAfter: null,
      reasons: [],
      penaltyText: null,
      screenshots: [],
      runId: null,
      previewDigest: null,
    });
    await expect(
      commitCancel({ ...stay, owner, reason: 'Duplicate Booking' }),
    ).resolves.toMatchObject({ outcome: 'refused_flag_off', runId: null, previewDigest: null });
    expect(seen).toEqual([]);
  });

  it('refuses arrivals before 2027 and malformed input before any lock or spawn', async () => {
    const seen: string[] = [];
    paneStayCancelLoaders.enabled = () => true;
    paneStayCancelLoaders.lock = passingLock(seen);
    paneStayCancelLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(
      previewCancel({ confirmation: '57291630-1', arrival: '2026-12-31', owner }),
    ).resolves.toMatchObject({ outcome: 'refused_not_lab' });
    await expect(
      previewCancel({ confirmation: 'ABC', arrival: '2027-09-14', owner }),
    ).resolves.toMatchObject({ outcome: 'refused_input_invalid' });
    await expect(
      previewCancel({ confirmation: '57291630-1', arrival: '2027-02-30', owner }),
    ).resolves.toMatchObject({ outcome: 'refused_input_invalid' });
    expect(seen).toEqual([]);
  });

  it('classifies inputs with the 2027 floor and the format checks', () => {
    expect(checkCancelInput(stay)).toBeNull();
    expect(checkCancelInput({ confirmation: '57291630-1', arrival: '2027-01-01' })).toBeNull();
    expect(checkCancelInput({ confirmation: '57291630-1', arrival: '2026-12-31' })).toBe(
      'refused_not_lab',
    );
    expect(checkCancelInput({ confirmation: '57291630', arrival: '2027-09-14' })).toBe(
      'refused_input_invalid',
    );
    expect(checkCancelInput({ confirmation: '57291630-1', arrival: '14-SEP-2027' })).toBe(
      'refused_input_invalid',
    );
  });

  it('refuses commit with a blank reason or one that reads as a CLI flag, before the grant check', async () => {
    paneStayCancelLoaders.enabled = () => true;
    paneStayCancelLoaders.lock = passingLock();
    paneStayCancelLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(commitCancel({ ...stay, owner, reason: '   ' })).resolves.toMatchObject({
      outcome: 'refused_reason_missing',
    });
    await expect(commitCancel({ ...stay, owner, reason: '--mode' })).resolves.toMatchObject({
      outcome: 'refused_reason_missing',
    });
  });

  it('refuses when no property lock exists (no loader and no DATABASE_URL)', async () => {
    paneStayCancelLoaders.enabled = () => true;
    paneStayCancelLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    vi.stubEnv('DATABASE_URL', '');
    await expect(previewCancel({ ...stay, owner })).resolves.toMatchObject({
      outcome: 'refused_lock_unavailable',
    });
  });

  it('refuses refused_lock_busy when the property lock stays held past the 20 s wait, with no spawn', async () => {
    paneStayCancelLoaders.enabled = () => true;
    paneStayCancelLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    paneStayCancelLoaders.lock = {
      withLock: async () => {
        throw busyLockError();
      },
    };
    await expect(previewCancel({ ...stay, owner })).resolves.toMatchObject({ outcome: 'refused_lock_busy' });
  });

  it('digest is sha256 of the canonical confirmation and arrival', () => {
    expect(paneCancelDigest(stay)).toBe(digestOf(stay));
    expect(paneCancelDigest({ ...stay, arrival: '2027-09-15' })).not.toBe(paneCancelDigest(stay));
  });

  it('preview runs the CLI under the lock and returns file names, a run id slot and the preview digest', async () => {
    const seen: string[] = [];
    let captured: unknown = null;
    paneStayCancelLoaders.enabled = () => true;
    paneStayCancelLoaders.lock = passingLock(seen);
    paneStayCancelLoaders.spawn = async (input) => {
      captured = input;
      return cliResult({
        screenshots: ['/tmp/pane-cancel-x/found.png', '/tmp/pane-cancel-x/cancel-dialog.png'],
        reasons: ['Test Reservations', 'Duplicate Booking'],
      });
    };
    await expect(previewCancel({ ...stay, owner })).resolves.toEqual({
      outcome: 'preview_ok',
      statusBefore: 'Reserved',
      statusAfter: 'Reserved',
      reasons: ['Test Reservations', 'Duplicate Booking'],
      penaltyText: null,
      screenshots: ['found.png', 'cancel-dialog.png'],
      runId: null,
      previewDigest: digestOf(stay),
    });
    expect(seen).toEqual(['lock']);
    expect(captured).toEqual({
      mode: 'preview',
      confirmation: '57291630-1',
      arrival: '2027-09-14',
      reason: null,
    });
  });

  it('commit needs the preview digest of the same stay, then passes the trimmed reason', async () => {
    const calls = enableCancel({
      commit: { penaltyText: 'Cancellation Penalty of 2060.00 may be added to account.' },
    });
    const preview = await previewCancel({ ...stay, owner });
    const result = await commitCancel({
      ...stay,
      owner,
      reason: '  Duplicate Booking ',
      previewDigest: preview.previewDigest ?? undefined,
    });
    expect(calls[1]).toEqual({
      mode: 'commit',
      confirmation: '57291630-1',
      arrival: '2027-09-14',
      reason: 'Duplicate Booking',
    });
    expect(result).toMatchObject({
      outcome: 'cancelled',
      statusBefore: 'Reserved',
      statusAfter: 'Cancelled',
      penaltyText: 'Cancellation Penalty of 2060.00 may be added to account.',
      previewDigest: null,
      runId: null,
    });
  });

  it('commit without a preview grant is refused before any lock or spawn', async () => {
    const seen: string[] = [];
    const calls = enableCancel();
    paneStayCancelLoaders.lock = passingLock(seen);
    await expect(
      commitCancel({ ...stay, owner, reason: 'Duplicate Booking' }),
    ).resolves.toMatchObject({
      outcome: 'cancel_preview_required',
      runId: null,
      previewDigest: null,
    });
    expect(seen).toEqual([]);
    // With the right digest but no preview, the grant check refuses under the lock.
    await expect(
      commitCancel({ ...stay, owner, reason: 'Duplicate Booking', previewDigest: digestOf(stay) }),
    ).resolves.toMatchObject({ outcome: 'cancel_preview_required' });
    expect(seen).toEqual(['lock']);
    expect(calls).toEqual([]);
  });

  it('a commit must echo the digest of its own stay, and a mismatch keeps the grant', async () => {
    const calls = enableCancel();
    const preview = await previewCancel({ ...stay, owner });
    const digest = preview.previewDigest ?? undefined;
    const other = { ...stay, arrival: '2027-09-15' };
    await expect(
      commitCancel({ ...other, owner, reason: 'Duplicate Booking', previewDigest: digest }),
    ).resolves.toMatchObject({ outcome: 'cancel_digest_mismatch' });
    await expect(
      commitCancel({ ...stay, owner, reason: 'Duplicate Booking', previewDigest: digestOf(other) }),
    ).resolves.toMatchObject({ outcome: 'cancel_digest_mismatch' });
    expect(calls.map((call) => call.mode)).toEqual(['preview']);
    await expect(
      commitCancel({ ...stay, owner, reason: 'Duplicate Booking', previewDigest: digest }),
    ).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(calls.map((call) => call.mode)).toEqual(['preview', 'commit']);
  });

  it('a preview grant is one use, belongs to its owner, and lasts 10 minutes', async () => {
    const calls = enableCancel();
    let now = 1_000_000;
    paneStaySaveLoaders.now = () => now;
    const first = await previewCancel({ ...stay, owner });
    const digest = first.previewDigest ?? undefined;
    await expect(
      commitCancel({
        ...stay,
        owner: 'user-other:transport-1',
        reason: 'Duplicate Booking',
        previewDigest: digest,
      }),
    ).resolves.toMatchObject({ outcome: 'cancel_preview_required' });
    await expect(
      commitCancel({ ...stay, owner, reason: 'Duplicate Booking', previewDigest: digest }),
    ).resolves.toMatchObject({ outcome: 'cancelled' });
    await expect(
      commitCancel({ ...stay, owner, reason: 'Duplicate Booking', previewDigest: digest }),
    ).resolves.toMatchObject({ outcome: 'cancel_preview_required' });
    // A preview that is never committed expires after 10 minutes.
    const second = await previewCancel({ ...stay, owner });
    now += PANE_PREVIEW_TTL_MS + 1;
    await expect(
      commitCancel({
        ...stay,
        owner,
        reason: 'Duplicate Booking',
        previewDigest: second.previewDigest ?? undefined,
      }),
    ).resolves.toMatchObject({ outcome: 'cancel_preview_required' });
    expect(calls.map((call) => call.mode)).toEqual(['preview', 'commit', 'preview']);
  });

  it('passes already_cancelled through and issues no grant for it', async () => {
    const calls = enableCancel({
      preview: {
        outcome: 'already_cancelled',
        statusBefore: 'Cancelled',
        statusAfter: 'Cancelled',
      },
    });
    const preview = await previewCancel({ ...stay, owner });
    expect(preview).toMatchObject({
      outcome: 'already_cancelled',
      statusAfter: 'Cancelled',
      previewDigest: null,
    });
    await expect(
      commitCancel({ ...stay, owner, reason: 'Duplicate Booking', previewDigest: digestOf(stay) }),
    ).resolves.toMatchObject({ outcome: 'cancel_preview_required' });
    expect(calls.map((call) => call.mode)).toEqual(['preview']);
  });

  it('maps a failed run to execution_failure instead of throwing', async () => {
    paneStayCancelLoaders.enabled = () => true;
    paneStayCancelLoaders.lock = passingLock();
    paneStayCancelLoaders.spawn = async () => {
      throw new Error('CDP unreachable');
    };
    await expect(previewCancel({ ...stay, owner })).resolves.toMatchObject({
      outcome: 'execution_failure',
      screenshots: [],
      runId: null,
      previewDigest: null,
    });
  });

  it('builds CLI args with --reason only for commit and always the run directory', () => {
    const preview = buildCancelStayArgs(
      { mode: 'preview', confirmation: '57291630-1', arrival: '2027-09-14', reason: null },
      '/tmp/run',
    );
    expect(preview.slice(1)).toEqual([
      '--confirmation',
      '57291630-1',
      '--arrival',
      '2027-09-14',
      '--mode',
      'preview',
      '--out',
      '/tmp/run',
    ]);
    const commit = buildCancelStayArgs(
      {
        mode: 'commit',
        confirmation: '57291630-1',
        arrival: '2027-09-14',
        reason: 'Duplicate Booking',
      },
      '/tmp/run',
    );
    expect(commit.slice(-2)).toEqual(['--reason', 'Duplicate Booking']);
    expect(commit).toContain('--mode');
    expect(commit[commit.indexOf('--mode') + 1]).toBe('commit');
  });

  it('returns a run id whose screenshots load through paneStayScreenshot, for the owner only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pane-cancel-test-'));
    try {
      await writeFile(join(dir, 'found.png'), Buffer.from('png-bytes'));
      paneStayCancelLoaders.enabled = () => true;
      paneStayCancelLoaders.lock = passingLock();
      paneStayCancelLoaders.spawn = async () =>
        cliResult({ runDir: dir, screenshots: [join(dir, 'found.png')] });
      const preview = await previewCancel({ ...stay, owner });
      expect(preview.runId).toMatch(PANE_RUN_ID_PATTERN);
      expect(preview.screenshots).toEqual(['found.png']);
      const runId = preview.runId as string;
      await expect(
        mailboxCaller().paneStayCancel.paneStayScreenshot({ runId, name: 'found.png' }),
      ).resolves.toEqual({
        status: 'ok',
        dataUrl: `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`,
      });
      await expect(
        mailboxCallerAs('user-other').paneStayCancel.paneStayScreenshot({
          runId,
          name: 'found.png',
        }),
      ).resolves.toEqual({ status: 'unavailable', reason: 'screenshot_unavailable' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is registered as paneStayCancel, takes the owner from the session, and rejects bad keys and digests', async () => {
    enableCancel();
    const preview = await mailboxCaller().paneStayCancel.previewCancel(stay);
    expect(preview).toMatchObject({ outcome: 'preview_ok', previewDigest: digestOf(stay) });
    await expect(
      mailboxCaller().paneStayCancel.previewCancel({ ...stay, propertyCode: 'OTHER' } as never),
    ).rejects.toThrow();
    await expect(
      mailboxCaller().paneStayCancel.commitCancel({
        ...stay,
        reason: '--force',
        previewDigest: digestOf(stay),
      }),
    ).rejects.toThrow();
    await expect(
      mailboxCaller().paneStayCancel.commitCancel({
        ...stay,
        reason: 'Duplicate Booking',
      } as never),
    ).rejects.toThrow();
    await expect(
      mailboxCaller().paneStayCancel.commitCancel({
        ...stay,
        reason: 'Duplicate Booking',
        previewDigest: 'ABC',
      }),
    ).rejects.toThrow();
    await expect(
      mailboxCaller().paneStayCancel.commitCancel({
        ...stay,
        reason: 'Duplicate Booking',
        previewDigest: preview.previewDigest as string,
      }),
    ).resolves.toMatchObject({ outcome: 'cancelled' });
  });
});

describe('paneStayCancel.paneStayScreenshot', () => {
  it('validates the run id and PNG name strictly and answers unavailable for unknown runs', async () => {
    await expect(
      mailboxCaller().paneStayCancel.paneStayScreenshot({ runId: '../etc', name: 'filled.png' }),
    ).rejects.toThrow();
    await expect(
      mailboxCaller().paneStayCancel.paneStayScreenshot({
        runId: '00000000-0000-4000-8000-000000000000',
        name: '../filled.png',
      }),
    ).rejects.toThrow();
    await expect(
      mailboxCaller().paneStayCancel.paneStayScreenshot({
        runId: '00000000-0000-4000-8000-000000000000',
        name: 'filled.png',
        extra: true,
      } as never),
    ).rejects.toThrow();
    await expect(
      mailboxCaller().paneStayCancel.paneStayScreenshot({
        runId: '00000000-0000-4000-8000-000000000000',
        name: 'filled.png',
      }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'screenshot_unavailable' });
  });
});
