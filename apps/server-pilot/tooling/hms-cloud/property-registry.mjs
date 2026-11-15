import { installAvailabilityReadOnlyGuard } from './hms-read-only-guard.mjs';

export const PROPERTY_REGISTRY_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $comment: 'Transports belong to one group; properties in that group may share them.',
  type: 'object',
  additionalProperties: false,
  required: ['properties', 'collectorTransportIds'],
  properties: {
    properties: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'propertyCode', 'active', 'transportIds', 'expectedTenant', 'expectedPropertyName',
          'username', 'mailboxTransportId', 'credentialSecretRef', 'credentialUse', 'browserSlot',
          'profileFile', 'group', 'landingPropertyCode', 'origin',
        ],
        properties: {
          propertyCode: { type: 'string', pattern: '^[A-Z][A-Z0-9]+$' },
          active: { type: 'boolean' },
          transportIds: {
            type: 'array', minItems: 1, uniqueItems: true,
            items: { type: 'string', pattern: '^transport-[a-z0-9]+(?:-[a-z0-9]+)*$' },
          },
          expectedTenant: { type: 'string', minLength: 1 },
          expectedPropertyName: { type: 'string', minLength: 1 },
          username: { type: 'string', minLength: 1 },
          mailboxTransportId: { type: 'string', minLength: 1 },
          credentialSecretRef: { type: 'string', minLength: 1 },
          credentialUse: { const: 'shared' },
          browserSlot: { type: 'string', minLength: 1 },
          profileFile: { type: ['string', 'null'] },
          group: { enum: ['centurion', 'davinci'] },
          landingPropertyCode: { type: 'string' },
          origin: { type: 'string' },
        },
      },
    },
    collectorTransportIds: {
      type: 'array', uniqueItems: true,
      items: { type: 'string', pattern: '^transport-[a-z0-9]+(?:-[a-z0-9]+)*$' },
    },
  },
});

export const PROPERTY_REGISTRY = Object.freeze({
  properties: Object.freeze([
    Object.freeze({
      propertyCode: 'HRCEN',
      group: 'centurion',
      landingPropertyCode: 'HRCEN',
      origin: 'https://hmsweb.hms.eu1.inforcloudsuite.com',
      active: true,
      transportIds: Object.freeze(['transport-centurion']),
      expectedTenant: 'THECENTURION_PRD',
      expectedPropertyName: 'Centurion Hotel',
      username: 'NAVAAI',
      mailboxTransportId: 'transport-centurion',
      credentialSecretRef: 'nava-zero/server-pilot/infor-hms-read',
      credentialUse: 'shared',
      browserSlot: 'centurion',
      profileFile: 'property-profiles/HRCEN.json',
    }),
    Object.freeze({
      propertyCode: 'HRDAV',
      group: 'davinci',
      landingPropertyCode: 'HRDAV',
      origin: 'https://hmsweb.hms.eu1.inforcloudsuite.com',
      active: true,
      transportIds: Object.freeze([
        'transport-davinci',
        'transport-faith',
        'transport-ayanda',
        'transport-epick',
        'transport-kmgidi',
      ]),
      expectedTenant: 'DAVINCI_PRD',
      expectedPropertyName: 'Davinci Hotel',
      username: 'NAVAAI',
      mailboxTransportId: 'transport-davinci',
      credentialSecretRef: 'nava-zero/server-pilot/infor-hms-read-davinci',
      credentialUse: 'shared',
      browserSlot: 'davinci',
      profileFile: 'property-profiles/HRDAV.json',
    }),
    Object.freeze({
      propertyCode: 'HRDAVS',
      group: 'davinci',
      landingPropertyCode: 'HRDAV',
      origin: 'https://hmsweb.hms.eu1.inforcloudsuite.com',
      active: true,
      transportIds: Object.freeze([
        'transport-davinci', 'transport-faith', 'transport-ayanda', 'transport-epick', 'transport-kmgidi',
      ]),
      expectedTenant: 'DAVINCI_PRD',
      expectedPropertyName: 'Davinci Hotel',
      username: 'NAVAAI',
      mailboxTransportId: 'transport-davinci',
      credentialSecretRef: 'nava-zero/server-pilot/infor-hms-read-davinci',
      credentialUse: 'shared',
      browserSlot: 'davinci',
      profileFile: 'property-profiles/HRDAVS.json',
    }),
  ]),
  collectorTransportIds: Object.freeze(['transport-nava']),
});

/** Structural JSON-schema checks plus uniqueness across every property's transportIds. */
export function validatePropertyRegistry(registry) {
  const propertyKeys = new Set([
    'propertyCode', 'active', 'transportIds', 'expectedTenant', 'expectedPropertyName',
    'username', 'mailboxTransportId', 'credentialSecretRef', 'credentialUse', 'browserSlot', 'profileFile',
    'group', 'landingPropertyCode', 'origin',
  ]);
  const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const isTransportId = (value) => typeof value === 'string' && /^transport-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
  const isString = (value) => typeof value === 'string' && value.length > 0;
  if (
    !isRecord(registry) ||
    Object.keys(registry).some((key) => !['properties', 'collectorTransportIds'].includes(key)) ||
    !Array.isArray(registry.properties) ||
    !registry.properties.length ||
    !Array.isArray(registry.collectorTransportIds)
  ) {
    throw new Error('hms_property_registry_invalid');
  }
  const propertyCodes = new Set();
  const transportOwners = new Map();
  for (const property of registry.properties) {
    if (
      !isRecord(property) ||
      Object.keys(property).some((key) => !propertyKeys.has(key)) ||
      typeof property.propertyCode !== 'string' ||
      !/^[A-Z][A-Z0-9]+$/.test(property.propertyCode) ||
      typeof property.active !== 'boolean' ||
      !Array.isArray(property.transportIds) ||
      !property.transportIds.length ||
      property.transportIds.some((id) => !isTransportId(id)) ||
      new Set(property.transportIds).size !== property.transportIds.length ||
      !property.transportIds.includes(property.mailboxTransportId) ||
      ['expectedTenant', 'expectedPropertyName', 'username', 'mailboxTransportId', 'credentialSecretRef', 'browserSlot']
        .some((field) => !isString(property[field])) ||
      !['centurion', 'davinci'].includes(property.group) ||
      !isString(property.landingPropertyCode) || !isString(property.origin) ||
      property.credentialUse !== 'shared' ||
      (property.profileFile !== null && typeof property.profileFile !== 'string')
    ) {
      throw new Error('hms_property_registry_invalid');
    }
    if (propertyCodes.has(property.propertyCode)) throw new Error('hms_property_duplicate_code');
    propertyCodes.add(property.propertyCode);
    for (const transportId of property.transportIds) {
      if (typeof transportId !== 'string' || !transportId) throw new Error('hms_property_registry_invalid');
      if (transportOwners.has(transportId) && transportOwners.get(transportId) !== property.group) throw new Error('hms_property_duplicate_transport');
      transportOwners.set(transportId, property.group);
    }
  }
  for (const transportId of registry.collectorTransportIds) {
    if (!isTransportId(transportId)) throw new Error('hms_property_registry_invalid');
    if (transportOwners.has(transportId)) throw new Error('hms_property_duplicate_transport');
    if (transportOwners.has(`collector:${transportId}`)) throw new Error('hms_property_duplicate_transport');
    transportOwners.set(`collector:${transportId}`, null);
  }
  return registry;
}

validatePropertyRegistry(PROPERTY_REGISTRY);

export function getPropertyRegistration(propertyCode) {
  return PROPERTY_REGISTRY.properties.find((entry) => entry.propertyCode === propertyCode) ?? null;
}

export function getPropertyTransportIds(propertyCode) {
  return getPropertyRegistration(propertyCode)?.transportIds ?? [];
}

export function resolvePropertyTransport(transportId, registry = PROPERTY_REGISTRY) {
  const id = typeof transportId === 'string' ? transportId.trim() : '';
  if (!id) return { kind: 'refusal', code: 'property_unknown', transportId: id };
  if (registry.collectorTransportIds.includes(id)) return { kind: 'collector', transportId: id };
  const property = registry.properties.find((entry) => entry.transportIds.includes(id));
  if (!property) return { kind: 'refusal', code: 'property_unknown', transportId: id };
  if (!property.active) return { kind: 'refusal', code: 'property_inactive', transportId: id };
  return { kind: 'property', transportId: id, property: Object.freeze({ ...property, transportId: id }) };
}

export function getHmsPropertyRegistration(transportId) {
  const resolved = resolvePropertyTransport(transportId);
  if (resolved.kind === 'property') return resolved.property;
  if (resolved.kind === 'collector') throw new Error('hms_property_not_hotel');
  throw new Error(resolved.code === 'property_inactive' ? 'hms_property_inactive' : 'hms_property_unknown');
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

/** Parse credential transport membership without rewriting the credential to match the caller. */
export function normalizeHmsSecretTransportIds(property, secret) {
  if (!property || !secret || typeof secret !== 'object' || Array.isArray(secret)) {
    throw new Error('hms_property_credential_mismatch');
  }
  const scalar = secret.mailboxTransportId;
  const array = secret.mailboxTransportIds;
  if (scalar !== undefined && (typeof scalar !== 'string' || !scalar)) throw new Error('hms_property_credential_mismatch');
  if (array !== undefined && (!Array.isArray(array) || array.length === 0 || array.some((id) => typeof id !== 'string' || !id) || new Set(array).size !== array.length)) {
    throw new Error('hms_property_credential_mismatch');
  }
  if (scalar === undefined && array === undefined) throw new Error('hms_property_credential_mismatch');
  if (scalar !== undefined && array !== undefined && !array.includes(scalar)) throw new Error('hms_property_credential_mismatch');
  const ids = array ?? [scalar];
  if (ids.some((id) => !property.transportIds.includes(id))) throw new Error('hms_property_credential_mismatch');
  if (property.group === 'davinci' && array !== undefined && (ids.length !== property.transportIds.length || property.transportIds.some((id) => !ids.includes(id)))) {
    throw new Error('hms_property_credential_mismatch');
  }
  return ids;
}

export function validateHmsPropertySecret(property, secret) {
  const ids = normalizeHmsSecretTransportIds(property, secret);
  if (
    secret.expectedPropertyCode !== property.landingPropertyCode ||
    secret.expectedTenant !== property.expectedTenant ||
    secret.expectedPropertyName !== property.expectedPropertyName ||
    secret.username !== property.username ||
    !['view_only', 'audited_write', 'write_capable'].includes(secret.credentialMode) ||
    (property.transportId && !ids.includes(property.transportId))
  ) throw new Error('hms_property_credential_mismatch');
  return secret;
}

export async function installRegisteredAvailabilityReadOnlyGuard(context, transportId, origin) {
  getHmsPropertyRegistration(transportId);
  return installAvailabilityReadOnlyGuard(context, origin);
}
