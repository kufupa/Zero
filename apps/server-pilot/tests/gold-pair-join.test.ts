import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SYNTHETIC_GOLD_PAIR_IN,
  joinGoldPairOps,
  parseGoldPairFixture,
  parseGoldPairJoinCli,
  predictedActionToOperations,
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

  it('maps party_lookup implied work to read and ignores the none token', () => {
    expect(
      staffMoveToOperations('no_visible_action', ['party_lookup']).map((row) => row.operation),
    ).toEqual(['read']);
    expect(
      staffMoveToOperations('silent_hms_work', ['party_lookup']).map((row) => row.operation),
    ).toEqual(['read']);
    expect(
      staffMoveToOperations('silent_hms_work', ['none', 'party_lookup']).map((row) => row.operation),
    ).toEqual(['read']);
    expect(staffMoveToOperations('silent_hms_work', ['none']).map((row) => row.operation)).toEqual([
      'none',
    ]);
    expect(staffMoveToOperations('no_visible_action', []).map((row) => row.operation)).toEqual([
      'none',
    ]);
  });
});

describe('predictedActionToOperations', () => {
  it('maps R3 actions onto same-move GoldOperation strings', () => {
    expect(predictedActionToOperations('new_booking').map((row) => row.operation)).toEqual(['create']);
    expect(predictedActionToOperations('quote_availability').map((row) => row.operation)).toEqual([
      'quote',
    ]);
    expect(predictedActionToOperations('cancel').map((row) => row.operation)).toEqual(['cancel']);
    expect(predictedActionToOperations('amend').map((row) => row.operation)).toEqual(['amend']);
    expect(predictedActionToOperations('payment_proof').map((row) => row.operation)).toEqual([
      'post_payment',
    ]);
    expect(predictedActionToOperations('billing').map((row) => row.operation)).toEqual(['unknown']);
    expect(predictedActionToOperations('billing')[0]?.unknownReason).toBe('billing');
    expect(predictedActionToOperations('no_action').map((row) => row.operation)).toEqual(['none']);
    expect(predictedActionToOperations('group_event').map((row) => row.operation)).toEqual(['unknown']);
    expect(predictedActionToOperations('other_actionable').map((row) => row.operation)).toEqual([
      'unknown',
    ]);
  });

  it('maps unknown action to unknown and does not throw', () => {
    expect(() => predictedActionToOperations('not_a_real_r3_action')).not.toThrow();
    expect(predictedActionToOperations('not_a_real_r3_action').map((row) => row.operation)).toEqual([
      'unknown',
    ]);
  });
});

describe('parseGoldPairFixture', () => {
  it('parses two-line JSONL objects as join input', () => {
    const raw = [
      JSON.stringify({ messageId: 'jsonl-a', staff_move: 'booked_confirmed' }),
      JSON.stringify({ messageId: 'jsonl-b', staff_move: 'cancel_done' }),
    ].join('\n');
    const parsed = parseGoldPairFixture(raw);
    expect(parsed.labels.map((row) => row.messageId)).toEqual(['jsonl-a', 'jsonl-b']);
    const rows = joinGoldPairOps(parsed);
    expect(rows.map((row) => ({ id: row.id, op: row.claimed[0]?.operation }))).toEqual([
      { id: 'jsonl-a', op: 'create' },
      { id: 'jsonl-b', op: 'cancel' },
    ]);
  });

  it('maps JSONL kind=predicted R3 actions onto GoldOperation and joins by messageId', () => {
    const raw = [
      JSON.stringify({ messageId: 'pred-book', staff_move: 'booked_confirmed' }),
      JSON.stringify({
        kind: 'predicted',
        messageId: 'pred-book',
        action: 'new_booking',
        needsAction: true,
      }),
      JSON.stringify({ messageId: 'pred-quote', staff_move: 'priced_quote' }),
      JSON.stringify({
        kind: 'predicted',
        messageId: 'pred-quote',
        action: 'quote_availability',
        needsAction: true,
      }),
      JSON.stringify({ messageId: 'pred-cancel', staff_move: 'cancel_done' }),
      JSON.stringify({ kind: 'predicted', messageId: 'pred-cancel', action: 'cancel' }),
      JSON.stringify({ messageId: 'pred-amend', staff_move: 'amend_done' }),
      JSON.stringify({ kind: 'predicted', messageId: 'pred-amend', action: 'amend' }),
      JSON.stringify({ messageId: 'pred-pay', staff_move: 'payment_ack' }),
      JSON.stringify({ kind: 'predicted', messageId: 'pred-pay', action: 'payment_proof' }),
      JSON.stringify({ messageId: 'pred-bill', staff_move: 'payment_ack' }),
      JSON.stringify({ kind: 'predicted', messageId: 'pred-bill', action: 'billing' }),
      JSON.stringify({ messageId: 'pred-none', staff_move: 'acknowledge_only' }),
      JSON.stringify({ kind: 'predicted', messageId: 'pred-none', action: 'no_action' }),
      JSON.stringify({ messageId: 'pred-unk', staff_move: 'ask_clarify' }),
      JSON.stringify({ kind: 'predicted', messageId: 'pred-unk', action: 'weird_r3' }),
    ].join('\n');
    const rows = joinGoldPairOps(parseGoldPairFixture(raw));
    const byId = Object.fromEntries(rows.map((row) => [row.id, row.predicted[0]?.operation]));
    expect(byId).toEqual({
      'pred-book': 'create',
      'pred-quote': 'quote',
      'pred-cancel': 'cancel',
      'pred-amend': 'amend',
      'pred-pay': 'post_payment',
      'pred-bill': 'unknown',
      'pred-none': 'none',
      'pred-unk': 'unknown',
    });
    expect(rows.find((row) => row.id === 'pred-book')?.expectPass).toBe(true);
    expect(rows.find((row) => row.id === 'pred-none')?.expectPass).toBe(true);
  });

  it('keeps already-parsed kind=predicted GoldOperation rows and ignores nava_should prose', () => {
    const raw = [
      JSON.stringify({
        messageId: 'pred-ops',
        staff_move: 'booked_confirmed',
        nava_should: 'please create a booking for the guest in June',
      }),
      JSON.stringify({
        kind: 'predicted',
        messageId: 'pred-ops',
        operations: [op('create', ['arrival'])],
        action: 'quote_availability',
      }),
    ].join('\n');
    const parsed = parseGoldPairFixture(raw);
    expect(parsed.predicted?.[0]?.operations.map((row) => row.operation)).toEqual(['create']);
    const rows = joinGoldPairOps(parsed);
    expect(rows[0]?.predicted).toEqual([op('create', ['arrival'])]);
    expect(JSON.stringify(rows[0])).not.toMatch(/nava_should|please create/);
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

  it('sets expectPass false when predicted lacks a claimed requiredField', () => {
    const rows = joinGoldPairOps({
      labels: [label({ staff_move: 'booked_confirmed' })],
      claimed: [{ messageId: 'msg-1', operations: [op('create', ['arrival'])] }],
      predicted: [{ messageId: 'msg-1', operations: [op('create')] }],
    });
    expect(rows[0]?.expectPass).toBe(false);
  });

  it('sets expectPass true when predicted has every claimed requiredField plus extras', () => {
    const rows = joinGoldPairOps({
      labels: [label({ staff_move: 'booked_confirmed' })],
      claimed: [{ messageId: 'msg-1', operations: [op('create', ['arrival'])] }],
      predicted: [{ messageId: 'msg-1', operations: [op('create', ['arrival', 'departure'])] }],
    });
    expect(rows[0]?.expectPass).toBe(true);
  });

  it('treats empty claimed requiredFields as no constraint', () => {
    const rows = joinGoldPairOps({
      labels: [label({ staff_move: 'booked_confirmed' })],
      claimed: [{ messageId: 'msg-1', operations: [op('create')] }],
      predicted: [{ messageId: 'msg-1', operations: [op('create', ['arrival'])] }],
    });
    expect(rows[0]?.expectPass).toBe(true);
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
