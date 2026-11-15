import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isExcludedRefundArAccount, loadReservationMemoryGuidance, loadReservationNativeLeads } from '../src/ai/reservation-workflow-v2-native-leads.js';
import type { ReservationWorkflowV2Proposal } from '../src/ai/reservation-workflow-v2-contract.js';
import * as nativeCatalog from '../src/ai/native-catalog-lookup.js';

afterEach(() => { vi.restoreAllMocks(); });

const fixture = vi.hoisted(() => ({ memory: {} as unknown }));
vi.mock('../tooling/hms-cloud/booking-lookup-session.mjs', () => ({
  loadOptionalBookingMemory: async () => ({ memory: fixture.memory }),
}));

const source = { messageId: 'current', threadId: 'current-thread', sourceHash: 'a'.repeat(64), arrivedAt: '2026-11-14T00:00:00.000Z' };
function setup(names: string[], email: string, organizations = names.map(() => 'Company One')) {
  const fields = (values: string[] = []) => ({ recordView: values, stay360: [], incompleteSources: [] });
  const observations = names.map((name, index) => ({ confirmationKey: `${1000000 + index}-1`, confirmationNumber: `${1000000 + index}-1`,
    observationId: `observation-${index}`, snapshotId: `snapshot-${index}`, sourceOfBusiness: 'E-Mail',
    historicalIdentity: { nativeConfirmation: 'matched' }, historicalHints: { guaranteeType: fields(['CC']), track: fields(['COR']),
      ratePlan: fields(['RATE1']), roomType: fields([]) }, historicalNoteFields: fields(['BB to agent']),
    outcomes: [{ combination: { bookingAgency: name, organization: organizations[index], arAccount: 'Refund Account', bookingAgencyContract: null },
      conflictingFields: [], fieldSources: {} }] }));
  fixture.memory = { propertyCode: 'HRCEN', snapshots: observations.map(row => ({ snapshotId: row.snapshotId,
    startedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })), observations,
    addressEvidence: observations.map(row => ({ confirmationKey: row.confirmationKey, address: email, domain: email.split('@')[1],
      role: 'inbound-sender', sentAt: '2026-01-01T00:00:00.000Z', linkMethod: 'attachment-id',
      linkProvenance: { ambiguousAttachment: false, labeledConfirmationMatch: true, subjectHasOtherConfirmation: false },
      linkedPmsSnapshotIds: [row.snapshotId], linkedPmsObservationIds: [row.observationId] })) };
  return { propertyCode: 'HRCEN', source, generationId: randomUUID(), fromAddress: email,
    sourceThreadMessageIds: [], env: { HMS_MEMORY_DATA_DIR: `/tmp/${randomUUID()}` } };
}
const proposal = { content: { requests: [{ id: 'r1', kind: 'create', body: { shared: {}, dateSections: [], allocations: [] } }], services: [], documents: [] },
  annotations: [], issues: [], sourceClaims: [], lookupResultRefs: [] } as unknown as ReservationWorkflowV2Proposal;
async function leads(input: ReturnType<typeof setup>, role: string, currentProposal = proposal) {
  const rows = await loadReservationNativeLeads({ ...input, proposal: currentProposal });
  const observation = rows.find(row => row.criteria.kind === 'historical_lookup_leads' && row.criteria.role === role);
  return (observation?.result.leads ?? []) as Array<Record<string, unknown>>;
}

describe('reservation memory eligibility', () => {
  it('keeps freemail party leads advisory and guidance sender-scoped', async () => {
    const input = setup(['Agency One', 'Agency One'], 'guest@gmail.com');
    expect(await leads(input, 'bookingAgency')).toContainEqual(expect.objectContaining({ support: 2, autoSelectable: false, blockedReason: 'staff_confirmation_required' }));
    expect(await loadReservationMemoryGuidance(input)).toMatchObject({ status: 'available', webmailDomain: true, denominator: 2, scope: 'sender' });
    const bound = structuredClone(proposal);
    const request = bound.content.requests[0];
    if (request?.kind !== 'create') throw new Error('expected Create');
    request.body.shared.bookingAgency = { name: 'Agency One', candidateRefs: ['verified'], suggestedRef: 'verified' };
    expect(await leads(input, 'bookingAgency', bound)).toContainEqual(expect.objectContaining({ basis: 'normalized_entity', autoSelectable: false }));
  });
  it('retains one-stay leads without auto-selection', async () => {
    const input = setup(['Agency One'], 'booker@business.test');
    expect(await leads(input, 'bookingAgency')).toContainEqual(expect.objectContaining({ support: 1, purity: 1, autoSelectable: false, blockedReason: 'staff_confirmation_required' }));
  });
  it('retains low purity and multi-client exact-sender choices without selecting them', async () => {
    const low = setup(['Agency One', 'Agency One', 'Agency Two'], 'booker@business.test');
    expect(await leads(low, 'bookingAgency')).toContainEqual(expect.objectContaining({ value: 'Agency One', support: 2, autoSelectable: false, blockedReason: 'staff_confirmation_required' }));
    const multi = setup(['Agency One', 'Agency One'], 'booker@business.test', ['Company One', 'Company Two']);
    expect(await leads(multi, 'bookingAgency')).toContainEqual(expect.objectContaining({ value: 'Agency One', autoSelectable: false, blockedReason: 'staff_confirmation_required' }));
  });
  it('excludes refund accounts without excluding legitimate agency names', () => {
    expect(isExcludedRefundArAccount('Refund Account')).toBe(true);
    expect(isExcludedRefundArAccount('Refund Travel')).toBe(false);
  });
  it('keeps exact and verified agency bases while blocking the refund account', async () => {
    const lookupVerifiedCode = vi.fn().mockReturnValue({ status: 'unique', record: { code: 'RATE1', meaning: 'Contract Rate' } });
    vi.spyOn(nativeCatalog, 'preloadNativeCatalogLookup').mockResolvedValue({ lookupVerifiedCode } as never);
    const input = setup(Array(4).fill('Refund Travel'), 'booker@business.test');
    const exact = (await leads(input, 'bookingAgency')).find(row => row.basis === 'exact_sender');
    expect(exact).toMatchObject({ value: 'Refund Travel', support: 4, denominator: 4, purity: 1, autoSelectable: false, blockedReason: 'staff_confirmation_required' });
    expect(exact?.confirmations).toHaveLength(3);
    expect(exact).not.toHaveProperty('evidenceRefs');
    expect(await leads(input, 'ar_account')).toEqual([]);
    const bound = structuredClone(proposal);
    const request = bound.content.requests[0];
    if (request?.kind !== 'create') throw new Error('expected Create');
    request.body.shared.bookingAgency = { name: 'Refund Travel', candidateRefs: ['verified'], suggestedRef: 'verified' };
    expect(await leads(input, 'bookingAgency', bound)).toContainEqual(expect.objectContaining({ basis: 'normalized_entity',
      sourceParty: expect.objectContaining({ role: 'bookingAgency', suggestedRef: 'verified' }), autoSelectable: false }));
    expect(await leads(input, 'rate_plan')).toContainEqual(expect.objectContaining({
      value: 'RATE1', label: 'RATE1 - Contract Rate', support: 4, autoSelectable: false }));
    lookupVerifiedCode.mockReturnValue({ status: 'not_found', record: null });
    expect(await leads(input, 'rate_plan')).toEqual([]);
    const accountInput = setup(Array(4).fill('Refund Travel'), 'booker@business.test');
    const memory = fixture.memory as { addressEvidence: Array<{ role: string }>;
      observations: Array<{ outcomes: Array<{ combination: { arAccount: string } }> }> };
    memory.observations.forEach(row => { row.outcomes[0]!.combination.arAccount = 'Account One'; });
    expect(await leads(accountInput, 'ar_account')).toContainEqual(expect.objectContaining({
      value: 'Account One', support: 4, autoSelectable: false }));
    const outboundInput = setup(Array(4).fill('Refund Travel'), 'booker@business.test');
    const outboundMemory = fixture.memory as { addressEvidence: Array<{ role: string }>; observations: Array<Record<string, unknown>> };
    outboundMemory.addressEvidence.forEach(row => { row.role = 'outbound-recipient'; });
    outboundMemory.observations.forEach(row => { row.historicalAutoTransfer = { value: true, evidence: 'stay360_auto_transfer_card_row' }; });
    if (request?.kind === 'create') request.body.shared.organization = { name: 'Company One', candidateRefs: [], suggestedRef: null };
    expect(await loadReservationNativeLeads({ ...outboundInput, proposal: bound })).toEqual([]);
    expect(await leads(outboundInput, 'bookingAgency', bound)).toEqual([]);
    expect(await loadReservationMemoryGuidance({ ...outboundInput, agencyName: 'Refund Travel' })).toMatchObject({
      status: 'unavailable', issue: 'booking_memory_identity_unavailable' });
  });
});
