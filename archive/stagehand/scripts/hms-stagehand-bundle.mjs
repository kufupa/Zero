#!/usr/bin/env node

/**
 * Build one bounded, content-addressed HMS trial artifact.
 *
 * This is deliberately a package helper, not a release/deploy command.  It
 * accepts explicit entrypoints and files, resolves the local import closure
 * with the installed esbuild binary, and writes an isolated directory with a
 * JSON integrity manifest.  It never reads git state and never mutates the
 * source checkout.
 */

import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_SCHEMA_VERSION = 'hms-stagehand-bundle/v1';
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Stable JSON is the only input to fingerprints. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function fingerprint(value) {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

function toPosix(relative) {
  return relative.split(path.sep).join('/');
}

function normalizeRelative(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const candidate = value.trim().replaceAll('\\', '/');
  if (
    candidate.startsWith('/') ||
    /^[A-Za-z]:\//.test(candidate) ||
    candidate.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`${label} must stay inside source root: ${value}`);
  }
  return candidate;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isPrivateOrSecretName(name) {
  const lower = name.toLowerCase();
  if (/^\.env(?:\.|$)/i.test(name)) return true;
  if (/^(?:credentials?|secrets?|passwords?|tokens?)(?:\.[^/]*)?$/i.test(name)) return true;
  return /(?:\.pem|\.key|\.p12|\.pfx)$/i.test(lower) || lower === 'id_rsa';
}

function assertSafeRelative(relative, label = 'path') {
  const parts = relative.split('/');
  const basename = parts.at(-1) ?? '';
  if (
    parts.some((part) => part === '.private' || part === '.git' || part === 'node_modules') ||
    parts.some((part) => isPrivateOrSecretName(part)) ||
    /(?:^|\/)(?:credentials?|secrets?|passwords?|tokens?)(?:\/|$)/i.test(relative) ||
    isPrivateOrSecretName(basename)
  ) {
    throw new Error(`${label} is secret-like or private and cannot be staged: ${relative}`);
  }
}

async function regularFile(file, label) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} does not exist: ${file}`);
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`${label} symlink is not allowed: ${file}`);
  if (!info.isFile()) throw new Error(`${label} must be a regular file: ${file}`);
  return info;
}

async function safeRead(file, label) {
  await regularFile(file, label);
  return readFile(file);
}

async function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function executable(file) {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findEsbuildBinary(root, requested) {
  const candidates = [
    requested,
    process.env.HMS_STAGEHAND_ESBUILD,
    process.env.ESBUILD_BIN,
    path.join(root, 'node_modules', '.bin', 'esbuild'),
    path.join(path.dirname(root), 'node_modules', '.bin', 'esbuild'),
    path.join(
      SCRIPT_DIR,
      '..',
      '..',
      '..',
      'node_modules',
      '.pnpm',
      'node_modules',
      '.bin',
      'esbuild',
    ),
    path.join(process.cwd(), 'node_modules', '.pnpm', 'node_modules', '.bin', 'esbuild'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await executable(candidate)) return path.resolve(candidate);
  }
  throw new Error(
    'installed esbuild binary not found; provide --esbuild <path> (no install is performed)',
  );
}

async function esbuildVersion(binary) {
  const result = await spawnCapture(binary, ['--version']);
  if (result.code !== 0 || !/^\d+\.\d+\.\d+\s*$/.test(result.stdout)) {
    throw new Error(`esbuild version check failed: ${result.stderr.trim() || 'unknown error'}`);
  }
  return result.stdout.trim();
}

function parsePackageSpec(spec, label = 'dependency') {
  if (typeof spec !== 'string' || spec.trim() === '')
    throw new Error(`${label} must be name@version`);
  const value = spec.trim();
  const at = value.startsWith('@') ? value.lastIndexOf('@') : value.indexOf('@');
  if (at <= 0 || at === value.length - 1 || value.slice(at + 1).includes('@')) {
    throw new Error(`${label} must pin installed identity as name@version: ${spec}`);
  }
  const name = value.slice(0, at);
  const version = value.slice(at + 1);
  if (name.includes('/') === false && name.startsWith('@')) {
    throw new Error(`${label} has invalid scoped package name: ${spec}`);
  }
  if (/\s/.test(name) || /\s/.test(version) || name.includes('..')) {
    throw new Error(`${label} contains unsafe package identity: ${spec}`);
  }
  return { name, version, spec: `${name}@${version}` };
}

async function resolvePackageJson(name, fromPath, additionalPaths = []) {
  let lastError;
  for (const candidatePath of [fromPath, ...additionalPaths]) {
    const parent = pathToFileURL(path.join(candidatePath, 'package.json')).href;
    const requireFrom = createRequire(parent);
    try {
      return await realpath(requireFrom.resolve(`${name}/package.json`));
    } catch {
      let resolved;
      try {
        resolved = await realpath(requireFrom.resolve(name));
      } catch (error) {
        lastError = error;
        continue;
      }
      let current = path.dirname(resolved);
      while (true) {
        const candidate = path.join(current, 'package.json');
        try {
          await regularFile(candidate, `dependency ${name} package metadata`);
          return candidate;
        } catch {
          const next = path.dirname(current);
          if (next === current) break;
          current = next;
        }
      }
      lastError = new Error(`installed dependency ${name} has no readable package.json`);
    }
  }
  throw new Error(
    `installed dependency ${name} not found from ${fromPath}: ${lastError?.message ?? 'unknown error'}`,
  );
}

async function readPackageIdentity(packageJsonPath) {
  const raw = await safeRead(packageJsonPath, 'package metadata');
  let json;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error(`invalid package metadata: ${packageJsonPath}`);
  }
  if (typeof json.name !== 'string' || typeof json.version !== 'string') {
    throw new Error(`package metadata missing pinned name/version: ${packageJsonPath}`);
  }
  return { name: json.name, version: json.version, packageJsonPath, json };
}

async function copyTree(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink())
    throw new Error(`symlink is not allowed in staged dependency: ${source}`);
  if (info.isFile()) {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    return;
  }
  if (!info.isDirectory()) throw new Error(`unsupported dependency filesystem entry: ${source}`);
  await mkdir(destination, { recursive: true });
  const names = (await readdir(source)).sort();
  for (const name of names) {
    if (name === 'node_modules') continue;
    const child = path.join(source, name);
    if (isPrivateOrSecretName(name)) continue;
    await copyTree(child, path.join(destination, name));
  }
}

/** Copy only explicitly declared external packages; no package-manager overlay. */
async function copyDeclaredExternalPackages({
  root,
  tempDir,
  externalSpecs,
  resolutionPaths = [],
}) {
  const identities = [];
  for (const spec of externalSpecs) {
    const packageJsonPath = await resolvePackageJson(spec.name, root, resolutionPaths);
    const identity = await readPackageIdentity(packageJsonPath);
    if (identity.version !== spec.version) {
      throw new Error(
        `pinned dependency mismatch for ${spec.name}: requested ${spec.version}, installed ${identity.version}`,
      );
    }
    const destination = path.join(tempDir, 'node_modules', ...identity.name.split('/'));
    await copyTree(path.dirname(packageJsonPath), destination);
    identities.push({ name: identity.name, version: identity.version });
    const optional = new Set(
      Object.entries(identity.json.peerDependenciesMeta ?? {})
        .filter(([, value]) => value?.optional === true)
        .map(([name]) => name),
    );
    for (const dependencyName of Object.keys(identity.json.dependencies ?? {}).sort()) {
      try {
        const dependencyJsonPath = await resolvePackageJson(
          dependencyName,
          path.dirname(packageJsonPath),
        );
        const dependency = await readPackageIdentity(dependencyJsonPath);
        const dependencyDestination = path.join(
          destination,
          'node_modules',
          ...dependency.name.split('/'),
        );
        await copyTree(path.dirname(dependencyJsonPath), dependencyDestination);
        identities.push({ name: dependency.name, version: dependency.version });
      } catch (error) {
        if (optional.has(dependencyName)) continue;
        throw new Error(
          `declared external dependency ${dependencyName} of ${identity.name} unavailable: ${error.message}`,
        );
      }
    }
  }
  return [...new Map(identities.map((identity) => [identity.name, identity])).values()].sort(
    (a, b) => a.name.localeCompare(b.name),
  );
}

function parseMetaInputs(meta, root) {
  return Object.keys(meta?.inputs ?? {}).map((input) => {
    const absolute = path.isAbsolute(input) ? input : path.resolve(root, input);
    return { input, absolute };
  });
}

async function fileRecord(file, artifactPath, role) {
  const bytes = await safeRead(file, role);
  return {
    path: toPosix(artifactPath),
    size: bytes.byteLength,
    sha256: sha256(bytes),
    role,
  };
}

async function copyWithRecord(file, destination, artifactRelative, role) {
  await regularFile(file, role);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(file, destination);
  return fileRecord(destination, artifactRelative, role);
}

/** Snapshot bounded source bytes without retaining their contents. */
export async function captureSourceSnapshot(root, relatives) {
  const paths = [...new Set(relatives)].sort();
  const files = [];
  for (const relative of paths) {
    assertSafeRelative(relative, 'snapshot source');
    const bytes = await safeRead(path.join(root, relative), `snapshot source ${relative}`);
    files.push({ path: toPosix(relative), size: bytes.byteLength, sha256: sha256(bytes) });
  }
  return { fingerprint: fingerprint(files), files };
}

/** Fail closed when source bytes differ across a build/copy boundary. */
export function assertSourceSnapshotStable(before, after, phase = 'bundle') {
  if (
    !before ||
    !after ||
    before.fingerprint !== after.fingerprint ||
    canonicalJson(before.files) !== canonicalJson(after.files)
  ) {
    throw new Error(`source changed during bundle (${phase}); retry from stable checkout`);
  }
}

async function collectDirectoryFiles(directory, artifactRoot, role = 'external-dependency') {
  const records = [];
  async function walk(current) {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name === 'bundle-manifest.json') continue;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(artifactRoot, absolute);
      if (entry.isSymbolicLink()) throw new Error(`staged artifact contains symlink: ${relative}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) records.push(await fileRecord(absolute, relative, role));
    }
  }
  await walk(directory);
  return records;
}

function outputName(entry) {
  const noExtension = entry.replace(/\.[^.\/]+$/, '');
  return `${noExtension.replaceAll('/', '-').replace(/[^A-Za-z0-9._-]/g, '_')}.mjs`;
}

function launcherSource(entries) {
  const table = Object.fromEntries(entries.map((entry) => [entry.input, entry.output]));
  return `// Generated by ${BUNDLE_SCHEMA_VERSION}; entry selection is explicit.\nimport { spawnSync } from 'node:child_process';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\n\nconst entries = ${JSON.stringify(table, null, 2)};\nconst args = process.argv.slice(2);\nconst selectorIndex = args.indexOf('--entry');\nconst selector = selectorIndex >= 0 ? args[selectorIndex + 1] : undefined;\nif (!selector || !entries[selector] || selectorIndex !== 0) {\n  console.error('usage: node launch.mjs --entry <relative-entry> [runner args...]');\n  process.exit(2);\n}\nconst runnerArgs = args.slice(2);\nconst root = path.dirname(fileURLToPath(import.meta.url));\nconst runner = path.join(root, 'entrypoints', entries[selector]);\nconst result = spawnSync(process.execPath, [runner, ...runnerArgs], { cwd: root, stdio: 'inherit' });\nif (result.error) throw result.error;\nprocess.exit(result.status ?? 1);\n`;
}

const OPTIONAL_PLAYWRIGHT_RUNTIME_MODULES = ['chromium-bidi'];

async function readExistingManifest(out) {
  try {
    const bytes = await readFile(path.join(out, 'bundle-manifest.json'));
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (
      manifest?.schemaVersion !== BUNDLE_SCHEMA_VERSION ||
      typeof manifest.bundleFingerprint !== 'string' ||
      !SHA256.test(manifest.bundleFingerprint) ||
      !Array.isArray(manifest.files)
    ) {
      throw new Error('existing artifact has invalid bundle manifest');
    }
    return manifest;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof SyntaxError)
      throw new Error('existing artifact has invalid JSON manifest');
    throw error;
  }
}

async function assertExistingArtifactIntegrity(out, manifest) {
  const expected = new Map();
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      path.isAbsolute(file.path) ||
      file.path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      typeof file.size !== 'number' ||
      !SHA256.test(file.sha256)
    ) {
      throw new Error('existing artifact has invalid file integrity record');
    }
    if (expected.has(file.path))
      throw new Error(`existing artifact has duplicate file record: ${file.path}`);
    expected.set(file.path, file);
  }
  const actual = await collectDirectoryFiles(out, out);
  if (actual.length !== expected.size) {
    throw new Error('existing artifact integrity differs: file set changed');
  }
  for (const record of actual) {
    const prior = expected.get(record.path);
    if (!prior || prior.size !== record.size || prior.sha256 !== record.sha256) {
      throw new Error(`existing artifact integrity differs: ${record.path}`);
    }
  }
}

function asArray(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

/**
 * @param {{
 *   root: string,
 *   out: string,
 *   entries?: string[],
 *   entrypoints?: string[],
 *   sources?: string[],
 *   assets?: string[],
 *   manifests?: string[],
 *   dependencies?: string[],
 *   external?: string[],
 *   esbuild?: string,
 * }} options
 */
export async function bundleStagehandTrial(options) {
  if (!options || typeof options !== 'object') throw new Error('bundle options are required');
  if (typeof options.root !== 'string' || typeof options.out !== 'string') {
    throw new Error('root and out are required');
  }
  const root = await realpath(path.resolve(options.root));
  const out = path.resolve(options.out);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error(`source root must be a directory: ${root}`);
  if (isInside(root, out)) throw new Error('output artifact must be outside source root');
  try {
    const outInfo = await lstat(out);
    if (outInfo.isSymbolicLink()) throw new Error(`output artifact symlink is not allowed: ${out}`);
    if (!outInfo.isDirectory()) throw new Error(`output artifact is not a directory: ${out}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const entries = asArray(options.entries ?? options.entrypoints, 'entries');
  if (entries.length === 0) throw new Error('at least one explicit entrypoint is required');
  const sources = asArray(options.sources, 'sources');
  const assets = asArray(options.assets, 'assets');
  const manifests = asArray(options.manifests, 'manifests');
  const dependencySpecs = asArray(options.dependencies, 'dependencies').map((spec) =>
    parsePackageSpec(spec),
  );
  const externalSpecs = asArray(options.external, 'external').map((spec) =>
    parsePackageSpec(spec, 'external dependency'),
  );
  const entryPaths = [
    ...new Set(entries.map((entry) => normalizeRelative(entry, 'entrypoint'))),
  ].sort();
  const sourcePaths = [
    ...new Set(sources.map((source) => normalizeRelative(source, 'source file'))),
  ].sort();
  const assetPaths = [...new Set(assets.map((asset) => normalizeRelative(asset, 'asset')))].sort();
  const manifestPaths = [
    ...new Set(manifests.map((manifest) => normalizeRelative(manifest, 'manifest'))),
  ].sort();
  const resolutionPaths = [
    root,
    ...entryPaths.map((entry) => path.dirname(path.join(root, entry))),
  ];
  for (const relative of [...entryPaths, ...sourcePaths, ...assetPaths, ...manifestPaths]) {
    assertSafeRelative(relative);
  }
  for (const relative of entryPaths)
    await regularFile(path.join(root, relative), `entrypoint ${relative}`);
  for (const relative of sourcePaths)
    await regularFile(path.join(root, relative), `source file ${relative}`);
  for (const relative of assetPaths)
    await regularFile(path.join(root, relative), `asset ${relative}`);
  for (const relative of manifestPaths)
    await regularFile(path.join(root, relative), `manifest ${relative}`);
  const requestedSnapshotPaths = [
    ...new Set([...entryPaths, ...sourcePaths, ...assetPaths, ...manifestPaths]),
  ].sort();
  const initialSourceSnapshot = await captureSourceSnapshot(root, requestedSnapshotPaths);

  const existing = await readExistingManifest(out).catch((error) => {
    if (error.message.startsWith('existing artifact')) {
      throw new Error(`refusing to overwrite existing artifact: ${error.message}`);
    }
    throw error;
  });
  if (existing) {
    try {
      await assertExistingArtifactIntegrity(out, existing);
    } catch (error) {
      throw new Error(`refusing to reuse existing artifact: ${error.message}`);
    }
  }
  if (existing === null) {
    try {
      const info = await lstat(out);
      if (info.isDirectory())
        throw new Error(`refusing to overwrite existing artifact without valid manifest: ${out}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const parent = path.dirname(out);
  await mkdir(parent, { recursive: true });
  const tempDir = await mkdtemp(path.join(parent, `.hms-stagehand-${process.pid}-`));
  let moved = false;
  try {
    const binary = await findEsbuildBinary(root, options.esbuild);
    const esbuild = await esbuildVersion(binary);
    const entryBuilds = [];
    const metaInputs = new Map();
    const externalNames = [
      ...new Set([
        ...externalSpecs.map((spec) => spec.name),
        ...(externalSpecs.some((spec) => spec.name === 'playwright')
          ? OPTIONAL_PLAYWRIGHT_RUNTIME_MODULES
          : []),
      ]),
    ];
    for (const entry of entryPaths) {
      const output = outputName(entry);
      const outputPath = path.join(tempDir, 'entrypoints', output);
      const metaPath = path.join(tempDir, `.meta-${output}.json`);
      await mkdir(path.dirname(outputPath), { recursive: true });
      const args = [
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--target=node20',
        '--legal-comments=none',
        '--charset=utf8',
        '--log-level=error',
        '--banner:js=import { createRequire as __stagehandCreateRequire } from "node:module"; const require = __stagehandCreateRequire(import.meta.url);',
        `--outfile=${outputPath}`,
        `--metafile=${metaPath}`,
        ...externalNames.map((name) => `--external:${name}`),
        path.join(root, entry),
      ];
      const build = await spawnCapture(binary, args, { cwd: root });
      if (build.code !== 0) {
        const detail = (build.stderr || build.stdout).trim().replace(/\s+/g, ' ').slice(0, 600);
        throw new Error(
          `esbuild failed for entrypoint ${entry}: ${detail || `exit ${build.code}`}`,
        );
      }
      let meta;
      try {
        meta = JSON.parse((await safeRead(metaPath, 'esbuild metafile')).toString('utf8'));
      } catch {
        throw new Error(`esbuild produced invalid metafile for entrypoint ${entry}`);
      }
      for (const input of parseMetaInputs(meta, root)) metaInputs.set(input.absolute, input.input);
      entryBuilds.push({ input: entry, output });
      await rm(metaPath, { force: true });
    }

    const explicitSourceFiles = new Map();
    for (const relative of sourcePaths) explicitSourceFiles.set(relative, { role: 'source' });
    for (const [absolute] of metaInputs) {
      if (!isInside(root, absolute)) continue;
      const relative = toPosix(path.relative(root, absolute));
      if (relative.split('/').includes('node_modules')) continue;
      assertSafeRelative(relative, 'imported source');
      explicitSourceFiles.set(relative, { role: 'source' });
    }
    for (const relative of [...assetPaths, ...manifestPaths]) {
      explicitSourceFiles.set(relative, { role: 'source' });
    }
    for (const metadata of [
      'package.json',
      'pnpm-lock.yaml',
      'package-lock.json',
      'npm-shrinkwrap.json',
    ]) {
      const absolute = path.join(root, metadata);
      try {
        await regularFile(absolute, 'dependency metadata');
        explicitSourceFiles.set(metadata, { role: 'dependency-metadata' });
      } catch (error) {
        if (error.message.includes('does not exist')) continue;
        throw error;
      }
    }

    const beforeCopySnapshot = await captureSourceSnapshot(root, [
      ...explicitSourceFiles.keys(),
      ...assetPaths,
      ...manifestPaths,
    ]);
    assertSourceSnapshotStable(
      initialSourceSnapshot,
      await captureSourceSnapshot(root, requestedSnapshotPaths),
      'esbuild',
    );

    const sourceRecords = [];
    for (const relative of [...explicitSourceFiles.keys()].sort()) {
      const source = path.join(root, relative);
      const destination = path.join(tempDir, 'source', relative);
      const record = await copyWithRecord(
        source,
        destination,
        path.join('source', relative),
        explicitSourceFiles.get(relative).role,
      );
      sourceRecords.push({
        path: relative,
        size: record.size,
        sha256: record.sha256,
        role: explicitSourceFiles.get(relative).role,
      });
    }
    assertSourceSnapshotStable(
      beforeCopySnapshot,
      await captureSourceSnapshot(root, [
        ...explicitSourceFiles.keys(),
        ...assetPaths,
        ...manifestPaths,
      ]),
      'source copy',
    );

    const runtimeRecords = [];
    for (const relative of [...assetPaths, ...manifestPaths].sort()) {
      const destination = path.join(tempDir, relative);
      const role = manifestPaths.includes(relative) ? 'runtime-manifest' : 'runtime-asset';
      runtimeRecords.push(
        await copyWithRecord(path.join(root, relative), destination, relative, role),
      );
    }
    assertSourceSnapshotStable(
      beforeCopySnapshot,
      await captureSourceSnapshot(root, [
        ...explicitSourceFiles.keys(),
        ...assetPaths,
        ...manifestPaths,
      ]),
      'artifact copy',
    );

    const explicitIdentities = new Map();
    for (const spec of [...dependencySpecs, ...externalSpecs]) {
      const packageJsonPath = await resolvePackageJson(spec.name, root, resolutionPaths);
      const identity = await readPackageIdentity(packageJsonPath);
      if (identity.version !== spec.version) {
        throw new Error(
          `pinned dependency mismatch for ${spec.name}: requested ${spec.version}, installed ${identity.version}`,
        );
      }
      explicitIdentities.set(identity.name, { name: identity.name, version: identity.version });
    }
    const externalIdentities = await copyDeclaredExternalPackages({
      root,
      tempDir,
      externalSpecs,
      resolutionPaths,
    });
    for (const identity of externalIdentities) explicitIdentities.set(identity.name, identity);

    const importedPackageIdentities = new Map();
    for (const absolute of metaInputs.keys()) {
      if (!absolute.includes(`${path.sep}node_modules${path.sep}`)) continue;
      try {
        const identity = await readPackageIdentity(await resolvePackageJsonFromInput(absolute));
        importedPackageIdentities.set(identity.name, {
          name: identity.name,
          version: identity.version,
        });
      } catch {
        // Generated esbuild inputs can point at package internals without a
        // discoverable package root; output bytes still remain fingerprinted.
      }
    }
    for (const identity of importedPackageIdentities.values()) {
      const prior = explicitIdentities.get(identity.name);
      if (prior && prior.version !== identity.version) {
        throw new Error(
          `imported dependency ${identity.name}@${identity.version} conflicts with pinned ${prior.version}`,
        );
      }
      explicitIdentities.set(identity.name, identity);
    }
    const dependencies = [...explicitIdentities.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    const generatedPackage = {
      name: 'hms-stagehand-bundle',
      private: true,
      type: 'module',
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      dependencies: Object.fromEntries(dependencies.map((dep) => [dep.name, dep.version])),
    };
    await writeFile(
      path.join(tempDir, 'package.json'),
      `${JSON.stringify(generatedPackage, null, 2)}\n`,
      { mode: 0o644 },
    );
    await writeFile(path.join(tempDir, 'launch.mjs'), launcherSource(entryBuilds), { mode: 0o755 });

    assertSourceSnapshotStable(
      beforeCopySnapshot,
      await captureSourceSnapshot(root, [
        ...explicitSourceFiles.keys(),
        ...assetPaths,
        ...manifestPaths,
      ]),
      'bundle finalization',
    );

    const sourceFingerprint = fingerprint({
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      esbuild,
      entries: entryBuilds,
      sourceFiles: sourceRecords.sort((a, b) => a.path.localeCompare(b.path)),
      assets: runtimeRecords
        .filter((record) => record.role === 'runtime-asset')
        .map(({ path: filePath, size, sha256: hash }) => ({ path: filePath, size, sha256: hash }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      manifests: runtimeRecords
        .filter((record) => record.role === 'runtime-manifest')
        .map(({ path: filePath, size, sha256: hash }) => ({ path: filePath, size, sha256: hash }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      dependencies,
      external: externalSpecs,
      optionalRuntimeModules: externalNames.filter((name) =>
        OPTIONAL_PLAYWRIGHT_RUNTIME_MODULES.includes(name),
      ),
    });

    const records = await collectDirectoryFiles(tempDir, tempDir);
    const runtimeRole = new Map(runtimeRecords.map((record) => [record.path, record.role]));
    const files = records
      .map((record) => ({
        ...record,
        role:
          runtimeRole.get(record.path) ??
          (record.path.startsWith('source/')
            ? 'source'
            : record.path.startsWith('entrypoints/')
              ? 'entrypoint'
              : record.path === 'launch.mjs'
                ? 'launcher'
                : record.path === 'package.json'
                  ? 'generated-metadata'
                  : record.path.startsWith('node_modules/')
                    ? 'external-dependency'
                    : 'artifact'),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const bundleFingerprint = fingerprint({
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      sourceFingerprint,
      entries: entryBuilds,
      dependencies,
      files,
    });
    const manifest = {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      sourceFingerprint,
      bundleFingerprint,
      sourceRoot: 'source',
      entries: entryBuilds,
      assets: runtimeRecords
        .filter((record) => record.role === 'runtime-asset')
        .map((record) => record.path)
        .sort(),
      manifests: runtimeRecords
        .filter((record) => record.role === 'runtime-manifest')
        .map((record) => record.path)
        .sort(),
      dependencies,
      externalDependencies: externalSpecs,
      optionalRuntimeModules: externalNames.filter((name) =>
        OPTIONAL_PLAYWRIGHT_RUNTIME_MODULES.includes(name),
      ),
      build: {
        tool: 'esbuild',
        version: esbuild,
        platform: 'node',
        format: 'esm',
        target: 'node20',
      },
      launch: {
        command: 'node launch.mjs --entry <relative-entry> [runner args...]',
        entries: Object.fromEntries(entryBuilds.map((entry) => [entry.input, entry.output])),
      },
      files,
    };
    await writeFile(
      path.join(tempDir, 'bundle-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        mode: 0o644,
      },
    );

    assertSourceSnapshotStable(
      beforeCopySnapshot,
      await captureSourceSnapshot(root, [
        ...explicitSourceFiles.keys(),
        ...assetPaths,
        ...manifestPaths,
      ]),
      'artifact publish',
    );

    if (existing) {
      if (existing.bundleFingerprint !== manifest.bundleFingerprint) {
        throw new Error(
          `refusing to overwrite different existing artifact: existing=${existing.bundleFingerprint} new=${manifest.bundleFingerprint}`,
        );
      }
      return { outputDir: out, manifest: existing, reused: true };
    }

    try {
      await rename(tempDir, out);
      moved = true;
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      const raced = await readExistingManifest(out);
      if (raced?.bundleFingerprint !== manifest.bundleFingerprint) {
        throw new Error(`refusing to overwrite different existing artifact: ${out}`);
      }
      return { outputDir: out, manifest: raced, reused: true };
    }
    return { outputDir: out, manifest, reused: false };
  } finally {
    if (!moved) await rm(tempDir, { recursive: true, force: true });
  }
}

async function resolvePackageJsonFromInput(input) {
  let current = path.dirname(input);
  while (true) {
    const candidate = path.join(current, 'package.json');
    try {
      await regularFile(candidate, 'import package metadata');
      const json = JSON.parse((await readFile(candidate)).toString('utf8'));
      if (typeof json.name === 'string' && typeof json.version === 'string') return candidate;
    } catch {
      // Keep walking package internals.
    }
    const next = path.dirname(current);
    if (next === current) throw new Error(`package metadata not found for ${input}`);
    current = next;
  }
}

function parseCli(argv) {
  const options = {
    entries: [],
    sources: [],
    assets: [],
    manifests: [],
    dependencies: [],
    external: [],
  };
  const valueFlags = new Map([
    ['--root', 'root'],
    ['--out', 'out'],
    ['--entry', 'entries'],
    ['--source', 'sources'],
    ['--asset', 'assets'],
    ['--manifest', 'manifests'],
    ['--dependency', 'dependencies'],
    ['--external', 'external'],
    ['--esbuild', 'esbuild'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equals = token.indexOf('=');
    const flag = equals >= 0 ? token.slice(0, equals) : token;
    const inline = equals >= 0 ? token.slice(equals + 1) : undefined;
    if (flag === '--help' || flag === '-h') return { help: true };
    const key = valueFlags.get(flag);
    if (!key) throw new Error(`unknown argument: ${token}`);
    const value = inline ?? argv[++index];
    if (!value) throw new Error(`${flag} requires a value`);
    if (Array.isArray(options[key])) options[key].push(value);
    else if (options[key] !== undefined) throw new Error(`${flag} may be supplied once`);
    else options[key] = value;
  }
  if (!options.root || !options.out || options.entries.length === 0) {
    throw new Error('--root, --out and at least one --entry are required');
  }
  return options;
}

function printUsage() {
  console.log(
    [
      'Usage:',
      '  node hms-stagehand-bundle.mjs --root <checkout> --out <artifact> --entry <relative-file>',
      '    [--entry <relative-file> ...] [--manifest <relative-file> ...] [--asset <relative-file> ...]',
      '    [--source <relative-file> ...] [--dependency name@version ...] [--external name@version ...]',
      '    [--esbuild <path>]',
      '',
      'Output: isolated artifact with entrypoints/, source/, explicit runtime assets,',
      'node_modules for pinned external packages, bundle-manifest.json and launch.mjs.',
    ].join('\n'),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) printUsage();
    else {
      const result = await bundleStagehandTrial(options);
      console.log(
        JSON.stringify(
          {
            outputDir: result.outputDir,
            sourceFingerprint: result.manifest.sourceFingerprint,
            bundleFingerprint: result.manifest.bundleFingerprint,
            reused: result.reused,
            entries: result.manifest.entries,
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
