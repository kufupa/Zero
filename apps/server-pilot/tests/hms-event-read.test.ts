import { describe, expect, it } from 'vitest';
import { claimsFromToolResult } from '../src/ai/candidate-draft-agent.js';
import { type ToolResult } from '../src/ai/draft-evidence.js';
import {
  EVENT_READ_PRIVACY_POLICY,
  eventReadDataSchema,
  mapEventSummaryClaim,
  parseEventReadFixture,
  type EventReadFixtureInput,
} from '../src/hms/event-read-contract.js';
import { READ_TOOLS, capabilityStateFor } from '../src/hms/read-tools.js';

const NOW = '2026-08-06T00:00:00.000Z';
const OBSERVED = '2026-08-05T23:58:00.000Z';
const HASH = 'a'.repeat(64);

function fixture(
  overrides: Partial<EventReadFixtureInput> = {},
): EventReadFixtureInput {
  return {
    candidate: {
      exactEventReferenceHash: HASH,
      observedEventReferenceHash: HASH,
    },
    roleProof: {
      schemaVersion: 2,
      credentialMode: 'view_only',
      eventSummaryRead: true,
      allowedSurfaces: ['Event Reservation List'],
      deniedActions: [...EVENT_READ_PRIVACY_POLICY.deniedActions],
      issuedAt: '2026-08-05T22:00:00.000Z',
      expiresAt: '2026-08-06T01:00:00.000Z',
    },
    surfaceProof: {
      listOnly: true,
      exactSearchProven: true,
      requiredSummaryPresentInList: true,
      detailNavigationUsed: false,
      detailNavigationProvenInert: false,
      reviewedRequestManifest: true,
      mutationEventsObserved: [],
    },
    eventStatus: 'confirmed',
    eventTypeClass: 'conference',
    startAt: '2026-09-01T08:00:00.000Z',
    endAt: '2026-09-01T17:00:00.000Z',
    layoutClass: 'theatre',
    attendeeCount: 80,
    setupMinutes: 60,
    teardownMinutes: 30,
    approvedItemSummary: [
      { itemClass: 'venue', count: 1, total: '1000.00' },
      { itemClass: 'catering', count: 80, total: '2000.00' },
    ],
    currency: 'ZAR',
    total: '3000.00',
    linkedGroupClass: 'group_block',
    linkedAccountClass: 'company',
    depositStatus: 'paid',
    recipientClass: 'authorized_event_contact',
    inquiryClass: 'existing_event_status',
    observedAt: OBSERVED,
    evaluatedAt: NOW,
    durationMs: 20,
    bytesObserved: 1_000,
    privateFields: {
      contactName: 'Private Contact',
      contactEmail: 'private@example.test',
      notes: 'Private event notes',
      itemDescription: 'Private item description',
    },
    ...overrides,
  };
}

function toolResult(data: unknown): ToolResult<unknown> {
  return {
    status: 'ok',
    draftReady: true,
    data,
    unresolvedFields: [],
    evidence: {
      kind: 'hms',
      id: 'event-evidence',
      toolId: 'hms_event_read',
      toolVersion: '1.0.0',
      propertyCode: 'HRCEN',
      observedAt: OBSERVED,
      expiresAt: '2026-08-06T01:00:00.000Z',
      claimKeys: [],
      sourceHash: HASH,
    },
  };
}

describe('hms_event_read fixture kernel', () => {
  it('returns minimized exact list-row event summary without private fields', () => {
    const parsed = parseEventReadFixture(fixture());
    expect(parsed.status).toBe('ok');
    expect(eventReadDataSchema.parse(parsed.data)).toEqual(parsed.data);
    expect(parsed.data).toEqual(
      expect.objectContaining({
        eventBinding: 'exact_reference_redacted',
        eventStatus: 'confirmed',
        attendeeCount: 80,
        currency: 'ZAR',
        total: '3000.00',
      }),
    );
    expect(JSON.stringify(parsed)).not.toMatch(
      /Private Contact|private@example\.test|Private event notes|Private item description/,
    );
  });

  it('requires exact event reference', () => {
    const parsed = parseEventReadFixture(
      fixture({
        candidate: {
          exactEventReferenceHash: HASH,
          observedEventReferenceHash: 'b'.repeat(64),
        },
      }),
    );
    expect(parsed.blocker).toBe('EVENT_EXACT_REFERENCE_MISMATCH');
    expect(parsed.data).toBeNull();
  });

  it('requires list-only summary and forbids unproven detail navigation', () => {
    for (const surfaceProof of [
      { ...fixture().surfaceProof, listOnly: false },
      { ...fixture().surfaceProof, exactSearchProven: false },
      { ...fixture().surfaceProof, requiredSummaryPresentInList: false },
      { ...fixture().surfaceProof, detailNavigationUsed: true },
      { ...fixture().surfaceProof, reviewedRequestManifest: false },
    ]) {
      const parsed = parseEventReadFixture(fixture({ surfaceProof }));
      expect(parsed.status).toBe('manual_required');
      expect(parsed.blocker).toBe('BLOCKED_EVENT_READ_SURFACE_UNPROVEN');
      expect(parsed.data).toBeNull();
    }
  });

  it.each([
    'double_click',
    'calculate',
    'post',
    'copy',
    'cancel',
    'print',
    'save',
  ] as const)('aborts when mutation-capable event %s is observed', (event) => {
    const parsed = parseEventReadFixture(
      fixture({
        surfaceProof: {
          ...fixture().surfaceProof,
          mutationEventsObserved: [event],
        },
      }),
    );
    expect(parsed.blocker).toBe('BLOCKED_EVENT_MUTATION_RISK');
  });

  it('requires current view-only role and complete action denials', () => {
    expect(
      parseEventReadFixture(
        fixture({
          roleProof: { ...fixture().roleProof, credentialMode: 'write_capable' },
        }),
      ).blocker,
    ).toBe('BLOCKED_NO_EVENT_READ_ROLE_PROOF_V2');
    expect(
      parseEventReadFixture(
        fixture({
          roleProof: { ...fixture().roleProof, deniedActions: [] },
        }),
      ).blocker,
    ).toBe('BLOCKED_NO_EVENT_READ_ROLE_PROOF_V2');
  });

  it('rejects invalid dates, counts, and total inconsistency', () => {
    expect(
      parseEventReadFixture(
        fixture({
          endAt: '2026-09-01T07:59:59.999Z',
        }),
      ).blocker,
    ).toBe('EVENT_DATE_OR_COUNT_INCONSISTENT');
    expect(
      parseEventReadFixture(fixture({ attendeeCount: -1 })),
    ).toEqual(
      expect.objectContaining({
        status: 'manual_required',
        blocker: 'EVENT_CONTRACT_OR_SCHEMA_DRIFT',
      }),
    );
    expect(
      parseEventReadFixture(fixture({ total: '2999.99' })).blocker,
    ).toBe('EVENT_CURRENCY_OR_TOTAL_INCONSISTENT');
  });

  it('quarantines absent required summary as unverified_negative', () => {
    const parsed = parseEventReadFixture(
      fixture({
        eventStatus: null,
        eventTypeClass: null,
        startAt: null,
        endAt: null,
        attendeeCount: null,
        currency: null,
        total: null,
        approvedItemSummary: [],
      }),
    );
    expect(parsed.status).toBe('unverified_negative');
    expect(parsed.blocker).toBe('UNVERIFIED_NEGATIVE');
    expect(parsed.data).toBeNull();
    expect(
      claimsFromToolResult({
        ...toolResult(null),
        status: 'unverified_negative',
        draftReady: false,
      }),
    ).toEqual([]);
  });

  it('publishes private-field and unsafe-action denials', () => {
    expect(EVENT_READ_PRIVACY_POLICY.deniedData).toEqual(
      expect.arrayContaining(['contact', 'notes', 'private_item_description']),
    );
    expect(READ_TOOLS.hms_event_read.deniedActions).toEqual(
      expect.arrayContaining([
        'detail_double_click',
        'calculate',
        'post',
        'copy',
        'cancel',
        'print',
        'save',
        'beo_generate',
        'pro_forma_generate',
      ]),
    );
  });
});

describe('event claims and registry', () => {
  it('grants Full only for existing event-status inquiry', () => {
    const parsed = parseEventReadFixture(fixture());
    expect(mapEventSummaryClaim(parsed.data!)?.responseCredit).toBe(
      'full_existing_event_status',
    );
    const claims = claimsFromToolResult(
      toolResult(parsed.data),
      new Date('2026-08-06T00:01:00.000Z'),
    );
    // Fixture observations do not carry separately issued requester authority;
    // the closed claim envelope must therefore emit no claim.
    expect(claims).toEqual([]);
  });

  it.each([
    'quote_request',
    'create_request',
    'amend_request',
    'beo_request',
    'pro_forma_request',
  ] as const)('limits %s to Partial', (inquiryClass) => {
    const parsed = parseEventReadFixture(fixture({ inquiryClass }));
    expect(mapEventSummaryClaim(parsed.data!)?.responseCredit).toBe(
      'partial_status_only',
    );
  });

  it('recomputes eligibility and rejects forged stored eligibility', () => {
    const parsed = parseEventReadFixture(fixture({ recipientClass: 'third_party' }));
    const forged = {
      ...parsed.data!,
      disclosure: {
        ...parsed.data!.disclosure,
        claimEligibility: 'full' as const,
      },
    };
    expect(mapEventSummaryClaim(forged)).toBeNull();
    expect(claimsFromToolResult(toolResult(forged))).toEqual([]);
  });

  it('registers fixture-only schema with no live driver evidence', () => {
    expect(READ_TOOLS.hms_event_read.observationSchema).toBe(eventReadDataSchema);
    expect(READ_TOOLS.hms_event_read.promotionEvidence).toEqual({
      fixture: true,
      discovery: false,
      live: false,
      shadow: false,
    });
    expect(capabilityStateFor('hms_event_read')).toBe('fixture_verified');
  });
});
