/**
 * Quote masked proof receipt-v2 + private artifact index bind.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { materializeMaskedQuoteProofArtifacts } from '../src/hms/quote-proof-artifacts.js';
import {
  buildPhaseBStatusReport,
  loadPhaseBReleaseCapabilitySnapshotFromDisk,
} from '../src/ops/phase-b-status.js';
import { fingerprintActiveSet } from '../src/hms/release-kernel.js';
import { fingerprintReadToolRegistry } from '../src/hms/read-tools.js';
import { writeFileSync } from 'node:fs';

describe('quote proof private artifacts', () => {
  it('writes receipt v2 + index IDs that status can bind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quote-proof-'));
    const artifactRoot = join(root, 'artifacts');
    const indexPath = join(root, 'index.v1.json');
    const registryPath = join(root, 'active.json');
    const releaseId = randomUUID();
    const operationId = randomUUID();

    const materialized = await materializeMaskedQuoteProofArtifacts({
      artifactRoot,
      indexPath,
      operationId,
      releaseId,
      sourceRevision: 'test-rev',
      credentialVersionHmacSha256: '1'.repeat(64),
      runtimeFingerprintSha256: '2'.repeat(64),
      privateDigestKeyVersion: 'v1',
      roleProofSha256: '3'.repeat(64),
      digests: {
        candidateSnapshotSha256: '4'.repeat(64),
        candidateHmacSha256: '5'.repeat(64),
        scopeHmacSha256: '6'.repeat(64),
        resultHmacSha256: '7'.repeat(64),
        sourceRefHmacSha256: '8'.repeat(64),
        discoveryReceiptSha256: '9'.repeat(64),
        oracleArtifactSha256: '0'.repeat(64),
        maskedTraceSha256: 'a'.repeat(64),
        maskedVideoSha256: null,
      },
    });

    expect(materialized.artifactId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(materialized.receipt.executionClass).toBe('proof');
    expect(materialized.receipt.toolId).toBe('hms_quote_stay');
    const receiptPath = join(
      artifactRoot,
      materialized.artifactId,
      'receipt.v2.json',
    );
    const receiptBody = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(receiptBody.schemaVersion).toBe(2);
    // No raw candidate / rate / PII keys in public receipt.
    expect(JSON.stringify(receiptBody)).not.toMatch(/roomRate|guest|surname|STD|BAR/i);

    const toolsetFingerprint = fingerprintReadToolRegistry();
    const base = {
      schemaVersion: 2 as const,
      generation: 1,
      toolsetVersion: '3.0.0',
      toolsetFingerprint,
      active: { hms_quote_stay: releaseId },
      immediatePredecessor: {},
    };
    writeFileSync(
      registryPath,
      `${JSON.stringify({
        ...base,
        activeSetFingerprint: fingerprintActiveSet(base),
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
    expect(report.tools[0]?.activeReleaseId).toBe(releaseId);
    expect(report.tools[0]?.privateArtifactIds).toEqual([
      materialized.artifactId,
    ]);
  });
});
