import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';

type GoldenPairTransactionEntry = {
  target: string;
  staged: string;
  sha256: string;
};

type GoldenPairTransaction = {
  version: 1;
  entries: GoldenPairTransactionEntry[];
};

export type GoldenSetPairAccess = {
  recover(): Promise<void>;
  write(goldenContents: string, hmsNeededContents: string): Promise<void>;
};

const GOLDEN_PAIR_TRANSACTION_FILE = '.golden-v1-pair-update.json';
const GOLDEN_PAIR_LOCK_FILE = '.golden-v1-pair.lock';

async function writeDurableFile(file: string, contents: string | Uint8Array): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      file,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(contents);
    await handle.sync();
  } catch {
    throw new Error('Could not safely write private golden data');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    await handle.sync();
  } catch {
    throw new Error('Could not safely write private golden data');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function discardFile(file: string): Promise<void> {
  await unlink(file).catch(() => undefined);
}

export async function writePrivateFileAtomically(
  file: string,
  contents: string | Uint8Array,
): Promise<void> {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    await writeDurableFile(temporary, contents);
    await rename(temporary, file);
    renamed = true;
    await syncDirectory(dirname(file));
  } catch {
    if (!renamed) await discardFile(temporary);
    throw new Error('Could not safely write private golden data');
  }
}

function pairTransactionPaths(
  goldenPath: string,
  hmsNeededPath: string,
): { directory: string; journalPath: string; lockPath: string; targets: [string, string] } {
  const targets: [string, string] = [resolve(goldenPath), resolve(hmsNeededPath)];
  const directory = dirname(targets[0]);
  if (directory !== dirname(targets[1]) || targets[0] === targets[1]) {
    throw new Error('Golden and HMS-needed files must share one private directory');
  }
  return {
    directory,
    journalPath: join(directory, GOLDEN_PAIR_TRANSACTION_FILE),
    lockPath: join(directory, GOLDEN_PAIR_LOCK_FILE),
    targets,
  };
}

function parseGoldenPairTransaction(
  value: unknown,
  expectedTargets: readonly string[],
): GoldenPairTransaction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Private golden update journal is malformed');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.entries) || record.entries.length !== 2) {
    throw new Error('Private golden update journal is malformed');
  }
  const expected = new Set(expectedTargets);
  const entries: GoldenPairTransactionEntry[] = [];
  for (const value of record.entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Private golden update journal is malformed');
    }
    const row = value as Record<string, unknown>;
    const target = typeof row.target === 'string' ? row.target.trim() : '';
    const staged = typeof row.staged === 'string' ? row.staged.trim() : '';
    const sha256 = typeof row.sha256 === 'string' ? row.sha256.trim() : '';
    if (
      !target ||
      !expected.has(target) ||
      !staged ||
      basename(staged) !== staged ||
      !staged.startsWith(`${target}.`) ||
      !staged.endsWith('.stage') ||
      !/^[a-f0-9]{64}$/u.test(sha256)
    ) {
      throw new Error('Private golden update journal is malformed');
    }
    entries.push({ target, staged, sha256 });
  }
  if (
    new Set(entries.map((entry) => entry.target)).size !== expectedTargets.length ||
    new Set(entries.map((entry) => entry.staged)).size !== entries.length
  ) {
    throw new Error('Private golden update journal is malformed');
  }
  return { version: 1, entries };
}

async function readRegularPrivateFile(file: string): Promise<Buffer> {
  const fileInfo = await lstat(file);
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.nlink > 1) {
    throw new Error('Private golden update journal is unsafe');
  }
  return readFile(file);
}

function sha256(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function recoverGoldenSetPair(
  directory: string,
  journalPath: string,
  targets: [string, string],
): Promise<void> {
  let journalBytes: Buffer;
  try {
    journalBytes = await readRegularPrivateFile(journalPath);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return;
    throw new Error('Could not recover the private golden update');
  }

  let transaction: GoldenPairTransaction;
  try {
    transaction = parseGoldenPairTransaction(
      JSON.parse(journalBytes.toString('utf8')) as unknown,
      targets.map((target) => basename(target)),
    );
  } catch {
    throw new Error('Could not recover the private golden update');
  }
  const prepared = await Promise.all(
    transaction.entries.map(async (entry) => {
      const stagedPath = join(directory, entry.staged);
      const contents = await readRegularPrivateFile(stagedPath);
      if (sha256(contents) !== entry.sha256) {
        throw new Error('Private golden update stage does not match its journal');
      }
      return { target: join(directory, entry.target), stagedPath, contents };
    }),
  );
  for (const entry of prepared) await writePrivateFileAtomically(entry.target, entry.contents);
  for (const entry of prepared) {
    const installed = await readRegularPrivateFile(entry.target);
    const expected = transaction.entries.find((item) => item.target === basename(entry.target));
    if (!expected || sha256(installed) !== expected.sha256) {
      throw new Error('Private golden update did not install cleanly');
    }
  }

  await unlink(journalPath);
  await syncDirectory(directory);
  for (const entry of prepared) await discardFile(entry.stagedPath);
  await syncDirectory(directory);
}

async function writeGoldenSetPair(
  directory: string,
  journalPath: string,
  targets: [string, string],
  goldenContents: string,
  hmsNeededContents: string,
): Promise<void> {
  await recoverGoldenSetPair(directory, journalPath, targets);
  const transactionId = randomUUID();
  const entries: GoldenPairTransactionEntry[] = [
    {
      target: basename(targets[0]),
      staged: `${basename(targets[0])}.${transactionId}.stage`,
      sha256: sha256(goldenContents),
    },
    {
      target: basename(targets[1]),
      staged: `${basename(targets[1])}.${transactionId}.stage`,
      sha256: sha256(hmsNeededContents),
    },
  ];
  const contents = [goldenContents, hmsNeededContents];
  let journalAttempted = false;
  try {
    await writeDurableFile(join(directory, entries[0].staged), contents[0]);
    await writeDurableFile(join(directory, entries[1].staged), contents[1]);
    await syncDirectory(directory);
    journalAttempted = true;
    await writePrivateFileAtomically(
      journalPath,
      JSON.stringify({ version: 1, entries } satisfies GoldenPairTransaction),
    );
    await recoverGoldenSetPair(directory, journalPath, targets);
  } catch (error) {
    let journalMayExist = journalAttempted;
    if (journalAttempted) {
      try {
        await lstat(journalPath);
      } catch (journalError) {
        journalMayExist = !hasErrorCode(journalError, 'ENOENT');
      }
    }
    if (!journalMayExist) {
      await discardFile(join(directory, entries[0].staged));
      await discardFile(join(directory, entries[1].staged));
    }
    throw error;
  }
}

async function acquirePairLock(lockPath: string): Promise<Awaited<ReturnType<typeof open>>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      lockPath,
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const fileInfo = await lstat(lockPath);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.nlink > 1) {
      throw new Error('Private golden lock file is unsafe');
    }
    await handle.chmod(0o600);
    await new Promise<void>((resolveLock, rejectLock) => {
      let settled = false;
      const child = spawn('flock', ['-x', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', handle!.fd],
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        rejectLock(error);
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        if (code === 0) resolveLock();
        else rejectLock(new Error('Could not acquire the private golden lock'));
      });
    });
    return handle;
  } catch {
    await handle?.close().catch(() => undefined);
    throw new Error('Could not safely lock private golden data');
  }
}

export async function withGoldenSetPairLock<T>(
  goldenPath: string,
  hmsNeededPath: string,
  operation: (pair: GoldenSetPairAccess) => Promise<T>,
): Promise<T> {
  const { directory, journalPath, lockPath, targets } = pairTransactionPaths(
    goldenPath,
    hmsNeededPath,
  );
  const lockHandle = await acquirePairLock(lockPath);
  try {
    return await operation({
      recover: () => recoverGoldenSetPair(directory, journalPath, targets),
      write: (goldenContents, hmsNeededContents) =>
        writeGoldenSetPair(directory, journalPath, targets, goldenContents, hmsNeededContents),
    });
  } finally {
    await lockHandle.close();
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === code,
  );
}
