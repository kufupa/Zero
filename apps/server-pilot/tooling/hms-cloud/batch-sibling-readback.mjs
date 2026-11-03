// Verify prior rooms from a server-owned batch, using fresh HMS reads.
import { digestCloudCreateRequest } from './create-request-binding.mjs';
import { readLabtestCreate } from './labtest-create-readback.mjs';
import { readCreateParties } from './create-party-readback.mjs';

const guarantees = { NGI: 'Non-Guaranteed Individual', GTDAGT: 'Guaranteed By Agent' };

/** The caller supplies only prior, durably confirmed rooms from the approved batch. */
export async function verifyBatchSiblings(census, siblings, {
  read = readLabtestCreate, readParties = readCreateParties,
} = {}) {
  try {
    if (census?.outcome !== 'existing_matches' || census.coverage?.complete !== true ||
        !Array.isArray(census.sameArrival) || !Array.isArray(siblings) || !siblings.length ||
        census.sameArrival.length !== siblings.length ||
        new Set(siblings.map((item) => item.confirmation)).size !== siblings.length ||
        new Set(census.sameArrival.map((item) => item.confirmation)).size !== siblings.length) return false;
    for (const sibling of siblings) {
      const { confirmation, approvedRequest: request, requestDigest } = sibling;
      const binding = digestCloudCreateRequest(request);
      const row = census.sameArrival.find((item) => item.confirmation === confirmation);
      if (binding.outcome !== 'ok' || binding.normalizedRequestDigest !== requestDigest ||
          !/^\d{6,}-\d+$/.test(confirmation) || !row || row.firstName !== 'Proof' || row.lastName !== 'Labtest' ||
          row.status !== 'Reserved' || request.propertyCode !== 'HRCEN' ||
          request.guest.firstName !== 'Proof' || request.guest.lastName !== 'Labtest' ||
          request.sendHmsConfirmation.kind !== 'never' || !guarantees[request.guaranteeType] ||
          request.stay.arrival < '2027-01-01' || row.arrival !== request.stay.arrival ||
          row.departure !== request.stay.departure || census.arrival !== request.stay.arrival ||
          !request.sourceOfBusiness || !request.note) return false;
      const ages = request.stay.childAges;
      const expected = { arrival: request.stay.arrival, departure: request.stay.departure,
        adults: request.stay.adults, children: ages.length,
        childBands: { child1: ages.filter((age) => age <= 2).length,
          child2: ages.filter((age) => age >= 3 && age <= 12).length,
          child3: ages.filter((age) => age >= 13).length },
        roomType: request.room.roomType, ratePlan: request.room.ratePlan, note: request.note,
        guestId: request.guest.nativeId, source: request.sourceOfBusiness.description,
        organization: request.parties?.organization?.name ?? '', guarantee: guarantees[request.guaranteeType],
        guaranteeCode: request.guaranteeType, cmsRecipient: request.cmsRecipient ?? '',
        ...(request.track ? { track: request.track.display } : {}),
        ...(request.booker ? { booker: request.booker } : {}),
        ...(request.guestOptIn === false ? { guestOptIn: false } : {}) };
      const proof = await read({ confirmation, stay: request.stay, expected });
      if (!Array.isArray(proof?.mismatches) || proof.mismatches.length || !Array.isArray(proof.fields)) return false;
      if (request.cmsMessageId !== undefined) {
        const fields = proof.fields.filter((field) => field.name === 'udfchar09');
        if (fields.length !== 1 || fields[0].value !== request.cmsMessageId) return false;
      }
      if (request.parties?.bookingAgency || request.parties?.organization) {
        const parties = await readParties({ confirmation, arrival: request.stay.arrival, guestId: request.guest.nativeId,
          agency: request.parties?.bookingAgency ?? null, organization: request.parties?.organization ?? null });
        if (parties?.outcome !== 'verified') return false;
      }
    }
    return true;
  } catch { return false; }
}
