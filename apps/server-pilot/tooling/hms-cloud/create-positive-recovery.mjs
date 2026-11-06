// A restart may confirm an interrupted Create only from an independent, positive HMS read.
import { digestCloudCreateRequest } from './create-request-binding.mjs';
import { searchLabtestPreimage } from './labtest-preimage.mjs';
import { readLabtestCreate } from './labtest-create-readback.mjs';
import { readCreateParties } from './create-party-readback.mjs';
import { withSavedStayAgentSession } from './saved-stay-agent-session.mjs';
import { withCenturionStay360Page } from '../playwright-quote/centurion-stay360.mjs';
import { installReadOnlyGuard } from '../playwright-quote/hms-read-only-guard.mjs';
import { CREATE_GUARANTEES, createCloudTargetKey, isLabtestGuest, sameCreateGuest, validCreateDates, validCreateGuest } from './cloud-create-policy.mjs';

const censusDefault = (stay, guest, cloudTargetKey) => withCenturionStay360Page((page) => searchLabtestPreimage(page,
  { ...stay, firstName: guest.firstName, lastName: guest.lastName }, { allowRealGuest: true, allowPast: true }), {
  headless: true, blockServiceWorkers: true, prepareContext: installReadOnlyGuard, cloudTargetKey,
});
const uniqueField = (fields, name) => {
  const found = fields.filter((field) => field.name === name);
  return found.length === 1 ? found[0].value : null;
};
const normalizeCurrency = (value) => String(value ?? '').trim().toUpperCase() === 'R' ? 'ZAR' : String(value ?? '').trim().toUpperCase();
const normalizeAmount = (value) => {
  const raw = String(value ?? '').trim(), numeric = raw.replace(/[^\d.-]/g, '');
  return /^-?\d+(?:\.\d+)?$/.test(numeric) ? Number(numeric).toFixed(2) : null;
};
function savedPrice(fields) {
  const averageRate = uniqueField(fields, 'averagerate'), totalRate = uniqueField(fields, 'totalrate');
  const currencies = ['averageratecurr', 'totalratecurr', 'currency'].map((name) => normalizeCurrency(uniqueField(fields, name)))
    .filter(Boolean);
  if (!currencies.length && [averageRate, totalRate].every((value) => /^(?:R|ZAR)\s*\d/i.test(String(value)) || /\bZAR$/i.test(String(value)))) {
    currencies.push('ZAR');
  }
  if (typeof averageRate !== 'string' && typeof averageRate !== 'number' ||
      typeof totalRate !== 'string' && typeof totalRate !== 'number' || !currencies.length || new Set(currencies).size !== 1) return null;
  return { averageRate: String(averageRate).trim(), totalRate: String(totalRate).trim(), currency: currencies[0] };
}
const samePrice = (actual, expected) => Boolean(actual && expected &&
  normalizeAmount(actual.averageRate) !== null && normalizeAmount(actual.averageRate) === normalizeAmount(expected.averageRate) &&
  normalizeAmount(actual.totalRate) !== null && normalizeAmount(actual.totalRate) === normalizeAmount(expected.totalRate) &&
  normalizeCurrency(actual.currency) === normalizeCurrency(expected.currency));
const blocked = (issue) => ({ outcome: 'unconfirmed', issue });

/** This reader never writes. Its optional dependencies exist for offline tests only. */
export async function provePositiveCreateRecovery(intent, { census = censusDefault,
  withSavedSession = withSavedStayAgentSession, partyReadback = readCreateParties } = {}) {
  try {
    const recovery = intent?.recovery, parsed = digestCloudCreateRequest(recovery?.request);
    if (intent?.operation !== 'create' || intent.propertyCode !== 'HRCEN' || !validCreateGuest(intent) || parsed.outcome !== 'ok' ||
        parsed.normalizedRequestDigest !== intent.approvedDigest) return blocked('intent_unverified');
    const request = parsed.request, { stay, guest, room } = request;
    if (request.propertyCode !== 'HRCEN' || guest.firstName !== intent.firstName || guest.lastName !== intent.lastName ||
        guest.nativeId !== intent.nativeGuestId || !validCreateDates(stay.arrival, stay.departure, true, true) ||
        !CREATE_GUARANTEES[request.guaranteeType] ||
        (request.sendHmsConfirmation.kind === 'send' && (isLabtestGuest(guest) ||
          !request.cmsMessageId || request.cmsRecipient !== request.sendHmsConfirmation.recipient)) ||
        typeof request.note !== 'string' ||
        recovery.guaranteeDisplay !== CREATE_GUARANTEES[request.guaranteeType] ||
        (request.parties?.arAccount && !/^\d+$/.test(String(recovery.arAccountProfileId ?? ''))) ||
        (request.billingReference !== undefined && !request.parties?.arAccount)) return blocked('intent_unverified');
    const preimage = recovery.preimage;
    if (preimage?.arrival !== stay.arrival || preimage?.departure !== stay.departure ||
        !Array.isArray(preimage.sameArrival) || preimage.sameArrival.length > 7 ||
        preimage.coverage?.complete !== true || !Number.isSafeInteger(preimage.coverage.displayed) ||
        preimage.coverage.displayed < preimage.sameArrival.length || preimage.coverage.displayed !== preimage.coverage.total ||
        preimage.searchedDateRange?.from > stay.arrival || preimage.searchedDateRange?.to < stay.arrival ||
        typeof preimage.searchedDateRange?.from !== 'string' || typeof preimage.searchedDateRange?.to !== 'string') {
      return blocked('preimage_unverified');
    }
    // The claim sealed only siblings that the server independently verified
    // before Save. Their exact identities must still be present in the census.
    const prior = preimage.sameArrival;
    const sameIdentity = (left, right) => left?.confirmation === right?.confirmation &&
      left?.firstName === right?.firstName && left?.lastName === right?.lastName &&
      left?.arrival === right?.arrival && left?.departure === right?.departure && left?.status === right?.status;
    if (new Set(prior.map((row) => row?.confirmation)).size !== prior.length || prior.some((row) =>
      !/^\d{6,10}-\d{1,2}$/.test(row?.confirmation || '') || !sameCreateGuest(row, guest) ||
      row.arrival !== stay.arrival || typeof row.departure !== 'string' || row.status !== 'Reserved')) {
      return blocked('preimage_unverified');
    }
    if (recovery.batchManifest !== undefined) {
      const manifest = recovery.batchManifest;
      if (!Array.isArray(manifest) || new Set(manifest.map((item) => item?.confirmation)).size !== manifest.length ||
          manifest.some((item) => {
            const bound = digestCloudCreateRequest(item?.approvedRequest);
            return bound.outcome !== 'ok' || bound.normalizedRequestDigest !== item?.requestDigest;
          })) return blocked('preimage_unverified');
      const matching = manifest.filter((item) => sameCreateGuest(item.approvedRequest.guest, guest) &&
        item.approvedRequest.stay.arrival === stay.arrival);
      if (matching.length !== prior.length || prior.some((row) => !matching.some((item) => item.confirmation === row.confirmation))) {
        return blocked('preimage_unverified');
      }
    }
    const cloudTargetKey = createCloudTargetKey(guest, stay.arrival);
    if (!cloudTargetKey) return blocked('intent_unverified');
    const listing = await census(stay, guest, cloudTargetKey);
    if (listing?.outcome !== 'existing_matches' || listing.arrival !== stay.arrival || listing.departure !== stay.departure ||
        listing.coverage?.complete !== true || !Number.isSafeInteger(listing.coverage.displayed) ||
        listing.coverage.displayed < 0 || listing.coverage.displayed !== listing.coverage.total ||
        typeof listing.searchedDateRange?.from !== 'string' || typeof listing.searchedDateRange?.to !== 'string' ||
        listing.searchedDateRange.from > stay.arrival || listing.searchedDateRange.to < stay.arrival ||
        !Array.isArray(listing.sameArrival) || listing.sameArrival.length !== prior.length + 1 ||
        listing.coverage.displayed < listing.sameArrival.length ||
        new Set(listing.sameArrival.map((row) => row?.confirmation)).size !== listing.sameArrival.length ||
        prior.some((row) => listing.sameArrival.filter((observed) => sameIdentity(row, observed)).length !== 1)) {
      return blocked('census_not_unique');
    }
    const candidate = listing.sameArrival.find((row) => !prior.some((before) => before.confirmation === row?.confirmation));
    if (!/^\d{6,10}-\d{1,2}$/.test(candidate?.confirmation || '') || !sameCreateGuest(candidate, guest) ||
        candidate.arrival !== stay.arrival || candidate.departure !== stay.departure ||
        candidate.status !== 'Reserved') return blocked('candidate_unverified');
    const ages = stay.childAges;
    const expected = { arrival: stay.arrival, departure: stay.departure, adults: stay.adults, children: ages.length,
      childBands: { child1: ages.filter((age) => age <= 2).length,
        child2: ages.filter((age) => age >= 3 && age <= 12).length, child3: ages.filter((age) => age >= 13).length },
      roomType: room.roomType, ratePlan: room.ratePlan, note: request.note, guestId: guest.nativeId,
      firstName: guest.firstName, lastName: guest.lastName, allowRealGuest: true,
      ...(request.sourceOfBusiness ? { source: request.sourceOfBusiness.description } : {}),
      organization: request.parties?.organization?.name ?? '',
      guarantee: recovery.guaranteeDisplay, guaranteeCode: request.guaranteeType,
      cmsSend: request.sendHmsConfirmation.kind === 'send',
      ...(request.cmsMessageId !== undefined ? { cmsMessageId: request.cmsMessageId } : {}),
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
      { withSavedSession: captureSession, cloudTargetKey });
    if (!Array.isArray(readback?.fields) || !Array.isArray(readback.mismatches) || readback.mismatches.length ||
        !Buffer.isBuffer(screenshot) || !screenshot.length ||
        (recovery.ratePlanAvailability !== undefined && !samePrice(savedPrice(readback.fields), recovery.ratePlanAvailability)) ||
        (request.reasonForStay && uniqueField(readback.fields, 'reasonforstay') !== request.reasonForStay.display) ||
        (request.cmsMessageId && uniqueField(readback.fields, 'udfchar09') !== request.cmsMessageId)) {
      return blocked('readback_unverified');
    }
    const partyProof = await partyReadback({ confirmation: candidate.confirmation, arrival: stay.arrival,
      guestId: guest.nativeId, firstName: guest.firstName, lastName: guest.lastName, allowRealGuest: true,
      agency: request.parties?.bookingAgency ?? null,
      organization: request.parties?.organization ?? null,
      arAccount: request.parties?.arAccount ? { ...request.parties.arAccount, profileId: recovery.arAccountProfileId } : null,
      ...(request.billingReference !== undefined ? { billingReference: request.billingReference } : {}) }, { cloudTargetKey });
    if (partyProof?.outcome !== 'verified') return blocked('party_readback_unverified');
    return { outcome: 'verified', confirmation: candidate.confirmation, readback: { ...readback, partyProof }, screenshot };
  } catch { return blocked('readback_unavailable'); }
}
