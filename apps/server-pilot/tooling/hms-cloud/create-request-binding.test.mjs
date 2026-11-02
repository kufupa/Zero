import test from 'node:test';
import assert from 'node:assert/strict';
import { digestCloudCreateRequest, normalizeCloudCreateRequest } from './create-request-binding.mjs';

const request = {
  propertyCode: 'HRCEN',
  guest: { nativeId: '123', firstName: 'Proof', lastName: 'Labtest' },
  stay: { arrival: '2027-03-15', departure: '2027-03-17', adults: 2, childAges: [8, 12] },
  room: { roomType: 'DLXKNG', ratePlan: 'BAR' },
  guaranteeType: 'NGI',
  sourceOfBusiness: { nativeCode: 'EMA', description: 'E-Mail' },
  parties: {
    agency: { nativeId: '99', name: 'Example Agency' },
    organization: { nativeId: '41', name: 'Example Company' },
    arAccount: { nativeId: '75', name: 'Example Account' },
  },
  note: 'One room only',
  cmsMessageId: '03',
  sendHmsConfirmation: { kind: 'never' },
};

test('normalizes property-bound, one-room create request including independent parties', () => {
  const result = normalizeCloudCreateRequest(request);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.request.version, 'hms-cloud-create-request/v1');
  assert.deepEqual(result.request.parties, {
    bookingAgency: { nativeId: '99', name: 'Example Agency' },
    organization: { nativeId: '41', name: 'Example Company' },
    arAccount: { nativeId: '75', name: 'Example Account' },
  });
  assert.deepEqual(result.request.sendHmsConfirmation, { kind: 'never' });
});

test('digest is deterministic across object key order and sensitive to request changes', () => {
  const original = digestCloudCreateRequest(request);
  const reordered = digestCloudCreateRequest({
    sendHmsConfirmation: { kind: 'never' }, cmsMessageId: '03', note: 'One room only',
    parties: { arAccount: request.parties.arAccount, organization: request.parties.organization,
      agency: request.parties.agency },
    sourceOfBusiness: request.sourceOfBusiness, guaranteeType: 'NGI',
    room: { ratePlan: 'BAR', roomType: 'DLXKNG' },
    stay: { childAges: [8, 12], adults: 2, departure: '2027-03-17', arrival: '2027-03-15' },
    guest: { lastName: 'Labtest', firstName: 'Proof', nativeId: '123' }, propertyCode: 'HRCEN',
  });
  assert.equal(original.normalizedRequestDigest, reordered.normalizedRequestDigest);
  for (const changed of [
    { ...request, propertyCode: 'HRDAV' },
    { ...request, guest: { ...request.guest, nativeId: '124' } },
    { ...request, stay: { ...request.stay, departure: '2027-03-18' } },
    { ...request, room: { ...request.room, ratePlan: 'OTHER' } },
    { ...request, parties: { ...request.parties, agency: { ...request.parties.agency, nativeId: '100' } } },
  ]) assert.notEqual(digestCloudCreateRequest(changed).normalizedRequestDigest, original.normalizedRequestDigest);
});

test('rejects unknown authority fields and room-count aliases rather than dropping them', () => {
  for (const changed of [
    { ...request, approval: { grantId: 'caller-value' } },
    { ...request, rooms: [request.room, request.room] },
    { ...request, quantity: 2 },
    { ...request, room: { ...request.room, quantity: 2 } },
  ]) {
    const result = normalizeCloudCreateRequest(changed);
    assert.equal(result.outcome, 'unsupported');
    assert.equal(result.issue, 'CREATE_FIELD_UNSUPPORTED');
  }
});

test('requires explicit CMS no-send or recipient policy without interpreting either as authorization', () => {
  assert.equal(normalizeCloudCreateRequest({ ...request, sendHmsConfirmation: undefined }).issue, 'CREATE_FIELD_REQUIRED');
  assert.equal(normalizeCloudCreateRequest({ ...request, sendHmsConfirmation: { kind: 'never', recipient: 'guest@example.test' } }).issue,
    'CREATE_NEVER_SEND_HAS_RECIPIENT');
  assert.equal(normalizeCloudCreateRequest({ ...request, sendHmsConfirmation: { kind: 'send' } }).issue,
    'CREATE_SEND_RECIPIENT_REQUIRED');
  const send = digestCloudCreateRequest({ ...request,
    sendHmsConfirmation: { kind: 'send', recipient: 'explicit@example.test' } });
  assert.equal(send.outcome, 'ok');
  assert.deepEqual(send.request.sendHmsConfirmation, { kind: 'send', recipient: 'explicit@example.test' });
  assert.notEqual(send.normalizedRequestDigest, digestCloudCreateRequest(request).normalizedRequestDigest);
});

test('rejects invalid dates, unsupported child bands, and non-string native identities', () => {
  assert.equal(normalizeCloudCreateRequest({ ...request,
    stay: { ...request.stay, arrival: '2027-02-30' } }).issue, 'CREATE_STAY_INVALID');
  assert.equal(normalizeCloudCreateRequest({ ...request,
    stay: { ...request.stay, childAges: [18] } }).issue, 'CREATE_STAY_INVALID');
  assert.equal(normalizeCloudCreateRequest({ ...request,
    guest: { ...request.guest, nativeId: 123 } }).issue, 'CREATE_GUEST_IDENTITY_INVALID');
});
