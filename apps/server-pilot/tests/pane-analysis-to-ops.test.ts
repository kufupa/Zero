import { describe, expect, it } from 'vitest';
import { decisionToOperations } from '../src/ai/agent-decision-to-ops.js';
import {
  paneAnalysisToOperations,
  snapshotRowToPaneSelection,
} from '../src/ai/pane-analysis-to-ops.js';
import type { ReservationistDecision } from '../src/ai/reservationist-decision.js';
import type { SnapshotRow } from '../src/ai/agent-decision-to-ops.js';
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

function mail(
  overrides: Partial<SnapshotRow['inbound']> & Pick<SnapshotRow['inbound'], 'id'>,
): SnapshotRow['inbound'] {
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

describe('paneAnalysisToOperations', () => {
  it('maps luna quote/create_booking/amend/cancel onto goldOp needLevel and candidateTool', () => {
    expect(paneAnalysisToOperations({ workflow: 'quote' })).toEqual([
      requiredOp('quote', 'hms_quote_stay'),
    ]);
    expect(paneAnalysisToOperations({ workflow: 'create_booking' })).toEqual([
      requiredOp('create', 'hms_create_reservation'),
    ]);
    expect(paneAnalysisToOperations({ workflow: 'amend' })).toEqual([
      requiredOp('amend', 'hms_amend_reservation'),
    ]);
    expect(paneAnalysisToOperations({ workflow: 'cancel' })).toEqual([
      requiredOp('cancel', 'hms_cancel_reservation'),
    ]);
  });

  it('maps other to unknown with unknownReason other', () => {
    expect(paneAnalysisToOperations({ workflow: 'other' })).toEqual([
      {
        operation: 'unknown',
        needLevel: 'not_needed',
        requiredFields: [],
        candidateTool: null,
        unknownReason: 'other',
      },
    ]);
  });

  it('maps skip to none with unknownReason null', () => {
    expect(paneAnalysisToOperations({ workflow: 'skip' })).toEqual([
      {
        operation: 'none',
        needLevel: 'not_needed',
        requiredFields: [],
        candidateTool: null,
        unknownReason: null,
      },
    ]);
    expect(paneAnalysisToOperations({ workflow: 'skip' })).toEqual(
      decisionToOperations(decision('skip'), []),
    );
  });

  it('maps hms_todo create onto goldOp create, and missing target onto unknown', () => {
    expect(paneAnalysisToOperations({ workflow: 'hms_todo', todoTarget: 'create' })).toEqual([
      requiredOp('create', 'hms_create_reservation'),
    ]);
    expect(paneAnalysisToOperations({ workflow: 'hms_todo' })).toEqual([
      {
        operation: 'unknown',
        needLevel: 'not_needed',
        requiredFields: [],
        candidateTool: null,
        unknownReason: 'hms_todo',
      },
    ]);
  });

  it('matches decisionToOperations goldOp semantics for the shared workflows', () => {
    expect(paneAnalysisToOperations({ workflow: 'quote' })).toEqual(
      decisionToOperations(decision('quote'), []),
    );
    expect(paneAnalysisToOperations({ workflow: 'create_booking' })).toEqual(
      decisionToOperations(decision('create'), []),
    );
    expect(paneAnalysisToOperations({ workflow: 'amend' })).toEqual(
      decisionToOperations(decision('amend'), []),
    );
    expect(paneAnalysisToOperations({ workflow: 'cancel' })).toEqual(
      decisionToOperations(decision('cancel'), []),
    );
    expect(paneAnalysisToOperations({ workflow: 'other' })).toEqual(
      decisionToOperations(decision('other'), []),
    );
  });
});

describe('snapshotRowToPaneSelection', () => {
  it('builds pane selection from a synthetic snapshot row and ignores outbound', () => {
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
        mail({
          id: 'msg-ctx-later',
          direction: 'outbound',
          from_address: 'hotel@example.com',
          received_at: '2026-10-02T10:00:00Z',
          subject: 'ANSWER-KEY-SUBJECT',
          body: 'ANSWER-KEY-BODY',
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

    const selection = snapshotRowToPaneSelection(row);

    expect(selection).toMatchObject({
      subject: 'October stay',
      bodyText: 'Please quote 12 October.',
      receivedAt: '2026-10-02T09:00:00Z',
      messageId: 'msg-in-1',
      fromAddress: 'guest@example.com',
      attachments: [],
    });
    expect(selection.preceding.map((message) => message.bodyText)).toEqual(['We can look at dates.']);
    expect(JSON.stringify(selection)).not.toMatch(/ANSWER-KEY/);
    expect(JSON.stringify(selection)).not.toMatch(/msg-out-secret/);
  });
});
