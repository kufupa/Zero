import { paneStayLookupLoaders } from '../src/ai/pane-stay-lookup.js';
import { paneStaySaveLoaders, paneStayTenantId, type PaneStayLock } from '../src/ai/pane-stay-save.js';
import { paneStayCancelLoaders, paneCancelDigest } from '../src/ai/pane-stay-cancel.js';
import { paneHmsWriteLoaders } from '../src/ai/pane-hms-write.js';
import { propertyReadLockKey } from '../src/hms/property-read-lock.js';
import { hmsProofRun, parseProofRunArgs, stayFromProofRequest } from '../src/ops/hms-proof-run.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LAB = {
  lastName: 'Labtest',
  firstName: 'Proof',
  arrival: '2027-03-10',
  confirmation: '1234567-1',
};

const WRITE_LAB: NodeJS.Dict<string> = {
  PANE_WRITE_CREATE: 'lab',
  PANE_WRITE_AMEND_UNPAID: 'lab',
  PANE_WRITE_AMEND_PAID: 'lab',
  PANE_WRITE_CANCEL_UNPAID: 'lab',
  PANE_WRITE_CANCEL_PAID: 'lab',
  RESERVATIONIST_PANE_SAVE: 'lab',
  HMS_EXPECTED_TENANT: 'centurion',
  DATABASE_URL: 'postgres://proof-lock/unused',
};

const HELD: PaneStayLock = { withLock: (fn) => fn() };

function argv(
  command: string,
  request: Record<string, unknown>,
  extra: { transport?: string; mode?: string; out?: string } = {},
): string[] {
  return [
    command,
    '--transport',
    extra.transport ?? 'transport-centurion',
    '--request',
    JSON.stringify(request),
    '--mode',
    extra.mode ?? 'preview',
    '--out',
    extra.out ?? '/tmp/hms-proof-run-out',
  ];
}

function createLockSpy() {
  const calls: Array<{ tenantId: string; propertyCode: string }> = [];
  const createLock = vi.fn(
    (input: { tenantId: string; propertyCode: string; databaseUrl: string }) => {
      calls.push({ tenantId: input.tenantId, propertyCode: input.propertyCode });
      return {
        key: propertyReadLockKey(input.tenantId, input.propertyCode),
        withLock: HELD.withLock,
      };
    },
  );
  return { calls, createLock };
}

afterEach(() => {
  paneStayLookupLoaders.spawn = null;
  paneStayLookupLoaders.lock = null;
  paneStayLookupLoaders.enabled = null;
  paneStaySaveLoaders.spawn = null;
  paneStaySaveLoaders.lock = null;
  paneStayCancelLoaders.spawn = null;
  paneStayCancelLoaders.lock = null;
  paneStayCancelLoaders.mode = null;
  paneHmsWriteLoaders.spawnAmend = null;
  paneHmsWriteLoaders.spawnAttach = null;
  paneHmsWriteLoaders.lock = null;
  vi.unstubAllEnvs();
});

describe('hms-proof-run args', () => {
  it('parses each subcommand with transport, request JSON, mode and out', () => {
    expect(parseProofRunArgs(argv('find', LAB))).toEqual({
      command: 'find',
      transportId: 'transport-centurion',
      request: LAB,
      mode: 'preview',
      outDir: '/tmp/hms-proof-run-out',
    });
    expect(parseProofRunArgs(argv('cancel', LAB, { mode: 'commit' })).mode).toBe('commit');
  });

  it('refuses unknown commands and missing or repeated flags', () => {
    expect(() => parseProofRunArgs([])).toThrow('usage');
    expect(() => parseProofRunArgs(['quote'])).toThrow('usage');
    expect(() => parseProofRunArgs(argv('find', LAB).slice(0, -2))).toThrow('required: --out');
    expect(() => parseProofRunArgs([...argv('find', LAB), '--out', '/x'])).toThrow(
      'repeated argument: --out',
    );
    expect(() => parseProofRunArgs(argv('find', LAB, { mode: 'apply' }))).toThrow('--mode');
    expect(() => parseProofRunArgs(argv('find', LAB).concat(['--thread', 't']))).toThrow(
      'unknown argument: --thread',
    );
  });
});

describe('hms-proof-run refusals', () => {
  it('refuses a non-Labtest request before any lock or spawn', async () => {
    const { createLock } = createLockSpy();
    const spawn = vi.fn();
    paneStayLookupLoaders.spawn = spawn;
    paneStaySaveLoaders.spawn = spawn;
    paneStayCancelLoaders.spawn = spawn;
    await expect(
      hmsProofRun(parseProofRunArgs(argv('find', { ...LAB, lastName: 'X' })), WRITE_LAB, createLock),
    ).rejects.toThrow(/refused_not_lab$/);
    expect(createLock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses an unknown transport before any lock or spawn', async () => {
    const { createLock } = createLockSpy();
    const spawn = vi.fn();
    paneStayLookupLoaders.spawn = spawn;
    await expect(
      hmsProofRun(
        parseProofRunArgs(argv('find', LAB, { transport: 'transport-unknown' })),
        WRITE_LAB,
        createLock,
      ),
    ).rejects.toThrow(/unknown_transport/);
    expect(createLock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a DV transport takes the HRDAV lock key', async () => {
    const { calls, createLock } = createLockSpy();
    paneStayLookupLoaders.spawn = vi.fn(async () => ({
      outcome: 'found',
      reason: null,
      stay: {
        status: 'Reserved',
        confirmation: LAB.confirmation,
        lastName: LAB.lastName,
        firstName: LAB.firstName,
        arrival: LAB.arrival,
        departure: '2027-03-12',
        nights: 2,
        adults: 1,
        children: 0,
        roomType: 'DBL',
        ratePlan: 'BAR',
        mealPlan: 'BB',
        averageRate: '1000.00',
        grandTotal: '2000.00',
        balance: '2000.00',
        sourceOfBusiness: null,
        guaranteeType: null,
        bookingAgency: null,
        organization: null,
      },
      rows: [],
      screenshots: [],
      runId: '00000000-0000-4000-8000-000000000001',
    }));
    const outDir = await mkdtemp(join(tmpdir(), 'hms-proof-dv-'));
    try {
      const line = await hmsProofRun(
        parseProofRunArgs(argv('find', LAB, { transport: 'transport-davinci', out: outDir })),
        WRITE_LAB,
        createLock,
      );
      expect(calls).toEqual([
        { tenantId: paneStayTenantId(WRITE_LAB), propertyCode: 'HRDAV' },
      ]);
      expect(line).toMatchObject({
        command: 'find',
        propertyCode: 'HRDAV',
        lockKey: propertyReadLockKey(paneStayTenantId(WRITE_LAB), 'HRDAV'),
        outcome: 'found',
      });
      expect(JSON.stringify(line)).not.toMatch(/Labtest|Proof/);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('cancel stays lab when create is on', async () => {
    const { createLock } = createLockSpy();
    const spawn = vi.fn(async () => ({
      outcome: 'previewed',
      clickedOk: false,
      screenshots: [],
    }));
    paneStayCancelLoaders.spawn = spawn;
    paneStayCancelLoaders.mode = () => 'lab';
    const outDir = await mkdtemp(join(tmpdir(), 'hms-proof-create-on-'));
    try {
      const line = await hmsProofRun(
        parseProofRunArgs(argv('cancel', LAB, { out: outDir })),
        { ...WRITE_LAB, PANE_WRITE_CREATE: 'on' },
        createLock,
      );
      expect(line).toMatchObject({ command: 'cancel', propertyCode: 'HRCEN' });
      expect(spawn).toHaveBeenCalled();
    } finally {
      paneStayCancelLoaders.mode = null;
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('create with PANE_WRITE_CREATE=on allows a Labtest request', async () => {
    const { createLock } = createLockSpy();
    const spawn = vi.fn(async () => ({
      outcome: 'previewed',
      clickedSave: false,
      screenshots: [],
      previewDigest: 'a'.repeat(64),
    }));
    paneStaySaveLoaders.spawn = spawn;
    const outDir = await mkdtemp(join(tmpdir(), 'hms-proof-create-on-lab-'));
    try {
      const line = await hmsProofRun(
        parseProofRunArgs(argv('create', LAB, { out: outDir })),
        { ...WRITE_LAB, PANE_WRITE_CREATE: 'on' },
        createLock,
      );
      expect(line).toMatchObject({ command: 'create', outcome: 'previewed' });
      expect(spawn).toHaveBeenCalled();
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('create with PANE_WRITE_CREATE=on still refuses a non-Labtest request', async () => {
    const { createLock } = createLockSpy();
    const spawn = vi.fn();
    paneStaySaveLoaders.spawn = spawn;
    await expect(
      hmsProofRun(
        parseProofRunArgs(argv('create', { ...LAB, lastName: 'Smith' })),
        { ...WRITE_LAB, PANE_WRITE_CREATE: 'on' },
        createLock,
      ),
    ).rejects.toThrow(/refused_not_lab$/);
    expect(createLock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses commit without a preview digest before any lock or spawn', async () => {
    const { createLock } = createLockSpy();
    const spawn = vi.fn();
    paneStayCancelLoaders.spawn = spawn;
    paneStaySaveLoaders.spawn = spawn;
    paneHmsWriteLoaders.spawnAmend = spawn;
    await expect(
      hmsProofRun(
        parseProofRunArgs(argv('cancel', { ...LAB, reason: 'Guest request' }, { mode: 'commit' })),
        WRITE_LAB,
        createLock,
      ),
    ).rejects.toThrow(/preview_digest_required$/);
    expect(createLock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses attach when the attach save gate is not lab', async () => {
    const { createLock } = createLockSpy();
    const spawn = vi.fn();
    paneHmsWriteLoaders.spawnAttach = spawn;
    await expect(
      hmsProofRun(
        parseProofRunArgs(
          argv(
            'attach',
            { ...LAB, file: '/tmp/lab.pdf', documentName: 'lab.pdf' },
            { mode: 'commit' },
          ),
        ),
        { ...WRITE_LAB, RESERVATIONIST_PANE_SAVE: 'off' },
        createLock,
      ),
    ).rejects.toThrow(/refused_write_not_lab$/);
    expect(createLock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses attach preview before any lock or spawn', async () => {
    const { createLock } = createLockSpy();
    const spawn = vi.fn();
    paneHmsWriteLoaders.spawnAttach = spawn;
    await expect(
      hmsProofRun(
        parseProofRunArgs(
          argv('attach', { ...LAB, file: '/tmp/lab.pdf', documentName: 'lab.pdf' }),
        ),
        WRITE_LAB,
        createLock,
      ),
    ).rejects.toThrow(/attach_preview_unsupported$/);
    expect(createLock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('consumes an expired preview grant and refuses commit before spawn', async () => {
    const { createLock } = createLockSpy();
    const spawn = vi.fn();
    paneStayCancelLoaders.spawn = spawn;
    paneStayCancelLoaders.mode = () => 'lab';
    const outDir = await mkdtemp(join(tmpdir(), 'hms-proof-grant-'));
    const digest = paneCancelDigest({ confirmation: LAB.confirmation, arrival: LAB.arrival });
    await writeFile(
      join(outDir, 'preview-grant.json'),
      `${JSON.stringify({
        owner: 'proof:transport-centurion',
        digest,
        expiresAt: Date.now() - 1,
      })}\n`,
    );
    try {
      const line = await hmsProofRun(
        parseProofRunArgs(
          argv('cancel', { ...LAB, reason: 'lab', previewDigest: digest }, { mode: 'commit', out: outDir }),
        ),
        WRITE_LAB,
        createLock,
      );
      expect(line).toMatchObject({ outcome: 'cancel_preview_required' });
      expect(spawn).not.toHaveBeenCalled();
      expect(existsSync(join(outDir, 'preview-grant.json'))).toBe(false);
    } finally {
      paneStayCancelLoaders.mode = null;
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('create stay omits CLI-only fields so the preview digest still matches', () => {
    const stay = stayFromProofRequest({
      ...LAB,
      adults: 1,
      sourceOfBusiness: 'Email',
      roomType: 'STQN',
      ratePlan: 'BAR',
      track: 'Walk in',
      guaranteeType: 'Non-Guaranteed Individual',
      previewDigest: 'a'.repeat(64),
      confirmation: LAB.confirmation,
    });
    expect(stay).not.toHaveProperty('previewDigest');
    expect(stay).not.toHaveProperty('confirmation');
    expect(stay.lastName).toBe('Labtest');
    expect(stay.arrival).toBe('2027-03-10');
  });
});
