import { createHash, randomUUID } from 'node:crypto';
import { access, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';

// This test substitutes the native session and database; it cannot prove an
// HMS save or a real staff Go.
const stubs = vi.hoisted(() => ({ native: vi.fn(), consume: vi.fn(), unchanged: vi.fn(), end: vi.fn(), evidence: vi.fn(),
  running: vi.fn(), heartbeat: vi.fn(), source: vi.fn(), approval: vi.fn(), epoch: vi.fn(), claim: vi.fn(), resolve: vi.fn() }));
vi.mock('../src/ai/hms-approval.js', async (original) => ({
  ...(await original<typeof import('../src/ai/hms-approval.js')>()), consumeHmsWriteApproval: stubs.consume,
  assertHmsUnchangedBeforeSave: stubs.unchanged, endHmsWriteRun: stubs.end,
  recordHmsWriteEvidence: stubs.evidence, lockConsumedCloudAmendApproval: stubs.approval,
}));
vi.mock('../src/ai/run-ledger.js', async (original) => ({
  ...(await original<typeof import('../src/ai/run-ledger.js')>()),
  markAiRunRunning: stubs.running, heartbeatAiRun: stubs.heartbeat,
}));
vi.mock('../src/ai/pane-cloud-amend.js', async (original) => ({
  ...(await original<typeof import('../src/ai/pane-cloud-amend.js')>()), lockBoundCloudAmendSource: stubs.source,
}));
vi.mock('../src/ai/hms-labtest-dispatch.js', async (original) => ({
  ...(await original<typeof import('../src/ai/hms-labtest-dispatch.js')>()),
  captureHmsLabtestDispatchEpoch: stubs.epoch, claimHmsLabtestDispatch: stubs.claim, resolveHmsLabtestDispatch: stubs.resolve,
}));
vi.mock('../src/ai/pane-stay-save.js', async (original) => ({
  ...(await original<typeof import('../src/ai/pane-stay-save.js')>()),
  paneStayPropertyLock: () => ({ withLock: async (fn: () => Promise<unknown>) => fn() }),
}));
vi.mock('../src/ai/pane-stay-spawn-env.js', async (original) => {
  const target = (await import('../src/hms/hms-read-target.js')).CENTURION_HMS_READ_TARGET;
  return { ...(await original<typeof import('../src/ai/pane-stay-spawn-env.js')>()),
    paneStayHmsTargetForTransport: () => ({ ok: true, target }) };
});
vi.mock('../tooling/playwright-quote/centurion-stay360.mjs', async (original) => ({
  ...(await original<typeof import('../tooling/playwright-quote/centurion-stay360.mjs')>()), centurionWriterCurrent: () => true,
}));
vi.mock('../tooling/hms-cloud/pane-amend-session.mjs', () => ({ commitCloudPaneAmend: stubs.native }));

import { runLabtestAmendOnce } from '../src/ai/hms-labtest-amend-worker.js';
import { HMS_LABTEST_AMEND_PROMPT_VERSION } from '../src/ai/pane-cloud-amend-readiness.js';
import { aiWorkflowRun } from '../src/db/schema/mail.js';
import { workEvent } from '../src/db/schema/work.js';

const env = { PANE_HMS_LAB_AMEND_WORKER: 'on', PANE_WRITE_AMEND: 'lab' };
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic')]);
const writer = { host: '7'.repeat(64), bootId: '00000000-0000-4000-8000-000000000007',
  pidNamespace: 'pid:[123]', node: { pid: 101, started: '1' }, browser: { pid: 102, started: '2' } };
let privateDir: string | null = null;

afterEach(async () => {
  if (privateDir) await rm(privateDir, { recursive: true, force: true });
  privateDir = null;
  vi.clearAllMocks();
});

describe('queued Cloud amend worker to readback (synthetic)', () => {
  it.each(['confirmed', 'after_seal_enoent', 'changed_preimage', 'epoch_occupied'] as const)(
    '%s: requires the claimed run, pre-effect evidence and a positive readback', async (scenario) => {
      const workItemId = randomUUID(), grantId = randomUUID(), runId = randomUUID(), holdId = randomUUID();
      const deadlineAt = new Date(Date.now() + 25 * 60_000), claimToken = randomUUID();
      const claimed = { id: runId, claimOwner: 'worker', claimToken, deadlineAt };
      const binding = { selected: { threadId: 'thread', messageId: 'message', extractionId: randomUUID(),
        sourceHash: 'a'.repeat(64) }, digest: 'b'.repeat(64), revision: 1, revisionHead: 1, revisionSeq: 2 };
      const native = { source: 'record_view_ext_model', propertyCode: 'HRCEN', firstName: 'Proof', lastName: 'Labtest',
        status: 'Reserved', confirmation: '12345678-1', guestId: '000123', arrival: '2027-05-02',
        departure: '2027-05-03', reservationStayId: '30', reservationId: '20', recordId: '40',
        roomType: 'STQN', ratePlan: 'BAR', adults: 2, children: 1, childAges: [8] };
      const price = { data: { state: 'amount', cents: '10000' }, visible: { state: 'amount', cents: '10000' },
        dataCurrency: { state: 'currency', code: 'ZAR' }, visibleCurrency: { state: 'currency', code: 'ZAR' } };
      const approvedPrices = { version: 1, currency: 'ZAR', fields: Object.fromEntries(
        ['averagenightly', 'averagerate', 'grandtotal', 'totalrate', 'totalratewithtax', 'guesttotal', 'tax', 'guesttax']
          .map((key) => [key, price])) };
      const form = { action: 'amend', confirmation: native.confirmation, arrival: native.arrival,
        fields: { adults: 3, ratePlan: 'BAR', retainRates: 'yes' }, previewDigest: 'c'.repeat(64),
        cloudAmend: { binding, nativeDigest: 'd'.repeat(64), preimage: { native }, approvedPrices,
          preserved: { cmsRecipient: '', agency: null, organization: null } } };
      const consumed = { form, grantId, payloadHash: 'e'.repeat(64), hmsBeforeDigest: 'f'.repeat(64),
        authority: { actorUserId: 'staff', sessionId: 'session', sessionProfile: 'remote' as const } };
      const evidenceRows: Array<Record<string, unknown>> = [], ordered: string[] = [];
      let evidenceRead = 0, intent: Record<string, unknown> | null = null;
      const tx = { select: () => {
        let table: unknown;
        const query = { from: (value: unknown) => { table = value; return query; }, where: () => query,
          limit: () => query, for: async () => table === workEvent ? [evidenceRows[evidenceRead++ === 2 ? 1 : 0]]
            : table === aiWorkflowRun ? [{ metrics: {}, deadlineAt }] : [] };
        return query;
      }, update: () => ({ set: () => ({ where: async () => {} }) }) };
      const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [
        { workItemId, transportId: 'transport' },
      ] }) }) }) } as unknown as DB;
      stubs.consume.mockResolvedValue(consumed);
      stubs.epoch.mockImplementation(async () => {
        ordered.push('epoch');
        if (scenario === 'epoch_occupied') throw new Error('hms_labtest_dispatch_occupied');
        return '8'.repeat(64);
      });
      stubs.running.mockResolvedValue(true); stubs.heartbeat.mockResolvedValue(true); stubs.end.mockResolvedValue(true);
      stubs.unchanged.mockResolvedValue(scenario === 'changed_preimage' ? { status: 'needs_check', reason: 'hms_changed' }
        : { status: 'unchanged' });
      stubs.source.mockResolvedValue({ id: workItemId }); stubs.approval.mockResolvedValue(undefined);
      stubs.evidence.mockImplementation(async ({ name }: { name: string }) => {
        if (name === 'after.png' && scenario === 'after_seal_enoent') {
          throw Object.assign(new Error('storage failed'), { code: 'ENOENT' });
        }
        const eventId = randomUUID(), sha256 = createHash('sha256').update(png).digest('hex');
        evidenceRows.push({ value: { runId, name }, evidence: { sha256, bytes: png.length, contentType: 'image/png',
          key: `hms-write-evidence/v1/transport/${workItemId}/${runId}/${name}` } });
        ordered.push(`seal:${name}`);
        return { eventId, sha256 };
      });
      stubs.claim.mockImplementation(async (_db, value, authorize, epoch) => {
        expect(epoch).toBe('8'.repeat(64));
        ordered.push('claim');
        await authorize(tx, value);
        intent = { ...structuredClone(value), version: 1, kind: 'intent', holdId, ownerDigest: 'a'.repeat(64) };
        return { holdId, ownerToken: 'a'.repeat(64) };
      });
      stubs.resolve.mockImplementation(async (_db, _handle, _result, authorize) => {
        ordered.push('resolve');
        await authorize(tx, intent);
      });
      stubs.native.mockImplementation(async (input, authorization) => {
        privateDir = dirname(input.beforeScreenshot);
        await writeFile(input.beforeScreenshot, png);
        await authorization.sealBeforeEvidence();
        await authorization.authorizeFirst({ operationDigest: authorization.operationDigest, phase: 'amend.availability',
          requestDigest: '1'.repeat(64), writer });
        ordered.push('native-effect'); // Simulated; no network request is made.
        await writeFile(input.afterScreenshot, png);
        return { outcome: 'amended', dispatchCallbacksDrained: true, writerSessionClosed: true, retainedPriceMatched: true,
          readback: { confirmation: native.confirmation, arrival: native.arrival, departure: native.departure,
            adults: 3, children: native.children, childAges: native.childAges, ratePlan: native.ratePlan } };
      });
      const claim = vi.fn(async () => claimed);
      expect(await runLabtestAmendOnce({ ownerId: 'worker', db, env, claim })).toBe(true);
      expect(claim).toHaveBeenCalledWith(expect.objectContaining({ promptVersion: HMS_LABTEST_AMEND_PROMPT_VERSION }));
      if (scenario === 'confirmed') {
        expect(ordered).toEqual(['epoch', 'seal:before.png', 'claim', 'native-effect', 'seal:after.png', 'resolve']);
        expect(stubs.end).not.toHaveBeenCalled();
      } else if (scenario === 'epoch_occupied') {
        expect(ordered).toEqual(['epoch']);
        expect(stubs.native).not.toHaveBeenCalled();
        expect(stubs.claim).not.toHaveBeenCalled();
        expect(stubs.end).toHaveBeenCalledWith(expect.objectContaining({ failureClass: 'NEEDS_CHECK' }));
      } else {
        expect(stubs.resolve).not.toHaveBeenCalled();
        expect(stubs.end).toHaveBeenCalledWith(expect.objectContaining({ failureClass: 'UNKNOWN' }));
        if (scenario === 'after_seal_enoent') {
          expect(ordered).toEqual(['epoch', 'seal:before.png', 'claim', 'native-effect']);
          await expect(access(`${privateDir}/after.png`)).resolves.toBeUndefined();
        } else expect(ordered).toEqual(['epoch', 'seal:before.png']);
      }
    });
});
