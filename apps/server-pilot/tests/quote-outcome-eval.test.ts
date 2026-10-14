import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatQuoteOutcomeSummary,
  parseQuoteOutcomeEvalArgs,
  parseQuoteOutcomeFixture,
} from '../scripts/quote-outcome-eval.js';
import { quoteOutcomeDiff, scoreQuoteOutcomes } from '../src/ai/quote-outcomes.js';

const fixture = readFileSync(new URL('./fixtures/quote-outcome-eval.jsonl', import.meta.url), 'utf8');

describe('quote outcome evaluation', () => {
  it('scores each judgment independently with deterministic synthetic cases', () => {
    const cases = parseQuoteOutcomeFixture(fixture);
    const result = scoreQuoteOutcomes(cases);
    expect(result).toMatchObject({
      cases: 2,
      action: { n: 2, correct: 1, pct: 50 },
      dates: { n: 2, correct: 1, pct: 50 },
      occupancy: { n: 2, correct: 1, pct: 50 },
      contact: { n: 6, correct: 3, pct: 50 },
      party: { n: 4, correct: 2, pct: 50 },
      lineTotals: { n: 2, correct: 1, pct: 50 },
      finalOutput: { n: 2, captured: 1, pct: 50 },
    });
  });

  it('counts message-level action labels once when one source has multiple final versions', () => {
    const item = parseQuoteOutcomeFixture(fixture)[0]!;
    const result = scoreQuoteOutcomes([item, item]);
    expect(result.cases).toBe(2);
    expect(result.action).toMatchObject({ n: 1, correct: 1, pct: 100 });
  });

  it('diffs changed paths deterministically without copying changed values', () => {
    expect(quoteOutcomeDiff({ z: { b: 2 }, a: 1 }, { z: { b: 3 }, a: 1, c: true })).toEqual(['c', 'z.b']);
  });

  it('prints only aggregate counts and percentages, not message or reply data', () => {
    const output = formatQuoteOutcomeSummary(scoreQuoteOutcomes(parseQuoteOutcomeFixture(fixture)));
    expect(output).toContain('"cases": 2');
    expect(output).toContain('"lineTotals"');
    expect(output).not.toMatch(/synthetic-message|avery@example|Synthetic quote reply/);
  });

  it('requires transport and model version for database mode; allows offline fixture mode', () => {
    expect(parseQuoteOutcomeEvalArgs(['--fixture', 'fixture.jsonl'])).toEqual({ fixture: 'fixture.jsonl' });
    expect(parseQuoteOutcomeEvalArgs(['--version', 'fixture-v1'], {
      HMS_MAILBOX_TRANSPORT_ID: ' synthetic-transport ',
    })).toEqual({ transportId: 'synthetic-transport', version: 'fixture-v1' });
    expect(() => parseQuoteOutcomeEvalArgs([], {})).toThrow('Invalid quote outcome eval options');
    expect(() => parseQuoteOutcomeEvalArgs(['--fixture', 'x', '--version', 'v'], {}))
      .toThrow('Invalid quote outcome eval options');
  });

  it('rejects malformed or blank fixture rows', () => {
    expect(() => parseQuoteOutcomeFixture('not-json')).toThrow('invalid quote outcome fixture');
    expect(() => parseQuoteOutcomeFixture(`${fixture.trimEnd()}\n\n`)).toThrow('invalid quote outcome fixture');
  });
});
