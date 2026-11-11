import type { ReservationWorkflowV2Extraction, ReservationWorkflowV2Proposal } from './reservation-workflow-v2-contract.js';

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
  request.boardHints.forEach((claim) => claim.sourceRefs.forEach((ref) => refs.add(ref)));
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
  const mapped = mappedId ? extraction.requests.find((candidate) => candidate.id === mappedId && candidate.kind === request.kind) : null;
  if (mapped) return mapped;
  const exactText = extraction.requests.filter((candidate) => candidate.kind === request.kind &&
    candidate.requestText.raw.trim() === request.requestText.trim());
  const proposalsWithExactText = proposalRequests.filter((candidate) => candidate.kind === request.kind &&
    candidate.requestText.trim() === request.requestText.trim());
  if (exactText.length === 1 && proposalsWithExactText.length === 1) return exactText[0]!;
  // Shared message evidence is common when one email asks for multiple bookings.
  // After preferring an exact source-text match, a unique model-provided ID is the
  // next strongest link; waiting for unique evidence refs drops otherwise-filled rows.
  const exactId = extraction.requests.filter((candidate) => candidate.id === request.id && candidate.kind === request.kind);
  const otherRequestsWithId = proposalRequests.filter((candidate) => candidate.id === request.id && candidate.kind === request.kind);
  if (exactId.length === 1 && otherRequestsWithId.length === 1) return exactId[0]!;
  const corresponds = (candidate: ReservationWorkflowV2Proposal['content']['requests'][number],
    extracted: ReservationWorkflowV2Extraction['requests'][number]) => candidate.kind === extracted.kind &&
    (candidate.id === extracted.id || candidate.requestText.trim() === extracted.requestText.raw.trim() ||
      [...extractionRefsForRequest(extracted)].some((ref) => candidate.sourceRefs.includes(ref)));
  const matches = extraction.requests.filter((candidate) => candidate.kind === request.kind &&
    (candidate.requestText.raw.trim() === request.requestText.trim() ||
      [...extractionRefsForRequest(candidate)].some((ref) => request.sourceRefs.includes(ref))));
  if (matches.length !== 1) return null;
  const linkedProposalRequests = proposalRequests.filter((candidate) => corresponds(candidate, matches[0]!));
  if (linkedProposalRequests.length === 1 && linkedProposalRequests[0] === request) return matches[0]!;
  return null;
}
