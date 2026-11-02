import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import type { AiRunFence } from '../src/ai/run-ledger.js';

const guards = vi.hoisted(() => ({ running: vi.fn(), end: vi.fn(), consume: vi.fn() }));
vi.mock('../src/ai/run-ledger.js', async (original) => ({
  ...await original<typeof import('../src/ai/run-ledger.js')>(), markAiRunRunning: guards.running,
}));
vi.mock('../src/ai/hms-approval.js', async (original) => ({
  ...await original<typeof import('../src/ai/hms-approval.js')>(),
  endHmsWriteRun: guards.end, consumeHmsWriteApproval: guards.consume,
}));
import { paneHmsWriteLoaders, runPaneHmsWriteOnce, spawnAttachDocument } from '../src/ai/pane-hms-write.js';

const fence: AiRunFence = { runId: 'run', claimOwner: 'owner', claimToken: 'token', deadlineAt: new Date('2099-01-01') };
const item = { state: { action: 'attach_document', confirmation: '123-1', arrival: '2027-01-01',
  lastName: 'Labtest', attachmentId: 'attachment', documentName: 'voucher.pdf' }, sourceMessageId: 'message' };
function database(state: Record<string, unknown> = item.state): DB {
  const rows = [[{ workItemId: 'work', transportId: 'mailbox' }], [{ ...item, state }]];
  return { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => rows.shift() ?? [] }) }) })) } as unknown as DB;
}

beforeEach(() => { guards.running.mockReset().mockResolvedValue(true); guards.end.mockReset().mockResolvedValue(true);
  guards.consume.mockReset(); paneHmsWriteLoaders.readAttachment = vi.fn(); paneHmsWriteLoaders.spawnAttach = vi.fn(); });
afterEach(() => { paneHmsWriteLoaders.readAttachment = null; paneHmsWriteLoaders.spawnAttach = null; vi.unstubAllEnvs(); });

describe('legacy attach server guard', () => {
  it('refuses direct server spawn even with the legacy arming flag', async () => {
    vi.stubEnv('ATTACH_VERIFIED', 'true');
    await expect(spawnAttachDocument({ confirmation: '123-1', arrival: '2027-01-01', file: '/missing',
      documentName: 'voucher.pdf', allowRealGuest: true })).resolves.toEqual({
      outcome: 'refused_legacy_attach_disabled', uploadSent: false, listed: false, screenshots: [],
    });
  });

  it.each([{}, { PANE_WRITE_ATTACH: 'off' }, { PANE_WRITE_ATTACH: 'lab' }, { PANE_WRITE_ATTACH: 'on' },
    { RESERVATIONIST_PANE_SAVE: 'lab' }])('blocks a claimed legacy job before bytes, consume or spawn under %j', async (env) => {
    const db = database();
    await expect(runPaneHmsWriteOnce({ runId: fence.runId, fence, db, env })).resolves.toEqual({
      status: 'ended', failureClass: 'UNKNOWN', reason: 'legacy_attach_disabled',
    });
    expect(guards.end).toHaveBeenCalledWith({ db, fence, failureClass: 'UNKNOWN', reason: 'legacy_attach_disabled' });
    expect(paneHmsWriteLoaders.readAttachment).not.toHaveBeenCalled();
    expect(guards.consume).not.toHaveBeenCalled();
    expect(paneHmsWriteLoaders.spawnAttach).not.toHaveBeenCalled();
  });

  it('holds malformed legacy forms too, before declaring an invalid form safe', async () => {
    const db = database({ action: 'attach_document' });
    await expect(runPaneHmsWriteOnce({ runId: fence.runId, fence, db, env: {} })).resolves.toMatchObject({
      status: 'ended', failureClass: 'UNKNOWN', reason: 'legacy_attach_disabled',
    });
  });

  it('does not declare an unknown result when the fenced termination loses the claim', async () => {
    guards.end.mockResolvedValue(false);
    await expect(runPaneHmsWriteOnce({ runId: fence.runId, fence, db: database(), env: {} })).resolves.toEqual({ status: 'lease_lost' });
    expect(guards.consume).not.toHaveBeenCalled();
  });

  it('preserves the off-mode policy for unrelated actions', async () => {
    const db = database({ action: 'cancel' });
    await expect(runPaneHmsWriteOnce({ runId: fence.runId, fence, db, env: {} })).resolves.toEqual({
      status: 'ended', failureClass: 'POLICY_BLOCK', reason: 'refused_flag_off',
    });
  });
});
