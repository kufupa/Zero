import { isFrontendOnlyDemo } from '@/lib/demo/runtime';

type SessionLike =
  | {
      user?: {
        email?: string | null;
      } | null;
    }
  | null
  | undefined;

export type AdminSource = 'demo' | 'hosted';

export function isAdminDashboardEnabled(session: SessionLike): boolean {
  if (isFrontendOnlyDemo()) return true;

  const email = (session?.user?.email ?? '').trim().toLowerCase();
  if (!email) return false;

  return true;
}

export function describeAdminSource(_session: SessionLike): AdminSource {
  return isFrontendOnlyDemo() ? 'demo' : 'hosted';
}
