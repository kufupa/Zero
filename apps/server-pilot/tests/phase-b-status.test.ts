/**
 * Phase B status — snapshot-backed capability report, no AWS/HMS.
 * Static READ_TOOLS is contract/fixture evidence only — not production activation.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PHASE_B_WAVE_TOOLS,
  buildPhaseBStatusReport,
  formatPhaseBStatusOkLine,
  loadPhaseBReleaseCapabilitySnapshotFromDisk,
  phaseBStatusJsonRecord,
  toolStatusRow,
} from '../src/ops/phase-b-status.js';
import { READ_TOOL_IDS, READ_TOOLS, fingerprintReadToolRegistry } from '../src/hms/read-tools.js';
import { fingerprintActiveSet } from '../src/hms/release-kernel.js';

describe('phase-b-status', () => {
  it('emits schemaVersion, tool rows, and empty productionActive by default', () => {
    const report = buildPhaseBStatusReport({ kind: 'all' });
    expect(report.schemaVersion).toBe(1);
    expect(report.productionActiveReadToolIds).toEqual([]);
    expect(report.registryLoadState).toBe('missing');
    expect(report.tools.map((t) => t.id)).toEqual([...READ_TOOL_IDS]);
    for (const row of report.tools) {
      expect(row.version).toBe(READ_TOOLS[row.id].version);
      expect(row.capabilityState).toBeTruthy();
      expect(row.promotionEvidence).toEqual(READ_TOOLS[row.id].promotionEvidence);
      expect(typeof row.fixtureDigestPresent).toBe('boolean');
      expect(typeof row.discoveryDigestPresent).toBe('boolean');
      expect(typeof row.liveProofDigestPresent).toBe('boolean');
      expect(row.activeReleaseId).toBeNull();
      expect(row.privateArtifactIds).toEqual([]);
    }
  });

  it('filters by --tool and reports find as live_verified after soft proof', () => {
    const report = buildPhaseBStatusReport({
      kind: 'tool',
      toolId: 'hms_find_reservation',
    });
    expect(report.tools).toHaveLength(1);
    expect(report.tools[0]).toMatchObject({
      id: 'hms_find_reservation',
      capabilityState: 'live_verified',
      fixtureDigestPresent: true,
      discoveryDigestPresent: true,
      liveProofDigestPresent: true,
      activeReleaseId: null,
      privateArtifactIds: [],
    });
    // Default snapshot still empty — productionActive comes from registry snapshot overlay.
    expect(report.productionActiveReadToolIds).toEqual([]);
  });

  it('consumes explicit release/capability snapshot for productionActive', () => {
    const releaseId = randomUUID();
    const artifactId = randomUUID();
    const report = buildPhaseBStatusReport(
      { kind: 'tool', toolId: 'hms_find_reservation' },
      {
        productionActiveReadToolIds: ['hms_find_reservation'],
        activeReleaseIdByTool: new Map([
          ['hms_find_reservation', releaseId],
        ]),
        privateArtifactIdsByTool: new Map([
          ['hms_find_reservation', [artifactId]],
        ]),
      },
    );
    expect(report.productionActiveReadToolIds).toEqual(['hms_find_reservation']);
    expect(report.tools[0]?.activeReleaseId).toBe(releaseId);
    expect(report.tools[0]?.privateArtifactIds).toEqual([artifactId]);
    // Static READ_TOOLS digests remain visible; snapshot only overlays release/artifact IDs.
    expect(report.tools[0]?.discoveryDigestPresent).toBe(true);
    expect(report.tools[0]?.liveProofDigestPresent).toBe(true);
  });

  it('binds quote active release + empty private IDs from registry snapshot', () => {
    const quoteReleaseId = randomUUID();
    const report = buildPhaseBStatusReport(
      { kind: 'tool', toolId: 'hms_quote_stay' },
      {
        productionActiveReadToolIds: ['hms_quote_stay'],
        activeReleaseIdByTool: new Map([['hms_quote_stay', quoteReleaseId]]),
        privateArtifactIdsByTool: new Map([['hms_quote_stay', []]]),
      },
    );
    expect(report.productionActiveReadToolIds).toContain('hms_quote_stay');
    expect(report.tools[0]).toMatchObject({
      id: 'hms_quote_stay',
      activeReleaseId: quoteReleaseId,
      privateArtifactIds: [],
    });
    // Not fixture_verified-only: release binding present.
    expect(report.tools[0]?.activeReleaseId).not.toBeNull();
  });

  it('loads registry + index from disk for quote status bind', () => {
    const root = mkdtempSync(join(tmpdir(), 'phase-b-status-'));
    const registryPath = join(root, 'active.json');
    const indexPath = join(root, 'index.v1.json');
    const quoteReleaseId = randomUUID();
    const artifactId = randomUUID();
    const toolsetFingerprint = fingerprintReadToolRegistry();
    const base = {
      schemaVersion: 2 as const,
      generation: 1,
      toolsetVersion: '3.0.0',
      toolsetFingerprint,
      active: { hms_quote_stay: quoteReleaseId },
      immediatePredecessor: {},
    };
    const registry = {
      ...base,
      activeSetFingerprint: fingerprintActiveSet(base),
    };
    writeFileSync(registryPath, `${JSON.stringify(registry)}\n`);
    writeFileSync(
      indexPath,
      `${JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            schemaVersion: 1,
            artifactId,
            toolId: 'hms_quote_stay',
            toolVersion: '2.0.0',
            releaseId: quoteReleaseId,
            kinds: ['receipt', 'live_proof'],
            receiptSchema: 'v2',
            complete: true,
            digestValid: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      })}\n`,
    );

    const snap = loadPhaseBReleaseCapabilitySnapshotFromDisk({
      HMS_ACTIVE_REGISTRY_PATH: registryPath,
      HMS_PROTECTED_ARTIFACT_INDEX_PATH: indexPath,
    } as NodeJS.ProcessEnv);
    const report = buildPhaseBStatusReport(
      { kind: 'tool', toolId: 'hms_quote_stay' },
      snap,
    );
    expect(report.productionActiveReadToolIds).toEqual(['hms_quote_stay']);
    expect(report.registryLoadState).toBe('ok');
    expect(snap.registryLoadState).toBe('ok');
    expect(report.tools[0]?.activeReleaseId).toBe(quoteReleaseId);
    expect(report.tools[0]?.privateArtifactIds).toEqual([artifactId]);
  });

  it('filters by known --wave sets', () => {
    expect(PHASE_B_WAVE_TOOLS.B1).toEqual([
      'hms_find_reservation',
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

  it('quote remains fixture-only until tenant Hotel Availability discovery exists', () => {
    const row = toolStatusRow('hms_quote_stay');
    expect(row.capabilityState).toBe('fixture_verified');
    expect(row.fixtureDigestPresent).toBe(true);
    expect(row.discoveryDigestPresent).toBe(false);
    expect(row.liveProofDigestPresent).toBe(false);
    expect(row.activeReleaseId).toBeNull();
    expect(row.privateArtifactIds).toEqual([]);
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
