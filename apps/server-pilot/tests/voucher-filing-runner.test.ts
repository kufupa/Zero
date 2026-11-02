import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFilingRunner, prepareFilingContext } from '../src/ai/voucher-filing-runner.js';
import { createPropertyReadLock } from '../src/hms/property-read-lock.js';

const pdf = Buffer.from('%PDF-synthetic');
const sha256 = createHash('sha256').update(pdf).digest('hex');
const marker = `NAVA${'A'.repeat(32)}`;
async function fixture() {
  const fence = { runId: 'run-1', claimOwner: 'worker', claimToken: 'token', deadlineAt: new Date('2099-01-01') };
  const pages: unknown[] = [];
  const context = { _options: { serviceWorkers: 'block' }, serviceWorkers: () => [], pages: () => pages,
    routeWebSocket: vi.fn(async (_url: string, _handler: (socket: { close(): Promise<void> | void }) => void) => {}) };
  await prepareFilingContext(context);
  const page = { context: () => context };
  pages.push(page);
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
  const fileLabtestVoucher = vi.fn(async ({ checkAuthority, deadlineAt, persistPreimage: persist }: any) => {
    if (!(await checkAuthority())) return { outcome: 'not_dispatched' };
    if (!(await persist({ marker })) || Date.now() >= deadlineAt.getTime()) return { outcome: 'not_dispatched' };
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
  it('installs a close-all websocket fence before any page exists', async () => {
    const f = await fixture();
    expect(f.context.routeWebSocket).toHaveBeenCalledWith('**/*', expect.any(Function));
    const close = vi.fn();
    f.context.routeWebSocket.mock.calls[0][1]({ close });
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects contexts that were not fenced before page creation', async () => {
    const f = await fixture();
    const unprepared = { ...f.context, pages: () => [f.deps.page] };
    const page = { context: () => unprepared };
    unprepared.pages = () => [page];
    await expect(prepareFilingContext(unprepared)).rejects.toThrow('FILING_CONTEXT_UNSAFE');
    expect((await f.lock.withLock(() => createFilingRunner({ ...f.deps, page }).run({ grantRef: 'grant-1' }))).reason)
      .toBe('filing_authority_unavailable');
    expect(f.consume).not.toHaveBeenCalled();
  });

  it('does not attest a context if a worker or page appears during fence installation', async () => {
    for (const kind of ['page', 'worker']) {
      const f = await fixture();
      const context = { ...f.context, pages: () => [] as unknown[], serviceWorkers: () => [] as unknown[],
        routeWebSocket: vi.fn(async () => {
          if (kind === 'page') context.pages = () => [f.deps.page];
          else context.serviceWorkers = () => [1];
        }) };
      await expect(prepareFilingContext(context)).rejects.toThrow('FILING_CONTEXT_UNSAFE');
    }
  });

  it('never retries a partially failed context setup', async () => {
    const context = { _options: { serviceWorkers: 'block' }, serviceWorkers: () => [], pages: () => [],
      routeWebSocket: vi.fn(async () => { throw new Error('route failed'); }) };
    await expect(prepareFilingContext(context)).rejects.toThrow('route failed');
    await expect(prepareFilingContext(context)).rejects.toThrow('FILING_CONTEXT_UNSAFE');
    expect(context.routeWebSocket).toHaveBeenCalledOnce();
  });

  it('consumes the server run grant, checks source and same-shape snapshot, and reports a dispatch uncertain', async () => {
    const f = await fixture();
    const result = await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'grant-1' }));
    expect(result).toEqual({ schema: 'nava.tool/v1', outcome: 'uncertain', reason: 'filing_needs_check',
      data: { documentCode: marker } });
    expect(f.consume).toHaveBeenCalledWith({ db: f.deps.db, runId: 'run-1', fence: f.deps.fence });
    expect(f.readApprovedSnapshot).toHaveBeenCalledOnce();
    expect(f.persistPreimage).toHaveBeenCalledWith({ fence: f.deps.fence, grantId: 'grant-1', preimage: { marker } });
    expect(f.fileLabtestVoucher).toHaveBeenCalledOnce();
    expect(f.fileLabtestVoucher).toHaveBeenCalledWith(expect.objectContaining({ deadlineAt: f.deps.fence.deadlineAt }));
    expect(f.endRun).toHaveBeenCalledWith({ db: f.deps.db, fence: f.deps.fence,
      failureClass: 'UNKNOWN', reason: 'filing_needs_check' });
  });

  it('rejects client authority fields and a different grant before consuming', async () => {
    const f = await fixture();
    expect((await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'grant-1', runId: 'client' } as any))).outcome).toBe('needs_input');
    expect((await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'other' }))).outcome).toBe('refused');
    expect(f.consume).not.toHaveBeenCalled();
    expect(f.fileLabtestVoucher).not.toHaveBeenCalled();
  });

  it('rejects a consumed grant that does not match the server-owned binding', async () => {
    const f = await fixture();
    f.consume.mockResolvedValueOnce({ grantId: 'different', payloadHash: 'hash', hmsBeforeDigest: 'before', form: f.form });
    expect((await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'grant-1' }))).reason).toBe('filing_grant_mismatch');
    expect(f.fileLabtestVoucher).not.toHaveBeenCalled();
  });

  it('refuses a missing held property lock or a mismatched approved property', async () => {
    const missing = await fixture();
    expect((await createFilingRunner(missing.deps).run({ grantRef: 'grant-1' })).reason).toBe('filing_authority_unavailable');
    expect(missing.consume).not.toHaveBeenCalled();
    const wrong = await fixture();
    wrong.consume.mockResolvedValueOnce({ grantId: 'grant-1', payloadHash: 'hash', hmsBeforeDigest: 'before',
      form: { ...wrong.form, propertyCode: 'HRDAV' } });
    expect((await wrong.lock.withLock(() => createFilingRunner(wrong.deps).run({ grantRef: 'grant-1' }))).reason)
      .toBe('filing_property_mismatch');
    expect(wrong.fileLabtestVoucher).not.toHaveBeenCalled();
  });

  it('refuses live service workers, multiple pages or no websocket fence before consuming', async () => {
    for (const variant of ['workers', 'pages', 'websocket', 'configuration']) {
      const f = await fixture();
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
      const f = await fixture();
      if (failure === 'stale') f.checkBeforeSave.mockResolvedValueOnce({ status: 'needs_check', reason: 'snapshot_stale' } as any);
      if (failure === 'lease') f.checkBeforeSave.mockResolvedValueOnce({ status: 'lease_lost' } as any);
      if (failure === 'incomplete') f.isEligibleSnapshot.mockReturnValueOnce(false);
      if (failure === 'error') f.readApprovedSnapshot.mockRejectedValueOnce(new Error('unavailable'));
      expect((await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'grant-1' }))).reason).toBe('filing_needs_check');
      expect(f.fileLabtestVoucher).not.toHaveBeenCalled();
    }
  });

  it('refuses an expired or invalid run deadline before consuming the grant', async () => {
    for (const deadline of [new Date(0), new Date(NaN)]) {
      const f = await fixture();
      f.deps.fence.deadlineAt = deadline;
      expect((await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'grant-1' }))).outcome).toBe('refused');
      expect(f.consume).not.toHaveBeenCalled();
    }
  });

  it('refuses when the deadline expires during the pre-submit HMS read', async () => {
    const f = await fixture();
    const deadline = Date.now() + 60_000;
    f.deps.fence.deadlineAt = new Date(deadline);
    const clock = vi.spyOn(Date, 'now');
    try {
      f.checkBeforeSave.mockImplementationOnce(async ({ readHmsState }: any) => {
        await readHmsState(); clock.mockReturnValue(deadline); return { status: 'unchanged' as const };
      });
      expect((await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'grant-1' }))).reason).toBe('filing_needs_check');
      expect(f.fileLabtestVoucher).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it('refuses release when the deadline expires during the final authority check', async () => {
    const f = await fixture();
    const deadline = Date.now() + 60_000;
    f.deps.fence.deadlineAt = new Date(deadline);
    const clock = vi.spyOn(Date, 'now');
    try {
      f.checkBeforeSave.mockImplementationOnce(async ({ readHmsState }: any) => {
        await readHmsState(); return { status: 'unchanged' as const };
      }).mockImplementationOnce(async ({ readHmsState }: any) => {
        await readHmsState(); clock.mockReturnValue(deadline); return { status: 'unchanged' as const };
      });
      expect((await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'grant-1' }))).reason).toBe('filing_not_dispatched');
      expect(f.persistPreimage).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it('refuses when the deadline expires during durable preimage persistence', async () => {
    const f = await fixture();
    const deadline = Date.now() + 60_000;
    f.deps.fence.deadlineAt = new Date(deadline);
    const clock = vi.spyOn(Date, 'now');
    try {
      f.persistPreimage.mockImplementationOnce(async () => { clock.mockReturnValue(deadline); return true; });
      expect((await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'grant-1' }))).reason).toBe('filing_not_dispatched');
      expect(f.persistPreimage).toHaveBeenCalledOnce();
    } finally { clock.mockRestore(); }
  });

  it('rejects changed source bytes both before dispatch and during the release check', async () => {
    const first = await fixture();
    first.readApprovedSource.mockResolvedValueOnce({ status: 'ready', bytes: Buffer.from('%PDF-wrong') });
    expect((await first.lock.withLock(() => createFilingRunner(first.deps).run({ grantRef: 'grant-1' }))).reason).toBe('filing_source_unavailable');
    expect(first.fileLabtestVoucher).not.toHaveBeenCalled();
    const later = await fixture();
    later.readApprovedSource.mockResolvedValueOnce({ status: 'ready', bytes: pdf })
      .mockResolvedValueOnce({ status: 'ready', bytes: Buffer.from('%PDF-mutated') });
    expect((await later.lock.withLock(() => createFilingRunner(later.deps).run({ grantRef: 'grant-1' }))).reason).toBe('filing_not_dispatched');
    expect(later.persistPreimage).not.toHaveBeenCalled();
  });

  it('rejects a preimage that cannot be persisted durably', async () => {
    const f = await fixture(); f.persistPreimage.mockResolvedValueOnce(false);
    expect((await f.lock.withLock(() => createFilingRunner(f.deps).run({ grantRef: 'grant-1' }))).reason).toBe('filing_not_dispatched');
  });

  it('never treats an adapter exception or contradictory possible dispatch as a refusal', async () => {
    const failed = await fixture(); failed.fileLabtestVoucher.mockRejectedValueOnce(new Error('after possible dispatch'));
    expect((await failed.lock.withLock(() => createFilingRunner(failed.deps).run({ grantRef: 'grant-1' }))).outcome).toBe('uncertain');
    expect(failed.endRun).toHaveBeenCalledWith(expect.objectContaining({ failureClass: 'UNKNOWN' }));
    const contradictory = await fixture();
    contradictory.fileLabtestVoucher.mockResolvedValueOnce({ outcome: 'not_dispatched', saveDispatched: 'unknown' } as any);
    expect((await contradictory.lock.withLock(() => createFilingRunner(contradictory.deps).run({ grantRef: 'grant-1' }))).outcome).toBe('uncertain');
  });

  it('runs a claimed grant at most once through one runner instance', async () => {
    const f = await fixture(), runner = createFilingRunner(f.deps);
    await f.lock.withLock(async () => {
      await runner.run({ grantRef: 'grant-1' });
      expect((await runner.run({ grantRef: 'grant-1' })).reason).toBe('filing_run_already_invoked');
    });
    expect(f.consume).toHaveBeenCalledOnce();
  });
});
