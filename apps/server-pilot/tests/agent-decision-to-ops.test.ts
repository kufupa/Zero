import { describe, expect, it } from 'vitest';
import {
  agentThreadPrompt,
  decisionToOperations,
  snapshotRowToAgentCase,
  type SnapshotRow,
} from '../src/ai/agent-decision-to-ops.js';
import { staffMoveToOperations } from '../src/ai/gold-pair-join.js';
import type { ReservationistDecision } from '../src/ai/reservationist-decision.js';
import { opsMatch, type GoldOperation } from '../src/ai/same-move-ops.js';

function decision(
  workflow: ReservationistDecision['workflow'],
  extra: Partial<ReservationistDecision> = {},
): ReservationistDecision {
  return { workflow, stayAsk: null, missing: [], replyDraft: '', rationale: '', ...extra };
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

  it('does not add read for party_lookup; gold priced_quote stays quote-only', () => {
    const predicted = decisionToOperations(decision('quote'), [{ toolName: 'party_lookup' }]);
    expect(predicted).toEqual([requiredOp('quote', 'hms_quote_stay')]);
    expect(opsMatch(predicted, staffMoveToOperations('priced_quote'))).toBe(true);
  });

  it('maps catalog moves onto gold ops', () => {
    expect(decisionToOperations(decision('forward_to_partner'), [])).toEqual([
      {
        operation: 'partner',
        needLevel: 'required',
        requiredFields: [],
        candidateTool: null,
        unknownReason: null,
      },
    ]);
    expect(decisionToOperations(decision('send_document'), [])).toEqual([
      requiredOp('document', 'hms_generate_invoice'),
    ]);
    expect(decisionToOperations(decision('payment_ack'), [])).toEqual([
      requiredOp('post_payment', 'hms_post_payment'),
    ]);
    expect(decisionToOperations(decision('clarify'), [])).toEqual([
      notNeededOp('unknown', 'clarify'),
    ]);
    expect(decisionToOperations(decision('acknowledge'), [])).toEqual([notNeededOp('none')]);
  });

  it('maps hms_todo onto its target op and never invents a completed write', () => {
    expect(
      decisionToOperations(
        decision('hms_todo', {
          todoTarget: 'post_payment',
          todoReason: 'POP posting is staff-only.',
          todoNextStep: 'Staff posts payment on the folio.',
        }),
        [],
      ),
    ).toEqual([requiredOp('post_payment', 'hms_post_payment')]);
    expect(decisionToOperations(decision('hms_todo'), [])).toEqual([
      notNeededOp('unknown', 'hms_todo'),
    ]);
  });

  it('ignores repeated party_lookup when mapping create', () => {
    const ops = decisionToOperations(decision('create'), [
      { toolName: 'party_lookup' },
      { toolName: 'quote_stay' },
      { toolName: 'party_lookup' },
    ]);
    expect(ops.map((row) => row.operation)).toEqual(['create']);
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

  it('converts HTML bodies to plain text before the 20k emailBlock cap', () => {
    const request = 'Please quote 12 October.';
    const html = `<html><head><style>${'x'.repeat(25_000)}</style></head><body><p>${request}</p></body></html>`;
    const built = snapshotRowToAgentCase({
      inbound: mail({
        id: 'msg-html-1',
        body: html,
        body_is_html: true,
        subject: 'October stay',
      }),
    });

    expect(built.trigger.text).not.toMatch(/<style|<p>|<\/p>|<html>/i);
    expect(agentThreadPrompt(built)).toContain(request);
  });

  it('drops context not strictly earlier than inbound received/sent time', () => {
    const built = snapshotRowToAgentCase({
      inbound: mail({
        id: 'msg-in-1',
        received_at: '2026-10-02T09:00:00Z',
        sent_at: '2026-10-02T08:59:00Z',
        body: 'Please quote 12 October.',
        subject: 'October stay',
      }),
      context: [
        mail({
          id: 'msg-ctx-earlier',
          direction: 'outbound',
          from_address: 'hotel@example.com',
          received_at: '2026-10-02T08:00:00Z',
          subject: 'Earlier reply',
          body: 'We can look at dates.',
        }),
        mail({
          id: 'msg-ctx-same',
          direction: 'outbound',
          from_address: 'hotel@example.com',
          received_at: '2026-10-02T09:00:00Z',
          subject: 'Same-instant leak',
          body: 'Same-time staff note.',
        }),
        mail({
          id: 'msg-ctx-later',
          direction: 'outbound',
          from_address: 'hotel@example.com',
          received_at: '2026-10-02T10:00:00Z',
          subject: 'ANSWER-KEY-SUBJECT',
          body: 'ANSWER-KEY-BODY 450 ZAR B&B',
        }),
        mail({
          id: 'msg-ctx-sent-only-earlier',
          direction: 'outbound',
          from_address: 'hotel@example.com',
          received_at: null,
          sent_at: '2026-10-02T08:30:00Z',
          subject: 'Sent-only earlier',
          body: 'Prior staff note via sent_at.',
        }),
        mail({
          id: 'msg-ctx-sent-only-later',
          direction: 'outbound',
          from_address: 'hotel@example.com',
          received_at: null,
          sent_at: '2026-10-02T10:30:00Z',
          subject: 'Sent-only leak',
          body: 'Later staff quote via sent_at.',
        }),
      ],
    });

    expect(built.context.map((row) => row.id)).toEqual([
      'msg-ctx-earlier',
      'msg-ctx-sent-only-earlier',
    ]);
    const prompt = agentThreadPrompt(built);
    expect(prompt).toContain('Earlier reply');
    expect(prompt).toContain('Sent-only earlier');
    expect(prompt).not.toMatch(/ANSWER-KEY/);
    expect(prompt).not.toContain('450 ZAR');
    expect(prompt).not.toContain('Same-instant leak');
    expect(prompt).not.toContain('Sent-only leak');
  });
});
