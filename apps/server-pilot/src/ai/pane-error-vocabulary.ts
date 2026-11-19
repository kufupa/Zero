/** Fixed pane error telemetry vocabularies (moved from the retired v2 contract). */
export const RESERVATION_WORKFLOW_V2_ERROR_PROCEDURES = [
  'resolveSource', 'ensure', 'prefill', 'addAction', 'changeRows', 'selectNative', 'verifyNativeLead', 'reviewScope',
  'get', 'reconcileSource', 'edit', 'review', 'undo', 'redo', 'lookup', 'guestProfileOptions',
  'prepareGuestProfile', 'createGuestProfile', 'prepare', 'execute', 'reconcile', 'configureFiling',
  'lookupServices', 'prepareServices', 'executeServices', 'reconcileServices',
] as const;
export const PANE_ERROR_CLASSES = ['trpc', 'network', 'timeout', 'client', 'unknown'] as const;
export const PANE_ERROR_CODES = [
  'PARSE_ERROR', 'BAD_REQUEST', 'INTERNAL_SERVER_ERROR', 'NOT_IMPLEMENTED', 'BAD_GATEWAY', 'SERVICE_UNAVAILABLE',
  'GATEWAY_TIMEOUT', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'METHOD_NOT_SUPPORTED', 'TIMEOUT', 'CONFLICT',
  'PRECONDITION_FAILED', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'UNPROCESSABLE_CONTENT', 'TOO_MANY_REQUESTS',
  'CLIENT_CLOSED_REQUEST', 'UNKNOWN',
] as const;
