import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compactRangeReader } from '../scripts/collect-centurion-from-header-retry-live.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const privateDir = path.resolve(appDir, '../../.private');
const collector = path.join(appDir, 'scripts/collect-centurion-from-header-retry-live.ts');

function withFixture(test: (dir: string) => void): void {
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(path.join(privateDir, 'synthetic-retry-'));
  try { test(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('confirmation PDF retry collector', () => {
  it('rejects non-status data before emitting a range', () => withFixture((dir) => {
    const file = path.join(dir, 'evidence.jsonl');
    for (const row of [
      { messageDbId: 'id-a', status: 'private data' },
      { messageDbId: 'id-a', status: 'no_match', headerSha256: 'private data' },
    ]) {
      writeFileSync(file, JSON.stringify(row));
      expect(() => execFileSync(process.execPath, ['-e', compactRangeReader, file, '0', '100'], { stdio: 'pipe' })).toThrow();
    }
  }));

  it('rejects output paths that escape the private root through a symlink', () => withFixture((dir) => {
    const outside = mkdtempSync(path.join(tmpdir(), 'centurion-retry-outside-'));
    try {
      const source = path.join(dir, 'attachments.jsonl');
      const remote = path.join(dir, 'remote.jsonl');
      const wrapper = path.join(dir, 'ssm.sh');
      const sourceText = JSON.stringify({ parentMessage: { messageDbId: 'id-a' }, fromHeaderEvidence: { status: 'missing' } });
      writeFileSync(source, sourceText);
      writeFileSync(remote, JSON.stringify({ messageDbId: 'id-a', status: 'missing' }));
      writeFileSync(wrapper, 'set -e\nresult=$(bash -c "$1")\nnode -e \'process.stdout.write(JSON.stringify({ResponseCode:0,Stdout:process.argv[1]}))\' "$result"\n');
      symlinkSync(outside, path.join(dir, 'escape'), 'dir');
      const args = ['--import', 'tsx', collector, `--source-attachments=${source}`,
        `--expected-source-sha256=${createHash('sha256').update(sourceText).digest('hex')}`,
        `--remote-evidence-file=${remote}`, `--output-file=${path.join(dir, 'escape/override.jsonl')}`,
        `--ssm-wrapper=${wrapper}`];
      expect(() => execFileSync(process.execPath, args, { cwd: appDir, stdio: 'pipe' })).toThrow();
      expect(existsSync(path.join(outside, 'override.jsonl'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));

  it('maps verified ordered ranges and rejects reordered evidence', () => withFixture((dir) => {
    const source = path.join(dir, 'attachments.jsonl');
    const remote = path.join(dir, 'remote.jsonl');
    const wrapper = path.join(dir, 'ssm.sh');
    const output = path.join(dir, 'override.jsonl');
    const sourceText = ['id-a', 'id-b'].map((id) => JSON.stringify({
      parentMessage: { messageDbId: id }, fromHeaderEvidence: { status: 'missing' },
    })).join('\n');
    writeFileSync(source, sourceText);
    writeFileSync(wrapper, 'set -e\nresult=$(bash -c "$1")\nnode -e \'process.stdout.write(JSON.stringify({ResponseCode:0,Stdout:process.argv[1]}))\' "$result"\n');
    const rows = [
      { messageDbId: 'id-a', status: 'missing' },
      { messageDbId: 'id-b', status: 'no_match', headerSha256: 'a'.repeat(64) },
    ];
    writeFileSync(remote, rows.map((row) => JSON.stringify(row)).join('\n'));
    const args = ['--import', 'tsx', collector, `--source-attachments=${source}`,
      `--expected-source-sha256=${createHash('sha256').update(sourceText).digest('hex')}`,
      `--remote-evidence-file=${remote}`, `--output-file=${output}`, `--ssm-wrapper=${wrapper}`];
    execFileSync(process.execPath, args, { cwd: appDir, stdio: 'pipe' });
    expect(readFileSync(output, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual(rows);
    const range = execFileSync(process.execPath, ['-e', compactRangeReader, remote, '0', '100'], { encoding: 'utf8' });
    expect(range).not.toContain('id-a');
    expect(range).not.toContain('id-b');
    writeFileSync(remote, [...rows].reverse().map((row) => JSON.stringify(row)).join('\n'));
    const mismatchedOutput = path.join(dir, 'mismatch.jsonl');
    const mismatchArgs = args.map((arg) => arg === `--output-file=${output}` ? `--output-file=${mismatchedOutput}` : arg);
    expect(() => execFileSync(process.execPath, mismatchArgs, { cwd: appDir, stdio: 'pipe' })).toThrow();
    expect(() => readFileSync(mismatchedOutput)).toThrow();
  }));
});
