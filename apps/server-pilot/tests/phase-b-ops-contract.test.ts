/**
 * Phase B ops front-door + live-proof wiring contracts (no pilot RDS / no HMS).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildDiscoveryReceiptV2,
  buildProofReceiptV2,
} from '../src/hms/browser-artifacts.js';
import { hmsProtectedArtifactIndexEntryV1Schema } from '../src/hms/artifact-index.js';
import {
  parsePhaseBArgv,
  runPhaseBLocalOperator,
} from '../src/ops/phase-b-operation.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverPilot = join(here, '..');
const deploy = join(serverPilot, 'deploy');

describe('phase-b-ops-contract', () => {
  it('ops-hms-proof.sh has no PHASE_B_BLOCKED in executable source', () => {
    const script = readFileSync(join(deploy, 'ops-hms-proof.sh'), 'utf8');
    // Help/docs may mention historical code; executable case bodies must not emit it.
    const caseBodies = script
      .split('\n')
      .filter((line) => !/^\s*#/.test(line) && !/usage:|printf/.test(line))
      .join('\n');
    expect(caseBodies).not.toMatch(/PHASE_B_BLOCKED/);
  });

  it('ops front door uses shared argv parser + one canonical envelope', () => {
    const script = readFileSync(join(deploy, 'ops-hms-proof.sh'), 'utf8');
    expect(script).toMatch(/phase-b-operation/);
    expect(script).toMatch(/parsePhaseBArgv|phase_b_operator|canonical/i);
    expect(script).toMatch(/--resume/);
    expect(script).toMatch(/rearm .*--operation|--operation.*--after-source/s);
    // No second per-tool Phase B case grammar for discovery/proof.
    expect(script).not.toMatch(
      /case "\$TOOL_ID" in[\s\S]{0,80}hms_quote_stay/,
    );
  });

  it('hms-live-proof remains sole proof CLI and imports operation store', () => {
    const proof = readFileSync(
      join(serverPilot, 'src', 'ops', 'hms-live-proof.ts'),
      'utf8',
    );
    expect(proof).toMatch(/phase-b-operation/);
    expect(proof).toMatch(/PhaseBOperationStore|parsePhaseBArgv|runPhaseB/);
    expect(proof).not.toMatch(/PHASE_B_BLOCKED/);
    // Still owns Phase A proof-video path.
    expect(proof).toMatch(/runProofVideo|proof-video/);
  });

  it('hms-read-gate accepts optional --tool / --wave scope', () => {
    const gate = readFileSync(join(deploy, 'hms-read-gate.sh'), 'utf8');
    expect(gate).toMatch(/--tool/);
    expect(gate).toMatch(/--wave/);
  });

  it('discovery/proof receipt variants stay strict for HmsReadToolId', () => {
    const common = {
      artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      toolId: 'hms_find_reservation' as const,
      discoveryOperationId: 'guest_stay_search' as const,
      toolVersion: '1.2.0',
      sourceRevision: 'rev',
      credentialVersionHmacSha256: 'c'.repeat(64),
      runtimeFingerprintSha256: 'd'.repeat(64),
      privateDigestKeyVersion: 'v1',
      traceSha256: 'e'.repeat(64),
      videoSha256: null,
      operationOutcome: 'succeeded' as const,
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const discovery = buildDiscoveryReceiptV2({
      ...common,
      structuralSignatureSha256: 'f'.repeat(64),
      candidateSnapshotSha256: null,
    });
    expect(discovery.executionClass).toBe('discovery');
    expect(discovery).not.toHaveProperty('roleProofSha256');
    expect(discovery).not.toHaveProperty('oracleArtifactSha256');

    const proof = buildProofReceiptV2({
      ...common,
      requestBranchId: 'guest_stay_search',
      candidateSnapshotSha256: '1'.repeat(64),
      candidateHmacSha256: '2'.repeat(64),
      scopeHmacSha256: '3'.repeat(64),
      resultHmacSha256: '4'.repeat(64),
      sourceRefHmacSha256: '5'.repeat(64),
      roleProofSha256: '6'.repeat(64),
      discoveryReceiptSha256: '7'.repeat(64),
      oracleArtifactSha256: '8'.repeat(64),
    });
    expect(proof.executionClass).toBe('proof');
  });

  it('protected artifact index carries operation/source/release/completeness fields', () => {
    const parsed = hmsProtectedArtifactIndexEntryV1Schema.safeParse({
      schemaVersion: 1,
      artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      toolId: 'hms_find_reservation',
      toolVersion: '1.2.0',
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sourceRevision: 'phase-b-rev',
      releaseId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      kinds: ['receipt', 'discovery'],
      receiptSchema: 'v2',
      complete: true,
      digestValid: true,
      sensitiveMediaExpiresAt: '2099-01-01T00:00:00.000Z',
      accessAudit: {
        lastFetchAt: null,
        fetchCount: 0,
        confirmSensitiveCount: 0,
      },
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
  });

  it('local operator emits DISCOVERY_READY next step without PHASE_B_BLOCKED', () => {
    const parsed = parsePhaseBArgv([
      'read-discovery',
      'hms_find_reservation',
      '--json',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = runPhaseBLocalOperator({
      command: parsed.command,
      operationId: '11111111-1111-4111-8111-111111111111',
      sourceRevision: 'local-test',
    });
    expect(result.code).not.toBe('PHASE_B_BLOCKED');
    expect(['NEXT_ACTION_READY', 'AGENT_REPAIR_REQUIRED', 'COMPLETE']).toContain(
      result.code,
    );
    expect(result.schemaVersion).toBe(1);
  });

  it('offline doctor via shared parser performs no HMS call shape', () => {
    const parsed = parsePhaseBArgv(['doctor', '--offline', '--json']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.command).toMatchObject({
      action: 'doctor',
      offline: true,
      json: true,
    });
    const result = runPhaseBLocalOperator({
      command: parsed.command,
      operationId: '11111111-1111-4111-8111-111111111111',
      sourceRevision: 'local-test',
    });
    expect(result.code).toBe('COMPLETE');
    expect(result.exitCode).toBe(0);
  });
});
