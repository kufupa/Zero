import type { LabIndex } from './centurion-eval';

export type LabIndexLoadError = { status: number; message: string };

export type LabIndexLoadResult =
  | { index: LabIndex; source: 'live' }
  | { source: 'error'; error: LabIndexLoadError };

/** Kept for test/API compat; index is never retained across loads. */
export function resetLabIndexCache(): void {}

function labIndexBackendOrigin(requestUrl: URL): string {
  // Match trpc/auth-client: empty VITE_PUBLIC_BACKEND_URL → same-origin /api/*.
  const configured = String(import.meta.env.VITE_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');
  return configured || requestUrl.origin;
}

export async function loadCenturionLabIndex(request: Request): Promise<LabIndexLoadResult> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/mail/')) {
    throw new Error('centurion eval lab must not mount under /mail folders');
  }
  const backendOrigin = labIndexBackendOrigin(url);
  const cookie = request.headers.get('cookie') ?? '';
  try {
    // Always re-fetch so revoked mailbox_access cannot reuse a prior 200 body.
    const live = await fetch(new URL('/api/lab/centurion-index', backendOrigin), {
      headers: cookie ? { cookie } : undefined,
      credentials: 'include',
      cache: 'no-store',
    });
    if (!live.ok) {
      return {
        source: 'error',
        error: { status: live.status, message: `lab index HTTP ${live.status}` },
      };
    }
    const index = (await live.json()) as LabIndex;
    if (!Array.isArray(index?.rows) || index.rows.length === 0) {
      return { source: 'error', error: { status: 200, message: 'lab index empty' } };
    }
    return { index, source: 'live' };
  } catch (err) {
    return {
      source: 'error',
      error: {
        status: 0,
        message: err instanceof Error ? err.message : 'lab index fetch failed',
      },
    };
  }
}
