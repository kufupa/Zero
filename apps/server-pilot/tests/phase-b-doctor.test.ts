/**
 * Phase B doctor — offline readiness + named preflight codes, no AWS/HMS.
 * Production activation comes from explicit snapshot — not static READ_TOOLS.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPhaseBDoctorReport,
  formatPhaseBDoctorOkLine,
  phaseBDoctorJsonRecord,
} from '../src/ops/phase-b-doctor.js';
import { READ_TOOL_IDS } from '../src/hms/read-tools.js';

describe('phase-b-doctor', () => {
  it('aggregates registry status plus discovery preflight without inventing live', () => {
    const report = buildPhaseBDoctorReport({
      roleProofV2Path: null,
      reviewedRequestManifestPath: null,
      now: new Date('2026-08-06T12:00:00.000Z'),
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.liveReady).toBe(false);
    expect(report.tools.map((t) => t.id)).toEqual([...READ_TOOL_IDS]);
    expect(report.productionActiveReadToolIds).toEqual([]);
    for (const row of report.tools) {
      expect(row.capabilityState).toBeTruthy();
      expect(typeof row.discoveryPreflightCode).toBe('string');
    }
    const quote = report.tools.find((t) => t.id === 'hms_quote_stay');
    expect(quote?.discoveryPreflightCode).toBe('DISCOVERY_READY');
    const find = report.tools.find((t) => t.id === 'hms_find_reservation');
    expect(find?.discoveryPreflightCode).toBe('DISCOVERY_READY');
    expect(find?.capabilityState).toBe('live_verified');
    expect(report.tools).not.toContainEqual(expect.objectContaining({ id: 'mail_read_artifact' }));
    expect(report.uniqueBlockerCodes).not.toContain('BLOCKED_MAIL_ARTIFACT_DISCOVERY');
    expect(report.uniqueBlockerCodes).not.toContain('PHASE_B_BLOCKED');
  });

  it('reports empty productionActive (find demotion) and decoupling', () => {
    const report = buildPhaseBDoctorReport({
      roleProofV2Path: null,
      reviewedRequestManifestPath: null,
    });
    expect(report.productionActiveReadToolIds).toEqual([]);
    expect(report.productionActiveReadDecoupled).toBe(true);
  });

  it('consumes explicit snapshot for productionActive without treating READ_TOOLS as activation', () => {
    const releaseId = '00000000-0000-4000-8000-000000000099';
    const report = buildPhaseBDoctorReport({
      roleProofV2Path: null,
      reviewedRequestManifestPath: null,
      snapshot: {
        productionActiveReadToolIds: ['hms_find_reservation'],
        activeReleaseIdByTool: new Map([
          ['hms_find_reservation', releaseId],
        ]),
        registryLoadState: 'ok',
      },
    });
    expect(report.productionActiveReadToolIds).toEqual(['hms_find_reservation']);
    expect(report.registryLoadState).toBe('ok');
    // Demotion-era: any snapshot-active tool flips decoupled false.
    expect(report.productionActiveReadDecoupled).toBe(false);
    // Static live evidence remains visible; snapshot is still the activation authority.
    const find = report.tools.find((t) => t.id === 'hms_find_reservation');
    expect(find?.capabilityState).toBe('live_verified');
    expect(find?.discoveryDigestPresent).toBe(true);
    expect(find?.activeReleaseId).toBe(releaseId);
  });

  it('formats DOCTOR_OK outcome for diagnosis', () => {
    expect(formatPhaseBDoctorOkLine()).toBe('HMS_OK code=DOCTOR_OK');
    const json = phaseBDoctorJsonRecord(
      buildPhaseBDoctorReport({
        roleProofV2Path: null,
        reviewedRequestManifestPath: null,
      }),
    );
    expect(json).toMatchObject({
      schemaVersion: 1,
      outcome: 'ok',
      stage: 'doctor',
      code: 'DOCTOR_OK',
      exitCode: 0,
      liveReady: false,
      productionActiveReadToolIds: [],
      productionActiveReadDecoupled: true,
    });
  });
});
