import { authClient } from './auth/better-auth-instance';
import { getDemoSession } from './demo/session';
import { resolveMailMode } from './runtime/mail-mode';

export const authProxy = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      if (resolveMailMode() === 'demo') {
        return getDemoSession();
      }
      if (resolveMailMode() === 'hosted') {
        return null;
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
