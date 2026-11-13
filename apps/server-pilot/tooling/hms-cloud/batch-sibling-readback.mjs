// Verify prior rooms from a server-owned batch, using fresh HMS reads.
import { digestCloudCreateRequest } from './create-request-binding.mjs';
import { readLabtestCreate } from './labtest-create-readback.mjs';
import { readCreateParties } from './create-party-readback.mjs';
import { CREATE_GUARANTEES, createCloudTargetKey, isLabtestGuest, sameCreateGuest, validCreateDates, validCreateGuest } from './cloud-create-policy.mjs';

/** The caller supplies only prior, durably confirmed rooms from the approved batch. */
export async function verifyBatchSiblings(census, siblings, {
  read = readLabtestCreate, readParties = readCreateParties, cloudTargetKey,
} = {}) {
  try {
    const target = { firstName: census?.firstName ?? 'Proof', lastName: census?.lastName ?? 'Labtest' };
    if (!validCreateGuest(target) || !['clear', 'existing_matches'].includes(census?.outcome) || census.coverage?.complete !== true ||
        !Array.isArray(census.sameArrival) || !Array.isArray(siblings) || !siblings.length ||
        new Set(siblings.map((item) => item.confirmation)).size !== siblings.length ||
        new Set(census.sameArrival.map((item) => item.confirmation)).size !== census.sameArrival.length) return false;
    const browserKey = cloudTargetKey ?? createCloudTargetKey(target, census.arrival);
    if (!browserKey) return false;
    const matching = siblings.filter(({ approvedRequest: request }) =>
      sameCreateGuest(request?.guest, target) && request?.stay?.arrival === census.arrival);
    if (census.sameArrival.length !== matching.length) return false;
    for (const sibling of siblings) {
      const { confirmation, approvedRequest: request, requestDigest } = sibling;
      const binding = digestCloudCreateRequest(request);
      const row = census.sameArrival.find((item) => item.confirmation === confirmation);
      const sameTarget = matching.includes(sibling);
      if (binding.outcome !== 'ok' || binding.normalizedRequestDigest !== requestDigest ||
          !/^\d{6,}-\d+$/.test(confirmation) || request.propertyCode !== 'HRCEN' || !validCreateGuest(request.guest) ||
          (request.sendHmsConfirmation.kind === 'send' && (isLabtestGuest(request.guest) ||
            !request.cmsMessageId || request.cmsRecipient !== request.sendHmsConfirmation.recipient)) ||
          !CREATE_GUARANTEES[request.guaranteeType] ||
          !validCreateDates(request.stay.arrival, request.stay.departure, true, true) ||
          (sameTarget && (!row || !sameCreateGuest(row, request.guest) || row.status !== 'Reserved' ||
            row.arrival !== request.stay.arrival || row.departure !== request.stay.departure))) return false;
      const ages = request.stay.childAges;
      const expected = { arrival: request.stay.arrival, departure: request.stay.departure,
        adults: request.stay.adults, children: ages.length,
        childBands: { child1: ages.filter((age) => age <= 2).length,
          child2: ages.filter((age) => age >= 3 && age <= 12).length,
          child3: ages.filter((age) => age >= 13).length },
        roomType: request.room.roomType, ratePlan: request.room.ratePlan, note: request.note,
        ...(request.room.mealPlan ? { mealPlan: request.room.mealPlan } : {}),
        guestId: request.guest.nativeId, firstName: request.guest.firstName, lastName: request.guest.lastName,
        allowRealGuest: true,
        ...(request.sourceOfBusiness ? { source: request.sourceOfBusiness.description } : {}),
        organization: request.parties?.organization?.name ?? '', guarantee: CREATE_GUARANTEES[request.guaranteeType],
        guaranteeCode: request.guaranteeType, cmsSend: request.sendHmsConfirmation.kind === 'send',
        ...(request.cmsMessageId !== undefined ? { cmsMessageId: request.cmsMessageId } : {}),
        ...(request.cmsRecipient !== undefined ? { cmsRecipient: request.cmsRecipient } : {}),
        ...(request.track ? { track: request.track.display } : {}),
        ...(request.booker ? { booker: request.booker } : {}),
        ...(request.guestOptIn === false ? { guestOptIn: false } : {}) };
      const proof = await read({ confirmation, stay: request.stay, expected }, { cloudTargetKey: browserKey });
      if (!Array.isArray(proof?.mismatches) || proof.mismatches.length || !Array.isArray(proof.fields)) return false;
      if (request.cmsMessageId !== undefined) {
        const fields = proof.fields.filter((field) => field.name === 'udfchar09');
        if (fields.length !== 1 || fields[0].value !== request.cmsMessageId) return false;
      }
      // Independently verify the selected agency and company after the save.
      const parties = await readParties({ confirmation, arrival: request.stay.arrival, guestId: request.guest.nativeId,
        firstName: request.guest.firstName, lastName: request.guest.lastName, allowRealGuest: true,
        agency: request.parties?.bookingAgency ?? null, organization: request.parties?.organization ?? null, arAccount: null },
      { cloudTargetKey: browserKey });
      if (parties?.outcome !== 'verified') return false;
    }
    return true;
  } catch { return false; }
}
