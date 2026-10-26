/**
 * Shared exclusive page lease for every HMS read CLI.
 * Unknown, inactive, or omitted property fails closed before a page is created.
 * No hotel default.
 *
 * Parent already holds the postgres property lock. A second postgres lock in the
 * child deadlocks staff-quote (DATABASE_URL is spread into the child). Pane spawn
 * strips DATABASE_URL for the same reason. CLI uses a process-local held lock so
 * the lease WeakMap is set without touching postgres.
 */
import { createExclusivePageLease, SlotLeaseRefusedError } from './hms-slot-lease.mjs';
import { getPropertyRegistration } from './property-registry.mjs';
import { createPropertyReadLock } from '../../src/hms/property-read-lock.ts';
import { createSlotSession } from '../../src/hms/slot-session.ts';

export { SlotLeaseRefusedError };

export const READ_CLI_TOOLS = Object.freeze([
  'fetch-quote',
  'party-lookup',
  'property-profile',
  'find-batch',
  'stay-lookup',
  'read-reservation-codes',
  'read-reservation-fields',
  'create-preflight',
  'hms-deeplink-probe',
]);

/** Active registry row, or null. Empty / unknown / inactive never fall through to another hotel. */
export function lookupActiveProperty(propertyCode) {
  const code = typeof propertyCode === 'string' ? propertyCode.trim() : '';
  if (!code) return null;
  const registration = getPropertyRegistration(code);
  if (!registration?.active) return null;
  return registration;
}

export function createReadCliLease(options = {}) {
  const lookupProperty = options.lookupProperty ?? lookupActiveProperty;
  return createExclusivePageLease({ ...options, lookupProperty });
}

let sharedLease = null;

export function resetSharedReadCliLease() {
  sharedLease = null;
}

export function sharedReadCliLease(options) {
  if (!sharedLease || options) sharedLease = createReadCliLease(options);
  return sharedLease;
}

/** Process-local lock so lease assertLockHeld sees a WeakMap-held connection. Never postgres. */
function childHeldLock(tenantId, propertyCode) {
  return createPropertyReadLock({
    tenantId,
    propertyCode,
    connectionFactory: async () => ({
      query: async () => [{ pg_try_advisory_lock: true }],
      close: async () => {},
    }),
  });
}

export async function prepareReadCliInput(input, env = process.env) {
  const code = typeof input?.propertyCode === 'string' ? input.propertyCode.trim() : '';
  const lookup = input.lookupProperty ?? lookupActiveProperty;
  const property = code ? lookup(code) : null;
  if (!code || !property || property.propertyCode !== code) {
    throw new SlotLeaseRefusedError('property_unknown', 'unknown property refused');
  }
  const resolvedEnv = input.env ?? env;
  const tenantId =
    typeof input.tenantId === 'string' && input.tenantId
      ? input.tenantId
      : resolvedEnv.PANE_STAY_TENANT_ID || resolvedEnv.HMS_EXPECTED_TENANT || property.expectedTenant || '';
  let session = input.session;
  if (!session) {
    session = createSlotSession({ owner: { login: async () => {}, wipeProfile: async () => {} } });
    await session.recover();
  }
  const lock = input.lock
    || (input.lockConnection ? null : childHeldLock(tenantId, code));
  return { ...input, propertyCode: code, tenantId, session, lock, env: resolvedEnv };
}

/**
 * One lease for every read CLI. Refuses omitted/unknown/inactive property before newPage/login.
 * Callers must run HMS work inside `run` — the lock is released when `run` returns.
 */
export async function withReadCliPage(input, run) {
  const prepared = await prepareReadCliInput(input, input.env ?? process.env);
  const lease = prepared.lease ?? sharedReadCliLease(prepared.leaseOptions);
  const invoke = (lockConnection, lockKey) =>
    lease.withPage(
      {
        propertyCode: prepared.propertyCode,
        tenantId: prepared.tenantId,
        secret: prepared.secret,
        session: prepared.session,
        lockConnection,
        lockKey,
        context: prepared.context,
        browser: prepared.browser,
        generation: prepared.generation,
        env: prepared.env,
      },
      run,
    );
  if (prepared.lock) return prepared.lock.withLock((connection) => invoke(connection, prepared.lock.key));
  return invoke(prepared.lockConnection, prepared.lockKey);
}

export const withLeasedReadPage = withReadCliPage;
