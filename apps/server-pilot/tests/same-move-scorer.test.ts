import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatSameMoveOpsBaseline,
  majorityBaseline,
  opsMatch,
  type GoldOperation,
} from '../src/ai/same-move-ops';
import {
  loadSameMoveOpsJsonl,
  parseSameMoveEvalCli,
  scoreSameMoveOps,
} from '../src/ai/same-move-scorer';

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

  it('exposes claimedOps predOps and pairTop so none→none matches cannot hide', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'same-move-ops-'));
    temps.add(dir);
    const jsonl = path.join(dir, 'joined.jsonl');
    const none = op('none', [], 'none');
    const create = op('create', ['arrival', 'departure'], 'hms_create_reservation');
    await writeFile(
      jsonl,
      `${JSON.stringify({ id: 'match-none', expectPass: true, predicted: [none], claimed: [none] })}\n${JSON.stringify({ id: 'mismatch-create-vs-none', expectPass: false, predicted: [none], claimed: [create] })}\n`,
    );

    const report = scoreSameMoveOps(loadSameMoveOpsJsonl(jsonl));

    expect(report).toMatchObject({ n: 2, match: 1, mismatch: 1, not_scored: 0, rate: 0.5 });
    expect(report.claimedOps).toEqual({ none: 1, create: 1 });
    expect(report.predOps).toEqual({ none: 2 });
    expect(report.pairTop).toEqual(
      expect.arrayContaining([
        { pair: 'none→none', n: 1 },
        { pair: 'create→none', n: 1 },
      ]),
    );
    expect(report.pairTop).toHaveLength(2);
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

describe('opsMatch requiredFields', () => {
  it('matches the same operation when claimed requiredFields are empty', () => {
    expect(opsMatch([op('create', ['arrival'], 'hms_create')], [op('create', [], 'hms_create')])).toBe(
      true,
    );
  });

  it('matches only when every claimed requiredField is on the predicted op', () => {
    const claimed = [op('create', ['arrival', 'departure'], 'hms_create')];
    expect(opsMatch([op('create', ['arrival'], 'hms_create')], claimed)).toBe(false);
    expect(opsMatch([op('create', ['arrival', 'departure', 'adults'], 'hms_create')], claimed)).toBe(
      true,
    );
  });

  it('does not match different operations even with empty fields', () => {
    expect(opsMatch([op('create', [], 'hms_create')], [op('cancel', [], 'hms_cancel')])).toBe(false);
  });
});

describe('majority baseline', () => {
  it('prints majority baseline beside model match and a per-workflow table', () => {
    const create = op('create', [], 'hms_create_reservation');
    const none = op('none', [], 'none');
    const rows = [
      { predicted: [create], claimed: [create] },
      { predicted: [create], claimed: [none] },
      { predicted: [none], claimed: [none] },
    ];
    const baseline = majorityBaseline(rows);
    expect(baseline.set).toBe('none');
    expect(baseline.match).toBe(2);
    expect(baseline.n).toBe(3);
    expect(baseline.modelMatch).toBe(2);
    expect(baseline.byWorkflow).toEqual([
      { workflow: 'none', model: 1, baseline: 2, n: 2 },
      { workflow: 'create', model: 1, baseline: 0, n: 1 },
    ]);
    const printed = formatSameMoveOpsBaseline(baseline);
    expect(printed).toContain('model match=2/3 (66.7%)  baseline majority=none match=2/3 (66.7%)');
    expect(printed).toContain('workflow\tmodel\tbaseline\tn');
    expect(printed).toContain('none\t1/2\t2/2\t2');
    expect(printed).toContain('create\t1/1\t0/1\t1');
  });

  it('uses opsMatch requiredFields when scoring the constant majority prediction', () => {
    const claimedCreate = op('create', ['arrival'], 'hms_create_reservation');
    const predictedCreate = op('create', ['arrival'], 'hms_create_reservation');
    const none = op('none', [], 'none');
    const rows = [
      { predicted: [predictedCreate], claimed: [claimedCreate] },
      { predicted: [none], claimed: [claimedCreate] },
    ];
    const baseline = majorityBaseline(rows);
    expect(baseline.set).toBe('create');
    expect(baseline.match).toBe(0);
    expect(baseline.modelMatch).toBe(1);
  });
});
