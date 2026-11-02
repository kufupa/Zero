import { describe, expect, it } from 'vitest';
import { buildVoucherFilingCandidate } from '../src/ai/voucher-filing-candidate.js';

const selection = { workItemId: 'work', messageId: 'message', attachmentId: 'attachment', kind: 'voucher' as const,
  stay: { confirmation: '123-1', arrival: '2027-01-01', lastName: 'Labtest' } };
const scope = { transportId: 'mailbox', workItemId: 'work', messageId: 'message', propertyCode: 'HRCEN' };
const source = { transportId: 'mailbox', messageId: 'message', attachmentId: 'attachment', filename: 'proof.pdf',
  mimeType: 'application/pdf' as const, sha256: 'a'.repeat(64), snapshotDigest: 'b'.repeat(64) };
const stay = { confirmation: '123-1', arrival: '2027-01-01', firstName: 'Proof', lastName: 'Labtest' };
const candidate = () => ({ selection: structuredClone(selection), scope: { ...scope }, source: { ...source }, stay: { ...stay } });

describe('filing candidate', () => {
  it('binds the server-resolved attachment and guest without approving or preparing', () => {
    expect(buildVoucherFilingCandidate(candidate())).toEqual({ status: 'candidate', form: {
      executor: 'cloud-write/v1', action: 'attach_document', propertyCode: 'HRCEN',
      payload: { source, stay, kind: 'voucher' },
    }, expectedSessionId: null });
    const input = candidate(); input.selection.stay.lastName = 'labtest';
    expect(buildVoucherFilingCandidate(input).status).toBe('candidate');
    expect(buildVoucherFilingCandidate({ ...candidate(), selection: { ...selection, expectedSessionId: 'open-session' } }))
      .toMatchObject({ status: 'candidate', expectedSessionId: 'open-session' });
  });

  it('rejects pane-provided authority and unexpected fields', () => {
    for (const extra of [{ grantRef: 'attacker' }, { transportId: 'other' }, { propertyCode: 'OTHER' }, { sha256: 'x' }]) {
      expect(buildVoucherFilingCandidate({ ...candidate(), selection: { ...selection, ...extra } })).toEqual({
        status: 'refused', reason: 'selection_invalid',
      });
    }
  });

  it('rejects a different work item, message, mailbox or attachment', () => {
    for (const change of [
      { scope: { ...scope, workItemId: 'other' } }, { scope: { ...scope, messageId: 'other' } },
      { scope: { ...scope, transportId: '' } },
    ]) expect(buildVoucherFilingCandidate({ ...candidate(), ...change })).toEqual({ status: 'refused', reason: 'scope_mismatch' });
    for (const change of [
      { source: { ...source, transportId: 'other' } }, { source: { ...source, messageId: 'other' } },
      { source: { ...source, attachmentId: 'other' } },
    ]) expect(buildVoucherFilingCandidate({ ...candidate(), ...change })).toEqual({ status: 'refused', reason: 'source_mismatch' });
  });

  it('rejects another booking, arrival or guest', () => {
    for (const changed of [{ confirmation: '999-1' }, { arrival: '2027-01-02' }, { lastName: 'Other' }]) {
      expect(buildVoucherFilingCandidate({ ...candidate(), stay: { ...stay, ...changed } })).toEqual({
        status: 'refused', reason: 'stay_mismatch',
      });
    }
  });

  it('rejects invalid trusted data rather than emitting an invalid candidate', () => {
    for (const changed of [{ filename: '../proof.pdf' }, { filename: 'proof.png' }, { sha256: '' }, { snapshotDigest: '' }, { mimeType: 'image/png' }]) {
      expect(buildVoucherFilingCandidate({ ...candidate(), source: { ...source, ...changed } as typeof source })).toEqual({
        status: 'refused', reason: 'form_invalid',
      });
    }
    expect(buildVoucherFilingCandidate({ ...candidate(), scope: { ...scope, propertyCode: 'invalid' } })).toEqual({
      status: 'refused', reason: 'form_invalid',
    });
  });
});
