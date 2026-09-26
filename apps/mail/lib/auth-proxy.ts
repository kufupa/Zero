import { createAuthClient } from 'better-auth/client';
import { resolvePublicBackendUrl } from './public-backend-url';
import { isFrontendOnlyDemo } from './demo/runtime';
import { getDemoSession } from './demo/session';

const authClient = createAuthClient({
  baseURL: resolvePublicBackendUrl(),
  fetchOptions: {
    credentials: 'include',
  },
  plugins: [],
});

export const authProxy = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      if (isFrontendOnlyDemo()) {
        return getDemoSession();
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        const session = await authClient.getSession({
          fetchOptions: { headers, credentials: 'include', signal: controller.signal },
        });
        if (session.error) {
          console.error(`Failed to get session: ${session.error}`, session);
          return null;
        }
        return session.data;
      } catch (error) {
        console.error('Failed to fetch session', error);
        return null;
      } finally {
        clearTimeout(timeout);
      }
    },
  },
};
