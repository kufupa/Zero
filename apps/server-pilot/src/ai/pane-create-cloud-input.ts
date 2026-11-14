import {
  digestCloudCreateRequest,
  normalizeCloudCreateRequest,
  validCreateNote,
} from '../../tooling/hms-cloud/create-request-binding.mjs';
import { CREATE_GUARANTEES, createGuaranteeCode, isLabtestGuest, validCreateGuest } from '../../tooling/hms-cloud/cloud-create-policy.mjs';
import { getPropertyRegistration } from '../../tooling/hms-cloud/property-registry.mjs';
import type { PropertyConfiguration } from '../hms/property-configuration.js';
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
  cmsRecipient?: string;
  booker?: { name?: string; contact?: string };
  track?: { lookupCode: string; display: string };
  marketSegment?: { value: string; display: string };
  guestOptIn?: boolean;
  sendHmsConfirmation: { kind: 'never' } | { kind: 'send'; recipient: string };
};

export type PaneCloudCreateMapping =
  | { outcome: 'ok'; input: Record<string, unknown> }
  | { outcome: 'refused'; reason: string; field?: string };

const same = (left: unknown, right: unknown) => typeof left === 'string' && typeof right === 'string' &&
  left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
const cleanText = (value: unknown): value is string => typeof value === 'string' && value === value.trim() && Boolean(value) &&
  ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const guaranteeCode = createGuaranteeCode;

export function cloudCreatePolicyIssue(policy: PropertyConfiguration['formPolicy'], input: Record<string, unknown>): string | null {
  const optIn = input.guestoptin4;
  if ((policy.guestOptIn === 'required' || policy.requiredFields.includes('guestoptin4')) && typeof optIn !== 'boolean') {
    return 'guest_opt_in_required';
  }
  if (policy.guestOptIn === 'unsupported' && optIn !== undefined) return 'guest_opt_in_unsupported';
  const segment = input.marketSegment;
  if (policy.requiredFields.includes('marketsegment') && (typeof segment !== 'string' || !segment)) return 'market_segment_required';
  if (segment !== undefined && policy.marketSegmentChoices?.length &&
      policy.marketSegmentChoices.filter(choice => choice.code === segment).length !== 1) return 'market_segment_unavailable';
  return null;
}

/** Exact supported subset. Unsupported pane properties are refused, never dropped. */
export function mapPaneStayToCloudCreateInput(
  stay: PaneCloudStay,
  mode: CloudCreateMode,
  nativeGuestId?: string,
  { allowRealGuest = false }: { allowRealGuest?: boolean } = {},
): PaneCloudCreateMapping {
  if (stay.marketSegment !== undefined && !/^[A-Z0-9]{1,20}$/.test(stay.marketSegment)) {
    return { outcome: 'refused', reason: 'cloud_create_field_unsupported', field: 'marketSegment' };
  }
  if (stay.confirmationSendMail === true && (!allowRealGuest || isLabtestGuest(stay))) {
    return { outcome: 'refused', reason: 'labtest_send_forbidden', field: 'confirmationSendMail' };
  }
  if (stay.confirmationSendMail === true && (!stay.cmsMessageId || !stay.confirmationRecipient)) {
    return { outcome: 'refused', reason: 'confirmation_recipient_required', field: 'confirmationRecipient' };
  }
  for (const [field, value, max] of [['bookerName', stay.bookerName, 50], ['bookerEmail', stay.bookerEmail, 80]] as const) {
    if (value !== undefined && (!cleanText(value) || value.length > max)) {
      return { outcome: 'refused', reason: 'cloud_create_field_unsupported', field };
    }
  }
  if (stay.confirmationRecipient !== undefined &&
      (!cleanText(stay.confirmationRecipient.address) || stay.confirmationRecipient.address.length > 255 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(stay.confirmationRecipient.address))) {
    return { outcome: 'refused', reason: 'cloud_create_field_unsupported', field: 'confirmationRecipient' };
  }
  if (stay.track !== undefined && !/^[A-Z0-9]{1,12}$/.test(stay.track)) {
    return { outcome: 'refused', reason: 'cloud_create_field_unsupported', field: 'track' };
  }
  if (!stay.propertyCode || !getPropertyRegistration(stay.propertyCode)?.active) {
    return { outcome: 'refused', reason: 'property_mismatch', field: 'propertyCode' };
  }
  if (!validCreateGuest(stay)) {
    return { outcome: 'refused', reason: 'guest_name_required', field: 'guest' };
  }
  // This option is supplied by the server's approved Cloud flow, never the pane.
  if (mode === 'commit' && !allowRealGuest && !isLabtestGuest(stay)) {
    return { outcome: 'refused', reason: 'labtest_guest_required', field: 'guest' };
  }
  const guarantee = guaranteeCode(stay.guaranteeType);
  if (!guarantee) return { outcome: 'refused', reason: 'cloud_create_guarantee_unsupported', field: 'guaranteeType' };
  if (!Number.isInteger(stay.adults) || stay.adults < 1) return { outcome: 'refused', reason: 'adults_required', field: 'adults' };
  if (!Array.isArray(stay.childAges) || !Array.from(stay.childAges).every((age) => Number.isInteger(age) && age >= 0 && age <= 17)) {
    return { outcome: 'refused', reason: 'child_ages_required', field: 'childAges' };
  }
  if (!cleanText(stay.sourceOfBusiness)) return { outcome: 'refused', reason: 'source_of_business_required', field: 'sourceOfBusiness' };
  if (!validCreateNote(stay.reservationNote) || stay.reservationNote !== stay.reservationNote.trim()) {
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
  // A caller can explicitly select a profile for an unsaved preview. Do not
  // infer one from a name: the current HMS picker can contain duplicate names.
  if ((mode === 'commit' && !nativeGuestId) ||
      (nativeGuestId !== undefined && !/^\d+$/.test(nativeGuestId))) {
    return { outcome: 'refused', reason: 'prepared_guest_identity_required', field: 'guest' };
  }

  return {
    outcome: 'ok',
    input: {
      mode,
      propertyCode: stay.propertyCode,
      guest: nativeGuestId !== undefined
        ? { profileId: nativeGuestId }
        : { search: { firstName: stay.firstName, lastName: stay.lastName } },
      stay: {
        arrival: stay.arrival, departure: stay.departure, adults: stay.adults,
        childAges: [...stay.childAges], childCount: stay.childAges.length,
      },
      room: { roomType: stay.roomType, ratePlan: stay.ratePlan },
      ...(stay.track !== undefined ? { track: stay.track } : {}),
      ...(stay.marketSegment !== undefined ? { marketSegment: stay.marketSegment } : {}),
      ...(stay.guestoptin4 !== undefined ? { guestoptin4: stay.guestoptin4 } : {}),
      ...(stay.bookerName !== undefined || stay.bookerEmail !== undefined ? { booker: {
        ...(stay.bookerName !== undefined ? { name: stay.bookerName } : {}),
        ...(stay.bookerEmail !== undefined ? { contact: stay.bookerEmail } : {}),
      } } : {}),
      guaranteeType: guarantee,
      sourceOfBusiness: stay.sourceOfBusiness,
      ...(Object.keys(parties).length ? { parties } : {}),
      note: stay.reservationNote,
      cms: { send: stay.confirmationSendMail === true, ...(stay.cmsMessageId ? { messageId: stay.cmsMessageId } : {}),
        ...(stay.confirmationRecipient ? { recipient: stay.confirmationRecipient.address } : {}) },
    },
  };
}

/** Bind only server-observed final selections to the reviewed pane stay. */
export function digestPaneCloudCreateProof(stay: PaneCloudStay, value: unknown, visibleGuarantee?: unknown, selectedGuestId?: string,
  requireVisibleGuarantee = false, allowRealGuest = false):
  | { outcome: 'ok'; normalizedRequestDigest: string; request: Record<string, unknown> }
  | { outcome: 'refused'; reason: string } {
  // A matching native proof is not evidence for a stay this bridge cannot map.
  // Apply the same limits independently, even when a caller skipped mapping.
  if (mapPaneStayToCloudCreateInput(stay, 'prepare', selectedGuestId, { allowRealGuest }).outcome !== 'ok') {
    return { outcome: 'refused', reason: 'cloud_create_proof_mismatch' };
  }
  // When staff selected a display label, a matching code alone does not prove
  // HMS showed that label. The bridge must supply its fresh form readback.
  const code = guaranteeCode(stay.guaranteeType);
  if (!code) return { outcome: 'refused', reason: 'cloud_create_proof_mismatch' };
  const expectedGuarantee = stay.propertyCode === 'HRCEN' ? CREATE_GUARANTEES[code] :
    stay.guaranteeType === code ? undefined : stay.guaranteeType;
  if ((requireVisibleGuarantee || expectedGuarantee !== undefined || visibleGuarantee !== undefined) &&
      (!cleanText(visibleGuarantee) || (expectedGuarantee !== undefined && visibleGuarantee !== expectedGuarantee))) {
    return { outcome: 'refused', reason: 'cloud_create_proof_mismatch' };
  }
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
  const track = request.track as CloudCreateProof['track'];
  const marketSegment = request.marketSegment as CloudCreateProof['marketSegment'];
  const booker = request.booker as CloudCreateProof['booker'];
  // This pane subset cannot request these fields. A prepared form containing them
  // must not become approval evidence for a different, narrower staff request.
  if (request.reasonForStay !== undefined || request.billingReference !== undefined ||
      (parties && Object.hasOwn(parties, 'arAccount'))) {
    return { outcome: 'refused', reason: 'cloud_create_proof_mismatch' };
  }
  if (request.propertyCode !== stay.propertyCode || guest.firstName !== stay.firstName || guest.lastName !== stay.lastName ||
      !/^\d+$/.test(guest.nativeId) || (selectedGuestId !== undefined && guest.nativeId !== selectedGuestId) ||
      requestedStay.arrival !== stay.arrival || requestedStay.departure !== stay.departure ||
      requestedStay.adults !== stay.adults || JSON.stringify(requestedStay.childAges) !== JSON.stringify(stay.childAges) ||
      room.roomType !== stay.roomType || room.ratePlan !== stay.ratePlan || request.guaranteeType !== guaranteeCode(stay.guaranteeType) ||
      request.note !== stay.reservationNote ||
      (stay.confirmationRecipient ? request.cmsRecipient !== stay.confirmationRecipient.address : request.cmsRecipient !== undefined) ||
      (stay.bookerName !== undefined ? booker?.name !== stay.bookerName : booker?.name !== undefined) ||
      (stay.bookerEmail !== undefined ? booker?.contact !== stay.bookerEmail : booker?.contact !== undefined) ||
      (stay.track !== undefined ? !track || track.lookupCode !== stay.track : track !== undefined) ||
      (stay.marketSegment !== undefined ? !marketSegment || marketSegment.value !== stay.marketSegment : marketSegment !== undefined) ||
      (stay.guestoptin4 !== undefined ? request.guestOptIn !== stay.guestoptin4 : request.guestOptIn !== undefined) ||
      !source || (!same(source.nativeCode, stay.sourceOfBusiness) && !same(source.description, stay.sourceOfBusiness)) ||
      (stay.cmsMessageId !== undefined ? request.cmsMessageId !== stay.cmsMessageId : request.cmsMessageId !== undefined) ||
      !request.sendHmsConfirmation || (stay.confirmationSendMail === true
        ? (request.sendHmsConfirmation as { kind?: unknown; recipient?: unknown }).kind !== 'send' ||
          (request.sendHmsConfirmation as { recipient?: unknown }).recipient !== stay.confirmationRecipient?.address
        : (request.sendHmsConfirmation as { kind?: unknown }).kind !== 'never')) {
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
