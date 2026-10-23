import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LAB_ARRIVAL_FLOOR,
  PROOF_RUN_REL,
  buildProofCancelCall,
  formatCleanupStdout,
  maskConfirmation,
  parseLabtestCleanupArgs,
  runLabtestCleanup,
  runLabtestCleanupCli,
  selectCleanupStays,
  type InventoryStay,
  type ProofCancelCall,
} from '../scripts/labtest-cleanup.js';

const DIGEST = 'a'.repeat(64);

function stay(overrides: Partial<InventoryStay> = {}): InventoryStay {
  return {
    propertyCode: 'HRCEN',
    confirmation: '10000001-1',
    lastName: 'Labtest',
    firstName: 'Proof',
    arrival: '2027-03-10',
    status: 'Reserved',
    ...overrides,
  };
}

function collectCalls() {
  const calls: ProofCancelCall[] = [];
  const cancel = async (call: ProofCancelCall) => {
    calls.push(call);
    if (call.mode === 'preview') return { previewDigest: DIGEST, outcome: 'previewed' };
    return { outcome: 'committed' };
  };
  return { calls, cancel };
}

describe('labtest cleanup args', () => {
  it('is dry-run unless --apply, and requires --in', () => {
    expect(parseLabtestCleanupArgs(['--in', 'stays.json'])).toEqual({
      inPath: 'stays.json',
      apply: false,
    });
    expect(parseLabtestCleanupArgs(['--in', 'stays.json', '--apply', '--property', 'HRDAV'])).toEqual({
      inPath: 'stays.json',
      apply: true,
      property: 'HRDAV',
    });
    expect(() => parseLabtestCleanupArgs([])).toThrow('usage');
    expect(() => parseLabtestCleanupArgs(['--apply'])).toThrow('usage');
    expect(() => parseLabtestCleanupArgs(['--in', 'stays.json', '--property', 'HMSX'])).toThrow(
      'unknown_property',
    );
    expect(() => parseLabtestCleanupArgs(['--in', 'postgres://example/db'])).toThrow('local_paths_only');
  });
});

describe('labtest cleanup select', () => {
  it('lists Reserved Labtest stays on or after the arrival floor, per hotel', () => {
    const rows = selectCleanupStays([
      stay(),
      stay({
        propertyCode: 'HRDAV',
        confirmation: '10000002-1',
        arrival: LAB_ARRIVAL_FLOOR,
      }),
      stay({ confirmation: '10000003-1', lastName: 'Smith' }),
      stay({ confirmation: '10000004-1', arrival: '2026-12-31' }),
      stay({ confirmation: '10000005-1', status: 'Cancelled' }),
      stay({ confirmation: '10000006-1', status: 'reserved' }),
    ]);
    expect(rows.filter((row) => row.action === 'would_cancel').map((row) => row.confirmation)).toEqual([
      '****0001-1',
      '****0002-1',
      '****0006-1',
    ]);
    expect(rows.find((row) => row.confirmation === '****0003-1')?.reason).toBe('not_lab');
    expect(rows.find((row) => row.confirmation === '****0004-1')?.reason).toBe('arrival_before_floor');
    expect(rows.find((row) => row.confirmation === '****0005-1')?.reason).toBe('not_reserved');
  });

  it('limits listing to --property', () => {
    const rows = selectCleanupStays(
      [stay(), stay({ propertyCode: 'HRDAV', confirmation: '10000002-1' })],
      'HRCEN',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.propertyCode).toBe('HRCEN');
  });
});

describe('labtest cleanup run', () => {
  it('dry-run lists eligible stays and never cancels', async () => {
    const { calls, cancel } = collectCalls();
    const result = await runLabtestCleanup([stay(), stay({ confirmation: '10000003-1', lastName: 'Smith' })], {
      cancel,
    });
    expect(result.mode).toBe('dry-run');
    expect(result.byHotel.HRCEN).toEqual({ listed: 1, skipped: 1, cancelled: 0 });
    expect(result.stays[0]).toMatchObject({
      propertyCode: 'HRCEN',
      confirmation: '****0001-1',
      arrival: '2027-03-10',
      status: 'Reserved',
      action: 'would_cancel',
    });
    expect(calls).toEqual([]);
  });

  it('apply cancels via hms-proof-run preview then commit, never cancel-stay.mjs', async () => {
    const { calls, cancel } = collectCalls();
    const result = await runLabtestCleanup(
      [
        stay(),
        stay({ propertyCode: 'HRDAV', confirmation: '10000002-1' }),
        stay({ confirmation: '10000003-1', lastName: 'Smith' }),
      ],
      { apply: true, cancel, workDir: '/tmp/labtest-cleanup-work' },
    );
    expect(result.mode).toBe('apply');
    expect(result.byHotel.HRCEN).toEqual({ listed: 1, skipped: 1, cancelled: 1 });
    expect(result.byHotel.HRDAV).toEqual({ listed: 1, skipped: 0, cancelled: 1 });
    expect(result.stays.filter((row) => row.action === 'cancelled')).toHaveLength(2);
    expect(calls.map((call) => [call.tool, call.command, call.mode, call.transportId])).toEqual([
      [PROOF_RUN_REL, 'cancel', 'preview', 'transport-centurion'],
      [PROOF_RUN_REL, 'cancel', 'commit', 'transport-centurion'],
      [PROOF_RUN_REL, 'cancel', 'preview', 'transport-davinci'],
      [PROOF_RUN_REL, 'cancel', 'commit', 'transport-davinci'],
    ]);
    expect(calls[1]?.request.previewDigest).toBe(DIGEST);
    expect(JSON.stringify(calls)).not.toMatch(/cancel-stay/);
  });

  it('does not commit when preview has no digest', async () => {
    const calls: ProofCancelCall[] = [];
    const result = await runLabtestCleanup([stay()], {
      apply: true,
      cancel: async (call) => {
        calls.push(call);
        return { outcome: 'previewed' };
      },
    });
    expect(calls.map((call) => call.mode)).toEqual(['preview']);
    expect(result.stays[0]?.action).toBe('skipped');
    expect(result.stays[0]?.reason).toBe('preview_digest_missing');
    expect(result.byHotel.HRCEN.cancelled).toBe(0);
  });
});

describe('labtest cleanup masking', () => {
  it('masks confs in stdout and never prints last names', async () => {
    expect(maskConfirmation('10000001-1')).toBe('****0001-1');
    const result = await runLabtestCleanup([stay({ lastName: 'Labtest', firstName: 'Proof' })]);
    const stdout = formatCleanupStdout(result);
    expect(stdout).toContain('****0001-1');
    expect(stdout).not.toContain('10000001-1');
    expect(stdout).not.toMatch(/Labtest|Proof/i);
  });

  it('proof cancel argv targets hms-proof-run cancel only', () => {
    const call = buildProofCancelCall(stay(), 'preview', { workDir: '/tmp/x', previewDigest: DIGEST });
    expect(call.tool).toBe('src/ops/hms-proof-run.ts');
    expect(call.command).toBe('cancel');
    expect(call.argv[0]).toBe('cancel');
    expect(call.argv.join(' ')).not.toMatch(/cancel-stay/);
  });
});

describe('labtest cleanup cli', () => {
  it('reads inventory and writes a masked report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'labtest-cleanup-'));
    try {
      const inPath = join(dir, 'stays.json');
      const outPath = join(dir, 'report.json');
      writeFileSync(inPath, JSON.stringify({ stays: [stay(), stay({ confirmation: '10000003-1', lastName: 'Smith' })] }));
      expect(await runLabtestCleanupCli(['--in', inPath, '--out', outPath])).toBe(0);
      const report = JSON.parse(readFileSync(outPath, 'utf8')) as { stays: Array<{ confirmation: string }> };
      expect(report.stays.map((row) => row.confirmation)).toEqual(['****0001-1', '****0003-1']);
      expect(readFileSync(outPath, 'utf8')).not.toContain('10000001-1');
      const { calls, cancel } = collectCalls();
      expect(
        await runLabtestCleanupCli(['--in', inPath, '--apply', '--out', join(dir, 'applied.json')], {
          cancel,
        }),
      ).toBe(0);
      expect(calls.map((call) => call.mode)).toEqual(['preview', 'commit']);
      expect(calls[0]?.tool).toBe(PROOF_RUN_REL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
