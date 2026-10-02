import {
  createAuthBoundaryRecovery,
  isUnauthorizedTrpcError,
  sessionExpiredRedirect,
} from '../lib/mail/auth-boundary';
import { describe, expect, it, vi } from 'vitest';

const { signOutMock } = vi.hoisted(() => ({
  signOutMock: vi.fn(async () => undefined),
}));

vi.mock('@/lib/auth-client', () => ({
  signOut: signOutMock,
  useSession: vi.fn(),
}));
vi.mock('@/hooks/use-connections', () => ({
  useActiveConnection: vi.fn(),
}));
vi.mock('@/lib/demo/runtime', () => ({
  isFrontendOnlyDemo: vi.fn(() => false),
}));
vi.mock('idb-keyval', () => ({
  del: vi.fn(async () => undefined),
  get: vi.fn(),
  set: vi.fn(),
}));

describe('tRPC auth-boundary errors', () => {
  it('keeps Outlook re-login on its exact permitted pane route', () => {
    expect(sessionExpiredRedirect('/outlook-pane')).toBe('/outlook-pane');
    expect(sessionExpiredRedirect('/mail/inbox')).toBe('/zero/login?error=session_expired');
    expect(sessionExpiredRedirect('/outlook-pane/unapproved')).toBe(
      '/zero/login?error=session_expired',
    );
  });
  it.each([
    { data: { code: 'UNAUTHORIZED' } },
    { shape: { data: { code: 'UNAUTHORIZED' } } },
    { message: 'no session' },
  ])('recognizes %j as an expired session', (error) => {
    expect(isUnauthorizedTrpcError(error)).toBe(true);
  });

  it.each([
    { data: { code: 'FORBIDDEN' } },
    { data: { code: 'NOT_FOUND' } },
    { data: { code: 'UNAUTHORIZED' }, message: 'Connection expired. Please reconnect.' },
    { message: 'processing failed' },
    null,
    'no session',
  ])('does not classify %j as an expired session', (error) => {
    expect(isUnauthorizedTrpcError(error)).toBe(false);
  });

  it('clears cached mail state, signs out, and redirects once', async () => {
    const queryClient = { clear: vi.fn() };
    const clearIdb = vi.fn(async () => undefined);
    const signOut = vi.fn(async () => undefined);
    const redirect = vi.fn();
    const recover = createAuthBoundaryRecovery();
    const deps = { queryClient, clearIdb, signOut, redirect };

    await Promise.all([recover(deps), recover(deps)]);
    await recover(deps);

    expect(queryClient.clear).toHaveBeenCalledOnce();
    expect(clearIdb).toHaveBeenCalledOnce();
    expect(signOut).toHaveBeenCalledOnce();
    expect(redirect).toHaveBeenCalledOnce();
    expect(redirect).toHaveBeenCalledWith('/zero/login?error=session_expired');
  });

  it('redirects even when cleanup or sign-out fails', async () => {
    const onError = vi.fn();
    const redirect = vi.fn();
    const recover = createAuthBoundaryRecovery();

    await recover({
      queryClient: {
        clear: vi.fn(() => {
          throw new Error('cache failed');
        }),
      },
      clearIdb: vi.fn(async () => {
        throw new Error('idb failed');
      }),
      signOut: vi.fn(async () => {
        throw new Error('sign-out failed');
      }),
      redirect,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(2);
    expect(redirect).toHaveBeenCalledWith('/zero/login?error=session_expired');
  });

  it('recovers from unauthorized mutation failures through the global cache', async () => {
    const { makeQueryClient } = await import('../providers/query-provider');
    const queryClient = makeQueryClient();
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => {
        throw Object.assign(new Error('no session'), {
          data: { code: 'UNAUTHORIZED' },
        });
      },
    });

    await expect(mutation.execute(undefined)).rejects.toThrow('no session');
    await vi.waitFor(() => expect(signOutMock).toHaveBeenCalledOnce());
  });
});
