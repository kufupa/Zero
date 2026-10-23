import { cancelExpectStay } from '../src/ai/pane-hms-write.js';
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
import { CENTURION_HMS_READ_TARGET, DAVINCI_HMS_READ_TARGET } from '../src/hms/hms-read-target.js';

const stay = { confirmation: '57291630-1', arrival: '2027-09-14' };
const owner = 'user-ropperman:transport-centurion';

// Replaces the cancel CLI process for the real defaultSpawn. Null keeps the real execFile.
const cliFake = vi.hoisted(() => ({
  run: null as null | ((argv: string[]) => Promise<void>),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = (...args: unknown[]) => {
    const [file, argv, , callback] = args as [string, string[], unknown, (error: unknown) => void];
    if (!cliFake.run || file !== 'node') {
      return (actual.execFile as unknown as (...rest: unknown[]) => unknown)(...args);
    }
    cliFake.run(argv).then(
      () => callback(null),
      (error: unknown) => callback(error),
    );
  };
  return { ...actual, execFile };
});

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
    activeTransportId: 'transport-centurion',
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
  paneStayCancelLoaders.mode = () => 'lab';
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
    paneStayCancelLoaders.mode = null;
    paneStayCancelLoaders.moneyState = null;
    paneStayCancelLoaders.folio = null;
    paneStaySaveLoaders.now = null;
    vi.unstubAllEnvs();
  });

  it('uses the save path flag: lab and on enable cancel, off and unset do not', () => {
    expect(paneStayCancelEnabled({})).toBe(false);
    expect(paneStayCancelEnabled({ RESERVATIONIST_PANE_SAVE: 'off' })).toBe(false);
    expect(paneStayCancelEnabled({ RESERVATIONIST_PANE_SAVE: 'lab' })).toBe(true);
    expect(paneStayCancelEnabled({ RESERVATIONIST_PANE_SAVE: 'on' })).toBe(true);
    expect(paneStayCancelEnabled({ PANE_WRITE_CREATE: 'on' })).toBe(false);
    expect(paneStayCancelEnabled({ PANE_WRITE_CANCEL_UNPAID: 'lab' })).toBe(true);
  });

  it('CANCEL_UNPAID=lab never passes allow-real-guest, even when SAVE is on', async () => {
    const calls: PaneStayCancelSpawnInput[] = [];
    paneStayCancelLoaders.lock = passingLock();
    paneStayCancelLoaders.moneyState = () => 'unpaid';
    paneStayCancelLoaders.spawn = async (input) => {
      calls.push(input);
      return cliResult();
    };
    vi.stubEnv('PANE_WRITE_CANCEL_UNPAID', 'lab');
    vi.stubEnv('RESERVATIONIST_PANE_SAVE', 'on');
    await expect(previewCancel({ ...stay, owner })).resolves.toMatchObject({ outcome: 'preview_ok' });
    expect(calls[0]).toMatchObject({ allowRealGuest: false });
    expect(buildCancelStayArgs(calls[0]!, '/tmp/run')).not.toContain('--allow-real-guest');
  });

  it('unknown money uses the paid switch: CANCEL_UNPAID=on CANCEL_PAID=off refuses with no allow-real-guest', async () => {
    const calls: PaneStayCancelSpawnInput[] = [];
    paneStayCancelLoaders.lock = passingLock();
    paneStayCancelLoaders.spawn = async (input) => {
      calls.push(input);
      throw new Error('must not spawn');
    };
    vi.stubEnv('PANE_WRITE_CANCEL_UNPAID', 'on');
    vi.stubEnv('PANE_WRITE_CANCEL_PAID', 'off');
    await expect(previewCancel({ ...stay, owner })).resolves.toMatchObject({
      outcome: 'refused_flag_off',
      previewDigest: null,
    });
    expect(paneStayCancelLoaders.moneyState).toBeNull();
    expect(calls).toEqual([]);
  });

  it('paid stay with CANCEL_PAID=off refuses and does not spawn', async () => {
    const calls: PaneStayCancelSpawnInput[] = [];
    paneStayCancelLoaders.lock = passingLock();
    paneStayCancelLoaders.moneyState = () => 'paid';
    paneStayCancelLoaders.spawn = async (input) => {
      calls.push(input);
      throw new Error('must not spawn');
    };
    vi.stubEnv('PANE_WRITE_CANCEL_UNPAID', 'lab');
    vi.stubEnv('PANE_WRITE_CANCEL_PAID', 'off');
    await expect(previewCancel({ ...stay, owner })).resolves.toMatchObject({
      outcome: 'refused_flag_off',
      previewDigest: null,
    });
    expect(calls).toEqual([]);
  });

  it('refuses preview and commit when the flag is off, with no lock or spawn', async () => {
    const seen: string[] = [];
    paneStayCancelLoaders.mode = () => 'off';
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
      message: null,
      arrivalMismatch: false,
      requestedArrival: null,
      hmsArrival: null,
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
    paneStayCancelLoaders.mode = () => 'lab';
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
    paneStayCancelLoaders.mode = () => 'lab';
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
    paneStayCancelLoaders.mode = () => 'lab';
    paneStayCancelLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    vi.stubEnv('DATABASE_URL', '');
    await expect(previewCancel({ ...stay, owner })).resolves.toMatchObject({
      outcome: 'refused_lock_unavailable',
    });
  });

  it('refuses refused_lock_busy when the property lock stays held past the 20 s wait, with no spawn', async () => {
    paneStayCancelLoaders.mode = () => 'lab';
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
    paneStayCancelLoaders.mode = () => 'lab';
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
      message: null,
      arrivalMismatch: false,
      requestedArrival: '2027-09-14',
      hmsArrival: null,
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
      allowRealGuest: false,
    });
  });

  const unpaidFolio = {
    status: 'Reserved',
    guaranteeType: 'Non-Guaranteed Individual',
    depositReceived: '0',
  };

  it('paid folio at commit refuses before spawn, unpaid proceeds, and preview does not call folio', async () => {
    const folioCalls: string[] = [];
    const calls = enableCancel();
    paneStayCancelLoaders.folio = async (input) => {
      folioCalls.push(input.confirmation);
      return { ...unpaidFolio, depositReceived: '250.00' };
    };
    const preview = await previewCancel({ ...stay, owner });
    expect(folioCalls).toEqual([]);
    expect(preview).toMatchObject({ outcome: 'preview_ok', previewDigest: digestOf(stay) });
    await expect(
      commitCancel({
        ...stay,
        owner,
        reason: 'Duplicate Booking',
        previewDigest: preview.previewDigest ?? undefined,
      }),
    ).resolves.toMatchObject({
      outcome: 'refused_not_unpaid',
      message: 'This change may affect money already paid. Handle in Infor.',
      previewDigest: null,
      runId: null,
    });
    expect(folioCalls).toEqual([stay.confirmation]);
    expect(calls.map((call) => call.mode)).toEqual(['preview']);
    paneStayCancelLoaders.folio = async () => unpaidFolio;
    const second = await previewCancel({ ...stay, owner });
    await expect(
      commitCancel({
        ...stay,
        owner,
        reason: 'Duplicate Booking',
        previewDigest: second.previewDigest ?? undefined,
      }),
    ).resolves.toMatchObject({ outcome: 'cancelled' });
    expect(calls.map((call) => call.mode)).toEqual(['preview', 'preview', 'commit']);
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
      allowRealGuest: false,
      target: CENTURION_HMS_READ_TARGET,
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
        owner: 'user-other:transport-centurion',
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

  it('a reason HMS does not accept keeps the preview grant, so staff can pick another reason', async () => {
    enableCancel({ commit: { outcome: 'refused_reason_missing' } });
    const preview = await previewCancel({ ...stay, owner });
    const previewDigest = preview.previewDigest ?? undefined;
    await expect(
      commitCancel({ ...stay, owner, reason: 'Wrong reason', previewDigest }),
    ).resolves.toMatchObject({ outcome: 'refused_reason_missing' });
    enableCancel();
    await expect(
      commitCancel({ ...stay, owner, reason: 'Duplicate Booking', previewDigest }),
    ).resolves.toMatchObject({ outcome: 'cancelled' });
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

  it('maps cancel_unconfirmed to the operator message, and gives no message to a confirmed cancel', async () => {
    enableCancel({ commit: { outcome: 'cancel_unconfirmed', statusAfter: 'Reserved' } });
    const first = await previewCancel({ ...stay, owner });
    await expect(
      commitCancel({ ...stay, owner, reason: 'Test Reservations', previewDigest: first.previewDigest ?? undefined }),
    ).resolves.toMatchObject({
      outcome: 'cancel_unconfirmed',
      message: 'HMS may have cancelled this booking. Check HMS before trying again.',
    });
    enableCancel();
    const second = await previewCancel({ ...stay, owner });
    await expect(
      commitCancel({ ...stay, owner, reason: 'Test Reservations', previewDigest: second.previewDigest ?? undefined }),
    ).resolves.toMatchObject({ outcome: 'cancelled', message: null });
  });

  it('passes already_cancelled through from the CLI', async () => {
    paneStayCancelLoaders.mode = () => 'lab';
    paneStayCancelLoaders.lock = passingLock();
    paneStayCancelLoaders.spawn = async () =>
      cliResult({
        outcome: 'already_cancelled',
        statusBefore: 'Cancelled',
        statusAfter: 'Cancelled',
      });
    await expect(previewCancel({ ...stay, owner })).resolves.toMatchObject({
      outcome: 'already_cancelled',
      statusAfter: 'Cancelled',
    });
  });

  it('maps a failed run to execution_failure instead of throwing', async () => {
    paneStayCancelLoaders.mode = () => 'lab';
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

  it('logs a CLI run that finished as execution_failure, with the same message cleanup as the lookup spawner', async () => {
    paneStayCancelLoaders.mode = () => 'lab';
    paneStayCancelLoaders.lock = passingLock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runDirs: string[] = [];
    cliFake.run = async (argv) => {
      const dir = argv[argv.indexOf('--out') + 1]!;
      runDirs.push(dir);
      await writeFile(
        join(dir, 'result.json'),
        JSON.stringify({
          outcome: 'execution_failure',
          error: `Command failed: node cancel-stay.mjs --confirmation ${stay.confirmation}\nHMS refused ${stay.confirmation}`,
        }),
      );
      throw Object.assign(new Error('Command failed'), { code: 2 });
    };
    try {
      await expect(previewCancel({ ...stay, owner })).resolves.toMatchObject({
        outcome: 'execution_failure',
      });
      expect(warn).toHaveBeenCalledWith('pane_stay_spawn_failed', {
        mode: 'preview',
        code: 'Error',
        msg: 'HMS refused <n>',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(stay.confirmation);
    } finally {
      cliFake.run = null;
      warn.mockRestore();
      await Promise.all(runDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });

  it('builds CLI args with --reason only for commit and always the run directory', () => {
    const preview = buildCancelStayArgs(
      { mode: 'preview', confirmation: '57291630-1', arrival: '2027-09-14', reason: null, allowRealGuest: false },
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
        allowRealGuest: false,
      },
      '/tmp/run',
    );
    expect(commit.slice(-2)).toEqual(['--reason', 'Duplicate Booking']);
    // The pane write runner's commit names the approved stay file in its own run directory. A preview never does.
    const checked = buildCancelStayArgs(
      {
        mode: 'commit',
        confirmation: '57291630-1',
        arrival: '2027-09-14',
        reason: 'Duplicate Booking',
        allowRealGuest: false,
        expectStay: { confirmation: '57291630-1', balance: '0.00' },
      },
      '/tmp/run',
    );
    expect(checked.slice(-2)).toEqual(['--expect-stay', '/tmp/run/expect-stay.json']);
    expect(
      buildCancelStayArgs(
        { mode: 'preview', confirmation: '57291630-1', arrival: '2027-09-14', reason: null, allowRealGuest: false, expectStay: {} },
        '/tmp/run',
      ),
    ).not.toContain('--expect-stay');
    expect(commit).toContain('--mode');
    expect(commit[commit.indexOf('--mode') + 1]).toBe('commit');
  });

  it('an approved cancel with lookup depositReceived 0 is not refused when the cancel read omits that key', async () => {
    const { stayChanges } = (await import('../tooling/playwright-quote/cancel-stay-rules.mjs' as string)) as {
      stayChanges(expected: Record<string, unknown>, actual: Record<string, unknown>): string[];
    };
    const lookupStay = {
      status: 'Reserved',
      confirmation: '57291630-1',
      lastName: 'Labtest',
      firstName: 'Lab',
      arrival: '2027-09-14',
      departure: '2027-09-16',
      nights: 2,
      adults: 1,
      children: 0,
      roomType: 'DBL',
      ratePlan: 'BAR',
      mealPlan: 'BB',
      averageRate: '1000.00',
      grandTotal: '2000.00',
      balance: '0.00',
      sourceOfBusiness: 'Direct',
      guaranteeType: 'Non-Guaranteed Individual',
      depositReceived: '0',
      bookingAgency: null,
      organization: null,
    };
    const expected = cancelExpectStay(lookupStay);
    expect(expected).not.toHaveProperty('depositReceived');
    const cancelRead = { ...expected };
    expect(stayChanges(expected, cancelRead)).toEqual([]);
    expect(stayChanges(lookupStay, cancelRead)).toEqual(['depositReceived']);
  });

  it('returns a run id whose screenshots load through paneStayScreenshot, for the owner only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pane-cancel-test-'));
    try {
      await writeFile(join(dir, 'found.png'), Buffer.from('png-bytes'));
      paneStayCancelLoaders.mode = () => 'lab';
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

describe('pane cancel modes', () => {
  const CHARGE = 'Cancellation Penalty of 2060.00 may be added to account.';
  const oldStay = { confirmation: '57291630-1', arrival: '2026-11-12' };

  afterEach(() => {
    paneStayCancelLoaders.spawn = null;
    paneStayCancelLoaders.lock = null;
    paneStayCancelLoaders.mode = null;
    paneStayCancelLoaders.moneyState = null;
    paneStayCancelLoaders.folio = null;
    cliFake.run = null;
    vi.unstubAllEnvs();
  });

  it('lab keeps the 2027 floor: a pre-2027 stay is refused with no spawn, and the CLI gets no switch', async () => {
    const calls = enableCancel();
    await expect(previewCancel({ ...oldStay, owner })).resolves.toMatchObject({
      outcome: 'refused_not_lab',
      previewDigest: null,
    });
    expect(calls).toEqual([]);
    await previewCancel({ ...stay, owner });
    expect(calls[0]).toMatchObject({ allowRealGuest: false });
    expect(buildCancelStayArgs(calls[0]!, '/tmp/run')).not.toContain('--allow-real-guest');
  });

  it('on lets a real guest through the floor: the CLI gets --allow-real-guest on preview and on commit', async () => {
    const calls = enableCancel();
    paneStayCancelLoaders.mode = () => 'on';
    const preview = await previewCancel({ ...oldStay, owner });
    expect(preview).toMatchObject({ outcome: 'preview_ok', previewDigest: digestOf(oldStay) });
    const commit = await commitCancel({
      ...oldStay,
      owner,
      reason: 'Guest request',
      previewDigest: digestOf(oldStay),
    });
    expect(commit).toMatchObject({ outcome: 'cancelled' });
    expect(calls.map((call) => call.allowRealGuest)).toEqual([true, true]);
    expect(calls[1]).toMatchObject({ reason: 'Guest request' });
    expect(buildCancelStayArgs(calls[1]!, '/tmp/run')).toContain('--allow-real-guest');
  });

  it('the real CLI run gets the switch only in on mode, from the server mode and never from the environment', async () => {
    paneStayCancelLoaders.lock = passingLock();
    const argvs: string[][] = [];
    cliFake.run = async (argv) => {
      argvs.push(argv);
      const dir = argv[argv.indexOf('--out') + 1]!;
      await writeFile(
        join(dir, 'result.json'),
        JSON.stringify({
          outcome: 'preview_ok',
          statusBefore: 'Reserved',
          statusAfter: 'Reserved',
          reasons: ['Test Reservations'],
        }),
      );
    };
    vi.stubEnv('RESERVATIONIST_PANE_SAVE', 'on');
    paneStayCancelLoaders.mode = () => 'lab';
    await previewCancel({ ...stay, owner });
    paneStayCancelLoaders.mode = () => 'on';
    await previewCancel({ ...oldStay, owner });
    expect(argvs[0]).not.toContain('--allow-real-guest');
    expect(argvs[1]).toContain('--allow-real-guest');
  });

  it('a penalty dialog before the OK refuses the commit with its text: no grant, no second run', async () => {
    const calls = enableCancel({
      commit: { outcome: 'refused_penalty', statusAfter: 'Reserved', penaltyText: CHARGE },
    });
    paneStayCancelLoaders.mode = () => 'on';
    const preview = await previewCancel({ ...oldStay, owner });
    const digest = preview.previewDigest as string;
    await expect(
      commitCancel({ ...oldStay, owner, reason: 'Guest request', previewDigest: digest }),
    ).resolves.toMatchObject({
      outcome: 'refused_penalty',
      penaltyText: CHARGE,
      previewDigest: null,
      runId: null,
    });
    await expect(
      commitCancel({ ...oldStay, owner, reason: 'Guest request', previewDigest: digest }),
    ).resolves.toMatchObject({ outcome: 'cancel_preview_required' });
    expect(calls.map((call) => call.mode)).toEqual(['preview', 'commit']);
  });

  it('a penalty dialog at preview refuses the preview, so no commit grant is issued', async () => {
    // A fresh owner: grants from earlier tests for this stay must not satisfy this commit.
    const fresh = 'user-penalty-preview:transport-centurion';
    const calls = enableCancel({ preview: { outcome: 'refused_penalty', penaltyText: CHARGE } });
    await expect(previewCancel({ ...stay, owner: fresh })).resolves.toMatchObject({
      outcome: 'refused_penalty',
      penaltyText: CHARGE,
      previewDigest: null,
    });
    await expect(
      commitCancel({
        ...stay,
        owner: fresh,
        reason: 'Duplicate Booking',
        previewDigest: digestOf(stay),
      }),
    ).resolves.toMatchObject({ outcome: 'cancel_preview_required' });
    expect(calls.map((call) => call.mode)).toEqual(['preview']);
  });

  it('a charge that opens after the OK is needs check, not cancelled, and its text comes back', async () => {
    enableCancel({
      commit: { outcome: 'cancel_penalty_pending', statusAfter: 'Cancelled', penaltyText: CHARGE },
    });
    const preview = await previewCancel({ ...stay, owner });
    await expect(
      commitCancel({
        ...stay,
        owner,
        reason: 'Duplicate Booking',
        previewDigest: preview.previewDigest as string,
      }),
    ).resolves.toMatchObject({
      outcome: 'cancel_penalty_pending',
      statusAfter: 'Cancelled',
      penaltyText: CHARGE,
      message: expect.stringContaining('penalty'),
    });
  });

  it('reason is required and a stale digest refuses in on mode, before any second run', async () => {
    const calls = enableCancel();
    paneStayCancelLoaders.mode = () => 'on';
    const preview = await previewCancel({ ...oldStay, owner });
    const digest = preview.previewDigest as string;
    await expect(
      commitCancel({ ...oldStay, owner, reason: '   ', previewDigest: digest }),
    ).resolves.toMatchObject({ outcome: 'refused_reason_missing' });
    await expect(
      commitCancel({
        ...oldStay,
        arrival: '2026-11-13',
        owner,
        reason: 'Guest request',
        previewDigest: digest,
      }),
    ).resolves.toMatchObject({ outcome: 'cancel_digest_mismatch' });
    expect(calls.map((call) => call.mode)).toEqual(['preview']);
  });

  it('off refuses preview and commit in every case, with no lock or spawn', async () => {
    const seen: string[] = [];
    paneStayCancelLoaders.lock = passingLock(seen);
    paneStayCancelLoaders.spawn = async () => {
      throw new Error('must not spawn');
    };
    paneStayCancelLoaders.mode = () => 'off';
    for (const input of [oldStay, stay]) {
      await expect(previewCancel({ ...input, owner })).resolves.toMatchObject({
        outcome: 'refused_flag_off',
      });
      await expect(
        commitCancel({ ...input, owner, reason: 'Guest request', previewDigest: digestOf(input) }),
      ).resolves.toMatchObject({ outcome: 'refused_flag_off' });
    }
    expect(seen).toEqual([]);
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

describe('pane stay cancel HMS target', () => {
  afterEach(() => {
    paneStayCancelLoaders.spawn = null;
    paneStayCancelLoaders.lock = null;
    paneStayCancelLoaders.mode = null;
    paneStayCancelLoaders.moneyState = null;
    paneStayCancelLoaders.folio = null;
  });

  it('a Da Vinci transport cancel gets the HRDAV target before spawn', async () => {
    const calls = enableCancel();
    await expect(
      previewCancel({
        ...stay,
        owner: 'user-ropperman:transport-centurion',
        transportId: 'transport-davinci',
      }),
    ).resolves.toMatchObject({ outcome: 'preview_ok' });
    expect(calls[0]?.target).toEqual(DAVINCI_HMS_READ_TARGET);
  });

  it('a Centurion transport cancel gets the HRCEN target before spawn', async () => {
    const calls = enableCancel();
    await expect(previewCancel({ ...stay, owner, transportId: 'transport-centurion' })).resolves.toMatchObject({
      outcome: 'preview_ok',
    });
    expect(calls[0]?.target).toEqual(CENTURION_HMS_READ_TARGET);
  });

  it('an unknown transport is refused before any spawn', async () => {
    const calls = enableCancel();
    await expect(
      previewCancel({ ...stay, owner: 'user-ropperman:nope', transportId: 'transport-unknown' }),
    ).resolves.toMatchObject({ outcome: 'refused_unknown_transport', runId: null, previewDigest: null });
    expect(calls).toEqual([]);
  });

  it('route transport wins over the owner string, so a caller-supplied hotel cannot steer the slot', async () => {
    const calls = enableCancel();
    await expect(
      previewCancel({
        ...stay,
        owner: 'user-ropperman:transport-centurion',
        transportId: 'transport-davinci',
      }),
    ).resolves.toMatchObject({ outcome: 'preview_ok' });
    expect(calls[0]?.target).toEqual(DAVINCI_HMS_READ_TARGET);
  });
});
