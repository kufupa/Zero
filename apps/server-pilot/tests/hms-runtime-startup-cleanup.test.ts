import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createProductionHmsRuntime, resolveHmsSourceRevision } = vi.hoisted(() => ({
  createProductionHmsRuntime: vi.fn(),
  resolveHmsSourceRevision: vi.fn(() => 'runtime-cleanup-test-source'),
}));

vi.mock('../src/hms/production-runtime.js', () => ({
  createProductionHmsRuntime,
  resolveHmsSourceRevision,
}));

const ENV = {
  HMS_HEALTH_STATUS_PATH: '/tmp/hms-runtime-cleanup-test-health.json',
  HMS_EXPECTED_PROPERTY_CODE: 'HRCEN',
  HMS_EXPECTED_TENANT: 'runtime-cleanup-test-tenant',
  HMS_EXPECTED_TRANSPORT_ID: 'runtime-cleanup-test-transport',
  HMS_READ_SECRET_ARN: 'runtime-cleanup-test-secret',
  HMS_CHROMIUM_EXECUTABLE_PATH: '/bin/false',
  HMS_READ_ROLE_PROOF_PATH: '/tmp/runtime-cleanup-test-role-proof.json',
  HMS_ACTIVE_REGISTRY_PATH: '/tmp/runtime-cleanup-test-missing-registry.json',
  HMS_EVIDENCE_HMAC_SECRET_ARN: 'runtime-cleanup-test-evidence-secret',
  HMS_EVIDENCE_HMAC_KEY_VERSION: 'runtime-cleanup-test-v1',
  HMS_EVIDENCE_HMAC_KEY: Buffer.alloc(32, 7).toString('base64'),
  HMS_RUN_DEADLINE_MS: '1000',
};

const ENV_KEYS = Object.keys(ENV) as Array<keyof typeof ENV>;
type WorkerModule = typeof import('../src/ai/worker.js');

let worker: WorkerModule;
let previousEnv: Partial<Record<keyof typeof ENV, string | undefined>>;

async function waitForStart(start: ReturnType<typeof vi.fn>): Promise<void> {
  // Module loading can outlast 100 immediate turns when test files run together.
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1), { timeout: 2_000 });
}

beforeEach(async () => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, ENV);
  worker = await import('../src/ai/worker.js');
  await worker.closeProductionHmsRuntimeForTests();
  createProductionHmsRuntime.mockReset();
  resolveHmsSourceRevision.mockReset().mockReturnValue('runtime-cleanup-test-source');
});

afterEach(async () => {
  await worker.closeProductionHmsRuntimeForTests();
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('synchronous HMS runtime startup cleanup', () => {
  it.each([
    ['late startup success', 'resolve'],
    ['late startup rejection', 'reject'],
  ] as const)('closes a runtime again after %s assigns its browser', async (_label, outcome) => {
    let browserAssigned = false;
    const closeSnapshots: boolean[] = [];
    let releaseStartup!: () => void;
    const startupReleased = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const runtime = {
      start: vi.fn(async () => {
        await startupReleased;
        browserAssigned = true;
        if (outcome === 'reject') throw new Error('late startup failure');
      }),
      close: vi.fn(async () => {
        closeSnapshots.push(browserAssigned);
      }),
    } as unknown as import('../src/hms/runtime.js').HmsRuntime;
    createProductionHmsRuntime.mockResolvedValue(runtime);

    const controller = new AbortController();
    const pending = worker.__getOrCreateProductionHmsRuntimeForTests(
      controller.signal,
      new Date(Date.now() + 5_000),
    );
    await waitForStart(runtime.start as unknown as ReturnType<typeof vi.fn>);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'READ_ABORTED' });
    expect(closeSnapshots).toEqual([false]);

    releaseStartup();
    await vi.waitFor(() => expect(closeSnapshots).toEqual([false, true]), { timeout: 2_000 });
  });

  it('does not close the shared singleton returned to a normal user after cancellation', async () => {
    const sharedClose = vi.fn(async () => undefined);
    const shared = {
      start: vi.fn(async () => undefined),
      close: sharedClose,
    } as unknown as import('../src/hms/runtime.js').HmsRuntime;
    createProductionHmsRuntime.mockResolvedValue(shared);

    const normalUser = await worker.__getOrCreateProductionHmsRuntimeForTests();
    const controller = new AbortController();
    const cancelledUser = worker.__getOrCreateProductionHmsRuntimeForTests(
      controller.signal,
      new Date(Date.now() + 5_000),
    );
    controller.abort();

    expect(normalUser).toBe(shared);
    await expect(cancelledUser).resolves.toBe(shared);
    expect(shared.start).toHaveBeenCalledTimes(1);
    expect(sharedClose).not.toHaveBeenCalled();
  });
});
