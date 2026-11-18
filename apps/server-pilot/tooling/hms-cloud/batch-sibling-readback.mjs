// Verify prior rooms from a server-owned batch, using fresh HMS reads.
import { digestCloudCreateRequest } from './create-request-binding.mjs';
import { readLabtestCreate } from './labtest-create-readback.mjs';
import { readCreateParties } from './create-party-readback.mjs';
import { CREATE_GUARANTEES, blockingCreateMatches, createCloudTargetKey, isLabtestGuest, sameCreateGuest, validCreateDates, validCreateGuest } from './cloud-create-policy.mjs';

/** Compare a fresh writer-page census to siblings independently verified before the writer opened. */
export function censusMatchesApprovedSiblings(census, siblings, { propertyCode = 'HRCEN' } = {}) {
  try {
    const target = { firstName: census?.firstName, lastName: census?.lastName };
    if (!validCreateGuest(target) || census.propertyCode !== propertyCode || !['clear', 'existing_matches'].includes(census?.outcome) || census.coverage?.complete !== true ||
        !Array.isArray(census.sameArrival) || !Array.isArray(siblings) ||
        new Set(siblings.map(item => item.confirmation)).size !== siblings.length ||
        new Set(census.sameArrival.map(item => item.confirmation)).size !== census.sameArrival.length) return false;
    const matching = [];
    for (const sibling of siblings) {
      const binding = digestCloudCreateRequest(sibling.approvedRequest), request = binding.request;
      if (binding.outcome !== 'ok' || binding.normalizedRequestDigest !== sibling.requestDigest ||
          request.propertyCode !== propertyCode || !/^\d{1,100}$/.test(sibling.nativeStayId || '')) return false;
      if (sameCreateGuest(request.guest, target) && request.stay.arrival === census.arrival &&
          request.stay.departure === census.departure) matching.push({ sibling, request });
    }
    if (blockingCreateMatches(census.sameArrival.filter(row => row.departure === census.departure)).length !== matching.length) return false;
    return matching.every(({ sibling, request }) => {
      const row = census.sameArrival.find(item => item.confirmation === sibling.confirmation);
      return Boolean(row && sameCreateGuest(row, request.guest) && row.status === 'Reserved' &&
        row.arrival === request.stay.arrival && row.departure === request.stay.departure);
    });
  } catch { return false; }
}

/** The caller supplies only prior, durably confirmed rooms from the approved batch. */
export async function verifyBatchSiblings(census, siblings, {
  ...options
} = {}) {
  if (!census) return false;
  return verifySiblings(census, siblings, options);
}

async function verifySiblings(census, siblings, {
  read = readLabtestCreate, readParties = readCreateParties, cloudTargetKey, propertyCode = 'HRCEN', transportId, signal, credentialLease,
  requireNativeStayId = false,
} = {}) {
  try {
    if (!Array.isArray(siblings) || !siblings.length ||
        new Set(siblings.map((item) => item.confirmation)).size !== siblings.length) return false;
    let matching = [];
    if (census !== null) {
      const target = { firstName: census?.firstName ?? 'Proof', lastName: census?.lastName ?? 'Labtest' };
      if (!validCreateGuest(target) || !['clear', 'existing_matches'].includes(census?.outcome) || census.coverage?.complete !== true ||
          !Array.isArray(census.sameArrival) || new Set(census.sameArrival.map(item => item.confirmation)).size !== census.sameArrival.length ||
          !(cloudTargetKey ?? createCloudTargetKey(target, census.arrival, propertyCode))) return false;
      matching = siblings.filter(({ approvedRequest: request }) =>
        sameCreateGuest(request?.guest, target) && request?.stay?.arrival === census.arrival && request?.stay?.departure === census.departure);
      if (blockingCreateMatches(census.sameArrival.filter(row => row.departure === census.departure)).length !== matching.length) return false;
    }
    for (const sibling of siblings) {
      const { confirmation, approvedRequest, requestDigest } = sibling;
      const binding = digestCloudCreateRequest(approvedRequest);
      const request = binding.request;
      const row = census?.sameArrival?.find((item) => item.confirmation === confirmation);
      const sameTarget = matching.includes(sibling);
      if (binding.outcome !== 'ok' || binding.normalizedRequestDigest !== requestDigest ||
          !/^\d{6,}-\d+$/.test(confirmation) || request.propertyCode !== propertyCode || !validCreateGuest(request.guest) ||
          (requireNativeStayId && !/^\d{1,100}$/.test(sibling.nativeStayId || '')) ||
          (requireNativeStayId && (!sibling.ratePlanAvailability ||
            !['averageRate', 'totalRate', 'currency'].every(key => typeof sibling.ratePlanAvailability[key] === 'string' &&
              sibling.ratePlanAvailability[key].trim()))) ||
          (request.room.roomTypeForCharge && !sibling.checkedPricing) ||
          (request.parties?.arAccount && !/^\d{1,100}$/.test(sibling.arProfileId || '')) ||
          (request.sendHmsConfirmation.kind === 'send' && (isLabtestGuest(request.guest) ||
            !request.cmsMessageId || request.cmsRecipient !== request.sendHmsConfirmation.recipient)) ||
          !CREATE_GUARANTEES[request.guaranteeType] ||
          !validCreateDates(request.stay.arrival, request.stay.departure, true, true) ||
          (sameTarget && (!row || !sameCreateGuest(row, request.guest) || row.status !== 'Reserved' ||
            row.arrival !== request.stay.arrival || row.departure !== request.stay.departure))) return false;
      const ages = request.stay.childAges;
      const expected = { arrival: request.stay.arrival, departure: request.stay.departure,
        adults: request.stay.adults, children: ages.length,
        childAges: ages,
        roomType: request.room.roomType, ratePlan: request.room.ratePlan, note: request.note,
        ...(request.room.roomTypeForCharge ? { roomTypeForCharge: request.room.roomTypeForCharge, checkedPricing: sibling.checkedPricing } : {}),
        ...(sibling.ratePlanAvailability ? { ratePlanAvailability: sibling.ratePlanAvailability } : {}),
        ...(request.room.mealPlan ? { mealPlan: request.room.mealPlan } : {}),
        guestId: request.guest.nativeId, firstName: request.guest.firstName, lastName: request.guest.lastName,
        allowRealGuest: true,
        ...(request.sourceOfBusiness ? { source: request.sourceOfBusiness.description } : {}),
        organization: request.parties?.organization?.name ?? '', guarantee: CREATE_GUARANTEES[request.guaranteeType],
        guaranteeCode: request.guaranteeType, cmsSend: request.sendHmsConfirmation.kind === 'send',
        ...(request.cmsMessageId !== undefined ? { cmsMessageId: request.cmsMessageId } : {}),
        ...(request.cmsRecipient !== undefined ? { cmsRecipient: request.cmsRecipient } : {}),
        ...(request.track ? { track: request.track.display } : {}),
        ...(request.marketSegment ? { marketSegment: request.marketSegment } : {}),
        ...(request.nativeCommissionPercent !== undefined ? { nativeCommissionPercent: request.nativeCommissionPercent } : {}),
        ...(request.booker ? { booker: request.booker } : {}),
        ...(request.guestOptIn !== undefined ? { guestOptIn: request.guestOptIn } : {}) };
      const siblingKey = createCloudTargetKey(request.guest, request.stay.arrival, propertyCode);
      const proof = await read({ confirmation, stay: request.stay, expected },
        { propertyCode, transportId, signal, credentialLease, cloudTargetKey: siblingKey });
      if (!Array.isArray(proof?.mismatches) || proof.mismatches.length || !Array.isArray(proof.fields) ||
          !/^\d{1,100}$/.test(proof.nativeStayId || '') ||
          (sibling.nativeStayId !== undefined && sibling.nativeStayId !== proof.nativeStayId)) return false;
      if (request.reasonForStay) {
        const reasons = proof.fields.filter(field => field.name === 'reasonforstay');
        if (reasons.length !== 1 || reasons[0].value !== request.reasonForStay.display) return false;
      }
      if (request.cmsMessageId !== undefined) {
        const fields = proof.fields.filter((field) => field.name === 'udfchar09');
        if (fields.length !== 1 || fields[0].value !== request.cmsMessageId) return false;
      }
      // Independently verify the selected agency and company after the save.
      const parties = await readParties({ confirmation, arrival: request.stay.arrival, guestId: request.guest.nativeId,
        firstName: request.guest.firstName, lastName: request.guest.lastName, allowRealGuest: true,
        agency: request.parties?.bookingAgency ?? null, organization: request.parties?.organization ?? null,
        arAccount: request.parties?.arAccount ? { ...request.parties.arAccount, profileId: sibling.arProfileId } : null,
        ...(request.billingReference !== undefined ? { billingReference: request.billingReference } : {}) },
      { propertyCode, transportId, signal, credentialLease, cloudTargetKey: siblingKey });
      if (parties?.outcome !== 'verified') return false;
    }
    return true;
  } catch { return false; }
}

/** Recheck every previously confirmed room before opening the next writer. */
export function verifyApprovedBatchSiblings(siblings, options = {}) {
  return verifySiblings(null, siblings, { ...options, requireNativeStayId: true });
}
