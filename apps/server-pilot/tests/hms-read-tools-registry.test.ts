import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import denominators from '../evals/hms/denominators.v1.json';
import portfolioCases from '../evals/hms/portfolio-cases.v3.json';
import {
  DISCOVERY_OPERATION_IDS,
  ROLE_SURFACE_IDS,
  controlOracleDefinitionSchema,
  hmsReadToolIdSchema,
  requestBranchDefinitionSchema,
} from '../src/hms/contracts.js';
import {
  CAPABILITY_PROMOTION_ORDER,
  HMS_READ_TOOL_IDS,
  INCLUDED_READ_TOOL_IDS,
  READ_TOOLS,
  activeShadowToolIds,
  assertReadToolRegistrySealed,
  capabilityStateFor,
  deriveCapabilityState,
  fingerprintReadToolRegistry,
  isProductionActiveReadTool,
  listReadToolIds,
  nonOverlappingIntentMembership,
  portfolioAblationReplay,
  productionActiveReadToolIds,
  productionActiveReservationContextToolIds,
  type CapabilityEvidenceRefs,
  type ReadToolId,
} from '../src/hms/read-tools';

const REQUIRED_TOOL_IDS: ReadToolId[] = [
  'hms_find_reservation',
  'hms_quote_stay',
  'hms_list_documents',
  'hms_sent_email_audit',
  'hms_read_folio',
  'hms_company_account_read',
  'hms_group_block_read',
  'hms_event_read',
];

describe('READ_TOOLS portfolio registry', () => {
  it('keeps the excluded mail adapter out of active enumeration', () => {
    expect(READ_TOOLS.mail_read_artifact.version).toBe('2');
    expect(listReadToolIds()).not.toContain('mail_read_artifact');
    expect(hmsReadToolIdSchema.safeParse('mail_read_artifact').success).toBe(false);
  });

  it('freezes the approved read scope without property knowledge or mailbox artifacts', () => {
    expect(INCLUDED_READ_TOOL_IDS).toEqual([
      ...REQUIRED_TOOL_IDS,
      'hms_read_reservation',
      'hms_read_notes_traces',
      'mail_parse_channel_payload',
    ]);
    expect(INCLUDED_READ_TOOL_IDS).not.toContain('property_read_knowledge' as never);
    expect(INCLUDED_READ_TOOL_IDS).not.toContain('mail_read_artifact' as never);
    expect(INCLUDED_READ_TOOL_IDS).not.toContain('documents_read_existing' as never);
  });

  it('lists every Phase B target tool with closed required fields', () => {
    expect(listReadToolIds().sort()).toEqual([...REQUIRED_TOOL_IDS].sort());
    assertReadToolRegistrySealed(READ_TOOLS);

    for (const id of REQUIRED_TOOL_IDS) {
      const tool = READ_TOOLS[id];
      expect(tool.id).toBe(id);
      expect(tool.version).toMatch(/^\d+(\.\d+){0,2}$/);
      expect(tool.effect).toBe('read');
      expect(tool.sourceUrls.length).toBeGreaterThan(0);
      expect(tool.privacyClass).toMatch(/^(minimized_hms|mail_server_only)$/);
      expect(tool.deniedActions.length).toBeGreaterThan(0);
      expect(tool.candidateRequirement).toBeTruthy();
      expect(tool.attemptCap).toBeGreaterThan(0);
      expect(tool.promotionEvidence).toEqual(
        expect.objectContaining({
          fixture: expect.any(Boolean),
          discovery: expect.any(Boolean),
          live: expect.any(Boolean),
          shadow: expect.any(Boolean),
        }),
      );
      expect(tool.observationSchema).toBeTruthy();
      if (tool.privacyClass === 'mail_server_only') {
        // Artifact text stays server-only; no model-visible claim kinds.
        expect(tool.claimKinds).toEqual([]);
        expect(tool).not.toHaveProperty('discoveryOperationIds');
        expect(tool).not.toHaveProperty('requestBranches');
      } else {
        expect(tool.claimKinds.length).toBeGreaterThan(0);
        expect(tool.discoveryOperationIds.length).toBeGreaterThan(0);
        expect(tool.requestBranches.length).toBeGreaterThan(0);
        for (const branch of tool.requestBranches) {
          expect(requestBranchDefinitionSchema.parse(branch)).toEqual(branch);
          expect(tool.discoveryOperationIds).toContain(branch.discoveryOperationId);
          expect(controlOracleDefinitionSchema.parse(branch.controlOracle)).toEqual(
            branch.controlOracle,
          );
        }
      }
    }
  });

  it('keeps closed HMS-only tool, surface, and discovery unions', () => {
    expect(HMS_READ_TOOL_IDS).toEqual(
      REQUIRED_TOOL_IDS.filter((id) => id !== 'mail_read_artifact'),
    );
    expect(hmsReadToolIdSchema.safeParse('mail_read_artifact').success).toBe(false);
    expect(ROLE_SURFACE_IDS).toEqual([
      'guest_stay',
      'room_type_rate_availability',
      'sent_email',
      'tax_invoice',
      'folio',
      'deposit_ledger',
      'company_account_billing',
      'group_block',
      'event_list',
    ]);
    expect(DISCOVERY_OPERATION_IDS).toEqual([
      'guest_stay_search',
      'quote_availability_search',
      'sent_email_list',
      'tax_invoice_list',
      'folio_summary',
      'deposit_ledger_summary',
      'reservation_linked_company_billing',
      'group_block_list',
      'event_list',
    ]);
  });

  it('activates soft-proven PMS read tools with liveProofDigest', () => {
    const active = productionActiveReadToolIds().sort();
    expect(active).toEqual(['hms_find_reservation']);
    expect(READ_TOOLS.hms_find_reservation.evidenceRefs).toEqual({
      fixtureDigest:
        '1fe75700f61799feb4ff2da9238af4ebd46396b422c94266356365f0df0da820',
      discoveryDigest:
        '1fe75700f61799feb4ff2da9238af4ebd46396b422c94266356365f0df0da820',
      liveProofDigest:
        '47a0121bd941d6508d924f3336a741b8eea4e70ec146d62d5635fae7e460a389',
    });
    expect(READ_TOOLS.hms_quote_stay.evidenceRefs).toEqual({
      fixtureDigest:
        '909a0f6e086bca1464eaafae78bf54a0650c02bc9be90f5726d594e0e6d47bcc',
      discoveryDigest:
        '909a0f6e086bca1464eaafae78bf54a0650c02bc9be90f5726d594e0e6d47bcc',
    });

    expect(isProductionActiveReadTool('hms_find_reservation')).toBe(true);
    expect(isProductionActiveReadTool('hms_quote_stay')).toBe(false);
    expect(isProductionActiveReadTool('hms_read_folio')).toBe(false);
    expect(isProductionActiveReadTool('hms_event_read')).toBe(false);
    expect(isProductionActiveReadTool('mail_read_artifact')).toBe(false);
  });

  it('exposes A1 as production-active context tool, not Phase-B READ_TOOL_IDS', () => {
    expect(listReadToolIds()).not.toContain('hms_read_reservation');
    expect(productionActiveReservationContextToolIds()).toEqual([]);
    expect(productionActiveReadToolIds()).not.toContain('hms_read_reservation' as ReadToolId);
  });

  it('derives capability state only from present valid evidence refs', () => {
    expect(CAPABILITY_PROMOTION_ORDER).toEqual([
      'planned',
      'fixture_verified',
      'discovery_verified',
      'live_verified',
      'shadow_enabled',
    ]);

    const empty: CapabilityEvidenceRefs = {};
    expect(deriveCapabilityState(empty)).toBe('planned');

    expect(
      deriveCapabilityState({
        fixtureDigest: 'a'.repeat(64),
      }),
    ).toBe('fixture_verified');

    expect(
      deriveCapabilityState({
        fixtureDigest: 'a'.repeat(64),
        discoveryDigest: 'b'.repeat(64),
      }),
    ).toBe('discovery_verified');

    expect(
      deriveCapabilityState({
        fixtureDigest: 'a'.repeat(64),
        discoveryDigest: 'b'.repeat(64),
        liveProofDigest: 'c'.repeat(64),
      }),
    ).toBe('live_verified');

    expect(
      deriveCapabilityState({
        fixtureDigest: 'a'.repeat(64),
        discoveryDigest: 'b'.repeat(64),
        liveProofDigest: 'c'.repeat(64),
        shadowDigest: 'd'.repeat(64),
      }),
    ).toBe('shadow_enabled');

    // Skipping stages is invalid — highest contiguous state only.
    expect(
      deriveCapabilityState({
        liveProofDigest: 'c'.repeat(64),
      }),
    ).toBe('planned');

    expect(capabilityStateFor('hms_find_reservation')).toBe('live_verified');
    expect(capabilityStateFor('hms_quote_stay')).toBe('discovery_verified');
    expect(capabilityStateFor('hms_read_folio')).toBe('discovery_verified');
    expect(capabilityStateFor('hms_company_account_read')).toBe(
      'fixture_verified',
    );
    expect(activeShadowToolIds()).toEqual([]);
  });

  it('fingerprints registry shape to prevent silent toolset reuse', () => {
    const fp = fingerprintReadToolRegistry();
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
    const again = fingerprintReadToolRegistry();
    expect(again).toBe(fp);
    const manual = createHash('sha256')
      .update(
        JSON.stringify(
          listReadToolIds()
            .sort()
            .map((id) => ({
              id,
              version: READ_TOOLS[id].version,
              effect: READ_TOOLS[id].effect,
              attemptCap: READ_TOOLS[id].attemptCap,
              privacyClass: READ_TOOLS[id].privacyClass,
              deniedActions: READ_TOOLS[id].deniedActions,
              candidateRequirement: READ_TOOLS[id].candidateRequirement,
              claimKinds: READ_TOOLS[id].claimKinds,
              promotionEvidence: READ_TOOLS[id].promotionEvidence,
              discoveryOperationIds:
                'discoveryOperationIds' in READ_TOOLS[id]
                  ? READ_TOOLS[id].discoveryOperationIds
                  : undefined,
              requestBranches:
                'requestBranches' in READ_TOOLS[id]
                  ? READ_TOOLS[id].requestBranches
                  : undefined,
            })),
        ),
      )
      .digest('hex');
    expect(fp).toBe(manual);
  });
});

describe('portfolio-cases.v3 coverage baseline', () => {
  it('migrates all 56 draftEligible thread IDs without message text', () => {
    expect(portfolioCases.schemaVersion).toBe(3);
    expect(portfolioCases.denominator).toBe('draftEligible');
    const ids = portfolioCases.cases.map((c) => c.threadId).sort((a, b) => a - b);
    expect(ids).toEqual([...denominators.draftEligible.members].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(56);

    for (const c of portfolioCases.cases) {
      expect(c).not.toHaveProperty('subject');
      expect(c).not.toHaveProperty('body');
      expect(c).not.toHaveProperty('messageText');
      expect(['adjudicated', 'placeholder']).toContain(c.labelStatus);
      if (c.labelStatus === 'placeholder') {
        expect(c.outcome).toBeNull();
      } else {
        expect(['full', 'useful_partial', 'abstain', 'manual_required']).toContain(
          c.outcome,
        );
      }
    }
  });

  it('ablation reports raw counts and never pre-credits unbuilt tools', () => {
    const releaseOrder = [
      'hms_find_reservation',
      'mail_read_artifact',
      'hms_quote_stay',
    ] as const;

    const report = portfolioAblationReplay({
      cases: portfolioCases.cases,
      releaseOrder: [...releaseOrder],
      outcomesByToolStep: {
        baseline: Object.fromEntries(
          portfolioCases.cases.map((c) => [
            c.threadId,
            c.labelStatus === 'adjudicated' && c.outcome === 'full' ? 'full' : 'abstain',
          ]),
        ),
        hms_find_reservation: Object.fromEntries(
          portfolioCases.cases.map((c) => [
            c.threadId,
            c.labelStatus === 'adjudicated' && c.outcome === 'full' ? 'full' : 'abstain',
          ]),
        ),
        mail_read_artifact: Object.fromEntries(
          portfolioCases.cases.map((c) => [c.threadId, 'abstain']),
        ),
        hms_quote_stay: Object.fromEntries(
          portfolioCases.cases.map((c) => [c.threadId, 'abstain']),
        ),
      },
    });

    expect(report.denominator).toBe(56);
    expect(report.steps.map((s) => s.toolId)).toEqual([
      'baseline',
      'hms_find_reservation',
      'mail_read_artifact',
      'hms_quote_stay',
    ]);
    for (const step of report.steps) {
      expect(step).toEqual(
        expect.objectContaining({
          eligible: 56,
          attempted: expect.any(Number),
          exact: expect.any(Number),
          partial: expect.any(Number),
          manual: expect.any(Number),
          numerator: expect.any(Number),
          denominator: 56,
        }),
      );
      // Placeholder labels must not inflate Full credit.
      expect(step.exact + step.partial + step.manual).toBeLessThanOrEqual(
        portfolioCases.cases.filter((c) => c.labelStatus === 'adjudicated').length,
      );
    }
    // One-sided 95% CI only when adjudicated attempted n >= 30.
    const adjudicated = portfolioCases.cases.filter(
      (c) => c.labelStatus === 'adjudicated',
    ).length;
    for (const step of report.steps) {
      if (step.attempted >= 30) {
        expect(step.confidenceInterval95).not.toBeNull();
        expect(step.confidenceInterval95?.lower).toBeGreaterThanOrEqual(0);
        expect(step.confidenceInterval95?.lower).toBeLessThanOrEqual(1);
      } else {
        expect(step.confidenceInterval95).toBeNull();
      }
    }
    expect(adjudicated).toBeGreaterThanOrEqual(30);
    // Unbuilt tools must not claim positive ΔFull from placeholders
    const quoteStep = report.steps.find((s) => s.toolId === 'hms_quote_stay');
    expect(quoteStep?.deltaFull).toBe(0);
  });

  it('emits non-overlapping intent memberships with opaque thread IDs only', () => {
    const membership = nonOverlappingIntentMembership({
      threads: [
        { threadId: 1, intents: ['quote_request', 'payment_ops'] },
        { threadId: 2, intents: ['payment_ops'] },
        { threadId: 3, intents: ['group_event'] },
        { threadId: 4, intents: ['spam_noise'] },
      ],
      priority: ['quote_request', 'payment_ops', 'group_event'],
    });
    expect(membership.buckets.quote_request).toEqual([1]);
    expect(membership.buckets.payment_ops).toEqual([2]);
    expect(membership.buckets.group_event).toEqual([3]);
    expect(membership.uncovered).toEqual([4]);
    // Mutual exclusion: each ID appears at most once across buckets.
    const seen = new Set<number>();
    for (const ids of Object.values(membership.buckets)) {
      for (const id of ids) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
    expect(membership.totals).toEqual({
      quote_request: 1,
      payment_ops: 1,
      group_event: 1,
      uncovered: 1,
    });
  });
});
