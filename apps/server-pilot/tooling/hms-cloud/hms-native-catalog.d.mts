export type NativeCatalogReadOptions = {
  path?: string;
  propertyCode?: string;
  tenantId?: string;
  landingPropertyCode?: string;
  credentialRef?: string;
  credentialVersionHmacSha256?: string;
  sourceRevision?: string;
  now?: Date;
};

export type NativeCatalogFormField = {
  name: string;
  label: string;
  type: string;
  required: boolean;
  visible: boolean;
  value?: boolean;
  choices?: Array<{ code: string; meaning: string }>;
};

export type NativeCatalog = {
  schemaVersion: string;
  propertyCode: string;
  capturedAt: string;
  maxAgeMs?: number;
  sourceRevision?: string;
  catalogs: Record<string, {
    coverage: { complete: boolean; loaded?: number; total?: number };
    scope: { kind: string; wholeCatalogComplete: boolean };
    records: Array<{ code: string | null; meaning: string | null; propertyCode: string; capturedAt: string }>;
  }>;
  form?: { propertyCode: string; fields: NativeCatalogFormField[] };
  availabilityForm?: { propertyCode: string; fields: NativeCatalogFormField[] };
};

export declare function nativeCatalogReadOptions(input: {
  propertyCode: string;
  env?: NodeJS.ProcessEnv;
}): NativeCatalogReadOptions;

export declare function loadHmsNativeCatalog(input: NativeCatalogReadOptions): Promise<
  | { status: 'available'; catalog: NativeCatalog }
  | { status: 'unavailable'; issue: string }
>;

export declare function normalizeHmsNativeCatalog(input: Record<string, unknown>): NativeCatalog;
export declare function validateAgencyCommissionMapping(samples?: unknown[]): unknown;
export declare function validateRateMealReadback(input?: Record<string, unknown>): unknown;
