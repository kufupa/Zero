import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  unlink,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PDF_BACKTEST_ADJUDICATION_SCHEMA,
  PDF_BACKTEST_EXIT_CODES,
  PDF_INSPECTOR_BACKTEST_MAX_INPUT_BYTES,
  createCandidatePdfBacktestParsers,
  createDefaultPdfBacktestParsers,
  createFixtureObjectReader,
  createMemoryPdfBacktestStore,
  createPdfInspectorCandidateProvenance,
  createPdfBacktestFileStore,
  executePdfInspectorBacktestCommand,
  loadPdfInspectorCandidateDescriptor,
  parsePdfInspectorCandidateDescriptor,
  parsePdfInspectorBacktestArgs,
  parsePdfInspectorBacktestFixture,
  pdfInspectorCandidateTreeDigest,
  pdfInspectorCandidateSourceTreeDigest,
  purgeExpiredPdfBacktestRuns,
  runFixtureBacktest,
  runLivePdfInspectorBacktest,
  runReplayPdfInspectorBacktest,
  summarizePdfBacktestStatus,
  validatePdfBacktestManifestRows,
  type PdfBacktestFixture,
  type PdfBacktestManifestRow,
  type PdfBacktestObjectReader,
  type PdfBacktestParserResult,
  type PdfBacktestRunStore,
} from '../src/ops/pdf-inspector-backtest-runner.js';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID_2 = '00000000-0000-4000-8000-000000000002';
const PDF_BYTES = Buffer.from('%PDF-1.7\nsynthetic fixture');
const PRIVATE_TEXT = 'synthetic comparison text';
const runnerPath = fileURLToPath(
  new URL('../src/ops/pdf-inspector-backtest-runner.ts', import.meta.url),
);
const runnerCliPath = fileURLToPath(
  new URL('../scripts/run-pdf-inspector-backtest.ts', import.meta.url),
);
const CANDIDATE_TOOL_VERSIONS = {
  poppler: '24.02.0',
  bwrap: '0.8.0',
  prlimit: '2.38.0',
  node: '20.0.0',
};

const inspectorDiagnostics = {
  pdfType: 'TextBased' as const,
  confidence: 0.99,
  ocrPages: [] as number[],
  tablePages: [] as number[],
  columnPages: [] as number[],
  hasEncodingIssues: false,
  isComplexLayout: false,
};

function row(
  attachmentId: string,
  overrides: Partial<PdfBacktestManifestRow> = {},
): PdfBacktestManifestRow {
  return {
    attachmentId,
    messageId: `message-${attachmentId}`,
    threadId: `thread-${attachmentId}`,
    transportId: 'transport-fixture',
    mimeType: 'application/pdf',
    sizeBytes: PDF_BYTES.byteLength,
    isInline: false,
    direction: 'inbound',
    createdAt: '2026-08-08T10:00:00.000Z',
    scopeMembership: {
      full_corpus: true,
      current_runtime_subset: false,
    },
    ...overrides,
  };
}

function parserResult(
  parser: 'poppler' | 'inspector',
  overrides: Partial<PdfBacktestParserResult> = {},
): PdfBacktestParserResult {
  return {
    status: 'ok',
    reason: 'text',
    pageCount: 1,
    text: PRIVATE_TEXT,
    markdown: `# ${PRIVATE_TEXT}`,
    elapsedMs: parser === 'poppler' ? 7 : 11,
    ...(parser === 'inspector'
      ? { diagnostics: inspectorDiagnostics }
      : {}),
    ...overrides,
  };
}

function fixture(
  rows: readonly PdfBacktestManifestRow[] = [row('attachment-1')],
  options: {
    bytes?: Buffer;
    sourceKey?: string;
    objectContentType?: string;
    outcomes?: Partial<
      Record<
        string,
        {
          poppler?: PdfBacktestParserResult;
          inspector?: PdfBacktestParserResult;
        }
      >
    >;
  } = {},
): PdfBacktestFixture {
  return {
    rows: rows.map((metadata) => ({
      ...metadata,
      bytesBase64: (options.bytes ?? PDF_BYTES).toString('base64'),
      ...(options.sourceKey ? { sourceKey: options.sourceKey } : {}),
      ...(options.objectContentType
        ? { objectContentType: options.objectContentType }
        : {}),
      ...(options.outcomes?.[metadata.attachmentId]
        ? { outcomes: options.outcomes[metadata.attachmentId] }
        : {}),
    })),
  };
}

type CandidateStageFixture = {
  rootPath: string;
  sourceRootPath: string;
  cargoLockPath: string;
  packageTarballPath: string;
  nodeModulesPath: string;
  nodeModulesPnpmPath: string;
  packageRootPath: string;
  nativeAddonPath: string;
  childScriptPath: string;
  childScriptSha256: string;
  pnpmStorePath: string;
  gateScriptPath: string;
  gateScriptSha256: string;
  networkProbeScriptPath: string;
  networkProbeScriptSha256: string;
  packageTreeSha256: string;
  sourceCommit: string;
  originMainCommit: string;
  runnerRootPath: string;
  runnerEntryPath: string;
  tsxLoaderPath: string;
  runnerTreeSha256: string;
  cargoLockSha256: string;
  sourceTreeSha256: string;
  lopdfVersion: string;
  tarballSha256: string;
  nativeAddonSha256: string;
};

function candidateDescriptor(stage?: Partial<CandidateStageFixture>) {
  const fixtureStage = {
    rootPath: join(tmpdir(), 'pdf-inspector-stage'),
    sourceRootPath: join(tmpdir(), 'pdf-inspector-stage', 'source'),
    cargoLockPath: join(
      tmpdir(),
      'pdf-inspector-stage',
      'source',
      'napi',
      'Cargo.lock',
    ),
    packageTarballPath: join(
      tmpdir(),
      'pdf-inspector-stage',
      'pdf-inspector.tgz',
    ),
    nodeModulesPath: join(tmpdir(), 'pdf-inspector-stage', 'node_modules'),
    nodeModulesPnpmPath: join(tmpdir(), 'pdf-inspector-stage', 'node_modules', '.pnpm'),
    packageRootPath: join(
      tmpdir(),
      'pdf-inspector-stage',
      'node_modules',
      '@firecrawl',
      'pdf-inspector',
    ),
    nativeAddonPath: join(
      tmpdir(),
      'pdf-inspector-stage',
      'node_modules',
      '@firecrawl',
      'pdf-inspector-linux-x64-gnu',
      'pdf_inspector.node',
    ),
    childScriptPath: join(
      tmpdir(),
      'pdf-inspector-stage',
      'pdf-inspector-child.mjs',
    ),
    childScriptSha256: 'e'.repeat(64),
    pnpmStorePath: join(tmpdir(), 'pdf-inspector-stage', 'pnpm-store'),
    gateScriptPath: join(tmpdir(), 'pdf-inspector-stage', 'pdf-inspector-gate.sh'),
    gateScriptSha256: 'f'.repeat(64),
    networkProbeScriptPath: join(
      tmpdir(),
      'pdf-inspector-stage',
      'pdf-inspector-network-probe.mjs',
    ),
    networkProbeScriptSha256: '1'.repeat(64),
    packageTreeSha256: '2'.repeat(64),
    sourceCommit: 'a'.repeat(40),
    originMainCommit: 'a'.repeat(40),
    runnerRootPath: join(tmpdir(), 'pdf-inspector-stage', 'runner'),
    runnerEntryPath: join(tmpdir(), 'pdf-inspector-stage', 'runner', 'run-pdf.ts'),
    tsxLoaderPath: join(
      tmpdir(),
      'pdf-inspector-stage',
      'runner',
      'node_modules',
      'tsx',
      'dist',
      'loader.mjs',
    ),
    runnerTreeSha256: '3'.repeat(64),
    cargoLockSha256: 'b'.repeat(64),
    sourceTreeSha256: '4'.repeat(64),
    lopdfVersion: '0.42.0',
    tarballSha256: 'c'.repeat(64),
    nativeAddonSha256: 'd'.repeat(64),
    ...stage,
  };
  const withoutId = {
    schema: 'pdf_inspector_candidate_v1' as const,
    source: {
      repository: 'firecrawl/pdf-inspector' as const,
      commit: fixtureStage.sourceCommit,
      originMainCommit: fixtureStage.originMainCommit,
      cargoLockSha256: fixtureStage.cargoLockSha256,
      sourceTreeSha256: fixtureStage.sourceTreeSha256,
    },
    package: {
      name: '@firecrawl/pdf-inspector' as const,
      version: '1.12.1-rc.0',
      tarballSha256: fixtureStage.tarballSha256,
      nativeAddonSha256: fixtureStage.nativeAddonSha256,
    },
    runtime: {
      target: 'x86_64-unknown-linux-gnu',
      libc: 'gnu' as const,
      nodeAbi: '115',
    },
    lopdfVersion: fixtureStage.lopdfVersion,
    stage: {
      rootPath: fixtureStage.rootPath,
      sourceRootPath: fixtureStage.sourceRootPath,
      cargoLockPath: fixtureStage.cargoLockPath,
      packageTarballPath: fixtureStage.packageTarballPath,
      nodeModulesPath: fixtureStage.nodeModulesPath,
      nodeModulesPnpmPath: fixtureStage.nodeModulesPnpmPath,
      packageRootPath: fixtureStage.packageRootPath,
      packageTreeSha256: fixtureStage.packageTreeSha256,
      nativeAddonPath: fixtureStage.nativeAddonPath,
      childScriptPath: fixtureStage.childScriptPath,
      childScriptSha256: fixtureStage.childScriptSha256,
      pnpmStorePath: fixtureStage.pnpmStorePath,
      gateScriptPath: fixtureStage.gateScriptPath,
      gateScriptSha256: fixtureStage.gateScriptSha256,
      networkProbeScriptPath: fixtureStage.networkProbeScriptPath,
      networkProbeScriptSha256: fixtureStage.networkProbeScriptSha256,
      runnerRootPath: fixtureStage.runnerRootPath,
      runnerEntryPath: fixtureStage.runnerEntryPath,
      runnerTreeSha256: fixtureStage.runnerTreeSha256,
    },
  };
  const candidateId = createHash('sha256')
    .update(
      JSON.stringify({
        source: withoutId.source,
        package: withoutId.package,
        runtime: withoutId.runtime,
        lopdfVersion: withoutId.lopdfVersion,
      }),
    )
    .digest('hex');
  return { ...withoutId, candidateId };
}

async function createCandidateStage(
  options: { lopdfVersion?: string } = {},
): Promise<CandidateStageFixture> {
  const rootPath = await mkdtemp(join(tmpdir(), 'pdf-inspector-stage-'));
  const sourceDir = join(rootPath, 'source');
  const napiDir = join(sourceDir, 'napi');
  const cargoLockPath = join(napiDir, 'Cargo.lock');
  const packageTarballPath = join(rootPath, 'pdf-inspector.tgz');
  const nodeModulesPath = join(rootPath, 'node_modules');
  const packageRootPath = join(
    nodeModulesPath,
    '@firecrawl',
    'pdf-inspector',
  );
  const nativePackageRoot = join(
    nodeModulesPath,
    '@firecrawl',
    'pdf-inspector-linux-x64-gnu',
  );
  const nativeAddonPath = join(nativePackageRoot, 'pdf_inspector.node');
  const childScriptPath = join(rootPath, 'pdf-inspector-child.mjs');
  const pnpmStorePath = join(rootPath, 'pnpm-store');
  const nodeModulesPnpmPath = join(nodeModulesPath, '.pnpm');
  const gateScriptPath = join(rootPath, 'pdf-inspector-gate.sh');
  const networkProbeScriptPath = join(
    rootPath,
    'pdf-inspector-network-probe.mjs',
  );
  const runnerRootPath = join(rootPath, 'runner');
  const runnerEntryPath = join(runnerRootPath, 'run-pdf.ts');
  const runnerEntry = Buffer.from('export {};\n', 'utf8');
  const tsxLoaderPath = join(
    runnerRootPath,
    'node_modules',
    'tsx',
    'dist',
    'loader.mjs',
  );
  const tsxLoader = Buffer.from('export {};\n', 'utf8');
  const lopdfVersion = options.lopdfVersion ?? '0.42.0';
  const cargoLock = Buffer.from(
    `version = 3\n\n[[package]]\nname = "lopdf"\nversion = "${lopdfVersion}"\n`,
    'utf8',
  );
  const nativeAddon = Buffer.from('synthetic native addon', 'utf8');
  const childScript = Buffer.from('export {};\n', 'utf8');
  const gateScript = Buffer.from('#!/usr/bin/env bash\nexit 0\n', 'utf8');
  const networkProbeScript = Buffer.from('export {};\n', 'utf8');
  const sourceGitignore = Buffer.from(
    'napi/node_modules/\nnapi/target/\n*.node\n',
    'utf8',
  );
  const packageJson = Buffer.from(
    JSON.stringify({
      name: '@firecrawl/pdf-inspector',
      version: '1.12.1-rc.0',
    }),
    'utf8',
  );
  const nativePackageJson = Buffer.from(
    JSON.stringify({
      name: '@firecrawl/pdf-inspector-linux-x64-gnu',
      version: '1.12.1-rc.0',
      main: 'pdf_inspector.node',
    }),
    'utf8',
  );

  await mkdir(sourceDir, { recursive: true });
  await mkdir(napiDir, { recursive: true });
  await mkdir(packageRootPath, { recursive: true });
  await mkdir(nativePackageRoot, { recursive: true });
  await mkdir(pnpmStorePath, { recursive: true });
  await mkdir(nodeModulesPnpmPath, { recursive: true });
  await mkdir(runnerRootPath, { recursive: true });
  await mkdir(join(runnerRootPath, 'node_modules', 'tsx', 'dist'), {
    recursive: true,
  });
  await writeFile(cargoLockPath, cargoLock, { mode: 0o400 });
  await writeFile(join(sourceDir, '.gitignore'), sourceGitignore, {
    mode: 0o400,
  });
  await writeFile(nativeAddonPath, nativeAddon, { mode: 0o400 });
  await writeFile(childScriptPath, childScript, { mode: 0o400 });
  await writeFile(join(packageRootPath, 'package.json'), packageJson, {
    mode: 0o400,
  });
  const tarSourceRoot = join(rootPath, 'tar-source');
  const tarPackageRoot = join(tarSourceRoot, 'package');
  await mkdir(tarPackageRoot, { recursive: true });
  await writeFile(join(tarPackageRoot, 'package.json'), packageJson, {
    mode: 0o400,
  });
  execFileSync('tar', ['-czf', 'pdf-inspector.tgz', '-C', 'tar-source', 'package'], {
    cwd: rootPath,
  });
  await writeFile(join(nativePackageRoot, 'package.json'), nativePackageJson, {
    mode: 0o400,
  });
  await writeFile(gateScriptPath, gateScript, { mode: 0o400 });
  await writeFile(networkProbeScriptPath, networkProbeScript, { mode: 0o400 });
  await writeFile(runnerEntryPath, runnerEntry, { mode: 0o400 });
  await writeFile(tsxLoaderPath, tsxLoader, { mode: 0o400 });
  execFileSync('git', ['init', '--quiet', sourceDir]);
  execFileSync('git', [
    '-C',
    sourceDir,
    'remote',
    'add',
    'origin',
    'https://github.com/firecrawl/pdf-inspector.git',
  ]);
  execFileSync('git', [
    '-C',
    sourceDir,
    'add',
    'napi/Cargo.lock',
    '.gitignore',
  ]);
  execFileSync(
    'git',
    [
      '-C',
      sourceDir,
      '-c',
      'user.name=PDF Inspector Test',
      '-c',
      'user.email=pdf-inspector-test@example.invalid',
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '-m',
      'stage fixture',
    ],
  );
  execFileSync('git', ['-C', sourceDir, 'checkout', '--quiet', '--detach', 'HEAD']);
  const sourceCommit = execFileSync(
    'git',
    ['-C', sourceDir, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();
  execFileSync('git', [
    '-C',
    sourceDir,
    'update-ref',
    'refs/remotes/origin/main',
    sourceCommit,
  ]);
  const tarball = await readFile(packageTarballPath);
  const stagedCargoLock = await readFile(cargoLockPath);

  if (process.platform !== 'win32') {
    for (const path of [
      rootPath,
      sourceDir,
      napiDir,
      join(sourceDir, '.git'),
      nodeModulesPath,
      nodeModulesPnpmPath,
      join(nodeModulesPath, '@firecrawl'),
      packageRootPath,
      nativePackageRoot,
      pnpmStorePath,
      runnerRootPath,
      join(runnerRootPath, 'node_modules'),
      join(runnerRootPath, 'node_modules', 'tsx'),
      join(runnerRootPath, 'node_modules', 'tsx', 'dist'),
    ]) {
      await chmod(path, 0o500);
    }
    for (const path of [
      cargoLockPath,
      packageTarballPath,
      nativeAddonPath,
      childScriptPath,
      join(packageRootPath, 'package.json'),
      join(nativePackageRoot, 'package.json'),
      gateScriptPath,
      networkProbeScriptPath,
      runnerEntryPath,
      tsxLoaderPath,
    ]) {
      await chmod(path, 0o400);
    }
  }

  return {
    rootPath,
    sourceRootPath: sourceDir,
    cargoLockPath,
    packageTarballPath,
    nodeModulesPath,
    nodeModulesPnpmPath,
    packageRootPath,
    nativeAddonPath,
    childScriptPath,
    childScriptSha256: createHash('sha256').update(childScript).digest('hex'),
    pnpmStorePath,
    gateScriptPath,
    gateScriptSha256: createHash('sha256').update(gateScript).digest('hex'),
    networkProbeScriptPath,
    networkProbeScriptSha256: createHash('sha256')
      .update(networkProbeScript)
      .digest('hex'),
    packageTreeSha256: createHash('sha256')
      .update(
        [
          'd:.',
          `f:package.json:${createHash('sha256').update(packageJson).digest('hex')}`,
        ].join('\n'),
      )
      .digest('hex'),
    sourceCommit,
    originMainCommit: sourceCommit,
    runnerRootPath,
    runnerEntryPath,
    tsxLoaderPath,
    runnerTreeSha256: pdfInspectorCandidateTreeDigest(runnerRootPath),
    cargoLockSha256: createHash('sha256').update(stagedCargoLock).digest('hex'),
    sourceTreeSha256: pdfInspectorCandidateSourceTreeDigest(sourceDir),
    lopdfVersion,
    tarballSha256: createHash('sha256').update(tarball).digest('hex'),
    nativeAddonSha256: createHash('sha256').update(nativeAddon).digest('hex'),
  };
}

async function loadStagedCandidate() {
  const descriptorRoot = await mkdtemp(
    join(tmpdir(), 'pdf-backtest-candidate-descriptor-'),
  );
  const descriptorPath = join(descriptorRoot, 'candidate.json');
  const stage = await createCandidateStage();
  await writeFile(descriptorPath, JSON.stringify(candidateDescriptor(stage)), {
    mode: 0o600,
  });
  if (process.platform !== 'win32') await chmod(descriptorPath, 0o600);
  return {
    stage,
    candidate: await loadPdfInspectorCandidateDescriptor(descriptorPath),
  };
}

async function writeCandidateDescriptorForStage(
  stage: CandidateStageFixture,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pdf-backtest-candidate-descriptor-'));
  const path = join(root, 'candidate.json');
  await writeFile(path, JSON.stringify(candidateDescriptor(stage)), {
    mode: 0o600,
  });
  if (process.platform !== 'win32') await chmod(path, 0o600);
  return path;
}

function parsers(options: {
  seenBytes?: Buffer[];
  counts?: { poppler: number; inspector: number };
} = {}) {
  return {
    poppler: async (input: {
      bytes: Buffer;
    }): Promise<PdfBacktestParserResult> => {
      options.seenBytes?.push(input.bytes);
      if (options.counts) options.counts.poppler += 1;
      return parserResult('poppler');
    },
    inspector: async (input: {
      bytes: Buffer;
    }): Promise<PdfBacktestParserResult> => {
      options.seenBytes?.push(input.bytes);
      if (options.counts) options.counts.inspector += 1;
      return parserResult('inspector');
    },
  };
}

describe('PDF Inspector backtest runner contracts', () => {
  it('parses help and each supported command grammar', () => {
    expect(parsePdfInspectorBacktestArgs(['--help'])).toEqual({
      kind: 'help',
    });
    expect(
      parsePdfInspectorBacktestArgs([
        '--fixture',
        'fixture.json',
        '--run-id',
        RUN_ID,
      ]),
    ).toEqual({
      kind: 'fixture',
      fixturePath: 'fixture.json',
      runId: RUN_ID,
    });
    expect(parsePdfInspectorBacktestArgs(['--live', '--run-id', RUN_ID])).toEqual({
      kind: 'live',
      runId: RUN_ID,
    });
    expect(
      parsePdfInspectorBacktestArgs([
        '--replay-run',
        RUN_ID,
        '--candidate-descriptor',
        'candidate.json',
        '--run-id',
        RUN_ID_2,
      ]),
    ).toEqual({
      kind: 'replay',
      replayRunId: RUN_ID,
      runId: RUN_ID_2,
      candidateDescriptorPath: 'candidate.json',
    });
    expect(parsePdfInspectorBacktestArgs(['--status', RUN_ID])).toEqual({
      kind: 'status',
      runId: RUN_ID,
    });
    expect(
      parsePdfInspectorBacktestArgs(['--show-private', RUN_ID, 'record-1']),
    ).toEqual({
      kind: 'show-private',
      runId: RUN_ID,
      recordRef: 'record-1',
    });
  });

  it('rejects unknown args, missing values, and invalid combinations', () => {
    expect(() => parsePdfInspectorBacktestArgs(['--unknown'])).toThrow(
      /invalid|unknown/i,
    );
    expect(() => parsePdfInspectorBacktestArgs(['--fixture'])).toThrow(
      /fixture/i,
    );
    expect(() =>
      parsePdfInspectorBacktestArgs(['--fixture', 'x.json', '--live']),
    ).toThrow(/combination|exactly one|live/i);
    expect(() =>
      parsePdfInspectorBacktestArgs(['--status', RUN_ID, '--run-id', RUN_ID]),
    ).toThrow(/status|combination/i);
    expect(() =>
      parsePdfInspectorBacktestArgs(['--show-private', RUN_ID]),
    ).toThrow(/show-private/i);
    expect(() =>
      parsePdfInspectorBacktestArgs(['--run-id', 'not-a-uuid', '--live']),
    ).toThrow(/uuid/i);
    expect(() =>
      parsePdfInspectorBacktestArgs(['--live', '--live']),
    ).toThrow(/duplicate/i);
    expect(() =>
      parsePdfInspectorBacktestArgs([
        '--live',
        '--candidate-descriptor',
        'candidate.json',
      ]),
    ).toThrow(/candidate|replay/i);
    expect(() =>
      parsePdfInspectorBacktestArgs(['--replay-run', RUN_ID]),
    ).toThrow(/candidate|descriptor/i);
    expect(() =>
      parsePdfInspectorBacktestArgs([
        '--replay-run',
        RUN_ID,
        '--candidate-descriptor',
        'candidate.json',
        '--run-id',
        RUN_ID,
      ]),
    ).toThrow(/replay|run.id|combination/i);
  });

  it('runs candidate native gate with a clean fixed host environment', () => {
    const source = readFileSync(runnerPath, 'utf8');
    const nativeGate = source.slice(
      source.indexOf('async function assertCandidateNativeGate'),
      source.indexOf('function commandVersion'),
    );

    expect(nativeGate).toContain("'/usr/bin/env'");
    expect(nativeGate).toContain("'-i'");
    expect(nativeGate).toContain("'PATH=/usr/bin:/bin'");
    expect(nativeGate).toContain("'NODE_BIN=/usr/bin/node'");
    expect(nativeGate).not.toContain('...process.env');
    expect(nativeGate).toContain('trustedCandidateBootstrapPaths');
    expect(nativeGate).not.toContain('candidate.stage.gateScriptPath');
    const upstreamVerification = source.slice(
      source.indexOf('function assertCandidateUpstreamMain'),
      source.indexOf('function commandVersion'),
    );
    expect(upstreamVerification).toContain(
      'https://github.com/firecrawl/pdf-inspector.git',
    );
    expect(upstreamVerification).toContain("'GIT_CONFIG_NOSYSTEM=1'");
    expect(upstreamVerification).toContain('refs/heads/main');
    const checkoutVerification = source.slice(
      source.indexOf('function assertCleanDetachedSourceCheckout'),
      source.indexOf('function verifyPdfInspectorCandidateStage'),
    );
    expect(checkoutVerification).toContain("'core.fsmonitor=false'");
    expect(checkoutVerification).toContain("'GIT_CONFIG_NOSYSTEM=1'");
    expect(checkoutVerification).toContain("'/usr/bin/env'");
    const defaultGate = source.slice(
      source.indexOf('async function assertDefaultNativeGate'),
      source.indexOf('async function assertCandidateNativeGate'),
    );
    expect(defaultGate).toContain("'/usr/bin/env'");
    expect(defaultGate).toContain("'-i'");
    expect(defaultGate).not.toContain("execFile(\n        'bash'");
  });

  it('keeps candidate command bootstrap in trusted canonical code', () => {
    const source = readFileSync(runnerCliPath, 'utf8');

    expect(source).toContain('runPdfInspectorBacktestCli');
    expect(source).not.toContain('runStagedCandidateRunner');
    expect(source).not.toContain('PDF_BACKTEST_STAGED_RUNNER');
    expect(source).not.toContain('candidateDescriptorPath');
  });

  it('rejects forged candidate descriptor identities', () => {
    const descriptor = candidateDescriptor();

    expect(parsePdfInspectorCandidateDescriptor(descriptor)).toEqual(descriptor);
    expect(() =>
      parsePdfInspectorCandidateDescriptor({
        ...descriptor,
        candidateId: '0'.repeat(64),
      }),
    ).toThrow(/candidate|identity|fingerprint/i);
  });

  it('derives candidate fingerprint from private descriptor bytes', async () => {
    const stage = await createCandidateStage();
    const root = await mkdtemp(join(tmpdir(), 'pdf-backtest-candidate-descriptor-'));
    const descriptorPath = join(root, 'candidate.json');
    const bytes = Buffer.from(JSON.stringify(candidateDescriptor(stage)), 'utf8');
    await writeFile(descriptorPath, bytes, { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(descriptorPath, 0o600);

    const candidate = await loadPdfInspectorCandidateDescriptor(descriptorPath);

    expect(candidate.implementationFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(candidate.implementationFingerprint).not.toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(candidate.descriptor.stage).toMatchObject({
      rootPath: stage.rootPath,
      childScriptSha256: stage.childScriptSha256,
    });
  });

  it('binds a canonical descriptor digest separately from implementation artifacts', async () => {
    const { candidate } = await loadStagedCandidate();

    expect(candidate).toMatchObject({
      descriptorDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      implementationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(
      (candidate as unknown as {
        descriptorDigest: string;
        implementationFingerprint: string;
      }).descriptorDigest,
    ).not.toBe(candidate.implementationFingerprint);
  });

  it('rejects a candidate descriptor that could bind filesystem root', async () => {
    const stage = await createCandidateStage();
    const root = await mkdtemp(join(tmpdir(), 'pdf-backtest-candidate-root-'));
    const descriptorPath = join(root, 'candidate.json');
    const descriptor = candidateDescriptor(stage);
    descriptor.stage.nodeModulesPath =
      process.platform === 'win32' ? 'C:\\' : '/';
    await writeFile(descriptorPath, JSON.stringify(descriptor), {
      mode: 0o600,
    });
    if (process.platform !== 'win32') await chmod(descriptorPath, 0o600);

    await expect(
      loadPdfInspectorCandidateDescriptor(descriptorPath),
    ).rejects.toThrow(/candidate.*stage|stage.*root|path/i);
  });

  it('requires an explicit staged pnpm store instead of deriving a host path', () => {
    const descriptor = candidateDescriptor();
    const { pnpmStorePath: _ignored, ...stageWithoutPnpmStore } =
      descriptor.stage;

    expect(() =>
      parsePdfInspectorCandidateDescriptor({
        ...descriptor,
        stage: stageWithoutPnpmStore,
      }),
    ).toThrow(/pnpmStorePath|required|invalid/i);
  });

  it('rejects cross-device descendants before candidate Bubblewrap binds', async () => {
    const gate = await readFile(
      new URL('../deploy/pdf-inspector-gate.sh', import.meta.url),
      'utf8',
    );

    expect(gate).toContain('root_device');
    expect(gate).toContain('stat -c %d');
    expect(gate).toContain('[[ "$child_device" == "$root_device" ]] || fail');
  });

  it('rejects cross-device descendants before TypeScript traversal reads them', async () => {
    const runner = await readFile(
      new URL('../src/ops/pdf-inspector-backtest-runner.ts', import.meta.url),
      'utf8',
    );

    expect(runner).toContain('PDF_BACKTEST_CANDIDATE_STAGE_CROSS_DEVICE_REJECTED');
    expect(runner).toMatch(
      /info\.dev !== rootDevice[\s\S]{0,240}readdirSync/u,
    );
  });

  it('routes candidate inspector through staged paths only', async () => {
    const stage = await createCandidateStage();
    const descriptor = candidateDescriptor(stage);
    let seen:
      | {
          args: string[];
          env: Record<string, string>;
        }
      | undefined;
    const candidateParsers = createCandidatePdfBacktestParsers(descriptor, {
      runChild: async (command) => {
        seen = command;
        return {
          stdout: Buffer.from(
            JSON.stringify({
              status: 'ok',
              reason: 'text',
              pageCount: 1,
              markdown: '# staged candidate',
              pdfType: 'TextBased',
              confidence: 0.99,
              pagesNeedingOcr: [],
              pagesWithTables: [],
              pagesWithColumns: [],
              isComplexLayout: false,
              hasEncodingIssues: false,
            }),
          ),
          stderr: Buffer.alloc(0),
          exitCode: 0,
          signal: null,
          outputLimitExceeded: false,
        };
      },
    });

    await candidateParsers.inspector({
      bytes: PDF_BYTES,
      row: row('candidate-stage'),
      sourceRef: 'pdf-candidate-stage',
      signal: new AbortController().signal,
    });

    expect(seen?.env).toEqual({ PATH: '/usr/bin:/bin' });
    const canonicalChildPath = fileURLToPath(
      new URL('../scripts/pdf-inspector-child.mjs', import.meta.url),
    );
    expect(seen?.args).toEqual(
      expect.arrayContaining([
        descriptor.stage.nodeModulesPath,
        canonicalChildPath,
        descriptor.stage.pnpmStorePath,
      ]),
    );
    expect(seen?.args).not.toContain(descriptor.stage.childScriptPath);
    expect(seen?.args).not.toContain('NODE_PATH');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked candidate artifact before constructing parser commands',
    async () => {
      const stage = await createCandidateStage();
      const outsideRoot = await mkdtemp(join(tmpdir(), 'pdf-inspector-outside-'));
      const outsideChild = join(outsideRoot, 'child.mjs');
      await writeFile(outsideChild, 'export {};\n', { mode: 0o400 });
      await chmod(stage.rootPath, 0o700);
      await unlink(stage.childScriptPath);
      await symlink(outsideChild, stage.childScriptPath);
      await chmod(stage.rootPath, 0o500);
      let parserCommandConstructed = false;

      expect(() =>
        createCandidatePdfBacktestParsers(candidateDescriptor(stage), {
          runChild: async () => {
            parserCommandConstructed = true;
            throw new Error('must not execute');
          },
        }),
      ).toThrow(/candidate.*stage|stage.*path|symlink/i);
      expect(parserCommandConstructed).toBe(false);
    },
  );

  it('rechecks staged implementation hashes before constructing parser commands', async () => {
    const { stage, candidate } = await loadStagedCandidate();
    await chmod(stage.rootPath, 0o700);
    await chmod(stage.childScriptPath, 0o600);
    await writeFile(stage.childScriptPath, 'export const drift = true;\n', {
      mode: 0o600,
    });
    if (process.platform !== 'win32') {
      await chmod(stage.childScriptPath, 0o400);
      await chmod(stage.rootPath, 0o500);
    }
    let parserCommandConstructed = false;

    expect(() =>
      createCandidatePdfBacktestParsers(candidate.descriptor, {
        runChild: async () => {
          parserCommandConstructed = true;
          throw new Error('must not execute');
        },
      }),
    ).toThrow('PDF_BACKTEST_CANDIDATE_STAGE_HASH_MISMATCH');
    expect(parserCommandConstructed).toBe(false);
  });

  it('rejects a candidate source checkout that is not clean and detached', async () => {
    const { stage } = await loadStagedCandidate();
    const dirtyPath = join(stage.sourceRootPath, 'untracked.txt');
    if (process.platform !== 'win32') await chmod(stage.sourceRootPath, 0o700);
    await writeFile(dirtyPath, 'drift\n', { mode: 0o400 });
    if (process.platform !== 'win32') await chmod(stage.sourceRootPath, 0o500);

    await expect(
      loadPdfInspectorCandidateDescriptor(
        await writeCandidateDescriptorForStage(stage),
      ),
    ).rejects.toThrow('PDF_BACKTEST_CANDIDATE_SOURCE_NOT_CLEAN_DETACHED');
  });

  it('rejects a candidate source checkout with an ignored build artifact', async () => {
    const { stage } = await loadStagedCandidate();
    const ignoredArtifactDir = join(stage.sourceRootPath, 'napi', 'target');
    const ignoredArtifactPath = join(ignoredArtifactDir, 'pdf_inspector.node');
    expect(
      execFileSync(
        'git',
        ['-C', stage.sourceRootPath, 'ls-files', '--error-unmatch', '.gitignore'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('.gitignore');
    if (process.platform !== 'win32') {
      await chmod(stage.sourceRootPath, 0o700);
      await chmod(join(stage.sourceRootPath, 'napi'), 0o700);
    }
    await mkdir(ignoredArtifactDir, { recursive: true });
    await writeFile(ignoredArtifactPath, 'ignored build artifact\n', {
      mode: 0o400,
    });
    if (process.platform !== 'win32') {
      await chmod(ignoredArtifactDir, 0o500);
      await chmod(join(stage.sourceRootPath, 'napi'), 0o500);
      await chmod(stage.sourceRootPath, 0o500);
    }

    await expect(
      loadPdfInspectorCandidateDescriptor(
        await writeCandidateDescriptorForStage(stage),
      ),
    ).rejects.toThrow('PDF_BACKTEST_CANDIDATE_SOURCE_NOT_CLEAN_DETACHED');
  });

  it('binds full staged source content, not only Cargo.lock bytes', async () => {
    const stage = await createCandidateStage();
    const descriptor = candidateDescriptor({
      ...stage,
      sourceTreeSha256: '0'.repeat(64),
    });
    const root = await mkdtemp(join(tmpdir(), 'pdf-backtest-candidate-descriptor-'));
    const path = join(root, 'candidate.json');
    await writeFile(path, JSON.stringify(descriptor), { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(path, 0o600);

    await expect(loadPdfInspectorCandidateDescriptor(path)).rejects.toThrow(
      'PDF_BACKTEST_CANDIDATE_SOURCE_TREE_HASH_MISMATCH',
    );
  });

  it('rejects lopdf prereleases below the fixed release floor', async () => {
    const stage = await createCandidateStage({
      lopdfVersion: '0.42.0-alpha.1',
    });

    await expect(
      loadPdfInspectorCandidateDescriptor(
        await writeCandidateDescriptorForStage(stage),
      ),
    ).rejects.toThrow('PDF_BACKTEST_CANDIDATE_LOPDF_LOCK_INVALID');
  });

  it('requires detached HEAD to equal locally tracked origin/main', async () => {
    const stage = await createCandidateStage();
    if (process.platform !== 'win32') await chmod(join(stage.sourceRootPath, '.git'), 0o700);
    execFileSync('git', [
      '-C',
      stage.sourceRootPath,
      'update-ref',
      '-d',
      'refs/remotes/origin/main',
    ]);
    if (process.platform !== 'win32') await chmod(join(stage.sourceRootPath, '.git'), 0o500);

    await expect(
      loadPdfInspectorCandidateDescriptor(
        await writeCandidateDescriptorForStage(stage),
      ),
    ).rejects.toThrow('PDF_BACKTEST_CANDIDATE_SOURCE_ORIGIN_MAIN_MISMATCH');
  });

  it('rejects a root-only Cargo.lock instead of Firecrawl napi/Cargo.lock', async () => {
    const stage = await createCandidateStage();
    const forgedRootLock = join(stage.sourceRootPath, 'Cargo.lock');
    await chmod(stage.rootPath, 0o700);
    await chmod(stage.sourceRootPath, 0o700);
    await writeFile(forgedRootLock, 'root-only forged lock\n', {
      mode: 0o400,
    });
    if (process.platform !== 'win32') {
      await chmod(stage.sourceRootPath, 0o500);
      await chmod(stage.rootPath, 0o500);
    }
    const descriptor = candidateDescriptor({
      ...stage,
      cargoLockPath: forgedRootLock,
    });
    const descriptorPath = await mkdtemp(
      join(tmpdir(), 'pdf-backtest-candidate-descriptor-'),
    );
    const path = join(descriptorPath, 'candidate.json');
    await writeFile(path, JSON.stringify(descriptor), { mode: 0o600 });

    await expect(loadPdfInspectorCandidateDescriptor(path)).rejects.toThrow(
      'PDF_BACKTEST_CANDIDATE_STAGE_PACKAGE_PATH_INVALID',
    );
  });

  it('rejects a malformed package tarball despite matching tarball bytes', async () => {
    const stage = await createCandidateStage();
    const malformed = Buffer.from('not a tarball', 'utf8');
    if (process.platform !== 'win32') {
      await chmod(stage.rootPath, 0o700);
      await chmod(stage.packageTarballPath, 0o600);
    }
    await writeFile(stage.packageTarballPath, malformed, { mode: 0o600 });
    stage.tarballSha256 = createHash('sha256').update(malformed).digest('hex');
    if (process.platform !== 'win32') {
      await chmod(stage.packageTarballPath, 0o400);
      await chmod(stage.rootPath, 0o500);
    }

    await expect(
      loadPdfInspectorCandidateDescriptor(
        await writeCandidateDescriptorForStage(stage),
      ),
    ).rejects.toThrow('PDF_BACKTEST_CANDIDATE_TARBALL_INVALID');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects writable descendants in mounted pnpm trees',
    async () => {
    const stage = await createCandidateStage();
    const writableDescendant = join(stage.pnpmStorePath, 'mutable.txt');
    if (process.platform !== 'win32') await chmod(stage.pnpmStorePath, 0o700);
    await writeFile(writableDescendant, 'mutable\n', { mode: 0o600 });
    if (process.platform !== 'win32') await chmod(stage.pnpmStorePath, 0o500);

      await expect(
        loadPdfInspectorCandidateDescriptor(
          await writeCandidateDescriptorForStage(stage),
        ),
      ).rejects.toThrow('PDF_BACKTEST_CANDIDATE_STAGE_PRIVATE_READONLY_REQUIRED');
    },
  );

  it('rejects package-tree drift even when package metadata is unchanged', async () => {
    const { stage } = await loadStagedCandidate();
    const driftPath = join(stage.packageRootPath, 'injected.mjs');
    if (process.platform !== 'win32') {
      await chmod(stage.rootPath, 0o700);
      await chmod(stage.packageRootPath, 0o700);
    }
    await writeFile(driftPath, 'export const drift = true;\n', { mode: 0o400 });
    if (process.platform !== 'win32') {
      await chmod(stage.packageRootPath, 0o500);
      await chmod(stage.rootPath, 0o500);
    }

    await expect(
      loadPdfInspectorCandidateDescriptor(
        await writeCandidateDescriptorForStage(stage),
      ),
    ).rejects.toThrow('PDF_BACKTEST_CANDIDATE_STAGE_HASH_MISMATCH');
  });

  it('marks candidate provenance backtest-only and promotion-blocked', async () => {
    const descriptor = candidateDescriptor();
    const provenance = createPdfInspectorCandidateProvenance(
      descriptor,
      'e'.repeat(64),
    );
    const result = await runFixtureBacktest({
      runId: RUN_ID,
      fixture: {
        ...fixture(),
        packageVersions: { pdfInspector: descriptor.package.version },
        inspectorProvenance: provenance,
      },
      store: createMemoryPdfBacktestStore(),
      parsers: parsers(),
    });

    expect(provenance).toMatchObject({
      backtestOnly: true,
      runtimeVerified: false,
      packageVersion: descriptor.package.version,
      lopdfVersion: descriptor.lopdfVersion,
      implementationFingerprint: {
        algorithm: 'sha256',
        value: 'e'.repeat(64),
      },
    });
    expect(result.report?.recommendation.state).toBe('blocked');
    expect(JSON.stringify(result.report)).not.toContain(
      descriptor.stage.nodeModulesPath,
    );
  });

  it('binds candidate fingerprint to metadata and rejects mismatched resumes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-backtest-candidate-fingerprint-'));
    const store = createPdfBacktestFileStore(root);
    const fingerprint = 'e'.repeat(64);
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture(),
      store,
      parsers: parsers(),
      candidateFingerprint: fingerprint,
      candidateDescriptorDigest: 'd'.repeat(64),
    });

    expect((await store.readTerminalResults(RUN_ID))[0]?.candidateFingerprint).toBe(
      fingerprint,
    );
    expect(
      JSON.parse(await readFile(join(root, RUN_ID, 'metadata.json'), 'utf8')),
    ).toMatchObject({
      candidateFingerprint: fingerprint,
      candidateDescriptorDigest: 'd'.repeat(64),
    });
    await expect(
      runFixtureBacktest({
        runId: RUN_ID,
        fixture: fixture(),
        store,
        parsers: parsers(),
        candidateFingerprint: 'f'.repeat(64),
        candidateDescriptorDigest: 'd'.repeat(64),
      }),
    ).rejects.toThrow('PDF_BACKTEST_CANDIDATE_FINGERPRINT_MISMATCH');

    const oldStore = createMemoryPdfBacktestStore();
    await runFixtureBacktest({
      runId: RUN_ID_2,
      fixture: fixture(),
      store: oldStore,
      parsers: parsers(),
    });
    await expect(
      runFixtureBacktest({
        runId: RUN_ID_2,
        fixture: fixture(),
        store: oldStore,
        parsers: parsers(),
        candidateFingerprint: fingerprint,
        candidateDescriptorDigest: 'd'.repeat(64),
      }),
    ).rejects.toThrow('PDF_BACKTEST_CANDIDATE_FINGERPRINT_MISSING');
  });

  it('replays source terminal identities and retains identity drift failures', async () => {
    const { candidate } = await loadStagedCandidate();
    const store = createMemoryPdfBacktestStore();
    const source = row('replay-source', {
      sourceKey: 'replay/source.pdf',
      expectedSourceIdentity: { etag: 'source-v1' },
    });
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([source]),
      store,
      parsers: parsers(),
      reader: {
        async getObjectBounded() {
          return {
            body: PDF_BYTES,
            contentType: 'application/pdf',
            identity: { etag: 'source-v1' },
          };
        },
      },
    });

    const replay = await runReplayPdfInspectorBacktest({
      runId: RUN_ID_2,
      replayRunId: RUN_ID,
      store,
      candidate,
      dependencies: {
        assertNativeGate: async () => undefined,
        toolVersions: CANDIDATE_TOOL_VERSIONS,
        parsers: parsers(),
        reader: {
          async getObjectBounded() {
            return {
              body: PDF_BYTES,
              contentType: 'application/pdf',
              identity: { etag: 'source-v2' },
            };
          },
        },
      },
    });

    expect((await store.readManifest(RUN_ID_2))[0]?.expectedSourceIdentity).toEqual({
      etag: 'source-v1',
    });
    expect(replay.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.identityDrift);
    expect((await store.readTerminalResults(RUN_ID_2))[0]).toMatchObject({
      status: 'identity_drift',
      candidateFingerprint: candidate.implementationFingerprint,
    });
  });

  it('blocks candidate replay when its native gate is absent', async () => {
    const { candidate } = await loadStagedCandidate();
    const store = createMemoryPdfBacktestStore();
    const source = row('replay-gate', {
      sourceKey: 'replay/gate.pdf',
      expectedSourceIdentity: { etag: 'source-v1' },
    });
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([source]),
      store,
      parsers: parsers(),
      reader: {
        async getObjectBounded() {
          return {
            body: PDF_BYTES,
            contentType: 'application/pdf',
            identity: { etag: 'source-v1' },
          };
        },
      },
    });

    const result = await runReplayPdfInspectorBacktest({
      runId: RUN_ID_2,
      replayRunId: RUN_ID,
      store,
      candidate,
      dependencies: {
        parsers: parsers(),
        reader: {
          async getObjectBounded() {
            return {
              body: PDF_BYTES,
              contentType: 'application/pdf',
              identity: { etag: 'source-v1' },
            };
          },
        },
      },
    });

    expect(result).toMatchObject({
      exitCode: PDF_BACKTEST_EXIT_CODES.dependencyBlocked,
      privateErrors: ['CANDIDATE_NATIVE_GATE_REQUIRED'],
    });
  });

  it('fails closed when candidate replay cannot report required tool versions', async () => {
    const { candidate } = await loadStagedCandidate();
    const store = createMemoryPdfBacktestStore();
    const source = row('replay-tool-versions', {
      sourceKey: 'replay/tool-versions.pdf',
      expectedSourceIdentity: { etag: 'source-v1' },
    });
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([source]),
      store,
      parsers: parsers(),
      reader: {
        async getObjectBounded() {
          return {
            body: PDF_BYTES,
            contentType: 'application/pdf',
            identity: { etag: 'source-v1' },
          };
        },
      },
    });

    const result = await runReplayPdfInspectorBacktest({
      runId: RUN_ID_2,
      replayRunId: RUN_ID,
      store,
      candidate,
      dependencies: {
        assertNativeGate: async () => undefined,
        parsers: parsers(),
        reader: createFixtureObjectReader(fixture([source])),
      },
    });

    expect(result).toMatchObject({
      exitCode: PDF_BACKTEST_EXIT_CODES.dependencyBlocked,
      privateErrors: ['CANDIDATE_TOOL_VERSIONS_UNAVAILABLE'],
    });
  });

  it('records verified candidate runtime and actual supplied tool versions after gate pass', async () => {
    const { candidate } = await loadStagedCandidate();
    const store = createMemoryPdfBacktestStore();
    const source = row('replay-runtime-verified', {
      sourceKey: 'replay/runtime-verified.pdf',
      expectedSourceIdentity: { etag: 'source-v1' },
    });
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([source]),
      store,
      parsers: parsers(),
      reader: {
        async getObjectBounded() {
          return {
            body: PDF_BYTES,
            contentType: 'application/pdf',
            identity: { etag: 'source-v1' },
          };
        },
      },
    });
    let gatePassed = false;
    const result = await runReplayPdfInspectorBacktest({
      runId: RUN_ID_2,
      replayRunId: RUN_ID,
      store,
      candidate,
      dependencies: {
        assertNativeGate: async () => {
          gatePassed = true;
        },
        toolVersions: CANDIDATE_TOOL_VERSIONS,
        parsers: parsers(),
        reader: {
          async getObjectBounded() {
            return {
              body: PDF_BYTES,
              contentType: 'application/pdf',
              identity: { etag: 'source-v1' },
            };
          },
        },
      },
    });

    expect(gatePassed).toBe(true);
    expect(result.report).toMatchObject({
      toolVersions: CANDIDATE_TOOL_VERSIONS,
    });
    expect((await store.readTerminalResults(RUN_ID_2))[0]).toMatchObject({
      candidateFingerprint: candidate.implementationFingerprint,
    });
  });

  it('records replay SHA-256 drift even when source identity and size match', async () => {
    const { candidate } = await loadStagedCandidate();
    const store = createMemoryPdfBacktestStore();
    const source = row('replay-sha', {
      sourceKey: 'replay/sha.pdf',
      expectedSourceIdentity: { etag: 'source-v1' },
    });
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([source]),
      store,
      parsers: parsers(),
      reader: {
        async getObjectBounded() {
          return {
            body: PDF_BYTES,
            contentType: 'application/pdf',
            identity: { etag: 'source-v1' },
          };
        },
      },
    });
    const swapped = Buffer.from(PDF_BYTES);
    swapped[swapped.byteLength - 1] ^= 1;

    const replay = await runReplayPdfInspectorBacktest({
      runId: RUN_ID_2,
      replayRunId: RUN_ID,
      store,
      candidate,
      dependencies: {
        assertNativeGate: async () => undefined,
        toolVersions: CANDIDATE_TOOL_VERSIONS,
        parsers: parsers(),
        reader: {
          async getObjectBounded() {
            return {
              body: swapped,
              contentType: 'application/pdf',
              identity: { etag: 'source-v1' },
            };
          },
        },
      },
    });

    expect(replay.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.identityDrift);
    expect((await store.readManifest(RUN_ID_2))[0]).toMatchObject({
      expectedSourceIdentity: { etag: 'source-v1' },
      sourceFingerprint: createHash('sha256').update(PDF_BYTES).digest('hex'),
    });
    expect((await store.readTerminalResults(RUN_ID_2))[0]).toMatchObject({
      status: 'identity_drift',
      failureCode: 'PDF_SOURCE_SHA256_DRIFT',
    });
  });

  it('replays legacy live manifests from their terminal source identity and hash', async () => {
    const { candidate } = await loadStagedCandidate();
    const memoryStore = createMemoryPdfBacktestStore();
    const source = row('replay-legacy-live-manifest', {
      sourceKey: 'replay/legacy-live-manifest.pdf',
    });
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([source]),
      store: memoryStore,
      parsers: parsers(),
      reader: {
        async getObjectBounded() {
          return {
            body: PDF_BYTES,
            contentType: 'application/pdf',
            identity: { etag: 'source-v1' },
          };
        },
      },
    });
    const legacyManifest = (await memoryStore.readManifest(RUN_ID)).map(
      ({ expectedSourceIdentity: _, ...manifest }) => ({
        ...manifest,
        sourceFingerprint: createHash('sha256').update('').digest('hex'),
      }),
    );
    const store: PdfBacktestRunStore = {
      writeManifest: memoryStore.writeManifest,
      readManifest: async (runId) =>
        runId === RUN_ID ? legacyManifest : memoryStore.readManifest(runId),
      appendTerminalResult: memoryStore.appendTerminalResult,
      bindCandidateFingerprint: memoryStore.bindCandidateFingerprint,
      readTerminalResults: memoryStore.readTerminalResults,
      readPrivate: memoryStore.readPrivate,
      markComplete: memoryStore.markComplete,
    };

    const replay = await runReplayPdfInspectorBacktest({
      runId: RUN_ID_2,
      replayRunId: RUN_ID,
      store,
      candidate,
      dependencies: {
        assertNativeGate: async () => undefined,
        toolVersions: CANDIDATE_TOOL_VERSIONS,
        parsers: parsers(),
        reader: {
          async getObjectBounded() {
            return {
              body: PDF_BYTES,
              contentType: 'application/pdf',
              identity: { etag: 'source-v1' },
            };
          },
        },
      },
    });

    expect(replay.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.success);
    expect((await store.readManifest(RUN_ID_2))[0]).toMatchObject({
      expectedSourceIdentity: { etag: 'source-v1' },
      sourceFingerprint: createHash('sha256').update(PDF_BYTES).digest('hex'),
    });
  });

  it('rejects a replay source that already terminated with identity drift', async () => {
    const { candidate } = await loadStagedCandidate();
    const store = createMemoryPdfBacktestStore();
    const source = row('replay-source-terminal-drift', {
      sourceKey: 'replay/source-terminal-drift.pdf',
      expectedSourceIdentity: { etag: 'source-v1' },
    });
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([source]),
      store,
      parsers: parsers(),
      reader: {
        async getObjectBounded() {
          return {
            body: PDF_BYTES,
            contentType: 'application/pdf',
            identity: { etag: 'source-v2' },
          };
        },
      },
    });

    await expect(
      runReplayPdfInspectorBacktest({
        runId: RUN_ID_2,
        replayRunId: RUN_ID,
        store,
        candidate,
      }),
    ).rejects.toThrow('PDF_BACKTEST_REPLAY_SOURCE_IDENTITY_DRIFT');
  });

  it('rejects source replay terminals without a completed comparison outcome', async () => {
    const { candidate } = await loadStagedCandidate();
    const source = row('replay-missing-outcome', {
      sourceKey: 'replay/missing-outcome.pdf',
      expectedSourceIdentity: { etag: 'source-v1' },
    });
    const recordRef = `pdf-${createHash('sha256')
      .update(`attachment:${source.attachmentId}`)
      .digest('hex')
      .slice(0, 32)}`;
    const store = {
      hasRun: async () => true,
      readManifest: async () => [source],
      readTerminalResults: async () => [
        {
          schema: 'pdf_inspector_backtest_terminal_v1' as const,
          runId: RUN_ID,
          recordRef,
          attachmentId: source.attachmentId,
          status: 'completed' as const,
          sourceSha256: createHash('sha256').update(PDF_BYTES).digest('hex'),
          sourceIdentity: { etag: 'source-v1' },
          finishedAt: '2026-08-08T12:00:00.000Z',
        },
      ],
    } as unknown as PdfBacktestRunStore;

    await expect(
      runReplayPdfInspectorBacktest({
        runId: RUN_ID_2,
        replayRunId: RUN_ID,
        store,
        candidate,
      }),
    ).rejects.toThrow('PDF_BACKTEST_REPLAY_SOURCE_TERMINAL_OUTCOME_MISSING');
  });

  it('rejects source replay terminals with an invalid source SHA-256', async () => {
    const { candidate } = await loadStagedCandidate();
    const source = row('replay-invalid-source-sha', {
      sourceKey: 'replay/invalid-source-sha.pdf',
      expectedSourceIdentity: { etag: 'source-v1' },
    });
    const recordRef = `pdf-${createHash('sha256')
      .update(`attachment:${source.attachmentId}`)
      .digest('hex')
      .slice(0, 32)}`;
    const store = {
      hasRun: async () => true,
      readManifest: async () => [source],
      readTerminalResults: async () => [
        {
          schema: 'pdf_inspector_backtest_terminal_v1' as const,
          runId: RUN_ID,
          recordRef,
          attachmentId: source.attachmentId,
          status: 'completed' as const,
          sourceSha256: 'not-a-sha',
          sourceIdentity: { etag: 'source-v1' },
          comparison: {},
          finishedAt: '2026-08-08T12:00:00.000Z',
        },
      ],
    } as unknown as PdfBacktestRunStore;

    await expect(
      runReplayPdfInspectorBacktest({
        runId: RUN_ID_2,
        replayRunId: RUN_ID,
        store,
        candidate,
      }),
    ).rejects.toThrow('PDF_BACKTEST_REPLAY_SOURCE_SHA256_INVALID');
  });

  it('strictly parses fixture rows and rejects forbidden row fields', () => {
    const parsed = parsePdfInspectorBacktestFixture(fixture());
    expect(parsed.rows).toHaveLength(1);
    expect(() =>
      parsePdfInspectorBacktestFixture({
        ...fixture(),
        rows: [{ ...fixture().rows[0], subject: 'forbidden' }],
      }),
    ).toThrow(/unrecognized|subject|strict/i);
  });

  it('validates inbound non-inline PDF metadata and size bounds', () => {
    expect(() =>
      parsePdfInspectorBacktestFixture(
        fixture([row('outbound', { direction: 'outbound' })]),
      ),
    ).toThrow(/inbound|direction/i);
    expect(() =>
      parsePdfInspectorBacktestFixture(
        fixture([row('inline', { isInline: true })]),
      ),
    ).toThrow(/inline/i);
    const oversizedMetadata = parsePdfInspectorBacktestFixture(
      fixture([
        row('too-large', {
          sizeBytes: PDF_INSPECTOR_BACKTEST_MAX_INPUT_BYTES + 1,
        }),
      ]),
    );
    expect(oversizedMetadata.rows[0]?.sizeBytes).toBe(
      PDF_INSPECTOR_BACKTEST_MAX_INPUT_BYTES + 1,
    );
  });

  it('dedupes attachment IDs and orders manifest oldest-first', async () => {
    const store = createMemoryPdfBacktestStore();
    const result = await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([
        row('later', { createdAt: '2026-08-08T12:00:00.000Z' }),
        row('duplicate', { createdAt: '2026-08-08T09:00:00.000Z' }),
        row('duplicate', { createdAt: '2026-08-08T09:00:00.000Z' }),
        row('earlier', { createdAt: '2026-08-08T08:00:00.000Z' }),
      ]),
      store,
      parsers: parsers(),
    });
    expect(result.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.success);
    expect((await store.readManifest(RUN_ID)).map((item) => item.attachmentId)).toEqual([
      'earlier',
      'duplicate',
      'later',
    ]);
  });

  it('passes identical Buffer bytes to both parser functions', async () => {
    const seen: Buffer[] = [];
    const result = await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture(),
      store: createMemoryPdfBacktestStore(),
      parsers: parsers({ seenBytes: seen }),
    });
    expect(result.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.success);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(PDF_BYTES);
    expect(seen[1]).toEqual(PDF_BYTES);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('adapts production Poppler and Inspector parsers through injected sandboxes', async () => {
    const defaultParsers = createDefaultPdfBacktestParsers({
      sandboxRunner: async (tool) =>
        tool === 'pdfinfo'
          ? {
              stdout: Buffer.from('Pages: 1\nEncrypted: no\n'),
              stderr: Buffer.alloc(0),
              exitCode: 0,
            }
          : {
              stdout: Buffer.from('fixture-text'),
              stderr: Buffer.alloc(0),
              exitCode: 0,
            },
      runChild: async () => ({
        stdout: Buffer.from(
          JSON.stringify({
            status: 'ok',
            reason: 'text',
            pageCount: 1,
            markdown: '# fixture-text',
            pdfType: 'TextBased',
            confidence: 0.99,
            pagesNeedingOcr: [],
            pagesWithTables: [],
            pagesWithColumns: [],
            isComplexLayout: false,
            hasEncodingIssues: false,
          }),
        ),
        stderr: Buffer.alloc(0),
        exitCode: 0,
        signal: null,
        outputLimitExceeded: false,
      }),
    });
    const input = {
      bytes: PDF_BYTES,
      row: row('production-adapter'),
      sourceRef: 'pdf-production-adapter',
      signal: new AbortController().signal,
    };
    const [poppler, inspector] = await Promise.all([
      defaultParsers.poppler(input),
      defaultParsers.inspector(input),
    ]);
    expect(poppler).toMatchObject({
      status: 'ok',
      reason: 'text',
      text: 'fixture-text',
    });
    expect(inspector).toMatchObject({
      status: 'ok',
      reason: 'text',
      text: '# fixture-text',
      diagnostics: { pdfType: 'TextBased' },
    });
  });

  it('uses one bounded GetObject fetch per attachment and resumes missing only', async () => {
    const calls: string[] = [];
    const baseReader = createFixtureObjectReader(fixture());
    const reader: PdfBacktestObjectReader = {
      async getObjectBounded(key, maxBytes, signal) {
        calls.push(`${key}:${maxBytes}:${signal?.aborted ?? false}`);
        return baseReader.getObjectBounded(key, maxBytes, signal);
      },
    };
    const store = createMemoryPdfBacktestStore();
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([
        row('one'),
        row('two', { createdAt: '2026-08-08T11:00:00.000Z' }),
      ]),
      store,
      reader,
      parsers: parsers(),
    });
    const firstCount = calls.length;
    expect(firstCount).toBe(2);
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([
        row('one'),
        row('two', { createdAt: '2026-08-08T11:00:00.000Z' }),
        row('three', { createdAt: '2026-08-08T12:00:00.000Z' }),
      ]),
      store,
      reader,
      parsers: parsers(),
    });
    expect(calls).toHaveLength(firstCount + 1);
    expect(calls.at(-1)).toContain('three');
  });

  it.each([
    ['missing object', async () => null, /missing|object/i],
    [
      'declared size mismatch',
      async () => ({ body: PDF_BYTES, contentType: 'application/pdf' }),
      /size|length/i,
    ],
    [
      'content type mismatch',
      async () => ({
        body: PDF_BYTES,
        contentType: 'application/octet-stream',
      }),
      /content|mime|type/i,
    ],
  ])('records bounded reader failure: %s', async (_name, getObject, errorPattern) => {
    const rowValue = row('bad', {
      sizeBytes: PDF_BYTES.byteLength + (_name === 'declared size mismatch' ? 1 : 0),
    });
    const result = await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([rowValue]),
      store: createMemoryPdfBacktestStore(),
      reader: { getObjectBounded: getObject },
      parsers: parsers(),
    });
    expect(result.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.success);
    expect(result.accounting.terminalCount).toBe(1);
    expect(result.privateErrors[0]).toMatch(errorPattern);
  });

  it('bounds oversize objects and rejects non-PDF bytes before parser execution', async () => {
    const counts = { poppler: 0, inspector: 0 };
    const huge = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.alloc(PDF_INSPECTOR_BACKTEST_MAX_INPUT_BYTES + 1),
    ]);
    const oversized = await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([row('oversized')], { bytes: huge }),
      store: createMemoryPdfBacktestStore(),
      parsers: parsers({ counts }),
    });
    expect(oversized.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.success);
    expect(counts).toEqual({ poppler: 0, inspector: 0 });
    expect(oversized.privateErrors[0]).toMatch(/large|size/i);

    const nonPdf = await runFixtureBacktest({
      runId: RUN_ID_2,
      fixture: fixture([row('non-pdf')], { bytes: Buffer.from('not pdf') }),
      store: createMemoryPdfBacktestStore(),
      parsers: parsers({ counts }),
    });
    expect(nonPdf.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.success);
    expect(counts).toEqual({ poppler: 0, inspector: 0 });
    expect(nonPdf.privateErrors[0]).toMatch(/pdf|header|malformed/i);
  });

  it('records private SHA-256 source identity while aggregate stays opaque', async () => {
    const store = createMemoryPdfBacktestStore();
    const result = await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture(),
      store,
      parsers: parsers(),
    });
    const records = await store.readTerminalResults(RUN_ID);
    expect(records[0]?.sourceSha256).toBe(
      createHash('sha256').update(PDF_BYTES).digest('hex'),
    );
    expect(JSON.stringify(result.report)).not.toContain('sourceRef');
    expect(JSON.stringify(result.report)).not.toContain(PRIVATE_TEXT);
    expect(JSON.stringify(result.report)).not.toContain('attachment-1');
  });

  it('counts overlapping full-corpus and runtime-subset membership', async () => {
    const result = await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([
        row('overlap', {
          scopeMembership: {
            full_corpus: true,
            current_runtime_subset: true,
          },
        }),
      ]),
      store: createMemoryPdfBacktestStore(),
      parsers: parsers(),
    });
    expect(result.report.scopeDenominators).toEqual({
      full_corpus: { eligible: 1, attempted: 1, unprocessed: 0 },
      current_runtime_subset: { eligible: 1, attempted: 1, unprocessed: 0 },
    });
  });

  it('persists private adjudications and includes them in resumed reports', async () => {
    const store = createMemoryPdfBacktestStore();
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture(),
      store,
      parsers: parsers(),
    });
    const terminal = (await store.readTerminalResults(RUN_ID))[0]!;
    const adjudication = {
      schema: PDF_BACKTEST_ADJUDICATION_SCHEMA,
      runId: RUN_ID,
      recordRef: terminal.recordRef,
      adjudication: {
        sourceRef: terminal.recordRef,
        label: 'equivalent' as const,
        rationaleCodes: ['normalized_match' as const],
      },
      adjudicatedAt: '2026-08-08T12:00:00.000Z',
    };

    await store.appendAdjudication!(RUN_ID, adjudication);
    expect(await store.readAdjudications!(RUN_ID)).toEqual([adjudication]);

    const resumed = await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture(),
      store,
      parsers: parsers(),
    });
    expect(resumed.report?.counts.byAdjudication.equivalent).toBe(1);
    await expect(
      store.appendAdjudication!(RUN_ID, {
        ...adjudication,
        adjudication: {
          ...adjudication.adjudication,
          label: 'poppler_better',
          rationaleCodes: ['poppler_has_more_text'],
        },
      }),
    ).rejects.toThrow(/identity|adjudication/i);
  });

  it('marks fixture provenance backtest-only so recommendation stays blocked', async () => {
    const result = await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture(),
      store: createMemoryPdfBacktestStore(),
      parsers: parsers(),
    });
    expect(result.report.recommendation).toEqual({
      parser: 'poppler',
      state: 'blocked',
      reasonCode: 'ADJUDICATION_INCOMPLETE',
    });
  });

  it('returns incomplete accounting when terminal record is missing', async () => {
    const store = createMemoryPdfBacktestStore();
    const result = await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([row('missing')]),
      store,
      parsers: parsers(),
      skipMissing: true,
    });
    expect(result.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.incompleteTerminalAccounting);
    expect(await summarizePdfBacktestStatus(RUN_ID, store)).toEqual({
      manifestCount: 1,
      terminalCount: 0,
      missingCount: 1,
      identityDriftCount: 0,
      complete: false,
    });
  });

  it('marks identity drift terminal and never reruns same record reference', async () => {
    const store = createMemoryPdfBacktestStore();
    const first = await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([
        {
          ...row('drift'),
          sourceIdentity: { etag: 'old-etag' },
        },
      ]),
      store,
      parsers: parsers(),
      reader: {
        async getObjectBounded() {
          return {
            body: PDF_BYTES,
            contentType: 'application/pdf',
            identity: { etag: 'new-etag' },
          };
        },
      },
    });
    expect(first.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.identityDrift);
    expect(first.report?.scopeDenominators.full_corpus.attempted).toBe(1);
    expect(first.report?.counts.byReason.poppler.parser_failure).toBe(1);
    const counts = { poppler: 0, inspector: 0 };
    const second = await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture([
        {
          ...row('drift'),
          sourceIdentity: { etag: 'old-etag' },
        },
      ]),
      store,
      parsers: parsers({ counts }),
    });
    expect(second.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.identityDrift);
    expect(counts).toEqual({ poppler: 0, inspector: 0 });
    await expect(
      runFixtureBacktest({
        runId: RUN_ID,
        fixture: fixture([
          {
            ...row('drift'),
            sourceIdentity: { etag: 'changed-again' },
          },
        ]),
        store,
        parsers: parsers({ counts }),
      }),
    ).rejects.toThrow('PDF_BACKTEST_MANIFEST_IDENTITY_DRIFT');
  });

  it('rejects unsafe file-store paths and creates owner-only run files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-backtest-runner-'));
    const store = createPdfBacktestFileStore(root);
    await expect(store.writeManifest('../escape', [])).rejects.toThrow(/uuid|path/i);
    await store.writeManifest(RUN_ID, [row('safe')]);
    const runDir = join(root, RUN_ID);
    const manifestStat = await lstat(join(runDir, 'manifest.jsonl'));
    expect(manifestStat.isSymbolicLink()).toBe(false);
    if (process.platform !== 'win32') {
      expect(lstat).toBeDefined();
      expect((await lstat(runDir)).mode & 0o777).toBe(0o700);
      expect(manifestStat.mode & 0o777).toBe(0o600);
    }
    const text = await readFile(join(runDir, 'manifest.jsonl'), 'utf8');
    expect(text).not.toContain('subject');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects symlinked private store roots',
    async () => {
      const parent = await mkdtemp(join(tmpdir(), 'pdf-backtest-symlink-'));
      const realRoot = join(parent, 'real');
      const linkRoot = join(parent, 'link');
      await mkdir(realRoot);
      await symlink(realRoot, linkRoot, 'junction');
      expect(() => createPdfBacktestFileStore(linkRoot)).toThrow(/symlink/i);
    },
  );

  it('purges expired completed runs without exposing private records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-backtest-expiry-'));
    const store = createPdfBacktestFileStore(root, {
      ttlMs: 1,
      now: () => new Date('2026-08-08T10:00:00.000Z'),
    });
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture(),
      store,
      parsers: parsers(),
      now: () => new Date('2026-08-08T10:00:00.000Z'),
    });
    const purged = await purgeExpiredPdfBacktestRuns(
      root,
      new Date('2026-08-08T10:00:00.002Z'),
    );
    expect(purged).toBe(1);
  });

  it('status and show-private enforce aggregate/private output split', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-backtest-cli-'));
    const store = createPdfBacktestFileStore(root);
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture(),
      store,
      parsers: parsers(),
    });
    const status = await executePdfInspectorBacktestCommand(
      ['--status', RUN_ID],
      { root },
    );
    expect(status.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.success);
    expect(status.stdout).not.toContain('attachment-1');
    expect(status.stdout).not.toContain('sourceRef');

    const privateRecord = (await store.readTerminalResults(RUN_ID))[0]!;
    const shown = await executePdfInspectorBacktestCommand(
      ['--show-private', RUN_ID, privateRecord.recordRef],
      { root },
    );
    expect(shown.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.success);
    expect(shown.stdout).toContain(PRIVATE_TEXT);
    expect(shown.stdout).toContain(privateRecord.recordRef);
  });

  it('fixture CLI emits aggregate-only ASCII-safe JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pdf-backtest-fixture-cli-'));
    const fixturePath = join(root, 'fixture.json');
    await writeFile(
      fixturePath,
      JSON.stringify(
        fixture([row('cli')], {
          outcomes: {
            cli: {
              poppler: parserResult('poppler'),
              inspector: parserResult('inspector'),
            },
          },
        }),
      ),
      'utf8',
    );
    const result = await executePdfInspectorBacktestCommand(
      ['--fixture', fixturePath, '--run-id', RUN_ID],
      { root },
    );
    expect(result.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.success);
    expect(result.stdout).toContain('"report"');
    expect(result.stdout).not.toContain('sourceRef');
    expect(result.stdout).not.toContain(PRIVATE_TEXT);
    expect(result.stdout).not.toMatch(/\P{ASCII}/u);
  });

  it('fails closed for live mode when read-only prerequisites are absent', async () => {
    const result = await executePdfInspectorBacktestCommand(
      ['--live', '--run-id', RUN_ID],
      { root: await mkdtemp(join(tmpdir(), 'pdf-backtest-live-')) },
    );
    expect(result.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.dependencyBlocked);
    expect(result.stdout).not.toContain('DATABASE_URL');
    expect(result.stderr).toContain('LIVE_PREREQUISITES_UNAVAILABLE');
  });

  it('does not synthesize an empty SHA-256 from live manifest placeholder bytes', async () => {
    const result = await runLivePdfInspectorBacktest({
      runId: RUN_ID,
      store: createMemoryPdfBacktestStore(),
      dependencies: {
        async openReadOnlySnapshot() {
          return {
            transactionReadOnly: true,
            isolationLevel: 'repeatable read',
            statementTimeoutMs: 1,
            projectedOnly: true,
            runtimeSubsetDerived: true,
            mailboxGrantVerified: true,
            rows: [
              row('live-placeholder', {
                sourceKey: 'live-placeholder.pdf',
                expectedSourceIdentity: { etag: 'live-v1' },
              }),
            ],
            sourceKeys: new Map([['live-placeholder', 'live-placeholder.pdf']]),
            expectedIdentities: new Map([
              ['live-placeholder', { etag: 'live-v1' }],
            ]),
          };
        },
        reader: {
          async getObjectBounded() {
            return {
              body: PDF_BYTES,
              contentType: 'application/pdf',
              identity: { etag: 'live-v1' },
            };
          },
        },
        parsers: parsers(),
        assertNativeGate: async () => {},
        packageVersions: { pdfInspector: '1.12.0' },
        toolVersions: CANDIDATE_TOOL_VERSIONS,
      },
    });

    expect(result.exitCode).toBe(PDF_BACKTEST_EXIT_CODES.success);
    expect(result.privateErrors).not.toContain('PDF_SOURCE_SHA256_DRIFT');
  });

  it('persists fixture source fingerprint only in private manifest', async () => {
    const store = createMemoryPdfBacktestStore();
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture(),
      store,
      parsers: parsers(),
    });
    const manifest = await store.readManifest(RUN_ID);
    expect(manifest[0]?.sourceFingerprint).toBe(
      createHash('sha256').update(PDF_BYTES).digest('hex'),
    );
  });

  it('rejects conflicting duplicate attachment metadata', () => {
    expect(() =>
      validatePdfBacktestManifestRows([
        row('duplicate'),
        row('duplicate', { threadId: 'different-thread' }),
      ]),
    ).toThrow('PDF_BACKTEST_CONFLICTING_DUPLICATE_ATTACHMENT');
  });

  it('rejects parser text over UTF-8 output bound', () => {
    const value = fixture([row('large-text')], {
      outcomes: {
        'large-text': {
          poppler: parserResult('poppler', { text: '😀'.repeat(65_537) }),
          inspector: parserResult('inspector'),
        },
      },
    });
    expect(() => parsePdfInspectorBacktestFixture(value)).toThrow(/256 KiB/u);
  });

  it('rejects parser page counts above native bound', () => {
    const value = fixture([row('many-pages')], {
      outcomes: {
        'many-pages': {
          poppler: parserResult('poppler', { pageCount: 51 }),
          inspector: parserResult('inspector'),
        },
      },
    });
    expect(() => parsePdfInspectorBacktestFixture(value)).toThrow(/too_big|50/u);
  });

  it('rejects negative parser elapsed time', () => {
    const value = fixture([row('negative-elapsed')], {
      outcomes: {
        'negative-elapsed': {
          poppler: parserResult('poppler', { elapsedMs: -1 }),
          inspector: parserResult('inspector'),
        },
      },
    });
    expect(() => parsePdfInspectorBacktestFixture(value)).toThrow(/greater|negative/u);
  });

  it('rejects terminal records bound to another run', async () => {
    const store = createMemoryPdfBacktestStore();
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture(),
      store,
      parsers: parsers(),
    });
    const result = (await store.readTerminalResults(RUN_ID))[0]!;
    await expect(
      store.appendTerminalResult(RUN_ID, { ...result, runId: RUN_ID_2 }),
    ).rejects.toThrow('PDF_BACKTEST_TERMINAL_RUN_ID_MISMATCH');
  });

  it('rejects terminal records with mismatched source refs', async () => {
    const store = createMemoryPdfBacktestStore();
    await runFixtureBacktest({
      runId: RUN_ID,
      fixture: fixture(),
      store,
      parsers: parsers(),
    });
    const result = (await store.readTerminalResults(RUN_ID))[0]!;
    await expect(
      store.appendTerminalResult(RUN_ID, { ...result, recordRef: 'pdf-unknown' }),
    ).rejects.toThrow('PDF_BACKTEST_TERMINAL_SOURCE_REF_MISMATCH');
  });

  it('does not count unknown terminal refs as complete', async () => {
    const fakeStore = {
      hasRun: async () => true,
      readManifest: async () => [row('known')],
      readTerminalResults: async () => [
        {
          recordRef: 'pdf-unknown',
          status: 'completed',
        },
      ],
    } as unknown as PdfBacktestRunStore;
    const status = await summarizePdfBacktestStatus(RUN_ID, fakeStore);
    expect(status.complete).toBe(false);
    expect(status.missingCount).toBe(1);
  });
});
