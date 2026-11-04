import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';

const stubs = vi.hoisted(() => ({ end: vi.fn(), running: vi.fn() }));
vi.mock('../src/ai/hms-approval.js', async (original) => ({
  ...(await original<typeof import('../src/ai/hms-approval.js')>()), endHmsWriteRun: stubs.end,
}));
vi.mock('../src/ai/run-ledger.js', async (original) => ({
  ...(await original<typeof import('../src/ai/run-ledger.js')>()), markAiRunRunning: stubs.running,
}));

import { approveHmsWrite, formDigest, hmsWriteStateOf, resolveHmsNeedsCheck, reviewHmsWrite } from '../src/ai/hms-approval.js';
import { paneHmsWriteLoaders, runPaneHmsWriteOnce } from '../src/ai/pane-hms-write.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';

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
  afterEach(() => vi.unstubAllEnvs());

  it('refuses approval and note-only resolution before making any event or run', async () => {
    const f = approvalDb();
    for (const transportId of [request.transportId, 'unknown-transport']) {
      await expect(approveHmsWrite({ ...request, transportId, db: f.db })).rejects.toMatchObject({ refusal: 'filing_unavailable' });
      await expect(resolveHmsNeedsCheck({ ...request, transportId, db: f.db, note: 'checked HMS' }))
        .rejects.toMatchObject({ refusal: 'filing_unavailable' });
    }
    expect(f.insert).not.toHaveBeenCalled();

    const source = { id: item.sourceMessageId, subject: 'Voucher', textBody: 'Document', htmlBody: null };
    const selectedSource = { messageId: source.id, threadId: item.threadId, sourceHash: staffQuoteSourceHash(source) };
    const bound = { ...item, state: { ...item.state, sourceMessageId: source.id,
      sourceThreadId: item.threadId, sourceHash: selectedSource.sourceHash } };
    const previous = { id: 'run-1', state: 'succeeded', failureClass: null, promptVersion: 'hms-write/1' };
    for (const decision of ['ok', 'flag'] as const) {
      const answers: unknown[][] = [[bound], [source], [], [previous], [previous]];
      const query = { from: () => query, where: () => query, orderBy: () => query, limit: () => {
        const rows = answers.shift() ?? [];
        return Object.assign(Promise.resolve(rows), { for: async () => rows });
      } };
      const insert = vi.fn();
      const tx = { select: () => query, execute: async () => undefined, insert };
      const db = { transaction: async (fn: (value: unknown) => unknown) => fn(tx) } as unknown as DB;
      await expect(reviewHmsWrite({ ...request, db, selectedSource, decision, note: 'Checked' }))
        .rejects.toMatchObject({ refusal: 'no_executed_write' });
      expect(insert).not.toHaveBeenCalled();
    }
  });

  it('marks an existing HRCEN attach form unavailable to the approval card', async () => {
    const answers = [[item], []];
    const query = { from: () => query, where: () => query, orderBy: () => query,
      limit: async () => answers.shift() ?? [] };
    const db = { select: () => query } as unknown as DB;
    await expect(hmsWriteStateOf({ db, transportId: request.transportId, workItemId: item.id }))
      .resolves.toMatchObject({ filingAvailable: false, form: { action: 'attach_document' } });

    const run: { id: string; state: string; failureClass: string | null; lastError: string | null;
      idempotencyKey: string; promptVersion: string } = { id: 'run-1', state: 'succeeded', failureClass: null, lastError: null,
      idempotencyKey: 'old-run', promptVersion: 'hms-write/1' };
    const evidence = { id: 'evidence-1', name: 'after.png', at: new Date() };
    const readRun = async (current: typeof run, grant?: Record<string, unknown>) => {
      const answers: unknown[][] = [[item], [current],
        ...(grant ? [[{ value: grant }], [{ id: 'consumed' }]] : []), [evidence], [],
        ...(['queued', 'claimed', 'running', 'retry_wait'].includes(current.state) ? [] : [[current]]),
        ...(current.failureClass === 'LEASE_LOST' ? [[]] : [])];
      const result = {
        from: () => result, where: () => result, orderBy: () => {
          const rows = answers.shift() ?? [];
          return Object.assign(Promise.resolve(rows), { limit: async () => rows });
        },
        limit: async () => answers.shift() ?? [],
      };
      return hmsWriteStateOf({ db: { select: () => result } as unknown as DB,
        transportId: request.transportId, workItemId: item.id });
    };
    // An earlier successful workflow cannot be presented as the new upload.
    expect(await readRun(run)).toMatchObject({ grant: null, run: null, needsCheck: false });
    // An active or unresolved prior write still blocks the new form.
    expect(await readRun({ ...run, state: 'running' })).toMatchObject({
      run: { state: 'running', evidence: [] }, needsCheck: false,
    });
    expect(await readRun({ ...run, state: 'dead_letter', failureClass: 'LEASE_LOST' })).toMatchObject({
      run: { state: 'dead_letter', evidence: [] }, needsCheck: true,
    });
    // A Filing success without its grant is unknown, not evidence of this upload.
    expect(await readRun({ ...run, promptVersion: 'hms-write/lab-attach/1' })).toMatchObject({
      grant: null, run: { state: 'succeeded', evidence: [], lastError: 'filing_approval_unverified' }, needsCheck: true,
    });
    const grantId = '11111111-1111-4111-8111-111111111111';
    const filing = { ...run, idempotencyKey: `hms-write:${grantId}`, promptVersion: 'hms-write/lab-attach/1' };
    const grant = { grantId, workItemId: item.id, transportId: request.transportId, actorUserId: 'user-1',
      formDigest: formDigest(item.state), hmsBeforeDigest: 'before', hmsReadAt: new Date().toISOString() };
    expect(await readRun(filing, grant)).toMatchObject({
      grant: { fingerprintMatches: true }, run: { state: 'succeeded', evidence: [{ eventId: evidence.id }] }, needsCheck: false,
    });
    expect(await readRun(filing, { ...grant, formDigest: 'earlier-form' }))
      .toMatchObject({ grant: null, run: null, needsCheck: false });
  });

  it('reports filing configuration for the selected property independently of the create flag', async () => {
    vi.stubEnv('PANE_HMS_LAB_ATTACH_WORKER', 'on');
    vi.stubEnv('PANE_WRITE_ATTACH', 'lab');
    vi.stubEnv('PANE_WRITE_CREATE', 'off');
    const answers = [[item], []];
    const query = { from: () => query, where: () => query, orderBy: () => query,
      limit: async () => answers.shift() ?? [] };
    const db = { select: () => query } as unknown as DB;
    await expect(hmsWriteStateOf({ db, transportId: request.transportId, workItemId: item.id }))
      .resolves.toMatchObject({ filingConfigured: true, filingAvailable: false });
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
