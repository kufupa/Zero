import type { LabIndex } from './centurion-eval';

export type LabIndexLoadError = { status: number; message: string };

export type LabIndexLoadResult =
  | { index: LabIndex; source: 'live' }
  | { source: 'error'; error: LabIndexLoadError };

let liveCache: { origin: string; result: Extract<LabIndexLoadResult, { source: 'live' }> } | null =
  null;

export function resetLabIndexCache(): void {
  liveCache = null;
}

export async function loadCenturionLabIndex(request: Request): Promise<LabIndexLoadResult> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/mail/')) {
    throw new Error('centurion eval lab must not mount under /mail folders');
  }
  if (liveCache && liveCache.origin === url.origin) return liveCache.result;

  const cookie = request.headers.get('cookie') ?? '';
  try {
    const live = await fetch(new URL('/api/lab/centurion-index', url.origin), {
      headers: cookie ? { cookie } : undefined,
      credentials: 'include',
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
    const result = { index, source: 'live' as const };
    liveCache = { origin: url.origin, result };
    return result;
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
