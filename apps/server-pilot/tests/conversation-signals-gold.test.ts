import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateGoldContract,
  evaluateGoldGate,
  GOLD_ACTIONABLE_TOTAL,
  GOLD_FALSE_POSITIVE_MAX,
  GOLD_RECALL_MIN,
  GOLD_UNANSWERED_TOTAL,
  GOLD_RESPONDED_TOTAL,
  resolvePrivateCorpusRoot,
  runConversationSignalsGoldEval,
  runConversationSignalsGoldEvalFromCorpus,
  type ConfusionMatrixCounts,
  type SnapshotRow,
} from '../src/ops/centurion-conversation-signals-eval.js';

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(serverRoot, '../..');

function row(
  overrides: Partial<SnapshotRow> & Pick<SnapshotRow, 'messageId' | 'threadId'>,
): SnapshotRow {
  return {
    direction: 'inbound',
    from: 'guest-a@example.com',
    to: 'centurion@legacyhotels.co.za',
    cc: '',
    subject: 'Room enquiry',
    bodyText: 'Need availability for two rooms.',
    receivedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

/** Opaque 20-thread subset — no PII; covers all six signal families + true negatives. */
const FIXTURE_GLOBAL_OUTBOUNDS: readonly SnapshotRow[] = [
  row({
    messageId: 'auto-conf-1',
    threadId: 'thread-auto-conf',
    direction: 'outbound',
    from: 'centurion@legacyhotels.co.za',
    to: 'booking.com notification',
    subject: 'Confirmation letter_Jane Guest (n°7654321-1) booking update notification',
    bodyText: '',
    receivedAt: '2026-08-01T12:00:00.000Z',
  }),
  row({
    messageId: 'orphan-auto-1',
    threadId: 'thread-orphan-auto',
    direction: 'outbound',
    from: 'centurion@legacyhotels.co.za',
    to: 'guest-a@example.com',
    subject: 'Confirmation letter for guest stay',
    bodyText: '',
    receivedAt: '2026-08-02T09:00:00.000Z',
  }),
  row({
    messageId: 'orphan-human-1',
    threadId: 'thread-orphan-human',
    direction: 'outbound',
    from: 'centurion@legacyhotels.co.za',
    to: 'guest-b@example.com',
    subject: 'Re: Quote follow-up',
    bodyText: 'Please see attached.',
    receivedAt: '2026-08-02T10:00:00.000Z',
  }),
];

const FIXTURE_THREADS: ReadonlyArray<{
  threadIdPrefix: string;
  goldResponded: boolean;
  messages: readonly SnapshotRow[];
}> = [
  {
    threadIdPrefix: 't-in-thr',
    goldResponded: true,
    messages: [
      row({ messageId: 't1-trigger', threadId: 't-in-thr-0001', from: 'guest-a@example.com' }),
      row({
        messageId: 't1-reply',
        threadId: 't-in-thr-0001',
        direction: 'outbound',
        from: 'centurion@legacyhotels.co.za',
        to: 'guest-a@example.com',
        subject: 'Re: Room enquiry',
        bodyText: 'We can assist.',
        receivedAt: '2026-08-01T11:00:00.000Z',
      }),
    ],
  },
  {
    threadIdPrefix: 't-xconf',
    goldResponded: true,
    messages: [
      row({
        messageId: 't2-trigger',
        threadId: 't-xconf-0002',
        bodyText: 'Please confirm reservation n°7654321-1.',
        receivedAt: '2026-08-01T13:00:00.000Z',
      }),
    ],
  },
  {
    threadIdPrefix: 't-orph-a',
    goldResponded: true,
    messages: [row({ messageId: 't3-trigger', threadId: 't-orph-a-0003', from: 'guest-a@example.com' })],
  },
  {
    threadIdPrefix: 't-orph-h',
    goldResponded: true,
    messages: [row({ messageId: 't4-trigger', threadId: 't-orph-h-0004', from: 'guest-b@example.com' })],
  },
  {
    threadIdPrefix: 't-q-hdr',
    goldResponded: true,
    messages: [
      row({
        messageId: 't5-trigger',
        threadId: 't-q-hdr-0005',
        bodyText: [
          'Forwarded quote.',
          'From: Centurion Hotel Reservations <centurion@legacyhotels.co.za>',
          'Subject: Quote',
        ].join('\n'),
      }),
    ],
  },
  {
    threadIdPrefix: 't-q-phr',
    goldResponded: true,
    messages: [
      row({
        messageId: 't6-trigger',
        threadId: 't-q-phr-0006',
        bodyText: 'Please find attached quotation for your requested dates.',
      }),
    ],
  },
  {
    threadIdPrefix: 't-combo',
    goldResponded: true,
    messages: [
      row({
        messageId: 't7-trigger',
        threadId: 't-combo-0007',
        bodyText: 'Please find attached quotation for your requested dates.',
      }),
      row({
        messageId: 't7-reply',
        threadId: 't-combo-0007',
        direction: 'outbound',
        from: 'marthamthembu@legacyhotels.co.za',
        to: 'guest-c@example.com',
        subject: 'Re: Group quote',
        bodyText: 'Attached updated quote.',
        receivedAt: '2026-08-03T11:00:00.000Z',
      }),
    ],
  },
  {
    threadIdPrefix: 't-un-01',
    goldResponded: false,
    messages: [
      row({
        messageId: 't8-trigger',
        threadId: 't-un-01-0008',
        from: 'guest-p@example.com',
        bodyText: 'Any availability for 10 rooms next month?',
      }),
    ],
  },
  {
    threadIdPrefix: 't-un-02',
    goldResponded: false,
    messages: [
      row({
        messageId: 't9-trigger',
        threadId: 't-un-02-0009',
        from: 'guest-d@example.com',
        subject: 'Group booking RFQ',
        bodyText: 'Looking for 20 rooms in September.',
      }),
    ],
  },
  {
    threadIdPrefix: 't-un-03',
    goldResponded: false,
    messages: [
      row({
        messageId: 't10-trigger',
        threadId: 't-un-03-0010',
        from: 'guest-e@example.com',
        subject: 'Modify booking',
        bodyText: 'Need to change check-in date.',
      }),
    ],
  },
  {
    threadIdPrefix: 't-un-04',
    goldResponded: false,
    messages: [
      row({
        messageId: 't11-trigger',
        threadId: 't-un-04-0011',
        from: 'guest-f@example.com',
        subject: 'Quote request',
        bodyText: 'Rates for 5 nights please.',
      }),
    ],
  },
  {
    threadIdPrefix: 't-un-05',
    goldResponded: false,
    messages: [
      row({
        messageId: 't12-trigger',
        threadId: 't-un-05-0012',
        from: 'guest-g@example.com',
        subject: 'New booking',
        bodyText: 'Book 2 double rooms.',
      }),
    ],
  },
  {
    threadIdPrefix: 't-un-06',
    goldResponded: false,
    messages: [
      row({
        messageId: 't13-trigger',
        threadId: 't-un-06-0013',
        from: 'guest-h@example.com',
        subject: 'Conference block',
        bodyText: 'Need 30 rooms for event.',
      }),
    ],
  },
  {
    threadIdPrefix: 't-un-07',
    goldResponded: false,
    messages: [
      row({
        messageId: 't14-trigger',
        threadId: 't-un-07-0014',
        from: 'guest-i@example.com',
        subject: 'Availability check',
        bodyText: 'Do you have twin rooms?',
      }),
    ],
  },
  {
    threadIdPrefix: 't-un-08',
    goldResponded: false,
    messages: [
      row({
        messageId: 't15-trigger',
        threadId: 't-un-08-0015',
        from: 'guest-j@example.com',
        subject: 'Booking enquiry',
        bodyText: 'Family of four needs accommodation.',
      }),
    ],
  },
  {
    threadIdPrefix: 't-un-09',
    goldResponded: false,
    messages: [
      row({
        messageId: 't16-trigger',
        threadId: 't-un-09-0016',
        from: 'guest-k@example.com',
        subject: 'Rate request',
        bodyText: 'Corporate rate for 3 nights.',
      }),
    ],
  },
  {
    threadIdPrefix: 't-un-10',
    goldResponded: false,
    messages: [
      row({
        messageId: 't17-trigger',
        threadId: 't-un-10-0017',
        from: 'guest-l@example.com',
        subject: 'Room block',
        bodyText: 'Hold 8 rooms for wedding party.',
      }),
    ],
  },
  {
    threadIdPrefix: 't-un-11',
    goldResponded: false,
    messages: [
      row({
        messageId: 't18-trigger',
        threadId: 't-un-11-0018',
        from: 'guest-m@example.com',
        subject: 'Quote follow-up',
        bodyText: 'Still waiting on your quote.',
      }),
    ],
  },
  {
    threadIdPrefix: 't-un-12',
    goldResponded: false,
    messages: [
      row({
        messageId: 't19-trigger',
        threadId: 't-un-12-0019',
        from: 'guest-n@example.com',
        subject: 'Booking request',
        bodyText: 'Need executive room for 4 nights.',
      }),
    ],
  },
  {
    threadIdPrefix: 't-un-13',
    goldResponded: false,
    messages: [
      row({
        messageId: 't20-trigger',
        threadId: 't-un-13-0020',
        from: 'guest-o@example.com',
        subject: 'Group enquiry',
        bodyText: 'School group needs 25 rooms.',
      }),
    ],
  },
];

function buildFixtureEvalInput() {
  const rows: SnapshotRow[] = [...FIXTURE_GLOBAL_OUTBOUNDS];
  const byThread = new Map<string, SnapshotRow[]>();

  for (const fixture of FIXTURE_THREADS) {
    for (const message of fixture.messages) {
      rows.push(message);
      const bucket = byThread.get(message.threadId) ?? [];
      bucket.push(message);
      byThread.set(message.threadId, bucket);
    }
  }

  for (const [threadId, messages] of byThread) {
    messages.sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
    byThread.set(threadId, messages);
  }

  return {
    goldThreads: FIXTURE_THREADS.map((fixture) => ({
      threadId: fixture.threadIdPrefix,
      responded: fixture.goldResponded,
    })),
    rows,
    byThread,
  };
}

function privateGoldAvailable(): boolean {
  try {
    resolvePrivateCorpusRoot(repoRoot);
    return true;
  } catch {
    return false;
  }
}

function passingGoldContractMatrix(
  overrides: Partial<ConfusionMatrixCounts> = {},
): ConfusionMatrixCounts {
  return {
    truePositives: GOLD_RECALL_MIN,
    falseNegatives: 0,
    falsePositives: 0,
    trueNegatives: GOLD_UNANSWERED_TOTAL,
    goldResponded: GOLD_RESPONDED_TOTAL,
    goldUnanswered: GOLD_UNANSWERED_TOTAL,
    goldTotal: GOLD_ACTIONABLE_TOTAL,
    predictedResponded: GOLD_RECALL_MIN,
    skippedThreads: 0,
    ...overrides,
  };
}

describe('conversation signals gold contract gate', () => {
  it('fails closed when any labelled thread is skipped', () => {
    const contract = evaluateGoldContract(passingGoldContractMatrix({ skippedThreads: 1 }));

    expect(contract.pass).toBe(false);
  });

  it('fails closed when any gold denominator does not match the EOD contract', () => {
    for (const field of ['goldTotal', 'goldResponded', 'goldUnanswered'] as const) {
      const contract = evaluateGoldContract(
        passingGoldContractMatrix({ [field]: passingGoldContractMatrix()[field] - 1 }),
      );

      expect(contract.pass, `${field} mismatch should fail the contract`).toBe(false);
    }
  });
});

describe('conversation signals gold fixture subset (CI)', () => {
  it('runs 20 opaque threads with zero false positives on unanswered', () => {
    const result = runConversationSignalsGoldEval(buildFixtureEvalInput());

    expect(FIXTURE_THREADS).toHaveLength(20);
    expect(result.matrix.goldTotal).toBe(20);
    expect(result.matrix.goldResponded).toBe(7);
    expect(result.matrix.goldUnanswered).toBe(13);
    expect(result.matrix.falsePositives).toBe(0);
    expect(result.matrix.truePositives).toBe(7);
    expect(result.matrix.falseNegatives).toBe(0);
    expect(result.cases.every((evalCase) => evalCase.goldResponded === evalCase.predictedResponded)).toBe(
      true,
    );
  });

  it('documents production gate constants', () => {
    expect(GOLD_ACTIONABLE_TOTAL).toBe(483);
    expect(GOLD_RESPONDED_TOTAL).toBe(282);
    expect(GOLD_UNANSWERED_TOTAL).toBe(201);
    expect(GOLD_RECALL_MIN).toBe(268);
    expect(GOLD_FALSE_POSITIVE_MAX).toBe(4);
  });
});

describe.skipIf(!privateGoldAvailable())('conversation signals full private gold', () => {
  it('meets recall and false-positive gate on defensible chart', () => {
    const corpusRoot = resolvePrivateCorpusRoot(repoRoot);
    const result = runConversationSignalsGoldEvalFromCorpus(corpusRoot);

    expect(result.matrix.skippedThreads).toBe(0);
    expect(result.matrix.goldTotal).toBe(GOLD_ACTIONABLE_TOTAL);
    expect(result.matrix.goldResponded).toBe(GOLD_RESPONDED_TOTAL);
    expect(result.matrix.goldUnanswered).toBe(GOLD_UNANSWERED_TOTAL);

    const gate = evaluateGoldGate(result.matrix);
    expect(gate.recallPass).toBe(true);
    expect(gate.falsePositivePass).toBe(true);
    expect(gate.pass).toBe(true);
    expect(result.matrix.truePositives).toBeGreaterThanOrEqual(GOLD_RECALL_MIN);
    expect(result.matrix.falsePositives).toBeLessThanOrEqual(GOLD_FALSE_POSITIVE_MAX);
  });
});

describe('parseConnectedMailboxSnapshot', () => {
  it('parses minimal markdown block shape', async () => {
    const { parseConnectedMailboxSnapshot } = await import(
      '../src/ops/centurion-conversation-signals-eval.js'
    );
    const sample = [
      '# dump',
      '',
      '---',
      '',
      '## Message 1: Test subject',
      '',
      '- **Message ID:** `msg-1`',
      '- **Thread ID:** `thread-1`',
      '- **Direction:** inbound',
      '- **From:** guest@example.com',
      '- **To:** centurion@legacyhotels.co.za',
      '- **CC:** ',
      '- **Received:** 2026-08-01T10:00:00.000Z',
      '',
      '### Text body',
      '',
      '```text',
      'Hello',
      '```',
      '---',
    ].join('\n');

    const parsed = parseConnectedMailboxSnapshot(sample);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      messageId: 'msg-1',
      threadId: 'thread-1',
      direction: 'inbound',
      subject: 'Test subject',
      bodyText: 'Hello',
    });
    expect(parsed.byThread.get('thread-1')).toHaveLength(1);
  });
});
