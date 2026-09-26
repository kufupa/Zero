import { describe, expect, it } from 'vitest';
import { claimsFromToolResult } from '../src/ai/candidate-draft-agent.js';
import { type ToolResult } from '../src/ai/draft-evidence.js';
import {
  GROUP_BLOCK_READ_MAX_DAYS,
  GROUP_BLOCK_READ_PRIVACY_POLICY,
  groupBlockReadDataSchema,
  mapGroupBlockClaim,
  parseGroupBlockReadFixture,
  type GroupBlockReadFixtureInput,
} from '../src/hms/group-block-read-contract.js';
import { READ_TOOLS, capabilityStateFor } from '../src/hms/read-tools.js';

const NOW = '2026-08-06T00:00:00.000Z';
const OBSERVED = '2026-08-05T23:58:00.000Z';
const HASH = 'a'.repeat(64);

function fixture(
  overrides: Partial<GroupBlockReadFixtureInput> = {},
): GroupBlockReadFixtureInput {
  return {
    candidate: {
      exactGroupReferenceHash: HASH,
      observedGroupReferenceHash: HASH,
      startDate: '2026-09-01',
      endDate: '2026-09-03',
    },
    roleProof: {
      schemaVersion: 2,
      credentialMode: 'view_only',
      groupBlockRead: true,
      allowedSurfaces: ['Group Booking', 'Subgroup Room Blocks'],
      deniedActions: [...GROUP_BLOCK_READ_PRIVACY_POLICY.deniedActions],
      issuedAt: '2026-08-05T22:00:00.000Z',
      expiresAt: '2026-08-06T01:00:00.000Z',
    },
    surfaceProof: {
      exactSearchProven: true,
      conSemanticsProven: true,
      blkSemanticsProven: true,
      pickupSemanticsProven: true,
      remainingSemanticsProven: true,
      restrictionSemanticsProven: true,
      reviewedRequestManifest: true,
      editEventsObserved: [],
    },
    groupStatus: 'definite',
    rows: [
      {
        date: '2026-09-01',
        roomTypeClass: 'standard',
        con: 10,
        blk: 8,
        pickup: 3,
        remaining: 5,
        restrictions: ['closed_to_arrival'],
      },
      {
        date: '2026-09-02',
        roomTypeClass: 'standard',
        con: 10,
        blk: 8,
        pickup: 4,
        remaining: 4,
        restrictions: [],
      },
    ],
    recipientClass: 'authorized_group_contact',
    inquiryClass: 'existing_group_status',
    observedAt: OBSERVED,
    evaluatedAt: NOW,
    durationMs: 25,
    bytesObserved: 1_000,
    privateFields: {
      delegateName: 'Private Delegate',
      roomingListIdentity: 'Private Guest',
      notes: 'Private group notes',
      rate: '999.00',
      billingInstructions: 'Private billing instructions',
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
      id: 'group-evidence',
      toolId: 'hms_group_block_read',
      toolVersion: '1.0.0',
      propertyCode: 'HRCEN',
      observedAt: OBSERVED,
      expiresAt: '2026-08-06T01:00:00.000Z',
      claimKeys: [],
      sourceHash: HASH,
    },
  };
}

describe('hms_group_block_read fixture kernel', () => {
  it('returns exact aggregate block rows with proven CON/BLK/pickup/remaining semantics', () => {
    const parsed = parseGroupBlockReadFixture(fixture());
    expect(parsed.status).toBe('ok');
    expect(groupBlockReadDataSchema.parse(parsed.data)).toEqual(parsed.data);
    expect(parsed.data).toEqual(
      expect.objectContaining({
        groupBinding: 'exact_reference_redacted',
        groupStatus: 'definite',
        startDate: '2026-09-01',
        endDate: '2026-09-03',
      }),
    );
    expect(parsed.data?.rows[0]).toEqual({
      date: '2026-09-01',
      roomTypeClass: 'standard',
      con: 10,
      blk: 8,
      pickup: 3,
      remaining: 5,
      restrictions: ['closed_to_arrival'],
    });
    expect(JSON.stringify(parsed)).not.toMatch(
      /Private Delegate|Private Guest|Private group notes|999\.00|Private billing instructions/,
    );
  });

  it('requires exact group reference and bounded dates', () => {
    expect(
      parseGroupBlockReadFixture(
        fixture({
          candidate: {
            ...fixture().candidate,
            observedGroupReferenceHash: 'b'.repeat(64),
          },
        }),
      ).blocker,
    ).toBe('GROUP_BLOCK_EXACT_REFERENCE_MISMATCH');
    expect(
      parseGroupBlockReadFixture(
        fixture({
          candidate: {
            ...fixture().candidate,
            endDate: '2027-12-31',
          },
        }),
      ).blocker,
    ).toBe('GROUP_BLOCK_DATE_WINDOW_INVALID');
    expect(GROUP_BLOCK_READ_MAX_DAYS).toBeGreaterThan(0);
  });

  it.each([
    'exactSearchProven',
    'conSemanticsProven',
    'blkSemanticsProven',
    'pickupSemanticsProven',
    'remainingSemanticsProven',
    'restrictionSemanticsProven',
    'reviewedRequestManifest',
  ] as const)('fails closed when %s is absent', (field) => {
    const parsed = parseGroupBlockReadFixture(
      fixture({
        surfaceProof: { ...fixture().surfaceProof, [field]: false },
      }),
    );
    expect(parsed.status).toBe('manual_required');
    expect(parsed.blocker).toBe('BLOCKED_GROUP_BLOCK_SURFACE_UNPROVEN');
    expect(parsed.data).toBeNull();
  });

  it.each(['focus', 'input', 'change', 'blur'] as const)(
    'aborts when edit event %s is observed',
    (event) => {
      const parsed = parseGroupBlockReadFixture(
        fixture({
          surfaceProof: {
            ...fixture().surfaceProof,
            editEventsObserved: [event],
          },
        }),
      );
      expect(parsed.blocker).toBe('BLOCKED_GROUP_BLOCK_MUTATION_RISK');
    },
  );

  it('requires current view-only role, exact surfaces, and complete denied actions', () => {
    expect(
      parseGroupBlockReadFixture(
        fixture({
          roleProof: { ...fixture().roleProof, credentialMode: 'write_capable' },
        }),
      ).blocker,
    ).toBe('BLOCKED_NO_GROUP_BLOCK_ROLE_PROOF_V2');
    expect(
      parseGroupBlockReadFixture(
        fixture({
          roleProof: { ...fixture().roleProof, deniedActions: [] },
        }),
      ).blocker,
    ).toBe('BLOCKED_NO_GROUP_BLOCK_ROLE_PROOF_V2');
  });

  it('rejects row dates outside scope and inconsistent remaining counts', () => {
    expect(
      parseGroupBlockReadFixture(
        fixture({ rows: [{ ...fixture().rows[0]!, date: '2026-08-31' }] }),
      ).blocker,
    ).toBe('GROUP_BLOCK_ROW_OUTSIDE_DATE_WINDOW');
    expect(
      parseGroupBlockReadFixture(
        fixture({ rows: [{ ...fixture().rows[0]!, remaining: 4 }] }),
      ).blocker,
    ).toBe('GROUP_BLOCK_COUNT_INCONSISTENT');
  });

  it('quarantines empty observations as unverified_negative', () => {
    const parsed = parseGroupBlockReadFixture(fixture({ rows: [] }));
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

  it('publishes structural action and identity denials', () => {
    expect(GROUP_BLOCK_READ_PRIVACY_POLICY.deniedData).toEqual(
      expect.arrayContaining(['rooming_list_identity', 'delegate_identity', 'notes']),
    );
    expect(READ_TOOLS.hms_group_block_read.deniedActions).toEqual(
      expect.arrayContaining([
        'block_tab_direct_entry',
        'quick_entry',
        'room_assignment',
        'document_tabs',
        'focus',
        'input',
        'change',
        'blur',
      ]),
    );
  });
});

describe('group-block claims and registry', () => {
  it('grants Full only for existing group-status inquiry', () => {
    const parsed = parseGroupBlockReadFixture(fixture());
    const mapped = mapGroupBlockClaim(parsed.data!);
    expect(mapped?.responseCredit).toBe('full_existing_group_status');
    const claims = claimsFromToolResult(
      toolResult(parsed.data),
      new Date('2026-08-06T00:01:00.000Z'),
    );
    // Fixture observations do not carry separately issued requester authority;
    // the closed claim envelope must therefore emit no claim.
    expect(claims).toEqual([]);
  });

  it.each(['create_request', 'amend_request', 'allocation_action'] as const)(
    'limits %s to Partial',
    (inquiryClass) => {
      const parsed = parseGroupBlockReadFixture(fixture({ inquiryClass }));
      expect(mapGroupBlockClaim(parsed.data!)?.responseCredit).toBe(
        'partial_status_only',
      );
    },
  );

  it('recomputes eligibility and rejects forged recipient eligibility', () => {
    const parsed = parseGroupBlockReadFixture(
      fixture({ recipientClass: 'third_party' }),
    );
    const forged = {
      ...parsed.data!,
      disclosure: {
        ...parsed.data!.disclosure,
        claimEligibility: 'full' as const,
      },
    };
    expect(mapGroupBlockClaim(forged)).toBeNull();
    expect(claimsFromToolResult(toolResult(forged))).toEqual([]);
  });

  it('registers fixture-only schema with no live driver evidence', () => {
    expect(READ_TOOLS.hms_group_block_read.observationSchema).toBe(
      groupBlockReadDataSchema,
    );
    expect(READ_TOOLS.hms_group_block_read.promotionEvidence).toEqual({
      fixture: true,
      discovery: false,
      live: false,
      shadow: false,
    });
    expect(capabilityStateFor('hms_group_block_read')).toBe('fixture_verified');
  });
});
