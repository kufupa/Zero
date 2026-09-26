/**
 * RCA dossier v1 — closed schema, stub load, required empirical-loop tools.
 */
import { describe, expect, it } from 'vitest';
import {
  RCA_DOSSIER_REQUIRED_TOOL_IDS,
  loadRcaDossier,
  parseRcaDossier,
  rcaDossierV1Schema,
} from '../src/hms/rca-dossier.js';
import { READ_TOOLS } from '../src/hms/read-tools.js';

function stubBase(
  overrides: Partial<ReturnType<typeof parseRcaDossier>> & {
    toolId: keyof typeof READ_TOOLS;
  },
) {
  const tool = READ_TOOLS[overrides.toolId];
  return {
    toolId: overrides.toolId,
    toolVersion: tool.version,
    symptom: 'fixture_verified awaiting discovery',
    structuralObservation: {
      routeClass: 'fixture_stub',
      envelopeDiscriminator: 'unproven',
    },
    assumptionsVerified: [],
    assumptionsInvalidated: [],
    causalChain: ['fixture_stub'],
    prediction: 'Discovery evidence replaces stub gaps',
    verificationCommands: ['npx vitest run tests/hms-rca-dossier.test.ts'],
    liveArtifactIds: [],
    unresolvedGaps: ['BLOCKED_TOOL_FIXTURE_ONLY'],
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('hms-rca-dossier', () => {
  it('rejects free-form private-looking keys', () => {
    const withGuest = {
      ...stubBase({ toolId: 'hms_quote_stay' }),
      guestName: 'Alice Example',
      guestEmail: 'alice@example.com',
      confirmationNumber: '123456789',
    };
    const result = rcaDossierV1Schema.safeParse(withGuest);
    expect(result.success).toBe(false);

    const nestedPrivate = {
      ...stubBase({ toolId: 'hms_quote_stay' }),
      structuralObservation: {
        routeClass: 'quote_stay_read',
        envelopeDiscriminator: 'fixture_only_unproven',
        guestPhone: '+27000000000',
      },
    };
    expect(rcaDossierV1Schema.safeParse(nestedPrivate).success).toBe(false);
  });

  it('rejects symptom that looks private', () => {
    expect(
      rcaDossierV1Schema.safeParse(
        stubBase({
          toolId: 'hms_quote_stay',
          symptom: 'guest alice@example.com missing',
        }),
      ).success,
    ).toBe(false);
    expect(
      rcaDossierV1Schema.safeParse(
        stubBase({
          toolId: 'hms_quote_stay',
          symptom: 'confirmation 123456789 missing',
        }),
      ).success,
    ).toBe(false);
  });

  it('accepts a valid stub dossier', () => {
    const parsed = parseRcaDossier(stubBase({ toolId: 'hms_event_read' }));
    expect(parsed.toolId).toBe('hms_event_read');
    expect(parsed.unresolvedGaps).toEqual(['BLOCKED_TOOL_FIXTURE_ONLY']);
    expect(parsed.liveArtifactIds).toEqual([]);
  });

  it('lists required empirical-loop tools and loads each stub', () => {
    expect([...RCA_DOSSIER_REQUIRED_TOOL_IDS].sort()).toEqual(
      [
        'hms_company_account_read',
        'hms_event_read',
        'hms_find_reservation',
        'hms_group_block_read',
        'hms_list_documents',
        'hms_quote_stay',
        'hms_read_folio',
        'hms_sent_email_audit',
      ].sort(),
    );

    for (const toolId of RCA_DOSSIER_REQUIRED_TOOL_IDS) {
      const dossier = loadRcaDossier(toolId);
      expect(dossier.toolId).toBe(toolId);
      expect(dossier.toolVersion).toBe(READ_TOOLS[toolId].version);
      expect(dossier.symptom).toMatch(
        /fixture_verified awaiting discovery|discovery_verified awaiting live proof|live_verified/,
      );
      expect(dossier.unresolvedGaps.length).toBeGreaterThan(0);
      expect(
        dossier.unresolvedGaps.every((code) => /^BLOCKED_[A-Z0-9_]+$/.test(code)),
      ).toBe(true);
      expect(dossier.liveArtifactIds).toEqual([]);
    }
  });

  it('find stub may note live_verified while empirical matrix stands', () => {
    const dossier = loadRcaDossier('hms_find_reservation');
    expect(dossier.symptom).toMatch(/live_verified/);
    expect(dossier.unresolvedGaps).toContain('BLOCKED_EMPIRICAL_MATRIX_STANDING');
  });
});
