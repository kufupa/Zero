export type HmsPolicyProperty = 'HRCEN' | 'HRDAV' | 'HRDAVS';
export type HmsWorkflow = 'reads' | 'quote' | 'create' | 'amend' | 'cancel' | 'attach' | 'addons' | 'guest_profile_create';
export type HmsWorkflowMode = 'off' | 'lab' | 'on';
export type HmsWorkflowCapability = 'unavailable' | 'prepare-only' | 'lab' | 'staff-enabled';
export interface EffectiveWorkflowPolicy {
  property: HmsPolicyProperty;
  workflow: HmsWorkflow;
  mode: HmsWorkflowMode;
  admittedMode: HmsWorkflowMode;
  readEnabled: boolean;
  capability: HmsWorkflowCapability;
  credentialIdentity: string;
  writerDependencyDigest: string | null;
  writerReady: boolean;
}
export const HMS_PROPERTIES: readonly HmsPolicyProperty[];
export const HMS_WORKFLOWS: readonly HmsWorkflow[];
export const HMS_WRITE_WORKFLOWS: readonly HmsWorkflow[];
export const DAVINCI_MODE_KEYS: Readonly<Record<HmsWorkflow, string>>;
export const WRITER_DIGEST_KEYS: Readonly<Partial<Record<HmsWorkflow, string>>>;
export const WRITER_CREDENTIAL_IDENTITY_KEYS: Readonly<Record<HmsPolicyProperty, string>>;
export const RUNTIME_PATH_KEYS: readonly string[];
export const SCOPED_RUNTIME_CONTROL_KEYS: readonly string[];
export function parseDavinciEnabledProperties(value: string | undefined): ('HRDAV' | 'HRDAVS')[];
export function validateRuntimeControl(key: string, value: string | undefined): void;
export function effectiveWorkflowPolicy(env: Readonly<Record<string, string | undefined>>, property: HmsPolicyProperty, workflow: HmsWorkflow): EffectiveWorkflowPolicy;
export function hmsWriterDependencyDigest(workflow: Exclude<HmsWorkflow, 'reads' | 'quote'>): string;
export function hmsWriterReady(env: Readonly<Record<string, string | undefined>>, property: HmsPolicyProperty, workflow: HmsWorkflow, expectedSourceRevision?: string): boolean;

export const CATALOG_CREDENTIAL_DIGEST_KEYS: readonly string[];
