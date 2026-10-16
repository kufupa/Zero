import {
  checkAmendPaneInput,
  commitAmend,
  paneHmsWriteLoaders,
  previewAmend,
  type PaneAmendSpawnInput,
  type PaneAmendSpawnResult,
} from '../src/ai/pane-hms-write.js';
import { paneStaySaveLoaders, type PaneStayLock } from '../src/ai/pane-stay-save.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appRouter } from '../src/trpc/router.js';

const stay = {
  confirmation: '57291630-1',
  arrival: '2027-09-14',
  lastName: 'Labtest',
  fields: { arrival: '2027-09-15' as const },
};
const owner = 'user-ropperman:transport-1';
const DIGEST = 'ab'.repeat(32);

function passingLock(): PaneStayLock {
  return { withLock: async (fn) => fn() };
}

function spawnResult(overrides: Partial<PaneAmendSpawnResult> = {}): PaneAmendSpawnResult {
  return {
    outcome: 'previewed',
    saveAttempted: false,
    screenshots: ['diff.png'],
    previewDigest: DIGEST,
    changedFieldsReadback: null,
    ...overrides,
  };
}

function enableAmend(): PaneAmendSpawnInput[] {
  const calls: PaneAmendSpawnInput[] = [];
  paneHmsWriteLoaders.lock = passingLock();
  paneHmsWriteLoaders.spawnAmend = async (input) => {
    calls.push(input);
    return input.mode === 'preview'
      ? spawnResult()
      : spawnResult({ outcome: 'amended', saveAttempted: true, screenshots: ['after.png'], previewDigest: null });
  };
  return calls;
}

function mailboxCaller() {
  return appRouter.createCaller({
    auth: null as never,
    reqHeaders: new Headers(),
    sessionUser: { id: 'user-ropperman', email: 'ropperman@legacyhotels.co.za', name: 'R Opperman' },
    activeTransportId: 'transport-1',
    transportEmail: 'centurion@legacyhotels.co.za',
    accessRole: 'owner',
  } as never);
}

describe('pane stay amend', () => {
  afterEach(() => {
    paneHmsWriteLoaders.spawnAmend = null;
    paneHmsWriteLoaders.lock = null;
    paneStaySaveLoaders.now = null;
    vi.unstubAllEnvs();
  });

  it('preview refuses a non-Labtest last name when mode is lab, with no spawn', async () => {
    vi.stubEnv('RESERVATIONIST_PANE_SAVE', 'lab');
    const calls = enableAmend();
    await expect(previewAmend({ ...stay, lastName: 'Smith', owner })).resolves.toMatchObject({
      outcome: 'refused_not_lab',
      previewDigest: null,
      runId: null,
    });
    expect(checkAmendPaneInput({ ...stay, lastName: 'Smith' })).toBe('refused_not_lab');
    expect(calls).toEqual([]);
  });

  it('commit refuses a stale digest and does not spawn', async () => {
    vi.stubEnv('RESERVATIONIST_PANE_SAVE', 'lab');
    const calls = enableAmend();
    const preview = await previewAmend({ ...stay, owner });
    expect(preview.previewDigest).toBe(DIGEST);
    await expect(commitAmend({ ...stay, owner, previewDigest: 'cd'.repeat(32) })).resolves.toMatchObject({
      outcome: 'amend_digest_mismatch',
      previewDigest: null,
    });
    expect(calls.map((call) => call.mode)).toEqual(['preview']);
  });

  it('the preview route refuses a non-Labtest last name when mode is lab', async () => {
    vi.stubEnv('RESERVATIONIST_PANE_SAVE', 'lab');
    enableAmend();
    await expect(mailboxCaller().paneStayAmend.previewAmend({ ...stay, lastName: 'Smith' })).resolves.toMatchObject({
      outcome: 'refused_not_lab',
    });
  });

  it('the commit route refuses a stale digest', async () => {
    vi.stubEnv('RESERVATIONIST_PANE_SAVE', 'lab');
    enableAmend();
    const preview = await mailboxCaller().paneStayAmend.previewAmend(stay);
    await expect(
      mailboxCaller().paneStayAmend.commitAmend({ ...stay, previewDigest: 'cd'.repeat(32) }),
    ).resolves.toMatchObject({ outcome: 'amend_digest_mismatch' });
    expect(preview.previewDigest).toBe(DIGEST);
  });
});
