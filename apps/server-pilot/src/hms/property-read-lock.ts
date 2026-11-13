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

const activePropertyReadConnections = new WeakMap<PropertyReadConnection, ReadonlySet<string>>();
const monitoredPropertyReadConnections = new WeakSet<PropertyReadConnection>();

/** Internal ownership proof for the connection currently inside withLock. */
export function isPropertyReadConnectionHeld(
  connection: PropertyReadConnection,
  key: string,
): boolean {
  return activePropertyReadConnections.get(connection)?.has(key) ?? false;
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
  /** One non-waiting attempt. A busy lock reports the deadline error at once, so background work can requeue. */
  tryOnce?: boolean;
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
    if (typeof current === 'object') {
      const record = current as { message?: unknown; cause?: unknown };
      if (record.message === PROPERTY_READ_LOCK_DEADLINE_MESSAGE) return true;
      current = record.cause;
    } else {
      current = null;
    }
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

/** Fail closed when a caller is about to touch HMS without the property lock. */
export function assertPropertyReadConnectionHeld(
  connection: PropertyReadConnection | undefined,
  key: string,
): void {
  if (!connection || !isPropertyReadConnectionHeld(connection, key)) {
    throw lockError();
  }
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
    if (options.tryOnce) throw lockError(new Error(PROPERTY_READ_LOCK_DEADLINE_MESSAGE));
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
        activePropertyReadConnections.set(acquiredConnection, new Set([key]));
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

/** A monitored lease must hear when its dedicated database session closes. */
export interface MonitoredPropertyReadConnection extends PropertyReadConnection {
  onLoss(listener: (cause?: unknown) => void): () => void;
}

export interface MonitoredPropertyReadLockOptions {
  /** The pane's own tenant; its key remains available as `key`. */
  tenantId: string;
  /** Complete, trusted tenant identities for this property, including tenantId. */
  tenantIds: readonly string[];
  propertyCode: string;
  connectionFactory: () => Promise<MonitoredPropertyReadConnection>;
  /** Tests may shorten these bounds; production may not lengthen them. */
  monitorIntervalMs?: number;
  monitorTimeoutMs?: number;
}

function monitoredProbeSql(keys: readonly string[]): string {
  const identities = keys.map((key) => {
    const unsigned = BigInt.asUintN(64, BigInt(key));
    return `(classid::text = '${unsigned >> 32n}' AND objid::text = '${unsigned & 0xffffffffn}')`;
  });
  return `SELECT pg_backend_pid() AS pid, (SELECT count(*)::integer FROM pg_locks ` +
    `WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted AND objsubid = 1 ` +
    `AND (${identities.join(' OR ')})) AS held`;
}

async function monitoredSnapshot(
  connection: MonitoredPropertyReadConnection,
  statement: string,
  timeoutMs: number,
  expectedCount: number,
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      connection.query<Array<{ pid: unknown; held: unknown }>>(statement),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('property lease check timed out')), timeoutMs);
      }),
    ]);
    const row = Array.isArray(rows) ? rows[0] : undefined;
    const pid = Number(row?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0 || Number(row?.held) !== expectedCount) {
      throw new Error('property lease keys are not held');
    }
    return pid;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Own every explicitly supplied identity on one session. The caller must supply
 * the complete identities for the selected property and use the lease signal
 * to terminate every child it starts; rejecting a callback does not kill it.
 */
export function createMonitoredPropertyReadLock(options: MonitoredPropertyReadLockOptions) {
  const validIdentity = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.trim() === value;
  if (!validIdentity(options.tenantId) || !validIdentity(options.propertyCode) ||
      !Array.isArray(options.tenantIds) || !options.tenantIds.length ||
      options.tenantIds.some((value) => !validIdentity(value)) ||
      !options.tenantIds.includes(options.tenantId)) {
    throw new Error('property lease identities are invalid');
  }
  const intervalMs = options.monitorIntervalMs ?? 1_000;
  const timeoutMs = options.monitorTimeoutMs ?? 2_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > 1_000 ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_000) {
    throw new Error('property lease monitor bounds are invalid');
  }
  const key = propertyReadLockKey(options.tenantId, options.propertyCode);
  const keys = Object.freeze([...new Set(options.tenantIds.map((tenant) =>
    propertyReadLockKey(tenant, options.propertyCode)))].sort((a, b) => Number(a) - Number(b)));
  const statement = monitoredProbeSql(keys);

  return {
    key,
    keys,
    async withLock<T>(
      callback: (connection: MonitoredPropertyReadConnection, signal: AbortSignal) => Promise<T>,
      acquisitionOptions: PropertyReadLockAcquisitionOptions = {},
    ): Promise<T> {
      let connection: MonitoredPropertyReadConnection | undefined;
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pending: Promise<void> | undefined;
      let stopping = false;
      let lost: (Error & { code: string }) | undefined;
      let failure: unknown;
      let failed = false;
      let releaseFailure: unknown;
      let releaseFailed = false;
      let claimed = false;
      let registered = false;
      let result: T | undefined;
      const acquired: string[] = [];
      const lease = new AbortController();
      const acquisition = new AbortController();
      const externalSignal = acquisitionOptions.signal;
      const forwardAbort = () => acquisition.abort(externalSignal?.reason);
      if (externalSignal?.aborted) forwardAbort();
      else externalSignal?.addEventListener('abort', forwardAbort, { once: true });
      const bounds = { ...acquisitionOptions, signal: acquisition.signal };
      const lose = (cause?: unknown) => {
        if (lost) return;
        lost = lockError(cause);
        acquisition.abort(lost);
        if (connection && registered) {
          activePropertyReadConnections.delete(connection);
          registered = false;
        }
        // Abort listeners run synchronously, so an owned child is killed before
        // this handler returns when the caller uses the supervised child helper.
        lease.abort(lost);
      };
      const stopMonitor = () => {
        stopping = true;
        if (timer) clearTimeout(timer);
      };
      try {
        connection = await withAcquisitionBounds(
          options.connectionFactory,
          bounds,
          (late) => {
            if (!activePropertyReadConnections.has(late) && !monitoredPropertyReadConnections.has(late)) {
              return late.close();
            }
          },
        );
        if (!connection) throw lockError(new Error('property lease connection was not created'));
        if (activePropertyReadConnections.has(connection) || monitoredPropertyReadConnections.has(connection)) {
          // A borrowed connection belongs to the other operation: do not close it.
          connection = undefined;
          throw lockError(new Error('property lease connection is already owned'));
        }
        monitoredPropertyReadConnections.add(connection);
        claimed = true;
        if (typeof connection.onLoss !== 'function') {
          throw lockError(new Error('property lease loss notifications unavailable'));
        }
        const heldConnection = connection;
        unsubscribe = heldConnection.onLoss(lose);
        let backend: number;
        try {
          for (const identity of keys) {
            await acquireAdvisoryLock(heldConnection, identity, bounds);
            acquired.push(identity);
          }
          assertAcquisitionActive(bounds);
          backend = await withAcquisitionBounds(
            () => monitoredSnapshot(heldConnection, statement, timeoutMs, keys.length),
            bounds,
          );
        } catch (cause) {
          throw lost ?? lockError(cause);
        }
        if (lost) throw lost;
        externalSignal?.removeEventListener('abort', forwardAbort);
        activePropertyReadConnections.set(heldConnection, new Set(keys));
        registered = true;

        const schedule = () => {
          if (stopping || lost) return;
          timer = setTimeout(() => {
            pending = monitoredSnapshot(heldConnection, statement, timeoutMs, keys.length)
              .then((current) => {
                if (current !== backend) throw new Error('property lease session changed');
              })
              .catch(lose)
              .finally(() => {
                pending = undefined;
                schedule();
              });
          }, intervalMs);
          timer.unref?.();
        };
        schedule();
        result = await callback(heldConnection, lease.signal);
        stopMonitor();
        if (pending) await pending;
        if (lost) throw lost;
      } catch (error) {
        failed = true;
        failure = error;
      } finally {
        stopMonitor();
        if (pending) await pending;
        externalSignal?.removeEventListener('abort', forwardAbort);
        try {
          unsubscribe?.();
        } catch (error) {
          releaseFailed = true;
          releaseFailure ??= error;
        }
        if (connection && claimed) {
          if (registered) activePropertyReadConnections.delete(connection);
          if (!lost) {
            for (const identity of acquired.reverse()) {
              try {
                const rows = await connection.query<Array<Record<string, unknown>>>(
                  `SELECT pg_advisory_unlock(${identity}) AS unlocked`,
                );
                if (!advisoryLockWasAcquired(rows)) throw new Error('property lease unlock failed');
              } catch (error) {
                releaseFailed = true;
                releaseFailure ??= error;
              }
            }
          }
          try {
            await connection.close();
            monitoredPropertyReadConnections.delete(connection);
          } catch (error) {
            releaseFailed = true;
            releaseFailure ??= error;
          }
        }
      }
      if (lost) {
        if (failed && failure !== lost) Object.assign(lost, { callbackFailure: failure });
        throw lost;
      }
      if (releaseFailed) throw lockError(releaseFailure);
      if (failed) throw failure;
      return result as T;
    },
  };
}

/** Production adapter with a single, non-idle-expiring session and loss notification. */
export function createMonitoredPostgresPropertyReadLock(input: {
  tenantId: string;
  propertyCode: string;
  databaseUrl: string;
  identities: readonly { tenantId: string; propertyCode: string; databaseUrl: string }[];
}) {
  if (!input.databaseUrl || !Array.isArray(input.identities) || !input.identities.length ||
      input.identities.some((identity) => !identity || identity.propertyCode !== input.propertyCode ||
        identity.databaseUrl !== input.databaseUrl)) {
    // A single session cannot cover locks on another database or property.
    throw new Error('property lease identity scope mismatch');
  }
  return createMonitoredPropertyReadLock({
    tenantId: input.tenantId,
    tenantIds: input.identities.map((identity) => identity.tenantId),
    propertyCode: input.propertyCode,
    connectionFactory: async () => {
      const listeners = new Set<(cause?: unknown) => void>();
      const client = postgres(input.databaseUrl, {
        max: 1,
        idle_timeout: 0,
        connect_timeout: 10,
        onclose: () => {
          for (const listener of listeners) listener(new Error('property lease session closed'));
        },
      });
      return {
        query: async <T = unknown>(statement: string) =>
          (await client.unsafe(statement)) as unknown as T,
        close: async () => { await client.end({ timeout: 5 }); },
        onLoss: (listener: (cause?: unknown) => void) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      } satisfies MonitoredPropertyReadConnection;
    },
  });
}
