/**
 * Property-scoped serialization for PMS reads.
 *
 * The connection is deliberately supplied by the caller.  An advisory lock
 * is only useful when it is held on the same dedicated connection as the
 * read, so this module does not reach into a shared pool or cache one.
 */
import { createHash } from 'node:crypto';
import postgres from 'postgres';

export interface PropertyReadConnection {
  query<T = unknown>(statement: string): Promise<T>;
  close(): Promise<void>;
}

const activePropertyReadConnections = new WeakMap<PropertyReadConnection, string>();

/** Internal ownership proof for the connection currently inside withLock. */
export function isPropertyReadConnectionHeld(
  connection: PropertyReadConnection,
  key: string,
): boolean {
  return activePropertyReadConnections.get(connection) === key;
}

export interface PropertyReadLockOptions {
  tenantId: string;
  propertyCode: string;
  connectionFactory: () => Promise<PropertyReadConnection>;
}

export function propertyReadLockKey(tenantId: string, propertyCode: string): string {
  const digest = createHash('sha256')
    .update(`${tenantId}\0${propertyCode}`, 'utf8')
    .digest();
  // Keep the decimal representation explicit in SQL and in receipts.  A
  // signed 32-bit value is accepted by PostgreSQL's advisory-lock overload.
  return String(digest.readInt32BE(0));
}

function lockError(cause?: unknown): Error & { code: string; cause?: unknown } {
  const error = Object.assign(new Error('property read advisory lock could not be acquired'), {
    code: 'PROPERTY_READ_LOCK_LOST',
    cause,
  });
  return error;
}

export function createPropertyReadLock(options: PropertyReadLockOptions) {
  const key = propertyReadLockKey(options.tenantId, options.propertyCode);

  return {
    key,
    async withLock<T>(callback: (connection: PropertyReadConnection) => Promise<T>): Promise<T> {
      let connection: PropertyReadConnection;
      try {
        connection = await options.connectionFactory();
      } catch (cause) {
        throw lockError(cause);
      }
      let held = true;
      let result: T | undefined;
      let callbackError: unknown;
      try {
        await connection.query(`SELECT pg_advisory_lock(${key})`);
      } catch (cause) {
        held = false;
        await connection.close().catch(() => undefined);
        throw lockError(cause);
      }
      try {
        activePropertyReadConnections.set(connection, key);
        try {
          result = await callback(connection);
        } catch (cause) {
          callbackError = cause;
        }
      } finally {
        activePropertyReadConnections.delete(connection);
      }

      let releaseError: Error & { code: string; cause?: unknown } | undefined;
      if (held) {
        try {
          const released = await connection.query<ReadonlyArray<Record<string, unknown>>>(
            `SELECT pg_advisory_unlock(${key})`,
          );
          const releaseRow = Array.isArray(released) ? released[0] : undefined;
          if (releaseRow && Object.values(releaseRow).some((value) => value === false)) {
            releaseError = lockError();
          }
        } catch (cause) {
          // Connection close below still guarantees the backend cannot retain
          // a lost lock, but the read must fail closed.
          releaseError = lockError(cause);
        }
      }
      let closeError: unknown;
      try {
        await connection.close();
      } catch (cause) {
        closeError = cause;
      }
      if (releaseError) throw releaseError;
      if (closeError) throw lockError(closeError);
      if (callbackError) throw callbackError;
      return result as T;
    },
  };
}

export type PropertyReadLock = ReturnType<typeof createPropertyReadLock>;

/**
 * Production adapter.  Each invocation creates a max-one postgres client and
 * closes it after the PMS session, so the advisory lock cannot accidentally
 * live on the shared application pool.
 */
export function createPostgresPropertyReadLock(input: {
  tenantId: string;
  propertyCode: string;
  databaseUrl: string;
}) {
  return createPropertyReadLock({
    tenantId: input.tenantId,
    propertyCode: input.propertyCode,
    connectionFactory: async () => {
      const client = postgres(input.databaseUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 });
      return {
        query: async <T = unknown>(statement: string) =>
          (await client.unsafe(statement)) as unknown as T,
        close: async () => {
          await client.end({ timeout: 5 });
        },
      } satisfies PropertyReadConnection;
    },
  });
}
