import { describe, expect, it } from 'vitest';
import {
  buildStaffProposalFacts,
  staffQuoteInput,
  type StaffQuoteInput,
} from '../src/ai/staff-quote-workflow.js';
import { deriveAuthorizedExtraLines } from '../src/quote-proposal/quote-lines.js';
import { renderRevisionProposalHtml } from '../src/quote-proposal/proposal-pdf.js';
import { syntheticRevision } from './helpers/synthetic-quote-revision.js';

const scope = { messageId: 'message-1', sourceHash: 'a'.repeat(64) };

function baseInput(overrides: Partial<StaffQuoteInput> = {}): StaffQuoteInput {
  return staffQuoteInput.parse({
    messageId: scope.messageId,
    sourceHash: scope.sourceHash,
    selectionEpoch: 1,
    inputRevision: 1,
    groups: [
      {
        id: 'stay',
        arrivalDate: '2026-10-12',
        departureDate: '2026-10-15',
        quantity: 1,
        adults: 2,
        childrenAges: [],
        board: 'bb',
      },
    ],
    ...overrides,
  });
}

describe('buildStaffProposalFacts', () => {
  it('charges dinner allowance across 2 adults and 3 nights as 6 person-service units', async () => {
    const revision = await syntheticRevision();
    const input = baseInput({ dinnerAllowanceMinor: 12_500 });
    const built = buildStaffProposalFacts(input, scope, { authorizationId: revision.authorizationId }, revision);
    expect(built.factRefs).toEqual(['extras']);
    expect(built.facts?.extras).toHaveLength(1);
    expect(built.facts?.extras[0]).toMatchObject({
      label: 'Dinner allowance',
      unitKind: 'person_service',
      quantity: 1,
      units: 6,
      unitMinor: 12_500,
    });
    const lines = deriveAuthorizedExtraLines(revision, built.facts!);
    expect(lines).toHaveLength(1);
    expect(lines[0].description).toContain('Dinner allowance');
    expect(lines[0].totalMinor).toBe(12_500 * 6);
  });

  it('adds a shuttle review item without an extras line when shuttle has no amount', async () => {
    const revision = await syntheticRevision();
    const built = buildStaffProposalFacts(
      baseInput({ shuttleRequested: true }),
      scope,
      { authorizationId: revision.authorizationId },
      revision,
    );
    expect(built.facts).toBeNull();
    expect(built.factRefs).toEqual([]);
    expect(built.extrasReviewItems).toEqual([
      'Shuttle requested — add a price or answer in the reply',
    ]);
  });

  it('adds a shuttle trip line when staff typed an amount', async () => {
    const revision = await syntheticRevision();
    const built = buildStaffProposalFacts(
      baseInput({ shuttleRequested: true, shuttleMinor: 45_000 }),
      scope,
      { authorizationId: revision.authorizationId },
      revision,
    );
    expect(built.factRefs).toEqual(['extras']);
    expect(built.facts?.extras[0]).toMatchObject({
      unitKind: 'trip',
      quantity: 1,
      units: 1,
      unitMinor: 45_000,
      persons: [],
      dates: ['2026-10-12'],
    });
    expect(built.extrasReviewItems).toEqual([]);
  });

  it('returns no proposal facts when no extras were confirmed', async () => {
    const revision = await syntheticRevision();
    const built = buildStaffProposalFacts(
      baseInput(),
      scope,
      { authorizationId: revision.authorizationId },
      revision,
    );
    expect(built.facts).toBeNull();
    expect(built.factRefs).toEqual([]);
    expect(built.extrasReviewItems).toEqual([]);
  });

  it('puts dinner and shuttle labels on the staff proposal HTML', async () => {
    const revision = await syntheticRevision();
    const built = buildStaffProposalFacts(
      baseInput({ dinnerAllowanceMinor: 12_500, shuttleRequested: true, shuttleMinor: 45_000 }),
      scope,
      { authorizationId: revision.authorizationId },
      revision,
    );
    expect(built.facts?.extras).toHaveLength(2);
    const html = renderRevisionProposalHtml(
      revision,
      {
        attention: 'Staff',
        company: 'Test',
        clientEmail: 'test@example.invalid',
        clientTelephone: '',
        agency: 'Test',
        signerName: 'Test',
        signerEmail: 'test@example.invalid',
      },
      built.facts!,
    );
    expect(html).toContain('Dinner allowance');
    expect(html).toContain('Shuttle');
  });

  it('keeps staffQuoteInput strict and rejects model-priced fields', () => {
    expect(() => baseInput({ rate: 1700 } as StaffQuoteInput)).toThrow();
    expect(() =>
      staffQuoteInput.parse({ ...baseInput(), dinnerAllowanceMinor: 100, modelTotal: 99 }),
    ).toThrow();
  });
});
