export type PropertyRegistryProperty = Readonly<{
  propertyCode: string;
  active: boolean;
  transportIds: readonly string[];
  expectedTenant: string;
  expectedPropertyName: string;
  username: string;
  mailboxTransportId: string;
  credentialSecretRef: string;
  credentialMode: 'view_only';
  browserSlot: 'centurion' | 'davinci';
  profileFile: string | null;
}>;

export type PropertyRegistry = Readonly<{
  properties: readonly PropertyRegistryProperty[];
  collectorTransportIds: readonly string[];
}>;

export type PropertyRegistration = PropertyRegistryProperty & { transportId: string };

export type PropertyTransportResolution =
  | { kind: 'property'; transportId: string; property: PropertyRegistration }
  | { kind: 'collector'; transportId: string }
  | { kind: 'refusal'; code: 'property_unknown' | 'property_inactive'; transportId: string };

export type SecretSource =
  | { source: 'aws'; secretId: string; property: PropertyRegistration | null }
  | { source: 'file'; path: string; property: null };

export declare const PROPERTY_REGISTRY: PropertyRegistry;
export declare const PROPERTY_REGISTRY_SCHEMA: Readonly<Record<string, unknown>>;

export declare function validatePropertyRegistry(registry: unknown): PropertyRegistry;
export declare function getPropertyRegistration(propertyCode: string): PropertyRegistryProperty | null;
export declare function getPropertyTransportIds(propertyCode: string): readonly string[];
export declare function resolvePropertyTransport(
  transportId: string | null | undefined,
  registry?: PropertyRegistry,
): PropertyTransportResolution;
export declare function getHmsPropertyRegistration(transportId: string): PropertyRegistration;
export declare function resolveSecretSource(env?: Record<string, string | undefined>): SecretSource;
export declare function validateHmsPropertySecret(property: PropertyRegistration | null | undefined, secret: unknown): unknown;
export declare function installRegisteredAvailabilityReadOnlyGuard(
  context: unknown,
  transportId: string,
  origin: string,
): Promise<void>;
