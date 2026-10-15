import { installAvailabilityReadOnlyGuard } from './hms-read-only-guard.mjs';

const PROPERTY_REGISTRY = Object.freeze([
  Object.freeze({
    transportId: 'transport-centurion',
    propertyCode: 'HRCEN',
    expectedTenant: 'HMS_LEGACY',
    expectedPropertyName: 'Centurion Hotel',
    username: 'NAVAAI',
    mailboxTransportId: 'transport-centurion',
    credentialSecretRef: 'nava-zero/server-pilot/infor-hms-read',
    credentialMode: 'view_only',
  }),
  Object.freeze({
    transportId: 'transport-davinci',
    propertyCode: 'HRDAV',
    expectedTenant: 'HMS_DAVINCI',
    expectedPropertyName: 'Davinci Hotel',
    username: 'NAVAAI',
    mailboxTransportId: 'transport-davinci',
    credentialSecretRef: 'nava-zero/server-pilot/infor-hms-read-davinci',
    credentialMode: 'view_only',
  }),
]);

const SECRET_BINDING_FIELDS = [
  'username',
  'expectedTenant',
  'expectedPropertyCode',
  'expectedPropertyName',
  'mailboxTransportId',
  'credentialMode',
];

export function getHmsPropertyRegistration(transportId) {
  const property = PROPERTY_REGISTRY.find((entry) => entry.transportId === transportId);
  if (!property) throw new Error('hms_property_unknown');
  return property;
}

export function resolveSecretSource(env = {}) {
  if (env.HMS_PROPERTY_TRANSPORT_ID !== undefined) {
    const property = getHmsPropertyRegistration(env.HMS_PROPERTY_TRANSPORT_ID);
    if (
      env.HMS_QUOTE_SECRET_PATH ||
      (env.HMS_READ_SECRET_ARN && env.HMS_READ_SECRET_ARN !== property.credentialSecretRef)
    ) {
      throw new Error('hms_property_credential_source_conflict');
    }
    return { source: 'aws', secretId: property.credentialSecretRef, property };
  }
  if (env.HMS_QUOTE_SECRET_PATH) return { source: 'file', path: env.HMS_QUOTE_SECRET_PATH, property: null };
  if (env.HMS_READ_SECRET_ARN) return { source: 'aws', secretId: env.HMS_READ_SECRET_ARN, property: null };
  throw new Error('missing configuration');
}

export function validateHmsPropertySecret(property, secret) {
  if (!property || !secret || typeof secret !== 'object' || Array.isArray(secret)) {
    throw new Error('hms_property_credential_mismatch');
  }
  if (
    secret.expectedPropertyCode !== property.propertyCode ||
    SECRET_BINDING_FIELDS.some(
      (field) => property[field] !== undefined && secret[field] !== property[field],
    )
  ) {
    throw new Error('hms_property_credential_mismatch');
  }
  return secret;
}

export async function installRegisteredAvailabilityReadOnlyGuard(context, transportId, origin) {
  const property = getHmsPropertyRegistration(transportId);
  if (property.credentialMode !== 'view_only') throw new Error('hms_property_not_view_only');
  return installAvailabilityReadOnlyGuard(context, origin);
}
