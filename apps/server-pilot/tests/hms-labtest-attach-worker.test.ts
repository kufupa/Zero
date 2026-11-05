import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { approveHmsWrite, formDigest, hmsStateDigest } from '../src/ai/hms-approval.js';
import { labtestAttachWorkerEnabled, runLabtestAttachOnce } from '../src/ai/hms-labtest-attach-worker.js';
import { HMS_LABTEST_ATTACH_PROMPT_VERSION, HMS_WRITE_RUN_KIND, type claimNextAiRun } from '../src/ai/run-ledger.js';
import type { runPaneHmsWriteOnce } from '../src/ai/pane-hms-write.js';
import { aiWorkflowRun, message } from '../src/db/schema/mail.js';
import { workEvent, workItem } from '../src/db/schema/work.js';
import { staffQuoteSourceHash } from '../src/ai/staff-quote-workflow.js';

const enabled = { PANE_HMS_LAB_ATTACH_WORKER: 'on', PANE_WRITE_ATTACH: 'lab' };
const selectedInternetMessageId = 'selected@example.test';
const selectedMail = { id: 'message', subject: null, textBody: null, htmlBody: null };
const selectedSource = { threadId: 'thread', messageId: selectedMail.id, sourceHash: staffQuoteSourceHash(selectedMail) };

function selectedSourceQueries(item: { sourceMessageId: string; threadId: string }) {
  return () => {
    let table: unknown;
    const query = new Proxy({ from: (value: unknown) => { table = value; return query; }, where: () => query,
      orderBy: () => query, limit: () => query,
      for: async () => table === workItem ? [item] : table === message
        ? [{ id: item.sourceMessageId, threadId: item.threadId, direction: 'inbound' }] : [] }, {
      get(target, property, receiver) {
        if (property === 'then') return (resolve: (value: unknown[]) => unknown) =>
          Promise.resolve(resolve(table === message ? [selectedMail] : []));
        return Reflect.get(target, property, receiver);
      },
    });
    return query;
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('opt-in Labtest attachment worker', () => {
  it('stays off unless both the explicit worker flag and a write mode are set', async () => {
    for (const env of [{}, { PANE_HMS_LAB_ATTACH_WORKER: 'on' },
      { PANE_HMS_LAB_ATTACH_WORKER: 'on', RESERVATIONIST_PANE_SAVE: 'lab' },
      { PANE_HMS_LAB_ATTACH_WORKER: 'off', PANE_WRITE_ATTACH: 'lab' }]) {
      expect(labtestAttachWorkerEnabled(env)).toBe(false);
      const claim = vi.fn(async () => null) as unknown as typeof claimNextAiRun;
      expect(await runLabtestAttachOnce({ ownerId: 'worker', env, claim })).toBe(false);
      expect(claim).not.toHaveBeenCalled();
    }
    expect(labtestAttachWorkerEnabled({ PANE_HMS_LAB_ATTACH_WORKER: 'on', PANE_WRITE_ATTACH: 'on' })).toBe(true);
  });

  it('refuses Go before creating a grant when the matching worker is disabled', async () => {
    vi.stubEnv('PANE_HMS_LAB_ATTACH_WORKER', 'off');
    vi.stubEnv('PANE_WRITE_ATTACH', 'lab');
    const item = { id: 'item', transportId: 'transport-centurion', status: 'needs_you', threadId: 'thread',
      sourceMessageId: 'message', state: { action: 'attach_document', sourceMessageId: 'message', lastName: 'Labtest',
        confirmation: '123-1', arrival: '2027-09-14', attachmentId: 'attachment', documentName: 'voucher.pdf',
        sourceInternetMessageId: selectedInternetMessageId, sourceThreadId: selectedSource.threadId,
        sourceHash: selectedSource.sourceHash, pdfSha256: 'a'.repeat(64), sourceSnapshotDigest: 'b'.repeat(64) } };
    const insert = vi.fn();
    const db = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      select: selectedSourceQueries(item), execute: async () => [], insert }) } as unknown as DB;
    await expect(approveHmsWrite({ db, transportId: item.transportId, workItemId: item.id, actorUserId: 'staff',
      selectedInternetMessageId, selectedSource, sessionId: 'session-1', sessionProfile: 'remote' }))
      .rejects.toThrow('filing_unavailable');
    expect(insert).not.toHaveBeenCalled();
  });

  it('claims only the dedicated prompt and passes the same lease to the runner once', async () => {
    const claimed = { id: 'run', claimOwner: 'worker', claimToken: 'token', deadlineAt: new Date('2027-01-01') };
    const claim = vi.fn(async () => claimed) as unknown as typeof claimNextAiRun;
    const run = vi.fn(async () => ({ status: 'lease_lost' as const })) as unknown as typeof runPaneHmsWriteOnce;
    expect(await runLabtestAttachOnce({ ownerId: 'worker', env: enabled, claim, run })).toBe(true);
    expect(claim).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ lane: 'hms', runKind: HMS_WRITE_RUN_KIND,
      promptVersion: HMS_LABTEST_ATTACH_PROMPT_VERSION }));
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run', fence: expect.objectContaining({
      runId: 'run', claimOwner: 'worker', claimToken: 'token', deadlineAt: claimed.deadlineAt,
    }) }));
  });

  it('queues the approved source-bound Labtest form for the worker that claims and runs it', async () => {
    vi.stubEnv('PANE_HMS_LAB_ATTACH_WORKER', 'on');
    vi.stubEnv('PANE_WRITE_ATTACH', 'lab');
    const now = new Date();
    const item = { id: 'item', transportId: 'transport-centurion', status: 'needs_you', threadId: 'thread',
      sourceMessageId: 'message', state: { action: 'attach_document', sourceMessageId: 'message', lastName: 'Labtest',
        confirmation: '123-1', arrival: '2027-09-14', attachmentId: 'attachment', documentName: 'voucher.pdf',
        sourceInternetMessageId: selectedInternetMessageId, sourceThreadId: selectedSource.threadId,
        sourceHash: selectedSource.sourceHash, pdfSha256: 'a'.repeat(64), sourceSnapshotDigest: 'b'.repeat(64),
        documentCode: `NAVA${'A'.repeat(26)}`, filingStateDigest: hmsStateDigest({ confirmation: '123-1' }),
        hmsSnapshot: { digest: hmsStateDigest({ confirmation: '123-1' }), readAt: now.toISOString() } } };
    const events: Array<Record<string, unknown>> = [];
    let queued: Record<string, unknown> | undefined;
    const tx = { select: selectedSourceQueries(item), execute: async () => [], insert: (table: unknown) => ({ values: (value: Record<string, unknown>) => {
      if (table === workEvent) events.push(value);
      if (table === aiWorkflowRun) queued = value;
      const chain = Object.assign(Promise.resolve(), {
        onConflictDoNothing() { return this; }, returning: async () => queued ? [queued] : [],
      });
      return chain;
    } }) };
    const db = { transaction: async (fn: (db: unknown) => Promise<unknown>) => fn(tx) } as unknown as DB;
    const approved = await approveHmsWrite({ db, transportId: item.transportId, workItemId: item.id,
      actorUserId: 'staff', sessionId: 'session-1', sessionProfile: 'remote', selectedInternetMessageId, selectedSource,
      formDigest: formDigest(item.state), now });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ id: approved.grantId, type: 'approval.granted', actorUserId: 'staff' }));
    expect(events[0]?.value).toMatchObject({ sessionId: 'session-1', sessionProfile: 'remote' });
    expect(queued).toEqual(expect.objectContaining({ id: approved.runId, triggerMessageId: 'message', workItemId: item.id,
      idempotencyKey: `hms-write:${approved.grantId}`, state: 'queued', runKind: HMS_WRITE_RUN_KIND,
      executorLane: 'hms', promptVersion: HMS_LABTEST_ATTACH_PROMPT_VERSION }));
    const claim = vi.fn(async (scope: { ownerId: string; runKind?: string; promptVersion?: string }) => (
      queued && scope.runKind === queued.runKind && scope.promptVersion === queued.promptVersion
        ? { ...queued, claimOwner: scope.ownerId, claimToken: 'token', deadlineAt: new Date(now.getTime() + 60_000) } : null
    )) as unknown as typeof claimNextAiRun;
    const run = vi.fn(async () => ({ status: 'lease_lost' as const })) as unknown as typeof runPaneHmsWriteOnce;
    expect(await runLabtestAttachOnce({ ownerId: 'worker', db, env: enabled, claim, run })).toBe(true);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ runId: approved.runId,
      fence: expect.objectContaining({ runId: approved.runId, claimOwner: 'worker', claimToken: 'token' }) }));
  });

  it('does not claim during shutdown or before recovery', async () => {
    const claim = vi.fn(async () => null) as unknown as typeof claimNextAiRun;
    expect(await runLabtestAttachOnce({ ownerId: 'worker', env: enabled, claim, signal: AbortSignal.abort() })).toBe(false);
    expect(await runLabtestAttachOnce({ ownerId: 'worker', env: enabled, claim,
      recovery: { mayClaim: async () => false } })).toBe(false);
    expect(claim).not.toHaveBeenCalled();
  });
});
