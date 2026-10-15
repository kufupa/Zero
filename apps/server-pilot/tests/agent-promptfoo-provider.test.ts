import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  callApi,
  generateAgentPromptfooTests,
  parseAgentEvalGenerateCli,
  type AgentReplayDeps,
} from '../evals/agent/provider.ts';
import {
  scoreReplayOutput,
  scoreRow,
  type EvalGoldRow,
} from '../evals/agent/score-row.ts';
import type { ReservationistDecision } from '../src/ai/reservationist-decision.ts';

const temps = new Set<string>();

afterEach(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
  temps.clear();
});

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-promptfoo-'));
  temps.add(dir);
  return dir;
}

function decision(
  workflow: ReservationistDecision['workflow'],
  stayAsk: ReservationistDecision['stayAsk'] = null,
  extra: Partial<ReservationistDecision> = {},
): ReservationistDecision {
  return {
    workflow,
    stayAsk,
    missing: [],
    replyDraft: extra.replyDraft ?? '',
    rationale: extra.rationale ?? '',
    confirmationNumber: extra.confirmationNumber,
    todoTarget: extra.todoTarget,
  };
}

function goldRow(label: EvalGoldRow['label'], id = 'msg-syn'): EvalGoldRow {
  return { inbound: { id }, label };
}

function mockedDeps(workflow: ReservationistDecision['workflow']): AgentReplayDeps {
  return {
    createModel: () => ({ id: 'mock-luna' }),
    createAgent: () => ({
      generate: async () => ({ object: decision(workflow), steps: [] }),
    }),
  };
}

describe('callApi reservationist replay provider', () => {
  it('returns workflow+operations JSON from a mocked agent for one snapshot row', async () => {
    const dir = await tmpDir();
    const pairsPath = path.join(dir, 'pairs.jsonl');
    await writeFile(
      pairsPath,
      `${JSON.stringify({
        split: 'dev',
        inbound: {
          id: 'msg-syn-quote',
          direction: 'inbound',
          from_address: 'agent@example.test',
          subject: 'synthetic stay ask',
          received_at: '2026-11-01T09:00:00Z',
          body: 'need two rooms next month',
        },
        context: [],
      })}\n`,
    );
    const result = await callApi(
      'replay msg-syn-quote',
      { vars: { pairsPath, messageId: 'msg-syn-quote' } },
      mockedDeps('quote'),
    );
    expect(result.error).toBeUndefined();
    const parsed = JSON.parse(String(result.output)) as {
      workflow: string;
      operations: Array<{ operation: string }>;
    };
    expect(parsed.workflow).toBe('quote');
    expect(parsed.operations.map((row) => row.operation)).toEqual(['quote']);
    expect(JSON.stringify(result)).not.toMatch(/need two rooms|agent@example\.test|synthetic stay ask/);
  });
});

describe('scoreReplayOutput (Promptfoo assert)', () => {
  it('passes when predicted ops match gold and required stay fields are present', () => {
    const stayAsk = {
      arrivalDate: '2026-11-10',
      departureDate: '2026-11-12',
      adults: 2,
      children: 0,
      rooms: 1,
    };
    const scored = scoreReplayOutput(
      JSON.stringify({
        workflow: 'create',
        operations: [{ operation: 'create', requiredFields: [] }],
        decision: decision('create', stayAsk),
      }),
      {
        staff_move: 'booked_confirmed',
        hms_work_implied: [],
        required_fields: ['arrivalDate', 'departureDate'],
        workflow: 'new_booking',
      },
    );
    expect(scored.pass).toBe(true);
    expect(scored.score).toBe(1);
    expect(scored.reason).toBe('match');
  });

  it('fails when a required gold field is missing from the decision', () => {
    const stayAsk = {
      arrivalDate: '2026-11-10',
      departureDate: '2026-11-12',
      adults: 2,
      children: 0,
      rooms: 1,
    };
    const scored = scoreReplayOutput(
      JSON.stringify({
        workflow: 'quote',
        operations: [{ operation: 'quote', requiredFields: [] }],
        decision: decision('quote', { ...stayAsk, departureDate: '' }),
      }),
      {
        staff_move: 'priced_quote',
        required_fields: ['arrivalDate', 'departureDate'],
        workflow: 'quote_availability',
      },
    );
    expect(scored.pass).toBe(false);
    expect(scored.score).toBe(0);
  });

  it('passes abstain-ok when gold and predicted are both unknown', () => {
    const scored = scoreReplayOutput(
      JSON.stringify({
        workflow: 'other',
        operations: [{ operation: 'unknown', requiredFields: [] }],
        decision: decision('other'),
      }),
      {
        staff_move: 'other',
        required_fields: ['confirmationNumber'],
        workflow: 'other_actionable',
      },
    );
    expect(scored.pass).toBe(true);
    expect(scored.reason).toBe('abstain-ok');
  });
});

describe('scoreRow (Driver C opKey)', () => {
  it('sets ok when staff-move op set equals decision op set', () => {
    const scored = scoreRow(
      goldRow({
        workflow: 'quote_availability',
        staff_move: 'priced_quote',
        hms_work_implied: [],
        required_fields: ['arrivalDate'],
      }),
      decision('quote', {
        arrivalDate: '2026-12-01',
        departureDate: '2026-12-03',
        adults: 1,
        children: 0,
        rooms: 1,
      }),
    );
    expect(scored.ok).toBe(true);
    expect(scored.gold).toBe('quote');
    expect(scored.pred).toBe('quote');
    expect(scored.fields).toBe(1);
    expect(scored.scorable).toBe(1);
  });
});

describe('generateAgentPromptfooTests', () => {
  it('emits path+id tests for a train/dev slice and refuses the test split', async () => {
    const dir = await tmpDir();
    const pairsPath = path.join(dir, 'pairs.jsonl');
    const labelsPath = path.join(dir, 'labels.jsonl');
    const rows = [
      { split: 'train', id: 'msg-train-a', staff_move: 'priced_quote', workflow: 'quote_availability' },
      { split: 'train', id: 'msg-train-b', staff_move: 'booked_confirmed', workflow: 'new_booking' },
      { split: 'dev', id: 'msg-dev-a', staff_move: 'cancel_done', workflow: 'cancel' },
      { split: 'test', id: 'msg-test-a', staff_move: 'amend_done', workflow: 'amend' },
    ];
    await writeFile(
      pairsPath,
      rows
        .map((row) =>
          JSON.stringify({
            split: row.split,
            inbound: {
              id: row.id,
              direction: 'inbound',
              from_address: 'agent@example.test',
              subject: 'synthetic',
              received_at: '2026-11-02T09:00:00Z',
              body: 'synthetic body omitted from tests yaml',
            },
          }),
        )
        .join('\n') + '\n',
    );
    await writeFile(
      labelsPath,
      rows
        .map((row) =>
          JSON.stringify({
            message_id: row.id,
            staff_move: row.staff_move,
            workflow: row.workflow,
            required_fields: row.staff_move === 'priced_quote' ? ['arrivalDate'] : [],
            hms_work_implied: [],
          }),
        )
        .join('\n') + '\n',
    );

    expect(() =>
      parseAgentEvalGenerateCli(['--labels', labelsPath, '--pairs', pairsPath, '--split', 'test']),
    ).toThrow(/never .*test split/i);

    const train = generateAgentPromptfooTests({
      labelsPath,
      pairsPath,
      split: 'train',
      limit: 1,
      offset: 1,
    });
    expect(train.tests).toHaveLength(1);
    const only = train.tests[0]!;
    expect(only.vars.messageId).toBe('msg-train-b');
    expect(only.vars.pairsPath).toBe(pairsPath);
    expect(only.vars.staff_move).toBe('booked_confirmed');
    expect(only.assert?.[0]?.metric).toBe('new_booking');
    expect(JSON.stringify(train)).not.toMatch(/synthetic body|from_address|textBody/);

    const dumped = JSON.stringify(
      generateAgentPromptfooTests({ labelsPath, pairsPath, split: 'dev', limit: 25, offset: 0 }),
    );
    expect(dumped).not.toMatch(/msg-test-a|msg-train-a/);
    expect(dumped).toMatch(/msg-dev-a/);
  });
});
