/**
 * Phase B status — snapshot-backed capability report, no AWS/HMS.
 * Static READ_TOOLS is contract/fixture evidence only — not production activation.
 */
import { describe, expect, it } from 'vitest';
import {
  PHASE_B_WAVE_TOOLS,
  buildPhaseBStatusReport,
  formatPhaseBStatusOkLine,
  phaseBStatusJsonRecord,
  toolStatusRow,
} from '../src/ops/phase-b-status.js';
import { READ_TOOL_IDS, READ_TOOLS } from '../src/hms/read-tools.js';

describe('phase-b-status', () => {
  it('emits schemaVersion, tool rows, and empty productionActive by default', () => {
    const report = buildPhaseBStatusReport({ kind: 'all' });
    expect(report.schemaVersion).toBe(1);
    expect(report.productionActiveReadToolIds).toEqual([]);
    expect(report.tools.map((t) => t.id)).toEqual([...READ_TOOL_IDS]);
    for (const row of report.tools) {
      expect(row.version).toBe(READ_TOOLS[row.id].version);
      expect(row.capabilityState).toBeTruthy();
      expect(row.promotionEvidence).toEqual(READ_TOOLS[row.id].promotionEvidence);
      expect(typeof row.fixtureDigestPresent).toBe('boolean');
      expect(typeof row.discoveryDigestPresent).toBe('boolean');
      expect(typeof row.liveProofDigestPresent).toBe('boolean');
    }
  });

  it('filters by --tool and reports find as fixture_verified (demoted)', () => {
    const report = buildPhaseBStatusReport({
      kind: 'tool',
      toolId: 'hms_find_reservation',
    });
    expect(report.tools).toHaveLength(1);
    expect(report.tools[0]).toMatchObject({
      id: 'hms_find_reservation',
      capabilityState: 'fixture_verified',
      fixtureDigestPresent: true,
      discoveryDigestPresent: false,
      liveProofDigestPresent: false,
    });
    expect(report.productionActiveReadToolIds).toEqual([]);
  });

  it('consumes explicit release/capability snapshot for productionActive', () => {
    const report = buildPhaseBStatusReport(
      { kind: 'tool', toolId: 'hms_find_reservation' },
      {
        productionActiveReadToolIds: ['hms_find_reservation'],
      },
    );
    expect(report.productionActiveReadToolIds).toEqual(['hms_find_reservation']);
    // Snapshot does not invent digests onto static contract rows.
    expect(report.tools[0]?.discoveryDigestPresent).toBe(false);
  });

  it('filters by known --wave sets', () => {
    expect(PHASE_B_WAVE_TOOLS.B1).toEqual([
      'hms_find_reservation',
      'mail_read_artifact',
      'hms_quote_stay',
    ]);
    const b2 = buildPhaseBStatusReport({ kind: 'wave', waveId: 'B2' });
    expect(b2.tools.map((t) => t.id)).toEqual([
      'hms_list_documents',
      'hms_sent_email_audit',
    ]);
    const b0 = buildPhaseBStatusReport({ kind: 'wave', waveId: 'B0' });
    expect(b0.tools).toEqual([]);
  });

  it('fixture_verified tools report digests without inventing discovery/live', () => {
    const row = toolStatusRow('hms_quote_stay');
    expect(row.capabilityState).toBe('fixture_verified');
    expect(row.fixtureDigestPresent).toBe(true);
    expect(row.discoveryDigestPresent).toBe(false);
    expect(row.liveProofDigestPresent).toBe(false);
    expect(row.promotionEvidence).toEqual({
      fixture: true,
      discovery: false,
      live: false,
      shadow: false,
    });
  });

  it('formats STATUS_OK outcome for registry read', () => {
    expect(formatPhaseBStatusOkLine()).toBe('HMS_OK code=STATUS_OK');
    const json = phaseBStatusJsonRecord(
      buildPhaseBStatusReport({ kind: 'tool', toolId: 'hms_event_read' }),
    );
    expect(json).toMatchObject({
      schemaVersion: 1,
      outcome: 'ok',
      stage: 'status',
      code: 'STATUS_OK',
      exitCode: 0,
      productionActiveReadToolIds: [],
    });
    expect(json.tools).toHaveLength(1);
  });
});
