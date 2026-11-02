import {
  digestCloudCreateRequest,
  normalizeCloudCreateRequest,
} from '../../tooling/hms-cloud/create-request-binding.mjs';
import type { PaneStay } from './pane-stay-save.js';

// Cloud preparation permits an omitted track; legacy pane saves still require one.
type PaneCloudStay = Omit<PaneStay, 'track'> & { track?: string };
type CloudCreateMode = 'prepare' | 'commit';
type CloudCreateProof = {
  propertyCode: string;
  guest: { nativeId: string; firstName: string; lastName: string };
  stay: { arrival: string; departure: string; adults: number; childAges: number[] };
  room: { roomType: string; ratePlan: string };
  guaranteeType: string;
  sourceOfBusiness?: { nativeCode: string; description: string };
  parties?: {
    agency?: { nativeId: string; name: string };
    bookingAgency?: { nativeId: string; name: string };
    organization?: { nativeId: string; name: string };
  };
  note?: string;
  cmsMessageId?: string;
  sendHmsConfirmation: { kind: 'never' };
};

export type PaneCloudCreateMapping =
  | { outcome: 'ok'; input: Record<string, unknown> }
  | { outcome: 'refused'; reason: string; field?: string };

const same = (left: unknown, right: unknown) => typeof left === 'string' && typeof right === 'string' &&
  left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
const cleanText = (value: unknown): value is string => typeof value === 'string' && value === value.trim() && Boolean(value) &&
  ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/** Exact supported subset. Unsupported pane properties are refused, never dropped. */
export function mapPaneStayToCloudCreateInput(
  stay: PaneCloudStay,
  mode: CloudCreateMode,
  nativeGuestId?: string,
): PaneCloudCreateMapping {
  for (const [field, value] of [
    ['track', stay.track], ['marketSegment', stay.marketSegment], ['guestoptin4', stay.guestoptin4],
    ['bookerName', stay.bookerName], ['bookerEmail', stay.bookerEmail],
    ['confirmationRecipient', stay.confirmationRecipient],
  ] as const) {
    if (value !== undefined) return { outcome: 'refused', reason: 'cloud_create_field_unsupported', field };
  }
  if (stay.propertyCode !== undefined && stay.propertyCode !== 'HRCEN') {
    return { outcome: 'refused', reason: 'property_mismatch', field: 'propertyCode' };
  }
  if (stay.firstName !== 'Proof' || stay.lastName !== 'Labtest') {
    return { outcome: 'refused', reason: 'labtest_guest_required', field: 'guest' };
  }
  if (stay.guaranteeType !== 'NGI') return { outcome: 'refused', reason: 'cloud_create_guarantee_unsupported', field: 'guaranteeType' };
  if (!Number.isInteger(stay.adults) || stay.adults < 1) return { outcome: 'refused', reason: 'adults_required', field: 'adults' };
  if (!Array.isArray(stay.childAges) || !Array.from(stay.childAges).every((age) => Number.isInteger(age) && age >= 0 && age <= 17)) {
    return { outcome: 'refused', reason: 'child_ages_required', field: 'childAges' };
  }
  if (!cleanText(stay.sourceOfBusiness)) return { outcome: 'refused', reason: 'source_of_business_required', field: 'sourceOfBusiness' };
  if (!cleanText(stay.reservationNote) || stay.reservationNote.length > 200) {
    return { outcome: 'refused', reason: 'staff_note_required', field: 'reservationNote' };
  }
  if (!/^[A-Z0-9]{1,12}$/.test(stay.roomType) || !/^[A-Z0-9]{1,12}$/.test(stay.ratePlan)) {
    return { outcome: 'refused', reason: 'native_room_codes_required', field: 'roomType' };
  }
  if (stay.cmsMessageId !== undefined && !cleanText(stay.cmsMessageId)) {
    return { outcome: 'refused', reason: 'cms_message_invalid', field: 'cmsMessageId' };
  }

  const parties: Record<string, unknown> = {};
  if (stay.bookingAgency) {
    const nativeId = stay.bookingAgency.nativeId ?? stay.bookingAgency.id;
    if (!nativeId || !/^\d+$/.test(nativeId) || !cleanText(stay.bookingAgency.name)) {
      return { outcome: 'refused', reason: 'booking_agency_id_and_name_required', field: 'bookingAgency' };
    }
    parties.agencyId = nativeId;
    parties.agencyName = stay.bookingAgency.name;
  }
  if (stay.organization) {
    if (!stay.organization.nativeId || !/^\d+$/.test(stay.organization.nativeId) || !cleanText(stay.organization.name)) {
      return { outcome: 'refused', reason: 'organization_id_and_name_required', field: 'organization' };
    }
    parties.organizationId = stay.organization.nativeId;
    parties.organizationName = stay.organization.name;
  }
  if (mode === 'commit' && (!nativeGuestId || !/^\d+$/.test(nativeGuestId))) {
    return { outcome: 'refused', reason: 'prepared_guest_identity_required', field: 'guest' };
  }

  return {
    outcome: 'ok',
    input: {
      mode,
      propertyCode: 'HRCEN',
      guest: mode === 'commit'
        ? { profileId: nativeGuestId }
        : { search: { firstName: 'Proof', lastName: 'Labtest' } },
      stay: {
        arrival: stay.arrival, departure: stay.departure, adults: stay.adults,
        childAges: [...stay.childAges], childCount: stay.childAges.length,
      },
      room: { roomType: stay.roomType, ratePlan: stay.ratePlan },
      guaranteeType: 'NGI',
      sourceOfBusiness: stay.sourceOfBusiness,
      ...(Object.keys(parties).length ? { parties } : {}),
      note: stay.reservationNote,
      cms: { send: false, ...(stay.cmsMessageId ? { messageId: stay.cmsMessageId } : {}) },
    },
  };
}

/** Bind only server-observed final selections to the reviewed pane stay. */
export function digestPaneCloudCreateProof(stay: PaneCloudStay, value: unknown):
  | { outcome: 'ok'; normalizedRequestDigest: string; request: Record<string, unknown> }
  | { outcome: 'refused'; reason: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { outcome: 'refused', reason: 'cloud_create_proof_invalid' };
  const proof = value as CloudCreateProof;
  const normalized = normalizeCloudCreateRequest(proof);
  if (normalized.outcome !== 'ok') return { outcome: 'refused', reason: 'cloud_create_proof_invalid' };
  const request = normalized.request as Record<string, unknown>;
  const guest = request.guest as CloudCreateProof['guest'];
  const requestedStay = request.stay as CloudCreateProof['stay'];
  const room = request.room as CloudCreateProof['room'];
  const source = request.sourceOfBusiness as CloudCreateProof['sourceOfBusiness'];
  const parties = request.parties as CloudCreateProof['parties'] | undefined;
  const agency = parties?.bookingAgency ?? parties?.agency;
  const organization = parties?.organization;
  // This pane subset cannot request these fields. A prepared form containing them
  // must not become approval evidence for a different, narrower staff request.
  if (request.reasonForStay !== undefined || request.billingReference !== undefined ||
      (parties && Object.hasOwn(parties, 'arAccount'))) {
    return { outcome: 'refused', reason: 'cloud_create_proof_mismatch' };
  }
  if (request.propertyCode !== 'HRCEN' || guest.firstName !== stay.firstName || guest.lastName !== stay.lastName ||
      !/^\d+$/.test(guest.nativeId) || requestedStay.arrival !== stay.arrival || requestedStay.departure !== stay.departure ||
      requestedStay.adults !== stay.adults || JSON.stringify(requestedStay.childAges) !== JSON.stringify(stay.childAges) ||
      room.roomType !== stay.roomType || room.ratePlan !== stay.ratePlan || request.guaranteeType !== 'NGI' ||
      request.note !== stay.reservationNote ||
      !source || (!same(source.nativeCode, stay.sourceOfBusiness) && !same(source.description, stay.sourceOfBusiness)) ||
      (stay.cmsMessageId !== undefined ? request.cmsMessageId !== stay.cmsMessageId : request.cmsMessageId !== undefined) ||
      !request.sendHmsConfirmation || (request.sendHmsConfirmation as { kind?: unknown }).kind !== 'never') {
    return { outcome: 'refused', reason: 'cloud_create_proof_mismatch' };
  }
  if (stay.bookingAgency) {
    const id = stay.bookingAgency.nativeId ?? stay.bookingAgency.id;
    if (!agency || agency.nativeId !== id || !same(agency.name, stay.bookingAgency.name)) {
      return { outcome: 'refused', reason: 'cloud_create_party_mismatch' };
    }
  } else if (agency) return { outcome: 'refused', reason: 'cloud_create_party_mismatch' };
  if (stay.organization) {
    if (!organization || organization.nativeId !== stay.organization.nativeId || !same(organization.name, stay.organization.name)) {
      return { outcome: 'refused', reason: 'cloud_create_party_mismatch' };
    }
  } else if (organization) return { outcome: 'refused', reason: 'cloud_create_party_mismatch' };

  const digest = digestCloudCreateRequest(proof);
  if (digest.outcome !== 'ok' || typeof digest.normalizedRequestDigest !== 'string') {
    return { outcome: 'refused', reason: 'cloud_create_proof_invalid' };
  }
  return { outcome: 'ok', normalizedRequestDigest: digest.normalizedRequestDigest, request };
}
