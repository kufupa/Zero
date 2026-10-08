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

export interface PropertyReadLockAcquisitionOptions {
  /** Abort the acquisition while it is waiting for another property read. */
  signal?: AbortSignal;
  /** Optional absolute deadline in epoch milliseconds. */
  deadlineAt?: number;
}

const PROPERTY_READ_LOCK_POLL_MS = 25;

/** The cause of an acquisition that ran out of time. Use isPropertyReadLockDeadline to test for it. */
export const PROPERTY_READ_LOCK_DEADLINE_MESSAGE =
  'property read advisory lock acquisition deadline exceeded';

/** How long a pane run waits for the property lock before it gives up and reports the HMS lock as busy. */
export const PANE_PROPERTY_LOCK_WAIT_MS = 20_000;

/** Acquisition bounds that end `waitMs` after `now`. The lock stops polling at that deadline. */
export function acquisitionWithin(
  waitMs: number,
  now: number = Date.now(),
): PropertyReadLockAcquisitionOptions {
  return { deadlineAt: now + waitMs };
}

/**
 * True when a lock acquisition gave up at its deadline. The error may be wrapped, so the cause chain is searched.
 * An abort or a failed connection is not a deadline.
 */
export function isPropertyReadLockDeadline(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error && current.message === PROPERTY_READ_LOCK_DEADLINE_MESSAGE) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function propertyReadLockKey(tenantId: string, propertyCode: string): string {
  const digest = createHash('sha256').update(`${tenantId}\0${propertyCode}`, 'utf8').digest();
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

function acquisitionDeadlineAt(options: PropertyReadLockAcquisitionOptions): number | undefined {
  if (options.deadlineAt !== undefined) return options.deadlineAt;
  const signal = options.signal as
    | (AbortSignal & { deadlineAt?: number; deadlineMs?: number })
    | undefined;
  return signal?.deadlineAt ?? signal?.deadlineMs;
}

function assertAcquisitionActive(options: PropertyReadLockAcquisitionOptions): void {
  if (options.signal?.aborted) {
    throw lockError(options.signal.reason);
  }
  const deadlineAt = acquisitionDeadlineAt(options);
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw lockError(new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE));
  }
}

function withAcquisitionBounds<T>(
  operation: () => Promise<T>,
  options: PropertyReadLockAcquisitionOptions,
  onLateResolution?: (value: T) => void | Promise<void>,
): Promise<T> {
  assertAcquisitionActive(options);
  const deadlineAt = acquisitionDeadlineAt(options);
  if (!options.signal && deadlineAt === undefined) return operation();

  let pending: Promise<T>;
  try {
    pending = operation();
  } catch (cause) {
    return Promise.reject(cause);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(lockError(options.signal?.reason));
    };
    if (deadlineAt !== undefined) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        settled = true;
        cleanup();
        reject(lockError(new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE)));
        return;
      }
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(lockError(new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE)));
      }, remaining);
      timer.unref?.();
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    pending.then(
      (value) => {
        if (settled) {
          if (onLateResolution)
            void Promise.resolve(onLateResolution(value)).catch(() => undefined);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause);
      },
    );
  });
}

function waitForAcquisitionPoll(options: PropertyReadLockAcquisitionOptions): Promise<void> {
  assertAcquisitionActive(options);
  const deadlineAt = acquisitionDeadlineAt(options);
  const remaining = deadlineAt === undefined ? PROPERTY_READ_LOCK_POLL_MS : deadlineAt - Date.now();
  if (remaining <= 0) {
    return Promise.reject(
      lockError(new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE)),
    );
  }
  const waitMs = Math.min(PROPERTY_READ_LOCK_POLL_MS, remaining);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        reject(lockError(new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE)));
      } else {
        resolve();
      }
    }, waitMs);
    timer.unref?.();
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(lockError(options.signal?.reason));
    };
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}

function advisoryLockWasAcquired(result: unknown): boolean {
  if (!Array.isArray(result)) return false;
  const row = result[0];
  return (
    !!row &&
    typeof row === 'object' &&
    Object.values(row as Record<string, unknown>).some((value) => value === true)
  );
}

async function acquireAdvisoryLock(
  connection: PropertyReadConnection,
  key: string,
  options: PropertyReadLockAcquisitionOptions,
): Promise<void> {
  for (;;) {
    const result = await withAcquisitionBounds(
      () =>
        connection.query<ReadonlyArray<Record<string, unknown>>>(
          `SELECT pg_try_advisory_lock(${key})`,
        ),
      options,
    );
    if (advisoryLockWasAcquired(result)) return;
    await waitForAcquisitionPoll(options);
  }
}

export function createPropertyReadLock(options: PropertyReadLockOptions) {
  const key = propertyReadLockKey(options.tenantId, options.propertyCode);

  return {
    key,
    async withLock<T>(
      callback: (connection: PropertyReadConnection) => Promise<T>,
      acquisitionOptions: PropertyReadLockAcquisitionOptions = {},
    ): Promise<T> {
      let connection: PropertyReadConnection | undefined;
      try {
        connection = await withAcquisitionBounds(
          options.connectionFactory,
          acquisitionOptions,
          (lateConnection) => lateConnection.close(),
        );
      } catch (cause) {
        if (connection) await connection.close().catch(() => undefined);
        throw lockError(cause);
      }
      if (!connection) throw lockError(new Error('property read connection was not created'));
      const acquiredConnection = connection;
      let held = false;
      let result: T | undefined;
      let callbackError: unknown;
      try {
        await acquireAdvisoryLock(acquiredConnection, key, acquisitionOptions);
        held = true;
      } catch (cause) {
        await acquiredConnection.close().catch(() => undefined);
        throw lockError(cause);
      }
      try {
        activePropertyReadConnections.set(acquiredConnection, key);
        try {
          result = await callback(acquiredConnection);
        } catch (cause) {
          callbackError = cause;
        }
      } finally {
        activePropertyReadConnections.delete(acquiredConnection);
      }

      let releaseError: (Error & { code: string; cause?: unknown }) | undefined;
      if (held) {
        try {
          const released = await acquiredConnection.query<ReadonlyArray<Record<string, unknown>>>(
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
        await acquiredConnection.close();
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
 *
 * `idle_timeout` must stay disabled (0). Live Guest Stay openReadSession holds
 * this lock across HMS login + storage-state handoff + proof context (~20s+)
 * with no SQL between acquire and unlock. A 5s idle timeout dropped the
 * connection mid-login and surfaced as PROPERTY_READ_LOCK_LOST before
 * toolStartedAt (Codex 2026-09-11 live proof attempts).
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
      const client = postgres(input.databaseUrl, {
        max: 1,
        idle_timeout: 0,
        connect_timeout: 10,
      });
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
