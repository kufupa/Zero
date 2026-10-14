import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatQuoteOutcomeSummary,
  quoteOutcomeCases,
  parseQuoteOutcomeEvalArgs,
  parseQuoteOutcomeFixture,
} from '../scripts/quote-outcome-eval.js';
import { finalQuoteVersion, quoteOutcomeDiff, scoreQuoteOutcomes, selectPreparedQuoteOutcomes } from '../src/ai/quote-outcomes.js';

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
      roomLineTotals: { n: 2, correct: 1, pct: 50 },
      finalOutput: { n: 2, captured: 1, pct: 50 },
    });
  });

  it('matches all requested run/revision pairs and rejects missing or duplicate references', () => {
    const item = parseQuoteOutcomeFixture(fixture)[0]!;
    const secondPrepared = { ...item.prepared, workflowRunId: 'run-2', revisionRef: 'revision-2' };
    const secondStaffFinal = { ...item.staffFinal, workflowRunId: 'run-2', revisionRef: 'revision-2' };
    const events = [
      { id: 'prepared-1', aiValue: item.prepared, value: item.staffFinal, aiSource: item.prepared.workflowRunId },
      { id: 'prepared-2', aiValue: secondPrepared, value: secondStaffFinal, aiSource: 'run-2' },
    ];
    const refs = [
      { workflowRunId: item.prepared.workflowRunId, revisionRef: item.prepared.revisionRef },
      { workflowRunId: 'run-2', revisionRef: 'revision-2' },
    ];
    expect(selectPreparedQuoteOutcomes(events, item.prepared.sourceMessageId, refs)?.map(({ event }) => event.id))
      .toEqual(['prepared-1', 'prepared-2']);
    expect(selectPreparedQuoteOutcomes(events, item.prepared.sourceMessageId, [
      ...refs, { workflowRunId: 'absent', revisionRef: 'revision' },
    ])).toBeNull();
    expect(selectPreparedQuoteOutcomes(events, item.prepared.sourceMessageId, [refs[0]!, refs[0]!])).toBeNull();
  });

  it('joins every prepared run to combined output and counts missing captures', () => {
    const [item, second] = parseQuoteOutcomeFixture(fixture);
    const secondPrepared = { ...second!.prepared, workflowRunId: 'run-2', revisionRef: 'revision-2' };
    const secondStaffFinal = { ...second!.staffFinal, workflowRunId: 'run-2', revisionRef: 'revision-2' };
    const preparedRows = [
      { eventId: 'prepared-1', sourceMessageId: item!.prepared.sourceMessageId, aiValue: item!.prepared, staffValue: item!.staffFinal },
      { eventId: 'prepared-2', sourceMessageId: second!.prepared.sourceMessageId, aiValue: secondPrepared, staffValue: secondStaffFinal },
    ];
    const combined = quoteOutcomeCases(preparedRows, [{
      value: {
        quotes: [
          { preparedEventId: 'prepared-1', prepared: item!.prepared, staffFinal: item!.staffFinal },
          { preparedEventId: 'prepared-2', prepared: secondPrepared, staffFinal: secondStaffFinal },
        ],
        output: item!.finalOutput,
      },
      evidence: { preparedEventIds: ['prepared-1', 'prepared-2'] },
    }]);
    expect(combined.map(({ prepared }) => [prepared.workflowRunId, prepared.revisionRef])).toEqual([
      [item!.prepared.workflowRunId, item!.prepared.revisionRef],
      ['run-2', 'revision-2'],
    ]);
    expect(scoreQuoteOutcomes(combined).finalOutput).toMatchObject({ n: 2, captured: 2, pct: 100 });

    const missing = quoteOutcomeCases(preparedRows, [{
      value: { output: item!.finalOutput }, evidence: { preparedEventId: 'prepared-1' },
    }]);
    expect(scoreQuoteOutcomes(missing).finalOutput).toMatchObject({ n: 2, captured: 1, pct: 50 });
  });

  it('counts missing prepared contact and party finals as disagreements', () => {
    const item = parseQuoteOutcomeFixture(fixture)[0]!;
    const staffFinal = {
      ...item.staffFinal,
      fields: { ...item.staffFinal.fields, contact: { ...item.staffFinal.fields.contact, email: '' } },
      party: null,
    };
    const result = scoreQuoteOutcomes([{ ...item, staffFinal }]);
    expect(result.contact).toMatchObject({ n: 3, correct: 2, pct: 66.67 });
    expect(result.party).toMatchObject({ n: 2, correct: 0, pct: 0 });
  });

  it('grades room line totals separately from authorized extra charges', () => {
    const item = parseQuoteOutcomeFixture(fixture)[0]!;
    const staffFinal = {
      ...item.staffFinal,
      lines: [...item.staffFinal.lines, { groupId: 'extra:dinner', totalMinor: 500, rateMinor: 500, nights: 1 }],
      totalMinor: item.staffFinal.totalMinor + 500,
    };
    expect(scoreQuoteOutcomes([{ ...item, staffFinal }]).roomLineTotals).toMatchObject({ n: 1, correct: 1, pct: 100 });
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
    expect(output).toContain('"roomLineTotals"');
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

  it('rejects malformed nested quote snapshots before scoring', () => {
    const item = parseQuoteOutcomeFixture(fixture)[0]!;
    expect(finalQuoteVersion({ ...item.prepared, fields: { ...item.prepared.fields, contact: null } })).toBeNull();
    expect(finalQuoteVersion({ ...item.prepared, fields: { ...item.prepared.fields, groups: [null] } })).toBeNull();
    expect(finalQuoteVersion({ ...item.prepared, lines: [null] })).toBeNull();
  });

  it('rejects malformed or blank fixture rows', () => {
    expect(() => parseQuoteOutcomeFixture('not-json')).toThrow('invalid quote outcome fixture');
    expect(() => parseQuoteOutcomeFixture(`${fixture.trimEnd()}\n\n`)).toThrow('invalid quote outcome fixture');
  });
});
