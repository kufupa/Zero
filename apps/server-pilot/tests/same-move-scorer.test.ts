import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadSameMoveOpsJsonl,
  parseSameMoveEvalCli,
  scoreSameMoveOps,
} from '../src/ai/same-move-scorer';
import type { GoldOperation } from '../src/ai/same-move-ops';

const temps = new Set<string>();

afterEach(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
  temps.clear();
});

function op(
  operation: GoldOperation['operation'],
  fields: string[],
  tool: string,
): GoldOperation {
  return {
    operation,
    needLevel: 'required',
    requiredFields: fields,
    candidateTool: tool,
    unknownReason: null,
  };
}

describe('same-move ops JSONL report', () => {
  it('scores a 2-row ops JSONL as match=1 mismatch=1', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'same-move-ops-'));
    temps.add(dir);
    const jsonl = path.join(dir, 'joined.jsonl');
    const create = op('create', ['arrival', 'departure'], 'hms_create_reservation');
    const cancel = op('cancel', ['reservationRef'], 'hms_cancel_reservation');
    await writeFile(
      jsonl,
      `${JSON.stringify({ id: 'match-create', expectPass: true, predicted: [create], claimed: [create] })}\n${JSON.stringify({ id: 'mismatch-create-vs-cancel', expectPass: false, predicted: [create], claimed: [cancel] })}\n`,
    );

    const report = scoreSameMoveOps(loadSameMoveOpsJsonl(jsonl));

    expect(report.n).toBe(2);
    expect(report.match).toBe(1);
    expect(report.mismatch).toBe(1);
    expect(report.not_scored).toBe(0);
    expect(report.rate).toBe(0.5);
    expect(report.grades).toMatchObject({ match: 1, mismatch: 1, not_scored: 0 });
  });

  it('counts empty predicted or claimed as not_scored', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'same-move-ops-'));
    temps.add(dir);
    const jsonl = path.join(dir, 'joined.jsonl');
    await writeFile(
      jsonl,
      `${JSON.stringify({ id: 'empty', expectPass: false, predicted: [], claimed: [] })}\n`,
    );
    const report = scoreSameMoveOps(loadSameMoveOpsJsonl(jsonl));
    expect(report).toMatchObject({ n: 1, match: 0, mismatch: 0, not_scored: 1, rate: 0 });
  });

  it('forbids mail PII keys in ops JSONL', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'same-move-ops-'));
    temps.add(dir);
    const jsonl = path.join(dir, 'joined.jsonl');
    await writeFile(
      jsonl,
      `${JSON.stringify({ id: 'pii', expectPass: true, predicted: [], claimed: [], textBody: 'secret' })}\n`,
    );
    expect(() => loadSameMoveOpsJsonl(jsonl)).toThrow(/forbids mail field textBody/);
  });

  it('parses --ops as report mode and no flag as Promptfoo', () => {
    expect(parseSameMoveEvalCli([])).toEqual({ mode: 'promptfoo' });
    const parsed = parseSameMoveEvalCli(['--ops', 'evals/same-move/joined.jsonl']);
    expect(parsed.mode).toBe('ops');
    if (parsed.mode === 'ops') {
      expect(parsed.opsPath).toMatch(/joined\.jsonl$/);
    }
  });
});
