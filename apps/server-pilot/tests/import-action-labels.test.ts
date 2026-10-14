import { parseActionLabelJsonl, parseImportArgs } from '../scripts/import-action-labels.js';
import { MAIL_ACTIONS } from '../src/mail/action-labels.js';
import { describe, expect, it } from 'vitest';

const label = (action = 'amend', needsAction = true) => ({ action, needsAction });
const line = (expected: unknown = label(), predictions: unknown = [label('cancel')]) =>
  JSON.stringify({ messageId: 'synthetic-message', expected, predictions });

describe('action label JSONL validation', () => {
  it('retains only action and needsAction from labels with extra metadata', () => {
    const extra = { ...label(), source: 'owner', messageId: 'unexpected', version: 'unexpected' };
    expect(parseActionLabelJsonl(line(extra, [extra])).records).toEqual([
      { messageId: 'synthetic-message', agent: label(), model: label() },
    ]);
  });
  it('reads nested agent gold and only the first model prediction, ignoring blank lines', () => {
    expect(parseActionLabelJsonl(`\n${line(label(), [label('cancel'), null])}\r\n \n`)).toEqual({
      parsed: 1,
      invalid: 0,
      records: [{ messageId: 'synthetic-message', agent: label(), model: label('cancel') }],
    });
  });

  it.each(MAIL_ACTIONS)('accepts shared action %s with a consistent boolean', (action) => {
    const value = label(action, action !== 'no_action');
    expect(parseActionLabelJsonl(line(value, [value])).records).toHaveLength(1);
  });

  it.each([
    '{broken',
    'null',
    '{}',
    JSON.stringify({ messageId: '', expected: label(), predictions: [label()] }),
    JSON.stringify({ messageId: 1, expected: label(), predictions: [label()] }),
    line(label('unknown')),
    line(label(), [label('unknown')]),
    line(label('no_action', true)),
    line(label(), [label('amend', false)]),
    line({ action: 'amend', needsAction: 'true' }),
    line(null),
    line(label(), []),
    line(label(), null),
    line(label(), [null]),
  ])('skips the entire invalid pair without throwing or exposing input', (input) => {
    expect(parseActionLabelJsonl(input)).toEqual({ parsed: 1, invalid: 1, records: [] });
  });

  it('continues after malformed lines', () => {
    expect(parseActionLabelJsonl(`${line()}\ninvalid\n${line()}`)).toMatchObject({
      parsed: 3,
      invalid: 1,
      records: [{ messageId: 'synthetic-message' }, { messageId: 'synthetic-message' }],
    });
  });
});

describe('import CLI options', () => {
  const required = ['--file', '/tmp/synthetic.jsonl', '--version', 'fixture-v1'];
  it('defaults to dry run and environment transport', () => {
    expect(parseImportArgs(required, { HMS_MAILBOX_TRANSPORT_ID: 'synthetic-env' })).toEqual({
      file: '/tmp/synthetic.jsonl',
      version: 'fixture-v1',
      transportId: 'synthetic-env',
      write: false,
    });
  });
  it('explicit transport overrides environment and write opts in', () => {
    expect(
      parseImportArgs([...required, '--transport', 'synthetic-explicit', '--write'], {
        HMS_MAILBOX_TRANSPORT_ID: 'synthetic-env',
      }),
    ).toMatchObject({ transportId: 'synthetic-explicit', write: true });
  });
  it.each(
    [
      [],
      ['--file'],
      [...required],
      [...required, '--transport'],
      [...required, '--unknown'],
      [...required, '--version', ''],
    ].map((args) => ({ args })),
  )('rejects missing or malformed options with a fixed non-input error', ({ args }) => {
    expect(() => parseImportArgs(args, {})).toThrow('Invalid import options');
  });
});
