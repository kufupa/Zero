import type { BrowserContext, Page } from 'playwright';
import type { PropertyCode } from './property-registry.mjs';

export type CloudPropertyIdentity = Readonly<{
  propertyCode: PropertyCode;
  tenantId: string;
  origin: string;
  observedName: string | null;
}>;
export type CloudSessionIdentity = CloudPropertyIdentity & Readonly<{
  landingPropertyCode: 'HRCEN' | 'HRDAV';
}>;
export type CloudSecretLoader = (input: { secretArn: string; signal?: AbortSignal }) => Promise<unknown>;
export type CloudLoadedSecret = Readonly<{ secret: unknown; versionId: string; versionStages: readonly string[] }>;
declare const cloudCredentialLeaseBrand: unique symbol;
export type CloudCredentialLease = Readonly<{
  [cloudCredentialLeaseBrand]: never;
  signal: AbortSignal;
  release(): Promise<void>;
}>;
export type CloudSessionOptions = {
  propertyCode: string;
  transportId?: string;
  signal?: AbortSignal;
  headless?: boolean;
  prepareContext?: (context: BrowserContext) => void | Promise<void>;
  startScreen?: 'BSSTRT' | 'OSRESV' | 'OSRESS';
  loadSecret?: CloudSecretLoader;
  credentialLease?: CloudCredentialLease;
};
export declare function cloudCredentialLeaseKey(propertyCode: string): string;
export declare function verifyCloudCredentialVersion(input: {
  propertyCode: string;
  transportId?: string;
  loadedSecret: unknown;
  signal?: AbortSignal;
}): Promise<string | null>;
export declare function acquireCloudCredentialLease(propertyCode: string, options?: {
  signal?: AbortSignal;
}): Promise<CloudCredentialLease>;
export declare function withCloudCredentialLease<T>(propertyCode: string,
  operation: (lease: CloudCredentialLease) => T | Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
export declare function verifyCloudProperty(page: Page, input: {
  propertyCode: string;
  tenantId?: string;
}): Promise<CloudPropertyIdentity>;
export declare function switchCloudProperty(page: Page, input: {
  propertyCode: string;
  landingPropertyCode: string;
  tenantId?: string;
}): Promise<CloudPropertyIdentity>;
export declare function withCloudReadSession<T>(operation: (page: Page, identity: CloudSessionIdentity) => T | Promise<T>,
  options: CloudSessionOptions): Promise<T>;
