import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LunaAnalysis } from '../src/ai/reservationist-decision.js';
import type { ReservationistRunners } from '../src/ai/reservationist-agent.js';
import {
  main,
  parseReplayAdapterOpsArgs,
  replayAdapterOps,
  type AnalyseSelectionWithAgentFn,
} from '../scripts/run-reservationist-backtest.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'replay-adapter-ops-'));
  dirs.push(dir);
  return dir;
}

function lunaQuote(): LunaAnalysis {
  return {
    workflow: 'quote',
    flags: [],
    groups: [],
    party: { kind: null, name: null, reference: null },
    rateClaims: [],
    missing: [],
    evidence: [],
    tasks: [],
  };
}

function syntheticSnapshotRow(id: string) {
  return {
    pair_id: `pair-${id}`,
    mailbox: 'mailbox-synth',
    thread_id: `thread-${id}`,
    inbound: {
      id,
      direction: 'inbound',
      from_address: 'guest@example.com',
      to_addresses: ['hotel@example.com'],
      cc_addresses: [],
      subject: 'October stay',
      sent_at: '2026-10-02T08:59:00Z',
      received_at: '2026-10-02T09:00:00Z',
      body: 'Please quote two rooms for 12 October.',
      body_is_html: false,
      attachments: [],
    },
    context: [],
    outbound: {
      id: `${id}-out`,
      direction: 'outbound',
      from_address: 'hotel@example.com',
      to_addresses: ['guest@example.com'],
      subject: 'ANSWER-KEY-SUBJECT',
      sent_at: '2026-10-02T10:00:00Z',
      received_at: '2026-10-02T10:00:00Z',
      body: 'ANSWER-KEY-BODY',
      body_is_html: false,
    },
  };
}

describe('parseReplayAdapterOpsArgs', () => {
  it('requires snapshot and out, and accepts 25-mail slice flags', () => {
    expect(parseReplayAdapterOpsArgs({})).toBeNull();
    expect(parseReplayAdapterOpsArgs({ snapshot: 'gold.jsonl' })).toBeNull();
    expect(parseReplayAdapterOpsArgs({ snapshot: 'gold.jsonl', out: 'pred.jsonl', limit: '0' })).toBeNull();
    expect(parseReplayAdapterOpsArgs({ snapshot: 'gold.jsonl', out: 'pred.jsonl', offset: '-1' })).toBeNull();
    expect(parseReplayAdapterOpsArgs({ snapshot: 'gold.jsonl', out: 'pred.jsonl', limit: '1.5' })).toBeNull();
    expect(
      parseReplayAdapterOpsArgs({
        snapshot: 'gold.jsonl',
        out: 'pred.jsonl',
        limit: '25',
        offset: '50',
      }),
    ).toEqual({
      snapshot: 'gold.jsonl',
      out: 'pred.jsonl',
      limit: 25,
      offset: 50,
      concurrency: 8,
    });
  });

  it('returns usage exit when replay-adapter-ops flags are missing or invalid', async () => {
    expect(await main(['replay-adapter-ops'])).toBe(2);
    expect(await main(['replay-adapter-ops', '--snapshot', 'gold.jsonl'])).toBe(2);
    expect(await main(['replay-adapter-ops', '--snapshot', 'gold.jsonl', '--out', 'pred.jsonl', '--limit', '0'])).toBe(
      2,
    );
  });
});

describe('replayAdapterOps', () => {
  it('maps one synthetic snapshot row through the agent producer with stub runners', async () => {
    const dir = tempDir();
    const snapshot = join(dir, 'snapshot.jsonl');
    const out = join(dir, 'pred.jsonl');
    writeFileSync(
      snapshot,
      `${JSON.stringify(syntheticSnapshotRow('msg-skip'))}\n${JSON.stringify(syntheticSnapshotRow('msg-synth-1'))}\n${JSON.stringify(syntheticSnapshotRow('msg-skip-2'))}\n`,
    );

    let seenSelectionId: string | undefined;
    let seenRunners: ReservationistRunners | undefined;
    const analyse: AnalyseSelectionWithAgentFn = async (input) => {
      seenSelectionId = input.selection.messageId;
      seenRunners = input.runners;
      expect(input.selection.bodyText).toContain('Please quote two rooms for 12 October.');
      expect(JSON.stringify(input.selection)).not.toMatch(/ANSWER-KEY/);
      return { source: 'luna', analysis: lunaQuote() };
    };

    const code = await replayAdapterOps(
      { snapshot, out, limit: 1, offset: 1, concurrency: 1 },
      { analyse, model: {} },
    );

    expect(code).toBe(0);
    expect(seenSelectionId).toBe('msg-synth-1');
    expect(await seenRunners!.quote({})).toEqual({ status: 'unavailable' });
    expect(await seenRunners!.party({})).toEqual({ outcome: 'no_match', candidates: [] });
    expect(await seenRunners!.validateCreate({})).toEqual({ ok: false, errors: ['unavailable'] });
    const rows = readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { message_id: string; workflow: string; error: string | null; operations: unknown[] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'predicted',
      message_id: 'msg-synth-1',
      workflow: 'quote',
      error: null,
    });
    expect(rows[0]!.operations).toEqual([
      {
        operation: 'quote',
        needLevel: 'required',
        requiredFields: [],
        candidateTool: 'hms_quote_stay',
        unknownReason: null,
      },
    ]);
  });
});
