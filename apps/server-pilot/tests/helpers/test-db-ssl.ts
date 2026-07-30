const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackDatabaseUrl(databaseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(databaseUrl).hostname);
  } catch {
    return false;
  }
}
