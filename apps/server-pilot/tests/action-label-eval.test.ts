import {
  computeActionLabelEval,
  parseEvalArgs,
  type EvalLabelRow,
} from '../scripts/action-label-eval.js';
import { MAIL_ACTIONS, type MailAction } from '../src/mail/action-labels.js';
import { describe, expect, it } from 'vitest';

const options = { transportId: 'synthetic-transport', version: 'fixture-v1' };
function row(
  messageId: string,
  source: EvalLabelRow['source'],
  action: MailAction,
  extra: Partial<EvalLabelRow> = {},
): EvalLabelRow {
  return {
    id: `${messageId}-${source}`,
    messageId,
    source,
    action,
    needsAction: action !== 'no_action',
    updatedAt: new Date('2026-01-01'),
    ...options,
    ...extra,
  };
}

describe('pure action label evaluation', () => {
  it('scores four marked messages, with owner actual and model predicted', () => {
    const rows = ['amend', 'cancel', 'no_action', 'quote_availability'].flatMap((action, i) => [
      row(`m${i}`, 'owner', action as MailAction),
      row(`m${i}`, 'model', i === 3 ? 'no_action' : (action as MailAction)),
      row(`m${i}`, 'agent', action as MailAction),
    ]);
    const result = computeActionLabelEval(rows, options);
    expect(result.metrics.modelActionAccuracy).toBe(0.75);
    expect(result.metrics.modelNeedsActionAccuracy).toBe(0.75);
    expect(result.metrics.agentOwnerActionAgreement).toBe(1);
    expect(result.metrics.coverage).toBe(1);
    expect(result.confusionMatrix.axes).toEqual({
      rows: 'owner_actual',
      columns: 'model_predicted',
    });
    expect(result.confusionMatrix.counts.quote_availability.no_action).toBe(1);
    expect(result.perClass.no_action).toEqual({ precision: 0.5, recall: 1 });
    expect(result.perClass.quote_availability).toEqual({ precision: 0, recall: 0 });
    expect(Object.keys(result.perClass)).toEqual([...MAIL_ACTIONS]);
  });

  it('separates action misses from needs-action misses and scores agent disagreement', () => {
    const result = computeActionLabelEval(
      [
        row('a', 'owner', 'amend'),
        row('a', 'model', 'cancel'),
        row('a', 'agent', 'amend'),
        row('b', 'owner', 'cancel'),
        row('b', 'model', 'cancel'),
        row('b', 'agent', 'amend'),
      ],
      options,
    );
    expect(result.counts).toEqual({ modelLabelled: 2, ownerMarked: 2, agentCompared: 2 });
    expect(result.metrics).toEqual({
      modelActionAccuracy: 0.5,
      modelNeedsActionAccuracy: 1,
      agentOwnerActionAgreement: 0.5,
      coverage: 1,
    });
    expect(result.confusionMatrix.counts.amend.cancel).toBe(1);
    expect(result.perClass.cancel).toEqual({ precision: 0.5, recall: 1 });
  });

  it('selects transport/version, latest owner, matching agent version; coverage counts unmarked', () => {
    const result = computeActionLabelEval(
      [
        row('a', 'model', 'amend'),
        row('b', 'model', 'cancel'),
        row('a', 'owner', 'cancel'),
        row('a', 'owner', 'amend', { version: 'owner-v2', updatedAt: new Date('2026-02-01') }),
        row('a', 'agent', 'cancel', { version: 'old' }),
        row('a', 'agent', 'amend'),
        row('c', 'model', 'cancel', { version: 'old' }),
        row('c', 'owner', 'cancel'),
        row('d', 'model', 'cancel', { transportId: 'other' }),
        row('d', 'owner', 'cancel'),
      ],
      options,
    );
    expect(result.counts).toEqual({ modelLabelled: 2, ownerMarked: 1, agentCompared: 1 });
    expect(result.metrics).toEqual({
      modelActionAccuracy: 1,
      modelNeedsActionAccuracy: 1,
      agentOwnerActionAgreement: 1,
      coverage: 0.5,
    });
    expect(result.labels).toEqual([
      {
        messageId: 'a',
        model: { action: 'amend', needsAction: true },
        owner: { action: 'amend', needsAction: true },
        agent: { action: 'amend', needsAction: true },
      },
      { messageId: 'b', model: { action: 'cancel', needsAction: true }, owner: null, agent: null },
    ]);
  });

  it.each(
    [[], [row('unmarked', 'model', 'amend')], [row('orphan', 'owner', 'amend')]].map((rows) => ({
      rows,
    })),
  )('returns finite zeros without marks or predictions', ({ rows }) => {
    const result = computeActionLabelEval(rows, options);
    expect(Object.values(result.metrics)).toEqual([0, 0, 0, 0]);
    for (const metrics of Object.values(result.perClass)) {
      expect(metrics).toEqual({ precision: 0, recall: 0 });
    }
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });
  it('does not penalize absent agent labels, and strips extra row metadata', () => {
    const contaminated = {
      ...row('a', 'model', 'amend'),
      content: 'synthetic-secret',
      provider: 'hidden',
    };
    const result = computeActionLabelEval([contaminated, row('a', 'owner', 'amend')], options);
    expect(result.counts.agentCompared).toBe(0);
    expect(result.metrics.agentOwnerActionAgreement).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-secret|hidden|provider|content/);
  });
});

describe('eval CLI options', () => {
  const args = ['--out', '/tmp/synthetic-eval.json', '--version', 'fixture-v1'];
  it('uses environment transport and supports explicit override', () => {
    expect(parseEvalArgs(args, { HMS_MAILBOX_TRANSPORT_ID: ' env ' })).toEqual({
      out: '/tmp/synthetic-eval.json',
      version: 'fixture-v1',
      transportId: 'env',
    });
    expect(parseEvalArgs([...args, '--transport', 'explicit'], {}).transportId).toBe('explicit');
  });
  it.each(
    [
      [],
      ['--out', 'x'],
      ['--version', 'v'],
      [...args, '--out', 'again'],
      [...args, '--unknown', 'x'],
      [...args, '--transport'],
      [...args, '--transport', ' '],
    ].map((input) => ({ input })),
  )('requires out/version/transport and rejects malformed options', ({ input }) => {
    expect(() => parseEvalArgs(input, {})).toThrow('Invalid eval options');
  });
});
