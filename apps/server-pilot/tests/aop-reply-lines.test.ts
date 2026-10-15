import { describe, expect, it } from 'vitest';
import {
  pickReplyLine,
  pickReplyLineDescription,
  pickReplyLineInputSchema,
  pickReplyLineOutputSchema,
  REPLY_CODE_FOR_WORKFLOW,
} from '../src/ai/aop/reply-lines.js';
import { REPLY_LINES_SOP } from '../src/ai/aop/reply-lines-sop.js';

const CONF = '9999901-1';

function instructionLines(sop: string): string[] {
  return sop
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'));
}

describe('pickReplyLine', () => {
  it('K is a received ack starting Good day, with no sign-off', () => {
    const result = pickReplyLine({ code: 'K' });
    expect(result.code).toBe('K');
    expect(result.line).toMatch(/^Good day,/);
    expect(result.line).toMatch(/received/i);
    expect(result.line).not.toMatch(/kind regards|warm regards|best regards|yours sincerely/i);
    expect(result.line.split(/(?<=[.!?])\s+/).length).toBe(1);
  });

  it('C names amended, cancelled, or released as per the request', () => {
    expect(pickReplyLine({ code: 'C', done: 'amended' }).line).toMatch(
      /amended as per your request/i,
    );
    expect(pickReplyLine({ code: 'C', done: 'cancelled' }).line).toMatch(
      /cancelled as per your request/i,
    );
    expect(pickReplyLine({ code: 'C', done: 'released' }).line).toMatch(
      /released as per your request/i,
    );
    expect(pickReplyLine({ code: 'C', done: 'cancelled', confirmationNumber: CONF }).line).toContain(
      CONF,
    );
  });

  it('B is booked plus pro forma to follow when a confirmation number exists', () => {
    const result = pickReplyLine({ code: 'B', confirmationNumber: CONF });
    expect(result.code).toBe('B');
    expect(result.line).toMatch(/^Good day,/);
    expect(result.line).toMatch(/booked|has been made/i);
    expect(result.line).toMatch(/pro forma/i);
    expect(result.line).toContain(CONF);
  });

  it('S asks the reader to see the attached document when one is attached', () => {
    const plain = pickReplyLine({ code: 'S', attached: true });
    expect(plain.line).toMatch(/^Good day,/);
    expect(plain.line).toMatch(/please see attached/i);
    const invoice = pickReplyLine({ code: 'S', attached: true, documentKind: 'invoice' });
    expect(invoice.line.toLowerCase()).toContain('invoice');
  });

  it('R redirects the sender to contact the destination', () => {
    const result = pickReplyLine({ code: 'R', redirectTo: 'Da Vinci reservations' });
    expect(result.code).toBe('R');
    expect(result.line).toMatch(/^Good day,/);
    expect(result.line).toMatch(/please contact Da Vinci reservations/i);
  });

  it('C without done does not default to amended', () => {
    expect(() => pickReplyLine({ code: 'C' })).toThrow(/done/i);
    expect(() => pickReplyLine({ code: REPLY_CODE_FOR_WORKFLOW.cancel })).toThrow(/done/i);
  });

  it('B without a confirmation number does not claim the booking was made', () => {
    expect(() => pickReplyLine({ code: 'B' })).toThrow(/confirmationNumber/i);
    expect(() => pickReplyLine({ code: REPLY_CODE_FOR_WORKFLOW.create })).toThrow(
      /confirmationNumber/i,
    );
  });

  it('S without an attached document does not say please see attached', () => {
    expect(() => pickReplyLine({ code: 'S' })).toThrow(/attached|documentKind/i);
    expect(() => pickReplyLine({ code: 'S', attached: false, documentKind: 'invoice' })).toThrow(/attached/i);
    expect(() => pickReplyLine({ code: REPLY_CODE_FOR_WORKFLOW.send_document })).toThrow(
      /attached|documentKind/i,
    );
  });

  it('R accepts partnerDestination as the live decision field', () => {
    const result = pickReplyLine({ code: 'R', partnerDestination: 'Accounts' });
    expect(result.line).toMatch(/please contact Accounts/i);
  });

  it('interpolated fields stay one sentence', () => {
    const result = pickReplyLine({
      code: 'R',
      redirectTo: 'Accounts\nSecond sentence',
    });
    expect(result.line).not.toMatch(/\n/);
    expect(result.line.split(/(?<=[.!?])\s+/).length).toBe(1);
    expect(result.line).toMatch(/^Good day, please contact Accounts Second sentence\.$/);
  });

  it('schemas and description are ready for createTool', () => {
    expect(pickReplyLineInputSchema.parse({ code: 'K' }).code).toBe('K');
    expect(pickReplyLineOutputSchema.parse({ code: 'K', line: 'Good day, received.' }).line).toMatch(
      /Good day,/,
    );
    expect(pickReplyLineDescription).toMatch(/pickReplyLine|one-line|when staff would send/i);
  });
});

describe('REPLY_CODE_FOR_WORKFLOW', () => {
  it('maps agent workflows onto K C B S R', () => {
    expect(REPLY_CODE_FOR_WORKFLOW.acknowledge).toBe('K');
    expect(REPLY_CODE_FOR_WORKFLOW.payment_ack).toBe('K');
    expect(REPLY_CODE_FOR_WORKFLOW.amend).toBe('C');
    expect(REPLY_CODE_FOR_WORKFLOW.cancel).toBe('C');
    expect(REPLY_CODE_FOR_WORKFLOW.create).toBe('B');
    expect(REPLY_CODE_FOR_WORKFLOW.send_document).toBe('S');
    expect(REPLY_CODE_FOR_WORKFLOW.forward_to_partner).toBe('R');
  });
});

describe('REPLY_LINES_SOP', () => {
  it('is a short all-workflow SOP that pins replyDraft to the template line', () => {
    expect(instructionLines(REPLY_LINES_SOP).length).toBeLessThanOrEqual(15);
    expect(REPLY_LINES_SOP).toMatch(/silent/i);
    expect(REPLY_LINES_SOP).toMatch(/replyDraft/);
    expect(REPLY_LINES_SOP).toMatch(/Good day,/);
    expect(REPLY_LINES_SOP).toMatch(/acknowledge/);
    expect(REPLY_LINES_SOP).toMatch(/payment_ack/);
    expect(REPLY_LINES_SOP).not.toMatch(/forward_to_partner|please contact/);
  });

  it('opens with its own entry condition and never overrides rules globally', () => {
    const first = instructionLines(REPLY_LINES_SOP)[0] ?? '';
    expect(first).toMatch(/^Applies only when /);
    expect(REPLY_LINES_SOP).not.toMatch(
      /Never skip|Never other|Overrides |beats |Pick one workflow|This SOP wins/i,
    );
  });

  it('does not mention events, conference, venue, or DDR', () => {
    expect(REPLY_LINES_SOP).not.toMatch(/\bevents?\b|\bconference\b|\bDDR\b|\bworkshop\b|\bvenue\b/i);
  });

  it('routes voucher already-paid new bookings to create, not payment_ack', () => {
    expect(REPLY_LINES_SOP).toMatch(/voucher/i);
    expect(REPLY_LINES_SOP).toMatch(/create/);
    expect(REPLY_LINES_SOP).toMatch(/not payment_ack/i);
  });

  it('says which template wins when amend and cancel both fit', () => {
    expect(REPLY_LINES_SOP).toMatch(/cancel wins/i);
  });
});
