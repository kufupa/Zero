import { describe, expect, it } from 'vitest';
import {
  runSameMovePromptfooEval,
  scoreSameMove,
} from '../src/ai/same-move-scorer';
import type { GoldOperation } from '../scripts/compare-centurion-human-gold';

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

describe('same-move Promptfoo gold scorer', () => {
  it('passes when predicted operations match claimed staff ops', () => {
    const create = op('create', ['arrival', 'departure'], 'hms_create_reservation');
    const result = scoreSameMove({ predicted: [create], claimed: [create] });
    expect(result.grade).toBe('match');
    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });

  it('fails a mismatched move so the scorer cannot be a stub', () => {
    const predicted = op('create', ['arrival', 'departure'], 'hms_create_reservation');
    const claimed = op('cancel', ['reservationRef'], 'hms_cancel_reservation');
    const result = scoreSameMove({ predicted: [predicted], claimed: [claimed] });
    expect(result.grade).toBe('mismatch');
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
    expect(result.mismatchReasons).toEqual(
      expect.arrayContaining(['missing_operation', 'unexpected_operation']),
    );
  });

  it('runs Promptfoo locally on repo fixtures without sharing bodies', async () => {
    const report = await runSameMovePromptfooEval();
    expect(report.sharing).toBe(false);
    expect(report.remote).toBe(false);
    expect(report.cases.map((row) => row.id).sort()).toEqual([
      'match-create',
      'mismatch-create-vs-cancel',
    ]);
    const match = report.cases.find((row) => row.id === 'match-create');
    const mismatch = report.cases.find((row) => row.id === 'mismatch-create-vs-cancel');
    expect(match).toMatchObject({ sameMovePass: true, grade: 'match', harnessPass: true });
    expect(mismatch).toMatchObject({
      sameMovePass: false,
      grade: 'mismatch',
      harnessPass: true,
    });
    expect(report.passed).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/textBody|htmlBody|"from"/);
  });
});
