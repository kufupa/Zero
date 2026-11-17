import { describe, expect, it } from 'vitest';
import { getQuotePackageOutput, quoteFamilyMembers } from '../lib/reservation-workflow/quote-output';
import type { ReservationPaneSnapshot, ReservationSourceContext } from '../lib/reservation-workflow/types';

const source = { mailboxId: 'mailbox', propertyId: 'HRCEN', threadId: 'thread', messageId: 'message', sourceHash: 'hash' } as ReservationSourceContext;
const kinds = ['email_quote', 'pdf_quote', 'xlsx_quote'];

function family() {
  const members = [{ requestId: 'one', label: 'Breakfast' }, { requestId: 'two', label: 'Room only' }];
  const composition = { kind: 'scenarios', options: members.map(member => ({ id: member.requestId,
    label: member.label, requestIds: [member.requestId], evidenceRefs: [] })) };
  const requests = members.map(member => ({ id: member.requestId, kind: 'quote', body: {
    outputIntent: { artifacts: kinds }, quoteFamily: { id: 'family', label: member.label, members, composition },
  } }));
  const operations = members.map(member => ({ id: `op-${member.requestId}`, requestId: member.requestId,
    workflow: 'quote', generationId: 'generation', status: 'succeeded', draftRevision: 1,
    observationRefs: [`document-${member.requestId}`] }));
  const observations = members.flatMap(member => {
    const common = { generationId: 'generation', propertyCode: 'HRCEN', sourceMessageId: 'message',
      status: 'complete', coverage: { complete: true } };
    return [
      { ...common, ref: `price-${member.requestId}`, kind: 'rate_availability',
        criteria: { workflow: 'quote', requestId: member.requestId, sourceHash: 'hash', inputDigest: `digest-${member.requestId}` },
        result: { freshUntil: new Date(Date.now() + 60_000).toISOString() } },
      { ...common, ref: `document-${member.requestId}`, kind: 'document', sourceRefs: [`price-${member.requestId}`],
        criteria: { workflow: 'quote', requestId: member.requestId, operationId: `op-${member.requestId}`, inputDigest: `digest-${member.requestId}` },
        result: { sourceHash: 'hash', requestedOutputKinds: kinds, preparedObservationRef: `price-${member.requestId}`,
          coverEmail: { to: 'recipient@example.test', subject: 'Quote', body: `${member.label}: 100` }, failures: [],
          artifacts: ['pdf_quote', 'xlsx_quote'].map((kind, index) => ({ kind, fileName: index ? 'Quote.xlsx' : 'Quote.pdf',
            mimeType: index ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf',
            sizeBytes: 1, sha256: 'a'.repeat(64), bytesBase64: 'YQ==' })) } },
    ];
  });
  const draft = { transportId: 'mailbox', propertyCode: 'HRCEN', source: { messageId: 'message', threadId: 'thread', sourceHash: 'hash' },
    generationId: 'generation', proposal: { content: { requests } }, fieldOverrides: {}, operationResults: operations, observations };
  const snapshot = { sourceMessageId: 'message', session: { revision: 1, draft } } as unknown as ReservationPaneSnapshot;
  return { snapshot, requests, operations, observations };
}

describe('quote option delivery', () => {
  it('combines every independently generated option into one draft with distinct file names', () => {
    const { snapshot } = family();
    const output = getQuotePackageOutput(source, snapshot, 'one');
    expect(output?.cover?.body).toContain('Breakfast: 100');
    expect(output?.cover?.body).toContain('Room only: 100');
    expect(output?.artifacts.map(item => item.fileName)).toEqual([
      'Option 1 - Quote.pdf', 'Option 1 - Quote.xlsx', 'Option 2 - Quote.pdf', 'Option 2 - Quote.xlsx',
    ]);
  });

  it('withholds the entire draft if an option is missing, stale or addressed elsewhere', () => {
    const first = family(); first.operations.pop();
    expect(getQuotePackageOutput(source, first.snapshot, 'one')).toBeNull();
    const second = family(); second.operations[1]!.draftRevision = 0;
    expect(getQuotePackageOutput(source, second.snapshot, 'one')).toBeNull();
    const third = family();
    const result = third.observations[3]!.result;
    if ('coverEmail' in result && result.coverEmail) result.coverEmail.to = 'other@example.test';
    expect(getQuotePackageOutput(source, third.snapshot, 'one')).toBeNull();
  });

  it('rejects inconsistent or duplicate family membership', () => {
    const first = family(); first.requests[1]!.body.quoteFamily.label = 'Changed';
    expect(quoteFamilyMembers(first.snapshot, 'one')).toBeNull();
    const second = family(); second.requests[0]!.body.quoteFamily.members[1]!.requestId = 'one';
    expect(quoteFamilyMembers(second.snapshot, 'one')).toBeNull();
  });
});
