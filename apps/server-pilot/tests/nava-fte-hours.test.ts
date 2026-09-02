import {
  computeNavaHoursStats,
  parseAsOfFromDump,
  parseConnectedMailboxDump,
  type NavaHoursMessage,
} from '../src/ops/nava-fte-hours';
import { describe, expect, it } from 'vitest';

function block(options: {
  index: number;
  id: string;
  threadId: string | null;
  direction: string;
  received?: string;
  sent?: string;
  created?: string;
  textBody?: string;
}): string {
  const thread =
    options.threadId === null ? '(unthreaded)' : `\`${options.threadId}\``;
  const body = options.textBody ?? 'hello';
  return [
    '---',
    '',
    `## Message ${options.index}: subject`,
    '',
    `- **Message ID:** \`${options.id}\``,
    `- **Thread ID:** ${thread}`,
    `- **Transport ID:** \`t1\``,
    `- **Direction:** ${options.direction}`,
    `- **From:** someone`,
    `- **To:** desk`,
    `- **CC:**`,
    `- **BCC:**`,
    `- **Received:** ${options.received ?? ''}`,
    `- **Sent:** ${options.sent ?? ''}`,
    `- **Created:** ${options.created ?? ''}`,
    '',
    '### Text body',
    '',
    '```text',
    body.endsWith('\n') ? body : `${body}\n`,
    '```',
    '',
    '### HTML body',
    '',
    '_(empty)_',
  ].join('\n');
}

function dump(messages: string[], asOf = '2026-08-25T22:24:55.657Z'): string {
  return [
    '# Connected mailbox message dump',
    '',
    `- Snapshot as of: ${asOf}`,
    `- Active mailboxes: 2`,
    `- Messages: ${messages.length} (0 inbound, 0 outbound)`,
    '',
    ...messages,
    '',
  ].join('\n');
}

describe('parseConnectedMailboxDump', () => {
  it('ignores Received lines inside fenced bodies', () => {
    const markdown = dump([
      block({
        index: 1,
        id: 'msg-1',
        threadId: 'thread-a',
        direction: 'inbound',
        received: '2026-01-02T00:00:00.000Z',
        created: '2026-01-01T00:00:00.000Z',
        textBody: '- **Received:** 2099-01-01T00:00:00.000Z',
      }),
    ]);
    const parsed = parseConnectedMailboxDump(markdown);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.timestamp?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('keeps unthreaded messages on distinct keys', () => {
    const markdown = dump([
      block({
        index: 1,
        id: 'u-1',
        threadId: null,
        direction: 'inbound',
        received: '2026-01-01T00:00:00.000Z',
      }),
      block({
        index: 2,
        id: 'u-2',
        threadId: null,
        direction: 'inbound',
        received: '2026-01-01T01:00:00.000Z',
      }),
    ]);
    const parsed = parseConnectedMailboxDump(markdown);
    expect(parsed.map((row) => row.threadKey).sort()).toEqual([
      'unthreaded:u-1',
      'unthreaded:u-2',
    ]);
  });

  it('drops directions other than inbound and outbound', () => {
    const markdown = dump([
      block({
        index: 1,
        id: 'x-1',
        threadId: 't',
        direction: 'unknown',
        received: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    expect(parseConnectedMailboxDump(markdown)).toEqual([]);
  });

  it('parses snapshot asOf', () => {
    expect(parseAsOfFromDump(dump([], '2026-08-25T22:24:55.657Z'))).toBe(
      '2026-08-25T22:24:55.657Z',
    );
  });
});

describe('computeNavaHoursStats', () => {
  const asOf = '2026-08-25T22:24:55.657Z';

  it('counts outbound-first threads as eligible when inbound exists', () => {
    const messages: NavaHoursMessage[] = [
      {
        messageId: 'out',
        threadKey: 't1',
        direction: 'outbound',
        timestamp: new Date('2026-01-01T01:00:00.000Z'),
      },
      {
        messageId: 'in',
        threadKey: 't1',
        direction: 'inbound',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
      },
    ];
    const stats = computeNavaHoursStats(messages, asOf);
    expect(stats.nEligibleFirstResponse).toBe(1);
    expect(stats.medianFirstResponseMinutes).toBe(60);
  });

  it('excludes inbound-only threads from eligible n', () => {
    const messages: NavaHoursMessage[] = [
      {
        messageId: 'in',
        threadKey: 'only',
        direction: 'inbound',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
      },
    ];
    const stats = computeNavaHoursStats(messages, asOf);
    expect(stats.threadCount).toBe(1);
    expect(stats.inboundOnlyThreads).toBe(1);
    expect(stats.threadsWithOutbound).toBe(0);
    expect(stats.nEligibleFirstResponse).toBe(0);
    expect(stats.medianFirstResponseMinutes).toBeNull();
  });

  it('drops missing timestamps from latency but still counts inbound-only', () => {
    const messages: NavaHoursMessage[] = [
      {
        messageId: 'in',
        threadKey: 'gap',
        direction: 'inbound',
        timestamp: null,
      },
    ];
    const stats = computeNavaHoursStats(messages, asOf);
    expect(stats.inboundOnlyThreads).toBe(1);
    expect(stats.nEligibleFirstResponse).toBe(0);
  });

  it('counts both-direction threads with missing timestamps as dropped', () => {
    const messages: NavaHoursMessage[] = [
      {
        messageId: 'in',
        threadKey: 'pair',
        direction: 'inbound',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        messageId: 'out',
        threadKey: 'pair',
        direction: 'outbound',
        timestamp: null,
      },
    ];
    const stats = computeNavaHoursStats(messages, asOf);
    expect(stats.droppedNegativeOrMissing).toBe(1);
    expect(stats.nEligibleFirstResponse).toBe(0);
  });

  it('drops negative first-response deltas', () => {
    const messages: NavaHoursMessage[] = [
      {
        messageId: 'in',
        threadKey: 'neg',
        direction: 'inbound',
        timestamp: new Date('2026-01-01T02:00:00.000Z'),
      },
      {
        messageId: 'out',
        threadKey: 'neg',
        direction: 'outbound',
        timestamp: new Date('2026-01-01T01:00:00.000Z'),
      },
    ];
    const stats = computeNavaHoursStats(messages, asOf);
    expect(stats.droppedNegativeOrMissing).toBe(1);
    expect(stats.nEligibleFirstResponse).toBe(0);
  });

  it('uses mean of two center values for even-n median', () => {
    const minutes = [10, 20, 30, 40];
    const messages: NavaHoursMessage[] = minutes.flatMap((value, index) => [
      {
        messageId: `in-${index}`,
        threadKey: `t-${index}`,
        direction: 'inbound',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        messageId: `out-${index}`,
        threadKey: `t-${index}`,
        direction: 'outbound',
        timestamp: new Date(Date.parse('2026-01-01T00:00:00.000Z') + value * 60_000),
      },
    ]);
    const stats = computeNavaHoursStats(messages, asOf);
    expect(stats.nEligibleFirstResponse).toBe(4);
    expect(stats.medianFirstResponseMinutes).toBe(25);
  });
});
