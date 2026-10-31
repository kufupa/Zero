import assert from 'node:assert/strict';
import test from 'node:test';
import { correlateAgencyReferenceField } from './lookup.mjs';

test('agency reference blanks are proven only by correlated response and grid properties', () => {
  assert.deepEqual(correlateAgencyReferenceField({ iatanumber: null }, { iatanumber: '' }, 'iatanumber'), {
    outcome: 'response_grid_correlated', value: null,
  });
  assert.deepEqual(correlateAgencyReferenceField({}, { iatanumber: '' }, 'iatanumber'), {
    outcome: 'response_field_missing',
  });
  assert.deepEqual(correlateAgencyReferenceField({ iatanumber: '' }, {}, 'iatanumber'), {
    outcome: 'grid_field_missing',
  });
  assert.deepEqual(correlateAgencyReferenceField({ iatanumber: '123' }, { iatanumber: '456' }, 'iatanumber'), {
    outcome: 'response_grid_mismatch',
  });
  assert.deepEqual(correlateAgencyReferenceField({ iatanumber: undefined }, { iatanumber: null }, 'iatanumber'), {
    outcome: 'response_value_unverified',
  });
  assert.deepEqual(correlateAgencyReferenceField({ iatanumber: '' }, null, 'iatanumber'), {
    outcome: 'grid_row_missing',
  });
});
