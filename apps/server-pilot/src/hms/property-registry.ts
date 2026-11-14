import { z } from 'zod';
import {
  getPropertyRegistration,
  resolvePropertyTransport,
  type PropertyCode as RegistryPropertyCode,
} from '../../tooling/hms-cloud/property-registry.mjs';

export const propertyCodeSchema = z.enum(['HRCEN', 'HRDAV', 'HRDAVS']);
export const propertySwitchSchema = z.enum(['HRDAV', 'HRDAVS']);
export type PropertyCode = z.infer<typeof propertyCodeSchema>;
export type PropertySwitch = z.infer<typeof propertySwitchSchema>;

export const resolvedPropertyScopeSchema = z.object({
  propertyCode: propertyCodeSchema,
  tenantId: z.string().min(1),
  group: z.enum(['centurion', 'davinci']),
  transportId: z.string().min(1),
  landingPropertyCode: z.enum(['HRCEN', 'HRDAV']),
  origin: z.string().url(),
  secretId: z.string().min(1),
}).strict();
export type ResolvedPropertyScope = z.infer<typeof resolvedPropertyScopeSchema>;

/** Resolve only from the authenticated mailbox; a switch never grants transport access. */
export function resolvePropertyScope(input: {
  transportId: string;
  propertySwitch?: PropertySwitch;
}): ResolvedPropertyScope {
  const resolved = resolvePropertyTransport(input.transportId);
  if (resolved.kind !== 'property') throw new Error('hms_property_transport_unauthorized');
  const selected: RegistryPropertyCode = input.propertySwitch ?? resolved.property.propertyCode;
  const property = getPropertyRegistration(selected);
  if (!property?.active || property.group !== resolved.property.group || !property.transportIds.includes(resolved.transportId)) {
    throw new Error('hms_property_switch_unauthorized');
  }
  return resolvedPropertyScopeSchema.parse({
    propertyCode: property.propertyCode,
    tenantId: property.expectedTenant,
    group: property.group,
    transportId: resolved.transportId,
    landingPropertyCode: property.landingPropertyCode,
    origin: property.origin,
    secretId: property.credentialSecretRef,
  });
}
