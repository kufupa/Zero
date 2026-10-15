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

  it('B is booked plus pro forma to follow', () => {
    const result = pickReplyLine({ code: 'B' });
    expect(result.code).toBe('B');
    expect(result.line).toMatch(/^Good day,/);
    expect(result.line).toMatch(/booked|booking has been made/i);
    expect(result.line).toMatch(/pro forma/i);
  });

  it('S asks the reader to see the attached document', () => {
    const plain = pickReplyLine({ code: 'S' });
    expect(plain.line).toMatch(/^Good day,/);
    expect(plain.line).toMatch(/please see attached/i);
    const invoice = pickReplyLine({ code: 'S', documentKind: 'invoice' });
    expect(invoice.line.toLowerCase()).toContain('invoice');
  });

  it('R redirects the sender to contact the destination', () => {
    const result = pickReplyLine({ code: 'R', redirectTo: 'Da Vinci reservations' });
    expect(result.code).toBe('R');
    expect(result.line).toMatch(/^Good day,/);
    expect(result.line).toMatch(/please contact Da Vinci reservations/i);
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
    expect(REPLY_LINES_SOP).toMatch(/forward_to_partner/);
  });
});
