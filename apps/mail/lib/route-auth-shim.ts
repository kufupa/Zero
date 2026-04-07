import { authProxy } from './auth-proxy';
import { getDemoSession, isDemoMode } from './demo-session';

type SessionResult = Awaited<ReturnType<typeof authProxy.api.getSession>>;

const LOGIN_REDIRECT = `${import.meta.env.VITE_PUBLIC_APP_URL}/login`;

const getDemoOrRealSession = async ({
  request,
}: {
  request: Request;
}): Promise<SessionResult> => {
  if (isDemoMode()) return getDemoSession() as SessionResult;
  return authProxy.api.getSession({ headers: request.headers });
};

export const getSessionOrRedirect = async ({
  request,
}: {
  request: Request;
}): Promise<Response | SessionResult> => {
  const session = await getDemoOrRealSession({ request });
  if (session || isDemoMode()) return session;
  return Response.redirect(LOGIN_REDIRECT);
};

