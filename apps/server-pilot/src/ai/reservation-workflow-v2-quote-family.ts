import type { ReservationWorkflowV2Draft } from './reservation-workflow-v2-contract.js';

type Member = { requestId: string; label: string };
export type QuoteFamilyOption = { id: string; label: string; members: Member[] };

/** Resolve the complete options represented by the individual native date runs. */
export function quoteFamilyOptions(draft: ReservationWorkflowV2Draft, requestId: string): QuoteFamilyOption[] | null {
  const requests = draft.proposal.content.requests;
  const request = requests.find(row => row.id === requestId && row.kind === 'quote');
  if (!request || request.kind !== 'quote') return null;
  const family = request.body.quoteFamily;
  if (!family) return [{ id: requestId, label: 'Quote', members: [{ requestId, label: 'Quote' }] }];
  const members = family.members;
  if (new Set(members.map(member => member.requestId)).size !== members.length ||
      members.filter(member => member.requestId === requestId && member.label === family.label).length !== 1) return null;
  const siblings = requests.filter(row => row.kind === 'quote' && row.body.quoteFamily?.id === family.id);
  if (siblings.length !== members.length || members.some(member => {
    const sibling = siblings.find(row => row.id === member.requestId);
    return !sibling || sibling.kind !== 'quote' || sibling.body.quoteFamily?.label !== member.label ||
      JSON.stringify(sibling.body.quoteFamily.members) !== JSON.stringify(members) ||
      JSON.stringify(sibling.body.quoteFamily.composition) !== JSON.stringify(family.composition);
  })) return null;
  if (!family.composition) return null;
  if (family.composition.kind === 'additive') return [{ id: family.id, label: 'Quote', members }];
  const options = family.composition.options;
  const ids = options.flatMap(option => option.requestIds);
  if (new Set(options.map(option => option.id)).size !== options.length ||
      new Set(ids).size !== ids.length || ids.length !== members.length ||
      ids.some(id => !members.some(member => member.requestId === id))) return null;
  return options.map(option => ({ id: option.id, label: option.label,
    members: option.requestIds.map(id => members.find(member => member.requestId === id)!) }));
}
