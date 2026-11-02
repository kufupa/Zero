export const CLOUD_CREATE_REQUEST_VERSION: 'hms-cloud-create-request/v1';
type Failure = { outcome: 'unsupported'; issue: string; path?: string };
export function normalizeCloudCreateRequest(input: unknown):
  | { outcome: 'ok'; request: Record<string, unknown> }
  | Failure;
export function digestCloudCreateRequest(input: unknown):
  | { outcome: 'ok'; request: Record<string, unknown>; normalizedRequestDigest: string }
  | Failure;
