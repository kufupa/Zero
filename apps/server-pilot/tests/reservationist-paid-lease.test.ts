import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquirePaidAccountingLease } from '../src/ai/reservationist-paid-lease.js';
const exec = promisify(execFile);
describe('exclusive paid accounting writer', () => {
  it('refuses another instance and another process before dispatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reservationist-paid-lease-')), path = join(directory, 'writer.lock');
    try {
      const lease = await acquirePaidAccountingLease(path);
      await expect(acquirePaidAccountingLease(path)).rejects.toThrow();
      const result = await exec(process.execPath, ['-e', 'const fs=require("node:fs");try{fs.openSync(process.argv[1],"wx");process.exit(3)}catch(e){process.exit(e.code==="EEXIST"?0:4)}', path]);
      expect(result.stderr).toBe('');
      await lease.release();
      const next = await acquirePaidAccountingLease(path); await next.release();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('preserves a changed ownership token rather than deleting another writer lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reservationist-paid-lease-')), path = join(directory, 'writer.lock');
    try {
      const lease = await acquirePaidAccountingLease(path);
      await writeFile(path, JSON.stringify({ token: 'other-owner' }));
      await expect(lease.release()).rejects.toThrow(/owner/);
      expect(JSON.parse(await readFile(path, 'utf8')).token).toBe('other-owner');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('never reclaims an old lock based on its timestamp', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reservationist-paid-lease-')), path = join(directory, 'writer.lock');
    try {
      await writeFile(path, JSON.stringify({ pid: 999999, at: '2000-01-01', token: 'old' }));
      await expect(acquirePaidAccountingLease(path)).rejects.toThrow();
      expect(JSON.parse(await readFile(path, 'utf8')).token).toBe('old');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
