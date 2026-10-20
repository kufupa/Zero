import {
  checkAmendPaneInput,
  commitAmend,
  paneHmsWriteLoaders,
  previewAmend,
  type PaneAmendSpawnInput,
  type PaneAmendSpawnResult,
} from '../src/ai/pane-hms-write.js';
import { paneStayLookupLoaders, type PaneStayFields } from '../src/ai/pane-stay-lookup.js';
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

const UNPAID_STAY: PaneStayFields = {
  status: 'Reserved',
  confirmation: stay.confirmation,
  lastName: stay.lastName,
  firstName: 'Lab',
  arrival: stay.arrival,
  departure: '2027-09-16',
  nights: 2,
  adults: 1,
  children: 0,
  roomType: 'STQN',
  ratePlan: 'BAR',
  mealPlan: 'BB',
  averageRate: '1000.00',
  grandTotal: '2000.00',
  balance: '0.00',
  sourceOfBusiness: 'Walk in',
  guaranteeType: 'Non-Guaranteed Individual',
  depositReceived: '0',
  bookingAgency: null,
  organization: null,
};

function enableAmend(lookupStay: PaneStayFields = UNPAID_STAY): PaneAmendSpawnInput[] {
  const calls: PaneAmendSpawnInput[] = [];
  paneHmsWriteLoaders.lock = passingLock();
  paneStayLookupLoaders.enabled = () => true;
  paneStayLookupLoaders.spawn = async () => ({
    outcome: 'found',
    reason: null,
    stay: lookupStay,
    rows: [],
    screenshots: [],
  });
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
    paneStayLookupLoaders.spawn = null;
    paneStayLookupLoaders.enabled = null;
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

  it('preview and commit refuse a paid, guaranteed, or unknown payment stay with no spawn', async () => {
    vi.stubEnv('RESERVATIONIST_PANE_SAVE', 'lab');
    const paid = enableAmend({ ...UNPAID_STAY, depositReceived: '120.00' });
    await expect(previewAmend({ ...stay, owner })).resolves.toMatchObject({
      outcome: 'refused_payment_unknown',
      previewDigest: null,
    });
    expect(paid).toEqual([]);

    const guaranteed = enableAmend({ ...UNPAID_STAY, guaranteeType: 'Guaranteed By Agent' });
    await expect(previewAmend({ ...stay, owner })).resolves.toMatchObject({ outcome: 'refused_payment_unknown' });
    expect(guaranteed).toEqual([]);

    const missingDeposit = enableAmend({ ...UNPAID_STAY, depositReceived: null });
    await expect(commitAmend({ ...stay, owner, previewDigest: DIGEST })).resolves.toMatchObject({
      outcome: 'refused_payment_unknown',
    });
    expect(missingDeposit).toEqual([]);

    const missingGuarantee = enableAmend({ ...UNPAID_STAY, guaranteeType: null });
    await expect(previewAmend({ ...stay, owner })).resolves.toMatchObject({ outcome: 'refused_payment_unknown' });
    expect(missingGuarantee).toEqual([]);
  });
});
