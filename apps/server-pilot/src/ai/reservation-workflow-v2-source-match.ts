import { normalizeRequestedMealPlan } from './reservation-workflow-v2-meal-plan.js';
import type { ReservationWorkflowV2Extraction, ReservationWorkflowV2Proposal } from './reservation-workflow-v2-contract.js';

export const requestTextKey = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');

export function extractionRefsForRequest(request: ReservationWorkflowV2Extraction['requests'][number]): Set<string> {
  const refs = new Set<string>(request.requestText.sourceRefs);
  request.dates.forEach((date) => { date.arrival?.sourceRefs.forEach((ref) => refs.add(ref)); date.departure?.sourceRefs.forEach((ref) => refs.add(ref));
    date.roomCount?.sourceRefs.forEach((ref) => refs.add(ref)); date.mealPlan?.sourceRefs.forEach((ref) => refs.add(ref));
    date.guestNames?.forEach((claim) => claim.sourceRefs.forEach((ref) => refs.add(ref))); });
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
  const exactId = extraction.requests.filter((candidate) => candidate.id === request.id && candidate.kind === request.kind);
  const otherRequestsWithId = proposalRequests.filter((candidate) => candidate.id === request.id && candidate.kind === request.kind);
  if (exactId.length === 1 && otherRequestsWithId.length === 1) return exactId[0]!;
  const matchesFacts = (proposal: typeof request, extracted: typeof extraction.requests[number]) => {
    if (proposal.kind !== extracted.kind || proposal.kind !== 'quote' || !proposal.body.groups.length) return false;
    const dates = extracted.dates.filter(date => typeof date.arrival?.value === 'string' && typeof date.departure?.value === 'string');
    if (!dates.length || !proposal.body.groups.every(group => dates.some(date =>
      date.arrival?.value === group.arrival && date.departure?.value === group.departure))) return false;
    const sourceBoards = new Set([...extracted.mealPlanHints, ...extracted.dates.flatMap(date => date.mealPlan ? [date.mealPlan] : [])]
      .map(claim => normalizeRequestedMealPlan(claim.value).mealPlan).filter(Boolean));
    const proposedBoards = proposal.body.groups.map(group => normalizeRequestedMealPlan(group.requestedMealPlan ?? group.mealPlan).mealPlan);
    if (sourceBoards.size === 1 && proposedBoards.some(board => board && !sourceBoards.has(board))) return false;
    const count = extracted.roomCount?.value;
    return typeof count !== 'number' || proposal.body.groups.reduce((sum, group) => sum + (group.quantity ?? 0), 0) === count;
  };
  const factMatches = extraction.requests.filter(candidate => matchesFacts(request, candidate));
  if (factMatches.length === 1 && proposalRequests.filter(candidate => matchesFacts(candidate, factMatches[0]!)).length === 1)
    return factMatches[0]!;
  if (extraction.requests.length > 1 || proposalRequests.length > 1) return null;
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
