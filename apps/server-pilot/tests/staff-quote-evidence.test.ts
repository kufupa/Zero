import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();
  const symlinks = new Set<string>();
  const sizeOverride = new Map<string, number>();
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  const kindOf = (path: string) => {
    if (symlinks.has(path)) return 'symlink' as const;
    if (files.has(path)) return 'file' as const;
    if (dirs.has(path)) return 'dir' as const;
    return undefined;
  };
  const mocks = {
    lstat: vi.fn(async (path: string) => {
      const kind = kindOf(path);
      if (!kind) throw enoent(path);
      return {
        isFile: () => kind === 'file',
        isDirectory: () => kind === 'dir',
        isSymbolicLink: () => kind === 'symlink',
        size: kind === 'file' ? (sizeOverride.get(path) ?? files.get(path)!.length) : 0,
      };
    }),
    readdir: vi.fn(async (path: string, options?: { withFileTypes?: boolean }) => {
      if (!dirs.has(path)) throw enoent(path);
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const children = new Set<string>();
      for (const entry of [...files.keys(), ...dirs, ...symlinks]) {
        if (entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/'))
          children.add(entry);
      }
      const entries = [...children].sort().map((entry) => {
        const kind = kindOf(entry)!;
        const name = entry.slice(prefix.length);
        return {
          name,
          isFile: () => kind === 'file',
          isDirectory: () => kind === 'dir',
          isSymbolicLink: () => kind === 'symlink',
        };
      });
      if (options?.withFileTypes) return entries;
      return entries.map((entry) => entry.name);
    }),
    readFile: vi.fn(async (path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw enoent(path);
      return bytes;
    }),
  };
  return { files, dirs, symlinks, sizeOverride, mocks };
});

vi.mock('node:fs/promises', () => fsState.mocks);

const { listQuoteRunScreenshots, quoteRunIdFromEvidenceDirectory, readQuoteRunScreenshot } =
  await import('../src/ai/staff-quote-evidence.js');

const OUT = '/synthetic/.private/playwright-quote/runs';
const RUN = '2026-10-07T23-33-12-345Z-abcd1234';
const RUN_DIR = `${OUT}/${RUN}`;
const SHOTS = `${RUN_DIR}/screenshots`;
const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('0000000d49484452', 'hex'),
  Buffer.from('synthetic-png-body'),
]);

function seedRun(shots: Record<string, Buffer>, extra: string[] = []) {
  fsState.dirs.add(OUT);
  fsState.dirs.add(RUN_DIR);
  fsState.dirs.add(SHOTS);
  for (const [name, bytes] of Object.entries(shots)) fsState.files.set(`${SHOTS}/${name}`, bytes);
  for (const name of extra) fsState.files.set(`${RUN_DIR}/${name}`, Buffer.from('{}'));
}

function touchedCount() {
  return [
    ...fsState.mocks.lstat.mock.calls,
    ...fsState.mocks.readdir.mock.calls,
    ...fsState.mocks.readFile.mock.calls,
  ].length;
}

beforeEach(() => {
  fsState.files.clear();
  fsState.dirs.clear();
  fsState.symlinks.clear();
  fsState.sizeOverride.clear();
  fsState.mocks.lstat.mockClear();
  fsState.mocks.readdir.mockClear();
  fsState.mocks.readFile.mockClear();
});

describe('quote run id from the installed evidence directory', () => {
  it('accepts the direct child that the capture tool created', () => {
    expect(quoteRunIdFromEvidenceDirectory(OUT, `${OUT}/${RUN}`)).toBe(RUN);
  });

  it('rejects nested, escaping, parent-relative, and malformed directories', () => {
    expect(quoteRunIdFromEvidenceDirectory(OUT, `${OUT}/x/${RUN}`)).toBeNull();
    expect(quoteRunIdFromEvidenceDirectory(OUT, `/tmp/${RUN}`)).toBeNull();
    expect(quoteRunIdFromEvidenceDirectory(OUT, `${OUT}/../${RUN}`)).toBeNull();
    expect(quoteRunIdFromEvidenceDirectory(OUT, `${OUT}/evil`)).toBeNull();
    expect(quoteRunIdFromEvidenceDirectory(OUT, `${OUT}/${RUN}-extra`)).toBeNull();
  });
});

describe('quote run screenshots (mocked filesystem)', () => {
  it('lists only regular PNG files in the run screenshots directory, sorted', async () => {
    seedRun(
      { 'group-1-availability-results.png': PNG, 'login-complete.png': PNG, 'notes.txt': PNG },
      ['request.json'],
    );
    fsState.dirs.add(`${SHOTS}/folder.png`);
    fsState.symlinks.add(`${SHOTS}/linked.png`);
    await expect(listQuoteRunScreenshots(OUT, RUN)).resolves.toEqual([
      'group-1-availability-results.png',
      'login-complete.png',
    ]);
  });

  it('returns an empty list for a missing run, or a malformed run id, without listing anything', async () => {
    await expect(listQuoteRunScreenshots(OUT, RUN)).resolves.toEqual([]);
    expect(fsState.mocks.readdir).not.toHaveBeenCalled();
    const before = touchedCount();
    await expect(listQuoteRunScreenshots(OUT, '../escape')).resolves.toEqual([]);
    expect(touchedCount()).toBe(before);
  });

  it('returns a ready PNG data URL for a listed screenshot (happy path)', async () => {
    seedRun({ 'group-1-availability-results.png': PNG });
    const result = await readQuoteRunScreenshot({
      outputDir: OUT,
      runId: RUN,
      name: 'group-1-availability-results.png',
    });
    expect(result).toEqual({
      status: 'ready',
      name: 'group-1-availability-results.png',
      mimeType: 'image/png',
      sizeBytes: PNG.length,
      dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
    });
  });

  it.each([
    ['parent traversal in name', 'name', '../login-complete.png'],
    ['nested path in name', 'name', 'screenshots/login-complete.png'],
    ['absolute path in name', 'name', '/etc/passwd'],
    ['encoded traversal in name', 'name', '..%2Flogin-complete.png'],
    ['NUL byte in name', 'name', 'login-complete.png\u0000'],
    ['dot-prefixed name', 'name', '.hidden.png'],
    ['double-dot name', 'name', '..png'],
    ['non-PNG extension', 'name', 'login-complete.json'],
    ['parent traversal in run id', 'runId', `../${RUN}`],
    ['run id with a slash', 'runId', `${RUN}/screenshots`],
    ['empty run id', 'runId', ''],
    ['run id with a trailing newline', 'runId', `${RUN}\n`],
  ])('rejects %s before touching the filesystem', async (_label, field, value) => {
    seedRun({ 'login-complete.png': PNG });
    const input = { outputDir: OUT, runId: RUN, name: 'login-complete.png' };
    if (field === 'name') input.name = value;
    else input.runId = value;
    await expect(readQuoteRunScreenshot(input)).resolves.toEqual({
      status: 'unavailable',
      reason: 'invalid_request',
    });
    expect(touchedCount()).toBe(0);
  });

  it('refuses a well-formed name that is not in the run listing', async () => {
    seedRun({ 'login-complete.png': PNG });
    await expect(
      readQuoteRunScreenshot({ outputDir: OUT, runId: RUN, name: 'failure.png' }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'not_found' });
    expect(fsState.mocks.readFile).not.toHaveBeenCalled();
  });

  it('refuses a symbolic link even when its name would otherwise be listed', async () => {
    seedRun({});
    fsState.symlinks.add(`${SHOTS}/login-complete.png`);
    await expect(
      readQuoteRunScreenshot({ outputDir: OUT, runId: RUN, name: 'login-complete.png' }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'not_found' });
    expect(fsState.mocks.readFile).not.toHaveBeenCalled();
  });

  it('refuses an oversized screenshot without reading it', async () => {
    seedRun({ 'group-1-availability-results.png': PNG });
    fsState.sizeOverride.set(`${SHOTS}/group-1-availability-results.png`, 9 * 1024 * 1024);
    await expect(
      readQuoteRunScreenshot({
        outputDir: OUT,
        runId: RUN,
        name: 'group-1-availability-results.png',
      }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'too_large' });
    expect(fsState.mocks.readFile).not.toHaveBeenCalled();
  });

  it('refuses a listed file whose bytes are not a PNG', async () => {
    seedRun({ 'login-complete.png': Buffer.from('<html>not a png</html>') });
    await expect(
      readQuoteRunScreenshot({ outputDir: OUT, runId: RUN, name: 'login-complete.png' }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'unreadable' });
  });
});
