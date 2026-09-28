/**
 * Private connected-runner proof binding.
 *
 * The sidecar is deliberately outside the shipped bundle.  It names the
 * operator-supplied role-proof files and pins their bytes and scope to the
 * session fields built by the connected runner.  A pre-promotion sidecar is a
 * valid isolated live-proof input; an active registry is only consulted by an
 * optional release entry.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  createReadToolHandler,
} from '../../../../../../apps/server-pilot/src/hms/read-handler-index.js';
import {
  hmsPortfolioToolReleaseV2Schema,
  hmsReadRoleProofV1Schema,
  hmsReadRoleProofV2Schema,
  validateRoleProofV1,
  validateRoleProofV2ForTool,
  type HmsReadRoleProofV1,
  type HmsReadRoleProofV2,
  type HmsSessionAuthorization,
} from '../../../../../../apps/server-pilot/src/hms/release-kernel.js';
import {
  runtimeFingerprintSha256 as computeRuntimeFingerprintSha256,
  type RuntimeFingerprintInput,
} from '../../../../../../apps/server-pilot/src/hms/evidence-runtime.js';
import { HMS_READ_TOOL_IDS, READ_TOOLS } from '../../../../../../apps/server-pilot/src/hms/read-tools.js';

/** Legacy U15 notes auth remains outside the Phase-B HmsReadToolId union. */
export type ConnectedSessionAuthorization =
  | HmsSessionAuthorization
  | (Omit<
      HmsSessionAuthorization,
      'toolId' | 'discoveryOperationId' | 'requestBranchId'
    > & {
      toolId: 'hms_read_notes_traces';
      discoveryOperationId: 'notes_traces_list';
      requestBranchId: 'notes_traces_list';
    });

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const proofSchemaVersion = z.union([z.literal(1), z.literal(2)]);
const proofToolId = z.enum(HMS_READ_TOOL_IDS);

const connectedProofEntrySchema = z
  .object({
    schemaVersion: proofSchemaVersion,
    roleProofPath: z.string().min(1),
    roleProofSha256: digest,
    /** Required for v2 so the proof's role scope cannot be silently widened. */
    toolId: proofToolId.optional(),
    expectedActorHmacSha256: digest.optional(),
    expectedEvidenceArtifactId: z.string().uuid().optional(),
    expectedEvidenceSha256: digest.optional(),
    /** Optional isolated release binding; absence means pre-promotion mode. */
    release: hmsPortfolioToolReleaseV2Schema.optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.schemaVersion !== 2) return;
    if (!entry.toolId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolId'],
        message: 'v2 proof binding requires a tool id',
      });
    }
    if (!entry.expectedActorHmacSha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedActorHmacSha256'],
        message: 'v2 proof binding requires actor evidence',
      });
    }
    if (!entry.expectedEvidenceArtifactId || !entry.expectedEvidenceSha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedEvidenceArtifactId'],
        message: 'v2 proof binding requires evidence scope',
      });
    }
  });

export const connectedProofBindingSidecarSchema = z
  .object({
    schemaVersion: z.literal('hms-connected-proof-binding/v1'),
    mode: z.enum(['pre_promotion', 'release_bound']),
    /** Source-supplied opaque id for an isolated pre-promotion lease. */
    bindingId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, 'expected opaque binding id'),
    propertyCode: z.literal('HRCEN'),
    /** Actual source-file fingerprint from the frozen bundle manifest. */
    bundleSourceFingerprintSha256: digest,
    /** Secrets Manager VersionId metadata; raw credentials never enter this file. */
    secretVersionId: z.string().min(1),
    credentialVersionHmacSha256: digest,
    runtimeFingerprintSha256: digest,
    privateDigestKeyVersion: z.string().min(1),
    sourceRevision: z.string().min(1),
    /** Find is mandatory because detail and legacy notes are its children. */
    find: connectedProofEntrySchema,
    folio: connectedProofEntrySchema.optional(),
    notes: connectedProofEntrySchema.optional(),
    sent: connectedProofEntrySchema.optional(),
  })
  .strict()
  .superRefine((sidecar, context) => {
    if (
      sidecar.mode === 'release_bound' &&
      ![sidecar.find, sidecar.folio, sidecar.notes, sidecar.sent].some(
        (entry) => entry?.release,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mode'],
        message: 'release_bound sidecar requires an attached release entry',
      });
    }
  });

export type ConnectedProofBindingSidecar = z.infer<
  typeof connectedProofBindingSidecarSchema
>;
export type ConnectedProofBindingEntry = z.infer<
  typeof connectedProofEntrySchema
>;

type ConnectedRoleProof = HmsReadRoleProofV1 | HmsReadRoleProofV2;

type VerifiedRoleProofSnapshot = Readonly<{
  bytes: Buffer;
  digest: string;
  proof: ConnectedRoleProof;
}>;

/**
 * The runtime calls the binding validator immediately before its role-proof
 * loader. Keep that handoff in memory, keyed by the sidecar object and exact
 * path, so the loader consumes the bytes that were hashed and parsed rather
 * than reopening an owner-controlled path.
 */
const verifiedRoleProofSnapshots = new WeakMap<
  ConnectedProofBindingSidecar,
  Map<string, VerifiedRoleProofSnapshot>
>();

export type ConnectedSecretVersion = {
  versionId: string;
  versionStages: readonly string[];
};

export class ConnectedProofBindingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConnectedProofBindingError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ConnectedProofBindingError(code, message);
}

async function readPrivateFile(path: string, code: string): Promise<Buffer> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    fail(code, 'private proof binding file is unavailable');
  }
  if (!stat.isFile() || (stat.mode & 0o022) !== 0) {
    fail(code, 'private proof binding file is not a protected regular file');
  }
  try {
    return await readFile(path);
  } catch {
    fail(code, 'private proof binding file could not be read');
  }
}

/** Check the actual frozen bundle source fingerprint, not merely sidecar text. */
export async function assertConnectedBundleSourceFingerprint(
  binding: ConnectedProofBindingSidecar,
  manifestPath: string = join(process.cwd(), 'bundle-manifest.json'),
): Promise<void> {
  const manifest = parseJson(
    await readPrivateFile(manifestPath, 'CONNECTED_BUNDLE_MANIFEST_MISSING'),
    'CONNECTED_BUNDLE_MANIFEST_INVALID',
  );
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    (manifest as { schemaVersion?: unknown }).schemaVersion !== 'hms-stagehand-bundle/v1' ||
    (manifest as { sourceFingerprint?: unknown }).sourceFingerprint !==
      binding.bundleSourceFingerprintSha256
  ) {
    fail(
      'CONNECTED_SOURCE_FINGERPRINT_MISMATCH',
      'loaded bundle source fingerprint is not sidecar-bound',
    );
  }
}

/** Reuse the existing runtime fingerprint helper against actual runtime revisions. */
export function assertConnectedRuntimeFingerprint(
  binding: ConnectedProofBindingSidecar,
  runtime: RuntimeFingerprintInput,
): void {
  const actual = computeRuntimeFingerprintSha256({
    ...runtime,
  });
  if (actual !== binding.runtimeFingerprintSha256) {
    fail(
      'CONNECTED_RUNTIME_FINGERPRINT_MISMATCH',
      'loaded runtime fingerprint is not sidecar-bound',
    );
  }
}

/** Bind the actual loaded property and Secrets Manager version metadata. */
export function assertConnectedSecretBinding(input: {
  binding: ConnectedProofBindingSidecar;
  propertyCode: string;
  secretVersion: ConnectedSecretVersion;
}): void {
  if (input.propertyCode !== input.binding.propertyCode) {
    fail('CONNECTED_PROPERTY_MISMATCH', 'loaded secret property is not sidecar-bound');
  }
  const versionId = input.secretVersion.versionId.trim();
  if (!versionId || versionId !== input.binding.secretVersionId) {
    fail('CONNECTED_CREDENTIAL_VERSION_MISMATCH', 'loaded secret version is not sidecar-bound');
  }
  if (!input.secretVersion.versionStages.includes('AWSCURRENT')) {
    fail('CONNECTED_CREDENTIAL_VERSION_STALE', 'loaded secret is not AWSCURRENT');
  }
}

function parseJson(bytes: Buffer, code: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(code, 'private proof binding JSON is invalid');
  }
}

/** Load and structurally validate the private sidecar; proof bytes are checked per session. */
export async function loadConnectedProofBinding(
  sidecarPath: string,
): Promise<ConnectedProofBindingSidecar> {
  const bytes = await readPrivateFile(sidecarPath, 'CONNECTED_SIDECAR_MISSING');
  try {
    return connectedProofBindingSidecarSchema.parse(
      parseJson(bytes, 'CONNECTED_SIDECAR_INVALID'),
    );
  } catch (error) {
    if (error instanceof ConnectedProofBindingError) throw error;
    fail('CONNECTED_SIDECAR_INVALID', 'private proof binding schema is invalid');
  }
}

function rememberVerifiedRoleProofSnapshot(
  binding: ConnectedProofBindingSidecar,
  path: string,
  snapshot: VerifiedRoleProofSnapshot,
): void {
  let snapshots = verifiedRoleProofSnapshots.get(binding);
  if (!snapshots) {
    snapshots = new Map();
    verifiedRoleProofSnapshots.set(binding, snapshots);
  }
  snapshots.set(path, snapshot);
}

function takeVerifiedRoleProofSnapshot(
  binding: ConnectedProofBindingSidecar,
  path: string,
): VerifiedRoleProofSnapshot | undefined {
  const snapshots = verifiedRoleProofSnapshots.get(binding);
  const snapshot = snapshots?.get(path);
  if (snapshots) snapshots.delete(path);
  return snapshot;
}

function failRoleProofValidation(error: unknown): never {
  const message = error instanceof Error ? error.message : 'role proof invalid';
  if (/expired/i.test(message)) {
    fail('CONNECTED_PROOF_EXPIRED', message);
  }
  fail('CONNECTED_PROOF_SCOPE_INVALID', message);
}

function parseAndValidateRoleProofSnapshot(input: {
  entry: ConnectedProofBindingEntry;
  authorization?: ConnectedSessionAuthorization;
  binding: ConnectedProofBindingSidecar;
  bytes: Buffer;
  now: Date;
}): VerifiedRoleProofSnapshot {
  const digestValue = createHash('sha256').update(input.bytes).digest('hex');
  if (
    digestValue !== input.entry.roleProofSha256 ||
    (input.authorization && digestValue !== input.authorization.roleProofSha256)
  ) {
    fail('CONNECTED_PROOF_HASH_MISMATCH', 'role-proof bytes do not match the sidecar digest');
  }

  if (input.entry.schemaVersion === 1) {
    if (
      input.authorization?.toolId === 'hms_read_folio' ||
      input.authorization?.toolId === 'hms_sent_email_audit' ||
      input.binding.folio === input.entry ||
      input.binding.sent === input.entry
    ) {
      fail(
        'CONNECTED_PROOF_SCOPE_INVALID',
        input.authorization?.toolId === 'hms_sent_email_audit' || input.binding.sent === input.entry
          ? 'sent-email requires a v2 role proof'
          : 'folio requires a v2 role proof',
      );
    }
    let proof: HmsReadRoleProofV1;
    try {
      proof = validateRoleProofV1(
        hmsReadRoleProofV1Schema.parse(
          parseJson(input.bytes, 'CONNECTED_PROOF_SCOPE_INVALID'),
        ),
        input.now,
      );
    } catch (error) {
      failRoleProofValidation(error);
    }
    if (proof.propertyCode !== input.binding.propertyCode) {
      fail('CONNECTED_PROOF_SCOPE_INVALID', 'role proof property is not sidecar-bound');
    }
    return {
      bytes: Buffer.from(input.bytes),
      digest: digestValue,
      proof,
    };
  }

  const toolId = input.entry.toolId;
  if (!toolId) fail('CONNECTED_PROOF_SCOPE_INVALID', 'v2 proof tool is missing');
  let proof: HmsReadRoleProofV2;
  try {
    proof = hmsReadRoleProofV2Schema.parse(
      parseJson(input.bytes, 'CONNECTED_PROOF_SCOPE_INVALID'),
    );
    validateRoleProofV2ForTool(proof, READ_TOOLS[toolId], input.now);
  } catch (error) {
    failRoleProofValidation(error);
  }
  const actorMatches = proof.actorHmacSha256 === input.entry.expectedActorHmacSha256;
  const evidenceMatches =
    proof.evidenceArtifactId === input.entry.expectedEvidenceArtifactId &&
    proof.evidenceSha256 === input.entry.expectedEvidenceSha256;
  if (!actorMatches) {
    fail('CONNECTED_PROOF_ACTOR_MISMATCH', 'role-proof actor evidence is not sidecar-bound');
  }
  if (!evidenceMatches) {
    fail('CONNECTED_PROOF_EVIDENCE_MISMATCH', 'role-proof evidence scope is not sidecar-bound');
  }
  if (
    proof.propertyCode !== input.binding.propertyCode ||
    proof.toolId !== toolId ||
    (input.authorization && proof.toolId !== input.authorization.toolId) ||
    (input.authorization &&
      proof.discoveryOperationId !== input.authorization.discoveryOperationId) ||
    proof.observerSourceRevision !== input.binding.sourceRevision ||
    proof.privateDigestKeyVersion !== input.binding.privateDigestKeyVersion ||
    proof.credentialVersionHmacSha256 !== input.binding.credentialVersionHmacSha256 ||
    proof.runtimeFingerprintSha256 !== input.binding.runtimeFingerprintSha256
  ) {
    fail('CONNECTED_PROOF_SCOPE_INVALID', 'role-proof scope is not sidecar-bound');
  }
  return {
    bytes: Buffer.from(input.bytes),
    digest: digestValue,
    proof,
  };
}

type ConnectedRoleProofLoaderResult = {
  schemaVersion: 1;
  propertyCode: 'HRCEN';
  allowedSurfaces: readonly string[];
  deniedActions: readonly string[];
  issuedAt: string;
  expiresAt: string;
  evidenceRef: string;
  evidenceSha256: string;
};

function adaptRoleProofForRuntime(proof: ConnectedRoleProof): ConnectedRoleProofLoaderResult {
  if (proof.schemaVersion === 1) return proof;
  return {
    schemaVersion: 1,
    propertyCode: 'HRCEN',
    allowedSurfaces: ['Guest Stay'],
    deniedActions: [
      'new_record',
      'save',
      'delete',
      'duplicate',
      'check_in',
      'check_out',
      'document_generate',
      'document_send',
    ],
    issuedAt: proof.issuedAt,
    expiresAt: proof.expiresAt,
    evidenceRef: `role-proof-v2:${proof.toolId}:${proof.evidenceArtifactId}`,
    evidenceSha256: proof.evidenceSha256,
  };
}

/** Adapt the selected sidecar proof to the runtime's legacy v1 loader shape. */
export async function loadConnectedRoleProof(
  binding: ConnectedProofBindingSidecar,
  path: string,
  now: Date = new Date(),
): Promise<ConnectedRoleProofLoaderResult> {
  const entry = [binding.find, binding.folio, binding.notes, binding.sent].find(
    (candidate) => candidate?.roleProofPath === path,
  );
  if (!entry) fail('CONNECTED_PROOF_PATH_MISMATCH', 'runtime role-proof path is not sidecar-bound');

  const cached = takeVerifiedRoleProofSnapshot(binding, path);
  const snapshot =
    cached?.digest === entry.roleProofSha256
      ? cached
      : parseAndValidateRoleProofSnapshot({
          entry,
          binding,
          bytes: await readPrivateFile(path, 'CONNECTED_PROOF_MISSING'),
          now,
        });
  return adaptRoleProofForRuntime(snapshot.proof);
}

function entryForAuthorization(
  binding: ConnectedProofBindingSidecar,
  authorization: ConnectedSessionAuthorization,
): ConnectedProofBindingEntry {
  switch (authorization.toolId) {
    case 'hms_read_folio':
      return binding.folio ?? fail('CONNECTED_PROOF_SCOPE_INVALID', 'folio proof binding is missing');
    case 'hms_read_notes_traces':
      return binding.notes ?? binding.find;
    case 'hms_sent_email_audit':
      return binding.sent ?? fail('CONNECTED_PROOF_SCOPE_INVALID', 'sent-email proof binding is missing');
    case 'hms_find_reservation':
      return binding.find;
    default:
      return fail('CONNECTED_PROOF_SCOPE_INVALID', 'connected proof binding has no entry for this tool');
  }
}

function assertSessionMetadata(
  binding: ConnectedProofBindingSidecar,
  entry: ConnectedProofBindingEntry,
  authorization: ConnectedSessionAuthorization,
): void {
  if (authorization.roleProofPath !== entry.roleProofPath) {
    fail('CONNECTED_PROOF_PATH_MISMATCH', 'session role-proof path is not sidecar-bound');
  }
  if (authorization.roleProofSha256 !== entry.roleProofSha256) {
    fail('CONNECTED_PROOF_HASH_MISMATCH', 'session role-proof digest is not sidecar-bound');
  }
  if (
    authorization.credentialVersionHmacSha256 !== binding.credentialVersionHmacSha256 ||
    authorization.runtimeFingerprintSha256 !== binding.runtimeFingerprintSha256 ||
    authorization.privateDigestKeyVersion !== binding.privateDigestKeyVersion ||
    authorization.sourceRevision !== binding.sourceRevision
  ) {
    fail('CONNECTED_PROOF_BINDING_MISMATCH', 'session proof metadata is not sidecar-bound');
  }
  if (entry.toolId && entry.toolId !== authorization.toolId) {
    fail('CONNECTED_PROOF_SCOPE_INVALID', 'session tool is not bound to the role proof');
  }
  if (entry.release) {
    if (authorization.toolId === 'hms_read_notes_traces') {
      fail('CONNECTED_RELEASE_BINDING_INVALID', 'legacy notes cannot carry a Phase-B release');
    }
    try {
      createReadToolHandler(entry.release, authorization);
    } catch {
      fail('CONNECTED_RELEASE_BINDING_INVALID', 'optional release does not bind to the session');
    }
  }
}

async function assertProofBytes(
  entry: ConnectedProofBindingEntry,
  authorization: ConnectedSessionAuthorization,
  binding: ConnectedProofBindingSidecar,
  now: Date,
): Promise<void> {
  const bytes = await readPrivateFile(entry.roleProofPath, 'CONNECTED_PROOF_MISSING');
  const snapshot = parseAndValidateRoleProofSnapshot({
    entry,
    authorization,
    binding,
    bytes,
    now,
  });
  rememberVerifiedRoleProofSnapshot(binding, entry.roleProofPath, snapshot);
}

/** Validate one session authorization immediately before context creation. */
export async function validateConnectedSessionAuthorization(input: {
  binding: ConnectedProofBindingSidecar;
  authorization: ConnectedSessionAuthorization;
  now?: Date;
  runtimeFingerprint?: RuntimeFingerprintInput;
  secretVersion?: ConnectedSecretVersion;
  propertyCode?: string;
  bundleManifestPath?: string;
}): Promise<void> {
  const now = input.now ?? new Date();
  const expiresAt = Date.parse(input.authorization.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    fail('CONNECTED_PROOF_EXPIRED', 'session authorization is expired');
  }
  if (input.runtimeFingerprint) {
    assertConnectedRuntimeFingerprint(input.binding, input.runtimeFingerprint);
  }
  if (input.secretVersion && input.propertyCode) {
    assertConnectedSecretBinding({
      binding: input.binding,
      propertyCode: input.propertyCode,
      secretVersion: input.secretVersion,
    });
  }
  if (input.bundleManifestPath) {
    await assertConnectedBundleSourceFingerprint(
      input.binding,
      input.bundleManifestPath,
    );
  }
  const entry = entryForAuthorization(input.binding, input.authorization);
  assertSessionMetadata(input.binding, entry, input.authorization);
  await assertProofBytes(entry, input.authorization, input.binding, now);
}
