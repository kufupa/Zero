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

function lockError(cause: unknown): Error & { code: string; cause?: unknown } {
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
      let held = false;
      try {
        try {
          await connection.query(`SELECT pg_advisory_lock(${key})`);
          held = true;
        } catch (cause) {
          throw lockError(cause);
        }
        return await callback(connection);
      } finally {
        if (held) {
          try {
            await connection.query(`SELECT pg_advisory_unlock(${key})`);
          } catch {
            // The read result is not a proof of a clean release.  Connection
            // close below still guarantees the backend cannot retain it.
          }
        }
        await connection.close();
      }
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
