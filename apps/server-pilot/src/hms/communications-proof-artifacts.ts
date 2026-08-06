/**
 * Communications live-proof private artifacts (sent-email audit + list docs).
 * Digests/HMACs only — never raw subjects/addresses/filenames.
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  hmsProtectedArtifactIndexEntryV1Schema,
  loadProtectedArtifactIndexSync,
  writeProtectedArtifactIndex,
  type HmsProtectedArtifactIndexEntryV1,
} from './artifact-index.js';
import {
  buildProofReceiptV2,
  writeBrowserArtifactReceiptV2,
} from './browser-artifacts.js';
import type { HmsBrowserArtifactReceiptV2 } from './release-kernel.js';
import type { HmsReadToolId } from './read-tools.js';

export type MaskedCommsProofDigests = {
  candidateSnapshotSha256: string;
  candidateHmacSha256: string;
  scopeHmacSha256: string;
  resultHmacSha256: string;
  sourceRefHmacSha256: string;
  discoveryReceiptSha256: string;
  oracleArtifactSha256: string;
  maskedTraceSha256: string;
  maskedVideoSha256: string | null;
};

export type MaterializeMaskedCommsProofInput = {
  artifactRoot: string;
  indexPath: string;
  operationId: string;
  releaseId: string;
  sourceRevision: string;
  toolId: Extract<HmsReadToolId, 'hms_sent_email_audit' | 'hms_list_documents'>;
  toolVersion?: string;
  credentialVersionHmacSha256: string;
  runtimeFingerprintSha256: string;
  privateDigestKeyVersion: string;
  roleProofSha256: string;
  requestBranchId: string;
  discoveryOperationId: 'sent_email_list' | 'tax_invoice_list';
  digests: MaskedCommsProofDigests;
  expiresAt?: string;
  now?: Date;
};

export async function materializeMaskedCommsProofArtifacts(
  input: MaterializeMaskedCommsProofInput,
): Promise<{
  artifactId: string;
  receipt: HmsBrowserArtifactReceiptV2;
  privateArtifactIds: string[];
}> {
  const now = input.now ?? new Date();
  const artifactId = randomUUID();
  const expiresAt =
    input.expiresAt ??
    new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const receipt = buildProofReceiptV2({
    artifactId,
    operationId: input.operationId,
    toolId: input.toolId,
    discoveryOperationId: input.discoveryOperationId,
    toolVersion: input.toolVersion ?? '1.0.0',
    sourceRevision: input.sourceRevision,
    credentialVersionHmacSha256: input.credentialVersionHmacSha256,
    runtimeFingerprintSha256: input.runtimeFingerprintSha256,
    privateDigestKeyVersion: input.privateDigestKeyVersion,
    traceSha256: input.digests.maskedTraceSha256,
    videoSha256: input.digests.maskedVideoSha256,
    operationOutcome: 'succeeded',
    expiresAt,
    requestBranchId: input.requestBranchId,
    candidateSnapshotSha256: input.digests.candidateSnapshotSha256,
    candidateHmacSha256: input.digests.candidateHmacSha256,
    scopeHmacSha256: input.digests.scopeHmacSha256,
    resultHmacSha256: input.digests.resultHmacSha256,
    sourceRefHmacSha256: input.digests.sourceRefHmacSha256,
    roleProofSha256: input.roleProofSha256,
    discoveryReceiptSha256: input.digests.discoveryReceiptSha256,
    oracleArtifactSha256: input.digests.oracleArtifactSha256,
  });

  const artifactDir = join(input.artifactRoot, artifactId);
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  await writeBrowserArtifactReceiptV2(artifactDir, receipt);

  const existing = loadProtectedArtifactIndexSync(input.indexPath);
  const entry = hmsProtectedArtifactIndexEntryV1Schema.parse({
    schemaVersion: 1,
    artifactId,
    toolId: input.toolId,
    toolVersion: input.toolVersion ?? '1.0.0',
    operationId: input.operationId,
    sourceRevision: input.sourceRevision,
    releaseId: input.releaseId,
    kinds: ['receipt', 'live_proof', 'trace'],
    receiptSchema: 'v2',
    complete: true,
    digestValid: true,
    sensitiveMediaExpiresAt: expiresAt,
    accessAudit: {
      lastFetchAt: null,
      fetchCount: 0,
      confirmSensitiveCount: 0,
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt,
  } satisfies HmsProtectedArtifactIndexEntryV1);

  const merged = [
    ...existing.filter((e) => e.artifactId !== artifactId),
    entry,
  ];
  await writeProtectedArtifactIndex(input.indexPath, merged);

  return {
    artifactId,
    receipt,
    privateArtifactIds: [artifactId],
  };
}
