import type { BrowserContext, Page, Request } from 'playwright';
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
  readRequestPolicy?: (request: Request) => boolean;
  requireBoundCredentialVersion?: boolean;
  allowUnboundCredentialVersion?: boolean;
  startScreen?: 'BSSTRT' | 'OSRESV' | 'OSRESS';
  loadSecret?: CloudSecretLoader;
  credentialLease?: CloudCredentialLease;
  cloudTargetKey?: string;
  cloudTargetKeys?: readonly string[];
};
export declare function installCloudReadGuard(context: BrowserContext, property: { origin: string; propertyCode: string; expectedTenant: string }, state: {
  writer: boolean; verified: boolean; authenticated: boolean; switching: string | null; ownedPage: Page | null;
  readRequestPolicy?: (request: Request) => boolean;
}): Promise<void>;
export declare function cloudCredentialLeaseKey(propertyCode: string): string;
export declare function verifyCloudCredentialVersion(input: {
  propertyCode: string;
  transportId?: string;
  loadedSecret: unknown;
  signal?: AbortSignal;
  requireBoundVersion?: boolean;
  allowUnboundVersion?: boolean;
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
export declare function withCloudReadSession<T>(operation: (page: Page, identity: CloudSessionIdentity, session: Readonly<{
  credentialVersionHmacSha256: string | null; signal: AbortSignal;
}>) => T | Promise<T>,
  options: CloudSessionOptions): Promise<T>;
export declare function withCloudWriterSession<T>(operation: (page: Page, identity: CloudSessionIdentity) => T | Promise<T>,
  options: CloudSessionOptions): Promise<T>;
export type CloudWriterIdentity = Readonly<{
  host: string; bootId: string; pidNamespace: string;
  node: Readonly<{ pid: number; started: string }>;
  browser: Readonly<{ pid: number; started: string }>;
}>;
export declare function cloudWriterIdentity(page: Page): CloudWriterIdentity | null;
export declare function cloudSessionIdentity(page: Page): CloudSessionIdentity | null;
export declare function cloudWriterCurrent(identity: unknown): boolean;
export declare function cloudWriterQuiesced(identity: unknown): boolean;
export declare function cloudHoldPath(propertyCode: string, alias: string, home?: string): string;
export declare function assertNoCloudHold(propertyCode: string, alias: string): void;
