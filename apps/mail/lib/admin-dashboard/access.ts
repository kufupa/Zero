import { isFrontendOnlyDemo } from '@/lib/demo/runtime';

/** Cosmetic client gate; server allowlist is the real control. */
const ALLOWED_ADMIN_EMAILS = ['navaai@legacyhotels.co.za'] as const;

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

  return (ALLOWED_ADMIN_EMAILS as readonly string[]).includes(email);
}

export function describeAdminSource(_session: SessionLike): AdminSource {
  return isFrontendOnlyDemo() ? 'demo' : 'hosted';
}
