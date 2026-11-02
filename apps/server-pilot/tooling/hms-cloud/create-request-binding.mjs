import { createHash } from 'node:crypto';

export const CLOUD_CREATE_REQUEST_VERSION = 'hms-cloud-create-request/v1';

const fail = (issue, path) => ({ outcome: 'unsupported', issue, ...(path ? { path } : {}) });
const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function objectKeys(value, allowed, required, path) {
  if (!isObject(value)) return fail('CREATE_OBJECT_REQUIRED', path);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) return fail('CREATE_FIELD_UNSUPPORTED', path ? `${path}.${unknown}` : unknown);
  const missing = required.find((key) => !Object.hasOwn(value, key) || value[key] === undefined);
  if (missing) return fail('CREATE_FIELD_REQUIRED', path ? `${path}.${missing}` : missing);
  return null;
}

function exactText(value, { max = 200, allowBlank = false } = {}) {
  return typeof value === 'string' && value.length <= max &&
    ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    (allowBlank || Boolean(value.trim()));
}

function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeParty(value, path) {
  const issue = objectKeys(value, ['nativeId', 'name'], ['nativeId', 'name'], path);
  if (issue) return issue;
  if (typeof value.nativeId !== 'string' || !/^\d+$/.test(value.nativeId) ||
      !exactText(value.name, { max: 200 })) return fail('CREATE_PARTY_INVALID', path);
  return { outcome: 'ok', value: { nativeId: value.nativeId, name: value.name } };
}

function normalizeParties(value, canonical) {
  if (value === undefined) return { outcome: 'ok', value: {} };
  const agencyField = canonical ? 'bookingAgency' : 'agency';
  const issue = objectKeys(value, [agencyField, 'organization', 'arAccount'], [], 'parties');
  if (issue) return issue;
  const parties = {};
  for (const [field, path] of [[agencyField, 'bookingAgency'], ['organization', 'organization'], ['arAccount', 'arAccount']]) {
    if (!Object.hasOwn(value, field)) continue;
    const selected = normalizeParty(value[field], `parties.${field}`);
    if (selected.outcome !== 'ok') return selected;
    parties[path] = selected.value;
  }
  return { outcome: 'ok', value: parties };
}

function normalizeConfirmation(input) {
  const issue = objectKeys(input, ['kind', 'recipient'], ['kind'], 'sendHmsConfirmation');
  if (issue) return issue;
  if (input.kind === 'never') {
    if (Object.hasOwn(input, 'recipient')) return fail('CREATE_NEVER_SEND_HAS_RECIPIENT', 'sendHmsConfirmation.recipient');
    return { outcome: 'ok', value: { kind: 'never' } };
  }
  if (input.kind !== 'send' || !Object.hasOwn(input, 'recipient') ||
      !exactText(input.recipient, { max: 320 }) || !/^[^\s@]+@[^\s@]+$/.test(input.recipient)) {
    return fail('CREATE_SEND_RECIPIENT_REQUIRED', 'sendHmsConfirmation');
  }
  return { outcome: 'ok', value: { kind: 'send', recipient: input.recipient } };
}

/**
 * Canonicalize the one-room create request. This is a digest contract only:
 * it does not authorize writes or prove that the native form matches it.
 */
export function normalizeCloudCreateRequest(input) {
  const issue = objectKeys(input,
    ['version', 'propertyCode', 'guest', 'stay', 'room', 'guaranteeType', 'sourceOfBusiness', 'reasonForStay',
      'parties', 'note', 'billingReference', 'cmsMessageId', 'sendHmsConfirmation'],
    ['propertyCode', 'guest', 'stay', 'room', 'guaranteeType', 'sendHmsConfirmation'], '');
  if (issue) return issue;
  const canonical = Object.hasOwn(input, 'version');
  if (canonical && input.version !== CLOUD_CREATE_REQUEST_VERSION) return fail('CREATE_VERSION_INVALID', 'version');
  if (typeof input.propertyCode !== 'string' || !/^[A-Z0-9]{1,12}$/.test(input.propertyCode)) return fail('CREATE_PROPERTY_INVALID', 'propertyCode');

  const guestIssue = objectKeys(input.guest, ['nativeId', 'firstName', 'lastName'],
    ['nativeId', 'firstName', 'lastName'], 'guest');
  if (guestIssue) return guestIssue;
  if (typeof input.guest.nativeId !== 'string' || !/^\d+$/.test(input.guest.nativeId) ||
      !exactText(input.guest.firstName, { max: 100 }) || !exactText(input.guest.lastName, { max: 100 })) {
    return fail('CREATE_GUEST_IDENTITY_INVALID', 'guest');
  }

  const stayIssue = objectKeys(input.stay, ['arrival', 'departure', 'adults', 'childAges'],
    ['arrival', 'departure', 'adults', 'childAges'], 'stay');
  if (stayIssue) return stayIssue;
  if (!isoDate(input.stay.arrival) || !isoDate(input.stay.departure) || input.stay.arrival >= input.stay.departure ||
      !Number.isSafeInteger(input.stay.adults) || input.stay.adults < 1 || !Array.isArray(input.stay.childAges) ||
      !Array.from(input.stay.childAges).every((age) => Number.isInteger(age) && age >= 0 && age <= 17)) {
    return fail('CREATE_STAY_INVALID', 'stay');
  }

  const roomIssue = objectKeys(input.room, ['roomType', 'ratePlan'], ['roomType', 'ratePlan'], 'room');
  if (roomIssue) return roomIssue;
  if (typeof input.room.roomType !== 'string' || !/^[A-Z0-9]{1,12}$/.test(input.room.roomType) ||
      typeof input.room.ratePlan !== 'string' || !/^[A-Z0-9]{1,12}$/.test(input.room.ratePlan)) {
    return fail('CREATE_ROOM_INVALID', 'room');
  }
  if (typeof input.guaranteeType !== 'string' || !/^[A-Z0-9]{1,12}$/.test(input.guaranteeType)) {
    return fail('CREATE_GUARANTEE_INVALID', 'guaranteeType');
  }

  let sourceOfBusiness;
  if (input.sourceOfBusiness !== undefined) {
    const sourceIssue = objectKeys(input.sourceOfBusiness, ['nativeCode', 'description'],
      ['nativeCode', 'description'], 'sourceOfBusiness');
    if (sourceIssue) return sourceIssue;
    if (!exactText(input.sourceOfBusiness.nativeCode, { max: 12 }) ||
        !exactText(input.sourceOfBusiness.description, { max: 200 })) {
      return fail('CREATE_SOURCE_INVALID', 'sourceOfBusiness');
    }
    sourceOfBusiness = { nativeCode: input.sourceOfBusiness.nativeCode, description: input.sourceOfBusiness.description };
  }

  let reasonForStay;
  if (input.reasonForStay !== undefined) {
    const reasonIssue = objectKeys(input.reasonForStay, ['value', 'display'], ['value', 'display'], 'reasonForStay');
    if (reasonIssue) return reasonIssue;
    if (!exactText(input.reasonForStay.value, { max: 100 }) || !exactText(input.reasonForStay.display, { max: 200 })) {
      return fail('CREATE_REASON_INVALID', 'reasonForStay');
    }
    reasonForStay = { value: input.reasonForStay.value, display: input.reasonForStay.display };
  }

  const parties = normalizeParties(input.parties, canonical);
  if (parties.outcome !== 'ok') return parties;
  if (input.billingReference !== undefined &&
      (!exactText(input.billingReference, { max: 4000 }) || !parties.value.arAccount)) {
    return fail('CREATE_BILLING_REFERENCE_INVALID', 'billingReference');
  }
  if (input.cmsMessageId !== undefined && !exactText(input.cmsMessageId, { max: 100 })) {
    return fail('CREATE_CMS_MESSAGE_INVALID', 'cmsMessageId');
  }
  if (input.note !== undefined && !exactText(input.note, { max: 200 })) return fail('CREATE_NOTE_INVALID', 'note');
  const confirmation = normalizeConfirmation(input.sendHmsConfirmation);
  if (confirmation.outcome !== 'ok') return confirmation;

  const request = {
    version: CLOUD_CREATE_REQUEST_VERSION,
    propertyCode: input.propertyCode,
    guest: { nativeId: input.guest.nativeId, firstName: input.guest.firstName, lastName: input.guest.lastName },
    stay: { arrival: input.stay.arrival, departure: input.stay.departure, adults: input.stay.adults,
      childAges: [...input.stay.childAges] },
    room: { roomType: input.room.roomType, ratePlan: input.room.ratePlan },
    guaranteeType: input.guaranteeType,
    ...(sourceOfBusiness ? { sourceOfBusiness } : {}),
    ...(reasonForStay ? { reasonForStay } : {}),
    ...(Object.keys(parties.value).length ? { parties: parties.value } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.billingReference !== undefined ? { billingReference: input.billingReference } : {}),
    ...(input.cmsMessageId !== undefined ? { cmsMessageId: input.cmsMessageId } : {}),
    sendHmsConfirmation: confirmation.value,
  };
  return { outcome: 'ok', request };
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

export function digestCloudCreateRequest(input) {
  const normalized = normalizeCloudCreateRequest(input);
  if (normalized.outcome !== 'ok') return normalized;
  const normalizedRequestDigest = createHash('sha256')
    .update(JSON.stringify(sorted(normalized.request)))
    .digest('hex');
  return { ...normalized, normalizedRequestDigest };
}
