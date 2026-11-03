// A restart may confirm an interrupted Create only from an independent, positive HMS read.
import { digestCloudCreateRequest } from './create-request-binding.mjs';
import { searchLabtestPreimage } from './labtest-preimage.mjs';
import { readLabtestCreate } from './labtest-create-readback.mjs';
import { readCreateParties } from './create-party-readback.mjs';
import { withSavedStayAgentSession } from './saved-stay-agent-session.mjs';
import { centurionWriterQuiesced, withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';

const censusDefault = (stay) => withCenturionStay360Page((page) => searchLabtestPreimage(page, stay), {
  headless: true, blockServiceWorkers: true, prepareContext: installReadOnlyGuard,
});
const uniqueField = (fields, name) => {
  const found = fields.filter((field) => field.name === name);
  return found.length === 1 ? found[0].value : null;
};
const blocked = (issue) => ({ outcome: 'unconfirmed', issue });

/** This reader never writes. Its optional dependencies exist for offline tests only. */
export async function provePositiveCreateRecovery(intent, { census = censusDefault,
  withSavedSession = withSavedStayAgentSession, partyReadback = readCreateParties,
  writerQuiesced = centurionWriterQuiesced } = {}) {
  try {
    const recovery = intent?.recovery, parsed = digestCloudCreateRequest(recovery?.request);
    if (intent?.operation !== 'create' || intent.propertyCode !== 'HRCEN' || intent.firstName !== 'Proof' ||
        intent.lastName !== 'Labtest' || !writerQuiesced(recovery?.writer) || parsed.outcome !== 'ok' ||
        parsed.normalizedRequestDigest !== intent.approvedDigest) return blocked('intent_unverified');
    const request = parsed.request, { stay, guest, room } = request;
    if (request.propertyCode !== 'HRCEN' || guest.firstName !== 'Proof' || guest.lastName !== 'Labtest' ||
        guest.nativeId !== intent.nativeGuestId || stay.arrival < '2027-01-01' ||
        !['NGI', 'GTDAGT'].includes(request.guaranteeType) || request.sendHmsConfirmation?.kind !== 'never' ||
        typeof request.note !== 'string' || !request.sourceOfBusiness?.description ||
        typeof recovery.guaranteeDisplay !== 'string' || !recovery.guaranteeDisplay.trim() ||
        request.parties?.arAccount || request.billingReference !== undefined) return blocked('intent_unverified');
    const preimage = recovery.preimage;
    if (preimage?.arrival !== stay.arrival || preimage?.departure !== stay.departure ||
        !Array.isArray(preimage.sameArrival) || preimage.sameArrival.length !== 0 ||
        preimage.coverage?.complete !== true || !Number.isSafeInteger(preimage.coverage.displayed) ||
        preimage.coverage.displayed < 0 || preimage.coverage.displayed !== preimage.coverage.total ||
        preimage.searchedDateRange?.from > stay.arrival || preimage.searchedDateRange?.to < stay.arrival ||
        typeof preimage.searchedDateRange?.from !== 'string' || typeof preimage.searchedDateRange?.to !== 'string') {
      return blocked('preimage_unverified');
    }
    const listing = await census(stay);
    if (listing?.outcome !== 'existing_matches' || listing.arrival !== stay.arrival || listing.departure !== stay.departure ||
        listing.coverage?.complete !== true || !Number.isSafeInteger(listing.coverage.displayed) ||
        listing.coverage.displayed < 0 || listing.coverage.displayed !== listing.coverage.total ||
        typeof listing.searchedDateRange?.from !== 'string' || typeof listing.searchedDateRange?.to !== 'string' ||
        listing.searchedDateRange.from > stay.arrival || listing.searchedDateRange.to < stay.arrival ||
        !Array.isArray(listing.sameArrival) || listing.sameArrival.length !== 1) return blocked('census_not_unique');
    const candidate = listing.sameArrival[0];
    if (!/^\d{6,10}-\d{1,2}$/.test(candidate?.confirmation || '') || candidate.firstName !== 'Proof' ||
        candidate.lastName !== 'Labtest' || candidate.arrival !== stay.arrival || candidate.departure !== stay.departure ||
        candidate.status !== 'Reserved') return blocked('candidate_unverified');
    const ages = stay.childAges;
    const expected = { arrival: stay.arrival, departure: stay.departure, adults: stay.adults, children: ages.length,
      childBands: { child1: ages.filter((age) => age <= 2).length,
        child2: ages.filter((age) => age >= 3 && age <= 12).length, child3: ages.filter((age) => age >= 13).length },
      roomType: room.roomType, ratePlan: room.ratePlan, note: request.note, guestId: guest.nativeId,
      source: request.sourceOfBusiness.description, organization: request.parties?.organization?.name ?? '',
      guarantee: recovery.guaranteeDisplay, guaranteeCode: request.guaranteeType,
      ...(request.track ? { track: request.track.display } : {}),
      ...(request.guestOptIn === false ? { guestOptIn: false } : {}),
      ...(request.booker ? { booker: request.booker } : {}),
      ...(request.cmsRecipient !== undefined ? { cmsRecipient: request.cmsRecipient } : {}) };
    let screenshot;
    const captureSession = (operation, options) => withSavedSession(async (session) => {
      const value = await operation(session);
      if (value?.outcome === 'ok') screenshot = await session.screenshotRecord();
      return value;
    }, options);
    const readback = await readLabtestCreate({ confirmation: candidate.confirmation, stay, expected },
      { withSavedSession: captureSession });
    if (!Array.isArray(readback?.fields) || !Array.isArray(readback.mismatches) || readback.mismatches.length ||
        !Buffer.isBuffer(screenshot) || !screenshot.length ||
        (request.reasonForStay && uniqueField(readback.fields, 'reasonforstay') !== request.reasonForStay.display) ||
        (request.cmsMessageId && uniqueField(readback.fields, 'udfchar09') !== request.cmsMessageId)) {
      return blocked('readback_unverified');
    }
    const partyProof = await partyReadback({ confirmation: candidate.confirmation, arrival: stay.arrival,
      guestId: guest.nativeId, agency: request.parties?.bookingAgency ?? null,
      organization: request.parties?.organization ?? null, arAccount: null });
    if (partyProof?.outcome !== 'verified') return blocked('party_readback_unverified');
    return { outcome: 'verified', confirmation: candidate.confirmation, readback: { ...readback, partyProof }, screenshot };
  } catch { return blocked('readback_unavailable'); }
}
