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

export type PrivateOutputRootFileSystem = Pick<
  PrivateOutputFileSystem,
  'chmod' | 'lstat' | 'mkdir' | 'realpath'
>;

export type PrivateOutputRootVerifier = (
  repoRoot: string,
  privateDirectoryName: string,
) => boolean | Promise<boolean>;

export type PrivateOutputWriterConfig = {
  /** Existing repository root. Symlink and junction roots are refused. */
  repoRoot: string;
  /** Direct child directory below the repository's fixed `.private` directory. */
  privateDirectoryName: string;
  /** File extensions this writer may publish, for example `.md` and `.jsonl`. */
  allowedExtensions: readonly string[];
};

export type TrustedPrivateOutputRoot = {
  repoRoot: string;
  privateRoot: string;
  outputRoot: string;
  platform: NodeJS.Platform;
};

export type TrustedPrivateOutputRootOptions = {
  fileSystem?: PrivateOutputRootFileSystem;
  /** Test seam for platform-specific permission validation. */
  platform?: NodeJS.Platform;
  /** Test seam; production uses the shared Git-ignore verifier below. */
  verifyIgnoredPrivateOutputDirectory?: PrivateOutputRootVerifier;
};

export type PrivateOutputWriterOptions = Omit<TrustedPrivateOutputRootOptions, 'fileSystem'> & {
  fileSystem?: PrivateOutputFileSystem;
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

const PRIVATE_OUTPUT_WRITE_ERROR = 'Private output write failed';
const PRIVATE_INPUT_READ_ERROR = 'Private input read failed';
const INVALID_PRIVATE_OUTPUT_CONFIGURATION = 'Invalid private output configuration';
const PRIVATE_OUTPUT_ROOT_PREFLIGHT_ERROR = 'Private output root preflight failed';
const PRIVATE_OUTPUT_ROOT_NOT_IGNORED = 'Private output root is not ignored';
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

function failRootPreflight(): never {
  throw new Error(PRIVATE_OUTPUT_ROOT_PREFLIGHT_ERROR);
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

export function samePrivateOutputPath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
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
    if (
      !gitRepoRoot ||
      !samePrivateOutputPath(path.resolve(gitRepoRoot), requestedRepoRoot, process.platform)
    ) {
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
  if (!samePrivateOutputPath(path.dirname(outputPath), outputRoot, platform)) failWrite();
  return outputPath;
}

export async function assertTrustedPrivateDirectory(
  fileSystem: PrivateOutputRootFileSystem,
  directory: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const entry = await fileSystem.lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) failRootPreflight();
  if (!samePrivateOutputPath(await fileSystem.realpath(directory), directory, platform)) {
    failRootPreflight();
  }
}

export async function setPrivateOutputMode(
  fileSystem: Pick<PrivateOutputRootFileSystem, 'chmod' | 'lstat'>,
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

  if (platform !== 'win32') {
    const entry = await fileSystem.lstat(target);
    if (entry.isSymbolicLink() || (entry.mode & 0o777) !== mode) {
      failRootPreflight();
    }
  }
}

export async function ensureTrustedPrivateDirectory(
  fileSystem: PrivateOutputRootFileSystem,
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

  await assertTrustedPrivateDirectory(fileSystem, directory, platform);
  await setPrivateOutputMode(fileSystem, directory, 0o700, platform);
}

async function assertIgnoredTrustedPrivateOutputRoot(
  config: PrivateOutputWriterConfig,
  verifier: PrivateOutputRootVerifier,
): Promise<void> {
  let isIgnored = false;
  try {
    isIgnored = await verifier(config.repoRoot, config.privateDirectoryName);
  } catch {
    failRootPreflight();
  }
  if (!isIgnored) throw new Error(PRIVATE_OUTPUT_ROOT_NOT_IGNORED);
}

async function canonicalTrustedPrivateRepository(
  fileSystem: PrivateOutputRootFileSystem,
  repoRoot: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const requestedRepoRoot = path.resolve(repoRoot);
  const canonicalRepoRoot = await fileSystem.realpath(requestedRepoRoot);
  if (!samePrivateOutputPath(canonicalRepoRoot, requestedRepoRoot, platform)) {
    failRootPreflight();
  }
  await assertTrustedPrivateDirectory(fileSystem, canonicalRepoRoot, platform);
  return canonicalRepoRoot;
}

export async function prepareTrustedPrivateOutputRoot(
  inputConfig: PrivateOutputWriterConfig,
  options: TrustedPrivateOutputRootOptions = {},
): Promise<TrustedPrivateOutputRoot> {
  const config = assertConfiguration(inputConfig);
  const fileSystem = options.fileSystem ?? LOCAL_FILE_SYSTEM;
  const platform = options.platform ?? process.platform;
  const verifier =
    options.verifyIgnoredPrivateOutputDirectory ?? isIgnoredPrivateOutputDirectory;
  const canonicalRepoRoot = await canonicalTrustedPrivateRepository(
    fileSystem,
    config.repoRoot,
    platform,
  );
  await assertIgnoredTrustedPrivateOutputRoot({ ...config, repoRoot: canonicalRepoRoot }, verifier);

  const privateRoot = path.join(canonicalRepoRoot, '.private');
  await ensureTrustedPrivateDirectory(fileSystem, privateRoot, platform);
  const outputRoot = path.join(privateRoot, config.privateDirectoryName);
  await ensureTrustedPrivateDirectory(fileSystem, outputRoot, platform);

  return { repoRoot: canonicalRepoRoot, privateRoot, outputRoot, platform };
}

export async function prepareExistingTrustedPrivateOutputRoot(
  inputConfig: PrivateOutputWriterConfig,
  options: TrustedPrivateOutputRootOptions = {},
): Promise<TrustedPrivateOutputRoot> {
  const config = assertConfiguration(inputConfig);
  const fileSystem = options.fileSystem ?? LOCAL_FILE_SYSTEM;
  const platform = options.platform ?? process.platform;
  const verifier =
    options.verifyIgnoredPrivateOutputDirectory ?? isIgnoredPrivateOutputDirectory;
  const canonicalRepoRoot = await canonicalTrustedPrivateRepository(
    fileSystem,
    config.repoRoot,
    platform,
  );
  await assertIgnoredTrustedPrivateOutputRoot({ ...config, repoRoot: canonicalRepoRoot }, verifier);

  const privateRoot = path.join(canonicalRepoRoot, '.private');
  const outputRoot = path.join(privateRoot, config.privateDirectoryName);
  await assertTrustedPrivateDirectory(fileSystem, privateRoot, platform);
  await setPrivateOutputMode(fileSystem, privateRoot, 0o700, platform);
  await assertTrustedPrivateDirectory(fileSystem, outputRoot, platform);
  await setPrivateOutputMode(fileSystem, outputRoot, 0o700, platform);

  return { repoRoot: canonicalRepoRoot, privateRoot, outputRoot, platform };
}

async function assertSafeExistingOutputTarget(
  fileSystem: PrivateOutputFileSystem,
  outputPath: string,
  platform: NodeJS.Platform,
): Promise<void> {
  try {
    const entry = await fileSystem.lstat(outputPath);
    if (!entry.isFile() || entry.isSymbolicLink()) failWrite();
    if (!samePrivateOutputPath(await fileSystem.realpath(outputPath), outputPath, platform)) {
      failWrite();
    }
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
}

async function revalidateTrustedPrivateRoot(
  fileSystem: PrivateOutputFileSystem,
  config: PrivateOutputWriterConfig,
  expected: TrustedPrivateOutputRoot,
  outputName: string,
  outputPath: string,
  platform: NodeJS.Platform,
  verifier: PrivateOutputRootVerifier | undefined,
): Promise<void> {
  const revalidated = await prepareExistingTrustedPrivateOutputRoot(config, {
    fileSystem,
    platform,
    verifyIgnoredPrivateOutputDirectory: verifier,
  });
  const revalidatedOutputPath = directOutputPath(
    revalidated.outputRoot,
    outputName,
    platform,
  );
  if (
    !samePrivateOutputPath(revalidated.repoRoot, expected.repoRoot, platform) ||
    !samePrivateOutputPath(revalidated.privateRoot, expected.privateRoot, platform) ||
    !samePrivateOutputPath(revalidated.outputRoot, expected.outputRoot, platform) ||
    !samePrivateOutputPath(revalidatedOutputPath, outputPath, platform)
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
  if (!samePrivateOutputPath(await fileSystem.realpath(inputPath), inputPath, platform)) {
    failWrite();
  }
}

async function revalidateTrustedPrivateInputRoot(
  fileSystem: PrivateOutputFileSystem,
  config: PrivateOutputWriterConfig,
  expected: TrustedPrivateOutputRoot,
  inputName: string,
  inputPath: string,
  platform: NodeJS.Platform,
  verifier: PrivateOutputRootVerifier | undefined,
): Promise<void> {
  const revalidated = await prepareExistingTrustedPrivateOutputRoot(config, {
    fileSystem,
    platform,
    verifyIgnoredPrivateOutputDirectory: verifier,
  });
  const revalidatedInputPath = directOutputPath(
    revalidated.outputRoot,
    inputName,
    platform,
  );
  if (
    !samePrivateOutputPath(revalidated.repoRoot, expected.repoRoot, platform) ||
    !samePrivateOutputPath(revalidated.privateRoot, expected.privateRoot, platform) ||
    !samePrivateOutputPath(revalidated.outputRoot, expected.outputRoot, platform) ||
    !samePrivateOutputPath(revalidatedInputPath, inputPath, platform)
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
  const verifier = options.verifyIgnoredPrivateOutputDirectory;
  const allowedExtensions = new Set(config.allowedExtensions);

  return {
    async read(inputName): Promise<string> {
      try {
        assertOutputName(inputName, allowedExtensions);
        const trustedRoot = await prepareExistingTrustedPrivateOutputRoot(config, {
          fileSystem,
          platform,
          verifyIgnoredPrivateOutputDirectory: verifier,
        });
        const inputPath = directOutputPath(trustedRoot.outputRoot, inputName, platform);
        await assertSafeExistingInputTarget(fileSystem, inputPath, platform);
        await revalidateTrustedPrivateInputRoot(
          fileSystem,
          config,
          trustedRoot,
          inputName,
          inputPath,
          platform,
          verifier,
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
          verifier,
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
  const verifier = options.verifyIgnoredPrivateOutputDirectory;
  const allowedExtensions = new Set(config.allowedExtensions);

  return {
    async write(outputName, content): Promise<string> {
      let temporaryDirectory: string | undefined;
      try {
        assertOutputName(outputName, allowedExtensions);
        const trustedRoot = await prepareTrustedPrivateOutputRoot(config, {
          fileSystem,
          platform,
          verifyIgnoredPrivateOutputDirectory: verifier,
        });
        const outputPath = directOutputPath(trustedRoot.outputRoot, outputName, platform);
        await assertSafeExistingOutputTarget(fileSystem, outputPath, platform);
        await revalidateTrustedPrivateRoot(
          fileSystem,
          config,
          trustedRoot,
          outputName,
          outputPath,
          platform,
          verifier,
        );

        temporaryDirectory = await fileSystem.mkdtemp(path.join(trustedRoot.outputRoot, '.tmp-'));
        if (!samePrivateOutputPath(path.dirname(temporaryDirectory), trustedRoot.outputRoot, platform))
          failWrite();
        await assertTrustedPrivateDirectory(fileSystem, temporaryDirectory, platform);
        await setPrivateOutputMode(fileSystem, temporaryDirectory, 0o700, platform);

        const temporaryPath = path.join(temporaryDirectory, outputName);
        if (!samePrivateOutputPath(path.dirname(temporaryPath), temporaryDirectory, platform)) {
          failWrite();
        }
        await fileSystem.writeFile(temporaryPath, content, { mode: 0o600 });
        await setPrivateOutputMode(fileSystem, temporaryPath, 0o600, platform);
        await revalidateTrustedPrivateRoot(
          fileSystem,
          config,
          trustedRoot,
          outputName,
          outputPath,
          platform,
          verifier,
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
