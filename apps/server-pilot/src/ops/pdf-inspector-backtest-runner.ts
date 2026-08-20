import { createHash, randomUUID } from 'node:crypto';
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
} from 'node:fs/promises';
import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import {
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import {
  ARTIFACT_MAX_INPUT_BYTES,
  assertPdfToolchain,
  extractEmbeddedPdfText,
  type SandboxRunner,
} from '../mail/artifacts/read-artifact.js';
import {
  inspectPdf,
  type PdfInspectorChildExecutor,
  type PdfInspectorCommandPaths,
} from '../mail/artifacts/pdf-inspector.js';
import {
  aggregatePdfInspectorBacktest,
  comparePdfParserOutcomes,
  parsePdfInspectorProvenance,
  renderPdfInspectorAggregateReport,
  validatePdfPrivateComparison,
  withPdfAdjudication,
  PDF_BACKTEST_ADJUDICATION_LABELS,
  PDF_BACKTEST_RATIONALE_CODES,
  type PdfInspectorBacktestReport,
  type PdfInspectorDiagnosticsInput,
  type PdfInspectorPromotionProvenance,
  type PdfBacktestAdjudicationLabel,
  type PdfBacktestRationaleCode,
  type PdfParserReason,
  type PdfParserStatus,
  type PdfPrivateComparison,
} from './pdf-inspector-backtest.js';
import {
  buildThreadContext,
  extractLookupCandidates,
  filterExactReservationCandidates,
  type ThreadContextMessage,
} from '../ai/thread-context.js';

export const PDF_INSPECTOR_BACKTEST_MAX_INPUT_BYTES =
  ARTIFACT_MAX_INPUT_BYTES;
export const PDF_BACKTEST_DEFAULT_ROOT =
  '/opt/nava/shared/pdf-inspector-backtest';
export const PDF_BACKTEST_EXIT_CODES = {
  success: 0,
  invalidInvocation: 2,
  dependencyBlocked: 20,
  identityDrift: 30,
  incompleteTerminalAccounting: 40,
} as const;

const PDF_BACKTEST_TERMINAL_SCHEMA = 'pdf_inspector_backtest_terminal_v1';
export const PDF_BACKTEST_ADJUDICATION_SCHEMA =
  'pdf_inspector_backtest_adjudication_v1';
const PDF_BACKTEST_METADATA_SCHEMA = 'pdf_inspector_backtest_metadata_v1';
const PDF_BACKTEST_ADJUDICATION_FILE = 'adjudications.jsonl';
const PDF_BACKTEST_MAX_FIXTURE_FILE_BYTES = 128 * 1024 * 1024;
const PDF_BACKTEST_MAX_CANDIDATE_DESCRIPTOR_BYTES = 64 * 1024;
const PDF_BACKTEST_MAX_PARSER_OUTPUT_BYTES = 256 * 1024;
const PDF_BACKTEST_MAX_PAGES = 50;
const PDF_BACKTEST_MAX_DECLARED_SIZE_BYTES = 2_147_483_647;
const PDF_BACKTEST_LIVE_STATEMENT_TIMEOUT_MS = 30_000;
const PDF_BACKTEST_RUNNING_GRACE_MS = 6 * 60 * 60 * 1000;
const execFile = promisify(execFileCallback);
const NOFOLLOW_FLAG = fsConstants.O_NOFOLLOW ?? 0;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_PACKAGE_VERSIONS = { pdfInspector: '1.12.0' };
const DEFAULT_TOOL_VERSIONS = {
  poppler: '24.02.0',
  bwrap: '0.8.0',
  prlimit: '2.38.0',
  node: '20.0.0',
};
const DEFAULT_INSPECTOR_PROVENANCE: PdfInspectorPromotionProvenance = {
  backtestOnly: true,
  packageVersion: '1.12.0',
  lopdfVersion: '0.41.0',
  runtimeVerified: false,
  implementationFingerprint: {
    algorithm: 'sha256',
    value: '0'.repeat(64),
  },
};

export type PdfBacktestSourceIdentity = {
  etag?: string;
  versionId?: string;
  lastModified?: string;
  contentLength?: number;
  contentType?: string;
};

export type PdfBacktestManifestRow = {
  attachmentId: string;
  messageId: string;
  threadId: string;
  transportId: string;
  mimeType: string;
  sizeBytes: number;
  isInline: boolean;
  direction: 'inbound' | 'outbound';
  createdAt: string;
  scopeMembership: {
    full_corpus: true;
    current_runtime_subset: boolean;
  };
  sourceKey?: string;
  expectedSourceIdentity?: PdfBacktestSourceIdentity;
  sourceFingerprint?: string;
};

export type PdfBacktestParserResult = {
  status: PdfParserStatus;
  reason: PdfParserReason;
  pageCount: number | null;
  text: string | null;
  markdown: string | null;
  elapsedMs: number;
  diagnostics?: PdfInspectorDiagnosticsInput;
};

export type PdfBacktestFixtureRow = PdfBacktestManifestRow & {
  bytesBase64: string;
  sourceKey?: string;
  objectContentType?: string;
  sourceIdentity?: PdfBacktestSourceIdentity;
  outcomes?: {
    poppler?: PdfBacktestParserResult;
    inspector?: PdfBacktestParserResult;
  };
};

export type PdfBacktestFixture = {
  rows: PdfBacktestFixtureRow[];
  packageVersions?: Record<string, string>;
  toolVersions?: Record<string, string>;
  inspectorProvenance?: PdfInspectorPromotionProvenance;
};

export type PdfBacktestAdjudicationRecord = {
  schema: typeof PDF_BACKTEST_ADJUDICATION_SCHEMA;
  runId: string;
  recordRef: string;
  adjudication: {
    sourceRef: string;
    label: PdfBacktestAdjudicationLabel;
    rationaleCodes: PdfBacktestRationaleCode[];
  };
  adjudicatedAt: string;
};

export type PdfBacktestObject = {
  body: Buffer;
  contentType: string;
  identity?: PdfBacktestSourceIdentity;
};

export interface PdfBacktestObjectReader {
  getObjectBounded(
    key: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<PdfBacktestObject | null>;
}

export type PdfBacktestParser = (input: {
  bytes: Buffer;
  row: PdfBacktestManifestRow;
  sourceRef: string;
  signal: AbortSignal;
}) => Promise<PdfBacktestParserResult>;

export type PdfBacktestParsers = {
  poppler: PdfBacktestParser;
  inspector: PdfBacktestParser;
};

export type PdfBacktestTerminalResult = {
  schema: typeof PDF_BACKTEST_TERMINAL_SCHEMA;
  runId: string;
  recordRef: string;
  attachmentId: string;
  status: 'completed' | 'identity_drift';
  sourceSha256: string;
  sourceIdentity: PdfBacktestSourceIdentity | null;
  comparison?: PdfPrivateComparison;
  failureCode?: string;
  candidateFingerprint?: string;
  candidateDescriptorDigest?: string;
  finishedAt: string;
};

export type PdfBacktestAccounting = {
  manifestCount: number;
  terminalCount: number;
  missingCount: number;
  identityDriftCount: number;
  complete: boolean;
};

export type PdfBacktestRunResult = {
  exitCode: number;
  report: PdfInspectorBacktestReport | null;
  accounting: PdfBacktestAccounting;
  privateErrors: string[];
};

export interface PdfBacktestRunStore {
  hasRun?(runId: string): Promise<boolean>;
  writeManifest(runId: string, rows: readonly PdfBacktestManifestRow[]): Promise<void>;
  readManifest(runId: string): Promise<PdfBacktestManifestRow[]>;
  appendTerminalResult(
    runId: string,
    result: PdfBacktestTerminalResult,
  ): Promise<void>;
  bindCandidateFingerprint?(
    runId: string,
    fingerprint: string,
    descriptorDigest: string,
  ): Promise<void>;
  readTerminalResults(runId: string): Promise<PdfBacktestTerminalResult[]>;
  readPrivate(
    runId: string,
    recordRef: string,
  ): Promise<PdfBacktestTerminalResult | null>;
  appendAdjudication?(
    runId: string,
    record: PdfBacktestAdjudicationRecord,
  ): Promise<void>;
  readAdjudications?(
    runId: string,
  ): Promise<PdfBacktestAdjudicationRecord[]>;
  markComplete(
    runId: string,
    status: 'completed' | 'incomplete' | 'blocked',
  ): Promise<void>;
}

type PdfBacktestCommand =
  | { kind: 'help' }
  | { kind: 'fixture'; fixturePath: string; runId: string }
  | { kind: 'live'; runId: string }
  | {
      kind: 'replay';
      replayRunId: string;
      runId: string;
      candidateDescriptorPath: string;
    }
  | { kind: 'status'; runId: string }
  | { kind: 'show-private'; runId: string; recordRef: string };

export type PdfBacktestLiveSnapshot = {
  transactionReadOnly: boolean;
  isolationLevel: 'repeatable read' | string;
  statementTimeoutMs: number;
  projectedOnly: boolean;
  runtimeSubsetDerived: boolean;
  mailboxGrantVerified: boolean;
  rows: PdfBacktestManifestRow[];
  sourceKeys: ReadonlyMap<string, string>;
  expectedIdentities?: ReadonlyMap<string, PdfBacktestSourceIdentity>;
};

export type PdfBacktestLiveDependencies = {
  openReadOnlySnapshot?: (
    signal?: AbortSignal,
  ) => Promise<PdfBacktestLiveSnapshot>;
  reader?: PdfBacktestObjectReader;
  parsers?: PdfBacktestParsers;
  assertNativeGate?: (signal?: AbortSignal) => Promise<void>;
  packageVersions?: Record<string, string>;
  toolVersions?: Record<string, string>;
};

export type PdfBacktestCandidateDependencies = {
  reader?: PdfBacktestObjectReader;
  parsers?: PdfBacktestParsers;
  assertNativeGate?: (signal?: AbortSignal) => Promise<void>;
  toolVersions?: Record<string, string>;
};

export type PdfBacktestCommandDependencies = {
  root?: string;
  store?: PdfBacktestRunStore;
  loadFixture?: (path: string) => Promise<unknown>;
  live?: PdfBacktestLiveDependencies;
};

export class PdfBacktestDependencyError extends Error {
  readonly code = 'PDF_BACKTEST_DEPENDENCY_BLOCKED';
}

export class PdfBacktestIntegrityError extends Error {
  readonly code = 'PDF_BACKTEST_INTEGRITY_FAILURE';
}

export class PdfBacktestIdentityDriftError extends Error {
  readonly code = 'PDF_BACKTEST_MANIFEST_IDENTITY_DRIFT';
}

export class PdfBacktestIncompleteError extends Error {
  readonly code = 'PDF_BACKTEST_INCOMPLETE_TERMINAL_ACCOUNTING';
}

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const semverSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  );
const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(isAbsolute, 'path must be absolute');
const safeRecordRefSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const sourceIdentitySchema = z
  .object({
    etag: z.string().min(1).max(512).optional(),
    versionId: z.string().min(1).max(512).optional(),
    lastModified: z.string().datetime().optional(),
    contentLength: z.number().int().nonnegative().optional(),
    contentType: z.string().min(1).max(256).optional(),
  })
  .strict();
const candidateDescriptorShape = {
  schema: z.literal('pdf_inspector_candidate_v1'),
  candidateId: sha256Schema,
  source: z
    .object({
      repository: z.literal('firecrawl/pdf-inspector'),
      commit: z.string().regex(/^[a-f0-9]{40}$/u),
      originMainCommit: z.string().regex(/^[a-f0-9]{40}$/u),
      cargoLockSha256: sha256Schema,
      sourceTreeSha256: sha256Schema,
    })
    .strict(),
  package: z
    .object({
      name: z.literal('@firecrawl/pdf-inspector'),
      version: semverSchema,
      tarballSha256: sha256Schema,
      nativeAddonSha256: sha256Schema,
    })
    .strict(),
  runtime: z
    .object({
      target: z.string().trim().min(1).max(256),
      libc: z.enum(['gnu', 'musl']),
      nodeAbi: z.string().regex(/^[1-9]\d*$/u),
    })
    .strict(),
  lopdfVersion: semverSchema,
  stage: z
    .object({
      rootPath: absolutePathSchema,
      sourceRootPath: absolutePathSchema,
      cargoLockPath: absolutePathSchema,
      packageTarballPath: absolutePathSchema,
      nodeModulesPath: absolutePathSchema,
      nodeModulesPnpmPath: absolutePathSchema,
      packageRootPath: absolutePathSchema,
      packageTreeSha256: sha256Schema,
      nativeAddonPath: absolutePathSchema,
      childScriptPath: absolutePathSchema,
      childScriptSha256: sha256Schema,
      pnpmStorePath: absolutePathSchema,
      gateScriptPath: absolutePathSchema,
      gateScriptSha256: sha256Schema,
      networkProbeScriptPath: absolutePathSchema,
      networkProbeScriptSha256: sha256Schema,
      runnerRootPath: absolutePathSchema,
      runnerEntryPath: absolutePathSchema,
      runnerTreeSha256: sha256Schema,
    })
    .strict(),
};

type PdfInspectorCandidateIdentity = Pick<
  z.infer<z.ZodObject<typeof candidateDescriptorShape>>,
  'source' | 'package' | 'runtime' | 'lopdfVersion'
>;

export function createPdfInspectorCandidateId(
  candidate: PdfInspectorCandidateIdentity,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        source: candidate.source,
        package: candidate.package,
        runtime: candidate.runtime,
        lopdfVersion: candidate.lopdfVersion,
      }),
    )
    .digest('hex');
}

export const pdfInspectorCandidateDescriptorSchema = z
  .object(candidateDescriptorShape)
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.candidateId !== createPdfInspectorCandidateId(candidate)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['candidateId'],
        message: 'candidateId does not match candidate identity',
      });
    }
  });

export type PdfInspectorCandidateDescriptor = z.infer<
  typeof pdfInspectorCandidateDescriptorSchema
>;

export type PdfInspectorCandidateRun = {
  descriptor: PdfInspectorCandidateDescriptor;
  descriptorDigest: string;
  implementationFingerprint: string;
};

type PdfInspectorVerifiedCandidateStage = {
  rootPath: string;
  sourceRootPath: string;
  cargoLockPath: string;
  packageTarballPath: string;
  nodeModulesPath: string;
  nodeModulesPnpmPath: string;
  packageRootPath: string;
  nativeAddonPath: string;
  childScriptPath: string;
  pnpmStorePath: string;
  gateScriptPath: string;
  networkProbeScriptPath: string;
  runnerRootPath: string;
  runnerEntryPath: string;
};

type VerifiedPdfInspectorCandidateRun = PdfInspectorCandidateRun & {
  stage: PdfInspectorVerifiedCandidateStage;
};

export function parsePdfInspectorCandidateDescriptor(
  value: unknown,
): PdfInspectorCandidateDescriptor {
  return pdfInspectorCandidateDescriptorSchema.parse(value);
}

function candidateDescriptorDigest(
  descriptor: PdfInspectorCandidateDescriptor,
): string {
  return sha256Hex(JSON.stringify(parsePdfInspectorCandidateDescriptor(descriptor)));
}

function isPathWithin(
  rootPath: string,
  candidatePath: string,
  allowRoot = false,
): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return (
    (allowRoot && relativePath.length === 0) ||
    (relativePath.length > 0 &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function assertNoSymlinkInAbsolutePath(path: string): void {
  const resolvedPath = resolve(path);
  const filesystemRoot = parsePath(resolvedPath).root;
  let currentPath = filesystemRoot;
  for (const segment of relative(filesystemRoot, resolvedPath)
    .split(sep)
    .filter(Boolean)) {
    currentPath = join(currentPath, segment);
    try {
      if (lstatSync(currentPath).isSymbolicLink()) {
        throw new PdfBacktestIntegrityError(
          'PDF_BACKTEST_CANDIDATE_STAGE_SYMLINK_REJECTED',
        );
      }
    } catch (error) {
      if (error instanceof PdfBacktestIntegrityError) throw error;
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_CANDIDATE_STAGE_PATH_MISSING',
      );
    }
  }
}

function assertCandidateStageEntry(
  path: string,
  directory: boolean,
): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_STAGE_PATH_MISSING',
    );
  }
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile())
  ) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_STAGE_PATH_INVALID',
    );
  }
  if (
    platform() === 'linux' &&
    typeof process.getuid === 'function' &&
    (info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 ||
      (info.mode & 0o222) !== 0)
  ) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_STAGE_PRIVATE_READONLY_REQUIRED',
    );
  }
}

type TrustedCandidateBootstrapPaths = {
  gateScriptPath: string;
  childScriptPath: string;
  networkProbeScriptPath: string;
};

function trustedCandidateBootstrapPaths(): TrustedCandidateBootstrapPaths {
  const appRoot = realpathSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  );
  const resolveTrustedFile = (relativePath: string): string => {
    const expectedPath = join(appRoot, relativePath);
    assertNoSymlinkInAbsolutePath(expectedPath);
    const info = lstatSync(expectedPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_CANDIDATE_TRUSTED_BOOTSTRAP_INVALID',
      );
    }
    const canonicalPath = realpathSync(expectedPath);
    if (!isPathWithin(appRoot, canonicalPath)) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_CANDIDATE_TRUSTED_BOOTSTRAP_INVALID',
      );
    }
    return canonicalPath;
  };
  return {
    gateScriptPath: resolveTrustedFile(join('deploy', 'pdf-inspector-gate.sh')),
    childScriptPath: resolveTrustedFile(
      join('scripts', 'pdf-inspector-child.mjs'),
    ),
    networkProbeScriptPath: resolveTrustedFile(
      join('scripts', 'pdf-inspector-network-probe.mjs'),
    ),
  };
}

function assertCandidateStagePath(
  rootPath: string,
  canonicalRootPath: string,
  candidatePath: string,
  directory: boolean,
): string {
  const resolvedPath = resolve(candidatePath);
  if (!isPathWithin(rootPath, resolvedPath)) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_STAGE_ROOT_ESCAPE',
    );
  }
  const segments = relative(rootPath, resolvedPath)
    .split(sep)
    .filter(Boolean);
  let currentPath = rootPath;
  assertCandidateStageEntry(currentPath, true);
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = join(currentPath, segments[index]!);
    assertCandidateStageEntry(
      currentPath,
      index === segments.length - 1 ? directory : true,
    );
  }
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(resolvedPath);
  } catch {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_STAGE_PATH_MISSING',
    );
  }
  if (!isPathWithin(canonicalRootPath, canonicalPath)) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_STAGE_CANONICAL_ESCAPE',
    );
  }
  return canonicalPath;
}

function assertFixedLopdf(
  cargoLock: string,
  expectedVersion: string,
): void {
  const versions = cargoLock
    .split(/^\[\[package\]\]\s*$/mu)
    .slice(1)
    .flatMap((block) => {
      if (!/^\s*name\s*=\s*"lopdf"\s*$/mu.test(block)) return [];
      const version = block.match(/^\s*version\s*=\s*"([^"]+)"\s*$/mu)?.[1];
      return version ? [version] : [];
    });
  const lopdfOrder = compareSemver(expectedVersion, '0.42.0');
  if (
    versions.length !== 1 ||
    versions[0] !== expectedVersion ||
    !Number.isFinite(lopdfOrder) ||
    lopdfOrder < 0
  ) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_LOPDF_LOCK_INVALID',
    );
  }
}

function compareSemver(left: string, right: string): number {
  const parse = (
    value: string,
  ): { core: [number, number, number]; prerelease: string[] | null } | null => {
    const match = value.match(
      /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
    );
    if (!match) return null;
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4]?.split('.') ?? null,
    };
  };
  const parsedLeft = parse(left);
  const parsedRight = parse(right);
  if (!parsedLeft || !parsedRight) return Number.NaN;
  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    if (parsedLeft.core[index] !== parsedRight.core[index]) {
      return parsedLeft.core[index]! > parsedRight.core[index]! ? 1 : -1;
    }
  }
  if (!parsedLeft.prerelease && !parsedRight.prerelease) return 0;
  if (!parsedLeft.prerelease) return 1;
  if (!parsedRight.prerelease) return -1;
  const length = Math.max(
    parsedLeft.prerelease.length,
    parsedRight.prerelease.length,
  );
  for (let index = 0; index < length; index += 1) {
    const leftPart = parsedLeft.prerelease[index];
    const rightPart = parsedRight.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) > Number(rightPart) ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function candidateTreeDigest(
  rootPath: string,
  options: { excludeRootGitDirectory?: boolean } = {},
): string {
  const entries: string[] = [];
  const rootDevice = lstatSync(rootPath).dev;
  const visit = (currentPath: string, relativePath: string): void => {
    const info = lstatSync(currentPath);
    if (info.dev !== rootDevice) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_CANDIDATE_STAGE_CROSS_DEVICE_REJECTED',
      );
    }
    if (info.isSymbolicLink()) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_CANDIDATE_STAGE_SYMLINK_REJECTED',
      );
    }
    if (info.isDirectory()) {
      entries.push(`d:${relativePath}`);
      for (const entry of readdirSync(currentPath).sort()) {
        if (options.excludeRootGitDirectory && relativePath === '.' && entry === '.git') {
          continue;
        }
        visit(join(currentPath, entry), join(relativePath, entry));
      }
      return;
    }
    if (!info.isFile()) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_CANDIDATE_STAGE_PACKAGE_TREE_INVALID',
      );
    }
    entries.push(`f:${relativePath}:${sha256Hex(readFileSync(currentPath))}`);
  };
  visit(rootPath, '.');
  return sha256Hex(entries.join('\n'));
}

export function pdfInspectorCandidateTreeDigest(rootPath: string): string {
  return candidateTreeDigest(rootPath);
}

export function pdfInspectorCandidateSourceTreeDigest(rootPath: string): string {
  return candidateTreeDigest(rootPath, { excludeRootGitDirectory: true });
}

function assertCandidateStageTree(rootPath: string): void {
  const rootDevice = lstatSync(rootPath).dev;
  const visit = (currentPath: string): void => {
    const info = lstatSync(currentPath);
    if (info.dev !== rootDevice) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_CANDIDATE_STAGE_CROSS_DEVICE_REJECTED',
      );
    }
    if (info.isDirectory()) {
      assertCandidateStageEntry(currentPath, true);
      for (const entry of readdirSync(currentPath)) visit(join(currentPath, entry));
      return;
    }
    assertCandidateStageEntry(currentPath, false);
  };
  visit(rootPath);
}

function tarballPackageTreeDigest(packageTarballPath: string): string {
  const tarballDirectory = dirname(packageTarballPath);
  const tarballName = basename(packageTarballPath);
  const listed = spawnSync('tar', ['-tvzf', tarballName], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: tarballDirectory,
  });
  if (listed.status !== 0) {
    throw new PdfBacktestIntegrityError('PDF_BACKTEST_CANDIDATE_TARBALL_INVALID');
  }
  for (const line of String(listed.stdout).split(/\r?\n/u).filter(Boolean)) {
    const type = line[0];
    const path = (line.trim().split(/\s+/u).at(-1) ?? '').replace(/\/+$/u, '');
    if (
      (type !== '-' && type !== 'd') ||
      path.startsWith('/') ||
      path.split('/').some((segment) => segment === '..' || segment.length === 0)
    ) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_CANDIDATE_TARBALL_INVALID',
      );
    }
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'pdf-inspector-tar-'));
  try {
    copyFileSync(packageTarballPath, join(temporaryRoot, 'package.tgz'));
    const extracted = spawnSync(
      'tar',
      [
        '-xzf',
        'package.tgz',
        ...(platform() === 'win32'
          ? []
          : ['--no-same-owner', '--no-same-permissions']),
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: temporaryRoot,
      },
    );
    if (extracted.status !== 0) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_CANDIDATE_TARBALL_INVALID',
      );
    }
    const packageRoot = join(temporaryRoot, 'package');
    const packageInfo = lstatSync(packageRoot);
    if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_CANDIDATE_TARBALL_INVALID',
      );
    }
    return pdfInspectorCandidateTreeDigest(packageRoot);
  } catch (error) {
    if (error instanceof PdfBacktestIntegrityError) throw error;
    throw new PdfBacktestIntegrityError('PDF_BACKTEST_CANDIDATE_TARBALL_INVALID');
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertCleanDetachedSourceCheckout(
  sourceRootPath: string,
  expectedCommit: string,
  expectedOriginMainCommit: string,
): void {
  assertNoSymlinkInAbsolutePath(join(sourceRootPath, '.git'));
  assertCandidateStageEntry(join(sourceRootPath, '.git'), true);
  const execute = (args: string[]) => {
    const gitArgs = [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-C',
      sourceRootPath,
      ...args,
    ];
    const options = {
      encoding: 'utf8' as const,
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    };
    if (platform() === 'linux') {
      return spawnSync(
        '/usr/bin/env',
        [
          '-i',
          'PATH=/usr/bin:/bin',
          'LC_ALL=C',
          'LANG=C',
          'GIT_CONFIG_NOSYSTEM=1',
          'GIT_CONFIG_GLOBAL=/dev/null',
          'GIT_TERMINAL_PROMPT=0',
          '/usr/bin/git',
          ...gitArgs,
        ],
        options,
      );
    }
    return spawnSync('git', gitArgs, {
      ...options,
      env: {
        PATH: process.env.PATH ?? '',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
  };
  const command = (args: string[]): string => {
    const result = execute(args);
    if (result.status !== 0) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_CANDIDATE_SOURCE_CHECKOUT_INVALID',
      );
    }
    return String(result.stdout).trim();
  };
  if (command(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_SOURCE_CHECKOUT_INVALID',
    );
  }
  if (
    !/^https:\/\/github\.com\/firecrawl\/pdf-inspector(?:\.git)?$/u.test(
      command(['remote', 'get-url', 'origin']),
    )
  ) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_SOURCE_REMOTE_MISMATCH',
    );
  }
  if (command(['rev-parse', 'HEAD']) !== expectedCommit) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_SOURCE_HEAD_MISMATCH',
    );
  }
  const originMainResult = execute(['rev-parse', 'refs/remotes/origin/main']);
  const originMain = String(originMainResult.stdout).trim();
  if (
    originMainResult.status !== 0 ||
    originMain !== expectedOriginMainCommit ||
    originMain !== expectedCommit
  ) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_SOURCE_ORIGIN_MAIN_MISMATCH',
    );
  }
  const detached = execute(['symbolic-ref', '--quiet', 'HEAD']);
  if (
    detached.status !== 1 ||
    command([
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignored',
    ]) !== ''
  ) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_SOURCE_NOT_CLEAN_DETACHED',
    );
  }
  command(['fsck', '--no-dangling', '--no-reflogs']);
}

function verifyPdfInspectorCandidateStage(
  descriptor: PdfInspectorCandidateDescriptor,
): VerifiedPdfInspectorCandidateRun {
  const candidate = parsePdfInspectorCandidateDescriptor(descriptor);
  const rootPath = resolve(candidate.stage.rootPath);
  let canonicalRootPath: string;
  try {
    assertNoSymlinkInAbsolutePath(rootPath);
    assertCandidateStageEntry(rootPath, true);
    canonicalRootPath = realpathSync(rootPath);
  } catch (error) {
    if (error instanceof PdfBacktestIntegrityError) throw error;
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_STAGE_ROOT_INVALID',
    );
  }
  if (canonicalRootPath === parsePath(canonicalRootPath).root) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_STAGE_ROOT_INVALID',
    );
  }
  const runnerRootPath = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    candidate.stage.runnerRootPath,
    true,
  );

  const sourceRootPath = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    candidate.stage.sourceRootPath,
    true,
  );
  const cargoLockPath = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    candidate.stage.cargoLockPath,
    false,
  );
  const packageTarballPath = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    candidate.stage.packageTarballPath,
    false,
  );
  const nodeModulesPath = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    candidate.stage.nodeModulesPath,
    true,
  );
  const nodeModulesPnpmPath = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    candidate.stage.nodeModulesPnpmPath,
    true,
  );
  const packageRootPath = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    candidate.stage.packageRootPath,
    true,
  );
  const nativeAddonPath = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    candidate.stage.nativeAddonPath,
    false,
  );
  const childScriptPath = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    candidate.stage.childScriptPath,
    false,
  );
  const pnpmStorePath = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    candidate.stage.pnpmStorePath,
    true,
  );
  const gateScriptPath = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    candidate.stage.gateScriptPath,
    false,
  );
  const networkProbeScriptPath = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    candidate.stage.networkProbeScriptPath,
    false,
  );
  const runnerEntryPath = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    candidate.stage.runnerEntryPath,
    false,
  );
  for (const mountedTree of [
    sourceRootPath,
    nodeModulesPath,
    nodeModulesPnpmPath,
    packageRootPath,
    pnpmStorePath,
    runnerRootPath,
  ]) {
    assertCandidateStageTree(mountedTree);
  }

  const expectedPackageRoot = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    join(nodeModulesPath, '@firecrawl', 'pdf-inspector'),
    true,
  );
  if (
    cargoLockPath !==
      assertCandidateStagePath(
        rootPath,
        canonicalRootPath,
        join(sourceRootPath, 'napi', 'Cargo.lock'),
        false,
      ) ||
    packageRootPath !== expectedPackageRoot ||
    nodeModulesPnpmPath !==
      assertCandidateStagePath(
        rootPath,
        canonicalRootPath,
        join(nodeModulesPath, '.pnpm'),
        true,
      ) ||
    !isPathWithin(nodeModulesPath, nativeAddonPath) ||
    !nativeAddonPath.endsWith('.node')
  ) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_STAGE_PACKAGE_PATH_INVALID',
    );
  }
  const packageJsonPath = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    join(packageRootPath, 'package.json'),
    false,
  );

  let packageJson: { name?: unknown; version?: unknown };
  let cargoLock: Buffer;
  let tarball: Buffer;
  let nativeAddon: Buffer;
  let childScript: Buffer;
  let gateScript: Buffer;
  let networkProbeScript: Buffer;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    cargoLock = readFileSync(cargoLockPath);
    tarball = readFileSync(packageTarballPath);
    nativeAddon = readFileSync(nativeAddonPath);
    childScript = readFileSync(childScriptPath);
    gateScript = readFileSync(gateScriptPath);
    networkProbeScript = readFileSync(networkProbeScriptPath);
  } catch {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_STAGE_ARTIFACT_READ_FAILED',
    );
  }
  assertCleanDetachedSourceCheckout(
    sourceRootPath,
    candidate.source.commit,
    candidate.source.originMainCommit,
  );
  if (
    packageJson.name !== candidate.package.name ||
    packageJson.version !== candidate.package.version
  ) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_STAGE_PACKAGE_METADATA_MISMATCH',
    );
  }
  const artifactHashes = {
    cargoLockSha256: sha256Hex(cargoLock),
    sourceTreeSha256: pdfInspectorCandidateSourceTreeDigest(sourceRootPath),
    tarballSha256: sha256Hex(tarball),
    nativeAddonSha256: sha256Hex(nativeAddon),
    childScriptSha256: sha256Hex(childScript),
    gateScriptSha256: sha256Hex(gateScript),
    networkProbeScriptSha256: sha256Hex(networkProbeScript),
    packageTreeSha256: pdfInspectorCandidateTreeDigest(packageRootPath),
    runnerTreeSha256: pdfInspectorCandidateTreeDigest(runnerRootPath),
  };
  const extractedTarballTreeSha256 = tarballPackageTreeDigest(packageTarballPath);
  if (artifactHashes.sourceTreeSha256 !== candidate.source.sourceTreeSha256) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_SOURCE_TREE_HASH_MISMATCH',
    );
  }
  if (
    artifactHashes.cargoLockSha256 !== candidate.source.cargoLockSha256 ||
    artifactHashes.tarballSha256 !== candidate.package.tarballSha256 ||
    artifactHashes.nativeAddonSha256 !== candidate.package.nativeAddonSha256 ||
    artifactHashes.childScriptSha256 !== candidate.stage.childScriptSha256 ||
    artifactHashes.gateScriptSha256 !== candidate.stage.gateScriptSha256 ||
    artifactHashes.networkProbeScriptSha256 !==
      candidate.stage.networkProbeScriptSha256 ||
    artifactHashes.packageTreeSha256 !== candidate.stage.packageTreeSha256
    || artifactHashes.runnerTreeSha256 !== candidate.stage.runnerTreeSha256
  ) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_STAGE_HASH_MISMATCH',
    );
  }
  if (extractedTarballTreeSha256 !== artifactHashes.packageTreeSha256) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_TARBALL_TREE_MISMATCH',
    );
  }
  assertFixedLopdf(cargoLock.toString('utf8'), candidate.lopdfVersion);
  const expectedNativePackageRoot = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    join(
      nodeModulesPath,
      '@firecrawl',
      `pdf-inspector-linux-${
        candidate.runtime.target.startsWith('x86_64-') ? 'x64' : 'arm64'
      }-${candidate.runtime.libc}`,
    ),
    true,
  );
  const nativePackageJsonPath = assertCandidateStagePath(
    rootPath,
    canonicalRootPath,
    join(expectedNativePackageRoot, 'package.json'),
    false,
  );
  let nativePackage: { name?: unknown; version?: unknown; main?: unknown };
  try {
    nativePackage = JSON.parse(readFileSync(nativePackageJsonPath, 'utf8')) as {
      name?: unknown;
      version?: unknown;
      main?: unknown;
    };
  } catch {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_STAGE_NATIVE_PACKAGE_INVALID',
    );
  }
  const expectedNativeAddonPath =
    typeof nativePackage.main === 'string'
      ? assertCandidateStagePath(
          rootPath,
          canonicalRootPath,
          join(expectedNativePackageRoot, nativePackage.main),
          false,
        )
      : '';
  if (
    nativePackage.version !== candidate.package.version ||
    nativePackage.name !==
      `@firecrawl/pdf-inspector-linux-${
        candidate.runtime.target.startsWith('x86_64-') ? 'x64' : 'arm64'
      }-${candidate.runtime.libc}` ||
    expectedNativeAddonPath !== nativeAddonPath
  ) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_STAGE_NATIVE_LOAD_MISMATCH',
    );
  }
  return {
    descriptor: candidate,
    descriptorDigest: candidateDescriptorDigest(candidate),
    implementationFingerprint: sha256Hex(
      JSON.stringify({
        schema: 'pdf_inspector_candidate_implementation_v1',
        candidateId: candidate.candidateId,
        descriptorDigest: candidateDescriptorDigest(candidate),
        source: {
          repository: candidate.source.repository,
          commit: candidate.source.commit,
          cargoLockSha256: artifactHashes.cargoLockSha256,
          sourceTreeSha256: artifactHashes.sourceTreeSha256,
        },
        package: {
          name: candidate.package.name,
          version: candidate.package.version,
          tarballSha256: artifactHashes.tarballSha256,
          nativeAddonSha256: artifactHashes.nativeAddonSha256,
        },
        runtime: candidate.runtime,
        lopdfVersion: candidate.lopdfVersion,
        childScriptSha256: artifactHashes.childScriptSha256,
        gateScriptSha256: artifactHashes.gateScriptSha256,
        networkProbeScriptSha256: artifactHashes.networkProbeScriptSha256,
        packageTreeSha256: artifactHashes.packageTreeSha256,
      }),
    ),
    stage: {
      rootPath: canonicalRootPath,
      sourceRootPath,
      cargoLockPath,
      packageTarballPath,
      nodeModulesPath,
      nodeModulesPnpmPath,
      packageRootPath,
      nativeAddonPath,
      childScriptPath,
      pnpmStorePath,
      gateScriptPath,
      networkProbeScriptPath,
      runnerRootPath,
      runnerEntryPath,
    },
  };
}

function parseCandidateRun(
  candidate: PdfInspectorCandidateRun,
): VerifiedPdfInspectorCandidateRun {
  const descriptorDigest = sha256Schema.safeParse(candidate.descriptorDigest);
  if (!descriptorDigest.success) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_DESCRIPTOR_DIGEST_INVALID',
    );
  }
  const implementationFingerprint = sha256Schema.safeParse(
    candidate.implementationFingerprint,
  );
  if (!implementationFingerprint.success) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_FINGERPRINT_INVALID',
    );
  }
  const verified = verifyPdfInspectorCandidateStage(candidate.descriptor);
  if (verified.descriptorDigest !== descriptorDigest.data) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_DESCRIPTOR_DIGEST_MISMATCH',
    );
  }
  if (verified.implementationFingerprint !== implementationFingerprint.data) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_IMPLEMENTATION_FINGERPRINT_MISMATCH',
    );
  }
  return verified;
}

export function createPdfInspectorCandidateProvenance(
  descriptor: PdfInspectorCandidateDescriptor,
  implementationFingerprint: string,
): PdfInspectorPromotionProvenance {
  const candidate = parsePdfInspectorCandidateDescriptor(descriptor);
  const fingerprint = sha256Schema.safeParse(implementationFingerprint);
  if (!fingerprint.success) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_FINGERPRINT_INVALID',
    );
  }
  return {
    backtestOnly: true,
    packageVersion: candidate.package.version,
    lopdfVersion: candidate.lopdfVersion,
    runtimeVerified: false,
    implementationFingerprint: {
      algorithm: 'sha256',
      value: fingerprint.data,
    },
  };
}

function createRuntimeVerifiedCandidateProvenance(
  candidate: VerifiedPdfInspectorCandidateRun,
): PdfInspectorPromotionProvenance {
  return {
    ...createPdfInspectorCandidateProvenance(
      candidate.descriptor,
      candidate.implementationFingerprint,
    ),
    runtimeVerified: true,
  };
}
const adjudicationRecordSchema = z
  .object({
    schema: z.literal(PDF_BACKTEST_ADJUDICATION_SCHEMA),
    runId: uuidSchema,
    recordRef: safeRecordRefSchema,
    adjudication: z
      .object({
        sourceRef: safeRecordRefSchema,
        label: z.enum(PDF_BACKTEST_ADJUDICATION_LABELS),
        rationaleCodes: z
          .array(z.enum(PDF_BACKTEST_RATIONALE_CODES))
          .min(1)
          .max(PDF_BACKTEST_RATIONALE_CODES.length),
      })
      .strict(),
    adjudicatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.recordRef !== record.adjudication.sourceRef ||
      record.runId.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['adjudication', 'sourceRef'],
        message: 'adjudication sourceRef must bind to recordRef',
      });
    }
  });
const scopeMembershipSchema = z
  .object({
    full_corpus: z.literal(true),
    current_runtime_subset: z.boolean(),
  })
  .strict();
const manifestRowShape = {
  attachmentId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
  threadId: z.string().min(1).max(256),
  transportId: z.string().min(1).max(256),
  mimeType: z.string().min(1).max(256),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(PDF_BACKTEST_MAX_DECLARED_SIZE_BYTES),
  isInline: z.boolean(),
  direction: z.enum(['inbound', 'outbound']),
  createdAt: z.string().datetime(),
  scopeMembership: scopeMembershipSchema,
  sourceKey: z.string().min(1).max(2048).optional(),
  expectedSourceIdentity: sourceIdentitySchema.optional(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
};
const manifestRowSchema = z
  .object(manifestRowShape)
  .strict()
  .superRefine((row, context) => {
    if (row.mimeType !== 'application/pdf') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mimeType'],
        message: 'only application/pdf is eligible',
      });
    }
    if (row.isInline) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['isInline'],
        message: 'inline attachments are not eligible',
      });
    }
    if (row.direction !== 'inbound') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['direction'],
        message: 'only inbound attachments are eligible',
      });
    }
  });
const boundedParserTextSchema = z
  .string()
  .refine(
    (value) =>
      Buffer.byteLength(value, 'utf8') <= PDF_BACKTEST_MAX_PARSER_OUTPUT_BYTES,
    'parser text exceeds 256 KiB UTF-8 bound',
  );
const parserResultSchema = z
  .object({
    status: z.enum(['ok', 'manual_required']),
    reason: z.enum([
      'text',
      'no_embedded_text',
      'encrypted',
      'malformed',
      'too_large',
      'too_many_pages',
      'timeout',
      'parser_failure',
      'unsupported',
    ]),
    pageCount: z
      .number()
      .int()
      .positive()
      .max(PDF_BACKTEST_MAX_PAGES)
      .nullable(),
    text: boundedParserTextSchema.nullable(),
    markdown: boundedParserTextSchema.nullable(),
    elapsedMs: z.number().int().nonnegative(),
    diagnostics: z
      .object({
        pdfType: z
          .enum(['TextBased', 'Scanned', 'ImageBased', 'Mixed'])
          .nullable(),
        confidence: z.number().min(0).max(1).nullable(),
        ocrPages: z.array(z.number().int().positive()).optional(),
        tablePages: z.array(z.number().int().positive()).optional(),
        columnPages: z.array(z.number().int().positive()).optional(),
        pagesNeedingOcr: z.array(z.number().int().positive()).optional(),
        pagesWithTables: z.array(z.number().int().positive()).optional(),
        pagesWithColumns: z.array(z.number().int().positive()).optional(),
        hasEncodingIssues: z.boolean().nullable(),
        isComplexLayout: z.boolean().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
function validBase64Syntax(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  let padding = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isAlphaNumeric =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a);
    const isSymbol = code === 0x2b || code === 0x2f;
    const isPadding = code === 0x3d;
    if (isPadding) {
      padding += 1;
      if (index < value.length - 2 || padding > 2) return false;
    } else if (padding > 0 || (!isAlphaNumeric && !isSymbol)) {
      return false;
    }
  }
  return true;
}
const fixtureRowSchema = z
  .object({
    ...manifestRowShape,
    bytesBase64: z
      .string()
      .max(PDF_INSPECTOR_BACKTEST_MAX_INPUT_BYTES * 2),
    sourceKey: z.string().min(1).max(2048).optional(),
    objectContentType: z.string().min(1).max(256).optional(),
    sourceIdentity: sourceIdentitySchema.optional(),
    outcomes: z
      .object({
        poppler: parserResultSchema.optional(),
        inspector: parserResultSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((row, context) => {
    if (!validBase64Syntax(row.bytesBase64)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bytesBase64'],
        message: 'invalid base64',
      });
    }
    if (row.mimeType !== 'application/pdf') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mimeType'],
        message: 'only application/pdf is eligible',
      });
    }
    if (row.isInline) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['isInline'],
        message: 'inline attachments are not eligible',
      });
    }
    if (row.direction !== 'inbound') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['direction'],
        message: 'only inbound attachments are eligible',
      });
    }
  });
const fixtureSchema = z
  .object({
    rows: z.array(fixtureRowSchema).max(100_000),
    packageVersions: z.record(z.string(), z.string()).optional(),
    toolVersions: z.record(z.string(), z.string()).optional(),
    inspectorProvenance: z.unknown().optional(),
  })
  .strict();
const terminalSchema = z
  .object({
    schema: z.literal(PDF_BACKTEST_TERMINAL_SCHEMA),
    runId: uuidSchema,
    recordRef: safeRecordRefSchema,
    attachmentId: z.string().min(1).max(256),
    status: z.enum(['completed', 'identity_drift']),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceIdentity: sourceIdentitySchema.nullable(),
    comparison: z
      .object({
        private: z.record(z.string(), z.unknown()),
        aggregate: z.record(z.string(), z.unknown()),
      })
      .optional(),
    failureCode: z.string().regex(/^[A-Z0-9_:-]+$/u).max(128).optional(),
    candidateFingerprint: sha256Schema.optional(),
    candidateDescriptorDigest: sha256Schema.optional(),
    finishedAt: z.string().datetime(),
  })
  .strict();

function parseRunId(runId: string): string {
  return uuidSchema.parse(runId);
}

function parseRecordRef(recordRef: string): string {
  return safeRecordRefSchema.parse(recordRef);
}

function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  }
}

function cloneBuffer(value: Buffer): Buffer {
  return Buffer.from(value);
}

function sourceRefForAttachment(attachmentId: string): string {
  return `pdf-${sha256Hex(`attachment:${attachmentId}`).slice(0, 32)}`;
}

function validateTerminalResultForRun(
  runId: string,
  value: unknown,
): PdfBacktestTerminalResult {
  const parsed = terminalSchema.parse(value) as PdfBacktestTerminalResult;
  if (parsed.runId !== runId) {
    throw new PdfBacktestIntegrityError('PDF_BACKTEST_TERMINAL_RUN_ID_MISMATCH');
  }
  if (parsed.recordRef !== sourceRefForAttachment(parsed.attachmentId)) {
    throw new PdfBacktestIntegrityError('PDF_BACKTEST_TERMINAL_SOURCE_REF_MISMATCH');
  }
  if (parsed.comparison) {
    const comparison = validatePdfPrivateComparison(parsed.comparison);
    if (comparison.private.sourceRef !== parsed.recordRef) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_COMPARISON_SOURCE_REF_MISMATCH',
      );
    }
    return { ...parsed, comparison };
  }
  return parsed;
}

function validateAdjudicationForRun(
  runId: string,
  value: unknown,
): PdfBacktestAdjudicationRecord {
  const parsed = adjudicationRecordSchema.parse(value) as PdfBacktestAdjudicationRecord;
  if (parsed.runId !== runId) {
    throw new PdfBacktestIntegrityError('PDF_BACKTEST_ADJUDICATION_RUN_ID_MISMATCH');
  }
  return parsed;
}

function identityEqual(
  expected: PdfBacktestSourceIdentity | undefined,
  actual: PdfBacktestSourceIdentity | undefined,
): boolean {
  if (!expected) return true;
  if (!actual) return false;
  for (const key of [
    'etag',
    'versionId',
    'lastModified',
    'contentLength',
    'contentType',
  ] as const) {
    if (expected[key] !== undefined && expected[key] !== actual[key]) {
      return false;
    }
  }
  return true;
}

function normalizeIdentity(
  identity: PdfBacktestSourceIdentity | undefined,
): PdfBacktestSourceIdentity | null {
  if (!identity) return null;
  return sourceIdentitySchema.parse(identity);
}

function hasExpectedSourceIdentity(
  identity: PdfBacktestSourceIdentity | undefined,
): identity is PdfBacktestSourceIdentity {
  return identity !== undefined && Object.keys(identity).length > 0;
}

function isLegacyDeferredSourceFingerprint(
  row: PdfBacktestManifestRow,
): boolean {
  return (
    !hasExpectedSourceIdentity(row.expectedSourceIdentity) &&
    row.sourceFingerprint === sha256Hex('')
  );
}

function validateBase64Bytes(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new Error('PDF_BACKTEST_INVALID_BASE64');
  }
  return bytes;
}

function metadataOf(row: PdfBacktestFixtureRow): PdfBacktestManifestRow {
  const bytes = validateBase64Bytes(row.bytesBase64);
  return {
    attachmentId: row.attachmentId,
    messageId: row.messageId,
    threadId: row.threadId,
    transportId: row.transportId,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    isInline: row.isInline,
    direction: row.direction,
    createdAt: row.createdAt,
    scopeMembership: row.scopeMembership,
    ...(row.sourceKey ? { sourceKey: row.sourceKey } : {}),
    ...(row.expectedSourceIdentity ?? row.sourceIdentity
      ? {
          expectedSourceIdentity:
            normalizeIdentity(row.expectedSourceIdentity ?? row.sourceIdentity) ??
            undefined,
        }
      : {}),
    ...(row.sourceFingerprint
      ? { sourceFingerprint: row.sourceFingerprint }
      : bytes.byteLength > 0
        ? { sourceFingerprint: createHash('sha256').update(bytes).digest('hex') }
        : {}),
  };
}

function rowSort(
  left: PdfBacktestManifestRow,
  right: PdfBacktestManifestRow,
): number {
  const created = left.createdAt.localeCompare(right.createdAt);
  if (created !== 0) return created;
  return left.attachmentId.localeCompare(right.attachmentId);
}

export function validatePdfBacktestManifestRows(
  rows: readonly PdfBacktestManifestRow[],
): PdfBacktestManifestRow[] {
  const unique = new Map<string, PdfBacktestManifestRow>();
  for (const row of rows) {
    const parsed = manifestRowSchema.parse(row);
    const prior = unique.get(parsed.attachmentId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(parsed)) {
      throw new PdfBacktestIdentityDriftError(
        'PDF_BACKTEST_CONFLICTING_DUPLICATE_ATTACHMENT',
      );
    }
    if (!prior) {
      unique.set(parsed.attachmentId, parsed);
    }
  }
  return [...unique.values()].sort(rowSort);
}

export function parsePdfInspectorBacktestFixture(
  value: unknown,
): PdfBacktestFixture {
  const parsed = fixtureSchema.parse(value);
  for (const row of parsed.rows) {
    validateBase64Bytes(row.bytesBase64);
  }
  const rows = parsed.rows.map((row) => ({
    ...row,
    ...(row.outcomes
      ? {
          outcomes: {
            ...(row.outcomes.poppler
              ? { poppler: parserResultSchema.parse(row.outcomes.poppler) }
              : {}),
            ...(row.outcomes.inspector
              ? { inspector: parserResultSchema.parse(row.outcomes.inspector) }
              : {}),
          },
        }
      : {}),
  }));
  return {
    rows,
    ...(parsed.packageVersions
      ? { packageVersions: parsed.packageVersions }
      : {}),
    ...(parsed.toolVersions ? { toolVersions: parsed.toolVersions } : {}),
    ...(parsed.inspectorProvenance !== undefined
      ? {
          inspectorProvenance: parsePdfInspectorProvenance(
            parsed.inspectorProvenance,
          ),
        }
      : {}),
  };
}

export function createFixtureObjectReader(
  value: PdfBacktestFixture | unknown,
): PdfBacktestObjectReader {
  const fixture = parsePdfInspectorBacktestFixture(value);
  const byKey = new Map<
    string,
    { body: Buffer; contentType: string; identity?: PdfBacktestSourceIdentity }
  >();
  for (const row of fixture.rows) {
    const body = validateBase64Bytes(row.bytesBase64);
    byKey.set(row.sourceKey ?? row.attachmentId, {
      body,
      contentType: row.objectContentType ?? row.mimeType,
      ...(row.sourceIdentity ? { identity: row.sourceIdentity } : {}),
    });
  }
  return {
    async getObjectBounded(key, maxBytes, signal) {
      abortIfNeeded(signal);
      const object = byKey.get(key);
      if (!object) return null;
      if (object.body.byteLength > maxBytes) {
        throw new PdfBacktestObjectTooLargeError(
          maxBytes,
          object.body.byteLength,
        );
      }
      return {
        body: cloneBuffer(object.body),
        contentType: object.contentType,
        ...(object.identity ? { identity: object.identity } : {}),
      };
    },
  };
}

export class PdfBacktestObjectTooLargeError extends Error {
  readonly maxBytes: number;
  readonly observedBytes: number;

  constructor(maxBytes: number, observedBytes: number) {
    super('PDF_BACKTEST_OBJECT_TOO_LARGE');
    this.name = 'PdfBacktestObjectTooLargeError';
    this.maxBytes = maxBytes;
    this.observedBytes = observedBytes;
  }
}

function emptyInspectorDiagnostics(): PdfInspectorDiagnosticsInput {
  return {
    pdfType: null,
    confidence: null,
    ocrPages: [],
    tablePages: [],
    columnPages: [],
    hasEncodingIssues: null,
    isComplexLayout: null,
  };
}

function normalizeParserResult(
  parser: 'poppler' | 'inspector',
  value: PdfBacktestParserResult,
): PdfBacktestParserResult {
  const parsed = parserResultSchema.parse(value);
  if (parser === 'inspector') {
    return {
      ...parsed,
      diagnostics: parsed.diagnostics ?? emptyInspectorDiagnostics(),
    };
  }
  return parsed;
}

function failureParserResult(
  reason: PdfParserReason,
): PdfBacktestParserResult {
  return {
    status: 'manual_required',
    reason,
    pageCount: null,
    text: null,
    markdown: null,
    elapsedMs: 0,
  };
}

function failureComparison(
  row: PdfBacktestManifestRow,
  sourceRef: string,
  reason: PdfParserReason,
): PdfPrivateComparison {
  const poppler = failureParserResult(reason);
  const inspector = failureParserResult(reason);
  return comparePdfParserOutcomes({
    scopeMembership: row.scopeMembership,
    sourceRef,
    poppler: {
      parser: 'poppler',
      ...poppler,
      sourceRef,
    },
    inspector: {
      parser: 'inspector',
      ...inspector,
      diagnostics: emptyInspectorDiagnostics(),
      sourceRef,
    },
  });
}

function artifactParserResult(
  result: Awaited<ReturnType<typeof extractEmbeddedPdfText>>,
  elapsedMs: number,
): PdfBacktestParserResult {
  return {
    status: result.status === 'ok' ? 'ok' : 'manual_required',
    reason: result.data.reason,
    pageCount: result.data.pageCount,
    text: result.data.text,
    markdown: result.data.text,
    elapsedMs,
  };
}

function inspectorParserResult(
  result: Awaited<ReturnType<typeof inspectPdf>>,
  elapsedMs: number,
): PdfBacktestParserResult {
  return {
    status: result.status,
    reason: result.reason,
    pageCount: result.pageCount,
    text: result.markdown,
    markdown: result.markdown,
    elapsedMs,
    diagnostics: {
      pdfType: result.pdfType,
      confidence: result.confidence,
      ocrPages: result.pagesNeedingOcr,
      tablePages: result.pagesWithTables,
      columnPages: result.pagesWithColumns,
      hasEncodingIssues: result.hasEncodingIssues,
      isComplexLayout: result.isComplexLayout,
    },
  };
}

export type PdfBacktestParserFactoryOptions = {
  sandboxRunner?: SandboxRunner;
  runChild?: PdfInspectorChildExecutor;
  commandPaths?: PdfInspectorCommandPaths;
};

export function createDefaultPdfBacktestParsers(
  options: PdfBacktestParserFactoryOptions = {},
): PdfBacktestParsers {
  return {
    async poppler(input) {
      const started = performance.now();
      const result = await extractEmbeddedPdfText(
        {
          body: input.bytes,
          declaredSize: input.row.sizeBytes,
          declaredMime: input.row.mimeType,
          objectMime: 'application/pdf',
        },
        {
          ...(options.sandboxRunner
            ? { runner: options.sandboxRunner }
            : {}),
          attachmentId: input.row.attachmentId,
          signal: input.signal,
        },
      );
      return artifactParserResult(
        result,
        Math.max(0, Math.round(performance.now() - started)),
      );
    },
    async inspector(input) {
      const started = performance.now();
      const result = await inspectPdf(input.bytes, {
        ...(options.runChild ? { runChild: options.runChild } : {}),
        ...(options.commandPaths ? { commandPaths: options.commandPaths } : {}),
        signal: input.signal,
      });
      return inspectorParserResult(
        result,
        Math.max(0, Math.round(performance.now() - started)),
      );
    },
  };
}

export function createCandidatePdfBacktestParsers(
  descriptor: PdfInspectorCandidateDescriptor,
  options: Omit<PdfBacktestParserFactoryOptions, 'commandPaths'> = {},
): PdfBacktestParsers {
  const candidate = verifyPdfInspectorCandidateStage(descriptor);
  const bootstrap = trustedCandidateBootstrapPaths();
  return createDefaultPdfBacktestParsers({
    ...options,
    commandPaths: {
      nodeModulesPath: candidate.stage.nodeModulesPath,
      appPnpmStorePath: candidate.stage.nodeModulesPnpmPath,
      childScriptPath: bootstrap.childScriptPath,
      pnpmStorePath: candidate.stage.pnpmStorePath,
    },
  });
}

function defaultVersions(fixture: PdfBacktestFixture): {
  packageVersions: Record<string, string>;
  toolVersions: Record<string, string>;
} {
  return {
    packageVersions: fixture.packageVersions ?? DEFAULT_PACKAGE_VERSIONS,
    toolVersions: fixture.toolVersions ?? DEFAULT_TOOL_VERSIONS,
  };
}

function defaultProvenance(
  fixture: PdfBacktestFixture,
): PdfInspectorPromotionProvenance {
  return fixture.inspectorProvenance ?? DEFAULT_INSPECTOR_PROVENANCE;
}

function makeRecord(
  runId: string,
  row: PdfBacktestManifestRow,
  sourceRef: string,
  comparison: PdfPrivateComparison,
  sourceSha256: string,
  sourceIdentity: PdfBacktestSourceIdentity | null,
  now: () => Date,
  failureCode?: string,
  candidateFingerprint?: string,
): PdfBacktestTerminalResult {
  return {
    schema: PDF_BACKTEST_TERMINAL_SCHEMA,
    runId,
    recordRef: sourceRef,
    attachmentId: row.attachmentId,
    status: 'completed',
    sourceSha256,
    sourceIdentity,
    comparison,
    ...(failureCode ? { failureCode } : {}),
    ...(candidateFingerprint ? { candidateFingerprint } : {}),
    finishedAt: nowIso(now),
  };
}

function makeIdentityDriftRecord(
  runId: string,
  row: PdfBacktestManifestRow,
  sourceRef: string,
  sourceSha256: string,
  sourceIdentity: PdfBacktestSourceIdentity | null,
  now: () => Date,
  comparison: PdfPrivateComparison,
  candidateFingerprint?: string,
  failureCode = 'PDF_SOURCE_IDENTITY_DRIFT',
): PdfBacktestTerminalResult {
  return {
    schema: PDF_BACKTEST_TERMINAL_SCHEMA,
    runId,
    recordRef: sourceRef,
    attachmentId: row.attachmentId,
    status: 'identity_drift',
    sourceSha256,
    sourceIdentity,
    comparison,
    failureCode,
    ...(candidateFingerprint ? { candidateFingerprint } : {}),
    finishedAt: nowIso(now),
  };
}

function bindCandidateDescriptorToTerminal(
  result: PdfBacktestTerminalResult,
  descriptorDigest: string | undefined,
): PdfBacktestTerminalResult {
  return descriptorDigest
    ? { ...result, candidateDescriptorDigest: descriptorDigest }
    : result;
}

function failureReasonForRead(error: unknown): {
  reason: PdfParserReason;
  code: string;
} {
  if (error instanceof PdfBacktestObjectTooLargeError) {
    return { reason: 'too_large', code: 'PDF_OBJECT_TOO_LARGE' };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    throw error;
  }
  return { reason: 'parser_failure', code: 'PDF_OBJECT_READ_FAILED' };
}

function parserFailureCode(
  parser: 'poppler' | 'inspector',
  error: unknown,
): { code: string; dependencyBlocked: boolean } {
  const message = error instanceof Error ? error.message : '';
  return {
    code: `PDF_${parser.toUpperCase()}_PARSER_FAILED`,
    dependencyBlocked: /sandbox|bwrap|prlimit|toolchain|dependency/iu.test(
      message,
    ),
  };
}

function reportFor(
  rows: readonly PdfBacktestManifestRow[],
  results: readonly PdfBacktestTerminalResult[],
  fixture: PdfBacktestFixture,
  adjudications: readonly PdfBacktestAdjudicationRecord[] = [],
): PdfInspectorBacktestReport {
  const rawComparisons = results.flatMap((result) =>
    result.comparison ? [result.comparison] : [],
  );
  const seenAdjudications = new Set<string>();
  for (const record of adjudications) {
    if (seenAdjudications.has(record.recordRef)) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_DUPLICATE_ADJUDICATION',
      );
    }
    seenAdjudications.add(record.recordRef);
    if (
      !rawComparisons.some(
        (comparison) => comparison.private.sourceRef === record.recordRef,
      )
    ) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_ADJUDICATION_SOURCE_REF_UNKNOWN',
      );
    }
  }
  const adjudicationByRef = new Map(
    adjudications.map((record) => [record.recordRef, record]),
  );
  const comparisons = rawComparisons.map((comparison) => {
    const record = adjudicationByRef.get(comparison.private.sourceRef);
    return record
      ? withPdfAdjudication(comparison, record.adjudication)
      : comparison;
  });
  const eligible = {
    full_corpus: rows.filter((row) => row.scopeMembership.full_corpus).length,
    current_runtime_subset: rows.filter(
      (row) => row.scopeMembership.current_runtime_subset,
    ).length,
  };
  const attempted = {
    full_corpus: comparisons.filter(
      (comparison) => comparison.aggregate.scopeMembership.full_corpus,
    ).length,
    current_runtime_subset: comparisons.filter(
      (comparison) => comparison.aggregate.scopeMembership.current_runtime_subset,
    ).length,
  };
  const versions = defaultVersions(fixture);
  return aggregatePdfInspectorBacktest({
    comparisons,
    scopeDenominators: {
      full_corpus: {
        eligible: eligible.full_corpus,
        attempted: attempted.full_corpus,
      },
      current_runtime_subset: {
        eligible: eligible.current_runtime_subset,
        attempted: attempted.current_runtime_subset,
      },
    },
    packageVersions: versions.packageVersions,
    toolVersions: versions.toolVersions,
    inspectorProvenance: defaultProvenance(fixture),
    gates: {
      adjudicationComplete:
        comparisons.length === adjudications.length &&
        adjudications.length > 0,
      safetyGatePassed: false,
      promotionGatePassed: false,
      explicitPromotionApproved: false,
    },
  });
}

function blockedResult(
  accounting: PdfBacktestAccounting,
  code: string,
): PdfBacktestRunResult {
  return {
    exitCode: PDF_BACKTEST_EXIT_CODES.dependencyBlocked,
    report: null,
    accounting,
    privateErrors: [code],
  };
}

async function preflightDefaultParsers(
  fixture: PdfBacktestFixture,
  parsers: PdfBacktestParsers | undefined,
): Promise<PdfBacktestParsers | null> {
  if (parsers) return parsers;
  const needsDefault = fixture.rows.some(
    (row) => !row.outcomes?.poppler || !row.outcomes?.inspector,
  );
  if (!needsDefault) return null;
  try {
    assertPdfToolchain();
    return createDefaultPdfBacktestParsers();
  } catch {
    return null;
  }
}

async function bindCandidateFingerprint(
  store: PdfBacktestRunStore,
  runId: string,
  fingerprint: string,
  descriptorDigest: string,
): Promise<{ fingerprint: string; descriptorDigest: string }> {
  const parsed = sha256Schema.safeParse(fingerprint);
  const parsedDescriptor = sha256Schema.safeParse(descriptorDigest);
  if (!parsed.success || !parsedDescriptor.success) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_FINGERPRINT_INVALID',
    );
  }
  if (!store.bindCandidateFingerprint) {
    throw new PdfBacktestDependencyError(
      'PDF_BACKTEST_CANDIDATE_FINGERPRINT_STORE_UNAVAILABLE',
    );
  }
  await store.bindCandidateFingerprint(runId, parsed.data, parsedDescriptor.data);
  return { fingerprint: parsed.data, descriptorDigest: parsedDescriptor.data };
}

function assertPriorCandidateFingerprints(
  results: readonly PdfBacktestTerminalResult[],
  fingerprint: string,
  descriptorDigest: string,
): void {
  for (const result of results) {
    if (!result.candidateFingerprint) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_CANDIDATE_FINGERPRINT_MISSING',
      );
    }
    if (result.candidateFingerprint !== fingerprint) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_CANDIDATE_FINGERPRINT_MISMATCH',
      );
    }
    if (result.candidateDescriptorDigest !== descriptorDigest) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_CANDIDATE_DESCRIPTOR_DIGEST_MISMATCH',
      );
    }
  }
}

export async function summarizePdfBacktestStatus(
  runId: string,
  store: PdfBacktestRunStore,
): Promise<PdfBacktestAccounting> {
  parseRunId(runId);
  if (store.hasRun && !(await store.hasRun(runId))) {
    return {
      manifestCount: 0,
      terminalCount: 0,
      missingCount: 1,
      identityDriftCount: 0,
      complete: false,
    };
  }
  const rows = await store.readManifest(runId);
  const results = await store.readTerminalResults(runId);
  const refs = new Set(rows.map((row) => sourceRefForAttachment(row.attachmentId)));
  const terminalRefs = new Set(
    results
      .filter((result) => refs.has(result.recordRef))
      .map((result) => result.recordRef),
  );
  const hasUnknownTerminal = results.some(
    (result) => !refs.has(result.recordRef),
  );
  const identityDriftCount = results.filter(
    (result) =>
      refs.has(result.recordRef) && result.status === 'identity_drift',
  ).length;
  return {
    manifestCount: rows.length,
    terminalCount: terminalRefs.size,
    missingCount: Math.max(0, rows.length - terminalRefs.size),
    identityDriftCount,
    complete: rows.length === terminalRefs.size && !hasUnknownTerminal,
  };
}

export async function runFixtureBacktest(input: {
  runId: string;
  fixture: PdfBacktestFixture | unknown;
  store?: PdfBacktestRunStore;
  reader?: PdfBacktestObjectReader;
  parsers?: PdfBacktestParsers;
  signal?: AbortSignal;
  now?: () => Date;
  skipMissing?: boolean;
  candidateFingerprint?: string;
  candidateDescriptorDigest?: string;
}): Promise<PdfBacktestRunResult> {
  const runId = parseRunId(input.runId);
  const fixture = parsePdfInspectorBacktestFixture(input.fixture);
  const now = input.now ?? (() => new Date());
  const store = input.store ?? createMemoryPdfBacktestStore();
  const rowsById = new Map<string, PdfBacktestFixtureRow>();
  const sortedFixtureRows = [...fixture.rows].sort((left, right) =>
    rowSort(left, right),
  );
  for (const item of sortedFixtureRows) {
    if (!rowsById.has(item.attachmentId)) rowsById.set(item.attachmentId, item);
  }
  const manifestRows = validatePdfBacktestManifestRows(
    sortedFixtureRows.map(metadataOf),
  );
  const candidateIdentity = input.candidateFingerprint
    ? await bindCandidateFingerprint(
        store,
        runId,
        input.candidateFingerprint,
        input.candidateDescriptorDigest ?? '',
      )
    : undefined;
  const candidateFingerprint = candidateIdentity?.fingerprint;
  const candidateDescriptorDigest = candidateIdentity?.descriptorDigest;
  await store.writeManifest(runId, manifestRows);
  const storedRows = await store.readManifest(runId);
  const previousResults = await store.readTerminalResults(runId);
  if (candidateFingerprint) {
    assertPriorCandidateFingerprints(
      previousResults,
      candidateFingerprint,
      candidateDescriptorDigest!,
    );
  }
  const previousByRef = new Map(
    previousResults.map((result) => [result.recordRef, result]),
  );
  const reader =
    input.reader ??
    createFixtureObjectReader(fixture);
  const parserDeps = await preflightDefaultParsers(fixture, input.parsers);
  const initialAccounting = await summarizePdfBacktestStatus(runId, store);
  if (!parserDeps && fixture.rows.some((row) => !row.outcomes?.poppler || !row.outcomes?.inspector)) {
    await store.markComplete(runId, 'blocked');
    return blockedResult(
      initialAccounting,
      'PDF_PARSER_DEPENDENCY_BLOCKED',
    );
  }

  let dependencyBlockedDuringRun = false;
  for (const rowValue of storedRows) {
    abortIfNeeded(input.signal);
    const sourceRef = sourceRefForAttachment(rowValue.attachmentId);
    if (previousByRef.has(sourceRef)) continue;
    if (input.skipMissing) continue;
    const item = rowsById.get(rowValue.attachmentId);
    if (!item) continue;
    const sourceKey = rowValue.sourceKey ?? item.sourceKey ?? item.attachmentId;
    let object: PdfBacktestObject | null;
    try {
      object = await reader.getObjectBounded(
        sourceKey,
        Math.min(rowValue.sizeBytes, PDF_INSPECTOR_BACKTEST_MAX_INPUT_BYTES),
        input.signal,
      );
    } catch (error) {
      const failure = failureReasonForRead(error);
      const comparison = failureComparison(rowValue, sourceRef, failure.reason);
      const result = makeRecord(
        runId,
        rowValue,
        sourceRef,
        comparison,
        sha256Hex(''),
        null,
        now,
        failure.code,
        candidateFingerprint,
      );
      await store.appendTerminalResult(
        runId,
        bindCandidateDescriptorToTerminal(result, candidateDescriptorDigest),
      );
      previousByRef.set(sourceRef, result);
      continue;
    }

    if (!object) {
      const comparison = failureComparison(
        rowValue,
        sourceRef,
        'parser_failure',
      );
      const result = makeRecord(
        runId,
        rowValue,
        sourceRef,
        comparison,
        sha256Hex(''),
        null,
        now,
        'PDF_OBJECT_MISSING',
        candidateFingerprint,
      );
      await store.appendTerminalResult(
        runId,
        bindCandidateDescriptorToTerminal(result, candidateDescriptorDigest),
      );
      previousByRef.set(sourceRef, result);
      continue;
    }

    const body = cloneBuffer(object.body);
    const sourceSha256 = sha256Hex(body);
    const sourceIdentity = normalizeIdentity(object.identity);
    if (
      !identityEqual(rowValue.expectedSourceIdentity ?? item.sourceIdentity, object.identity)
    ) {
      const result = makeIdentityDriftRecord(
        runId,
        rowValue,
        sourceRef,
        sourceSha256,
        sourceIdentity,
        now,
        failureComparison(rowValue, sourceRef, 'parser_failure'),
        candidateFingerprint,
      );
      await store.appendTerminalResult(
        runId,
        bindCandidateDescriptorToTerminal(result, candidateDescriptorDigest),
      );
      previousByRef.set(sourceRef, result);
      continue;
    }
    if (
      rowValue.sourceFingerprint !== undefined &&
      sourceSha256 !== rowValue.sourceFingerprint
    ) {
      const result = makeIdentityDriftRecord(
        runId,
        rowValue,
        sourceRef,
        sourceSha256,
        sourceIdentity,
        now,
        failureComparison(rowValue, sourceRef, 'parser_failure'),
        candidateFingerprint,
        'PDF_SOURCE_SHA256_DRIFT',
      );
      await store.appendTerminalResult(
        runId,
        bindCandidateDescriptorToTerminal(result, candidateDescriptorDigest),
      );
      previousByRef.set(sourceRef, result);
      continue;
    }

    let failure: { reason: PdfParserReason; code: string } | null = null;
    if (body.byteLength > PDF_INSPECTOR_BACKTEST_MAX_INPUT_BYTES) {
      failure = { reason: 'too_large', code: 'PDF_SOURCE_TOO_LARGE' };
    } else if (body.byteLength !== rowValue.sizeBytes) {
      failure = { reason: 'malformed', code: 'PDF_SOURCE_SIZE_MISMATCH' };
    } else if (object.contentType !== rowValue.mimeType) {
      failure = { reason: 'unsupported', code: 'PDF_SOURCE_CONTENT_TYPE_MISMATCH' };
    } else if (body.subarray(0, 5).toString('ascii') !== '%PDF-') {
      failure = { reason: 'malformed', code: 'PDF_SOURCE_HEADER_MISMATCH' };
    }

    if (failure) {
      const comparison = failureComparison(rowValue, sourceRef, failure.reason);
      const result = makeRecord(
        runId,
        rowValue,
        sourceRef,
        comparison,
        sourceSha256,
        sourceIdentity,
        now,
        failure.code,
        candidateFingerprint,
      );
      await store.appendTerminalResult(
        runId,
        bindCandidateDescriptorToTerminal(result, candidateDescriptorDigest),
      );
      previousByRef.set(sourceRef, result);
      continue;
    }

    const parserSignal = input.signal ?? new AbortController().signal;
    let parserFailureCodeValue: string | undefined;
    let popplerResult: PdfBacktestParserResult;
    try {
      popplerResult = item.outcomes?.poppler
        ? normalizeParserResult('poppler', item.outcomes.poppler)
        : await parserDeps!.poppler({
            bytes: cloneBuffer(body),
            row: rowValue,
            sourceRef,
            signal: parserSignal,
          });
    } catch (error) {
      abortIfNeeded(parserSignal);
      const failure = parserFailureCode('poppler', error);
      dependencyBlockedDuringRun ||= failure.dependencyBlocked;
      parserFailureCodeValue = failure.code;
      popplerResult = failureParserResult('parser_failure');
    }
    let inspectorResult: PdfBacktestParserResult;
    try {
      inspectorResult = item.outcomes?.inspector
        ? normalizeParserResult('inspector', item.outcomes.inspector)
        : await parserDeps!.inspector({
            bytes: cloneBuffer(body),
            row: rowValue,
            sourceRef,
            signal: parserSignal,
          });
    } catch (error) {
      abortIfNeeded(parserSignal);
      const failure = parserFailureCode('inspector', error);
      dependencyBlockedDuringRun ||= failure.dependencyBlocked;
      parserFailureCodeValue ??= failure.code;
      inspectorResult = failureParserResult('parser_failure');
    }
    const comparison = comparePdfParserOutcomes({
      scopeMembership: rowValue.scopeMembership,
      sourceRef,
      poppler: {
        parser: 'poppler',
        ...normalizeParserResult('poppler', popplerResult),
        sourceRef,
      },
      inspector: {
        parser: 'inspector',
        ...normalizeParserResult('inspector', inspectorResult),
        diagnostics:
          normalizeParserResult('inspector', inspectorResult).diagnostics ??
          emptyInspectorDiagnostics(),
        sourceRef,
      },
    });
    const result = makeRecord(
      runId,
      rowValue,
      sourceRef,
      comparison,
      sourceSha256,
      sourceIdentity,
      now,
      parserFailureCodeValue,
      candidateFingerprint,
    );
    await store.appendTerminalResult(
      runId,
      bindCandidateDescriptorToTerminal(result, candidateDescriptorDigest),
    );
    previousByRef.set(sourceRef, result);
  }

  const accounting = await summarizePdfBacktestStatus(runId, store);
  const results = await store.readTerminalResults(runId);
  const adjudications = store.readAdjudications
    ? await store.readAdjudications(runId)
    : [];
  const report = reportFor(storedRows, results, fixture, adjudications);
  const privateErrors = results
    .map((result) => result.failureCode)
    .filter((value): value is string => value !== undefined);
  if (!accounting.complete) {
    privateErrors.push('INCOMPLETE_TERMINAL_ACCOUNTING');
  }
  const exitCode = dependencyBlockedDuringRun
      ? PDF_BACKTEST_EXIT_CODES.dependencyBlocked
      : accounting.identityDriftCount > 0
      ? PDF_BACKTEST_EXIT_CODES.identityDrift
      : !accounting.complete
        ? PDF_BACKTEST_EXIT_CODES.incompleteTerminalAccounting
        : PDF_BACKTEST_EXIT_CODES.success;
  await store.markComplete(
    runId,
    exitCode === PDF_BACKTEST_EXIT_CODES.success ? 'completed' : 'incomplete',
  );
  return { exitCode, report, accounting, privateErrors };
}

type LiveAttachmentProjection = {
  attachmentId: string;
  messageId: string;
  threadId: string;
  transportId: string;
  mimeType: string;
  sizeBytes: number;
  isInline: boolean;
  direction: 'inbound';
  createdAt: Date;
  sourceKey: string;
};

type LiveMessageProjection = {
  id: string;
  transportId: string;
  threadId: string;
  direction: 'inbound' | 'outbound';
  textBody: string | null;
  htmlBody: string | null;
  subject: string | null;
  receivedAt: Date | null;
  sentAt: Date | null;
};

function requireLiveEnvironment(): {
  databaseUrl: string;
  region: string;
  bucket: string;
} {
  if (platform() !== 'linux') {
    throw new PdfBacktestDependencyError('LIVE_PREREQUISITES_UNAVAILABLE');
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const region = process.env.AWS_REGION?.trim();
  const bucket = process.env.S3_BUCKET?.trim();
  if (!databaseUrl || !region || !bucket) {
    throw new PdfBacktestDependencyError('LIVE_PREREQUISITES_UNAVAILABLE');
  }
  return { databaseUrl, region, bucket };
}

function requireCandidateObjectEnvironment(): {
  region: string;
  bucket: string;
} {
  const region = process.env.AWS_REGION?.trim();
  const bucket = process.env.S3_BUCKET?.trim();
  if (!region || !bucket) {
    throw new PdfBacktestDependencyError(
      'CANDIDATE_REPLAY_OBJECT_READER_UNAVAILABLE',
    );
  }
  return { region, bucket };
}

async function readS3BodyBounded(
  body: unknown,
  maxBytes: number,
): Promise<Buffer> {
  if (!body || typeof body !== 'object' || !(Symbol.asyncIterator in body)) {
    throw new Error('PDF_OBJECT_BODY_UNAVAILABLE');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array | Buffer>) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      if (
        typeof (body as { destroy?: unknown }).destroy === 'function'
      ) {
        (body as unknown as { destroy: () => void }).destroy();
      }
      throw new PdfBacktestObjectTooLargeError(maxBytes, total);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function createS3PdfBacktestObjectReader(input: {
  region: string;
  bucket: string;
}): PdfBacktestObjectReader {
  const { region, bucket } = input;
  const client = new S3Client({ region });
  return {
    async getObjectBounded(key, maxBytes, signal) {
      let response;
      try {
        response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          signal ? { abortSignal: signal } : undefined,
        );
      } catch (error) {
        const name =
          error && typeof error === 'object' && 'name' in error
            ? String((error as { name?: string }).name)
            : '';
        if (name === 'NoSuchKey' || name === 'NotFound') return null;
        throw error;
      }
      if (
        response.ContentLength !== undefined &&
        response.ContentLength > maxBytes
      ) {
        throw new PdfBacktestObjectTooLargeError(
          maxBytes,
          response.ContentLength,
        );
      }
      if (!response.Body) return null;
      const body = await readS3BodyBounded(response.Body, maxBytes);
      return {
        body,
        contentType: response.ContentType ?? 'application/octet-stream',
        identity: {
          ...(response.ETag ? { etag: response.ETag } : {}),
          ...(response.VersionId ? { versionId: response.VersionId } : {}),
          ...(response.LastModified
            ? { lastModified: response.LastModified.toISOString() }
            : {}),
          ...(response.ContentLength !== undefined
            ? { contentLength: response.ContentLength }
            : {}),
          ...(response.ContentType ? { contentType: response.ContentType } : {}),
        },
      };
    },
  };
}

export function createDefaultPdfBacktestObjectReader(): PdfBacktestObjectReader {
  return createS3PdfBacktestObjectReader(requireLiveEnvironment());
}

export function createCandidatePdfBacktestObjectReader(): PdfBacktestObjectReader {
  return createS3PdfBacktestObjectReader(requireCandidateObjectEnvironment());
}

async function assertDefaultNativeGate(signal?: AbortSignal): Promise<void> {
  requireLiveEnvironment();
  abortIfNeeded(signal);
  for (const script of ['pdf-text-gate.sh', 'pdf-inspector-gate.sh']) {
    abortIfNeeded(signal);
    try {
      await execFile(
        '/usr/bin/env',
        [
          '-i',
          'PATH=/usr/bin:/bin',
          'LC_ALL=C',
          'LANG=C',
          'NODE_BIN=/usr/bin/node',
          'BWRAP_BIN=/usr/bin/bwrap',
          'PRLIMIT_BIN=/usr/bin/prlimit',
          '/usr/bin/bash',
          fileURLToPath(new URL(`../../deploy/${script}`, import.meta.url)),
        ],
        {
          timeout: 120_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        },
      );
    } catch {
      throw new PdfBacktestDependencyError('PDF_NATIVE_GATE_FAILED');
    }
  }
}

async function assertCandidateNativeGate(
  candidate: VerifiedPdfInspectorCandidateRun,
  signal?: AbortSignal,
): Promise<void> {
  abortIfNeeded(signal);
  assertCandidateUpstreamMain(candidate);
  abortIfNeeded(signal);
  const bootstrap = trustedCandidateBootstrapPaths();
  const gatePath = bootstrap.gateScriptPath;
  const args = [
    '--candidate',
    '--stage-root',
    candidate.stage.rootPath,
    '--source-root',
    candidate.stage.sourceRootPath,
    '--cargo-lock',
    candidate.stage.cargoLockPath,
    '--package-tarball',
    candidate.stage.packageTarballPath,
    '--node-modules',
    candidate.stage.nodeModulesPath,
    '--node-modules-pnpm',
    candidate.stage.nodeModulesPnpmPath,
    '--package-root',
    candidate.stage.packageRootPath,
    '--native-addon',
    candidate.stage.nativeAddonPath,
    '--child-script',
    bootstrap.childScriptPath,
    '--pnpm-store',
    candidate.stage.pnpmStorePath,
    '--network-probe-script',
    bootstrap.networkProbeScriptPath,
    '--cargo-lock-sha256',
    candidate.descriptor.source.cargoLockSha256,
    '--source-tree-sha256',
    candidate.descriptor.source.sourceTreeSha256,
    '--tarball-sha256',
    candidate.descriptor.package.tarballSha256,
    '--native-addon-sha256',
    candidate.descriptor.package.nativeAddonSha256,
    '--child-script-sha256',
    candidate.descriptor.stage.childScriptSha256,
    '--package-version',
    candidate.descriptor.package.version,
    '--package-tree-sha256',
    candidate.descriptor.stage.packageTreeSha256,
    '--target',
    candidate.descriptor.runtime.target,
    '--libc',
    candidate.descriptor.runtime.libc,
    '--node-abi',
    candidate.descriptor.runtime.nodeAbi,
    '--lopdf-version',
    candidate.descriptor.lopdfVersion,
  ];
  try {
    await execFile(
      '/usr/bin/env',
      [
        '-i',
        'PATH=/usr/bin:/bin',
        'LC_ALL=C',
        'LANG=C',
        'NODE_BIN=/usr/bin/node',
        'BWRAP_BIN=/usr/bin/bwrap',
        'PRLIMIT_BIN=/usr/bin/prlimit',
        '/usr/bin/bash',
        gatePath,
        ...args,
      ],
      {
        timeout: 120_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
    );
  } catch {
    throw new PdfBacktestDependencyError('PDF_CANDIDATE_NATIVE_GATE_FAILED');
  }
}

function assertCandidateUpstreamMain(
  candidate: VerifiedPdfInspectorCandidateRun,
): void {
  const result = spawnSync(
    '/usr/bin/env',
    [
      '-i',
      'PATH=/usr/bin:/bin',
      'LC_ALL=C',
      'LANG=C',
      'GIT_CONFIG_NOSYSTEM=1',
      'GIT_CONFIG_GLOBAL=/dev/null',
      'GIT_TERMINAL_PROMPT=0',
      '/usr/bin/git',
      'ls-remote',
      '--exit-code',
      'https://github.com/firecrawl/pdf-inspector.git',
      'refs/heads/main',
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      maxBuffer: 16 * 1024,
    },
  );
  const expected = candidate.descriptor.source.commit;
  const output = String(result.stdout);
  const matches = output.match(
    /^([a-f0-9]{40})\trefs\/heads\/main\s*$/mu,
  );
  if (
    result.status !== 0 ||
    !matches ||
    matches[1] !== expected ||
    candidate.descriptor.source.originMainCommit !== expected
  ) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_UPSTREAM_MAIN_UNVERIFIED',
    );
  }
}

function commandVersion(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const match = output.match(/\b\d+\.\d+\.\d+\b/u);
  if (!match) {
    throw new PdfBacktestDependencyError('PDF_BACKTEST_TOOL_VERSION_UNAVAILABLE');
  }
  return match[0];
}

function defaultLiveVersions(): {
  packageVersions: Record<string, string>;
  toolVersions: Record<string, string>;
} {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  let packageVersion: unknown;
  try {
    packageVersion = (
      JSON.parse(
        readFileSync(
          join(appDir, 'node_modules/@firecrawl/pdf-inspector/package.json'),
          'utf8',
        ),
      ) as { version?: unknown }
    ).version;
  } catch {
    throw new PdfBacktestDependencyError('PDF_BACKTEST_PACKAGE_VERSION_UNAVAILABLE');
  }
  if (
    typeof packageVersion !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(packageVersion)
  ) {
    throw new PdfBacktestDependencyError('PDF_BACKTEST_PACKAGE_VERSION_UNAVAILABLE');
  }
  return {
    packageVersions: { pdfInspector: packageVersion },
    toolVersions: {
      poppler: commandVersion('/usr/bin/pdfinfo', ['-v']),
      bwrap: commandVersion('/usr/bin/bwrap', ['--version']),
      prlimit: commandVersion('/usr/bin/prlimit', ['--version']),
      node: process.versions.node,
    },
  };
}

function candidateRuntimeVersions(
  candidate: VerifiedPdfInspectorCandidateRun,
): {
  packageVersions: Record<string, string>;
  toolVersions: Record<string, string>;
} {
  return {
    packageVersions: {
      pdfInspector: candidate.descriptor.package.version,
    },
    toolVersions: {
      poppler: commandVersion('/usr/bin/pdfinfo', ['-v']),
      bwrap: commandVersion('/usr/bin/bwrap', ['--version']),
      prlimit: commandVersion('/usr/bin/prlimit', ['--version']),
      node: process.versions.node,
    },
  };
}

async function openDefaultReadOnlySnapshot(
  signal?: AbortSignal,
): Promise<PdfBacktestLiveSnapshot> {
  const { databaseUrl } = requireLiveEnvironment();
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 30,
  });
  try {
    abortIfNeeded(signal);
    await sql`BEGIN READ ONLY`;
    await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await sql`SELECT set_config(
      'statement_timeout',
      ${`${PDF_BACKTEST_LIVE_STATEMENT_TIMEOUT_MS}ms`},
      true
    )`;
    const [proof] = await sql<{
      readOnly: string;
      isolation: string;
    }[]>`
      SELECT
        current_setting('transaction_read_only') AS "readOnly",
        current_setting('transaction_isolation') AS isolation
    `;
    if (
      proof?.readOnly !== 'on' ||
      proof.isolation.toLowerCase() !== 'repeatable read'
    ) {
      throw new PdfBacktestDependencyError('LIVE_READ_ONLY_ASSERT_FAILED');
    }
    const attachmentRows = await sql<LiveAttachmentProjection[]>`
      SELECT
        a.id AS "attachmentId",
        a.message_id AS "messageId",
        m.thread_id AS "threadId",
        m.transport_id AS "transportId",
        a.mime_type AS "mimeType",
        a.size_bytes AS "sizeBytes",
        a.is_inline AS "isInline",
        m.direction AS direction,
        a.created_at AS "createdAt",
        a.s3_key AS "sourceKey"
      FROM attachment a
      JOIN message m ON m.id = a.message_id
      WHERE m.direction = 'inbound'
        AND a.is_inline = false
        AND a.mime_type = 'application/pdf'
        AND a.size_bytes >= 1
      ORDER BY a.created_at ASC, a.id ASC
    `;
    const threadIds = [...new Set(attachmentRows.map((row) => row.threadId))];
    const messages = threadIds.length
      ? await sql<LiveMessageProjection[]>`
          SELECT
            id,
            transport_id AS "transportId",
            thread_id AS "threadId",
            direction,
            text_body AS "textBody",
            html_body AS "htmlBody",
            subject,
            received_at AS "receivedAt",
            sent_at AS "sentAt"
          FROM message
          WHERE thread_id = ANY(${sql.array(threadIds)})
          ORDER BY thread_id ASC, COALESCE(sent_at, received_at, created_at) DESC, id DESC
        `
      : [];
    const messageIds = [...new Set(messages.map((row) => row.id))];
    const attachmentIds = messageIds.length
      ? await sql<{ id: string; messageId: string }[]>`
          SELECT id, message_id AS "messageId"
          FROM attachment
          WHERE message_id = ANY(${sql.array(messageIds)})
        `
      : [];
    const principal =
      process.env.HMS_SHADOW_SERVICE_USER_ID?.trim() || 'user-centurion';
    const transportIds = [...new Set(attachmentRows.map((row) => row.transportId))];
    const grants = transportIds.length
      ? await sql<{ transportId: string }[]>`
          SELECT transport_id AS "transportId"
          FROM mailbox_access
          WHERE user_id = ${principal}
            AND transport_id = ANY(${sql.array(transportIds)})
        `
      : [];
    const granted = new Set(grants.map((row) => row.transportId));
    const idsByMessage = new Map<string, string[]>();
    for (const row of attachmentIds) {
      const ids = idsByMessage.get(row.messageId) ?? [];
      ids.push(row.id);
      idsByMessage.set(row.messageId, ids);
    }
    const messagesByThread = new Map<string, ThreadContextMessage[]>();
    for (const message of messages) {
      const values = messagesByThread.get(message.threadId) ?? [];
      values.push({
        ...message,
        attachmentIds: idsByMessage.get(message.id) ?? [],
      });
      messagesByThread.set(message.threadId, values);
    }
    const subsetAttachmentIds = new Set<string>();
    for (const [threadId, values] of messagesByThread) {
      const newest = [...values].sort((left, right) => {
        const leftTime = (left.sentAt ?? left.receivedAt)?.getTime() ?? 0;
        const rightTime = (right.sentAt ?? right.receivedAt)?.getTime() ?? 0;
        return rightTime - leftTime || right.id.localeCompare(left.id);
      })[0];
      if (!newest || !granted.has(newest.transportId)) continue;
      const context = await buildThreadContext({
        transportId: newest.transportId,
        threadId,
        triggerMessageId: newest.id,
        messages: values,
        latestDraftRevisionId: null,
      });
      const pdfCount = attachmentRows.filter(
        (row) =>
          row.threadId === threadId &&
          context.includedMessageIds.includes(row.messageId),
      ).length;
      const exactCandidates = filterExactReservationCandidates(
        extractLookupCandidates(context.normalizedText),
      );
      if (pdfCount >= 1 && pdfCount <= 3 && exactCandidates.length === 0) {
        for (const row of attachmentRows) {
          if (
            row.threadId === threadId &&
            context.includedMessageIds.includes(row.messageId)
          ) {
            subsetAttachmentIds.add(row.attachmentId);
          }
        }
      }
    }
    const rows: PdfBacktestManifestRow[] = attachmentRows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      scopeMembership: {
        full_corpus: true,
        current_runtime_subset: subsetAttachmentIds.has(row.attachmentId),
      },
      sourceKey: row.sourceKey,
    }));
    return {
      transactionReadOnly: true,
      isolationLevel: 'repeatable read',
      statementTimeoutMs: PDF_BACKTEST_LIVE_STATEMENT_TIMEOUT_MS,
      projectedOnly: true,
      runtimeSubsetDerived: true,
      mailboxGrantVerified: true,
      rows,
      sourceKeys: new Map(rows.map((row) => [row.attachmentId, row.sourceKey!])),
    };
  } finally {
    await sql`ROLLBACK`.catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
}

export function createDefaultPdfBacktestLiveDependencies(): PdfBacktestLiveDependencies {
  requireLiveEnvironment();
  const versions = defaultLiveVersions();
  return {
    openReadOnlySnapshot: openDefaultReadOnlySnapshot,
    reader: createDefaultPdfBacktestObjectReader(),
    parsers: createDefaultPdfBacktestParsers(),
    assertNativeGate: assertDefaultNativeGate,
    ...versions,
  };
}

function createDefaultPdfBacktestCandidateDependencies(
  descriptor: PdfInspectorCandidateDescriptor,
): PdfBacktestCandidateDependencies {
  const candidate = verifyPdfInspectorCandidateStage(descriptor);
  const versions = candidateRuntimeVersions(candidate);
  return {
    reader: createCandidatePdfBacktestObjectReader(),
    parsers: createCandidatePdfBacktestParsers(candidate.descriptor),
    assertNativeGate: (signal) => assertCandidateNativeGate(candidate, signal),
    toolVersions: versions.toolVersions,
  };
}

export async function runLivePdfInspectorBacktest(input: {
  runId: string;
  store?: PdfBacktestRunStore;
  dependencies?: PdfBacktestLiveDependencies;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<PdfBacktestRunResult> {
  const runId = parseRunId(input.runId);
  const deps = input.dependencies;
  const store = input.store ?? createMemoryPdfBacktestStore();
  if (!deps?.openReadOnlySnapshot || !deps.reader) {
    return blockedResult(
      await summarizePdfBacktestStatus(runId, store),
      'LIVE_PREREQUISITES_UNAVAILABLE',
    );
  }
  if (!deps.assertNativeGate) {
    return blockedResult(
      await summarizePdfBacktestStatus(runId, store),
      'LIVE_PREREQUISITES_UNAVAILABLE',
    );
  }
  try {
    await deps.assertNativeGate!(input.signal);
  } catch {
    return blockedResult(
      await summarizePdfBacktestStatus(runId, store),
      'PDF_NATIVE_GATE_FAILED',
    );
  }
  let snapshot: PdfBacktestLiveSnapshot;
  try {
    snapshot = await deps.openReadOnlySnapshot(input.signal);
  } catch {
    return blockedResult(
      await summarizePdfBacktestStatus(
        runId,
        input.store ?? createMemoryPdfBacktestStore(),
      ),
      'LIVE_READ_ONLY_SNAPSHOT_FAILED',
    );
  }
  if (
    snapshot.transactionReadOnly !== true ||
    snapshot.isolationLevel.toLowerCase() !== 'repeatable read' ||
    snapshot.statementTimeoutMs <= 0 ||
    snapshot.projectedOnly !== true ||
    snapshot.runtimeSubsetDerived !== true ||
    snapshot.mailboxGrantVerified !== true
  ) {
    return blockedResult(
      await summarizePdfBacktestStatus(
        runId,
        input.store ?? createMemoryPdfBacktestStore(),
      ),
      'LIVE_READ_ONLY_ASSERT_FAILED',
    );
  }
  const fixture: PdfBacktestFixture = {
    rows: snapshot.rows.map((row) => ({
      ...row,
      bytesBase64: '',
      sourceKey: snapshot.sourceKeys.get(row.attachmentId),
      sourceIdentity:
        snapshot.expectedIdentities?.get(row.attachmentId) ??
        row.expectedSourceIdentity,
    })),
    ...(deps.packageVersions
      ? { packageVersions: deps.packageVersions }
      : {}),
    ...(deps.toolVersions ? { toolVersions: deps.toolVersions } : {}),
  };
  if (fixture.rows.some((row) => !row.sourceKey)) {
    return blockedResult(
      await summarizePdfBacktestStatus(
        runId,
        input.store ?? createMemoryPdfBacktestStore(),
      ),
      'LIVE_SOURCE_KEY_PROJECTION_MISSING',
    );
  }
  return runFixtureBacktest({
    runId,
    fixture,
    store: input.store,
    reader: deps.reader,
    parsers: deps.parsers,
    signal: input.signal,
    now: input.now,
  });
}

export async function runReplayPdfInspectorBacktest(input: {
  runId: string;
  replayRunId: string;
  store?: PdfBacktestRunStore;
  dependencies?: PdfBacktestCandidateDependencies;
  candidate: PdfInspectorCandidateRun;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<PdfBacktestRunResult> {
  const runId = parseRunId(input.runId);
  const replayRunId = parseRunId(input.replayRunId);
  if (runId === replayRunId) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_REPLAY_TARGET_RUN_ID_INVALID',
    );
  }
  const candidate = parseCandidateRun(input.candidate);
  const store = input.store ?? createMemoryPdfBacktestStore();
  const sourceAccounting = await summarizePdfBacktestStatus(replayRunId, store);
  if (!sourceAccounting.complete) {
    throw new PdfBacktestIncompleteError('PDF_BACKTEST_REPLAY_SOURCE_INCOMPLETE');
  }
  if (sourceAccounting.identityDriftCount > 0) {
    throw new PdfBacktestIdentityDriftError(
      'PDF_BACKTEST_REPLAY_SOURCE_IDENTITY_DRIFT',
    );
  }
  const sourceRows = await store.readManifest(replayRunId);
  const sourceResults = await store.readTerminalResults(replayRunId);
  const terminals = new Map<string, PdfBacktestTerminalResult>();
  for (const terminal of sourceResults) {
    if (terminals.has(terminal.recordRef)) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_REPLAY_SOURCE_TERMINAL_DUPLICATE',
      );
    }
    terminals.set(terminal.recordRef, terminal);
  }
  const replayRows: PdfBacktestFixtureRow[] = sourceRows.map((row) => {
    const recordRef = sourceRefForAttachment(row.attachmentId);
    const terminal = terminals.get(recordRef);
    if (!terminal) {
      throw new PdfBacktestIncompleteError(
        'PDF_BACKTEST_REPLAY_SOURCE_TERMINAL_MISSING',
      );
    }
    if (terminal.status !== 'completed') {
      throw new PdfBacktestIncompleteError(
        'PDF_BACKTEST_REPLAY_SOURCE_TERMINAL_NOT_COMPLETED',
      );
    }
    if (!terminal.comparison) {
      throw new PdfBacktestIncompleteError(
        'PDF_BACKTEST_REPLAY_SOURCE_TERMINAL_OUTCOME_MISSING',
      );
    }
    if (!sha256Schema.safeParse(terminal.sourceSha256).success) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_REPLAY_SOURCE_SHA256_INVALID',
      );
    }
    if (
      !terminal.sourceIdentity ||
      Object.keys(terminal.sourceIdentity).length === 0
    ) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_REPLAY_SOURCE_IDENTITY_MISSING',
      );
    }
    const manifestHasSourceIdentity = hasExpectedSourceIdentity(
      row.expectedSourceIdentity,
    );
    if (
      manifestHasSourceIdentity &&
      !identityEqual(row.expectedSourceIdentity, terminal.sourceIdentity)
    ) {
      throw new PdfBacktestIdentityDriftError(
        'PDF_BACKTEST_REPLAY_SOURCE_IDENTITY_DRIFT',
      );
    }
    if (
      !isLegacyDeferredSourceFingerprint(row) &&
      row.sourceFingerprint !== undefined &&
      row.sourceFingerprint !== terminal.sourceSha256
    ) {
      throw new PdfBacktestIdentityDriftError(
        'PDF_BACKTEST_REPLAY_SOURCE_SHA256_DRIFT',
      );
    }
    if (!row.sourceKey) {
      throw new PdfBacktestIntegrityError(
        'PDF_BACKTEST_REPLAY_SOURCE_KEY_MISSING',
      );
    }
    return {
      ...row,
      bytesBase64: '',
      sourceIdentity: terminal.sourceIdentity,
      expectedSourceIdentity: terminal.sourceIdentity,
      sourceFingerprint: terminal.sourceSha256,
    };
  });
  const deps = input.dependencies;
  if (!deps?.reader || !deps.parsers) {
    return blockedResult(
      await summarizePdfBacktestStatus(runId, store),
      'CANDIDATE_REPLAY_PREREQUISITES_UNAVAILABLE',
    );
  }
  if (!deps.assertNativeGate) {
    return blockedResult(
      await summarizePdfBacktestStatus(runId, store),
      'CANDIDATE_NATIVE_GATE_REQUIRED',
    );
  }
  if (!deps.toolVersions) {
    return blockedResult(
      await summarizePdfBacktestStatus(runId, store),
      'CANDIDATE_TOOL_VERSIONS_UNAVAILABLE',
    );
  }
  try {
    await deps.assertNativeGate(input.signal);
  } catch {
    return blockedResult(
      await summarizePdfBacktestStatus(runId, store),
      'PDF_CANDIDATE_NATIVE_GATE_FAILED',
    );
  }
  return runFixtureBacktest({
    runId,
    fixture: {
      rows: replayRows,
      packageVersions: {
        pdfInspector: candidate.descriptor.package.version,
      },
      toolVersions: deps.toolVersions,
      inspectorProvenance: createRuntimeVerifiedCandidateProvenance(candidate),
    },
    store,
    reader: deps.reader,
    parsers: deps.parsers,
    signal: input.signal,
    now: input.now,
    candidateFingerprint: candidate.implementationFingerprint,
    candidateDescriptorDigest: candidate.descriptorDigest,
  });
}

export function parsePdfInspectorBacktestArgs(
  argv: readonly string[],
): PdfBacktestCommand {
  if (argv.length === 0) {
    throw new Error('PDF_BACKTEST_INVALID_INVOCATION');
  }
  let help = false;
  let fixturePath: string | undefined;
  let live = false;
  let runId: string | undefined;
  let replayRunId: string | undefined;
  let candidateDescriptorPath: string | undefined;
  let status: string | undefined;
  let showPrivate: { runId: string; recordRef: string } | undefined;
  const seenOptions = new Set<string>();
  const markOption = (option: string): void => {
    if (seenOptions.has(option)) {
      throw new Error('PDF_BACKTEST_DUPLICATE_ARGUMENT');
    }
    seenOptions.add(option);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      markOption('--help');
      help = true;
      continue;
    }
    if (arg === '--fixture') {
      markOption('--fixture');
      const value = argv[++index];
      if (!value || value.startsWith('--')) {
        throw new Error('PDF_BACKTEST_FIXTURE_PATH_REQUIRED');
      }
      fixturePath = value;
      continue;
    }
    if (arg === '--live') {
      markOption('--live');
      live = true;
      continue;
    }
    if (arg === '--replay-run') {
      markOption('--replay-run');
      const value = argv[++index];
      if (!value || value.startsWith('--')) {
        throw new Error('PDF_BACKTEST_REPLAY_RUN_ID_REQUIRED');
      }
      replayRunId = parseRunId(value);
      continue;
    }
    if (arg === '--candidate-descriptor') {
      markOption('--candidate-descriptor');
      const value = argv[++index];
      if (!value || value.startsWith('--')) {
        throw new Error('PDF_BACKTEST_CANDIDATE_DESCRIPTOR_PATH_REQUIRED');
      }
      candidateDescriptorPath = value;
      continue;
    }
    if (arg === '--run-id') {
      markOption('--run-id');
      const value = argv[++index];
      if (!value || value.startsWith('--')) {
        throw new Error('PDF_BACKTEST_RUN_ID_REQUIRED');
      }
      runId = parseRunId(value);
      continue;
    }
    if (arg === '--status') {
      markOption('--status');
      const value = argv[++index];
      if (!value || value.startsWith('--')) {
        throw new Error('PDF_BACKTEST_STATUS_RUN_ID_REQUIRED');
      }
      status = parseRunId(value);
      continue;
    }
    if (arg === '--show-private') {
      markOption('--show-private');
      const requestedRunId = argv[++index];
      const recordRef = argv[++index];
      if (
        !requestedRunId ||
        !recordRef ||
        requestedRunId.startsWith('--') ||
        recordRef.startsWith('--')
      ) {
        throw new Error('PDF_BACKTEST_SHOW-PRIVATE_ARGS_REQUIRED');
      }
      showPrivate = {
        runId: parseRunId(requestedRunId),
        recordRef: parseRecordRef(recordRef),
      };
      continue;
    }
    throw new Error('PDF_BACKTEST_UNKNOWN_ARGUMENT');
  }

  if (help) {
    if (argv.length !== 1) {
      throw new Error('PDF_BACKTEST_HELP_COMBINATION_INVALID');
    }
    return { kind: 'help' };
  }
  const modeCount =
    Number(Boolean(fixturePath)) +
    Number(live) +
    Number(Boolean(replayRunId)) +
    Number(Boolean(status)) +
    Number(Boolean(showPrivate));
  if (modeCount !== 1) {
    throw new Error('PDF_BACKTEST_MODE_COMBINATION_INVALID');
  }
  if (status && runId) {
    throw new Error('PDF_BACKTEST_STATUS_RUN_ID_COMBINATION_INVALID');
  }
  if (showPrivate && runId) {
    throw new Error('PDF_BACKTEST_SHOW_PRIVATE_RUN_ID_COMBINATION_INVALID');
  }
  if ((fixturePath || live || replayRunId) && status) {
    throw new Error('PDF_BACKTEST_MODE_COMBINATION_INVALID');
  }
  if ((fixturePath || live || replayRunId) && showPrivate) {
    throw new Error('PDF_BACKTEST_MODE_COMBINATION_INVALID');
  }
  if (candidateDescriptorPath && !replayRunId) {
    throw new Error('PDF_BACKTEST_CANDIDATE_REPLAY_REQUIRED');
  }
  if (replayRunId && !candidateDescriptorPath) {
    throw new Error('PDF_BACKTEST_CANDIDATE_DESCRIPTOR_REQUIRED');
  }
  if (replayRunId && runId === replayRunId) {
    throw new Error('PDF_BACKTEST_REPLAY_TARGET_RUN_ID_INVALID');
  }
  if (fixturePath) {
    return {
      kind: 'fixture',
      fixturePath,
      runId: runId ?? randomUUID(),
    };
  }
  if (live) {
    return {
      kind: 'live',
      runId: runId ?? randomUUID(),
    };
  }
  if (replayRunId) {
    return {
      kind: 'replay',
      replayRunId,
      runId: runId ?? randomUUID(),
      candidateDescriptorPath: candidateDescriptorPath!,
    };
  }
  if (status) return { kind: 'status', runId: status };
  if (showPrivate) return { kind: 'show-private', ...showPrivate };
  throw new Error('PDF_BACKTEST_INVALID_INVOCATION');
}

export function pdfInspectorBacktestHelp(): string {
  return [
    'usage: run-pdf-inspector-backtest.ts (--fixture PATH | --live | --status UUID | --show-private UUID RECORD_REF) [--run-id UUID]',
    '       run-pdf-inspector-backtest.ts --replay-run UUID --candidate-descriptor PATH [--run-id UUID]',
    '  --fixture PATH       Run local JSON fixture; parser output stays private.',
    '  --live               Require injected read-only repeatable-read prerequisites.',
    '  --replay-run UUID   Replay private manifest rows against recorded S3 identities.',
    '  --candidate-descriptor PATH  Require isolated staged candidate for paired replay only.',
    '  --run-id UUID        Resume or create named run.',
    '  --status UUID        Emit aggregate accounting only.',
    '  --show-private ...   Emit one explicitly named private result.',
    '  --help               Show this help.',
  ].join('\n');
}

function sanitizeError(error: unknown): string {
  if (error instanceof z.ZodError) return 'PDF_BACKTEST_INVALID_FIXTURE';
  if (
    error instanceof PdfBacktestDependencyError ||
    error instanceof PdfBacktestIntegrityError ||
    error instanceof PdfBacktestIdentityDriftError ||
    error instanceof PdfBacktestIncompleteError
  ) {
    return error.message;
  }
  if (error instanceof Error && /^[A-Z0-9_:-]+$/u.test(error.message)) {
    return error.message;
  }
  return 'PDF_BACKTEST_INVALID_INVOCATION';
}

function publicAccounting(accounting: PdfBacktestAccounting) {
  return {
    manifestCount: accounting.manifestCount,
    terminalCount: accounting.terminalCount,
    missingCount: accounting.missingCount,
    identityDriftCount: accounting.identityDriftCount,
    complete: accounting.complete,
  };
}

function asciiJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (/\P{ASCII}/u.test(text)) {
    throw new Error('PDF_BACKTEST_PUBLIC_OUTPUT_NOT_ASCII');
  }
  return text;
}

async function readFixtureFile(path: string): Promise<unknown> {
  const fixturePath = resolve(path);
  const info = await lstat(fixturePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new PdfBacktestIntegrityError('PDF_BACKTEST_FIXTURE_PATH_INVALID');
  }
  if (info.size > PDF_BACKTEST_MAX_FIXTURE_FILE_BYTES) {
    throw new PdfBacktestIntegrityError('PDF_BACKTEST_FIXTURE_TOO_LARGE');
  }
  return JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
}

function assertPrivateCandidateDescriptorFile(info: {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  size: number;
  uid: number;
  mode: number;
}): void {
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_DESCRIPTOR_PATH_INVALID',
    );
  }
  if (info.size > PDF_BACKTEST_MAX_CANDIDATE_DESCRIPTOR_BYTES) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_DESCRIPTOR_TOO_LARGE',
    );
  }
  if (
    platform() === 'linux' &&
    typeof process.getuid === 'function' &&
    (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
  ) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_DESCRIPTOR_PRIVATE_PATH_REQUIRED',
    );
  }
}

export async function loadPdfInspectorCandidateDescriptor(
  path: string,
): Promise<VerifiedPdfInspectorCandidateRun> {
  let bytes: Buffer;
  try {
    const descriptorPath = resolve(path);
    assertPrivateCandidateDescriptorFile(await lstat(descriptorPath));
    const handle = await open(
      descriptorPath,
      fsConstants.O_RDONLY | NOFOLLOW_FLAG,
    );
    try {
      assertPrivateCandidateDescriptorFile(await handle.stat());
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof PdfBacktestIntegrityError) throw error;
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_DESCRIPTOR_PATH_INVALID',
    );
  }
  if (bytes.byteLength > PDF_BACKTEST_MAX_CANDIDATE_DESCRIPTOR_BYTES) {
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_DESCRIPTOR_TOO_LARGE',
    );
  }
  try {
    return verifyPdfInspectorCandidateStage(
      parsePdfInspectorCandidateDescriptor(
        JSON.parse(bytes.toString('utf8')) as unknown,
      ),
    );
  } catch (error) {
    if (error instanceof PdfBacktestIntegrityError) throw error;
    throw new PdfBacktestIntegrityError(
      'PDF_BACKTEST_CANDIDATE_DESCRIPTOR_INVALID',
    );
  }
}

function storeFor(
  dependencies: PdfBacktestCommandDependencies,
): PdfBacktestRunStore {
  return (
    dependencies.store ??
    createPdfBacktestFileStore(
      dependencies.root ?? process.env.PDF_BACKTEST_ROOT ?? PDF_BACKTEST_DEFAULT_ROOT,
    )
  );
}

export async function executePdfInspectorBacktestCommand(
  argv: readonly string[],
  dependencies: PdfBacktestCommandDependencies = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let command: PdfBacktestCommand;
  try {
    command = parsePdfInspectorBacktestArgs(argv);
  } catch (error) {
    return {
      exitCode: PDF_BACKTEST_EXIT_CODES.invalidInvocation,
      stdout: '',
      stderr: `${sanitizeError(error)}\n`,
    };
  }

  if (command.kind === 'help') {
    return {
      exitCode: PDF_BACKTEST_EXIT_CODES.success,
      stdout: `${pdfInspectorBacktestHelp()}\n`,
      stderr: '',
    };
  }

  try {
    const store = storeFor(dependencies);
    const candidateDescriptorPath =
      command.kind === 'replay' ? command.candidateDescriptorPath : undefined;
    const candidate = candidateDescriptorPath
      ? await loadPdfInspectorCandidateDescriptor(candidateDescriptorPath)
      : undefined;
    const liveDependencies =
      command.kind === 'live'
        ? dependencies.live ?? createDefaultPdfBacktestLiveDependencies()
        : undefined;
    const candidateDependencies =
      command.kind === 'replay' && candidate
        ? createDefaultPdfBacktestCandidateDependencies(candidate.descriptor)
        : undefined;
    if (command.kind === 'status') {
      const accounting = await summarizePdfBacktestStatus(command.runId, store);
      const exitCode = accounting.identityDriftCount
        ? PDF_BACKTEST_EXIT_CODES.identityDrift
        : accounting.complete
          ? PDF_BACKTEST_EXIT_CODES.success
          : PDF_BACKTEST_EXIT_CODES.incompleteTerminalAccounting;
      return {
        exitCode,
        stdout: `${asciiJson({ accounting: publicAccounting(accounting) })}\n`,
        stderr: '',
      };
    }

    if (command.kind === 'show-private') {
      const record = await store.readPrivate(command.runId, command.recordRef);
      if (!record) {
        return {
          exitCode: PDF_BACKTEST_EXIT_CODES.incompleteTerminalAccounting,
          stdout: '',
          stderr: 'PDF_BACKTEST_PRIVATE_RECORD_NOT_FOUND\n',
        };
      }
      return {
        exitCode: PDF_BACKTEST_EXIT_CODES.success,
        stdout: `${JSON.stringify({ private: record })}\n`,
        stderr: '',
      };
    }

    const result =
      command.kind === 'fixture'
        ? await runFixtureBacktest({
            runId: command.runId,
            fixture: await (dependencies.loadFixture
              ? dependencies.loadFixture(command.fixturePath)
              : readFixtureFile(command.fixturePath)),
            store,
          })
        : command.kind === 'live'
          ? await runLivePdfInspectorBacktest({
              runId: command.runId,
              store,
              dependencies: liveDependencies,
            })
          : await runReplayPdfInspectorBacktest({
              runId: command.runId,
              replayRunId: command.replayRunId,
              store,
              dependencies: candidateDependencies,
              candidate: candidate!,
            });
    if (!result.report) {
      return {
        exitCode: result.exitCode,
        stdout: '',
        stderr: `${result.privateErrors[0] ?? 'PDF_BACKTEST_DEPENDENCY_BLOCKED'}\n`,
      };
    }
    return {
      exitCode: result.exitCode,
      stdout: `${asciiJson({
        report: JSON.parse(renderPdfInspectorAggregateReport(result.report)),
        accounting: publicAccounting(result.accounting),
      })}\n`,
      stderr: '',
    };
  } catch (error) {
    const code = sanitizeError(error);
    const exitCode =
      error instanceof PdfBacktestDependencyError
        ? PDF_BACKTEST_EXIT_CODES.dependencyBlocked
        : error instanceof PdfBacktestIdentityDriftError
          ? PDF_BACKTEST_EXIT_CODES.identityDrift
          : error instanceof PdfBacktestIntegrityError ||
              error instanceof PdfBacktestIncompleteError
            ? PDF_BACKTEST_EXIT_CODES.incompleteTerminalAccounting
            : PDF_BACKTEST_EXIT_CODES.invalidInvocation;
    return { exitCode, stdout: '', stderr: `${code}\n` };
  }
}

export async function runPdfInspectorBacktestCli(
  argv: readonly string[],
): Promise<number> {
  const result = await executePdfInspectorBacktestCommand(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void runPdfInspectorBacktestCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

function runDirectory(root: string, runId: string): string {
  parseRunId(runId);
  const rootPath = resolve(root);
  const runPath = resolve(rootPath, runId);
  if (runPath !== join(rootPath, runId)) {
    throw new Error('PDF_BACKTEST_PATH_TRAVERSAL');
  }
  return runPath;
}

function assertNoSymlinkSync(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error('PDF_BACKTEST_SYMLINK_REJECTED');
  }
}

async function assertNoSymlink(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error('PDF_BACKTEST_SYMLINK_REJECTED');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await assertNoSymlink(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertNoSymlink(path);
  await chmod(path, 0o700);
  await assertPrivatePath(path, true);
}

async function assertPrivatePath(path: string, directory = false): Promise<void> {
  await assertNoSymlink(path);
  if (platform() !== 'linux' || typeof process.getuid !== 'function') return;
  const info = await lstat(path);
  if (directory !== info.isDirectory()) {
    throw new PdfBacktestIntegrityError('PDF_BACKTEST_PRIVATE_PATH_TYPE_INVALID');
  }
  if (info.uid !== process.getuid() || (info.mode & 0o022) !== 0) {
    throw new PdfBacktestIntegrityError('PDF_BACKTEST_PRIVATE_PATH_PERMISSIONS');
  }
}

async function readJsonl<T>(
  path: string,
  parse: (value: unknown) => T,
): Promise<T[]> {
  try {
    await assertPrivatePath(path);
    const text = await readFile(path, 'utf8');
    const rows: T[] = [];
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      rows.push(parse(JSON.parse(line) as unknown));
    }
    return rows;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function appendJsonl(path: string, value: unknown): Promise<void> {
  await assertNoSymlink(path);
  const handle = await open(
    path,
    fsConstants.O_WRONLY |
      fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      NOFOLLOW_FLAG,
    0o600,
  );
  try {
    await handle.write(`${JSON.stringify(value)}\n`, undefined, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
  await assertPrivatePath(path);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await assertNoSymlink(path);
  const handle = await open(
    path,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      NOFOLLOW_FLAG,
    0o600,
  );
  try {
    await handle.write(JSON.stringify(value), undefined, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
  await assertPrivatePath(path);
}

export function createPdfBacktestFileStore(
  root: string,
  options: { ttlMs?: number; now?: () => Date } = {},
): PdfBacktestRunStore {
  const rootPath = resolve(root);
  assertNoSymlinkSync(rootPath);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => new Date());

  async function prepareRun(runId: string): Promise<string> {
    const directory = runDirectory(rootPath, runId);
    await ensurePrivateDirectory(rootPath);
    await assertNoSymlink(directory);
    await ensurePrivateDirectory(directory);
    const metadataPath = join(directory, 'metadata.json');
    try {
      await lstat(metadataPath);
      await assertPrivatePath(metadataPath);
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
        expiresAt?: string;
      };
      if (
        !metadata.expiresAt ||
        new Date(metadata.expiresAt).getTime() <= now().getTime()
      ) {
        throw new PdfBacktestIntegrityError('PDF_BACKTEST_RUN_EXPIRED');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writePrivateJson(metadataPath, {
        schema: PDF_BACKTEST_METADATA_SCHEMA,
        createdAt: nowIso(now),
        expiresAt: new Date(now().getTime() + ttlMs).toISOString(),
        status: 'running',
      });
    }
    return directory;
  }

  return {
    async hasRun(runId) {
      const directory = runDirectory(rootPath, runId);
      try {
        const info = await lstat(directory);
        if (info.isSymbolicLink()) {
          throw new Error('PDF_BACKTEST_SYMLINK_REJECTED');
        }
        return info.isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    async bindCandidateFingerprint(runId, fingerprint, descriptorDigest) {
      const parsed = sha256Schema.safeParse(fingerprint);
      const parsedDescriptor = sha256Schema.safeParse(descriptorDigest);
      if (!parsed.success || !parsedDescriptor.success) {
        throw new PdfBacktestIntegrityError(
          'PDF_BACKTEST_CANDIDATE_FINGERPRINT_INVALID',
        );
      }
      const directory = runDirectory(rootPath, runId);
      let existed = false;
      try {
        const info = await lstat(directory);
        if (info.isSymbolicLink()) {
          throw new Error('PDF_BACKTEST_SYMLINK_REJECTED');
        }
        if (!info.isDirectory()) {
          throw new PdfBacktestIntegrityError(
            'PDF_BACKTEST_PRIVATE_PATH_TYPE_INVALID',
          );
        }
        existed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const preparedDirectory = await prepareRun(runId);
      const metadataPath = join(preparedDirectory, 'metadata.json');
      await assertPrivatePath(metadataPath);
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<
        string,
        unknown
      >;
      const prior = metadata.candidateFingerprint;
      const priorDescriptor = metadata.candidateDescriptorDigest;
      if (prior !== undefined && !sha256Schema.safeParse(prior).success) {
        throw new PdfBacktestIntegrityError(
          'PDF_BACKTEST_CANDIDATE_FINGERPRINT_INVALID',
        );
      }
      if (typeof prior === 'string') {
        if (
          prior !== parsed.data ||
          priorDescriptor !== parsedDescriptor.data
        ) {
          throw new PdfBacktestIntegrityError(
            'PDF_BACKTEST_CANDIDATE_FINGERPRINT_MISMATCH',
          );
        }
        return;
      }
      if (existed) {
        throw new PdfBacktestIntegrityError(
          'PDF_BACKTEST_CANDIDATE_FINGERPRINT_MISSING',
        );
      }
      await writePrivateJson(metadataPath, {
        ...metadata,
        candidateFingerprint: parsed.data,
        candidateDescriptorDigest: parsedDescriptor.data,
      });
    },
    async writeManifest(runId, rows) {
      const directory = await prepareRun(runId);
      const manifestPath = join(directory, 'manifest.jsonl');
      const existing = await readJsonl(manifestPath, (value) =>
        manifestRowSchema.parse(value),
      );
      const byId = new Map(existing.map((row) => [row.attachmentId, row]));
      for (const row of validatePdfBacktestManifestRows(rows)) {
        const prior = byId.get(row.attachmentId);
        if (prior) {
          if (JSON.stringify(prior) !== JSON.stringify(row)) {
            throw new PdfBacktestIdentityDriftError(
              'PDF_BACKTEST_MANIFEST_IDENTITY_DRIFT',
            );
          }
          continue;
        }
        await appendJsonl(manifestPath, {
          ...row,
        });
        byId.set(row.attachmentId, row);
      }
    },
    async readManifest(runId) {
      const directory = runDirectory(rootPath, runId);
      const path = join(directory, 'manifest.jsonl');
      await assertNoSymlink(directory);
      await assertNoSymlink(path);
      return (await readJsonl(path, (value) => manifestRowSchema.parse(value))).sort(
        rowSort,
      );
    },
    async appendTerminalResult(runId, result) {
      const directory = await prepareRun(runId);
      const resultsPath = join(directory, 'results.jsonl');
      const existing = await readJsonl(resultsPath, (value) =>
        validateTerminalResultForRun(runId, value),
      );
      if (existing.some((item) => item.recordRef === result.recordRef)) {
        throw new Error('PDF_BACKTEST_DUPLICATE_TERMINAL_RESULT');
      }
      await appendJsonl(
        resultsPath,
        validateTerminalResultForRun(runId, result),
      );
    },
    async readTerminalResults(runId) {
      const directory = runDirectory(rootPath, runId);
      const path = join(directory, 'results.jsonl');
      await assertNoSymlink(directory);
      await assertNoSymlink(path);
      return readJsonl(path, (value) =>
        validateTerminalResultForRun(runId, value),
      );
    },
    async readPrivate(runId, recordRef) {
      parseRecordRef(recordRef);
      const results = await this.readTerminalResults(runId);
      return results.find((item) => item.recordRef === recordRef) ?? null;
    },
    async appendAdjudication(runId, record) {
      const directory = await prepareRun(runId);
      const adjudicationsPath = join(directory, PDF_BACKTEST_ADJUDICATION_FILE);
      const existing = await readJsonl(adjudicationsPath, (value) =>
        validateAdjudicationForRun(runId, value),
      );
      const validated = validateAdjudicationForRun(runId, record);
      const prior = existing.find(
        (item) => item.recordRef === validated.recordRef,
      );
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(validated)) {
          throw new PdfBacktestIntegrityError(
            'PDF_BACKTEST_ADJUDICATION_IDENTITY_DRIFT',
          );
        }
        return;
      }
      await appendJsonl(adjudicationsPath, validated);
    },
    async readAdjudications(runId) {
      const directory = runDirectory(rootPath, runId);
      const path = join(directory, PDF_BACKTEST_ADJUDICATION_FILE);
      await assertNoSymlink(directory);
      await assertNoSymlink(path);
      return readJsonl(path, (value) =>
        validateAdjudicationForRun(runId, value),
      );
    },
    async markComplete(runId, status) {
      const directory = await prepareRun(runId);
      const metadataPath = join(directory, 'metadata.json');
      await assertPrivatePath(metadataPath);
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<
        string,
        unknown
      >;
      if (
        typeof metadata.expiresAt !== 'string' ||
        new Date(metadata.expiresAt).getTime() <= now().getTime()
      ) {
        throw new PdfBacktestIntegrityError('PDF_BACKTEST_RUN_EXPIRED');
      }
      await writePrivateJson(metadataPath, {
        ...metadata,
        schema: PDF_BACKTEST_METADATA_SCHEMA,
        status,
        completedAt: nowIso(now),
      });
    },
  };
}

export function createMemoryPdfBacktestStore(): PdfBacktestRunStore {
  const manifests = new Map<string, PdfBacktestManifestRow[]>();
  const results = new Map<string, PdfBacktestTerminalResult[]>();
  const adjudications = new Map<string, PdfBacktestAdjudicationRecord[]>();
  const metadata = new Map<
    string,
    { candidateFingerprint?: string; candidateDescriptorDigest?: string }
  >();
  return {
    async hasRun(runId) {
      parseRunId(runId);
      return manifests.has(runId) || results.has(runId) || metadata.has(runId);
    },
    async bindCandidateFingerprint(runId, fingerprint, descriptorDigest) {
      parseRunId(runId);
      const parsed = sha256Schema.safeParse(fingerprint);
      const parsedDescriptor = sha256Schema.safeParse(descriptorDigest);
      if (!parsed.success || !parsedDescriptor.success) {
        throw new PdfBacktestIntegrityError(
          'PDF_BACKTEST_CANDIDATE_FINGERPRINT_INVALID',
        );
      }
      const prior = metadata.get(runId);
      const hasRun =
        prior !== undefined || manifests.has(runId) || results.has(runId);
      if (!hasRun) {
        metadata.set(runId, {
          candidateFingerprint: parsed.data,
          candidateDescriptorDigest: parsedDescriptor.data,
        });
        return;
      }
      if (!prior?.candidateFingerprint) {
        throw new PdfBacktestIntegrityError(
          'PDF_BACKTEST_CANDIDATE_FINGERPRINT_MISSING',
        );
      }
      if (
        prior.candidateFingerprint !== parsed.data ||
        prior.candidateDescriptorDigest !== parsedDescriptor.data
      ) {
        throw new PdfBacktestIntegrityError(
          'PDF_BACKTEST_CANDIDATE_FINGERPRINT_MISMATCH',
        );
      }
    },
    async writeManifest(runId, rows) {
      parseRunId(runId);
      const next = validatePdfBacktestManifestRows(rows);
      const prior = manifests.get(runId) ?? [];
      const byId = new Map(prior.map((row) => [row.attachmentId, row]));
      for (const row of next) {
        const existing = byId.get(row.attachmentId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(row)) {
          throw new PdfBacktestIdentityDriftError(
            'PDF_BACKTEST_MANIFEST_IDENTITY_DRIFT',
          );
        }
        if (!existing) byId.set(row.attachmentId, row);
      }
      manifests.set(runId, [...byId.values()]);
    },
    async readManifest(runId) {
      parseRunId(runId);
      return [...(manifests.get(runId) ?? [])].sort(rowSort);
    },
    async appendTerminalResult(runId, result) {
      parseRunId(runId);
      const validated = validateTerminalResultForRun(runId, result);
      const prior = results.get(runId) ?? [];
      if (prior.some((item) => item.recordRef === validated.recordRef)) {
        throw new Error('PDF_BACKTEST_DUPLICATE_TERMINAL_RESULT');
      }
      results.set(runId, [...prior, validated]);
    },
    async readTerminalResults(runId) {
      parseRunId(runId);
      return (results.get(runId) ?? []).map((result) =>
        validateTerminalResultForRun(runId, result),
      );
    },
    async readPrivate(runId, recordRef) {
      parseRecordRef(recordRef);
      const values = results.get(runId) ?? [];
      return values.find((item) => item.recordRef === recordRef) ?? null;
    },
    async appendAdjudication(runId, record) {
      parseRunId(runId);
      const validated = validateAdjudicationForRun(runId, record);
      const prior = adjudications.get(runId) ?? [];
      const existing = prior.find(
        (item) => item.recordRef === validated.recordRef,
      );
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(validated)) {
          throw new PdfBacktestIntegrityError(
            'PDF_BACKTEST_ADJUDICATION_IDENTITY_DRIFT',
          );
        }
        return;
      }
      adjudications.set(runId, [...prior, validated]);
    },
    async readAdjudications(runId) {
      parseRunId(runId);
      return (adjudications.get(runId) ?? []).map((record) =>
        validateAdjudicationForRun(runId, record),
      );
    },
    async markComplete(runId) {
      parseRunId(runId);
    },
  };
}

export async function purgeExpiredPdfBacktestRuns(
  root: string,
  at = new Date(),
): Promise<number> {
  const rootPath = resolve(root);
  await assertNoSymlink(rootPath);
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let purged = 0;
  for (const entry of entries) {
    const directory = join(rootPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error('PDF_BACKTEST_SYMLINK_REJECTED');
    }
    if (!entry.isDirectory() || !uuidSchema.safeParse(entry.name).success) {
      continue;
    }
    const metadataPath = join(directory, 'metadata.json');
    try {
      await assertPrivatePath(directory, true);
      await assertPrivatePath(metadataPath);
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
        expiresAt?: string;
        status?: string;
        createdAt?: string;
      };
      const runningExpired =
        metadata.status === 'running' &&
        metadata.createdAt !== undefined &&
        new Date(metadata.createdAt).getTime() + PDF_BACKTEST_RUNNING_GRACE_MS <=
          at.getTime();
      if (
        runningExpired ||
        (metadata.status !== 'running' &&
          metadata.expiresAt &&
          new Date(metadata.expiresAt).getTime() <= at.getTime())
      ) {
        await rm(directory, { recursive: true, force: true });
        purged += 1;
      }
    } catch {
      // Incomplete private dirs remain for status/operator diagnosis.
    }
  }
  return purged;
}
