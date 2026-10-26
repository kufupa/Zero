/**
 * Shared exclusive page lease for every HMS read CLI.
 * Unknown, inactive, or omitted property fails closed before a page is created.
 * No hotel default.
 */
import { createExclusivePageLease, SlotLeaseRefusedError } from './hms-slot-lease.mjs';
import { getPropertyRegistration } from './property-registry.mjs';
import { createPostgresPropertyReadLock } from '../../src/hms/property-read-lock.ts';
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

export async function prepareReadCliInput(input, env = process.env) {
  const code = typeof input?.propertyCode === 'string' ? input.propertyCode.trim() : '';
  const lookup = input.lookupProperty ?? lookupActiveProperty;
  const property = code ? lookup(code) : null;
  if (!code || !property || property.propertyCode !== code) {
    throw new SlotLeaseRefusedError('property_unknown', 'unknown property refused');
  }
  const tenantId =
    typeof input.tenantId === 'string' && input.tenantId
      ? input.tenantId
      : env.PANE_STAY_TENANT_ID || env.HMS_EXPECTED_TENANT || property.expectedTenant || '';
  let session = input.session;
  if (!session) {
    session = createSlotSession({ owner: { login: async () => {}, wipeProfile: async () => {} } });
    await session.recover();
  }
  const lock = input.lock
    || (input.lockConnection
      ? null
      : env.DATABASE_URL
        ? createPostgresPropertyReadLock({
          tenantId,
          propertyCode: code,
          databaseUrl: env.DATABASE_URL,
        })
        : null);
  return { ...input, propertyCode: code, tenantId, session, lock };
}

/**
 * One lease for every read CLI. Refuses omitted/unknown/inactive property before newPage/login.
 */
export async function withReadCliPage(input, run) {
  const prepared = await prepareReadCliInput(input);
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
      },
      run,
    );
  if (prepared.lock) return prepared.lock.withLock((connection) => invoke(connection, prepared.lock.key));
  return invoke(prepared.lockConnection, prepared.lockKey);
}

export const withLeasedReadPage = withReadCliPage;
