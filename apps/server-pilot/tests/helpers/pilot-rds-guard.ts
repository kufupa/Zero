/**
 * Fail-closed guard so vitest cannot open/mutate the live pilot RDS.
 * Host marker kept in sync with scripts/ingest-benchmark.ts PILOT_PROD_DB_HOST.
 */
export const PILOT_PROD_DB_HOST = 'nava-zero-mail-pilot';

export function isPilotProdDatabase(databaseUrl: string): boolean {
  try {
    const host = new URL(databaseUrl).hostname;
    return host.includes(PILOT_PROD_DB_HOST);
  } catch {
    return databaseUrl.includes(PILOT_PROD_DB_HOST);
  }
}

/**
 * Throws if `databaseUrl` points at the pilot RDS and
 * `VITEST_ALLOW_PILOT_RDS=1` is not set. No-ops for unset/empty URL.
 */
export function assertNotPilotProdDatabase(
  databaseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!databaseUrl) return;
  if (!isPilotProdDatabase(databaseUrl)) return;
  if (env.VITEST_ALLOW_PILOT_RDS === '1') return;

  let host = '(unparseable)';
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    /* keep fallback label */
  }

  throw new Error(
    `Refusing vitest against pilot RDS (${host}). ` +
      `Unset DATABASE_URL or use a disposable DB. ` +
      `Intentional gates only: set VITEST_ALLOW_PILOT_RDS=1 ` +
      `(marker: ${PILOT_PROD_DB_HOST}).`,
  );
}
