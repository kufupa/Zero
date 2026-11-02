import { describe, expect, it } from 'vitest';
import { checkCloudSavedStayAmendHold, cloudSavedStayAmendEnvelopeSchema } from '../src/ai/cloud-saved-stay-amend.js';

const envelope = { executor: 'cloud-write/v1', action: 'amend', propertyCode: 'HRCEN', payload: {
  source: { threadId: 't', messageId: 'm', mailboxEmail: 'hotel@example.test', sourceHash: 'a'.repeat(64) },
  preimageRef: 'opaque-ref', proposal: { confirmation: '12345678-1', changes: { arrival: '2027-10-01', adults: 2 } },
} };

describe('Cloud saved stay amendment envelope', () => {
  it('accepts valid proposals but never authorises or dispatches an unproven save', () => {
    expect(cloudSavedStayAmendEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(checkCloudSavedStayAmendHold(envelope)).toEqual({ outcome: 'not_dispatched', issue: 'NATIVE_AMEND_SAVE_NOT_VERIFIED' });
  });
  it('rejects malformed source, property, unexpected fields and invalid dates', () => {
    for (const bad of [
      { ...envelope, propertyCode: '' },
      { ...envelope, propertyCode: 'HRCEN_OTHER' },
      { ...envelope, propertyCode: 'A' },
      { ...envelope, payload: { ...envelope.payload, source: { ...envelope.payload.source, sourceHash: 'bad' } } },
      { ...envelope, payload: { ...envelope.payload, bypass: true } },
      { ...envelope, payload: { ...envelope.payload, proposal: { ...envelope.payload.proposal, changes: { departure: '2027-02-30' } } } },
      { ...envelope, payload: { ...envelope.payload, proposal: { ...envelope.payload.proposal, changes: {} } } },
    ]) expect(checkCloudSavedStayAmendHold(bad).outcome).toBe('input_gap');
  });
  it('accepts rate-plan and explicit retain-rate proposals without enabling save', () => {
    for (const retainRates of ['yes', 'no']) {
      const input = { ...envelope, payload: { ...envelope.payload, proposal: {
        confirmation: '12345678-1', changes: { ratePlan: 'BAR', arrival: '2027-10-01' }, retainRates,
      } } };
      expect(checkCloudSavedStayAmendHold(input)).toEqual({ outcome: 'not_dispatched', issue: 'NATIVE_AMEND_SAVE_NOT_VERIFIED' });
    }
    const propose = (changes: unknown, retainRates: unknown) => ({ ...envelope, payload: { ...envelope.payload,
      proposal: { confirmation: '12345678-1', changes, retainRates } } });
    expect(checkCloudSavedStayAmendHold(propose({ ratePlan: '  ' }, 'yes')).outcome).toBe('input_gap');
    expect(checkCloudSavedStayAmendHold(propose({ ratePlan: 'BAR' }, 'maybe')).outcome).toBe('input_gap');
    expect(checkCloudSavedStayAmendHold(propose({}, 'yes')).outcome).toBe('input_gap');
    expect(checkCloudSavedStayAmendHold(propose({ adults: undefined }, 'yes')).outcome).toBe('input_gap');
  });

  it('requires matching child ages and rejects unsupported amount changes', () => {
    const propose = (changes: unknown) => ({ ...envelope, payload: { ...envelope.payload, proposal: { ...envelope.payload.proposal, changes } } });
    expect(checkCloudSavedStayAmendHold(propose({ children: 2, childAges: [7] })).outcome).toBe('input_gap');
    expect(checkCloudSavedStayAmendHold(propose({ childAges: [7] })).outcome).toBe('input_gap');
    expect(checkCloudSavedStayAmendHold(propose({ children: 0, childAges: [] })).outcome).toBe('not_dispatched');
    expect(checkCloudSavedStayAmendHold(propose({ amount: { amount: '90', currency: 'ZAR', basis: 'per_night', tax: 'included', authorisedBy: '' } })).outcome).toBe('input_gap');
    expect(checkCloudSavedStayAmendHold(propose({ amount: { amount: '90', currency: 'ZAR', basis: 'per_night', tax: 'included', authorisedBy: 'Manager' } })).outcome).toBe('input_gap');
  });
});
