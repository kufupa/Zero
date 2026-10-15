import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  evaluateAgentFinishCheck,
  evaluateAgentFinishCheckJson,
} from '../src/ai/agent-finish-check.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/agent-finish');
const readFixture = (name: string) => readFileSync(join(fixtures, name), 'utf8');

describe('agent-finish-check', () => {
  it('accepts the in-repo PASS fixture', () => {
    const verdict = evaluateAgentFinishCheckJson(readFixture('pass.json'));
    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it('rejects the FAIL fixture that omits sha', () => {
    const verdict = evaluateAgentFinishCheckJson(readFixture('fail-missing-sha.json'));
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('missing sha');
  });

  it('requires tests_pass, typecheck_new, sha, files, and listed tests', () => {
    const verdict = evaluateAgentFinishCheck({});
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual([
      'missing tests_pass',
      'missing typecheck_new',
      'missing sha',
      'missing files',
      'missing tests',
    ]);
  });

  it('rejects typecheck_new other than 0', () => {
    const verdict = evaluateAgentFinishCheck({
      tests_pass: true,
      typecheck_new: 2,
      sha: 'a402a4e14c834dbb53dad329b7ad6a5d9de1c834',
      files: ['apps/server-pilot/src/ai/agent-finish-check.ts'],
      tests: ['tests/agent-finish-check.test.ts'],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('typecheck_new must be 0');
  });

  it('rejects placeholder sha values', () => {
    const base = {
      tests_pass: true,
      typecheck_new: 0,
      files: ['apps/server-pilot/src/ai/agent-finish-check.ts'],
      tests: ['tests/agent-finish-check.test.ts'],
    };
    expect(evaluateAgentFinishCheck({ ...base, sha: 'TBD' }).errors).toContain('placeholder sha');
    expect(evaluateAgentFinishCheck({ ...base, sha: 'placeholder' }).errors).toContain(
      'placeholder sha',
    );
    expect(evaluateAgentFinishCheck({ ...base, sha: '0000000' }).errors).toContain('placeholder sha');
  });

  it('rejects empty tests lists', () => {
    const verdict = evaluateAgentFinishCheck({
      tests_pass: true,
      typecheck_new: 0,
      sha: 'a402a4e14c834dbb53dad329b7ad6a5d9de1c834',
      files: ['apps/server-pilot/src/ai/agent-finish-check.ts'],
      tests: [],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContain('tests not listed');
  });
});
