import { assertRequiredRocketseedDbReachable } from './helpers/rocketseed-db-gate.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const originalRequired = process.env.REQUIRE_ROCKETSEED_DB_TESTS;

afterEach(() => {
  if (originalRequired === undefined) {
    delete process.env.REQUIRE_ROCKETSEED_DB_TESTS;
  } else {
    process.env.REQUIRE_ROCKETSEED_DB_TESTS = originalRequired;
  }
});

describe('Rocketseed required DB gate', () => {
  it('rejects an unreachable probe only when gate mode is required', () => {
    expect(() =>
      assertRequiredRocketseedDbReachable({
        required: true,
        databaseUrlConfigured: true,
        reachable: false,
      }),
    ).toThrow(/required DB probe is unreachable/);

    expect(() =>
      assertRequiredRocketseedDbReachable({
        required: false,
        databaseUrlConfigured: true,
        reachable: false,
      }),
    ).not.toThrow();
  });

  it('rejects missing DATABASE_URL in required mode', () => {
    expect(() =>
      assertRequiredRocketseedDbReachable({
        required: true,
        databaseUrlConfigured: false,
        reachable: false,
      }),
    ).toThrow(/requires DATABASE_URL/);
  });

  it('package command activates required mode before Vitest', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['test:rocketseed:db']).toContain(
      '--require ./scripts/require-rocketseed-db-tests.cjs',
    );

    delete process.env.REQUIRE_ROCKETSEED_DB_TESTS;
    const preloadPath = require.resolve('../scripts/require-rocketseed-db-tests.cjs');
    delete require.cache[preloadPath];
    require(preloadPath);
    expect(process.env.REQUIRE_ROCKETSEED_DB_TESTS).toBe('1');
  });
});
