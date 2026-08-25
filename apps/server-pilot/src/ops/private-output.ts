import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export type PrivateOutputFileSystem = {
  chmod: typeof chmod;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  mkdtemp: typeof mkdtemp;
  readFile: typeof readFile;
  realpath: typeof realpath;
  rename: typeof rename;
  rm: typeof rm;
  stat: typeof stat;
  writeFile: typeof writeFile;
};

export type PrivateOutputWriterConfig = {
  /** Existing repository root. Symlink and junction roots are refused. */
  repoRoot: string;
  /** Direct child directory below the repository's fixed `.private` directory. */
  privateDirectoryName: string;
  /** File extensions this writer may publish, for example `.md` and `.jsonl`. */
  allowedExtensions: readonly string[];
};

export type PrivateOutputWriterOptions = {
  fileSystem?: PrivateOutputFileSystem;
  /** Test seam for platform-specific permission validation. */
  platform?: NodeJS.Platform;
};

export type PrivateOutputWriter = {
  /**
   * Atomically publishes content as a direct child of configured private root.
   * Content stays opaque: this helper never logs or serializes it.
   */
  write(outputName: string, content: string | Uint8Array): Promise<string>;
};

export type PrivateInputReader = {
  /**
   * Reads an existing direct child of configured private root.
   * Content stays opaque: this helper never logs or serializes it.
   */
  read(inputName: string): Promise<string>;
};

type TrustedPrivateRoot = {
  repoRoot: string;
  privateRoot: string;
  outputRoot: string;
};

const PRIVATE_OUTPUT_WRITE_ERROR = 'Private output write failed';
const PRIVATE_INPUT_READ_ERROR = 'Private input read failed';
const INVALID_PRIVATE_OUTPUT_CONFIGURATION = 'Invalid private output configuration';
const DIRECTORY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const OUTPUT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'AUX',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'CON',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
  'NUL',
  'PRN',
]);

const LOCAL_FILE_SYSTEM: PrivateOutputFileSystem = {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
};

function failWrite(): never {
  throw new Error(PRIVATE_OUTPUT_WRITE_ERROR);
}

function failRead(): never {
  throw new Error(PRIVATE_INPUT_READ_ERROR);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function isMissingPathError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isAlreadyExistsError(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isWindowsReservedDeviceName(name: string): boolean {
  return WINDOWS_RESERVED_DEVICE_NAMES.has(name.split('.', 1)[0]!.toUpperCase());
}

/**
 * Returns whether one direct `.private` child is ignored under exactly this Git worktree root.
 * It deliberately emits no command output and treats every Git failure as unsafe.
 */
export function isIgnoredPrivateOutputDirectory(
  repoRoot: string,
  privateDirectoryName: string,
): boolean {
  if (
    typeof repoRoot !== 'string' ||
    !repoRoot ||
    typeof privateDirectoryName !== 'string' ||
    !DIRECTORY_NAME_PATTERN.test(privateDirectoryName) ||
    isWindowsReservedDeviceName(privateDirectoryName)
  ) {
    return false;
  }

  const requestedRepoRoot = path.resolve(repoRoot);
  try {
    const gitRepoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: requestedRepoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!gitRepoRoot || !samePath(path.resolve(gitRepoRoot), requestedRepoRoot, process.platform)) {
      return false;
    }

    execFileSync('git', ['check-ignore', '--quiet', '--', `.private/${privateDirectoryName}/`], {
      cwd: requestedRepoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function assertConfiguration(config: PrivateOutputWriterConfig): PrivateOutputWriterConfig {
  if (
    !config ||
    typeof config.repoRoot !== 'string' ||
    config.repoRoot.length === 0 ||
    typeof config.privateDirectoryName !== 'string' ||
    !DIRECTORY_NAME_PATTERN.test(config.privateDirectoryName) ||
    isWindowsReservedDeviceName(config.privateDirectoryName) ||
    !Array.isArray(config.allowedExtensions) ||
    config.allowedExtensions.length === 0
  ) {
    throw new Error(INVALID_PRIVATE_OUTPUT_CONFIGURATION);
  }

  const extensions = new Set<string>();
  for (const extension of config.allowedExtensions) {
    if (typeof extension !== 'string' || !/^\.[A-Za-z0-9]+$/.test(extension)) {
      throw new Error(INVALID_PRIVATE_OUTPUT_CONFIGURATION);
    }
    extensions.add(extension);
  }
  if (extensions.size !== config.allowedExtensions.length) {
    throw new Error(INVALID_PRIVATE_OUTPUT_CONFIGURATION);
  }

  return {
    repoRoot: path.resolve(config.repoRoot),
    privateDirectoryName: config.privateDirectoryName,
    allowedExtensions: [...extensions],
  };
}

function assertOutputName(outputName: string, allowedExtensions: ReadonlySet<string>): void {
  if (
    typeof outputName !== 'string' ||
    !OUTPUT_NAME_PATTERN.test(outputName) ||
    isWindowsReservedDeviceName(outputName) ||
    path.isAbsolute(outputName) ||
    path.basename(outputName) !== outputName ||
    !allowedExtensions.has(path.extname(outputName))
  ) {
    failWrite();
  }
}

function directOutputPath(
  outputRoot: string,
  outputName: string,
  platform: NodeJS.Platform,
): string {
  const outputPath = path.resolve(outputRoot, outputName);
  if (!samePath(path.dirname(outputPath), outputRoot, platform)) failWrite();
  return outputPath;
}

async function assertTrustedDirectory(
  fileSystem: PrivateOutputFileSystem,
  directory: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const entry = await fileSystem.lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) failWrite();
  if (!samePath(await fileSystem.realpath(directory), directory, platform)) failWrite();
}

async function setPrivateMode(
  fileSystem: PrivateOutputFileSystem,
  target: string,
  mode: number,
  platform: NodeJS.Platform,
): Promise<void> {
  try {
    await fileSystem.chmod(target, mode);
  } catch (error) {
    if (
      platform === 'win32' &&
      ['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(errorCode(error) ?? '')
    ) {
      return;
    }
    throw error;
  }

  if (platform !== 'win32' && ((await fileSystem.stat(target)).mode & 0o777) !== mode) {
    failWrite();
  }
}

async function ensureTrustedDirectory(
  fileSystem: PrivateOutputFileSystem,
  directory: string,
  platform: NodeJS.Platform,
): Promise<void> {
  try {
    await fileSystem.lstat(directory);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    try {
      await fileSystem.mkdir(directory, { recursive: false, mode: 0o700 });
    } catch (createError) {
      if (!isAlreadyExistsError(createError)) throw createError;
    }
  }

  await assertTrustedDirectory(fileSystem, directory, platform);
  await setPrivateMode(fileSystem, directory, 0o700, platform);
}

async function prepareTrustedPrivateRoot(
  fileSystem: PrivateOutputFileSystem,
  config: PrivateOutputWriterConfig,
  platform: NodeJS.Platform,
): Promise<TrustedPrivateRoot> {
  if (!isIgnoredPrivateOutputDirectory(config.repoRoot, config.privateDirectoryName)) failWrite();
  const requestedRepoRoot = path.resolve(config.repoRoot);
  const canonicalRepoRoot = await fileSystem.realpath(requestedRepoRoot);
  if (!samePath(canonicalRepoRoot, requestedRepoRoot, platform)) failWrite();
  await assertTrustedDirectory(fileSystem, canonicalRepoRoot, platform);

  const privateRoot = path.join(canonicalRepoRoot, '.private');
  await ensureTrustedDirectory(fileSystem, privateRoot, platform);
  const outputRoot = path.join(privateRoot, config.privateDirectoryName);
  await ensureTrustedDirectory(fileSystem, outputRoot, platform);

  return { repoRoot: canonicalRepoRoot, privateRoot, outputRoot };
}

async function prepareExistingTrustedPrivateRoot(
  fileSystem: PrivateOutputFileSystem,
  config: PrivateOutputWriterConfig,
  platform: NodeJS.Platform,
): Promise<TrustedPrivateRoot> {
  if (!isIgnoredPrivateOutputDirectory(config.repoRoot, config.privateDirectoryName)) failWrite();
  const requestedRepoRoot = path.resolve(config.repoRoot);
  const canonicalRepoRoot = await fileSystem.realpath(requestedRepoRoot);
  if (!samePath(canonicalRepoRoot, requestedRepoRoot, platform)) failWrite();
  await assertTrustedDirectory(fileSystem, canonicalRepoRoot, platform);

  const privateRoot = path.join(canonicalRepoRoot, '.private');
  const outputRoot = path.join(privateRoot, config.privateDirectoryName);
  await assertTrustedDirectory(fileSystem, privateRoot, platform);
  await assertTrustedDirectory(fileSystem, outputRoot, platform);

  return { repoRoot: canonicalRepoRoot, privateRoot, outputRoot };
}

async function assertSafeExistingOutputTarget(
  fileSystem: PrivateOutputFileSystem,
  outputPath: string,
  platform: NodeJS.Platform,
): Promise<void> {
  try {
    const entry = await fileSystem.lstat(outputPath);
    if (!entry.isFile() || entry.isSymbolicLink()) failWrite();
    if (!samePath(await fileSystem.realpath(outputPath), outputPath, platform)) failWrite();
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
}

async function revalidateTrustedPrivateRoot(
  fileSystem: PrivateOutputFileSystem,
  config: PrivateOutputWriterConfig,
  expected: TrustedPrivateRoot,
  outputName: string,
  outputPath: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (!isIgnoredPrivateOutputDirectory(config.repoRoot, config.privateDirectoryName)) failWrite();
  const requestedRepoRoot = path.resolve(config.repoRoot);
  const canonicalRepoRoot = await fileSystem.realpath(requestedRepoRoot);
  if (!samePath(canonicalRepoRoot, requestedRepoRoot, platform)) failWrite();
  await assertTrustedDirectory(fileSystem, canonicalRepoRoot, platform);

  const privateRoot = path.join(canonicalRepoRoot, '.private');
  const outputRoot = path.join(privateRoot, config.privateDirectoryName);
  await assertTrustedDirectory(fileSystem, privateRoot, platform);
  await assertTrustedDirectory(fileSystem, outputRoot, platform);

  const revalidatedOutputPath = directOutputPath(outputRoot, outputName, platform);
  if (
    !samePath(canonicalRepoRoot, expected.repoRoot, platform) ||
    !samePath(privateRoot, expected.privateRoot, platform) ||
    !samePath(outputRoot, expected.outputRoot, platform) ||
    !samePath(revalidatedOutputPath, outputPath, platform)
  ) {
    failWrite();
  }
  await assertSafeExistingOutputTarget(fileSystem, revalidatedOutputPath, platform);
}

async function assertSafeExistingInputTarget(
  fileSystem: PrivateOutputFileSystem,
  inputPath: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const entry = await fileSystem.lstat(inputPath);
  if (!entry.isFile() || entry.isSymbolicLink()) failWrite();
  if (!samePath(await fileSystem.realpath(inputPath), inputPath, platform)) failWrite();
}

async function revalidateTrustedPrivateInputRoot(
  fileSystem: PrivateOutputFileSystem,
  config: PrivateOutputWriterConfig,
  expected: TrustedPrivateRoot,
  inputName: string,
  inputPath: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (!isIgnoredPrivateOutputDirectory(config.repoRoot, config.privateDirectoryName)) failWrite();
  const requestedRepoRoot = path.resolve(config.repoRoot);
  const canonicalRepoRoot = await fileSystem.realpath(requestedRepoRoot);
  if (!samePath(canonicalRepoRoot, requestedRepoRoot, platform)) failWrite();
  await assertTrustedDirectory(fileSystem, canonicalRepoRoot, platform);

  const privateRoot = path.join(canonicalRepoRoot, '.private');
  const outputRoot = path.join(privateRoot, config.privateDirectoryName);
  await assertTrustedDirectory(fileSystem, privateRoot, platform);
  await assertTrustedDirectory(fileSystem, outputRoot, platform);

  const revalidatedInputPath = directOutputPath(outputRoot, inputName, platform);
  if (
    !samePath(canonicalRepoRoot, expected.repoRoot, platform) ||
    !samePath(privateRoot, expected.privateRoot, platform) ||
    !samePath(outputRoot, expected.outputRoot, platform) ||
    !samePath(revalidatedInputPath, inputPath, platform)
  ) {
    failWrite();
  }
  await assertSafeExistingInputTarget(fileSystem, revalidatedInputPath, platform);
}

/**
 * Creates a reader scoped to one existing `.private/<directory>` root.
 * It refuses arbitrary, nested, missing, and symlinked paths.
 */
export function createPrivateInputReader(
  inputConfig: PrivateOutputWriterConfig,
  options: PrivateOutputWriterOptions = {},
): PrivateInputReader {
  const config = assertConfiguration(inputConfig);
  const fileSystem = options.fileSystem ?? LOCAL_FILE_SYSTEM;
  const platform = options.platform ?? process.platform;
  const allowedExtensions = new Set(config.allowedExtensions);

  return {
    async read(inputName): Promise<string> {
      try {
        assertOutputName(inputName, allowedExtensions);
        const trustedRoot = await prepareExistingTrustedPrivateRoot(fileSystem, config, platform);
        const inputPath = directOutputPath(trustedRoot.outputRoot, inputName, platform);
        await assertSafeExistingInputTarget(fileSystem, inputPath, platform);
        await revalidateTrustedPrivateInputRoot(
          fileSystem,
          config,
          trustedRoot,
          inputName,
          inputPath,
          platform,
        );
        const content = await fileSystem.readFile(inputPath, 'utf8');
        if (typeof content !== 'string') failRead();
        await revalidateTrustedPrivateInputRoot(
          fileSystem,
          config,
          trustedRoot,
          inputName,
          inputPath,
          platform,
        );
        return content;
      } catch {
        throw new Error(PRIVATE_INPUT_READ_ERROR);
      }
    },
  };
}

/**
 * Creates a writer scoped to one ignored `.private/<directory>` root.
 * It accepts opaque bytes/text only; callers own formatting and serialization.
 */
export function createPrivateOutputWriter(
  inputConfig: PrivateOutputWriterConfig,
  options: PrivateOutputWriterOptions = {},
): PrivateOutputWriter {
  const config = assertConfiguration(inputConfig);
  const fileSystem = options.fileSystem ?? LOCAL_FILE_SYSTEM;
  const platform = options.platform ?? process.platform;
  const allowedExtensions = new Set(config.allowedExtensions);

  return {
    async write(outputName, content): Promise<string> {
      let temporaryDirectory: string | undefined;
      try {
        assertOutputName(outputName, allowedExtensions);
        const trustedRoot = await prepareTrustedPrivateRoot(fileSystem, config, platform);
        const outputPath = directOutputPath(trustedRoot.outputRoot, outputName, platform);
        await assertSafeExistingOutputTarget(fileSystem, outputPath, platform);
        await revalidateTrustedPrivateRoot(
          fileSystem,
          config,
          trustedRoot,
          outputName,
          outputPath,
          platform,
        );

        temporaryDirectory = await fileSystem.mkdtemp(path.join(trustedRoot.outputRoot, '.tmp-'));
        if (!samePath(path.dirname(temporaryDirectory), trustedRoot.outputRoot, platform))
          failWrite();
        await assertTrustedDirectory(fileSystem, temporaryDirectory, platform);
        await setPrivateMode(fileSystem, temporaryDirectory, 0o700, platform);

        const temporaryPath = path.join(temporaryDirectory, outputName);
        if (!samePath(path.dirname(temporaryPath), temporaryDirectory, platform)) failWrite();
        await fileSystem.writeFile(temporaryPath, content, { mode: 0o600 });
        await setPrivateMode(fileSystem, temporaryPath, 0o600, platform);
        await revalidateTrustedPrivateRoot(
          fileSystem,
          config,
          trustedRoot,
          outputName,
          outputPath,
          platform,
        );
        await fileSystem.rename(temporaryPath, outputPath);
        return outputPath;
      } catch {
        throw new Error(PRIVATE_OUTPUT_WRITE_ERROR);
      } finally {
        if (temporaryDirectory) {
          try {
            await fileSystem.rm(temporaryDirectory, { recursive: true, force: true });
          } catch {
            // A cleanup failure must not disclose filesystem details or content.
          }
        }
      }
    },
  };
}
