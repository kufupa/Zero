import type { QueryClient } from '@tanstack/react-query';
import { runLogoutCleanup } from './query-cache-policy';

const SESSION_EXPIRED_REDIRECT = '/zero/login?error=session_expired';
const CONNECTION_EXPIRED_MESSAGE = 'Connection expired. Please reconnect.';

export function sessionExpiredRedirect(pathname: string): string {
  return pathname === '/outlook-pane' ? '/outlook-pane' : SESSION_EXPIRED_REDIRECT;
}

type TrpcErrorLike = {
  message?: unknown;
  data?: { code?: unknown } | null;
  shape?: { data?: { code?: unknown } | null } | null;
};

export function isUnauthorizedTrpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as TrpcErrorLike;
  if (candidate.message === CONNECTION_EXPIRED_MESSAGE) return false;
  return (
    candidate.data?.code === 'UNAUTHORIZED' ||
    candidate.shape?.data?.code === 'UNAUTHORIZED' ||
    candidate.message === 'no session' ||
    candidate.message === 'UNAUTHORIZED'
  );
}

export type AuthBoundaryRecoveryDeps = {
  queryClient: Pick<QueryClient, 'clear'>;
  clearIdb: () => Promise<void>;
  signOut: () => Promise<unknown>;
  redirect: (path: string) => void;
  onError?: (error: unknown) => void;
};

export function createAuthBoundaryRecovery() {
  let inFlight = false;
  let redirectRequested = false;

  return async function recoverFromAuthBoundary(deps: AuthBoundaryRecoveryDeps): Promise<void> {
    if (inFlight || redirectRequested) return;
    inFlight = true;

    try {
      try {
        await runLogoutCleanup({
          queryClient: deps.queryClient,
          clearIdb: deps.clearIdb,
        });
      } catch (error) {
        deps.onError?.(error);
      }

      try {
        await deps.signOut();
      } catch (error) {
        deps.onError?.(error);
      }

      redirectRequested = true;
      deps.redirect(SESSION_EXPIRED_REDIRECT);
    } finally {
      inFlight = false;
    }
  };
}
