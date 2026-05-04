import { useQuery } from '@tanstack/react-query';
import type { Auth } from '@zero/server/auth';
import { authClient, $fetch, signIn, signOut, signUp } from './auth/better-auth-instance';
import { getAuthApi } from './auth/factory';
import { resolveMailMode } from './runtime/mail-mode';

export { authClient, signIn, signUp, signOut, $fetch };

export async function getSession() {
  return getAuthApi().getSession();
}

export function linkSocialSafe(payload: Parameters<typeof authClient.linkSocial>[0]): Promise<unknown> {
  return getAuthApi().linkSocialSafe(payload);
}

export function useSession() {
  const mode = resolveMailMode();
  const isDemo = mode === 'demo';
  const isHosted = mode === 'hosted';
  return useQuery({
    queryKey: ['auth', 'session', mode],
    queryFn: async () => {
      const result = await getSession();
      return result.data ?? null;
    },
    staleTime: isDemo || isHosted ? Infinity : 1000 * 30,
    refetchOnWindowFocus: !(isDemo || isHosted),
    retry: false,
  });
}

export type Session = Awaited<ReturnType<Auth['api']['getSession']>>;
