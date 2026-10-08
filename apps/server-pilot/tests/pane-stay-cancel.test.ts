import {
  buildCancelStayArgs,
  checkCancelInput,
  commitCancel,
  paneStayCancelEnabled,
  paneStayCancelLoaders,
  previewCancel,
  type PaneStayCancelSpawnResult,
} from '../src/ai/pane-stay-cancel.js';
import type { PaneStayLock } from '../src/ai/pane-stay-save.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';

const stay = { confirmation: '57291630-1', arrival: '2027-09-14' };

function mailboxCaller() {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: {
      id: 'user-ropperman',
      email: 'ropperman@legacyhotels.co.za',
      name: 'R Opperman',
    },
    activeTransportId: 'transport-1',
    transportEmail: 'centurion@legacyhotels.co.za',
    accessRole: 'owner',
  } as never);
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

describe('pane stay cancel', () => {
  afterEach(() => {
    paneStayCancelLoaders.spawn = null;
    paneStayCancelLoaders.lock = null;
    paneStayCancelLoaders.enabled = null;
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
    await expect(previewCancel(stay)).resolves.toEqual({
      outcome: 'refused_flag_off',
      statusBefore: null,
      statusAfter: null,
      reasons: [],
      penaltyText: null,
      message: null,
      arrivalMismatch: false,
      requestedArrival: null,
      hmsArrival: null,
      screenshots: [],
    });
    await expect(commitCancel({ ...stay, reason: 'Duplicate Booking' })).resolves.toMatchObject({
      outcome: 'refused_flag_off',
    });
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
      previewCancel({ confirmation: '57291630-1', arrival: '2026-12-31' }),
    ).resolves.toMatchObject({ outcome: 'refused_not_lab' });
    await expect(
      previewCancel({ confirmation: 'ABC', arrival: '2027-09-14' }),
    ).resolves.toMatchObject({ outcome: 'refused_input_invalid' });
    await expect(
      previewCancel({ confirmation: '57291630-1', arrival: '2027-02-30' }),
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

  it('refuses commit with a blank reason or one that reads as a CLI flag', async () => {
    paneStayCancelLoaders.enabled = () => true;
    paneStayCancelLoaders.lock = passingLock();
    paneStayCancelLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    await expect(commitCancel({ ...stay, reason: '   ' })).resolves.toMatchObject({
      outcome: 'refused_reason_missing',
    });
    await expect(commitCancel({ ...stay, reason: '--mode' })).resolves.toMatchObject({
      outcome: 'refused_reason_missing',
    });
  });

  it('refuses when no property lock exists (no loader and no DATABASE_URL)', async () => {
    paneStayCancelLoaders.enabled = () => true;
    paneStayCancelLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    vi.stubEnv('DATABASE_URL', '');
    await expect(previewCancel(stay)).resolves.toMatchObject({
      outcome: 'refused_lock_unavailable',
    });
  });

  it('preview runs the CLI under the lock and returns the mapped result with file names', async () => {
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
    await expect(previewCancel(stay)).resolves.toEqual({
      outcome: 'preview_ok',
      statusBefore: 'Reserved',
      statusAfter: 'Reserved',
      reasons: ['Test Reservations', 'Duplicate Booking'],
      penaltyText: null,
      message: null,
      arrivalMismatch: false,
      requestedArrival: '2027-09-14',
      hmsArrival: null,
      screenshots: ['found.png', 'cancel-dialog.png'],
    });
    expect(seen).toEqual(['lock']);
    expect(captured).toEqual({
      mode: 'preview',
      confirmation: '57291630-1',
      arrival: '2027-09-14',
      reason: null,
    });
  });

  it('commit passes the trimmed reason and returns cancelled with the penalty text', async () => {
    let captured: unknown = null;
    paneStayCancelLoaders.enabled = () => true;
    paneStayCancelLoaders.lock = passingLock();
    paneStayCancelLoaders.spawn = async (input) => {
      captured = input;
      return cliResult({
        outcome: 'cancelled',
        statusAfter: 'Cancelled',
        penaltyText: 'Cancellation Penalty of 2060.00 may be added to account.',
      });
    };
    const result = await commitCancel({ ...stay, reason: '  Duplicate Booking ' });
    expect(captured).toEqual({
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
    });
  });

  it('maps cancel_unconfirmed to the operator message, and gives no message to a confirmed cancel', async () => {
    paneStayCancelLoaders.enabled = () => true;
    paneStayCancelLoaders.lock = passingLock();
    paneStayCancelLoaders.spawn = async () =>
      cliResult({ outcome: 'cancel_unconfirmed', statusBefore: 'Reserved', statusAfter: 'Reserved' });
    await expect(commitCancel({ ...stay, reason: 'Test Reservations' })).resolves.toMatchObject({
      outcome: 'cancel_unconfirmed',
      message: 'HMS may have cancelled this booking. Check HMS before trying again.',
    });
    paneStayCancelLoaders.spawn = async () =>
      cliResult({ outcome: 'cancelled', statusBefore: 'Reserved', statusAfter: 'Cancelled' });
    await expect(commitCancel({ ...stay, reason: 'Test Reservations' })).resolves.toMatchObject({
      outcome: 'cancelled',
      message: null,
    });
  });

  it('passes already_cancelled through from the CLI', async () => {
    paneStayCancelLoaders.enabled = () => true;
    paneStayCancelLoaders.lock = passingLock();
    paneStayCancelLoaders.spawn = async () =>
      cliResult({
        outcome: 'already_cancelled',
        statusBefore: 'Cancelled',
        statusAfter: 'Cancelled',
      });
    await expect(previewCancel(stay)).resolves.toMatchObject({
      outcome: 'already_cancelled',
      statusAfter: 'Cancelled',
    });
  });

  it('maps a failed run to execution_failure instead of throwing', async () => {
    paneStayCancelLoaders.enabled = () => true;
    paneStayCancelLoaders.lock = passingLock();
    paneStayCancelLoaders.spawn = async () => {
      throw new Error('CDP unreachable');
    };
    await expect(previewCancel(stay)).resolves.toMatchObject({
      outcome: 'execution_failure',
      screenshots: [],
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

  it('is registered as paneStayCancel.previewCancel / commitCancel and rejects unknown keys', async () => {
    paneStayCancelLoaders.enabled = () => true;
    paneStayCancelLoaders.lock = passingLock();
    paneStayCancelLoaders.spawn = async () => cliResult();
    await expect(mailboxCaller().paneStayCancel.previewCancel(stay)).resolves.toMatchObject({
      outcome: 'preview_ok',
    });
    await expect(
      mailboxCaller().paneStayCancel.previewCancel({ ...stay, propertyCode: 'OTHER' } as never),
    ).rejects.toThrow();
    await expect(
      mailboxCaller().paneStayCancel.commitCancel({ ...stay, reason: '--force' }),
    ).rejects.toThrow();
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
