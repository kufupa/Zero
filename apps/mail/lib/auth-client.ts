import { phoneNumberClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { useQuery } from '@tanstack/react-query';
import type { Auth } from '@zero/server/auth';
import { isFrontendOnlyDemo } from './demo/runtime';
import { getDemoSession } from './demo/session';

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_PUBLIC_BACKEND_URL,
  fetchOptions: {
    credentials: 'include',
  },
  plugins: [phoneNumberClient()],
});

export const { signIn, signUp, signOut, $fetch } = authClient;

export async function getSession() {
  if (isFrontendOnlyDemo()) {
    return {
      data: getDemoSession(),
      error: null,
    };
  }
  return authClient.getSession({
    fetchOptions: {
      credentials: 'include',
    },
  });
}

export function linkSocialSafe(
  payload: Parameters<typeof authClient.linkSocial>[0],
): Promise<unknown> {
  if (isFrontendOnlyDemo()) {
    return Promise.resolve(undefined);
  }

  return authClient.linkSocial(payload) as Promise<unknown>;
}

export function useSession() {
  const demoMode = isFrontendOnlyDemo();
  return useQuery({
    queryKey: ['auth', 'session', demoMode ? 'demo' : 'live'],
    queryFn: async () => {
      const result = await getSession();
      return result.data ?? null;
    },
    staleTime: demoMode ? Infinity : 1000 * 30,
    refetchOnWindowFocus: !demoMode,
    retry: false,
  });
}

export type Session = Awaited<ReturnType<Auth['api']['getSession']>>;
