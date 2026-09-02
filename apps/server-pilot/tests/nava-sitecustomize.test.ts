import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const pythonPath = path.join(repoRoot, 'scripts', 'nava-sitecustomize-path');

describe('nava sitecustomize dump deny', () => {
  it('raises PermissionError via python -m when NAVA_ALLOW_DUMP=0', () => {
    const result = spawnSync(
      'python3',
      ['-m', 'nava_dump_probe'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: pythonPath,
          NAVA_ALLOW_DUMP: '0',
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/PermissionError|NAVA dump deny/);
  });

  it('allows Path.read_text when NAVA_ALLOW_DUMP=1 if the file exists or FileNotFound otherwise', () => {
    const result = spawnSync(
      'python3',
      ['-m', 'nava_dump_probe'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONPATH: pythonPath,
          NAVA_ALLOW_DUMP: '1',
        },
      },
    );
    const blob = `${result.stderr}${result.stdout}`;
    expect(blob).not.toMatch(/NAVA dump deny/);
  });

  it('denies dump reads on Prime kernel venv python when that interpreter exists', () => {
    const candidates = [
      process.env.PRIME_AGENT_KERNEL_VENV,
      path.join(os.homedir(), '.prime', 'agent', 'kernel-venv', 'bin', 'python'),
      '/home/ubuntu/.prime/agent/kernel-venv/bin/python',
    ].filter((value): value is string => Boolean(value));
    const python = candidates.find((candidate) => existsSync(candidate));
    if (!python) return;
    const result = spawnSync(python, ['-m', 'nava_dump_probe'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONPATH: pythonPath,
        NAVA_ALLOW_DUMP: '0',
      },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toMatch(/PermissionError|NAVA dump deny/);
  });
});
