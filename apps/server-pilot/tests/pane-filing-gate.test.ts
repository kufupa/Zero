import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';

const stubs = vi.hoisted(() => ({ end: vi.fn(), running: vi.fn() }));
vi.mock('../src/ai/hms-approval.js', async (original) => ({
  ...(await original<typeof import('../src/ai/hms-approval.js')>()), endHmsWriteRun: stubs.end,
}));
vi.mock('../src/ai/run-ledger.js', async (original) => ({
  ...(await original<typeof import('../src/ai/run-ledger.js')>()), markAiRunRunning: stubs.running,
}));

import { approveHmsWrite, hmsWriteStateOf, resolveHmsNeedsCheck } from '../src/ai/hms-approval.js';
import { paneHmsWriteLoaders, runPaneHmsWriteOnce } from '../src/ai/pane-hms-write.js';

const item = { id: 'item-1', threadId: 'thread-1', sourceMessageId: 'mail-1', status: 'needs_you',
  state: { action: 'attach_document', confirmation: '123456-1', arrival: '2027-09-14',
    lastName: 'Labtest', attachmentId: 'attachment-1', documentName: 'voucher.pdf' } };
const request = { transportId: 'transport-centurion', workItemId: item.id, actorUserId: 'user-1' };

function approvalDb() {
  const insert = vi.fn();
  const query = { from: () => query, where: () => query, limit: () => query, for: async () => [item] };
  const tx = { select: () => query, insert };
  return { db: { transaction: async (fn: (value: unknown) => unknown) => fn(tx) } as unknown as DB, insert };
}

describe('HRCEN filing hold', () => {
  beforeEach(() => { stubs.end.mockReset().mockResolvedValue(true); stubs.running.mockReset().mockResolvedValue(true); });

  it('refuses approval and note-only resolution before making any event or run', async () => {
    const f = approvalDb();
    for (const transportId of [request.transportId, 'unknown-transport']) {
      await expect(approveHmsWrite({ ...request, transportId, db: f.db })).rejects.toMatchObject({ refusal: 'filing_unavailable' });
      await expect(resolveHmsNeedsCheck({ ...request, transportId, db: f.db, note: 'checked HMS' }))
        .rejects.toMatchObject({ refusal: 'filing_unavailable' });
    }
    expect(f.insert).not.toHaveBeenCalled();
  });

  it('marks an existing HRCEN attach form unavailable to the approval card', async () => {
    const answers = [[item], []];
    const query = { from: () => query, where: () => query, orderBy: () => query,
      limit: async () => answers.shift() ?? [] };
    const db = { select: () => query } as unknown as DB;
    await expect(hmsWriteStateOf({ db, transportId: request.transportId, workItemId: item.id }))
      .resolves.toMatchObject({ filingAvailable: false, form: { action: 'attach_document' } });
  });

  it('stops an already-claimed legacy attach before attachment read, grant consume or native spawn', async () => {
    const answers = [[{ workItemId: item.id, transportId: request.transportId }], [item]];
    const query = { from: () => query, where: () => query, limit: async () => answers.shift() ?? [] };
    const db = { select: () => query } as unknown as DB;
    const read = vi.fn();
    const spawn = vi.fn();
    paneHmsWriteLoaders.readAttachment = read;
    paneHmsWriteLoaders.spawnAttach = spawn;
    const fence = { runId: 'run-1', claimOwner: 'owner-1', claimToken: 'token-1', deadlineAt: new Date(Date.now() + 60_000) };
    try {
      await expect(runPaneHmsWriteOnce({ db, runId: fence.runId, fence, env: { PANE_WRITE_ATTACH: 'lab' } }))
        .resolves.toEqual({ status: 'ended', failureClass: 'POLICY_BLOCK', reason: 'refused_cloud_upload_unavailable' });
      expect(read).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(stubs.end).toHaveBeenCalledWith(expect.objectContaining({ failureClass: 'POLICY_BLOCK' }));
    } finally {
      paneHmsWriteLoaders.readAttachment = null;
      paneHmsWriteLoaders.spawnAttach = null;
    }
  });
});
