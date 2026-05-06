import { isFrontendOnlyDemo } from '@/lib/demo/runtime';

const ALLOWED_ADMIN_EMAILS = ['centurion@legacyhotels.co.za'] as const;

type SessionLike = {
  user?: {
    email?: string | null;
  } | null;
} | null;

export type AdminSource = 'demo' | 'hosted';

export function isAdminDashboardEnabled(session: SessionLike): boolean {
  if (isFrontendOnlyDemo()) return true;

  const email = (session?.user?.email ?? '').trim().toLowerCase();
  if (!email) return false;

  return (ALLOWED_ADMIN_EMAILS as readonly string[]).includes(email);
}

export function describeAdminSource(_session: SessionLike): AdminSource {
  return isFrontendOnlyDemo() ? 'demo' : 'hosted';
}
