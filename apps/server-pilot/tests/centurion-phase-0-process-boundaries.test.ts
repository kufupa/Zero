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

const PROCESS_SOURCES = [
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
] as const;

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

function parseSource(relativePath: string): ts.SourceFile {
  const absolutePath = path.join(SERVER_ROOT, relativePath);
  return ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function collect<T extends ts.Node>(source: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

type ChildProcessBindings = {
  named: ReadonlyMap<string, string>;
  namespaces: ReadonlySet<string>;
};

function isChildProcessRequire(expression: ts.Expression | undefined): boolean {
  return (
    expression !== undefined &&
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'require' &&
    expression.arguments.length === 1 &&
    ts.isStringLiteral(expression.arguments[0]) &&
    (expression.arguments[0].text === 'node:child_process' ||
      expression.arguments[0].text === 'child_process')
  );
}

function childProcessBindings(source: ts.SourceFile): ChildProcessBindings {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const declaration of collect(
    source,
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      (node.moduleSpecifier.text === 'node:child_process' ||
        node.moduleSpecifier.text === 'child_process'),
  )) {
    const bindings = declaration.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (CHILD_PROCESS_CALLS.has(imported)) named.set(element.name.text, imported);
    }
  }
  for (const declaration of collect(
    source,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      isChildProcessRequire(node.initializer),
  )) {
    if (!ts.isObjectBindingPattern(declaration.name)) continue;
    for (const element of declaration.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const imported = element.propertyName?.getText(source) ?? element.name.text;
      if (CHILD_PROCESS_CALLS.has(imported)) named.set(element.name.text, imported);
    }
  }
  return { named, namespaces };
}

function childProcessCallName(
  call: ts.CallExpression,
  bindings: ChildProcessBindings,
): string | null {
  if (ts.isIdentifier(call.expression)) {
    const imported = bindings.named.get(call.expression.text);
    return (
      imported ?? (CHILD_PROCESS_CALLS.has(call.expression.text) ? call.expression.text : null)
    );
  }
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    CHILD_PROCESS_CALLS.has(call.expression.name.text) &&
    ((ts.isIdentifier(call.expression.expression) &&
      bindings.namespaces.has(call.expression.expression.text)) ||
      isChildProcessRequire(call.expression.expression))
  ) {
    return call.expression.name.text;
  }
  return null;
}

function isFiniteArgumentSource(argument: ts.Expression | undefined): boolean {
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

function executableConstants(source: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();
  for (const declaration of collect(
    source,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isStringLiteral(node.initializer),
  )) {
    const initializer = declaration.initializer;
    if (ts.isIdentifier(declaration.name) && initializer && ts.isStringLiteral(initializer)) {
      constants.set(declaration.name.text, initializer.text);
    }
  }
  return constants;
}

function processBoundaryViolations(
  source: ts.SourceFile,
  allowedAdapters: ReadonlySet<string>,
  allowedConstants: Readonly<Record<string, string>>,
): string[] {
  const constants = executableConstants(source);
  const violations: string[] = [];
  const bindings = childProcessBindings(source);
  for (const [name, value] of Object.entries(allowedConstants)) {
    if (constants.get(name) !== value) violations.push(`constant:${name}`);
  }
  for (const call of collect(
    source,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && childProcessCallName(node, bindings) !== null,
  )) {
    const name = childProcessCallName(call, bindings);
    if (name !== 'spawnSync') {
      violations.push(`unsupported:${name}`);
      continue;
    }
    if (!allowedAdapters.has(enclosingClassName(call) ?? '')) {
      violations.push(`adapter:${enclosingClassName(call) ?? 'none'}`);
    }
    const executable = call.arguments[0];
    if (!executable || !ts.isIdentifier(executable) || !(executable.text in allowedConstants)) {
      violations.push('ambient-executable');
    }
    if (!isFiniteArgumentSource(call.arguments[1])) {
      violations.push('non-finite-arguments');
    }
    const options = call.arguments[2];
    const optionsText = options?.getText(source) ?? '';
    if (
      !optionsText.includes('shell: false') ||
      !optionsText.includes('env:') ||
      !optionsText.includes('cwd:') ||
      !optionsText.includes('stdio') ||
      optionsText.includes('process.env')
    ) {
      violations.push('unsafe-options');
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
  it('permits child-process calls only in fixed narrow adapters', () => {
    const requirements = new Map<string, (typeof PROCESS_SOURCES)[number]>(
      PROCESS_SOURCES.map((requirement) => [requirement.path, requirement]),
    );
    for (const filePath of PHASE_ZERO_FILES) {
      const source = parseSource(filePath);
      const requirement = requirements.get(filePath);
      expect(
        processBoundaryViolations(
          source,
          requirement?.adapters ?? new Set<string>(),
          requirement?.constants ?? {},
        ),
        filePath,
      ).toEqual([]);
    }
  });

  it('rejects ambient executables and inherited environment fixtures', () => {
    const fixture = ts.createSourceFile(
      'ambient-executable.ts',
      [
        "import { spawnSync } from 'node:child_process';",
        "spawnSync('git', ['status'], { shell: false, env: process.env, stdio: 'ignore' });",
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(
      processBoundaryViolations(fixture, new Set(['SafeAdapter']), {
        EC2_GIT: '/usr/bin/git',
      }),
    ).toEqual(expect.arrayContaining(['ambient-executable', 'adapter:none', 'constant:EC2_GIT']));

    const aliases = ts.createSourceFile(
      'child-process-aliases.ts',
      [
        "import { spawnSync as run } from 'node:child_process';",
        "import * as processTools from 'node:child_process';",
        "const { execSync: shellOut } = require('node:child_process');",
        "run('/usr/bin/git', ['status'], { shell: false, env: {}, stdio: 'ignore' });",
        "const ambientArgs = ['status'];",
        "run('/usr/bin/git', ambientArgs, { shell: false, env: {}, cwd: '/', stdio: 'ignore' });",
        "processTools.execFile('/usr/bin/git', ['status']);",
        "shellOut('git status');",
        "require('node:child_process').fork('synthetic-worker');",
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(
      processBoundaryViolations(aliases, new Set(['SafeAdapter']), {
        EC2_GIT: '/usr/bin/git',
      }),
    ).toEqual(
      expect.arrayContaining([
        'adapter:none',
        'ambient-executable',
        'constant:EC2_GIT',
        'non-finite-arguments',
        'unsupported:execFile',
        'unsupported:execSync',
        'unsupported:fork',
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
