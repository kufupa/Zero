import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakeExecFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const execFile = Object.assign(() => undefined, { [Symbol.for('nodejs.util.promisify.custom')]: fakeExecFile });
  return { ...original, execFile };
});

import { clearPanePreviewMemory, paneStayDigest, paneStaySaveLoaders, runPaneStay } from '../src/ai/pane-stay-save.js';

const stay = {
  firstName: 'Proof', lastName: 'Labtest', arrival: '2027-09-14', departure: '2027-09-16', adults: 1,
  sourceOfBusiness: 'Walk in', roomType: 'STQN', ratePlan: 'BAR', track: 'BAR', guaranteeType: 'Awaiting Voucher',
};
const owner = 'synthetic-staff:transport-centurion';
const runDirs: string[] = [];

beforeEach(() => {
  paneStaySaveLoaders.mode = () => 'lab';
  paneStaySaveLoaders.lock = { withLock: async (fn) => fn() };
  paneStaySaveLoaders.osressGuestDatesSearch = async () => 'clear';
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  paneStaySaveLoaders.mode = null;
  paneStaySaveLoaders.lock = null;
  paneStaySaveLoaders.osressGuestDatesSearch = null;
  paneStaySaveLoaders.spawn = null;
  clearPanePreviewMemory();
  await Promise.all(runDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  fakeExecFile.mockReset();
  vi.restoreAllMocks();
});

async function commitWithRunnerResult(
  result: Record<string, unknown> | null,
  options: { failed: boolean; stdout?: string; parentConfirmation?: string },
) {
  paneStaySaveLoaders.spawn = async () => ({ outcome: 'previewed', clickedSave: false, confirmationNumber: '' });
  await runPaneStay({ mode: 'preview', stay, owner });
  paneStaySaveLoaders.spawn = null;
  fakeExecFile.mockImplementation(async (_bin: string, args: string[]) => {
    const dir = args[args.indexOf('--out') + 1]!;
    runDirs.push(dir);
    if (result) await writeFile(join(dir, 'result.json'), JSON.stringify(result));
    if (options.failed) throw new Error('synthetic runner failure');
    return { stdout: options.stdout ?? '', stderr: '' };
  });
  return runPaneStay({
    mode: 'commit', stay, owner, previewDigest: paneStayDigest(stay),
    ...(options.parentConfirmation ? { parentConfirmation: options.parentConfirmation } : {}),
  });
}

describe('create runner exit and the save boundary', () => {
  it('reads a nonzero pre-save search refusal and proves Save was not attempted', async () => {
    await expect(commitWithRunnerResult({
      outcome: 'refused_save', refusalReason: 'proof_pre_save_search_unavailable', clickedSave: false,
    }, { failed: true })).resolves.toMatchObject({ status: 'refused', reason: 'refused_save', clickedSave: false });
  });

  it('treats the create runner blank-field exit as a definite pre-save refusal', async () => {
    await expect(commitWithRunnerResult(
      { outcome: 'refused_save_blank_required' }, { failed: false, stdout: 'refused_save_blank_required\n' },
    )).resolves.toMatchObject({ status: 'refused', reason: 'refused_save_blank_required', clickedSave: false });
  });

  it('keeps a contradictory blank-field result uncertain', async () => {
    await expect(commitWithRunnerResult(
      { outcome: 'refused_save_blank_required', clickedSave: true },
      { failed: false, stdout: 'refused_save_blank_required\n' },
    )).resolves.toMatchObject({ status: 'refused', reason: 'pane_save_unconfirmed' });
  });

  it('retains a known number from a failed runner as unconfirmed', async () => {
    await expect(commitWithRunnerResult(
      { outcome: 'execution_failure', clickedSave: false, confirmationNumber: '11111111-1' }, { failed: true },
    )).resolves.toMatchObject({
      status: 'refused', reason: 'pane_save_unconfirmed', confirmationNumber: '11111111-1',
    });
  });

  it('keeps a refusal with a printed confirmation uncertain', async () => {
    await expect(commitWithRunnerResult(
      { outcome: 'refused_save_blank_required' },
      { failed: false, stdout: 'refused_save_blank_required 11111111-1\n' },
    )).resolves.toMatchObject({
      status: 'refused', reason: 'pane_save_unconfirmed', confirmationNumber: '11111111-1',
    });
  });

  it.each<[Record<string, unknown> | null, string | undefined]>([
    [null, undefined],
    [{ outcome: 'execution_failure', clickedSave: false }, undefined],
    [{ outcome: 'refused_save', refusalReason: 'other', clickedSave: false }, undefined],
    [{ outcome: 'refused_save', refusalReason: 'proof_pre_save_search_unavailable', clickedSave: true }, undefined],
    [{ outcome: 'refused_save', refusalReason: 'proof_pre_save_search_unavailable', clickedSave: false }, '11111111-1'],
  ])('does not treat an ambiguous failed runner as a safe refusal', async (result, parentConfirmation) => {
    await expect(commitWithRunnerResult(result, { failed: true, parentConfirmation })).rejects.toThrow('synthetic runner failure');
  });
});
