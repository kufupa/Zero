export const HRCEN_PROPERTY_CODE = 'HRCEN' as const;

/** Non-secret binding that selects one hotel's HMS runtime. */
export type HmsPropertyRegistration = Readonly<{
  propertyCode: string;
  tenantId: string;
  /** Non-secret login identity used only to derive a hashed lock key. */
  username: string;
  mailboxTransportId: string;
  /** HMS origin only; never a credential-bearing URL. */
  hmsBaseUrl: string;
  /** Secrets Manager reference, never credential material. */
  credentialSecretRef: string;
}>;

export type HmsPropertyRegistry = Readonly<{
  resolve(propertyCode: string): HmsPropertyRegistration;
  list(): readonly HmsPropertyRegistration[];
}>;

const REQUIRED_FIELDS = [
  'propertyCode',
  'tenantId',
  'username',
  'mailboxTransportId',
  'credentialSecretRef',
] as const;

export function createHmsPropertyRegistry(
  entries: readonly HmsPropertyRegistration[],
): HmsPropertyRegistry {
  const byPropertyCode = new Map<string, HmsPropertyRegistration>();
  const mailboxRoutes = new Set<string>();
  const credentialSecrets = new Set<string>();

  for (const entry of entries) {
    if (REQUIRED_FIELDS.some((field) => !entry[field].trim())) {
      throw new Error('hms_property_registry_invalid_entry');
    }

    let origin: URL;
    try {
      origin = new URL(entry.hmsBaseUrl);
    } catch {
      throw new Error('hms_property_registry_invalid_origin');
    }
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    ) {
      throw new Error('hms_property_registry_invalid_origin');
    }

    if (byPropertyCode.has(entry.propertyCode)) {
      throw new Error('hms_property_registry_duplicate_property');
    }
    if (mailboxRoutes.has(entry.mailboxTransportId)) {
      throw new Error('hms_property_registry_duplicate_mailbox');
    }
    if (credentialSecrets.has(entry.credentialSecretRef)) {
      throw new Error('hms_property_registry_duplicate_secret');
    }

    const registered = Object.freeze({
      ...entry,
      hmsBaseUrl: origin.origin,
    });
    byPropertyCode.set(registered.propertyCode, registered);
    mailboxRoutes.add(registered.mailboxTransportId);
    credentialSecrets.add(registered.credentialSecretRef);
  }

  return Object.freeze({
    resolve(propertyCode: string) {
      const property = byPropertyCode.get(propertyCode);
      if (!property) throw new Error('hms_property_unknown');
      return property;
    },
    list() {
      return [...byPropertyCode.values()];
    },
  });
}
