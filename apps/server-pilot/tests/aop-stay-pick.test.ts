import { describe, expect, it } from 'vitest';
import { pickStayFromFindRows } from '../src/ai/aop/stay-pick.js';

const row = (partial: Record<string, unknown> = {}) => ({
  confirmation: '9999901-1',
  lastName: 'Smith',
  arrival: '2026-11-12',
  departure: '2026-11-14',
  status: 'Reserved',
  ...partial,
});
const ask = { lastName: 'Smith', arrival: '2026-11-12', departure: '2026-11-14' };

describe('pickStayFromFindRows', () => {
  it('picks a unique live surname+arrival match', () => {
    expect(pickStayFromFindRows({ ask, rows: [row()], workflow: 'amend' })).toEqual({
      status: 'pick',
      confirmationNumber: '9999901-1',
      why: ['exact surname and arrival'],
    });
  });

  it('returns check_conf when two live stays match', () => {
    const result = pickStayFromFindRows({
      ask,
      rows: [row(), row({ confirmation: '9999902-1' })],
      workflow: 'amend',
    });
    expect(result.status).toBe('check_conf');
    expect(result.confirmationNumber).toBeNull();
  });

  it('returns check_conf when a stated confirmation is not in the rows', () => {
    const result = pickStayFromFindRows({
      ask: { ...ask, confirmationNumber: '9999901-1' },
      rows: [row({ confirmation: '9999902-1' })],
      workflow: 'amend',
    });
    expect(result.status).toBe('check_conf');
    expect(result.why.some((line) => /stated_conf_not_found/i.test(line))).toBe(true);
  });

  it('ignores cancelled rows when picking a live match', () => {
    const result = pickStayFromFindRows({
      ask,
      rows: [row({ confirmation: '9999908-1', status: 'Cancelled' }), row()],
      workflow: 'amend',
    });
    expect(result).toMatchObject({ status: 'pick', confirmationNumber: '9999901-1' });
  });

  it('returns check_conf when post_payment C1 and C3 disagree', () => {
    const result = pickStayFromFindRows({
      ask,
      rows: [row(), row({ confirmation: '9999902-1', lastName: 'Jones', arrival: '2026-12-01', balanceDue: 2400 })],
      workflow: 'post_payment',
      pop: { amount: null, reference: 'EFT 9999902-1', payerName: null, paidOn: null },
    });
    expect(result).toMatchObject({ status: 'check_conf', confirmationNumber: null });
  });

  it('picks the stay whose balance matches an attachment-only POP amount', () => {
    const result = pickStayFromFindRows({
      ask: { lastName: 'Guest', arrival: '2026-10-01' },
      rows: [
        row({ balanceDue: 1850 }),
        row({ confirmation: '9999902-1', lastName: 'Jones', arrival: '2026-12-01', balanceDue: 2400 }),
      ],
      workflow: 'post_payment',
      selection: {
        bodyText: 'Please find proof of payment attached.',
        attachments: [{ text: 'ABSA EFT\nAmount R1,850.00' }],
      },
    });
    expect(result.status).toBe('pick');
    expect(result.confirmationNumber).toBe('9999901-1');
  });

  it('ignores two distinct POP amounts and falls back to the confirmation only', () => {
    const result = pickStayFromFindRows({
      ask: { lastName: 'Guest', arrival: '2026-10-01' },
      rows: [
        row({ balanceDue: 1850 }),
        row({ confirmation: '9999902-1', lastName: 'Jones', arrival: '2026-12-01', balanceDue: 2400 }),
      ],
      workflow: 'post_payment',
      selection: {
        bodyText: 'Please find proof of payment attached.',
        attachments: [{ text: 'Paid R2,400.00 and R1,850.00\nReference 9999901' }],
      },
    });
    expect(result.status).toBe('pick');
    expect(result.confirmationNumber).toBe('9999901-1');
  });

  it('fills C1 voucherNumber from attachment text when the ask lacks it', () => {
    const result = pickStayFromFindRows({
      ask: { lastName: 'Jones', arrival: '2026-12-01' },
      rows: [
        row({
          confirmation: '9999903-1',
          lastName: 'Other',
          arrival: '2026-12-20',
          notes: 'Agent voucher VCH-99993 attached',
        }),
      ],
      workflow: 'amend',
      selection: {
        bodyText: 'Please book as per the attached voucher.',
        attachments: [{ text: 'Voucher number: VCH-99993\nGuest: Other' }],
      },
    });
    expect(result.status).toBe('pick');
    expect(result.confirmationNumber).toBe('9999903-1');
  });
});
