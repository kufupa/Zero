/**
 * Phase B doctor — offline readiness + named preflight blockers, no AWS/HMS.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPhaseBDoctorReport,
  formatPhaseBDoctorOkLine,
  phaseBDoctorJsonRecord,
} from '../src/ops/phase-b-doctor.js';
import {
  READ_TOOL_IDS,
  productionActiveReadToolIds,
} from '../src/hms/read-tools.js';

describe('phase-b-doctor', () => {
  it('aggregates registry status plus discovery preflight codes without inventing live', () => {
    const report = buildPhaseBDoctorReport({
      roleProofV2Path: null,
      reviewedRequestManifestPath: null,
      now: new Date('2026-08-06T12:00:00.000Z'),
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.liveReady).toBe(false);
    expect(report.tools.map((t) => t.id)).toEqual([...READ_TOOL_IDS]);
    expect(report.uniqueBlockerCodes).toContain('BLOCKED_NO_ROLE_PROOF_V2');
    for (const row of report.tools) {
      expect(row.capabilityState).toBeTruthy();
      expect(typeof row.discoveryPreflightCode).toBe('string');
    }
    const quote = report.tools.find((t) => t.id === 'hms_quote_stay');
    expect(quote?.discoveryPreflightCode).toBe('BLOCKED_NO_ROLE_PROOF_V2');
    const mail = report.tools.find((t) => t.id === 'mail_read_artifact');
    expect(mail?.discoveryPreflightCode).toBe('BLOCKED_MAIL_ARTIFACT_DISCOVERY');
  });

  it('reports production active-read decoupling (find only)', () => {
    const report = buildPhaseBDoctorReport({
      roleProofV2Path: null,
      reviewedRequestManifestPath: null,
    });
    expect(report.productionActiveReadToolIds).toEqual(
      productionActiveReadToolIds(),
    );
    expect(report.productionActiveReadToolIds).toEqual([
      'hms_find_reservation',
    ]);
    expect(report.productionActiveReadDecoupled).toBe(true);
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
    });
  });
});
