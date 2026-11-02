import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavedChildStageRequestGate } from './saved-stay-child-request-gate.mjs';

const origin = 'https://hmsweb.hms.eu1.inforcloudsuite.com';
const frame = {};
const input = () => ({ frame, stayId: '5', adults: 2, priorAges: [8, 12],
  priorBands: { child1: 0, child2: 2, child3: 0 }, nextAges: [8, 12, 5], deadlineAt: performance.now() + 30_000 });
const request = (path, params, extra = {}) => {
  const body = new URLSearchParams({ params: JSON.stringify(params), ONLY_DATA_REQUIRED: 'true' });
  if (extra.duplicate) body.append('params', '{}');
  return { url: () => `${origin}${path}${extra.query || ''}`, method: () => extra.method || 'POST',
    frame: () => extra.frame || frame, headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }),
    postData: () => body.toString() };
};
const read = (extra) => request('/web/base/OSRESV.HDR.getChildAges',
  { propertyCode: 'HRCEN', reservationStayId: '5', childAges: [8, 12] }, extra);
const validate = (extra) => request('/web/base/OSRESV.HDR.validateChildAgeDetails',
  { propertyCode: 'HRCEN', reservationStayId: '5', childAges: [8, 12, 5], adultCount: '2', childCount: '3',
    updateChildCategories: true, activeChildCategories: 3, confirmChildCategory: false,
    childCategoryCounts: { child1: 0, child2: 2, child3: 0 } }, extra);

test('allows one exact child read then one exact validation only after verified response', () => {
  const gate = createSavedChildStageRequestGate(input());
  assert.equal(gate.armValidation(), false);
  assert.equal(gate.armRead(), true);
  assert.equal(gate.armRead(), false);
  const readRequest = read();
  assert.equal(gate.consume(readRequest), true);
  assert.equal(gate.isReadRequest(readRequest), true);
  assert.equal(gate.isReadRequest(read()), false);
  assert.equal(gate.armValidation(), false);
  assert.equal(gate.markReadVerified(), true);
  assert.equal(gate.armValidation(), true);
  const validationRequest = validate();
  assert.equal(gate.consume(validationRequest), true);
  assert.equal(gate.isValidationRequest(validationRequest), true);
  assert.equal(gate.isValidationRequest(validate()), false);
  assert.equal(gate.consume(validate()), false);
  assert.equal(gate.armRead(), false);
});

test('rejects a different frame, query, duplicate payload, or Save and closes the gate', () => {
  for (const candidate of [read({ frame: {} }), read({ query: '?extra=1' }), read({ duplicate: true }),
    request('/web/base/OSRESV.HDR?pageaction=SAVE', {})]) {
    const gate = createSavedChildStageRequestGate(input());
    assert.equal(gate.armRead(), true);
    assert.equal(gate.consume(candidate), false);
    assert.equal(gate.consume(read()), false);
    assert.equal(gate.markReadVerified(), false);
  }
});

test('copies occupancy inputs and refuses contradictory, missing, or expired preimages', () => {
  const config = input();
  const gate = createSavedChildStageRequestGate(config);
  config.priorAges[0] = 7; config.nextAges[0] = 7; config.priorBands.child2 = 0;
  assert.equal(gate.armRead(), true);
  assert.equal(gate.consume(read()), true);
  assert.equal(gate.markReadVerified(), true);
  assert.equal(gate.armValidation(), true);
  assert.equal(gate.consume(validate()), true);
  for (const invalid of [{ ...input(), priorAges: null }, { ...input(), nextAges: [18] },
    { ...input(), priorBands: { child1: 0, child2: 0, child3: 2 } },
    { ...input(), stayId: '' }, { ...input(), deadlineAt: performance.now() - 1 }]) {
    assert.throws(() => createSavedChildStageRequestGate(invalid), /CHILD_STAGE_GATE_INPUT_INVALID/);
  }
});

test('closing gate prevents late reads and validation', () => {
  const gate = createSavedChildStageRequestGate(input());
  assert.equal(gate.armRead(), true);
  gate.close();
  assert.equal(gate.consume(read()), false);
  assert.equal(gate.markReadVerified(), false);
  assert.equal(gate.armValidation(), false);
});
