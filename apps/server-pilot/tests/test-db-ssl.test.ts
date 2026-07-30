import { describe, expect, it } from 'vitest';
import { isLoopbackDatabaseUrl } from './helpers/test-db-ssl.js';

describe('isLoopbackDatabaseUrl', () => {
  it.each([
    ['localhost', 'postgresql://user:pass@localhost:55432/zero_test'],
    ['IPv4 loopback', 'postgresql://user:pass@127.0.0.1:55432/zero_test'],
    ['IPv6 loopback', 'postgresql://user:pass@[::1]:55432/zero_test'],
  ])('accepts exact %s hostname', (_label, databaseUrl) => {
    expect(isLoopbackDatabaseUrl(databaseUrl)).toBe(true);
  });

  it.each([
    ['remote host', 'postgresql://user:pass@db.example.com:5432/zero_test'],
    ['localhost subdomain', 'postgresql://user:pass@localhost.example.com:5432/zero_test'],
    ['non-loopback IPv4', 'postgresql://user:pass@127.0.0.2:5432/zero_test'],
    [
      'remote sslmode override',
      'postgresql://user:pass@db.example.com:5432/zero_test?sslmode=disable',
    ],
    ['malformed URL', 'not-a-url-with-localhost'],
    ['empty URL', ''],
  ])('rejects %s', (_label, databaseUrl) => {
    expect(isLoopbackDatabaseUrl(databaseUrl)).toBe(false);
  });
});
