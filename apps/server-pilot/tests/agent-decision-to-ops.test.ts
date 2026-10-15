import { describe, expect, it } from 'vitest';
import {
  decisionToOperations,
  snapshotRowToAgentCase,
  type SnapshotRow,
} from '../src/ai/agent-decision-to-ops.js';
import type { ReservationistDecision } from '../src/ai/reservationist-decision.js';
import type { GoldOperation } from '../src/ai/same-move-ops.js';

function decision(workflow: ReservationistDecision['workflow']): ReservationistDecision {
  return { workflow, stayAsk: null, missing: [], replyDraft: '', rationale: '' };
}

function requiredOp(operation: string, candidateTool: string): GoldOperation {
  return {
    operation,
    needLevel: 'required',
    requiredFields: [],
    candidateTool,
    unknownReason: null,
  };
}

function notNeededOp(operation: string, unknownReason: string | null = null): GoldOperation {
  return {
    operation,
    needLevel: 'not_needed',
    requiredFields: [],
    candidateTool: null,
    unknownReason,
  };
}

describe('decisionToOperations', () => {
  it('maps quote/create/amend/cancel workflows onto GoldOperation with goldOp needLevel and candidateTool', () => {
    expect(decisionToOperations(decision('quote'), [])).toEqual([
      requiredOp('quote', 'hms_quote_stay'),
    ]);
    expect(decisionToOperations(decision('create'), [])).toEqual([
      requiredOp('create', 'hms_create_reservation'),
    ]);
    expect(decisionToOperations(decision('amend'), [])).toEqual([
      requiredOp('amend', 'hms_amend_reservation'),
    ]);
    expect(decisionToOperations(decision('cancel'), [])).toEqual([
      requiredOp('cancel', 'hms_cancel_reservation'),
    ]);
  });

  it('maps skip and spam to none', () => {
    expect(decisionToOperations(decision('skip'), [])).toEqual([notNeededOp('none')]);
    expect(decisionToOperations(decision('spam'), [])).toEqual([notNeededOp('none')]);
  });

  it('maps other to unknown with unknownReason other', () => {
    expect(decisionToOperations(decision('other'), [])).toEqual([notNeededOp('unknown', 'other')]);
  });

  it('adds a read op when party_lookup was called', () => {
    expect(
      decisionToOperations(decision('quote'), [{ toolName: 'party_lookup' }]),
    ).toEqual([
      requiredOp('quote', 'hms_quote_stay'),
      requiredOp('read', 'hms_read_reservation'),
    ]);
  });

  it('dedupes by operation when party_lookup is repeated', () => {
    const ops = decisionToOperations(decision('create'), [
      { toolName: 'party_lookup' },
      { toolName: 'quote_stay' },
      { toolName: 'party_lookup' },
    ]);
    expect(ops.map((row) => row.operation)).toEqual(['create', 'read']);
  });
});

function mail(overrides: Partial<SnapshotRow['inbound']> & Pick<SnapshotRow['inbound'], 'id'>): SnapshotRow['inbound'] {
  return {
    direction: 'inbound',
    from_address: 'guest@example.com',
    to_addresses: ['hotel@example.com'],
    cc_addresses: [],
    subject: 'Room request',
    sent_at: '2026-10-01T08:00:00Z',
    received_at: '2026-10-01T08:01:00Z',
    body: 'Need two rooms next week.',
    body_is_html: false,
    attachments: [{ filename: 'request.pdf' }],
    ...overrides,
  };
}

describe('snapshotRowToAgentCase', () => {
  it('builds trigger+context CaseMessages from a synthetic snapshot row and ignores outbound', () => {
    const row: SnapshotRow = {
      pair_id: 'pair-synth-1',
      mailbox: 'mailbox-synth',
      thread_id: 'thread-synth',
      inbound: mail({
        id: 'msg-in-1',
        received_at: '2026-10-02T09:00:00Z',
        body: 'Please quote 12 October.',
        subject: 'October stay',
      }),
      context: [
        mail({
          id: 'msg-ctx-1',
          direction: 'outbound',
          from_address: 'hotel@example.com',
          received_at: '2026-10-01T12:00:00Z',
          subject: 'Earlier reply',
          body: 'We can look at dates.',
        }),
      ],
      outbound: mail({
        id: 'msg-out-secret',
        direction: 'outbound',
        from_address: 'hotel@example.com',
        subject: 'ANSWER-KEY-SUBJECT',
        body: 'ANSWER-KEY-BODY',
        received_at: '2026-10-02T10:00:00Z',
      }),
    };

    const built = snapshotRowToAgentCase(row);

    expect(built.trigger).toEqual({
      id: 'msg-in-1',
      direction: 'inbound',
      eventAt: '2026-10-02T09:00:00Z',
      from: 'guest@example.com',
      subject: 'October stay',
      text: 'Please quote 12 October.',
    });
    expect(built.context).toEqual([
      {
        id: 'msg-ctx-1',
        direction: 'outbound',
        eventAt: '2026-10-01T12:00:00Z',
        from: 'hotel@example.com',
        subject: 'Earlier reply',
        text: 'We can look at dates.',
      },
    ]);
    expect(JSON.stringify(built)).not.toMatch(/ANSWER-KEY/);
    expect(JSON.stringify(built)).not.toMatch(/msg-out-secret/);
  });
});
