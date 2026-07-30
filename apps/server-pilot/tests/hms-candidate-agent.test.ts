import { describe, expect, it } from 'vitest';
import {
  EvidenceClaimSchema,
  HmsEvidenceRefSchema,
  MailEvidenceRefSchema,
  ToolResultSchema,
  evaluateDraftReadiness,
  isEvidenceFresh,
  renderClaim,
  renderFactualLines,
  type EvidenceClaim,
  type HmsEvidenceRef,
  type MailEvidenceRef,
  type ToolResult,
} from '../src/ai/draft-evidence.js';

const now = new Date('2026-07-30T12:00:00.000Z');

function hmsEvidence(overrides: Partial<HmsEvidenceRef> = {}): HmsEvidenceRef {
  return {
    kind: 'hms',
    id: 'ev-hms-1',
    toolId: 'hms_find_reservation',
    toolVersion: '1',
    propertyCode: 'CENTURION',
    observedAt: '2026-07-30T11:00:00.000Z',
    expiresAt: '2026-07-30T13:00:00.000Z',
    claimKeys: ['reservation.status', 'reservation.dates'],
    sourceHash: 'a'.repeat(64),
    ...overrides,
  };
}

function mailEvidence(overrides: Partial<MailEvidenceRef> = {}): MailEvidenceRef {
  return {
    kind: 'mail_attachment',
    id: 'ev-mail-1',
    toolId: 'mail_read_artifact',
    toolVersion: '1',
    attachmentId: 'att-1',
    observedAt: '2026-07-30T11:00:00.000Z',
    sourceHash: 'b'.repeat(64),
    claimKeys: ['attachment.confirmation'],
    ...overrides,
  };
}

describe('hms typed evidence contracts', () => {
  it('accepts discriminated HMS and mail evidence unions without raw body/text', () => {
    expect(HmsEvidenceRefSchema.parse(hmsEvidence())).toMatchObject({
      kind: 'hms',
      propertyCode: 'CENTURION',
    });
    expect(MailEvidenceRefSchema.parse(mailEvidence())).toMatchObject({
      kind: 'mail_attachment',
      attachmentId: 'att-1',
      toolId: 'mail_read_artifact',
    });

    expect(() =>
      HmsEvidenceRefSchema.parse({
        ...hmsEvidence(),
        body: 'raw reservation dump',
      }),
    ).toThrow();
    expect(() =>
      MailEvidenceRefSchema.parse({
        ...mailEvidence(),
        text: 'raw attachment text',
      }),
    ).toThrow();
    expect(() =>
      HmsEvidenceRefSchema.parse({
        ...hmsEvidence(),
        propertyCode: undefined,
      }),
    ).toThrow();
    expect(() =>
      MailEvidenceRefSchema.parse({
        ...mailEvidence(),
        attachmentId: undefined,
      }),
    ).toThrow();
  });

  it('ToolResult carries status, draftReady, unresolvedFields, and evidence', () => {
    const result: ToolResult<{ confirmation: string }> = {
      status: 'ok',
      draftReady: true,
      data: { confirmation: 'CONF-88421' },
      unresolvedFields: [],
      evidence: hmsEvidence(),
    };
    expect(ToolResultSchema.parse(result)).toEqual(result);

    const partial: ToolResult<Record<string, never>> = {
      status: 'partial',
      draftReady: false,
      data: {},
      unresolvedFields: ['rate.amount'],
      evidence: mailEvidence(),
    };
    expect(ToolResultSchema.parse(partial).draftReady).toBe(false);
  });

  it('marks evidence stale after expiresAt and rejects draft readiness', () => {
    const fresh = hmsEvidence({ expiresAt: '2026-07-30T13:00:00.000Z' });
    const stale = hmsEvidence({
      id: 'ev-stale',
      expiresAt: '2026-07-30T11:30:00.000Z',
    });
    expect(isEvidenceFresh(fresh, now)).toBe(true);
    expect(isEvidenceFresh(stale, now)).toBe(false);

    expect(
      evaluateDraftReadiness({
        status: 'ok',
        draftReady: true,
        data: {},
        unresolvedFields: [],
        evidence: stale,
      }, now).draftReady,
    ).toBe(false);

    expect(
      evaluateDraftReadiness({
        status: 'partial',
        draftReady: true,
        data: {},
        unresolvedFields: ['inventory.nights'],
        evidence: fresh,
      }, now).draftReady,
    ).toBe(false);

    expect(
      evaluateDraftReadiness({
        status: 'ambiguous',
        draftReady: true,
        data: {},
        unresolvedFields: [],
        evidence: fresh,
      }, now).draftReady,
    ).toBe(false);
  });

  it('renders typed claims deterministically without free-form factual prose', () => {
    const claims: EvidenceClaim[] = [
      EvidenceClaimSchema.parse({
        id: 'claim-status',
        kind: 'reservation_status',
        value: { status: 'Confirmed', confirmation: 'CONF-88421' },
        evidenceId: 'ev-hms-1',
        expiresAt: '2026-07-30T13:00:00.000Z',
      }),
      EvidenceClaimSchema.parse({
        id: 'claim-dates',
        kind: 'stay_dates',
        value: { arrivalDate: '2026-08-01', departureDate: '2026-08-03' },
        evidenceId: 'ev-hms-1',
      }),
      EvidenceClaimSchema.parse({
        id: 'claim-rate',
        kind: 'displayed_rate',
        value: { amount: '1200.00', currency: 'ZAR', basis: 'per_room_per_night' },
        evidenceId: 'ev-hms-1',
      }),
    ];

    expect(renderClaim(claims[0]!)).toBe(
      'Reservation status: Confirmed (confirmation CONF-88421).',
    );
    expect(renderClaim(claims[1]!)).toBe('Stay dates: 2026-08-01 to 2026-08-03.');
    expect(renderClaim(claims[2]!)).toBe(
      'Displayed rate: 1200.00 ZAR (per_room_per_night).',
    );

    const lines = renderFactualLines(
      ['claim-status', 'claim-dates', 'claim-rate'],
      new Map(claims.map((c) => [c.id, c])),
    );
    expect(lines).toEqual([
      'Reservation status: Confirmed (confirmation CONF-88421).',
      'Stay dates: 2026-08-01 to 2026-08-03.',
      'Displayed rate: 1200.00 ZAR (per_room_per_night).',
    ]);
    // Same inputs → same outputs (deterministic).
    expect(
      renderFactualLines(
        ['claim-status', 'claim-dates', 'claim-rate'],
        new Map(claims.map((c) => [c.id, c])),
      ),
    ).toEqual(lines);
  });

  it('rejects missing claims and unknown claim kinds at the contract boundary', () => {
    expect(() =>
      renderFactualLines(['missing'], new Map()),
    ).toThrow(/unknown claim/i);

    expect(() =>
      EvidenceClaimSchema.parse({
        id: 'bad',
        kind: 'free_form_fact',
        value: 'Guest owes money',
        evidenceId: 'ev-1',
      }),
    ).toThrow();
  });
});
