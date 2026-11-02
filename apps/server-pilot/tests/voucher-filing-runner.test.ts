import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFilingRunner } from '../src/ai/voucher-filing-runner.js';
import { createPropertyReadLock } from '../src/hms/property-read-lock.js';

const pdf = Buffer.from('%PDF-synthetic');
const sha256 = createHash('sha256').update(pdf).digest('hex');
const marker = `NAVA${'A'.repeat(32)}`;
function fixture() {
  const fence = { runId: 'run-1', claimOwner: 'worker', claimToken: 'token', deadlineAt: new Date('2099-01-01') };
  const context = { _options: { serviceWorkers: 'block' }, serviceWorkers: () => [], pages: () => [page], routeWebSocket: () => {} };
  const page = { context: () => context };
  const form = { propertyCode: 'HRCEN', payload: { source: { sha256 } } };
  const connection = { query: async () => [{ ok: true }], close: async () => {} } as any;
  const lock = createPropertyReadLock({ tenantId: 'tenant', propertyCode: 'HRCEN', connectionFactory: async () => connection });
  const consume = vi.fn(async () => ({ grantId: 'grant-1', payloadHash: 'hash', hmsBeforeDigest: 'before', form }));
  const readApprovedSource = vi.fn(async () => ({ status: 'ready' as const, bytes: pdf }));
  const readApprovedSnapshot = vi.fn(async () => ({ identity: 'same-shape', coverage: { complete: true, refreshVerified: true } }));
  const isEligibleSnapshot = vi.fn((snapshot: any) => snapshot.coverage.complete && snapshot.coverage.refreshVerified);
  const checkBeforeSave = vi.fn(async ({ readHmsState }: any) => {
    await readHmsState(); return { status: 'unchanged' as const };
  });
  const persistPreimage = vi.fn(async () => true);
  const endRun = vi.fn(async () => true);
  const fileLabtestVoucher = vi.fn(async ({ checkAuthority, persistPreimage: persist }: any) => {
    if (!(await checkAuthority())) return { outcome: 'not_dispatched' };
    if (!(await persist({ marker }))) return { outcome: 'not_dispatched' };
    return { outcome: 'awaiting_readback', marker };
  });
  const deps = { db: {} as any, fence, serverGrantId: 'grant-1', page,
    propertyLock: { connection, tenantId: 'tenant', propertyCode: 'HRCEN' }, consume: consume as any,
    checkBeforeSave: checkBeforeSave as any, readApprovedSource, readApprovedSnapshot, isEligibleSnapshot,
    persistPreimage, fileLabtestVoucher, endRun: endRun as any };
  return { deps, form, consume, readApprovedSource, readApprovedSnapshot, isEligibleSnapshot, checkBeforeSave,
    persistPreimage, fileLabtestVoucher, context, endRun, lock };
}

describe('fenced voucher filing runner', () => {
  it('consumes the server run grant, checks source and same-shape snapshot, and reports a dispatch uncertain', async () => {
    const f = fixture();
    const result = await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'grant-1' }));
    expect(result).toEqual({ schema: 'nava.tool/v1', outcome: 'uncertain', reason: 'filing_needs_check',
      data: { documentCode: marker } });
    expect(f.consume).toHaveBeenCalledWith({ db: f.deps.db, runId: 'run-1', fence: f.deps.fence });
    expect(f.readApprovedSnapshot).toHaveBeenCalledOnce();
    expect(f.persistPreimage).toHaveBeenCalledWith({ fence: f.deps.fence, grantId: 'grant-1', preimage: { marker } });
    expect(f.fileLabtestVoucher).toHaveBeenCalledOnce();
    expect(f.endRun).toHaveBeenCalledWith({ db: f.deps.db, fence: f.deps.fence,
      failureClass: 'UNKNOWN', reason: 'filing_needs_check' });
  });

  it('rejects client authority fields and a different grant before consuming', async () => {
    const f = fixture();
    expect((await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'grant-1', runId: 'client' } as any))).outcome).toBe('needs_input');
    expect((await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'other' }))).outcome).toBe('refused');
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.fileLabtestVoucher).not.toHaveBeenCalled();
  });

  it('rejects a consumed grant that does not match the server-owned binding', async () => {
    const f = fixture();
    f.consume.mockResolvedValueOnce({ grantId: 'different', payloadHash: 'hash', hmsBeforeDigest: 'before', form: f.form });
    expect((await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'grant-1' }))).reason).toBe('filing_grant_mismatch');
    expect(f.fileLabtestVoucher).not.toHaveBeenCalled();
  });

  it('refuses a missing held property lock or a mismatched approved property', async () => {
    const missing = fixture();
    expect((await createFilingRunner(missing.deps).run({ grantRef: 'grant-1' })).reason).toBe('filing_authority_unavailable');
    expect(missing.consume).not.toHaveBeenCalled();
    const wrong = fixture();
    wrong.consume.mockResolvedValueOnce({ grantId: 'grant-1', payloadHash: 'hash', hmsBeforeDigest: 'before',
      form: { ...wrong.form, propertyCode: 'HRDAV' } });
    expect((await wrong.lock.withLock(() => createFilingRunner(wrong.deps).run({ grantRef: 'grant-1' }))).reason)
      .toBe('filing_property_mismatch');
    expect(wrong.fileLabtestVoucher).not.toHaveBeenCalled();
  });

  it('refuses live service workers, multiple pages or no websocket fence before consuming', async () => {
    for (const variant of ['workers', 'pages', 'websocket', 'configuration']) {
      const f = fixture();
      if (variant === 'workers') f.context.serviceWorkers = () => [1] as any;
      if (variant === 'pages') f.context.pages = () => [];
      if (variant === 'websocket') f.context.routeWebSocket = undefined as any;
      if (variant === 'configuration') f.context._options.serviceWorkers = 'allow';
      expect((await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'grant-1' }))).outcome).toBe('refused');
      expect(f.consume).not.toHaveBeenCalled();
    }
  });

  it('refuses stale, incomplete, failed reads and lost leases before native dispatch', async () => {
    for (const failure of ['stale', 'incomplete', 'error', 'lease']) {
      const f = fixture();
      if (failure === 'stale') f.checkBeforeSave.mockResolvedValueOnce({ status: 'needs_check', reason: 'snapshot_stale' } as any);
      if (failure === 'lease') f.checkBeforeSave.mockResolvedValueOnce({ status: 'lease_lost' } as any);
      if (failure === 'incomplete') f.isEligibleSnapshot.mockReturnValueOnce(false);
      if (failure === 'error') f.readApprovedSnapshot.mockRejectedValueOnce(new Error('unavailable'));
      expect((await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'grant-1' }))).reason).toBe('filing_needs_check');
      expect(f.fileLabtestVoucher).not.toHaveBeenCalled();
    }
  });

  it('rejects changed source bytes both before dispatch and during the release check', async () => {
    const first = fixture();
    first.readApprovedSource.mockResolvedValueOnce({ status: 'ready', bytes: Buffer.from('%PDF-wrong') });
    expect((await first.lock.withLock(() => createFilingRunner(first.deps).run({ grantRef: 'grant-1' }))).reason).toBe('filing_source_unavailable');
    expect(first.fileLabtestVoucher).not.toHaveBeenCalled();
    const later = fixture();
    later.readApprovedSource.mockResolvedValueOnce({ status: 'ready', bytes: pdf })
      .mockResolvedValueOnce({ status: 'ready', bytes: Buffer.from('%PDF-mutated') });
    expect((await later.lock.withLock(() => createFilingRunner(later.deps).run({ grantRef: 'grant-1' }))).reason).toBe('filing_not_dispatched');
    expect(later.persistPreimage).not.toHaveBeenCalled();
  });

  it('rejects a preimage that cannot be persisted durably', async () => {
    const f = fixture(); f.persistPreimage.mockResolvedValueOnce(false);
    expect((await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'grant-1' }))).reason).toBe('filing_not_dispatched');
  });

  it('never treats an adapter exception or contradictory possible dispatch as a refusal', async () => {
    const failed = fixture(); failed.fileLabtestVoucher.mockRejectedValueOnce(new Error('after possible dispatch'));
    expect((await failed.lock.withLock(() => createFilingRunner(failed.deps).run({ grantRef: 'grant-1' }))).outcome).toBe('uncertain');
    expect(failed.endRun).toHaveBeenCalledWith(expect.objectContaining({ failureClass: 'UNKNOWN' }));
    const contradictory = fixture();
    contradictory.fileLabtestVoucher.mockResolvedValueOnce({ outcome: 'not_dispatched', saveDispatched: 'unknown' } as any);
    expect((await contradictory.lock.withLock(() => createFilingRunner(contradictory.deps).run({ grantRef: 'grant-1' }))).outcome).toBe('uncertain');
  });

  it('runs a claimed grant at most once through one runner instance', async () => {
    const f = fixture(), runner = createFilingRunner(f.deps);
    await f.lock.withLock(async () => {
      await runner.run({ grantRef: 'grant-1' });
      expect((await runner.run({ grantRef: 'grant-1' })).reason).toBe('filing_run_already_invoked');
    });
    expect(f.consume).toHaveBeenCalledOnce();
  });
});
