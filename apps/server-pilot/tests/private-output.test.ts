import {
  createPrivateInputReader,
  createPrivateOutputWriter,
  type PrivateOutputFileSystem,
  type PrivateOutputWriterConfig,
  type PrivateOutputWriterOptions,
} from '../src/ops/private-output';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import path from 'node:path';

const localFileSystem: PrivateOutputFileSystem = {
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

async function withTemporaryRepo<T>(
  run: (repoRoot: string) => Promise<T>,
  options: { ignoreConfiguredPrivateRoot?: boolean } = {},
): Promise<T> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'private-output-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repoRoot, stdio: 'ignore' });
    if (options.ignoreConfiguredPrivateRoot ?? true) {
      await writeFile(
        path.join(repoRoot, '.gitignore'),
        '/.private/connected-mailbox-corpus/\n',
        'utf8',
      );
    }
    return await run(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

function createWriter(
  repoRoot: string,
  overrides: Partial<
    Pick<PrivateOutputWriterConfig, 'privateDirectoryName' | 'allowedExtensions'>
  > = {},
  options: PrivateOutputWriterOptions = {},
) {
  return createPrivateOutputWriter(
    {
      repoRoot,
      privateDirectoryName: 'connected-mailbox-corpus',
      allowedExtensions: ['.md', '.jsonl'],
      ...overrides,
    },
    options,
  );
}

function createReader(
  repoRoot: string,
  overrides: Partial<
    Pick<PrivateOutputWriterConfig, 'privateDirectoryName' | 'allowedExtensions'>
  > = {},
  options: PrivateOutputWriterOptions = {},
) {
  return createPrivateInputReader(
    {
      repoRoot,
      privateDirectoryName: 'connected-mailbox-corpus',
      allowedExtensions: ['.md', '.jsonl'],
      ...overrides,
    },
    options,
  );
}

function privateRoot(repoRoot: string): string {
  return path.join(repoRoot, '.private', 'connected-mailbox-corpus');
}

async function tryCreateDirectoryLink(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === 'EACCES' || code === 'ENOTSUP' || code === 'EPERM') return false;
    throw error;
  }
}

async function tryCreateFileLink(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, 'file');
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === 'EACCES' || code === 'ENOTSUP' || code === 'EPERM') return false;
    throw error;
  }
}

describe('private output writer', () => {
  it('reads only allowed direct-child files from verified private root', async () => {
    await withTemporaryRepo(async (repoRoot) => {
      const root = privateRoot(repoRoot);
      const labelsPath = path.join(root, 'labels.jsonl');
      await mkdir(root, { recursive: true });
      await writeFile(labelsPath, '{"synthetic":true}\n', 'utf8');

      const reader = createReader(repoRoot);
      await expect(reader.read('labels.jsonl')).resolves.toBe('{"synthetic":true}\n');

      const trackedPath = path.join(repoRoot, 'tracked.jsonl');
      for (const inputName of [
        '../tracked.jsonl',
        'nested/labels.jsonl',
        trackedPath,
        'labels.txt',
        'AUX.jsonl',
      ]) {
        await expect(reader.read(inputName)).rejects.toThrow(/^Private input read failed$/);
      }
      await expect(readdir(repoRoot)).resolves.toEqual(
        expect.arrayContaining(['.git', '.gitignore', '.private']),
      );
    });
  });

  it('tightens existing private reader roots before reading their content', async () => {
    await withTemporaryRepo(async (repoRoot) => {
      const privateDirectory = path.join(repoRoot, '.private');
      const root = privateRoot(repoRoot);
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, 'labels.jsonl'), '{"synthetic":true}\n', 'utf8');
      await chmod(privateDirectory, 0o755);
      await chmod(root, 0o755);

      await expect(createReader(repoRoot).read('labels.jsonl')).resolves.toBe(
        '{"synthetic":true}\n',
      );

      if (process.platform !== 'win32') {
        const [privateStats, rootStats] = await Promise.all([
          stat(privateDirectory),
          stat(root),
        ]);
        expect(privateStats.mode & 0o777).toBe(0o700);
        expect(rootStats.mode & 0o777).toBe(0o700);
      }
    });
  });

  it('fails closed for an unignored configured root without creating writer output', async () => {
    await withTemporaryRepo(
      async (repoRoot) => {
        await expect(createWriter(repoRoot).write('summary.md', 'synthetic')).rejects.toThrow(
          /^Private output write failed$/,
        );

        expect(await readdir(repoRoot)).not.toContain('.private');
      },
      { ignoreConfiguredPrivateRoot: false },
    );
  });

  it('fails closed for a reader when its configured root is unignored', async () => {
    await withTemporaryRepo(
      async (repoRoot) => {
        const root = privateRoot(repoRoot);
        await mkdir(root, { recursive: true });
        await writeFile(path.join(root, 'labels.jsonl'), '{"synthetic":true}\n', 'utf8');

        await expect(createReader(repoRoot).read('labels.jsonl')).rejects.toThrow(
          /^Private input read failed$/,
        );
      },
      { ignoreConfiguredPrivateRoot: false },
    );
  });

  it('rejects symlinked private input targets without reading destinations', async () => {
    await withTemporaryRepo(async (repoRoot) => {
      const root = privateRoot(repoRoot);
      const outsidePath = path.join(repoRoot, 'outside.jsonl');
      await Promise.all([
        mkdir(root, { recursive: true }),
        writeFile(outsidePath, '{"preserve":"synthetic"}\n', 'utf8'),
      ]);
      if (!(await tryCreateFileLink(outsidePath, path.join(root, 'labels.jsonl')))) return;

      await expect(createReader(repoRoot).read('labels.jsonl')).rejects.toThrow(
        /^Private input read failed$/,
      );
      await expect(readFile(outsidePath, 'utf8')).resolves.toBe('{"preserve":"synthetic"}\n');
    });
  });

  it('hides private input content when reads fail', async () => {
    await withTemporaryRepo(async (repoRoot) => {
      const root = privateRoot(repoRoot);
      const payload = 'SYNTHETIC_PRIVATE_INPUT_TOKEN';
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, 'labels.jsonl'), payload, 'utf8');

      const reader = createReader(
        repoRoot,
        {},
        {
          fileSystem: {
            ...localFileSystem,
            async readFile() {
              throw new Error(`synthetic read failure: ${payload}`);
            },
          },
        },
      );

      await expect(reader.read('labels.jsonl')).rejects.toThrow(/^Private input read failed$/);
    });
  });

  it('writes allowed Markdown and JSONL direct children with restrictive modes', async () => {
    await withTemporaryRepo(async (repoRoot) => {
      const chmodCalls: Array<{ target: string; mode: number }> = [];
      const writer = createWriter(
        repoRoot,
        {},
        {
          fileSystem: {
            ...localFileSystem,
            async chmod(...args: Parameters<typeof chmod>) {
              chmodCalls.push({ target: String(args[0]), mode: Number(args[1]) });
              return chmod(...args);
            },
          },
        },
      );

      const markdownPath = await writer.write('summary.md', '# Synthetic summary\n');
      const jsonlPath = await writer.write('corpus.jsonl', '{"synthetic":true}\n');
      const root = privateRoot(repoRoot);

      expect(path.dirname(markdownPath)).toBe(root);
      expect(path.dirname(jsonlPath)).toBe(root);
      await expect(readFile(markdownPath, 'utf8')).resolves.toBe('# Synthetic summary\n');
      await expect(readFile(jsonlPath, 'utf8')).resolves.toBe('{"synthetic":true}\n');
      await expect(readdir(root)).resolves.toEqual(['corpus.jsonl', 'summary.md']);
      expect(chmodCalls).toContainEqual({ target: root, mode: 0o700 });
      expect(chmodCalls.some((call) => call.mode === 0o600)).toBe(true);

      if (process.platform !== 'win32') {
        const [rootStats, markdownStats, jsonlStats] = await Promise.all([
          stat(root),
          stat(markdownPath),
          stat(jsonlPath),
        ]);
        expect(rootStats.mode & 0o777).toBe(0o700);
        expect(markdownStats.mode & 0o777).toBe(0o600);
        expect(jsonlStats.mode & 0o777).toBe(0o600);
      }
    });
  });

  it('rejects arbitrary, nested, and unsupported output names before writing', async () => {
    await withTemporaryRepo(async (repoRoot) => {
      const writer = createWriter(repoRoot);
      const outsidePath = path.join(repoRoot, 'tracked.md');

      for (const outputName of [
        '../outside.md',
        'nested/summary.md',
        outsidePath,
        'summary.txt',
        'AUX.md',
        'COM1.md',
        'CON.md',
        'LPT9.md',
        'NUL.jsonl',
      ]) {
        await expect(writer.write(outputName, 'synthetic')).rejects.toThrow(
          /^Private output write failed$/,
        );
      }
      expect(await readdir(repoRoot)).not.toContain('.private');
    });
  });

  it('rejects non-direct private root configuration', async () => {
    await withTemporaryRepo(async (repoRoot) => {
      expect(() => createWriter(repoRoot, { privateDirectoryName: '../tracked-output' })).toThrow(
        /^Invalid private output configuration$/,
      );
      expect(() => createWriter(repoRoot, { privateDirectoryName: 'NUL' })).toThrow(
        /^Invalid private output configuration$/,
      );
    });
  });

  it('rejects a symlinked repository root when platform permits links', async () => {
    await withTemporaryRepo(async (repoRoot) => {
      const linkedRepoRoot = `${repoRoot}-link`;
      try {
        if (!(await tryCreateDirectoryLink(repoRoot, linkedRepoRoot))) return;

        await expect(createWriter(linkedRepoRoot).write('summary.md', 'synthetic')).rejects.toThrow(
          /^Private output write failed$/,
        );
      } finally {
        await rm(linkedRepoRoot, { recursive: true, force: true });
      }
    });
  });

  it('rejects a symlinked .private path component when platform permits links', async () => {
    await withTemporaryRepo(async (repoRoot) => {
      const outsideRoot = path.join(repoRoot, 'outside');
      const privatePath = path.join(repoRoot, '.private');
      await mkdir(outsideRoot);
      if (!(await tryCreateDirectoryLink(outsideRoot, privatePath))) return;

      await expect(createWriter(repoRoot).write('summary.md', 'synthetic')).rejects.toThrow(
        /^Private output write failed$/,
      );
      await expect(readdir(outsideRoot)).resolves.toEqual([]);
    });
  });

  it('rejects a symlinked configured private root when platform permits links', async () => {
    await withTemporaryRepo(async (repoRoot) => {
      const outsideRoot = path.join(repoRoot, 'outside');
      const privatePath = path.join(repoRoot, '.private');
      await Promise.all([mkdir(outsideRoot), mkdir(privatePath)]);
      if (!(await tryCreateDirectoryLink(outsideRoot, privateRoot(repoRoot)))) return;

      await expect(createWriter(repoRoot).write('summary.md', 'synthetic')).rejects.toThrow(
        /^Private output write failed$/,
      );
      await expect(readdir(outsideRoot)).resolves.toEqual([]);
    });
  });

  it('rejects a symlinked output target without changing its destination', async () => {
    await withTemporaryRepo(async (repoRoot) => {
      const root = privateRoot(repoRoot);
      const outsideTarget = path.join(repoRoot, 'outside.md');
      await Promise.all([
        mkdir(root, { recursive: true }),
        writeFile(outsideTarget, 'preserve-synthetic-content', 'utf8'),
      ]);
      if (!(await tryCreateFileLink(outsideTarget, path.join(root, 'summary.md')))) return;

      await expect(createWriter(repoRoot).write('summary.md', 'synthetic')).rejects.toThrow(
        /^Private output write failed$/,
      );
      await expect(readFile(outsideTarget, 'utf8')).resolves.toBe('preserve-synthetic-content');
    });
  });

  it('uses unique temporary paths and revalidates root before rename', async () => {
    await withTemporaryRepo(async (repoRoot) => {
      const root = privateRoot(repoRoot);
      const temporaryDirectories: string[] = [];
      const renamedSources: string[] = [];
      const writer = createWriter(
        repoRoot,
        {},
        {
          fileSystem: {
            ...localFileSystem,
            async mkdtemp(...args: Parameters<typeof mkdtemp>) {
              const directory = await mkdtemp(...args);
              temporaryDirectories.push(directory);
              return directory;
            },
            async rename(...args: Parameters<typeof rename>) {
              renamedSources.push(String(args[0]));
              return rename(...args);
            },
          },
        },
      );

      await Promise.all([
        writer.write('first.md', 'first synthetic payload'),
        writer.write('second.jsonl', '{"synthetic":"second"}\n'),
      ]);

      expect(temporaryDirectories).toHaveLength(2);
      expect(new Set(temporaryDirectories).size).toBe(2);
      for (const temporaryDirectory of temporaryDirectories) {
        expect(path.dirname(temporaryDirectory)).toBe(root);
      }
      expect(renamedSources).toHaveLength(2);
      for (const source of renamedSources) {
        expect(path.dirname(path.dirname(source))).toBe(root);
        expect(source).not.toMatch(/\.tmp$/);
      }
    });

    await withTemporaryRepo(async (repoRoot) => {
      const root = privateRoot(repoRoot);
      let wroteTemporaryFile = false;
      let renameCalls = 0;
      const writer = createWriter(
        repoRoot,
        {},
        {
          fileSystem: {
            ...localFileSystem,
            async writeFile(...args: Parameters<typeof writeFile>) {
              const result = await writeFile(...args);
              wroteTemporaryFile = true;
              return result;
            },
            async realpath(target: Parameters<typeof realpath>[0]) {
              if (wroteTemporaryFile && path.resolve(String(target)) === root) {
                return path.join(repoRoot, 'replaced-root');
              }
              return realpath(target);
            },
            async rename(...args: Parameters<typeof rename>) {
              renameCalls += 1;
              return rename(...args);
            },
          },
        },
      );

      await expect(writer.write('summary.md', 'synthetic')).rejects.toThrow(
        /^Private output write failed$/,
      );
      expect(renameCalls).toBe(0);
    });
  });

  it('does not log or include payload content in write errors', async () => {
    await withTemporaryRepo(async (repoRoot) => {
      const payload = 'SYNTHETIC_PRIVATE_PAYLOAD_TOKEN';
      const log = vi.spyOn(console, 'log');
      const warn = vi.spyOn(console, 'warn');
      const error = vi.spyOn(console, 'error');
      const writer = createWriter(
        repoRoot,
        {},
        {
          fileSystem: {
            ...localFileSystem,
            async writeFile(...args: Parameters<typeof writeFile>) {
              throw new Error(`synthetic write failure: ${String(args[1])}`);
            },
          },
        },
      );

      try {
        await writer.write('summary.md', payload);
        throw new Error('Expected private output write to fail');
      } catch (writeError) {
        expect(writeError).toBeInstanceOf(Error);
        expect((writeError as Error).message).toBe('Private output write failed');
        expect((writeError as Error).message).not.toContain(payload);
      } finally {
        log.mockRestore();
        warn.mockRestore();
        error.mockRestore();
      }

      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });
  });
});
