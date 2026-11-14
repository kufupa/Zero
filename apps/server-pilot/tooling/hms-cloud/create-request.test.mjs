import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCreateRequest } from './create-request.mjs';

const STAY = {
  firstName: 'Proof',
  lastName: 'Labtest',
  arrival: '2027-07-22',
  departure: '2027-07-23',
  roomType: 'STKNG',
  adults: 1,
  sourceOfBusiness: 'Walk in',
  ratePlan: 'BAR',
  track: 'BAR',
  guaranteeType: 'Non-Guaranteed Individual',
};

test('offline create request test does not opt into pilot RDS', () => {
  assert.notEqual(process.env.VITEST_ALLOW_PILOT_RDS, '1');
  assert.equal(/nava-zero-mail-pilot/i.test(process.env.DATABASE_URL || ''), false);
});

test('property-driven guarantee accepts CCIATA and rejects unknown labels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-request-test-'));
  const file = join(dir, 'request.json');
  try {
    await writeFile(file, JSON.stringify({ ...STAY, guaranteeType: 'CCIATA' }));
    const args = ['--property', 'HRDAV', '--request', file];
    const accepted = await loadCreateRequest(args);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.request.guaranteeType, 'Guaranteed By Credit Card and Agent');
    await writeFile(file, JSON.stringify({ ...STAY, guaranteeType: 'unknown' }));
    assert.equal((await loadCreateRequest(args)).error, 'guarantee_type_unknown');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
