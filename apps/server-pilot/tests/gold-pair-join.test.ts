import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SYNTHETIC_GOLD_PAIR_IN,
  joinGoldPairOps,
  parseGoldPairJoinCli,
  runGoldPairJoin,
  staffMoveToOperations,
  type ClaimedOpsRow,
  type GoldOperation,
  type PredictedOpsRow,
  type StaffMoveLabel,
} from '../src/ai/gold-pair-join.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temps = new Set<string>();

afterEach(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
  temps.clear();
});

function op(operation: string, fields: string[] = []): GoldOperation {
  return {
    operation,
    needLevel: 'required',
    requiredFields: fields,
    candidateTool: null,
    unknownReason: null,
  };
}

function label(overrides: Partial<StaffMoveLabel> & Pick<StaffMoveLabel, 'staff_move'>): StaffMoveLabel {
  return {
    messageId: 'msg-1',
    threadId: 'thread-1',
    targetKey: 'normal:msg-1',
    ...overrides,
  };
}

describe('staffMoveToOperations', () => {
  it('maps visible staff_move onto same-move GoldOperation strings', () => {
    expect(staffMoveToOperations('booked_confirmed').map((row) => row.operation)).toEqual(['create']);
    expect(staffMoveToOperations('cancel_done').map((row) => row.operation)).toEqual(['cancel']);
    expect(staffMoveToOperations('amend_done').map((row) => row.operation)).toEqual(['amend']);
    expect(staffMoveToOperations('priced_quote').map((row) => row.operation)).toEqual(['quote']);
    expect(staffMoveToOperations('payment_ack').map((row) => row.operation)).toEqual(['post_payment']);
  });

  it('uses hms_work_implied when staff_move has no visible mail action', () => {
    expect(
      staffMoveToOperations('no_visible_action', ['create', 'none']).map((row) => row.operation),
    ).toEqual(['create']);
    expect(staffMoveToOperations('no_visible_action', ['none']).map((row) => row.operation)).toEqual([
      'none',
    ]);
  });
});

describe('joinGoldPairOps', () => {
  it('joins labelled staff_move to Promptfoo ops JSON by message id', () => {
    const predicted: PredictedOpsRow[] = [
      { messageId: 'msg-1', operations: [op('create', ['arrival'])] },
    ];
    const rows = joinGoldPairOps({
      labels: [label({ staff_move: 'booked_confirmed' })],
      predicted,
    });
    expect(rows).toEqual([
      {
        id: 'msg-1',
        expectPass: true,
        predicted: [op('create', ['arrival'])],
        claimed: [expect.objectContaining({ operation: 'create' })],
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/textBody|htmlBody|"from"|"to"|subject/);
  });

  it('prefers claimed_action ops joined by targetKey over staff_move mapping', () => {
    const claimed: ClaimedOpsRow[] = [
      {
        targetKey: 'normal:msg-1',
        operations: [op('amend', ['departure'])],
      },
    ];
    const rows = joinGoldPairOps({
      labels: [label({ staff_move: 'booked_confirmed', targetKey: 'normal:msg-1' })],
      claimed,
    });
    expect(rows[0]?.id).toBe('msg-1');
    expect(rows[0]?.claimed).toEqual([op('amend', ['departure'])]);
    expect(rows[0]?.expectPass).toBe(false);
  });

  it('falls back to unique threadId when messageId and targetKey miss', () => {
    const claimed: ClaimedOpsRow[] = [
      { threadId: 'thread-only', operations: [op('cancel')] },
    ];
    const rows = joinGoldPairOps({
      labels: [
        label({
          messageId: 'msg-thread',
          threadId: 'thread-only',
          targetKey: undefined,
          staff_move: 'booked_confirmed',
        }),
      ],
      claimed,
    });
    expect(rows[0]?.claimed).toEqual([op('cancel')]);
  });

  it('does not join via threadId when that thread has two claimed rows', () => {
    const claimed: ClaimedOpsRow[] = [
      { threadId: 'shared', operations: [op('create')] },
      { threadId: 'shared', operations: [op('cancel')] },
    ];
    const rows = joinGoldPairOps({
      labels: [
        label({
          messageId: 'msg-shared',
          threadId: 'shared',
          targetKey: undefined,
          staff_move: 'booked_confirmed',
        }),
      ],
      claimed,
    });
    expect(rows[0]?.claimed.map((row) => row.operation)).toEqual(['create']);
  });

  it('sets expectPass false when predicted create disagrees with claimed cancel', () => {
    const rows = joinGoldPairOps({
      labels: [label({ staff_move: 'cancel_done' })],
      predicted: [{ messageId: 'msg-1', operations: [op('create')] }],
    });
    expect(rows[0]?.expectPass).toBe(false);
    expect(rows[0]?.claimed[0]?.operation).toBe('cancel');
    expect(rows[0]?.predicted[0]?.operation).toBe('create');
  });

  it('throws when a join input carries mail fields', () => {
    expect(() =>
      joinGoldPairOps({
        labels: [
          {
            ...label({ staff_move: 'booked_confirmed' }),
            textBody: 'do not copy',
          } as StaffMoveLabel,
        ],
      }),
    ).toThrow(/textBody/);
  });

  it('accepts G-label snake_case message_id without copying free-text fields', () => {
    const rows = joinGoldPairOps({
      labels: [
        {
          message_id: 'g-label-1',
          thread_id: 'g-thread',
          staff_move: 'priced_quote',
          hms_work_implied: ['rates_read'],
        },
      ],
    });
    expect(rows[0]?.id).toBe('g-label-1');
    expect(rows[0]?.claimed[0]?.operation).toBe('quote');
    expect(JSON.stringify(rows[0])).not.toMatch(/nava_should|move_detail|evidence|textBody/);
  });
});

describe('gold-pair join CLI', () => {
  it('defaults --in to the in-repo synthetic fixture (no RDS)', () => {
    const args = parseGoldPairJoinCli([], SERVER_ROOT);
    expect(args.inPath).toBe(path.join(SERVER_ROOT, DEFAULT_SYNTHETIC_GOLD_PAIR_IN));
    expect(args.inPath.includes('.private')).toBe(false);
    expect(args.privateInPath).toBeNull();
  });

  it('reads the synthetic fixture and writes ops JSONL with no mail fields', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gold-pair-join-'));
    temps.add(dir);
    const outPath = path.join(dir, 'joined-ops.jsonl');
    const result = await runGoldPairJoin({
      inPath: path.join(SERVER_ROOT, DEFAULT_SYNTHETIC_GOLD_PAIR_IN),
      outPath,
    });
    expect(result.written).toBeGreaterThan(0);
    const text = await readFile(outPath, 'utf8');
    expect(text).not.toMatch(/textBody|htmlBody|"from"|"to"|subject/);
    const rows = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: string; expectPass: boolean });
    expect(rows.some((row) => row.id === 'msg-book-1' && row.expectPass === true)).toBe(true);
    expect(rows.some((row) => row.id === 'msg-cancel-1' && row.expectPass === false)).toBe(true);
  });

  it('accepts --private-in for a later .private/ ops file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gold-pair-private-'));
    temps.add(dir);
    const privateDir = path.join(dir, '.private');
    await mkdir(privateDir);
    const privateIn = path.join(privateDir, 'labels.json');
    await writeFile(
      privateIn,
      JSON.stringify({
        labels: [{ messageId: 'priv-1', staff_move: 'amend_done' }],
      }),
    );
    const outPath = path.join(dir, 'out.jsonl');
    const args = parseGoldPairJoinCli(['--private-in', privateIn, '--out', outPath], SERVER_ROOT);
    expect(args.inPath).toBe(privateIn);
    const result = await runGoldPairJoin(args);
    expect(result.written).toBe(1);
    const line = JSON.parse(await readFile(outPath, 'utf8'));
    expect(line.id).toBe('priv-1');
    expect(line.claimed[0].operation).toBe('amend');
  });
});
