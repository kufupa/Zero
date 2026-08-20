import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const seedSource = readFileSync(join(here, '..', 'src', 'db', 'seed.ts'), 'utf8');

describe('remote session revocation contracts', () => {
  it('deletes legacy and remote sessions only during password rotation', () => {
    const rotationBlock = seedSource.match(
      /if\s*\(\s*shouldRotate\s*\)\s*\{([\s\S]*?)\n\s*\}/,
    )?.[1];

    expect(rotationBlock).toBeDefined();
    expect(rotationBlock).toMatch(/delete\(session\)[\s\S]*eq\(session\.userId,\s*actualUserId\)/);
    expect(rotationBlock).toMatch(
      /delete\(remoteSession\)[\s\S]*eq\(remoteSession\.userId,\s*actualUserId\)/,
    );
    expect(seedSource.replace(rotationBlock ?? '', '')).not.toMatch(/delete\(session\)|delete\(remoteSession\)/);
  });

  it('emergency revoke requires exact email plus confirmation and only deletes remote sessions', () => {
    const script = readFileSync(
      join(here, '..', 'scripts', 'revoke-remote-sessions.ts'),
      'utf8',
    );

    expect(script).toMatch(/--email/);
    expect(script).toMatch(/--confirm-revoke/);
    expect(script).toMatch(/where\(eq\(user\.email,\s*email\)\)/);
    expect(script).toMatch(/delete\(remoteSession\)/);
    expect(script).not.toMatch(/delete\(session\)|delete\(account\)|delete\(user\)/);
    expect(script).not.toMatch(/\b(token|secret|password)\b/i);
  });
});
