import type { ReservationWorkflowV2Extraction, ReservationWorkflowV2Proposal } from './reservation-workflow-v2-contract.js';

export const requestTextKey = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');

export function extractionRefsForRequest(request: ReservationWorkflowV2Extraction['requests'][number]): Set<string> {
  const refs = new Set<string>(request.requestText.sourceRefs);
  request.dates.forEach((date) => { date.arrival?.sourceRefs.forEach((ref) => refs.add(ref)); date.departure?.sourceRefs.forEach((ref) => refs.add(ref)); });
  request.roomCount?.sourceRefs.forEach((ref) => refs.add(ref));
  request.occupancy.forEach((row) => { row.adults?.sourceRefs.forEach((ref) => refs.add(ref)); row.childCount?.sourceRefs.forEach((ref) => refs.add(ref));
    row.childAges?.forEach((claim) => claim.sourceRefs.forEach((ref) => refs.add(ref))); });
  request.guests.forEach((guest) => { guest.name?.sourceRefs.forEach((ref) => refs.add(ref)); guest.email?.sourceRefs.forEach((ref) => refs.add(ref));
    guest.mobile?.sourceRefs.forEach((ref) => refs.add(ref)); });
  request.parties.forEach((party) => party.name.sourceRefs.forEach((ref) => refs.add(ref)));
  request.confirmationHints.forEach((claim) => claim.sourceRefs.forEach((ref) => refs.add(ref)));
  request.roomTypeHints.forEach((claim) => claim.sourceRefs.forEach((ref) => refs.add(ref)));
  request.rateHints.forEach((claim) => claim.sourceRefs.forEach((ref) => refs.add(ref)));
  request.mealPlanHints.forEach((claim) => claim.sourceRefs.forEach((ref) => refs.add(ref)));
  request.serviceHints.forEach((claim) => claim.sourceRefs.forEach((ref) => refs.add(ref)));
  if (request.requestedPrice) {
    request.requestedPrice.nightlyRate?.sourceRefs.forEach((ref) => refs.add(ref));
    request.requestedPrice.total?.sourceRefs.forEach((ref) => refs.add(ref));
    request.requestedPrice.currency?.sourceRefs.forEach((ref) => refs.add(ref));
  }
  request.documentHints.forEach((hint) => {
    refs.add(hint.documentRef);
    hint.sourceRefs.forEach((ref) => refs.add(ref));
  });
  request.documentRefs.forEach((ref) => refs.add(ref));
  return refs;
}

export function extractionRequestForProposal(
  request: ReservationWorkflowV2Proposal['content']['requests'][number],
  proposalRequests: ReservationWorkflowV2Proposal['content']['requests'],
  extraction: ReservationWorkflowV2Extraction,
  extractionIdByProposalRequestId?: ReadonlyMap<string, string>,
): ReservationWorkflowV2Extraction['requests'][number] | null {
  const mappedId = extractionIdByProposalRequestId?.get(request.id);
  if (mappedId) {
    const mapped = extraction.requests.filter((candidate) => candidate.id === mappedId && candidate.kind === request.kind);
    if (mapped.length === 1) return mapped[0]!;
  }
  const exactText = extraction.requests.filter((candidate) => candidate.kind === request.kind &&
    requestTextKey(candidate.requestText.raw) === requestTextKey(request.requestText));
  const proposalsWithExactText = proposalRequests.filter((candidate) => candidate.kind === request.kind &&
    requestTextKey(candidate.requestText) === requestTextKey(request.requestText));
  if (requestTextKey(request.requestText) && exactText.length === 1 && proposalsWithExactText.length === 1) return exactText[0]!;
  if (mappedId) return null;
  // Model IDs and shared email evidence cannot identify one of several requests.
  if (extraction.requests.length > 1 || proposalRequests.length > 1) return null;
  const exactId = extraction.requests.filter((candidate) => candidate.id === request.id && candidate.kind === request.kind);
  const otherRequestsWithId = proposalRequests.filter((candidate) => candidate.id === request.id && candidate.kind === request.kind);
  if (exactId.length === 1 && otherRequestsWithId.length === 1) return exactId[0]!;
  const corresponds = (candidate: ReservationWorkflowV2Proposal['content']['requests'][number],
    extracted: ReservationWorkflowV2Extraction['requests'][number]) => candidate.kind === extracted.kind &&
    (candidate.id === extracted.id || requestTextKey(candidate.requestText) === requestTextKey(extracted.requestText.raw) ||
      [...extractionRefsForRequest(extracted)].some((ref) => candidate.sourceRefs.includes(ref)));
  const matches = extraction.requests.filter((candidate) => candidate.kind === request.kind &&
    (requestTextKey(candidate.requestText.raw) === requestTextKey(request.requestText) ||
      [...extractionRefsForRequest(candidate)].some((ref) => request.sourceRefs.includes(ref))));
  if (matches.length !== 1) return null;
  const linkedProposalRequests = proposalRequests.filter((candidate) => corresponds(candidate, matches[0]!));
  if (linkedProposalRequests.length === 1 && linkedProposalRequests[0] === request) return matches[0]!;
  return null;
}
