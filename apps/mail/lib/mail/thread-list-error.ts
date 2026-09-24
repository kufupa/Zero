import { isUnauthorizedTrpcError } from './auth-boundary';
import { isUnsupportedSearchOperatorError } from './search-list';

export type ThreadListErrorView = {
  message: string;
  retryLabel: string;
  /** When true, auth-boundary recovery should own the next navigation. */
  isSessionError: boolean;
};

/**
 * Mail list used to label every listThreads failure as a search outage, which
 * hid session / transport failures (including the baked `undefined/api/trpc`
 * SPA bug) behind "Unable to load search results".
 */
export function resolveThreadListErrorView(
  error: unknown,
  hasActiveSearch: boolean,
): ThreadListErrorView {
  if (isUnauthorizedTrpcError(error)) {
    return {
      message: 'Session expired. Signing you back in…',
      retryLabel: 'Retry',
      isSessionError: true,
    };
  }
  if (isUnsupportedSearchOperatorError(error)) {
    return {
      message:
        error instanceof Error && error.message
          ? error.message
          : 'Unsupported search operator.',
      retryLabel: 'Retry search',
      isSessionError: false,
    };
  }
  if (hasActiveSearch) {
    return {
      message: 'Unable to load search results. Please retry.',
      retryLabel: 'Retry search',
      isSessionError: false,
    };
  }
  return {
    message: 'Unable to load mail. Please retry.',
    retryLabel: 'Retry',
    isSessionError: false,
  };
}
