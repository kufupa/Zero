import { describe, expect, it } from 'vitest';
import {
  matchPaymentProof,
  matchPaymentProofInputSchema,
} from '../src/ai/aop/payment-proof-match.js';

const stay = {
  confirmationNumber: '9999901-1',
  lastName: 'Smith',
  arrival: '2026-11-12',
  departure: '2026-11-14',
  balanceDue: 1850,
  company: 'Northwind Travel',
};

const other = {
  confirmationNumber: '9999902-1',
  lastName: 'Jones',
  arrival: '2026-11-12',
  departure: '2026-11-14',
  balanceDue: 2400,
  company: 'Contoso Agency',
};

function pop(
  extra: Partial<{
    amount: number | null;
    reference: string | null;
    payerName: string | null;
    paidOn: string | null;
  }> = {},
) {
  return {
    amount: null as number | null,
    reference: null as string | null,
    payerName: null as string | null,
    paidOn: null as string | null,
    ...extra,
  };
}

describe('matchPaymentProof', () => {
  it('matches a stated confirmation number with no surname', () => {
    const result = matchPaymentProof({
      pop: pop({ reference: 'EFT 9999901-1' }),
      candidates: [stay, other],
    });
    expect(result.status).toBe('exact');
    expect(result.confirmationNumber).toBe('9999901-1');
    expect(result.candidates).toEqual(['9999901-1']);
    expect(result.why.some((line) => /conf/i.test(line))).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it('does not treat a confirmation number as a digit substring of the reference', () => {
    const result = matchPaymentProof({
      pop: pop({ reference: 'EFT 0123456' }),
      candidates: [
        {
          ...stay,
          confirmationNumber: '12345',
          lastName: 'Ng',
          company: null,
          balanceDue: null,
        },
        other,
      ],
    });
    expect(result.status).toBe('none');
    expect(result.confirmationNumber).toBeNull();
    expect(result.why).toContain('stated_conf_not_found');
  });

  it('stated confirmation beats amount and name for a different stay', () => {
    const result = matchPaymentProof({
      pop: pop({
        reference: 'EFT 9999901-1',
        amount: 2400,
        payerName: 'Jones Contoso Agency',
        paidOn: '2026-11-10',
      }),
      candidates: [stay, other],
    });
    expect(result.confirmationNumber).not.toBe('9999902-1');
    expect(result.status).toBe('ambiguous');
    expect(result.confirmationNumber).toBeNull();
  });

  it('returns none with stated_conf_not_found when the stated confirmation matches no candidate', () => {
    const result = matchPaymentProof({
      pop: pop({
        reference: 'EFT 8888888',
        amount: 1850,
        payerName: 'Smith Northwind Travel',
        paidOn: '2026-11-10',
      }),
      candidates: [stay, other],
    });
    expect(result.status).toBe('none');
    expect(result.confirmationNumber).toBeNull();
    expect(result.why).toContain('stated_conf_not_found');
    expect(result.candidates).toEqual([]);
  });

  it('returns ambiguous when a base confirmation matches two legs', () => {
    const result = matchPaymentProof({
      pop: pop({ reference: 'EFT 9999901' }),
      candidates: [
        stay,
        { ...stay, confirmationNumber: '9999901-2' },
        other,
      ],
    });
    expect(result.status).toBe('ambiguous');
    expect(result.confirmationNumber).toBeNull();
    expect(result.candidates).toEqual(['9999901-1', '9999901-2']);
    expect(result.why).toContain('stated_conf_not_found');
  });

  it('matches a full base-N token to only that leg', () => {
    const result = matchPaymentProof({
      pop: pop({ reference: 'EFT 9999901-1' }),
      candidates: [stay, { ...stay, confirmationNumber: '9999901-2' }, other],
    });
    expect(result.status).toBe('exact');
    expect(result.confirmationNumber).toBe('9999901-1');
  });

  it('ignores paidOn that is not an ISO calendar day', () => {
    const slash = matchPaymentProof({
      pop: pop({ paidOn: '01/02/2027' }),
      candidates: [
        { ...stay, lastName: 'Ng', departure: '12/31/2026' },
        { ...other, lastName: 'Ng', departure: '01/01/2027' },
      ],
    });
    expect(slash.status).toBe('none');
    expect(slash.confirmationNumber).toBeNull();
  });

  it('treats amount equal to balanceDue within R1 as a match signal', () => {
    const result = matchPaymentProof({
      pop: pop({ amount: 1850.4 }),
      candidates: [stay, other],
    });
    expect(result.status).toBe('exact');
    expect(result.confirmationNumber).toBe('9999901-1');
    expect(result.why.some((line) => /amount|balance/i.test(line))).toBe(true);
  });

  it('does not treat an amount more than R1 off as a hit', () => {
    const result = matchPaymentProof({
      pop: pop({ amount: 1852 }),
      candidates: [stay, other],
    });
    expect(result.status).toBe('none');
    expect(result.confirmationNumber).toBeNull();
  });

  it('matches surname or company in the payer name or the reference', () => {
    const byName = matchPaymentProof({
      pop: pop({ payerName: 'A. Smith' }),
      candidates: [stay, other],
    });
    expect(byName.status).toBe('exact');
    expect(byName.confirmationNumber).toBe('9999901-1');

    const byCompany = matchPaymentProof({
      pop: pop({ reference: 'Northwind Travel remittance' }),
      candidates: [stay, other],
    });
    expect(byCompany.status).toBe('exact');
    expect(byCompany.confirmationNumber).toBe('9999901-1');
  });

  it('adds a signal when paidOn is before departure', () => {
    const withDate = matchPaymentProof({
      pop: pop({ payerName: 'Smith', paidOn: '2026-11-10' }),
      candidates: [stay, other],
    });
    expect(withDate.status).toBe('exact');
    expect(withDate.why.some((line) => /paid|depart/i.test(line))).toBe(true);

    const afterStay = matchPaymentProof({
      pop: pop({ paidOn: '2026-11-20' }),
      candidates: [stay, other],
    });
    expect(afterStay.status).toBe('none');
  });

  it('does not treat a date-only signal as exact', () => {
    const result = matchPaymentProof({
      pop: pop({ paidOn: '2026-11-10' }),
      candidates: [stay],
    });
    expect(result.status).toBe('none');
    expect(result.confirmationNumber).toBeNull();
    expect(result.score).toBe(1);
  });

  it('returns ambiguous on a tie and never picks a confirmation number', () => {
    const twins = [
      { ...stay, confirmationNumber: '9999901-1', lastName: 'Lee', balanceDue: 1000 },
      { ...other, confirmationNumber: '9999902-1', lastName: 'Lee', balanceDue: 1000 },
    ];
    const result = matchPaymentProof({
      pop: pop({ payerName: 'Lee', amount: 1000 }),
      candidates: twins,
    });
    expect(result.status).toBe('ambiguous');
    expect(result.confirmationNumber).toBeNull();
    expect(result.candidates).toEqual(['9999901-1', '9999902-1']);
  });

  it('is exact when one stay wins by a score gap', () => {
    const result = matchPaymentProof({
      pop: pop({
        amount: 1850,
        payerName: 'Smith',
      }),
      candidates: [stay, { ...other, lastName: 'Smith' }],
    });
    expect(result.status).toBe('exact');
    expect(result.confirmationNumber).toBe('9999901-1');
  });

  it('returns none when there is no signal', () => {
    const result = matchPaymentProof({
      pop: pop({ reference: 'bank transfer', payerName: 'Unknown', amount: 50 }),
      candidates: [stay, other],
    });
    expect(result.status).toBe('none');
    expect(result.confirmationNumber).toBeNull();
    expect(result.score).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it('does not parse amounts from free text; the caller supplies numbers', () => {
    const result = matchPaymentProof({
      pop: pop({ reference: 'Paid R1850.00 for Smith' }),
      candidates: [stay, other],
    });
    expect(result.status).toBe('exact');
    expect(result.confirmationNumber).toBe('9999901-1');
    expect(result.why.some((line) => /amount|balance/i.test(line))).toBe(false);
  });

  it('accepts the documented input schema', () => {
    const parsed = matchPaymentProofInputSchema.parse({
      pop: { amount: 10, reference: 'x', payerName: null, paidOn: null },
      candidates: [
        {
          confirmationNumber: '9999903-1',
          lastName: 'Ng',
          arrival: '2026-12-01',
          departure: '2026-12-02',
        },
      ],
    });
    expect(parsed.candidates[0]?.confirmationNumber).toBe('9999903-1');
  });
});
