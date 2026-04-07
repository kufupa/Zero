import { phoneNumberClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import type { Auth } from '@zero/server/auth';
import { getDemoSession, isDemoMode } from './demo-session';

const authClientBase = createAuthClient({
  baseURL: import.meta.env.VITE_PUBLIC_BACKEND_URL,
  fetchOptions: {
    credentials: 'include',
  },
  plugins: [phoneNumberClient()],
});

type SessionResponse = Awaited<ReturnType<typeof authClientBase.api.getSession>>;
type SignInResult = Awaited<
  ReturnType<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (typeof authClientBase.signIn & { social: (...args: any[]) => any })['social']
  >
>;

const getDemoSessionResponse = (): SessionResponse => ({
  data: getDemoSession() as SessionResponse['data'],
  error: null,
});

const getDemoSignInResult = (): SignInResult => ({
  data: null,
  error: null,
} as SignInResult);

const originalGetSession = authClientBase.api.getSession.bind(authClientBase.api);

const patchedGetSession: typeof authClientBase.api.getSession = async (...args) => {
  if (isDemoMode()) return getDemoSessionResponse();
  return originalGetSession(...args);
};

authClientBase.api.getSession = patchedGetSession;

const demoSignIn = new Proxy(
  async () => getDemoSignInResult(),
  {
    apply: (_target, _thisArg, _args) => Promise.resolve(getDemoSignInResult()),
    get: () => async () => getDemoSignInResult(),
  },
) as typeof authClientBase.signIn;

const demoSignOut: typeof authClientBase.signOut = async () => ({
  data: null,
  error: null,
});

if (isDemoMode()) {
  authClientBase.signIn = demoSignIn;
  authClientBase.signOut = demoSignOut;
}

/** Single client instance so React hooks (`useSession`, etc.) stay valid; demo patches `api.getSession` above. */
export const authClient = authClientBase;

export const { signIn, signUp, signOut, useSession, getSession, $fetch } = authClient;
export type Session = Awaited<ReturnType<Auth['api']['getSession']>>;
