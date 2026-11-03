import { describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/client.js';
import { cloudAmendDispatchCallbacks, cloudAmendDispatchFormSchema } from '../src/ai/pane-cloud-amend-dispatch.js';
import { authorizeFreshCloudAmend, verifiedCloudAmendReadback } from '../src/ai/pane-cloud-amend-runner.js';
import { HMS_LABTEST_AMEND_DISPATCH_RESERVE_MS } from '../src/ai/pane-cloud-amend-readiness.js';
import type { claimHmsLabtestDispatch } from '../src/ai/hms-labtest-dispatch.js';
import { createLabtestAmendDispatch } from '../tooling/hms-cloud/labtest-amend-dispatch.mjs';
import type { AiRunFence } from '../src/ai/run-ledger.js';

const workItemId = '00000000-0000-4000-8000-000000000001';
const grantId = '00000000-0000-4000-8000-000000000002';
const holdId = '00000000-0000-4000-8000-000000000003';
const expectedEpoch = '8'.repeat(64);
const beforeEvidence = { eventId:'00000000-0000-4000-8000-000000000005', sha256:'9'.repeat(64) };
const runId = '00000000-0000-4000-8000-000000000006';
const writer = { host: '7'.repeat(64), bootId: '00000000-0000-4000-8000-000000000007',
  pidNamespace: 'pid:[123]', node: { pid: 101, started: '1' }, browser: { pid: 102, started: '2' } };
const source = { threadId: 'thread', messageId: 'message', extractionId: '00000000-0000-4000-8000-000000000004',
  sourceHash: 'a'.repeat(64) };
const binding = { selected: source, digest: 'b'.repeat(64), revision: 1, revisionHead: 1, revisionSeq: 2 };
const native = { source: 'record_view_ext_model', propertyCode: 'HRCEN', firstName: 'Proof', lastName: 'Labtest',
  status: 'Reserved', confirmation: '12345678-1', guestId: '000123', arrival: '2027-05-02',
  reservationStayId: '30', reservationId: '20', recordId: '40', roomType: 'STQN',
  departure: '2027-05-03', ratePlan: 'BAR', adults: 2, children: 1, childAges: [8] };
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
const request = (phase: 'availability' | 'save') => ({ method: () => 'POST',
  url: () => `https://hmsweb.hms.eu1.inforcloudsuite.com/web/base/${phase === 'availability'
    ? 'OSRESV.HDR.getcheckavailability' : 'OSRESV.HDR?pageaction=SAVE'}`,
  headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }),
  postDataBuffer: () => Buffer.from('fenced=request') });

describe('cloud amend shared dispatch adapter', () => {
  it('claims only after a fresh unchanged HMS read and refuses a stopped or expired operation', async () => {
    const claim = vi.fn(async () => 'claimed');
    const check = vi.fn(async () => ({ status: 'unchanged' as const }));
    const deadline = new Date(Date.now() + HMS_LABTEST_AMEND_DISPATCH_RESERVE_MS + 60_000);
    expect(await authorizeFreshCloudAmend(check, claim, deadline)).toBe('claimed');
    expect(check.mock.invocationCallOrder[0]).toBeLessThan(claim.mock.invocationCallOrder[0]!);
    for (const result of [{ status: 'lease_lost' as const },
      { status: 'needs_check' as const, reason: 'hms_changed' as const }]) {
      const refused = vi.fn(async () => result);
      await expect(authorizeFreshCloudAmend(refused, claim, deadline)).rejects.toThrow('CLOUD_AMEND_PREIMAGE_CHANGED');
    }
    const controller = new AbortController();
    let finish!: (value: { status: 'unchanged' }) => void;
    const pending = new Promise<{ status: 'unchanged' }>((resolve) => { finish = resolve; });
    const stopped = authorizeFreshCloudAmend(() => pending, claim, deadline, controller.signal);
    controller.abort();
    finish({ status: 'unchanged' });
    await expect(stopped).rejects.toThrow('CLOUD_AMEND_PREIMAGE_CHANGED');
    await expect(authorizeFreshCloudAmend(check, claim, deadline, controller.signal)).rejects.toThrow('CLOUD_AMEND_PREIMAGE_CHANGED');
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('requires time for the writer and independent readback, even after a slow claim commits', async () => {
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(1_000);
      const deadline = new Date(1_000 + HMS_LABTEST_AMEND_DISPATCH_RESERVE_MS + 100);
      const check = vi.fn(async () => ({ status: 'unchanged' as const }));
      const claim = vi.fn(async () => { clock.mockReturnValue(1_101); return 'committed'; });
      await expect(authorizeFreshCloudAmend(check, claim, deadline)).rejects.toThrow('CLOUD_AMEND_DEADLINE_EXHAUSTED');
      expect(claim).toHaveBeenCalledTimes(1); // The caller must preserve the committed UNKNOWN.
      const tooLate = vi.fn(async () => 'must not claim');
      await expect(authorizeFreshCloudAmend(check, tooLate, deadline)).rejects.toThrow('CLOUD_AMEND_PREIMAGE_CHANGED');
      expect(tooLate).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it('commits one recoverable shared hold after source and approval checks for the whole amend', async () => {
    const events: string[] = [], tx = {} as never, db = {} as DB, item = { id: workItemId } as never;
    const claim: typeof claimHmsLabtestDispatch = async (_db, input, authorize, epoch) => {
      expect(epoch).toBe(expectedEpoch);
      expect(input).toMatchObject({ nativeGuestId: '000123', operation: 'amend', sourceDigest: binding.digest,
        recovery: { firstPhase:'amend.availability', confirmation:native.confirmation, approved:form.fields, beforeEvidence, writer } });
      events.push('claim-start'); await authorize(tx, input); events.push('claim-commit');
      return { holdId, ownerToken: 'a'.repeat(64) };
    };
    const lockSource = vi.fn(async () => { events.push('source'); return item; });
    const lockApproval = vi.fn(async () => { events.push('approval'); });
    const checkEvidence = vi.fn(async (_tx, details) => {
      expect(details).toEqual({ transportId: 'transport', workItemId, runId, ...beforeEvidence });
      events.push('evidence');
    });
    const callbacks = cloudAmendDispatchCallbacks({ db, fence: { runId } as AiRunFence, transportId: 'transport',
      workItemId, consumed, expectedEpoch }, { claim, lockSource, lockApproval, checkEvidence, writerCurrent: () => true });
    const dispatcher = createLabtestAmendDispatch({ ...callbacks, requiresAvailability: true,
      authorizeFirst: (step: Omit<Parameters<typeof callbacks.authorizeFirst>[0], 'beforeEvidence' | 'writer'>) =>
        callbacks.authorizeFirst({ ...step, beforeEvidence, writer }) });
    await dispatcher.availability(request('availability'), async () => { events.push('availability'); });
    await dispatcher.save(request('save'), async () => { events.push('save'); });
    expect(events).toEqual(['claim-start', 'source', 'approval', 'evidence', 'claim-commit', 'availability', 'save']);
  });

  it('refuses missing session, altered operation, stale source and revoked approval', async () => {
    const db = {} as DB, fence = {} as AiRunFence;
    const input = { db, fence, transportId: 'transport', workItemId, consumed, expectedEpoch };
    expect(() => cloudAmendDispatchCallbacks({ ...input, consumed: { ...consumed, authority: null } })).toThrow();
    expect(() => cloudAmendDispatchCallbacks({ ...input, expectedEpoch: 'missing' })).toThrow('CLOUD_AMEND_AUTHORITY_INVALID');
    for (const failure of ['source', 'approval', 'evidence']) {
      const claim: typeof claimHmsLabtestDispatch = async (_db, value, authorize) => {
        await authorize({} as never, value); return { holdId, ownerToken: 'a'.repeat(64) };
      };
      const callbacks = cloudAmendDispatchCallbacks(input, {
        claim, lockSource: vi.fn(async () => failure === 'source' ? null : ({ id: workItemId } as never)),
        lockApproval: vi.fn(async () => { if (failure === 'approval') throw new Error('revoked'); }),
        checkEvidence: vi.fn(async () => { if (failure === 'evidence') throw new Error('unsealed'); }),
        writerCurrent: () => true,
      });
      await expect(callbacks.authorizeFirst({ operationDigest: '0'.repeat(64), phase: 'amend.save',
        requestDigest: '1'.repeat(64), beforeEvidence, writer })).rejects.toThrow('CLOUD_AMEND_APPROVAL_CHANGED');
      await expect(callbacks.authorizeFirst({ operationDigest: callbacks.operationDigest, phase: 'amend.save',
        requestDigest: '1'.repeat(64), beforeEvidence, writer })).rejects.toThrow();
    }
  });

  it('does not continue a native request when an intervening write changes the epoch', async () => {
    const claim = vi.fn(async (_db, _value, _authorize, epoch) => {
      expect(epoch).toBe(expectedEpoch);
      throw new Error('hms_labtest_dispatch_occupied');
    });
    const callbacks = cloudAmendDispatchCallbacks({ db: {} as DB, fence: { runId } as AiRunFence,
      transportId: 'transport', workItemId, consumed, expectedEpoch }, { claim, writerCurrent: () => true });
    const dispatcher = createLabtestAmendDispatch({ ...callbacks, requiresAvailability: true,
      authorizeFirst: (step: Omit<Parameters<typeof callbacks.authorizeFirst>[0], 'beforeEvidence' | 'writer'>) =>
        callbacks.authorizeFirst({ ...step, beforeEvidence, writer }) });
    const proceed = vi.fn(async () => {});
    await expect(dispatcher.availability(request('availability'), proceed)).rejects.toThrow('hms_labtest_dispatch_occupied');
    expect(proceed).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('requires the sealed before screenshot on the exact run before committing the claim', async () => {
    const valid = { value: { runId, name: 'before.png' }, evidence: { sha256: beforeEvidence.sha256, contentType: 'image/png',
      key: `hms-write-evidence/v1/transport/${workItemId}/${runId}/before.png`, bytes: 100 } };
    const cases = [
      { row: valid, allowed: true },
      { row: undefined, allowed: false },
      { row: { ...valid, value: { ...valid.value, runId: workItemId } }, allowed: false },
      { row: { ...valid, value: { ...valid.value, name: 'after.png' } }, allowed: false },
      { row: { ...valid, evidence: { ...valid.evidence, sha256: '0'.repeat(64) } }, allowed: false },
      { row: { ...valid, evidence: { ...valid.evidence, contentType: 'image/jpeg' } }, allowed: false },
      { row: { ...valid, evidence: { ...valid.evidence, key: 'some-other-object' } }, allowed: false },
      { row: { ...valid, evidence: { ...valid.evidence, bytes: 0 } }, allowed: false },
    ];
    for (const { row, allowed } of cases) {
      const locked = vi.fn(async () => row ? [row] : []);
      const limit = vi.fn(() => ({ for: locked }));
      const tx = { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) } as never;
      let committed = false;
      const claim: typeof claimHmsLabtestDispatch = async (_db, input, authorize) => {
        await authorize(tx, input);
        committed = true;
        return { holdId, ownerToken: 'a'.repeat(64) };
      };
      const callbacks = cloudAmendDispatchCallbacks({ db: {} as DB, fence: { runId } as AiRunFence,
        transportId: 'transport', workItemId, consumed, expectedEpoch }, { claim,
        lockSource: vi.fn(async () => ({ id: workItemId } as never)), lockApproval: vi.fn(async () => {}),
        writerCurrent: () => true });
      const result = callbacks.authorizeFirst({ operationDigest: callbacks.operationDigest, phase: 'amend.save',
        requestDigest: '1'.repeat(64), beforeEvidence, writer });
      if (allowed) await expect(result).resolves.toMatchObject({ holdId });
      else await expect(result).rejects.toThrow('CLOUD_AMEND_EVIDENCE_INVALID');
      expect(committed).toBe(allowed);
      expect(limit).toHaveBeenCalledWith(1);
      expect(locked).toHaveBeenCalledWith('share');
    }
  });

  it('resolves only its own immutable dispatch intent and never repeats a claim', async () => {
    let claimed: unknown;
    const claim: typeof claimHmsLabtestDispatch = async (_db, value, authorize) => {
      await authorize({} as never, value); claimed = structuredClone(value);
      return { holdId, ownerToken: 'a'.repeat(64) };
    };
    const callbacks = cloudAmendDispatchCallbacks({ db: {} as DB, fence: { runId } as AiRunFence,
      transportId:'transport', workItemId, consumed, expectedEpoch }, { claim,
      lockSource:vi.fn(async () => ({ id:workItemId } as never)), lockApproval:vi.fn(async () => {}),
      checkEvidence:vi.fn(async () => {}), writerCurrent: () => true });
    const step = { operationDigest:callbacks.operationDigest, phase:'amend.availability' as const,
      requestDigest:'1'.repeat(64), beforeEvidence, writer };
    await callbacks.authorizeFirst(step);
    const intent = { ...(claimed as object), version:1, kind:'intent', holdId, ownerDigest:'a'.repeat(64) };
    expect(() => callbacks.assertResolutionIntent(intent as never)).not.toThrow();
    expect(() => callbacks.assertResolutionIntent({ ...intent, requestDigest:'2'.repeat(64) } as never))
      .toThrow('CLOUD_AMEND_INTENT_CHANGED');
    expect(() => callbacks.assertResolutionIntent({ ...intent, grantId:workItemId } as never))
      .toThrow('CLOUD_AMEND_INTENT_CHANGED');
    await expect(callbacks.authorizeFirst(step)).rejects.toThrow('CLOUD_AMEND_APPROVAL_CHANGED');
  });

  it('does not repeat an ambiguously committed dispatch claim', async () => {
    const claim = vi.fn(async () => { throw new Error('connection lost after commit'); });
    const callbacks = cloudAmendDispatchCallbacks({ db:{} as DB, fence:{ runId } as AiRunFence,
      transportId:'transport', workItemId, consumed, expectedEpoch }, { claim, writerCurrent: () => true });
    const step = { operationDigest:callbacks.operationDigest, phase:'amend.availability' as const,
      requestDigest:'1'.repeat(64), beforeEvidence, writer };
    await expect(callbacks.authorizeFirst(step)).rejects.toThrow('connection lost');
    await expect(callbacks.authorizeFirst(step)).rejects.toThrow('CLOUD_AMEND_APPROVAL_CHANGED');
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('requires the same live owned writer before and inside the UNKNOWN claim', async () => {
    const claimSeen = vi.fn();
    const claim: typeof claimHmsLabtestDispatch = async (_db, input, authorize) => {
      claimSeen();
      await authorize({} as never, input);
      return { holdId, ownerToken: 'a'.repeat(64) };
    };
    const make = (writerCurrent: (identity: typeof writer) => boolean) => cloudAmendDispatchCallbacks({
      db: {} as DB, fence: { runId } as AiRunFence, transportId: 'transport', workItemId, consumed, expectedEpoch,
    }, { claim, writerCurrent, lockSource: vi.fn(async () => ({ id: workItemId } as never)),
      lockApproval: vi.fn(async () => {}), checkEvidence: vi.fn(async () => {}) });
    const unavailable = make(() => false);
    const step = { operationDigest: unavailable.operationDigest, phase: 'amend.availability' as const,
      requestDigest: '1'.repeat(64), beforeEvidence, writer };
    await expect(unavailable.authorizeFirst(step)).rejects.toThrow('CLOUD_AMEND_WRITER_UNVERIFIED');
    expect(claimSeen).not.toHaveBeenCalled();
    const current = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const lost = make(current);
    await expect(lost.authorizeFirst(step)).rejects.toThrow('CLOUD_AMEND_WRITER_UNVERIFIED');
    expect(claimSeen).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledTimes(2);
  });

  it('accepts only a drained, closed, fresh readback of the exact approved outcome', () => {
    const approved = cloudAmendDispatchFormSchema.parse(form);
    const readback = { confirmation:native.confirmation, arrival:native.arrival, departure:native.departure,
      adults:3, children:native.children, childAges:native.childAges, ratePlan:native.ratePlan };
    const result = { outcome:'amended', dispatchCallbacksDrained:true, writerSessionClosed:true,
      retainedPriceMatched:true, readback };
    expect(verifiedCloudAmendReadback(approved, result)).toEqual(readback);
    const shifted = cloudAmendDispatchFormSchema.parse({ ...form, fields:{ arrival:'2027-05-03', departure:'2027-05-04',
      ratePlan:'BAR', retainRates:'yes' } });
    const shiftedResult = { ...result, readback:{ ...readback, arrival:'2027-05-03', departure:'2027-05-04', adults:native.adults } };
    expect(verifiedCloudAmendReadback(shifted, shiftedResult)).toEqual(shiftedResult.readback);
    expect(verifiedCloudAmendReadback(shifted, result)).toBeNull();
    for (const changed of [
      { ...result, outcome:'uncertain' }, { ...result, dispatchCallbacksDrained:false },
      { ...result, writerSessionClosed:false }, { ...result, retainedPriceMatched:false },
      { ...result, readback:{ ...readback, confirmation:'12345678-2' } },
      { ...result, readback:{ ...readback, adults:2 } },
      { ...result, readback:{ ...readback, childAges:[9] } },
      { ...result, readback:{ ...readback, ratePlan:'OTHER' } },
      { ...result, readback:{ ...readback, extra:'unexpected' } },
    ]) expect(verifiedCloudAmendReadback(approved, changed)).toBeNull();
  });

  it('refuses a changed rate or child count before claiming a shared hold', () => {
    const input = { db: {} as DB, fence: {} as AiRunFence, transportId: 'transport', workItemId, consumed, expectedEpoch };
    for (const fields of [
      { adults: 3, ratePlan: 'OTHER', retainRates: 'yes' },
      { children: 2, childAges: [8, 5], ratePlan: 'BAR', retainRates: 'yes' },
      { adults: 3, ratePlan: 'BAR', retainRates: 'no' },
      { adults: 3, departure: '2027-05-04', ratePlan: 'BAR', retainRates: 'yes' },
    ]) {
      expect(() => cloudAmendDispatchCallbacks({ ...input, consumed: { ...consumed,
        form: { ...form, fields } } })).toThrow('CLOUD_AMEND_AUTHORITY_INVALID');
    }
    const noPrices = { ...form, cloudAmend: { ...form.cloudAmend, approvedPrices: undefined } };
    expect(() => cloudAmendDispatchCallbacks({ ...input, consumed: { ...consumed, form: noPrices } }))
      .toThrow('CLOUD_AMEND_AUTHORITY_INVALID');
  });
});
