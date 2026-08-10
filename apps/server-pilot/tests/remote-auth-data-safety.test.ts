import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('remote auth data safety', () => {
  it('keeps migration 0017 additive and exclusive to remote_session', () => {
    const migration = readFileSync(
      join(here, '..', 'drizzle', '0017_remote_auth_session.sql'),
      'utf8',
    );

    expect(migration).toMatch(/CREATE TABLE(?: IF NOT EXISTS)? "remote_session"/i);
    expect(migration).toMatch(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "remote_session_/i);
    expect(migration).not.toMatch(/^\s*(DROP|TRUNCATE|DELETE|UPDATE|ALTER)\b/im);

    const tableNames = [...migration.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? "([^"]+)"/gi)].map(
      (match) => match[1],
    );
    expect(tableNames).toEqual(['remote_session']);

    const indexTargets = [
      ...migration.matchAll(/CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "[^"]+" ON "([^"]+)"/gi),
    ].map((match) => match[1]);
    expect(indexTargets).toEqual(['remote_session', 'remote_session']);
  });

  it('binds HTTP process to loopback only', () => {
    const main = readFileSync(join(here, '..', 'src', 'main.ts'), 'utf8');

    expect(main).toMatch(/serve\(\{\s*fetch:\s*app\.fetch,\s*port,\s*hostname:\s*'127\.0\.0\.1'/);
    expect(main).not.toMatch(/0\.0\.0\.0/);
  });
});
