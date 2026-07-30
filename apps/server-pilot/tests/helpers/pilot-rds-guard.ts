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

/** Throws if `databaseUrl` points at pilot RDS. No override exists. */
export function assertNotPilotProdDatabase(
  databaseUrl: string | undefined,
): void {
  if (!databaseUrl) return;
  if (!isPilotProdDatabase(databaseUrl)) return;

  let host = '(unparseable)';
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    /* keep fallback label */
  }

  throw new Error(
    `Refusing vitest against pilot RDS (${host}). ` +
      `Unset DATABASE_URL or use a disposable DB. ` +
      `No override exists (marker: ${PILOT_PROD_DB_HOST}).`,
  );
}
