import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAmendPayment } from './amend-stay-rules.mjs';
import { fillBlankPaymentFields, readVisibleNamedPaymentInputs } from './stay-lookup.mjs';

function visibleInputDoc(values) {
  return {
    querySelectorAll(selector) {
      const match = /^input\[name="([^"]+)"\]$/.exec(selector);
      if (!match) return [];
      const name = match[1];
      if (!(name in values)) return [];
      return [
        {
          tagName: 'INPUT',
          type: 'text',
          value: values[name],
          getBoundingClientRect: () => ({ width: 10, height: 10 }),
        },
      ];
    },
  };
}

const blankStay = {
  status: 'Reserved',
  confirmation: '57291630-1',
  lastName: 'Labtest',
  guaranteeType: null,
  depositReceived: null,
  balance: '0.00',
};

test('visible named inputs fill blank stay payment fields without commercial; unpaid when 0.00 ZAR', () => {
  const named = readVisibleNamedPaymentInputs(
    visibleInputDoc({
      guaranteetype: 'Non-Guaranteed Individual',
      depositreceived: '0.00 ZAR',
    }),
  );
  const stay = fillBlankPaymentFields(blankStay, named);
  assert.equal(stay.guaranteeType, 'Non-Guaranteed Individual');
  assert.equal(stay.depositReceived, '0.00 ZAR');
  assert.equal(stay.balance, '0.00');
  assert.equal(classifyAmendPayment(stay), 'unpaid');
});

test('blank visible deposit is confirmed blank and unpaid with a non-paying guarantee', () => {
  const named = readVisibleNamedPaymentInputs(
    visibleInputDoc({
      guaranteetype: 'Non-Guaranteed Individual',
      depositreceived: '   ',
    }),
  );
  const stay = fillBlankPaymentFields(blankStay, named);
  assert.equal(stay.guaranteeType, 'Non-Guaranteed Individual');
  assert.equal(stay.depositReceived, '');
  assert.equal(stay.balance, '0.00');
  assert.equal(classifyAmendPayment(stay), 'unpaid');
});

test('missing deposit control stays null and unknown', () => {
  const named = readVisibleNamedPaymentInputs(
    visibleInputDoc({ guaranteetype: 'Non-Guaranteed Individual' }),
  );
  const stay = fillBlankPaymentFields(blankStay, named);
  assert.equal(stay.guaranteeType, 'Non-Guaranteed Individual');
  assert.equal(stay.depositReceived, null);
  assert.equal(stay.balance, '0.00');
  assert.equal(classifyAmendPayment(stay), 'unknown');
});
