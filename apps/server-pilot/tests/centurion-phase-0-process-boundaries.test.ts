import * as analysisWorkspace from '../src/ops/centurion-thread-corpus-analysis-workspace.js';
import * as relayReceiver from '../src/ops/centurion-thread-corpus-relay-receiver.js';
import * as relayProducer from '../src/ops/centurion-thread-corpus-relay-producer.js';
import * as readiness from '../scripts/check-centurion-thread-corpus-readiness.js';
import * as liveExport from '../scripts/export-centurion-thread-corpus-live.js';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type ProcessSource = {
  path: string;
  adapters: ReadonlySet<string>;
  constants: Readonly<Record<string, string>>;
  processApi?: 'spawn' | 'spawnSync';
};

const PROCESS_SOURCES: readonly ProcessSource[] = [
  {
    path: 'scripts/export-centurion-thread-corpus-live.ts',
    adapters: new Set(['Ec2GitIgnoreProcessAdapter']),
    constants: { EC2_GIT: '/usr/bin/git' },
  },
  {
    path: 'scripts/check-centurion-thread-corpus-readiness.ts',
    adapters: new Set(['Ec2GitProcessAdapter', 'Ec2AwsProcessAdapter']),
    constants: {
      EC2_GIT: '/usr/bin/git',
      EC2_AWS: '/usr/local/bin/aws',
    },
  },
  {
    path: 'src/ops/centurion-thread-corpus-relay-producer.ts',
    adapters: new Set(['Ec2GitProcessAdapter']),
    constants: { EC2_GIT: '/usr/bin/git' },
  },
  {
    path: 'src/ops/centurion-thread-corpus-relay-receiver.ts',
    adapters: new Set(['WindowsPrivateAclProcessAdapter', 'WindowsGitIgnoreProcessAdapter']),
    constants: {
      WINDOWS_POWERSHELL: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      WINDOWS_GIT: 'C:\\Program Files\\Git\\cmd\\git.exe',
    },
  },
  {
    path: 'src/ops/centurion-thread-corpus-analysis-workspace.ts',
    adapters: new Set(['WindowsGitIgnoreProcessAdapter']),
    constants: {
      WINDOWS_GIT: 'C:\\Program Files\\Git\\cmd\\git.exe',
    },
  },
  {
    path: 'src/mail/artifacts/read-artifact.ts',
    adapters: new Set(['PdfSandboxProcessAdapter']),
    processApi: 'spawn',
    constants: {
      LINUX_BWRAP: '/usr/bin/bwrap',
      LINUX_PDFINFO: '/usr/bin/pdfinfo',
      LINUX_PDFTOTEXT: '/usr/bin/pdftotext',
      LINUX_PRLIMIT: '/usr/bin/prlimit',
    },
  },
];

const PHASE_ZERO_FILES = [
  'src/ops/centurion-thread-corpus-readiness.ts',
  'scripts/check-centurion-thread-corpus-readiness.ts',
  'src/ops/centurion-thread-corpus-relay.ts',
  'src/ops/centurion-thread-corpus-relay-producer.ts',
  'src/ops/centurion-thread-corpus-relay-finalizer.ts',
  'src/ops/centurion-thread-corpus-relay-receiver.ts',
  'scripts/stage-centurion-thread-corpus-relay.ts',
  'scripts/finalize-centurion-thread-corpus-relay.ts',
  'scripts/receive-centurion-thread-corpus-relay.ts',
  'src/ops/centurion-thread-corpus-analysis.ts',
  'src/ops/centurion-thread-corpus-evidence.ts',
  'src/ops/centurion-thread-corpus-analysis-workspace.ts',
  'scripts/analyze-centurion-thread-corpus.ts',
  'scripts/export-thread-corpus.ts',
  'src/ops/centurion-thread-corpus-exporter.ts',
  'src/ops/centurion-thread-corpus-hydrator.ts',
  'src/mail/artifacts/read-artifact.ts',
  'src/ops/centurion-thread-corpus-postgres-reader.ts',
  'src/storage/s3.ts',
  'scripts/export-centurion-thread-corpus-live.ts',
  'tests/centurion-thread-corpus-readiness.test.ts',
  'tests/check-centurion-thread-corpus-readiness.test.ts',
  'tests/centurion-thread-corpus-relay.test.ts',
  'tests/centurion-thread-corpus-relay-producer.test.ts',
  'tests/centurion-thread-corpus-relay-finalizer.test.ts',
  'tests/centurion-thread-corpus-relay-receiver.test.ts',
  'tests/centurion-thread-corpus-analysis.test.ts',
  'tests/centurion-thread-corpus-evidence.test.ts',
  'tests/analyze-centurion-thread-corpus.test.ts',
  'tests/centurion-thread-corpus-postgres-reader.test.ts',
  'tests/centurion-thread-corpus-hydrator.test.ts',
  'tests/hms-artifact.test.ts',
  'tests/centurion-thread-corpus-exporter.test.ts',
  'tests/export-centurion-thread-corpus-live.test.ts',
  'tests/centurion-phase-0-process-boundaries.test.ts',
] as const;

const CHILD_PROCESS_CALLS = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]);
const LINUX_GIT_ENV = {
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_KEY_1: 'core.hooksPath',
  GIT_CONFIG_KEY_2: 'core.excludesFile',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_VALUE_1: '/dev/null',
  GIT_CONFIG_VALUE_2: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
} as const;
const WINDOWS_GIT_ENV = {
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_GLOBAL: 'NUL',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_KEY_1: 'core.hooksPath',
  GIT_CONFIG_KEY_2: 'core.excludesFile',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_VALUE_1: 'NUL',
  GIT_CONFIG_VALUE_2: 'NUL',
  GIT_OPTIONAL_LOCKS: '0',
} as const;

type DynamicModule = Record<string, unknown>;

function collect<T extends ts.Node>(source: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function isChildProcessModuleSpecifier(expression: ts.Expression | undefined): boolean {
  return (
    expression !== undefined &&
    ts.isStringLiteral(expression) &&
    (expression.text === 'node:child_process' || expression.text === 'child_process')
  );
}

function isChildProcessRequire(expression: ts.Expression | undefined): boolean {
  return (
    expression !== undefined &&
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'require' &&
    expression.arguments.length === 1 &&
    isChildProcessModuleSpecifier(expression.arguments[0])
  );
}

function phaseZeroProgram(): ts.Program {
  const configPath = path.join(SERVER_ROOT, 'tsconfig.centurion-phase-0.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as object;
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, SERVER_ROOT, undefined, configPath);
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function virtualProgram(sources: Readonly<Record<string, string>>): ts.Program {
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host = ts.createCompilerHost(options);
  const virtualSources = new Map(
    Object.entries(sources).map(([fileName, text]) => [
      path.resolve(fileName).replaceAll('\\', '/'),
      text,
    ]),
  );
  const textFor = (fileName: string): string | undefined =>
    virtualSources.get(path.resolve(fileName).replaceAll('\\', '/'));
  return ts.createProgram({
    rootNames: [...virtualSources.keys()],
    options,
    host: {
      ...host,
      fileExists: (fileName) => textFor(fileName) !== undefined || host.fileExists(fileName),
      getSourceFile: (fileName, languageVersion) =>
        textFor(fileName) !== undefined
          ? ts.createSourceFile(
              fileName,
              textFor(fileName)!,
              languageVersion,
              true,
              ts.ScriptKind.TS,
            )
          : host.getSourceFile(fileName, languageVersion),
      readFile: (fileName) => textFor(fileName) ?? host.readFile(fileName),
    },
  });
}

function isProcessArgumentExpression(argument: ts.Expression | undefined): boolean {
  if (
    argument &&
    ts.isPropertyAccessExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    (argument.expression.text === 'invocation' || argument.expression.text === 'input') &&
    argument.name.text === 'args'
  ) {
    return true;
  }
  return (
    argument !== undefined &&
    ts.isArrayLiteralExpression(argument) &&
    argument.elements.every(
      (element) =>
        ts.isStringLiteral(element) ||
        (ts.isElementAccessExpression(element) &&
          ts.isPropertyAccessExpression(element.expression) &&
          ts.isIdentifier(element.expression.expression) &&
          (element.expression.expression.text === 'invocation' ||
            element.expression.expression.text === 'input') &&
          element.expression.name.text === 'args' &&
          ts.isNumericLiteral(element.argumentExpression)),
    )
  );
}

function enclosingClassName(node: ts.Node): string | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isClassDeclaration(current)) return current.name?.text ?? null;
  }
  return null;
}

function isExactStdio(value: ts.Expression | undefined): boolean {
  return (
    (value !== undefined && ts.isStringLiteral(value) && value.text === 'ignore') ||
    (value !== undefined &&
      ts.isArrayLiteralExpression(value) &&
      value.elements.length === 3 &&
      value.elements.every(
        (element, index) =>
          ts.isStringLiteral(element) &&
          (index === 1
            ? element.text === 'pipe'
            : element.text === 'ignore' || element.text === 'pipe'),
      ))
  );
}

function isAdapterMember(
  value: ts.Expression | undefined,
  property: 'env' | 'cwd' | 'signal',
): boolean {
  const direct =
    value !== undefined &&
    ts.isPropertyAccessExpression(value) &&
    ts.isIdentifier(value.expression) &&
    (value.expression.text === 'invocation' || value.expression.text === 'input') &&
    value.name.text === property;
  const nestedEnvironment =
    property === 'env' &&
    value !== undefined &&
    ts.isPropertyAccessExpression(value) &&
    value.name.text === 'env' &&
    ts.isPropertyAccessExpression(value.expression) &&
    ts.isIdentifier(value.expression.expression) &&
    value.expression.expression.text === 'invocation' &&
    value.expression.name.text === 'options';
  return direct || nestedEnvironment;
}

function hasExactProcessOptions(call: ts.CallExpression): boolean {
  const options = call.arguments[2];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  const properties = new Map<string, ts.Expression>();
  for (const property of options.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      ts.isComputedPropertyName(property.name) ||
      (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
    ) {
      return false;
    }
    const name = property.name.text;
    if (properties.has(name)) return false;
    properties.set(name, property.initializer);
  }
  const keys = [...properties.keys()].sort();
  const allowed = new Set([
    'cwd',
    'encoding',
    'env',
    'maxBuffer',
    'shell',
    'signal',
    'stdio',
    'windowsHide',
  ]);
  if (
    keys.some((key) => !allowed.has(key)) ||
    !properties.has('cwd') ||
    !properties.has('env') ||
    !properties.has('shell') ||
    !properties.has('stdio') ||
    !properties.has('windowsHide')
  ) {
    return false;
  }
  const shell = properties.get('shell');
  const cwd = properties.get('cwd');
  const env = properties.get('env');
  const windowsHide = properties.get('windowsHide');
  const encoding = properties.get('encoding');
  const maxBuffer = properties.get('maxBuffer');
  return (
    shell?.kind === ts.SyntaxKind.FalseKeyword &&
    isAdapterMember(env, 'env') &&
    (isAdapterMember(cwd, 'cwd') ||
      (cwd !== undefined && ts.isStringLiteral(cwd) && cwd.text === '/') ||
      (cwd !== undefined && ts.isIdentifier(cwd) && cwd.text === 'WINDOWS_SYSTEM32')) &&
    isExactStdio(properties.get('stdio')) &&
    windowsHide?.kind === ts.SyntaxKind.TrueKeyword &&
    (encoding === undefined || (ts.isStringLiteral(encoding) && encoding.text === 'utf8')) &&
    (maxBuffer === undefined || ts.isNumericLiteral(maxBuffer)) &&
    (properties.get('signal') === undefined || isAdapterMember(properties.get('signal'), 'signal'))
  );
}

function sourceRelativePath(source: ts.SourceFile): string {
  return path.relative(SERVER_ROOT, path.resolve(source.fileName)).split(path.sep).join('/');
}

function sourceIsWithinServerRoot(source: ts.SourceFile): boolean {
  const root = path.resolve(SERVER_ROOT).toLowerCase();
  const fileName = path.resolve(source.fileName).toLowerCase();
  return fileName === root || fileName.startsWith(`${root}${path.sep}`);
}

function runtimePhaseZeroSources(program: ts.Program): readonly ts.SourceFile[] {
  const sourcesByPath = new Map(
    program.getSourceFiles().map((source) => [path.resolve(source.fileName), source]),
  );
  const reachable = new Set<string>();
  const visit = (source: ts.SourceFile): void => {
    const resolvedPath = path.resolve(source.fileName);
    if (reachable.has(resolvedPath)) return;
    reachable.add(resolvedPath);
    for (const declaration of collect(source, ts.isImportDeclaration)) {
      if (
        declaration.importClause?.isTypeOnly ||
        !ts.isStringLiteral(declaration.moduleSpecifier) ||
        !declaration.moduleSpecifier.text.startsWith('.')
      ) {
        continue;
      }
      const resolution = ts.resolveModuleName(
        declaration.moduleSpecifier.text,
        source.fileName,
        program.getCompilerOptions(),
        ts.sys,
      ).resolvedModule?.resolvedFileName;
      const dependency = resolution ? sourcesByPath.get(path.resolve(resolution)) : undefined;
      if (dependency && !dependency.isDeclarationFile) visit(dependency);
    }
  };
  for (const filePath of PHASE_ZERO_FILES) {
    if (filePath.startsWith('tests/')) continue;
    const source = sourcesByPath.get(path.resolve(SERVER_ROOT, filePath));
    if (source) visit(source);
  }
  return [...reachable].map((fileName) => sourcesByPath.get(fileName)!);
}

function processBoundaryViolations(
  program: ts.Program,
  sourcePaths?: ReadonlySet<string>,
  requireServerRoot = true,
): string[] {
  const requirements = new Map<string, (typeof PROCESS_SOURCES)[number]>(
    PROCESS_SOURCES.map((requirement) => [requirement.path, requirement]),
  );
  const violations: string[] = [];
  for (const source of program.getSourceFiles()) {
    if (
      (requireServerRoot && !sourceIsWithinServerRoot(source)) ||
      source.isDeclarationFile ||
      !source.fileName.endsWith('.ts') ||
      (sourcePaths !== undefined && !sourcePaths.has(path.resolve(source.fileName)))
    ) {
      continue;
    }
    const relativePath = sourceRelativePath(source);
    const requirement = requirements.get(relativePath);
    const scanned = ts.createSourceFile(
      source.fileName,
      source.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const declaration of collect(scanned, ts.isImportDeclaration)) {
      if (!isChildProcessModuleSpecifier(declaration.moduleSpecifier)) continue;
      if (declaration.importClause?.isTypeOnly) continue;
      const bindings = declaration.importClause?.namedBindings;
      const expectedProcessApi = requirement?.processApi ?? 'spawnSync';
      const onlyDirectProcessApi =
        declaration.importClause?.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length === 1 &&
        bindings.elements[0]!.name.text === expectedProcessApi &&
        bindings.elements[0]!.propertyName === undefined;
      if (!requirement || !onlyDirectProcessApi) {
        violations.push(`${relativePath}:child-process-import`);
      }
    }
    for (const call of collect(scanned, ts.isCallExpression)) {
      if (isChildProcessRequire(call)) {
        violations.push(`${relativePath}:child-process-require`);
        continue;
      }
      if (
        call.expression.kind === ts.SyntaxKind.ImportKeyword &&
        call.arguments.length === 1 &&
        isChildProcessModuleSpecifier(call.arguments[0])
      ) {
        violations.push(`${relativePath}:child-process-dynamic-import`);
        continue;
      }
      if (!ts.isIdentifier(call.expression) || !CHILD_PROCESS_CALLS.has(call.expression.text)) {
        continue;
      }
      if (call.expression.text !== (requirement?.processApi ?? 'spawnSync')) {
        violations.push(`${relativePath}:unsupported-${call.expression.text}`);
        continue;
      }
      if (!requirement || !requirement.adapters.has(enclosingClassName(call) ?? '')) {
        violations.push(`${relativePath}:unapproved-${call.expression.text}`);
      }
      const executable = call.arguments[0];
      if (
        !executable ||
        !ts.isIdentifier(executable) ||
        !(executable.text in (requirement?.constants ?? {}))
      ) {
        violations.push(`${relativePath}:ambient-executable`);
      }
      if (!isProcessArgumentExpression(call.arguments[1])) {
        violations.push(`${relativePath}:non-finite-arguments`);
      }
      if (!hasExactProcessOptions(call)) {
        violations.push(`${relativePath}:unsafe-options`);
      }
    }
    for (const identifier of collect(scanned, ts.isIdentifier)) {
      if (identifier.text !== 'spawnSync' && identifier.text !== 'spawn') continue;
      const parent = identifier.parent;
      if (parent !== undefined && ts.isImportSpecifier(parent)) continue;
      if (!ts.isCallExpression(parent) || parent.expression !== identifier) {
        violations.push(`${relativePath}:child-process-alias-acquisition`);
      }
    }
  }
  return [...new Set(violations)].sort();
}

function exportedFunction(module: DynamicModule, name: string): (...args: any[]) => any {
  const candidate = module[name];
  expect(candidate).toBeTypeOf('function');
  return candidate as (...args: any[]) => any;
}

function trusted(executable: string, owner: 'root' | 'trusted-system') {
  return {
    inspect: async () => ({
      path: executable,
      stableIdentity: 'synthetic-stable-identity',
      regularFile: true as const,
      symbolicLink: false as const,
      owner,
      writableByOthers: false as const,
    }),
  };
}

async function hostileEnvironment(run: () => Promise<void>): Promise<void> {
  const variables = {
    PATH: 'C:\\synthetic\\shadow',
    PATHEXT: '.SYNTHETIC',
    HOME: 'C:\\synthetic\\home',
    GIT_CONFIG_GLOBAL: 'C:\\synthetic\\gitconfig',
    GIT_PAGER: 'synthetic-pager',
    AWS_PROFILE: 'synthetic-profile',
    AWS_CONFIG_FILE: 'C:\\synthetic\\aws-config',
    AWS_SHARED_CREDENTIALS_FILE: 'C:\\synthetic\\aws-credentials',
    AWS_ENDPOINT_URL: 'https://synthetic.invalid',
    HTTP_PROXY: 'http://synthetic.invalid',
    HTTPS_PROXY: 'http://synthetic.invalid',
    ALL_PROXY: 'http://synthetic.invalid',
    PAGER: 'synthetic-pager',
  };
  const previous = new Map(Object.keys(variables).map((key) => [key, process.env[key]] as const));
  Object.assign(process.env, variables);
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('Phase 0 process boundary inventory', () => {
  it('scans every manifest-reachable TypeScript source', () => {
    const program = phaseZeroProgram();
    const reachable = runtimePhaseZeroSources(program);
    expect(reachable.map(sourceRelativePath)).toEqual(
      expect.arrayContaining(PHASE_ZERO_FILES.filter((filePath) => !filePath.startsWith('tests/'))),
    );
    expect(
      processBoundaryViolations(
        program,
        new Set(reachable.map((source) => path.resolve(source.fileName))),
      ),
    ).toEqual([]);
  }, 30_000);

  it('rejects aliases, acquisition bypasses, and nonliteral options', () => {
    const program = virtualProgram({
      [path.join(SERVER_ROOT, 'scripts/export-centurion-thread-corpus-live.ts')]: [
        "import { spawnSync } from 'node:child_process';",
        'const copied = spawnSync;',
        'const chained = copied;',
        "require('node:child_process');",
        "import('node:child_process');",
        'class Ec2GitIgnoreProcessAdapter {',
        '  run(invocation: { args: readonly string[]; env: Record<string, string>; cwd: string }) {',
        "    spawnSync(EC2_GIT, invocation.args, { ...{}, shell: false, env: invocation.env, cwd: invocation.cwd, stdio: 'ignore', windowsHide: true });",
        '  }',
        '}',
      ].join('\n'),
      [path.join(SERVER_ROOT, 'src/ops/centurion-thread-corpus-relay-producer.ts')]: [
        "import defaultChildProcess from 'node:child_process';",
        "import * as childProcess from 'node:child_process';",
        "import { spawnSync as renamedSpawn } from 'node:child_process';",
        "childProcess.execFile('/usr/bin/git', []);",
        "defaultChildProcess.spawnSync('/usr/bin/git', []);",
        "renamedSpawn('/usr/bin/git', []);",
      ].join('\n'),
      [path.join(SERVER_ROOT, 'scripts/check-centurion-thread-corpus-readiness.ts')]: [
        "import { spawnSync } from 'node:child_process';",
        'class Ec2GitProcessAdapter {',
        '  run(invocation: { args: readonly string[]; env: Record<string, string>; cwd: string }) {',
        "    spawnSync(EC2_GIT, invocation.args, { shell: Boolean(0), env: invocation.env, cwd: invocation.cwd, stdio: 'ignore', windowsHide: true });",
        "    spawnSync(EC2_GIT, invocation.args, { ['shell']: false, env: invocation.env, cwd: invocation.cwd, stdio: 'ignore', windowsHide: true });",
        "    spawnSync(EC2_GIT, invocation.args, { shell: false, env: approvedEnv, cwd: invocation.cwd, stdio: 'ignore', windowsHide: true });",
        '  }',
        '}',
      ].join('\n'),
      [path.join(SERVER_ROOT, 'src/mail/artifacts/read-artifact.ts')]: [
        "import { spawn } from 'node:child_process';",
        "spawn('/usr/bin/bwrap', [], { shell: false, env: {}, cwd: '/', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });",
      ].join('\n'),
    });
    expect(processBoundaryViolations(program, undefined, false)).toEqual(
      expect.arrayContaining([
        'scripts/export-centurion-thread-corpus-live.ts:child-process-alias-acquisition',
        'scripts/export-centurion-thread-corpus-live.ts:child-process-require',
        'scripts/export-centurion-thread-corpus-live.ts:child-process-dynamic-import',
        'scripts/export-centurion-thread-corpus-live.ts:unsafe-options',
        'src/ops/centurion-thread-corpus-relay-producer.ts:child-process-import',
        'scripts/check-centurion-thread-corpus-readiness.ts:unsafe-options',
        'src/mail/artifacts/read-artifact.ts:unapproved-spawn',
        'src/mail/artifacts/read-artifact.ts:ambient-executable',
      ]),
    );
  });
});

describe('Phase 0 fake process adapters', () => {
  it('rejects Linux Git path shadows before a fake process can run', async () => {
    const createRunner = exportedFunction(
      liveExport as unknown as DynamicModule,
      'createFixedEc2GitIgnoreRunner',
    );
    const calls: unknown[] = [];
    const runner = {
      run: (invocation: unknown) => {
        calls.push(invocation);
        return { failed: false, status: 0 };
      },
    };
    const boundary = createRunner(trusted('/usr/bin/git', 'root'), runner);

    await hostileEnvironment(async () => {
      expect(
        await boundary.isIgnored({
          repoRoot: '/synthetic/zero',
          relativePath: '.private/centurion-thread-corpus/synthetic',
        }),
      ).toBe(true);
    });
    expect(calls).toEqual([
      {
        executable: '/usr/bin/git',
        args: ['check-ignore', '-q', '--no-index', '.private/centurion-thread-corpus/synthetic'],
        cwd: '/synthetic/zero',
        env: LINUX_GIT_ENV,
        shell: false,
      },
    ]);

    const rejectedCalls: unknown[] = [];
    const rejected = createRunner(trusted('/usr/bin/git', 'trusted-system'), {
      run: (invocation: unknown) => rejectedCalls.push(invocation),
    });
    expect(
      await rejected.isIgnored({
        repoRoot: '/synthetic/zero',
        relativePath: '.private/centurion-thread-corpus/synthetic',
      }),
    ).toBe(false);
    expect(rejectedCalls).toEqual([]);

    const malformedCalls: unknown[] = [];
    const malformed = createRunner(
      {
        inspect: async () => ({
          path: '/usr/bin/git',
          stableIdentity: 'synthetic-stable-identity',
          regularFile: false,
          symbolicLink: false,
          owner: 'root',
          writableByOthers: false,
        }),
      },
      { run: (invocation: unknown) => malformedCalls.push(invocation) },
    );
    expect(
      await malformed.isIgnored({
        repoRoot: '/synthetic/zero',
        relativePath: '.private/centurion-thread-corpus/synthetic',
      }),
    ).toBe(false);
    expect(malformedCalls).toEqual([]);
  });

  it('pins readiness AWS inspection independently of ambient AWS settings', async () => {
    const createAdapters = exportedFunction(
      readiness as unknown as DynamicModule,
      'createFixedReadinessProcessAdapters',
    );
    const calls: Array<Record<string, unknown>> = [];
    const adapter = createAdapters(
      trusted('/usr/local/bin/aws', 'root'),
      { run: () => ({ failed: false, status: 0, stdout: '' }) },
      {
        run: (invocation: Record<string, unknown>) => {
          calls.push(invocation);
          return { failed: false, status: 0, stdout: null };
        },
      },
    );

    await hostileEnvironment(async () => {
      expect(
        await adapter.probeS3AndKmsMetadata({
          region: 'synthetic-region-1',
          bucket: 'synthetic-private-bucket',
          kmsKeyId: 'arn:aws:kms:synthetic-region-1:123456789012:key/synthetic',
        }),
      ).toBe(true);
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.executable === '/usr/local/bin/aws')).toBe(true);
    expect(calls.every((call) => JSON.stringify(call.env).includes('synthetic') === false)).toBe(
      true,
    );
    expect(
      calls.every(
        (call) =>
          (call.env as Readonly<Record<string, unknown>> | undefined)?.AWS_CONFIG_FILE ===
          '/dev/null',
      ),
    ).toBe(true);
    expect(calls.every((call) => call.shell === false)).toBe(true);
  });

  it('blocks Linux source Git until injected identity inspection succeeds', async () => {
    const createBoundary = exportedFunction(
      relayProducer as unknown as DynamicModule,
      'createFixedEc2GitInspectionBoundary',
    );
    const calls: unknown[] = [];
    const boundary = createBoundary(trusted('/usr/bin/git', 'root'), {
      run: (invocation: unknown) => {
        calls.push(invocation);
        return { failed: false, status: 0, stdout: 'safe\n' };
      },
    });
    expect(boundary.inspect({ check: 'revision', cwd: '/synthetic/zero' })).toBeNull();
    expect(calls).toEqual([]);
    expect(await boundary.assertTrustedExecutable()).toBe(true);
    expect(boundary.inspect({ check: 'revision', cwd: '/synthetic/zero' })).toBe('safe\n');
    expect(calls).toHaveLength(1);
  });

  it('pins Windows PowerShell and Git while preserving encoded ACL arguments', async () => {
    const aclCalls: Array<Record<string, unknown>> = [];
    const acl = relayReceiver.createWindowsPrivateAcl(
      {
        run: async (invocation) => {
          aclCalls.push(invocation);
          return {
            status: 0,
            stdout: '{"ok":true,"stableIdentity":"safe-identity","volumeId":"safe-volume"}',
          };
        },
      },
      trusted('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'trusted-system'),
    );
    await hostileEnvironment(async () => {
      await acl.assertTrustedPath('C:\\synthetic\\private');
    });
    expect(aclCalls).toHaveLength(1);
    expect(aclCalls[0]).toMatchObject({
      executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: expect.arrayContaining(['-NoProfile', '-NonInteractive', '-EncodedCommand']),
      options: { shell: false },
    });
    expect(JSON.stringify(aclCalls[0])).not.toContain('synthetic-pager');

    const createRunner = exportedFunction(
      relayReceiver as unknown as DynamicModule,
      'createFixedWindowsGitIgnoreRunner',
    );
    const gitCalls: Array<Record<string, unknown>> = [];
    const runner = createRunner(trusted('C:\\Program Files\\Git\\cmd\\git.exe', 'trusted-system'), {
      run: (invocation: Record<string, unknown>) => {
        gitCalls.push(invocation);
        return { failed: false, status: 0 };
      },
    });
    await hostileEnvironment(async () => {
      expect(
        await runner.isIgnored({
          checkoutRoot: 'C:\\synthetic\\zero',
          candidate: '.private/centurion-thread-corpus',
        }),
      ).toBe(true);
    });
    expect(gitCalls[0]).toMatchObject({
      executable: 'C:\\Program Files\\Git\\cmd\\git.exe',
      shell: false,
      env: WINDOWS_GIT_ENV,
    });
    expect(JSON.stringify(gitCalls[0])).not.toContain('synthetic-pager');
  });

  it('fails closed by default before launching Windows processes', async () => {
    const aclCalls: unknown[] = [];
    const acl = relayReceiver.createWindowsPrivateAcl({
      run: async (invocation) => {
        aclCalls.push(invocation);
        return { status: 0, stdout: '{"ok":true,"stableIdentity":"safe","volumeId":"safe"}' };
      },
    });
    expect(await acl.assertTrustedPath('C:\\synthetic\\private')).toBeNull();
    expect(aclCalls).toEqual([]);

    const gitCalls: unknown[] = [];
    const git = relayReceiver.createFixedWindowsGitIgnoreRunner(undefined, {
      run: (invocation) => {
        gitCalls.push(invocation);
        return { failed: false, status: 0 };
      },
    });
    expect(
      await git.isIgnored({
        checkoutRoot: 'C:\\synthetic\\zero',
        candidate: '.private/centurion-thread-corpus',
      }),
    ).toBe(false);
    expect(gitCalls).toEqual([]);
  });

  it('blocks analysis Git invocation when inspector rejects its fixed executable', async () => {
    const calls: unknown[] = [];
    const runner = analysisWorkspace.createFixedGitIgnoreRunner(
      {
        run: (invocation) => {
          calls.push(invocation);
          return { failed: false, status: 0 };
        },
      },
      trusted('C:\\Program Files\\Git\\cmd\\git.exe', 'root'),
    );
    expect(
      await runner.isIgnored({
        checkoutRoot: 'C:\\synthetic\\zero',
        candidate: '.private/centurion-thread-analysis/',
      }),
    ).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('Phase 0 TypeScript manifest', () => {
  it('has a dedicated no-emit typecheck command and exact files manifest', () => {
    const configPath = path.join(SERVER_ROOT, 'tsconfig.centurion-phase-0.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      compilerOptions?: { noEmit?: unknown; noImplicitAny?: unknown; strict?: unknown };
      files?: unknown;
    };
    expect(config.compilerOptions?.noEmit).toBe(true);
    expect(config.compilerOptions?.strict).toBe(true);
    expect(config.compilerOptions?.noImplicitAny).not.toBe(false);
    expect(config.files).toEqual(PHASE_ZERO_FILES);

    const packageJson = JSON.parse(
      readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8'),
    ) as {
      scripts?: Record<string, unknown>;
    };
    expect(packageJson.scripts?.['typecheck:centurion-phase-0']).toBe(
      'tsc -p tsconfig.centurion-phase-0.json --noEmit',
    );
    expect(
      ({} as { scripts?: Record<string, unknown> }).scripts?.['typecheck:centurion-phase-0'],
    ).toBeUndefined();

    const parsed = ts.parseJsonConfigFileContent(
      config,
      ts.sys,
      SERVER_ROOT,
      undefined,
      configPath,
    );
    expect(parsed.errors).toEqual([]);
    expect(
      parsed.fileNames.map((fileName) =>
        path.relative(SERVER_ROOT, fileName).split(path.sep).join('/'),
      ),
    ).toEqual(PHASE_ZERO_FILES);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    expect(ts.getPreEmitDiagnostics(program)).toEqual([]);
  }, 30_000);
});
